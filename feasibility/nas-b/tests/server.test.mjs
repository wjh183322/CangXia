import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { openProbeStore } from '../src/store.mjs';
import { parseSourcePage } from '../src/page-parser.mjs';
import { createDownloads } from '../src/downloads.mjs';
import { randomBytes } from 'node:crypto';
import { generate } from 'selfsigned';
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
    tls: { cert, key: identity.private },
    token,
    host: '127.0.0.1',
    port: 0,
    gateway
  });
  s.onCleanup(probe.close);
  function request(route, body, cookie, { method, range, discardResponse } = {}) {
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
  await client.send('session/acquire', {});
  assert.notEqual(client.last('acquire'), lostId);
  assert.equal(client.last('release'), lostId);
  assert.equal((await client.lookup('release')).operationId, lostId);
  assert.equal((await client.lookup('release')).released, true);
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
test('an existing marked layout cannot reinitialize a missing database', async (t) => {
  const s = await makeSandbox(t);
  await s.prepare();
  await assert.rejects(startProbe({ config: s.config, layout: await s.prepare(), host: '127.0.0.1' }));
  assert.equal(await s.exists('state/library.sqlite'), false);
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
