import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate as yieldLoop} from 'node:timers/promises';
import {inspectWorkFiles} from './repair-check.mjs';
import {preparePreviews,previewAsset,readLocalPreview} from './backup-previews.mjs';
import {RepairChecks} from './repair-checks.mjs';
import {sourceState} from '../shared/source-state.mjs';
import {ProblemRegistry} from './problem-registry.mjs';
const repairable=i=>!['complete','processing','unavailable','sourceUnknown'].includes(i.status)&&i.issues.some(v=>!['blocked','checking','source'].includes(v.kind));

const safeId=id=>typeof id==='string'&&/^\d{1,32}$/.test(id);
export class DefectRepair{
 constructor({store,backup,collector,queue,profile,runForeground,onChange=()=>{}}){
  Object.assign(this,{store,backup,collector,queue,profile,runForeground,onChange});this.file=path.join(profile,'defect-repair.sqlite');this.running=false;fs.mkdirSync(profile,{recursive:true});
  this.db=new DatabaseSync(this.file,{timeout:5000});this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS job(key TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS items(position INTEGER PRIMARY KEY,body TEXT NOT NULL);');
  this.registry=new ProblemRegistry(this.db);this.problemCursor=Number(this.db.prepare("SELECT value FROM problem_meta WHERE key='journal'").get()?.value||0);this.problemReady=!!this.db.prepare("SELECT value FROM problem_meta WHERE key='seeded'").get();
  const identity=this.db.prepare("SELECT value FROM problem_meta WHERE key='localIdentity'").get()?.value;
  if(identity&&identity!==store.localIdentity||this.problemCursor>store.backupRevision()){this.db.exec("BEGIN IMMEDIATE;DELETE FROM problems;DELETE FROM problem_kinds;DELETE FROM problem_meta;DELETE FROM job;DELETE FROM items;INSERT INTO problem_meta VALUES('revision','0');COMMIT");this.problemCursor=0;this.problemReady=false;}
  this.db.prepare("INSERT OR REPLACE INTO problem_meta VALUES('localIdentity',?)").run(store.localIdentity);
  try{this.scanReport=JSON.parse(this.db.prepare("SELECT value FROM problem_meta WHERE key='lastScan'").get()?.value||'null');}catch{this.scanReport=null;}
  try{const saved=this.db.prepare("SELECT body FROM job WHERE key='current'").get();this.job=saved?{...JSON.parse(saved.body),items:this.db.prepare('SELECT body FROM items ORDER BY position').all().map(r=>JSON.parse(r.body))}:null;if(this.job?.items.some(i=>!safeId(i.id)))this.job=null;}catch{this.job=null;}
  this.persistAll=true;
  this.checks=new RepairChecks(store,()=>this.onChange());this.scanItems=[];this.scanToken=null;
  if(this.job){for(const item of this.job.items)if(['waiting','running','failed'].includes(item.state)&&item.issues?.some(i=>i.kind==='cover')&&!backup.covers.problems.has(item.id))backup.covers.problems.set(item.id,{kind:'source',reason:item.message||'上次封面补齐未完成',time:new Date().toISOString()});backup.covers.saveProblems();}
  if(this.job&&(this.job.phase==='running'||this.job.items.some(i=>i.state==='running'))){this.job.phase='paused';this.job.message='上次补齐未正常结束，已保留结果，可继续';for(const item of this.job.items)if(item.state==='running')item.state='waiting';this.persist();}
  this.indexJob();this.boundSettlement=job=>this.downloadSettled(job);queue.onJobSettled=this.boundSettlement;for(const job of queue.jobs)if(this.positions.has(job.id)&&['complete','failed','unavailable'].includes(job.state))this.downloadSettled(job,{updateOverview:false});
  this.unsubscribeDeviceScopes=store.deviceScopes?.subscribe(ids=>{try{this.refreshProblemIds(ids);}catch(error){this.problemError='问题索引暂未保存：'+error.message;}});
  this.unsubscribeFiles=store.fileStates.subscribe?.(ids=>{try{this.refreshProblemIds(ids);}catch(error){this.problemError='问题索引暂未保存：'+error.message;}});
 }
 cachedFiles(id){
  const w=this.store.work(id),d=this.store.download(id);if(!d)return {status:'complete',missing:[]};
  const cached=this.store.fileStates.get(id),expected=w?.type==='video'?[['video','视频'],['cover','高清单图'],['metadata','作品信息']]:[...(w?.images||[]).map(i=>['image-'+i.index,'图片 '+(i.index+1)]),['metadata','作品信息']],missing=[];
  let uncertain=!cached;
  for(const [key,label]of expected){if(!d.assets?.some(a=>a.key===key)){missing.push({key,label,reason:'尚未保存'});continue;}const a=cached?.assets?.[key];if(a?.state==='missing'||a?.state==='invalid')missing.push({key,label,reason:a.state==='invalid'?'文件大小异常':'文件不存在'});else if(!a?.exists)uncertain=true;}
  if(missing.length)return {status:'missing',missing};return {status:cached?.status==='unknown'?'error':uncertain?'checking':'complete',missing:[],error:'保存目录或文件当前状态无法确认，原文件保留'};
 }
 validFileReport(id,report){if(!report?.signature)return report;const body=this.store.rows('SELECT body FROM downloads WHERE id=?',[id])[0]?.body||'';return report.root===this.store.root&&createHash('sha256').update(body).digest('hex')===report.signature?report:{status:'checking',missing:[],stale:true};}
 hasProblemContext(id,work){return !!work&&(!!this.store.rows('SELECT 1 FROM downloads WHERE id=?',[id]).length||!!this.store.audio?.localIndex.get(id)?.local_saved||this.store.hasRead(id)&&!!this.store.rows("SELECT 1 FROM members WHERE collection_id='__all__' AND work_id=? LIMIT 1",[id]).length||this.store.visibleAuthorRows(id).length>0);}
 problemRank(id,work=this.store.work(id)){const account=work&&this.store.hasRead(id)||!!this.store.download(id);if(this.problemRanks?.has(id)&&account)return this.problemRanks.get(id);const member=account?this.store.rows("SELECT rank FROM members WHERE collection_id='__all__' AND work_id=?",[id])[0]:null;if(member)return {rank:member.rank??1e12,sourceLabel:'收藏'};const author=this.store.visibleAuthorRows(id)[0];return author?{rank:1e13+(author.position||0),sourceLabel:'作者作品'}:{rank:Number.MAX_SAFE_INTEGER,sourceLabel:'保留的本地作品'};}
 refreshProblemIds(ids,filesById,checkedAt=new Date().toISOString()){
  if(this.closed||this.store.db.depth)return;
  const patches=[];for(const id of new Set(ids)){
   const work=this.store.work(id),old=this.registry.get(id);if(!this.hasProblemContext(id,work)){if(old)patches.push({id,file:{status:'complete',issues:[]},source:{state:'unchecked'},task:{state:'complete'},repair:{state:'complete'},checkedAt});continue;}
   const item=this.inspect(id,work,filesById?.get(id)||this.cachedFiles(id)),task=this.queue.taskRows?.byId.get(id)||this.queue.jobs.find(j=>j.id===id),issues=(item?.issues||[]).filter(i=>i.kind!=='source'&&i.kind!=='download');
   if(!item&&!old)continue;
   patches.push({id,name:work.name,author:work.author?.nickname,...this.problemRank(id),file:{status:issues.length?(task?.state==='failed'?'downloadFailed':issues.every(i=>['blocked','checking'].includes(i.kind))?'checking':'pending'):!this.store.download(id)&&['unknown','unavailable'].includes(sourceState(work))?'pending':'complete',issues},source:{state:sourceState(work),reason:work.sourceStatus?.reason,checkedAt:work.sourceStatus?.checkedAt||'1970-01-01T00:00:00.000Z'},task:task?{state:task.state,message:task.message}:old?.facts.task?.state==='failed'?{state:'complete'}:undefined,checkedAt});
  }
  for(const patch of patches)if(patch.file?.issues?.length===0)patch.repair={state:'complete'};
  if(patches.length)this.registry.patchMany(patches,{authoritative:true});
 }
 refreshProblemJournal(limit=200){
  if(this.closed||this.store.db.depth)return;
  const rows=this.store.rows('SELECT seq,kind,work_id FROM backup_changes WHERE seq>? ORDER BY seq LIMIT ?',[this.problemCursor,limit]);if(!rows.length)return;
  const files=new Set(),sources=new Set();for(const row of rows)if(row.work_id){if(['local_downloads','downloads'].includes(row.kind))files.add(row.work_id);if(['works','members','author_members'].includes(row.kind))sources.add(row.work_id);if(['members','author_members'].includes(row.kind))this.problemRanks?.delete(row.work_id);}
  this.refreshProblemIds([...files]);this.refreshSourceFacts([...sources]);this.problemCursor=rows.at(-1).seq;this.db.prepare("INSERT OR REPLACE INTO problem_meta VALUES('journal',?)").run(String(this.problemCursor));
 }
 refreshSourceFacts(ids){
  if(this.closed||this.store.db.depth)return;const patches=[],refresh=[];
  for(const id of new Set(ids)){const work=this.store.work(id),old=this.registry.get(id);if(!this.hasProblemContext(id,work)){if(old)patches.push({id,file:{status:'complete',issues:[]},source:{state:'unchecked'},task:{state:'complete'},repair:{state:'complete'}});continue;}const state=sourceState(work);if(!old&&!['unavailable','unknown'].includes(state))continue;if(!old||old.fileStatus==='complete'&&!this.store.download(id)){refresh.push(id);continue;}patches.push({id,name:work.name,author:work.author?.nickname,...this.problemRank(id,work),source:{state,reason:work.sourceStatus?.reason,checkedAt:work.sourceStatus?.checkedAt||'1970-01-01T00:00:00.000Z'}});}
  if(patches.length)this.registry.patchMany(patches,{authoritative:true});
  if(refresh.length)this.refreshProblemIds(refresh);
 }
 async updateCompleteFilesPolicy(){
  if(this.db.prepare("SELECT value FROM problem_meta WHERE key='completeFilesPolicy'").get()?.value==='1')return;
  let after='';for(;;){const rows=this.db.prepare("SELECT id FROM problems WHERE problem=1 AND file_status='complete' AND id>? ORDER BY id LIMIT 50").all(after);if(!rows.length)break;
   for(const {id}of rows){const old=this.registry.get(id);if(this.store.download(id)?.state==='complete'&&old.facts?.file?.status==='complete')this.registry.patchMany([{id,file:old.facts.file}]);else this.refreshProblemIds([id]);}after=rows.at(-1).id;await yieldLoop();if(this.closed)return;
  }this.db.prepare("INSERT OR REPLACE INTO problem_meta VALUES('completeFilesPolicy','1')").run();
 }
 async prepareOverview(){
  if(this.policyPreparing)await this.policyPreparing;else this.policyPreparing=this.updateCompleteFilesPolicy().finally(()=>{this.policyPreparing=null;});if(this.policyPreparing)await this.policyPreparing;
  if(this.problemReady)return;if(this.problemPreparing)return this.problemPreparing;
  this.problemPreparing=(async()=>{const baseline=this.store.backupRevision(),ids=new Set(this.store.rows("SELECT id FROM works WHERE json_extract(body,'$.remoteState') IN ('unknown','unavailable')").map(r=>r.id));for(const row of this.store.rows('SELECT id FROM downloads'))ids.add(row.id);for(const job of this.queue.jobs)if(job.state==='failed')ids.add(job.id);for(const id of this.backup.covers.problems.keys())ids.add(id);for(const item of this.job?.items||[])ids.add(item.id);
   const list=[...ids];for(let start=0;start<list.length&&!this.closed;start+=50){this.refreshProblemIds(list.slice(start,start+50),undefined,'1970-01-01T00:00:00.000Z');await yieldLoop();}if(this.closed)return;this.problemReady=true;this.problemCursor=baseline;this.db.prepare("INSERT OR REPLACE INTO problem_meta VALUES('journal',?)").run(String(baseline));this.db.prepare("INSERT OR REPLACE INTO problem_meta VALUES('seeded','1')").run();
  })().finally(()=>{this.problemPreparing=null;});return this.problemPreparing;
 }
 async overview(){await this.prepareOverview();this.refreshProblemJournal();const result=this.registry.page();return {...result,checked:this.scanReport?.checked||0,cancelled:this.scanReport?.cancelled||false};}
 persist(){if(!this.job)return;const {items,...body}=this.job;this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare("INSERT OR REPLACE INTO job VALUES('current',?)").run(JSON.stringify(body));const put=this.db.prepare('INSERT OR REPLACE INTO items VALUES(?,?)');if(this.persistAll){this.db.exec('DELETE FROM items');items.forEach((item,index)=>put.run(index,JSON.stringify(item)));}else if(this.currentIndex!==undefined)put.run(this.currentIndex,JSON.stringify(items[this.currentIndex]));this.db.exec('COMMIT');this.persistAll=false;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 close(){this.closed=true;this.unsubscribeFiles?.();this.unsubscribeDeviceScopes?.();if(this.queue.onJobSettled===this.boundSettlement)this.queue.onJobSettled=null;void this.checks.close();this.db.close();}
 indexJob(){this.positions=new Map((this.job?.items||[]).map((item,index)=>[item.id,{item,index}]));}
 downloadSettled(task,{updateOverview=true}={}){if(updateOverview)try{this.refreshProblemIds([task.id]);}catch(error){this.problemError='问题索引暂未保存：'+error.message;}const entry=this.positions.get(task.id);if(!entry?.item.queueFiles||!['complete','failed','unavailable'].includes(task.state)||entry.item.downloadResult?.state==='complete')return;const {item,index}=entry,expected=item.downloadOptions||{source:'douyin',coverOnly:false};if((task.source||'douyin')!==expected.source||!!task.coverOnly!==expected.coverOnly)return;item.downloadResult={state:task.state,message:task.message||''};try{this.db.prepare('INSERT OR REPLACE INTO items VALUES(?,?)').run(index,JSON.stringify(item));}catch(error){this.job.message='补齐结果保存失败：'+error.message;}this.onChange();}
 emit(){try{this.persist();}catch(error){this.controller?.abort();this.job.phase='paused';this.job.message='补齐进度保存失败：'+error.message;}this.onChange();}
 state(){
  if(this.problemReady)try{this.refreshProblemJournal();this.problemError='';}catch(error){this.problemError='问题索引暂未更新：'+error.message;}
  const overviewRevision=this.registry.revision,overviewError=this.problemError||'';
  if(!this.job&&!this.scanState)return {items:[],phase:'idle',running:false,total:0,overviewRevision,overviewError};
  const {accountKey,...job}=this.job||{items:[],phase:'idle',message:''},position=this.currentIndex??Math.max(0,job.items.length-1),items=job.items.map(i=>this.result(i));
  const verification=job.items.filter(i=>i.state==='verified'&&['available','unavailable','unknown'].includes(i.verification?.state)),verifying=job.kind==='verify';
  return {...job,overviewRevision,overviewError,scan:this.scanState?{...this.scanState,files:this.checks.state()}:null,items:items.slice(Math.max(0,position-19),position+1),running:this.running,total:items.length,
   processed:verifying?verification.length:items.filter(i=>['done','failed','skipped','unavailable','verified'].includes(i.state)).length,
   failed:items.filter(i=>i.state==='failed').length,done:items.filter(i=>['done','skipped'].includes(i.state)).length,queued:items.filter(i=>i.state==='queued'||i.state==='downloading').length,
   verified:verification.length,pendingVerification:verifying?items.length-verification.length:0,
   sourceUnavailable:verifying?verification.filter(i=>i.verification.state==='unavailable').length:items.filter(i=>i.status==='unavailable').length,
   sourceAvailable:verification.filter(i=>i.verification.state==='available').length,sourceUnknown:verification.filter(i=>i.verification.state==='unknown').length};
 }
 sourceWork(id){return this.store.lightViews?.ready?this.store.lightViews.bases.get(id):this.store.work(id);}
 sourceProblem(item,work){
  if(!work)return null;
  const source=sourceState(work),issues=item.issues.filter(i=>i.kind!=='source');let status=item.fileStatus??item.status;
  if(source==='unavailable'){issues.push({kind:'source',label:'原作品已失效',reason:work.sourceStatus?.reason||'此前已确认原作品失效，媒体与记录保留'});status='unavailable';}
  else if(source==='unknown'){issues.push({kind:'source',label:'暂无法确认原作品状态',reason:work.sourceStatus?.reason||'此前核验未能确认原作品状态，可以重新核验'});if(status!=='processing')status='sourceUnknown';}
  else if(source==='available'&&!['complete','processing'].includes(status))status='sourceAvailable';
  return issues.length?{...item,issues,status}:null;
 }
 inspect(id,work=this.store.work(id),fileReport){
  if(!this.hasProblemContext(id,work))return null;
  const issues=[],problem=this.backup.covers.problems?.get(id),asset=previewAsset(this.store,work);
  if(!this.store.get('backup_downloads',id)?.backupDeleted&&!this.store.get('backup_downloads',id)?.backupRemoved){if(problem)issues.push({kind:'cover',label:'封面异常',reason:problem.reason});
  else if(!asset&&(!work.thumbnail||(!this.backup.meta.dirty&&this.backup.meta.baseRevision!==null)))issues.push({kind:'cover',label:'封面待补',reason:work.thumbnail?'封面尚未成功备份':'缺少封面地址'});}
  const indexed=this.queue.taskRows?.byId.get(id);const download=this.store.download(id),failed=this.queue.taskRows?(indexed?.state==='failed'?indexed:null):this.queue.jobs.find(j=>j.id===id&&j.state==='failed');
  if(download||failed){const files=this.validFileReport(id,fileReport)||inspectWorkFiles(this.store,id);if(files.status==='missing')for(const m of files.missing){const kind=m.reason==='文件大小异常'?'invalid':m.key==='video'?'video':m.key.startsWith('image-')?'image':m.key==='metadata'?'metadata':'cover';issues.push({kind:'files',type:kind,label:kind==='invalid'?'文件异常':'文件缺失',reason:`${m.label}：${m.reason}`});}else if(files.status==='error')issues.push({kind:files.error.includes('缺少原始图片数量')?'metadata':'blocked',label:files.error.includes('缺少原始图片数量')?'作品信息不完整':'暂时无法检查文件',reason:files.error});else if(files.status==='checking')issues.push({kind:'checking',label:'待检查',reason:'尚未完成文件检查，先重新检查后再补齐'});}
  if(!issues.length&&failed)issues.push({kind:'download',label:'下载失败',reason:failed.message||'上次下载未完成，需要重新确认文件'});
  const fileStatus=failed?'downloadFailed':issues.length&&issues.every(i=>['blocked','checking'].includes(i.kind))?'checking':'pending';
  return this.sourceProblem({id,name:String(work.name).slice(0,256),author:work.author?.nickname||'',url:work.url,issues,status:fileStatus,fileStatus},work);
 }
 async scan({compact=false,ids:selected}={}){
  if(selected!==undefined&&(!Array.isArray(selected)||!selected.length||selected.some(id=>!safeId(id))))throw Error('请选择要检查的作品');const selectedSet=selected?new Set(selected):null,previousReport=this.scanReport;
  if(this.scanState?.running||this.running)throw Error('已有检查或补齐任务正在进行');
  this.scanState={running:true,checked:0,total:0,cancelled:false};this.onChange();
  try{
   await this.prepareOverview();
   const candidates=new Set(selected?selected.filter(id=>this.store.rows('SELECT 1 FROM downloads WHERE id=?',[id]).length):this.store.rows('SELECT id FROM downloads').map(r=>r.id));for(const j of this.queue.jobs)if(j.state==='failed'&&(!selectedSet||selectedSet.has(j.id)))candidates.add(j.id);const candidateIds=[...candidates];
   const checked=candidates.size?await this.checks.check(candidateIds):null,problems=new Map((this.checks.job?.problems||[]).map(i=>[i.id,i])),stoppedInFiles=this.scanState.cancelled;
   const allIds=selected?[...selectedSet].map(id=>({id})):this.store.rows('SELECT id FROM works'),ids=stoppedInFiles?candidateIds.slice(0,checked?.checked||0).map(id=>({id})):allIds,items=[];this.scanState.total=allIds.length;
   for(let index=0;index<ids.length;index++){
    if(this.scanState.cancelled&&!stoppedInFiles)break;const id=ids[index].id;
    const files=candidates.has(id)?problems.get(id)||{status:stoppedInFiles||checked?.phase==='done'?'complete':'checking',missing:[],...this.checks.job?.proofs?.get(id)}:undefined;
    const item=this.inspect(id,undefined,files);if(item)items.push(item);this.scanState.checked++;
    if(index%50===49){this.onChange();await yieldLoop();}
   }
   this.scanItems=this.sort(items);this.scanToken=randomUUID();this.scanRevision=(this.scanRevision||0)+1;const report={token:this.scanToken,revision:this.scanRevision,checked:selected?previousReport?.checked||0:this.scanState.checked,cancelled:selected?previousReport?.cancelled||false:this.scanState.cancelled,lastCheck:{scope:selected?'selected':'all',checked:this.scanState.checked,cancelled:this.scanState.cancelled},covers:items.filter(i=>i.issues.some(v=>v.kind==='cover')).length,files:items.filter(i=>i.issues.some(v=>v.kind==='files')).length,blocked:items.filter(i=>i.issues.some(v=>v.kind==='blocked')).length};this.scanReport=report;
   for(let start=0;start<this.scanState.checked;start+=50){const batch=ids.slice(start,Math.min(start+50,this.scanState.checked)).map(r=>r.id),reports=new Map(batch.map(id=>[id,candidates.has(id)?problems.get(id)||{status:checked?.phase==='done'?'complete':'checking',missing:[],...this.checks.job?.proofs?.get(id)}:{status:'complete',missing:[]}]));this.refreshProblemIds(batch,reports);await yieldLoop();}this.problemReady=true;this.db.prepare("INSERT OR REPLACE INTO problem_meta VALUES('seeded','1')").run();this.problemCursor=this.store.backupRevision();this.db.prepare("INSERT OR REPLACE INTO problem_meta VALUES('journal',?)").run(String(this.problemCursor));this.scanToken=this.registry.selection().token;report.token=this.scanToken;this.db.prepare("INSERT OR REPLACE INTO problem_meta VALUES('lastScan',?)").run(JSON.stringify(report));
   return {...report,...(compact?this.page():{items:this.scanItems})};
  }finally{this.scanState.running=false;this.onChange();}
 }
 sort(items){
  const s=this.store,rows=s.orderedMemberRows('__all__'),ordered=s.collectionReads.managed('__all__')?s.collectionReads.order('__all__',rows):s.sync.order('__all__',rows),rank=new Map(ordered.map((r,i)=>[r.work_id,i])),authorOrder=new Map();let n=0;
  for(const a of s.all('authors').sort((a,b)=>a.id.localeCompare(b.id)))for(const id of s.authorSources.order(a.id))if(!authorOrder.has(id))authorOrder.set(id,n++);
  this.problemRanks=new Map([...rank].map(([id,rank])=>[id,{rank,sourceLabel:'收藏'}]));for(const [id,rank]of authorOrder)if(!this.problemRanks.has(id))this.problemRanks.set(id,{rank:1e13+rank,sourceLabel:'作者作品'});
  return items.map(i=>({...i,source:rank.has(i.id)?'收藏':authorOrder.has(i.id)?'作者作品':'保留的本地作品'})).sort((a,b)=>(rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity)||(authorOrder.get(a.id)??Infinity)-(authorOrder.get(b.id)??Infinity)||a.id.localeCompare(b.id));
 }
 result(item){
  if(this.job?.kind==='verify'&&!(item.state==='verified'&&item.verification))return {...item,status:item.state==='running'?'processing':'pending'};
  if(item.verification)return {...item,status:item.verification.state==='unavailable'?'unavailable':item.verification.state==='available'?'sourceAvailable':'sourceUnknown'};
  if(item.state==='unavailable'||(this.store.lightViews?.ready?this.store.lightViews.bases.get(item.id):this.store.work(item.id))?.remoteState==='unavailable')return {...item,state:'unavailable',status:'unavailable',message:'原作品已失效，已跳过自动补齐'};
  let state=item.state,message=item.message;const job=this.queue.taskRows?this.queue.taskRows.byId.get(item.id):this.queue.jobs.find(j=>j.id===item.id);
  const settled=item.downloadResult?.state==='complete'?item.downloadResult:job||item.downloadResult;
  if(item.queueFiles){if(settled?.state==='unavailable')return {...item,state:'unavailable',status:'unavailable',message:settled.message};if(settled?.state==='complete'){state=item.repairFailed?'failed':'done';message=item.repairFailed?item.message:'缺失文件已补齐';}else if(settled?.state==='failed'){state='failed';message=settled.message;}else if(job?.state==='running'){state='downloading';message=job.message;}else if(job?.state==='waiting'){state='queued';message='等待下载补齐';}else if(['queued','downloading'].includes(state)){state='failed';message='下载任务已取消或移除，可重新检查并补齐';}}
  const status=state==='done'||state==='skipped'?'complete':state==='failed'?(item.queueFiles&&settled?.state==='failed'?'downloadFailed':'repairFailed'):['running','downloading','queued'].includes(state)?'processing':'pending';
  return {...item,state,status,message};
 }
 rows(view){
  const tasks=new Map((this.job?.items||[]).map(i=>[i.id,i]));
  if(view==='results')return [...tasks.values()].map(i=>{const row=this.result(i),sourceStatus=this.job.kind==='verify'?(i.verification?.state||'unchecked'):sourceState(this.sourceWork(i.id)),originalFile=i.downloadResult?.state==='complete'?(i.repairFailed?'repairFailed':'complete'):['done','skipped'].includes(i.state)?'complete':i.fileStatus||'pending';return {...row,fileStatus:this.job.kind==='verify'?(i.fileStatus||'pending'):['unavailable','sourceAvailable','sourceUnknown'].includes(row.status)?originalFile:row.status,sourceStatus};});
  return this.scanItems.map(i=>{
   const task=this.job?.kind!=='verify'&&this.job?.scanToken===this.scanToken?tasks.get(i.id):null,result=task?this.result(task):null;
   const row=result?{...i,...result,fileStatus:result.status}:i;
   return this.sourceProblem(row,this.sourceWork(i.id));
  }).filter(Boolean);
 }
 page({view='problems',page=1,status='all',kind='all',fileStatus='all',sourceStatus='all'}={}){
  if(view==='problems'){this.refreshProblemJournal();return this.registry.page({page,status,kind,fileStatus,sourceStatus});}
  if(!['problems','results'].includes(view)||!Number.isInteger(page)||page<1||!['all','pending','checking','processing','downloadFailed','repairFailed','complete','unavailable','sourceUnknown','sourceAvailable'].includes(status)||!['all','cover','files','video','image','invalid','metadata','blocked','source'].includes(kind))throw Error('检查筛选参数无效');
  if(!['all','checking','pending','processing','downloadFailed','repairFailed','complete','blocked'].includes(fileStatus)||!['all','unchecked','available','unavailable','unknown'].includes(sourceStatus))throw Error('检查筛选参数无效');
  const rows=this.rows(view),counts={status:{},fileStatus:{},sourceStatus:{},kind:{}};
  for(const row of rows){for(const key of ['status','fileStatus','sourceStatus'])counts[key][row[key]]=(counts[key][row[key]]||0)+1;for(const key of new Set(row.issues.flatMap(i=>[i.kind,i.type].filter(Boolean))))counts.kind[key]=(counts.kind[key]||0)+1;}
  const matches=rows.filter(i=>(status==='all'||i.status===status)&&(fileStatus==='all'||i.fileStatus===fileStatus)&&(sourceStatus==='all'||i.sourceStatus===sourceStatus)&&(kind==='all'||i.issues.some(v=>v.kind===kind||v.type===kind))),pages=Math.max(1,Math.ceil(matches.length/20)),current=Math.min(page,pages);
  return {token:view==='results'?this.job?.id:this.scanToken,revision:(this.scanRevision||0)+(this.queue.taskRows?.revision||0),items:matches.slice((current-1)*20,current*20),total:matches.length,page:current,pages,counts,repairable:matches.filter(repairable).length,selectable:matches.filter(i=>i.status!=='processing').length};
 }
 selection(input,{verify=false}={}){
  if(Array.isArray(input))return [...new Set(input)];
  if(input?.view!=='results'){this.refreshProblemJournal();return this.registry.resolveSelection(input,{verify});}
  if(!input||input.token!==(input.view==='results'?this.job?.id:this.scanToken)||input.all!==true||!Array.isArray(input.exclude)||input.exclude.some(id=>!safeId(id)))throw Error('检查结果已更新，请重新选择');
  this.page({...input,page:1});const omit=new Set(input.exclude);
  return this.rows(input.view||'problems').filter(row=>(input.status==='all'||!input.status||row.status===input.status)&&(input.fileStatus==='all'||!input.fileStatus||row.fileStatus===input.fileStatus)&&(input.sourceStatus==='all'||!input.sourceStatus||row.sourceStatus===input.sourceStatus)&&(input.kind==='all'||!input.kind||row.issues.some(i=>i.kind===input.kind||i.type===input.kind))&&!omit.has(row.id)&&(verify?row.status!=='processing':repairable(row))).map(i=>i.id);
 }
 jobItem(id,indexed){const saved=this.registry.get(id),previous=indexed.get(id);return {id,name:saved?.name||previous?.name||this.store.lightViews?.bases.get(id)?.name||id,issues:saved?.issues||previous?.issues||[],fileStatus:saved?.fileStatus||previous?.fileStatus||'pending',state:'waiting',message:''};}
 validateSelection(input){
  if(!Array.isArray(input.ids)||input.ids.length>100000||input.ids.some(id=>!safeId(id)))throw Error('作品选择无效');
  const selected=[...new Set(input.ids)];if(input.view!=='results'){this.refreshSourceFacts(selected);const result=this.registry.validateSelection(input),busy=new Set(selected.filter(id=>['running','waiting'].includes(this.queue.taskRows?.byId.get(id)?.state))),ids=result.ids.filter(id=>!busy.has(id));return {ids,repairableIds:result.repairableIds.filter(id=>!busy.has(id)),invalid:selected.length-ids.length};}
  if(input.jobId!==this.job?.id)return {ids:[],repairableIds:[],invalid:selected.length};this.page({...input,page:1});const rows=new Map(this.rows('results').map(row=>[row.id,row])),valid=selected.map(id=>rows.get(id)).filter(row=>row&&row.fileStatus!=='processing'&&(input.fileStatus==='all'||!input.fileStatus||row.fileStatus===input.fileStatus)&&(input.sourceStatus==='all'||!input.sourceStatus||row.sourceStatus===input.sourceStatus)&&(input.kind==='all'||!input.kind||row.issues.some(i=>i.kind===input.kind||i.type===input.kind)));return {ids:valid.map(i=>i.id),repairableIds:valid.filter(repairable).map(i=>i.id),invalid:selected.length-valid.length};
 }
 startVerification(input){
  if(this.running||this.scanState?.running)throw Error('已有检查或补齐任务正在进行');const ids=this.selection(input,{verify:true});if(!ids.length||ids.length>100000||ids.some(id=>!safeId(id)))throw Error('请选择要核验的作品');
  const indexed=new Map(this.scanItems.map(i=>[i.id,i]));this.job={id:randomUUID(),kind:'verify',scanToken:this.scanToken,accountKey:this.store.getSetting('browserAccountKey'),phase:'running',message:'正在批量核验原作品状态',items:this.sort(ids.map(id=>this.jobItem(id,indexed)))};
  return this.runVerification();
 }
 runVerification(){
  this.job.phase='running';this.indexJob();this.controller=new AbortController();this.running=true;this.persistAll=true;this.currentIndex=0;this.emit();
  this.promise=this.runForeground(async()=>{for(const [index,item]of this.job.items.entries()){if(item.state!=='waiting')continue;if(this.controller.signal.aborted)break;if(this.job.accountKey!==this.store.getSetting('browserAccountKey'))throw Error('账号发生变化，已暂停核验');this.currentIndex=index;item.state='running';this.job.message='正在核验：'+item.name;this.emit();try{const result=await this.collector.verifySource(item.id,{signal:this.controller.signal});item.verification=result;this.refreshSourceFacts([item.id]);item.state='verified';item.message=result.reason;if(result.state==='available')item.issues=item.issues.filter(i=>i.kind!=='source');this.emit();if(result.authRequired){this.job.message='登录或访问频率需要处理，剩余作品保留';break;}}catch(error){item.state='waiting';if(this.controller.signal.aborted)break;throw error;}await yieldLoop();if(this.collector.delay)await this.collector.delay();}
   this.job.phase=this.job.items.some(i=>i.state==='waiting')?'paused':'done';if(this.job.phase==='done')this.job.message='原作品状态核验完成，未添加下载任务';else if(this.controller.signal.aborted)this.job.message='核验已停止，已核验结果保留';
  }).catch(error=>{this.job.phase='paused';this.job.message=error.message;}).finally(()=>{this.running=false;this.controller=null;for(const item of this.job.items)if(item.state==='running')item.state='waiting';this.persistAll=true;this.emit();});return this.state();
 }
 start(ids,{resume=false}={}){
  if(this.running)throw new Error('已有补齐任务正在运行');
  if(resume&&this.job?.kind==='verify'){if(this.job.accountKey!==this.store.getSetting('browserAccountKey'))throw Error('账号已变化，无法继续核验');return this.runVerification();}
  if(resume){if(!this.job||this.job.accountKey!==this.store.getSetting('browserAccountKey'))throw new Error('没有可继续的同账号补齐任务');for(const item of this.job.items){const result=this.result(item);Object.assign(item,{state:['done','skipped'].includes(result.state)?result.state:'waiting',message:result.message,queueFiles:false,downloadResult:null});}}
  else {ids=this.selection(ids);if(!ids.length||ids.length>100000||ids.some(id=>!safeId(id)))throw new Error('请选择有效的问题作品');const indexed=new Map(this.scanItems.map(i=>[i.id,i]));this.job={id:randomUUID(),scanToken:this.scanToken,accountKey:this.store.getSetting('browserAccountKey'),phase:'running',message:'正在准备定向补齐',items:ids.map(id=>this.jobItem(id,indexed))};}
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
   if(this.store.work(item.id)?.remoteState==='unavailable'){item.state='unavailable';item.message='原作品已失效，已跳过补齐';this.emit();continue;}
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
   finally{if(['failed','done','skipped','queued'].includes(item.state)){this.refreshProblemIds([item.id],filesById);if(this.hasProblemContext(item.id,this.store.work(item.id)))this.registry.patchMany([{id:item.id,repair:{state:item.state==='failed'?'failed':'complete',message:item.message,issues:item.state==='failed'?item.issues.filter(i=>!['source','download'].includes(i.kind)):[]}}],{authoritative:true});}this.emit();}
   if(Number(this.store.getSetting('accessHoldUntil')||0)>Date.now()||this.store.getSetting('authNeedsRefresh')){stopped=true;this.job.message='平台需要验证或已限制访问，剩余作品保留，请完成验证后继续';break;}
  }
  this.job.phase=stopped?'paused':'done';if(!stopped||signal.aborted)this.job.message=stopped?'补齐已停止，已完成内容保留':'本次补齐结束；仍失败的作品可以单独重试';
 }
}
