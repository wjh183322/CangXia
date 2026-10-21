import {randomUUID} from 'node:crypto';
const small=(v,n)=>String(v||'').slice(0,n);

// Batches own immutable child log identities; resuming a checkpoint in a later
// batch must not rewrite the earlier batch's saved summary or difference items.
export class ReadHistoryBatches{
 constructor(history){this.history=history;this.store=history.store;this.recovering=new Map();}
 init(){
  this.store.db.run('CREATE TABLE IF NOT EXISTS read_history_children(batch_id TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE,position INTEGER NOT NULL,PRIMARY KEY(batch_id,run_id));CREATE INDEX IF NOT EXISTS read_history_child_order ON read_history_children(batch_id,position);CREATE INDEX IF NOT EXISTS read_history_read_token ON read_history_runs(json_extract(body,\'$.readToken\'));CREATE TABLE IF NOT EXISTS read_history_owners(read_token TEXT PRIMARY KEY,log_id TEXT NOT NULL);');
  // A startup can stop after updating the batch and before checkpoint recovery.
  // Reconstruct routing from durable child/checkpoint identities on every boot.
  for(const row of this.store.rows('SELECT r.body FROM read_history_owners o JOIN read_history_runs r ON r.id=o.log_id JOIN read_history_children c ON c.run_id=r.id')){
   const child=JSON.parse(row.body),run=child.readToken&&this.store.get('collection_read_runs',child.mode+':'+child.scope);
   if(run?.status==='running'&&run.token===child.readToken&&!this.recovering.has(run.token))this.recovering.set(run.token,child.token);
  }
  for(const row of this.store.rows("SELECT body FROM read_history_runs WHERE scope='__batch__' AND json_extract(body,'$.running')=1")){
   const parent=JSON.parse(row.body),children=this.children(parent.token);
   for(const child of children)if(child.batchState==='running'){
    if(child.readPhase==='done'&&child.status==='complete'&&!child.saveFailed)child.batchState='complete';
    else if(child.saveFailed||child.readPhase==='attention')child.batchState='failed';
    else if(child.status==='complete'){child.batchState='interrupted';child.batchMessage='读取内容已提交，收尾状态尚未确认';}
    else{child.batchState='paused';if(child.status!=='complete')child.status='paused';child.reason='上次读取中断，已保存内容保留';}
    this.put(child);
   }
   const counts=Object.fromEntries([['succeeded','complete'],['failed','failed'],['skipped','skipped'],['pending','waiting'],['paused','paused']].map(([key,value])=>[key,children.filter(c=>c.batchState===value).length]));
   counts.paused+=children.filter(c=>c.batchState==='interrupted').length;
   this.put({...parent,...counts,processed:counts.succeeded+counts.failed+counts.skipped,running:false,phase:'stopped',message:'上次批量读取中断，已有日志和各夹进度保留'});
  }
 }
 put(summary){const body=JSON.stringify(summary);this.store.db.run('INSERT OR REPLACE INTO read_history_runs VALUES(?,?,?,?,?)',[summary.token,summary.scope,summary.startedAt||new Date().toISOString(),body,Buffer.byteLength(body)]);}
 children(token){return this.store.rows('SELECT r.body FROM read_history_children c JOIN read_history_runs r ON r.id=c.run_id WHERE c.batch_id=? ORDER BY c.position',[token]).map(row=>JSON.parse(row.body));}
 begin(batch){batch.historyToken=randomUUID();this.active=batch;this.publish(batch);}
 publish(batch){
  if(!batch.historyToken)return;
  this.store.db.run('BEGIN');try{
   const parent={token:batch.historyToken,scope:'__batch__',source:'batch',name:batch.includeTotal?'总收藏与自建收藏夹':'批量读取自建收藏夹',includeTotal:batch.includeTotal,mode:batch.mode,startedAt:new Date(batch.startedAt).toISOString(),running:batch.running,phase:batch.phase,total:batch.total,processed:batch.processed,succeeded:batch.succeeded,failed:batch.failed,skipped:batch.skipped,pending:batch.pending,paused:batch.paused,message:batch.message||'批量读取进行中'};this.put(parent);
   batch.items.forEach((item,position)=>{
    const token=batch.historyToken+':'+item.id,prior=this.store.get('read_history_runs',token)||{},child={...prior,token,scope:item.id,batchId:batch.historyToken,batchState:item.state,name:small(item.name,256),mode:batch.mode,startedAt:prior.startedAt||parent.startedAt};
    if(!child.readToken)child.hasReadSummary=false;
    if(item.message)child.batchMessage=small(item.message,2048);
    this.put(child);this.store.db.run('INSERT OR IGNORE INTO read_history_children VALUES(?,?,?)',[batch.historyToken,token,position]);
   });this.store.db.run('COMMIT');
  }catch(e){this.store.db.run('ROLLBACK');throw e;}
 }
 end(batch){try{this.publish(batch);}finally{if(this.active===batch)this.active=null;}}
 route(summary){
  const batch=this.active,readToken=summary.token;
  const token=batch?.items.some(item=>item.id===summary.scope)?batch.historyToken+':'+summary.scope:this.recovering.get(readToken);
  if(!token)return summary;
  const old=this.store.get('read_history_runs',token)||{};
  if(old.readToken!==readToken){
   const prior=this.store.rows("SELECT id FROM read_history_runs WHERE id=? OR json_extract(body,'$.readToken')=? ORDER BY started_at DESC,id DESC LIMIT 1",[readToken,readToken])[0];
   if(prior&&prior.id!==token)this.store.db.run('INSERT OR IGNORE INTO read_history_items SELECT ?,work_id,position,kind,body,bytes FROM read_history_items WHERE session_id=?',[token,prior.id]);
  }
  return {...summary,token,readToken,batchId:old.batchId,batchState:old.batchState,hasReadSummary:true};
 }
 itemToken(run){return this.active?.items.some(item=>item.id===run.scope)?this.active.historyToken+':'+run.scope:run.token;}
}
