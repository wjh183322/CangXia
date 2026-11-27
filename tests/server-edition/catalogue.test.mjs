import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openLibrary } from '../../server/library.mjs';
import { createSessionService } from '../../server/session.mjs';
import { selectWorks } from '../../electron/filter.mjs';
import { creatorIndex } from '../../shared/creators.mjs';

const first = 9007199254740993123n;
function fixture(t, n = 55, catalogueActions = {}, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-catalogue-'));
  const library = openLibrary({ root, mode: 'init' });
  const works = Array.from({ length: n }, (_, i) => ({
    id: String(first + BigInt(i)),
    name: '春日 ' + i,
    title: '春日 ' + i,
    type: i % 2 ? 'images' : 'video',
    description: '相册',
    author: { uid: '71', nickname: '树' },
    coAuthors: i % 3 ? [] : [{ uid: '42', nickname: '猫', secUid: 'sec42' }],
    tags: i % 2 ? ['A', 'B'] : ['A'],
    images: [],
    localTags: []
  }));
  const profile = { uid: '42', secUid: 'sec42', nickname: '新猫', uniqueId: 'cat' };
  library.write((db) => {
    const put = db.prepare('INSERT INTO works VALUES(?,?,?)'),
      member = db.prepare('INSERT INTO source_members VALUES(?,?,?,0)');
    for (const [i, w] of works.entries()) {
      put.run(w.id, w.name, JSON.stringify({ ...w, videoUrl: 'secret-synthetic', readHidden: false }));
      if (i < n - 1) {
        member.run('total', w.id, i);
        member.run('folder:77', w.id, n - i);
        if (i % 3 === 0) member.run('author:sec42', w.id, i);
      }
    }
    db.prepare('INSERT INTO source_creator_profiles VALUES(?,?)').run('uid:42', JSON.stringify(profile));
  });
  const sessions = createSessionService({ library, catalogueActions, source });
  t.after(() => {
    sessions.close();
    library.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const who = { accountId: 'a', deviceId: 'A' };
  const grant = sessions.acquire(who, {
    deviceId: 'A',
    libraryId: library.libraryId,
    instanceId: randomUUID(),
    operationId: randomUUID()
  });
  const query = (kind, payload) => sessions.query(who, grant, { kind, payload });
  return {
    library,
    works,
    profile,
    query,
    grant,
    sessions,
    who,
    action: (payload, operationId = randomUUID()) =>
      sessions.command(who, grant, { kind: 'catalogue-action', payload, operationId, entityVersion: 0 })
  };
}
test('catalogue preserves absolute independent positions, bounded pages and baseline text, creator and tag filters', (t) => {
  const { query, works, profile } = fixture(t);
  const page = (source, input = {}) => query('list-works', { source, ...input });
  assert.deepEqual(
    page('total', { page: 2 }).ids,
    works.slice(20, 40).map((w) => w.id)
  );
  assert.deepEqual(
    page('folder:77').ids,
    works
      .slice(0, -1)
      .reverse()
      .slice(0, 20)
      .map((w) => w.id)
  );
  assert.equal(page('all', { filter: { query: works.at(-1).id } }).total, 1);
  assert.equal(page('total', { filter: { query: works.at(-1).id } }).total, 0);
  for (const filter of [
    { query: '新猫' },
    { author: 'sec:sec42', type: 'images' },
    { tags: ['B', 'A'], tagMode: 'all' },
    { query: "%' OR 1=1 --" }
  ]) {
    const expected = selectWorks(works.slice(0, -1), { ...filter, creators: creatorIndex([profile]) });
    assert.deepEqual(
      page('total', { filter }).ids,
      expected.slice(0, 20).map((w) => w.id)
    );
  }
  assert.equal(query('catalogue-position', { source: 'folder:77', id: works[2].id }).position, 51);
  assert(!JSON.stringify(page('total')).includes('secret-synthetic'));
  assert.equal(query('state', {}).works.length, 0);
});
test('a cross-page scope excludes exceptions and expires on a metadata change before being used', (t) => {
  const { query, works, library } = fixture(t);
  const page = query('list-works', { source: 'all' });
  const input = { source: 'all', revision: page.revision, scope: page.scope, all: true, ids: [works[2].id] };
  assert.equal(query('resolve-selection', input).count, 54);
  assert.throws(() => query('resolve-selection', { ...input, source: 'total' }));
  library.write((db) => db.prepare('INSERT INTO work_tags VALUES(?,?)').run(works[0].id, '旅行'));
  assert.throws(() => query('resolve-selection', input), /重新/);
});

test('a confirmed action revalidates the count and revision inside the write transaction before applying any IDs', (t) => {
  let applied = [];
  const { query, works, library, action } = fixture(t, 55, {
    download: (_db, ids) => {
      applied.push(...ids);
      return { queued: ids.length };
    }
  });
  const { revision, scope } = query('list-works', { source: 'folder:77' });
  const selection = {
    source: 'folder:77',
    revision,
    scope,
    all: true,
    ids: [works[0].id],
    confirmedCount: 53
  };
  assert.throws(() => action({ action: 'download', selection: { ...selection, confirmedCount: 52 } }));
  assert.deepEqual(applied, []);
  const op = randomUUID(),
    payload = { action: 'download', selection };
  const receipt = action(payload, op);
  assert.deepEqual(
    applied,
    works
      .slice(1, -1)
      .reverse()
      .map((w) => w.id)
  );
  library.write((db) => db.prepare('INSERT INTO work_tags VALUES(?,?)').run(works[1].id, '月'));
  assert.deepEqual(action(payload, op), receipt);
  applied = [];
  assert.throws(() => action(payload), /重新/);
  assert.deepEqual(applied, []);
});

test('facets search beyond the first page, media only ordering, and detail expose safe metadata', (t) => {
  const { query, library, works } = fixture(t, 90),
    id = works[5].id;
  library.write((db) => {
    db.prepare(
      "UPDATE works SET body=json_set(body,'$.url',?,'$.author.token','synthetic-secret','$.coAuthors',json('[]'),'$.author.uid','82','$.author.nickname','夜') WHERE id=?"
    ).run('https://www.douyin.com/note/' + id + '?token=synthetic-secret', id);
    const insert = db.prepare('INSERT INTO work_tags VALUES(?,?)');
    for (let i = 0; i < 78; i++) insert.run(works[0].id, '标签' + String(i).padStart(3, '0'));
    const media = db.prepare('INSERT INTO media_files VALUES(?,?,?,?,?)');
    for (const [i, n] of [
      [4, 300],
      [2, 100]
    ])
      media.run('f' + i, works[i].id, i + '/video.mp4', n, 'a'.repeat(64));
  });
  assert.deepEqual(query('catalogue-choices', { kind: 'authors', source: 'total', query: '夜' }).items, [
    ['uid:82', '夜']
  ]);
  assert.equal(query('catalogue-choices', { kind: 'myTags', page: 2 }).items.length, 28);
  assert.deepEqual(query('catalogue-choices', { kind: 'myTags', query: '077' }).items, [
    ['标签077', '标签077']
  ]);
  assert.deepEqual(query('list-works', { source: 'media', sort: 'size-desc' }).ids, [
    works[4].id,
    works[2].id
  ]);
  assert.deepEqual(query('list-works', { source: 'total', filter: { downloaded: 'complete' } }).ids, []);
  library.write((db) => {
    db.prepare("INSERT INTO download_jobs VALUES('job',?,'complete')").run(works[2].id);
    db.prepare("UPDATE works SET body=json_set(body,'$.localStatus','checking') WHERE id=?").run(works[0].id);
  });
  assert.deepEqual(query('list-works', { source: 'total', filter: { downloaded: 'complete' } }).ids, [
    works[2].id
  ]);
  assert(
    !query('list-works', { source: 'total', filter: { downloaded: 'missing' } }).ids.includes(works[0].id)
  );
  assert.deepEqual(query('list-works', { source: 'total', filter: { downloaded: 'checking' } }).ids, [
    works[0].id
  ]);
  const detail = query('work-detail', { id });
  assert.equal(detail.url, 'https://www.douyin.com/note/' + id);
  assert(!JSON.stringify(detail).includes('synthetic-secret'));
  assert.equal(detail.author.nickname, '夜');
});
test('thousands of synthetic rows stay paged on the server', (t) => {
  const { query, library, works } = fixture(t, 3001);
  const start = performance.now();
  assert.equal(query('list-works', { source: 'total', page: 140 }).ids.length, 20);
  assert.equal(query('list-works', { source: 'all', filter: { query: '新猫' } }).total, 1001);
  assert.equal(query('catalogue-position', { source: 'folder:77', id: works[3].id }).position, 2996);
  const plan = library.read((db) =>
    db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT work_id FROM source_members WHERE source_id='folder:77' ORDER BY order_generation DESC,position,work_id LIMIT 20"
      )
      .all()
  );
  assert(plan.some((r) => r.detail.includes('source_members_order')));
  t.diagnostic('3,001 works, page/search/position ' + Math.round(performance.now() - start) + ' ms');
});

test('manual creator lookup verifies each stored work participant before updating shared profiles', async (t) => {
  const epoch = randomUUID(),
    id = String(first),
    sec = 'MS4wLjABsynthetic001',
    other = 'MS4wLjABsynthetic002';
  const source = {
    account: () => ({ uid: '101', authEpoch: epoch }),
    lookupAuthor: async (_input, text) =>
      text.includes(other)
        ? { id: other, uid: '888', name: '冒名' }
        : { id: sec, uid: '71', name: '新作者', uniqueId: 'new' }
  };
  const { sessions, library, who, grant, query } = fixture(t, 55, {}, source);
  library.write((db) => {
    db.prepare('INSERT INTO source_account VALUES(1,?,?,?)').run('101', 'fixture', randomUUID());
    db.prepare(
      "UPDATE works SET body=json_set(body,'$.author.secUid',?,'$.coAuthors[0].secUid',?) WHERE id=?"
    ).run(sec, other, id);
  });
  const result = await sessions.sourceOperation(who, grant, 'creator-profiles', { id });
  assert.equal(result.updated, 1);
  assert.equal(query('work-detail', { id }).author.uniqueId, 'new');
  assert(!JSON.stringify(query('work-detail', { id })).includes('冒名'));
  assert.equal(query('state', {}).authors.length, 0);
});
