import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import selfsigned from 'selfsigned';
import { createHttpsService } from '../../server/http.mjs';
import { createDownloads } from '../../server/downloads.mjs';
import { createSessionService } from '../../server/session.mjs';
import { openLibrary } from '../../server/library.mjs';
import { parseSourcePage, parseSourceDetail } from '../../server/source-parser.mjs';
import { ServerClient } from '../../electron/server-client.mjs';

const total = { kind: 'total', id: '__all__' },
  folder = { kind: 'collection', id: '77' },
  A = '9007199254740993123';
const tls = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
  keySize: 2048,
  algorithm: 'sha256'
});
async function fixture(t, { readDelay = 0, downloadOptions } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-reads-'));
  const library = openLibrary({ root, mode: 'init' });
  const identity = { uid: '101', authEpoch: randomUUID() };
  library.write((db) =>
    db.prepare('INSERT INTO source_account VALUES(1,?,?,?)').run(identity.uid, 'fixture', randomUUID())
  );
  const calls = [];
  const source = {
    account: () => identity,
    discoverFolders: async () => [{ id: '77', name: '自建夹', count: 1 }],
    async readSourcePage({ source, cursor, signal, count }) {
      calls.push({ source, cursor, count });
      const { ids, next } = await sourceRows(source, cursor, signal, count);
      return parseSourcePage({
        source,
        inputCursor: cursor,
        status: 200,
        observedAt: '2026-11-26T12:00:00Z',
        text: JSON.stringify({
          aweme_list: ids.map((id) => ({
            aweme_id: id,
            item_title: '标题 ' + id,
            ...(source.kind === 'author'
              ? { author: { uid: '88', sec_uid: source.id, nickname: '作者' } }
              : {})
          })),
          has_more: next != null,
          cursor: next ?? '0'
        })
      });
    }
  };
  let sourceRows = () => ({ ids: [A] });
  const downloads = downloadOptions && createDownloads({ library,root,source,...downloadOptions });
  const sessions = createSessionService({ library, source, readDelay, downloads });
  const cert = await tls,
    token = 'a'.repeat(48);
  const https = createHttpsService({
    sessions,
    source,
    key: cert.private,
    cert: cert.cert,
    credentials: { A: { accountId: 'family', token } }
  });
  await new Promise((resolve) => https.listen(0, '127.0.0.1', resolve));
  const client = new ServerClient();
  const config = {
    url: 'https://127.0.0.1:' + https.address().port,
    fingerprint: new X509Certificate(cert.cert).fingerprint256,
    deviceId: 'A',
    token
  };
  async function connect() {
    await client.connect(config);
    await client.acquire();
  }
  await connect();
  t.after(async () => {
    client.lock();
    sessions.close();
    await downloads?.close();
    await new Promise((resolve) => https.close(resolve));
    library.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cmd = (kind, payload, operationId = randomUUID()) =>
    client.command({ kind, payload, entityVersion: 0, operationId });
  const start = (source, opts = {}) => cmd('start-read', { source, mode: 'full', ...opts });
  async function done(id) {
    for (let n = 0; n < 500; n++) {
      const result = await client.query('read-job', { jobId: id });
      if (result.status !== 'running') return result;
      await delay(5);
    }
    throw Error('job did not settle');
  }
  return {
    client,
    downloads,
    library,
    source,
    identity,
    calls,
    cmd,
    start,
    done,
    connect,
    rows: (fn) => {
      sourceRows = fn;
    },
    async discover() {
      await client.call('source/folders', {});
      await cmd('add-folders', { ids: ['77'] });
    }
  };
}
test('HTTPS linked reads wait for verified NAS metadata then resume into the selected folder',async t=>{
  let fail=false;
  const f=await fixture(t,{downloadOptions:{
    fetchAsset:async()=>new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64'),{headers:{'Content-Type':'image/png'}}),
    fileHook(name){if(fail && name==='beforeMetadataExchange')throw Object.assign(Error('full'),{code:'ENOSPC'});}
  }});
  await f.discover();
  f.library.write(db=>{
    db.exec("INSERT INTO download_auth VALUES(1,'fixture')");
    db.prepare('INSERT INTO works VALUES(?,?,?)').run(A,'旧名',JSON.stringify({id:A,name:'旧名',type:'images',author:{nickname:'作者'},images:[{index:0,urls:['https://p3.douyinpic.com/test']}]}));
  });
  await f.cmd('enqueue-download',{workIds:[A],selection:'missing'});
  await f.downloads.run();
  assert.equal(f.downloads.store.resources(A).length,2);
  fail=true;
  const batch=await f.start(total,{followFolders:['77']});
  for(let i=0;i<500 && !f.library.read(db=>db.prepare('SELECT error FROM archive_state WHERE work_id=?').get(A)?.error);i++)await delay(10);
  assert.equal((await f.client.query('read-job',{jobId:batch.jobId})).status,'finalizing');
  assert.equal(f.calls.filter(call=>call.source.kind==='collection').length,0);
  assert.equal(f.library.read(db=>db.prepare("SELECT status FROM read_finalizers WHERE work_id=?").get(A).status),'pending');
  fail=false;
  await f.cmd('control-read',{jobId:batch.jobId,action:'resume'});
  let summary;
  for(let i=0;i<800;i++){summary=await f.client.query('read-job',{jobId:batch.jobId});if(summary.status==='complete')break;await delay(10);}
  assert.equal(summary.status,'complete',JSON.stringify(summary));
  assert.equal(f.calls.filter(call=>call.source.kind==='collection').length,1);
  assert.deepEqual(f.library.read(db=>db.prepare('SELECT status FROM read_finalizers WHERE work_id=? ORDER BY rowid').all(A)).map(row=>row.status),['complete','complete']);
  const rows=f.downloads.store.resources(A);
  assert.equal(rows.filter(row=>row.kind==='image').length,1);
  const meta=rows.find(row=>row.key==='metadata');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.downloads.layout.media,meta.relative_path))).collectionId,'77');
});

test('HTTPS linked batch restores each relation and reports one unique work, with durable detail and idempotent start', async (t) => {
  const f = await fixture(t);
  await f.discover();
  const operation = randomUUID(),
    payload = { source: total, mode: 'full', followFolders: ['77'] };
  const first = await f.cmd('start-read', payload, operation);
  assert.deepEqual(await f.cmd('start-read', payload, operation), first);
  assert.equal((await f.done(first.jobId)).status, 'complete');
  for(const key of ['total','folder:'+folder.id]){
    const {revision,scope}=await f.client.query('list-works',{source:key});
    const plan=await f.cmd('preview-removal',{scope:'membership',selection:{source:key,ids:[A],all:false,revision,scope}});
    await f.cmd('confirm-removal',{token:plan.token});
  }
  const next = await f.start(total, { followFolders: ['77'] });
  const batch = await f.done(next.jobId);
  assert.equal(batch.restoredRelations, 2);
  assert.equal(batch.distinctRestoredWorks, 1);
  for (const run of batch.steps) {
    assert.equal(run.added, 0);
    const result = await f.client.query('history-items', { runId: run.token, kind: 'restored', page: 1 });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].workId, A);
    assert.equal(result.items[0].position, 0);
    assert.equal(result.items[0].name, '标题 ' + A);
  }
});
test('quick requires consent without an anchor, then stops after two contiguous history pages', async (t) => {
  const f = await fixture(t),
    size = 19 * 30;
  f.rows((_s, c) => {
    const start = Number(c);
    return {
      ids: Array.from({ length: 30 }, (_, i) => String(1000 + start + i)),
      next: start + 30 < size ? String(start + 30) : null
    };
  });
  await assert.rejects(f.start(total, { mode: 'quick' }), /确认/);
  const full = await f.done((await f.start(total)).jobId);
  assert.equal(full.steps[0].rawCount, size);
  const quick = await f.done((await f.start(total, { mode: 'quick' })).jobId);
  assert.equal(quick.steps[0].outcome, 'matched');
  assert.equal(quick.steps[0].checked, 60);
  const last = await f.client.query('history-items', { runId: full.steps[0].token, page: 12 });
  assert.equal(last.total, size);
  assert.equal(last.items.length, 20);
});
test('handoff drops page two already dispatched and resumes the same remote cursor with a new generation', async (t) => {
  const f = await fixture(t),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  f.rows(async (_s, c) => {
    if (c === '0') return { ids: ['101'], next: '815' };
    entered.resolve();
    await release.promise;
    return { ids: ['777'] };
  });
  const job = await f.start(total);
  await entered.promise;
  await f.client.release();
  await f.connect();
  assert.equal((await f.done(job.jobId)).status, 'paused');
  f.rows((_s, c) => {
    assert.equal(c, '815');
    return { ids: ['888'] };
  });
  const receipt = await f.cmd('control-read', { jobId: job.jobId, action: 'resume' });
  release.resolve();
  const end = await f.done(receipt.jobId);
  assert.equal(end.steps[0].checked, 2);
  assert.deepEqual(
    f.library.read((db) =>
      db
        .prepare('SELECT id FROM works ORDER BY id')
        .all()
        .map((r) => r.id)
    ),
    ['101', '888']
  );
});
test('handoff before dispatching page two keeps its cursor, and reset requires explicit confirmation', async (t) => {
  const f = await fixture(t, { readDelay: 400 });
  f.rows((_s, c) => (c === '0' ? { ids: ['11'], next: '815' } : { ids: ['12'] }));
  const job = await f.start(total);
  assert.equal((await f.client.query('read-job', { jobId: job.jobId })).steps[0].checked, 1);
  await f.client.release();
  await f.connect();
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.cmd('control-read', { jobId: job.jobId, action: 'reset' }), /确认/);
  const reset = await f.cmd('control-read', { jobId: job.jobId, action: 'reset', confirmed: true });
  assert.notEqual(job.jobId, reset.jobId);
  assert.equal((await f.done(reset.jobId)).steps[0].checked, 2);
  assert.deepEqual(
    f.calls.map((c) => c.cursor),
    ['0', '0', '815']
  );
});
test('quick and full have independent checkpoints and resuming a superseded generation preserves newer order', async (t) => {
  const f = await fixture(t);
  let reached = Promise.withResolvers(),
    held = Promise.withResolvers();
  f.rows(async (_s, c) => {
    if (c === '0') return { ids: ['11'], next: '830' };
    reached.resolve();
    await held.promise;
    return { ids: ['99'] };
  });
  const quick = await f.start(total, { mode: 'quick', allowFullScan: true });
  await reached.promise;
  await f.cmd('control-read', { jobId: quick.jobId, action: 'stop' });
  held.resolve();
  f.rows(() => ({ ids: ['21', '11', '22'] }));
  await f.done((await f.start(total)).jobId);
  const info = (await f.client.query('state')).collectionReadInfo.__all__;
  assert.equal(info.quick.canResume, true);
  f.rows((_s, c) => {
    assert.equal(c, '830');
    return { ids: ['22', '21', '23'] };
  });
  await f.cmd('control-read', { jobId: quick.jobId, action: 'resume' });
  const end = await f.done(quick.jobId);
  assert.equal(end.steps[0].outcome, 'end-stale');
  const order = f.library.read((db) =>
    db
      .prepare(
        "SELECT work_id FROM source_members WHERE source_id='total' ORDER BY order_generation DESC,position"
      )
      .all()
      .map((r) => r.work_id)
  );
  assert.deepEqual(order, ['21', '11', '22', '23']);
});
test('resuming a standalone total can follow independently paused folders at their own NAS cursors', async (t) => {
  const f = await fixture(t);
  await f.discover();
  f.rows((_s, c) => {
    if (c === '0') return { ids: ['101'], next: '801' };
    throw Error('fixture stop');
  });
  const main = await f.start(total);
  await f.done(main.jobId);
  const prior = await f.start(folder);
  const partial = await f.done(prior.jobId);
  const offset = f.calls.length;
  f.rows((_s, c) => {
    assert.equal(c, '801');
    return { ids: ['102'] };
  });
  await f.cmd('control-read', { jobId: main.jobId, action: 'resume', followFolders: true });
  const result = await f.done(main.jobId);
  assert.equal(result.steps.length, 2);
  assert.equal(result.status, 'complete');
  assert.equal(result.steps[1].token, partial.steps[0].token);
  assert.deepEqual(
    f.calls.slice(offset).map((c) => [c.source.kind, c.cursor]),
    [
      ['total', '801'],
      ['collection', '801']
    ]
  );
  assert.equal(
    (await f.client.query('read-job', { jobId: prior.jobId })).steps[0].token,
    partial.steps[0].token
  );
});
for (const initial of [true, false]) {
  test('reset total uses newly confirmed folder selection, originally linked=' + initial, async (t) => {
    const f = await fixture(t);
    await f.discover();
    f.rows(() => {
      throw Error('paused');
    });
    const job = await f.start(total, { followFolders: initial ? ['77'] : [] });
    const previous = await f.done(job.jobId);
    f.rows(() => ({ ids: ['101'] }));
    const cmd = {
      jobId: job.jobId,
      stepId: previous.steps[0].token,
      source: total,
      action: 'reset',
      confirmed: true,
      followFolders: initial ? [] : ['77']
    };
    const id = randomUUID();
    const reset = await f.cmd('control-read', cmd, id);
    assert.deepEqual(await f.cmd('control-read', cmd, id), reset);
    assert.deepEqual(
      (await f.done(reset.jobId)).steps.map((s) => s.scope),
      initial ? ['__all__'] : ['__all__', '77']
    );
  });
}
test('resuming the second failed folder reads only that source using the selected checkpoint', async (t) => {
  const f = await fixture(t);
  f.source.discoverFolders = async () => ['77', '78', '79'].map((id) => ({ id, name: id, count: 1 }));
  await f.discover();
  await f.cmd('add-folders', { ids: ['78', '79'] });
  f.rows((s, c) => {
    if (c === '0') return { ids: [s.id], next: '501' };
    throw Object.assign(Error('夹页无效'), { code: 'SOURCE_PAGE_INVALID', status: 409 });
  });
  const job = await f.start(total, { allAdded: true }),
    before = await f.done(job.jobId),
    b = before.steps[1];
  const payload = {
    jobId: job.jobId,
    source: { kind: 'collection', id: '78' },
    stepId: b.token,
    action: 'resume'
  };
  await assert.rejects(f.cmd('control-read', { ...payload, stepId: before.steps[0].token }));
  f.rows(() => ({ ids: ['201'] }));
  const offset = f.calls.length;
  await f.cmd('control-read', payload);
  const after = await f.done(job.jobId);
  assert.deepEqual(
    f.calls.slice(offset).map((c) => [c.source.id, c.cursor]),
    [['78', '501']]
  );
  assert.deepEqual(
    after.steps.map((s) => s.status),
    ['failed', 'complete', 'failed']
  );
});
test('review of a sharply reduced total preserves history and requires confirmation before followers', async (t) => {
  const f = await fixture(t);
  await f.discover();
  f.rows(() => ({ ids: Array.from({ length: 30 }, (_, i) => String(101 + i)) }));
  await f.done((await f.start(total)).jobId);
  f.rows(() => ({ ids: ['101'] }));
  const job = await f.start(total, { followFolders: ['77'] });
  assert.equal((await f.done(job.jobId)).status, 'review');
  assert.equal(f.calls.filter((c) => c.source.kind === 'collection').length, 0);
  await assert.rejects(f.cmd('control-read', { jobId: job.jobId, action: 'resume' }), /确认/);
  await f.cmd('control-read', { jobId: job.jobId, action: 'confirm' });
  assert.equal((await f.done(job.jobId)).status, 'complete');
  assert.equal(
    f.library.read(
      (db) => db.prepare("SELECT count(*) n FROM source_members WHERE source_id='total'").get().n
    ),
    30
  );
});
test('author selection commits exactly the requested prefix even if the official page exceeds count, then resumes retained remainder', async (t) => {
  const f = await fixture(t),
    id = 'MS4wLjABsynthetic001';
  f.source.lookupAuthor = async () => ({ id, uid: '88', name: '作者' });
  await f.client.call('source/author', { text: 'https://www.douyin.com/user/' + id });
  f.rows(() => ({ ids: ['101', '102', '103', '104', '105'] }));
  const job = await f.start({ kind: 'author', id }, { mode: 'partial', limit: 2 });
  const part = await f.done(job.jobId);
  assert.equal(part.steps[0].checked, 2);
  assert.equal(part.steps[0].outcome, 'limit');
  assert.equal(part.steps[0].scope, 'author:' + id);
  assert.equal(part.status, 'paused');
  assert.equal(
    f.library.read((db) => db.prepare('SELECT count(*) n FROM works').get().n),
    2
  );
  await f.cmd('control-read', { jobId: job.jobId, action: 'resume', limit: 2 });
  assert.equal((await f.done(job.jobId)).steps[0].checked, 4);
  await f.cmd('control-read', { jobId: job.jobId, action: 'resume', readAll: true });
  const end = await f.done(job.jobId);
  assert.equal(end.status, 'complete');
  assert.equal(end.steps[0].checked, 5);
  assert.equal(f.calls.length, 1);
});
test('required archive handoff, ordinary folder errors, changed UID and new-scope memberships are distinguished', async (t) => {
  const f = await fixture(t);
  f.source.discoverFolders = async () => ['77', '78'].map((id) => ({ id, name: id, count: 1 }));
  await f.discover();
  await f.cmd('add-folders', { ids: ['78'] });
  const first = await f.done((await f.start(total)).jobId);
  assert.equal(first.steps[0].newWorks, 1);
  f.rows((s) => {
    if (s.id === '77')
      throw Object.assign(Error('夹内容不完整'), { status: 409, code: 'SOURCE_PAGE_INVALID' });
    return { ids: [A] };
  });
  const batch = await f.done((await f.start(total, { allAdded: true })).jobId);
  assert.equal(batch.status, 'partial');
  assert.equal(batch.steps[0].status, 'failed');
  assert.equal(batch.steps[1].newWorks, 0);
  assert.equal(batch.steps[1].added, 1);
  f.rows(() => {
    throw Object.assign(Error('账号已变化'), { status: 409, code: 'SOURCE_AUTH' });
  });
  const before = f.calls.length;
  await f.done((await f.start(total, { allAdded: true })).jobId);
  assert.equal(f.calls.length, before + 1);
});
test('directory pagination rejects ambiguous status, cycles and untrusted share redirects', async () => {
  const { discoveryReads, resolveWorkLink } = await import('../../server/read-sources.mjs');
  const { signal } = new AbortController();
  let mode = 'ok',
    requests = [];
  const source = discoveryReads(async (_, request, parse) => {
    const c = new URL(request.url).searchParams.get('cursor');
    requests.push(c);
    return parse({
      status: mode === 'unavailable' ? 503 : 200,
      text: JSON.stringify({
        has_more: mode === 'cycle' || c === '0',
        cursor: mode === 'cycle' ? '0' : '59',
        collects_list: [{ collects_id: c === '0' ? A : '77', collects_name: '夹' }]
      })
    });
  });
  const result = await source.discoverFolders({ signal });
  assert.deepEqual(
    result.map((r) => r.id),
    [A, '77']
  );
  assert.deepEqual(requests, ['0', '59']);
  mode = 'cycle';
  await assert.rejects(source.discoverFolders({ signal }));
  mode = 'unavailable';
  await assert.rejects(source.discoverFolders({ signal }));
  let hops = 0;
  const redirect = async () => {
    hops++;
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
  };
  await assert.rejects(resolveWorkLink('https://v.douyin.com/sample', signal, redirect));
  assert.equal(hops, 1);
  assert.equal(
    await resolveWorkLink(
      'https://v.douyin.com/sample',
      signal,
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://www.douyin.com/note/' + A } })
    ),
    A
  );
});
test('old summaries with restoration counts expose only evidence the old log actually stored', async (t) => {
  const f = await fixture(t),
    token = randomUUID();
  f.library.write((db) =>
    db.prepare('INSERT INTO read_legacy_runs VALUES(?,?,?)').run(
      token,
      '2025-10-01',
      JSON.stringify({
        name: '旧资料',
        source: 'collection',
        mode: 'full',
        status: 'complete',
        restored: 3
      })
    )
  );
  const history = await f.client.query('history-runs', { page: 1 });
  assert.equal(history.items[0].restored, 3);
  assert.equal(history.items[0].legacy, true);
  assert.equal(history.items[0].added, undefined);
  const restored = await f.client.query('history-items', { runId: token, kind: 'restored', page: 1 });
  assert.equal(restored.total, 0);
  assert.deepEqual(restored.items, []);
});
test('clear history preserves resumable runs and freezes completed run counts across later membership changes', async (t) => {
  const f = await fixture(t);
  f.rows((_s, c) => {
    if (c === '0') return { ids: ['11'], next: '90' };
    throw Error('pause');
  });
  const j = await f.start(total);
  await f.done(j.jobId);
  await f.cmd('clear-read-history', {});
  assert.equal((await f.client.query('history-runs', {})).total, 1);
  f.rows(() => ({ ids: ['12'] }));
  await f.cmd('control-read', { jobId: j.jobId, action: 'resume' });
  const r = await f.done(j.jobId);
  assert.equal(r.steps[0].historyCount, 2);
  f.rows(() => ({ ids: ['11', '12', '13'] }));
  await f.done((await f.start(total)).jobId);
  assert.equal((await f.client.query('read-job', { jobId: j.jobId })).steps[0].historyCount, 2);
  await f.cmd('clear-read-history', {});
  assert.equal((await f.client.query('history-runs', {})).total, 0);
});
test('author terminal shrink completes with warning and preserves the prior reliable baseline', async (t) => {
  const f = await fixture(t),
    id = 'MS4wLjABsynthetic001',
    source = { kind: 'author', id };
  f.source.lookupAuthor = async () => ({ id, uid: '88', name: '作者' });
  await f.client.call('source/author', { text: 'https://www.douyin.com/user/' + id });
  f.rows(() => ({ ids: Array.from({ length: 30 }, (_, i) => String(100 + i)) }));
  const base = await f.done((await f.start(source)).jobId);
  f.rows(() => ({ ids: ['110'] }));
  const small = await f.done((await f.start(source)).jobId);
  assert.equal(small.status, 'complete');
  assert.equal(small.steps[0].warning, true);
  assert.equal(small.steps[0].notReturned, 29);
  const newer = await f.done((await f.start(source)).jobId);
  assert.equal(
    f.library.read(
      (db) => db.prepare('SELECT anchor_run FROM read_steps WHERE id=?').get(newer.steps[0].token).anchor_run
    ),
    base.steps[0].token
  );
});
for (const [action, method] of [
  ['folders', 'discoverFolders'],
  ['author', 'lookupAuthor']
]) {
  test(
    'stop cancels ' + action + ' before there is a read job, even when provider finishes late',
    async (t) => {
      const f = await fixture(t),
        entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      let stopped;
      f.source[method] = async ({ signal }) => {
        stopped = signal;
        entered.resolve();
        await release.promise;
        return action === 'author'
          ? { id: 'MS4wLjABsynthetic001', uid: '81', name: 'late' }
          : [{ id: '77', name: 'late' }];
      };
      const operationId = randomUUID();
      await f.client.call('source/begin', { operationId, action });
      const pending = f.client.call('source/' + action, {
        operationId,
        text: 'https://www.douyin.com/user/MS4wLjABsynthetic001'
      });
      await entered.promise;
      const observed = assert.rejects(pending, /停止/);
      await f.client.call('source/stop', { operationId });
      assert.equal(stopped.aborted, true);
      await observed;
      release.resolve();
      await delay(5);
      assert.equal(
        f.library.read((db) => db.prepare('SELECT count(*) n FROM read_sources').get().n),
        0
      );
      await assert.rejects(f.client.call('source/' + action, { operationId }), /停止/);
    }
  );
}
test('active discovery excludes resume, confirm and reset while stop remains available', async (t) => {
  const f = await fixture(t);
  f.rows(() => {
    throw Error('paused');
  });
  const previous = await f.done((await f.start(total)).jobId);
  const operationId = randomUUID();
  await f.client.call('source/begin', { operationId, action: 'folders' });
  for (const action of ['resume', 'reset', 'confirm']) {
    await assert.rejects(
      f.cmd('control-read', { jobId: previous.jobId, action, confirmed: true }),
      /已有来源读取/
    );
  }
  await f.cmd('control-read', { jobId: previous.jobId, action: 'stop' });
  await f.client.call('source/stop', { operationId });
  f.rows(() => ({ ids: ['11'] }));
  await f.cmd('control-read', { jobId: previous.jobId, action: 'resume' });
  assert.equal((await f.done(previous.jobId)).status, 'complete');
});
test('work import is an idempotent NAS job and does not create a favorite relation', async (t) => {
  const f = await fixture(t);
  const url = 'https://www.douyin.com/video/' + A;
  await assert.rejects(f.client.call('source/resolve-work', { text: 'https://evil.invalid/video/' + A }));
  const source = await f.client.call('source/resolve-work', { text: '分享 ' + url });
  assert.deepEqual(source, { kind: 'link', id: A });
  let detailReads = 0;
  f.source.readDetail = async ({ workId }) => {
    detailReads++;
    return parseSourceDetail({
      workId,
      status: 200,
      observedAt: new Date().toISOString(),
      text: JSON.stringify({
        aweme_detail: {
          aweme_id: workId,
          item_title: '分享作品',
          video: { cover: { url_list: ['https://p3.douyinpic.com/private-signature'] } },
          author: { uid: '81', nickname: '样本' }
        }
      })
    });
  };
  const run = await f.done((await f.start(source)).jobId);
  assert.equal(run.status, 'complete');
  assert.equal(run.steps[0].added, 1);
  assert.equal(detailReads, 1);
  assert.equal(
    f.library.read((db) => db.prepare('SELECT count(*) n FROM source_members').get().n),
    0
  );
  const detail = await f.client.query('work-detail', { id: A });
  assert.equal(detail.name, '分享作品');
  assert.doesNotMatch(JSON.stringify(detail), /private-signature/);
  assert.match(
    f.library.read((db) => db.prepare('SELECT body FROM works WHERE id=?').get(A).body),
    /private-signature/
  );
});
test('failed total and required archive finalization never dispatch a linked folder', async (t) => {
  const f = await fixture(t);
  await f.discover();
  f.rows(() => {
    throw Error('offline error');
  });
  const failed = await f.done((await f.start(total, { followFolders: ['77'] })).jobId);
  assert.notEqual(failed.status, 'complete');
  assert.equal(f.calls.filter((c) => c.source.kind === 'collection').length, 0);
  f.rows(() => ({ ids: [A] }));
  await f.done((await f.start(total)).jobId);
  f.library.write((db) =>
    db.prepare('INSERT INTO media_files VALUES(?,?,?,?,?)').run('file', A, 'archive.mp4', 1, 'a'.repeat(64))
  );
  const gated = await f.done((await f.start(total, { followFolders: ['77'] })).jobId);
  assert.equal(gated.status, 'finalizing');
  const child = { jobId: gated.jobId, stepId: gated.steps[1].token, source: folder };
  for (const action of ['reset', 'resume', 'confirm'])
    await assert.rejects(f.cmd('control-read', { ...child, action, confirmed: true }), /总收藏/);
  assert.equal(f.calls.filter((c) => c.source.kind === 'collection').length, 0);
});
