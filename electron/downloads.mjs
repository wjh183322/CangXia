import fs from 'node:fs';
import path from 'node:path';
import {transferAsset} from './resumable-transfer.mjs';
import { isMediaURL, requireInside } from './model.mjs';
import { imageDimensions } from './media-info.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { inspectWorkFiles } from './repair-check.mjs';
import {setImmediate as yieldToUI} from 'node:timers/promises';
const storageFailure=e=>['ENOSPC','EACCES','EPERM','EROFS','ENOENT','ENOTDIR','EISDIR','EBUSY','EIO','EMFILE'].includes(e?.code)||String(e?.code||'').startsWith('SQLITE');
const sourceFailure=e=>!storageFailure(e)&&(e?.sourceUnavailable||e?.refreshable||e?.httpStatus>=400||e?.code==='AUTH_REQUIRED'||['ECONNRESET','ETIMEDOUT','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ERR_STREAM_PREMATURE_CLOSE','UND_ERR_SOCKET'].includes(e?.code||e?.cause?.code)||e?.name==='TimeoutError');

function extension(contentType, kind) {
  const t = (contentType || '').split(';')[0];
  if (kind === 'video') {
    if (!['video/mp4', 'application/octet-stream', 'video/x-m4v'].includes(t)) throw Object.assign(new Error('返回的内容不是可保存的视频'),{sourceUnavailable:true});
    return '.mp4';
  }
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif' }[t];
  if (!ext) throw Object.assign(new Error('没有取得静态原图，已保留已有文件'),{sourceUnavailable:true});
  return ext;
}
export class DownloadQueue {
  constructor(store, collector, fetchMedia, notify) {
    Object.assign(this, { store, collector, fetchMedia, notify });
    this.taskRows=store.downloadTasks;
    this.jobs = (store.getSetting('downloadJobs') || []).map(j=>({...j,source:j.source==='nas'?'nas':'douyin',state:j.state==='running'?'waiting':j.state}));
    this.running=false;this.paused=this.jobs.some(j=>j.state==='waiting');this.active=new Map();this.resolveTail=Promise.resolve();this.cursor=0;
    const saved=store.getSetting('downloadConcurrency');this.concurrency=Number.isInteger(saved)&&saved>=1&&saved<=6?saved:3;
  }
  get jobs(){return this.taskRows?.jobs||this.legacyJobs||[];}
  set jobs(value){if(this.taskRows)this.taskRows.replace(value);else this.legacyJobs=value;}
  state({summary=false}={}) { const jobs=summary&&this.taskRows?[...this.taskRows.bucket('running')].map(id=>this.taskRows.byId.get(id)):this.jobs;return { summary,revision:this.taskRows?.revision||0,counts:this.taskRows?.counts(),total:this.jobs.length,jobs: jobs.map(({ id, title, state, progress, message, phase,coverOnly,source,activeSource }) => ({ id, title, state, progress, message, phase,coverOnly,source:source||'douyin',activeSource })), paused: this.paused, running: this.running, concurrency:this.concurrency, active:this.active.size, transferring:jobs.filter(j=>j.state==='running'&&j.phase==='transferring').length, pauseReason:this.pauseReason||'' }; }
  setConcurrency(value){
    if(!Number.isInteger(value)||value<1||value>6)throw new Error('同时下载数量应为 1 至 6');
    this.concurrency=value;this.store.setSetting('downloadConcurrency',value);this.store.save();this.wake?.();this.notify();
  }
  clearCompleted(ids) {
    const selected=ids===null?null:new Set(ids);
    this.jobs=this.jobs.filter(j=>j.state!=='complete'||selected&&!selected.has(j.id));
    this.cursor=0;this.emit(true);this.store.save();
  }
  async cancel(ids=null){
    const selected=ids===null?null:new Set(ids),removed=this.jobs.filter(j=>j.state!=='complete'&&(!selected||selected.has(j.id)));
    const removedIds=new Set(removed.map(j=>j.id)),pending=[];
    // Persist queue removal before waiting for network/file handles to settle.
    this.jobs=this.jobs.filter(j=>!removedIds.has(j.id));this.cursor=0;
    if(this.jobs.every(j=>j.state==='complete'))this.pauseReason='';
    this.emit(true);this.store.save();
    for(const id of removedIds){const task=this.active.get(id);if(task){task.cancelled=true;task.controller.abort();pending.push(task.promise);}}
    this.wake?.();await Promise.allSettled(pending);this.emit(true);
    return {cancelled:removedIds.size};
  }
  emit(force=false) {
    // Asset checkpoints remain durable; avoid serializing a 30,000-job queue on every byte update.
    if(force||!this.lastPersist||Date.now()-this.lastPersist>=5000){
      if(this.taskRows)this.taskRows.flush();else this.store.setSetting('downloadJobs',this.jobs.map(({id,title,state,progress,message,coverOnly,source})=>({id,title,state,progress,message,coverOnly,source:source||'douyin'})));this.lastPersist=Date.now();
    }
    this.notify();
  }
  enqueue(ids,{coverOnly=false,source='douyin'}={}) {
    if(!['douyin','nas'].includes(source))throw Error('下载来源无效');
    if(ids.some(id=>this.active.get(id)?.cancelled))throw Error('该任务正在取消，请稍后重新添加');
    const requested=new Set(ids);if(this.jobs.some(j=>requested.has(j.id)&&['waiting','running'].includes(j.state)&&(!!j.coverOnly!==coverOnly||(!coverOnly&&(j.source||'douyin')!==source))))throw Error('所选作品已有不同类型或来源的任务，请先完成或取消该任务');
    const busy=new Set(this.jobs.filter(j=>['waiting','running'].includes(j.state)).map(j=>j.id)),added=[];
    for (const id of [...new Set(ids)]) {
      if(busy.has(id))continue;
      const w = this.store.lightViews?.ready?this.store.lightViews.bases.get(id):this.store.work(id); if (!w) continue;
      added.push({ id, title: w.name, state: 'waiting', progress: 0, message: '',coverOnly,source });
    }
    const replacing=new Set(added.map(j=>j.id));this.jobs=this.jobs.filter(j=>!replacing.has(j.id)).concat(added);this.cursor=0;
    this.paused = false;this.pauseReason=''; this.emit(true);this.wake?.();void this.run();
    return added.length;
  }
  pause() { this.paused = true;for(const task of this.active.values())task.controller.abort();if(this.resolving)this.collector.cancelResolve?.('下载已暂停');this.wake?.();this.emit(true);this.store.save(); }
  resume() { this.pauseReason='';this.paused = false;this.cursor=0;this.emit(true);this.wake?.();void this.run(); }
  async resolveWork(id,signal,job){
    if(job){job.phase='waitingResource';job.message='等待后台刷新资源';this.emit();}
    const previous=this.resolveTail;let release;this.resolveTail=new Promise(r=>{release=r;});
    let onAbort;
    try{signal.throwIfAborted();await Promise.race([previous,new Promise((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});})]);signal.throwIfAborted();this.resolving=true;if(job){job.phase='resolving';job.message='后台刷新作品资源';this.emit();}try{return await this.collector.resolveWork(id,{backgroundOnly:true,signal});}finally{this.resolving=false;}}
    finally{if(onAbort)signal.removeEventListener('abort',onAbort);void previous.then(release);}
  }
  waitForIdle(){if(!this.running)return Promise.resolve();return new Promise(resolve=>(this.idleWaiters??=[]).push(resolve));}
  async run() {
    if (this.running) return; this.running = true;this.cursor=0;
    try {
      while (true) {
        while(!this.paused&&this.active.size<this.concurrency&&this.cursor<this.jobs.length){
          const job=this.jobs[this.cursor++];if(job.state!=='waiting'||this.active.has(job.id))continue;
          const task={controller:new AbortController()};this.active.set(job.id,task);job.state='running';job.phase='preparing';this.emit();
          task.promise=Promise.resolve().then(()=>this.saveWork(job,task.controller.signal)).then(async()=>{
            if(task.cancelled)return;
            job.phase='checking';try{const confirmed=await this.store.fileStates?.confirmWritten(job.id);if(this.store.fileStates&&!confirmed&&!job.coverOnly)throw Error('已保存文件的当前状态未通过确认');}catch(error){if(!task.cancelled){job.state='failed';job.message='已保存内容保留，文件确认暂未完成：'+error.message;}return;}if(task.cancelled)return;
            job.state='complete';job.progress=100;job.message='文件已保存';
          },e=>{
            if(task.cancelled)return;
            if(e.code==='AUTH_REQUIRED'){this.pauseReason=e.message;this.pause();}
            const interrupted=task.controller.signal.aborted;
            job.state=interrupted?'waiting':'failed';job.message=interrupted?'已暂停，继续时补齐':e.message;
            if(interrupted)this.cursor=0;
          }).finally(()=>{this.active.delete(job.id);this.emit();this.store.save();});
        }
        if(!this.active.size)break;
        await Promise.race([...this.active.values()].map(t=>t.promise).concat(new Promise(r=>{this.wake=r;})));this.wake=null;
        await yieldToUI();
      }
    } finally { this.running = false;this.wake=null;this.emit(true);for(const resolve of this.idleWaiters||[])resolve();this.idleWaiters=[];if(!this.paused)this.onIdle?.(); }
  }
  async saveWork(job, signal) {
    signal.throwIfAborted();
    if(job.coverOnly){const w=this.store.work(job.id),d=this.store.download(job.id);if(w?.type!=='video'||!d)throw Error('本机没有可补齐封面的视频');try{await this.ensureHDCover(job,w,d,signal);}finally{if(!signal.aborted){this.saveMetadata(w,d);this.store.put('downloads',d.id,d);const check=inspectWorkFiles(this.store,job.id);if(check.status!=='error')d.state=check.missing.length?'partial':'complete';this.store.put('downloads',d.id,d);this.store.save();}}return;}
    if(job.source==='nas'){
      job.activeSource='nas';job.message='从 NAS 恢复备份';this.emit();
      if(this.backupRestore&&await this.backupRestore(job,signal))return;
      throw Error('NAS 没有完整媒体备份；已恢复的文件保留，可到收藏或作者作品中尝试下载');
    }
    try{return await this.saveFromDouyin(job,signal);}catch(error){
      signal.throwIfAborted();if(!sourceFailure(error)||!this.backupRestore)throw error;
      job.activeSource='nas';job.message='抖音资源未取得，尝试从 NAS 补齐';this.emit();
      try{if(await this.backupRestore(job,signal,{missingOnly:true}))return;}
      catch(nasError){signal.throwIfAborted();throw Error(`抖音下载失败：${error.message}；NAS 补齐失败：${nasError.message}`);}
      throw error;
    }
  }
  async saveFromDouyin(job,signal){
    job.activeSource='douyin';
    const { store } = this;
    const inspection=inspectWorkFiles(store,job.id);
    if(inspection.status==='error')throw new Error(inspection.error);
    const w=store.work(job.id);
    if (inspection.status==='complete') { job.message = '文件完整，无需补齐'; return; }
    try{return await this.saveResources(job,signal,w);}
    catch(error){
      signal.throwIfAborted();if(!error.refreshable)throw error;
      let fresh;try{fresh=await this.resolveWork(job.id,signal,job);}catch(e){if(!storageFailure(e))e.sourceUnavailable=true;throw e;}signal.throwIfAborted();
      // Only one refresh per work attempt; saved assets are retained and skipped below.
      return this.saveResources(job,signal,fresh||store.work(job.id));
    }
  }
  async saveResources(job,signal,w){
    signal.throwIfAborted();const {store}=this;
    const old = store.download(job.id);
    if (old) store.relocate(job.id);
    const { dir, collectionId,home } = store.destination(job.id);
    store.assertDirectory(dir); fs.mkdirSync(dir, { recursive: true });
    let d = { ...store.download(job.id), id: job.id, path: dir, collectionId, home,state: 'partial', assets: store.download(job.id)?.assets || [], savedAt: old?.savedAt || new Date().toISOString() };
    store.put('downloads', job.id, d); store.save();
    const targets = w.type === 'video'
      ? [{ key: 'video', name: '视频', kind: 'video', urls: w.videoUrls }, { key: 'cover', name: '单图', kind: 'image', urls: w.coverUrls }]
      : w.images.map(im => ({ key: `image-${im.index}`, name: `图片-${String(im.index + 1).padStart(3, '0')}`, kind: 'image', urls: im.urls }));
    if (!targets.length) throw Object.assign(new Error('未获得作品媒体资源'),{refreshable:true});
    let completed = 0; const failures = [];let refreshable=false,allSourceFailures=true;
    for (const target of targets) {
      if (signal.aborted) throw new Error('已暂停');
      const existing = d.assets.find(a => a.key === target.key);
      if (existing && store.assetExists(d, existing)) {
        if(existing.kind==='image' && !existing.width) Object.assign(existing,imageDimensions(fs.readFileSync(path.join(d.path,existing.file))));
        completed++; continue;
      }
      job.phase='connecting';job.message = `从抖音连接${target.name}`; this.emit();
      try {
        const progress=bytes => { job.phase='transferring';job.progress = Math.round((completed / targets.length) * 95); job.message = `抖音 · ${target.name} · ${(bytes / 1048576).toFixed(1)} MB`; this.emit(); };
        const asset = target.key==='cover' && w.coverVariants?.length ? await this.saveBestCover(dir,w.coverVariants,signal,progress) : await this.saveAsset(dir, target, signal, progress);
        d.assets = [...d.assets.filter(a => a.key !== target.key), asset];
        store.put('downloads', job.id, d); store.save();
      } catch (e) { if (signal.aborted||e.code==='AUTH_REQUIRED') throw e;refreshable ||= !!e.refreshable||[401,403,404,410].includes(e.httpStatus);allSourceFailures&&=!!sourceFailure(e);failures.push(`${target.name}：${e.message}`); }
      completed++;
    }
    d.state = failures.length ? 'partial' : 'complete';
    d.coverSource = d.assets.find(a=>a.key==='cover')?.source || w.coverSource; d.lastError = failures.join('；');
    const cover = d.assets.find(a=>a.key==='cover');
    if(!d.hdCover)d.coverWarning = cover?.width ? `当前封面 ${cover.width}×${cover.height}，可手动补齐高清图` : '';
    this.saveMetadata(w,d);
    store.put('downloads', job.id, d); store.save(); this.emit();
    if (failures.length) throw Object.assign(new Error(`部分已保存，${failures.join('；')}`),{refreshable:refreshable&&allSourceFailures,sourceUnavailable:allSourceFailures});
  }
  async ensureHDCover(job,w,d,signal){
    if(!this.hdCovers)return;
    try{await this.hdCovers.ensure(this,w,d,signal,message=>{job.phase='matching';job.message=message;this.emit();});}
    catch(e){if(signal.aborted)throw e;d.hdCover={status:'failed',message:e.message};d.coverWarning='未取得与视频清晰度相当的封面：'+e.message;throw Error(d.coverWarning);}
  }
  saveMetadata(w,d){
    const metadata = this.metadata(w, d),dir=d.path;
    const file = requireInside(dir, path.join(dir, '作品信息.json'));
    fs.writeFileSync(file + '.part', JSON.stringify(metadata, null, 2)); fs.renameSync(file + '.part', file);
    d.assets = [...d.assets.filter(a => a.key !== 'metadata'), { key: 'metadata', file: '作品信息.json', size: fs.statSync(file).size, kind: 'metadata' }];
  }
  metadata(w, d) {
    return { schemaVersion: 1, workId: w.id, workName: w.name, title: w.title, caption:w.caption, description: w.description, author: w.author, coAuthors:w.coAuthors||[], tags: w.tags, rawTags:w.rawTags, localTags: this.store.get('local_tags', w.id)?.tags || [], publishedAt: w.publishedAt, originalURL: w.url, collection: this.store.collection(d.collectionId)?.name || '收藏', collectionId: d.collectionId, savedAt: d.savedAt, remoteState: w.remoteState, checkedAt: w.checkedAt, hdCover:d.hdCover, coverSource: d.assets.find(a=>a.key==='cover')?.source || w.coverSource, assets: d.assets.filter(a=>a.key!=='metadata').map(({ key, file, size, width, height, source, comparisons,match }) => ({ key, file, size, width, height, source, comparisons,match })) };
  }
  async saveAsset(dir, target, signal, progress) {
    if (!target.urls?.length) throw Object.assign(new Error('作品未提供此资源'),{refreshable:true});
    let lastError;
    for (const url of target.urls.slice(0, 9)) {
      if (!isMediaURL(url)) continue;
      try {
        let lastProgress=0;const {file,size,sha256,resumedBytes}=await transferAsset({dir,target,url,signal,fetchMedia:async(...args)=>{try{return await this.fetchMedia(...args);}catch(e){if(!storageFailure(e))e.sourceUnavailable=true;throw e;}},extension,progress:bytes=>{if(Date.now()-lastProgress>500){lastProgress=Date.now();progress(bytes);}}});
        const dimensions=target.kind==='image'?imageDimensions(fs.readFileSync(file)):{};
        return { key: target.key, kind: target.kind, file: path.basename(file), size,sha256,resumedBytes,...dimensions };
      } catch (e) {
        if (signal.aborted||e.httpStatus===429||e.code==='AUTH_REQUIRED') throw e; lastError = e;
      }
    }
    throw lastError || Object.assign(new Error('没有可用的媒体地址'),{refreshable:true});
  }
  async saveBestCover(dir,variants,signal,progress){
    const candidates=[];const seen=new Set();let lastError;
    try{
      const groups=[];
      for(const variant of variants.slice(0,3))for(const url of variant.urls.slice(0,9)){
        if(!isMediaURL(url))continue;const u=new URL(url);for(const key of ['x-signature','x-expires','l','from','s','lk3s'])u.searchParams.delete(key);u.searchParams.sort();const identity=u.pathname+'?'+u.searchParams.toString();
        let group=groups.find(g=>g.identity===identity);if(!group){group={identity,source:variant.source,urls:[]};groups.push(group);}if(!group.urls.includes(url))group.urls.push(url);
      }
      for(const variant of groups.slice(0,9)){
        if(signal.aborted)throw new Error('已暂停');
        const identity=JSON.stringify([...variant.urls].sort());if(seen.has(identity))continue;seen.add(identity);
        const urls=variant.urls;
        try{const candidate=await this.saveAsset(dir,{key:'cover',name:'.cangxia-'+randomUUID(),kind:'image',urls},signal,progress);candidate.source=variant.source;candidate.sha256=createHash('sha256').update(fs.readFileSync(path.join(dir,candidate.file))).digest('hex');candidates.push(candidate);}catch(e){lastError=e;if(signal.aborted)throw e;}
      }
      if(!candidates.length)throw lastError||new Error('没有可用静态单图');
      const sorted=[...candidates].sort((a,b)=>(b.width||0)*(b.height||0)-(a.width||0)*(a.height||0));const best=sorted[0];
      const comparisons=candidates.map(({source,width,height,size,sha256})=>({source,width,height,size,sha256}));
      const final=path.join(dir,'单图'+path.extname(best.file));fs.renameSync(path.join(dir,best.file),final);
      return {...best,file:path.basename(final),comparisons};
    }finally{for(const c of candidates){const file=requireInside(dir,path.join(dir,c.file));if(fs.existsSync(file))fs.unlinkSync(file);}}
  }
}
