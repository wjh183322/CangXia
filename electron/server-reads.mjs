import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function registerReadHandlers({ ipc, client, notify, openExternal }) {
  const handle = (name, fn) => ipc(name, 'workspace', fn);
  const command = (kind, payload, operationId = randomUUID()) =>
    client.command({ kind, payload, operationId, entityVersion: 0 });
  const startRead = ({ operationId, ...payload }) => command('start-read', payload, operationId);
  const controlRead = ({ operationId, ...payload }) => command('control-read', payload, operationId);
  const state = async () => {
    const snapshot = await client.query('state');
    notify(snapshot);
    return snapshot;
  };
  async function waitRead({ jobId }) {
    const signal = client.signal();
    for (;;) {
      const job = await client.query('read-job', { jobId });
      const step =
        job.steps.find((s) => ['running', 'waiting', 'paused', 'finalizing', 'review'].includes(s.status)) ??
        job.steps.at(-1);
      if (!job.running) {
        const snapshot = await client.query('state');
        snapshot.readSummary = { ...step, message: step.reason || job.message };
        snapshot.collector.message = job.message || step.reason;
        if (job.steps.length > 1)
          snapshot.collector.collectionBatch = {
            ...job,
            includeTotal: job.steps[0].scope === '__all__',
            items: job.steps.map((s) => ({
              id: s.scope,
              name: s.name,
              state: s.status,
              message: s.reason,
              summary: s
            }))
          };
        notify(snapshot);
        return snapshot;
      }
      notify({
        delta: true,
        collector: {
          connected: true,
          busy: true,
          phase: 'syncing',
          jobId,
          message: '正在读取' + step.name,
          readProgress: {
            mode: step.mode,
            name: step.name,
            checked: step.checked,
            added: step.added,
            restored: step.restored,
            stage: 'reading',
            startedAt: Date.parse(step.startedAt)
          }
        }
      });
      await delay(350, undefined, { signal });
    }
  }
  handle('startRead', startRead);
  handle('controlRead', controlRead);
  handle('historyItems', (payload) => client.query('history-items', payload));
  handle('sync', async (options = {}) => {
    if (options.discoverOnly) {
      await client.call('source/folders', {});
      return state();
    }
    const id = options.collectionId ?? '__all__',
      mode = options.mode ?? 'quick';
    const source = { kind: id === '__all__' ? 'total' : 'collection', id };
    if (options.resume || options.reset) {
      const prior = (await client.query('state')).collectionReadInfo[id]?.[mode];
      if (!prior?.batchId) throw Error('找不到可继续的读取进度。');
      return waitRead(
        await controlRead({
          jobId: prior.batchId,
          action: options.reset ? 'reset' : 'resume',
          followFolders: options.syncCollections === true,
          confirmed: options.reset === true,
          allowFullScan: options.allowFullScan === true
        })
      );
    }
    return waitRead(
      await startRead({
        source,
        mode,
        ...(options.syncCollections ? { followFolders: true } : {}),
        allAdded: options.allAdded === true,
        allowFullScan: options.allowFullScan === true
      })
    );
  });
  handle('confirmCollectionRead', async ({ collectionId, mode, token }) => {
    const run = (await client.query('state')).collectionReadInfo[collectionId]?.[mode];
    if (!run || run.token !== token) throw Error('读取记录已变化。');
    return waitRead(await controlRead({ jobId: run.batchId, action: 'confirm' }));
  });
  handle('stopSync', async () => {
    const { collector } = await client.query('state');
    if (collector.jobId) await controlRead({ jobId: collector.jobId, action: 'stop' });
    return state();
  });
  handle('addCollections', async (ids) => {
    await command('add-folders', { ids });
    return state();
  });
  handle('addAuthor', async (text) => {
    const result = await client.call('source/author', { text });
    await state();
    return result;
  });
  handle('readAuthor', async ({ id, limit = 20, readAll = false, resume = false }) => {
    let receipt;
    if (resume) {
      const author = (await client.query('state')).authors.find((a) => a.id === id);
      if (!author?.run?.batchId) throw Error('找不到作者的上次读取。');
      receipt = await controlRead({ jobId: author.run.batchId, action: 'resume', limit, readAll });
    } else
      receipt = await startRead({
        source: { kind: 'author', id },
        mode: readAll ? 'full' : 'partial',
        limit
      });
    const snapshot = await waitRead(receipt);
    return { id, readSummary: snapshot.readSummary };
  });
  handle('importLink', async (text) => {
    const source = await client.call('source/resolve-work', { text });
    const result = await waitRead(await startRead({ source, mode: 'full' }));
    if (result.readSummary.outcome !== 'imported') throw Error(result.collector.message);
    return source.id;
  });
  handle('workDetail', (id) => client.query('work-detail', { id }));
  handle('openOriginal', async (id) => {
    if (typeof id !== 'string' || !/^\d{1,40}$/.test(id) || !/[1-9]/.test(id)) throw Error('作品 ID 无效。');
    const stored = await client.query('work-detail', { id });
    let target = 'https://www.douyin.com/video/' + id;
    if (stored?.url) {
      let url;
      try {
        url = new URL(stored.url);
      } catch {
        throw Error('原作品链接无效。');
      }
      if (
        url.protocol !== 'https:' ||
        url.port ||
        url.username ||
        url.password ||
        !['www.douyin.com', 'douyin.com'].includes(url.hostname) ||
        !new RegExp('^/(?:video|note|slides)/' + id + '/?$').test(url.pathname)
      )
        throw Error('原作品链接与所选 ID 不符。');
      target = url.origin + url.pathname;
    }
    await openExternal(target);
    return true;
  });
  handle('readHistoryRuns', (payload) => client.query('history-runs', payload));
  handle('readHistoryItems', (runId, options) => client.query('history-items', { runId, ...options }));
  handle('clearReadHistory', () => command('clear-read-history', {}));
}
