import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openLibrary } from '../../server/library.mjs';
import { openDownloadStore } from '../../server/download-store.mjs';
import { createSessionService } from '../../server/session.mjs';
import { createTrashAdapter } from '../../server/trash.mjs';

function fixture(t, fileHook) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-removal-'));
  const root = path.join(base, 'library'),
    bin = path.join(base, 'native');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  const library = openLibrary({ root, mode: 'init' }),
    store = openDownloadStore({ root, library, fileHook });
  const { layout } = store;
  const original = path.join(layout.media, 'folder', 'one', 'video.mp4');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, 'synthetic bytes');
  const sha = createHash('sha256').update('synthetic bytes').digest('hex');
  const identity = (file) => {
    const s = fs.statSync(file, { bigint: true });
    return { dev: String(s.dev), ino: String(s.ino) };
  };
  const proof = {
    identity: identity(original),
    mtimeNs: String(fs.statSync(original, { bigint: true }).mtimeNs),
    size: 15,
    sha256: sha
  };
  library.write((db) => {
    db.prepare('INSERT INTO works VALUES(?,?,?)').run(
      '11',
      'sample',
      JSON.stringify({ id: '11', name: 'sample', type: 'video' })
    );
    for (const source of ['folder:12', 'folder:13', 'total'])
      db.prepare('INSERT INTO source_members VALUES(?,?,1,1)').run(source, '11');
    db.exec("INSERT INTO work_tags VALUES('11','saved')");
    db.prepare('INSERT INTO media_files VALUES(?,?,?,?,?)').run(
      '11:video',
      '11',
      'folder/one/video.mp4',
      15,
      sha
    );
    db.exec("INSERT INTO archive_assets VALUES('11:video','video','video','video/mp4',1)");
    db.prepare('INSERT INTO file_commits VALUES(?,?,?,?,?,1)').run(
      'file',
      '11',
      '11:video',
      'registered',
      JSON.stringify(proof)
    );
    db.prepare('INSERT INTO archive_homes VALUES(?,?)').run(
      '11',
      JSON.stringify({
        identity: identity(path.dirname(original)),
        home: { kind: 'collection', id: '12', folder: 'folder', workFolder: 'one' }
      })
    );
  });
  const who = { accountId: 'test', deviceId: 'test' };
  let sessions, grant;
  function reconnect() {
    sessions?.close();
    sessions = createSessionService({ library, removalFiles: { store, layout, bin } });
    grant = sessions.acquire(who, { ...who, instanceId: randomUUID(), operationId: randomUUID() });
  }
  reconnect();
  const cmd = (kind, payload, id = randomUUID()) =>
    sessions.command(who, grant, { kind, payload, entityVersion: 0, operationId: id });
  const query = (kind, payload = {}) => sessions.query(who, grant, { kind, payload });
  function preview(scope, source = 'all') {
    const view = query('list-works', { source });
    return cmd('preview-removal', {
      scope,
      selection: { source, ids: ['11'], all: false, revision: view.revision, scope: view.scope }
    });
  }
  t.after(() => {
    sessions.close();
    store.close();
    library.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { library, store, layout, bin, cmd, query, preview, original, sha, proof, reconnect };
}

test('only the named source is removed; the work, other source and shared bytes survive', (t) => {
  const f = fixture(t),
    p = f.preview('membership', 'folder:12');
  const id = randomUUID(),
    confirm = () => f.cmd('confirm-removal', { token: p.token }, id);
  assert.deepEqual(confirm(), confirm());
  assert.equal(f.query('list-works', { source: 'folder:12' }).total, 0);
  assert.equal(f.query('list-works', { source: 'folder:13' }).total, 1);
  assert.equal(fs.existsSync(f.original), true);
  assert.throws(() => f.cmd('restore-removal', { token: p.token }), /来源/);
});

test('work record receipt restores tags and independently ordered memberships; expired preview has no effect', (t) => {
  const f = fixture(t),
    old = f.preview('records'),
    p = f.preview('records');
  f.cmd('confirm-removal', { token: p.token });
  assert.throws(() => f.cmd('confirm-removal', { token: old.token }));
  assert.equal(f.query('list-works', { source: 'all' }).total, 0);
  assert.equal(f.query('list-works', { source: 'media' }).total, 1);
  const restore = f.cmd('preview-restore', { token: p.token });
  f.cmd('restore-removal', { token: restore.token });
  assert.equal(f.query('list-works', { source: 'folder:13' }).total, 1);
  assert.equal(f.query('work-detail', { id: '11' }).localTags[0], 'saved');
});

test('unverified bin preserves the registered file; native adapter restores without overwriting', async (t) => {
  const f = fixture(t),
    p = f.preview('files');
  assert.match(p.reason, /回收站/);
  assert.throws(() => f.cmd('confirm-removal', { token: p.token }), /回收站/);
  assert.equal(fs.readFileSync(f.original, 'utf8'), 'synthetic bytes');
  const adapter = createTrashAdapter({ layout: f.layout, bin: f.bin });
  const file = {
    relative_path: 'folder/one/video.mp4',
    ...f.proof,
    parent: JSON.parse(f.store.db.prepare('SELECT body FROM archive_homes').get().body).identity
  };
  const binding = adapter.binding();
  await adapter.trash(file, binding);
  fs.writeFileSync(f.original, 'foreign');
  await assert.rejects(adapter.restore(file, binding));
  assert.equal(fs.readFileSync(f.original, 'utf8'), 'foreign');
  fs.renameSync(f.original, f.original + '.foreign');
  await adapter.restore(file, binding);
  assert.equal(fs.readFileSync(f.original, 'utf8'), 'synthetic bytes');
});

async function until(get, match) {
  for (let i = 0; i < 200; i++) {
    const v = get();
    if (match(v)) return v;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('timed out: ' + JSON.stringify(get()));
}
test('operator-attested synthetic challenge, staged trash, conflict preview and verified restoration through session commands', async (t) => {
  const f = fixture(t),
    s = () => f.query('trash-status');
  const challenge = f.cmd('start-trash-probe', {
    supported: true,
    reference: 'synthetic fixture',
    retention: 'synthetic fixture only'
  });
  const p = await until(s, (v) => v.phase === 'await-native' && !v.busy);
  assert.throws(() =>
    f.cmd('control-trash-probe', { token: challenge.probeToken, action: 'verify', observed: false })
  );
  f.cmd('control-trash-probe', { token: p.token, action: 'verify', observed: true });
  await until(s, (v) => v.phase === 'await-native' && !v.busy && /尚未通过/.test(v.reason));
  assert.ok(!s().verified);
  // Emulate the external appliance restore in this isolated share. This does not test UGOS.
  fs.renameSync(p.bin, p.original);
  f.cmd('control-trash-probe', { token: p.token, action: 'verify', observed: true });
  await until(s, (v) => v.verified && !v.busy);
  const remove = f.preview('files');
  assert.equal(remove.reason, '');
  f.cmd('confirm-removal', { token: remove.token });
  await until(
    () => f.query('removal-status', { token: remove.token }),
    (v) => v.state === 'done'
  );
  assert.equal(fs.existsSync(f.original), false);
  assert.equal(f.query('list-works', { source: 'folder:13' }).total, 1);
  assert.equal(f.query('list-works', { source: 'media' }).total, 0);
  fs.writeFileSync(f.original, 'unknown');
  const conflict = f.cmd('preview-restore', { token: remove.token });
  assert.match(conflict.reason, /占用/);
  assert.throws(() => f.cmd('restore-removal', { token: conflict.token }));
  assert.equal(fs.readFileSync(f.original, 'utf8'), 'unknown');
  fs.renameSync(f.original, f.original + '.external');
  const restore = f.cmd('preview-restore', { token: remove.token });
  f.cmd('restore-removal', { token: restore.token });
  await until(
    () => f.query('removal-status', { token: restore.token }),
    (v) => v.state === 'done'
  );
  assert.equal(fs.readFileSync(f.original, 'utf8'), 'synthetic bytes');
  assert.equal(f.query('list-works', { source: 'media' }).total, 1);
  assert.equal(f.query('removal-history')[1].state, 'restored');
});

test('interrupted physical move and restore reconcile on explicit retry after restarting sessions', async (t) => {
  let interrupt = true;
  const f = fixture(t, (stage) => {
    if (stage === 'afterRemovalMove' && interrupt) {
      interrupt = false;
      throw Error('interrupted before receipt');
    }
  });
  const s = () => f.query('trash-status');
  f.cmd('start-trash-probe', { supported: true, reference: 'synthetic fixture', retention: 'fixture' });
  const p = await until(s, (v) => v.phase === 'await-native' && !v.busy);
  fs.renameSync(p.bin, p.original);
  f.cmd('control-trash-probe', { token: p.token, action: 'verify', observed: true });
  await until(s, (v) => v.verified && !v.busy);
  const remove = f.preview('files');
  f.cmd('confirm-removal', { token: remove.token });
  const state = (token) => () => f.query('removal-status', { token });
  await until(state(remove.token), (v) => v.state === 'paused');
  assert(!fs.existsSync(f.original));
  assert.equal(f.store.resources('11').length, 1);
  f.reconnect();
  assert.equal(state(remove.token)().state, 'paused');
  f.cmd('control-removal', { token: remove.token, action: 'resume' });
  await until(state(remove.token), (v) => v.state === 'done');
  assert.equal(f.store.resources('11').length, 0);
  const r = f.cmd('preview-restore', { token: remove.token });
  interrupt = true;
  f.cmd('restore-removal', { token: r.token });
  await until(state(r.token), (v) => v.state === 'paused');
  assert.equal(fs.readFileSync(f.original, 'utf8'), 'synthetic bytes');
  assert.equal(f.store.resources('11').length, 0);
  f.reconnect();
  f.cmd('control-removal', { token: r.token, action: 'resume' });
  await until(state(r.token), (v) => v.state === 'done');
  assert.equal(f.store.resources('11').length, 1);
  assert.ok(f.store.resources('11')[0].revision > 1);
});

test('a normal downloaded album supports partial rollback while a foreign replacement stays untouched', async (t) => {
  const { createDownloads } = await import('../../server/downloads.mjs');
  const { resolveResource } = await import('../../server/files.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-album-removal-'));
  const root = path.join(base, 'volume'),
    bin = path.join(base, 'bin');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  const library = openLibrary({ root, mode: 'init' });
  const work = {
    id: '501',
    name: '合成图集',
    type: 'images',
    author: { nickname: '测试' },
    images: [0, 1].map((index) => ({ index, urls: ['https://p3.douyinpic.com/fixture-' + index] }))
  };
  library.write((db) => {
    db.exec(
      "INSERT INTO source_account VALUES (1,'42','测试','profile');INSERT INTO download_auth VALUES(1,'fixture-key')"
    );
    db.prepare('INSERT INTO works VALUES(?,?,?)').run(work.id, work.name, JSON.stringify(work));
  });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64'
  );
  const source = { account: () => ({ uid: '42', authEpoch: 'fixture' }) };
  const downloads = createDownloads({
    library,
    root,
    source,
    fetchAsset: async () => new Response(png, { headers: { 'Content-Type': 'image/png' } })
  });
  const sessions = createSessionService({ library, downloads, source, removalFiles: { ...downloads, bin } });
  const who = { accountId: 'fixture', deviceId: 'pc' },
    grant = sessions.acquire(who, { ...who, instanceId: randomUUID(), operationId: randomUUID() });
  const cmd = (kind, payload) =>
    sessions.command(who, grant, { kind, payload, entityVersion: 0, operationId: randomUUID() });
  const query = (kind, payload = {}) => sessions.query(who, grant, { kind, payload });
  t.after(async () => {
    await sessions.close();
    await downloads.close();
    library.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  cmd('enqueue-download', { workIds: [work.id], selection: 'missing' });
  await downloads.run();
  assert.equal(query('download-page', { tab: 'all' }).jobs[0].state, 'complete');
  cmd('start-trash-probe', { supported: true, reference: 'fixture', retention: 'fixture' });
  const s = () => query('trash-status'),
    p = await until(s, (v) => v.phase === 'await-native' && !v.busy);
  fs.renameSync(p.bin, p.original);
  cmd('control-trash-probe', { token: p.token, action: 'verify', observed: true });
  await until(s, (v) => v.verified && !v.busy);
  const view = query('list-works', { source: 'media' }),
    r = cmd('preview-removal', {
      scope: 'files',
      selection: { source: 'media', ids: [work.id], all: false, revision: view.revision, scope: view.scope }
    });
  assert.equal(r.files, 3);
  assert.equal(r.reason, '');
  const second = path.join(downloads.layout.media, r.items[1].path);
  fs.renameSync(second, second + '.retained');
  fs.copyFileSync(second + '.retained', second);
  cmd('confirm-removal', { token: r.token });
  const status = (token) => () => query('removal-status', { token });
  await until(status(r.token), (v) => v.state === 'paused' && v.done === 1);
  assert.throws(() => cmd('enqueue-download', { workIds: [work.id], selection: 'missing' }), /删除或恢复/);
  const partial = cmd('preview-restore', { token: r.token });
  assert.equal(partial.files, 1);
  cmd('restore-removal', { token: partial.token });
  await until(status(partial.token), (v) => v.state === 'done');
  assert.equal(status(r.token)().state, 'paused');
  assert.equal(downloads.store.resources(work.id).length, 3);
  fs.renameSync(second, second + '.external');
  fs.renameSync(second + '.retained', second);
  cmd('control-removal', { token: r.token, action: 'resume' });
  await until(status(r.token), (v) => v.state === 'done');
  const rest = cmd('preview-restore', { token: r.token });
  assert.equal(rest.files, 2);
  cmd('restore-removal', { token: rest.token });
  await until(status(rest.token), (v) => v.state === 'done');
  for (const { key } of downloads.store.resources(work.id)) {
    await resolveResource({ ...downloads, workId: work.id, key, verify: true });
  }
  assert.equal(downloads.store.resources(work.id).length, 3);
  assert.equal(query('list-works', { source: 'media' }).total, 1);
  assert.equal(status(r.token)().state, 'restored');
});
