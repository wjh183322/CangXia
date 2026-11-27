import { mergeReadOrder } from '../electron/read-history.mjs';
import { validateSource } from './source-parser.mjs';
import { failure } from './service-error.mjs';

export function sourceKey(source) {
  const { kind, id } = validateSource(source);
  if (kind === 'total') return 'total';
  return (kind === 'collection' ? 'folder:' : 'author:') + id;
}

export function orderedMemberships(db, source) {
  return db
    .prepare(
      `SELECT m.work_id AS workId, coalesce(r.version,0) AS entityVersion
    FROM source_members m LEFT JOIN membership_removals r USING(source_id,work_id)
    WHERE m.source_id=? ORDER BY m.order_generation DESC,m.position,m.work_id`
    )
    .all(sourceKey(source));
}

export function removeMembership(db, { source, workId, expectedVersion }) {
  if (
    typeof workId !== 'string' ||
    !/^\d+$/.test(workId) ||
    !/[1-9]/.test(workId) ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  )
    throw failure(400, 'INVALID_REQUEST', '归属参数无效。');
  const key = sourceKey(source);
  const version =
    db.prepare('SELECT version FROM membership_removals WHERE source_id=? AND work_id=?').get(key, workId)
      ?.version ?? 0;
  if (version !== expectedVersion) throw failure(409, 'STALE_ENTITY', '归属已变更，请重新读取。');
  const removed = db.prepare('DELETE FROM source_members WHERE source_id=? AND work_id=?').run(key, workId);
  if (!removed.changes) throw failure(404, 'MEMBERSHIP_UNKNOWN', '找不到该来源的可见归属。');
  const revision = db
    .prepare('SELECT coalesce(max(revision),0)+1 AS next FROM membership_removals')
    .get().next;
  db.prepare(
    `INSERT INTO membership_removals VALUES(?,?,?,?) ON CONFLICT(source_id,work_id)
    DO UPDATE SET revision=excluded.revision,version=excluded.version`
  ).run(key, workId, revision, version + 1);
  return { source, workId, entityVersion: version + 1, removalRevision: revision };
}

export function publishMemberships(db, run, ticket, page, titles) {
  const restoredIds = [];
  const observe = db.prepare(`INSERT INTO source_read_items(job_id,work_id,observed) VALUES(?,?,?)
    ON CONFLICT(job_id,work_id) DO UPDATE SET observed=coalesce(observed,excluded.observed)`);
  const relation = db.prepare(`SELECT r.revision, EXISTS(SELECT 1 FROM source_members m
    WHERE m.source_id=r.source_id AND m.work_id=r.work_id) AS visible FROM membership_removals r
    WHERE r.source_id=? AND r.work_id=?`);
  const publish =
    db.prepare(`INSERT INTO source_members(source_id,work_id,position,order_generation) VALUES(?,?,?,?)
    ON CONFLICT(source_id,work_id) DO UPDATE SET position=excluded.position,order_generation=excluded.order_generation
    WHERE source_members.order_generation<>excluded.order_generation`);
  const restore = db.prepare(
    'UPDATE membership_removals SET version=version+1 WHERE source_id=? AND work_id=?'
  );
  const event = db.prepare(
    'INSERT INTO membership_restorations VALUES(?,?,?,?,?) ON CONFLICT(job_id,work_id) DO NOTHING'
  );
  for (const { workId, rank } of page.refs) {
    const position = run.received + rank;
    observe.run(run.job_id, workId, position);
    const prior = relation.get(run.source_id, workId);
    if (prior && !prior.visible) {
      if (prior.revision > ticket.removalRevision) continue;
      restore.run(run.source_id, workId);
      if (event.run(run.job_id, run.source_id, workId, titles.get(workId), position).changes)
        restoredIds.push(workId);
    }
    publish.run(run.source_id, workId, position, run.generation);
  }
  if (page.terminal) {
    // Full reads place previously known, unreturned works beside their original
    // anchors. Use the pre-read ordering, even after several published prefixes.
    const baseline = db
      .prepare(
        `SELECT i.work_id FROM source_read_items i JOIN source_members m
      ON m.source_id=? AND m.work_id=i.work_id WHERE i.job_id=? AND i.baseline IS NOT NULL ORDER BY i.baseline`
      )
      .all(run.source_id, run.job_id);
    // A suppressed stale observation is evidence of the response, but only a later
    // accepted response can establish the restored member's display position.
    const returned = db
      .prepare(
        `SELECT work_id FROM source_members WHERE source_id=? AND order_generation=? ORDER BY position,work_id`
      )
      .all(run.source_id, run.generation);
    const order = mergeReadOrder(
      baseline.map((row) => row.work_id),
      returned.map((row) => row.work_id)
    );
    const update = db.prepare(
      'UPDATE source_members SET order_generation=?,position=? WHERE source_id=? AND work_id=?'
    );
    for (const [position, id] of order.entries()) update.run(run.generation, position, run.source_id, id);
  }
  return restoredIds;
}
