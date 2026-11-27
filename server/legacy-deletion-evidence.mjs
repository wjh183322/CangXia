import { contentHash } from '../shared/backup-protocol.mjs';
import { validateScopeCommand } from '../shared/backup-scopes.mjs';
import { decodeReceipt, hydrateScopeReceipt } from '../shared/scope-receipt.mjs';
import { readCopy } from './rehearsal-files.mjs';

export function memberScopeKey(marker) {
  const split = marker.key.lastIndexOf(':'),
    source = marker.key.slice(0, split),
    work = marker.key.slice(split + 1);
  return JSON.stringify([
    marker.lineage,
    work,
    marker.table === 'members' ? 'account' : 'author',
    marker.table === 'members' ? '__all__' : source
  ]);
}
const hasTable = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
const evidenceKey = (scope, revision) => JSON.stringify([scope, revision]);

function deletedItems(row, lineage, localCommands) {
  const summary = decodeReceipt(row.result);
  if (
    summary.libraryId !== lineage ||
    summary.operationId !== row.operation_id ||
    summary.action !== 'delete'
  )
    return [];
  let receipt = summary;
  if (summary.compacted) {
    const command = localCommands.get(summary.commandHash);
    if (!command) return []; // Compact receipts omit scope IDs. A hash alone cannot establish a deletion.
    receipt = hydrateScopeReceipt(summary, command);
  }
  if (!Array.isArray(receipt.items) || !receipt.items.length || receipt.items.length > 100) return [];
  const command = validateScopeCommand({
    libraryId: lineage,
    operationId: receipt.operationId,
    items: receipt.items.map((i) => ({ scope: i.scope, expectedGeneration: i.generation - 1 }))
  });
  if (
    contentHash({ action: 'delete', command }) !== row.request_hash ||
    !Number.isSafeInteger(receipt.dataRevision) ||
    receipt.dataRevision < 1
  )
    return [];
  const first = receipt.revision - receipt.items.length + 1;
  if (
    !Number.isSafeInteger(first) ||
    first < 1 ||
    receipt.items.some(
      (i, n) =>
        i.deleted !== true ||
        i.revision !== first + n ||
        i.operationId !== row.operation_id ||
        i.deviceId !== row.device_id ||
        i.dataRevision !== receipt.dataRevision
    )
  )
    return [];
  return receipt.items;
}

// Latest scope_state can represent generation 3 while a particular NULL was last written at
// generation 1. Look up the earlier native operation, independently of the scope's current state.
export async function pastMemberDeletes({
  sources,
  identities,
  markers,
  versions,
  restored,
  localCommands,
  issue
}) {
  const pending = markers.filter((m) => {
    const k = memberScopeKey(m);
    return (
      m.historical &&
      m.recordRevision > 0 &&
      restored.has(k) &&
      !versions.get(k)?.some((v) => v.origin === m.origin && v.deleted && v.dataRevision === m.recordRevision)
    );
  });
  const result = new Map();
  if (!pending.length) return result;
  for (const [index, source] of sources.entries()) {
    const origin = identities[index],
      affected = pending.filter((m) => m.lineage === origin.lineage);
    if (!affected.length) continue;
    const revisions = [...new Set(affected.map((m) => m.recordRevision))];
    const wanted = new Set(affected.map((m) => evidenceKey(memberScopeKey(m), m.recordRevision)));
    await readCopy(source, source.database, (db) => {
      const revisionParam = JSON.stringify(revisions),
        hasKeys = hasTable(db, 'scope_receipt_keys');
      const hasCommits =
        hasTable(db, 'commits') &&
        db.prepare("SELECT 1 FROM pragma_table_info('commits') WHERE name='request'").get();
      const receipts = new Map(),
        own = affected.filter((m) => m.origin === origin.source);
      const commits = new Map();
      if (hasCommits)
        for (const c of db
          .prepare(
            'SELECT revision,request,requestHash FROM commits WHERE revision IN (SELECT value FROM json_each(?))'
          )
          .iterate(revisionParam))
          commits.set(c.revision, c);
      for (const marker of own) marker.commit = commits.get(marker.recordRevision);
      if (hasKeys) {
        for (const row of db
          .prepare(
            "SELECT operation_id,device_id,request_hash,summary result FROM scope_receipt_keys WHERE json_extract(summary,'$.dataRevision') IN (SELECT value FROM json_each(?))"
          )
          .iterate(revisionParam))
          receipts.set(row.operation_id, row);
      }
      if (hasTable(db, 'scope_receipts')) {
        const lookup = db.prepare(
          'SELECT operation_id,device_id,request_hash,result FROM scope_receipts WHERE operation_id=?'
        );
        for (const id of new Set([
          ...receipts.keys(),
          ...[...commits.values()].map((c) => c.request).filter(Boolean)
        ])) {
          const full = lookup.get(id);
          if (full) receipts.set(id, full);
        }
      }
      for (const row of receipts.values()) {
        let items;
        try {
          items = deletedItems(row, origin.lineage, localCommands);
        } catch {
          issue(origin.source, 'scopeReceipt', row.operation_id, '旧范围回执无法核实，相应空记录保留候选');
          continue;
        }
        for (const item of items) {
          const s = item.scope,
            key = evidenceKey(
              JSON.stringify([origin.lineage, s.workId, s.kind, s.sourceId]),
              item.dataRevision
            );
          if (!wanted.has(key)) continue;
          const commit = commits.get(item.dataRevision);
          if (commit && (commit.request !== item.operationId || commit.requestHash !== row.request_hash))
            continue;
          const list = result.get(key) ?? [];
          list.push({ ...item, origin: origin.source, requestHash: row.request_hash });
          result.set(key, list);
        }
      }
    });
  }
  return result;
}
export function earlierMemberDelete(evidence, marker) {
  const rows = evidence.get(evidenceKey(memberScopeKey(marker), marker.recordRevision)) ?? [];
  return rows.find(
    (v) =>
      v.origin === marker.origin ||
      (marker.commit?.request === v.operationId && marker.commit.requestHash === v.requestHash)
  );
}
