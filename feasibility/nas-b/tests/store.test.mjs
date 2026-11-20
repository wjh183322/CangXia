import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseSourcePage } from '../src/page-parser.mjs';
import { openProbeStore } from '../src/store.mjs';
import { makeSandbox, makeStoreFixture, sourceFixture } from './helpers.mjs';

const allow = () => {};
const total = { kind: 'total', id: '__all__' };
const collection = id => ({ kind: 'collection', id });
const author = id => ({ kind: 'author', id });
const parse = (name, fields) => parseSourcePage({ ...sourceFixture(name), ...fields });
const pageFor = (ids, { source = total, inputCursor = '0', nextCursor = null } = {}) => parse('two-works', {
  source, inputCursor,
  text: JSON.stringify({
    has_more: nextCursor !== null, cursor: nextCursor ?? '0',
    aweme_list: ids.map(id => ({ aweme_id: id, desc: 'Synthetic work ' + id }))
  })
});
const rowCount = (store, table) => store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
const hintCount = page => page.aux.audioSourceHints.reduce((count, hint) => count + hint.sources.length, 0);

function commit(store, job, operationId, page, guard = allow) {
  return store.commitPage({ jobId: job.id, epoch: job.epoch, authEpoch: job.authEpoch, operationId, page }, guard);
}

function putRecord(store, kind, id, body, revision = 0) {
  store.db.prepare('INSERT OR REPLACE INTO records(kind,id,body,revision) VALUES (?,?,?,?)')
    .run(kind, id, JSON.stringify(body), revision);
}

function protect(store, workId, kind, sourceId = '') {
  store.db.prepare('INSERT INTO scope_state(work_id,kind,source_id,generation,deleted,revision) VALUES (?,?,?,1,1,0)')
    .run(workId, kind, sourceId);
}

test('opens only an explicitly initialized probe database with the same library identity', async t => {
  const sandbox = await makeSandbox(t);
  const layout = await sandbox.prepare();
  const file = path.join(layout.state, 'library.sqlite');
  const libraryId = sandbox.config.libraryId;
  const open = (options = {}) => openProbeStore({ file, libraryId, ...options });

  assert.throws(() => open(), { code: 'PROBE_DB_MISSING' });
  assert.equal(await sandbox.exists('state/library.sqlite'), false);
  const store = open({ initialize: true });
  sandbox.onCleanup(() => store.close());
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  store.close();
  assert.throws(() => open({ initialize: true }), { code: 'PROBE_DB_EXISTS' });
  assert.throws(() => open({ libraryId: 'different-library' }), { code: 'FOREIGN_PROBE_DB' });
  const reopened = open();
  sandbox.onCleanup(() => reopened.close());
  assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('rejects a database whose effective application ID differs from its checkpointed header', async t => {
  const f = await makeStoreFixture(t);
  const expected = f.store.db.prepare('PRAGMA application_id').get().application_id;
  f.store.db.exec('PRAGMA wal_autocheckpoint=0; PRAGMA application_id=1234');
  assert.equal(readFileSync(f.file).readUInt32BE(68), expected);
  assert.equal(f.store.db.prepare('PRAGMA application_id').get().application_id, 1234);
  let recovered;
  try {
    assert.throws(() => { recovered = f.reopen(); }, { code: 'FOREIGN_PROBE_DB' });
  } finally {
    recovered?.close();
  }
  assert.equal(f.store.db.prepare('PRAGMA application_id').get().application_id, 1234);
});

test('initialization rejects a pathname replaced after exclusive creation', async t => {
  const sandbox = await makeSandbox(t);
  const { state } = await sandbox.prepare();
  const file = path.join(state, 'library.sqlite');
  const otherFile = path.join(state, 'other.sqlite');
  const other = new DatabaseSync(otherFile);
  other.exec("CREATE TABLE unrelated(id TEXT); INSERT INTO unrelated VALUES ('keep')");
  other.close();
  const foreignBytes = readFileSync(otherFile);
  const close = fs.closeSync;
  let replaced = false;
  const replacingClose = t.mock.method(fs, 'closeSync', handle => {
    close(handle);
    if (replaced) return;
    replaced = true;
    fs.renameSync(file, path.join(state, 'created.sqlite'));
    fs.renameSync(otherFile, file);
  });
  syncBuiltinESMExports();
  let opened;
  try {
    assert.throws(() => {
      opened = openProbeStore({ file, libraryId: sandbox.config.libraryId, initialize: true });
    }, { code: 'UNSAFE_PROBE_DB' });
  } finally {
    replacingClose.mock.restore();
    syncBuiltinESMExports();
    opened?.close();
  }
  assert.equal(replaced, true);
  assert.deepEqual(readFileSync(file), foreignBytes);
});

test('rejects preexisting empty, unknown, directory, hardlinked and orphan-sidecar database paths', async t => {
  const sandbox = await makeSandbox(t);
  const { state } = await sandbox.prepare();
  const libraryId = sandbox.config.libraryId;
  const probe = (name, options) => openProbeStore({ file: path.join(state, name), libraryId, ...options });
  writeFileSync(path.join(state, 'empty.sqlite'), '');
  assert.throws(() => probe('empty.sqlite'), { code: 'FOREIGN_PROBE_DB' });
  assert.throws(() => probe('empty.sqlite', { initialize: true }), { code: 'PROBE_DB_EXISTS' });

  const unknownPath = path.join(state, 'other.sqlite');
  const other = new DatabaseSync(unknownPath);
  other.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES (\'keep\')');
  other.close();
  const unknownBytes = readFileSync(unknownPath);
  assert.throws(() => probe('other.sqlite'), { code: 'FOREIGN_PROBE_DB' });
  assert.deepEqual(readFileSync(unknownPath), unknownBytes);

  mkdirSync(path.join(state, 'directory.sqlite'));
  assert.throws(() => probe('directory.sqlite'), { code: 'UNSAFE_PROBE_DB' });

  linkSync(unknownPath, path.join(state, 'linked.sqlite'));
  assert.throws(() => probe('linked.sqlite'), { code: 'UNSAFE_PROBE_DB' });
  writeFileSync(path.join(state, 'lost.sqlite-wal'), 'orphan');
  assert.throws(() => probe('lost.sqlite', { initialize: true }), { code: 'UNSAFE_PROBE_DB' });
  assert.equal(await sandbox.exists('state/lost.sqlite'), false);
});

test('refuses asynchronous write callbacks and rolls back a thenable result', async t => {
  const { store } = await makeStoreFixture(t);
  const put = db => db.prepare('INSERT INTO runtime_meta(key,value) VALUES (?,?)').run('fixture', 'true');
  let invoked = false;
  assert.throws(() => store.withWrite(async () => { invoked = true; }), { code: 'PROBE_SYNC_REQUIRED' });
  assert.equal(invoked, false);
  assert.throws(() => store.withWrite(db => { put(db); return Promise.resolve(); }), { code: 'PROBE_SYNC_REQUIRED' });
  assert.equal(store.db.prepare("SELECT 1 FROM runtime_meta WHERE key='fixture'").get(), undefined);
  assert.equal(store.withWrite(put).changes, 1);
});

test('rolled back page leaves the previous head, records, relationships, auxiliary data and receipts after reopen', async t => {
  let fail = false;
  const f = await makeStoreFixture(t, { testHooks: { afterWorkWrite: () => {
    if (fail) throw Error('injected');
  } } });
  const first = parse('unsafe-integer');
  const old = f.store.commitPage(f.command(first), allow);
  const head = f.store.readHead(total);
  const before = f.store.readJob(f.job.id);
  const second = parse('media', { inputCursor: first.nextCursor });
  fail = true;
  let writes = 0;
  const secondCommand = { ...f.command(second), operationId: 'second-page' };
  assert.throws(() => f.store.commitPage(secondCommand, () => {
    assert.equal(f.store.db.isTransaction, true);
    writes++;
  }), /injected/);
  assert.equal(writes, 1);
  f.store.close();

  const db = f.reopen();
  assert.equal(db.work(second.works[0].id), null);
  assert.deepEqual(db.readJob(f.job.id), before);
  assert.deepEqual(db.readHead(total), head);
  assert.deepEqual(db.operation(f.opId), old);
  assert.equal(db.operation('second-page'), null);
  assert.equal(rowCount(db, 'read_pages'), 1);
  assert.equal(rowCount(db, 'work_refs'), 1);
  assert.equal(rowCount(db, 'audio_source_hints'), hintCount(first));
  assert.equal(rowCount(db, 'creator_profiles'), first.aux.creatorProfiles.length);
  assert.equal(db.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('lost confirmation after commit resolves from the same complete page after reopening', async t => {
  let returned = 0;
  const f = await makeStoreFixture(t, { testHooks: { afterPageCommit: () => {
    returned++;
    throw Error('lost confirmation');
  } } });
  const page = parse('media');
  const command = f.command(page);
  assert.throws(() => f.store.commitPage(command, allow), /lost confirmation/);
  assert.equal(returned, 1);
  f.store.close();
  const store = f.reopen();

  const receipt = store.operation(f.opId);
  assert.equal(receipt.operationId, f.opId);
  assert.equal(receipt.kind, 'page');
  assert.equal(receipt.jobId, f.job.id);
  assert.equal(receipt.epoch, f.job.epoch);
  assert.equal(receipt.authEpoch, f.job.authEpoch);
  assert.equal(receipt.nextCursor, null);
  assert.equal(receipt.savedPages, 1);
  assert.equal(receipt.savedReceived, page.receivedCount);
  assert.equal(receipt.savedUnique, page.uniqueCount);
  assert.equal(store.readJob(f.job.id).cursor, null);
  assert.equal(store.readJob(f.job.id).finalizationPending, true);
  assert.equal(store.readHead(total).revision, receipt.revision);
  assert.deepEqual(store.work(page.works[0].id), page.works[0]);
  assert.equal(rowCount(store, 'work_refs'), page.refs.length);
  assert.equal(rowCount(store, 'creator_profiles'), page.aux.creatorProfiles.length);
  assert.equal(rowCount(store, 'audio_source_hints'), hintCount(page));
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  let replayGuarded = false;
  assert.deepEqual(store.commitPage(command, ({ inputCursor, replay }) => {
    replayGuarded = store.db.isTransaction && replay && inputCursor === null;
  }), receipt);
  assert.equal(replayGuarded, true);
  assert.equal(rowCount(store, 'operations'), 1);
});

test('a process exiting between row writes leaves the last complete page after restart', async t => {
  const f = await makeStoreFixture(t);
  const first = f.store.commitPage(f.command(parse('unsafe-integer')), allow);
  f.store.close();
  const storeUrl = new URL('../src/store.mjs', import.meta.url).href;
  const parserUrl = new URL('../src/page-parser.mjs', import.meta.url).href;
  const helpersUrl = new URL('./helpers.mjs', import.meta.url).href;
  const script = `
    import { openProbeStore } from ${JSON.stringify(storeUrl)};
    import { parseSourcePage } from ${JSON.stringify(parserUrl)};
    import { sourceFixture } from ${JSON.stringify(helpersUrl)};
    const [file, libraryId, jobId, cursor] = process.argv.slice(1);
    const store = openProbeStore({ file, libraryId, testHooks: { afterWorkWrite: () => process.exit(73) } });
    const { epoch, authEpoch } = store.readJob(jobId);
    const page = parseSourcePage({ ...sourceFixture('media'), inputCursor: cursor });
    store.commitPage({ jobId, epoch, authEpoch, operationId: 'interrupted-op', page }, () => {});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script,
    f.file, f.libraryId, f.job.id, first.nextCursor], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 73, child.error?.message ?? child.stderr);
  const store = f.reopen();
  assert.deepEqual(store.operation(f.opId), first);
  assert.equal(store.operation('interrupted-op'), null);
  assert.equal(store.readJob(f.job.id).cursor, first.nextCursor);
  assert.equal(store.work('101'), null);
  assert.equal(store.work('102'), null);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('a failed cursor write rolls back auxiliary rows, relationships and the operation receipt', async t => {
  const f = await makeStoreFixture(t);
  f.store.db.exec(`
    CREATE TEMP TRIGGER fail_cursor BEFORE UPDATE OF cursor ON source_jobs BEGIN
      SELECT RAISE(ABORT, 'fixture cursor write failure');
    END;
  `);
  assert.throws(() => f.store.commitPage(f.command(parse('media')), allow), /fixture cursor write failure/);
  f.store.close();
  const store = f.reopen();
  for (const table of ['records', 'read_pages', 'work_refs', 'read_job_works', 'creator_profiles', 'audio_source_hints', 'operations']) {
    assert.equal(rowCount(store, table), 0, table);
  }
  assert.equal(store.readHead(total), null);
  assert.equal(store.readJob(f.job.id).cursor, '0');
  assert.equal(store.db.prepare("SELECT value FROM runtime_meta WHERE key='revision'").get().value, '0');
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('retains normalized music hints until the work observes another music identity', async t => {
  const f = await makeStoreFixture(t);
  const mediaUrl = 'https://v3.douyinvod.com/fixture.mp3';
  const text = (music, nextCursor) => JSON.stringify({
    has_more: nextCursor !== null, cursor: nextCursor ?? '0',
    aweme_list: [{ aweme_id: '101', ...(music === undefined ? {} : { music }) }]
  });
  const first = parse('media', { text: text({ play_url: { url_list: [mediaUrl] } }, '1') });
  assert.equal(first.aux.audioSourceHints.length, 1);
  f.store.commitPage(f.command(first), allow);
  const hint = () => f.store.db.prepare("SELECT body FROM audio_source_hints WHERE work_id='101' AND kind='music'").get();
  assert.deepEqual(JSON.parse(hint().body).urls, [mediaUrl]);
  const sparse = parse('media', { inputCursor: '1', text: text(undefined, '2') });
  commit(f.store, f.job, 'sparse-page', sparse);
  assert.deepEqual(JSON.parse(hint().body).urls, [mediaUrl]);
  const changed = parse('media', { inputCursor: '2', text: text({ id: '3' }, null) });
  commit(f.store, f.job, 'changed-music', changed);
  assert.equal(hint(), undefined);
});

test('a page rejects mismatched generations, cursor, source, identity, reused digest and visited next cursors', async t => {
  const f = await makeStoreFixture(t);
  const first = parse('unsafe-integer');
  const command = f.command(first);
  assert.throws(() => f.store.commitPage(command), { code: 'PROBE_SYNC_REQUIRED' });
  assert.throws(() => f.store.commitPage(command, async () => {}), { code: 'PROBE_SYNC_REQUIRED' });
  assert.throws(() => f.store.commitPage(command, () => Promise.resolve()), { code: 'PROBE_SYNC_REQUIRED' });
  assert.throws(() => f.store.commitPage(command, () => { throw Error('stale lease'); }), /stale lease/);
  assert.throws(() => f.store.commitPage({ ...command, epoch: 0 }, allow), { code: 'STALE_JOB_EPOCH' });
  assert.throws(() => f.store.commitPage({ ...command, authEpoch: 0 }, allow), { code: 'STALE_JOB_EPOCH' });
  assert.throws(() => f.store.commitPage({ ...command, page: { ...first, inputCursor: '2' } }, allow), { code: 'STALE_PAGE_CURSOR' });
  assert.throws(() => f.store.commitPage({ ...command, page: { ...first, source: collection('10') } }, allow), { code: 'PROBE_PAGE_CONFLICT' });
  assert.throws(() => f.store.commitPage({ ...command, page: { ...first, refs: [{ workId: 99, rank: 0 }] } }, allow), { code: 'SOURCE_PAGE_INVALID' });
  assert.equal(f.store.readHead(total), null);

  const receipt = f.store.commitPage(command, allow);
  assert.equal(f.store.work('7345612390836712343').id, '7345612390836712343');
  assert.equal(f.store.readJob(f.job.id).cursor, '7345612390836712345');
  assert.throws(() => f.store.commitPage({ ...command, page: { ...first, digest: 'a'.repeat(64) } }, allow), { code: 'PROBE_OPERATION_CONFLICT' });
  assert.throws(() => f.store.commitPage({ ...command, page: { ...first, works: first.works.map(work => ({ ...work, title: 'changed content' })) } }, allow), { code: 'PROBE_OPERATION_CONFLICT' });
  assert.throws(() => f.store.commitPage({ ...command, operationId: 'wrong-job-op', jobId: 'no-such-job' }, allow), { code: 'PROBE_JOB_UNKNOWN' });
  assert.throws(() => f.store.commitPage({ ...command, operationId: 'repeated-page', page: {
    ...first, inputCursor: first.nextCursor, nextCursor: '9999999999999999999'
  } }, allow), { code: 'PROBE_PAGE_CONFLICT' });
  const cycles = pageFor(['999'], { inputCursor: first.nextCursor, nextCursor: '0' });
  assert.throws(() => commit(f.store, f.job, 'cursor-cycle', cycles), { code: 'PROBE_PAGE_CONFLICT' });
  f.store.withWrite(db => db.prepare('UPDATE source_jobs SET epoch=2 WHERE id=?').run(f.job.id));
  assert.throws(() => f.store.commitPage(command, allow), { code: 'STALE_JOB_EPOCH' });
  assert.throws(() => f.store.commitPage({ ...command, epoch: 2 }, allow), { code: 'PROBE_OPERATION_CONFLICT' });
  assert.deepEqual(f.store.operation(f.opId), receipt);
  assert.equal(rowCount(f.store, 'operations'), 1);
});

test('a page requires its captured authorization epoch after the job changes accounts', async t => {
  const f = await makeStoreFixture(t);
  const page = parse('unsafe-integer');
  const captured = f.command(page);
  f.store.withWrite(db => db.prepare('UPDATE source_jobs SET auth_epoch=3 WHERE id=?').run(f.job.id));
  assert.throws(() => f.store.commitPage(captured, allow), { code: 'STALE_JOB_EPOCH' });
  const { authEpoch, ...withoutOrigin } = captured;
  assert.throws(() => f.store.commitPage(withoutOrigin, allow), { code: 'INVALID_PROBE_JOB' });
  assert.equal(f.store.operation(f.opId), null);
  assert.equal(f.store.readHead(total), null);
  assert.equal(f.store.readJob(f.job.id).cursor, '0');
});

test('same work retains its separate collection relationships and no total relationship is invented', async t => {
  const a = collection('9000000000000000001');
  const b = collection('9000000000000000002');
  const f = await makeStoreFixture(t, { source: a });
  const first = parse('two-works', { source: a });
  f.store.commitPage(f.command(first), allow);
  const other = f.store.createReadJob({ id: 'collection-b', source: b });
  commit(f.store, other, 'another-source', pageFor(['101'], { source: b }));
  assert.equal(f.store.listWorks({ source: a }).total, 2);
  assert.equal(f.store.listWorks({ source: b }).total, 1);
  assert.equal(f.store.listWorks({ source: total }).total, 0);
  assert.equal(f.store.listWorks().total, 2);

  putRecord(f.store, 'works', '103', { id: '103', name: 'Unlinked local work', type: 'video' });
  assert.equal(f.store.listWorks().total, 3);
  assert.equal(f.store.listWorks().items.find(work => work.id === '103').name, 'Unlinked local work');
  assert.equal(f.store.listWorks({ source: total }).total, 0);
});

test('protected file and source scopes do not block other source metadata or resurrect deleted local records', async t => {
  const source = author('fixture-author-list');
  const f = await makeStoreFixture(t, { source });
  const parsed = parse('media', { source });
  const observed = parsed.works[0];
  const previous = { ...observed, title: 'previous title', localNote: 'retain', backupCover: { sha256: 'a'.repeat(64) } };
  putRecord(f.store, 'works', observed.id, previous);
  putRecord(f.store, 'local_tags', observed.id, { tags: ['existing'] }, 7);
  putRecord(f.store, 'downloads', observed.id, { id: observed.id, state: 'partial', assets: [] }, 3);
  const unrelatedResource = ['unrelated-file', '102', 'video', 'video', 'fixture/video.mp4', 128, 'b'.repeat(64), 'video/mp4', 'registered', 2];
  f.store.db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?,?,?,?)').run(...unrelatedResource);
  protect(f.store, observed.id, 'files');
  protect(f.store, observed.id, 'author', source.id);
  protect(f.store, '102', 'account', '__all__');
  protect(f.store, '103', 'work');

  f.store.commitPage(f.command(parsed), allow);
  assert.equal(f.store.work(observed.id).title, observed.title);
  assert.equal(f.store.work(observed.id).localNote, 'retain');
  assert.equal(f.store.work(observed.id).backupCover, undefined);
  assert.deepEqual(f.store.work(observed.id).coverVariants, observed.coverVariants);
  assert.deepEqual(f.store.listWorks({ source }).items.map(item => item.id), ['102']);

  const coll = collection('1000');
  const next = f.store.createReadJob({ id: 'new-collection', source: coll });
  commit(f.store, next, 'collection-page', pageFor(['101', '102', '103', '104'], { source: coll }));
  assert.deepEqual(f.store.listWorks({ source: coll }).items.map(item => item.id), ['101', '104']);
  assert.equal(f.store.work('103'), null);
  assert.ok(f.store.work('102'));
  assert.equal(f.store.listWorks().total, 3);
  assert.equal(f.store.listWorks({ source: total }).total, 0);
  for (const [kind, revision] of [['downloads', 3], ['local_tags', 7]]) {
    assert.equal(f.store.db.prepare('SELECT revision FROM records WHERE kind=? AND id=?').get(kind, observed.id).revision, revision);
  }
  assert.equal(rowCount(f.store, 'scope_state'), 4);
  assert.deepEqual(Object.values(f.store.db.prepare('SELECT * FROM resources').get()), unrelatedResource);
});

test('paged source listing uses first occurrence order and enforces 20 items with checked bounds', async t => {
  const f = await makeStoreFixture(t);
  const ids = Array.from({ length: 25 }, (_, index) => String(9000 + index));
  f.store.commitPage(f.command(pageFor(ids.slice(0, 18), { nextCursor: '24' })), allow);
  commit(f.store, f.job, 'second-page', pageFor([ids[1], ...ids.slice(18)], { inputCursor: '24' }));
  const first = f.store.listWorks({ source: total, page: 1 });
  const second = f.store.listWorks({ source: total, page: 2, pageSize: 20 });
  assert.equal(first.total, 25);
  assert.equal(first.pages, 2);
  assert.equal(first.pageSize, 20);
  assert.deepEqual(first.items.map(work => work.id), ids.slice(0, 20));
  assert.deepEqual(second.items.map(work => work.id), ids.slice(20));
  assert.equal(f.store.readJob(f.job.id).savedReceived, 26);
  assert.equal(f.store.readJob(f.job.id).savedUnique, 25);
  assert.equal('videoUrls' in first.items[0], false);
  assert.equal('coverVariants' in first.items[0], false);
  for (const page of [0, -1, 1.5, 3, '1', Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => f.store.listWorks({ source: total, page }), { code: 'INVALID_PROBE_PAGE' });
  }
  assert.throws(() => f.store.listWorks({ pageSize: 2 }), { code: 'INVALID_PROBE_PAGE' });
});
