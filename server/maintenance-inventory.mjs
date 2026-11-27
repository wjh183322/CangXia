import { resolveResource } from './files.mjs';

export const inventoryReasons = {
  NAS_FILE_MISSING: '已登记文件缺失，可重新核对并补齐。',
  NAS_FILE_REVIEW: '文件身份、大小或内容与登记不同，请先核对原文件。',
  NAS_FILE_PATH: '资料卷或归档目录不可用，请核对挂载。',
  NAS_FILE_OPERATION: '暂时无法读取文件，请检查磁盘及权限。',
  NAS_MEDIA_SET_REVIEW: '媒体清单不完整，请核对来源及归档登记。'
};
const issue = (code, stage, key) => ({ code, stage, ...(key && { key }), reason: inventoryReasons[code] });
export const knownKey = (key) =>
  /^(?:video|cover(?:-hd)?|metadata|audio|image-\d{1,6})$/.test(key) ? key : undefined;
export async function inspectInventory({ store, layout, work, signal, wantedResources }) {
  const id = work.id;
  const rows = store.resources(id),
    issues = [];
  let metadataVerified = false;
  const resources = new Map();
  let bytes = 0,
    verified = 0;
  const attached = store.db.prepare('SELECT count(*) n FROM media_files WHERE work_id=?').get(id).n;
  if (attached !== rows.length) issues.push(issue('NAS_MEDIA_SET_REVIEW', 'registration'));
  for (const row of rows) {
    signal.throwIfAborted();
    try {
      const value = await resolveResource({
        store,
        layout,
        workId: id,
        key: row.key,
        verify: true,
        allowMissing: true,
        signal
      });
      if (!value) throw Error('resource changed');
      if (value.missing) {
        issues.push(issue('NAS_FILE_MISSING', 'files', knownKey(row.key)));
        continue;
      }
      bytes += value.size;
      verified++;
      resources.set(value.id, { sha256: value.sha256, identity: value.identity });
      if (row.key === 'metadata') metadataVerified = true;
    } catch (e) {
      signal.throwIfAborted();
      const code =
        e.code === 'NAS_FILE_MISSING'
          ? 'NAS_FILE_PATH'
          : ['NAS_FILE_REVIEW', 'NAS_FILE_PATH'].includes(e.code)
            ? e.code
            : 'NAS_FILE_OPERATION';
      issues.push(issue(code, 'files', knownKey(row.key)));
    }
  }
  if (rows.some((r) => !['audio', 'metadata'].includes(r.key))) {
    try {
      for (const target of wantedResources(work, false))
        if (target.candidates.length && !rows.some((r) => r.key === target.key))
          issues.push(issue('NAS_FILE_MISSING', 'files', knownKey(target.key)));
    } catch {
      issues.push(issue('NAS_MEDIA_SET_REVIEW', 'registration'));
    }
  }

  return { issues, verified, bytes, metadataVerified, resources };
}
export function inventoryStatus(issues) {
  if (!issues.length) return null;
  return issues.every((i) => i.code === 'NAS_FILE_MISSING') ? 'partial' : 'checking';
}
export function saveInventoryState(db, workId, issues) {
  const status = inventoryStatus(issues);
  if (status)
    db.prepare(
      'INSERT INTO maintenance_file_state VALUES(?,?) ON CONFLICT(work_id) DO UPDATE SET status=excluded.status WHERE status<>excluded.status'
    ).run(workId, status);
  else db.prepare('DELETE FROM maintenance_file_state WHERE work_id=?').run(workId);
}
