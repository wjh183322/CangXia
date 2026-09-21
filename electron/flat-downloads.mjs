import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {inside,safeName,isMediaURL,requireInside} from './model.mjs';
import {transferAsset} from './resumable-transfer.mjs';

const unfinished=j=>['waiting','running','failed'].includes(j.state);
const mediaExt=/^\.(jpg|jpeg|png|webp|avif|mp4|m4v)$/i;
function regular(file){const s=fs.lstatSync(file,{throwIfNoEntry:false});return s?.isFile()&&!s.isSymbolicLink()?s:null;}
async function hashFile(file,signal){const h=createHash('sha256');for await(const bytes of fs.createReadStream(file)){signal?.throwIfAborted();h.update(bytes);}return h.digest('hex');}
function extension(type,kind){type=(type||'').split(';')[0];if(kind==='video'&&['video/mp4','video/x-m4v','application/octet-stream'].includes(type))return '.mp4';const ext={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/avif':'.avif'}[type];if(kind==='image'&&ext)return ext;throw new Error('返回的内容不是支持的图片或视频');}
function targetsFor(w,cover){return w.type==='video'?[{key:'video',kind:'video',urls:w.videoUrls||[]},...(cover?[{key:'cover',kind:'image',urls:w.coverUrls||[]}]:[]) ]:(w.images||[]).map((im,i)=>({key:`image-${im.index??i}`,kind:'image',number:i+1,urls:im.urls||[]}));}

// No store writes: batches, resource URLs and checkpoints live only in this process.
export class FlatDownloadQueue{
 constructor({store,collector,fetchMedia,notify=()=>{},protectedPaths=[]}){Object.assign(this,{store,collector,fetchMedia,notify,protectedPaths});this.batches=[];this.intents=new Map();this.checkpoints=new Map();this.running=false;}
 state(){return {running:this.running,batches:this.batches.map(b=>({id:b.id,directory:b.directory,includeCover:b.includeCover,paused:b.paused,canceled:b.canceled,cleanupMessage:b.cleanupMessage||'',total:b.jobs.length,complete:b.jobs.filter(j=>j.state==='complete').length,failed:b.jobs.filter(j=>j.state==='failed').length,files:b.jobs.reduce((n,j)=>n+j.results.size,0),skipped:b.jobs.reduce((n,j)=>n+[...j.results.values()].filter(r=>r.skipped).length,0),jobs:b.jobs.map(j=>({id:j.id,title:j.work.name,state:j.state,message:j.message||'',done:j.results.size,total:j.targets?.length||0}))}))};}
 emit(){this.notify();}
 checkDirectory(value){
  if(typeof value!=='string'||!path.isAbsolute(value))throw new Error('请选择完整的目标目录');
  const stat=fs.lstatSync(value);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('请选择普通文件夹');
  const directory=fs.realpathSync(value);
  for(const root of [this.store.root,...this.protectedPaths]){const resolved=fs.existsSync(root)?fs.realpathSync(root):path.resolve(root);if(inside(resolved,directory))throw new Error('请在普通媒体库和软件缓存目录之外选择文件夹');}
  fs.accessSync(directory,fs.constants.W_OK);return directory;
 }
 prepare(value,ids,includeCover=false){
  const directory=this.checkDirectory(value),works=ids.map(id=>this.store.work(id)).filter(Boolean).map(w=>structuredClone(w));if(!works.length)throw new Error('请先选择作品');
  const token=randomUUID();this.intents.clear();this.intents.set(token,{directory,works,includeCover:!!includeCover,expires:Date.now()+600000});return {token,directory,count:works.length,nonempty:fs.readdirSync(directory).length>0};
 }
 start(token,allowNonempty=false){
  const intent=this.intents.get(token);if(!intent||intent.expires<Date.now())throw new Error('下载确认已过期，请重新选择目录');
  const directory=this.checkDirectory(intent.directory);if(fs.readdirSync(directory).length&&!allowNonempty)return {needsConfirmation:true};
  this.intents.delete(token);const id=randomUUID(),stage=path.join(directory,'.cangxia-flat-'+id);fs.mkdirSync(stage);const stageStat=fs.lstatSync(stage);
  const batch={id,directory,stage,stageStat,includeCover:intent.includeCover,paused:false,canceled:false,jobs:intent.works.map((work,index)=>({id:work.id,work,index,state:'waiting',results:new Map(),local:structuredClone(this.store.download(work.id)||null)}))};
  this.batches.push(batch);this.emit();void this.run();return {id};
 }
 get(id){const batch=this.batches.find(b=>b.id===id);if(!batch)throw new Error('本次下载任务已清除');return batch;}
 assertStage(b){const s=fs.lstatSync(b.stage,{throwIfNoEntry:false});if(!inside(b.directory,b.stage)||!s?.isDirectory()||s.isSymbolicLink()||s.dev!==b.stageStat.dev||s.ino!==b.stageStat.ino||fs.realpathSync(b.stage)!==b.stage)throw new Error('临时目录已变化，已停止写入');}
 hasUnfinished(){return this.batches.some(b=>!b.canceled&&b.jobs.some(unfinished));}
 pause(id){const b=this.get(id);b.paused=true;if(this.current===b)this.controller?.abort();this.emit();}
 pauseAll(){for(const b of this.batches)if(!b.canceled)this.pause(b.id);}
 waitForBatch(b){return b.activePromise||Promise.resolve();}
 async networkBatchIds(){const ids=[];for(const b of this.batches){if(b.canceled||b.paused)continue;let network=false;for(const j of b.jobs.filter(j=>['waiting','running'].includes(j.state))){const targets=j.targets||targetsFor(j.work,b.includeCover);if(!targets.length){network=true;break;}for(const t of targets){if(j.results.has(t.key))continue;const d=j.local,a=d?.assets?.find(a=>a.key===t.key);try{if(!a||!mediaExt.test(path.extname(a.file)))throw new Error();const source=requireInside(d.path,path.join(d.path,a.file));if(!regular(source)||fs.statSync(source).size!==a.size||a.size<=0||(a.sha256&&await hashFile(source)!==a.sha256))throw new Error();}catch{network=true;break;}}if(network)break;}if(network)ids.push(b.id);}return ids;}
 resume(id){const b=this.get(id);if(b.canceled)throw new Error('已取消的任务不能继续');b.paused=false;this.emit();void this.run();}
 retry(id){const b=this.get(id);if(b.canceled)return;for(const j of b.jobs)if(j.state==='failed')j.state='waiting';this.resume(id);}
 waitForIdle(){return this.running?new Promise(r=>(this.waiters??=[]).push(r)):Promise.resolve();}
 async cancel(id){const b=this.get(id);b.canceled=true;b.paused=true;if(this.current===b){this.controller?.abort();await this.waitForBatch(b);}for(const j of b.jobs)if(unfinished(j))j.state='canceled';await this.cleanup(b);this.emit();}
 async clear(id){const b=this.get(id);if(b.jobs.some(unfinished)&&!b.canceled)throw new Error('请先取消剩余任务');await this.cleanup(b);this.batches=this.batches.filter(x=>x!==b);this.emit();}
 async cleanup(b){if(b.cleanupPromise)return b.cleanupPromise;b.cleanupPromise=(async()=>{if(!fs.existsSync(b.stage))return;this.assertStage(b);await fs.promises.rm(b.stage,{recursive:true});for(const key of this.checkpoints.keys())if(inside(b.stage,key))this.checkpoints.delete(key);})();try{await b.cleanupPromise;}finally{b.cleanupPromise=null;}}
 async dispose(){this.pauseAll();for(const b of this.batches)b.canceled=true;this.controller?.abort();await this.waitForIdle();for(const b of this.batches)await this.cleanup(b);this.batches=[];this.intents.clear();this.checkpoints.clear();}
 async run(){
  if(this.running)return;this.running=true;
  try{for(;;){const b=this.batches.find(b=>!b.paused&&!b.canceled&&b.jobs.some(j=>j.state==='waiting'));if(!b)break;const j=b.jobs.find(j=>j.state==='waiting');this.current=b;this.controller=new AbortController();let finish;b.activePromise=new Promise(r=>{finish=r;});j.state='running';this.emit();
   try{await this.save(b,j,this.controller.signal);j.state='complete';j.message='媒体已保存';}
   catch(e){j.state=b.canceled?'canceled':b.paused?'waiting':'failed';j.message=b.canceled?'已取消，完整文件保留':b.paused?'已暂停，可在本次运行中继续':e.message;}
   this.controller=null;this.current=null;finish();b.activePromise=null;this.emit();if(b.jobs.every(j=>j.state==='complete'))try{await this.cleanup(b);}catch{b.cleanupMessage='媒体已完整保存，临时文件夹未能清理；可关闭软件后删除 .cangxia-flat- 开头的临时文件夹。';this.emit();}
  }}catch(e){if(this.current){this.current.paused=true;for(const j of this.current.jobs)if(j.state==='running'){j.state='failed';j.message=e.message;}}}
  finally{this.current=null;this.controller=null;this.running=false;this.emit();for(const r of this.waiters||[])r();this.waiters=[];}
 }
 async copyLocal(b,j,target,name,signal){
  const d=j.local,a=d?.assets?.find(a=>a.key===target.key);if(!a||!mediaExt.test(path.extname(a.file)))return null;
  try{
   const source=requireInside(d.path,path.join(d.path,a.file)),s=regular(source);if(!s||s.size<=0||s.size!==a.size||!inside(fs.realpathSync(d.path),fs.realpathSync(source)))return null;
   const sha256=await hashFile(source,signal);if(a.sha256&&a.sha256!==sha256)return null;
   this.assertStage(b);const file=path.join(b.stage,name+path.extname(a.file).toLowerCase());
   if(fs.existsSync(file)){if(!regular(file))throw new Error('临时文件已变化');await fs.promises.unlink(file);}
   await pipeline(fs.createReadStream(source),fs.createWriteStream(file,{flags:'wx'}),{signal});
   if(!regular(file)||fs.statSync(file).size!==s.size||await hashFile(file,signal)!==sha256){await fs.promises.unlink(file);return null;}
   return {file,size:s.size,sha256};
  }catch(e){if(signal.aborted)throw e;return null;}
 }
 async network(b,j,t,name,signal){
  let error;for(const url of(t.urls||[]).slice(0,5)){if(!isMediaURL(url))continue;try{this.assertStage(b);let last=0;return await transferAsset({dir:b.stage,target:{...t,name},url,signal,fetchMedia:this.fetchMedia,extension,checkpoints:this.checkpoints,progress:bytes=>{if(Date.now()-last>500){last=Date.now();j.message=`${j.results.size} / ${j.targets.length} 个文件 · ${(bytes/1048576).toFixed(1)} MB`;this.emit();}}});}catch(e){if(signal.aborted||e.httpStatus===429)throw e;error=e;}}
  throw error||new Error('没有可用媒体地址，请登录原账号后重试');
 }
 async publish(b,asset,base,signal){
  this.assertStage(b);const ext=path.extname(asset.file);for(let n=0;n<10000;n++){
   signal.throwIfAborted();const file=path.join(b.directory,base+(n?`_${n+1}`:'')+ext);const existing=fs.lstatSync(file,{throwIfNoEntry:false});
   if(existing){if(existing.isFile()&&!existing.isSymbolicLink()&&existing.size===asset.size&&await hashFile(file,signal)===asset.sha256)return {file,skipped:true};continue;}
   try{await fs.promises.link(asset.file,file);return {file,skipped:false};}catch(e){if(e.code==='EEXIST')continue;if(!['EPERM','ENOTSUP','EOPNOTSUPP','EXDEV','ENOSYS'].includes(e.code))throw e;}
   // Exclusive creation is the fallback for filesystems without hard links.
   let handle;try{handle=await fs.promises.open(file,'wx');}catch(e){if(e.code==='EEXIST')continue;throw e;}
   const owned=await handle.stat();try{
    for await(const bytes of fs.createReadStream(asset.file)){signal.throwIfAborted();let used=0;while(used<bytes.length){const {bytesWritten}=await handle.write(bytes,used,bytes.length-used);if(!bytesWritten)throw new Error('文件写入未完成');used+=bytesWritten;}}
    await handle.sync();await handle.close();handle=null;if(await hashFile(file,signal)!==asset.sha256)throw new Error('目标文件校验失败');return {file,skipped:false};
   }catch(e){await handle?.close();const now=fs.lstatSync(file,{throwIfNoEntry:false});if(now&&!now.isSymbolicLink()&&now.dev===owned.dev&&now.ino===owned.ino)await fs.promises.unlink(file);throw e;}
  }throw new Error('同名文件过多，请选择其他文件夹');
 }
 async save(b,j,signal){
  this.assertStage(b);j.targets??=targetsFor(j.work,b.includeCover);if(!j.targets.length)throw new Error('作品未提供图片或视频');
  const errors=[];let refreshed=false;
  for(let i=0;i<j.targets.length;i++){
   signal.throwIfAborted();let t=j.targets[i];const previous=j.results.get(t.key);if(previous&&regular(previous.file)?.size===previous.size&&await hashFile(previous.file,signal)===previous.sha256)continue;j.results.delete(t.key);
   const name=`asset_${j.index}_${i}`;j.message=`校验并保存 ${i+1} / ${j.targets.length} 个文件`;this.emit();
   try{
    let asset=await this.copyLocal(b,j,t,name,signal);
    if(!asset){
     if(!refreshed){try{const fresh=await this.collector.resolveMediaOnly(j.id,signal);const next=targetsFor(fresh,b.includeCover);if(next.length!==j.targets.length||next.some((x,k)=>x.key!==j.targets[k].key))throw new Error('作品媒体数量发生变化，请重新发起单独下载');j.targets=next;t=next[i];}catch(e){if(signal.aborted||e.httpStatus===429||e.message.includes('数量发生变化'))throw e;}refreshed=true;}
     asset=await this.network(b,j,t,name,signal);
    }
    signal.throwIfAborted();const prefix=`${String(j.index+1).padStart(4,'0')}_${safeName(j.work.author?.nickname||'未知作者',32)}_${j.id}`;
    const base=prefix+(t.key==='cover'?'_封面':t.kind==='image'?'_'+String(t.number||i+1).padStart(2,'0'):'');
    const result=await this.publish(b,asset,base,signal);j.results.set(t.key,{...result,size:asset.size,sha256:asset.sha256});await fs.promises.unlink(asset.file);this.emit();
   }catch(e){if(signal.aborted)throw e;errors.push(`${i+1}：${e.message}`);if(e.httpStatus===429)break;}
  }
  if(errors.length||j.results.size!==j.targets.length)throw new Error(`部分文件未完成（${j.results.size}/${j.targets.length}）：${errors.join('；')}`);
 }
}
