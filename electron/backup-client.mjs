import {preparePreviews,missingPreviews,validPreview} from './backup-previews.mjs';
import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {randomUUID,createHash} from 'node:crypto';
import {BackupTransport,normalizeEndpoint,normalizeFingerprint} from './backup-transport.mjs';import {exportRecords,hashes,changesSince,applyChanges,recordId} from './backup-model.mjs';import {contentHash,PROTOCOL} from '../shared/backup-protocol.mjs';import {requireInside} from './model.mjs';
import {BackupCovers} from './backup-covers.mjs';

const localKeys=new Set(['authNeedsRefresh','loggedOut','root','sessionConnected','accessHoldUntil','downloadJobs']);
export class BackupClient{
 constructor(store,profile,{vault,onChange=()=>{},onUnavailable=()=>{},isIdle=()=>true,heartbeatMs=15000}={}){
  this.covers=new BackupCovers(this);
  Object.assign(this,{store,profile,vault,onChange,onUnavailable,isIdle,heartbeatMs});this.deviceId=this.read('device.json')?.id||randomUUID();this.write('device.json',{id:this.deviceId});this.config=this.read('backup-connection.json');this.meta=this.read('backup-state.json')||{baseRevision:null,baseline:{},files:{},dirty:false};this.status={mode:'backup',phase:'unconfigured',writable:false,connected:false,message:'请先连接 NAS 备份服务',deviceName:this.config?.deviceName||os.hostname(),pending:!!this.meta.dirty};
  store.backup={assertWritable:()=>this.assertWritable(),canWrite:()=>this.status.writable||!!this.applying,changed:()=>this.scheduleChanged(),localKey:key=>localKeys.has(key),applying:()=>!!this.applying};
 }
 read(name){try{return JSON.parse(fs.readFileSync(path.join(this.profile,name),'utf8'));}catch{return null;}}
 write(name,value){fs.mkdirSync(this.profile,{recursive:true});const file=path.join(this.profile,name);fs.writeFileSync(file+'.tmp',JSON.stringify(value));fs.renameSync(file+'.tmp',file);}
 persist(){this.write('backup-state.json',this.meta);}
 emit(){this.onChange();}
 publicConfig(){return {url:this.config?.url||'',fingerprint:this.config?.fingerprint||'',deviceName:this.status.deviceName,intervalMinutes:this.config?.intervalMinutes||5,hasToken:!!this.config?.sealedToken};}
 assertWritable(){if(this.applying)return;if(!this.status.writable)throw new Error(this.status.message||'请先连接 NAS 并完成同步检查');}
 unavailable(message,phase='offline'){this.status={...this.status,connected:false,writable:false,phase,message,pending:!!this.meta.dirty||!!this.status.pendingCovers};this.onUnavailable();this.emit();}
 mediaSignature(){const parts=[];for(const d of this.store.all('downloads'))for(const a of d.assets||[]){if(a.kind==='metadata')continue;try{const file=requireInside(d.path,path.join(d.path,a.file));this.store.assertDirectory(d.path);const s=fs.lstatSync(file);parts.push([d.id,a.key,file,s.size,s.mtimeMs,s.ctimeMs]);}catch{parts.push([d.id,a.key,'missing']);}}return contentHash(parts);}
 mediaDirty(){for(const d of this.store.all('downloads'))for(const a of d.assets||[]){if(a.kind==='metadata'||!this.store.assetExists(d,a))continue;try{const file=requireInside(d.path,path.join(d.path,a.file)),s=fs.statSync(file),stamp=[s.size,s.mtimeMs,s.ctimeMs].join(':'),cached=this.meta.files?.[file],remote=this.store.get('backup_downloads',d.id)?.assets?.find(v=>v.key===a.key);if(!cached||cached.stamp!==stamp||!remote||remote.sha256!==cached.sha)return true;}catch{return true;}}return false;}
 scheduleChanged(){if(this.applying||this.closed)return;if(this.isIdle())return this.changed();clearTimeout(this.changeTimer);this.status.pending=true;this.changeTimer=setTimeout(()=>{if(!this.isIdle())return this.scheduleChanged();this.changed();},500);this.changeTimer.unref?.();}
 changed(){clearTimeout(this.changeTimer);if(this.applying)return;const entries=exportRecords(this.store),changes=changesSince(entries,this.meta.baseline||{});this.meta.dirty=changes.length>0||this.mediaDirty();this.status.pendingCovers=missingPreviews(this.store);this.status.pending=this.meta.dirty||this.status.pendingCovers>0;this.status.pendingRecords=changes.filter(e=>e.table!=='downloads').length;this.persist();if(this.status.writable&&!this.syncing){this.status.phase=this.meta.dirty?'pending':this.status.pendingCovers?'coversPending':'synced';this.status.message=this.meta.dirty?'本机有更新，等待同步到 NAS':this.status.pendingCovers?`记录已同步，${this.status.pendingCovers} 张封面待备份；请连接抖音后再次同步`:'本机记录与 NAS 已同步';}this.emit();}
 makeTransport(){if(!this.config)return null;const token=this.vault.open(this.config.sealedToken);return new BackupTransport({...this.config,token,deviceId:this.deviceId});}
 async configure(input){
  if(this.syncing)throw new Error('请先结束正在进行的备份同步');const url=normalizeEndpoint(String(input.url||'').trim()),fingerprint=normalizeFingerprint(String(input.fingerprint||'')),name=String(input.deviceName||os.hostname()).trim();if(!name||name.length>80)throw new Error('设备名称无效');const interval=Number(input.intervalMinutes||5);if(!Number.isInteger(interval)||interval<1||interval>1440)throw new Error('同步间隔应为 1 至 1440 分钟');
  const token=String(input.token||'').trim()||(this.config?.sealedToken?this.vault.open(this.config.sealedToken):'');if(token.length<24)throw new Error('请输入 NAS 服务生成的访问密钥');
  await this.release();this.config={url,fingerprint,deviceName:name,intervalMinutes:interval,sealedToken:this.vault.seal(token)};this.write('backup-connection.json',this.config);this.status.deviceName=name;this.transport?.close();this.transport=this.makeTransport();return this.check();
 }
 async renew(){const response=await this.transport.json('POST','/v1/lease',{data:{deviceId:this.deviceId,name:this.config.deviceName,leaseToken:this.transport.leaseToken}});this.transport.leaseToken=response.leaseToken;return response;}
 async start(){if(!this.config)return;this.transport=this.makeTransport();try{await this.check();}catch{}this.installTimers();}
 installTimers(){clearInterval(this.heartbeat);clearInterval(this.schedule);this.heartbeat=setInterval(()=>{void this.poll();},this.heartbeatMs);this.heartbeat.unref?.();this.schedule=setInterval(()=>{if(this.status.writable&&!this.syncing)void this.sync().catch(()=>{});},(this.config?.intervalMinutes||5)*60000);this.schedule.unref?.();}
 async check(){
  if(this.checking)return this.checking;if(this.syncing)throw new Error('正在同步，请等待完成');if(!this.transport)this.transport=this.makeTransport();if(!this.transport)throw new Error('请先填写备份服务连接信息');
  this.checking=(async()=>{this.status={...this.status,phase:'checking',writable:false,message:'正在与 NAS 比对同步状态…'};this.emit();try{
   const remote=await this.transport.json('GET','/v1/status');if(remote.protocol!==PROTOCOL)throw new Error('备份服务协议不兼容');if(this.meta.libraryId&&this.meta.libraryId!==remote.libraryId)throw new Error('这是另一份 NAS 备份库，未覆盖本机资料');
   if(this.meta.pendingCommit){try{const ack=await this.transport.json('GET','/v1/commits/'+this.meta.pendingCommit.request.requestId);if(ack.requestHash!==contentHash(this.commitContent(this.meta.pendingCommit.request)))throw new Error('提交确认与本机待确认内容不同');this.acceptCommit(this.meta.pendingCommit,ack.revision);}catch(e){if(e.status!==404)throw e;}}
   const existing=changesSince(exportRecords(this.store),this.meta.baseline||{});const localChanged=this.meta.baseRevision===null?this.store.all('works').length>0:existing.length>0||this.meta.dirty||this.mediaDirty();
   if((this.meta.baseRevision!==null&&remote.revision!==this.meta.baseRevision&&localChanged)||(this.meta.baseRevision===null&&remote.revision>0&&localChanged)){this.status={...this.status,connected:true,writable:false,phase:'conflict',message:'本机和 NAS 都有更新，已保留双方，未自动覆盖',lastSync:remote.lastSync};this.emit();return this.status;}
   let leased,readOnlyMessage;try{leased=await this.renew();}catch(e){if(e.status===423)readOnlyMessage=e.message;else throw e;}
   if(leased&&leased.revision!==remote.revision)throw new Error('NAS 刚刚有更新，请重新检查');
   this.meta.libraryId=remote.libraryId;
   if(remote.revision!==(this.meta.baseRevision??0)){
    const update=await this.transport.json('GET','/v1/changes?since='+(this.meta.baseRevision??0));this.applying=true;try{applyChanges(this.store,update.changes);for(const e of update.changes){if(e.body===null)delete this.meta.baseline[recordId(e)];else this.meta.baseline[recordId(e)]=contentHash({...e.body,...(['works','collections','local_tags','downloads'].includes(e.table)?{id:e.key}:{})});}this.store.reconcile();}finally{this.applying=false;}this.meta.baseRevision=update.revision;this.meta.mediaSignature=this.mediaSignature();this.meta.dirty=false;await this.onRemoteApplied?.();
   }else if(this.meta.baseRevision===null)this.meta.baseRevision=remote.revision;
   this.status={...this.status,connected:true,writable:!readOnlyMessage,lastSync:remote.lastSync,phase:readOnlyMessage?'readonly':'synced',message:readOnlyMessage||'本机记录与 NAS 已同步'};this.changed();this.persist();this.installTimers();return this.status;
  }catch(e){this.unavailable(e.message);throw e;}})();try{return await this.checking;}finally{this.checking=null;}
 }
 async poll(){if(this.polling||this.checking||!this.transport||!this.status.connected)return;this.polling=true;try{
  if(!this.status.writable){if(this.status.phase==='readonly'&&this.isIdle())await this.check();return;}const head=await this.renew();this.status.lastSync=head.lastSync;if(!this.syncing&&head.revision!==this.meta.baseRevision){this.status.writable=false;this.onUnavailable();if(this.isIdle())await this.check();else this.unavailable('NAS 有更新，请暂停当前操作后重新检查','remoteChanges');}
 }catch(e){this.unavailable(e.message);}finally{this.polling=false;}}
 async prepare(signal){
  const entries=exportRecords(this.store),map=new Map(entries.map(e=>[recordId(e),e])),files=[];
  for(const d of this.store.all('downloads')){signal?.throwIfAborted();const assets=[];for(const a of d.assets||[]){if(a.kind==='metadata'||!this.store.assetExists(d,a))continue;const file=requireInside(d.path,path.join(d.path,a.file)),stat=await fsp.stat(file),stamp=[stat.size,stat.mtimeMs,stat.ctimeMs].join(':');let hash=this.meta.files?.[file]?.stamp===stamp?this.meta.files[file].sha:null;
    if(!hash){this.status.progress=`检查本机文件：${a.file}`;this.emit();const h=createHash('sha256');for await(const chunk of fs.createReadStream(file,{signal}))h.update(chunk);hash=h.digest('hex');this.meta.files||={};this.meta.files[file]={stamp,sha:hash};}
    const asset={...a,sha256:hash,size:stat.size};assets.push(asset);files.push({file,asset});
   }if(assets.length){const record={id:d.id,collectionId:d.collectionId,state:d.state,savedAt:d.savedAt,coverSource:d.coverSource,coverWarning:d.coverWarning,assets};map.set('downloads:'+d.id,{table:'downloads',key:d.id,body:record});}
  }const preparedEntries=[...map.values()];await preparePreviews(this,preparedEntries,files,signal);return {entries:preparedEntries,files};
 }
 commitContent(request){return {libraryId:request.libraryId,baseRevision:request.baseRevision,changes:request.changes};}
 acceptCommit(pending,revision){
  this.applying=true;try{for(const e of pending.request.changes){if(e.body===null)delete this.meta.baseline[recordId(e)];else this.meta.baseline[recordId(e)]=contentHash(e.body);if(e.table==='works'&&validPreview(e.body?.backupCover)){const current=this.store.work(e.key);if(current)this.store.put('works',e.key,{...current,backupCover:e.body.backupCover});}if(e.table==='downloads'){if(e.body)this.store.put('backup_downloads',e.key,e.body);else this.store.db.run('DELETE FROM backup_downloads WHERE id=?',[e.key]);}}this.store.save();}finally{this.applying=false;}
  this.meta.baseRevision=revision;this.meta.mediaSignature=pending.mediaSignature;delete this.meta.pendingCommit;this.meta.dirty=changesSince(exportRecords(this.store),this.meta.baseline).length>0||this.mediaDirty();this.persist();
 }
 async sync(){
  if(this.applying)throw new Error('正在更新本机资料，请稍候');this.assertWritable();if(this.syncing)return this.syncing;this.controller=new AbortController();const signal=this.controller.signal;
  this.syncing=(async()=>{this.status.phase='syncing';this.status.message='正在后台同步到 NAS，本机可以继续使用';this.emit();try{
   const head=await this.renew();if(this.meta.pendingCommit){const pending=this.meta.pendingCommit,result=await this.transport.json('POST','/v1/commit',{data:pending.request,signal,timeout:120000});this.acceptCommit(pending,result.ackRevision??result.revision);this.status.lastSync=result.lastSync;if(result.revision!==this.meta.baseRevision)this.unavailable('NAS 还有新的更新，请重新检查','remoteChanges');return result;}
   if(head.revision!==this.meta.baseRevision)throw Object.assign(new Error('NAS 已有其他更新，未覆盖'),{status:409});const prepared=await this.prepare(signal),changes=changesSince(prepared.entries,this.meta.baseline),capturedSignature=this.mediaSignature();this.status.pendingRecords=changes.length;
   const needed=new Set(changes.flatMap(e=>e.table==='downloads'&&e.body?e.body.assets.map(a=>a.sha256):e.table==='works'&&validPreview(e.body?.backupCover)?[e.body.backupCover.sha256]:[])),sent=new Set();let index=0;
   for(const item of prepared.files){if(!needed.has(item.asset.sha256)||sent.has(item.asset.sha256))continue;sent.add(item.asset.sha256);index++;await this.transport.upload(item.file,item.asset,{signal,onProgress:(n,total)=>{this.status.progress=`上传 ${index}/${needed.size} · ${(n/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`;this.emit();}});}
   signal.throwIfAborted();if(!changes.length){this.meta.mediaSignature=capturedSignature;this.meta.dirty=false;this.status.lastSync=head.lastSync;this.persist();return head;}
   this.status.progress='NAS 正在提交同步信息';this.emit();const pending={request:{requestId:randomUUID(),libraryId:this.meta.libraryId,baseRevision:this.meta.baseRevision,changes},mediaSignature:capturedSignature};this.meta.pendingCommit=pending;this.persist();
   const result=await this.transport.json('POST','/v1/commit',{data:pending.request,signal,timeout:120000});this.acceptCommit(pending,result.ackRevision??result.revision);this.status.lastSync=result.lastSync;this.status.progress='';return result;
  }catch(e){if(signal.aborted){this.status.phase='pending';this.status.message='后台同步已暂停，本机文件保留';}else this.unavailable(e.message,e.status===409?'conflict':'offline');throw e;}finally{this.syncing=null;this.controller=null;this.changed();}})();return this.syncing;
 }
 cancel(){this.controller?.abort();}
 afterDownloads(){if(this.status.writable&&!this.syncing)void this.sync().catch(()=>{});}
 async restoreWork(job,signal,metadata){
  const remote=this.store.get('backup_downloads',job.id);if(!remote?.assets?.length)return false;this.assertWritable();if(this.store.isDownloaded(job.id))return true;if(this.store.download(job.id))this.store.relocate(job.id);const target=this.store.destination(job.id),old=this.store.download(job.id);this.store.assertDirectory(target.dir);fs.mkdirSync(target.dir,{recursive:true});const assets=[];
  for(const a of remote.assets){let existing=old?.assets?.find(v=>v.key===a.key);if(existing&&this.store.assetExists(old,existing)&&old.path===target.dir){assets.push(existing);continue;}let name=a.file,file=requireInside(target.dir,path.join(target.dir,name));if(fs.existsSync(file)&&!old?.assets?.some(v=>v.file===name)){name='backup-'+a.sha256.slice(0,8)+'-'+name;file=requireInside(target.dir,path.join(target.dir,name));}await this.transport.download(a,file,{signal,onProgress:(n,total)=>{job.message=`从 NAS 下载 ${a.file} · ${(n/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`;job.progress=Math.round(n/total*95);this.emit();}});assets.push({...a,file:name});}
  signal.throwIfAborted();const d={...remote,path:target.dir,collectionId:target.collectionId,assets};const info=path.join(target.dir,'作品信息.json');fs.writeFileSync(info,JSON.stringify(metadata(this.store.work(job.id),d),null,2));d.assets.push({key:'metadata',file:'作品信息.json',kind:'metadata',size:fs.statSync(info).size});this.store.put('downloads',job.id,d);this.store.save();return d.state==='complete';
 }
 async acceptRemote(){if(this.status.phase!=='conflict')throw new Error('当前没有待处理冲突');await this.renew();const update=await this.transport.json('GET','/v1/changes?since=0');if(update.libraryId!==this.meta.libraryId)throw new Error('备份库标识不一致');const recovery=path.join(this.profile,'recovery');fs.mkdirSync(recovery,{recursive:true});const file=path.join(recovery,Date.now()+'.sqlite');fs.writeFileSync(file,this.store.db.export());
  this.applying=true;try{applyChanges(this.store,update.changes,{replace:true});}finally{this.applying=false;}this.meta={libraryId:update.libraryId,baseRevision:update.revision,baseline:hashes(update.changes.filter(e=>e.body!==null)),files:{},dirty:false,mediaSignature:this.mediaSignature()};this.persist();this.status={...this.status,recovery:file,connected:true,writable:true,phase:'synced',message:'已保留本机恢复副本，并更新为 NAS 的记录',lastSync:update.lastSync,pending:false};this.installTimers();this.emit();return this.status;
 }
 async release(){clearInterval(this.heartbeat);clearInterval(this.schedule);if(this.transport?.leaseToken)try{await this.transport.json('DELETE','/v1/lease',{timeout:4000});}catch{}if(this.transport)this.transport.leaseToken='';this.status.writable=false;}
 async close(){clearTimeout(this.changeTimer);this.changed();this.closed=true;this.cancel();await this.covers.close();if(this.syncing)await this.syncing.catch(()=>{});await this.release();this.transport?.close();this.persist();}
}
