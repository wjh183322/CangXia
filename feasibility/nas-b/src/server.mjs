import { assessRegisteredCover } from './cover-adapter.mjs';
import https from 'node:https';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { prepareDataRoot, consumeFreshLayout } from './config.mjs';
import { PROBE, ProbeError } from './contracts.mjs';
import { openProbeStore } from './store.mjs';
import { createLeaseManager } from './lease.mjs';
import { openBrowserGateway } from './browser.mjs';
import { createDownloads } from './downloads.mjs';
import { createReadCoordinator } from './read-jobs.mjs';
import { reconcileWork, resolveResource, assertResourceCurrent } from './files.mjs';
import { serveResource } from './media-http.mjs';
import { redact } from './redact.mjs';
import { parsePlatformJSON } from '../../../electron/model.mjs';
import { normalizeCollections, pageResult } from '../../../electron/api-pagination.mjs';

const fail = (code) => {
  throw new ProbeError(code);
};
const digest = (value) => createHash('sha256').update(value).digest();
const text = (value) => (typeof value === 'string' ? redact(value.slice(0, 4096)) : undefined);
const pick = (value, keys) =>
  Object.fromEntries(
    keys
      .filter((k) => ['string', 'number', 'boolean'].includes(typeof value?.[k]))
      .map((k) => [k, typeof value[k] === 'string' ? text(value[k]) : value[k]])
  );
function job(value) {
  if (!value) return null;
  const result = pick(value, [
    'id',
    'workId',
    'state',
    'mode',
    'savedPages',
    'savedReceived',
    'savedUnique',
    'filesComplete',
    'finalizationPending',
    'afterTotalJobId',
    'cursor'
  ]);
  if (value.source) result.source = pick(value.source, ['kind', 'id']);
  if (value.reason) result.reason = pick(value.reason, ['code', 'scope', 'retryAfter']);
  if (value.expected) result.expected = value.expected.map((item) => pick(item, ['key', 'name', 'kind']));
  if (value.finalizationErrors)
    result.finalizationErrors = value.finalizationErrors.map((e) => pick(e, ['workId', 'code']));
  return result;
}
function receipt(value) {
  if (!value) fail('PROBE_NOT_FOUND');
  return {
    ...pick(value, [
      'operationId',
      'kind',
      'revision',
      'generation',
      'released',
      'jobId',
      'savedPages',
      'savedUnique'
    ]),
    ...(value.job ? { job: job(value.job) } : {}),
    ...(value.jobs ? { jobs: value.jobs.map(job) } : {})
  };
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail('INVALID_PROBE_CONTENT');
  let size = 0;
  const bytes = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) fail('INVALID_PROBE_BODY');
    bytes.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(bytes).toString());
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  fail('INVALID_PROBE_BODY');
}
const names = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']]
]);
async function credentials(layout, fresh, options) {
  const secret = path.join(layout.state, 'access.token'),
    pem = path.join(layout.state, 'server.pem'),
    key = path.join(layout.state, 'server.key');
  if (fresh && !options.token)
    await writeFile(secret, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  if (fresh && !options.tls)
    await promisify(execFile)(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:3072',
        '-nodes',
        '-days',
        '365',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        key,
        '-out',
        pem
      ],
      { windowsHide: true }
    );
  const token = options.token ?? (await readFile(secret, 'utf8')).trim();
  if (typeof token !== 'string' || token.length < 32) fail('INVALID_PROBE_ACCESS_KEY');
  return {
    secret: digest(token),
    tls: options.tls ?? { key: await readFile(key), cert: await readFile(pem) }
  };
}

export async function startProbe(options) {
  const { config } = options;
  const layout = options.layout ?? (await prepareDataRoot(config));
  const fresh = consumeFreshLayout(layout);
  const store =
    options.store ??
    openProbeStore({
      file: path.join(layout.state, 'library.sqlite'),
      libraryId: config.libraryId,
      initialize: fresh
    });
  let gateway, downloads, reads, server, unsubscribe;
  const sessions = new Map(),
    active = new Set();
  const close = async () => {
    const draining = Array.from(active, (c) => c.finished);
    for (const controller of active) controller.abort();
    for (const session of sessions.values())
      if (session.grant)
        try {
          leases.release(session.grant, randomUUID());
        } catch {}
    unsubscribe?.();
    if (server?.listening) {
      const done = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await done;
    }
    await Promise.allSettled(draining);
    await downloads?.close();
    await gateway?.close();
    await reads?.close?.();
    if (!options.store && store.db.isOpen) store.close();
  };
  let leases;
  try {
    const { tls, secret } = await credentials(layout, fresh, options);
    leases = options.leases ?? createLeaseManager({ store, bootId: randomUUID() });
    gateway = options.gateway ?? (await openBrowserGateway({ config, store }));
    downloads = options.downloads ?? createDownloads({ store, gateway, layout });
    const finalize = async (current, guard) => {
      const errors = [];
      for (let page = 1; ; page++) {
        guard();
        const result = store.listWorks({ source: current.source, page });
        for (const item of result.items) {
          guard();
          const outcome = await reconcileWork({ store, layout, workId: item.id, guard });
          errors.push(...outcome.errors);
        }
        if (page >= result.pages) break;
      }
      return { ok: !errors.length, pending: !!errors.length, errors };
    };
    reads = options.reads ?? createReadCoordinator({ store, leases, gateway, finalize });
    let downloadError,
      authEpoch,
      coverBusy = false;
    const runDownloads = () => {
      void downloads.run().catch(() => {
        downloadError = 'PROBE_DOWNLOAD_FAILED';
      });
    };
    const authorizeSource = () => {
      gateway.assertAuthEpoch(authEpoch);
      return authEpoch;
    };
    unsubscribe = leases.onLost((loss) => {
      for (const c of active) if (c.generation === loss.generation) c.abort();
    });
    server = https.createServer(
      { ...tls, minVersion: 'TLSv1.2', requestTimeout: 15000, headersTimeout: 10000 },
      async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        );
        const controller = new AbortController(),
          signal = controller.signal;
        let finish;
        controller.finished = new Promise((resolve) => {
          finish = resolve;
        });
        active.add(controller);
        res.on('close', () => controller.abort());
        const json = (value, status = 200) => {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(value));
        };
        try {
          const url = new URL(req.url, 'https://localhost'),
            route = url.pathname;
          const method = req.method;
          if (method === 'GET' && names.has(route)) {
            const [name, mime] = names.get(route);
            const bytes = await readFile(new URL('../web/' + name, import.meta.url));
            res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
            return res.end(bytes);
          }
          if (!route.startsWith('/probe/v1/')) fail('PROBE_NOT_FOUND');
          const parts = route.slice(10).split('/').map(decodeURIComponent);
          const [group, id, action] = parts;
          if (parts.length > 3 || parts.some((p) => !p || p.length > 256)) fail('PROBE_NOT_FOUND');
          if (
            req.headers['sec-fetch-site'] === 'cross-site' ||
            (req.headers.origin && req.headers.origin !== 'https://' + req.headers.host)
          )
            fail('PROBE_FORBIDDEN');
          if (method === 'POST' && group === 'access' && id === 'login' && !action) {
            const data = await body(req);
            if (typeof data.token !== 'string' || !timingSafeEqual(digest(data.token), secret))
              fail('PROBE_UNAUTHENTICATED');
            for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
            if (sessions.size >= 256) fail('PROBE_SESSION_LIMIT');
            const cookie = randomBytes(32).toString('hex'),
              deviceId = randomUUID(),
              instanceId = randomUUID();
            sessions.set(cookie, { deviceId, instanceId, expires: Date.now() + 12 * 3600000 });
            res.setHeader(
              'Set-Cookie',
              '__Host-probe=' + cookie + '; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'
            );
            return json({ service: PROBE.service });
          }
          const cookie = /(?:^|;\s*)__Host-probe=([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
          const session = sessions.get(cookie);
          if (!session || session.expires <= Date.now()) fail('PROBE_UNAUTHENTICATED');
          if (group === 'session' && !action && method === 'GET' && id === 'status')
            return json(leases.status());
          const data = method === 'POST' ? await body(req) : {};
          if (group === 'session' && !action && method === 'POST' && id === 'acquire') {
            session.grant = leases.acquire({
              deviceId: session.deviceId,
              instanceId: session.instanceId,
              operationId: data.operationId
            });
            return json({ ttlMs: session.grant.ttlMs });
          }
          const lease = session.grant;
          const guard = () => {
            signal.throwIfAborted();
            if (session.expires <= Date.now()) fail('PROBE_UNAUTHENTICATED');
            leases.assertLease(lease);
          };
          guard();
          controller.generation = lease.generation;
          if (group === 'session' && !action && method === 'POST') {
            if (id === 'renew') {
              session.grant = leases.renew(lease);
              return json({ ttlMs: session.grant.ttlMs });
            }
            if (id === 'release') return json(receipt(leases.release(lease, data.operationId)));
          }
          if (group === 'identity' && !action) {
            if (id === 'open' && method === 'POST') {
              session.view = null;
              authEpoch = undefined;
              const view = await (options.fixtureView ?? gateway).openLogin();
              guard();
              session.view = pick(view, ['pageRevision', 'width', 'height']);
              return json({ ...session.view, localVerification: !options.fixtureView });
            }
            if (id === 'verify' && method === 'POST') {
              const verified = await gateway.verifyIdentity();
              guard();
              gateway.assertAuthEpoch(verified.authEpoch);
              authEpoch = verified.authEpoch;
              return json({
                verified: true,
                uid: text(String(verified.uid)).slice(0, 128),
                nickname: text(verified.nickname)?.slice(0, 120)
              });
            }
            if ((id === 'frame' && method === 'GET') || (id === 'input' && method === 'POST')) {
              if (!options.fixtureView) fail('PROBE_LOCAL_VERIFICATION_REQUIRED');
              if (!session.view) fail('PROBE_VIEW_REQUIRED');
              const revision = session.view.pageRevision;
              if (
                Number(method === 'GET' ? url.searchParams.get('revision') : data.pageRevision) !== revision
              )
                fail('PROBE_VIEW_REQUIRED');
              if (id === 'input') {
                await options.fixtureView.input({
                  ...pick(data, ['type', 'x', 'y', 'key', 'text']),
                  pageRevision: revision
                });
                guard();
                return json({ accepted: true });
              }
              const frame = await options.fixtureView.frame({ pageRevision: revision });
              guard();
              if (
                frame.pageRevision !== revision ||
                frame.mime !== 'image/png' ||
                !Buffer.isBuffer(frame.bytes) ||
                frame.bytes.length > 4 * 1024 * 1024
              )
                fail('PROBE_VIEW_REQUIRED');
              res.writeHead(200, { 'Content-Type': 'image/png' });
              return res.end(frame.bytes);
            }
          }
          if (group === 'sources' && id === 'collections' && !action && method === 'GET') {
            const epoch = authorizeSource();
            const response = await gateway.request('/aweme/v1/web/collects/list/', {
              authEpoch: epoch,
              method: 'GET',
              params: { cursor: '0', count: '20' },
              signal,
              beforeDispatch: guard
            });
            guard();
            gateway.assertAuthEpoch(epoch);
            const parsed = parsePlatformJSON(response.text);
            if (response.status !== 200 || parsed.status_code !== 0) fail('PROBE_SOURCE_UNAVAILABLE');
            const page = pageResult(parsed, 'collects_list');
            return json({
              items: normalizeCollections(page.items.slice(0, 20)).map((i) => ({
                id: i.collects_id,
                name: text(i.collects_name)
              })),
              complete: page.complete && page.items.length <= 20
            });
          }
          if (group === 'reads') {
            if (method === 'POST' && !id)
              return json(
                job(
                  reads.start({
                    source: data.source,
                    afterTotalJobId: data.afterTotalJobId,
                    operationId: data.operationId,
                    lease,
                    authEpoch: authorizeSource()
                  })
                )
              );
            if (id && !action && method === 'GET')
              return json(job(reads.snapshot(id)) ?? fail('PROBE_NOT_FOUND'));
            if (method === 'POST' && ['resume', 'pause', 'stop'].includes(action))
              return json(
                job(
                  reads[action](id, data.operationId, {
                    lease,
                    ...(action === 'resume' ? { authEpoch: authorizeSource() } : {})
                  })
                )
              );
          }
          if (group === 'library' && !id && method === 'GET') {
            const opts = { page: Number(url.searchParams.get('page') ?? 1) };
            if (url.searchParams.has('kind'))
              opts.source = { kind: url.searchParams.get('kind'), id: url.searchParams.get('id') };
            const page = store.listWorks(opts);
            return json({
              ...page,
              items: page.items.map((i) =>
                pick(i, ['id', 'name', 'type', 'author', 'remoteState', 'publishedAt', 'imageCount'])
              )
            });
          }
          if (group === 'works' && id && !action && method === 'GET') {
            const work = store.work(id) ?? fail('PROBE_NOT_FOUND');
            const resources = [];
            for (const row of store
              .resources(id)
              .filter((r) => ['video', 'image'].includes(r.kind) && r.state === 'complete')) {
              const asset = await resolveResource({ store, layout, workId: id, key: row.key, signal });
              guard();
              if (asset)
                resources.push(pick(asset, ['id', 'key', 'kind', 'mime', 'size', 'width', 'height']));
            }
            return json({
              ...pick(work, ['id', 'name', 'type', 'desc', 'publishedAt', 'remoteState', 'duration']),
              author: pick(work.author, ['nickname', 'uid']),
              resources
            });
          }
          if (group === 'works' && id && action === 'cover-check' && method === 'POST') {
            if (coverBusy) fail('PROBE_COVER_BUSY');
            coverBusy = true;
            try {
              const resolve = (key) => resolveResource({ store, layout, workId: id, key, signal });
              const video = await resolve('video'),
                cover = await resolve('cover');
              if (!video || !cover) fail('PROBE_NOT_FOUND');
              guard();
              const result = await assessRegisteredCover({
                video,
                cover,
                signal,
                authorize(resource, stat) {
                  guard();
                  assertResourceCurrent({ store, resource, stat });
                }
              });
              guard();
              return json(result);
            } finally {
              coverBusy = false;
            }
          }
          if (group === 'downloads') {
            if (!id && method === 'GET') {
              const snapshot = downloads.snapshot();
              return json({
                jobs: snapshot.jobs.map(job),
                usage: pick(snapshot.usage, [
                  'limitBytes',
                  'transferredBytes',
                  'newMediaBytes',
                  'details',
                  'selectedWorks'
                ])
              });
            }
            if (!id && method === 'POST') {
              const jobs = downloads.enqueue({ workIds: data.workIds, operationId: data.operationId });
              runDownloads();
              return json({ jobs: jobs.map(job) });
            }
            if (method === 'POST' && ['resume', 'pause', 'cancel'].includes(action)) {
              const value = downloads[action](id, data.operationId);
              runDownloads();
              return json(job(value));
            }
          }
          if (group === 'media' && id && !action && ['GET', 'HEAD'].includes(method)) {
            const row = store.db
              .prepare(
                "SELECT work_id,key FROM resources WHERE id=? AND state='complete' AND kind IN ('image','video')"
              )
              .get(id);
            if (!row) fail('PROBE_NOT_FOUND');
            const resource = await resolveResource({
              store,
              layout,
              workId: row.work_id,
              key: row.key,
              signal
            });
            if (resource?.id !== id) fail('PROBE_NOT_FOUND');
            signal.addEventListener('abort', () => res.destroy(), { once: true });
            return await serveResource(req, res, {
              resource,
              signal,
              authorize: (stat) => {
                guard();
                assertResourceCurrent({ store, resource, stat });
              }
            });
          }
          if (group === 'operations' && id && !action && method === 'GET')
            return json(receipt(store.operation(id)));
          if (group === 'report' && !id && method === 'GET')
            return json({
              service: PROBE.service,
              version: PROBE.version,
              mode: PROBE.mode,
              fieldValidation: 'pending',
              verification: 'operator-browser',
              downloadError
            });
          fail('PROBE_NOT_FOUND');
        } catch (error) {
          if (res.headersSent || signal.aborted) {
            res.destroy();
            return;
          }
          const code =
            error instanceof ProbeError && /^[A-Z_0-9]{1,80}$/.test(error.code)
              ? error.code
              : 'PROBE_REQUEST_FAILED';
          json(
            { code },
            code === 'PROBE_UNAUTHENTICATED'
              ? 401
              : code === 'PROBE_NOT_FOUND'
                ? 404
                : ['STALE_LEASE', 'PROBE_FORBIDDEN'].includes(code)
                  ? 403
                  : code.startsWith('INVALID_')
                    ? 400
                    : 409
          );
        } finally {
          active.delete(controller);
          finish();
        }
      }
    );
    const host = options.host ?? '0.0.0.0';
    if (options.fixtureView && !['localhost', '127.0.0.1', '::1'].includes(host)) fail('INVALID_PROBE_HOST');
    server.listen(options.port ?? config.port, host);
    await once(server, 'listening');
    runDownloads();
    return {
      url: 'https://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + server.address().port,
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}
