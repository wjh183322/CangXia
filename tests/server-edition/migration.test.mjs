import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, X509Certificate, randomUUID } from 'node:crypto';
import { ScopeState } from '../../backup-server/scope-state.mjs';
import { checkLinuxMountTrees } from '../../server/rehearsal-files.mjs';
import { setTimeout as wait } from 'node:timers/promises';
import selfsigned from 'selfsigned';
import { createSessionService } from '../../server/session.mjs';
import { createHttpsService } from '../../server/http.mjs';
import { createRehearsals } from '../../server/rehearsal-service.mjs';
import { ServerClient, pinnedRequest } from '../../electron/server-client.mjs';
import { registerCatalogueHandlers } from '../../electron/server-ipc.mjs';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { Store } from '../../electron/store.mjs';
import { DownloadQueue } from '../../electron/downloads.mjs';
import { HDCover } from '../../electron/hd-cover.mjs';
import { listWorks } from '../../server/catalogue.mjs';
import { historyRuns, historyItems } from '../../server/read-history.mjs';
import * as recovery from '../../server/recovery.mjs';
import { mediaList } from '../../server/media.mjs';
import { authorPublic } from '../../shared/backup-protocol.mjs';
import { createDownloads } from '../../server/downloads.mjs';
import { openLibrary } from '../../server/library.mjs';
import { createBackupServer } from '../../backup-server/server.mjs';
import { sealSource, previewImport, importApproved } from '../../server/migration.mjs';
import { verifyRestore, preserveBeforeRollback } from '../../server/recovery.mjs';

const hash = (b) => createHash('sha256').update(b).digest('hex');
const work = (id) => ({
  id,
  name: '作品' + id,
  title: '作品' + id,
  type: 'video',
  author: { uid: '55', nickname: '甲' },
  images: [],
  coAuthors: []
});
const imageDigest = 'sha256:' + 'a'.repeat(64);
test('Linux mount extents include bind-mounted reports and nested sources before any report can be written', () => {
  const normal = '1 0 8:1 / / rw - ext4 /dev/test rw';
  const bind = (backing, at) => '2 1 8:1 ' + backing + ' ' + at + ' rw - ext4 /dev/test rw';
  assert.doesNotThrow(() => checkLinuxMountTrees(['/live', '/rehearsal/reports'], normal));
  assert.throws(
    () =>
      checkLinuxMountTrees(
        ['/live', '/rehearsal/reports'],
        normal + '\n' + bind('/live', '/rehearsal/reports')
      ),
    /独立目录/
  );
  assert.throws(
    () =>
      checkLinuxMountTrees(
        ['/rehearsal/reports', '/rehearsal/sources'],
        normal + '\n' + bind('/rehearsal/reports', '/rehearsal/sources/frozen/objects')
      ),
    /独立目录/
  );
  assert.throws(
    () =>
      checkLinuxMountTrees(
        ['/targets/a', '/targets/b'],
        normal + '\n' + bind('/targets/a/media', '/targets/b')
      ),
    /独立目录/
  );
});
test('native Windows WAL, NAS objects, recovery-only records and device deletion protection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-rehearsal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = (name) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    return d;
  };
  const win = dir('windows'),
    nas = dir('nas'),
    previous = dir('restore'),
    target = path.join(root, 'new-volume');
  const dbfile = 'library.sqlite';
  const store = await Store.open(path.join(win, dbfile), path.join(win, 'archive'));
  const uid = '987654321',
    id = '90071992547409999',
    deleted = '2';
  store.setSetting('account', { uid, nickname: 'test' });
  store.setSetting('privateToken', 'never-migrate-this');
  for (const w of [id, deleted]) store.put('works', w, work(w));
  store.db.run('INSERT INTO members VALUES(?,?,?)', ['__all__', id, 3]);
  store.put('local_tags', id, { id, tags: ['手工'] });
  store.deviceScopes.hold(
    { scope: { workId: deleted, kind: 'files', sourceId: '' }, generation: 1, revision: 1, deleted: true },
    []
  );
  const parentLog = {
    token: 'old-batch',
    scope: '__batch__',
    source: 'batch',
    name: '合成批次',
    phase: 'done',
    startedAt: '2026-01-01T00:00:00Z'
  };
  store.readHistory.batches.put(parentLog);
  store.readHistory.batches.put({
    token: 'old-child',
    scope: '__all__',
    batchId: 'old-batch',
    batchState: 'complete',
    hasReadSummary: true,
    name: '总收藏',
    checked: 18,
    rawCount: 22,
    notReturned: null,
    countsVersion: 2,
    startedAt: parentLog.startedAt
  });
  store.db.run('INSERT INTO read_history_children VALUES(?,?,?)', ['old-batch', 'old-child', 4]);
  const detail = { id, name: '恢复明细', kind: 'fill', reappeared: true, position: 3 };
  store.db.run('INSERT INTO read_history_items VALUES(?,?,?,?,?,?)', [
    'old-child',
    id,
    3,
    'fill',
    JSON.stringify(detail),
    123
  ]);
  const source = createBackupServer({
    dataDir: nas,
    token: 'synthetic-rehearsal-only-'.repeat(2),
    allowInsecureLoopback: true
  });
  await source.listen();
  const bytes = fs.readFileSync(new URL('./fixtures/media-preview.mp4', import.meta.url)),
    sha = hash(bytes),
    home = { kind: 'collection', id: '__all__', folder: '收藏', workFolder: '旧归档' };
  fs.writeFileSync(path.join(nas, 'objects', sha), bytes);
  const record = (table, key, body) =>
    source.db.prepare('INSERT INTO records VALUES(?,?,?,1)').run(table, key, JSON.stringify(body));
  record('settings', 'account', { value: { uid } });
  record('works', id, work(id));
  record('works', deleted, work(deleted));
  source.db.prepare('INSERT INTO objects VALUES(?,?)').run(sha, bytes.length);
  const status = {
    state: 'available',
    reason: '来源可用',
    method: 'platform',
    checkedAt: '2026-01-02T00:00:00Z'
  };
  const archiveWork = {
    ...work(id),
    sourceStatus: status,
    sourceAttempt: status,
    checkedAt: status.checkedAt
  };
  const actualMetadata = DownloadQueue.prototype.metadata.call({ store }, archiveWork, {
    collectionId: '__all__',
    assets: [{ key: 'video', file: '原件.mp4', size: bytes.length }]
  });
  const metadata = Buffer.from(JSON.stringify(actualMetadata, null, 2));
  const secret = 'private-fixture-token-not-in-report',
    rejectedWork = { ...work('91'), sourceStatus: { ...status, cookie: secret } };
  const rejected = Buffer.from(
    JSON.stringify(
      DownloadQueue.prototype.metadata.call({ store }, rejectedWork, { collectionId: '__all__', assets: [] })
    )
  );
  record('works', '91', work('91'));
  const rejectHash = hash(rejected);
  source.db.prepare('INSERT INTO objects VALUES(?,?)').run(rejectHash, rejected.length);
  fs.writeFileSync(path.join(nas, 'objects', rejectHash), rejected);
  record('downloads', '91', {
    collectionId: '__all__',
    home: { ...home, workFolder: '受保护的作品信息' },
    state: 'partial',
    assets: [
      { key: 'metadata', kind: 'metadata', file: '作品信息.json', size: rejected.length, sha256: rejectHash }
    ]
  });
  const metaHash = hash(metadata);
  source.db.prepare('INSERT INTO objects VALUES(?,?)').run(metaHash, metadata.length);
  fs.writeFileSync(path.join(nas, 'objects', metaHash), metadata);
  for (const w of [id, deleted])
    record('downloads', w, {
      id: w,
      home,
      collectionId: '__all__',
      state: 'complete',
      requiredKeys: ['video'],
      assets: [
        { key: 'video', kind: 'video', file: '原件.mp4', sha256: sha, size: bytes.length },
        ...(w === id
          ? [
              {
                key: 'metadata',
                kind: 'metadata',
                file: '作品信息.json',
                sha256: metaHash,
                size: metadata.length
              }
            ]
          : [])
      ]
    });
  record('members', '__all__:' + deleted, { collectionId: '__all__', workId: deleted, rank: 9 });
  store.db.run('INSERT INTO members VALUES(?,?,?)', ['__all__', deleted, 12]);
  const absent = 'f'.repeat(64);
  source.db.prepare('INSERT INTO objects VALUES(?,?)').run(absent, 900);
  store.db.run('INSERT INTO download_tasks VALUES(?,?,?,?)', [
    id,
    'running',
    1,
    JSON.stringify({ id, state: 'running' })
  ]);
  const inputs = [
    await sealSource({ directory: win, kind: 'windows', database: dbfile }),
    await sealSource({ directory: nas, kind: 'nas', database: dbfile })
  ];
  // A self-contained recovery copy may lack the device DB; all its unique rows remain candidates.
  fs.writeFileSync(path.join(previous, dbfile), store.db.export());
  const old = new DatabaseSync(path.join(previous, dbfile));
  old.prepare('INSERT INTO works VALUES(?,?)').run('999', JSON.stringify(work('999')));
  old.close();
  inputs.push(await sealSource({ directory: previous, kind: 'recovery', database: dbfile }));
  const args = { sources: inputs, target, uid, imageDigest };
  try {
    const pre = await previewImport(args);
    assert.ok(pre.conflicts.some((c) => c.key === '91/metadata' && c.reason.includes('sourceStatus.cookie')));
    assert.ok(!JSON.stringify(pre).includes(secret));
    assert.equal(fs.existsSync(target), false);
    assert.ok(pre.conflicts.some((x) => x.key.includes('999')));
    assert.ok(pre.conflicts.some((x) => x.reason.includes('删除')));
    assert.ok(pre.conflicts.some((x) => x.key === absent && x.reason.includes('缺失')));
    assert.ok(
      pre.conflicts.some(
        (x) => x.type === 'member' && x.key === 'total/' + deleted && x.reason.includes('顺序')
      )
    );
    assert.ok(inputs[0].files.some((f) => f.relative === dbfile + '-wal' && f.size > 32));
    const detached = dir('detached');
    for (const f of inputs[0].files) {
      const out = path.join(detached, f.relative);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      if (f.relative !== dbfile + '-wal') fs.copyFileSync(path.join(win, f.relative), out);
    }
    await assert.rejects(
      previewImport({ ...args, sources: [{ ...inputs[0], directory: detached }] }),
      /清单|封存/
    );
    const damaged = fs.readFileSync(path.join(win, dbfile + '-wal'));
    damaged[damaged.length - 1] ^= 7;
    fs.writeFileSync(path.join(detached, dbfile + '-wal'), damaged);
    const invalidWal = await sealSource({ ...inputs[0], directory: detached });
    await assert.rejects(previewImport({ ...args, sources: [invalidWal] }), /WAL/);
    await assert.rejects(previewImport({ ...args, uid: '123456' }), /账号/);
    await assert.rejects(
      importApproved({ ...args, previewId: pre.previewId, approval: { confirmed: false } }),
      /确认/
    );
    const approved = {
      ...args,
      previewId: pre.previewId,
      approval: { confirmed: true, uid, target, previewId: pre.previewId }
    };
    const stagedFile = path.join(
      root,
      '.cx-' + pre.previewId.slice(0, 32),
      'volume',
      'cangxia-server',
      'media',
      '收藏',
      '旧归档',
      '原件.mp4'
    );
    await assert.rejects(
      importApproved({
        ...approved,
        guard: () => {
          if (fs.existsSync(stagedFile)) throw Error('模拟控制权失效');
        }
      }),
      /模拟控制权/
    );
    assert.ok(!fs.existsSync(target));
    const stagedIdentity = fs.statSync(stagedFile, { bigint: true }).ino;
    const result = await importApproved(approved);
    assert.equal((await importApproved(approved)).libraryId, result.libraryId);
    const lib = openLibrary({ root: target, expectedId: result.libraryId });
    lib.read((db) => {
      assert.deepEqual(db.prepare('SELECT position FROM source_members WHERE work_id=?').get(id).position, 3);
      assert.equal(db.prepare('SELECT tag FROM work_tags').get().tag, '手工');
      assert.equal(db.prepare('SELECT count(*) n FROM works WHERE id=?').get('999').n, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM media_files WHERE work_id=?').get(deleted).n, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM download_auth').get().n, 0);
      assert.deepEqual(
        listWorks(db, { source: 'all', filter: { downloaded: 'complete' } }, { grant: { proof: 'test' } })
          .ids,
        [id]
      );
      assert.equal(db.prepare('SELECT state FROM download_jobs WHERE id=?').get(id).state, 'paused');
      assert.equal(historyRuns(db).items[0].token, 'old-batch');
      assert.equal(historyRuns(db).total, 1);
      const child = historyRuns(db, { batch: 'old-batch' }).items[0];
      assert.equal(child.checked, 18);
      assert.equal(child.rawCount, 22);
      assert.equal(child.notReturned, null);
      assert.equal(historyItems(db, { runId: child.token, kind: 'returned' }).items[0].id, id);
      assert.equal(db.prepare('SELECT count(*) n FROM source_members WHERE work_id=?').get(deleted).n, 0);
    });
    const rel = '收藏/旧归档/原件.mp4',
      mediaRoot = path.join(target, 'cangxia-server', 'media');
    assert.deepEqual(fs.readFileSync(path.join(mediaRoot, rel)), bytes);
    assert.equal(fs.statSync(path.join(mediaRoot, rel), { bigint: true }).ino, stagedIdentity);
    for (const s of inputs) assert.equal((await sealSource(s)).seal, s.seal);
    assert.equal(
      fs.readFileSync(path.join(target, 'cangxia-server', 'library.sqlite')).includes('never-migrate-this'),
      false
    );
    const restored = dir('external'),
      snapshot = path.join(restored, 'snapshot'),
      archive = path.join(restored, 'media');
    fs.cpSync(result.snapshot, snapshot, { recursive: true });
    fs.cpSync(mediaRoot, archive, { recursive: true });
    const check = () =>
      verifyRestore({
        snapshot,
        mediaRoot: archive,
        manifestSha256: result.manifestSha256,
        uid,
        libraryId: result.libraryId
      });
    assert.equal((await check()).matched.length, 2);
    const targetRestore = path.join(root, 'playable-copy');
    const restoredInput = {
      snapshot,
      mediaRoot: archive,
      manifestSha256: result.manifestSha256,
      uid,
      target: targetRestore,
      libraryId: result.libraryId,
      confirmed: true
    };
    const playable = await recovery.restoreApproved(restoredInput);
    assert.equal(playable.verifiedPlayback, 1);
    assert.equal(playable.registeredFiles, 2);
    await assert.rejects(recovery.restoreApproved(restoredInput), /存在/);
    await assert.rejects(
      recovery.restoreApproved({ ...restoredInput, uid: '1234', target: path.join(root, 'wrong-account') }),
      /账号/
    );
    assert.equal((await check()).matched.length, 2);
    assert.deepEqual(fs.readFileSync(path.join(archive, '收藏', '旧归档', '作品信息.json')), metadata);
    fs.writeFileSync(path.join(archive, rel), 'modified');
    assert.equal((await check()).changed.length, 1);
    const mutatedTarget = path.join(root, 'changed-restore');
    await assert.rejects(recovery.restoreApproved({ ...restoredInput, target: mutatedTarget }), /核实/);
    assert.ok(!fs.existsSync(mutatedTarget));
    fs.unlinkSync(path.join(archive, rel));
    assert.equal((await check()).missing.length, 1);
    fs.writeFileSync(path.join(archive, '旁存文件'), 'keep');
    assert.deepEqual((await check()).extra, ['旁存文件']);
    const foreignControl = path.join(archive, '.cangxia-staging');
    fs.mkdirSync(foreignControl);
    const fake = new DatabaseSync(path.join(foreignControl, 'worker.sqlite'));
    fake.exec('CREATE TABLE owner(id TEXT PRIMARY KEY,foreign_data TEXT) STRICT');
    fake.prepare('INSERT INTO owner VALUES(?,?)').run(result.libraryId, 'operator-file');
    fake.close();
    assert.ok((await check()).extra.includes('.cangxia-staging/worker.sqlite'));
    fs.appendFileSync(path.join(snapshot, 'library.sqlite'), 'corrupt');
    await assert.rejects(check(), /摘要/);
    lib.write((db) => {
      db.prepare('INSERT INTO works VALUES(?,?,?)').run('3', '新增', JSON.stringify(work('3')));
      db.prepare('INSERT INTO download_auth VALUES(1,?)').run('private-test-session-material');
    });
    await assert.rejects(importApproved(approved), /变化|变动|stale/);
    const saved = await preserveBeforeRollback({
      root: target,
      libraryId: result.libraryId,
      imageDigest,
      confirmed: true
    });
    assert.ok(saved.snapshot !== result.snapshot);
    const handoffDir = dir('growing-handoff');
    let wrote = false;
    const changing = await preserveBeforeRollback({
      root: target,
      destination: handoffDir,
      uid,
      libraryId: result.libraryId,
      imageDigest,
      confirmed: true,
      guard: () => {
        if (wrote || !fs.readdirSync(handoffDir).some((n) => !n.startsWith('.'))) return;
        wrote = true;
        lib.write((db) =>
          db.prepare('INSERT INTO works VALUES(?,?,?)').run('4', '封存后新增', JSON.stringify(work('4')))
        );
      }
    });
    assert.equal(changing.updatedAfterSnapshot, true);
    assert.equal(changing.verified, false);
    assert.equal(
      fs.readFileSync(path.join(saved.snapshot, 'library.sqlite')).includes('private-test-session-material'),
      false
    );
    const newer = new DatabaseSync(path.join(saved.snapshot, 'library.sqlite'), { readOnly: true });
    assert.equal(newer.prepare('SELECT count(*) n FROM works WHERE id=?').get('3').n, 1);
    newer.close();
    lib.close();
    fs.writeFileSync(path.join(nas, 'objects', sha), 'bad');
    await assert.rejects(importApproved(approved), /清单|封存/);
  } finally {
    store.close();
    await source.close();
  }
});

test('desktop IPC uses the authenticated owner and worker to approve a named offline volume', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-rehearsal-http-'));
  const root = path.join(tmp, 'outputs'), inputsRoot=path.join(tmp,'admin-approved'),
    liveRoot = path.join(tmp, 'live');
  for (const n of ['sources','manifests','restores'])fs.mkdirSync(path.join(inputsRoot,n),{recursive:true});
  for (const n of ['targets','reports'])fs.mkdirSync(path.join(root,n),{recursive:true});
  fs.writeFileSync(path.join(root,'rehearsal.json'),JSON.stringify({accountId:'foreign',sources:{fake:'wrong'}}));
  fs.mkdirSync(liveRoot);
  const src = path.join(inputsRoot, 'sources', 'desktop');
  fs.mkdirSync(src);
  const uid = '101',
    store = await Store.open(path.join(src, 'library.sqlite'), path.join(src, 'archive'));
  store.setSetting('account', { uid });
  store.put('works', '8', work('8'));
  store.close();
  const { directory: origin, ...seal } = await sealSource({
    directory: src,
    kind: 'windows',
    database: 'library.sqlite'
  });
  const json = JSON.stringify(seal),
    config = { accountId: 'family', uid, imageDigest, sources: { desktop: hash(json) }, restores: {} };
  fs.writeFileSync(path.join(inputsRoot, 'manifests', 'desktop.json'), json);
  fs.writeFileSync(path.join(inputsRoot, 'rehearsal.json'), JSON.stringify(config));
  const library = openLibrary({ root: liveRoot, mode: 'init' }),
    sessions = createSessionService({ library });
  const service = createRehearsals({ root, inputsRoot, liveRoot }),
    tls = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048 });
  const token = 'synthetic-owner-'.repeat(3),
    creds = { A: { accountId: 'family', token }, B: { accountId: 'other', token: 'b'.repeat(48) } };
  const http = createHttpsService({
    credentials: creds,
    sessions,
    rehearsals: service,
    key: tls.private,
    cert: tls.cert
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const cfg = {
    url: 'https://127.0.0.1:' + http.address().port,
    fingerprint: new X509Certificate(tls.cert).fingerprint256,
    deviceId: 'A',
    token
  };
  const client = new ServerClient(),
    other = new ServerClient();
  t.after(async () => {
    client.lock();
    other.lock();
    service.close();
    await sessions.close();
    http.closeAllConnections();
    await new Promise((r) => http.close(r));
    library.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await assert.rejects(pinnedRequest(cfg, 'rehearsal', { input: { action: 'list' } }));
  await client.connect(cfg);
  await client.acquire();
  let ipc;
  registerCatalogueHandlers({
    client,
    ipc: (n, role, fn) => {
      if (n === 'serverRehearsal') {
        assert.equal(role, 'workspace');
        ipc = fn;
      }
    }
  });
  const op = async (input) => {
    const job = await ipc(input);
    for (let n = 0; n < 300; n++) {
      const r = await ipc({ action: 'status', id: job.id });
      if (r.state !== 'running') return r;
      await wait(20);
    }
    throw Error('worker did not complete');
  };
  assert.deepEqual((await ipc({ action: 'list' })).sources, ['desktop']);
  const sources = ['desktop'],
    target = 'trial',
    args = { sources, target };
  const reportRoot = path.join(root, 'reports'),
    initialReports = fs.readdirSync(reportRoot);
  await assert.rejects(ipc({ action: 'preview', sources, target: '../escape' }), /名称/);
  assert.deepEqual(fs.readdirSync(reportRoot), initialReports);
  const realReports = path.join(root, 'unmounted-reports'),
    beforeAlias = fs.readdirSync(liveRoot);
  fs.renameSync(reportRoot, realReports);
  fs.symlinkSync(liveRoot, reportRoot, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(ipc({ action: 'preview', sources, target: 'invalid-layout' }));
    assert.deepEqual(fs.readdirSync(liveRoot), beforeAlias);
  } finally {
    fs.unlinkSync(reportRoot);
    fs.renameSync(realReports, reportRoot);
  }
  assert.deepEqual(fs.readdirSync(reportRoot), initialReports);
  const preview = await op({ action: 'preview', ...args });
  assert.equal(preview.state, 'done', preview.message);
  const failure = await op({
    action: 'import',
    ...args,
    uid,
    previewId: preview.summary.previewId,
    confirmed: false
  });
  assert.equal(failure.state, 'failed');
  assert.equal(fs.existsSync(path.join(root, 'targets', target)), false);
  const done = await op({
    action: 'import',
    ...args,
    uid,
    previewId: preview.summary.previewId,
    confirmed: true
  });
  assert.equal(done.state, 'done', done.message);
  assert.equal(done.summary.counts.work, 1);
  assert.equal(
    library.read((db) => db.prepare('SELECT count(*) n FROM works').get().n),
    0
  );
  const external = path.join(inputsRoot, 'restores', 'usb01');
  fs.mkdirSync(external);
  fs.cpSync(done.summary.snapshot, path.join(external, 'snapshot'), { recursive: true });
  fs.cpSync(done.summary.mediaRoot, path.join(external, 'media'), { recursive: true });
  config.restores.usb01 = { libraryId: done.summary.libraryId, manifestSha256: done.summary.manifestSha256 };
  fs.writeFileSync(path.join(inputsRoot, 'rehearsal.json'), JSON.stringify(config));
  const checked = await op({ action: 'verify', restore: 'usb01' });
  assert.equal(checked.state, 'done', checked.message);
  const restored = await op({
    action: 'restore',
    restore: 'usb01',
    target: 'usable',
    uid,
    libraryId: checked.summary.libraryId,
    manifestSha256: checked.summary.manifestSha256,
    confirmed: true
  });
  assert.equal(restored.state, 'done', restored.message);
  assert.equal(restored.summary.registeredFiles, 0);
  library.write((db) => {
    db.prepare('INSERT INTO source_account VALUES(1,?,?,NULL)').run(uid, '现场合成账号');
    db.prepare('INSERT INTO works VALUES(?,?,?)').run('202', '切换后新增', JSON.stringify(work('202')));
    db.prepare("INSERT INTO download_jobs VALUES('202','202','paused')").run();
    db.prepare("INSERT INTO download_manifests(id,work_id,body) VALUES('202','202',?)").run(
      JSON.stringify({
        id: '202',
        workId: '202',
        state: 'paused',
        auth: { uid, sessionKey: 'do-not-copy-credential' }
      })
    );
  });
  const liveSnapshots = path.join(liveRoot, 'cangxia-server', 'snapshots'),
    before = fs.readdirSync(liveSnapshots);
  const handoff = await op({
    action: 'handoff',
    libraryId: library.libraryId,
    uid,
    target: 'before-rollback',
    confirmed: true
  });
  assert.equal(handoff.state, 'done', handoff.message);
  assert.ok(handoff.summary.verified);
  assert.deepEqual(fs.readdirSync(liveSnapshots), before);
  assert.ok(handoff.summary.snapshot.startsWith(path.join(root, 'targets', 'before-rollback') + path.sep));
  const handoffDb = path.join(handoff.summary.snapshot, 'library.sqlite');
  assert.equal(fs.readFileSync(handoffDb).includes('do-not-copy-credential'), false);
  const reader = new DatabaseSync(handoffDb, { readOnly: true });
  assert.equal(reader.prepare('SELECT state FROM download_jobs WHERE work_id=?').get('202').state, 'paused');
  reader.close();
  await client.release();
  await other.connect({ ...cfg, deviceId: 'B', token: creds.B.token });
  await other.acquire();
  await assert.rejects(other.call('rehearsal', { input: { action: 'list' } }), /账号无权/);
});

test('independent memberships, audio identity, ranked overlays and restored generations survive normal queries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const win = path.join(root, 'windows'),
    nas = path.join(root, 'nas'),
    target = path.join(root, 'target');
  fs.mkdirSync(win);
  fs.mkdirSync(nas);
  const uid = '55',
    author = 'MS4wLjABsynthetic01';
  const s = await Store.open(path.join(win, 'library.sqlite'), path.join(win, 'archive'));
  const n = createBackupServer({ dataDir: nas, token: 'synthetic-'.repeat(5), allowInsecureLoopback: true });
  await n.listen();
  try {
    const nasId = n.status().libraryId;
    s.deviceScopes.bind(nasId);
    s.setSetting('account', { uid });
    const record = (k, id, b) =>
      n.db.prepare('INSERT INTO records VALUES(?,?,?,1)').run(k, id, JSON.stringify(b));
    record('settings', 'account', { value: { uid } });
    const person = {
      id: author,
      uid: '123',
      name: '作者',
      folder: '作者作品/作者',
      url: 'https://www.douyin.com/user/' + author,
      updatedAt: '2026-01-01',
      run: { count: 2, pages: 1, status: 'complete' }
    };
    s.put('authors', author, person);
    record('authors', author, authorPublic(person));
    s.put('collections', '77', { id: '77', name: '夹', added: true });
    for (const id of ['1', '2', '3', '4', '5', '88', '89', '14', '15']) {
      const w = work(id);
      if (id === '88' || id === '89') w.music = { id: '100', version: 1, state: 'known' };
      s.put('works', id, w);
    }
    s.db.run('INSERT INTO author_members VALUES(?,?,?,?)', [author, '1', 0, 0]);
    record('author_members', author + ':1', { authorId: author, workId: '1', position: 0, hidden: false });
    for (const [id, pos] of [
      ['1', 0],
      ['2', 1]
    ])
      s.db.run('INSERT INTO members VALUES(?,?,?)', ['77', id, pos]);
    s.db.run('INSERT INTO sync_runs VALUES(?,?)', ['77', JSON.stringify({ status: 'running' })]);
    s.db.run('INSERT INTO sync_items VALUES(?,?,?)', ['77', '3', 0]);
    s.put('collections', '78', { id: '78', name: '读取夹', added: true });
    for (const [id, pos] of [
      ['1', 0],
      ['2', 1]
    ])
      s.db.run('INSERT INTO members VALUES(?,?,?)', ['78', id, pos]);
    const readRun = { key: 'quick:78', scope: '78', mode: 'quick', status: 'running' };
    s.put('collection_read_runs', readRun.key, readRun);
    for (const [id, pos] of [
      ['3', 0],
      ['2', 1]
    ])
      s.db.run('INSERT INTO collection_read_items VALUES(?,?,?)', [readRun.key, id, pos]);
    const displayed = s.collectionReads.order('78', s.orderedMemberRows('78')).map((r) => r.work_id);
    for (const [id, pos] of [
      ['4', 10],
      ['5', 10],
      ['88', 11]
    ])
      s.db.run('INSERT INTO members VALUES(?,?,?)', ['__all__', id, pos]);
    for (const [id, state] of [
      ['4', 'failed'],
      ['5', 'cancelled']
    ])
      s.db.run('INSERT INTO download_tasks VALUES(?,?,?,?)', [id, state, 1, JSON.stringify({ id, state })]);
    for (const [id, rank] of [
      ['14', 0],
      ['15', 1]
    ])
      s.db.run('INSERT INTO download_tasks VALUES(?,?,?,?)', [
        id,
        'failed',
        rank,
        JSON.stringify({ id, state: 'failed' })
      ]);
    const files = { workId: '88', kind: 'files', sourceId: '' };
    s.deviceScopes.remember({ scope: files, generation: 1, revision: 1, deleted: true });
    const scope = (id, kind, sid, gen, del, rev) =>
      n.db
        .prepare('INSERT INTO scope_state VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, kind, sid, gen, Number(del), rev, 'synthetic', 'n', 'test', '2026');
    scope('88', 'files', '', 2, false, 9);
    scope('88', 'account', '__all__', 1, true, 10);
    const audio = Buffer.alloc(44 + 16000);
    audio.write('RIFF');
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(8000, 24);
    audio.writeUInt32LE(16000, 28);
    audio.writeUInt16LE(2, 32);
    audio.writeUInt16LE(16, 34);
    audio.write('data', 36);
    audio.writeUInt32LE(16000, 40);
    const sha = hash(audio);
    fs.writeFileSync(path.join(nas, 'objects', sha), audio);
    n.db.prepare('INSERT INTO objects VALUES(?,?)').run(sha, audio.length);
    for (const id of ['88', '89'])
      record('downloads', id, {
        state: 'partial',
        collectionId: '__all__',
        home: { kind: 'collection', id: '__all__', folder: '收藏', workFolder: '归档' + id },
        assets: [],
        audio: {
          state: 'saved',
          musicId: id === '88' ? '100' : '999',
          object: { sha256: sha, size: audio.length, format: 'wav', duration: 1 }
        }
      });
    const args = {
      uid,
      imageDigest,
      target,
      sources: [
        await sealSource({ kind: 'windows', directory: win, database: 'library.sqlite' }),
        await sealSource({ kind: 'nas', directory: nas, database: 'library.sqlite' })
      ]
    };
    const preview = await previewImport(args);
    assert.ok(preview.conflicts.some((c) => c.reason.includes('顺序') && c.key === 'total/5'));
    const result = await importApproved({
      ...args,
      previewId: preview.previewId,
      approval: { confirmed: true, uid, target, previewId: preview.previewId }
    });
    const lib = openLibrary({ root: target, expectedId: result.libraryId }),
      owner = { grant: { proof: 'test' } },
      downloads = createDownloads({ library: lib, root: target });
    try {
      lib.read((db) => {
        assert.deepEqual(listWorks(db, { source: 'folder:77' }, owner).ids, ['3', '1', '2']);
        assert.deepEqual(listWorks(db, { source: 'folder:78' }, owner).ids, displayed);
        assert.deepEqual(listWorks(db, { source: 'author:' + author }, owner).ids, ['1']);
        assert.deepEqual(listWorks(db, { source: 'total' }, owner).ids, []);
        assert.equal(mediaList(db, '88').find((a) => a.key === 'audio')?.saved, true);
        assert.ok(!mediaList(db, '89').some((a) => a.key === 'audio' && a.saved));
        assert.ok(downloads.page(db, { tab: 'failed' }).jobs.some((j) => j.workId === '4'));
        assert.deepEqual(
          downloads
            .page(db, { tab: 'failed' })
            .jobs.map((j) => j.workId)
            .filter((id) => ['14', '15'].includes(id)),
          ['14', '15']
        );
        assert.ok(!downloads.page(db, { tab: 'active' }).jobs.some((j) => j.workId === '5'));
      });
      const proof = await preserveBeforeRollback({
        root: target,
        libraryId: result.libraryId,
        imageDigest,
        uid,
        confirmed: true
      });
      assert.equal(proof.verification.extra.length, 0);
      assert.ok(proof.verified);
      const restored = await recovery.restoreApproved({
        uid,
        libraryId: result.libraryId,
        snapshot: proof.snapshot,
        mediaRoot: proof.mediaRoot,
        target: path.join(root, 'recovered'),
        confirmed: true,
        manifestSha256: proof.manifestSha256
      });
      assert.equal(restored.verifiedPlayback, 1);
      lib.write((db) =>
        db.prepare("UPDATE works SET body=json_set(body,'$.music.id','101') WHERE id='88'").run()
      );
      const later = await preserveBeforeRollback({
        root: target,
        libraryId: result.libraryId,
        imageDigest,
        uid,
        confirmed: true
      });
      const inactive = await recovery.restoreApproved({
        uid,
        libraryId: result.libraryId,
        snapshot: later.snapshot,
        mediaRoot: later.mediaRoot,
        target: path.join(root, 'old-track'),
        confirmed: true,
        manifestSha256: later.manifestSha256
      });
      assert.equal(inactive.verifiedPlayback, 0);
      assert.equal(inactive.inactiveMedia.length, 1);
      const oldCopy = openLibrary({ root: inactive.target, expectedId: result.libraryId });
      try {
        oldCopy.read((db) => assert.ok(!mediaList(db, '88').some((r) => r.key === 'audio' && r.saved)));
      } finally {
        oldCopy.close();
      }
      assert.deepEqual(
        fs.readFileSync(path.join(inactive.target, 'cangxia-server', 'media', inactive.inactiveMedia[0].key)),
        audio
      );
    } finally {
      await downloads.close();
      lib.close();
    }
  } finally {
    s.close();
    await n.close();
  }
});

test('native NAS deletion tombstones yield only to a later proved restore of that member on the same library', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-scoped-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = (name) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    return d;
  };
  const nas = make('nas'),
    old = make('old'),
    win = make('win'),
    target = path.join(root, 'new'),
    uid = '55';
  const n = createBackupServer({
    dataDir: nas,
    token: 'scoped-history-unit-'.repeat(2),
    allowInsecureLoopback: true
  });
  await n.listen();
  const local = await Store.open(path.join(win, 'library.sqlite'), path.join(win, 'archive'));
  try {
    const libraryId = n.status().libraryId,
      scopes = new ScopeState(n.db),
      device = { id: randomUUID(), name: 'synthetic NAS device' },
      author = 'MS4wLjABfixture123';
    local.setSetting('account', { uid });
    local.deviceScopes.bind(libraryId);
    const put = (table, key, body, revision = 0) =>
      n.db
        .prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)')
        .run(table, key, body === null ? null : JSON.stringify(body), revision);
    put('settings', 'account', { value: { uid } });
    put('authors', author, {
      id: author,
      uid: '800',
      name: '作者',
      folder: '作者作品/测试',
      url: 'https://www.douyin.com/user/' + author
    });
    for (const key of ['5', '6', '8']) {
      put('works', key, work(key));
      local.put('works', key, work(key));
    }
    put('collections', '__all__', { id: '__all__', name: '总收藏', folder: '收藏' });
    const member = (id, pos) => ({
      table: 'members',
      key: '__all__:' + id,
      body: { collectionId: '__all__', workId: id, rank: pos }
    });
    const authorMember = {
      table: 'author_members',
      key: author + ':5',
      body: { authorId: author, workId: '5', position: 0, hidden: false }
    };
    for (const row of [member('5', 0), authorMember, member('6', 2)]) put(row.table, row.key, row.body);
    local.db.run('INSERT INTO members VALUES(?,?,?)', ['__all__', '6', 2]);
    put('members', '__all__:8', null); // Ordinary old NULL, without a deletion generation or matching receipt.
    put('collections', '77', { id: '77', name: '另一夹', folder: '另一夹' });
    put('members', '77:5', { collectionId: '77', workId: '5', rank: 4 });
    put('collections', '99', { id: '99', name: '未知归属', folder: '未知' });
    put('members', '99:5', null);
    const account = (id) => ({ workId: id, kind: 'account', sourceId: '__all__' });
    const authorScope = { workId: '5', kind: 'author', sourceId: author };
    const cmd = (items, generation) => ({
      operationId: randomUUID(),
      libraryId,
      items: items.map((scope) => ({ scope, expectedGeneration: generation }))
    });
    const firstCommand = cmd([account('5'), authorScope, account('6')], 0);
    const deleted = scopes.delete(firstCommand, device);
    assert.equal(
      n.db
        .prepare("SELECT revision FROM records WHERE kind='members' AND id='__all__:5' AND body IS NULL")
        .get().revision,
      deleted.dataRevision
    );
    const grant = scopes.prepareRestore(cmd([account('5'), authorScope], 1), device);
    const firstRestore = scopes.finishRestore(grant.grantId, [member('5', 0), authorMember], device);
    assert.equal(firstRestore.items[0].generation, 2);
    scopes.delete(cmd([account('5'), authorScope], 2), device);
    n.db.prepare('VACUUM INTO ?').run(path.join(old, 'library.sqlite'));
    const oldDatabase = path.join(old, 'library.sqlite'),
      historical = new DatabaseSync(oldDatabase);
    const packed = historical
      .prepare('SELECT result FROM scope_receipts WHERE operation_id=?')
      .get(firstCommand.operationId);
    historical
      .prepare('UPDATE scope_receipts SET result=? WHERE operation_id=?')
      .run('gz1:' + gzipSync(packed.result).toString('base64'), firstCommand.operationId);
    historical.close();
    const next = scopes.prepareRestore(cmd([account('5'), authorScope], 3), device);
    const folder = { table: 'members', key: '77:5', body: { collectionId: '77', workId: '5', rank: 4 } };
    const restored = scopes.finishRestore(next.grantId, [member('5', 0), folder, authorMember], device);
    assert.equal(restored.items[0].generation, 4);
    put('members', '__all__:8', member('8', 3).body, restored.dataRevision);
    put('members', '99:5', { collectionId: '99', workId: '5', rank: 4 }, restored.dataRevision);
    const sources = [];
    for (const [directory, kind] of [
      [nas, 'nas'],
      [old, 'recovery'],
      [win, 'windows']
    ])
      sources.push(await sealSource({ directory, kind, database: 'library.sqlite' }));
    const args = { sources, uid, target, imageDigest },
      preview = await previewImport(args);
    const result = await importApproved({
      ...args,
      previewId: preview.previewId,
      approval: { confirmed: true, uid, target, previewId: preview.previewId }
    });
    const lib = openLibrary({ root: target, expectedId: result.libraryId });
    try {
      lib.read((db) => {
        const owner = { grant: { proof: 'test' } };
        assert.deepEqual(listWorks(db, { source: 'total' }, owner).ids, ['5']);
        assert.deepEqual(listWorks(db, { source: 'author:' + author }, owner).ids, ['5']);
        assert.deepEqual(listWorks(db, { source: 'folder:77' }, owner).ids, ['5']);
        assert.deepEqual(listWorks(db, { source: 'folder:99' }, owner).ids, []);
      });
    } finally {
      lib.close();
    }
    assert.ok(preview.conflicts.some((x) => x.key === '__all__:8' && x.reason.includes('删除')));
    const pruned = new DatabaseSync(oldDatabase);
    pruned.prepare('DELETE FROM scope_receipts WHERE operation_id=?').run(firstCommand.operationId);
    pruned.close();
    n.db.prepare('DELETE FROM scope_receipts WHERE operation_id=?').run(firstCommand.operationId);
    const again = async (name) =>
      previewImport({
        ...args,
        target: path.join(root, name),
        sources: await Promise.all(sources.map((s) => sealSource(s)))
      });
    const noCommand = await again('compact-unproved');
    assert.ok(
      noCommand.conflicts.some((x) => x.type === 'members' && x.key === '77:5' && x.reason.includes('未核实'))
    );
    local.deviceScopes.db.exec(
      'CREATE TABLE IF NOT EXISTS local_deletion_commands(local_id TEXT,library_id TEXT,operation_id TEXT,position INTEGER,body TEXT,receipt TEXT,PRIMARY KEY(local_id,library_id,operation_id,position))'
    );
    local.deviceScopes.db
      .prepare('INSERT INTO local_deletion_commands VALUES(?,?,?,?,?,NULL)')
      .run(local.localIdentity, libraryId, randomUUID(), 0, JSON.stringify(firstCommand));
    const withCommand = await again('compact-proved');
    assert.ok(
      withCommand.conflicts.some(
        (x) => x.type === 'scopeHistory' && x.key === '77:5' && x.reason.includes('已核实')
      )
    );
    assert.ok(
      !withCommand.conflicts.some(
        (x) => x.type === 'members' && x.key === '77:5' && x.reason.includes('未核实')
      )
    );
  } finally {
    local.close();
    await n.close();
  }
});

test('native cover-only failure retains archived video and projects safe diagnostic metadata', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-old-cover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const win = path.join(root, 'windows');
  fs.mkdirSync(win);
  const media = path.join(win, 'archive'),
    store = await Store.open(path.join(win, 'library.sqlite'), media);
  const uid = '111',
    target = path.join(root, 'detached'),
    queue = new DownloadQueue(store, {}, undefined, () => {});
  store.setSetting('account', { uid });
  const video = fs.readFileSync(new URL('./fixtures/media-preview.mp4', import.meta.url));
  const cover = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64'
  );
  const diagnostic = {
    11: 'No matching frame',
    12: 'Matcher failed at /private/real-library/frames',
    13: 'Authorization: Basic concealed-value',
    14: null,
    15: 'upstream error: access_token=SYNTHETIC_FIXTURE',
    16: 'No YUV/RGB match'
  };
  const reasons = {
    15: ['upstream error: access_token=SYNTHETIC_FIXTURE', '{"refreshToken":"SYNTHETIC_REFRESH"}'],
    16: ['HTTP/2 returned 404', 'image/jpeg at 30000/1001 fps']
  };
  const stamp = '2026-01-02T00:00:00Z';
  const nativeStatus = (reason) => ({ state: 'unknown', method: 'api', checkedAt: stamp, reason });
  try {
    store.readHistory.batches.put({
      token: 'old-diagnostics',
      scope: '__batch__',
      source: 'batch',
      startedAt: stamp,
      reason: 'X-API-Key: SYNTHETIC_API_KEY',
      message: 'ENOENT: open "C:\\private\\frames"',
      batchMessage: 'retry: sessionid_ss=SYNTHETIC_COOKIE',
      warning: true
    });
    store.readHistory.batches.put({
      token: 'old-formats',
      scope: '__batch__',
      source: 'batch',
      startedAt: stamp,
      reason: 'Basic YUV/RGB comparison failed',
      message: 'access token expired',
      batchMessage: 'frame 3/5'
    });
    for (const [id, message] of Object.entries(diagnostic)) {
      const home = { kind: 'collection', id: '__all__', folder: '收藏', workFolder: '旧作品' + id };
      const homeDir = path.join(media, home.folder, home.workFolder);
      fs.mkdirSync(homeDir, { recursive: true });
      const w = { ...work(id), coverUrls: ['https://example.com/cover.jpg'] };
      if (reasons[id]) {
        w.sourceStatus = nativeStatus(reasons[id][0]);
        w.sourceAttempt = nativeStatus(reasons[id][1]);
      }
      store.put('works', id, w);
      const assets = [];
      for (const [key, file, bytes] of [
        ['video', '原件.mp4', video],
        ['cover', '单图.png', cover]
      ]) {
        fs.writeFileSync(path.join(homeDir, file), bytes);
        assets.push({
          key,
          file,
          size: bytes.length,
          kind: key === 'video' ? 'video' : 'image',
          sha256: hash(bytes)
        });
      }
      store.put('downloads', id, {
        id,
        home,
        path: homeDir,
        collectionId: '__all__',
        state: 'complete',
        assets
      });
      queue.hdCovers = new HDCover({
        store,
        extract: async () => {
          if (message) throw Error(message);
          return { width: 1, height: 1 };
        }
      });
      const save = queue.saveWork({ id, coverOnly: true }, new AbortController().signal);
      if (message) await assert.rejects(save, /未取得/);
      else await save;
      assert.equal(store.download(id).state, 'complete');
      const native = JSON.parse(fs.readFileSync(path.join(homeDir, '作品信息.json')));
      if (message) assert.equal(native.hdCover.message, message);
      else assert.equal(native.hdCover.status, 'ready');
    }
    const args = {
      uid,
      target,
      imageDigest,
      sources: [await sealSource({ directory: win, kind: 'windows', database: 'library.sqlite' })]
    };
    const pre = await previewImport(args);
    const result = await importApproved({
      ...args,
      previewId: pre.previewId,
      approval: { confirmed: true, uid, target, previewId: pre.previewId }
    });
    const lib = openLibrary({ root: target, expectedId: result.libraryId });
    try {
      lib.read((db) =>
        assert.deepEqual(
          listWorks(
            db,
            { source: 'all', filter: { downloaded: 'complete' } },
            { grant: { proof: 'test' } }
          ).ids.sort(),
          Object.keys(diagnostic)
        )
      );
      const info = (id) =>
        fs.readFileSync(path.join(result.mediaRoot, '收藏', '旧作品' + id, '作品信息.json'), 'utf8');
      const withheld = '旧端诊断明细已隐去';
      for (const [id, expected] of [['15', [withheld, withheld]], ['16', reasons[16]]]) {
        const original = fs.readFileSync(path.join(media, '收藏', '旧作品' + id, '作品信息.json'), 'utf8');
        const handedOff = info(id);
        const metadata = JSON.parse(handedOff);
        assert.equal(JSON.parse(original).hdCover.message, diagnostic[id]);
        assert.equal(JSON.parse(original).sourceAttempt.reason, reasons[id][1]);
        assert.equal(metadata.hdCover.message, id === '15' ? withheld : diagnostic[id]);
        const stored = lib.read((db) => JSON.parse(db.prepare('SELECT body FROM works WHERE id=?').get(id).body));
        for (const doc of [metadata, stored]) {
          assert.deepEqual(doc.sourceStatus, nativeStatus(expected[0]));
          assert.deepEqual(doc.sourceAttempt, nativeStatus(expected[1]));
        }
        const projection = pre.conflicts.find((c) => c.type === 'metadataProjection' && c.key === id + '/metadata');
        if (id === '15') {
          assert.ok(projection.reason.includes(hash(original)) && projection.reason.includes(hash(handedOff)));
          assert.notEqual(hash(original), hash(handedOff));
        } else {
          assert.equal(handedOff, original);
          assert.equal(projection, undefined);
        }
      }
      const summary = (id) =>
        lib.read((db) => JSON.parse(db.prepare('SELECT summary FROM read_legacy_runs WHERE id=?').get(id).summary));
      const hidden = summary('old-diagnostics');
      assert.deepEqual(
        [hidden.reason, hidden.message, hidden.batchMessage, hidden.warning],
        [withheld, withheld, withheld, true]
      );
      const formats = summary('old-formats');
      assert.deepEqual(
        [formats.reason, formats.message, formats.batchMessage],
        ['Basic YUV/RGB comparison failed', 'access token expired', 'frame 3/5']
      );
      assert.ok(!JSON.stringify(pre).includes('SYNTHETIC_'));
      assert.ok(!fs.readFileSync(path.join(result.snapshot, 'library.sqlite')).includes('SYNTHETIC_'));
      assert.deepEqual(await sealSource({ directory: win, kind: 'windows', database: 'library.sqlite' }), args.sources[0]);
      assert.equal(JSON.parse(info('11')).hdCover.message, 'No matching frame');
      assert.equal(
        info('11'),
        fs.readFileSync(path.join(media, '收藏', '旧作品11', '作品信息.json'), 'utf8')
      );
      const sensitive = info('12');
      assert.equal(JSON.parse(sensitive).hdCover.status, 'failed');
      assert.ok(!sensitive.includes('/private/') && !info('13').includes('concealed-value'));
      assert.deepEqual(JSON.parse(info('14')).hdCover, {
        status: 'ready',
        source: 'platform',
        key: 'cover',
        width: 1,
        height: 1,
        videoWidth: 1,
        videoHeight: 1
      });
      assert.ok(!JSON.stringify(pre).includes('concealed-value'));
      assert.ok(pre.conflicts.some((c) => c.reason.includes('hdCover.message') && c.reason.includes('隐去')));
      const restored = await recovery.restoreApproved({
        snapshot: result.snapshot,
        mediaRoot: result.mediaRoot,
        manifestSha256: result.manifestSha256,
        libraryId: result.libraryId,
        uid,
        confirmed: true,
        target: path.join(root, 'playable')
      });
      assert.equal(restored.verifiedPlayback, 12);
      assert.ok(!fs.readFileSync(path.join(result.snapshot, 'library.sqlite')).includes('concealed-value'));
    } finally {
      lib.close();
    }
  } finally {
    store.close();
  }
});
