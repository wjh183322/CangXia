import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createDownloads } from '../src/downloads.mjs';
import { assertResourceCurrent, planDestination, reconcileWork, recoverFileCommits, resolveResource, withWorkFiles } from '../src/files.mjs';
import { makeSandbox } from './helpers.mjs';
import { openProbeStore } from '../src/store.mjs';
import { parseSourcePage } from '../src/page-parser.mjs';

const id = '7650000000000000001';
const sourceURL = 'https://p3.douyinpic.com/picture/token';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const record = { aweme_id: id, desc: '原名😀', author: { uid: '42', nickname: '作者' }, images: [{ origin_image: { uri: 'pic-1', url_list: [sourceURL] } }] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);

async function fixture(t, testHooks) {
  const sandbox = await makeSandbox(t);
  const layout = await sandbox.prepare();
  const open = (initialize, hooks) => {
    const store = openProbeStore({ file: path.join(layout.state, 'fixture.sqlite'), libraryId: sandbox.config.libraryId,
      initialize, testHooks: hooks });
    sandbox.onCleanup(() => store.close());
    return store;
  };
  const store = open(true, testHooks);
  const source = { kind: 'total', id: '__all__' };
  const job = store.createReadJob({ source, authEpoch: 3 });
  const page = parseSourcePage({ source, inputCursor: '0', status: 200, observedAt: '2026-11-20T00:00:00Z',
    text: JSON.stringify({ has_more: 0, aweme_list: [record] }) });
  store.commitPage({ jobId: job.id, epoch: 1, authEpoch: 3, operationId: 'seed', page }, () => {});
  store.db.prepare('INSERT INTO runtime_meta VALUES (?,?)').run('browser_auth', '{"uid":"1234","authEpoch":3}');
  let requests = 0;
  const downloadsFor = owner => createDownloads({ store: owner, layout,
    gateway: { assertAuthEpoch(epoch) { assert.equal(epoch, 3); }, async mediaHeaders() { return new Headers(); } },
    fetchAsset() {
      requests++;
      return new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) } });
    }
  });
  const downloads = downloadsFor(store);
  const [download] = downloads.enqueue({ workIds: [id], operationId: 'download' });
  return { sandbox, layout, store, open, downloadsFor, downloads, download, requestCount: () => requests };
}

test('DL-05 and TX-06 recover the exact placed inode using its durable file journal', async t => {
  const f = await fixture(t);
  f.store.close();
  const child = [
    'import path from "node:path";',
    'import { openProbeStore } from ' + JSON.stringify(new URL('../src/store.mjs', import.meta.url)) + ';',
    'import { createDownloads } from ' + JSON.stringify(new URL('../src/downloads.mjs', import.meta.url)) + ';',
    'const layout = JSON.parse(process.argv[1]);',
    'const store = openProbeStore({ file: path.join(layout.state, "fixture.sqlite"), libraryId: process.argv[2],',
    '  testHooks: { afterFilePlacement({ kind }) { if (kind === "image") process.exit(61); } } });',
    'const downloads = createDownloads({ store, layout, gateway: { assertAuthEpoch() {}, async mediaHeaders() { return new Headers(); } },',
    '  fetchAsset() { return new Response(Buffer.from(process.argv[3], "base64"), { headers: { "Content-Type": "image/png" } }); } });',
    'await downloads.run();'
  ].join('\n');
  await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', child, JSON.stringify(f.layout),
    f.sandbox.config.libraryId, png.toString('base64')], { timeout: 15000 }), { code: 61 });
  const file = path.join(f.layout.media, '收藏', '原名😀-作者', '图片-001.png');
  assert.equal(hash(await readFile(file)), hash(png));
  const original = await lstat(file, { bigint: true });
  assert.equal(original.nlink, 2n);
  assert.deepEqual(await f.sandbox.prepare(), f.layout);
  const store = f.open(false);
  assert.equal(store.resources(id).length, 0);
  const recovered = await recoverFileCommits({ store, layout: f.layout });
  assert.equal(recovered.at(0).stage, 'registered');
  assert.equal((await lstat(file, { bigint: true })).ino, original.ino);
  const downloads = f.downloadsFor(store);
  await downloads.run();
  assert.equal(downloads.snapshot().jobs[0].state, 'complete');
  assert.equal(f.requestCount(), 0);
});

test('DL-05 a different inode, even with the same contents, is never adopted or overwritten', async t => {
  let placement;
  const f = await fixture(t, { afterFilePlacement(value) {
    if (value.kind === 'image') { placement = value; throw Error('fixture termination point'); }
  } });
  await f.downloads.run();
  await rename(placement.file, placement.file + '.old');
  await writeFile(placement.file, png, { flag: 'wx' });
  const foreign = await lstat(placement.file);
  f.store.close();
  const store = f.open(false);
  await assert.rejects(recoverFileCommits({ store, layout: f.layout }), { code: 'PROBE_FILE_REVIEW' });
  assert.equal(store.resources(id).length, 0);
  assert.equal((await lstat(placement.file)).ino, foreign.ino);
  assert.deepEqual(await readFile(placement.file + '.old'), png);
});

test('overlapping recovery keeps one registered commit and one visible resource', async t => {
  const f = await fixture(t, { afterFilePlacement({ kind }) {
    if (kind === 'image') throw Error('fixture termination point');
  } });
  await f.downloads.run();
  f.store.close();
  const store = f.open(false);
  assert.equal(store.resources(id).length, 0);

  const { promise: release, resolve: unlock } = Promise.withResolvers();
  const holding = withWorkFiles(f.layout, id, () => release);
  const { promise: bothScan, resolve: scanned } = Promise.withResolvers();
  const fileCommits = store.fileCommits.bind(store);
  let scans = 0;
  store.fileCommits = workId => {
    const rows = fileCommits(workId);
    if (workId === id && ++scans === 2) scanned();
    return rows;
  };
  const recover = () => recoverFileCommits({ store, layout: f.layout, workId: id });
  const recoveries = Promise.all([recover(), recover()]);
  await Promise.race([bothScan, recoveries]).finally(unlock);
  await holding;
  const [first, second] = await recoveries;
  const committed = [...first, ...second];
  assert.deepEqual(committed.map(row => row.stage), ['registered']);
  assert.equal(store.resources(id).length, 1);
  const asset = await resolveResource({ store, layout: f.layout, workId: id, key: 'image-0' });
  assert.deepEqual(await readFile(asset.file), png);
});

test('TX-05 injected ENOSPC during the JSON leaves registered media complete and finalization retryable', async t => {
  const f = await fixture(t, { beforeFileWrite({ kind }) {
    if (kind === 'metadata') throw Object.assign(Error('fixture disk full'), { code: 'ENOSPC' });
  } });
  await f.downloads.run();
  const [job] = f.downloads.snapshot().jobs;
  assert.equal(job.filesComplete, true);
  assert.equal(job.finalizationPending, true);
  assert.equal(job.reason.code, 'ENOSPC');
  assert.equal(f.store.resources(id).length, 1);
  assert.equal((await reconcileWork({ store: f.store, workId: id, layout: f.layout })).errors[0].code, 'ENOSPC');
  f.store.close();
  const store = f.open(false);
  const downloads = f.downloadsFor(store);
  downloads.resume(f.download.id, 'retry');
  await downloads.run();
  assert.equal(downloads.snapshot().jobs[0].state, 'complete');
  assert.equal(f.requestCount(), 1);
});

test('DL-07 destination preserves author homes, Chinese names and ownership; rename recovers before DB commit', async t => {
  const work = { id, name: '冲突 / 标题', author: { nickname: '合作作者' } };
  const total = { kind: 'total', id: '__all__', name: '收藏' };
  const home = planDestination({ work, source: total, owners: new Map([['收藏/冲突 _ 标题-合作作者', new Set([otherId()])]]) });
  assert.deepEqual(home, { kind: 'collection', id: '__all__', folder: '收藏', workFolder: '冲突 _ 标题-合作作者-' + id });
  const source = { kind: 'author', id: 'MS4wLjABabcdefgh', name: '独立创作者' };
  const archived = planDestination({ work, source, owners: new Map() });
  assert.match(archived.folder, /^作者作品\/独立创作者-[a-f\d]{10}$/);
  assert.deepEqual(planDestination({ work, source: total, existingHome: archived }), archived);
  let interrupted = false;
  const f = await fixture(t, { afterFilePlacement({ kind }) {
    if (kind === 'move') { interrupted = true; throw Error('fixture termination point'); }
  } });
  await f.downloads.run();
  const asset = await resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'image-0' });
  await writeFile(path.join(path.dirname(asset.file), '未知旧文件.txt'), 'own content');
  f.store.db.prepare("UPDATE records SET body=json_set(body,'$.name',?) WHERE kind='works' AND id=?").run('改名😀', id);
  const result = await reconcileWork({ store: f.store, workId: id, layout: f.layout });
  assert.equal(result.pending, true);
  assert.equal(interrupted, true);
  f.store.close();
  const store = f.open(false);
  assert.equal((await recoverFileCommits({ store, layout: f.layout })).at(0).stage, 'registered');
  assert.deepEqual(await reconcileWork({ store, workId: id, layout: f.layout }), { ok: true, pending: false, errors: [] });
  const moved = await resolveResource({ store, layout: f.layout, workId: id, key: 'image-0' });
  assert.match(moved.file, /改名😀-作者/);
  assert.equal(await readFile(path.join(path.dirname(moved.file), '未知旧文件.txt'), 'utf8'), 'own content');
  const metadata = JSON.parse(await readFile(path.join(path.dirname(moved.file), '作品信息.json'), 'utf8'));
  assert.equal(metadata.workName, '改名😀');
});

function otherId() { return '7650000000000000002'; }

test('the startup hardlink exception is confined to only two managed names and requires a journal token', async t => {
  const f = await fixture(t);
  const external = await makeSandbox(t);
  const workDir = path.join(f.layout.media, '收藏', '比对');
  await mkdir(workDir, { recursive: true });
  const formal = path.join(workDir, '单图.png');
  await writeFile(formal, png);
  const tokenDir = path.join(f.layout.staging, 'commits', randomUUID());
  await mkdir(tokenDir, { recursive: true });
  const staged = path.join(tokenDir, 'payload.png');
  await link(formal, staged);
  assert.deepEqual(await f.sandbox.prepare(), f.layout);
  await assert.rejects(recoverFileCommits({ store: f.store, layout: f.layout }), { code: 'PROBE_FILE_REVIEW' });
  await link(formal, path.join(external.root, 'extra-link.png'));
  await assert.rejects(f.sandbox.prepare(), { code: 'UNSAFE_DATA_ROOT' });

  const distinct = await fixture(t);
  const unowned = path.join(distinct.layout.reports, 'original.png');
  await writeFile(unowned, png);
  await link(unowned, path.join(external.root, 'independent-link.png'));
  await assert.rejects(distinct.sandbox.prepare(), { code: 'UNSAFE_DATA_ROOT' });

  const outside = await fixture(t);
  const original = path.join(outside.layout.media, '收藏', '比对');
  await mkdir(original, { recursive: true });
  const media = path.join(original, 'single.png');
  await writeFile(media, png);
  await link(media, path.join(external.root, 'outside-link.png'));
  await assert.rejects(outside.sandbox.prepare(), { code: 'UNSAFE_DATA_ROOT' });
});

test('an unknown formal filename is preserved and same-length external mutation is fenced', async t => {
  const f = await fixture(t, { beforeFileWrite({ kind }) {
    if (kind === 'image') {
      writeFileSync(candidate, 'unregistered', { flag: 'wx' });
    }
  } });
  const candidate = path.join(f.layout.media, '收藏', '原名😀-作者', '图片-001.png');
  await f.downloads.run();
  assert.equal(f.downloads.snapshot().jobs[0].state, 'complete');
  assert.equal(await readFile(candidate, 'utf8'), 'unregistered');
  const asset = await resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'image-0' });
  assert.match(asset.file, /图片-001-补存\.png$/);
  const changed = Buffer.from(png);
  changed[40] ^= 1;
  await writeFile(asset.file, changed);
  await assert.rejects(resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'image-0' }), { code: 'PROBE_FILE_REVIEW' });
});

test('a target directory appearing after the last precheck is never replaced', async t => {
  let target;
  let inode;
  const f = await fixture(t, { beforeFileMove({ file }) {
    if (target) return;
    target = file;
    mkdirSync(file);
    inode = lstatSync(file, { bigint: true }).ino;
  } });
  await f.downloads.run();
  const asset = await resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'image-0' });
  const sourceDirectory = path.dirname(asset.file);
  const sourceInode = (await lstat(sourceDirectory, { bigint: true })).ino;
  f.store.db.prepare("UPDATE records SET body=json_set(body,'$.name',?) WHERE kind='works' AND id=?").run('竞争', id);
  const result = await reconcileWork({ store: f.store, layout: f.layout, workId: id });
  assert.equal(result.pending, true);
  assert.equal(result.errors[0].code, 'PROBE_FILE_REVIEW');
  assert.equal((await lstat(target, { bigint: true })).ino, inode);
  assert.equal((await lstat(sourceDirectory, { bigint: true })).ino, sourceInode);
  assert.deepEqual(await readdir(target), []);
  assert.deepEqual(await readFile(asset.file), png);
});

test('a missing registered asset can be explicitly repaired without changing other media', async t => {
  const f = await fixture(t);
  await f.downloads.run();
  const asset = await resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'image-0' });
  const old = asset.file + '.unattached';
  await rename(asset.file, old);
  await assert.rejects(resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'image-0' }), { code: 'PROBE_FILE_MISSING' });
  f.downloads.enqueue({ workIds: [id], operationId: 'repair' });
  await f.downloads.run();
  assert.equal(f.downloads.snapshot().jobs[0].state, 'complete');
  const repaired = await resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'image-0' });
  assert.equal(repaired.file, asset.file);
  assert.notDeepEqual(repaired.identity, asset.identity);
  assert.deepEqual(await readFile(old), png);
  assert.equal(f.requestCount(), 2);
});

test('a queued job paused while waiting for the work lock stays paused', async t => {
  const selected = Promise.withResolvers();
  const release = Promise.withResolvers();
  const holderReady = Promise.withResolvers();
  const f = await fixture(t, { beforeDownloadWorkLock() { selected.resolve(); } });
  const holder = withWorkFiles(f.layout, id, () => { holderReady.resolve(); return release.promise; });
  await holderReady.promise;
  const running = f.downloads.run();
  await selected.promise;
  try {
    assert.equal(f.downloads.pause(f.download.id, 'pause').state, 'paused');
  } finally { release.resolve(); }
  await holder;
  await running;
  assert.equal(f.downloads.snapshot().jobs[0].state, 'paused');
  assert.equal(f.requestCount(), 0);
});

for (const change of ['in-place edit', 'new inode']) {
  test('metadata update preserves a raced external ' + change, async t => {
    let armed = false;
    let displaced;
    const edited = Buffer.from('external version must survive');
    const f = await fixture(t, { beforeMetadataExchange({ file, displaced: backup }) {
      if (!armed) return;
      armed = false;
      displaced = backup;
      if (change === 'new inode') renameSync(file, file + '.external');
      writeFileSync(file, edited, change === 'new inode' ? { flag: 'wx' } : undefined);
    } });
    await f.downloads.run();
    const { file } = await resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'metadata' });
    const oldBytes = await readFile(file);
    f.store.db.prepare("UPDATE records SET body=json_set(body,'$.caption',?) WHERE kind='works' AND id=?").run('说明变化', id);
    armed = true;
    const result = await reconcileWork({ store: f.store, layout: f.layout, workId: id });
    assert.equal(result.errors[0]?.code, 'PROBE_FILE_REVIEW');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).caption, '说明变化');
    assert.deepEqual(await readFile(displaced), edited);
    if (change === 'new inode') assert.deepEqual(await readFile(file + '.external'), oldBytes);
    assert.equal(f.store.resources(id).find(row => row.key === 'metadata').sha256, hash(oldBytes));
  });
}

test('metadata is always present at the swap interruption and recovery retains both inodes', async t => {
  const f = await fixture(t);
  await f.downloads.run();
  const { file } = await resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'metadata' });
  const oldBytes = await readFile(file);
  const oldInode = (await lstat(file, { bigint: true })).ino;
  f.store.db.prepare("UPDATE records SET body=json_set(body,'$.caption',?) WHERE kind='works' AND id=?").run('恢复说明', id);
  f.store.close();
  const child = [
    'import path from "node:path";',
    'import { lstatSync } from "node:fs";',
    'import { openProbeStore } from ' + JSON.stringify(new URL('../src/store.mjs', import.meta.url)) + ';',
    'import { reconcileWork } from ' + JSON.stringify(new URL('../src/files.mjs', import.meta.url)) + ';',
    'const layout = JSON.parse(process.argv[1]);',
    'const store = openProbeStore({ file: path.join(layout.state, "fixture.sqlite"), libraryId: process.argv[2],',
    '  testHooks: { afterMetadataExchange({ file, displaced }) {',
    '    if (lstatSync(file, { bigint: true }).ino === lstatSync(displaced, { bigint: true }).ino) process.exit(62);',
    '    process.exit(63);',
    '  } } });',
    'await reconcileWork({ store, layout, workId: process.argv[3] });'
  ].join('\n');
  await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', child, JSON.stringify(f.layout),
    f.sandbox.config.libraryId, id], { timeout: 15000 }), { code: 63 });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).caption, '恢复说明');
  const atInterruption = (await lstat(file, { bigint: true })).ino;
  const newBytes = await readFile(file);
  assert.deepEqual(await f.sandbox.prepare(), f.layout);
  const reopened = f.open(false);
  const stage = reopened.fileCommits(id).at(-1);
  assert.equal(stage.stage, 'swapping');
  assert.equal(reopened.resources(id).find(row => row.key === 'metadata').sha256, hash(oldBytes));
  const displaced = path.join(f.layout.staging, 'commits', stage.id,
    process.platform === 'win32' ? 'displaced.json' : 'payload.json');
  assert.deepEqual(await readFile(displaced), oldBytes);
  assert.equal((await lstat(displaced, { bigint: true })).ino, oldInode);
  assert.equal((await recoverFileCommits({ store: reopened, layout: f.layout })).at(0)?.stage, 'registered');
  const updated = await resolveResource({ store: reopened, layout: f.layout, workId: id, key: 'metadata', verify: true });
  assert.equal(JSON.parse(await readFile(updated.file, 'utf8')).caption, '恢复说明');
  assert.equal((await lstat(updated.file, { bigint: true })).ino, atInterruption);
  assert.deepEqual(await readFile(updated.file), newBytes);
  assert.deepEqual(await readFile(displaced), oldBytes);
  assert.deepEqual(await recoverFileCommits({ store: reopened, layout: f.layout }), []);
});

test('the probe restores a verified old escrow left by an earlier build before starting its atomic swap', async t => {
  let switched = false;
  const f = await fixture(t, { beforeMetadataExchange({ file }) {
    switched = true;
    const stage = f.store.fileCommits(id).at(-1);
    const backup = path.join(f.layout.staging, 'commits', stage.id, 'displaced.json');
    renameSync(file, backup);
    f.store.db.prepare("UPDATE file_commits SET stage='escrowing' WHERE id=?").run(stage.id);
    throw Error('fixture represents a prior build stopped after the old file moved');
  } });
  await f.downloads.run();
  const { file } = await resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'metadata' });
  f.store.db.prepare("UPDATE records SET body=json_set(body,'$.caption',?) WHERE kind='works' AND id=?").run('旧阶段恢复', id);
  assert.equal((await reconcileWork({ store: f.store, layout: f.layout, workId: id })).pending, true);
  assert.equal(switched, true);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  f.store.close();
  const reopened = f.open(false);
  assert.equal((await recoverFileCommits({ store: reopened, layout: f.layout })).at(0)?.stage, 'registered');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).caption, '旧阶段恢复');
});

test('the displaced original, exchanged candidate and newer canonical file survive a publication conflict', async t => {
  let displaced;
  const external = 'someone else replaced the canonical JSON';
  const f = await fixture(t, { afterMetadataExchange({ file, displaced: backup }) {
    displaced = backup;
    renameSync(file, file + '.published');
    writeFileSync(file, external, { flag: 'wx' });
  } });
  await f.downloads.run();
  const { file } = await resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'metadata' });
  const oldBytes = await readFile(file);
  f.store.db.prepare("UPDATE records SET body=json_set(body,'$.caption',?) WHERE kind='works' AND id=?").run('新说明', id);
  assert.equal((await reconcileWork({ store: f.store, layout: f.layout, workId: id })).pending, true);
  assert.equal(await readFile(file, 'utf8'), external);
  assert.deepEqual(await readFile(displaced), oldBytes);
  assert.equal(JSON.parse(await readFile(file + '.published', 'utf8')).caption, '新说明');
  assert.equal(f.store.fileCommits(id).at(-1).stage, 'review');
  f.store.close();
  const reopened = f.open(false);
  assert.deepEqual(await recoverFileCommits({ store: reopened, layout: f.layout }), []);
  assert.equal(await readFile(file, 'utf8'), external);
  assert.deepEqual(await readFile(displaced), oldBytes);
});

test('a late file-scope tombstone prevents a resource from being returned after verification', async t => {
  let armed = false;
  const f = await fixture(t, { beforeResourceVerify() {
    if (!armed) return;
    f.store.db.prepare("INSERT INTO scope_state VALUES (?,'files','',1,1,1)").run(id);
  } });
  await f.downloads.run();
  armed = true;
  assert.equal(await resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'image-0', verify: true }), null);
});

test('the opened file must still match its current registry entry and scope before it can be read', async t => {
  let armed = false;
  const f = await fixture(t, { beforeResourceVerify() {
    if (armed) f.store.db.prepare("UPDATE resources SET revision=revision+1 WHERE work_id=? AND key='image-0'").run(id);
  } });
  await f.downloads.run();
  const parameters = { store: f.store, layout: f.layout, workId: id, key: 'image-0' };
  const original = await resolveResource(parameters);
  const handle = await open(original.file, 'r');
  try {
    const stat = await handle.stat({ bigint: true });
    assert.doesNotThrow(() => assertResourceCurrent({ store: f.store, resource: original, stat }));
    armed = true;
    await assert.rejects(resolveResource({ ...parameters, verify: true }), { code: 'PROBE_FILE_REVIEW' });
    assert.throws(() => assertResourceCurrent({ store: f.store, resource: original, stat }), { code: 'PROBE_FILE_REVIEW' });
    const refreshed = await resolveResource(parameters);
    assert.doesNotThrow(() => assertResourceCurrent({ store: f.store, resource: refreshed, stat }));
    f.store.db.prepare("INSERT INTO scope_state VALUES (?,'files','',1,1,1)").run(id);
    assert.throws(() => assertResourceCurrent({ store: f.store, resource: refreshed, stat }), { code: 'PROBE_FILES_PROTECTED' });
  } finally { await handle.close(); }
});

test('cancellation during finalization verification prevents a new JSON stage', async t => {
  let interrupted = false;
  const f = await fixture(t, { beforeResourceVerify({ key }) {
    if (key !== 'image-0' || interrupted) return;
    interrupted = true;
    f.downloads.cancel(f.download.id, 'cancel');
  } });
  await f.downloads.run();
  assert.equal(interrupted, true);
  assert.equal(f.downloads.snapshot().jobs[0].state, 'cancelled');
  assert.equal(f.store.fileCommits(id).some(entry => entry.body.kind === 'metadata'), false);
  assert.deepEqual(f.store.resources(id).map(row => row.key), ['image-0']);
});

test('cancellation immediately after the swap retains the present canonical JSON and settles the registration', async t => {
  let displaced;
  let presentAtCancel;
  const f = await fixture(t, { afterMetadataExchange({ file, displaced: backup }) {
    displaced = backup;
    presentAtCancel = JSON.parse(readFileSync(file, 'utf8')).caption;
    assert.equal(f.downloads.cancel(f.download.id, 'cancel-after-exchange').state, 'cancelling');
  } });
  await f.downloads.run();
  const previous = await resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'metadata' });
  const bytes = await readFile(previous.file);
  f.store.db.prepare("UPDATE records SET body=json_set(body,'$.caption',?) WHERE kind='works' AND id=?").run('已开始保存', id);
  f.downloads.enqueue({ workIds: [id], operationId: 'check-again' });
  await f.downloads.run();
  assert.equal(f.downloads.snapshot().jobs[0].state, 'cancelled');
  assert.equal(presentAtCancel, '已开始保存');
  assert.deepEqual(await readFile(displaced), bytes);
  const current = await resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'metadata', verify: true });
  assert.equal(JSON.parse(await readFile(current.file, 'utf8')).caption, '已开始保存');
});
