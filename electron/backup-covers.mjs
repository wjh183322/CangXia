import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {bestCover} from './hd-cover.mjs';
import {readCachedPreview,fetchPreviewImage} from './backup-previews.mjs';
import {isMediaURL} from './model.mjs';

// Cover reads are allowed on a read-only client and never create download records.
export class BackupCovers {
  constructor(client){this.client=client;this.pending=new Map();this.active=0;this.waiters=[];this.controller=new AbortController();this.problemFile=path.join(client.profile,'cover-problems.json');try{this.problems=new Map(Object.entries(JSON.parse(syncFs.readFileSync(this.problemFile,'utf8'))).filter(([id,p])=>/^\d+$/.test(id)&&typeof p?.reason==='string'));}catch{this.problems=new Map();}}
  saveProblems(){const temporary=this.problemFile+'.'+randomUUID()+'.tmp';try{syncFs.mkdirSync(this.client.profile,{recursive:true});syncFs.writeFileSync(temporary,JSON.stringify(Object.fromEntries(this.problems)),{flag:'wx'});syncFs.renameSync(temporary,this.problemFile);}catch(error){this.client.onDiagnostic?.({event:'cover-problem-save-failed',code:error.code,reason:error.message});}finally{try{syncFs.rmSync(temporary,{force:true});}catch{}}}
  scheduleProblems(){if(this.problemTimer)return;this.problemTimer=setTimeout(()=>{this.problemTimer=null;this.saveProblems();},500);this.problemTimer.unref?.();}
  reportProblem(id,reason,kind='nas'){if(this.controller.signal.aborted||!/^\d+$/.test(String(id)))return;this.problems.set(String(id),{reason:String(reason).replace(/https?:\/\/\S+/g,'[图片地址]').slice(0,180),kind,time:new Date().toISOString()});this.scheduleProblems();}
  clearProblem(id){if(this.problems.delete(String(id)))this.scheduleProblems();}
  async slot(action,signal){
    while(this.active>=3){signal.throwIfAborted();await new Promise((resolve,reject)=>{const done=()=>{signal.removeEventListener('abort',abort);resolve();};const abort=()=>{const i=this.waiters.indexOf(done);if(i>=0)this.waiters.splice(i,1);reject(signal.reason);};this.waiters.push(done);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
    signal.throwIfAborted();this.active++;try{return await action();}finally{this.active--;this.waiters.shift()?.();}
  }
  async shared(key,signal,action){signal??=new AbortController().signal;signal.throwIfAborted();let entry=this.pending.get(key);if(!entry){const controller=new AbortController();entry={controller,users:new Set()};entry.promise=this.slot(()=>action(AbortSignal.any([controller.signal,this.controller.signal])),AbortSignal.any([controller.signal,this.controller.signal])).finally(()=>this.pending.delete(key));entry.promise.catch(()=>{});this.pending.set(key,entry);}const user=randomUUID();entry.users.add(user);let reject;const cancelled=new Promise((_,r)=>reject=r),abort=()=>{entry.users.delete(user);if(!entry.users.size)entry.controller.abort();reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();try{return await Promise.race([entry.promise,cancelled]);}finally{signal.removeEventListener('abort',abort);entry.users.delete(user);if(!entry.users.size)entry.controller.abort();}}
  get(id,{preferDouyin=false,signal}={}){return this.shared('cover:'+id+':'+preferDouyin,signal,s=>this.getFile(id,{preferDouyin,signal:s}));}
  async fromDouyin(id,signal){
    const file=path.join(this.client.profile,'covers',id+'.jpg');
    const alias=await this.client.cache?.alias('cover',id);if(alias)return alias.file;
    if(await readCachedPreview(file,signal))return file;
    const work=this.client.store.work(id),url=[work?.thumbnail,...(work?.coverUrls||[]),...(work?.images?.[0]?.urls||[])].find(isMediaURL);
    if(!url||!this.client.fetchCover)return null;
    return (async()=>{
      signal.throwIfAborted();
      const imageSignal=AbortSignal.any([signal,AbortSignal.timeout(2500)]);
      const result=await fetchPreviewImage(this.client.fetchCover,url,imageSignal);signal.throwIfAborted();
      if(this.client.cache){const row=await this.client.cache.writeCover(result.bytes,result.ext,{alias:id});return row.file;}
      await fs.mkdir(path.dirname(file),{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';
      try{await fs.writeFile(temporary,result.bytes,{flag:'wx'});signal.throwIfAborted();await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}
      return file;
    })();
  }
  async getFile(id,{preferDouyin=false,signal}={}){
    id=String(id);if(!/^\d+$/.test(id))throw Error('封面作品标识无效');
    const assets=this.client.store.get('backup_downloads',id)?.assets||[];
    const candidates=[bestCover(this.client.store.get('backup_downloads',id)),this.client.store.work(id)?.backupCover,assets.find(a=>a.key==='cover'),assets.find(a=>a.key==='image-0'),...assets.filter(a=>a.kind==='image')];
    const asset=candidates.find(a=>a?.kind==='image'&&/^[a-f0-9]{64}$/.test(a.sha256)&&Number.isSafeInteger(a.size)&&a.size>0&&a.size<=20*1024*1024);
    if(!asset){if(preferDouyin){try{const file=await this.fromDouyin(id,signal);if(file)this.clearProblem(id);return file;}catch(error){if(!signal.aborted)this.reportProblem(id,'抖音封面暂不可用：'+(error.code||error.message),'source');throw error;}}return null;}
    const extension=path.extname(asset.file||'').toLowerCase();
    const suffix=['.jpg','.jpeg','.png','.webp','.gif','.avif'].includes(extension)?extension:'.img';
    const directory=path.join(this.client.profile,'covers','backup');
    const file=path.join(directory,asset.sha256+suffix);
    // Prepared backup previews already exist locally; do not fetch them again from NAS.
    const localFiles=[path.join(this.client.profile,'covers','previews',asset.sha256+suffix),file];
    if(/^\d+$/.test(String(id)))localFiles.push(path.join(this.client.profile,'covers',id+'.jpg'));
    for(const local of localFiles)if(await this.client.verifiedFile(local,asset,signal)){if(this.client.cache&&!this.client.store.rows('SELECT 1 FROM media_cache_objects WHERE file=?',[local]).length)await this.client.cache.register('cover','cover:'+asset.sha256,local,asset.size,{scope:local.includes(path.sep+'previews'+path.sep)?'legacy':'cover',...(local.includes(path.sep+'previews'+path.sep)?{hold:{library:'',work:id}}:{})});this.clearProblem(id);return local;}
    // Display may use a newer platform preview. Strict NAS repair/restore callers
    // retain the default, which must return bytes matching the NAS object hash.
    if(preferDouyin){try{const online=await this.fromDouyin(id,signal);if(online){this.clearProblem(id);return online;}}catch{}signal.throwIfAborted();}
    if(!this.client.status.connected||!this.client.transport){this.reportProblem(id,'NAS 未连接，本机暂无可用封面缓存');return null;}
    try{signal.throwIfAborted();await fs.mkdir(directory,{recursive:true});const reservation=await this.client.cache?.reserve('cover',asset.size);try{await this.client.transport.download(asset,file,{signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});if(this.client.cache)await this.client.cache.register('cover','cover:'+asset.sha256,file,asset.size);}finally{reservation?.release();const partial=file+'.backup-part';if(await fs.lstat(partial).catch(()=>null))await fs.unlink(partial);}this.clearProblem(id);return file;}catch(error){if(!signal.aborted)this.reportProblem(id,'NAS 封面取回失败：'+(error.code||error.message));throw error;}
  }
  async close(){this.controller.abort();await Promise.allSettled([...this.pending.values()]);if(this.problemTimer){clearTimeout(this.problemTimer);this.problemTimer=null;this.saveProblems();}}
}
