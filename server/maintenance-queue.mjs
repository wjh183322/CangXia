export function downloadScope(id, workId) {
  if (id === workId) return 'media';
  if (id === 'audio:' + workId) return 'audio';
  if (id === 'hd:' + workId) return 'cover-hd';
  return null;
}
export const unsettled = (state) => ['queued', 'running', 'paused', 'pausing', 'cancelling'].includes(state);
export function summarizeRepairJobs(result) {
  const jobs = result.jobs;
  const states = [...new Set(jobs.map((j) => j.state))];
  const active = states.some(unsettled);
  const failed = result.registration === 'failed' || states.some((s) => s !== 'complete' && !unsettled(s));
  return {
    ...result,
    downloadState: states.length === 1 ? states[0] : 'mixed',
    fileStatus: active ? 'queued' : failed ? 'failed' : 'complete',
    repairable:
      !active &&
      failed &&
      result.sourceStatus !== 'unavailable' &&
      jobs.some((j) => j.state !== 'unavailable')
  };
}
export function updateRepairJobs(db, job) {
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
