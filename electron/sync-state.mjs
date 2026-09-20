export class SyncState {
  constructor(store){this.store=store;}
  get(id){const row=this.store.rows('SELECT body FROM sync_runs WHERE collection_id=?',[id])[0];return row?JSON.parse(row.body):null;}
  write(run){const {ids,...body}=run;this.store.db.run('INSERT OR REPLACE INTO sync_runs VALUES(?,?)',[run.collectionId,JSON.stringify({...body,updatedAt:new Date().toISOString()})]);this.store.save();}
  ids(id){return this.store.rows('SELECT work_id FROM sync_items WHERE collection_id=? ORDER BY position',[id]).map(r=>r.work_id);}
  seen(id,cursor){return this.store.rows('SELECT 1 FROM sync_pages WHERE collection_id=? AND cursor=?',[id,cursor]).length>0;}
  start(id,{resume=false,readAll=false}={}){
    const accountKey=this.store.getSetting('browserAccountKey')||null,previous=this.get(id);
    if(resume){if(!previous||previous.status==='complete'||previous.nextCursor===null)throw new Error('没有可继续的读取进度');if(previous.accountKey!==accountKey)throw new Error('账号信息已变化，请重新开始读取，已有记录会保留');const run={...previous,status:'running',readAll,resumed:true,ids:new Set(this.ids(id))};this.write(run);return run;}
    this.store.db.run('BEGIN');try{
      if(previous&&previous.status!=='complete')this.publish(previous,false);
      this.store.db.run('DELETE FROM sync_items WHERE collection_id=?',[id]);this.store.db.run('DELETE FROM sync_pages WHERE collection_id=?',[id]);
      const run={collectionId:id,accountKey,readAll,nextCursor:'0',status:'running',count:0,added:0,pages:0,ids:new Set()};this.write(run);this.store.db.run('COMMIT');return run;
    }catch(e){this.store.db.run('ROLLBACK');throw e;}
  }
  applyPage(run,items,result,{maxNew=Infinity,signal}={}){
    const cursor=run.nextCursor;let consumed=0,added=0;const before={...run,ids:new Set(run.ids)};
    this.store.db.run('BEGIN');try{
      for(const raw of items){signal?.throwIfAborted();const id=String(raw.aweme_id||raw.awemeId||'');if(!/^\d+$/.test(id))throw new Error('作品结构无法识别，已保留原列表');const known=this.store.hasRead(id)||run.ids.has(id);this.store.upsertWork(raw);const work=this.store.work(id);if(work?.readHidden)this.store.put('works',id,{...work,readHidden:false});if(!run.ids.has(id)){this.store.db.run('INSERT INTO sync_items VALUES(?,?,?)',[run.collectionId,id,run.count]);run.ids.add(id);run.count++;}consumed++;if(!known){added++;run.added++;}if(added>=maxNew)break;}
      const entire=consumed===items.length;run.pages++;
      if(entire)this.store.db.run('INSERT OR IGNORE INTO sync_pages VALUES(?,?)',[run.collectionId,cursor]);
      run.nextCursor=entire?result.next:cursor;
      const complete=result.complete&&entire;const c=this.store.collection(run.collectionId);this.store.put('collections',c.id,{...c,loadedCount:run.count,count:Math.max(c.count||0,run.count),complete:false,syncedAt:new Date().toISOString()});
      this.write(run);if(complete)this.finish(run,true);this.store.db.run('COMMIT');return {added,complete,limited:added>=maxNew};
    }catch(e){this.store.db.run('ROLLBACK');Object.assign(run,before);this.store.invalidateViews();throw e;}
  }
  publish(run,complete){this.store.ingestMembers(run.collectionId,this.ids(run.collectionId),complete);}
  finish(run,complete,reason=''){
    this.store.db.run('BEGIN');try{this.publish(run,complete&&!run.resumed);run.status=complete?'complete':'paused';run.reason=reason;if(complete)run.nextCursor=null;this.write(run);if(complete){this.store.db.run('DELETE FROM sync_items WHERE collection_id=?',[run.collectionId]);this.store.db.run('DELETE FROM sync_pages WHERE collection_id=?',[run.collectionId]);}this.store.db.run('COMMIT');}catch(e){this.store.db.run('ROLLBACK');throw e;}
  }
  order(id,rows){const run=this.get(id);if(!run||run.status==='complete')return rows;const ids=this.ids(id),seen=new Set(ids);return [...ids.map((work_id,rank)=>({work_id,rank})),...rows.filter(r=>!seen.has(r.work_id))];}
  list(){const key=this.store.getSetting('browserAccountKey')||null;return this.store.rows('SELECT body FROM sync_runs').map(r=>JSON.parse(r.body)).filter(r=>r.status!=='complete').map(r=>({collectionId:r.collectionId,name:this.store.collection(r.collectionId)?.name||'收藏',count:r.count,pages:r.pages,updatedAt:r.updatedAt,status:r.status,reason:r.reason,canResume:r.nextCursor!==null&&r.accountKey===key}));}
  recover(){for(const {body}of this.store.rows('SELECT body FROM sync_runs')){const run=JSON.parse(body);if(run.status==='running')this.finish(run,false,'上次读取未正常结束，可以继续');}}
}
