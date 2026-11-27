import {setImmediate as yieldTurn} from 'node:timers/promises';
import {failure} from './service-error.mjs';

export const admissionThreshold=64;
const changed=()=>failure(409,'STALE_SELECTION','作品或选择已更新，请重新确认。');
const scopeNames=['unsaved','missing','repair','audio','repair-cover'];

export function admitBatch(db,query,scope,{operationId,account,selection,auth}) {
  if(!scopeNames.includes(scope)||!Number.isSafeInteger(query.count)||query.count<1)throw changed();
  db.prepare("INSERT INTO download_batches VALUES(?,?,?,?,?,?,'pending',?)").run(
    operationId,account,scope,JSON.stringify(selection),JSON.stringify(auth),query.count,Date.now());
  // The catalogue predicate, version snapshot and normal operation receipt share one transaction.
  // Store compact IDs and version counters. Never copy 50,000 work JSON documents into a command.
  const inserted=db.prepare(`INSERT INTO download_batch_items(batch,work_id,version)
    SELECT ?,s.id,v.revision FROM (${query.sql}) s JOIN download_work_versions v ON v.work_id=s.id`)
    .run(operationId,...query.params).changes;
  if(inserted!==query.count)throw changed();
  db.exec('UPDATE download_options SET revision=revision+1');
  return {batchId:operationId,accepted:inserted,queued:0};
}

export function batchStatus(db,id,account) {
  const b=db.prepare('SELECT id,account,scope,total,state FROM download_batches WHERE id=?').get(id);
  if(!b||(account!==undefined&&account!==b.account))throw changed();
  const counts=Object.fromEntries(db.prepare('SELECT state,count(*) AS n FROM download_batch_items WHERE batch=? GROUP BY state')
    .all(id).map(row=>[row.state,row.n]));
  return {id:b.id,scope:b.scope,total:b.total,state:b.state,pending:counts.pending??0,queued:counts.queued??0,
    existing:counts.existing??0,skipped:counts.skipped??0,removed:counts.removed??0,changed:counts.changed??0,
    failed:counts.failed??0,cancelled:counts.cancelled??0};
}

export function batchList(db,audioOnly) {
  return db.prepare(`SELECT id FROM download_batches WHERE scope ${audioOnly?'=':'<>'} 'audio' ORDER BY rowid DESC LIMIT 10`)
    .all().map(b=>batchStatus(db,b.id));
}

export function batchPage(db,{id,page=1},owner) {
  const status=batchStatus(db,id,owner.who.accountId);
  if(!Number.isSafeInteger(page)||page<1)throw changed();
  const items=db.prepare(`SELECT work_id AS workId,state,reason FROM download_batch_items WHERE batch=?
    AND state IN ('failed','changed') ORDER BY rowid LIMIT 50 OFFSET ?`).all(id,(page-1)*50);
  return {...status,page,items};
}

export function controlBatches(db,action,ids=null,audioOnly=false) {
  if(!['pause','resume','cancel'].includes(action))return 0;
  const q=ids===null?
    db.prepare("SELECT id FROM download_batches WHERE state IN ('pending','paused')"+(audioOnly?" AND scope='audio'":"")).all():
    ids.filter(id=>id.startsWith('batch:')).map(id=>({id:id.slice(6)}));
  let count=0;
  for(const {id} of q){
    if(action==='cancel')count+=db.prepare("UPDATE download_batch_items SET state='cancelled' WHERE batch=? AND state='pending'").run(id).changes;
    db.prepare("UPDATE download_batches SET state=? WHERE id=? AND state IN ('pending','paused')").run(
      action==='pause'?'paused':action==='resume'?'pending':'cancelled',id);
  }
  if(q.length)db.exec('UPDATE download_options SET revision=revision+1');
  return count;
}

// No source/network/file operation occurs during admission. Dispatch yields the NAS event
// loop between bounded writes. A row and its ordinary job are committed or rolled back together.
export async function dispatchBatches(store,{enqueue,authorized,closed,wake}) {
  while(!closed()){
    await yieldTurn();
    if(closed())return;
    const batch=store.db.prepare(`SELECT * FROM download_batches WHERE state='pending'
      AND NOT (SELECT paused FROM download_options) ORDER BY rowid LIMIT 1`).get();
    if(!batch)return;
    const original=JSON.parse(batch.auth);
    store.withWrite(db=>{
      const set=db.prepare("UPDATE download_batch_items SET state=?,reason=? WHERE batch=? AND work_id=? AND state='pending'");
      const items=db.prepare(`SELECT i.work_id,i.version,v.revision FROM download_batch_items i
        LEFT JOIN download_work_versions v ON v.work_id=i.work_id
        WHERE i.batch=? AND i.state='pending' ORDER BY i.rowid LIMIT 16`).all(batch.id);
      for(const row of items){
        let state='changed',reason='作品、文件或已有任务的版本已变化，请重新选择。';
        if(row.version===row.revision && authorized(db,original)){
          db.exec('SAVEPOINT batch_item');
          try{
            const result=enqueue(db,[row.work_id],batch.scope);
            state=result.queued?'queued':result.existing?'existing':result.removed?'removed':'skipped';
            reason=null;
          }catch(error){
            db.exec('ROLLBACK TO batch_item');
            if(!error.status && !error.code?.startsWith('NAS_') && !error.code?.startsWith('SOURCE_'))throw error;
            state='failed';reason='来源、文件或任务未通过核对，请重新选择。';
          }finally{db.exec('RELEASE batch_item');}
        }else if(row.version===row.revision)reason='来源账号或登录版本已变更，请重新确认。';
        set.run(state,reason,batch.id,row.work_id);
      }
      if(!db.prepare("SELECT 1 FROM download_batch_items WHERE batch=? AND state='pending' LIMIT 1").get(batch.id))
        db.prepare("UPDATE download_batches SET state='finished' WHERE id=?").run(batch.id);
      db.exec('UPDATE download_options SET revision=revision+1');
    });
    wake();
  }
}
