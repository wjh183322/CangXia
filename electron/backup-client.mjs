import {inspectWorkFiles} from './repair-check.mjs';
import {preparePreviews,missingPreviews,validPreview} from './backup-previews.mjs';
import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {randomUUID,createHash} from 'node:crypto';
import {BackupTransport,normalizeEndpoint,normalizeFingerprint} from './backup-transport.mjs';import {exportRecords,hashes,changesSince,applyChanges,recordId} from './backup-model.mjs';import {contentHash,PROTOCOL,validHome,commitBatches,validateEntry} from '../shared/backup-protocol.mjs';import {requireInside} from './model.mjs';
import {BackupCovers} from './backup-covers.mjs';
import {BackupAnalysis} from './backup-analysis.mjs';

const localKeys=new Set(['authNeedsRefresh','loggedOut','root','sessionConnected','accessHoldUntil','downloadJobs','downloadConcurrency','localRemoval','nasRemovalJob']);
export class BackupClient{
 constructor(store,profile,{vault,onChange=()=>{},onUnavailable=()=>{},onDiagnostic=()=>{},isIdle=()=>true,heartbeatMs=15000}={}){
  this.profile=profile;this.covers=new BackupCovers(this);this.analyzer=new BackupAnalysis(store.file);
  Object.assign(this,{store,profile,vault,onChange,onUnavailable,onDiagnostic,isIdle,heartbeatMs});this.localReadDepth=0;this.deviceId=this.read('device.json')?.id||randomUUID();this.write('device.json',{id:this.deviceId});this.config=this.read('backup-connection.json');this.meta=this.read('backup-state.json')||{baseRevision:null,baseline:{},files:{},dirty:false};this.status={mode:'backup',phase:'unconfigured',writable:false,connected:false,message:'请先连接 NAS 备份服务',deviceName:this.config?.deviceName||os.hostname(),pending:!!this.meta.dirty};
  store.backup={assertWritable:()=>this.assertWritable(),canWrite:()=>this.status.writable||!!this.applying||!!this.localReadDepth,changed:()=>this.scheduleChanged(),localKey:key=>localKeys.has(key),applying:()=>!!this.applying};
 }
 read(name){try{return JSON.parse(fs.readFileSync(path.join(this.profile,name),'utf8'));}catch{return null;}}
 write(name,value){fs.mkdirSync(this.profile,{recursive:true});const file=path.join(this.profile,name);fs.writeFileSync(file+'.tmp',JSON.stringify(value));fs.renameSync(file+'.tmp',file);}
 persist(){this.write('backup-state.json',this.meta);}
 emit(){this.onChange();}
 publicConfig(){return {url:this.config?.url||'',fingerprint:this.config?.fingerprint||'',deviceName:this.status.deviceName,intervalMinutes:this.config?.intervalMinutes||5,hasToken:!!this.config?.sealedToken};}
 assertWritable(){if(this.applying||this.localReadDepth)return;if(!this.status.writable)throw new Error(this.status.message||'请先连接 NAS 并完成同步检查');}
 unavailable(message,phase='offline'){this.reconnectAt=Date.now()+15000;this.status={...this.status,connected:false,writable:false,phase,message,pending:!!this.meta.dirty||!!this.status.pendingCovers};this.onDiagnostic({event:'nas-unavailable',reason:message,path:phase});this.onUnavailable();this.emit();}
 canSync(){return !this.localReadDepth&&this.isIdle();}
 deferSync(){
  if(this.closed)return;this.idlePending=true;
  if(this.status.writable&&!this.syncing){this.status.phase='waitingIdle';this.status.progress='';this.status.message='本机资料待同步；读取和下载结束后自动备份';this.emit();}
  clearTimeout(this.idleTimer);this.idleTimer=setTimeout(()=>{void this.automaticSync().catch(()=>{});},Math.max(1000,(this.reconnectAt||0)-Date.now()));this.idleTimer.unref?.();
 }
 async automaticSync(){
  if(this.closed||!this.config)return;
  if(!this.canSync()){this.deferSync();return {deferred:true};}
  if(this.syncing||this.checking){this.deferSync();return {deferred:true};}
  if(!this.status.connected){if(Date.now()<(this.reconnectAt||0)){this.deferSync();return {deferred:true};}try{await this.check();}catch{this.deferSync();return {deferred:true};}}
  if(!this.status.writable)return {deferred:true};
  this.idlePending=false;return this.sync();
 }
 async withForegroundRead(action){
  if(this.localReadDepth)throw new Error('已有读取任务正在进行');this.assertWritable();this.localReadDepth++;
  try{if(this.syncing){this.onDiagnostic({event:'nas-paused-for-read'});this.cancel();await this.syncing.catch(()=>{});}return await action();}
  finally{this.localReadDepth--;await this.changed();this.deferSync();}
 }
 mediaSignature(){const parts=[];for(const d of this.store.all('downloads'))for(const a of d.assets||[]){if(a.kind==='metadata')continue;try{const file=requireInside(d.path,path.join(d.path,a.file));this.store.assertDirectory(d.path);const s=fs.lstatSync(file);parts.push([d.id,a.key,file,s.size,s.mtimeMs,s.ctimeMs]);}catch{parts.push([d.id,a.key,'missing']);}}return contentHash(parts);}
 mediaDirty(){for(const d of this.store.all('downloads')){if(this.store.get('backup_downloads',d.id)?.backupDeleted)continue;for(const a of d.assets||[]){if(a.kind==='metadata'||!this.store.assetExists(d,a))continue;try{const file=requireInside(d.path,path.join(d.path,a.file)),s=fs.statSync(file),stamp=[s.size,s.mtimeMs,s.ctimeMs].join(':'),cached=this.meta.files?.[file],remote=this.store.get('backup_downloads',d.id)?.assets?.find(v=>v.key===a.key);if(!cached||cached.stamp!==stamp||!remote||remote.sha256!==cached.sha)return true;}catch{return true;}}}return false;}
 scheduleChanged(){if(this.applying||this.closed)return;clearTimeout(this.changeTimer);this.meta.dirty=true;this.status.pending=true;this.changeTimer=setTimeout(()=>{if(!this.isIdle())return this.scheduleChanged();void this.changed().catch(error=>this.unavailable(error.message));},150);this.changeTimer.unref?.();}
 async analysis(){
  if(!this.analysisPromise){const revision=this.store.revision,base=this.meta.baseRevision;this.analysisPromise=this.analyzer.inspect(this.meta.baseline||{}).then(result=>({...result,analyzedRevision:revision,analyzedBase:base})).finally(()=>{this.analysisPromise=null;});}
  const result=await this.analysisPromise;if(result.analyzedRevision!==this.store.revision||result.analyzedBase!==this.meta.baseRevision)return this.analysis();return result;
 }
 async changed(){clearTimeout(this.changeTimer);if(this.applying)return;const revision=this.store.revision,base=this.meta.baseRevision,result=await this.analysis(),stale=revision!==this.store.revision||base!==this.meta.baseRevision;this.meta.dirty=stale||result.changes.length>0||this.mediaDirty();this.status.pendingCovers=result.pendingCovers;this.status.pending=this.meta.dirty||this.status.pendingCovers>0;this.status.pendingRecords=result.pendingRecords;this.persist();if(this.status.writable&&!this.syncing){this.status.phase=this.meta.dirty?'pending':this.status.pendingCovers?'coversPending':'synced';this.status.message=this.meta.dirty?'本机资料待同步，空闲后备份到 NAS':this.status.pendingCovers?`记录已同步，${this.status.pendingCovers} 张封面暂未备份；已有封面可正常显示，可稍后重试`:'本机记录与 NAS 已同步';}this.emit();if(stale&&!this.closed)this.scheduleChanged();}
 makeTransport(){if(!this.config)return null;const token=this.vault.open(this.config.sealedToken);return new BackupTransport({...this.config,token,deviceId:this.deviceId,onDiagnostic:this.onDiagnostic});}
 async configure(input){
  if(this.syncing)throw new Error('请先结束正在进行的备份同步');const url=normalizeEndpoint(String(input.url||'').trim()),fingerprint=normalizeFingerprint(String(input.fingerprint||'')),name=String(input.deviceName||os.hostname()).trim();if(!name||name.length>80)throw new Error('设备名称无效');const interval=Number(input.intervalMinutes||5);if(!Number.isInteger(interval)||interval<1||interval>1440)throw new Error('同步间隔应为 1 至 1440 分钟');
  const token=String(input.token||'').trim()||(this.config?.sealedToken?this.vault.open(this.config.sealedToken):'');if(token.length<24)throw new Error('请输入 NAS 服务生成的访问密钥');
  await this.release();this.config={url,fingerprint,deviceName:name,intervalMinutes:interval,sealedToken:this.vault.seal(token)};this.write('backup-connection.json',this.config);this.status.deviceName=name;this.transport?.close();this.transport=this.makeTransport();return this.check();
 }
 async renew(){
  if(this.closed||this.releasing)throw Error('正在关闭 NAS 连接');if(this.renewing)return this.renewing;
  const transport=this.transport;
  this.renewing=(async()=>{const response=await transport.json('POST','/v1/lease',{data:{deviceId:this.deviceId,name:this.config.deviceName,leaseToken:transport.leaseToken},timeout:15000});transport.leaseToken=response.leaseToken;return response;})();
  try{return await this.renewing;}finally{this.renewing=null;}
 }
 async start(){if(!this.config)return;this.transport=this.makeTransport();try{await this.check();}catch{}this.installTimers();}
 installTimers(){clearInterval(this.heartbeat);clearInterval(this.schedule);this.heartbeat=setInterval(()=>{void this.poll();},this.heartbeatMs);this.heartbeat.unref?.();this.schedule=setInterval(()=>{void this.automaticSync().catch(()=>{});},(this.config?.intervalMinutes||5)*60000);this.schedule.unref?.();}
 async check(){
  if(this.checking)return this.checking;if(!this.canSync())throw new Error('请等待读取和下载结束后再比对 NAS');if(this.syncing)throw new Error('正在同步，请等待完成');if(!this.transport)this.transport=this.makeTransport();if(!this.transport)throw new Error('请先填写备份服务连接信息');
  this.checking=(async()=>{this.status={...this.status,phase:'checking',writable:false,message:'正在与 NAS 比对同步状态…'};this.emit();try{
   const remote=await this.transport.json('GET','/v1/status');if(remote.protocol!==PROTOCOL)throw Object.assign(new Error('请先升级 NAS 备份服务至 0.2.0（协议 2），现有数据和连接配置可保留'),{code:'PROTOCOL_MISMATCH'});if(this.meta.libraryId&&this.meta.libraryId!==remote.libraryId)throw new Error('这是另一份 NAS 备份库，未覆盖本机资料');
   this.status.backupDeletion=!!remote.capabilities?.backupDeletion;
   if(this.meta.pendingBackupAction){try{const receipt=await this.transport.json('GET','/v1/backup-actions/'+this.meta.pendingBackupAction.data.requestId);await this.acceptBackupAction(receipt);}catch(e){if(e.status!==404)throw e;delete this.meta.pendingBackupAction;this.persist();}}
   if(this.meta.pendingCommit){try{const ack=await this.transport.json('GET','/v1/commits/'+this.meta.pendingCommit.request.requestId);if(ack.requestHash!==await this.analyzer.content(this.commitContent(this.meta.pendingCommit.request)))throw new Error('提交确认与本机待确认内容不同');await this.acceptCommit(this.meta.pendingCommit,ack.revision);}catch(e){if(e.status!==404)throw e;}}
   const existing=await this.analysis();const localChanged=this.meta.baseRevision===null?this.store.rows('SELECT 1 FROM works LIMIT 1').length>0:existing.changes.length>0||this.meta.dirty||this.mediaDirty();
   if((this.meta.baseRevision!==null&&remote.revision!==this.meta.baseRevision&&localChanged)||(this.meta.baseRevision===null&&remote.revision>0&&localChanged)){this.status={...this.status,connected:true,writable:false,phase:'conflict',message:'本机和 NAS 都有更新，已保留双方，未自动覆盖',lastSync:remote.lastSync};this.emit();return this.status;}
   let leased,readOnlyMessage;try{leased=await this.renew();}catch(e){if(e.status===423){const writer=remote.writer;readOnlyMessage=writer?.device===this.deviceId?`本机上一次运行的使用权尚未释放，将自动重试（NAS 锁剩余约 ${Math.max(1,Math.ceil((writer.expires-Date.now())/1000))} 秒）；若旧窗口仍开着，请先退出旧窗口`:writer?.name===this.status.deviceName?`同名设备的另一个实例正在使用：${writer.name}；设备标识不同，请检查是否开着另一份客户端`:e.message;}else throw e;}
   if(leased&&leased.revision!==remote.revision)throw new Error('NAS 刚刚有更新，请重新检查');
   this.meta.libraryId=remote.libraryId;
   if(remote.revision!==(this.meta.baseRevision??0)){
    const update=await this.fetchChanges(this.meta.baseRevision??0);this.applying=true;try{applyChanges(this.store,update.changes);for(const e of update.changes){if(e.body===null)delete this.meta.baseline[recordId(e)];else this.meta.baseline[recordId(e)]=contentHash({...e.body,...(['works','collections','local_tags','downloads'].includes(e.table)?{id:e.key}:{})});}this.store.reconcile();}finally{this.applying=false;}this.meta.baseRevision=update.revision;this.meta.mediaSignature=this.mediaSignature();this.meta.dirty=false;await this.onRemoteApplied?.();
   }else if(this.meta.baseRevision===null)this.meta.baseRevision=remote.revision;
   this.reconnectAt=0;this.status={...this.status,connected:true,writable:!readOnlyMessage,lastSync:remote.lastSync,phase:readOnlyMessage?'readonly':'synced',message:readOnlyMessage||'本机记录与 NAS 已同步'};await this.changed();this.persist();this.installTimers();return this.status;
  }catch(e){this.unavailable(e.message,e.code==='PROTOCOL_MISMATCH'?'upgrade':'offline');throw e;}})();try{return await this.checking;}finally{this.checking=null;}
 }
 async poll(){if(this.closed||this.releasing||this.polling||this.checking||!this.transport||!this.status.connected)return;this.polling=true;try{
  if(!this.status.writable){if(this.status.phase==='readonly'&&this.isIdle())await this.check();return;}const head=await this.renew();if(this.closed||this.releasing)return;this.status.lastSync=head.lastSync;if(!this.syncing&&head.revision!==this.meta.baseRevision){this.status.writable=false;this.onUnavailable();if(this.isIdle())await this.check();else this.unavailable('NAS 有更新，请暂停当前操作后重新检查','remoteChanges');}
 }catch(e){if(!this.closed&&!this.releasing)this.unavailable(e.message);}finally{this.polling=false;}}
 async prepare(signal){
  const analysis=await this.analysis(),entries=analysis.entries,map=new Map(entries.map(e=>[recordId(e),e])),files=[];
  for(const d of this.store.all('downloads')){signal?.throwIfAborted();if(this.store.get('backup_downloads',d.id)?.backupDeleted)continue;const assets=[];for(const a of d.assets||[]){if(a.kind==='metadata'||!this.store.assetExists(d,a))continue;const file=requireInside(d.path,path.join(d.path,a.file)),stat=await fsp.stat(file),stamp=[stat.size,stat.mtimeMs,stat.ctimeMs].join(':');let hash=this.meta.files?.[file]?.stamp===stamp?this.meta.files[file].sha:null;
    if(!hash){this.status.progress=`检查本机文件：${a.file}`;this.emit();const h=createHash('sha256');for await(const chunk of fs.createReadStream(file,{signal}))h.update(chunk);hash=h.digest('hex');this.meta.files||={};this.meta.files[file]={stamp,sha:hash};}
    const existing=this.store.get('backup_downloads',d.id)?.assets?.find(v=>v.key===a.key);if(existing&&existing.sha256!==hash)throw Object.assign(Error('作品 '+d.id+' 的 '+a.file+' 与 NAS 已保存内容不同，原备份保留，请处理文件差异'),{status:409,code:'MEDIA_CONTENT_CHANGED'});const asset={...a,file:existing?.file||a.file,sha256:hash,size:stat.size};assets.push(asset);files.push({file,asset});
   }if(assets.length){const relative=path.relative(this.store.root,path.dirname(d.path)).split(path.sep).join('/'),source=d.collectionId||'__all__',home=d.home||{kind:source.startsWith('author:')?'author':'collection',id:source.startsWith('author:')?source.slice(7):source,folder:relative,workFolder:path.basename(d.path)};if(!validHome(home))throw Error('作品目录无法安全恢复，请检查保存归属');const previous=this.store.get('backup_downloads',d.id),knownKeys=new Set(assets.map(a=>a.key));const merged=[...assets,...(previous?.assets||[]).filter(a=>!knownKeys.has(a.key))],work=this.store.work(d.id),expected=work.type==='images'?work.images.map(im=>'image-'+im.index):['video',...(work.coverUrls?.length||merged.some(a=>a.key==='cover')?['cover']:[])],requiredKeys=[...new Set([...(previous?.requiredKeys||[]),...expected])],state=requiredKeys.every(k=>merged.some(a=>a.key===k))&&(d.state==='complete'||previous?.state==='complete')?'complete':'partial';const record={id:d.id,collectionId:source,home,requiredKeys,state,savedAt:d.savedAt,coverSource:d.coverSource,coverWarning:d.coverWarning,hdCover:d.hdCover||previous?.hdCover,...(previous?.backupDeleted===false?{backupDeleted:false}:{}),assets:merged};map.set('downloads:'+d.id,{table:'downloads',key:d.id,body:record});}
  }const preparedEntries=[...map.values()];await preparePreviews(this,preparedEntries,files,signal);return {entries:preparedEntries,files,deletions:analysis.deletions};
 }
 commitContent(request){return {libraryId:request.libraryId,baseRevision:request.baseRevision,changes:request.changes};}
 async backupAction(action,ids){
  this.assertWritable();const head=await this.renew();if(!head.capabilities?.backupDeletion)throw Error('请先将 NAS 备份服务更新至 0.2.1，保留原 data 目录');
  if(this.meta.pendingCommit){const pending=this.meta.pendingCommit,result=await this.transport.json('POST','/v1/commit',{data:pending.request});await this.acceptCommit(pending,result.ackRevision??result.revision);}
  if(this.meta.pendingBackupAction){const pending=this.meta.pendingBackupAction;try{await this.acceptBackupAction(await this.transport.json('GET','/v1/backup-actions/'+pending.data.requestId));}catch(e){if(e.status!==404)throw e;await this.acceptBackupAction(await this.transport.json('POST',pending.route,{data:pending.data}));}}
  const latest=await this.renew();if(latest.revision!==this.meta.baseRevision)throw Error('NAS 已有其他更新，请重新检查后再删除');
  const pending={route:'/v1/backup-'+action,data:{requestId:randomUUID(),libraryId:this.meta.libraryId,baseRevision:this.meta.baseRevision,ids}};this.meta.pendingBackupAction=pending;this.persist();
  const result=await this.transport.json('POST',pending.route,{data:pending.data,timeout:120000});await this.acceptBackupAction(result);return result;
 }
 async acceptBackupAction(result){
  if(result.libraryId!==this.meta.libraryId||!Array.isArray(result.changes)||!Number.isSafeInteger(result.ackRevision))throw Error('NAS 操作回执无效');
  const pending=this.meta.pendingBackupAction;if(!pending||result.requestId!==pending.data.requestId)throw Error('NAS 操作回执与当前批次不一致');const selected=new Set(pending.data.ids);for(const e of result.changes){validateEntry(e);if(!selected.has(e.key)||!['works','downloads'].includes(e.table)||!e.body)throw Error('NAS 回执包含未选择的作品');}
  this.applying=true;try{for(const e of result.changes){if(e.table==='downloads')this.store.put('backup_downloads',e.key,e.body);else if(e.table==='works'){const current=this.store.work(e.key);if(current){const updated={...current};if(e.body.backupCover)updated.backupCover=e.body.backupCover;else delete updated.backupCover;this.store.put('works',e.key,updated);}this.covers.clearProblem(e.key);}this.meta.baseline[recordId(e)]=contentHash(e.body);}this.store.invalidateViews();this.store.save();}finally{this.applying=false;}
  this.meta.baseRevision=result.ackRevision;delete this.meta.pendingBackupAction;this.status.lastSync=result.lastSync||this.status.lastSync;this.persist();await this.changed();
 }
 async acceptCommit(pending,revision,{deferDirty=false}={}){
  const acceptedHashes=pending.hashes||(await this.analyzer.delta(pending.request.changes.filter(e=>e.body!==null),{},[])).hashes;
  this.applying=true;try{for(const e of pending.request.changes){if(e.body===null)delete this.meta.baseline[recordId(e)];else this.meta.baseline[recordId(e)]=acceptedHashes[recordId(e)];if(e.table==='works'&&validPreview(e.body?.backupCover)){const current=this.store.work(e.key);if(current)this.store.put('works',e.key,{...current,backupCover:e.body.backupCover});}if(e.table==='downloads'){if(e.body)this.store.put('backup_downloads',e.key,e.body);else this.store.db.run('DELETE FROM backup_downloads WHERE id=?',[e.key]);}}this.store.save();}finally{this.applying=false;}
  this.meta.baseRevision=revision;this.meta.mediaSignature=pending.mediaSignature;delete this.meta.pendingCommit;this.meta.dirty=true;if(!deferDirty)await this.changed();this.persist();
 }
 async fetchChanges(since){
  let offset=0,revision=null,last=null;const changes=[];for(;;){const result=await this.transport.json('GET','/v1/changes?since='+since+'&offset='+offset+(revision===null?'':'&through='+revision));if(revision!==null&&result.revision!==revision)throw Error('同步期间 NAS 记录变化，请重新检查');revision=result.revision;changes.push(...result.changes);last=result;if(result.nextOffset===null||result.nextOffset===undefined)break;if(!Number.isSafeInteger(result.nextOffset)||result.nextOffset<=offset)throw Error('NAS 分页位置无效');offset=result.nextOffset;}return {...last,changes};
 }
 async sync(){
  if(this.applying)throw new Error('正在更新本机资料，请稍候');if(!this.canSync()){this.deferSync();return {deferred:true};}this.assertWritable();if(this.syncing)return this.syncing;this.controller=new AbortController();const signal=this.controller.signal;
  this.syncing=(async()=>{this.status.phase='syncing';this.status.message='正在后台同步到 NAS，本机可以继续使用';this.emit();try{
   let head=await this.renew();if(this.meta.pendingCommit){const pending=this.meta.pendingCommit,result=await this.transport.json('POST','/v1/commit',{data:pending.request,signal,timeout:120000});await this.acceptCommit(pending,result.ackRevision??result.revision);this.status.lastSync=result.lastSync;if(result.revision!==this.meta.baseRevision)throw Object.assign(Error('NAS 还有新的更新，请重新检查'),{status:409});head=await this.renew();}
   if(head.revision!==this.meta.baseRevision)throw Object.assign(new Error('NAS 已有其他更新，未覆盖'),{status:409});const prepared=await this.prepare(signal),delta=await this.analyzer.delta(prepared.entries,this.meta.baseline,prepared.deletions),changes=delta.changes,capturedSignature=this.mediaSignature();this.status.pendingRecords=changes.length;
   const batches=commitBatches(changes),needed=new Set(changes.flatMap(e=>e.table==='downloads'&&e.body?e.body.assets.map(a=>a.sha256):e.table==='works'&&validPreview(e.body?.backupCover)?[e.body.backupCover.sha256]:[])),sent=new Set();let index=0;
   for(const item of prepared.files){if(!needed.has(item.asset.sha256)||sent.has(item.asset.sha256))continue;sent.add(item.asset.sha256);index++;await this.transport.upload(item.file,item.asset,{signal,onProgress:(n,total)=>{this.status.progress=`上传 ${index}/${needed.size} · ${(n/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`;this.emit();}});}
   signal.throwIfAborted();if(!changes.length){this.meta.mediaSignature=capturedSignature;this.meta.dirty=false;this.status.lastSync=head.lastSync;this.status.progress='';this.persist();return head;}
   let result=head;for(let b=0;b<batches.length;b++){signal.throwIfAborted();this.assertWritable();this.status.progress=`NAS 正在提交记录 ${b+1}/${batches.length}`;this.emit();const pending={request:{requestId:randomUUID(),libraryId:this.meta.libraryId,baseRevision:this.meta.baseRevision,changes:batches[b]},hashes:Object.fromEntries(batches[b].filter(e=>e.body!==null).map(e=>[recordId(e),delta.hashes[recordId(e)]])),mediaSignature:capturedSignature};this.meta.pendingCommit=pending;this.persist();result=await this.transport.json('POST','/v1/commit',{data:pending.request,signal,timeout:120000});await this.acceptCommit(pending,result.ackRevision??result.revision,{deferDirty:true});this.status.lastSync=result.lastSync;if(result.revision!==this.meta.baseRevision)throw Object.assign(Error('NAS 还有其他更新，请重新检查'),{status:409});}
   this.status.progress='';return result;
  }catch(e){if(signal.aborted){this.status.phase='pending';this.status.message='后台同步已暂停，本机文件保留';}else this.unavailable(e.message,e.code==='MEDIA_CONTENT_CHANGED'?'mediaConflict':e.status===409?'conflict':'offline');throw e;}finally{this.syncing=null;this.controller=null;await this.changed();}})();return this.syncing;
 }
 cancel(){this.controller?.abort();}
 afterDownloads(){this.deferSync();}
 async verifiedFile(file,asset,signal){
  let stat;try{stat=await fsp.lstat(file);}catch(e){if(e.code==='ENOENT')return false;throw e;}if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==asset.size)return false;
  const stamp=[stat.size,stat.mtimeMs,stat.ctimeMs].join(':'),cached=this.meta.files?.[file];if(cached?.stamp===stamp)return cached.sha===asset.sha256;
  const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file,{signal}))hash.update(chunk);const sha=hash.digest('hex');this.meta.files||={};this.meta.files[file]={stamp,sha};return sha===asset.sha256;
 }
 async restoreWork(job,signal,metadata,{missingOnly=false}={}){
  const remote=this.store.get('backup_downloads',job.id);if(!remote?.assets?.length)return false;
  this.assertWritable();if(this.store.download(job.id))this.store.relocate(job.id);
  const target=this.store.destination(job.id),old=this.store.download(job.id);this.store.assertDirectory(target.dir);fs.mkdirSync(target.dir,{recursive:true});
  const local=(old?.path===target.dir?old?.assets||[]:[]).filter(a=>this.store.assetExists(old,a));
  const assets=missingOnly?[...local]:local.filter(a=>a.key==='metadata');
  const d={...remote,...(missingOnly?old||{}:{}),id:job.id,path:target.dir,collectionId:target.collectionId,home:target.home,state:'partial',assets};
  const remember=()=>{this.store.put('downloads',job.id,d);this.store.save();};
  for(const a of remote.assets){
   signal.throwIfAborted();if(a.kind==='metadata')continue;
   // A Douyin fallback fills gaps only. Never replace a successful local transfer.
   if(missingOnly&&assets.some(v=>v.key===a.key))continue;
   const existing=local.find(v=>v.key===a.key);
   if(existing&&await this.verifiedFile(requireInside(target.dir,path.join(target.dir,existing.file)),a,signal)){assets.push({...existing,...a,file:existing.file});remember();continue;}
   let name=a.file,file=requireInside(target.dir,path.join(target.dir,name));
   if(fs.existsSync(file)&&!(await this.verifiedFile(file,a,signal))){name='backup-'+a.sha256.slice(0,8)+'-'+name;file=requireInside(target.dir,path.join(target.dir,name));if(fs.existsSync(file)&&!(await this.verifiedFile(file,a,signal))){name=randomUUID().slice(0,8)+'-'+name;file=requireInside(target.dir,path.join(target.dir,name));}}
   if(!(await this.verifiedFile(file,a,signal)))await this.transport.download(a,file,{signal,onProgress:(n,total)=>{job.phase='transferring';job.activeSource='nas';job.message=`从 NAS 下载 ${a.file} · ${(n/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`;job.progress=Math.round(n/total*95);this.emit();}});
   assets.push({...a,file:name});remember();
  }
  signal.throwIfAborted();
  const ownedMetadata=local.find(a=>a.key==='metadata');let metadataName=ownedMetadata?.file||'作品信息.json';
  if(!ownedMetadata&&fs.existsSync(path.join(target.dir,metadataName)))metadataName='backup-'+job.id+'-'+randomUUID().slice(0,8)+'-作品信息.json';
  const info=requireInside(target.dir,path.join(target.dir,metadataName)),temporary=info+'.tmp';fs.writeFileSync(temporary,JSON.stringify(metadata(this.store.work(job.id),d),null,2));fs.renameSync(temporary,info);
  d.assets=[...assets.filter(a=>a.key!=='metadata'),{key:'metadata',file:metadataName,kind:'metadata',size:fs.statSync(info).size}];d.state=remote.state;remember();
  if(missingOnly){const check=inspectWorkFiles(this.store,job.id);d.state=check.status==='complete'?'complete':'partial';if(d.state==='complete')d.lastError='';d.coverSource=d.assets.find(a=>a.key==='cover')?.source||d.coverSource;remember();}
  return d.state==='complete';
 }
 async acceptRemote(){if(this.status.phase!=='conflict')throw new Error('当前没有待处理冲突');await this.renew();const update=await this.fetchChanges(0);if(update.libraryId!==this.meta.libraryId)throw new Error('备份库标识不一致');const recovery=path.join(this.profile,'recovery');fs.mkdirSync(recovery,{recursive:true});const file=path.join(recovery,Date.now()+'.sqlite');fs.writeFileSync(file,this.store.db.export());
  this.applying=true;try{applyChanges(this.store,update.changes,{replace:true});}finally{this.applying=false;}this.meta={libraryId:update.libraryId,baseRevision:update.revision,baseline:hashes(update.changes.filter(e=>e.body!==null)),files:{},dirty:false,mediaSignature:this.mediaSignature()};this.persist();this.status={...this.status,recovery:file,connected:true,writable:true,phase:'synced',message:'已保留本机恢复副本，并更新为 NAS 的记录',lastSync:update.lastSync,pending:false};this.installTimers();this.emit();return this.status;
 }
 async release(){clearInterval(this.heartbeat);clearInterval(this.schedule);clearTimeout(this.idleTimer);this.releasing=true;try{await this.renewing?.catch(()=>{});if(this.transport?.leaseToken)try{await this.transport.json('DELETE','/v1/lease',{timeout:4000});}catch{}if(this.transport)this.transport.leaseToken='';this.status.writable=false;}finally{this.releasing=false;}}
 async close(){this.closed=true;clearInterval(this.heartbeat);clearInterval(this.schedule);clearTimeout(this.changeTimer);clearTimeout(this.idleTimer);this.cancel();await this.covers.close();if(this.syncing)await this.syncing.catch(()=>{});try{await this.changed();}finally{await this.analyzer.close();await this.release();this.transport?.close();this.persist();}}
}
