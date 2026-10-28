import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';import {setImmediate as yieldToUI} from 'node:timers/promises';
import {planDownloads} from './download-selection.mjs';import {buildDirectoryIndex,directoryKey,DirectoryReservations} from './download-directory-index.mjs';import {DownloadAnalysis} from './download-analysis-process.mjs';import {captureCancellationOwnership} from './download-ownership-async.mjs';import {DownloadPreparationRepository} from './download-preparation-repository.mjs';
const terminal=new Set(['complete','partial','stopped','failed']);
const fault=(message,code='PREPARATION_CHANGED')=>Object.assign(Error(message),{code});
export class DownloadPreparation{
 constructor({store,queue,analysis,onChange=()=>{},diagnostics,capture=captureCancellationOwnership,threshold=10000}={}){
  Object.assign(this,{store,queue,analysis,onChange,diagnostics,capture,threshold});this.repo=new DownloadPreparationRepository(store);this.stats={ownershipBuilds:0};this.current=this.repo.latest();if(this.current&&!terminal.has(this.current.phase)){this.current={...this.current,phase:'stopped',message:'上次准备未正常结束，已受理任务保持暂停'};this.repo.save(this.current);}this.reservations=new DirectoryReservations();
 }
 state(){return {...(this.current||{phase:'idle',total:0,processed:0,accepted:0,existing:0,skipped:0,failed:0,remaining:0,held:0}),running:!!this.controller};}
 results(options){return this.repo.page(options);}
 emit(persist=true){if(persist&&this.current)this.repo.save(this.current);this.onChange(this.state());}
 context(){return {root:path.resolve(this.store.root),file:this.store.file,libraryId:this.store.backup?.meta?.libraryId||null};}
 checkContext(context){if(this.closed||path.resolve(this.store.root)!==context.root||this.store.file!==context.file||(this.store.backup?.meta?.libraryId||null)!==context.libraryId)throw fault('下载根目录或资料库已变化，请重新准备','PREPARATION_CONTEXT');}
 start(input){
  if(this.closed)throw fault('下载准备已关闭');if(this.controller)throw fault('已有下载任务正在准备，请先停止或等待','PREPARATION_BUSY');if(!input||!Array.isArray(input.ids)||input.ids.length>100000||input.ids.some(id=>typeof id!=='string'||!/^\d{1,32}$/.test(id)))throw Error('下载选择无效');
  const request={source:'douyin',scope:'unsaved',kind:'selection',coverOnly:false,...input,ids:[...new Set(input.ids)]};if(!['douyin','nas'].includes(request.source)||!['selection','exact'].includes(request.kind)||!['unsaved','missing'].includes(request.scope)||typeof request.coverOnly!=='boolean')throw Error('下载准备选项无效');
  this.controller=new AbortController();this.current={operationId:randomUUID(),phase:'analysing',total:request.ids.length,processed:0,accepted:0,existing:0,skipped:0,failed:0,remaining:request.ids.length,held:0,startedAt:new Date().toISOString(),message:'正在准备下载任务'};this.emit();const context=this.context(),signal=this.controller.signal;this.promise=(async()=>{await yieldToUI();return this.execute(request,context,signal);})();this.promise.catch(()=>{});return {operationId:this.current.operationId};
 }
 async submit(request){this.start(request);return this.promise;}
 stop(id){if(this.current?.operationId!==id)throw Error('准备任务已变化');if(this.controller&&!this.controller.signal.aborted){this.current.phase='stopping';this.current.message='正在停止准备，已受理任务保留';this.controller.abort();this.emit();}return this.state();}
 result(){const s=this.current;return {operationId:s.operationId,queued:s.accepted,existing:s.existing,skipped:s.skipped,unavailable:s.unavailable||0,removed:s.removed||0,failed:s.failed,remaining:s.remaining,held:s.held,phase:s.phase,message:s.message};}
 async classify(request,signal){const eligible=[],excluded=[];let unavailable=0;for(let i=0;i<request.ids.length;i+=500){signal.throwIfAborted();const ids=request.ids.slice(i,i+500);if(request.kind==='selection'&&request.source==='douyin'&&!request.coverOnly){const plan=planDownloads(this.store,this.queue,ids,{scope:request.scope});eligible.push(...plan.ids);excluded.push(...plan.excludedTasks);unavailable+=plan.report.unavailable;}else for(const id of ids){const work=this.store.lightViews.ready?this.store.lightViews.bases.get(id):this.store.work(id);if(!work)continue;if(request.source!=='nas'&&work.remoteState==='unavailable'){unavailable++;continue;}eligible.push(id);}await yieldToUI();}return {eligible,excluded,unavailable};}
 async beginIndex(context,operationId,signal){
  this.stats.ownershipBuilds++;this.reservations=new DirectoryReservations();const count=this.store.rows('SELECT COUNT(*) n FROM downloads')[0].n;
  if(this.analysis||count>=this.threshold){this.analysis||=new DownloadAnalysis({file:context.file,root:context.root,libraryId:context.libraryId});Object.assign(this.analysis,{file:context.file,root:context.root,libraryId:context.libraryId});const opened=await this.analysis.open({operationId,signal});return {helper:true,...opened,seq:opened.baseSeq,overlay:new Map(),looked:new Set()};}
  const baseSeq=this.store.pathJournal.head(),rows=this.store.rows("SELECT id,json_extract(body,'$.path') path FROM downloads");this.reservations=new DirectoryReservations(buildDirectoryIndex(rows));return {helper:false,seq:baseSeq,overlay:new Map(),looked:new Set()};
 }
 refreshIndex(index){let count=0;for(;;){const page=this.store.pathJournal.changes(index.seq);for(const row of page.items){if(++count>10000||index.overlay.size>=10000&&!index.overlay.has(row.id))throw fault('下载目录变化过多，请重新准备','PATH_JOURNAL_GAP');this.reservations.update(row);index.overlay.set(row.id,row);index.seq=row.seq;}if(!page.hasMore)break;}}
 async remember(index,files,signal){
  const missing=[...new Set(files)].filter(file=>!index.looked.has(directoryKey(file)));if(!index.helper){for(const file of missing)index.looked.add(directoryKey(file));return;}if(!missing.length)return;
  const rows=await this.analysis.lookup(index.snapshotId,missing,{signal});this.refreshIndex(index);for(const row of rows){const key=directoryKey(row.path),owners=new Set(row.owners.filter(id=>!index.overlay.has(id)||index.overlay.get(id).path&&directoryKey(index.overlay.get(id).path)===key));for(const change of index.overlay.values())if(change.path&&directoryKey(change.path)===key)owners.add(change.id);this.reservations.index.set(key,owners);for(const id of owners)this.reservations.paths.set(id,key);index.looked.add(key);}
 }
 async target(id,index,signal){const base=this.store.destination(id,{owners:new Map(),exists:()=>false,check:false});await this.remember(index,[base.dir,base.dir+'-'+id],signal);this.refreshIndex(index);let exists;try{await fs.lstat(base.dir);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;exists=false;}const owners={get:file=>this.reservations.owners(file)},target=this.store.destination(id,{owners,exists:()=>exists,check:false});if([...this.reservations.owners(target.dir)].some(owner=>owner!==id))throw fault('目标目录已被其他作品占用，原文件保留','DIRECTORY_OCCUPIED');return target;}
 async execute(request,context,signal){let index;const s=this.current;
  try{
   this.checkContext(context);const plan=await this.classify(request,signal);s.unavailable=plan.unavailable;s.skipped=request.ids.length-plan.eligible.length;s.processed=s.skipped;s.remaining=plan.eligible.length;if(plan.excluded.length)s.removed=(await this.queue.discardUnneeded(plan.excluded)).removed;this.checkContext(context);signal.throwIfAborted();
   index=await this.beginIndex(context,s.operationId,signal);for(const job of this.queue.jobs)if(job.state!=='complete')for(const dir of job.cancelOwnership?.dirs||[])this.reservations.reserve(dir.dir,job.id);
   for(let i=0;i<plan.eligible.length;i++){
    signal.throwIfAborted();this.checkContext(context);this.refreshIndex(index);const id=plan.eligible[i],old=this.queue.taskRows.byId.get(id);
    if(old?.cancelOwnership?.cancelRequested||this.queue.cancellations.has(id))throw fault('所选任务正在取消或清理，准备已暂停','PREPARATION_CANCELLING');
    if(old&&['waiting','running'].includes(old.state)){if(!!old.coverOnly!==request.coverOnly||(old.source||'douyin')!==request.source)throw fault('所选作品已有其他类型的任务，请先完成或取消','PREPARATION_TYPE');s.existing++;s.processed++;s.remaining--;this.emit();continue;}
    let target,ownership;const before=JSON.stringify(this.store.work(id));s.phase='capturing';s.message=`正在准备任务 ${i+1} / ${plan.eligible.length}`;
    try{target=await this.target(id,index,signal);ownership=old&&old.state!=='complete'?old.cancelOwnership:await this.capture(this.store,id,{target,signal});}
    catch(e){signal.throwIfAborted();this.checkContext(context);if(e.code?.startsWith('ANALYSIS_')||e.code==='PATH_JOURNAL_GAP')throw e;s.failed++;s.processed++;s.remaining--;this.repo.result(s.operationId,id,s.processed,'failed',String(e.message).replaceAll(context.root,'[保存目录]').slice(0,240));this.emit();continue;}
    signal.throwIfAborted();this.checkContext(context);if(JSON.stringify(this.store.work(id))!==before){s.failed++;s.processed++;s.remaining--;this.repo.result(s.operationId,id,s.processed,'failed','作品资料已变化，请重新准备');this.emit();continue;}
    this.refreshIndex(index);if([...this.reservations.owners(target.dir)].some(owner=>owner!==id))throw fault('下载目录归属已变化，请重新准备','PREPARATION_CHANGED');
    const work=this.store.lightViews.ready?this.store.lightViews.bases.get(id):this.store.work(id),job={id,title:work.name,state:'waiting',progress:0,message:'已准备，等待批次放行',source:request.source,coverOnly:request.coverOnly,...(request.catalogueLibrary?{catalogueLibrary:request.catalogueLibrary}:{}),...(ownership?{cancelOwnership:ownership}:{}),admission:{operationId:s.operationId,held:true,root:context.root,libraryId:context.libraryId,target}};
    s.phase='admitting';const oldCopy=old?{...old}:null,counts={accepted:s.accepted,held:s.held,processed:s.processed,remaining:s.remaining};this.store.db.run('BEGIN');try{this.queue.admitPrepared([job],{operationId:s.operationId,held:true});s.accepted++;s.held++;s.processed++;s.remaining--;this.repo.result(s.operationId,id,s.processed,'accepted');this.repo.save(s);this.store.db.run('COMMIT');}
    catch(e){this.store.db.run('ROLLBACK');Object.assign(s,counts);if(oldCopy){for(const key of Object.keys(old))if(!(key in oldCopy))delete old[key];this.queue.taskRows.upsertMany([oldCopy]);}else this.queue.taskRows.removeMany([id]);throw e;}
    this.reservations.reserve(target.dir,id);this.emit(false);await yieldToUI();
   }
   signal.throwIfAborted();this.checkContext(context);this.queue.releaseAdmission(s.operationId);s.held=0;s.phase=s.failed?'partial':'complete';s.message=s.failed?'准备完成，部分作品失败，可查看原因后重试':'下载任务准备完成';
  }catch(e){s.phase=signal.aborted?'stopped':'failed';s.errorCode=e.code;s.message=signal.aborted?'准备已停止，已受理任务保持暂停':String(e.message).replaceAll(context.root,'[保存目录]').slice(0,240);}
  finally{if(index?.helper)await this.analysis.release(index.snapshotId).catch(()=>{});this.controller=null;this.emit();this.repo.prune();this.diagnostics?.record?.({event:'download-preparation',count:s.accepted,code:s.errorCode,reason:s.phase});}
  return this.result();
 }
 async continue(id){
  if(this.closed)throw Error('下载准备已关闭');if(this.controller)throw fault('请先停止或等待当前准备','PREPARATION_BUSY');const saved=this.repo.get(id);if(!saved)throw Error('准备任务已不存在');const jobs=this.queue.jobs.filter(j=>j.admission?.operationId===id&&j.admission.held),context=this.context();
  this.controller=new AbortController();const signal=this.controller.signal;this.current={...saved,phase:'capturing',message:'正在核对本批暂停任务'};this.emit();
  this.promise=(async()=>{let index;try{await yieldToUI();this.checkContext(context);index=await this.beginIndex(context,id,signal);for(const job of this.queue.jobs)if(job.state!=='complete')for(const dir of job.cancelOwnership?.dirs||[])this.reservations.reserve(dir.dir,job.id);
   for(const job of jobs){signal.throwIfAborted();this.checkContext(context);if(job.admission.root!==context.root||job.admission.libraryId!==context.libraryId)throw Error('保存根目录或资料库已变化，请重新准备');if(job.cancelOwnership?.cancelRequested||this.queue.cancellations.has(job.id))throw Error('任务清理尚未完成');const work=this.store.work(job.id);if(!work||job.source!=='nas'&&work.remoteState==='unavailable')throw Error('作品状态已变化，请重新核对');const target=await this.target(job.id,index,signal);if(directoryKey(target.dir)!==directoryKey(job.admission.target.dir))throw Error('暂停任务的保存位置已变化，请取消该任务后重新准备');await this.capture(this.store,job.id,{target,signal});this.checkContext(context);if(this.queue.taskRows.byId.get(job.id)!==job)throw Error('暂停任务已变化，请重新核对');}
   signal.throwIfAborted();this.checkContext(context);this.queue.releaseAdmission(id);this.current={...saved,held:0,phase:saved.failed||saved.remaining?'partial':'complete',message:'已继续本批已受理任务；尚未受理部分可重新选择下载'};return this.result();
  }catch(error){this.current={...saved,phase:signal.aborted?'stopped':'failed',message:String(error.message).replaceAll(context.root,'[保存目录]').slice(0,240)};throw error;}
  finally{if(index?.helper)await this.analysis.release(index.snapshotId).catch(()=>{});this.controller=null;this.emit();}})();this.promise.catch(()=>{});return this.promise;
 }
 async drain(){if(this.controller)this.stop(this.current.operationId);await this.promise?.catch(()=>{});}
 async close(){this.closed=true;await this.drain();await this.analysis?.close();}
}
