import { updateRepairJobs } from './maintenance-queue.mjs';
import { saveInventoryState } from './maintenance-inventory.mjs';

export function getJob(db, id) {
  const row = db.prepare('SELECT body FROM download_manifests WHERE id=?').get(id);
  return row ? JSON.parse(row.body) : null;
}
export function putJob(db, job, inventory) {
  db.prepare(
    'INSERT INTO download_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state WHERE state<>excluded.state'
  ).run(job.id, job.workId, job.state);
  db.prepare(
    'INSERT INTO download_manifests(id,work_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,hidden=0'
  ).run(job.id, job.workId, JSON.stringify(job));
  if (inventory) saveInventoryState(db, job.workId, inventory.issues);
  updateRepairJobs(db, job, inventory);
  db.exec('UPDATE download_options SET revision=revision+1');
}
export function fenceUnavailable(db, workId) {
  const entries = db
    .prepare(
      "SELECT m.body FROM download_manifests m JOIN download_jobs j ON j.id=m.id WHERE j.work_id=? AND j.state NOT IN ('complete','cancelled','cancelling','unavailable')"
    )
    .all(workId);
  for (const row of entries) {
    const job = JSON.parse(row.body);
    job.state = 'unavailable';
    job.sourceFence = (job.sourceFence ?? 0) + 1;
    job.reason = {
      code: 'NAS_SOURCE_UNAVAILABLE',
      message: '来源不可用，已保留文件。重新核验为可访问后可手动重试。'
    };
    putJob(db, job);
  }
}
