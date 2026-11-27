import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openLibrary } from '../../server/library.mjs';
import { createSessionService } from '../../server/session.mjs';
import { parseWork, parsePlatformJSON } from '../../electron/model.mjs';

import { createSourceBrowser } from '../../server/source-browser.mjs';
const fixtures = parsePlatformJSON(
  fs.readFileSync(new URL('../../feasibility/nas-b/fixtures/source-pages.json', import.meta.url), 'utf8')
);
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-source-'));
  const library = openLibrary({ root, mode: 'init' }),
    sessions = createSessionService({ library });
  const who = { deviceId: 'fixture', accountId: 'operator' };
  const grant = sessions.acquire(who, {
    deviceId: who.deviceId,
    instanceId: randomUUID(),
    operationId: randomUUID()
  });
  const session = sessions.sourceSession(who, grant);
  const provider = {
    uid: '7345612390836712341',
    phase: 'loading',
    reads: [],
    restored: false,
    async self() {
      return this.uid ? { uid: this.uid, nickname: '样本' } : null;
    },
    async sessionKey() {
      return 'synthetic-session';
    },
    async storage() {
      return { cookies: [], origins: [] };
    },
    async loginView() {
      return {
        phase: this.phase,
        ...(this.phase === 'ready' ? { image: 'data:image/png;base64,fixture' } : {})
      };
    },
    async read(request) {
      this.reads.push(request);
      return { status: 200, text: JSON.stringify(this.page || fixtures['unsafe-integer']) };
    },
    async close() {},
    async refresh() {
      this.phase = 'loading';
    }
  };
  const make = () =>
    createSourceBrowser({
      library,
      root,
      openProvider: async (saved) => {
        provider.restored = !!saved;
        return provider;
      }
    });
  const source = make();
  t.after(async () => {
    await source.close();
    sessions.close();
    library.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { source, provider, session, library, make, sessions, who, grant };
}
test('restored NAS state is verified against self, and another UID makes no change', async (t) => {
  const { source, provider, session, make, library } = setup(t);
  const first = await source.verifyAccount(session);
  assert.equal(first.uid, '7345612390836712341');
  await source.close();
  const next = make();
  t.after(() => next.close());
  const recovered = await next.recover(session);
  assert.equal(recovered.uid, first.uid);
  assert.equal(provider.restored, true);
  const dump = () => library.read((db) => db.prepare('SELECT * FROM source_account').all());
  const before = dump();
  provider.uid = '876';
  await assert.rejects(next.verifyAccount(session), { code: 'ACCOUNT_MISMATCH' });
  assert.deepEqual(dump(), before);
  assert.equal(next.account(), null);
});
test('three scoped page requests preserve decimal identities, cursors and source attribution', async (t) => {
  const { source, provider, session, sessions, who, grant } = setup(t);
  const { authEpoch } = await source.verifyAccount(session);
  const cursor = '7345612390836712344';
  for (const [kind, id, route] of [
    ['total', '__all__', 'aweme/listcollection/'],
    ['collection', '123', 'collects/video/list/'],
    ['author', 'fixture_author', 'aweme/post/']
  ]) {
    const page = await source.readSourcePage({
      source: { kind, id },
      cursor,
      authEpoch,
      signal: session.signal
    });
    const req = provider.reads.at(-1),
      url = new URL(req.url);
    assert.ok(url.pathname.endsWith(route));
    assert.equal(
      kind === 'total'
        ? new URLSearchParams(req.body).get('cursor')
        : url.searchParams.get(kind === 'author' ? 'max_cursor' : 'cursor'),
      cursor
    );
    assert.deepEqual(page.source, { kind, id });
    assert.equal(page.works[0].id, '7345612390836712343');
    assert.equal(page.works[0].music.id, '7345612390836712347');
    assert.equal(page.nextCursor, '7345612390836712345');
  }
  const input = { source: { kind: 'total', id: '__all__' }, cursor, authEpoch, signal: session.signal };
  await assert.rejects(
    source.readSourcePage({ ...input, source: { kind: 'url', id: 'https://fixture.invalid' } })
  );
  provider.uid = '998';
  await assert.rejects(source.readSourcePage(input), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(provider.reads.length, 3);
  sessions.release(who, grant, randomUUID());
  await assert.rejects(source.verifyAccount(session));
});
test('media and detail fields match the baseline including unknown and verified co-authors', async (t) => {
  const { source, provider, session } = setup(t);
  const { authEpoch } = await source.verifyAccount(session);
  provider.page = fixtures.media;
  const page = await source.readSourcePage({
    source: { kind: 'total', id: '__all__' },
    cursor: '0',
    authEpoch,
    signal: session.signal
  });
  const raw = fixtures.media.data.aweme_list[0],
    baseline = parseWork(raw);
  const work = page.works[0];
  assert.deepEqual(work.coAuthors, baseline.coAuthors);
  assert.equal(work.coAuthors[0].roleTitle, 'Camera');
  assert.deepEqual(work.music, baseline.music);
  assert.deepEqual(work.coverVariants, baseline.coverVariants);
  assert.deepEqual(
    page.aux.audioSourceHints[0].sources.map((s) => s.kind),
    ['music', 'work']
  );
  const rawDetail = { ...raw };
  delete rawDetail.cooperation_info;
  provider.page = { aweme_detail: rawDetail };
  const detail = await source.readDetail({ workId: work.id, authEpoch, signal: session.signal });
  assert.equal(detail.coAuthorsState, 'unknown');
  assert.ok(detail.creatorsCheckedAt);
  provider.page = { aweme_list: [rawDetail], has_more: false };
  assert.equal(
    (await source.readSourcePage({ source: page.source, cursor: '0', authEpoch, signal: session.signal }))
      .works[0].coAuthorsState,
    undefined
  );
});
test('lost holder cannot deliver a QR or bind the result of an in-flight verification', async (t) => {
  const { source, provider, session, sessions, who, grant, library } = setup(t);
  const pending = Promise.withResolvers(),
    entered = Promise.withResolvers();
  provider.self = () => {
    entered.resolve();
    return pending.promise;
  };
  const verifying = source.verifyAccount(session);
  await entered.promise;
  sessions.release(who, grant, randomUUID());
  pending.resolve({ uid: '12', nickname: 'late' });
  await assert.rejects(verifying);
  assert.equal(
    library.read((db) => db.prepare('SELECT count(*) n FROM source_account').get().n),
    0
  );
  await assert.rejects(source.openLogin(session));
});

test('bundled Chromium handles late official 4.0.8 dialog, repaint, expiry and explicit human OTP offline', async (t) => {
  const { exerciseProvider } = await import('./source-provider-fixture.mjs');
  const provider = await import('../../server/source-provider.mjs').catch(() => ({}));
  await exerciseProvider(t, provider.openOfficialProvider);
});
test('pinned HTTPS source login requires the live grant, supports QR polling and accepts no caller route', async (t) => {
  const { source, provider, sessions, who, grant } = setup(t);
  const { config } = await httpsFixture(t, sessions, source);
  const { pinnedRequest } = await import('../../electron/server-client.mjs');
  const call = (route, body) => pinnedRequest(config, route, body);
  await assert.rejects(call('source/open', {}), { code: 'SESSION_LOST' });
  const login = await call('source/open', { grant });
  assert.equal(login.phase, 'loading');
  provider.phase = 'ready';
  const qr = await call('source/view', { grant, viewId: login.viewId });
  assert.match(qr.image, /^data:image\/png/);
  const identity = await call('identity/verify', { grant });
  assert.equal(identity.uid, provider.uid);
  await assert.rejects(call('source/open', { grant, url: 'https://fixture.invalid' }), {
    code: 'INVALID_REQUEST'
  });
  await assert.rejects(call('source/read', { grant }), { code: 'UNKNOWN_ROUTE' });
  sessions.release(who, grant, randomUUID());
  await assert.rejects(call('source/view', { grant, viewId: login.viewId }), { code: 'SESSION_LOST' });
});

async function httpsFixture(t, sessions, source) {
  const { createHttpsService } = await import('../../server/http.mjs');
  const { default: selfsigned } = await import('selfsigned');
  const { X509Certificate } = await import('node:crypto');
  const tls = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256'
  });
  const token = 'fixture'.repeat(7);
  const svc = createHttpsService({
    sessions,
    source,
    credentials: { fixture: { accountId: 'operator', token } },
    key: tls.private,
    cert: tls.cert
  });
  await new Promise((r) => svc.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => svc.close(r)));
  return {
    config: {
      url: 'https://127.0.0.1:' + svc.address().port,
      deviceId: 'fixture',
      token,
      fingerprint: new X509Certificate(tls.cert).fingerprint256
    }
  };
}
test(
  'actual Windows account button opens the NAS QR, verifies the NAS account and locks on wake',
  {
    skip: process.platform !== 'win32' || process.env.CANGXIA_DESKTOP_SESSION_TEST !== '1',
    timeout: 60000
  },
  async (t) => {
    const { source, provider, who, grant, sessions, library } = setup(t);
    sessions.release(who, grant, randomUUID());
    sessions.close();
    const live = createSessionService({ library, source });
    t.after(() => live.close());
    const { config } = await httpsFixture(t, live, source);
    provider.phase = 'ready';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-source-desktop-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    fs.writeFileSync(path.join(root, 'connection.json'), JSON.stringify(config));
    const { spawn } = await import('node:child_process'),
      { once } = await import('node:events'),
      { fileURLToPath } = await import('node:url');
    const { default: electron } = await import('electron');
    const env = { ...process.env, CANGXIA_SESSION_FIXTURE: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [fileURLToPath(new URL('./source-desktop.mjs', import.meta.url))], {
      env,
      windowsHide: true
    });
    t.after(() => child.kill());
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    assert.match(output, /SOURCE_DESKTOP_VERIFIED/);
  }
);
test('changed provider session during self verification cannot persist an identity or credential', async (t) => {
  const { source, provider, session, library } = setup(t);
  let binding = 'first';
  provider.sessionKey = async () => binding;
  provider.storage = async () => {
    binding = 'second';
    return { cookies: [], origins: [] };
  };
  await assert.rejects(source.verifyAccount(session), { code: 'SOURCE_SESSION_LOST' });
  assert.equal(
    library.read((db) => db.prepare('SELECT count(*) n FROM source_account').get().n),
    0
  );
});
test('rate-limit pauses subsequent pages and refuses to expose a cursor or provider response', async (t) => {
  const { source, provider, session } = setup(t);
  const { authEpoch } = await source.verifyAccount(session);
  let calls = 0;
  provider.read = async () => {
    calls++;
    return { status: 429, retryAfter: 60, text: 'fixture-private-session-marker' };
  };
  const input = { source: { kind: 'total', id: '__all__' }, cursor: '0', authEpoch, signal: session.signal };
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      source.readSourcePage(input),
      (err) =>
        err.code === 'SOURCE_RATE_LIMITED' && !JSON.stringify(err).includes('fixture-private-session-marker')
    );
  assert.equal(calls, 1);
});
test('schema 3 acquires a verified rollback snapshot before adding the NAS source binding', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const { CURRENT_SCHEMA } = await import('../../server/library.mjs');
  const { inspectUpgrade, applyUpgrade } = await import('../../server/upgrade.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-source-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = openLibrary({ root, mode: 'init' }),
    expectedId = library.libraryId;
  library.close();
  const dir = path.join(root, 'cangxia-server'),
    file = path.join(dir, 'library.sqlite');
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE source_account; PRAGMA user_version=3; INSERT INTO works VALUES('29','fixture','{}')");
  db.close();
  const bytes = fs.readFileSync(file);
  const preview = inspectUpgrade(root, expectedId);
  assert.equal(preview.state, 'migration-required');
  assert.equal(preview.from, 3);
  assert.deepEqual(fs.readFileSync(file), bytes);
  const approval = {
    from: 3,
    to: CURRENT_SCHEMA,
    libraryId: expectedId,
    operationId: randomUUID(),
    confirmed: true,
    imageDigest: 'sha256:' + 'c'.repeat(64)
  };
  const receipt = await applyUpgrade({ ...approval, root, expectedId, approval });
  const snapshot = new DatabaseSync(path.join(dir, receipt.snapshot, 'library.sqlite'), { readOnly: true });
  assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 3);
  snapshot.close();
  const upgraded = openLibrary({ root, expectedId });
  t.after(() => upgraded.close());
  assert.deepEqual(
    upgraded.read((conn) => [
      conn.prepare("SELECT title FROM works WHERE id='29'").get().title,
      conn.prepare('SELECT count(*) n FROM source_account').get().n
    ]),
    ['fixture', 0]
  );
});
