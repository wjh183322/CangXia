import fs from 'node:fs';
import path from 'node:path';
import {setImmediate as yieldToUI} from 'node:timers/promises';

// Only confirmed local folders are touched. A restart never resumes destructive work.
export class LocalRemoval {
 constructor({store,trash,before=async()=>{},after=()=>{},notify=()=>{}}){
  Object.assign(this,{store,trash,before,after,notify});this.running=false;
  this.progress=store.getSetting('localRemoval')||null;
  if(this.progress?.running){this.progress={...this.progress,running:false,phase:'interrupted',message:'上次删除被中断，未继续删除。已移走的文件会在启动检查时更新状态。'};this.persist();}
 }
 state(){return this.progress;}
 persist(){this.store.setSetting('localRemoval',this.progress);this.notify();}
 start(ids){
  if(this.running)throw Error('已有删除任务正在进行');
  const selected=[...new Set(ids)];this.running=true;this.cancelled=false;
  this.progress={running:true,phase:'preparing',total:selected.length,processed:0,deleted:0,failed:0,current:'',message:'正在停止后台备份…'};this.persist();
  this.task=this.run(selected);return this.state();
 }
 cancel(){if(this.running){this.cancelled=true;this.progress.phase='stopping';this.progress.message='正在停止，等待当前作品移入回收站后不再删除后续作品';this.persist();}return this.state();}
 async wait(){await this.task;}
 async run(ids){
  try{
   await this.before();
   for(const id of ids){
    if(this.cancelled)break;
    const record=this.store.download(id);
    this.progress.current=this.store.work(id)?.name||id;this.progress.phase='deleting';this.progress.message='正在移入系统回收站';this.persist();
    try{
     if(record){this.store.assertDirectory(record.path);await fs.promises.stat(path.parse(path.resolve(this.store.root)).root);let stat;try{stat=await fs.promises.lstat(record.path);}catch(e){if(e.code!=='ENOENT')throw e;}if(stat){if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('作品路径不是普通文件夹');await this.trash(record.path);}this.store.forgetDownloads([id],{localOnly:true,pruneHistory:false});}
     this.progress.deleted++;
    }catch(error){this.progress.failed++;this.progress.lastError=error.message;}
    this.progress.processed++;this.persist();await yieldToUI();
   }
   this.progress.phase=this.cancelled?'cancelled':this.progress.failed?'partial':'complete';
   this.progress.message=this.cancelled?'已取消，未继续删除剩余作品':this.progress.failed?'部分作品未能删除，请检查失败原因':'本地文件删除完成';
  }catch(error){this.progress.phase='failed';this.progress.message=error.message;}
  finally{
   try{this.store.forgetDownloads([],{localOnly:true});}catch(error){this.progress.lastError=error.message;this.progress.phase='failed';this.progress.message='删除已停止，下载记录整理失败';}
   this.running=false;this.progress.running=false;this.progress.current='';this.persist();this.after();
  }
 }
}
