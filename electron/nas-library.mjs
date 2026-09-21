import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {Worker} from 'node:worker_threads';import {randomUUID} from 'node:crypto';
import {Store} from './store.mjs';import {SqliteStore} from './sqlite-store.mjs';import {DownloadQueue} from './downloads.mjs';import {serializeShared,digest,child,headFromLog} from './nas-format.mjs';import {requireInside,TOTAL} from './model.mjs';

export class NasLibrary{
 constructor(profile,onChange,onLost){this.profile=profile;this.onChange=onChange;this.onLost=onLost;this.pending=new Map();this.stores=new Set();this.status={mode:'local',backupDeferred:true};this.dirty=false;this.writable=false;this.assetStates={};this.serial=Promise.resolve();
  this.configFile=path.join(profile,'library-location.json');this.deviceFile=path.join(profile,'library-device-id');
  fs.mkdirSync(profile,{recursive:true});if(!fs.existsSync(this.deviceFile))fs.writeFileSync(this.deviceFile,randomUUID());this.deviceId=fs.readFileSync(this.deviceFile,'utf8').trim();
 }
 get selection(){try{return JSON.parse(fs.readFileSync(this.configFile,'utf8'));}catch{return null;}}
 emit(){this.onChange?.();}
 fail(message){this.writable=false;this.status={...this.status,connected:false,writable:false,message,pending:this.dirty};if(this.store?.nas)this.store.nas.offline=true;this.onLost?.();this.emit();}
 startWorker(){this.worker=new Worker(new URL('./nas-worker.mjs',import.meta.url));this.worker.on('message',r=>{
   if(r.event==='lost'){this.fail(r.message);return;}if(r.event==='heartbeat'){this.lastHeartbeat=Date.now();if(r.phase==='verify'){this.status.message=`正在校验 NAS 记录：${(r.bytes/1048576).toFixed(1)} / ${(r.total/1048576).toFixed(1)} MB`;this.commitProgress?.({phase:'records',bytes:r.bytes,total:r.total});this.emit();}return;}
   const p=this.pending.get(r.id);if(!p)return;if(r.event==='started'){p.arm(p.timeout);return;}if(r.event==='transfer'){p.onProgress?.(r);return;}r.ok?p.resolve(r.data):p.reject(new Error(r.error));
  });this.worker.on('error',e=>this.fail(e.message));this.worker.on('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('NAS 后台连接已关闭'));}this.pending.clear();});
 }
 call(action,args={},options={}){return new Promise((resolve,reject)=>{
  if(!this.worker)return reject(new Error('NAS 未连接'));if(options.signal?.aborted)return reject(new Error('已暂停，临时文件保留'));
  const worker=this.worker,id=randomUUID(),transfer=['publishFiles','copyOut','prepareDelete'].includes(action);
  if(transfer){this.activeTransfers=(this.activeTransfers||0)+1;this.status.transferring=true;}
  const abort=()=>worker.postMessage({action:'abort',targetId:id});
  const finish=(callback,value)=>{clearTimeout(p.timer);options.signal?.removeEventListener('abort',abort);this.pending.delete(id);if(transfer){this.activeTransfers--;this.status.transferring=this.activeTransfers>0;}callback(value);};
  const p={onProgress:options.onProgress,timeout:transfer?1800000:['commit','connect','refresh'].includes(action)?330000:action==='disconnect'?5000:120000,resolve:v=>finish(resolve,v),reject:e=>finish(reject,e)};
  p.arm=duration=>{clearTimeout(p.timer);p.timer=setTimeout(()=>{p.reject(new Error('NAS 响应超时，已保留本机工作副本'));this.fail('NAS 响应超时，已停止写入');void worker.terminate();},duration);};
  // Queue waiting is separate from the running operation's timeout.
  this.pending.set(id,p);p.arm(action==='disconnect'?5000:2100000);options.signal?.addEventListener('abort',abort,{once:true});worker.postMessage({id,action,args});
 });}
 assertWritable(){if(!this.writable||!this.status.connected)throw new Error(this.status.message||'NAS 媒体库当前只读');}
 context(){const file=path.join(this.profile,'nas-device-settings.json');let settings={};try{settings=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}const id=this.libraryId;settings[id]||={};return {mediaRoot:path.join(this.root,'媒体'),deviceSettings:settings[id],getDeviceSetting:key=>settings[id][key]??null,setDeviceSetting:(key,value)=>{settings[id][key]=value;fs.writeFileSync(file+'.tmp',JSON.stringify(settings));fs.renameSync(file+'.tmp',file);},assets:this.assetStates,relocations:new Set(),canWrite:()=>this.writable&&this.status.connected,assertWritable:()=>this.assertWritable(),changed:()=>this.changed()};}
 cacheFile(id){const base=path.join(this.profile,'nas-cache');let name=id+'.sqlite';try{const candidate=fs.readFileSync(path.join(base,id+'.active'),'utf8').trim();if(candidate.startsWith(id+'-')&&/^[a-f0-9-]+\.sqlite$/.test(candidate))name=candidate;}catch{}return path.join(base,name);}
 rememberCache(id,file){const pointer=path.join(this.profile,'nas-cache',id+'.active');fs.writeFileSync(pointer+'.tmp',path.basename(file));fs.renameSync(pointer+'.tmp',pointer);}
 async loadStore(bytes,id){
  const previous=this.cacheFile(id);let file=previous;fs.mkdirSync(path.dirname(file),{recursive:true});
  let same=false;if(bytes)try{same=fs.existsSync(previous)&&fs.readFileSync(previous+'.remotehash','utf8')===digest(Buffer.from(bytes));}catch{}
  if(bytes&&fs.existsSync(previous+'.pending')){
    let reading=false;if(same&&this.writable){let check;try{check=new DatabaseSync(previous,{readOnly:true});if(check.prepare("SELECT 1 FROM sqlite_master WHERE name='sync_runs'").get())reading=check.prepare('SELECT body FROM sync_runs').all().some(r=>JSON.parse(r.body).status!=='complete');}catch{}finally{check?.close();}}
    if(reading){const recovery=previous+'.recovery-'+Date.now();await SqliteStore.copyFile(previous,recovery);this.status.recovery=recovery;}else same=false;
  }
  if(bytes&&!same){if(fs.existsSync(previous+'.pending')&&fs.existsSync(previous)){const recovery=previous+'.recovery-'+Date.now();await SqliteStore.copyFile(previous,recovery);this.status.recovery=recovery;}
    file=path.join(path.dirname(previous),id+'-'+randomUUID()+'.sqlite');fs.writeFileSync(file,Buffer.from(bytes));}
  if(!fs.existsSync(file))throw new Error('没有可离线浏览的本机缓存');
  const s=await Store.open(file,path.join(this.root,'媒体'));this.stores.add(s);s.onClose=()=>this.stores.delete(s);
  for(const d of s.all('downloads')){const relative=path.isAbsolute(d.path)?path.relative(s.getSetting('root')||path.join(this.root,'媒体'),d.path):d.path;d.path=child(path.join(this.root,'媒体'),relative);s.put('downloads',d.id,d);}
  s.setSetting('root',path.join(this.root,'媒体'));s.save();this.store=s;s.nas=this.context();
  try{this.assetStates=JSON.parse(fs.readFileSync(file+'.assets','utf8'));s.nas.assets=this.assetStates;}catch{}
  if(bytes)fs.writeFileSync(file+'.remotehash',digest(Buffer.from(bytes)));this.rememberCache(id,file);
  this.dirty=false;this.lastHash=bytes?digest(Buffer.from(bytes)):digest(serializeShared(s));if(fs.existsSync(file+'.pending')){this.status.pending=true;this.status.recovery=file;}return s;
 }
 async open(root,{create=false}={}){
  await this.close({keepStores:true});this.store=null;this.dirty=false;this.lastHash=null;this.assetStates={};this.root=path.resolve(root);this.startWorker();this.status={mode:'nas',root:this.root,connected:false,writable:false,message:'正在连接 NAS…',backupDeferred:true};this.emit();
  try{
   const info=await this.call('connect',{root:this.root,create,deviceId:this.deviceId,device:os.hostname().slice(0,40)});this.libraryId=info.manifest.id;this.writable=info.writable;this.revision=info.head?.revision||0;
   this.status={...this.status,libraryId:this.libraryId,connected:true,writable:this.writable,message:this.writable?'NAS 已连接 · 当前电脑可写':'其他电脑占用写入锁 · 当前只读'};
   if(!create){await this.loadStore(info.bytes,this.libraryId);await this.pruneDeletedDownloads();await this.refreshFiles();}
   this.dirty=false;this.installPoll();this.emit();return info;
  }catch(e){this.fail(e.message);await this.close({keepStores:true});throw e;}
 }
 remember(){fs.writeFileSync(this.configFile,JSON.stringify({mode:'nas',root:this.root,id:this.libraryId}));}
 async restore(){const c=this.selection;if(c?.mode!=='nas')return null;try{await this.open(c.root);return this.store;}catch{this.root=c.root;this.libraryId=c.id;await this.loadStore(null,c.id);this.status={...this.status,mode:'nas',root:c.root,message:'NAS 无法连接，显示本机缓存；修改操作已停用',connected:false,writable:false};return this.store;}}
 changed(){if(this.suppress||!this.store?.nas||!this.writable)return;this.dirty=true;this.status.pending=true;fs.writeFileSync(this.store.file+'.pending','1');clearTimeout(this.saveTimer);if(this.deferCommits)return;this.saveTimer=setTimeout(()=>{void this.flush().catch(e=>this.fail(e.message));},350);}
 async flush(){
  clearTimeout(this.saveTimer);
  this.serial=this.serial.catch(()=>{}).then(async()=>{
   if(!this.dirty)return;this.assertWritable();const bytes=serializeShared(this.store),hash=digest(bytes);
   if(hash===this.lastHash){this.dirty=false;this.status.pending=false;try{fs.unlinkSync(this.store.file+'.pending');}catch{}return;}
   this.status.saving=true;this.emit();
   try{const head=await this.call('commit',{bytes});this.lastHeartbeat=Date.now();this.revision=head.revision;this.lastHash=hash;fs.writeFileSync(this.store.file+'.remotehash',hash);
    if(digest(serializeShared(this.store))===hash){this.dirty=false;this.status.pending=false;try{fs.unlinkSync(this.store.file+'.pending');}catch{}}
    this.status.lastSaved=head.time;if(this.writable&&!this.status.migrating)this.status.message='NAS 已连接 · 当前电脑可写';
   }finally{this.status.saving=false;this.emit();}
  });return this.serial;
 }
 records(){return this.store.all('downloads').map(d=>({...d,relative:path.relative(this.root,d.path).split(path.sep).join('/')}));}
 async pruneDeletedDownloads(){if(!this.writable||!this.status.connected)return [];let removed;try{removed=await this.call('findDeleted',{records:this.records()});this.assertWritable();this.store.forgetDownloads(removed);await this.flush();this.onPruned?.(removed);return removed;}catch(e){this.fail(e.message);throw e;}}
 async refreshFiles(ids){if(!this.status.connected)throw new Error('NAS 离线，不能据此判断文件已删除');const records=this.records().filter(d=>!ids||ids.includes(d.id));let states;try{states=await this.call('scan',{records});}catch(e){this.fail(e.message);throw e;}for(const [key,state]of Object.entries(states)){if(state.error)this.assetStates[key]={...this.assetStates[key],error:state.error};else this.assetStates[key]=state;}if(this.store.nas)this.store.nas.assets=this.assetStates;this.store.invalidateViews();fs.writeFileSync(this.store.file+'.assets',JSON.stringify(this.assetStates));this.emit();return states;}
 async checkRepairs(ids){await this.refreshFiles(ids);const items=ids.map(id=>{const w=this.store.work(id),d=this.store.download(id);if(!w)return {id,name:id,status:'error',error:'作品不存在',missing:[]};const targets=w.type==='video'?[['video','视频'],['cover','高清单图']]:w.images.map(i=>['image-'+i.index,'图片 '+(i.index+1)]);targets.push(['metadata','作品信息']);const missing=[],errors=[];for(const [key,label]of targets){const state=this.assetStates[id+':'+key];if(state?.error)errors.push(state.error);else if(!d?.assets?.some(a=>a.key===key)||!state?.exists)missing.push({key,label,reason:'尚未保存或文件缺失/大小异常'});}return {id,name:w.name,status:errors.length?'error':missing.length?'missing':'complete',missing,error:errors.join('；')};});return {items,complete:items.filter(i=>i.status==='complete').length,missing:items.filter(i=>i.status==='missing').length,errors:items.filter(i=>i.status==='error').length};}
 async uploadRecord(record,sourcePath,options={}){
  const previousProgress=this.commitProgress;this.commitProgress=options.onProgress;try{
  this.assertWritable();const old=this.store.download(record.id),target=this.store.destination(record.id),relative=path.relative(this.root,target.dir).split(path.sep).join('/');
  const sourceAssets=(record.assets||[]).filter(a=>a.kind!=='metadata');
  const assets=await this.call('publishFiles',{relative,assets:sourceAssets.map(a=>({...a,inputPath:child(sourcePath,a.file)}))},options);
  options.signal?.throwIfAborted();options.onProgress?.({phase:'records',bytes:0,total:0});
  const next={...record,path:target.dir,collectionId:target.collectionId,assets};
  const w=this.store.work(record.id);const metadata={schemaVersion:2,workId:w.id,workName:w.name,title:w.title,description:w.description,author:w.author,tags:w.tags,localTags:this.store.get('local_tags',w.id)?.tags||[],collectionId:target.collectionId,collection:this.store.collection(target.collectionId)?.name,assets:assets.map(({file,key,kind,size,sha256,width,height})=>({file,key,kind,size,sha256,width,height})),originalURL:w.url};
  assets.push(await this.call('writeInfo',{relative,text:JSON.stringify(metadata,null,2)}));
  this.store.put('downloads',record.id,next);for(const a of assets)this.assetStates[record.id+':'+a.key]={exists:true};this.store.save();await this.flush();
  fs.writeFileSync(this.store.file+'.assets',JSON.stringify(this.assetStates));
  if(old){const files=old.assets.map(a=>path.relative(this.root,path.join(old.path,a.file)).split(path.sep).join('/'));await this.call('archive',{files}).catch(e=>{this.status.message='已保存新文件；旧版本归档待处理：'+e.message;});}
  return next;
  }finally{this.commitProgress=previousProgress;}
 }
 async saveWork(job,signal,collector,fetchMedia,notify){
  this.deferCommits=(this.deferCommits||0)+1;clearTimeout(this.saveTimer);try{
  this.assertWritable();const report=await this.checkRepairs([job.id]);if(report.errors)throw new Error(report.items[0].error);if(!report.missing){job.message='文件完整，无需补齐';return;}
  const stagingRoot=path.join(this.profile,'nas-staging');fs.mkdirSync(stagingRoot,{recursive:true});if(!/^\d+$/.test(job.id)||!/^[a-f0-9-]+$/.test(this.libraryId))throw new Error('暂存任务标识无效');const dir=requireInside(stagingRoot,path.join(stagingRoot,this.libraryId,job.id));fs.mkdirSync(dir,{recursive:true});let scratch;
  try{
    scratch=await Store.open(path.join(dir,'work.sqlite'),path.join(dir,'媒体'));const w=this.store.work(job.id);scratch.put('works',w.id,w);scratch.put('local_tags',w.id,{id:w.id,tags:this.store.get('local_tags',w.id)?.tags||[]});
    const original=this.store.download(w.id),destination=scratch.destination(w.id).dir;fs.mkdirSync(destination,{recursive:true});const existing=[...(scratch.download(w.id)?.assets||[])];
    if(original)for(const a of original.assets||[])if(this.assetStates[w.id+':'+a.key]?.exists){if(existing.some(saved=>saved.key===a.key&&scratch.assetExists({path:destination},saved)))continue;if(signal.aborted)throw new Error('已暂停');await this.call('copyOut',{source:path.relative(this.root,path.join(original.path,a.file)).split(path.sep).join('/'),destination:path.join(destination,a.file),size:a.size});existing.push(a);}
    if(original||existing.length)scratch.put('downloads',w.id,{...original,...scratch.download(w.id),id:w.id,path:destination,collectionId:TOTAL,assets:existing});
    const q=new DownloadQueue(scratch,{resolveWork:async id=>{const fresh=await collector.resolveWork(id);if(fresh)scratch.put('works',id,fresh);return fresh;}},fetchMedia,notify);
    let failure;try{await q.saveWork(job,signal);}catch(e){failure=e;}
    if(signal.aborted)throw failure||new Error('已暂停，临时文件保留');
    const d=scratch.download(w.id);if(d?.assets?.length){job.message='准备保存到 NAS';notify();await this.uploadRecord(d,d.path,{signal,onProgress:p=>{if(p.phase==='records'){job.message='正在保存 NAS 作品记录'+(p.total?` · ${(p.bytes/1048576).toFixed(2)} / ${(p.total/1048576).toFixed(2)} MB`:'');job.progress=98;}else{job.message=`${{copy:'复制到 NAS',flush:'等待 NAS 确认写入',verify:'校验 NAS 文件'}[p.phase]} · ${p.file}/${p.files} · ${(p.bytes/1048576).toFixed(2)} / ${(p.total/1048576).toFixed(2)} MB`;job.progress=p.total?Math.round(p.bytes/p.total*100):0;}notify();}});}
    if(failure)throw failure;
    scratch.close();scratch=null;requireInside(stagingRoot,dir);fs.rmSync(dir,{recursive:true,force:true});
  }catch(e){this.status.staging=dir;this.emit();throw e;}finally{scratch?.close();}
  }finally{this.deferCommits--;if(this.dirty&&this.writable&&!this.deferCommits)this.changed();}
 }
 async migrate(source,target){
  await this.open(target,{create:true});if(!this.writable)throw new Error('NAS 媒体库正在被使用，不能迁移');
  const id=this.libraryId,file=path.join(this.profile,'nas-cache',id+'-'+randomUUID()+'.sqlite');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source.db.export());
  const s=await Store.open(file,path.join(target,'媒体'));this.stores.add(s);s.onClose=()=>this.stores.delete(s);const originals=s.all('downloads');s.db.run('DELETE FROM downloads');s.setSetting('root',path.join(target,'媒体'));this.store=s;s.nas=this.context();this.status.migrating=true;this.suppress=true;this.emit();
  try{
    let count=0;
    for(const d of originals){const valid=d.assets.filter(a=>source.assetExists(d,a));if(!valid.length)continue;
      this.status.message=`正在复制 ${++count}/${originals.length}：${source.work(d.id)?.name||d.id}`;this.emit();
      await this.uploadRecord({...d,assets:valid,state:valid.length===d.assets.length?d.state:'partial'},d.path);
    }
    this.suppress=false;this.dirty=true;s.save();await this.flush();this.rememberCache(id,file);this.remember();this.status.migrating=false;this.status.message='迁移完成，原本机文件已保留';this.emit();return s;
  }catch(e){this.suppress=false;this.status.migrating=false;this.fail('迁移未完成，原本机库未改变：'+e.message);await this.close();throw e;}
 }
 async deleteFiles(ids){
  this.assertWritable();const records=ids.map(id=>this.store.download(id)).filter(Boolean),relativeRecords=records.map(d=>({...d,path:undefined,relative:path.relative(this.root,d.path).split(path.sep).join('/')}));
  // Finish and verify the recoverable copy before publishing the deletion.
  await this.call('prepareDelete',{records:relativeRecords});this.store.forgetDownloads(records.map(d=>d.id));this.onPruned?.(records.map(d=>d.id));
  this.store.save();await this.flush();const files=records.flatMap(d=>d.assets.map(a=>path.relative(this.root,path.join(d.path,a.file)).split(path.sep).join('/')));await this.call('discardFiles',{files}).catch(e=>{this.status.message='删除已保存并可恢复，原位置的残留文件待清理：'+e.message;});this.emit();
 }
 async trash(){if(!this.status.connected)throw new Error('请先连接 NAS');const batches=await this.call('trash');return batches.flatMap(b=>(b.records||[]).filter(d=>!(b.restored||[]).includes(d.id)).map(d=>({batch:b.batch,id:d.id,name:this.store.work(d.id)?.name||d.id,time:b.time})));}
 async restoreDeleted(batch,id){this.assertWritable();if(this.store.download(id))throw new Error('作品已有保存记录，未覆盖现有文件');const batches=await this.call('trash'),entry=batches.find(b=>b.batch===batch),d=entry?.records?.find(d=>d.id===id);if(!d)throw new Error('未找到删除的作品');const source=child(this.root,'.cangxia/trash/'+entry.batch+'/'+d.relative);await this.uploadRecord(d,source);await this.call('restored',{batch:entry.batch,id});this.emit();}
 async refreshInfo(id){this.assertWritable();const d=this.store.download(id),w=this.store.work(id);if(!d)return;const relative=path.relative(this.root,d.path).split(path.sep).join('/');const old=d.assets.find(a=>a.key==='metadata');const info={workId:w.id,workName:w.name,title:w.title,description:w.description,author:w.author,tags:w.tags,localTags:this.store.get('local_tags',id)?.tags||[],collectionId:d.collectionId,assets:d.assets.filter(a=>a.kind!=='metadata')};const text=JSON.stringify(info,null,2);if(old?.sha256===digest(Buffer.from(text)))return;const a=await this.call('writeInfo',{relative,text});d.assets=[...d.assets.filter(a=>a.key!=='metadata'),a];this.store.put('downloads',id,d);this.assetStates[id+':metadata']={exists:true};this.store.save();await this.flush();if(old)await this.call('archive',{files:[path.relative(this.root,path.join(d.path,old.file)).split(path.sep).join('/')]}).catch(()=>{});}
 async settle(){
  this.assertWritable();const pending=[...this.store.nas.relocations];this.store.nas.relocations.clear();
  for(const id of pending){const d=this.store.download(id);if(!d)continue;const destination=this.store.destination(id);
   if(path.resolve(d.path)!==destination.dir){await this.refreshFiles([id]);const assets=d.assets.filter(a=>this.assetStates[id+':'+a.key]?.exists);if(assets.length)await this.uploadRecord({...d,assets,state:assets.length===d.assets.length?d.state:'partial'},d.path);}
   else await this.refreshInfo(id);
  }
  await this.flush();
 }
 async migrationPlan(source,target){
  if(source.nas)throw new Error('请先返回本机库，再迁移本机资料');
  await source.pruneDeletedDownloads();
  const root=path.resolve(target),relative=path.relative(source.root,root);if(!relative||!relative.startsWith('..')&&!path.isAbsolute(relative))throw new Error('NAS 目标不能位于现有媒体目录内');
  const stat=await fsp.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('请选择普通共享文件夹');
  try{const marker=JSON.parse(await fsp.readFile(path.join(root,'.cangxia','library.json'),'utf8'));if(marker.initializer!==this.deviceId||headFromLog(await fsp.readFile(path.join(root,'.cangxia','head.log'))))throw new Error('目标已有媒体库，请打开已有 NAS 库');}catch(e){if(e.code!=='ENOENT')throw e;}
  let bytes=0,files=0,missing=0;for(const d of source.all('downloads'))for(const a of d.assets||[]){source.assertDirectory(d.path);try{const file=requireInside(d.path,path.join(d.path,a.file)),s=await fsp.lstat(file);if(s.isFile()&&!s.isSymbolicLink()&&s.size>0&&(!a.size||a.size===s.size)){files++;bytes+=s.size;}else missing++;}catch(e){if(e.code==='ENOENT')missing++;else throw e;}}
  let free=null;try{const s=await fsp.statfs(root);free=s.bavail*s.bsize;}catch{}
  if(free!==null&&free<bytes+source.db.export().length*3)throw new Error('目标可用空间不足，无法复制当前媒体库');
  return {root,works:source.all('works').length,files,bytes,missing,free};
 }
 installPoll(){clearInterval(this.poll);this.lastHeartbeat=Date.now();this.poll=setInterval(async()=>{if(this.polling||!this.store||!this.status.connected||this.status.migrating)return;if(this.writable&&Date.now()-this.lastHeartbeat>((this.status.saving||this.status.transferring)?330000:15000)){this.fail('NAS 写入锁心跳超时，修改已停用，请重新连接');return;}this.polling=true;try{if(!this.writable){const latest=await this.call('refresh');if(latest.head&&latest.head.revision!==this.revision){const old=this.store;await this.loadStore(latest.bytes,this.libraryId);this.revision=latest.head.revision;await this.refreshFiles();this.onReload?.(this.store);old.close();this.emit();}}}catch(e){this.fail(e.message);}finally{this.polling=false;}},5000);this.poll.unref?.();}
 async close({keepStores=false}={}){clearTimeout(this.saveTimer);clearInterval(this.poll);if(this.worker){await this.call('disconnect').catch(()=>{});await this.worker.terminate();this.worker=null;}this.writable=false;if(!keepStores){for(const s of this.stores)s.close();this.stores.clear();}}
 async leave(){await this.close();fs.writeFileSync(this.configFile,JSON.stringify({mode:'local'}));this.store=null;this.status={mode:'local',backupDeferred:true};this.dirty=false;this.emit();}
}
