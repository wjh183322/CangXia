import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate as yieldLoop} from 'node:timers/promises';
import {inspectWorkFiles} from './repair-check.mjs';
import {preparePreviews,previewAsset,readCachedPreview} from './backup-previews.mjs';

const safeId=id=>typeof id==='string'&&/^\d{1,32}$/.test(id);
export class DefectRepair{
 constructor({store,backup,collector,queue,profile,runForeground,onChange=()=>{}}){
  Object.assign(this,{store,backup,collector,queue,profile,runForeground,onChange});this.file=path.join(profile,'defect-repair.sqlite');this.running=false;fs.mkdirSync(profile,{recursive:true});
  this.db=new DatabaseSync(this.file,{timeout:5000});this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS job(key TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS items(position INTEGER PRIMARY KEY,body TEXT NOT NULL);');
  try{const saved=this.db.prepare("SELECT body FROM job WHERE key='current'").get();this.job=saved?{...JSON.parse(saved.body),items:this.db.prepare('SELECT body FROM items ORDER BY position').all().map(r=>JSON.parse(r.body))}:null;if(this.job?.items.some(i=>!safeId(i.id)))this.job=null;}catch{this.job=null;}
  this.persistAll=true;
  if(this.job){for(const item of this.job.items)if(['waiting','running','failed'].includes(item.state)&&item.issues?.some(i=>i.kind==='cover')&&!backup.covers.problems.has(item.id))backup.covers.problems.set(item.id,{kind:'source',reason:item.message||'上次封面补齐未完成',time:new Date().toISOString()});backup.covers.saveProblems();}
  if(this.job?.phase==='running'){this.job.phase='paused';this.job.message='上次补齐未正常结束，已保留结果，可继续';for(const item of this.job.items)if(item.state==='running')item.state='waiting';this.persist();}
 }
 persist(){if(!this.job)return;const {items,...body}=this.job;this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare("INSERT OR REPLACE INTO job VALUES('current',?)").run(JSON.stringify(body));const put=this.db.prepare('INSERT OR REPLACE INTO items VALUES(?,?)');if(this.persistAll){this.db.exec('DELETE FROM items');items.forEach((item,index)=>put.run(index,JSON.stringify(item)));}else if(this.currentIndex!==undefined)put.run(this.currentIndex,JSON.stringify(items[this.currentIndex]));this.db.exec('COMMIT');this.persistAll=false;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 close(){this.db.close();}
 emit(){try{this.persist();}catch(error){this.controller?.abort();this.job.phase='paused';this.job.message='补齐进度保存失败：'+error.message;}this.onChange();}
 state(){if(!this.job)return null;const {accountKey,...job}=this.job,position=this.currentIndex??Math.max(0,job.items.length-1);return {...job,items:job.items.slice(Math.max(0,position-19),position+1),running:this.running,total:job.items.length,processed:job.items.filter(i=>['done','queued','failed','skipped'].includes(i.state)).length,failed:job.items.filter(i=>i.state==='failed').length,done:job.items.filter(i=>i.state==='done').length,queued:job.items.filter(i=>i.state==='queued').length};}
 inspect(id,work=this.store.work(id)){
  if(!work||(work.readHidden&&!this.store.download(id)))return null;
  const issues=[],problem=this.backup.covers.problems?.get(id),asset=previewAsset(this.store,work);
  if(problem)issues.push({kind:'cover',label:'封面异常',reason:problem.reason});
  else if(!asset&&(!work.thumbnail||(!this.backup.meta.dirty&&this.backup.meta.baseRevision!==null)))issues.push({kind:'cover',label:'封面待补',reason:work.thumbnail?'封面尚未成功备份':'缺少封面地址'});
  const download=this.store.download(id),failed=this.queue.jobs.find(j=>j.id===id&&j.state==='failed');
  if(download||failed){const files=inspectWorkFiles(this.store,id);if(files.status==='missing')issues.push({kind:'files',label:'文件缺失或异常',reason:files.missing.map(m=>`${m.label}：${m.reason}`).join('；')});else if(files.status==='error')issues.push({kind:files.error.includes('缺少原始图片数量')?'metadata':'blocked',label:files.error.includes('缺少原始图片数量')?'作品信息不完整':'暂时无法检查文件',reason:files.error});}
  return issues.length?{id,name:work.name,author:work.author?.nickname||'',url:work.url,issues}:null;
 }
 async scan(){const items=[],ids=this.store.rows('SELECT id FROM works');for(let index=0;index<ids.length;index++){const item=this.inspect(ids[index].id);if(item)items.push(item);if(index%100===99)await yieldLoop();}return {items,checked:ids.length,covers:items.filter(i=>i.issues.some(v=>v.kind==='cover')).length,files:items.filter(i=>i.issues.some(v=>v.kind==='files')).length,blocked:items.filter(i=>i.issues.some(v=>v.kind==='blocked')).length};}
 start(ids,{resume=false}={}){
  if(this.running)throw new Error('已有补齐任务正在运行');
  if(resume){if(!this.job||this.job.accountKey!==this.store.getSetting('browserAccountKey'))throw new Error('没有可继续的同账号补齐任务');for(const item of this.job.items){item.queueFiles=false;if(item.state==='failed')item.state='waiting';}}
  else {if(!Array.isArray(ids)||!ids.length||ids.length>100000||ids.some(id=>!safeId(id)))throw new Error('请选择有效的问题作品');this.job={id:randomUUID(),accountKey:this.store.getSetting('browserAccountKey'),phase:'running',message:'正在准备定向补齐',items:[...new Set(ids)].map(id=>({id,name:this.store.work(id)?.name||id,issues:this.inspect(id)?.issues||[],state:'waiting',message:''}))};for(const item of this.job.items){const cover=item.issues.find(i=>i.kind==='cover');if(cover&&!this.backup.covers.problems.has(item.id))this.backup.covers.problems.set(item.id,{reason:cover.reason,kind:'source',time:new Date().toISOString()});}this.backup.covers.saveProblems();}
  this.controller=new AbortController();this.running=true;this.persistAll=true;this.currentIndex=0;this.job.phase='running';this.emit();
  this.promise=this.runForeground(()=>this.execute(this.controller.signal)).then(()=>{const planned=this.job.items.filter(i=>i.queueFiles);if(this.job.phase==='done'&&this.backup.status.writable){if(planned.length)this.queue.enqueue(planned.map(i=>i.id));}else for(const item of planned){item.state='waiting';item.queueFiles=false;item.message='文件补齐尚未启动，恢复连接后可继续';this.job.phase='paused';this.persistAll=true;}}).catch(error=>{this.job.phase='paused';this.job.message=error.message;}).finally(()=>{this.running=false;this.controller=null;for(const item of this.job.items)if(item.state==='running')item.state='waiting';this.emit();});
  return this.state();
 }
 stop(){if(this.job?.phase!=='running')return;this.controller?.abort();this.collector.cancelResolve('补齐已停止');}
 async wait(){await this.promise;}
 async repairCover(id,signal){
  let work=this.store.work(id);const asset=previewAsset(this.store,work);
  if(asset){const file=await this.backup.covers.get(id);if(!file)throw new Error('暂时无法取回 NAS 封面，请检查连接后重试');return '已取回并校验封面';}
  if(await readCachedPreview(path.join(this.profile,'covers',id+'.jpg'),signal)){this.backup.covers.clearProblem(id);return '本机封面已可用，空闲后补备份';}
  signal.throwIfAborted();await this.collector.resolveWork(id);signal.throwIfAborted();work=this.store.work(id);
  const entries=[{table:'works',key:id,body:work}],files=[];const failures=await preparePreviews(this.backup,entries,files,signal);
  if(failures||!files.length)throw new Error(this.backup.covers.problems?.get(id)?.reason||'刷新作品后仍未取得封面，可能是图片地址失效或作品受限');
  const target=path.join(this.profile,'covers',id+'.jpg'),temporary=target+'.'+randomUUID()+'.tmp';
  try{await fsp.copyFile(files[0].file,temporary);signal.throwIfAborted();await fsp.rename(temporary,target);}finally{await fsp.rm(temporary,{force:true});}
  this.backup.covers.clearProblem(id);return '已取得封面，空闲后备份到 NAS';
 }
 async execute(signal){
  let stopped=false;
  for(const item of this.job.items){if(item.state!=='waiting')continue;
   this.currentIndex=this.job.items.indexOf(item);
   if(signal.aborted){stopped=true;break;}
   if(this.job.accountKey!==this.store.getSetting('browserAccountKey'))throw new Error('账号发生变化，已停止补齐');
   item.state='running';item.queueFiles=false;this.job.message='正在补齐：'+item.name;this.emit();
   try{
    const defect=this.inspect(item.id);if(!defect){item.state='skipped';item.message='已正常或已移除，未重新下载';continue;}
    const messages=[],failures=[];let queued=false;
    if(defect.issues.some(v=>v.kind==='metadata')){await this.collector.resolveWork(item.id);signal.throwIfAborted();messages.push('已刷新这一条作品信息');}
    if(defect.issues.some(v=>v.kind==='cover'))try{messages.push(await this.repairCover(item.id,signal));}catch(error){if(signal.aborted)throw error;failures.push(error.message);}
    signal.throwIfAborted();
    if(defect.issues.some(v=>['files','metadata'].includes(v.kind))){const files=inspectWorkFiles(this.store,item.id);if(files.status==='missing'){queued=true;messages.push('交给下载管理，仅补缺失文件');}else if(files.status==='error')failures.push(files.error);}
    if(defect.issues.some(v=>v.kind==='blocked'))failures.push('目录暂时不可访问，未尝试下载');
    item.queueFiles=queued;item.state=failures.length?'failed':queued?'queued':'done';item.message=[...messages,...failures].join('；');
   }catch(error){if(signal.aborted){item.state='waiting';item.message='已停止，未完成部分可继续';stopped=true;break;}item.state='failed';item.message=error.message;}
   finally{this.emit();}
   if(Number(this.store.getSetting('accessHoldUntil')||0)>Date.now()||this.store.getSetting('authNeedsRefresh')){stopped=true;this.job.message='平台需要验证或已限制访问，剩余作品保留，请完成验证后继续';break;}
  }
  this.job.phase=stopped?'paused':'done';if(!stopped||signal.aborted)this.job.message=stopped?'补齐已停止，已完成内容保留':'本次补齐结束；仍失败的作品可以单独重试';
 }
}
