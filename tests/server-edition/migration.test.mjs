import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import selfsigned from 'selfsigned';
import { createSessionService } from '../../server/session.mjs';
import { createHttpsService } from '../../server/http.mjs';
import { createRehearsals } from '../../server/rehearsal-service.mjs';
import { ServerClient, pinnedRequest } from '../../electron/server-client.mjs';
import { registerCatalogueHandlers } from '../../electron/server-ipc.mjs';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../electron/store.mjs';
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
  const source = createBackupServer({
    dataDir: nas,
    token: 'synthetic-rehearsal-only-'.repeat(2),
    allowInsecureLoopback: true
  });
  await source.listen();
  const bytes = Buffer.from('synthetic-video-body'),
    sha = hash(bytes),
    home = { kind: 'collection', id: '__all__', folder: '收藏', workFolder: '旧归档' };
  fs.writeFileSync(path.join(nas, 'objects', sha), bytes);
  const record = (table, key, body) =>
    source.db.prepare('INSERT INTO records VALUES(?,?,?,1)').run(table, key, JSON.stringify(body));
  record('settings', 'account', { value: { uid } });
  record('works', id, work(id));
  record('works', deleted, work(deleted));
  source.db.prepare('INSERT INTO objects VALUES(?,?)').run(sha, bytes.length);
  const metadata = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      workId: id,
      workName: '旧归档',
      assets: [{ key: 'video', file: '原件.mp4', size: bytes.length }]
    })
  );
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
      assert.equal(db.prepare('SELECT state FROM download_jobs WHERE work_id=?').get(id).state, 'cancelled');
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
      verifyRestore({ snapshot, mediaRoot: archive, manifestSha256: result.manifestSha256 });
    assert.equal((await check()).matched.length, 2);
    assert.deepEqual(fs.readFileSync(path.join(archive, '收藏', '旧归档', '作品信息.json')), metadata);
    fs.writeFileSync(path.join(archive, rel), 'modified');
    assert.equal((await check()).changed.length, 1);
    fs.unlinkSync(path.join(archive, rel));
    assert.equal((await check()).missing.length, 1);
    fs.writeFileSync(path.join(archive, '旁存文件'), 'keep');
    assert.deepEqual((await check()).extra, ['旁存文件']);
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
  const root = path.join(tmp, 'rehearsal'),
    liveRoot = path.join(tmp, 'live');
  for (const n of ['sources', 'manifests', 'targets', 'restores', 'reports'])
    fs.mkdirSync(path.join(root, n), { recursive: true });
  fs.mkdirSync(liveRoot);
  const src = path.join(root, 'sources', 'desktop');
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
  fs.writeFileSync(path.join(root, 'manifests', 'desktop.json'), json);
  fs.writeFileSync(path.join(root, 'rehearsal.json'), JSON.stringify(config));
  const library = openLibrary({ root: liveRoot, mode: 'init' }),
    sessions = createSessionService({ library });
  const service = createRehearsals({ root, liveRoot }),
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
  const invalid = await op({ action: 'preview', sources, target: '../escape' });
  assert.equal(invalid.state, 'failed');
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
  await client.release();
  await other.connect({ ...cfg, deviceId: 'B', token: creds.B.token });
  await other.acquire();
  await assert.rejects(other.call('rehearsal', { input: { action: 'list' } }), /账号无权/);
});
