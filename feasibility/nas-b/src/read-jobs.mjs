import { randomUUID } from 'node:crypto';
import { contentHash } from '../../../shared/backup-protocol.mjs';
import { goneMessage } from '../../../shared/source-state.mjs';
import { LIMITS, ProbeError } from './contracts.mjs';
import { assertJobEpoch } from './lease.mjs';
import { parseSourcePage } from './page-parser.mjs';
import { normalizeSource } from './store.mjs';

const activeKey = 'read:active';
const receivedKey = 'read:received';
const detailKey = id => 'read:job:' + id;
const isKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sameLease = (left, right) => left && left.bootId === right.bootId && left.generation === right.generation;
const sameRun = (left, right) => sameLease(left, right) && left.jobId === right.jobId && left.epoch === right.epoch;
const error = (code, message) => new ProbeError(code, message);
const busy = () => error('PROBE_READ_BUSY', 'A read job is still active.');
const limit = () => error('PROBE_SAMPLE_LIMIT', 'The probe has reached its sample limit.');
const unknownJob = () => error('PROBE_JOB_UNKNOWN', 'The read job does not exist.');
const pauseReason = { code: 'PROBE_READ_PAUSED', scope: 'global' };
const stopReason = { code: 'PROBE_READ_STOPPED', scope: 'global' };
const authCodes = new Set(['PROBE_AUTH_REQUIRED', 'STALE_AUTH_EPOCH', 'PROBE_SOURCE_AUTH']);
const storageCode = /SQLITE|^(ENOSPC|EIO|EROFS|EPERM|EACCES|EBUSY|UNSAFE_PROBE_DB|PROBE_READ_STORAGE|PROBE_DB_OPEN_FAILED)$/;
const sourceCodes = new Set(['SOURCE_PAGE_INVALID', 'SOURCE_HTTP', 'PROBE_PAGE_CONFLICT',
  'PROBE_BROWSER_RESPONSE_LIMIT', 'PROBE_BROWSER_REQUEST', 'PROBE_BROWSER_TIMEOUT']);

function requestFor({ source, cursor }, count) {
  switch (source.kind) {
    case 'total': return ['/aweme/v1/web/aweme/listcollection/', { method: 'POST', form: { cursor, count: String(count) } }];
    case 'collection': return ['/aweme/v1/web/collects/video/list/', { params: { collects_id: source.id, cursor, count } }];
    case 'author': return ['/aweme/v1/web/aweme/post/', { params: {
      sec_user_id: source.id, max_cursor: cursor, count, locate_query: false, publish_video_strategy_type: 2
    } }];
  }
}

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM runtime_meta WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : null;
}

function putMeta(db, key, value) {
  db.prepare(`
    INSERT INTO runtime_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, JSON.stringify(value));
}

function usedRows(db) {
  return getMeta(db, receivedKey) ?? db.prepare('SELECT COALESCE(SUM(received_count),0) AS n FROM read_pages').get().n;
}

function available(db, source) {
  const remaining = LIMITS.receivedRows - usedRows(db);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM read_pages WHERE source_kind=? AND source_id=?')
    .get(source.kind, source.id);
  if (remaining <= 0 || n >= LIMITS.pagesPerSource) throw limit();
  return remaining;
}

function admitSource(db, source) {
  const sources = db.prepare('SELECT DISTINCT source_id FROM source_jobs WHERE source_kind=?').all(source.kind);
  const capacity = source.kind === 'collection' ? 2 : 1;
  if (!sources.some(row => row.source_id === source.id) && sources.length >= capacity) throw limit();
}

function assertLinkedTotal(store, id, except) {
  const total = store.readJob(id);
  if (total?.source.kind !== 'total' || total.state !== 'complete' || total.finalizationPending) {
    throw error('PROBE_TOTAL_PENDING', 'The linked total favorites job has unfinished required work.');
  }
  const interrupted = store.db.prepare(`
    SELECT j.id FROM source_jobs j JOIN runtime_meta m ON m.key='read:job:' || j.id
    WHERE json_extract(m.value,'$.afterTotalJobId')=? AND json_extract(m.value,'$.reason.scope')='global'
      AND j.id<>? LIMIT 1
  `).get(id, except ?? '');
  if (total.reason?.scope === 'global' || interrupted) {
    throw error('PROBE_READ_BATCH_PAUSED', 'The linked read is paused. Resolve the interruption before continuing.');
  }
}

function finalization(result) {
  if (typeof result?.ok !== 'boolean' || typeof result?.pending !== 'boolean' || !Array.isArray(result.errors) ||
      result.errors.some(item => typeof item?.workId !== 'string' || !isKey(item.code) || typeof item.message !== 'string')) {
    return { finished: false, errors: [{ workId: '', code: 'INVALID_PROBE_FINALIZATION', message: 'The required finalizer returned an invalid result.' }] };
  }
  return {
    finished: result.ok && !result.pending && result.errors.length === 0,
    errors: result.errors.map(({ workId, code, message }) => ({ workId, code, message: error(code, message).message }))
  };
}

function assertSourceResponse({ status, text, retryAfter }) {
  if (status === 401 || status === 403) throw error('PROBE_SOURCE_AUTH', 'Verify the source login.');
  if (status === 429) throw new ProbeError('PROBE_SOURCE_RATE_LIMITED', 'The source requested a pause.', { retryAfter });
  if (status !== 200) return;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw error('PROBE_SOURCE_AUTH', 'The source did not return a valid response. Verify the source login.');
  }
  const message = String(body?.status_msg || body?.message || body?.data?.status_msg || body?.data?.message || '');
  if (/访问太频繁|访问过于频繁|操作频繁|请求过于频繁|too many requests/i.test(message)) {
    throw new ProbeError('PROBE_SOURCE_RATE_LIMITED', 'The source requested a pause.', { retryAfter: retryAfter || 60 });
  }
  if (Number(body?.status_code || body?.data?.status_code || 0) !== 0 && !goneMessage(message)) {
    throw error('PROBE_SOURCE_AUTH', 'The source rejected access. Verify the source login.');
  }
}

function sourceReason(cause) {
  const code = cause?.code;
  if (code === 'PROBE_SAMPLE_LIMIT' || code === 'PROBE_SOURCE_RATE_LIMITED' || authCodes.has(code)) {
    return {
      code, scope: 'global',
      ...(code === 'PROBE_SOURCE_RATE_LIMITED' && Number.isFinite(cause.details?.retryAfter) ?
        { retryAfter: cause.details.retryAfter } : {})
    };
  }
  if (code === 'STALE_LEASE' || code === pauseReason.code) return pauseReason;
  return { code: sourceCodes.has(code) ? code : 'PROBE_SOURCE_UNAVAILABLE', scope: 'source' };
}

export function createReadCoordinator({ store, leases, gateway, clock = Date, finalize }) {
  let local;

  function update(db, job, state, { epoch = job.epoch, authEpoch = job.authEpoch, reason = null,
    finalizationErrors = job.finalizationErrors ?? [], finalizationPending = job.finalizationPending } = {}) {
    db.prepare(`
      UPDATE source_jobs SET state=?,epoch=?,auth_epoch=?,pause_requested=?,finalization_pending=? WHERE id=?
    `).run(state, epoch, authEpoch, Number(state === 'pausing'), Number(finalizationPending), job.id);
    putMeta(db, detailKey(job.id), { afterTotalJobId: job.afterTotalJobId ?? null, reason, finalizationErrors });
    return store.readJob(job.id);
  }

  function recover(db, lease) {
    const previous = getMeta(db, activeKey);
    if (!previous || previous.bootId === lease.bootId) return previous;
    const job = store.readJob(previous.jobId);
    if (job) {
      // A dead boot has no outstanding worker to settle. Only the NAS cursor survives.
      const stopped = job.state === 'stopping';
      update(db, job, stopped ? 'stopped' : 'paused', { reason: stopped ? stopReason : pauseReason });
    }
    putMeta(db, activeKey, null);
    return null;
  }

  function operate(kind, operationId, lease, command, change) {
    if (!isKey(operationId)) throw error('INVALID_PROBE_OPERATION', 'The read operation ID is invalid.');
    return store.withWrite(db => {
      leases.assertLease(lease);
      const commandHash = contentHash(command);
      const saved = db.prepare('SELECT kind,command_hash,body FROM operations WHERE operation_id=?').get(operationId);
      if (saved) {
        if (saved.kind !== kind || saved.command_hash !== commandHash) {
          throw error('PROBE_OPERATION_CONFLICT', 'The operation ID belongs to a different command.');
        }
        return { job: JSON.parse(saved.body).job };
      }
      const active = recover(db, lease);
      const { job, run, cancel } = change(db, active);
      const revision = store.nextRevision();
      db.prepare('INSERT INTO operations VALUES (?,?,?,?,?)')
        .run(operationId, kind, commandHash, revision, JSON.stringify({ operationId, kind, revision, job }));
      return { job, run, cancel };
    });
  }

  function claim(db, job, lease) {
    const run = { jobId: job.id, epoch: job.epoch, bootId: lease.bootId, generation: lease.generation };
    putMeta(db, activeKey, run);
    return { job, run };
  }

  function owningJob(db, run) {
    if (!sameRun(getMeta(db, activeKey), run)) throw error('STALE_JOB_EPOCH', 'The active read job changed.');
    const job = store.readJob(run.jobId);
    if (!job) throw unknownJob();
    return job;
  }

  function finish(run, state, flags) {
    return store.withWrite(db => {
      if (!sameRun(getMeta(db, activeKey), run)) return;
      const job = owningJob(db, run);
      if (job.state === 'stopping') update(db, job, 'stopped', { reason: stopReason });
      else if (job.state === 'pausing' && flags?.reason?.scope !== 'global') {
        update(db, job, 'paused', {
          ...flags, reason: pauseReason, finalizationPending: job.finalizationPending
        });
      }
      else update(db, job, state, flags);
      putMeta(db, activeKey, null);
    });
  }

  function flagLost(worker) {
    store.withWrite(db => {
      if (!sameRun(getMeta(db, activeKey), worker.run)) return;
      const job = owningJob(db, worker.run);
      if (job.state === 'reading' || job.state === 'finalizing') {
        update(db, job, 'pausing', { reason: pauseReason });
      }
    });
    if (!worker.dispatched) worker.controller?.abort();
  }

  async function collect(worker, job) {
    const { run, lease } = worker;
    const { id, source, cursor, epoch, authEpoch } = job;
    const operationId = randomUUID();
    const controller = new AbortController();
    worker.controller = controller;
    worker.dispatched = false;
    let count;
    let page;
    try {
      leases.assertLease(lease);
      gateway.assertAuthEpoch(authEpoch);
      count = Math.min(30, available(store.db, source));
      const [route, options] = requestFor(job, count);
      const reply = await gateway.request(route, {
        ...options, authEpoch, signal: controller.signal,
        beforeDispatch() {
          try {
            store.withWrite(db => {
              const current = owningJob(db, run);
              leases.assertLease(lease);
              gateway.assertAuthEpoch(authEpoch);
              assertJobEpoch(store, { jobId: id, epoch, authEpoch, inputCursor: cursor });
              if (current.state !== 'reading' || worker.dispatched) throw error(pauseReason.code, 'The read is pausing.');
              if (available(db, source) < count) throw limit();
              // A crash or unparseable response retains this conservative reservation.
              putMeta(db, receivedKey, usedRows(db) + count);
            });
          } catch (cause) {
            if (cause instanceof ProbeError) throw cause;
            throw error('PROBE_READ_STORAGE', 'The sample budget could not be reserved.');
          }
          worker.dispatched = true;
        }
      });
      if (!worker.dispatched) throw error('PROBE_READ_DISPATCH', 'The source request did not cross the dispatch fence.');
      assertSourceResponse(reply);
      page = parseSourcePage({
        source, inputCursor: cursor, status: reply.status, text: reply.text, observedAt: new Date(clock.now()).toISOString()
      });
    } catch (cause) {
      if (controller.signal.aborted) throw error(pauseReason.code, 'The read is pausing.');
      if (cause instanceof ProbeError) throw cause;
      throw error('PROBE_SOURCE_UNAVAILABLE', 'The source request could not be completed.');
    }

    // The response consumes budget even if an authorization change or stop disallows its write.
    const fits = store.withWrite(db => {
      const current = owningJob(db, run);
      const actual = usedRows(db) - count + page.receivedCount;
      putMeta(db, receivedKey, Math.min(actual, LIMITS.receivedRows));
      if (current.state === 'reading') {
        try {
          leases.assertLease(lease);
        } catch (cause) {
          if (cause?.code !== 'STALE_LEASE') throw cause;
          update(db, current, 'pausing', { reason: pauseReason });
        }
      }
      return actual <= LIMITS.receivedRows;
    });
    if (!fits) throw limit();

    try {
      store.commitPage({ jobId: id, epoch, authEpoch, operationId, page }, context => {
        const current = owningJob(store.db, run);
        assertJobEpoch(store, context);
        gateway.assertAuthEpoch(authEpoch);
        if (current.state === 'reading') leases.assertLease(lease);
        else if (current.state !== 'pausing' || !worker.dispatched) throw error(pauseReason.code, 'The read is pausing.');
        const seen = store.db.prepare(`
          SELECT 1 FROM read_pages WHERE source_kind=? AND source_id=? AND (input_cursor=? OR input_cursor=? OR digest=?)
        `).get(source.kind, source.id, cursor, page.nextCursor, page.digest);
        if (seen) throw error('PROBE_PAGE_CONFLICT', 'The source repeated an already saved page or cursor.');
      });
    } catch (cause) {
      if (store.operation(operationId)) return;
      if (cause instanceof ProbeError) throw cause;
      throw error('PROBE_READ_STORAGE', 'The source page could not be saved.');
    }
  }

  async function runJob(worker) {
    const { run, lease } = worker;
    try {
      for (;;) {
        const job = owningJob(store.db, run);
        if (job.state === 'pausing' || job.pauseRequested || job.state === 'stopping') {
          finish(run, 'paused', { reason: pauseReason });
          return;
        }
        if (job.state === 'finalizing') {
          leases.assertLease(lease);
          let result;
          let failedToSave = false;
          try {
            result = finalization(await finalize(job));
          } catch {
            failedToSave = true;
            result = {
              finished: false,
              errors: [{ workId: '', code: 'PROBE_FINALIZATION_FAILED', message: 'The required finalizer failed.' }]
            };
          }
          if (result.finished) finish(run, 'complete', { finalizationPending: false, finalizationErrors: [] });
          else {
            const global = job.source.kind === 'total' || failedToSave || result.errors.some(({ code }) => storageCode.test(code));
            finish(run, global ? 'paused' : 'failed', {
              reason: { code: 'PROBE_FINALIZATION_PENDING', scope: global ? 'global' : 'source' },
              finalizationErrors: result.errors
            });
          }
          return;
        }
        await collect(worker, job);
      }
    } catch (cause) {
      const reason = cause?.code === 'PROBE_READ_STORAGE' || !(cause instanceof ProbeError) ?
        { code: 'PROBE_READ_STORAGE', scope: 'global' } : sourceReason(cause);
      try {
        finish(run, reason.scope === 'source' ? 'failed' : 'paused', { reason });
      } catch {
        // The persisted active claim blocks new reads while storage cannot confirm a boundary.
      }
    } finally {
      worker.unsubscribe?.();
      if (local === worker) local = undefined;
    }
  }

  function deliver(result, lease) {
    if (result.run) {
      const worker = { run: result.run, lease: { ...lease }, dispatched: false };
      local = worker;
      worker.unsubscribe = leases.onLost(lost => {
        if (sameLease(lost, worker.run)) {
          try {
            flagLost(worker);
          } catch {
            worker.controller?.abort();
          }
        }
      });
      queueMicrotask(() => { void runJob(worker); });
    }
    if (result.cancel && local && sameRun(local.run, result.cancel)) {
      if (result.job.state === 'stopping' || !local.dispatched) local.controller?.abort();
    }
    return result.job;
  }

  function interrupt(id, operationId, lease, stop) {
    const kind = stop ? 'read-stop' : 'read-pause';
    return deliver(operate(kind, operationId, lease, { id }, (db, active) => {
      const job = store.readJob(id);
      if (!job) throw unknownJob();
      if (job.state === 'complete') {
        return { job: stop && job.source.kind === 'total' ? update(db, job, 'complete', { reason: stopReason }) : job };
      }
      if (job.state === 'stopped') return { job };
      if (active?.jobId === id) {
        if (job.state === 'stopping' || (!stop && job.state === 'pausing')) return { job };
        return {
          job: update(db, job, stop ? 'stopping' : 'pausing', {
            epoch: stop ? job.epoch + 1 : job.epoch, reason: stop ? stopReason : pauseReason
          }),
          cancel: active
        };
      }
      return { job: update(db, job, stop ? 'stopped' : 'paused', { reason: stop ? stopReason : pauseReason }) };
    }), lease);
  }

  return {
    start({ source, operationId, mode = 'sample', lease, authEpoch, afterTotalJobId = null }) {
      source = normalizeSource(source);
      if (mode !== 'sample' || (afterTotalJobId !== null && (source.kind !== 'collection' || !isKey(afterTotalJobId)))) {
        throw error('INVALID_PROBE_JOB', 'A valid probe sample and source are required.');
      }
      return deliver(operate('read-start', operationId, lease, { source, mode, afterTotalJobId }, (db, active) => {
        if (active) throw busy();
        if (afterTotalJobId) assertLinkedTotal(store, afterTotalJobId);
        gateway.assertAuthEpoch(authEpoch);
        admitSource(db, source);
        available(db, source);
        const head = store.readHead(source);
        if (head?.terminal) throw error('PROBE_SOURCE_TERMINAL', 'This source has a terminal page. Resume its finalization if needed.');
        const job = store.createReadJob({ source, mode, authEpoch, cursor: head?.cursor ?? '0' });
        const initial = { ...job, afterTotalJobId };
        return claim(db, update(db, initial, 'reading'), lease);
      }), lease);
    },

    resume(id, operationId, { lease, authEpoch } = {}) {
      return deliver(operate('read-resume', operationId, lease, { id }, (db, active) => {
        if (active) throw busy();
        const job = store.readJob(id);
        if (!job) throw unknownJob();
        if (!['paused', 'stopped', 'failed'].includes(job.state) || job.cursor === null && !job.finalizationPending) {
          throw error('PROBE_READ_NOT_RESUMABLE', 'The read job is not resumable.');
        }
        if (job.afterTotalJobId) assertLinkedTotal(store, job.afterTotalJobId, id);
        gateway.assertAuthEpoch(authEpoch);
        if (!job.finalizationPending) {
          available(db, job.source);
          const head = store.readHead(job.source);
          if (head && head.cursor !== job.cursor) throw error('STALE_PAGE_CURSOR', 'Another read advanced the source cursor.');
        }
        const resumed = update(db, job, job.finalizationPending ? 'finalizing' : 'reading', { epoch: job.epoch + 1, authEpoch });
        return claim(db, resumed, lease);
      }), lease);
    },

    pause: (id, operationId, { lease } = {}) => interrupt(id, operationId, lease, false),
    stop: (id, operationId, { lease } = {}) => interrupt(id, operationId, lease, true),
    snapshot: id => store.readJob(id)
  };
}
