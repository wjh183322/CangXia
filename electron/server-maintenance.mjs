import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DirectorySize } from './directory-size.mjs';

export function registerMaintenanceHandlers({
  ipc,
  client,
  chooseDiagnostic,
  openDirectory,
  diagnostics,
  cache
}) {
  const handle = (name, fn) => ipc(name, 'workspace', fn);
  const command = (kind, payload) =>
    client.command({ kind, payload, operationId: randomUUID(), entityVersion: 0 });
  const control = (id, action) => command('control-check', { id, action });
  let cacheResult;
  const usage = new DirectorySize({
    getRoot: () => cache.directory,
    getSaved: () => cacheResult,
    save: (r) => {
      cacheResult = r;
    }
  });
  async function selection(ids) {
    const view = await client.query('list-works', { source: 'maintenance' });
    return {
      source: 'maintenance',
      scope: view.scope,
      revision: view.revision,
      all: !ids,
      ids: ids ?? [],
      confirmedCount: ids ? ids.length : view.total
    };
  }
  async function start(kind, input) {
    return command('start-check', {
      kind,
      selection: Array.isArray(input) || !input ? await selection(input) : input
    });
  }
  for (const name of ['refreshFiles', 'checkRepairs', 'inspectDefects'])
    handle(name, (input) => start('files', input));
  for (const name of ['cancelFileCheck', 'cancelRepairs', 'stopDefectRepair'])
    handle(name, (id) => control(id, 'stop'));
  for (const name of ['repairPage', 'defectPage']) handle(name, (q) => client.query('check-page', q));
  for (const name of ['startRepairs', 'startDefectRepair'])
    handle(name, (selection) => command('retry-repair', { selection }));
  handle('validateDefectSelection', (selection) => client.query('validate-check-selection', selection));
  handle('resumeDefectRepair', (id) => control(id, 'resume'));
  handle('resumeReconcile', (revision) => command('start-check', { kind: 'reconcile', revision }));
  handle('defectOverview', (query) => client.query('check-history', query ?? {}));
  handle('verifySources', (s) => start('source', s));
  handle('checkSource', async (id) => {
    const { id: run } = await start('source', [id]);
    for (;;) {
      const page = await client.query('check-page', { id: run });
      if (page.state !== 'running')
        return {
          state: page.items[0]?.sourceStatus ?? 'unknown',
          reason: page.reason ?? page.items[0]?.issues[0]?.reason,
          id: run
        };
      await delay(120, undefined, { signal: client.signal() });
    }
  });
  handle('markSourceUnavailable', (workId, revision) =>
    command('mark-source-unavailable', { workId, revision })
  );
  handle('reportCoverStatus', (workId, failed, identity) =>
    command('cover-display', { workId, failed, identity })
  );
  handle('openDiagnostics', () => openDirectory(diagnostics.dir));
  handle('exportWorkDiagnostic', async (workId) => {
    const epoch = client.epoch,
      record = await client.query('work-diagnostic', { workId });
    const { canceled, filePath } = await chooseDiagnostic({
      title: '导出作品诊断',
      defaultPath: path.join(diagnostics.dir, '作品诊断-' + record.workId + '.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    client.assert(epoch);
    if (canceled || !filePath) return { saved: false };
    const temporary = path.join(path.dirname(filePath), '.cangxia-diagnostic-' + randomUUID() + '.tmp');
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(record, null, 2) + '\n', 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      client.assert(epoch);
      await fs.rename(temporary, filePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
    return { saved: true };
  });
  handle('refreshStorageSize', async () => {
    const receipt = await command('start-check', { kind: 'storage' });
    const signal = client.signal(),
      stop = () => usage.cancel();
    signal.addEventListener('abort', stop, { once: true });
    void usage.start().finally(() => signal.removeEventListener('abort', stop));
    return receipt;
  });
  handle('cancelStorageSize', async (id) => {
    const receipt = await control(id, 'stop');
    usage.cancel();
    return receipt;
  });
  handle('storageUsage', async () => {
    const latest = await client.query('check-history', { kind: 'storage' });
    const local = usage.state();
    return {
      run: latest.items[0],
      cache: {
        phase: local.phase,
        bytes: local.bytes ?? local.result?.bytes,
        files: local.files,
        message: local.message
      }
    };
  });
}
