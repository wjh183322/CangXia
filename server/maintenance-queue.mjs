import { inventoryStatus } from './maintenance-inventory.mjs';
export function downloadScope(id, workId) {
  if (id === workId) return 'media';
  if (id === 'audio:' + workId) return 'audio';
  if (id === 'hd:' + workId) return 'cover-hd';
  return null;
}
export const unsettled = (state) =>
  ['queued', 'running', 'paused', 'pausing', 'cancelling', 'awaiting-registration'].includes(state);
export function sharedRepairPeers(db, job) {
  return db
    .prepare(
      `SELECT DISTINCT p.job AS id,j.state FROM maintenance_queue_links s
    JOIN maintenance_queue_links p ON p.run=s.run AND p.work_id=s.work_id AND p.job<>s.job
    JOIN download_jobs j ON j.id=p.job WHERE s.job=? AND s.work_id=?`
    )
    .all(job.id, job.workId);
}
export const needsResourceWork = (peer) => unsettled(peer.state) && peer.state !== 'awaiting-registration';
export function summarizeRepairJobs(result) {
  const jobs = result.jobs;
  const states = [...new Set(jobs.map((j) => j.state))];
  const active = states.some(unsettled);
  const registration = result.registration === 'pending' && !active ? 'failed' : result.registration;
  const failed = registration === 'failed' || states.some((s) => s !== 'complete' && !unsettled(s));
  return {
    ...result,
    ...(registration && { registration }),
    downloadState: states.length === 1 ? states[0] : 'mixed',
    fileStatus: active ? 'queued' : failed ? 'failed' : (result.verifiedFileStatus ?? 'complete'),
    repairable:
      !active &&
      (failed || result.verifiedFileStatus === 'pending') &&
      result.verifiedFileStatus !== 'blocked' &&
      result.sourceStatus !== 'unavailable' &&
      jobs.some((j) => j.state !== 'unavailable')
  };
}
export function updateRepairJobs(db, job, inventory) {
  const links = db.prepare('SELECT run,work_id FROM maintenance_queue_links WHERE job=?').all(job.id);
  for (const link of links) {
    const row = db
      .prepare('SELECT result FROM maintenance_items WHERE run=? AND work_id=?')
      .get(link.run, link.work_id);
    if (!row?.result) continue;
    const value = JSON.parse(row.result);
    const jobs = value.jobs ?? [
      { id: job.id, scope: downloadScope(job.id, job.workId), state: value.downloadState }
    ];
    const match = jobs.find((j) => j.id === job.id);
    if (match && match.state !== job.state) {
      match.state = job.state;
      if (inventory) {
        const status = inventoryStatus(inventory.issues);
        value.verifiedFileStatus =
          status === 'partial' ? 'pending' : status === 'checking' ? 'blocked' : 'complete';
        value.verified = inventory.verified;
        value.bytes = inventory.bytes;
        value.issues = [
          ...(value.issues ?? []).filter(
            (i) =>
              i.stage !== 'files' &&
              i.code !== 'NAS_MEDIA_SET_REVIEW' &&
              !(i.jobId === job.id && job.state === 'complete')
          ),
          ...inventory.issues
        ];
      }
      if (value.registration && inventory) {
        value.registration = inventory.registrationConfirmed
          ? 'complete'
          : jobs.some((j) => unsettled(j.state))
            ? 'pending'
            : 'failed';
        if (value.registration === 'complete')
          value.issues = value.issues.filter((i) => i.scope !== 'archive');
      }
      db.prepare('UPDATE maintenance_items SET result=? WHERE run=? AND work_id=?').run(
        JSON.stringify(summarizeRepairJobs({ ...value, jobs })),
        link.run,
        link.work_id
      );
      db.prepare('UPDATE maintenance_runs SET version=version+1 WHERE id=?').run(link.run);
    }
    if (!unsettled(job.state))
      db.prepare('DELETE FROM maintenance_queue_links WHERE run=? AND work_id=? AND job=?').run(
        link.run,
        link.work_id,
        job.id
      );
  }
}
