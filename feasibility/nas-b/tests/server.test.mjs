import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { openProbeStore } from '../src/store.mjs';
import { parseSourcePage } from '../src/page-parser.mjs';
import { createDownloads } from '../src/downloads.mjs';
import { randomBytes } from 'node:crypto';
import { writeTestCertificate } from '../../../tests/test-certificate.mjs';
import { makeSandbox, fakeClock } from './helpers.mjs';
import { startProbe } from '../src/server.mjs';
import { createClientGate } from '../web/app.mjs';
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
test('HTTPS requires authentication and current ownership before library or verification access', async (t) => {
  const s = await makeSandbox(t),
    token = randomBytes(32).toString('hex');
  const layout = await s.prepare();
  await writeTestCertificate(layout.state);
  const cert = await readFile(path.join(layout.state, 'cert.pem'));
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
    epochs = [];
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
    tls: { cert, key: await readFile(path.join(layout.state, 'key.pem')) },
    token,
    host: '127.0.0.1',
    port: 0,
    gateway
  });
  s.onCleanup(probe.close);
  function request(route, body, cookie, { method, range } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        new URL('/probe/v1/' + route, probe.url),
        {
          ca: cert,
          servername: 'localhost',
          method: method ?? (body ? 'POST' : 'GET'),
          headers: {
            ...(range ? { range } : {}),
            ...(cookie ? { cookie } : {}),
            ...(body ? { 'content-type': 'application/json' } : {})
          }
        },
        (res) => {
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
  const a = await request('access/login', { token }),
    b = await request('access/login', { token });
  assert.ok(a.cookie && b.cookie && a.cookie !== b.cookie);
  assert.equal((await request('session/acquire', { operationId: 'alpha' }, a.cookie)).status, 200);
  for (const route of ['library', 'identity/frame', 'media/unknown', 'report'])
    assert.equal((await request(route, null, b.cookie)).status, 403);
  const opened = await request('identity/open', {}, a.cookie);
  assert.equal(opened.body.localVerification, true);
  assert.equal(
    (await request('identity/input', { type: 'text', text: 'fixture' }, a.cookie)).body.code,
    'PROBE_LOCAL_VERIFICATION_REQUIRED'
  );
  assert.deepEqual((await request('identity/verify', { authEpoch: 333 }, a.cookie)).body, {
    verified: true,
    uid: '123',
    nickname: 'fixture'
  });
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
  assert.equal((await request('session/release', { operationId: 'done' }, a.cookie)).status, 200);
  assert.equal((await request('session/acquire', { operationId: 'beta' }, b.cookie)).status, 200);
  assert.equal((await request('operations/done', null, b.cookie)).body.released, true);
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
test('an existing marked layout cannot reinitialize a missing database', async (t) => {
  const s = await makeSandbox(t);
  await s.prepare();
  await assert.rejects(startProbe({ config: s.config, layout: await s.prepare() }));
  assert.equal(await s.exists('state/library.sqlite'), false);
});
