import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate as yieldLoop} from 'node:timers/promises';
import {inspectWorkFiles} from './repair-check.mjs';
import {preparePreviews,previewAsset,readLocalPreview} from './backup-previews.mjs';
import {RepairChecks} from './repair-checks.mjs';

const safeId=id=>typeof id==='string'&&/^\d{1,32}$/.test(id);
export class DefectRepair{
 constructor({store,backup,collector,queue,profile,runForeground,onChange=()=>{}}){
  Object.assign(this,{store,backup,collector,queue,profile,runForeground,onChange});this.file=path.join(profile,'defect-repair.sqlite');this.running=false;fs.mkdirSync(profile,{recursive:true});
  this.db=new DatabaseSync(this.file,{timeout:5000});this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS job(key TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS items(position INTEGER PRIMARY KEY,body TEXT NOT NULL);');
  try{const saved=this.db.prepare("SELECT body FROM job WHERE key='current'").get();this.job=saved?{...JSON.parse(saved.body),items:this.db.prepare('SELECT body FROM items ORDER BY position').all().map(r=>JSON.parse(r.body))}:null;if(this.job?.items.some(i=>!safeId(i.id)))this.job=null;}catch{this.job=null;}
  this.persistAll=true;
  this.checks=new RepairChecks(store,()=>this.onChange());this.scanItems=[];this.scanToken=null;
  if(this.job){for(const item of this.job.items)if(['waiting','running','failed'].includes(item.state)&&item.issues?.some(i=>i.kind==='cover')&&!backup.covers.problems.has(item.id))backup.covers.problems.set(item.id,{kind:'source',reason:item.message||'上次封面补齐未完成',time:new Date().toISOString()});backup.covers.saveProblems();}
  if(this.job?.phase==='running'){this.job.phase='paused';this.job.message='上次补齐未正常结束，已保留结果，可继续';for(const item of this.job.items)if(item.state==='running')item.state='waiting';this.persist();}
  this.indexJob();this.boundSettlement=job=>this.downloadSettled(job);queue.onJobSettled=this.boundSettlement;for(const job of queue.jobs)if(['complete','failed'].includes(job.state))this.downloadSettled(job);
 }
 persist(){if(!this.job)return;const {items,...body}=this.job;this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare("INSERT OR REPLACE INTO job VALUES('current',?)").run(JSON.stringify(body));const put=this.db.prepare('INSERT OR REPLACE INTO items VALUES(?,?)');if(this.persistAll){this.db.exec('DELETE FROM items');items.forEach((item,index)=>put.run(index,JSON.stringify(item)));}else if(this.currentIndex!==undefined)put.run(this.currentIndex,JSON.stringify(items[this.currentIndex]));this.db.exec('COMMIT');this.persistAll=false;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 close(){if(this.queue.onJobSettled===this.boundSettlement)this.queue.onJobSettled=null;void this.checks.close();this.db.close();}
 indexJob(){this.positions=new Map((this.job?.items||[]).map((item,index)=>[item.id,{item,index}]));}
 downloadSettled(task){const entry=this.positions.get(task.id);if(!entry?.item.queueFiles||!['complete','failed'].includes(task.state)||entry.item.downloadResult?.state==='complete')return;const {item,index}=entry,expected=item.downloadOptions||{source:'douyin',coverOnly:false};if((task.source||'douyin')!==expected.source||!!task.coverOnly!==expected.coverOnly)return;item.downloadResult={state:task.state,message:task.message||''};try{this.db.prepare('INSERT OR REPLACE INTO items VALUES(?,?)').run(index,JSON.stringify(item));}catch(error){this.job.message='补齐结果保存失败：'+error.message;}this.onChange();}
 emit(){try{this.persist();}catch(error){this.controller?.abort();this.job.phase='paused';this.job.message='补齐进度保存失败：'+error.message;}this.onChange();}
 state(){if(!this.job&&!this.scanState)return null;const {accountKey,...job}=this.job||{items:[],phase:'idle',message:''},position=this.currentIndex??Math.max(0,job.items.length-1),items=job.items.map(i=>this.result(i));return {...job,scan:this.scanState?{...this.scanState,files:this.checks.state()}:null,items:items.slice(Math.max(0,position-19),position+1),running:this.running,total:items.length,processed:items.filter(i=>['done','failed','skipped'].includes(i.state)).length,failed:items.filter(i=>i.state==='failed').length,done:items.filter(i=>['done','skipped'].includes(i.state)).length,queued:items.filter(i=>i.state==='queued'||i.state==='downloading').length};}
 inspect(id,work=this.store.work(id),fileReport){
  if(!work||(work.readHidden&&!this.store.download(id)))return null;
  const issues=[],problem=this.backup.covers.problems?.get(id),asset=previewAsset(this.store,work);
  if(!this.store.get('backup_downloads',id)?.backupDeleted&&!this.store.get('backup_downloads',id)?.backupRemoved){if(problem)issues.push({kind:'cover',label:'封面异常',reason:problem.reason});
  else if(!asset&&(!work.thumbnail||(!this.backup.meta.dirty&&this.backup.meta.baseRevision!==null)))issues.push({kind:'cover',label:'封面待补',reason:work.thumbnail?'封面尚未成功备份':'缺少封面地址'});}
  const indexed=this.queue.taskRows?.byId.get(id);const download=this.store.download(id),failed=this.queue.taskRows?(indexed?.state==='failed'?indexed:null):this.queue.jobs.find(j=>j.id===id&&j.state==='failed');
  if(download||failed){const files=fileReport||inspectWorkFiles(this.store,id);if(files.status==='missing')for(const m of files.missing){const kind=m.reason==='文件大小异常'?'invalid':m.key==='video'?'video':m.key.startsWith('image-')?'image':m.key==='metadata'?'metadata':'cover';issues.push({kind:'files',type:kind,label:kind==='invalid'?'文件异常':'文件缺失',reason:`${m.label}：${m.reason}`});}else if(files.status==='error')issues.push({kind:files.error.includes('缺少原始图片数量')?'metadata':'blocked',label:files.error.includes('缺少原始图片数量')?'作品信息不完整':'暂时无法检查文件',reason:files.error});else if(files.status==='checking')issues.push({kind:'checking',label:'待检查',reason:'尚未完成文件检查，先重新检查后再补齐'});}
  if(!issues.length&&failed)issues.push({kind:'download',label:'下载失败',reason:failed.message||'上次下载未完成，需要重新确认文件'});
  return issues.length?{id,name:String(work.name).slice(0,256),author:work.author?.nickname||'',url:work.url,issues,status:failed?'downloadFailed':issues.every(i=>['blocked','checking'].includes(i.kind))?'checking':'pending'}:null;
 }
 async scan({compact=false}={}){
  if(this.scanState?.running||this.running)throw Error('已有检查或补齐任务正在进行');
  this.scanState={running:true,checked:0,total:0,cancelled:false};this.onChange();
  try{
   const candidates=new Set(this.store.rows('SELECT id FROM downloads').map(r=>r.id));for(const j of this.queue.jobs)if(j.state==='failed')candidates.add(j.id);const candidateIds=[...candidates];
   const checked=candidates.size?await this.checks.check(candidateIds):null,problems=new Map((this.checks.job?.problems||[]).map(i=>[i.id,i])),stoppedInFiles=this.scanState.cancelled;
   const allIds=this.store.rows('SELECT id FROM works'),ids=stoppedInFiles?candidateIds.slice(0,checked?.checked||0).map(id=>({id})):allIds,items=[];this.scanState.total=allIds.length;
   for(let index=0;index<ids.length;index++){
    if(this.scanState.cancelled&&!stoppedInFiles)break;const id=ids[index].id;
    const files=candidates.has(id)?problems.get(id)||{status:stoppedInFiles||checked?.phase==='done'?'complete':'checking',missing:[]}:undefined;
    const item=this.inspect(id,undefined,files);if(item)items.push(item);this.scanState.checked++;
    if(index%50===49){this.onChange();await yieldLoop();}
   }
   this.scanItems=this.sort(items);this.scanToken=randomUUID();this.scanRevision=(this.scanRevision||0)+1;const report={token:this.scanToken,revision:this.scanRevision,checked:this.scanState.checked,cancelled:this.scanState.cancelled,covers:items.filter(i=>i.issues.some(v=>v.kind==='cover')).length,files:items.filter(i=>i.issues.some(v=>v.kind==='files')).length,blocked:items.filter(i=>i.issues.some(v=>v.kind==='blocked')).length};this.scanReport=report;
   return {...report,...(compact?this.page():{items:this.scanItems})};
  }finally{this.scanState.running=false;this.onChange();}
 }
 sort(items){
  const s=this.store,rows=s.orderedMemberRows('__all__'),ordered=s.collectionReads.managed('__all__')?s.collectionReads.order('__all__',rows):s.sync.order('__all__',rows),rank=new Map(ordered.map((r,i)=>[r.work_id,i])),authorOrder=new Map();let n=0;
  for(const a of s.all('authors').sort((a,b)=>a.id.localeCompare(b.id)))for(const id of s.authorSources.order(a.id))if(!authorOrder.has(id))authorOrder.set(id,n++);
  return items.map(i=>({...i,source:rank.has(i.id)?'收藏':authorOrder.has(i.id)?'作者作品':'保留的本地作品'})).sort((a,b)=>(rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity)||(authorOrder.get(a.id)??Infinity)-(authorOrder.get(b.id)??Infinity)||a.id.localeCompare(b.id));
 }
 result(item){
  let state=item.state,message=item.message;const job=this.queue.taskRows?this.queue.taskRows.byId.get(item.id):this.queue.jobs.find(j=>j.id===item.id);
  const settled=item.downloadResult?.state==='complete'?item.downloadResult:job||item.downloadResult;
  if(item.queueFiles){if(settled?.state==='complete'){state=item.repairFailed?'failed':'done';message=item.repairFailed?item.message:'缺失文件已补齐';}else if(settled?.state==='failed'){state='failed';message=settled.message;}else if(job?.state==='running'){state='downloading';message=job.message;}else if(job?.state==='waiting'){state='queued';message='等待下载补齐';}else if(['queued','downloading'].includes(state)){state='failed';message='下载任务已取消或移除，可重新检查并补齐';}}
  const status=state==='done'||state==='skipped'?'complete':state==='failed'?(item.queueFiles&&settled?.state==='failed'?'downloadFailed':'repairFailed'):['running','downloading','queued'].includes(state)?'processing':'pending';
  return {...item,state,status,message};
 }
 rows(view){const tasks=new Map((this.job?.items||[]).map(i=>[i.id,i]));return view==='results'?[...tasks.values()].map(i=>this.result(i)):this.scanItems.map(i=>{const task=this.job?.scanToken===this.scanToken?tasks.get(i.id):null;return task?{...i,...this.result(task)}:i;});}
 page({view='problems',page=1,status='all',kind='all'}={}){
  if(!['problems','results'].includes(view)||!Number.isInteger(page)||page<1||!['all','pending','checking','processing','downloadFailed','repairFailed','complete'].includes(status)||!['all','cover','files','video','image','invalid','metadata','blocked'].includes(kind))throw Error('检查筛选参数无效');
  const rows=this.rows(view),counts={status:{},kind:{}};
  for(const row of rows){counts.status[row.status]=(counts.status[row.status]||0)+1;for(const key of new Set(row.issues.flatMap(i=>[i.kind,i.type].filter(Boolean))))counts.kind[key]=(counts.kind[key]||0)+1;}
  const matches=rows.filter(i=>(status==='all'||i.status===status)&&(kind==='all'||i.issues.some(v=>v.kind===kind||v.type===kind))),pages=Math.max(1,Math.ceil(matches.length/20)),current=Math.min(page,pages);
  return {token:view==='results'?this.job?.id:this.scanToken,revision:(this.scanRevision||0)+(this.queue.taskRows?.revision||0),items:matches.slice((current-1)*20,current*20),total:matches.length,page:current,pages,counts,repairable:matches.filter(i=>i.status!=='complete'&&i.status!=='processing'&&i.issues.some(v=>!['blocked','checking'].includes(v.kind))).length};
 }
 selection(input){
  if(Array.isArray(input))return [...new Set(input)];
  if(!input||input.token!==(input.view==='results'?this.job?.id:this.scanToken)||input.all!==true||!Array.isArray(input.exclude)||input.exclude.some(id=>!safeId(id)))throw Error('检查结果已更新，请重新选择');
  this.page({...input,page:1});const omit=new Set(input.exclude);
  return this.rows(input.view||'problems').filter(row=>(input.status==='all'||!input.status||row.status===input.status)&&(input.kind==='all'||!input.kind||row.issues.some(i=>i.kind===input.kind||i.type===input.kind))&&!omit.has(row.id)&&row.status!=='complete'&&row.status!=='processing'&&row.issues.some(v=>!['blocked','checking'].includes(v.kind))).map(i=>i.id);
 }
 start(ids,{resume=false}={}){
  if(this.running)throw new Error('已有补齐任务正在运行');
  if(resume){if(!this.job||this.job.accountKey!==this.store.getSetting('browserAccountKey'))throw new Error('没有可继续的同账号补齐任务');for(const item of this.job.items){const result=this.result(item);Object.assign(item,{state:['done','skipped'].includes(result.state)?result.state:'waiting',message:result.message,queueFiles:false,downloadResult:null});}}
  else {ids=this.selection(ids);if(!ids.length||ids.length>100000||ids.some(id=>!safeId(id)))throw new Error('请选择有效的问题作品');const indexed=new Map(this.scanItems.map(i=>[i.id,i]));this.job={id:randomUUID(),scanToken:this.scanToken,accountKey:this.store.getSetting('browserAccountKey'),phase:'running',message:'正在准备定向补齐',items:ids.map(id=>({id,name:indexed.get(id)?.name||this.store.lightViews?.bases.get(id)?.name||id,issues:indexed.get(id)?.issues||[],state:'waiting',message:''}))};}
  this.indexJob();this.controller=new AbortController();this.running=true;this.persistAll=true;this.currentIndex=0;this.job.phase='running';this.emit();
  this.promise=this.runForeground(()=>this.execute(this.controller.signal)).then(()=>{const planned=this.job.items.filter(i=>i.queueFiles);if(this.job.phase==='done'&&this.backup.status.writable){const groups=new Map();for(const item of planned){const options=item.downloadOptions||{source:'douyin',coverOnly:false},key=JSON.stringify(options);if(!groups.has(key))groups.set(key,{options,ids:[]});groups.get(key).ids.push(item.id);}for(const group of groups.values())this.queue.enqueue(group.ids,group.options);}else for(const item of planned){item.state='waiting';item.queueFiles=false;item.message='文件补齐尚未启动，恢复连接后可继续';this.job.phase='paused';this.persistAll=true;}}).catch(error=>{this.job.phase='paused';this.job.message=error.message;}).finally(()=>{this.running=false;this.controller=null;for(const item of this.job.items)if(item.state==='running')item.state='waiting';this.persistAll=true;this.emit();});
  return this.state();
 }
 stop(){if(this.scanState?.running&&!this.scanState.cancelled){this.scanState.cancelled=true;this.checks.cancel();this.onChange();}if(this.job?.phase!=='running')return;this.controller?.abort();this.checks.cancel();this.collector.cancelResolve('补齐已停止');}
 async wait(){await this.promise;}
 async repairCover(id,signal){
  let work=this.store.work(id);const asset=previewAsset(this.store,work);
  if(asset){const file=await this.backup.covers.get(id);if(!file)throw new Error('暂时无法取回 NAS 封面，请检查连接后重试');return '已取回并校验封面';}
  if(await readLocalPreview(this.backup,work,signal)){this.backup.covers.clearProblem(id);return '本机封面已可用，空闲后补备份';}
  signal.throwIfAborted();await this.collector.resolveWork(id,{backgroundOnly:true,signal});signal.throwIfAborted();work=this.store.work(id);
  const entries=[{table:'works',key:id,body:work}],files=[];const failures=await preparePreviews(this.backup,entries,files,signal);
  if(failures||!files.length)throw new Error(this.backup.covers.problems?.get(id)?.reason||'刷新作品后仍未取得封面，可能是图片地址失效或作品受限');
  const target=path.join(this.profile,'covers',id+'.jpg'),temporary=target+'.'+randomUUID()+'.tmp';
  try{await fsp.copyFile(files[0].file,temporary);signal.throwIfAborted();await fsp.rename(temporary,target);}finally{await fsp.rm(temporary,{force:true});}
  this.backup.covers.clearProblem(id);return '已取得封面，空闲后备份到 NAS';
 }
 async execute(signal){
  let stopped=false,filesById=new Map(),batchEnd=0;
  for(const [index,item] of this.job.items.entries()){if(item.state!=='waiting')continue;
   this.currentIndex=index;
   await yieldLoop();
   if(signal.aborted){stopped=true;break;}
   if(index>=batchEnd){batchEnd=index+50;
    const ids=this.job.items.slice(index,index+50).filter(i=>i.state==='waiting').map(i=>i.id).filter(id=>this.store.download(id)||(this.queue.taskRows?this.queue.taskRows.byId.get(id)?.state==='failed':this.queue.jobs.some(j=>j.id===id&&j.state==='failed')));
    filesById=new Map();if(ids.length){const checked=await this.checks.check(ids);if(!signal.aborted&&checked.phase!=='done')throw Error('后台文件检查未完成：'+checked.message);const problems=new Map((this.checks.job?.problems||[]).map(i=>[i.id,i]));for(const id of ids)filesById.set(id,problems.get(id)||{status:checked.phase==='done'?'complete':'checking',missing:[]});}
    if(signal.aborted){stopped=true;break;}
   }
   if(this.job.accountKey!==this.store.getSetting('browserAccountKey'))throw new Error('账号发生变化，已停止补齐');
   item.state='running';item.queueFiles=false;this.job.message='正在补齐：'+item.name;this.emit();
   try{
    const defect=this.inspect(item.id,undefined,filesById.get(item.id));if(!defect){item.state='skipped';item.message='已正常或已移除，未重新下载';continue;}item.issues=defect.issues;item.name=defect.name;
    const messages=[],failures=[];let queued=false;
    if(defect.issues.some(v=>v.kind==='metadata')){await this.collector.resolveWork(item.id,{backgroundOnly:true,signal});signal.throwIfAborted();messages.push('已刷新这一条作品信息');}
    if(defect.issues.some(v=>v.kind==='cover'))try{if(!this.backup.covers.problems.has(item.id)){this.backup.covers.problems.set(item.id,{kind:'source',reason:'封面补齐尚未完成',time:new Date().toISOString()});this.backup.covers.saveProblems();}messages.push(await this.repairCover(item.id,signal));}catch(error){if(signal.aborted)throw error;failures.push(error.message);}
    signal.throwIfAborted();
    if(defect.issues.some(v=>['files','metadata'].includes(v.kind))){let files=filesById.get(item.id);if(defect.issues.some(v=>v.kind==='metadata')){const checked=await this.checks.check([item.id]);signal.throwIfAborted();if(checked.phase!=='done')throw Object.assign(Error('后台文件检查未完成：'+checked.message),{checkFailed:true});files=this.checks.job.problems[0]||{status:'complete'};}if(files?.status==='missing'){queued=true;messages.push('交给下载管理，仅补缺失文件');}else if(files?.status==='error')failures.push(files.error);else if(files?.status==='checking')throw Object.assign(Error('本轮尚未完成文件检查，请重新检查后继续'),{checkFailed:true});}
    if(defect.issues.some(v=>v.kind==='blocked'))failures.push('目录暂时不可访问，未尝试下载');
    const original=this.queue.taskRows?this.queue.taskRows.byId.get(item.id):this.queue.jobs.find(j=>j.id===item.id);
    if(defect.issues.some(v=>v.kind==='download')){queued=true;messages.push(original?.coverOnly?'重试原高清图补齐任务':'重试原任务并确认文件完整性');}
    item.downloadOptions={source:original?.source==='nas'?'nas':'douyin',coverOnly:!!original?.coverOnly};item.queueFiles=queued;item.repairFailed=failures.length>0;item.state=failures.length?'failed':queued?'queued':'done';item.message=[...messages,...failures].join('；');
   }catch(error){if(signal.aborted||error.checkFailed){item.state='waiting';item.message=signal.aborted?'已停止，未完成部分可继续':error.message;if(error.checkFailed)this.job.message=error.message;stopped=true;break;}item.state='failed';item.message=error.message;}
   finally{this.emit();}
   if(Number(this.store.getSetting('accessHoldUntil')||0)>Date.now()||this.store.getSetting('authNeedsRefresh')){stopped=true;this.job.message='平台需要验证或已限制访问，剩余作品保留，请完成验证后继续';break;}
  }
  this.job.phase=stopped?'paused':'done';if(!stopped||signal.aborted)this.job.message=stopped?'补齐已停止，已完成内容保留':'本次补齐结束；仍失败的作品可以单独重试';
 }
}
