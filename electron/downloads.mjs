import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isMediaURL, requireInside } from './model.mjs';
import { imageDimensions } from './media-info.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { inspectWorkFiles } from './repair-check.mjs';

function extension(contentType, kind) {
  const t = (contentType || '').split(';')[0];
  if (kind === 'video') {
    if (!['video/mp4', 'application/octet-stream', 'video/x-m4v'].includes(t)) throw new Error('返回的内容不是可保存的视频');
    return '.mp4';
  }
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif' }[t];
  if (!ext) throw new Error('没有取得静态原图，已保留已有文件');
  return ext;
}
export class DownloadQueue {
  constructor(store, collector, fetchMedia, notify) { Object.assign(this, { store, collector, fetchMedia, notify }); this.jobs = (store.getSetting('downloadJobs') || []).map(j=>({...j,state:j.state==='running'?'waiting':j.state})); this.running = false; this.paused = this.jobs.some(j=>j.state==='waiting'); this.controller = null; }
  state() { return { jobs: this.jobs.map(({ id, title, state, progress, message }) => ({ id, title, state, progress, message })), paused: this.paused, running: this.running }; }
  clearCompleted(ids) {
    const selected=new Set(ids);
    this.jobs=this.jobs.filter(j=>j.state!=='complete'||!selected.has(j.id));
    this.emit();this.store.save();
  }
  emit() { if(!this.store.nas||this.store.nas.canWrite())this.store.setSetting('downloadJobs',this.jobs.map(({id,title,state,progress,message})=>({id,title,state,progress,message}))); this.notify(); }
  enqueue(ids) {
    for (const id of [...new Set(ids)]) {
      const w = this.store.work(id); if (!w) continue;
      if (this.jobs.some(j => j.id === id && ['waiting', 'running'].includes(j.state))) continue;
      this.jobs = this.jobs.filter(j => j.id !== id);
      this.jobs.push({ id, title: w.name, state: 'waiting', progress: 0, message: '' });
    }
    this.paused = false; this.emit(); void this.run();
  }
  pause() { this.paused = true; this.controller?.abort(); if(this.controller)this.collector.cancelResolve?.('下载已暂停'); this.emit(); this.store.save(); }
  resume() { this.paused = false; this.emit(); void this.run(); }
  async run() {
    if (this.running) return; this.running = true;
    try {
      while (!this.paused) {
        const job=this.jobs.find(j=>j.state==='waiting');
        if(!job)break;
        job.state = 'running'; this.controller = new AbortController(); this.emit();
        try { await this.saveWork(job, this.controller.signal); job.state = 'complete'; job.progress = 100; job.message = '文件已保存'; }
        catch (e) { job.state = this.paused ? 'waiting' : 'failed'; job.message = this.paused ? '已暂停，继续时补齐' : e.message; }
        this.controller = null; this.emit(); this.store.save();
      }
    } finally { this.running = false; this.emit(); }
  }
  async saveWork(job, signal) {
    if(this.remoteSaveWork)return this.remoteSaveWork(job,signal);
    const { store } = this;
    const inspection=inspectWorkFiles(store,job.id);
    if(inspection.status==='error')throw new Error(inspection.error);
    if (inspection.status==='complete') { job.message = '文件完整，无需补齐'; return; }
    let w = store.work(job.id);
    job.message = '刷新作品资源'; this.emit();
    try { const fresh = await this.collector.resolveWork(job.id); if (fresh) w = fresh; }
    catch (e) { w=store.work(job.id)||w; if (!w.videoUrls.length && !w.images.length) throw e; }
    if (signal.aborted) throw new Error('已暂停');
    const old = store.download(job.id);
    if (old) store.relocate(job.id);
    const { dir, collectionId } = store.destination(job.id);
    store.assertDirectory(dir); fs.mkdirSync(dir, { recursive: true });
    let d = { ...store.download(job.id), id: job.id, path: dir, collectionId, state: 'partial', assets: store.download(job.id)?.assets || [], savedAt: old?.savedAt || new Date().toISOString() };
    store.put('downloads', job.id, d); store.save();
    const targets = w.type === 'video'
      ? [{ key: 'video', name: '视频', kind: 'video', urls: w.videoUrls }, { key: 'cover', name: '单图', kind: 'image', urls: w.coverUrls }]
      : w.images.map(im => ({ key: `image-${im.index}`, name: `图片-${String(im.index + 1).padStart(3, '0')}`, kind: 'image', urls: im.urls }));
    if (!targets.length) throw new Error('未获得作品媒体资源，请在抖音窗口正常打开作品后重试');
    let completed = 0; const failures = [];
    for (const target of targets) {
      if (signal.aborted) throw new Error('已暂停');
      const existing = d.assets.find(a => a.key === target.key);
      if (existing && store.assetExists(d, existing)) {
        if(existing.kind==='image' && !existing.width) Object.assign(existing,imageDimensions(fs.readFileSync(path.join(d.path,existing.file))));
        completed++; continue;
      }
      job.message = `保存${target.name}`; this.emit();
      try {
        const progress=bytes => { job.progress = Math.round((completed / targets.length) * 95); job.message = `${target.name} · ${(bytes / 1048576).toFixed(1)} MB`; this.emit(); };
        const asset = target.key==='cover' && w.coverVariants?.length ? await this.saveBestCover(dir,w.coverVariants,signal,progress) : await this.saveAsset(dir, target, signal, progress);
        d.assets = [...d.assets.filter(a => a.key !== target.key), asset];
        store.put('downloads', job.id, d); store.save();
      } catch (e) { if (signal.aborted) throw e; failures.push(`${target.name}：${e.message}`); }
      completed++;
    }
    const metadata = this.metadata(w, d);
    const file = requireInside(dir, path.join(dir, '作品信息.json'));
    fs.writeFileSync(file + '.part', JSON.stringify(metadata, null, 2)); fs.renameSync(file + '.part', file);
    d.assets = [...d.assets.filter(a => a.key !== 'metadata'), { key: 'metadata', file: '作品信息.json', size: fs.statSync(file).size, kind: 'metadata' }];
    d.state = failures.length ? 'partial' : 'complete';
    d.coverSource = d.assets.find(a=>a.key==='cover')?.source || w.coverSource; d.lastError = failures.join('；');
    const cover = d.assets.find(a=>a.key==='cover');
    d.coverWarning = cover?.width && Math.min(cover.width,cover.height)<720 ? `当前单图仅 ${cover.width}×${cover.height}，尚未取得更高清版本` : '';
    store.put('downloads', job.id, d); store.save(); this.emit();
    if (failures.length) throw new Error(`部分已保存，${failures.join('；')}`);
  }
  metadata(w, d) {
    return { schemaVersion: 1, workId: w.id, workName: w.name, title: w.title, caption:w.caption, description: w.description, author: w.author, tags: w.tags, rawTags:w.rawTags, localTags: this.store.get('local_tags', w.id)?.tags || [], publishedAt: w.publishedAt, originalURL: w.url, collection: this.store.collection(d.collectionId)?.name || '收藏', collectionId: d.collectionId, savedAt: d.savedAt, remoteState: w.remoteState, checkedAt: w.checkedAt, coverSource: d.assets.find(a=>a.key==='cover')?.source || w.coverSource, assets: d.assets.filter(a=>a.key!=='metadata').map(({ key, file, size, width, height, source, comparisons }) => ({ key, file, size, width, height, source, comparisons })) };
  }
  async saveAsset(dir, target, signal, progress) {
    if (!target.urls?.length) throw new Error('作品未提供此资源');
    let lastError;
    for (const url of target.urls.slice(0, 9)) {
      if (!isMediaURL(url)) continue;
      let partial;
      try {
        const response = await this.fetchMedia(url, { signal:AbortSignal.any([signal,AbortSignal.timeout(120000)]) });
        if (!response.ok) throw new Error(`资源请求失败（${response.status}）`);
        const ext = extension(response.headers.get('content-type'), target.kind);
        const file = requireInside(dir, path.join(dir, target.name + ext)); partial = file + '.part';
        const expected = Number(response.headers.get('content-length') || 0);
        let bytes = 0, lastProgress = 0;
        const input = Readable.fromWeb(response.body);
        input.on('data', chunk => { bytes += chunk.length; if(target.kind==='image'&&bytes>50000000)input.destroy(new Error('图片文件过大，已停止')); if (Date.now() - lastProgress > 500) { lastProgress = Date.now(); progress(bytes); } });
        await pipeline(input, fs.createWriteStream(partial, { flags: 'w' }), { signal });
        if (!bytes || (expected && bytes !== expected)) throw new Error('文件未下载完整，请重试');
        fs.renameSync(partial, file);
        const dimensions=target.kind==='image'?imageDimensions(fs.readFileSync(file)):{};
        return { key: target.key, kind: target.kind, file: path.basename(file), size: bytes, ...dimensions };
      } catch (e) {
        if (partial && fs.existsSync(partial)) fs.unlinkSync(partial);
        if (signal.aborted) throw e; lastError = e;
      }
    }
    throw lastError || new Error('没有可用的媒体地址');
  }
  async saveBestCover(dir,variants,signal,progress){
    const candidates=[];const seen=new Set();let lastError;
    try{
      for(const variant of variants.slice(0,3)){
        if(signal.aborted)throw new Error('已暂停');
        const identity=JSON.stringify([...variant.urls].sort());if(seen.has(identity))continue;seen.add(identity);
        const urls=variant.source==='cover'&&variant.urls.length>1?[variant.urls[1],variant.urls[0],...variant.urls.slice(2)]:variant.urls;
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
