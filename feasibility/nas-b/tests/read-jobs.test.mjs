import assert from 'node:assert/strict';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { ProbeError } from '../src/contracts.mjs';
import { createLeaseManager } from '../src/lease.mjs';
import { createReadCoordinator } from '../src/read-jobs.mjs';
import { openProbeStore } from '../src/store.mjs';
import { fakeClock, makeSandbox } from './helpers.mjs';

const total = { kind: 'total', id: '__all__' };
const folder = id => ({ kind: 'collection', id });
const author = id => ({ kind: 'author', id });
const end = { ok: true, pending: false, errors: [] };
const page = (ids, cursor = null) => ({
  status: 200,
  text: JSON.stringify({ aweme_list: ids.map(aweme_id => ({ aweme_id })), has_more: cursor === null ? 0 : 1,
    cursor: cursor ?? '0' }),
  retryAfter: 0
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check) {
  for (let tries = 0; tries < 40; tries++) {
    const value = check();
    if (value) return value;
    await setImmediate();
  }
  assert.fail('Timed out waiting for the persisted job boundary');
}

async function fixture(t, { reply = () => page(['100']), finalize = async () => end, testHooks } = {}) {
  const sandbox = await makeSandbox(t);
  const layout = await sandbox.prepare();
  const file = path.join(layout.state, 'library.sqlite');
  const clock = fakeClock();
  const calls = [];
  let next = 0;
  let authEpoch = 1;
  const gateway = {
    assertAuthEpoch(epoch) {
      if (epoch !== authEpoch) throw new ProbeError('STALE_AUTH_EPOCH', 'Changed fixture session');
    },
    async request(route, options) {
      const call = { route, ...options, cursor: options.form?.cursor ?? options.params?.cursor ?? options.params?.max_cursor };
      calls.push(call);
      gateway.assertAuthEpoch(options.authEpoch);
      return reply(call, options.beforeDispatch);
    }
  };
  const launch = (initialize = false) => {
    const store = openProbeStore({ file, libraryId: sandbox.config.libraryId, initialize, testHooks });
    sandbox.onCleanup(() => store.close());
    const leases = createLeaseManager({ store, bootId: 'fixture-boot-' + ++next, clock });
    const reads = createReadCoordinator({ store, gateway, leases, finalize, clock });
    const acquire = name => leases.acquire({ deviceId: name, instanceId: name, operationId: 'lease-' + name });
    const grant = { lease: acquire('client-' + next) };
    const opts = (lease = grant.lease) => ({ lease, authEpoch });
    const start = (source, operationId, options = {}) => reads.start({ source, operationId, mode: 'sample', ...opts(), ...options });
    const settled = id => until(() => {
      const job = reads.snapshot(id);
      return ['paused', 'stopped', 'complete', 'failed'].includes(job?.state) && job;
    });
    return { store, reads, leases, acquire, grant, opts, start, settled };
  };
  return { ...launch(true), launch, calls, clock, rotateAuth: () => ++authEpoch };
}

test('stores one active command before dispatch and replays its exact receipt', async t => {
  const hold = deferred();
  const f = await fixture(t, { reply: (_call, dispatch) => { dispatch(); return hold.promise; } });
  const job = f.start(total, 'start-total');
  await until(() => f.calls.length > 0);
  assert.equal(f.store.readJob(job.id).state, 'reading');
  assert.deepEqual(f.start(total, 'start-total'), job);
  assert.throws(() => f.start(folder('10'), 'start-total'), { code: 'PROBE_OPERATION_CONFLICT' });
  assert.throws(() => f.start(folder('10'), 'start-other'), { code: 'PROBE_READ_BUSY' });
  hold.resolve(page(['100']));
  assert.equal((await f.settled(job.id)).state, 'complete');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.start(total, 'start-total'), job);
});

test('a replacement lease waits for the dispatched page and resumes from the NAS cursor', async t => {
  const hold = deferred();
  const f = await fixture(t, { reply: (call, dispatch) => {
    dispatch();
    return call.cursor === '0' ? hold.promise : page(['200']);
  } });
  const job = f.start(total, 'start-a');
  await until(() => f.calls.length > 0);
  f.leases.release(f.grant.lease, 'release-a');
  const b = f.acquire('replacement-b');
  await until(() => f.reads.snapshot(job.id).state === 'pausing');
  assert.throws(() => f.reads.resume(job.id, 'early-b', f.opts(b)), { code: 'PROBE_READ_BUSY' });
  hold.resolve(page(['100'], '9357260389275234771'));
  assert.equal((await f.settled(job.id)).cursor, '9357260389275234771');
  assert.throws(() => f.reads.resume(job.id, 'stale-a', f.opts()), { code: 'STALE_LEASE' });
  const resumed = f.reads.resume(job.id, 'resume-b', f.opts(b));
  assert.equal(resumed.epoch, job.epoch + 1);
  assert.equal((await f.settled(job.id)).state, 'complete');
  assert.deepEqual(f.calls.map(call => call.cursor), ['0', '9357260389275234771']);
});

test('an outstanding page loses write authority when the browser account changes', async t => {
  const hold = deferred();
  const f = await fixture(t, { reply: (_call, dispatch) => { dispatch(); return hold.promise; } });
  const job = f.start(total, 'old-auth');
  await until(() => f.calls.length > 0);
  f.reads.pause(job.id, 'pause-page', f.opts());
  f.rotateAuth();
  hold.resolve(page(['100']));
  const state = await f.settled(job.id);
  assert.equal(state.reason.code, 'STALE_AUTH_EPOCH');
  assert.equal(state.reason.scope, 'global');
  assert.equal(f.store.readHead(total), null);
  assert.equal(f.store.work('100'), null);
  assert.equal(f.calls[0].authEpoch, 1);
});

test('pausing a gateway-queued page prevents its browser dispatch after lease loss', async t => {
  const queued = deferred();
  let dispatched = 0;
  const f = await fixture(t, { reply: async (_call, dispatch) => {
    await queued.promise;
    dispatch();
    dispatched++;
    return page(['100']);
  } });
  const job = f.start(total, 'start-queued');
  await until(() => f.calls.length > 0);
  f.leases.release(f.grant.lease, 'release-queued');
  queued.resolve();
  assert.equal((await f.settled(job.id)).state, 'paused');
  assert.equal(dispatched, 0);
  assert.equal(f.store.readHead(total), null);
});

test('a user stop discards a late page and leaves prior committed work and cursor intact', async t => {
  const hold = deferred();
  const f = await fixture(t, { reply: (call, dispatch) => {
    dispatch();
    return call.cursor === '0' ? page(['100'], '30') : hold.promise;
  } });
  const job = f.start(total, 'start-stop');
  await until(() => f.calls.length === 2);
  const stopped = f.reads.stop(job.id, 'user-stop', f.opts());
  assert.deepEqual(f.reads.stop(job.id, 'user-stop', f.opts()), stopped);
  assert.throws(() => f.start(folder('10'), 'next-busy'), { code: 'PROBE_READ_BUSY' });
  hold.resolve(page(['200']));
  assert.equal((await f.settled(job.id)).state, 'stopped');
  assert.equal(f.store.readHead(total).cursor, '30');
  assert.ok(f.store.work('100'));
  assert.equal(f.store.work('200'), null);
});

test('limits persist across restarts, with exact cursors and independent source relationship rows', async t => {
  const f = await fixture(t, { reply: (call, dispatch) => {
    dispatch();
    return page(['100'], call.cursor === '0' ? '30' : '60');
  } });
  const job = f.start(total, 'sample-total');
  const limited = await f.settled(job.id);
  assert.equal(limited.state, 'paused');
  assert.equal(limited.reason.code, 'PROBE_SAMPLE_LIMIT');
  assert.equal(f.store.readHead(total).terminal, false);
  assert.equal(f.store.readHead(total).cursor, '60');
  f.store.close();
  f.rotateAuth();
  const reopened = f.launch();
  assert.throws(() => reopened.reads.resume(job.id, 'retry-limit', reopened.opts()), { code: 'PROBE_SAMPLE_LIMIT' });
  assert.throws(() => reopened.start(total, 'new-total'), { code: 'PROBE_SAMPLE_LIMIT' });
  for (const [source, operationId] of [[folder('10'), 'folder-10'], [folder('20'), 'folder-20'], [author('author_one'), 'author-one']]) {
    const started = reopened.start(source, operationId);
    await reopened.settled(started.id);
    assert.equal(reopened.store.listWorks({ source }).total, 1);
  }
  assert.throws(() => reopened.start(folder('30'), 'too-many-folders'), { code: 'PROBE_SAMPLE_LIMIT' });
  assert.throws(() => reopened.start(author('author_two'), 'too-many-authors'), { code: 'PROBE_SAMPLE_LIMIT' });
  assert.deepEqual(f.calls.map(({ route, form, params, authEpoch }) => ({ route, form, params, authEpoch })), [
    ...['0', '30'].map(cursor => ({ route: '/aweme/v1/web/aweme/listcollection/', form: { cursor, count: '30' }, params: undefined, authEpoch: 1 })),
    ...['10', '20'].flatMap(id => ['0', '30'].map(cursor => ({ route: '/aweme/v1/web/collects/video/list/', form: undefined, params: { collects_id: id, cursor, count: 30 }, authEpoch: 2 }))),
    ...['0', '30'].map(cursor => ({ route: '/aweme/v1/web/aweme/post/', form: undefined, params: { sec_user_id: 'author_one', max_cursor: cursor, count: 30, locate_query: false, publish_video_strategy_type: 2 }, authEpoch: 2 }))
  ]);
});

test('a new job continues an explicitly stopped source at its previous committed cursor', async t => {
  const hold = deferred();
  let held = true;
  const f = await fixture(t, { reply: async (call, dispatch) => {
    if (call.cursor !== '0' && held) await hold.promise;
    dispatch();
    if (call.cursor === '0') return page(['100'], '30');
    return page(['90', '100']);
  } });
  const job = f.start(total, 'first-job');
  await until(() => f.calls.length === 2);
  f.reads.stop(job.id, 'stop-first', f.opts());
  hold.resolve(page([]));
  await f.settled(job.id);
  held = false;
  const continued = f.start(total, 'second-job');
  assert.equal(continued.cursor, '30');
  assert.equal((await f.settled(continued.id)).state, 'complete');
  assert.deepEqual(f.store.listWorks({ source: total }).items.map(item => item.id), ['100', '90']);
});

test('duplicate received rows count against the global whole-page budget across reopen', async t => {
  const rows = n => Array(n).fill('100');
  const f = await fixture(t, { reply: (call, dispatch) => {
    dispatch();
    if (call.route === '/aweme/v1/web/aweme/listcollection/') return page(rows(272));
    return page(rows(29));
  } });
  const totalJob = f.start(total, 'large-total');
  assert.equal((await f.settled(totalJob.id)).savedReceived, 272);
  f.store.close();
  const reopened = f.launch();
  const other = reopened.start(folder('10'), 'remaining-folder');
  const limited = await reopened.settled(other.id);
  assert.equal(limited.reason.code, 'PROBE_SAMPLE_LIMIT');
  assert.equal(limited.savedReceived, 0);
  assert.equal(reopened.store.readHead(folder('10')), null);
  assert.throws(() => reopened.start(folder('20'), 'another-folder'), { code: 'PROBE_SAMPLE_LIMIT' });
});

test('a required finalizer failure leaves a total barrier and resumes without another source read', async t => {
  let succeed = false;
  const finalizing = deferred();
  const f = await fixture(t, { reply: (_call, dispatch) => { dispatch(); return page(['100']); },
    finalize: async job => {
      if (job.source.kind !== 'total') return end;
      if (succeed) return finalizing.promise;
      return { ok: false, pending: true, errors: [{ workId: '100', code: 'NECESSARY_FILES', message: 'Fixture organization failed' }] };
    } });
  const job = f.start(total, 'finalize-total');
  const failed = await f.settled(job.id);
  assert.equal(failed.finalizationPending, true);
  assert.equal(failed.reason.code, 'PROBE_FINALIZATION_PENDING');
  assert.deepEqual(failed.finalizationErrors, [{ workId: '100', code: 'NECESSARY_FILES', message: 'Fixture organization failed' }]);
  assert.equal(f.store.readHead(total).terminal, true);
  assert.throws(() => f.start(folder('10'), 'linked-too-early', { afterTotalJobId: job.id }), { code: 'PROBE_TOTAL_PENDING' });
  f.store.close();
  const reopened = f.launch();
  succeed = true;
  const resumed = reopened.reads.resume(job.id, 'resume-finalize', reopened.opts());
  assert.equal(resumed.state, 'finalizing');
  await until(() => reopened.reads.snapshot(job.id).state === 'finalizing');
  assert.equal(f.calls.length, 1);
  finalizing.resolve(end);
  assert.equal((await reopened.settled(job.id)).state, 'complete');
  const linked = reopened.start(folder('10'), 'linked-now', { afterTotalJobId: job.id });
  assert.equal((await reopened.settled(linked.id)).state, 'complete');
  assert.equal(f.calls.length, 2);
});

test('a source-specific folder failure permits a linked successor, while access and rate limits block it', async t => {
  const f = await fixture(t, { reply: (call, dispatch) => {
    dispatch();
    if (call.params?.collects_id === '10') return { status: 200, text: '{}', retryAfter: 0 };
    if (call.params?.collects_id === '20') return { status: 429, text: '', retryAfter: 13 };
    return page(['100']);
  } });
  const totalJob = f.start(total, 'complete-total');
  await f.settled(totalJob.id);
  const link = { afterTotalJobId: totalJob.id };
  const ordinary = f.start(folder('10'), 'ordinary-folder', link);
  assert.equal((await f.settled(ordinary.id)).reason.scope, 'source');
  const limited = f.start(folder('20'), 'limited-folder', link);
  const blocked = await f.settled(limited.id);
  assert.deepEqual(blocked.reason, { code: 'PROBE_SOURCE_RATE_LIMITED', scope: 'global', retryAfter: 13 });
  assert.throws(() => f.start(folder('10'), 'further-folder', link), { code: 'PROBE_READ_BATCH_PAUSED' });
  assert.equal(f.calls.length, 3);
});

test('a page persistence failure rolls back the whole page and halts the source', async t => {
  const f = await fixture(t, { reply: (_call, dispatch) => { dispatch(); return page(['100', '101'], '30'); },
    testHooks: { afterWorkWrite() { throw new Error('Fixture failed mid-transaction'); } } });
  const job = f.start(total, 'disk-failure');
  const stopped = await f.settled(job.id);
  assert.deepEqual(stopped.reason, { code: 'PROBE_READ_STORAGE', scope: 'global' });
  assert.equal(stopped.cursor, '0');
  assert.equal(f.store.readHead(total), null);
  assert.equal(f.store.work('100'), null);
  assert.equal(f.calls.length, 1);
});

test('an error from the outstanding page cannot reopen a paused linked batch', async t => {
  const hold = deferred();
  const f = await fixture(t, { reply: (call, dispatch) => {
    dispatch();
    return call.params?.collects_id === '10' ? hold.promise : page(['100']);
  } });
  const totalJob = f.start(total, 'finish-total');
  await f.settled(totalJob.id);
  const link = { afterTotalJobId: totalJob.id };
  const first = f.start(folder('10'), 'first-linked-folder', link);
  await until(() => f.calls.length === 2);
  f.reads.pause(first.id, 'pause-first-folder', f.opts());
  hold.resolve({ status: 200, text: '{}', retryAfter: 0 });
  const paused = await f.settled(first.id);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.reason.scope, 'global');
  assert.throws(() => f.start(folder('20'), 'next-linked-folder', link), { code: 'PROBE_READ_BATCH_PAUSED' });
});

test('a returned ordinary folder finalization error preserves its checkpoint and permits the next linked folder', async t => {
  const f = await fixture(t, {
    reply: (_call, dispatch) => { dispatch(); return page(['100']); },
    finalize: async job => job.source.id === '10' ? {
      ok: false, pending: true, errors: [{ workId: '100', code: 'FOLDER_CONFLICT', message: 'Fixture organization conflict' }]
    } : end
  });
  const totalJob = f.start(total, 'final-total');
  await f.settled(totalJob.id);
  const link = { afterTotalJobId: totalJob.id };
  const first = f.start(folder('10'), 'ordinary-finalization', link);
  const failed = await f.settled(first.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.reason.scope, 'source');
  assert.equal(failed.finalizationPending, true);
  assert.equal(f.store.readHead(folder('10')).terminal, true);
  const next = f.start(folder('20'), 'next-finalization', link);
  assert.equal((await f.settled(next.id)).state, 'complete');
});

test('a folder finalization storage error blocks the rest of its linked read', async t => {
  const f = await fixture(t, {
    reply: (_call, dispatch) => { dispatch(); return page(['100']); },
    finalize: async job => job.source.id === '10' ? {
      ok: false, pending: true, errors: [{ workId: '100', code: 'ENOSPC', message: 'Fixture storage failure' }]
    } : end
  });
  const totalJob = f.start(total, 'finish-total');
  await f.settled(totalJob.id);
  const link = { afterTotalJobId: totalJob.id };
  const first = f.start(folder('10'), 'storage-finalization', link);
  assert.equal((await f.settled(first.id)).reason.scope, 'global');
  assert.throws(() => f.start(folder('20'), 'next-finalization', link), { code: 'PROBE_READ_BATCH_PAUSED' });
});

for (const [text, expected] of [
  ['{"status_code":8,"status_msg":"login required"}', 'PROBE_SOURCE_AUTH'],
  ['{"status_code":0,"status_msg":"too many requests","aweme_list":[],"has_more":0}', 'PROBE_SOURCE_RATE_LIMITED'],
  ['{', 'PROBE_SOURCE_AUTH']
]) {
  test('platform access interruption pauses the read for ' + expected + ' with no partial write', async t => {
    const f = await fixture(t, { reply: (_call, dispatch) => { dispatch(); return { status: 200, text, retryAfter: 0 }; } });
    const job = f.start(folder('10'), 'source-interruption');
    const paused = await f.settled(job.id);
    assert.equal(paused.reason.code, expected);
    assert.equal(paused.reason.scope, 'global');
    assert.equal(f.store.readHead(folder('10')), null);
  });
}

test('a new service boot resumes from the last committed cursor and fences an old worker', async t => {
  const oldPage = deferred();
  let stopped = false;
  const f = await fixture(t, { reply: async (call, dispatch) => {
    if (call.cursor !== '0' && !stopped) await oldPage.promise;
    dispatch();
    return call.cursor === '0' ? page(['100'], '30') : page(['200']);
  } });
  const started = f.start(total, 'before-crash');
  await until(() => f.calls.length === 2);
  stopped = true;
  const reopened = f.launch();
  const recovered = reopened.reads.resume(started.id, 'after-crash', reopened.opts());
  assert.equal(recovered.cursor, '30');
  assert.equal(recovered.epoch, started.epoch + 1);
  assert.equal((await reopened.settled(started.id)).state, 'complete');
  oldPage.resolve(page(['300']));
  await setImmediate();
  assert.equal(reopened.store.work('300'), null);
  assert.deepEqual(reopened.store.listWorks({ source: total }).items.map(item => item.id), ['100', '200']);
  assert.deepEqual(f.calls.map(call => call.cursor), ['0', '30', '30']);
});

test('lost page acknowledgement is recovered through its committed receipt', async t => {
  const f = await fixture(t, { reply: (call, dispatch) => {
    dispatch();
    return call.cursor === '0' ? page(['100'], '30') : page(['200']);
  }, testHooks: { afterPageCommit() { throw new Error('Fixture lost commit acknowledgement'); } } });
  const job = f.start(total, 'lost-ack');
  const complete = await f.settled(job.id);
  assert.equal(complete.state, 'complete');
  assert.equal(complete.savedPages, 2);
  assert.deepEqual(f.calls.map(call => call.cursor), ['0', '30']);
  assert.equal(f.store.operation(f.store.readHead(total).operationId).savedPages, 2);
});

test('stopping a completed total preserves the total result while preventing its linked follow-up', async t => {
  const f = await fixture(t, { reply: (_call, dispatch) => { dispatch(); return page(['100']); } });
  const totalJob = f.start(total, 'finish-total-before-stop');
  await f.settled(totalJob.id);
  const stopped = f.reads.stop(totalJob.id, 'stop-before-follow-up', f.opts());
  assert.equal(stopped.state, 'complete');
  assert.equal(stopped.finalizationPending, false);
  assert.equal(f.store.readHead(total).terminal, true);
  assert.throws(() => f.start(folder('10'), 'no-follow-up', { afterTotalJobId: totalJob.id }),
    { code: 'PROBE_READ_BATCH_PAUSED' });
  assert.equal(f.calls.length, 1);
  const independent = f.start(folder('10'), 'explicit-independent-folder');
  assert.equal((await f.settled(independent.id)).state, 'complete');
});

test('lease expiration during reservation prevents dispatch without spending a known unsent page', async t => {
  let dispatched = 0;
  let expireFirst = true;
  const f = await fixture(t, { reply: (call, dispatch) => {
    if (expireFirst) {
      expireFirst = false;
      const write = f.store.withWrite.bind(f.store);
      f.store.withWrite = callback => {
        f.store.withWrite = write;
        const result = write(callback);
        f.clock.advance(20_000);
        return result;
      };
    }
    dispatch();
    dispatched++;
    return call.cursor === '0' ? page(['100'], '30') : page(['200']);
  } });
  const job = f.start(total, 'slow-budget-reservation');
  assert.equal((await f.settled(job.id)).state, 'paused');
  assert.equal(dispatched, 0);
  assert.equal(f.store.readHead(total), null);
  const successor = f.acquire('lease-after-slow-reservation');
  f.reads.resume(job.id, 'resume-after-slow-reservation', f.opts(successor));
  assert.equal((await f.settled(job.id)).state, 'complete');
  assert.equal(dispatched, 2);
});

test('opening a new lease boot alone fences an old authorized page before the successor sends a read command', async t => {
  const hold = deferred();
  const f = await fixture(t, { reply: (_call, dispatch) => { dispatch(); return hold.promise; } });
  const job = f.start(total, 'old-page');
  await until(() => f.calls.length === 1);
  const reopened = f.launch();
  hold.resolve(page(['100'], '30'));
  await setImmediate();
  assert.equal(reopened.store.readHead(total), null);
  assert.equal(reopened.store.work('100'), null);
  assert.equal(reopened.reads.snapshot(job.id).cursor, '0');
});

test('opening a new lease boot alone fences an old asynchronous finalizer', async t => {
  const hold = deferred();
  let entered = false;
  const f = await fixture(t, {
    reply: (_call, dispatch) => { dispatch(); return page(['100']); },
    finalize: async () => { entered = true; return hold.promise; }
  });
  const job = f.start(total, 'old-finalize');
  await until(() => entered);
  const reopened = f.launch();
  hold.resolve(end);
  await setImmediate();
  assert.equal(reopened.reads.snapshot(job.id).finalizationPending, true);
  assert.equal(reopened.reads.snapshot(job.id).state, 'finalizing');
  assert.equal(f.calls.length, 1);
});

test('authorization changes during the finalizer leave necessary work pending', async t => {
  const hold = deferred();
  let entered = false;
  const f = await fixture(t, {
    reply: (_call, dispatch) => { dispatch(); return page(['100']); },
    finalize: async () => { entered = true; return hold.promise; }
  });
  const job = f.start(total, 'auth-finalizer');
  await until(() => entered);
  f.rotateAuth();
  hold.resolve(end);
  const paused = await f.settled(job.id);
  assert.equal(paused.finalizationPending, true);
  assert.equal(paused.reason.code, 'STALE_AUTH_EPOCH');
});

test('two dispatched pages exhaust a source even when stop discards the second complete response', async t => {
  const hold = deferred();
  const f = await fixture(t, { reply: (call, dispatch) => {
    dispatch();
    return call.cursor === '0' ? page(['100'], '30') : hold.promise;
  } });
  const first = f.start(total, 'first-two-pages');
  await until(() => f.calls.length === 2);
  f.reads.stop(first.id, 'discard-second', f.opts());
  hold.resolve(page(['200']));
  await f.settled(first.id);
  assert.equal(f.store.readHead(total).cursor, '30');
  assert.equal(f.store.work('200'), null);
  const reopened = f.launch();
  assert.throws(() => reopened.reads.resume(first.id, 'resume-exhausted', reopened.opts()), { code: 'PROBE_SAMPLE_LIMIT' });
  assert.throws(() => reopened.start(total, 'new-exhausted'), { code: 'PROBE_SAMPLE_LIMIT' });
});

test('rows in a structurally complete oversized envelope count despite invalid work data', async t => {
  const f = await fixture(t, { reply: (_call, dispatch) => {
    dispatch();
    return page(Array(301).fill('bad-id'));
  } });
  const job = f.start(total, 'oversized-invalid-rows');
  const paused = await f.settled(job.id);
  assert.equal(paused.reason.code, 'PROBE_SAMPLE_LIMIT');
  assert.equal(f.store.readHead(total), null);
  assert.throws(() => f.start(folder('10'), 'budget-already-spent'), { code: 'PROBE_SAMPLE_LIMIT' });
});

test('an unbounded malformed page seals the remaining row budget across restart', async t => {
  const f = await fixture(t, { reply: (_call, dispatch) => {
    dispatch();
    return { status: 200, text: '{"aweme_list":[', retryAfter: 0 };
  } });
  const job = f.start(total, 'unbounded-page');
  assert.equal((await f.settled(job.id)).reason.code, 'PROBE_SOURCE_AUTH');
  const reopened = f.launch();
  assert.throws(() => reopened.start(folder('10'), 'unproven-budget'), { code: 'PROBE_SAMPLE_LIMIT' });
});

test('an independent start cannot strand a linked source with an unresolved access interruption', async t => {
  let recovered = false;
  let holdIndependent = true;
  const queued = deferred();
  const f = await fixture(t, { reply: async (call, dispatch) => {
    if (call.params?.collects_id === '10' && holdIndependent) await queued.promise;
    dispatch();
    return call.params?.collects_id === '10' && !recovered ? { status: 429, text: '', retryAfter: 13 } : page(['100']);
  } });
  const prior = f.start(folder('10'), 'previous-independent-job');
  await until(() => f.calls.length === 1);
  f.reads.pause(prior.id, 'pause-previous-independent', f.opts());
  holdIndependent = false;
  queued.resolve();
  await f.settled(prior.id);
  const totalJob = f.start(total, 'batch-total');
  await f.settled(totalJob.id);
  const link = { afterTotalJobId: totalJob.id };
  const interrupted = f.start(folder('10'), 'linked-interrupted', link);
  assert.equal((await f.settled(interrupted.id)).reason.scope, 'global');
  assert.throws(() => f.start(folder('10'), 'independent-same-folder'), { code: 'PROBE_READ_BATCH_PAUSED' });
  assert.throws(() => f.reads.resume(prior.id, 'resume-same-folder', f.opts()), { code: 'PROBE_READ_BATCH_PAUSED' });
  const independent = f.start(author('independent-author'), 'independent-other-source');
  assert.equal((await f.settled(independent.id)).state, 'complete');
  recovered = true;
  f.reads.resume(interrupted.id, 'recover-linked-folder', f.opts());
  assert.equal((await f.settled(interrupted.id)).state, 'complete');
  const next = f.start(folder('20'), 'next-after-recovery', link);
  assert.equal((await f.settled(next.id)).state, 'complete');
});

test('a browser network failure keeps only its requested reservation and allows an independent sample', async t => {
  const fakeSecret = 'fixture-raw-driver-secret';
  const f = await fixture(t, { reply: (call, dispatch) => {
    dispatch();
    if (call.form) return page(Array(269).fill('100'));
    if (call.params?.collects_id === '10') {
      throw new ProbeError('PROBE_BROWSER_REQUEST', 'Browser driver value ' + fakeSecret);
    }
    return page(['200']);
  } });
  const totalJob = f.start(total, 'near-row-limit');
  await f.settled(totalJob.id);
  const failed = f.start(folder('10'), 'linked-transport-failed', { afterTotalJobId: totalJob.id });
  const failure = await f.settled(failed.id);
  assert.deepEqual(failure.reason, { code: 'PROBE_BROWSER_REQUEST', scope: 'source' });
  assert.equal(f.store.readHead(folder('10')), null);
  assert.equal(JSON.stringify(failure).includes(fakeSecret), false);
  assert.equal(JSON.stringify(f.store.operation('linked-transport-failed')).includes(fakeSecret), false);
  const resumed = f.launch();
  const next = resumed.start(folder('20'), 'independent-remaining-row');
  assert.equal((await resumed.settled(next.id)).state, 'complete');
  assert.equal(f.calls.at(-1).params.count, 1);
  assert.throws(() => resumed.start(author('remaining-author'), 'no-rows-left'), { code: 'PROBE_SAMPLE_LIMIT' });
});

test('a gateway-confirmed unsent page refunds its row and source dispatch reservation', async t => {
  let refuse = true;
  const f = await fixture(t, { reply: (call, dispatch) => {
    dispatch();
    if (call.form) return page(Array(269).fill('100'));
    if (refuse) {
      refuse = false;
      throw new ProbeError('PROBE_BROWSER_NOT_DISPATCHED', 'The source page changed before sending a request.');
    }
    return call.cursor === '0' ? page(['110'], '30') : page(['120']);
  } });
  const totalJob = f.start(total, 'before-refund');
  await f.settled(totalJob.id);
  const failed = f.start(folder('10'), 'unsent-source-page');
  const failure = await f.settled(failed.id);
  assert.deepEqual(failure.reason, { code: 'PROBE_BROWSER_NOT_DISPATCHED', scope: 'source' });
  assert.equal(f.store.readHead(folder('10')), null);
  f.reads.resume(failed.id, 'recover-unsent-source-page', f.opts());
  const complete = await f.settled(failed.id);
  assert.equal(complete.state, 'complete');
  assert.equal(complete.savedPages, 2);
  assert.deepEqual(f.calls.filter(call => call.params?.collects_id === '10').map(call => [call.cursor, call.params.count]), [
    ['0', 30], ['0', 30], ['30', 30]
  ]);
});

test('a received oversized browser body still seals the persisted row budget', async t => {
  const fakeSecret = 'fixture-oversized-body-content';
  const f = await fixture(t, { reply: (_call, dispatch) => {
    dispatch();
    throw new ProbeError('PROBE_BROWSER_RESPONSE_LIMIT', 'Browser driver value ' + fakeSecret);
  } });
  const job = f.start(total, 'oversized-browser-body');
  const failure = await f.settled(job.id);
  assert.deepEqual(failure.reason, { code: 'PROBE_BROWSER_RESPONSE_LIMIT', scope: 'source' });
  assert.equal(JSON.stringify(failure).includes(fakeSecret), false);
  assert.equal(f.store.readHead(total), null);
  const reopened = f.launch();
  assert.throws(() => reopened.start(folder('10'), 'blocked-oversize'), { code: 'PROBE_SAMPLE_LIMIT' });
});
