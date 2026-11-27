import {
  archiveRevision,
  cleanFileStages,
  fileReason,
  finalizeWorkFiles,
  recoverFileCommits,
  resolveResource,
  withWorkFiles
} from './files.mjs';
import { SourceError } from './source-error.mjs';

export function createArchive(store) {
  const { db, layout } = store;
  const stopping = new AbortController();
  const archived = db.prepare(
    "SELECT run_id,operation_id FROM read_finalizers WHERE work_id=? AND status='pending'"
  );
  const tasks = new Set();

  async function perform({
    workId,
    expectedRevision = archiveRevision(store, workId),
    guard: owner,
    signal
  }) {
    const jobId = 'archive:' + workId;
    const tickets = archived.all(workId);
    const guard = () => {
      stopping.signal.throwIfAborted();
      signal?.throwIfAborted();
      owner?.();
      if (archiveRevision(store, workId) !== expectedRevision)
        throw new SourceError('NAS_ARCHIVE_STALE', '资料已更新，将按最新版本整理。');
    };
    try {
      guard();
      const recovery = await recoverFileCommits({ store, layout, workId, jobId, guard });
      const failure = recovery.find((row) => row.error)?.error;
      if (failure) throw new SourceError(failure.code, failure.message);
      return await withWorkFiles(layout, workId, async () => {
        guard();
        // A download interrupted inside file publication must settle its own journal first.
        if (
          store
            .fileCommits(workId)
            .some(
              (c) =>
                c.body.jobId !== jobId &&
                ['verified', 'swapping', 'moving', 'placed', 'review', 'hd-withdrawing'].includes(c.stage)
            )
        )
          throw new SourceError('NAS_FILE_REVIEW', '下载还有尚未登记的归档文件。');
        if (await cleanFileStages({ store, layout, workId, jobId }))
          throw new SourceError('CLEANUP_PENDING', '旧暂存文件仍待核对。');
        const result = await finalizeWorkFiles({
          store,
          layout,
          workId,
          jobId,
          signal: stopping.signal,
          guard
        });
        if (result.pending) throw new SourceError(result.errors[0].code, result.errors[0].message);
        if (
          !(await resolveResource({
            store,
            layout,
            workId,
            key: 'metadata',
            verify: true,
            signal: stopping.signal
          }))
        )
          throw new SourceError('NAS_FILE_MISSING', '尚未核实作品信息 JSON。');
        if (await cleanFileStages({ store, layout, workId, jobId }))
          throw new SourceError('CLEANUP_PENDING', '归档清理尚未完成。');
        store.withWrite((conn) => {
          guard();
          for (const t of tickets)
            conn
              .prepare(
                "UPDATE read_finalizers SET status='complete' WHERE run_id=? AND work_id=? AND operation_id=? AND status='pending'"
              )
              .run(t.run_id, workId, t.operation_id);
          conn
            .prepare('UPDATE archive_state SET completed=revision,error=NULL WHERE work_id=? AND revision=?')
            .run(workId, expectedRevision);
        });
        return result;
      });
    } catch (error) {
      const reason = fileReason(error);
      if (!stopping.signal.aborted)
        store.withWrite((conn) =>
          conn
            .prepare('UPDATE archive_state SET error=? WHERE work_id=? AND revision=?')
            .run(reason.message, workId, expectedRevision)
        );
      return { pending: true, errors: [reason] };
    }
  }

  function reconcileArchive(request) {
    const task = perform(request).finally(() => tasks.delete(task));
    tasks.add(task);
    return task;
  }
  async function run(sourceId, signal) {
    const rows = sourceId
      ? db
          .prepare(
            `SELECT DISTINCT a.work_id,a.revision FROM archive_state a JOIN read_finalizers f ON f.work_id=a.work_id
        JOIN read_steps s ON s.id=f.run_id WHERE f.status='pending' AND s.source_id=?`
          )
          .all(sourceId)
      : db.prepare('SELECT work_id,revision FROM archive_state WHERE revision<>completed').all();
    for (const row of rows) {
      if (stopping.signal.aborted || signal?.aborted) return;
      await reconcileArchive({ workId: row.work_id, expectedRevision: row.revision, signal });
    }
  }
  return {
    reconcileArchive,
    run,
    async close() {
      stopping.abort();
      await Promise.allSettled([...tasks]);
    }
  };
}
