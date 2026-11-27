import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { openLibrary } from '../../server/library.mjs';
import { createSessionService } from '../../server/session.mjs';
import { parseSourcePage } from '../../server/source-parser.mjs';
import { createReadStore } from '../../server/read-store.mjs';
import { orderedMemberships } from '../../server/memberships.mjs';

const total = { kind: 'total', id: '__all__' },
  folder = { kind: 'collection', id: '77' },
  other = { kind: 'collection', id: '78' };
const A = '9007199254740993123';
const raw = (id) => ({ aweme_id: id, item_title: 'title ' + id });
const page = (ticket, rows, next = null) =>
  parseSourcePage({
    source: ticket.source,
    inputCursor: ticket.inputCursor,
    status: 200,
    observedAt: '2026-11-26T12:00:00Z',
    text: JSON.stringify({
      aweme_list: rows.map((row) => (typeof row === 'string' ? raw(row) : row)),
      has_more: next !== null,
      cursor: next ?? '0'
    })
  });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-members-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = openLibrary({ root, mode: 'init' });
  t.after(() => library.close());
  const identity = { uid: '101', authEpoch: randomUUID() };
  library.write((db) =>
    db.prepare('INSERT INTO source_account VALUES (1,?,?,?)').run(identity.uid, 'fixture', randomUUID())
  );
  const browser = { account: () => identity };
  const who = { accountId: 'operator', deviceId: 'A' };
  function attach(lib) {
    const sessions = createSessionService({ library: lib, source: browser });
    t.after(() => sessions.close());
    const grant = sessions.acquire(who, {
      deviceId: who.deviceId,
      instanceId: randomUUID(),
      operationId: randomUUID()
    });
    const session = sessions.sourceSession(who, grant);
    const store = createReadStore({ session, browser });
    return { sessions, grant, store };
  }
  const { sessions, grant, store } = attach(library);
  const start = (source) => {
    const job = { jobId: randomUUID(), jobEpoch: 1, authEpoch: identity.authEpoch, source };
    store.startRead(job);
    return job;
  };
  const prepare = (job, operationId = randomUUID()) => store.prepareSourcePage({ ...job, operationId });
  function commit(job, rows, next = null) {
    const ticket = prepare(job);
    return store.commitSourcePage({ ...ticket, page: page(ticket, rows, next) });
  }
  const members = (source) => library.read((db) => orderedMemberships(db, source).map((row) => row.workId));
  const remove = (source, workId, entityVersion = 0, operationId = randomUUID()) =>
    sessions.command(who, grant, {
      operationId,
      kind: 'remove-membership',
      entityVersion,
      payload: { source, workId }
    });
  return {
    root,
    library,
    browser,
    identity,
    sessions,
    who,
    grant,
    store,
    start,
    prepare,
    commit,
    members,
    remove,
    attach
  };
}

for (const first of [total, folder])
  test('restores only the returning scope, first ' + first.kind, (t) => {
    const f = fixture(t);
    const orders = new Map([
      [total, ['11', A, '12']],
      [folder, ['21', A, '22']],
      [other, [A, '31']]
    ]);
    for (const [source, ids] of orders) f.commit(f.start(source), ids);
    f.library.write((db) =>
      db
        .prepare('INSERT INTO media_files VALUES (?,?,?,?,?)')
        .run('existing', A, 'archive.mp4', 1, 'a'.repeat(64))
    );
    const operationId = randomUUID(),
      removed = f.remove(total, A, 0, operationId);
    assert.deepEqual(f.remove(total, A, 0, operationId), removed);
    assert.deepEqual(f.sessions.receipt(f.who, f.grant, operationId), removed);
    assert.throws(() => f.remove(folder, A, 0, operationId), { code: 'OPERATION_CONFLICT' });
    f.remove(folder, A);
    const second = first === total ? folder : total;
    const job = f.start(first),
      ticket = f.prepare(job),
      input = { ...ticket, page: page(ticket, orders.get(first)) };
    const result = f.store.commitSourcePage(input);
    assert.deepEqual(result.restoredIds, [A]);
    assert.equal(result.savedCursor, null);
    assert.deepEqual(f.store.commitSourcePage(input), result);
    assert.throws(() => f.store.commitSourcePage({ ...ticket, page: page(ticket, ['99']) }), {
      code: 'OPERATION_CONFLICT'
    });
    assert.deepEqual(f.members(first), orders.get(first));
    assert.deepEqual(
      f.members(second),
      orders.get(second).filter((id) => id !== A)
    );
    assert.deepEqual(f.members(other), orders.get(other));
    const nextJob = f.start(second);
    f.commit(nextJob, orders.get(second));
    assert.deepEqual(f.members(second), orders.get(second));
    const events = f.library.read((db) =>
      db
        .prepare('SELECT job_id,work_id,name,source_id,position FROM membership_restorations ORDER BY rowid')
        .all()
    );
    assert.deepEqual(
      events.map((e) => [e.job_id, e.work_id, e.name, e.position]),
      [
        [job.jobId, A, 'title ' + A, 1],
        [nextJob.jobId, A, 'title ' + A, 1]
      ]
    );
    assert.deepEqual(events.map((e) => e.source_id).sort(), ['folder:77', 'total']);
    assert.equal(
      f.library.read((db) => db.prepare('SELECT count(*) n FROM media_files').get().n),
      1
    );
    assert.equal(
      f.library.read((db) => db.prepare('SELECT count(*) n FROM download_jobs').get().n),
      0
    );
    assert.throws(() => f.remove(total, A, 0), { code: 'STALE_ENTITY' });
  });

test('partial prefix and terminal order use original anchors across restart; cycles and changed generations reject', (t) => {
  const f = fixture(t);
  f.commit(f.start(folder), ['10', '11', '12', '13', '14', '15']);
  const job = f.start(folder);
  f.commit(job, ['20', '12', '12'], '9007199254740993987');
  const evidence = f.library.read((db) =>
    db.prepare('SELECT ordered_refs,received_count FROM source_page_operations WHERE job_id=?').get(job.jobId)
  );
  assert.deepEqual(JSON.parse(evidence.ordered_refs), [
    { workId: '20', rank: 0 },
    { workId: '12', rank: 1 }
  ]);
  assert.equal(evidence.received_count, 3);
  assert.deepEqual(f.members(folder), ['20', '12', '10', '11', '13', '14', '15']);
  const ticket = f.prepare(job);
  assert.deepEqual(f.prepare(job, ticket.operationId), ticket);
  assert.throws(() => f.store.commitSourcePage({ ...ticket, page: page(ticket, ['77'], '0') }));
  assert.throws(() =>
    f.store.commitSourcePage({ ...ticket, page: page(ticket, ['77'], ticket.inputCursor) })
  );
  assert.throws(() => f.store.commitSourcePage({ ...ticket, jobEpoch: 2, page: page(ticket, ['77']) }));
  f.identity.authEpoch = randomUUID();
  assert.throws(() => f.store.commitSourcePage({ ...ticket, page: page(ticket, ['77']) }));
  const lib = openLibrary({ root: f.root, expectedId: f.library.libraryId });
  t.after(() => lib.close());
  const next = f.attach(lib).store;
  const resumed = { ...job, jobEpoch: 2, authEpoch: f.identity.authEpoch };
  next.resumeRead({ ...resumed, expectedEpoch: 1 });
  assert.throws(() => next.commitSourcePage({ ...ticket, page: page(ticket, ['77']) }));
  const pending = next.prepareSourcePage({ ...resumed, operationId: randomUUID() });
  assert.equal(pending.inputCursor, '9007199254740993987');
  next.commitSourcePage({ ...pending, page: page(pending, ['14', '11', '20']) });
  assert.deepEqual(f.members(folder), ['20', '12', '13', '14', '10', '11', '15']);
  assert.deepEqual(f.members(total), []);
  assert.throws(() => next.prepareSourcePage({ ...resumed, operationId: randomUUID() }));
});

test('an outstanding page cannot undo a later removal; late failure rolls back the entire page', (t) => {
  const f = fixture(t);
  f.commit(f.start(folder), [A, '11', '12']);
  f.remove(folder, A);
  const job = f.start(folder),
    first = f.prepare(job);
  const firstPage = page(first, [A, '11'], '42');
  f.store.commitSourcePage({ ...first, page: firstPage });
  const next = f.prepare(job);
  f.remove(folder, A, 2);
  const cmd =
    "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked');";
  f.library.write(() => {
    const other = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', cmd, path.join(f.root, 'cangxia-server', 'library.sqlite')],
      { encoding: 'utf8' }
    );
    assert.match(other.stderr, /locked|busy/i);
  });
  assert.deepEqual(f.store.commitSourcePage({ ...first, page: firstPage }).restoredIds, [A]);
  assert.deepEqual(f.members(folder), ['11', '12']);
  const result = f.store.commitSourcePage({ ...next, page: page(next, [A, '12']) });
  assert.deepEqual(result.restoredIds, []);
  assert.deepEqual(f.members(folder), ['11', '12']);
  const again = f.start(folder),
    pending = f.prepare(again);
  const valid = page(pending, ['99', A]);
  // Abort after work and order writes to exercise SQLite rollback and the identical dispatch retry.
  const trigger =
    "CREATE TEMP TRIGGER fail_commit BEFORE UPDATE OF cursor ON source_read_runs BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END";
  const guarded = createReadStore({
    browser: f.browser,
    session: {
      read: (fn) => f.library.read(fn),
      write: (fn) =>
        f.library.write((db) => {
          db.exec(trigger);
          return fn(db);
        })
    }
  });
  assert.throws(() => guarded.commitSourcePage({ ...pending, page: valid }), /fixture commit failure/);
  assert.equal(
    f.library.read((db) => db.prepare("SELECT count(*) n FROM works WHERE id='99'").get().n),
    0
  );
  assert.deepEqual(f.members(folder), ['11', '12']);
  assert.deepEqual(f.store.commitSourcePage({ ...pending, page: valid }).restoredIds, [A]);
  assert.deepEqual(f.members(folder), ['99', A, '11', '12']);
});

test('the session-owned gateway commits its typed page, metadata and receipt; sparse rereads preserve prior evidence', async (t) => {
  const f = fixture(t);
  const { createSourceBrowser } = await import('../../server/source-browser.mjs');
  const data = {
    ...raw(A),
    author: { uid: '222', sec_uid: 'author_222', nickname: '创作者' },
    cooperation_info: { co_creators: [{ uid: '223', nickname: '共同作者', invite_status: 1 }] },
    music: { id: '51', title: '配乐', play_url: { url_list: ['https://v.douyinvod.com/audio.mp3'] } }
  };
  let rows = [data],
    reads = 0;
  const gateway = createSourceBrowser({
    root: f.root,
    library: f.library,
    openProvider: async () => ({
      self: async () => ({ uid: f.identity.uid, nickname: 'sample' }),
      sessionKey: async () => 'fixture',
      storage: async () => ({ cookies: [], origins: [] }),
      endLogin() {},
      async close() {},
      async read() {
        reads++;
        return { status: 200, text: JSON.stringify({ aweme_list: rows, has_more: false }) };
      }
    })
  });
  t.after(() => gateway.close());
  // Bind the production source and grant using the same registration as startServer.
  const sessions = createSessionService({ library: f.library, source: gateway });
  t.after(() => sessions.close());
  const grant = sessions.acquire(f.who, {
    deviceId: f.who.deviceId,
    instanceId: randomUUID(),
    operationId: randomUUID()
  });
  f.library.write((db) => db.exec('UPDATE source_account SET profile_id=NULL'));
  const account = await gateway.verifyAccount(sessions.sourceSession(f.who, grant));
  const store = sessions.readStore(f.who, grant);
  const run = () => ({ jobId: randomUUID(), jobEpoch: 1, authEpoch: account.authEpoch, source: folder });
  const one = run(),
    input = { ...one, operationId: randomUUID() };
  store.startRead(one);
  assert.deepEqual(await store.readNextPage(input), { savedCursor: null, restoredIds: [] });
  assert.deepEqual(await store.readNextPage(input), { savedCursor: null, restoredIds: [] });
  assert.equal(reads, 1);
  f.library.write((db) => db.prepare('INSERT INTO work_tags VALUES(?,?)').run(A, 'manual'));
  rows = [{ aweme_id: A }];
  const two = run();
  store.startRead(two);
  await store.readNextPage({ ...two, operationId: randomUUID() });
  f.library.read((db) => {
    const row = db.prepare('SELECT * FROM works WHERE id=?').get(A);
    assert.equal(row.title, 'title ' + A);
    const body = JSON.parse(row.body);
    assert.equal(body.author.uid, '222');
    assert.equal(body.coAuthors[0].uid, '223');
    assert.equal(body.music.id, '51');
    assert.equal(db.prepare('SELECT tag FROM work_tags WHERE work_id=?').get(A).tag, 'manual');
    assert.equal(db.prepare('SELECT count(*) n FROM source_creator_profiles').get().n, 2);
    assert.equal(
      JSON.parse(db.prepare('SELECT body FROM source_audio_hints WHERE work_id=?').get(A).body).sources[0]
        .kind,
      'music'
    );
  });
  rows = [{ aweme_id: A, music: { id: '52', title: '另一首' } }];
  const three = run();
  store.startRead(three);
  await store.readNextPage({ ...three, operationId: randomUUID() });
  assert.equal(
    f.library.read((db) => db.prepare('SELECT count(*) n FROM source_audio_hints').get().n),
    0
  );
});

test('cross-process removal between dispatch and delivery survives restart and rejected stale or invented revisions', (t) => {
  const f = fixture(t);
  f.commit(f.start(folder), [A]);
  const job = f.start(folder),
    ticket = f.prepare(job);
  const peer = `import {openLibrary} from './server/library.mjs';
    import {removeMembership} from './server/memberships.mjs';
    const lib=openLibrary({root:process.argv[1],expectedId:process.argv[2]});
    lib.write(db=>removeMembership(db,{source:{kind:'collection',id:'77'},workId:process.argv[3],expectedVersion:0}));lib.close();`;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', peer, f.root, f.library.libraryId, A],
    {
      cwd: new URL('../../', import.meta.url),
      encoding: 'utf8'
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const response = page(ticket, [A, '13']);
  assert.throws(() =>
    f.store.commitSourcePage({ ...ticket, removalRevision: ticket.removalRevision + 1, page: response })
  );
  assert.deepEqual(f.store.commitSourcePage({ ...ticket, page: response }).restoredIds, []);
  assert.deepEqual(f.members(folder), ['13']);
  const abandoned = f.start(folder),
    old = f.prepare(abandoned);
  const resumed = { ...abandoned, jobEpoch: 2 };
  f.store.resumeRead({ ...resumed, expectedEpoch: 1 });
  assert.throws(() => f.store.prepareSourcePage({ ...resumed, operationId: old.operationId }));
  assert.throws(() => f.store.commitSourcePage({ ...old, page: page(old, [A]) }));
  const fresh = f.prepare(resumed);
  assert.deepEqual(f.store.commitSourcePage({ ...fresh, page: page(fresh, [A]) }).restoredIds, [A]);
  const confirmed = f.store.checkpoint(resumed.jobId);
  assert.equal(confirmed.savedCursor, null);
  assert.equal(confirmed.pendingOperationId, null);
});

test('handoff while page two is in flight retains the committed page receipt and cursor', async (t) => {
  const f = fixture(t),
    job = f.start(total),
    one = f.prepare(job);
  const first = f.store.commitSourcePage({ ...one, page: page(one, ['15'], '36') });
  let deliver;
  const pending = Promise.withResolvers();
  f.browser.readSourcePage = async (request) => {
    deliver = () => pending.resolve(page({ source: request.source, inputCursor: request.cursor }, ['16']));
    return pending.promise;
  };
  const operationId = randomUUID(),
    late = f.store.readNextPage({ ...job, operationId });
  assert.equal(f.store.checkpoint(job.jobId).pendingOperationId, operationId);
  f.sessions.release(f.who, f.grant, randomUUID());
  const next = f.attach(f.library).store;
  deliver();
  await assert.rejects(late, { code: 'SESSION_LOST' });
  assert.deepEqual(f.members(total), ['15']);
  assert.deepEqual(next.pageReceipt(job.jobId, one.operationId), first);
  assert.equal(next.pageReceipt(job.jobId, operationId), null);
  assert.equal(next.checkpoint(job.jobId).savedCursor, '36');
  const current = { ...job, jobEpoch: 2 };
  next.resumeRead({ ...current, expectedEpoch: 1 });
  const two = next.prepareSourcePage({ ...current, operationId: randomUUID() });
  next.commitSourcePage({ ...two, page: page(two, ['17']) });
  assert.deepEqual(f.members(total), ['15', '17']);
  assert.equal(next.checkpoint(job.jobId).pendingOperationId, null);
});
