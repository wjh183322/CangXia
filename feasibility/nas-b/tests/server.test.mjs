import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { openProbeStore } from '../src/store.mjs';
import { parseSourcePage } from '../src/page-parser.mjs';
import { createDownloads } from '../src/downloads.mjs';
import { randomBytes, X509Certificate } from 'node:crypto';
import { generate } from 'selfsigned';
import { makeSandbox, fakeClock } from './helpers.mjs';
import { startProbe } from '../src/server.mjs';
import { createClientGate } from '../web/app.mjs';
import { PROBE, ProbeError } from '../src/contracts.mjs';
test('wake locks synchronously and losing the grant rejects a late renewal', async () => {
  let finish;
  const gate = createClientGate({
    clock: fakeClock(),
    renew: () => new Promise((r) => (finish = r)),
    onLock() {}
  });
  const pending = gate.resumeCheck();
  assert.equal(gate.locked, true);
  gate.lock();
  finish({ ttlMs: 10000 });
  await pending;
  assert.equal(gate.locked, true);
  gate.dispose();
});
test('clearing the owner QR removes its image and ignores a late response', async () => {
  const { createQrView } = await import('../web/app.mjs');
  const image = { hidden: true, removeAttribute() { delete this.src; } };
  const clock = fakeClock();
  let response;
  let revoked;
  const view = createQrView({
    image, clock,
    urls: { createObjectURL: () => 'blob:fixture', revokeObjectURL: (url) => { revoked = url; } },
    load: (_revision, signal) => new Promise(resolve => { response = { resolve, signal }; })
  });
  const late = view.show(7);
  view.clear();
  assert.equal(response.signal.aborted, true);
  response.resolve(new Blob(['fixture'], { type: 'image/png' }));
  await late;
  assert.equal(image.src, undefined);
  const fresh = view.show(8);
  response.resolve(new Blob(['fixture'], { type: 'image/png' }));
  await fresh;
  assert.equal(image.src, 'blob:fixture');
  assert.equal(image.hidden, false);
  clock.advance(20001);
  assert.equal(revoked, 'blob:fixture');
  assert.equal(image.hidden, true);
  assert.equal(image.src, undefined);
});
test('repeated release while confirmation is pending shares the same request', async () => {
  const { createClientOperations } = await import('../web/app.mjs');
  let complete;
  const posted = [];
  const client = createClientOperations(async (_route, body) => {
    posted.push(body.operationId);
    return new Promise(resolve => { complete = resolve; });
  });
  const first = client.send('session/release', {});
  const duplicate = client.send('session/release', {});
  assert.deepEqual(posted, [client.last('release')]);
  complete({ released: true });
  assert.equal((await first).released, true);
  assert.equal((await duplicate).released, true);
});
test('HTTPS requires authentication and current ownership before library or verification access', async (t) => {
  const s = await makeSandbox(t),
    token = randomBytes(32).toString('hex');
  const layout = await s.prepare();
  const identity = await generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 7, ip: '127.0.0.1' },
          { type: 2, value: 'localhost' }
        ]
      }
    ]
  });
  const cert = identity.cert;
  const store = openProbeStore({
    file: path.join(layout.state, 'fixture.sqlite'),
    libraryId: s.config.libraryId,
    initialize: true
  });
  s.onCleanup(() => store.close());
  const workId = '7650000000000000001',
    source = { kind: 'total', id: '__all__' };
  const work = {
    aweme_id: workId,
    desc: '本地夹具',
    author: { uid: '42', nickname: 'fixture' },
    images: [
      {
        origin_image: { uri: 'pic-1', url_list: ['https://p3.douyinpic.com/asset?x-signature=signed-secret'] }
      }
    ]
  };
  const read = store.createReadJob({ source, authEpoch: 3 });
  const page = parseSourcePage({
    source,
    inputCursor: '0',
    status: 200,
    observedAt: '2026-01-01T00:00:00Z',
    text: JSON.stringify({ has_more: 0, aweme_list: [work] })
  });
  store.commitPage({ jobId: read.id, epoch: read.epoch, authEpoch: 3, operationId: 'page', page }, () => {});
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64'
  );
  let verified = false,
    epochs = [],
    qrCaptures = 0,
    onQrCapture;
  const qrPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4CAAAAAAcD2kOAAAATElEQVR4nO3NAQkAAAwDoPUvvcU4HC1geiRisVgsFovFYrFYLBaLxWKxWCwWi8VisVgsFovFYrFYLBaLxWKxWCwWi8VisVgsFou/xQMh7wsJH5s1mQAAAABJRU5ErkJggg==',
    'base64'
  );
  const gateway = {
    assertAuthEpoch(epoch) {
      if (verified) assert.equal(epoch, 3);
    },
    async mediaHeaders() {
      return new Headers();
    },
    close() {},
    async openLogin() {
      return { pageRevision: 7, width: 120, height: 80 };
    },
    async loginQr({ pageRevision }) {
      qrCaptures++;
      await onQrCapture?.();
      return { pageRevision, bytes: qrPng };
    },
    async verifyIdentity() {
      verified = true;
      store.db
        .prepare('INSERT OR REPLACE INTO runtime_meta VALUES (?,?)')
        .run('browser_auth', JSON.stringify({ uid: '123', authEpoch: 3 }));
      return { authEpoch: 3, uid: '123', nickname: 'fixture', cookie: 'private-cookie' };
    },
    async request(route, options) {
      epochs.push(options.authEpoch);
      assert.equal(route, '/aweme/v1/web/collects/list/');
      return {
        status: 200,
        text: JSON.stringify({
          status_code: 0,
          has_more: 0,
          collects_list: [{ collects_id_str: '123', collects_name: 'fixture', url: 'https://secret.local' }]
        })
      };
    }
  };
  const downloads = createDownloads({
    store,
    gateway,
    layout,
    fetchAsset: async () =>
      new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) } })
  });
  const probe = await startProbe({
    config: s.config,
    layout,
    store,
    downloads,
    tls: { cert, key: identity.private },
    token,
    host: '127.0.0.1',
    port: 0,
    gateway
  });
  s.onCleanup(probe.close);
  function request(route, body, cookie, { method, range, discardResponse, origin } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        new URL('/probe/v1/' + route, probe.url),
        {
          ca: cert,
          servername: 'localhost',
          method: method ?? (body ? 'POST' : 'GET'),
          headers: {
            ...(range ? { range } : {}),
            ...(origin ? { origin } : {}),
            ...(cookie ? { cookie } : {}),
            ...(body ? { 'content-type': 'application/json' } : {})
          }
        },
        (res) => {
          if (discardResponse) {
            res.destroy();
            reject(Error('connection closed'));
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: res.headers['content-type']?.includes('application/json')
                ? JSON.parse(Buffer.concat(chunks))
                : Buffer.concat(chunks),
              cookie: res.headers['set-cookie']?.[0].split(';')[0]
            })
          );
        }
      );
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  assert.equal((await request('library')).status, 401);
  assert.equal((await request('identity/qr?revision=7')).status, 401);
  const a = await request('access/login', { token }),
    b = await request('access/login', { token });
  assert.ok(a.cookie && b.cookie && a.cookie !== b.cookie);
  assert.equal((await request('session/acquire', { operationId: 'alpha' }, a.cookie)).status, 200);
  for (const route of ['library', 'identity/frame', 'identity/qr?revision=7', 'media/unknown', 'report'])
    assert.equal((await request(route, null, b.cookie)).status, 403);
  assert.equal((await request('identity/qr?revision=7', null, a.cookie)).body.code, 'PROBE_VIEW_REQUIRED');
  const opened = await request('identity/open', {}, a.cookie);
  assert.equal(opened.body.localVerification, true);
  assert.equal((await request('identity/qr?revision=7', null, a.cookie, { origin: 'https://other.invalid' })).status, 403);
  assert.equal((await request('identity/qr?revision=6', null, a.cookie)).body.code, 'PROBE_VIEW_REQUIRED');
  assert.equal((await request('identity/qr?revision=07', null, a.cookie)).body.code, 'PROBE_VIEW_REQUIRED');
  assert.equal(qrCaptures, 0);
  const qr = await request('identity/qr?revision=7', null, a.cookie);
  assert.equal(qr.status, 200);
  assert.equal(qr.headers['content-type'], 'image/png');
  assert.equal(qr.headers['cache-control'], 'no-store');
  assert.deepEqual(qr.body, qrPng);
  onQrCapture = () => { throw new ProbeError('PROBE_QR_UNAVAILABLE'); };
  assert.equal((await request('identity/qr?revision=7', null, a.cookie)).body.code, 'PROBE_QR_UNAVAILABLE');
  assert.equal(
    (await request('identity/input', { type: 'text', text: 'fixture' }, a.cookie)).body.code,
    'PROBE_LOCAL_VERIFICATION_REQUIRED'
  );
  let captureStarted, finishCapture;
  const captureReady = new Promise(resolve => { captureStarted = resolve; });
  onQrCapture = () => new Promise(resolve => {
    finishCapture = resolve;
    captureStarted();
  });
  const staleCapture = request('identity/qr?revision=7', null, a.cookie);
  await captureReady;
  assert.deepEqual((await request('identity/verify', { authEpoch: 333 }, a.cookie)).body, {
    verified: true,
    uid: '123',
    nickname: 'fixture'
  });
  finishCapture();
  assert.equal((await staleCapture).body.code, 'PROBE_VIEW_REQUIRED');
  assert.equal((await request('identity/qr?revision=7', null, a.cookie)).body.code, 'PROBE_VIEW_REQUIRED');
  const collections = await request('sources/collections', null, a.cookie);
  assert.equal(collections.body.items[0].id, '123');
  assert.equal(JSON.stringify(collections.body).includes('secret.local'), false);
  assert.deepEqual(epochs, [3]);
  assert.equal((await request('library', null, a.cookie)).body.total, 1);
  await request('downloads', { workIds: [workId], operationId: 'download' }, a.cookie);
  await downloads.run();
  const detail = (await request('works/' + workId, null, a.cookie)).body;
  assert.equal(JSON.stringify(detail).includes('signed-secret'), false);
  const media = 'media/' + encodeURIComponent(detail.resources[0].id);
  const head = await request(media, null, a.cookie, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), png.length);
  const partial = await request(media, null, a.cookie, { range: 'bytes=2-5' });
  assert.equal(partial.status, 206);
  assert.deepEqual(partial.body, png.subarray(2, 6));
  const invalid = await request(media, null, a.cookie, { range: 'bytes=999-' });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers['content-range'], 'bytes */' + png.length);
  assert.equal((await request(media, null, b.cookie)).status, 403);
  const { createClientOperations } = await import('../web/app.mjs');
  let loseRelease = true;
  const client = createClientOperations(async (route, body) => {
    const discardResponse = route === 'session/release' && loseRelease;
    if (discardResponse) loseRelease = false;
    const reply = await request(route, body, a.cookie, { discardResponse });
    if (reply.status !== 200) throw Error(reply.body.code);
    return reply.body;
  });
  await assert.rejects(client.send('session/release', {}), /connection closed/);
  const lostId = client.last('release');
  assert.ok(lostId);
  const gate = createClientGate({ clock: fakeClock(), renew: () => ({ ttlMs: 10000 }), onLock() {} });
  gate.lock();
  await assert.rejects(client.send('session/release', {}), /STALE_LEASE/);
  assert.equal(client.last('release'), lostId);
  await client.send('session/acquire', {});
  assert.notEqual(client.last('acquire'), lostId);
  assert.equal(client.last('release'), lostId);
  assert.equal((await client.lookup('release')).operationId, lostId);
  assert.equal((await client.lookup('release')).released, true);
  assert.equal((await request('identity/open', {}, a.cookie)).status, 200);
  const leaseCaptureReady = new Promise(resolve => { captureStarted = resolve; });
  const leaseCapture = assert.rejects(request('identity/qr?revision=7', null, a.cookie), { code: 'ECONNRESET' });
  await leaseCaptureReady;
  await client.send('session/release', {});
  assert.notEqual(client.last('release'), lostId);
  finishCapture();
  await leaseCapture;
  await client.send('session/acquire', {});
  assert.equal((await request('identity/qr?revision=7', null, a.cookie)).body.code, 'PROBE_VIEW_REQUIRED');
  await client.send('session/release', {});
  assert.equal((await request('session/acquire', { operationId: 'beta' }, b.cookie)).status, 200);
  assert.equal((await request('operations/' + lostId, null, b.cookie)).body.released, true);
  assert.equal((await request('report', null, b.cookie)).body.service, 'cangxia-server-probe');
});
test('heartbeat keeps foreground data and expires a hung renewal', async () => {
  const clock = fakeClock();
  let renew = async () => ({ ttlMs: 10000 }),
    locks = 0;
  const gate = createClientGate({
    clock,
    renew: () => renew(),
    onLock() {
      locks++;
    }
  });
  await gate.resumeCheck();
  const initial = locks,
    ticket = gate.generation;
  await gate.heartbeat();
  assert.equal(gate.generation, ticket);
  assert.equal(locks, initial);
  renew = () => new Promise(() => {});
  void gate.heartbeat();
  clock.advance(3001);
  assert.equal(gate.locked, true);
});
test('a legacy completed marker cannot reinitialize a missing database', async (t) => {
  const s = await makeSandbox(t);
  await s.write(PROBE.marker, JSON.stringify({
    service: PROBE.service, version: PROBE.markerVersion, runId: s.config.runId, libraryId: s.config.libraryId
  }));
  await assert.rejects(startProbe({ config: s.config, layout: await s.prepare(), host: '127.0.0.1' }),
    { code: 'PROBE_DB_MISSING' });
  assert.equal(await s.exists('state/library.sqlite'), false);
});

test('first startup resumes after the root is claimed and before the database exists', async (t) => {
  const s = await makeSandbox(t);
  await s.prepare();
  assert.equal(await s.exists('state/library.sqlite'), false);
  await assert.rejects(s.prepare({ libraryId: 'foreign-library' }), { code: 'FOREIGN_DATA_ROOT' });
  const identity = await generate([{ name: 'commonName', value: 'probe-nas.local' }], {
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'probe-nas.local' }] }]
  });
  const probe = await startProbe({
    config: { ...s.config, accessHost: 'probe-nas.local' }, layout: await s.prepare(),
    host: '127.0.0.1', port: 0, gateway: { close() {} },
    token: randomBytes(32).toString('hex'), tls: { key: identity.private, cert: identity.cert }
  });
  await probe.close();
  assert.equal(await s.exists('state/library.sqlite'), true);
});

test('first startup can initialize an empty database file left by an interrupted creation', async (t) => {
  const s = await makeSandbox(t);
  await s.prepare();
  await s.write('state/library.sqlite', '');
  const identity = await generate([{ name: 'commonName', value: 'probe-nas.local' }], {
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'probe-nas.local' }] }]
  });
  const probe = await startProbe({
    config: { ...s.config, accessHost: 'probe-nas.local' }, layout: await s.prepare(),
    host: '127.0.0.1', port: 0, gateway: { close() {} },
    token: randomBytes(32).toString('hex'), tls: { key: identity.private, cert: identity.cert }
  });
  await probe.close();
  const database = openProbeStore({ file: path.join(s.root, 'state', 'library.sqlite'), libraryId: s.config.libraryId });
  database.close();
});

test('first startup rejects foreign content in a claimed but incomplete root', async (t) => {
  const s = await makeSandbox(t);
  await s.prepare();
  await s.write('media/foreign.txt', 'owned fixture');
  await assert.rejects(startProbe({ config: s.config, layout: await s.prepare(), host: '127.0.0.1' }),
    { code: 'FOREIGN_DATA_ROOT' });
  assert.equal(await s.exists('state/library.sqlite'), false);
  assert.equal(await s.read('media/foreign.txt'), 'owned fixture');
});

test('first startup recovers a partial TLS pair and keeps completed credentials', async (t) => {
  if (spawnSync('openssl', ['version'], { windowsHide: true }).error?.code === 'ENOENT') {
    t.skip('OpenSSL CLI unavailable on this host');
    return;
  }
  const s = await makeSandbox(t);
  const state = (await s.prepare()).state;
  const file = path.join(state, 'library.sqlite');
  openProbeStore({ file, libraryId: s.config.libraryId, initialize: true }).close();
  const token = randomBytes(32).toString('hex');
  await s.write('state/access.token', token);
  await s.write('state/server.key', 'interrupted private key');
  const start = async () => startProbe({
    config: { ...s.config, accessHost: 'probe-nas.local' }, layout: await s.prepare(),
    host: '127.0.0.1', port: 0, gateway: { close() {} }
  });
  await (await start()).close();
  const certificate = await s.read('state/server.pem');
  const key = await s.read('state/server.key');
  assert.equal(new X509Certificate(certificate).checkHost('probe-nas.local'), 'probe-nas.local');
  assert.equal(await s.read('state/access.token'), token);
  await (await start()).close();
  assert.equal(await s.read('state/server.pem'), certificate);
  assert.equal(await s.read('state/server.key'), key);

  await unlink(path.join(state, 'server.pem'));
  await assert.rejects(start(), { code: 'ENOENT' });
  assert.equal(await s.exists('state/server.pem'), false);
  assert.equal(await s.read('state/server.key'), key);
  assert.equal(await s.read('state/access.token'), token);
});
test('a restart verifies the configured LAN certificate identity before opening a browser or listener', async (t) => {
  const s = await makeSandbox(t);

  const pem = await generate([{ name: 'commonName', value: 'decoy.local' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'probe-nas.local' },
          { type: 7, ip: '192.168.2.40' }
        ]
      }
    ]
  });
  const initial = await s.prepare();
  const token = randomBytes(32).toString('hex');
  const tls = { cert: pem.cert, key: pem.private };
  const start = (address, layout, overrides = {}) =>
    startProbe({
      config: { ...s.config, accessHost: address },
      port: 0,
      host: '127.0.0.1',
      layout,
      token,
      gateway: { close() {} },
      ...overrides
    });
  const probe = await start('192.168.2.40', initial, { tls });
  assert.match(probe.url, /^https:\/\/192\.168\.2\.40:/);
  await probe.close();
  await s.write('state/server.pem', pem.cert);
  await s.write('state/server.key', pem.private);
  const restarted = await start('probe-nas.local', await s.prepare());
  await restarted.close();
  const parameters = await s.prepare();
  for (const host of ['192.168.2.41', 'decoy.local']) {
    const attempt = await start(host, parameters).catch((e) => e);
    if (attempt.close) await attempt.close();
    assert.equal(attempt.code, 'PROBE_TLS_IDENTITY');
  }
  const wrongKey = await generate([{ name: 'commonName', value: 'probe-nas.local' }], { keySize: 2048 });
  await assert.rejects(
    start('probe-nas.local', parameters, { tls: { cert: pem.cert, key: wrongKey.private } }),
    { code: 'PROBE_TLS_IDENTITY' }
  );
  for (const host of [
    '8.8.8.8',
    'domain.com',
    '*.local',
    'nas.local,IP:1.2.3.4',
    '-evil',
    'localhost',
    'localhost.local'
  ]) {
    const attempt = await start(host, parameters, { tls }).catch((e) => e);
    if (attempt.close) await attempt.close();
    assert.equal(attempt.code, 'INVALID_PROBE_ACCESS_HOST');
  }
});
test('fresh OpenSSL profile issues an exact LAN SAN and reuses its certificate after restart', async (t) => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('openssl', ['version'], { windowsHide: true }).error?.code === 'ENOENT') {
    t.skip('OpenSSL CLI unavailable on this host');
    return;
  }
  const { X509Certificate } = await import('node:crypto');
  const s = await makeSandbox(t),
    address = '192.168.201.19';
  const config = { ...s.config, accessHost: address };
  const start = async () =>
    startProbe({ config, layout: await s.prepare(), host: '127.0.0.1', port: 0, gateway: { close() {} } });
  const initial = await start();
  await initial.close();
  const file = path.join(s.root, 'state', 'server.pem'),
    first = new X509Certificate(await readFile(file));
  assert.equal(first.checkIP(address), address);
  assert.equal(first.checkIP('127.0.0.1'), undefined);
  assert.equal(first.checkHost('localhost'), undefined);
  const next = await start();
  await next.close();
  assert.equal(new X509Certificate(await readFile(file)).fingerprint256, first.fingerprint256);
});
