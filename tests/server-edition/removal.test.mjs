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

async function verifyTestRecycle(f) {
  const status = () => f.query('trash-status');
  f.cmd('start-trash-probe', { supported: true, reference: 'test fixture', retention: 'test' });
  const sample = await until(status, (p) => p.phase === 'await-native' && !p.busy);
  fs.renameSync(sample.bin, sample.original);
  f.cmd('control-trash-probe', { token: sample.token, action: 'verify', observed: true });
  await until(status, (p) => p.verified && !p.busy);
}

for (const restoring of [false, true])
  for (const swappedSide of ['original', 'recycled'])
    test(
      'receipt checks ' +
        swappedSide +
        ' canonical directory chain after ' +
        (restoring ? 'restore' : 'trash'),
      async (t) => {
        let swap;
        const f = fixture(t, (stage) => {
          if (stage === 'afterRemovalMove' && swap) {
            const replace = swap;
            swap = null;
            replace();
          }
        });
        await verifyTestRecycle(f);
        const r = f.preview('files');
        const status = (token) => () => f.query('removal-status', { token });
        const parent =
          swappedSide === 'original' ? path.dirname(f.original) : path.join(f.bin, 'folder', 'one');
        if (restoring) {
          f.cmd('confirm-removal', { token: r.token });
          await until(status(r.token), (p) => p.state === 'done');
        }
        const job = restoring ? f.cmd('preview-restore', { token: r.token }) : r;
        swap = () => {
          fs.renameSync(parent, parent + '.held');
          fs.mkdirSync(parent);
          fs.writeFileSync(path.join(parent, 'video.mp4'), 'foreign');
        };
        f.cmd(restoring ? 'restore-removal' : 'confirm-removal', { token: job.token });
        const observed = await until(status(job.token), (p) => ['paused', 'done'].includes(p.state));
        assert.equal(observed.state, 'paused');
        assert.equal(f.store.resources('11').length, restoring ? 0 : 1);
        assert.equal(fs.readFileSync(path.join(parent, 'video.mp4'), 'utf8'), 'foreign');
        fs.renameSync(parent, parent + '.foreign');
        fs.renameSync(parent + '.held', parent);
        f.cmd('control-removal', { token: job.token, action: 'resume' });
        await until(status(job.token), (p) => p.state === 'done');
        assert.equal(f.store.resources('11').length, restoring ? 1 : 0);
      }
    );
test('cancel a blocked deletion before any move without requiring the retired backend', async (t) => {
  const f = fixture(t);
  await verifyTestRecycle(f);
  const r = f.preview('files');
  fs.renameSync(f.original, f.original + '.outside');
  f.cmd('confirm-removal', { token: r.token });
  const status = () => f.query('removal-status', { token: r.token });
  await until(status, (p) => p.state === 'paused');
  fs.renameSync(f.bin, f.bin + '.retired');
  f.cmd('control-removal', { token: r.token, action: 'cancel' });
  await until(status, (p) => p.state === 'cancelled');
  assert.equal(f.store.resources('11').length, 1);
  const { removalOwnsFiles } = await import('../../server/removal.mjs');
  assert.equal(removalOwnsFiles(f.store.db, '11'), false);
});

test('old public membership command cannot bypass confirmation or the removal history', (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.cmd('remove-membership', { source: { kind: 'total', id: '__all__' }, workId: '11' }),
    { code: 'UNKNOWN_COMMAND' }
  );
  assert.equal(f.query('list-works', { source: 'total' }).total, 1);
  assert.deepEqual(f.query('removal-history'), []);
});

for (const replaceRoot of [false, true])
  test('restore old boot receipt after new proof; replaced recycle root ' + replaceRoot, async (t) => {
    const f = fixture(t);
    await verifyTestRecycle(f);
    const r = f.preview('files');
    f.cmd('confirm-removal', { token: r.token });
    await until(
      () => f.query('removal-status', { token: r.token }),
      (p) => p.state === 'done'
    );
    // A reboot invalidates the original volatile proof. Leave it on the receipt.
    f.library.write((db) => {
      db.prepare(
        "UPDATE removal_batches SET body=json_set(body,'$.binding.boot','previous-boot','$.binding.media.mount','previous-mount') WHERE token=?"
      ).run(r.token);
      db.exec(
        "UPDATE trash_probe SET body=json_set(body,'$.binding.boot','previous-boot','$.binding.media.mount','previous-mount')"
      );
    });
    assert.throws(() => f.cmd('control-removal', { token: r.token, action: 'rebind' }));
    if (replaceRoot) {
      fs.renameSync(f.bin, f.bin + '.original');
      fs.mkdirSync(f.bin);
    }
    await verifyTestRecycle(f);
    const before = f.cmd('preview-restore', { token: r.token });
    assert.ok(before.reason);
    if (replaceRoot) {
      assert.throws(() => f.cmd('control-removal', { token: r.token, action: 'rebind' }));
      assert.equal(fs.existsSync(f.original), false);
      assert.equal(
        fs.readFileSync(path.join(f.bin + '.original', 'folder', 'one', 'video.mp4'), 'utf8'),
        'synthetic bytes'
      );
      return;
    }
    assert.ok(f.query('removal-status', { token: r.token }).rebindRequired);
    f.cmd('control-removal', { token: r.token, action: 'rebind' });
    const plan = f.cmd('preview-restore', { token: r.token });
    assert.equal(plan.reason, '');
    f.cmd('restore-removal', { token: plan.token });
    await until(
      () => f.query('removal-status', { token: plan.token }),
      (p) => p.state === 'done'
    );
    assert.equal(fs.readFileSync(f.original, 'utf8'), 'synthetic bytes');
  });

test('cancel releases untouched works, reconciles the old-mount in-flight receipt and keeps its restore action', async (t) => {
  let interrupt = true;
  const f = fixture(t, (stage) => {
    if (interrupt && stage === 'afterRemovalMove') {
      interrupt = false;
      throw Error('interrupt');
    }
  });
  const another = path.join(path.dirname(f.original), 'different.mp4');
  fs.writeFileSync(another, 'synthetic bytes');
  const s = fs.statSync(another, { bigint: true });
  f.library.write((db) => {
    db.exec(
      "INSERT INTO works VALUES('22','second','{}'); INSERT INTO media_files SELECT '22:video','22','folder/one/different.mp4',size,sha256 FROM media_files WHERE work_id='11';INSERT INTO archive_assets VALUES('22:video','video','video','video/mp4',1);INSERT INTO archive_homes SELECT '22',body FROM archive_homes WHERE work_id='11'"
    );
    db.prepare("INSERT INTO file_commits VALUES('second','22','22:video','registered',?,1)").run(
      JSON.stringify({
        ...f.proof,
        identity: { dev: String(s.dev), ino: String(s.ino) },
        mtimeNs: String(s.mtimeNs)
      })
    );
  });
  await verifyTestRecycle(f);
  const { scope, revision } = f.query('list-works', { source: 'all' });
  const r = f.cmd('preview-removal', {
    scope: 'files',
    selection: { scope, revision, all: true, ids: [], source: 'all' }
  });
  f.cmd('confirm-removal', { token: r.token });
  const status = () => f.query('removal-status', { token: r.token });
  await until(status, (v) => v.state === 'paused');
  assert.equal(fs.existsSync(f.original), false);
  f.library.write((db) => {
    const b = JSON.parse(db.prepare('SELECT body FROM removal_batches WHERE token=?').get(r.token).body);
    b.binding.boot = 'old-boot';
    b.binding.media.mount = 'old-mount';
    db.prepare('UPDATE removal_batches SET body=? WHERE token=?').run(JSON.stringify(b), r.token);
    db.exec("UPDATE trash_probe SET body=json_set(body,'$.binding.boot','old-boot')");
    const row = db
        .prepare('SELECT ordinal,body FROM removal_items WHERE token=? AND work_id=?')
        .get(r.token, '11'),
      i = JSON.parse(row.body);
    for (const dirs of Object.values(i.attempt)) for (const d of dirs) d.mount = 'old-mount';
    db.prepare('UPDATE removal_items SET body=? WHERE token=? AND ordinal=?').run(
      JSON.stringify(i),
      r.token,
      row.ordinal
    );
  });
  f.cmd('control-removal', { token: r.token, action: 'cancel' });
  const paused = await until(status, (v) => v.state === 'paused' && v.cancelling);
  assert.equal(paused.cancelled, 1);
  const { removalOwnsFiles } = await import('../../server/removal.mjs');
  assert(!removalOwnsFiles(f.store.db, '22'));
  assert(removalOwnsFiles(f.store.db, '11'));
  assert.equal(fs.readFileSync(another, 'utf8'), 'synthetic bytes');
  await verifyTestRecycle(f);
  f.cmd('control-removal', { token: r.token, action: 'rebind' });
  f.cmd('control-removal', { token: r.token, action: 'resume' });
  const end = await until(status, (v) => v.state === 'cancelled');
  assert.equal(end.restorable, 1);
  assert.equal(f.store.resources('11').length, 0);
  assert.equal(f.store.resources('22').length, 1);
  const plan = f.cmd('preview-restore', { token: r.token });
  assert.equal(plan.files, 1);
  f.cmd('restore-removal', { token: plan.token });
  await until(
    () => f.query('removal-status', { token: plan.token }),
    (v) => v.state === 'done'
  );
  assert.equal(fs.readFileSync(f.original, 'utf8'), 'synthetic bytes');
});

test('a persisted move intent can be cancelled using the verified intact original when the bin is gone', async (t) => {
  const f = fixture(t, (stage) => {
    if (stage === 'afterRemovalMove') throw Error('response lost');
  });
  await verifyTestRecycle(f);
  const r = f.preview('files');
  f.cmd('confirm-removal', { token: r.token });
  const status = () => f.query('removal-status', { token: r.token });
  await until(status, (p) => p.state === 'paused');
  fs.renameSync(path.join(f.bin, 'folder', 'one', 'video.mp4'), f.original);
  fs.renameSync(f.bin, f.bin + '.offline');
  f.cmd('control-removal', { token: r.token, action: 'cancel' });
  const result = await until(status, (p) => p.state !== 'running');
  assert.equal(result.state, 'cancelled');
  assert.equal(result.cancelled, 1);
  assert.equal(result.restorable, 0);
  assert.equal(f.store.resources('11').length, 1);
  assert.equal(fs.readFileSync(f.original, 'utf8'), 'synthetic bytes');
});

// Frozen legacy payload shape from e23c690. These rows have no filesystem ID,
// protocol, per-item intent, receipt directory chain or new-format verification.
function seedV14Receipt(f, { state = 'done', oldBoot = false, moved = true } = {}) {
  const adapter = createTrashAdapter({ layout: f.layout, bin: f.bin }),
    runtime = adapter.binding();
  adapter.close();
  const root = ({ path, dev, ino, mount }) => ({ path, dev, ino, mount });
  const binding = {
    method: 'mirror-exclusive-rename-v1',
    media: root(runtime.media),
    recycle: root(runtime.recycle),
    service: runtime.service,
    boot: oldBoot ? 'historical-linux-boot' : runtime.boot
  };
  const token = randomUUID(),
    asset = f.store.resources('11')[0];
  if (moved) {
    const dest = path.join(f.bin, asset.relative_path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(f.original, dest);
  }
  f.library.write((db) => {
    const parent = JSON.parse(db.prepare('SELECT body FROM archive_homes').get().body).identity;
    const body = {
      count: 1,
      files: 1,
      relations: 3,
      source: 'all',
      sourceUid: null,
      binding,
      reason: '',
      boot: randomUUID(),
      generation: 1
    };
    db.prepare('INSERT INTO removal_batches VALUES(?,?,?,?,?,?,?)').run(
      token,
      'test',
      'files',
      7,
      state,
      Date.now(),
      JSON.stringify(body)
    );
    db.prepare('INSERT INTO removal_items VALUES(?,?,?,?,?)').run(
      token,
      0,
      '11',
      state === 'done' ? 'done' : 'ready',
      JSON.stringify({
        title: 'sample',
        file: { ...asset, identity: f.proof.identity, mtimeNs: f.proof.mtimeNs, parent }
      })
    );
    db.prepare('INSERT INTO trash_probe VALUES(1,?)').run(
      JSON.stringify({
        token: randomUUID(),
        account: 'test',
        phase: 'verified',
        binding,
        relative_path: 'old-test/sample.txt',
        reference: 'historical',
        retention: 'test'
      })
    );
    if (state === 'done') db.exec('DELETE FROM archive_assets;DELETE FROM media_files');
  });
  return token;
}
for (const state of ['done', 'paused'])
  test(
    'fresh probe explicitly upgrades actual e23c690 ' + state + ' receipt on the original mount',
    async (t) => {
      const f = fixture(t),
        token = seedV14Receipt(f, { state });
      assert.throws(() => f.cmd('control-removal', { token, action: 'rebind' }));
      await verifyTestRecycle(f);
      f.cmd('control-removal', { token, action: 'rebind' });
      if (state === 'paused') {
        f.cmd('control-removal', { token, action: 'resume' });
        await until(
          () => f.query('removal-status', { token }),
          (s) => s.state === 'done'
        );
      }
      const r = f.cmd('preview-restore', { token });
      assert.equal(r.reason, '');
      f.cmd('restore-removal', { token: r.token });
      await until(
        () => f.query('removal-status', { token: r.token }),
        (s) => s.state === 'done'
      );
      assert.equal(fs.readFileSync(f.original, 'utf8'), 'synthetic bytes');
    }
  );
test('legacy proof with replaced recycle root cannot be upgraded', async (t) => {
  const f = fixture(t),
    token = seedV14Receipt(f);
  fs.renameSync(f.bin, f.bin + '-original');
  fs.mkdirSync(f.bin);
  await verifyTestRecycle(f);
  assert.throws(() => f.cmd('control-removal', { token, action: 'rebind' }));
  assert.equal(fs.existsSync(f.original), false);
});
for (const state of ['done', 'paused'])
  test(
    'old-boot legacy ' + state + ' receipt reconciles only the exact manually restored original',
    async (t) => {
      const f = fixture(t),
        token = seedV14Receipt(f, { state, oldBoot: true });
      await verifyTestRecycle(f);
      assert.throws(() => f.cmd('control-removal', { token, action: 'rebind' }));
      const recycled = path.join(f.bin, 'folder', 'one', 'video.mp4');
      fs.copyFileSync(recycled, f.original);
      const manual = () => f.cmd('control-removal', { token, action: 'manual', ordinal: 0, restored: true });
      const status = () => f.query('removal-status', { token });
      manual();
      await until(status, (s) => s.state !== 'checking');
      assert.equal(status().state, state);
      assert.equal(f.store.resources('11').length, state === 'done' ? 0 : 1);
      fs.renameSync(f.original, f.original + '.unknown');
      fs.renameSync(recycled, f.original);
      manual();
      await until(status, (s) => s.state === (state === 'done' ? 'restored' : 'cancelled'));
      assert.equal(f.store.resources('11').length, 1);
      assert.equal(fs.readFileSync(f.original + '.unknown', 'utf8'), 'synthetic bytes');
    }
  );

test('legacy partially restored batch reconciles its in-flight restore item and parent receipt', async (t) => {
  const f = fixture(t),
    parent = seedV14Receipt(f, { oldBoot: true }),
    token = randomUUID();
  f.library.write((db) => {
    const old = JSON.parse(db.prepare('SELECT body FROM removal_batches WHERE token=?').get(parent).body);
    db.prepare("UPDATE removal_batches SET state='restoring' WHERE token=?").run(parent);
    db.prepare("INSERT INTO removal_batches VALUES(?,?,'restore-files',7,'paused',?,?)").run(
      token,
      'test',
      Date.now(),
      JSON.stringify({ ...old, parent, priorState: 'done' })
    );
    db.prepare(
      "INSERT INTO removal_items SELECT ?,ordinal,work_id,'ready',body FROM removal_items WHERE token=?"
    ).run(token, parent);
  });
  fs.renameSync(path.join(f.bin, 'folder', 'one', 'video.mp4'), f.original);
  f.cmd('control-removal', { token, action: 'manual', ordinal: 0, restored: true });
  await until(
    () => f.query('removal-status', { token }),
    (s) => s.state === 'done'
  );
  assert.equal(f.query('removal-status', { token: parent }).state, 'restored');
  assert.equal(f.store.resources('11').length, 1);
});

test('adapter replays an already moved item and verifies the canonical paths before closing their handles', async t=>{
  const f=fixture(t),adapter=createTrashAdapter({layout:f.layout,bin:f.bin});
  t.after(()=>adapter.close());
  const binding=adapter.binding(),parent=JSON.parse(f.store.db.prepare('SELECT body FROM archive_homes').get().body).identity;
  const file={relative_path:'folder/one/video.mp4',parent,...f.proof};
  for(const method of ['trash','restore']){
    const moved=await adapter[method](file,binding);
    const resumed=await adapter[method](file,binding,{paths:moved.paths});
    assert.deepEqual(resumed,moved);
    adapter.assertObserved(file,binding,resumed);
  }
  assert.equal(fs.readFileSync(f.original,'utf8'),'synthetic bytes');
});
