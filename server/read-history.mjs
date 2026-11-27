import { failure } from './service-error.mjs';

const invalid = () => failure(400, 'INVALID_REQUEST', '读取记录参数无效。');
function pagination(page = 1) {
  if (!Number.isSafeInteger(page) || page < 1 || page > Math.floor(Number.MAX_SAFE_INTEGER / 50))
    throw invalid();
  return { page, offset: (page - 1) * 50 };
}
function paged(items, total, page) {
  return { items, total, page, pages: Math.max(1, Math.ceil(total / 50)) };
}
export function stepSummary(db, step, started) {
  const run = db.prepare('SELECT received,cursor,active FROM source_read_runs WHERE job_id=?').get(step.id);
  const counts = db
    .prepare(
      `SELECT count(observed) checked,count(baseline) old,
    count(CASE WHEN baseline IS NOT NULL AND observed IS NULL THEN 1 END) missing FROM source_read_items WHERE job_id=?`
    )
    .get(step.id);
  const { added, front, fill, returned, newWorks } = db
    .prepare(
      `SELECT count(CASE WHEN kind<>'returned' THEN 1 END) added,
    count(CASE WHEN kind='returned' THEN 1 END) returned,coalesce(sum(new_work),0) newWorks,count(CASE WHEN kind='front' THEN 1 END) front,
    count(CASE WHEN kind='fill' THEN 1 END) fill FROM read_differences WHERE run_id=?`
    )
    .get(step.id);
  if (step.outcome === 'imported') counts.checked = 1;
  const latest = db
    .prepare('SELECT id FROM read_steps WHERE source_id=? AND mode=? ORDER BY rowid DESC LIMIT 1')
    .get(step.source_id, step.mode);
  const restored = db.prepare('SELECT count(*) n FROM membership_restorations WHERE job_id=?').get(step.id).n;
  const pages = db
    .prepare('SELECT count(*) n FROM source_page_operations WHERE job_id=? AND result IS NOT NULL')
    .get(step.id).n;
  const scope =
    step.source_id === 'total'
      ? '__all__'
      : step.source_id.startsWith('author:')
        ? step.source_id
        : step.source_id.slice(step.source_id.indexOf(':') + 1);
  return {
    token: step.id,
    scope,
    name: step.name,
    source: step.source_id.startsWith('link:')
      ? 'link'
      : step.source_id.startsWith('author:')
        ? 'author'
        : 'collection',
    batchId: step.batch_id,
    mode: step.mode,
    status: step.status,
    batchState: step.status,
    reason: step.message,
    batchMessage: step.message,
    outcome: step.outcome,
    startedAt: started,
    checked: counts.checked,
    rawCount: run?.received ?? 0,
    pages,
    added,
    restored,
    newWorks,
    reappeared: returned,
    count: counts.checked,
    countsVersion: 2,
    existing: counts.checked - added,
    frontAdded: front,
    filled: fill,
    initialAdded: added - front - fill,
    hasPrevious: counts.old > 0,
    notReturned: ['end', 'end-warning'].includes(step.outcome) ? counts.missing : null,
    baselineKnown: !!step.baseline_known,
    historyCount: step.history_count,
    warning: step.status === 'review' || step.outcome === 'end-warning',
    canResume: latest?.id === step.id && ['paused', 'failed', 'finalizing', 'review'].includes(step.status)
  };
}
export function jobSummary(db, id, { steps = true } = {}) {
  const job = db.prepare('SELECT * FROM read_batches WHERE id=?').get(id);
  if (!job) throw failure(404, 'UNKNOWN_READ', '找不到此次读取。');
  const rows = db
    .prepare('SELECT * FROM read_history_steps WHERE history_batch=? ORDER BY history_position')
    .all(id);
  const counts = db
    .prepare(
      `SELECT count(*) restoredRelations,count(DISTINCT work_id) distinctRestoredWorks
    FROM membership_restorations WHERE job_id IN (SELECT id FROM read_history_steps WHERE history_batch=?)`
    )
    .get(id);
  const count = (s) => rows.filter((r) => s.includes(r.status)).length;
  return {
    jobId: id,
    selectedStep: job.selected_step,
    token: id,
    name: rows[0].source_id === 'total' ? '总收藏与自建收藏夹' : '自建收藏夹',
    startedAt: job.started,
    source: 'batch',
    status: job.status,
    running: job.status === 'running',
    message: job.message,
    phase: job.status === 'complete' ? 'done' : job.status,
    succeeded: count(['complete']),
    failed: count(['failed']),
    pending: count(['waiting']),
    paused: count(['paused', 'review', 'finalizing']),
    skipped: count(['skipped']),
    ...counts,
    ...(steps ? { steps: rows.map((r) => stepSummary(db, r, job.started)) } : {})
  };
}
export function historyRuns(db, { batch, page: input } = {}) {
  const { page, offset } = pagination(input);
  const stats = db
    .prepare(
      `SELECT count(*) runs, (SELECT count(*) FROM read_differences d JOIN read_steps s ON s.id=d.run_id
    JOIN read_batches b ON b.id=s.batch_id WHERE NOT b.hidden)+(SELECT count(*) FROM membership_restorations m
    JOIN read_steps s ON s.id=m.job_id JOIN read_batches b ON b.id=s.batch_id WHERE NOT b.hidden) items
    FROM read_steps s JOIN read_batches b ON b.id=s.batch_id WHERE NOT b.hidden`
    )
    .get();
  const legacy = db
    .prepare(
      "SELECT count(*) runs,(SELECT count(*) FROM read_legacy_items) items FROM read_legacy_runs WHERE json_extract(summary,'$.batchId') IS NULL"
    )
    .get();
  stats.runs += legacy.runs;
  stats.items += legacy.items;
  let total, items;
  if (batch) {
    const group = db.prepare('SELECT started FROM read_batches WHERE id=? AND NOT hidden').get(batch);
    if (!group) {
      if (
        !db
          .prepare("SELECT 1 FROM read_legacy_runs WHERE id=? AND json_extract(summary,'$.source')='batch'")
          .get(batch)
      )
        throw invalid();
      const from = " FROM read_legacy_runs WHERE json_extract(summary,'$.batchId')=?";
      total = db.prepare('SELECT count(*) n' + from).get(batch).n;
      items = db
        .prepare(
          'SELECT id,started,summary' +
            from +
            " ORDER BY json_extract(summary,'$.batchPosition'),id LIMIT 50 OFFSET ?"
        )
        .all(batch, offset)
        .map((r) => ({ ...JSON.parse(r.summary), token: r.id, startedAt: r.started, legacy: true }));
      return { ...paged(items, total, page), stats };
    }
    total = db.prepare('SELECT count(*) n FROM read_history_steps WHERE history_batch=?').get(batch).n;
    items = db
      .prepare(
        'SELECT * FROM read_history_steps WHERE history_batch=? ORDER BY history_position LIMIT 50 OFFSET ?'
      )
      .all(batch, offset)
      .map((r) => stepSummary(db, r, group.started));
  } else {
    total = db.prepare('SELECT count(*) n FROM read_batches WHERE NOT hidden').get().n + legacy.runs;
    items = db
      .prepare(
        `SELECT id,started,NULL summary FROM read_batches WHERE NOT hidden UNION ALL SELECT id,started,summary FROM read_legacy_runs WHERE json_extract(summary,'$.batchId') IS NULL ORDER BY started DESC,id LIMIT 50 OFFSET ?`
      )
      .all(offset)
      .map((b) => {
        if (b.summary) return { ...JSON.parse(b.summary), token: b.id, startedAt: b.started, legacy: true };
        const rows = db
          .prepare('SELECT * FROM read_history_steps WHERE history_batch=? ORDER BY history_position LIMIT 2')
          .all(b.id);
        return rows.length === 1
          ? stepSummary(db, rows[0], b.started)
          : jobSummary(db, b.id, { steps: false });
      });
  }
  return { ...paged(items, total, page), stats };
}
export function historyItems(db, { runId, kind = 'all', page: input } = {}) {
  const { page, offset } = pagination(input);
  if (!['all', 'restored', 'front', 'fill', 'returned', 'initial'].includes(kind)) throw invalid();
  const step = db
    .prepare(
      'SELECT s.* FROM read_steps s JOIN read_batches b ON b.id=s.batch_id WHERE s.id=? AND NOT b.hidden'
    )
    .get(runId);
  if (!step) {
    if (!db.prepare('SELECT 1 FROM read_legacy_runs WHERE id=?').get(runId))
      throw failure(404, 'UNKNOWN_READ', '找不到此次读取。');
    const filter =
      "FROM read_legacy_items WHERE run_id=? AND (?='all' OR CASE WHEN kind='fill' AND json_extract(body,'$.reappeared')=1 THEN 'returned' ELSE kind END=?)";
    const args = [runId, kind, kind];
    const total = db.prepare('SELECT count(*) n ' + filter).get(...args).n;
    const records = db
      .prepare('SELECT body ' + filter + ' ORDER BY position LIMIT 50 OFFSET ?')
      .all(...args, offset);
    return paged(
      records.map((row) => {
        const b = JSON.parse(row.body);
        return b.reappeared ? { ...b, kind: 'returned' } : b;
      }),
      total,
      page
    );
  }
  const sql = `SELECT work_id AS workId,name,position,'restored' AS kind FROM membership_restorations WHERE job_id=?
    UNION ALL SELECT work_id,name,position,kind FROM read_differences WHERE run_id=?`;
  const filtered = `FROM (${sql}) WHERE (?='all' OR kind=?)`,
    args = [runId, runId, kind, kind];
  const total = db.prepare('SELECT count(*) n ' + filtered).get(...args).n;
  const items = db
    .prepare('SELECT * ' + filtered + ' ORDER BY position,workId LIMIT 50 OFFSET ?')
    .all(...args, offset)
    .map((w) => ({ ...w, id: w.workId, reappeared: w.kind === 'returned', source: step.source_id }));
  return paged(items, total, page);
}
