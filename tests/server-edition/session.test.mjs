import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import selfsigned from 'selfsigned';
import { openLibrary } from '../../server/library.mjs';

const token = 'a'.repeat(48);
const credentials = { A: { accountId: 'family', token }, B: { accountId: 'family', token: 'b'.repeat(48) } };
const cert = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
  keySize: 2048,
  algorithm: 'sha256'
});
async function fixture(t, options = {}) {
  const { createSessionService } = await import('../../server/session.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-session-'));
  const library = openLibrary({ root, mode: 'init' });
  t.after(() => {
    library.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  library.write((db) => db.prepare('INSERT INTO works VALUES (?,?,?)').run('99', 'synthetic', '{}'));
  const sessions = createSessionService({ library, ...options });
  t.after(() => sessions.close());
  return { library, sessions };
}
const identity = (deviceId) => ({ deviceId, accountId: 'family' });
const request = (library, deviceId) => ({
  libraryId: library.libraryId,
  deviceId,
  instanceId: randomUUID(),
  operationId: randomUUID()
});

test('exclusive owner, acquire replay, server expiry, stale reads and old boot fence', async (t) => {
  let ms = 0;
  const { library, sessions } = await fixture(t, { now: () => ms });
  const first = request(library, 'A');
  const grant = sessions.acquire(identity('A'), first);
  assert.deepEqual(sessions.acquire(identity('A'), first), grant);
  assert.throws(
    () => sessions.acquire(identity('B'), request(library, 'B')),
    (e) => e.status === 409
  );
  for (const forged of [
    { ...grant, libraryId: randomUUID() },
    { ...grant, generation: 42 },
    { ...grant, proof: '0'.repeat(64) }
  ]) {
    assert.throws(
      () => sessions.read(identity('A'), forged, () => 1),
      (e) => e.status === 403
    );
  }
  assert.throws(
    () => sessions.read(identity('B'), grant, () => 1),
    (e) => e.status === 403
  );
  assert.throws(
    () => sessions.read({ ...identity('A'), accountId: 'other' }, grant, () => 1),
    (e) => e.status === 403
  );
  ms = 19999;
  assert.equal(
    sessions.read(identity('A'), grant, () => 1),
    1
  );
  ms = 20000;
  assert.throws(
    () => sessions.read(identity('A'), grant, () => 1),
    (e) => e.status === 403
  );
  const next = sessions.acquire(identity('B'), request(library, 'B'));
  assert.ok(next.generation > grant.generation);
  const { createSessionService } = await import('../../server/session.mjs');
  const reboot = createSessionService({ library });
  t.after(() => reboot.close());
  assert.throws(
    () => sessions.read(identity('B'), next, () => 1),
    (e) => e.status === 403
  );
});
test('HTTPS clients race, pin before credentials, deduplicate commands and reject old holders after handoff', async (t) => {
  const { createHttpsService } = await import('../../server/http.mjs');
  const { pinnedRequest, ServerClient } = await import('../../electron/server-client.mjs');
  const commands = {
    'queue-fixture': (db, { payload }) => {
      const jobId = randomUUID();
      db.prepare('INSERT INTO download_jobs VALUES (?,?,?)').run(jobId, payload.id, 'queued');
      return { jobId };
    }
  };
  const { library, sessions } = await fixture(t, { commands });
  const tls = await cert;
  const server = createHttpsService({ sessions, credentials, key: tls.private, cert: tls.cert });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = {
    url: 'https://127.0.0.1:' + server.address().port,
    fingerprint: new X509Certificate(tls.cert).fingerprint256
  };
  let hits = 0;
  server.on('request', () => hits++);
  await assert.rejects(
    pinnedRequest({ ...base, fingerprint: '00'.repeat(32), deviceId: 'A', token }, 'status', {}),
    /指纹/
  );
  assert.equal(hits, 0);
  await assert.rejects(
    pinnedRequest({ ...base, deviceId: 'B', token }, 'status', {}),
    (e) => e.status === 401
  );
  const config = ['A', 'B'].map((deviceId) => ({ ...base, deviceId, token: credentials[deviceId].token }));
  const clients = config.map(() => new ServerClient());
  t.after(() => clients.forEach((c) => c.lock()));
  await Promise.all(clients.map((c, i) => c.connect(config[i])));
  const race = await Promise.allSettled(clients.map((c) => c.acquire()));
  assert.equal(race.filter((o) => o.status === 'fulfilled').length, 1);
  const index = race.findIndex((o) => o.status === 'fulfilled'),
    owner = clients[index],
    second = clients[1 - index];
  const command = {
    operationId: randomUUID(),
    kind: 'queue-fixture',
    payload: { id: '99' },
    entityVersion: 0
  };
  const original = await owner.command(command);
  const replay = await owner.command(command);
  assert.equal(replay.jobId, original.jobId);
  assert.equal((await owner.receipt(command.operationId)).jobId, original.jobId);
  await assert.rejects(owner.command({ ...command, payload: { id: '100' } }), (e) => e.status === 409);
  const priorGrant = { ...owner.grant };
  await owner.release();
  await second.acquire();
  await assert.rejects(
    pinnedRequest(config[index], 'query', { kind: 'state', grant: priorGrant }),
    (e) => e.status === 403
  );
  assert.equal((await second.receipt(command.operationId)).jobId, original.jobId);
  assert.equal(
    library.read((db) => db.prepare('SELECT count(*) AS n FROM download_jobs').get().n),
    1
  );
});
test('locked client discards delayed data and invalidates media scope even when a transport ignores abort', async () => {
  const { ServerClient } = await import('../../electron/server-client.mjs');
  let resolveRead;
  const libraryId = randomUUID();
  const c = new ServerClient({
    request: async (_config, route, body) => {
      if (route === 'status') return { occupied: false, protocolVersion: 1, libraryId };
      if (route === 'acquire')
        return {
          libraryId,
          deviceId: 'A',
          accountId: 'family',
          instanceId: body.instanceId,
          bootId: randomUUID(),
          generation: 1,
          proof: 'a'.repeat(64),
          ttlMs: 20000
        };
      return new Promise((r) => {
        resolveRead = r;
      });
    }
  });
  await c.connect({ url: 'https://localhost', deviceId: 'A', token, fingerprint: '99'.repeat(32) });
  await c.acquire();
  const signal = c.signal();
  const old = c.query('state');
  c.lock('电脑已唤醒');
  resolveRead({ title: 'must stay hidden' });
  assert.equal(signal.aborted, true);
  await assert.rejects(old, /锁定/);
  assert.equal(c.state().owned, false);
});
test(
  'normal HTTPS start and Windows Electron product entry lock on wake using an encrypted isolated profile',
  { skip: process.platform !== 'win32' || process.env.CANGXIA_DESKTOP_SESSION_TEST !== '1', timeout: 60000 },
  async (t) => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const { fileURLToPath } = await import('node:url');
    const { default: electron } = await import('electron');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-windows-'));
    const volume = path.join(root, 'volume');
    fs.mkdirSync(volume);
    const db = openLibrary({ mode: 'init', root: volume });
    db.write(conn=>{
      conn.prepare('INSERT INTO works VALUES (?,?,?)').run('99','fixture','{}');
      for(let i=0;i<43;i++){
        const id=String(9007199254740993123n+BigInt(i));
        conn.prepare('INSERT INTO works VALUES(?,?,?)').run(id,'目录 '+i,JSON.stringify({type:'images',author:{uid:'77',nickname:'春'},tags:['春游'],images:[{width:20,height:10}]}));
        if(i<4)conn.prepare('INSERT INTO media_files VALUES(?,?,?,?,?)').run('f'+i,id,i+'/image.jpg',20,'a'.repeat(64));
        if(i<42)conn.prepare("INSERT INTO source_members VALUES('total',?,?,0)").run(id,i);
      }
    });
    db.close();
    const keys = await cert,
      config = { deviceId: 'A', token, fingerprint: new X509Certificate(keys.cert).fingerprint256 };
    for (const [file, value] of Object.entries({
      'key.pem': keys.private,
      'cert.pem': keys.cert,
      'devices.json': JSON.stringify(credentials)
    }))
      fs.writeFileSync(path.join(root, file), value);
    const entry = fileURLToPath(new URL('../../server/start.mjs', import.meta.url));
    const server = spawn(process.execPath, [entry, 'start', '--root', volume, '--library-id', db.libraryId], {
      windowsHide: true,
      env: {
        ...process.env,
        CANGXIA_PORT: '0',
        CANGXIA_HOST: '127.0.0.1',
        CANGXIA_TLS_KEY_FILE: path.join(root, 'key.pem'),
        CANGXIA_TLS_CERT_FILE: path.join(root, 'cert.pem'),
        CANGXIA_DEVICES_FILE: path.join(root, 'devices.json')
      }
    });
    const stopped = once(server, 'exit');
    t.after(async () => {
      server.kill();
      await stopped;
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    });
    const [chunk] = await once(server.stdout, 'data');
    const ready = JSON.parse(String(chunk));
    assert.equal(ready.state, 'serving');
    fs.writeFileSync(
      path.join(root, 'connection.json'),
      JSON.stringify({ ...config, url: 'https://127.0.0.1:' + ready.port })
    );
    const fixture = fileURLToPath(new URL('./session-desktop.mjs', import.meta.url));
    const env = { ...process.env, CANGXIA_SESSION_FIXTURE: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const ui = spawn(electron, [fixture], { windowsHide: true, env });
    t.after(() => ui.kill());
    let output = '';
    ui.stdout.on('data', (c) => {
      output += c;
    });
    ui.stderr.on('data', (c) => {
      output += c;
    });
    const [code] = await once(ui, 'exit');
    assert.equal(code, 0, output);
    assert.match(output, /SESSION_DESKTOP_VERIFIED/);
  }
);
test('a committed command with a lost response is recovered after relaunch by ID alone', async (t) => {
  let ms = 0,
    saved = {};
  const { library, sessions } = await fixture(t, { now: () => ms });
  const { ServerClient } = await import('../../electron/server-client.mjs');
  const config = { url: 'https://localhost', deviceId: 'A', token, fingerprint: '99'.repeat(32) };
  const profile = {
    load: () => structuredClone(saved),
    save: (value) => {
      saved = structuredClone(value);
    }
  };
  const actions = [];
  const request = async (config, route, body) => {
    const who = identity(config.deviceId);
    actions.push(route);
    switch (route) {
      case 'status':
        return sessions.status();
      case 'acquire':
        return sessions.acquire(who, body);
      case 'receipt':
        return sessions.receipt(who, body.grant, body.operationId);
      case 'command':
        sessions.command(who, body.grant, body);
        throw Error('response lost');
    }
  };
  const first = new ServerClient({ request, profile, now: () => ms });
  await first.connect(config);
  await first.acquire();
  const operationId = randomUUID();
  await assert.rejects(
    first.command({
      operationId,
      kind: 'set-tags',
      payload: { id: '99', tags: ['private-fixture-tag'] },
      entityVersion: 0
    }),
    /response lost/
  );
  assert.equal(first.state().owned, false);
  assert.equal(JSON.stringify(saved).includes('private-fixture-tag'), false);
  assert.equal(JSON.stringify(saved).includes(operationId), true);
  ms = 20001;
  const next = new ServerClient({ request, profile, now: () => ms });
  t.after(() => next.lock());
  await next.connect();
  await next.acquire();
  assert.deepEqual(next.state().recent, { operationId, confirmed: true });
  assert.deepEqual(actions, ['status', 'acquire', 'command', 'status', 'acquire', 'receipt']);
  assert.equal(
    library.read((db) => db.prepare('SELECT version FROM entity_versions').get().version),
    1
  );
});
test('a version two volume is readonly on start until an explicitly verified snapshot upgrades its session schema', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const { inspectUpgrade, applyUpgrade } = await import('../../server/upgrade.mjs');
  const { APP_ID, APPLICATION_ID, upgradeV1 } = await import('../../server/library.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-schema2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'cangxia-server'),
    id = randomUUID();
  for (const target of ['media', 'snapshots']) fs.mkdirSync(path.join(dir, target), { recursive: true });
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({ appId: APP_ID, libraryId: id }));
  const dbPath = path.join(dir, 'library.sqlite'),
    db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(new URL('../../server/schema/v1.sql', import.meta.url), 'utf8'));
  db.exec(upgradeV1);
  db.prepare('INSERT INTO library_identity VALUES(1,?,?)').run(APP_ID, id);
  db.exec('PRAGMA application_id=' + APPLICATION_ID + '; PRAGMA user_version=2');
  db.close();
  const bytes = fs.readFileSync(dbPath);
  const preview = inspectUpgrade(root, id);
  assert.equal(preview.from, 2);
  assert.equal(preview.state, 'migration-required');
  assert.equal(openLibrary({ root, expectedId: id }).write, undefined);
  assert.deepEqual(fs.readFileSync(dbPath), bytes);
  const imageDigest = 'sha256:' + 'c'.repeat(64);
  const approval = {
    from: 2,
    to: preview.to,
    libraryId: id,
    operationId: randomUUID(),
    imageDigest,
    confirmed: true
  };
  const receipt = await applyUpgrade({ ...approval, expectedId: id, root, approval });
  const snapshot = new DatabaseSync(path.join(dir, receipt.snapshot, 'library.sqlite'), { readOnly: true });
  assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 2);
  snapshot.close();
  const library = openLibrary({ root, expectedId: id });
  assert.equal(
    library.read((db) => db.prepare('SELECT count(*) AS n FROM command_receipts').get().n),
    0
  );
  library.close();
});

test('client denies a mismatched holder on acquire and a changed generation during renewal', async () => {
  const { ServerClient } = await import('../../electron/server-client.mjs');
  let wrongHolder = true;
  const libraryId = randomUUID(),
    bootId = randomUUID();
  const client = new ServerClient({
    request: async (_config, route, body) => {
      if (route === 'status') return { protocolVersion: 1, occupied: false };
      if (route === 'acquire')
        return {
          libraryId,
          bootId,
          generation: 1,
          accountId: 'family',
          deviceId: wrongHolder ? 'B' : 'A',
          instanceId: body.instanceId,
          proof: 'b'.repeat(64),
          ttlMs: 20000
        };
      return { ...body.grant, generation: 42, ttlMs: 20000 };
    }
  });
  await client.connect({ url: 'https://localhost', deviceId: 'A', token, fingerprint: '88'.repeat(32) });
  await assert.rejects(client.acquire(), /锁定/);
  assert.equal(client.state().owned, false);
  wrongHolder = false;
  await client.acquire();
  await assert.rejects(client.renew(), /锁定/);
  assert.equal(client.state().owned, false);
});

test(
  'Windows temporary SHM name must disappear before a volume passes strict layout checks',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { inspectLayout } = await import('../../server/library.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-shm-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
    const lib = openLibrary({ root, mode: 'init' });
    lib.close();
    const dir = path.join(root, 'cangxia-server'),
      name = 'LIBRARY.SQLITE-SHM.tmp';
    const original = fs.readdirSync;
    let transient = true;
    const calls = t.mock.method(fs, 'readdirSync', function (target, ...args) {
      const names = original.call(this, target, ...args);
      if (target === dir && transient) {
        transient = false;
        return [...names, name];
      }
      return names;
    });
    assert.equal(inspectLayout(root, lib.libraryId).libraryId, lib.libraryId);
    calls.mock.restore();
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'unverified');
    assert.throws(() => inspectLayout(root, lib.libraryId), /Unsafe library path/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'unverified');
  }
);

test('a completed connection attempt cannot acquire after the desktop locked', async () => {
  const { ServerClient } = await import('../../electron/server-client.mjs');
  const libraryId = randomUUID(),
    calls = [];
  const client = new ServerClient({
    request: async (_config, route, body) => {
      calls.push(route);
      if (route === 'status') return { occupied: false, protocolVersion: 1 };
      return {
        libraryId,
        bootId: randomUUID(),
        accountId: 'family',
        deviceId: 'A',
        instanceId: body.instanceId,
        generation: 1,
        proof: 'b'.repeat(64),
        ttlMs: 20000
      };
    }
  });
  const config = { url: 'https://localhost', deviceId: 'A', token, fingerprint: '88'.repeat(32) };
  const prior = await client.connect(config);
  client.lock('电脑已唤醒');
  await assert.rejects(client.acquire(prior.attempt), /锁定/);
  assert.deepEqual(calls, ['status']);
  const fresh = await client.connect(config);
  await client.acquire(fresh.attempt);
  assert.deepEqual(calls, ['status', 'status', 'acquire']);
  client.lock();
});
test('release replay is bound to the issuing device, instance and current service boot', async (t) => {
  const { sessions, library } = await fixture(t);
  const grant = sessions.acquire(identity('A'), request(library, 'A')),
    id = randomUUID();
  const result = sessions.release(identity('A'), grant, id);
  const active = sessions.acquire(identity('B'), request(library, 'B'));
  assert.deepEqual(sessions.release(identity('A'), grant, id), result);
  for (const changed of [
    { ...grant, deviceId: 'B' },
    { ...grant, instanceId: randomUUID() }
  ]) {
    assert.throws(
      () => sessions.release(identity(changed.deviceId), changed, id),
      (e) => [403, 409].includes(e.status)
    );
  }
  assert.equal(
    sessions.read(identity('B'), active, () => 1),
    1
  );
  const { createSessionService } = await import('../../server/session.mjs');
  const next = createSessionService({ library });
  t.after(() => next.close());
  assert.throws(
    () => next.release(identity('A'), grant, id),
    (e) => e.status === 403
  );
  assert.throws(
    () => sessions.release(identity('A'), grant, id),
    (e) => e.status === 403
  );
});

test('lost acquire and release acknowledgements survive relaunch; only an explicit fresh attempt can recover', async (t) => {
  const { ServerClient } = await import('../../electron/server-client.mjs');
  const { sessions } = await fixture(t);
  const config = { url: 'https://localhost', deviceId: 'A', token, fingerprint: '88'.repeat(32) };
  let saved = {},
    dropAcquire = true,
    dropRelease = true,
    releaseId,
    releaseCalls = 0;
  const profile = {
    load: () => structuredClone(saved),
    save: (value) => {
      saved = structuredClone(value);
    }
  };
  const acquisitions = [],
    receipts = [];
  const request = async (config, route, body) => {
    const who = identity(config.deviceId);
    if (route === 'status') return sessions.status();
    if (route === 'acquire') {
      acquisitions.push(structuredClone(body));
      const grant = sessions.acquire(who, body);
      if (dropAcquire) {
        dropAcquire = false;
        throw Error('lost acquire ack');
      }
      return grant;
    }
    if (route === 'release') {
      releaseCalls++;
      const value = sessions.release(who, body.grant, body.operationId);
      releaseId = body.operationId;
      if (dropRelease) {
        dropRelease = false;
        throw Error('lost release ack');
      }
      return value;
    }
    if (route === 'receipt') {
      receipts.push(body.operationId);
      return sessions.receipt(who, body.grant, body.operationId);
    }
  };
  const first = new ServerClient({ profile, request });
  const initial = await first.connect(config);
  await assert.rejects(first.acquire(initial.attempt), /lost acquire/);
  assert.equal(first.state().owned, false);
  const recovered = new ServerClient({ profile, request });
  t.after(() => recovered.lock());
  const status = await recovered.connect();
  assert.equal(status.occupied, true);
  assert.equal(recovered.state().owned, false);
  await recovered.acquire(status.attempt);
  assert.deepEqual(acquisitions[1], acquisitions[0]);
  await Promise.all([
    assert.rejects(recovered.release(), /lost release/),
    assert.rejects(recovered.release(), /lost release/)
  ]);
  assert.equal(releaseCalls, 1);
  assert.equal(recovered.state().owned, false);
  assert.ok(JSON.stringify(saved).includes(releaseId));
  const next = new ServerClient({ profile, request });
  t.after(() => next.lock());
  const fresh = await next.connect();
  assert.equal(next.state().owned, false);
  assert.deepEqual(receipts, []);
  await next.acquire(fresh.attempt);
  assert.deepEqual(next.state().recent, { operationId: releaseId, confirmed: true });
  assert.deepEqual(receipts, [releaseId]);
  assert.ok(!JSON.stringify(saved).includes(releaseId));
});
