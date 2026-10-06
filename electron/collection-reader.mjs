import {TOTAL} from './model.mjs';
import {pageResult} from './api-pagination.mjs';

// Quick reads end on ordered overlap or an explicit last page, never a new-item quota.
export async function readCollection(collector,{collectionId=TOTAL,mode='quick',resume=false,allowFullScan=false}={}){
  const c=collector,store=c.store,reads=store.collectionReads,epoch=c.cancelEpoch;
  reads.key(collectionId,mode);
  if(c.busy||c.waiters.size)throw Error('已有读取任务正在进行');
  const collection=store.collection(collectionId);
  if(!collection?.added||collection.remoteMissing)throw Error('请先添加有效的收藏夹');
  await c.ready;
  try{c.assertNotCoolingDown();if(!(await c.isAuthenticated())){c.update('attention','请先连接原抖音账号，再读取收藏');return;}}catch(e){c.update('attention',e.message);return;}
  if(epoch!==c.cancelEpoch){c.update('idle','已取消读取，原资料保留');return;}
  reads.importLegacy(collectionId);
  const hasAnchor=resume?reads.get(collectionId,'quick')?.baselineKnown:!!reads.baseline(collectionId);
  if(mode==='quick'&&!hasAnchor&&allowFullScan!==true)throw Error('没有可靠的历史对照，可能读取到列表末尾，请先确认继续');
  c.busy=true;c.cancelled=false;c.stopRequested=false;c.syncController=new AbortController();
  const signal=c.syncController.signal;
  c.status.readProgress={mode,name:collection.name,goal:null,checked:0,added:0,restored:0,startedAt:Date.now(),stage:'preparing'};c.notify();
  let run,failure='',saveFailed=false;
  try{
    run=reads.start(collectionId,mode,{resume});
    for(let page=0;mode==='quick'||page<10000;page++){
      signal.throwIfAborted();if(c.cancelled)break;
      c.update('syncing',`${mode==='quick'?'正在检查新增':'正在完整核对'}「${collection.name}」`,run.count);
      c.readProgress({stage:'reading',checked:run.count,added:run.added,restored:run.restored});
      const cursor=run.nextCursor;
      if(cursor===null||reads.seen(run,cursor))throw Error('保存的分页位置无法继续，请从头核对');
      const data=collectionId===TOTAL?await c.request('/aweme/v1/web/aweme/listcollection/',{method:'POST',form:{cursor,count:'30'},signal}):await c.request('/aweme/v1/web/collects/video/list/',{params:{collects_id:collectionId,cursor,count:30},signal});
      signal.throwIfAborted();if(c.cancelled)break;
      const result=pageResult(data,'aweme_list');
      const body=data?.data&&typeof data.data==='object'?data.data:data,flag=body.has_more??data.has_more;
      result.unknown=![0,1,false,true].includes(flag);
      reads.apply(run,result,{signal});
      c.readProgress({checked:run.count,added:run.added,restored:run.restored});
      if(run.status!=='running')break;
      await c.delay();signal.throwIfAborted();
    }
    if(run.status==='running')reads.finish(run,c.cancelled?'paused':'limit',c.cancelled?'':'本次请求已达上限，进度保留，请手动继续');
  }catch(e){failure=c.cancelled?(c.stopRequested?'':c.status.message):e.message;if(!c.cancelled)c.update('attention',failure);}
  finally{
    c.readProgress({stage:'saving'});
    try{
      if(run?.status==='running')reads.finish(run,c.stopRequested?'paused':'error',failure);
      if(run){const errors=store.reconcile();if(errors.length)failure=errors.join('；');}
      if(run)c.update(!failure&&['matched','end'].includes(run.outcome)?'done':c.stopRequested?'idle':'attention',failure||`${run.reason} · 已检查 ${run.count} 条，新增收藏 ${run.added} 条${run.restored?`，恢复记录 ${run.restored} 条`:''}`,run.count);
    }catch(error){saveFailed=true;c.onDiagnostic({event:'read-save-failed',name:error.name,code:error.code,reason:error.message,count:run?.count});c.update('attention',`读取已停止，收尾进度保存失败：${error.message}；已提交的页面仍保留`);}
    c.busy=false;c.syncController=null;c.readProgress({stage:'finished',finishedAt:Date.now(),stopped:c.cancelled,saveFailed});c.scheduleBrowserIdle();c.notify();
  }
}
