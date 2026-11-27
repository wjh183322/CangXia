import { randomUUID } from 'node:crypto';
export function registerCatalogueHandlers({ ipc, client }) {
  ipc('serverRehearsal','workspace',input=>client.call('rehearsal',{input}));
  const command = (kind, payload) =>
    client.command({ kind, payload, operationId: randomUUID(), entityVersion: 0 });
  for (const [method,kind] of Object.entries({previewRemoval:'preview-removal',confirmRemoval:'confirm-removal',previewRestore:'preview-restore',restoreRemoval:'restore-removal',controlRemoval:'control-removal',startTrashProbe:'start-trash-probe',controlTrashProbe:'control-trash-probe'}))
    ipc(method,'workspace',payload=>command(kind,payload));
  for (const [method,kind] of Object.entries({removalStatus:'removal-status',removalHistory:'removal-history',trashStatus:'trash-status'}))
    ipc(method,'workspace',payload=>client.query(kind,payload??{}));
  const control = (action, ids = null, extra = {}) => command('control-download', { action, ids, ...extra });
  ipc('downloadPage', 'workspace', (query) => client.query('download-page', query));
  ipc('downloadBatch', 'workspace', (query) => client.query('download-batch', query));
  ipc('validateDownloadSelection','workspace',query=>client.query('validate-downloads',query));
  ipc('previewDownloads', 'workspace', (workIds) => client.query('preview-download', { workIds }));
  ipc('repairVideoCover', 'workspace', (workIds, revision) =>
    command('enqueue-download', { workIds, selection: 'repair-cover', revision })
  );
  ipc('download', 'workspace', (workIds, options = {}) =>
    command('enqueue-download', {
      workIds,
      selection: options.scope || 'missing',
      revision: options.revision
    })
  );
  ipc('setDownloadConcurrency', 'workspace', (value) => control('concurrency', null, { value }));
  ipc('pause', 'workspace', () => control('pause'));
  ipc('resume', 'workspace', () => control('resume'));
  ipc('retryDownloads', 'workspace', (ids) => control('retry', ids ?? null));
  ipc('cancelDownloads', 'workspace', (ids, options) =>
    control('cancel', ids ?? null, { state: options?.state })
  );
  ipc('clearCompleted', 'workspace', (ids) => control('clear', ids ?? null));
  ipc('catalogueAction', 'workspace', (action, selection) =>
    client.command({
      operationId: randomUUID(),
      kind: 'catalogue-action',
      entityVersion: 0,
      payload: { action, selection }
    })
  );
  for (const [method, query] of Object.entries({
    previewDownloadSelection: 'download-selection',
    listWorks: 'list-works',
    cataloguePosition: 'catalogue-position',
    catalogueChoices: 'catalogue-choices',
    resolveSelection: 'resolve-selection'
  }))
    ipc(method, 'workspace', (payload) => client.query(query, payload));
}
