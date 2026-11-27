import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function registerReadHandlers({ ipc, client, notify, openExternal }) {
  let activeSource;
  async function sourceOperation(action, body = {}) {
    const slot = { id: randomUUID(), epoch: client.epoch, stopped: false };
    if (activeSource?.epoch === slot.epoch) throw Error('已有来源读取正在进行。');
    activeSource = slot;
    try {
      await client.call('source/begin', { operationId: slot.id, action });
      if (slot.stopped) {
        await client.call('source/stop', { operationId: slot.id });
        throw Error('来源读取已停止。');
      }
      return await client.call('source/' + action, { ...body, operationId: slot.id });
    } finally {
      if (activeSource === slot) activeSource = null;
    }
  }
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
        job.steps.find((s) => s.token === job.selectedStep) ??
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
      await sourceOperation('folders');
      return state();
    }
    const id = options.collectionId ?? '__all__',
      mode = options.mode ?? 'quick';
    const source = { kind: id === '__all__' ? 'total' : 'collection', id };
    if (options.resume || options.reset) {
      const prior = options.checkpoint;
      if (!prior?.jobId || !prior.stepId) throw Error('找不到所选读取的 NAS 断点。');
      return waitRead(
        await controlRead({
          jobId: prior.jobId,
          stepId: prior.stepId,
          source,
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
    return waitRead(
      await controlRead({
        jobId: run.batchId,
        stepId: run.token,
        source: { kind: collectionId === '__all__' ? 'total' : 'collection', id: collectionId },
        action: 'confirm'
      })
    );
  });
  handle('stopSync', async () => {
    if (activeSource?.epoch === client.epoch) {
      activeSource.stopped = true;
      await client.call('source/stop', { operationId: activeSource.id });
      return state();
    }
    const { collector } = await client.query('state');
    if (collector.jobId) await controlRead({ jobId: collector.jobId, action: 'stop' });
    return state();
  });
  handle('addCollections', async (ids) => {
    await command('add-folders', { ids });
    return state();
  });
  handle('addAuthor', async (text) => {
    const result = await sourceOperation('author', { text });
    await state();
    return result;
  });
  handle('readAuthor', async ({ id, limit = 20, readAll = false, resume = false, checkpoint }) => {
    let receipt;
    if (resume) {
      if (!checkpoint?.jobId || !checkpoint.stepId) throw Error('找不到所选作者断点。');
      receipt = await controlRead({
        ...checkpoint,
        source: { kind: 'author', id },
        action: 'resume',
        limit,
        readAll
      });
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
    const source = await sourceOperation('resolve-work', { text });
    const result = await waitRead(await startRead({ source, mode: 'full' }));
    if (result.readSummary.outcome !== 'imported') throw Error(result.collector.message);
    return source.id;
  });
  let creatorRefresh;
  handle('refreshWorkCreators',async id=>{
    if(creatorRefresh)throw Error('已有作者信息更新正在进行。');
    if(!await client.query('work-detail',{id}))throw Error('找不到作品。');
    const task={id,epoch:client.epoch,stopped:false};creatorRefresh=task;
    try{
      const receipt=await startRead({source:{kind:'link',id},mode:'full'});
      task.jobId=receipt.jobId;
      if(task.stopped)await controlRead({action:'stop',jobId:task.jobId});
      const result=await waitRead(receipt);
      if(result.readSummary.outcome!=='imported')throw Error(result.collector.message||'未取得作者信息。');
      if(task.stopped)throw Error('作者信息更新已停止。');
      task.profiles=true;
      const refreshed=await sourceOperation('creator-profiles',{id});
      await state();
      return refreshed;
    }finally{if(creatorRefresh===task)creatorRefresh=null;}
  });
  handle('stopWorkCreators',async id=>{
    const task=creatorRefresh;if(!task||task.id!==id||task.epoch!==client.epoch)return false;
    task.stopped=true;
    if(task.profiles&&activeSource){activeSource.stopped=true;await client.call('source/stop',{operationId:activeSource.id});}
    else if(task.jobId)await controlRead({action:'stop',jobId:task.jobId});return true;
  });
  handle('workDetail', (id) => client.query('work-detail', { id }));
  handle('openOriginal', async (id) => {
    if (typeof id !== 'string' || !/^\d{1,40}$/.test(id) || !/[1-9]/.test(id)) throw Error('作品 ID 无效。');
    const stored = await client.query('work-detail', { id });
    if(stored?.invalidOriginal)throw Error('原作品链接与所选 ID 不符。');
    let target = 'https://www.douyin.com/'+(stored?.type==='images'?'note':'video')+'/'+id;
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
