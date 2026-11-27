import { setImmediate as nextTurn } from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { catalogueRevision, confirmedSelection } from './catalogue.mjs';
import { withWorkFiles } from './files.mjs';
import {
  inventoryReasons,
  inspectInventory,
  saveInventoryState,
  knownKey
} from './maintenance-inventory.mjs';
import { recordedWork } from './download-store.mjs';
import { displayCover, mediaList } from './media.mjs';
import { wantedResources } from './downloads.mjs';
import { downloadScope, summarizeRepairJobs } from './maintenance-queue.mjs';
import { failure } from './service-error.mjs';

const invalid = () => failure(400, 'INVALID_CHECK', '检查范围或参数无效。');
const stale = () => failure(409, 'CHECK_CHANGED', '检查结果或资料库已变化，请刷新并重新选择。');
const reasons = {
  ...inventoryReasons,
  NAS_DOWNLOAD_FAILED: '下载未完成，请在下载管理查看原因并重试。',
  NAS_CLEANUP_PENDING: '下载暂存尚待清理，请在下载管理核对。',
  NAS_REGISTRATION_PENDING: '归档登记未完成，请在下载管理重试。',
  SOURCE_ACCESS_DENIED: '来源拒绝访问，请核对当前账号后重试。',
  SOURCE_AUTH: '来源拒绝访问，请重新核对登录或人工验证。',
  SOURCE_TIMEOUT: '来源响应超时，保留最近一次已核验状态。',
  SOURCE_CHANGED: '核验期间作品或来源状态已改变，请重新核验。',
  SOURCE_RATE_LIMITED: '来源限流，请稍后继续核验。',
  SOURCE_UNKNOWN: '暂时无法核验该作品，请检查来源账号及网络。',
  SOURCE_UNAVAILABLE: '来源已确认不可用，已保留作品、归属及媒体。',
  CHECK_INTERRUPTED: '检查已中断，可从已提交的位置继续。',
  COVER_DISPLAY_FAILED: '客户端显示封面失败，请重新加载并核对 NAS 文件。',
  REPAIR_FAILED: '补齐未入队，请核对账号、原文件及下载记录。'
};
const message = (code) => reasons[code] ?? reasons.NAS_FILE_OPERATION;
const issue = (code, stage, key) => ({ code, stage, ...(key && { key }), reason: message(code) });
const sourceState = (w) =>
  ['available', 'unavailable', 'unknown'].includes(w?.remoteState) ? w.remoteState : 'unchecked';
const pageSize = 50;
function sourceStamp(db, id) {
  return db
    .prepare(
      "SELECT json_array(json_extract(w.body,'$.remoteState'),json_extract(w.body,'$.sourceStatus'),r.token) stamp FROM works w LEFT JOIN removed_work_records r ON r.work_id=w.id WHERE w.id=?"
    )
    .get(id)?.stamp;
}
function pageNumber(page = 1) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000000) throw invalid();
  return page;
}
function owned(db, id, owner) {
  const row = db
    .prepare('SELECT * FROM maintenance_runs WHERE id=? AND account=?')
    .get(id, owner.who.accountId);
  if (!row) throw failure(404, 'CHECK_UNKNOWN', '找不到本次检查。');
  return row;
}
function addRun(db, id, kind, ids, account) {
  if (db.prepare("SELECT 1 FROM maintenance_runs WHERE state='running'").get())
    throw failure(409, 'CHECK_BUSY', '已有检查正在进行，请等待或停止。');
  db.prepare("INSERT INTO maintenance_runs(id,account,kind,state,created) VALUES(?,?,?,'running',?)").run(
    id,
    account,
    kind,
    Date.now()
  );
  const insert = db.prepare('INSERT INTO maintenance_items(run,ordinal,work_id) VALUES(?,?,?)');
  ids.forEach((work, index) => insert.run(id, index, work));
  return { id };
}
function matches(input = {}) {
  const sql = [],
    args = [];
  for (const [name, field, values] of [
    ['fileStatus', '$.fileStatus', ['pending', 'blocked', 'complete', 'queued', 'failed']],
    ['sourceStatus', '$.sourceStatus', ['available', 'unknown', 'unavailable', 'unchecked']]
  ]) {
    if (!input[name] || input[name] === 'all') continue;
    if (!values.includes(input[name])) throw invalid();
    sql.push("json_extract(result,'" + field + "')=?");
    args.push(input[name]);
  }
  if (input.stage && input.stage !== 'all') {
    if (!['source', 'files', 'download', 'registration', 'cleanup', 'cover'].includes(input.stage))
      throw invalid();
    sql.push("EXISTS(SELECT 1 FROM json_each(result,'$.issues') WHERE json_extract(value,'$.stage')=?)");
    args.push(input.stage);
  }
  return { where: sql.length ? ' AND ' + sql.join(' AND ') : '', args };
}
function checkedSelection(db, s, owner, repairOnly = false) {
  if (
    !s ||
    !Array.isArray(s.ids) ||
    s.ids.length > 10000 ||
    new Set(s.ids).size !== s.ids.length ||
    s.ids.some((x) => !/^\d{1,40}$/.test(x)) ||
    typeof s.all !== 'boolean'
  )
    throw invalid();
  const run = owned(db, s.id, owner);
  if (run.version !== s.version || s.revision !== catalogueRevision(db) || run.state === 'running')
    throw stale();
  const { where, args } = matches(s);
  const predicate = ' FROM maintenance_items WHERE run=? AND result IS NOT NULL' + where;
  const membership = 'work_id IN (SELECT value FROM json_each(?))';
  const json = JSON.stringify(s.ids);
  if (
    db.prepare('SELECT count(*) n' + predicate + ' AND ' + membership).get(run.id, ...args, json).n !==
    s.ids.length
  )
    throw stale();
  const ids = db
    .prepare(
      'SELECT work_id' +
        predicate +
        ' AND ' +
        (s.all ? 'NOT ' : '') +
        membership +
        (repairOnly ? " AND json_extract(result,'$.repairable')=1" : '') +
        ' ORDER BY ordinal'
    )
    .all(run.id, ...args, json)
    .map((x) => x.work_id);
  return ids;
}
function jobIssues(db, id) {
  const rows = db
    .prepare(
      "SELECT j.id,j.state,json_extract(m.body,'$.cleanupPending') cleanup FROM download_jobs j LEFT JOIN download_manifests m ON m.id=j.id WHERE j.work_id=?"
    )
    .all(id);
  const issues = [];
  if (db.prepare('SELECT 1 FROM maintenance_cover_failures WHERE work_id=?').get(id))
    issues.push(issue('COVER_DISPLAY_FAILED', 'cover'));
  for (const job of rows) {
    const scope = downloadScope(job.id, id);
    if (!scope) continue;
    const add = (code, stage) => issues.push({ ...issue(code, stage), jobId: job.id, scope });
    if (job.cleanup) add('NAS_CLEANUP_PENDING', 'cleanup');
    if (job.state === 'finalization-pending') add('NAS_REGISTRATION_PENDING', 'registration');
    else if (
      ['failed', 'review', 'waiting-rate', 'waiting-auth'].includes(job.state) ||
      (job.state === 'unavailable' && sourceState(recordedWork(db, id)) === 'available')
    )
      add('NAS_DOWNLOAD_FAILED', 'download');
  }
  if (db.prepare('SELECT 1 FROM archive_state WHERE work_id=? AND revision<>completed').get(id))
    issues.push({ ...issue('NAS_REGISTRATION_PENDING', 'registration'), scope: 'archive' });
  return issues;
}
async function files(downloads, id, signal) {
  const { store, layout } = downloads,
    work = recordedWork(store.db, id);
  if (!work) throw stale();
  const inventory = await inspectInventory({ store, layout, work, signal, wantedResources });
  const { verified, bytes } = inventory,
    issues = [...jobIssues(store.db, id), ...inventory.issues];
  const state = sourceState(work);
  if (state === 'unavailable') issues.push(issue('SOURCE_UNAVAILABLE', 'source'));
  const blocked = issues.some(
    (i) =>
      ['NAS_FILE_REVIEW', 'NAS_FILE_PATH', 'NAS_FILE_OPERATION', 'NAS_MEDIA_SET_REVIEW'].includes(i.code) ||
      (i.code === 'NAS_CLEANUP_PENDING' &&
        !issues.some((j) => j.jobId === i.jobId && j.code === 'NAS_REGISTRATION_PENDING'))
  );
  const pending = issues.some((i) =>
    ['NAS_FILE_MISSING', 'NAS_DOWNLOAD_FAILED', 'NAS_REGISTRATION_PENDING'].includes(i.code)
  );
  return {
    workId: id,
    fileStatus: blocked ? 'blocked' : pending ? 'pending' : 'complete',
    sourceStatus: state,
    repairable: pending && !blocked && state !== 'unavailable',
    verified,
    bytes,
    issues
  };
}
function repairScopes(workId, issues) {
  const scopes = new Map();
  for (const i of issues) {
    if (i.jobId) scopes.set(i.scope, { id: i.jobId, scope: i.scope, retry: true });
    else if (i.code === 'NAS_FILE_MISSING' && i.key && i.key !== 'metadata') {
      const scope = i.key === 'audio' ? 'audio' : i.key === 'cover-hd' ? 'cover-hd' : 'media';
      const current = scopes.get(scope);
      if (!current)
        scopes.set(scope, {
          id: scope === 'audio' ? 'audio:' + workId : scope === 'cover-hd' ? 'hd:' + workId : workId,
          scope,
          missing: true
        });
      else current.missing = true;
    }
  }
  return [...scopes.values()];
}
function admitRepairJobs(db, downloads, run, workId, operations, issues) {
  const jobs = [];
  for (const { id, scope, retry, missing } of operations) {
    db.exec('SAVEPOINT maintenance_enqueue');
    try {
      const needsBytes =
        missing &&
        db
          .prepare(
            "SELECT 1 FROM download_manifests WHERE id=? AND json_extract(body,'$.finalizationPending')=1"
          )
          .get(id);
      const response =
        retry && !needsBytes
          ? downloads.control(db, { action: 'retry', jobId: id })
          : downloads.enqueue(
              db,
              [workId],
              { media: 'repair', audio: 'audio', 'cover-hd': 'repair-cover' }[scope]
            );
      const state = db.prepare('SELECT state FROM download_jobs WHERE id=?').get(id)?.state;
      if (
        !(response.queued || response.existing) ||
        !['queued', 'running', 'paused', 'pausing', 'awaiting-registration'].includes(state)
      )
        throw stale();
      db.prepare('INSERT INTO maintenance_queue_links VALUES(?,?,?)').run(run, workId, id);
      jobs.push({ id, scope, state });
      db.exec('RELEASE maintenance_enqueue');
    } catch {
      db.exec('ROLLBACK TO maintenance_enqueue; RELEASE maintenance_enqueue');
      jobs.push({ id, scope, state: 'failed' });
      issues.push({ ...issue('REPAIR_FAILED', 'download'), jobId: id, scope });
    }
  }
  return jobs;
}
function summary(db, r) {
  const { n, done } = db
    .prepare('SELECT count(*) n,count(result) done FROM maintenance_items WHERE run=?')
    .get(r.id);
  return {
    id: r.id,
    pendingJobs: db.prepare('SELECT count(*) n FROM maintenance_queue_links WHERE run=?').get(r.id).n,
    kind: r.kind,
    state: r.state,
    created: r.created,
    version: r.version,
    revision: catalogueRevision(db),
    total: n,
    processed: done,
    reason: r.reason ? message(r.reason) : null,
    totals: r.totals ? JSON.parse(r.totals) : null
  };
}
function getCheckPage(db, input, owner) {
  const run = owned(db, input.id, owner),
    requested = pageNumber(input.page);
  if (input.version !== undefined && run.version !== input.version) throw stale();
  const { where, args } = matches(input),
    from = ' FROM maintenance_items WHERE run=? AND result IS NOT NULL' + where;
  const count = db.prepare('SELECT count(*) n' + from).get(run.id, ...args).n;
  const pages = Math.max(1, Math.ceil(count / pageSize));
  const page = input.follow === true ? Math.min(pages, requested) : requested;
  if (page > pages) throw invalid();
  const items = db
    .prepare('SELECT result' + from + ' ORDER BY ordinal LIMIT ? OFFSET ?')
    .all(run.id, ...args, pageSize, (page - 1) * pageSize)
    .map((r) => JSON.parse(r.result));
  const byStage = db
    .prepare(
      "SELECT json_extract(j.value,'$.stage') stage,count(DISTINCT i.work_id) n FROM maintenance_items i,json_each(i.result,'$.issues') j WHERE i.run=? GROUP BY stage"
    )
    .all(run.id);
  return {
    ...summary(db, run),
    count,
    pages,
    page,
    items,
    stageCounts: Object.fromEntries(byStage.map((r) => [r.stage, r.n]))
  };
}
function problemCounts(db) {
  const rows = db
    .prepare(
      `WITH issues(work,stage) AS (
    SELECT work_id,'files' FROM maintenance_file_state
    UNION SELECT work_id,'cover' FROM maintenance_cover_failures
    UNION SELECT id,'source' FROM works WHERE json_extract(body,'$.remoteState')='unavailable'
    UNION SELECT work_id,'registration' FROM archive_state WHERE error IS NOT NULL AND revision<>completed
    UNION SELECT work_id,'registration' FROM download_jobs WHERE state='finalization-pending'
    UNION SELECT work_id,'download' FROM download_jobs WHERE state IN ('failed','waiting-rate','waiting-auth','review')
    UNION SELECT work_id,'cleanup' FROM download_manifests WHERE json_extract(body,'$.cleanupPending')=1)
    SELECT stage,count(*) n FROM issues GROUP BY stage`
    )
    .all();
  return Object.fromEntries(rows.map((r) => [r.stage, r.n]));
}
function diagnostic(db, { workId }, owner) {
  if (typeof workId !== 'string' || !/^\d{1,40}$/.test(workId)) throw invalid();
  const work = recordedWork(db, workId);
  if (!work) throw failure(404, 'WORK_UNKNOWN', '找不到作品。');
  const checks = db
    .prepare(
      'SELECT r.kind,r.created,i.result FROM maintenance_items i JOIN maintenance_runs r ON r.id=i.run WHERE i.work_id=? AND r.account=? AND i.result IS NOT NULL ORDER BY r.rowid DESC LIMIT 50'
    )
    .all(workId, owner.who.accountId)
    .map((row) => {
      const value = JSON.parse(row.result);
      const jobs = (Array.isArray(value.jobs) ? value.jobs : []).flatMap((job) => {
        const scope = downloadScope(job?.id, workId);
        if (!scope) return [];
        const state = [
          'queued',
          'paused',
          'pausing',
          'running',
          'cancelling',
          'cancelled',
          'complete',
          'failed',
          'review',
          'waiting-auth',
          'waiting-rate',
          'finalization-pending',
          'awaiting-registration',
          'unavailable'
        ].includes(job.state)
          ? job.state
          : 'unknown';
        return [{ id: job.id, scope, state }];
      });
      const issues = (Array.isArray(value.issues) ? value.issues : []).map((i) =>
        issue(
          Object.hasOwn(reasons, i?.code) ? i.code : 'NAS_FILE_OPERATION',
          ['source', 'files', 'download', 'registration', 'cleanup', 'cover'].includes(i?.stage)
            ? i.stage
            : 'files',
          knownKey(i?.key)
        )
      );
      return {
        kind: ['files', 'source', 'repair', 'reconcile'].includes(row.kind) ? row.kind : 'check',
        time: row.created,
        issues,
        ...(jobs.length && { jobs }),
        ...(['pending', 'complete', 'failed'].includes(value.registration) && {
          registration: value.registration
        }),
        fileStatus: ['complete', 'pending', 'blocked', 'failed', 'queued'].includes(value.fileStatus)
          ? value.fileStatus
          : 'unknown',
        sourceStatus: ['available', 'unavailable', 'unknown', 'unchecked'].includes(value.sourceStatus)
          ? value.sourceStatus
          : 'unknown',
        ...(Number.isSafeInteger(value.verified) && { verified: value.verified }),
        ...(Number.isSafeInteger(value.bytes) && { bytes: value.bytes })
      };
    });
  const assets = db
    .prepare(
      'SELECT a.key,m.size,m.sha256 FROM media_files m LEFT JOIN archive_assets a ON a.id=m.id WHERE m.work_id=?'
    )
    .all(workId)
    .map((a) => ({ key: knownKey(a.key), size: a.size, sha256: a.sha256 }));
  return {
    format: 1,
    workId,
    sourceStatus: sourceState(work),
    assets,
    checks,
    stages: jobIssues(db, workId)
  };
}
async function storageUsage(downloads, signal, update) {
  const { layout, store } = downloads;
  const totals = store.db
    .prepare(
      'SELECT (SELECT count(*) FROM works WHERE id NOT IN(SELECT work_id FROM removed_work_records)) works,(SELECT count(*) FROM source_members) memberships,(SELECT count(*) FROM media_files) registeredFiles,(SELECT count(*) FROM download_jobs) jobs'
    )
    .get();
  Object.assign(totals, { archiveBytes: 0, stagingBytes: 0, files: 0, links: 0 });
  const stack = [layout.media],
    seen = new Set();
  while (stack.length) {
    signal.throwIfAborted();
    layout.assertCurrent();
    const dir = stack.pop(),
      stat = await fs.lstat(dir, { bigint: true });
    if (!stat.isDirectory() || (await fs.realpath(dir)) !== dir) throw Error('directory changed');
    const handle = await fs.opendir(dir);
    for await (const entry of handle) {
      signal.throwIfAborted();
      const file = path.join(dir, entry.name),
        st = await fs.lstat(file, { bigint: true });
      if (st.isSymbolicLink()) {
        totals.links++;
        continue;
      }
      if (st.isDirectory()) {
        stack.push(file);
        continue;
      }
      if (!st.isFile()) continue;
      const key = String(st.dev) + '/' + String(st.ino);
      if (seen.has(key)) continue;
      seen.add(key);
      totals.files++;
      totals[file.startsWith(layout.staging + path.sep) ? 'stagingBytes' : 'archiveBytes'] += Number(st.size);
      if (totals.files % 128 === 0) update(totals);
    }
    const after = await fs.lstat(dir, { bigint: true });
    if (stat.dev !== after.dev || stat.ino !== after.ino || (await fs.realpath(dir)) !== dir)
      throw Error('directory changed');
    update(totals);
  }
  return totals;
}

export function createMaintenance({ library, downloads }) {
  const active = new Map();
  function startCheck(db, { payload, operationId }, owner) {
    const { kind, selection } = payload;
    if (kind === 'reconcile') {
      if (!downloads || payload.revision !== catalogueRevision(db)) throw stale();
      const ids = db
        .prepare('SELECT work_id FROM archive_state WHERE revision<>completed ORDER BY work_id')
        .all()
        .map((r) => r.work_id);
      if (!ids.length) throw failure(409, 'NO_ARCHIVE_WORK', '没有待整理的归档。');
      return addRun(db, operationId, kind, ids, owner.who.accountId);
    }
    if (!['files', 'source', 'storage'].includes(kind) || !downloads) throw invalid();
    const ids =
      kind === 'storage'
        ? []
        : selection?.id
          ? checkedSelection(db, selection, owner)
          : confirmedSelection(db, selection, owner, { collect: true });
    return addRun(db, operationId, kind, ids, owner.who.accountId);
  }
  function retryRepair(db, { operationId, payload }, owner) {
    const ids = checkedSelection(db, payload.selection, owner, true);
    if (!ids.length) throw invalid();
    return addRun(db, operationId, 'repair', ids, owner.who.accountId);
  }
  function control(db, { payload }, owner) {
    const run = owned(db, payload.id, owner);
    if (payload.action === 'stop') {
      db.prepare(
        "UPDATE maintenance_runs SET state='paused',version=version+1 WHERE id=? AND state='running'"
      ).run(run.id);
    } else if (payload.action === 'resume') {
      if (
        !['failed', 'paused'].includes(run.state) ||
        db.prepare("SELECT 1 FROM maintenance_runs WHERE state='running'").get()
      )
        throw stale();
      db.prepare("UPDATE maintenance_runs SET state='running',reason=NULL,version=version+1 WHERE id=?").run(
        run.id
      );
    } else throw invalid();
    return { id: run.id, action: payload.action };
  }
  async function run(id, session, signal) {
    const guard = (db) => {
      signal.throwIfAborted();
      const run = db.prepare('SELECT * FROM maintenance_runs WHERE id=?').get(id);
      if (run?.state !== 'running') throw stale();
      return run;
    };
    const commit = (fn) =>
      session.write((db) => {
        guard(db);
        return fn(db);
      });
    const kind = session.read((db) => guard(db).kind);
    if (kind === 'storage') {
      await storageUsage(downloads, signal, (totals) =>
        commit((db) =>
          db
            .prepare('UPDATE maintenance_runs SET totals=?,version=version+1 WHERE id=?')
            .run(JSON.stringify(totals), id)
        )
      );
    } else
      for (;;) {
        const row = session.read((db) => {
          guard(db);
          return db
            .prepare(
              'SELECT work_id FROM maintenance_items WHERE run=? AND result IS NULL ORDER BY ordinal LIMIT 1'
            )
            .get(id);
        });
        if (!row) break;
        const workId = row.work_id;
        let result,
          sourceUpdate,
          auth,
          priorSource,
          operations = [];
        if (kind === 'source') {
          priorSource = session.read((db) => sourceStamp(db, workId));
          try {
            auth = downloads.sourceAuthorization();
            const observed = await downloads.readMediaDetail(workId, auth, signal);
            if (observed?.id !== workId) throw invalid();
            const state = sourceState(observed);
            result = {
              workId,
              sourceStatus: state,
              fileStatus: 'complete',
              repairable: false,
              issues:
                state === 'available'
                  ? []
                  : [issue(state === 'unavailable' ? 'SOURCE_UNAVAILABLE' : 'SOURCE_UNKNOWN', 'source')]
            };
            if (['available', 'unavailable'].includes(state)) sourceUpdate = state;
          } catch (e) {
            signal.throwIfAborted();
            if (e.code === 'SOURCE_RATE_LIMITED') {
              commit((db) =>
                db
                  .prepare(
                    "UPDATE maintenance_runs SET state='paused',reason='SOURCE_RATE_LIMITED',version=version+1 WHERE id=?"
                  )
                  .run(id)
              );
              return;
            }
            result = {
              workId,
              sourceStatus: 'unknown',
              fileStatus: 'failed',
              repairable: false,
              issues: [
                issue(
                  ['SOURCE_ACCESS_DENIED', 'SOURCE_AUTH', 'SOURCE_TIMEOUT'].includes(e.code)
                    ? e.code
                    : 'SOURCE_UNKNOWN',
                  'source'
                )
              ]
            };
          }
        } else if (kind === 'reconcile') {
          const outcome = await downloads.archive.reconcileArchive({
            workId,
            signal,
            guard: () => session.read(guard)
          });
          const pending = !!outcome.pending;
          result = {
            workId,
            sourceStatus: sourceState(recordedWork(downloads.store.db, workId)),
            fileStatus: pending ? 'failed' : 'complete',
            repairable: false,
            issues: pending ? [issue('NAS_REGISTRATION_PENDING', 'registration')] : []
          };
        } else result = await withWorkFiles(downloads.layout, workId, () => files(downloads, workId, signal));
        if (kind === 'repair' && result.repairable) {
          operations = repairScopes(workId, result.issues);
          if (
            result.issues.some(
              (i) => i.scope === 'archive' || (i.code === 'NAS_FILE_MISSING' && i.key === 'metadata')
            )
          ) {
            if (operations.length) result.registration = 'pending';
            else {
              const outcome = await downloads.archive.reconcileArchive({
                workId,
                signal,
                guard: () =>
                  session.read((db) => {
                    guard(db);
                    if (sourceState(recordedWork(db, workId)) === 'unavailable') throw stale();
                  })
              });
              result.registration = outcome.pending ? 'failed' : 'complete';
              if (!outcome.pending)
                result.issues = result.issues.filter(
                  (i) => i.scope !== 'archive' && !(i.code === 'NAS_FILE_MISSING' && i.key === 'metadata')
                );
            }
          }
        }
        commit((db) => {
          if (kind === 'files' || kind === 'repair') {
            const mediaIssues = result.issues.filter(
              (i) => i.stage === 'files' || i.code === 'NAS_MEDIA_SET_REVIEW'
            );
            saveInventoryState(db, workId, mediaIssues);
          }
          if (sourceUpdate && sourceStamp(db, workId) !== priorSource) {
            sourceUpdate = null;
            result = {
              workId,
              sourceStatus: sourceState(recordedWork(db, workId)),
              fileStatus: 'failed',
              repairable: false,
              issues: [issue('SOURCE_CHANGED', 'source')]
            };
          }
          if (sourceUpdate) {
            const current = downloads.sourceAuthorization();
            if (
              current.sessionKey !== auth.sessionKey ||
              current.authEpoch !== auth.authEpoch ||
              current.uid !== auth.uid
            )
              throw stale();
            const record = { state: sourceUpdate, method: 'platform', checkedAt: new Date().toISOString() };
            db.prepare(
              "UPDATE works SET body=json_set(body,'$.remoteState',?,'$.sourceStatus',json(?)) WHERE id=?"
            ).run(sourceUpdate, JSON.stringify(record), workId);
            if (sourceUpdate === 'unavailable') downloads.fenceUnavailable(db, workId);
          }
          if (kind === 'repair') {
            result.queued = false;
            if (result.repairable) {
              const jobs = admitRepairJobs(db, downloads, id, workId, operations, result.issues);
              if (jobs.length)
                result = summarizeRepairJobs({
                  ...result,
                  jobs,
                  queued: jobs.some((j) => j.state !== 'failed')
                });
              else if (result.registration) {
                result.fileStatus = result.registration === 'complete' ? 'complete' : 'failed';
                result.repairable = result.registration !== 'complete';
              }
            }
          }
          db.prepare('UPDATE maintenance_items SET result=? WHERE run=? AND work_id=?').run(
            JSON.stringify(result),
            id,
            workId
          );
          db.prepare('UPDATE maintenance_runs SET version=version+1 WHERE id=?').run(id);
        });
        if (sourceUpdate === 'unavailable') downloads.stopUnavailable(workId);
        if (result.queued) void downloads.run().catch(() => {});
        await nextTurn();
      }
    commit((db) =>
      db.prepare("UPDATE maintenance_runs SET state='complete',version=version+1 WHERE id=?").run(id)
    );
  }
  function wake(receipt, session) {
    if (!['start-check', 'retry-repair', 'control-check'].includes(receipt.kind)) return;
    const id = receipt.id;
    if (receipt.action === 'stop') {
      if (
        session.read((db) => db.prepare('SELECT state FROM maintenance_runs WHERE id=?').get(id)?.state) ===
        'paused'
      )
        active.get(id)?.controller.abort();
      return;
    }
    if (active.has(id)) {
      const slot = active.get(id);
      if (slot.signal.aborted)
        void slot.task.then(() => {
          if (!session.signal.aborted) wake(receipt, session);
        });
      return;
    }
    if (
      session.read((db) => db.prepare('SELECT state FROM maintenance_runs WHERE id=?').get(id)?.state) !==
      'running'
    )
      return;
    const controller = new AbortController(),
      signal = AbortSignal.any([session.signal, controller.signal]);
    const task = nextTurn()
      .then(() => run(id, session, signal))
      .catch(() => {
        if (signal.aborted) return;
        // A replaced service or grant may no longer publish results. Acquisition pauses abandoned runs.
        try {
          session.write((db) =>
            db
              .prepare(
                "UPDATE maintenance_runs SET state='failed',reason='CHECK_INTERRUPTED',version=version+1 WHERE id=? AND state='running'"
              )
              .run(id)
          );
        } catch {}
      })
      .finally(() => active.delete(id));
    active.set(id, { task, controller, signal });
  }
  return {
    commands: {
      'start-check': startCheck,
      'retry-repair': retryRepair,
      'control-check': control,
      'cover-display': (db, { payload: { workId, failed, identity } }) => {
        if (
          typeof workId !== 'string' ||
          !/^\d{1,40}$/.test(workId) ||
          typeof failed !== 'boolean' ||
          !recordedWork(db, workId)
        )
          throw invalid();
        const cover = displayCover(mediaList(db, workId));
        if (!cover || cover.version !== identity?.version || cover.resourceId !== identity?.resourceId)
          throw stale();
        const version = JSON.stringify([cover.resourceId, cover.version]);
        const change = failed
          ? db
              .prepare(
                'INSERT INTO maintenance_cover_failures(work_id,version) VALUES(?,?) ON CONFLICT(work_id) DO UPDATE SET version=excluded.version WHERE version IS NOT excluded.version'
              )
              .run(workId, version)
          : db.prepare('DELETE FROM maintenance_cover_failures WHERE work_id=?').run(workId);
        return { workId, changed: !!change.changes };
      },
      'mark-source-unavailable': (db, { payload }) => {
        if (
          typeof payload.workId !== 'string' ||
          !/^\d{1,40}$/.test(payload.workId) ||
          payload.revision !== catalogueRevision(db)
        )
          throw stale();
        const state = { state: 'unavailable', method: 'manual', checkedAt: new Date().toISOString() };
        if (
          !db
            .prepare(
              "UPDATE works SET body=json_set(body,'$.remoteState','unavailable','$.sourceStatus',json(?)) WHERE id=?"
            )
            .run(JSON.stringify(state), payload.workId).changes
        )
          throw invalid();
        downloads?.fenceUnavailable(db, payload.workId);
        return { workId: payload.workId, sourceStatus: 'unavailable' };
      }
    },
    queries: {
      'check-page': getCheckPage,
      'work-diagnostic': diagnostic,
      'validate-check-selection': (db, s, owner) => ({ count: checkedSelection(db, s, owner).length }),
      'check-history': (db, { page = 1, kind }, owner) => {
        const offset = (pageNumber(page) - 1) * pageSize;
        if (kind !== undefined && !['files', 'source', 'storage', 'repair', 'reconcile'].includes(kind))
          throw invalid();
        const rows = db
          .prepare(
            'SELECT * FROM maintenance_runs WHERE account=?' +
              (kind ? ' AND kind=?' : '') +
              ' ORDER BY rowid DESC LIMIT ? OFFSET ?'
          )
          .all(owner.who.accountId, ...(kind ? [kind] : []), pageSize + 1, offset);
        return {
          items: rows.slice(0, pageSize).map((r) => summary(db, r)),
          hasMore: rows.length > pageSize,
          page,
          revision: catalogueRevision(db),
          ...(!kind && { problems: problemCounts(db) }),
          pendingArchive: db.prepare('SELECT count(*) n FROM archive_state WHERE revision<>completed').get().n
        };
      }
    },
    wake,
    close: () => {
      for (const slot of active.values()) slot.controller.abort();
      return Promise.allSettled([...active.values()].map((s) => s.task));
    }
  };
}
