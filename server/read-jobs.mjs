import { abortable } from '../electron/browser-api.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createReadStore, saveWorks, validatePage } from './read-store.mjs';
import { sourceKey } from './memberships.mjs';
import { boundIdentity, sourceFromKey } from './read-sources.mjs';
import { stepSummary, jobSummary } from './read-history.mjs';
import { collectProfiles } from './source-parser.mjs';
import { sameCreator, workCreators } from '../shared/creators.mjs';
import { failure } from './service-error.mjs';

const reject = (message = '读取参数无效。') => failure(409, 'READ_CONFLICT', message);
const findStep = (db, id) => db.prepare('SELECT * FROM read_steps WHERE id=?').get(id);
const jobRow = (db, id) => db.prepare('SELECT * FROM read_batches WHERE id=?').get(id);
const runRow = (db, id) => db.prepare('SELECT * FROM source_read_runs WHERE job_id=?').get(id);
const running = (db) => db.prepare("SELECT * FROM read_batches WHERE status='running'").get();
const batchStatus = (db, id, state, msg = '') =>
  db.prepare('UPDATE read_batches SET status=?,message=? WHERE id=?').run(state, msg, id);
function stepStatus(db, id, state, msg = '') {
  db.prepare(
    `UPDATE read_steps SET status=?,message=?,history_count=(SELECT count(*) FROM source_members WHERE source_id=read_steps.source_id)
    WHERE id=?`
  ).run(state, msg, id);
}
const currentStep = (db, id) =>
  db
    .prepare(
      "SELECT s.* FROM read_steps s JOIN read_batches b ON b.id=s.batch_id WHERE b.id=? AND (b.selected_step IS NULL OR b.selected_step=s.id) AND s.status IN ('waiting','running','paused','review','finalizing') ORDER BY ordinal LIMIT 1"
    )
    .get(id);
const localStore = (db, browser) =>
  createReadStore({ browser, session: { read: (fn) => fn(db), write: (fn) => fn(db) } });
function anchor(db, key, uid) {
  return db
    .prepare(
      `SELECT s.id FROM read_steps s JOIN read_batches b ON b.id=s.batch_id
    WHERE b.uid=? AND s.source_id=? AND s.outcome IN ('end','matched') AND s.status='complete' ORDER BY s.rowid DESC LIMIT 1`
    )
    .get(uid, key)?.id;
}
function jobSourceKey(source) {
  if (source?.kind !== 'link') return sourceKey(source);
  if (typeof source.id !== 'string' || !/^\d{1,40}$/.test(source.id) || !/[1-9]/.test(source.id))
    throw reject();
  return 'link:' + source.id;
}
function adoptable(db, source, uid) {
  if (source.startsWith('link:')) return { name: '分享作品' };
  if (source === 'total') return { name: '总收藏' };
  const row = db
    .prepare('SELECT * FROM read_sources WHERE source_id=? AND uid=? AND added=1')
    .get(source, uid);
  if (!row) throw reject('请先从当前账号的目录添加此来源。');
  return row;
}
function observedCount(db, id) {
  return db.prepare('SELECT count(observed) n FROM source_read_items WHERE job_id=?').get(id).n;
}
function authorPage(db, step, ticket, page, budget) {
  const person = JSON.parse(adoptable(db, step.source_id, runRow(db, step.id).uid).body);
  if (
    page.works.some(
      (work) => !workCreators(work).some((a) => sameCreator(a, { uid: person.uid, secUid: person.id }))
    )
  )
    throw failure(409, 'AUTHOR_MISMATCH', '此页含无法核实作者身份的作品，已保留断点。');
  const saved = db.prepare('SELECT * FROM read_page_buffers WHERE run_id=?').get(step.id);
  const cursor = page.inputCursor,
    offset = saved?.offset ?? 0;
  if (!saved) validatePage(ticket, page);
  const known = db.prepare('SELECT observed FROM source_read_items WHERE job_id=? AND work_id=?');
  let remaining = budget ?? Infinity,
    end = page.receivedCount;
  for (const r of page.refs) {
    if (r.rank < offset || known.get(step.id, r.workId)?.observed != null) continue;
    if (remaining === 0) {
      end = r.rank;
      break;
    }
    remaining--;
  }
  if (!saved && end === page.receivedCount) return page;
  const more = end < page.receivedCount;
  const refs = page.refs
    .filter((r) => r.rank >= offset && r.rank < end)
    .map((r) => ({ ...r, rank: r.rank - offset }));
  const ids = new Set(refs.map((r) => r.workId)),
    works = page.works.filter((w) => ids.has(w.id));
  if (more)
    db.prepare(
      `INSERT INTO read_page_buffers VALUES(?,?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET offset=excluded.offset`
    ).run(step.id, cursor, end, ticket.removalRevision, JSON.stringify(page));
  else db.prepare('DELETE FROM read_page_buffers WHERE run_id=?').run(step.id);
  return {
    ...page,
    inputCursor: ticket.inputCursor,
    nextCursor: more ? cursor + '@' + end : page.nextCursor,
    terminal: !more && page.terminal,
    receivedCount: end - offset,
    uniqueCount: works.length,
    refs,
    works,
    aux: {
      creatorProfiles: collectProfiles(works),
      audioSourceHints: page.aux.audioSourceHints.filter((h) => ids.has(h.workId))
    }
  };
}
function publishAnchors(db, step) {
  const add = db.prepare('INSERT OR IGNORE INTO read_anchors VALUES(?,?,?)');
  let pos = 0;
  for (const item of db
    .prepare(
      'SELECT work_id FROM source_read_items WHERE job_id=? AND observed IS NOT NULL ORDER BY observed'
    )
    .iterate(step.id))
    add.run(step.id, item.work_id, pos++);
  if (step.outcome === 'matched' && step.anchor_run)
    for (const item of db
      .prepare('SELECT work_id FROM read_anchors WHERE run_id=? AND position>? ORDER BY position')
      .iterate(step.anchor_run, step.last_anchor))
      add.run(step.id, item.work_id, pos++);
}
// Task 09 retires this exact operation only after verified archive placement
// and JSON persistence. A later observation invalidates earlier completion.
function queueArchiveFinalizer(db, runId, workId, operationId) {
  db.prepare(
    `INSERT INTO read_finalizers(run_id,work_id,operation_id)
    SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM media_files WHERE work_id=?)
    ON CONFLICT(run_id,work_id) DO UPDATE SET operation_id=excluded.operation_id,status='pending'`
  ).run(runId, workId, operationId, workId);
}
function unfinishedArchive(db, step) {
  return db
    .prepare(
      `SELECT 1 FROM read_finalizers f JOIN read_steps s ON s.id=f.run_id
    WHERE s.source_id=? AND f.status<>'complete' LIMIT 1`
    )
    .get(step.source_id);
}
function finishStep(db, step) {
  if (unfinishedArchive(db, step)) {
    stepStatus(db, step.id, 'finalizing', '等待 NAS 核对归档目录并更新作品信息 JSON。');
    batchStatus(db, step.batch_id, 'finalizing', '必要整理尚未完成。');
    return;
  }
  if (step.superseded) {
    db.prepare("UPDATE read_steps SET outcome='end-stale' WHERE id=?").run(step.id);
  } else if (['end', 'matched'].includes(step.outcome)) publishAnchors(db, step);
  db.prepare('UPDATE source_read_runs SET active=0 WHERE job_id=?').run(step.id);
  stepStatus(
    db,
    step.id,
    'complete',
    step.outcome === 'end-warning'
      ? '作者主页返回明显减少，保留已有记录及历史对照。'
      : step.outcome === 'matched'
        ? '连续匹配历史顺序，检查完成。'
        : '已到当前可访问列表末尾。'
  );
}
function includeResumeFolders(db, job, step, options) {
  if (step.source_id !== 'total') throw reject('只能从总收藏跟进自建夹。');
  const folders = db
    .prepare(
      "SELECT * FROM read_sources WHERE uid=? AND added=1 AND missing=0 AND source_id LIKE 'folder:%' ORDER BY rowid"
    )
    .all(job.uid);
  const children = db
    .prepare('SELECT source_id FROM read_steps WHERE batch_id=? ORDER BY ordinal')
    .all(job.id);
  const included = new Set(children.map((s) => s.source_id));
  let ordinal = children.length;
  for (const f of folders) {
    if (included.has(f.source_id)) continue;
    const base = anchor(db, f.source_id, job.uid);
    if (step.mode === 'quick' && !base && !options.allowFullScan)
      throw reject('自建夹没有完整历史对照，请先确认可能读到末尾。');
    db.prepare(
      `INSERT INTO read_steps(id,batch_id,ordinal,source_id,name,mode,status,baseline_known,anchor_run,resume_folder)
      VALUES(?,?,?,?,?,?,'waiting',?,?,1)`
    ).run(randomUUID(), job.id, ordinal++, f.source_id, f.name, step.mode, base ? 1 : 0, base ?? null);
  }
  db.prepare(
    "UPDATE read_steps SET resume_folder=1 WHERE batch_id=? AND status='waiting' AND source_id LIKE 'folder:%'"
  ).run(job.id);
}
function adoptFolderCheckpoint(db, job, step, account, store) {
  // The former batch keeps a reference. The run, page receipts, durable cursor
  // and restoration events keep their original IDs and are never duplicated.
  const old = db
    .prepare(
      `SELECT s.* FROM read_steps s JOIN read_batches b ON b.id=s.batch_id
    JOIN source_read_runs r ON r.job_id=s.id WHERE s.source_id=? AND s.mode=? AND b.uid=?
    AND s.batch_id<>? AND r.active=1 AND s.status IN ('paused','failed','review','finalizing')
    ORDER BY r.generation DESC LIMIT 1`
    )
    .get(step.source_id, step.mode, account.uid, job.id);
  if (!old) return step;
  const run = runRow(db, old.id);
  db.prepare('INSERT INTO read_prior_batches VALUES(?,?,?)').run(old.batch_id, old.id, old.ordinal);
  db.prepare("DELETE FROM read_steps WHERE id=? AND status='waiting'").run(step.id);
  db.prepare('UPDATE read_steps SET batch_id=?,ordinal=?,resume_folder=0 WHERE id=?').run(
    job.id,
    step.ordinal,
    old.id
  );
  const other = db.prepare('SELECT 1 FROM read_steps WHERE batch_id=? LIMIT 1').get(old.batch_id);
  db.prepare(
    "UPDATE read_batches SET status='continued',message='本轮已在后续批次继续',hidden=? WHERE id=?"
  ).run(other ? 0 : 1, old.batch_id);
  if (old.status === 'review' || old.status === 'finalizing') {
    batchStatus(db, job.id, old.status, old.message);
    return null;
  }
  if (run.cursor !== null)
    store.resumeRead({
      source: sourceFromKey(step.source_id),
      jobId: old.id,
      expectedEpoch: run.job_epoch,
      jobEpoch: run.job_epoch + 1,
      authEpoch: account.authEpoch
    });
  stepStatus(db, old.id, 'running');
  return findStep(db, old.id);
}
function stopExpired(db, grant) {
  const job = running(db);
  if (job && (job.owner_boot !== grant.bootId || job.owner_generation !== grant.generation)) {
    batchStatus(db, job.id, 'paused', '控制端已离线，已保留 NAS 断点。');
    const step = currentStep(db, job.id);
    if (step) stepStatus(db, step.id, 'paused', '控制端已离线。');
  }
}
export function createReadJobs({ source, readDelay = 1100 }) {
  let live;
  function start(db, { payload: p }, { grant }) {
    const { uid, authEpoch } = boundIdentity(db, source);
    stopExpired(db, grant);
    if (running(db)) throw reject('已有读取任务正在进行。');
    if (!['quick', 'full', 'partial'].includes(p.mode)) throw reject();
    const key = jobSourceKey(p.source),
      isAuthor = key.startsWith('author:');
    if ((p.mode === 'partial' && !isAuthor) || (isAuthor && p.mode === 'quick')) throw reject();
    if (p.mode === 'partial' && (!Number.isSafeInteger(p.limit) || p.limit < 1 || p.limit > 100000))
      throw reject();
    if (key.startsWith('link:') && p.mode !== 'full') throw reject();
    let keys = [key];
    if (p.allAdded || p.followFolders === true) {
      if (key !== 'total') throw reject();
      keys = [
        ...(p.allAdded ? [] : [key]),
        ...db
          .prepare(
            "SELECT source_id FROM read_sources WHERE uid=? AND added=1 AND source_id LIKE 'folder:%' ORDER BY rowid"
          )
          .all(uid)
          .map((r) => r.source_id)
      ];
    } else if (p.followFolders !== undefined && p.followFolders !== false) {
      if (key !== 'total' || !Array.isArray(p.followFolders)) throw reject();
      keys.push(...p.followFolders.map((id) => sourceKey({ kind: 'collection', id })));
    }
    if (!keys.length || new Set(keys).size !== keys.length) throw reject();
    const jobId = randomUUID(),
      started = new Date().toISOString();
    db.prepare(
      "INSERT INTO read_batches(id,uid,auth_epoch,owner_boot,owner_generation,status,started) VALUES(?,?,?,?,?,'running',?)"
    ).run(jobId, uid, authEpoch, grant.bootId, grant.generation, started);
    for (const [ordinal, k] of keys.entries()) {
      const cat = adoptable(db, k, uid),
        prior = anchor(db, k, uid);
      if (!cat.missing && p.mode === 'quick' && !prior && p.allowFullScan !== true)
        throw reject('尚无完整历史对照，请确认可能读到末尾。');
      if (cat.missing && keys.length === 1) throw reject('此收藏夹已不在当前目录。');
      db.prepare(
        `INSERT INTO read_steps(id,batch_id,ordinal,source_id,name,mode,status,goal,baseline_known,anchor_run)
        VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(
        randomUUID(),
        jobId,
        ordinal,
        k,
        cat.name,
        p.mode,
        cat.missing ? 'skipped' : 'waiting',
        p.mode === 'partial' ? p.limit : null,
        prior ? 1 : 0,
        prior ?? null
      );
    }
    return { jobId };
  }
  function control(db, { payload: p }, { grant }) {
    stopExpired(db, grant);
    const job = jobRow(db, p.jobId);
    if (!job) throw reject();
    if (p.action === 'stop') {
      if (job.status === 'running') {
        batchStatus(db, job.id, 'paused', '已停止，进度保存在 NAS。');
        const step = currentStep(db, job.id);
        if (step) stepStatus(db, step.id, 'paused', '已停止读取。');
      }
      return { jobId: job.id };
    }
    if (
      !['resume', 'confirm', 'reset'].includes(p.action) ||
      running(db) ||
      !['paused', 'review', 'finalizing', 'partial'].includes(job.status)
    )
      throw reject();
    const account = boundIdentity(db, source);
    if (account.uid !== job.uid) throw reject('来源账号已变化。');
    let requested;
    if (p.stepId !== undefined || p.source !== undefined) {
      requested = findStep(db, p.stepId ?? '');
      if (!requested || requested.batch_id !== job.id || jobSourceKey(p.source) !== requested.source_id)
        throw reject('所选来源与 NAS 断点不符。');
    }
    const wholeBatch =
      !requested || p.followFolders === true || (p.action === 'confirm' && !job.selected_step);
    if (p.followFolders === true && requested && requested.source_id !== 'total') throw reject();
    db.prepare('UPDATE read_batches SET selected_step=? WHERE id=?').run(
      wholeBatch ? null : requested.id,
      job.id
    );
    const step =
      (requested && (!wholeBatch || p.action === 'reset') ? requested : null) ??
      currentStep(db, job.id) ??
      db
        .prepare("SELECT * FROM read_steps WHERE batch_id=? AND status='failed' ORDER BY ordinal LIMIT 1")
        .get(job.id);
    if (!step) throw reject();
    if (p.action === 'resume' && p.followFolders === true) {
      const first = db
        .prepare('SELECT * FROM read_steps WHERE batch_id=? ORDER BY ordinal LIMIT 1')
        .get(job.id);
      includeResumeFolders(db, job, first, p);
    }
    if (p.action === 'reset') {
      if (p.confirmed !== true) throw reject('请先确认从头读取。');
      const result = start(
        db,
        {
          payload: {
            source: sourceFromKey(step.source_id),
            mode: step.mode,
            limit: p.limit ?? step.goal,
            ...(step.source_id === 'total' ? { followFolders: p.followFolders ?? false } : {}),
            allowFullScan: p.allowFullScan
          }
        },
        { grant }
      );
      if (step.status !== 'complete')
        db.prepare("UPDATE read_steps SET status='stopped',message='此来源已从头读取。' WHERE id=?").run(
          step.id
        );
      const sibling = db
        .prepare(
          "SELECT 1 FROM read_steps WHERE batch_id=? AND id<>? AND status IN ('failed','paused','review','finalizing')"
        )
        .get(job.id, step.id);
      batchStatus(db, job.id, sibling ? 'partial' : 'stopped', '所选来源已从头读取。');
      return result;
    }
    if (
      requested &&
      step.status === 'waiting' &&
      db
        .prepare(
          "SELECT 1 FROM read_steps WHERE batch_id=? AND source_id='total' AND ordinal<? AND status<>'complete'"
        )
        .get(job.id, step.ordinal)
    )
      throw reject('总收藏及必要整理尚未完成。');
    if (step.outcome === 'limit') db.prepare('UPDATE read_steps SET outcome=NULL WHERE id=?').run(step.id);
    if (!['waiting', 'paused', 'failed', 'review', 'finalizing'].includes(step.status))
      throw reject('所选读取已经结束。');
    if (step.status === 'review' && p.action !== 'confirm')
      throw reject('本轮返回数量明显减少，请确认采用此次对照。');
    if (p.action === 'confirm' && step.status !== 'review') throw reject();
    if (step.status === 'finalizing' && unfinishedArchive(db, step)) throw reject('NAS 必要整理仍未完成。');
    const run = runRow(db, step.id);
    if (run) {
      if (!run.active) {
        const latest = db
          .prepare('SELECT id FROM read_steps WHERE source_id=? AND mode=? ORDER BY rowid DESC LIMIT 1')
          .get(step.source_id, step.mode);
        if (latest?.id !== step.id || step.source_id.startsWith('author:'))
          throw reject('此来源已有更新的读取，请从头核对。');
        db.prepare('UPDATE source_read_runs SET active=0 WHERE source_id=? AND active=1').run(step.source_id);
        db.prepare('UPDATE source_read_runs SET active=1 WHERE job_id=?').run(step.id);
        db.prepare('UPDATE read_steps SET superseded=1 WHERE id=?').run(step.id);
      }
      if (run.cursor !== null && !['matched', 'end'].includes(step.outcome))
        localStore(db, source).resumeRead({
          source: sourceFromKey(step.source_id),
          jobId: step.id,
          expectedEpoch: run.job_epoch,
          jobEpoch: run.job_epoch + 1,
          authEpoch: account.authEpoch
        });
    }
    if (step.mode === 'partial' && run) {
      if (p.readAll === true)
        db.prepare("UPDATE read_steps SET mode='full',goal=NULL WHERE id=?").run(step.id);
      else {
        const count = p.limit ?? 20;
        if (!Number.isSafeInteger(count) || count < 1 || count > 100000) throw reject();
        db.prepare('UPDATE read_steps SET goal=? WHERE id=?').run(
          count + observedCount(db, step.id),
          step.id
        );
      }
    }
    if (p.action === 'confirm') db.prepare("UPDATE read_steps SET outcome='end' WHERE id=?").run(step.id);
    db.prepare(
      "UPDATE read_batches SET hidden=0,status='running',owner_generation=?,owner_boot=?,auth_epoch=?,message='' WHERE id=?"
    ).run(grant.generation, grant.bootId, account.authEpoch, job.id);
    stepStatus(db, step.id, 'running');
    return { jobId: job.id };
  }
  function prepare(db, job) {
    let step = currentStep(db, job.id);
    if (!step) {
      const unfinished = db
        .prepare(
          "SELECT status FROM read_steps WHERE batch_id=? AND status IN ('waiting','paused','review','finalizing','failed') ORDER BY ordinal LIMIT 1"
        )
        .get(job.id);
      const failed = unfinished?.status === 'failed';
      if (unfinished && !failed) {
        batchStatus(db, job.id, 'paused', '所选来源已结束，其他来源进度保留。');
        return null;
      }
      batchStatus(
        db,
        job.id,
        failed ? 'partial' : 'complete',
        failed ? '部分收藏夹读取失败。' : '读取已完成。'
      );
      return null;
    }
    const { uid, authEpoch } = boundIdentity(db, source);
    if (uid !== job.uid || authEpoch !== job.auth_epoch) throw reject('来源账号已变化。');
    if (step.source_id.startsWith('link:')) {
      if (step.outcome === 'imported') {
        finishStep(db, step);
        return null;
      }
      stepStatus(db, step.id, 'running');
      return { workId: step.source_id.slice(5), stepId: step.id, authEpoch };
    }
    const store = localStore(db, source),
      scope = sourceFromKey(step.source_id);
    if (step.resume_folder && step.status === 'waiting') {
      step = adoptFolderCheckpoint(db, job, step, { uid, authEpoch }, store);
      if (!step) return null;
    }
    let run = runRow(db, step.id);
    if (!run) {
      store.startRead({ source: scope, authEpoch, jobEpoch: 1, jobId: step.id });
      run = runRow(db, step.id);
    }
    if (['end', 'end-warning', 'matched'].includes(step.outcome)) {
      finishStep(db, step);
      return null;
    }
    stepStatus(db, step.id, 'running');
    const ticket = store.prepareSourcePage({
      source: scope,
      authEpoch,
      jobEpoch: run.job_epoch,
      jobId: step.id,
      operationId: randomUUID()
    });
    const buffer = db.prepare('SELECT * FROM read_page_buffers WHERE run_id=?').get(step.id);
    if (buffer) {
      if (ticket.inputCursor !== buffer.cursor + '@' + buffer.offset) throw reject('作者分页断点已变化。');
      db.prepare('UPDATE source_page_operations SET removal_revision=? WHERE operation_id=?').run(
        buffer.removal_revision,
        ticket.operationId
      );
      ticket.removalRevision = buffer.removal_revision;
    }
    const budget = step.goal === null ? null : step.goal - observedCount(db, step.id);
    return {
      ticket,
      count: budget === null ? 30 : Math.min(30, budget),
      budget,
      page: buffer ? JSON.parse(buffer.page) : null
    };
  }
  function commit(db, ticket, page) {
    const step = findStep(db, ticket.jobId),
      run = runRow(db, step.id);
    const old = db.prepare('SELECT 1 FROM works WHERE id=?'),
      duplicate = db.prepare('SELECT observed,baseline FROM source_read_items WHERE job_id=? AND work_id=?');
    const ref = db.prepare('SELECT position FROM read_anchors WHERE run_id=? AND work_id=?');
    let { streak, streak_pages: pages, last_anchor: last } = step,
      newPage = true,
      unique = 0;
    const tombstone = db.prepare('SELECT 1 FROM membership_removals WHERE source_id=? AND work_id=?');
    const events = [];
    for (const r of page.refs) {
      const prior = duplicate.get(step.id, r.workId);
      const already = prior?.observed != null;
      if (!already) unique++;
      const position = ref.get(step.anchor_run, r.workId)?.position;
      if (!already) {
        const scopeNew = prior?.baseline == null && !tombstone.get(step.source_id, r.workId);
        const returned = prior?.baseline != null && step.baseline_known && position === undefined;
        if (scopeNew || returned) events.push({ ...r, returned, newWork: old.get(r.workId) ? 0 : 1 });
      }
      if (already || position === undefined) {
        streak = 0;
        pages = 0;
        last = null;
        newPage = true;
      } else if (last !== null && position === last + 1) {
        streak++;
        if (newPage) pages++;
        newPage = false;
        last = position;
      } else {
        streak = 1;
        pages = 1;
        newPage = false;
        last = position;
      }
    }
    if (page.receivedCount > page.uniqueCount) {
      streak = 0;
      pages = 0;
      last = null;
    }
    const empty = unique ? 0 : step.empty_pages + 1;
    if (empty >= 3 && !page.terminal) throw failure(409, 'SOURCE_PAGE_INVALID', '连续三页没有新的有效作品。');
    localStore(db, source).commitSourcePage({ ...ticket, page });
    const added = db.prepare('INSERT INTO read_differences VALUES(?,?,?,?,?,?)'),
      title = db.prepare('SELECT title FROM works WHERE id=?');
    const historical = db
      .prepare('SELECT min(observed) first FROM source_read_items WHERE job_id=? AND baseline IS NOT NULL')
      .get(step.id).first;
    const oldCount = db
      .prepare('SELECT count(*) n FROM source_read_items WHERE job_id=? AND baseline IS NOT NULL')
      .get(step.id).n;
    for (const r of events) {
      const position = run.received + r.rank;
      added.run(
        step.id,
        r.workId,
        title.get(r.workId).title,
        position,
        r.returned
          ? 'returned'
          : !oldCount
            ? 'initial'
            : historical === null || position < historical
              ? 'front'
              : 'fill',
        r.newWork
      );
    }
    for (const r of page.refs) queueArchiveFinalizer(db, step.id, r.workId, ticket.operationId);
    let outcome = page.terminal
      ? 'end'
      : step.mode === 'quick' && step.baseline_known && streak >= 60 && pages >= 2
        ? 'matched'
        : null;
    db.prepare(
      'UPDATE read_steps SET streak=?,streak_pages=?,last_anchor=?,empty_pages=?,outcome=? WHERE id=?'
    ).run(streak, pages, last, empty, outcome, step.id);
    const count = db.prepare('SELECT count(observed) n FROM source_read_items WHERE job_id=?').get(step.id).n;
    if (
      !step.superseded &&
      outcome === 'end' &&
      ((oldCount > 0 && count === 0) || (oldCount >= 20 && count < oldCount / 2) || oldCount - count >= 1000)
    ) {
      if (step.source_id.startsWith('author:')) {
        db.prepare("UPDATE read_steps SET outcome='end-warning' WHERE id=?").run(step.id);
        finishStep(db, findStep(db, step.id));
        return;
      }
      stepStatus(db, step.id, 'review', '本轮返回数量明显减少，历史记录保留，请核对。');
      batchStatus(db, step.batch_id, 'review', '请确认返回数量变化。');
    } else if (outcome) finishStep(db, findStep(db, step.id));
    else if (step.goal !== null && count >= step.goal) {
      db.prepare("UPDATE read_steps SET outcome='limit' WHERE id=?").run(step.id);
      stepStatus(db, step.id, 'paused', '本次限定读取已完成，可继续读取。');
      batchStatus(db, step.batch_id, 'paused', '已达到本次读取数量。');
    }
  }
  async function execute(session, grant, id, stop) {
    function owned(db) {
      const job = jobRow(db, id);
      if (
        stop.aborted ||
        job?.status !== 'running' ||
        job.owner_generation !== grant.generation ||
        job.owner_boot !== grant.bootId
      )
        throw reject();
      return job;
    }
    while (!stop.aborted) {
      let work;
      try {
        work = session.write((db) => prepare(db, owned(db)));
        if (!work) {
          if (session.read((db) => jobRow(db, id).status) !== 'running') return;
          continue;
        }
        if (work.workId) {
          const detail = await abortable(
            source.readDetail({
              workId: work.workId,
              authEpoch: work.authEpoch,
              signal: stop
            }),
            stop
          );
          session.write((db) => {
            owned(db);
            if (boundIdentity(db, source).authEpoch !== work.authEpoch) throw reject('来源账号状态已变化。');
            if (detail?.id !== work.workId || detail.statusOnly) throw reject('未取得此作品的详情。');
            const existed = db.prepare('SELECT 1 FROM works WHERE id=?').get(work.workId);
            const { audioSourceHints, ...record } = detail;
            const titles = saveWorks(db, {
              works: [record],
              aux: {
                audioSourceHints: audioSourceHints ? [audioSourceHints] : [],
                creatorProfiles: [detail.author, ...(detail.coAuthors ?? [])].filter(
                  (a) => a?.uid || a?.secUid
                )
              }
            });
            if (!existed)
              db.prepare("INSERT INTO read_differences VALUES(?,?,?,0,'initial',1)").run(
                work.stepId,
                work.workId,
                titles.get(work.workId)
              );
            queueArchiveFinalizer(db, work.stepId, work.workId, work.stepId);
            db.prepare("UPDATE read_steps SET outcome='imported' WHERE id=?").run(work.stepId);
            finishStep(db, findStep(db, work.stepId));
          });
          continue;
        }
        const { ticket, count } = work;
        const page =
          work.page ??
          (await abortable(
            source.readSourcePage({
              source: ticket.source,
              cursor: ticket.inputCursor,
              authEpoch: ticket.authEpoch,
              signal: stop,
              count
            }),
            stop
          ));
        stop.throwIfAborted();
        session.write((db) => {
          owned(db);
          const scopePage =
            ticket.source.kind === 'author'
              ? authorPage(db, findStep(db, ticket.jobId), ticket, page, work.budget)
              : page;
          commit(db, ticket, scopePage);
        });
        if (readDelay && session.read((db) => jobRow(db, id).status) === 'running')
          await delay(readDelay, undefined, { signal: stop });
      } catch (e) {
        if (stop.aborted) return;
        try {
          const continuing = session.write((db) => {
            owned(db);
            const step = currentStep(db, id);
            if (!step) return false;
            const ordinary = step.source_id.startsWith('folder:') && e.code === 'SOURCE_PAGE_INVALID';
            const message = e.status ? e.message : '读取或保存失败，已提交的进度保留。';
            stepStatus(db, step.id, ordinary ? 'failed' : 'paused', message);
            if (!ordinary) batchStatus(db, id, 'paused', message);
            return ordinary;
          });
          if (continuing) continue;
        } catch {
          /* The next lease will recover the persisted cursor. */
        }
        return;
      }
    }
  }
  return {
    start,
    control,
    stopExpired,
    wake(session, grant, id) {
      const job = session.read((db) => jobRow(db, id));
      if (live?.id === id && live.generation === grant.generation && job?.status === 'running') return;
      if (live?.id === id || job?.status === 'running') {
        live?.controller.abort();
        live = null;
      }
      if (
        job?.status !== 'running' ||
        job.owner_generation !== grant.generation ||
        job.owner_boot !== grant.bootId
      )
        return;
      const controller = new AbortController(),
        worker = { id, generation: grant.generation, controller };
      live = worker;
      const signal = AbortSignal.any([controller.signal, session.signal]);
      void execute(session, grant, id, signal).finally(() => {
        if (live === worker) live = null;
      });
    }
  };
}
export function readState(db, state) {
  state.collectionReadInfo = {};
  state.authors = [];
  const summaryByKey = (key) =>
    db
      .prepare(
        'SELECT s.*,b.started FROM read_steps s JOIN read_batches b ON b.id=s.batch_id WHERE source_id=? ORDER BY s.rowid DESC'
      )
      .all(key);
  const uid = db.prepare('SELECT uid FROM source_account WHERE singleton=1').get()?.uid;
  for (const row of db.prepare('SELECT * FROM read_sources WHERE uid=? ORDER BY rowid').all(uid ?? '')) {
    const item = { ...JSON.parse(row.body), added: !!row.added, remoteMissing: !!row.missing };
    if (row.source_id.startsWith('folder:')) state.collections.push(item);
    else {
      const last = summaryByKey(row.source_id)[0];
      if (last) item.run = stepSummary(db, last, last.started);
      state.authors.push(item);
    }
  }
  for (const folder of state.collections) {
    const key = folder.id === '__all__' ? 'total' : 'folder:' + folder.id,
      info = { baselineKnown: !!anchor(db, key, uid ?? '') };
    for (const step of summaryByKey(key))
      if (!info[step.mode]) info[step.mode] = stepSummary(db, step, step.started);
    state.collectionReadInfo[folder.id] = info;
  }
  for (const mode of ['quick', 'full']) {
    const summary = state.collectionReadInfo.__all__?.[mode];
    if (
      summary?.status === 'complete' &&
      ['paused', 'review', 'finalizing', 'partial'].includes(jobRow(db, summary.batchId)?.status)
    )
      summary.canResume = true;
  }
  const current = running(db);
  if (current) {
    const step = currentStep(db, current.id);
    state.collector = {
      ...state.collector,
      busy: true,
      phase: 'syncing',
      message: '正在读取' + (step?.name ?? ''),
      jobId: current.id
    };
  }
  return state;
}
