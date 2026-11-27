import { needsResourceWork, sharedRepairPeers, unsettled, updateRepairJobs } from './maintenance-queue.mjs';
import { saveInventoryState } from './maintenance-inventory.mjs';

export function getJob(db, id) {
  const row = db.prepare('SELECT body FROM download_manifests WHERE id=?').get(id);
  return row ? JSON.parse(row.body) : null;
}
function writeJob(db, job, inventory) {
  if (job.state !== 'awaiting-registration') delete job.registrationAssets;
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
export function putJob(db, job, inventory) {
  // Capture the original approved group before recording this terminal transition removes its link.
  const waiting = unsettled(job.state)
    ? []
    : sharedRepairPeers(db, job).filter((peer) => peer.state === 'awaiting-registration');
  writeJob(db, job, inventory);
  for (const { id } of waiting) {
    const peer = getJob(db, id);
    if (peer?.state !== 'awaiting-registration' || sharedRepairPeers(db, peer).some(needsResourceWork))
      continue;
    const verified =
      inventory?.registrationConfirmed &&
      peer.registrationAssets?.length &&
      peer.registrationAssets.every((asset) => {
        const observed = inventory.resources.get(asset.id);
        return (
          observed?.sha256 === asset.sha256 &&
          observed.identity.dev === asset.identity.dev &&
          observed.identity.ino === asset.identity.ino
        );
      });
    peer.state = verified ? 'complete' : 'finalization-pending';
    peer.finalizationPending = !verified;
    peer.reason = verified
      ? null
      : {
          code: 'NAS_REGISTRATION_PENDING',
          message: '此范围的字节已保存；同一作品的归档登记尚未全部核实，请核对其他范围后重试。'
        };
    writeJob(db, peer, inventory);
  }
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
    // All affected scopes are being fenced in this same transaction.
    writeJob(db, job);
  }
}
