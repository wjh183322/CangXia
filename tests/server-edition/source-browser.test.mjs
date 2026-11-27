import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openLibrary } from '../../server/library.mjs';
import {createDownloads} from '../../server/downloads.mjs';
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
        ...(this.phase === 'ready'
          ? {
              image:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ZkAAAAASUVORK5CYII=',
              imageToken: 'fixture-render-token'
            }
          : {})
      };
    },
    async read(request) {
      this.reads.push(request);
      return { status: 200, text: JSON.stringify(this.page || fixtures['unsafe-integer']) };
    },
    async beginLogin() {},
    endLogin() {},
    async qrShown(token) {
      this.shown = token;
      return {};
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
        provider.lastSaved = saved;
        return provider;
      }
    });
  const source = make();
  const cleanups=[];
  t.after(async () => {
    for(const fn of cleanups)await fn();
    await source.close();
    sessions.close();
    library.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { source, provider, session, library, make, sessions, who, grant, root, cleanups };
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
    assert.equal(url.origin, 'https://www.douyin.com');
    assert.equal(url.pathname, '/aweme/v1/web/' + route);
    assert.equal(req.method, kind === 'total' ? 'POST' : 'GET');
    const fixed = {
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      update_version_code: '170400',
      pc_client_type: '1',
      version_code: '190500',
      version_name: '19.5.0'
    };
    const params =
      kind === 'collection'
        ? { collects_id: '123', cursor, count: '30' }
        : kind === 'author'
          ? {
              sec_user_id: 'fixture_author',
              max_cursor: cursor,
              count: '30',
              locate_query: 'false',
              publish_video_strategy_type: '2'
            }
          : {};
    assert.deepEqual(Object.fromEntries(url.searchParams), { ...fixed, ...params });
    assert.equal(req.body, kind === 'total' ? 'cursor=' + cursor + '&count=30' : null);
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
    const { source, provider, who, grant, sessions, library,root:volume,cleanups } = setup(t);
    sessions.release(who, grant, randomUUID());
    sessions.close();
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
    const downloads=createDownloads({library,root:volume,source,fetchAsset:async url=>{
      assert.equal(url,'https://p3.douyinpic.com/test-image');
      return new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(png.length)}});
    }});
    cleanups.push(()=>downloads.close());
    const live = createSessionService({ library, source,downloads });
    t.after(() => live.close());
    const { config } = await httpsFixture(t, live, source);
    provider.phase = 'ready';
    provider.read = async ({ url }, signal) => {
      const route = new URL(url).pathname;
      const scenarioFile = path.join(root, 'scenario');
      const scenario = fs.existsSync(scenarioFile) ? fs.readFileSync(scenarioFile, 'utf8') : '';
      fs.appendFileSync(
        path.join(root, 'requests'),
        scenario + ' ' + route + ' ' + new URL(url).search + '\n'
      );
      const canceledLookup = scenario === 'stop-author' && route.endsWith('/user/profile/other/');
      if (canceledLookup) {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 5000);
          const stop = () => {
            clearTimeout(timeout);
            resolve();
          };
          if (signal.aborted) stop();
          else signal.addEventListener('abort', stop, { once: true });
        });
      }
      if (scenario === 'stop-folders' && route.endsWith('/collects/list/'))
        return {
          status: 200,
          text: JSON.stringify({
            has_more: 1,
            cursor: '55',
            collects_list: [{ collects_id: '55', collects_name: '取消样本' }]
          })
        };
      if (scenario === 'fail-total' && route.endsWith('/aweme/listcollection/'))
        return { status: 503, text: 'fixture' };
      if (scenario === 'bad-folders' && route.endsWith('/collects/video/list/'))
        return { status: 200, text: JSON.stringify({ has_more: 0, aweme_list: [{ aweme_id: 'bad' }] }) };
      const author = { uid: '88', sec_uid: 'MS4wLjABsynthetic001', nickname: '离线作者' };
      if (route.endsWith('/user/profile/other/'))
        return { status: 200, text: JSON.stringify({ user: author }) };
      if (route.endsWith('/aweme/detail/'))
        return {
          status: 200,
          text: JSON.stringify({ aweme_detail: { aweme_id: '9192', item_title: '分享样本', author } })
        };
      if (route.endsWith('/aweme/post/'))
        return {
          status: 200,
          text: JSON.stringify({
            has_more: 0,
            aweme_list: Array.from({ length: scenario === 'shrink-author' ? 1 : 30 }, (_, i) => ({
              aweme_id: String(9200 + i),
              item_title: '作者样本',
              ...(i===0&&{aweme_type:68,images:[{uri:'fixture-image',origin_image:{uri:'fixture-image',url_list:['https://p3.douyinpic.com/test-image']}}]}),
              author
            }))
          })
        };
      if (route.endsWith('/collects/list/'))
        return {
          status: 200,
          text: JSON.stringify({
            has_more: 0,
            collects_list: [
              { collects_id: '77', collects_name: '离线夹' },
              ...(scenario === 'two-folders' ? [{ collects_id: '78', collects_name: '第二夹' }] : [])
            ]
          })
        };
      return {
        status: 200,
        text: JSON.stringify({ has_more: 0, aweme_list: [{ aweme_id: '9191', item_title: '离线作品' }] })
      };
    };
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
    assert.equal(provider.shown, 'fixture-render-token');
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
for (const version of [3, 4, 5, 6, 7, 8, 9, 10, 11])
  test('schema ' + version + ' requires verified migration and preserves the bound account', async (t) => {
    const { DatabaseSync } = await import('node:sqlite');
    const {
      APP_ID,
      APPLICATION_ID,
      CURRENT_SCHEMA,
      upgradeV1,
      upgradeV2,
      upgradeV3,
      upgradeV4,
      upgradeV5,
      upgradeV6,upgradeV7,upgradeV8,upgradeV9,upgradeV10
    } = await import('../../server/library.mjs');
    const { inspectUpgrade, applyUpgrade } = await import('../../server/upgrade.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-source-upgrade-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const expectedId = randomUUID(),
      dir = path.join(root, 'cangxia-server'),
      file = path.join(dir, 'library.sqlite');
    for (const name of ['media', 'snapshots']) fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'identity.json'),
      JSON.stringify({ appId: APP_ID, libraryId: expectedId })
    );
    const db = new DatabaseSync(file);
    db.exec(fs.readFileSync(new URL('../../server/schema/v1.sql', import.meta.url), 'utf8'));
    db.exec(upgradeV1);
    db.exec(upgradeV2);
    if (version >= 4) {
      db.exec(upgradeV3);
      db.exec("INSERT INTO source_account VALUES(1,'101','fixture')");
    }
    if (version >= 5) db.exec(upgradeV4);
    if (version >= 6) db.exec(upgradeV5);
    if (version>=7)db.exec(upgradeV6);
    if (version>=8)db.exec(upgradeV7);
    if(version>=9)db.exec(upgradeV8);
    if(version>=10)db.exec(upgradeV9);
    if(version>=11)db.exec(upgradeV10);
    if (version === 7) {
      db.prepare('UPDATE source_account SET profile_id=?').run(randomUUID());
      db.prepare("INSERT INTO works VALUES('500','author baseline','{}')").run();
      for (const [index, id] of ['MS4wLjABlegacy001', 'MS4wLjABlegacy002', '78'].entries()) {
        const key = (index === 2 ? 'folder:' : 'author:') + id,
          stepId = randomUUID(),
          batchId = randomUUID(),
          epoch = randomUUID();
        db.prepare('INSERT INTO read_sources VALUES(?,?,?,?,1,0)').run(
          key,
          '101',
          '作者' + index,
          JSON.stringify({ id, uid: '55', name: '作者' + index })
        );
        db.prepare(
          "INSERT INTO read_batches(id,uid,auth_epoch,owner_boot,owner_generation,status,started) VALUES(?,'101',?,'b',1,'review','2026-11-01')"
        ).run(batchId, epoch);
        db.prepare(
          "INSERT INTO read_steps(id,batch_id,ordinal,source_id,name,mode,status,outcome) VALUES(?,?,0,?,'作者','full','review','end')"
        ).run(stepId, batchId, key);
        db.prepare(
          "INSERT INTO source_read_runs(job_id,job_epoch,auth_epoch,uid,source_id,active,cursor) VALUES(?,1,?,'101',?,1,NULL)"
        ).run(stepId, epoch, key);
        db.prepare("INSERT INTO source_read_items(job_id,work_id,baseline) VALUES(?,'500',0)").run(stepId);
        db.prepare("INSERT INTO source_members(source_id,work_id,position) VALUES(?,'500',0)").run(key);
        if (index === 1)
          db.prepare("INSERT INTO read_finalizers VALUES(?,'500',?,'pending')").run(stepId, randomUUID());
      }
      db.exec(
        "INSERT INTO read_batches(id,uid,auth_epoch,owner_boot,owner_generation,status,started) VALUES('old-group','101','a','b',1,'complete','2026-11-01')"
      );
      db.exec(
        "INSERT INTO read_steps(id,batch_id,ordinal,source_id,name,mode,status,outcome) VALUES('old-run','old-group',0,'folder:77','旧夹','full','complete','end')"
      );
    }
    db.prepare('INSERT INTO library_identity VALUES(1,?,?)').run(APP_ID, expectedId);
    db.exec('PRAGMA application_id=' + APPLICATION_ID);
    db.exec('PRAGMA user_version=' + version + "; INSERT INTO works VALUES('29','fixture','{}')");
    db.exec(
      "INSERT INTO source_members(source_id,work_id,position) VALUES('folder:77','29',7); INSERT INTO work_tags VALUES('29','manual')"
    );
    if (version===10) {
      db.prepare('INSERT INTO archive_homes VALUES(?,?)').run('29',JSON.stringify({home:{kind:'collection',id:'77',folder:'旧夹',workFolder:'原作品'},identity:{dev:'1',ino:'42'},collectionName:'旧夹'}));
    }
    db.close();
    const bytes = fs.readFileSync(file);
    const preview = inspectUpgrade(root, expectedId);
    assert.equal(preview.state, 'migration-required');
    assert.equal(preview.from, version);
    assert.equal(preview.to, CURRENT_SCHEMA);
    assert.deepEqual(fs.readFileSync(file), bytes);
    const approval = {
      from: version,
      to: CURRENT_SCHEMA,
      libraryId: expectedId,
      operationId: randomUUID(),
      confirmed: true,
      imageDigest: 'sha256:' + 'c'.repeat(64)
    };
    const receipt = await applyUpgrade({ ...approval, root, expectedId, approval });
    const snapshot = new DatabaseSync(path.join(dir, receipt.snapshot, 'library.sqlite'), { readOnly: true });
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, version);
    snapshot.close();
    const upgraded = openLibrary({ root, expectedId });
    t.after(() => upgraded.close());
    if (version===10) {
      assert.equal(upgraded.read(db=>db.prepare("SELECT revision=completed AS clean FROM archive_state WHERE work_id='29'").get().clean),1);
      assert.equal(upgraded.read(db=>JSON.parse(db.prepare("SELECT body FROM archive_homes WHERE work_id='29'").get().body).home.folder),'旧夹');
    }
    if (version === 7) {
      const { jobSummary } = await import('../../server/read-history.mjs');
      const old = upgraded.read((db) => jobSummary(db, 'old-group'));
      assert.equal(old.steps[0].historyCount, null);
      assert.equal(old.steps[0].name, '旧夹');
      const { registerReadHandlers } = await import('../../electron/server-reads.mjs');
      const { ServerClient } = await import('../../electron/server-client.mjs');
      const identity = { uid: '101', authEpoch: randomUUID() };
      let networkReads = 0;
      const source = {
        account: () => identity,
        readSourcePage: async () => {
          networkReads++;
          throw Error('terminal page fetched');
        }
      };
      const service = createSessionService({ library: upgraded, source, readDelay: 0 });
      t.after(() => service.close());
      const { config } = await httpsFixture(t, service, source),
        client = new ServerClient();
      await client.connect(config);
      await client.acquire();
      t.after(() => client.lock());
      const handlers = new Map();
      registerReadHandlers({ ipc: (name, access, fn) => handlers.set(name, fn), client, notify: () => {} });
      const { authors } = await client.query('state');
      for (const [index, a] of authors.entries()) {
        const { readSummary } = await handlers.get('readAuthor')({
          id: a.id,
          resume: true,
          readAll: true,
          checkpoint: { jobId: a.run.batchId, stepId: a.run.token }
        });
        assert.equal(readSummary.outcome, 'end-warning');
        assert.equal(readSummary.warning, true);
        assert.equal(readSummary.status, index ? 'finalizing' : 'complete');
      }
      const pendingFolder = (await client.query('state')).collectionReadInfo['78'].full;
      await assert.rejects(
        handlers.get('sync')({
          collectionId: '78',
          mode: 'full',
          resume: true,
          checkpoint: { jobId: pendingFolder.batchId, stepId: pendingFolder.token }
        }),
        /确认/
      );
      assert.equal((await client.query('read-job', { jobId: pendingFolder.batchId })).status, 'review');
      assert.equal(networkReads, 0);
      assert.equal(
        upgraded.read((db) => db.prepare('SELECT count(*) n FROM read_anchors').get().n),
        0
      );
    }
    if (version === 4) {
      const privateDir = path.join(dir, 'source-session');
      fs.mkdirSync(privateDir, { mode: 0o700 });
      fs.writeFileSync(path.join(privateDir, 'browser.json'), JSON.stringify({ cookies: [], origins: [] }), {
        mode: 0o600
      });
      const services = createSessionService({ library: upgraded });
      const who = { deviceId: 'fixture', accountId: 'operator' };
      const grant = services.acquire(who, {
        deviceId: 'fixture',
        instanceId: randomUUID(),
        operationId: randomUUID()
      });
      const gateway = createSourceBrowser({
        library: upgraded,
        root,
        openProvider: () => {
          throw Error('unreferenced legacy file used');
        }
      });
      assert.equal(await gateway.recover(services.sourceSession(who, grant)), null);
      await gateway.close();
      services.close();
    }
    assert.deepEqual(
      upgraded.read((conn) => [
        conn.prepare("SELECT title FROM works WHERE id='29'").get().title,
        conn.prepare('SELECT count(*) n FROM source_account').get().n
      ]),
      ['fixture', version >= 4 ? 1 : 0]
    );
    const { orderedMemberships } = await import('../../server/memberships.mjs');
    assert.deepEqual(
      upgraded.read((db) => orderedMemberships(db, { kind: 'collection', id: '77' }).map((m) => m.workId)),
      ['29']
    );
    assert.equal(
      upgraded.read((db) => db.prepare('SELECT tag FROM work_tags').get().tag),
      'manual'
    );
  });

test('same UID reverified under a new provider session fences queued reads from the prior epoch', async (t) => {
  const { source, provider, session } = setup(t);
  let fingerprint = 'first';
  provider.sessionKey = async () => fingerprint;
  const first = await source.verifyAccount(session);
  assert.equal((await source.verifyAccount(session)).authEpoch, first.authEpoch);
  fingerprint = 'second';
  const second = source.verifyAccount(session);
  const queued = source.readSourcePage({
    source: { kind: 'total', id: '__all__' },
    cursor: '0',
    authEpoch: first.authEpoch,
    signal: session.signal
  });
  const [verified] = await Promise.all([second, assert.rejects(queued, { code: 'SOURCE_SESSION_LOST' })]);
  assert.notEqual(verified.authEpoch, first.authEpoch);
  assert.equal(provider.reads.length, 0);
});

test('typed details keep audio candidates, distinguish missing/private/deleted, and require matched filter evidence', async (t) => {
  const { source, provider, session } = setup(t);
  const { authEpoch } = await source.verifyAccount(session);
  const id = '7345612390836712343';
  const read = async (data) => {
    provider.page = data;
    return source.readDetail({ workId: id, authEpoch, signal: session.signal });
  };
  const media = await read({ aweme_detail: { ...fixtures.media.data.aweme_list[0], aweme_id: id } });
  assert.equal(media.sourceStatus.state, 'available');
  assert.deepEqual(
    media.audioSourceHints.sources.map((s) => s.kind),
    ['music', 'work']
  );
  assert.equal(media.audioSourceHints.workId, id);
  for (const [raw, state] of [
    [{ aweme_id: id }, 'unknown'],
    [{ aweme_id: id, is_private: 1 }, 'unknown'],
    [{ aweme_id: id, is_delete: 1 }, 'unavailable']
  ]) {
    const result = await read({ aweme_detail: raw });
    assert.equal(result.sourceStatus.state, state);
    assert.equal(result.remoteState, state);
  }
  const filter = {
    status_code: 0,
    aweme_detail: null,
    filter_detail: { aweme_id: id, filter_reason: 'status_audit_self_see' }
  };
  const unavailable = await read(filter);
  assert.equal(unavailable.id, id);
  assert.equal(unavailable.sourceStatus.state, 'unavailable');
  assert.equal(unavailable.statusOnly, true);
  const unknown = await read({ ...filter, filter_detail: { aweme_id: id, filter_reason: 'unrecognized' } });
  assert.equal(unknown.sourceStatus.state, 'unknown');
  assert.equal((await read({ status_code: 0, aweme_detail: null })).sourceStatus.state, 'unknown');
  await assert.rejects(read({ ...filter, filter_detail: { ...filter.filter_detail, aweme_id: '33' } }), {
    code: 'SOURCE_PAGE_INVALID'
  });
  await assert.rejects(read({ aweme_detail: { aweme_id: '33', is_delete: 1 } }), {
    code: 'SOURCE_PAGE_INVALID'
  });
});
test('post-write rejection retains prior committed profile and leaves first failed binding unrecoverable', async (t) => {
  const { source, provider, session, make } = setup(t);
  const rejected = {
    ...session,
    write: (fn) =>
      session.write((db) => {
        fn(db);
        throw Error('simulated transaction rollback');
      })
  };
  provider.storage = async () => ({ cookies: [], origins: [], fixture: 'uncommitted' });
  await assert.rejects(source.verifyAccount(rejected), /rollback/);
  await source.close();
  const second = make();
  t.after(() => second.close());
  assert.equal(await second.recover(session), null);
  provider.storage = async () => ({ cookies: [], origins: [], fixture: 'first' });
  await second.verifyAccount(session);
  await second.close();
  const third = make();
  t.after(() => third.close());
  provider.storage = async () => ({ cookies: [], origins: [], fixture: 'uncommitted' });
  await assert.rejects(third.verifyAccount(rejected), /rollback/);
  await third.close();
  const restored = make();
  t.after(() => restored.close());
  await restored.recover(session);
  assert.equal(provider.lastSaved.fixture, 'first');
});

test('typed exact work lookup recognizes explicit gone business messages while HTTP failures and ambiguity retain work', async (t) => {
  const { source, provider, session } = setup(t);
  const { authEpoch } = await source.verifyAccount(session);
  const workId = '101';
  const detail = (page) => {
    provider.page = page;
    return source.readDetail({ workId, authEpoch, signal: session.signal });
  };
  const result = await detail({ status_code: 42, status_msg: '该作品已下架' });
  assert.equal(result.sourceStatus.state, 'unavailable');
  assert.match(result.sourceStatus.reason, /已下架/);
  assert.equal(result.id, workId);
  assert.equal(source.account().authEpoch, authEpoch);
  await assert.rejects(detail({ status_code: 42, status_msg: '该作品已下架', data: { aweme_id: '202' } }), {
    code: 'SOURCE_PAGE_INVALID'
  });
  assert.equal(
    (await detail({ status_code: 0, status_msg: '作品可能已删除' })).sourceStatus.state,
    'unknown'
  );
  provider.read = async () => ({ status: 503, text: JSON.stringify({ status_msg: '该作品已下架' }) });
  await assert.rejects(source.readDetail({ workId, authEpoch, signal: session.signal }), {
    code: 'SOURCE_PAGE_INVALID'
  });
});
test('successful verification detaches the reader from a late login response', async (t) => {
  const { library, session, root } = setup(t);
  let login, reader;
  const makeProvider = async (saved) => {
    const p = {
      uid: saved?.fixtureUid ?? '101',
      async self() {
        return { uid: this.uid, nickname: 'fixture' };
      },
      async sessionKey() {
        return 'fingerprint-' + this.uid;
      },
      async storage() {
        return { cookies: [], origins: [], fixtureUid: this.uid };
      },
      async beginLogin() {},
      async loginView() {
        return { phase: 'loading' };
      },
      endLogin() {},
      async close() {},
      async read() {
        return { status: 200, text: '{"aweme_list":[],"has_more":false}' };
      }
    };
    if (saved) reader = p;
    else login = p;
    return p;
  };
  const source = createSourceBrowser({ library, root, openProvider: makeProvider });
  t.after(() => source.close());
  await source.openLogin(session);
  const { authEpoch } = await source.verifyAccount(session);
  login.uid = '202'; // A response already dispatched by the retired login browser.
  const page = await source.readSourcePage({
    source: { kind: 'total', id: '__all__' },
    cursor: '0',
    authEpoch,
    signal: session.signal
  });
  assert.equal(page.terminal, true);
  assert.equal(reader.uid, '101');
  assert.notEqual(login, reader);
});
test(
  'a delayed native QR status response cannot set credentials in the verified Chromium reader',
  { timeout: 12000 },
  async (t) => {
    const { library, root, session } = setup(t);
    const { openOfficialProvider } = await import('../../server/source-provider.mjs');
    const { delayedStatusDuringVerification } = await import('./source-provider-fixture.mjs');
    await delayedStatusDuringVerification(
      t,
      (openProvider) => createSourceBrowser({ library, root, openProvider }),
      openOfficialProvider,
      session
    );
  }
);
test(
  'native redirect, history, passive reload completion, cancellation and deadline share only the approved document',
  { timeout: 20000 },
  async (t) => {
    const { openOfficialProvider } = await import('../../server/source-provider.mjs');
    const { testNavigation } = await import('./source-navigation-fixture.mjs');
    await testNavigation(t, openOfficialProvider);
  }
);
