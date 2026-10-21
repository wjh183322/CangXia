import {TOTAL} from './model.mjs';
import {readCollection} from './collection-reader.mjs';

// One foreground read owns the whole batch; each folder keeps its existing run/log.
export async function readAddedCollections(c,{mode='quick',allowFullScan=false}={}){
 if(!['quick','full'].includes(mode))throw Error('批量读取方式无效');
 if(c.batchReading||c.busy||c.waiters.size)throw Error('已有读取任务正在进行');
 const epoch=c.cancelEpoch;await c.ready;
 if(epoch!==c.cancelEpoch)throw Error('已停止，未开始批量读取');
 if(c.batchReading||c.busy||c.waiters.size)throw Error('已有读取任务正在进行');
 const folders=c.store.all('collections').filter(folder=>folder.added&&folder.id!==TOTAL).sort((a,b)=>(a.rank||0)-(b.rank||0));
 if(!folders.length)throw Error('尚未添加自建收藏夹');
 for(const folder of folders)if(!folder.remoteMissing)c.store.collectionReads.importLegacy(folder.id);
 if(mode==='quick'&&allowFullScan!==true&&folders.some(folder=>!folder.remoteMissing&&!c.store.collectionReads.baseline(folder.id)))throw Error('部分收藏夹没有可靠的历史对照，可能需要读到列表末尾，请先统一确认');
 const account=c.store.getSetting('browserAccountKey');
 const batch={running:true,phase:'running',mode,total:folders.length,processed:0,succeeded:0,failed:0,skipped:0,pending:folders.length,paused:0,checked:0,added:0,startedAt:Date.now(),currentId:null,currentName:'',items:folders.map(folder=>({id:folder.id,name:folder.name,state:'waiting',message:''}))};
 c.batchReading=true;c.cancelled=false;c.stopRequested=false;c.status.readSummary=null;c.status.collectionBatch=batch;
 c.status.readProgress={mode,name:'全部自建收藏夹',checked:0,added:0,stage:'preparing',startedAt:batch.startedAt};
 const changedAccount=()=>c.store.getSetting('browserAccountKey')!==account;
 const interrupted=()=>epoch!==c.cancelEpoch||c.cancelled||c.status.needsLogin||changedAccount()||Number(c.store.getSetting('accessHoldUntil')||0)>Date.now();
 const publish=()=>{for(const [field,state]of [['succeeded','complete'],['failed','failed'],['skipped','skipped'],['pending','waiting'],['paused','paused']])batch[field]=batch.items.filter(item=>item.state===state).length;batch.processed=batch.succeeded+batch.failed+batch.skipped;batch.checked=batch.items.reduce((sum,item)=>sum+(item.summary?.checked||0),0);batch.added=batch.items.reduce((sum,item)=>sum+(item.summary?.added||0),0);c.notify();};
 try{
  c.notify();
  for(const item of batch.items){
   if(interrupted())break;
   const folder=c.store.collection(item.id);
   if(!folder?.added||folder.remoteMissing){item.state='skipped';item.message='收藏夹已不在当前可读取目录中，已有记录保留';publish();continue;}
   batch.currentId=item.id;batch.currentName=item.name;item.state='running';c.status.readSummary=null;publish();
   if(interrupted()){item.state='waiting';publish();break;}
   try{
    await readCollection(c,{collectionId:item.id,mode,allowFullScan});
    const summary=c.status.readSummary;
    if(summary?.scope===item.id){item.summary={...summary};item.message=summary.message||summary.reason||c.status.message;item.state=summary.status==='complete'&&!summary.saveFailed&&c.status.phase==='done'?'complete':c.stopRequested?'paused':'failed';}
    else{item.state=c.stopRequested?'paused':'failed';item.message=c.status.message||'未取得本夹读取结果';}
   }catch(error){item.state=c.stopRequested?'paused':'failed';item.message=error.message||'本夹读取失败';}
   publish();
   if(interrupted()||item.summary?.saveFailed)break;
   if(batch.items.some(next=>next.state==='waiting'))await c.delay();
  }
  batch.phase=interrupted()||batch.items.some(item=>item.state==='waiting'||item.state==='paused')?'stopped':batch.failed?'partial':'done';
  batch.message=changedAccount()?'账号已变化，批量同步已停止，已有内容保留':c.status.needsLogin?'需要重新登录，批量同步已停止，已有内容保留':Number(c.store.getSetting('accessHoldUntil')||0)>Date.now()?'平台限制访问频率，批量同步已停止，已有内容保留':batch.phase==='stopped'?'批量同步已停止，已读取内容和各夹进度保留':'批量同步结束，各收藏夹读取日志已保留';
  return batch;
 }catch(error){batch.phase='stopped';batch.message='批量同步已停止：'+(error.message||'未完成，已有内容保留');return batch;}
 finally{
  for(const item of batch.items)if(item.state==='running')item.state='paused';
  batch.running=false;batch.finishedAt=Date.now();c.batchReading=false;publish();
  c.update(batch.phase==='done'?'done':batch.phase==='stopped'?'idle':'attention',batch.message||'批量同步未完成，已有内容保留');
 }
}
