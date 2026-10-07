export class NASRemoval {
 constructor({store,backup,notify=()=>{}}){Object.assign(this,{store,backup,notify});this.running=false;this.job=store.getSetting('nasRemovalJob');if(this.job?.running){this.job={...this.job,running:false,phase:'paused',message:'上次 NAS 操作被中断，请检查连接后继续；不会自动继续删除'};this.persist();}}
 state(){if(!this.job)return null;const {ids,...state}=this.job;return {...state,running:this.running,total:ids.length};}
 persist(){this.store.setSetting('nasRemovalJob',this.job);this.notify();}
 start(ids,action='delete',resume=false){
  if(this.running)throw Error('已有 NAS 操作正在进行');this.backup.assertWritable();if(!this.backup.status.backupDeletion)throw Error('NAS 服务需要更新至 0.2.1，现有 data 目录保留');
  if(resume){if(!this.job||this.job.libraryId!==this.backup.meta.libraryId||this.job.processed>=this.job.ids.length)throw Error('没有可继续的同一 NAS 操作');}
  else this.job={ids:[...new Set(ids)],libraryId:this.backup.meta.libraryId,action,processed:0,affected:0,freedBytes:0,pendingObjects:0};
  this.running=true;this.cancelled=false;this.job={...this.job,running:true,phase:'preparing',message:'正在停止后台备份…'};this.persist();this.promise=this.run();return this.state();
 }
 cancel(){if(this.running){this.cancelled=true;this.job.phase='stopping';this.job.message='当前批次完成后停止，已提交的删除无法撤销';this.persist();}return this.state();}
 async wait(){await this.promise;}
 async run(){
  try{
   this.backup.cancel();if(this.backup.syncing)await this.backup.syncing.catch(()=>{});if(this.backup.checking)await this.backup.checking.catch(()=>{});
   while(!this.cancelled&&this.job.processed<this.job.ids.length){
    const batch=this.job.ids.slice(this.job.processed,this.job.processed+100);this.job.phase='running';this.job.message=this.job.action==='delete'?'正在删除 NAS 备份并清理无引用文件':'正在重新启用 NAS 备份';this.persist();
    const result=await this.backup.backupAction(this.job.action,batch);this.job.processed+=batch.length;this.job.affected+=result.count;this.job.freedBytes+=result.cleanup?.freedBytes||0;this.job.pendingObjects=result.cleanup?.pendingObjects||0;this.persist();
   }
   this.job.phase=this.cancelled?'paused':'complete';this.job.message=this.cancelled?'已停止，后续批次保留':this.job.action==='delete'?'所选 NAS 备份已删除，本地文件和作品资料保留':'已重新启用，空闲时备份本机媒体';
  }catch(error){this.job.phase='paused';this.job.message=error.message;}
  finally{this.running=false;this.job.running=false;this.persist();this.backup.deferSync();}
 }
}
