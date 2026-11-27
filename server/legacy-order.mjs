import { mergeReadOrder } from '../electron/read-history.mjs';

// Reconstruct the same display overlays as CollectionReads.order, SyncState.order and AuthorSources.order.
// Every SELECT is performed against the already verified private SQLite snapshot.
export function readLegacyOrder(db, names, entry, issue) {
  const has = (name) => names.includes(name);
  const select = (table, sql, ...params) => (has(table) ? db.prepare(sql).all(...params) : []);
  const scopes = new Set(select('members', 'SELECT DISTINCT collection_id id FROM members').map((r) => r.id));
  const reads = select('collection_read_runs', 'SELECT id,body FROM collection_read_runs').map((r) =>
    JSON.parse(r.body)
  );
  const sync = new Map(
    select('sync_runs', 'SELECT collection_id,body FROM sync_runs').map((r) => [
      r.collection_id,
      JSON.parse(r.body)
    ])
  );
  const byMode = new Map();
  for (const r of reads) {
    scopes.add(r.scope);
    byMode.set(r.mode + ':' + r.scope, r);
  }
  for (const k of sync.keys()) scopes.add(k);
  function positions(rows, label) {
    const seen = new Set(),
      conflicts = new Set();
    for (const r of rows)
      if (r.position !== null) {
        if (seen.has(r.position)) conflicts.add(r.position);
        seen.add(r.position);
      }
    for (const r of rows) if (conflicts.has(r.position)) issue(label, r.work_id, r.position);
    return rows.map((r) => r.work_id);
  }
  for (const id of scopes) {
    const label = id === '__all__' ? 'total' : 'folder:' + id;
    const base = select(
      'members',
      'SELECT work_id,rank AS position FROM members WHERE collection_id=? ORDER BY rank IS NULL,rank,work_id',
      id
    );
    const baseIds = positions(base, label),
      pending = new Set(base.filter((r) => r.position === null).map((r) => r.work_id));
    const modes = ['quick', 'full'].map((m) => byMode.get(m + ':' + id));
    const run = modes.find((r) => r?.status === 'running');
    let effective = base;
    if (run) {
      const incoming = positions(
        select(
          'collection_read_items',
          'SELECT work_id,position FROM collection_read_items WHERE run_key=? ORDER BY position,work_id',
          run.key
        ),
        label
      );
      const seen = new Set(incoming),
        existing = new Set(baseIds);
      effective = run.conflicted
        ? [
            ...base,
            ...incoming
              .filter((w) => !existing.has(w))
              .map((work_id, i) => ({ work_id, position: base.length + i }))
          ]
        : mergeReadOrder(baseIds, incoming).map((work_id, i) => ({
            work_id,
            position: pending.has(work_id) && !seen.has(work_id) ? null : i
          }));
    } else if (!modes.some(Boolean) && sync.has(id) && sync.get(id).status !== 'complete') {
      const incoming = positions(
        select(
          'sync_items',
          'SELECT work_id,position FROM sync_items WHERE collection_id=? ORDER BY position,work_id',
          id
        ),
        label
      );
      const seen = new Set(incoming);
      effective = [...incoming, ...baseIds.filter((w) => !seen.has(w))].map((work_id, i) => ({
        work_id,
        position: pending.has(work_id) && !seen.has(work_id) ? null : i
      }));
    }
    for (const r of effective)
      entry('members', id + ':' + r.work_id, { collectionId: id, workId: r.work_id, rank: r.position });
  }
  const authors = new Set(
    [
      ...select('author_members', 'SELECT DISTINCT author_id id FROM author_members'),
      ...select('author_scan', 'SELECT DISTINCT author_id id FROM author_scan')
    ].map((r) => r.id)
  );
  for (const id of authors) {
    const base = select(
        'author_members',
        'SELECT * FROM author_members WHERE author_id=? ORDER BY position,work_id',
        id
      ),
      hidden = new Set(base.filter((r) => r.hidden).map((r) => r.work_id));
    const scan = select(
      'author_scan',
      'SELECT work_id,position FROM author_scan WHERE author_id=? ORDER BY position,work_id',
      id
    );
    const oldIds = positions(base, 'author:' + id),
      newIds = positions(scan, 'author:' + id);
    const effective = scan.length
      ? mergeReadOrder(oldIds, newIds).map((work_id, position) => ({ work_id, position }))
      : base;
    for (const r of effective)
      entry('author_members', id + ':' + r.work_id, {
        authorId: id,
        workId: r.work_id,
        position: r.position,
        hidden: hidden.has(r.work_id)
      });
  }
}
