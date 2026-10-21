import {normalizeReadSummary} from '../shared/read-summary.mjs';
import {randomUUID} from 'node:crypto';
import {ReadHistoryBatches} from './read-history-batches.mjs';
const small=(v,n)=>String(v||'').slice(0,n);
export function mergeReadOrder(previous,returned){
 const present=new Set(returned),before=new Map();let pending=[];
 for(const id of previous){if(present.has(id)){if(pending.length)before.set(id,pending);pending=[];}else pending.push(id);}
 const result=[];for(const id of returned){if(before.has(id))for(const old of before.get(id))result.push(old);result.push(id);}for(const old of pending)result.push(old);return result;
}
export class ReadHistory{
 constructor(store){this.store=store;this.batches=new ReadHistoryBatches(this);}
 init(){const s=this.store;s.db.run(`CREATE TABLE IF NOT EXISTS read_history_runs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,started_at TEXT NOT NULL,body TEXT NOT NULL,bytes INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS read_history_order ON read_history_runs(started_at DESC,id DESC);
 CREATE TABLE IF NOT EXISTS read_history_items(session_id TEXT NOT NULL,work_id TEXT NOT NULL,position INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(session_id,work_id));
 CREATE INDEX IF NOT EXISTS read_history_item_order ON read_history_items(session_id,position,work_id);
 CREATE INDEX IF NOT EXISTS read_history_item_kind ON read_history_items(session_id,kind,position,work_id);
 CREATE TABLE IF NOT EXISTS read_history_meta(key TEXT PRIMARY KEY);`);
 this.batches.init();
 if(!s.rows("SELECT 1 FROM read_history_meta WHERE key='legacy-import'").length){s.db.run('BEGIN');try{for(const run of s.all('collection_read_runs'))this.write({...s.collectionReads.summary(run),legacy:true});for(const a of s.all('authors'))if(a.run){if(!a.run.token){a.run.token=randomUUID();s.authorSources.save(a);}this.write({...s.authorSources.summary(a),legacy:true});}s.db.run("INSERT INTO read_history_meta VALUES('legacy-import')");s.db.run('COMMIT');}catch(error){s.db.run('ROLLBACK');throw error;}}
 for(const a of s.all('authors'))if(a.run?.historyRecovered){this.write(s.authorSources.summary(a));delete a.run.historyRecovered;s.authorSources.save(a);}
 }
 write(summary){this.store.db.run('BEGIN');try{summary=this.batches.route(normalizeReadSummary(summary));const id=summary.token||randomUUID();this.batches.put({...summary,name:small(summary.name,256),reason:small(summary.reason,1024),message:small(summary.message,2048),token:id});this.store.db.run('INSERT OR REPLACE INTO read_history_owners VALUES(?,?)',[summary.readToken||id,id]);this.store.db.run('COMMIT');if(this.batches.recovering.get(summary.readToken)===id)this.batches.recovering.delete(summary.readToken);}catch(e){this.store.db.run('ROLLBACK');throw e;}}
 entry(run,w,kind,position){if(run.reference.has(w.id))kind='returned';const body=JSON.stringify({id:w.id,name:small(w.name,256),type:w.type,author:{nickname:small(w.author?.nickname,96),uniqueId:small(w.author?.uniqueId,80),uid:small(w.author?.uid,40),secUid:small(w.author?.secUid,240)},publishedAt:w.publishedAt||null,foundAt:new Date().toISOString(),position,kind,reappeared:run.reference.has(w.id),afterId:run.lastHistoricalId||null});this.store.db.run('INSERT OR IGNORE INTO read_history_items VALUES(?,?,?,?,?,?)',[this.batches.itemToken(run),w.id,position,kind,body,Buffer.byteLength(body)]);}
 runs({page=1,batch}={}){
  if(!Number.isInteger(page)||page<1)throw Error('日志页码无效');
  if(batch!==undefined&&(typeof batch!=='string'||batch.length>100||this.store.get('read_history_runs',batch)?.source!=='batch'))throw Error('批次日志已不存在');
  const from=batch===undefined?'read_history_runs r WHERE NOT EXISTS(SELECT 1 FROM read_history_children c WHERE c.run_id=r.id)':'read_history_runs r JOIN read_history_children c ON c.run_id=r.id WHERE c.batch_id=?',args=batch===undefined?[]:[batch];
  const total=this.store.rows('SELECT COUNT(*) n FROM '+from,args)[0].n,pages=Math.max(1,Math.ceil(total/50)),current=Math.min(page,pages),order=batch===undefined?'r.started_at DESC,r.id DESC':'c.position';
  return {items:this.store.rows('SELECT r.body FROM '+from+' ORDER BY '+order+' LIMIT 50 OFFSET ?',[...args,(current-1)*50]).map(r=>{const s=JSON.parse(r.body);return s.source==='batch'||s.hasReadSummary===false?s:normalizeReadSummary(s);}),total,page:current,pages,stats:this.stats()};
 }
 items(token,{page=1,kind='all'}={}){
  if(typeof token!=='string'||token.length>100||!Number.isInteger(page)||page<1||!['all','front','fill','returned'].includes(kind))throw Error('日志参数无效');
  if(!this.store.rows('SELECT 1 FROM read_history_runs WHERE id=?',[token]).length)throw Error('读取日志已不存在');
  const returning="(kind='returned' OR (kind='fill' AND json_extract(body,'$.reappeared')=1))";
  const extra={all:'',front:" AND kind='front'",fill:" AND kind='fill' AND COALESCE(json_extract(body,'$.reappeared'),0)=0",returned:' AND '+returning}[kind],clause='session_id=?'+extra,args=[token];
  const total=this.store.rows('SELECT COUNT(*) n FROM read_history_items WHERE '+clause,args)[0].n,pages=Math.max(1,Math.ceil(total/50)),current=Math.min(page,pages);
  return {items:this.store.rows('SELECT body FROM read_history_items WHERE '+clause+' ORDER BY position,work_id LIMIT 50 OFFSET ?',[...args,(current-1)*50]).map(r=>{const item=JSON.parse(r.body);return item.reappeared?{...item,kind:'returned'}:item;}),total,page:current,pages};
 }
 stats(){const runs=this.store.rows('SELECT COALESCE(SUM(bytes),0) bytes FROM read_history_runs')[0],items=this.store.rows('SELECT COUNT(*) n,COALESCE(SUM(bytes),0) bytes FROM read_history_items')[0],top=this.store.rows('SELECT COUNT(*) n FROM read_history_runs r WHERE NOT EXISTS(SELECT 1 FROM read_history_children c WHERE c.run_id=r.id)')[0];return {runs:top.n,items:items.n,bytes:runs.bytes+items.bytes};}
 clear(){this.store.db.run('BEGIN');try{this.store.db.run('DELETE FROM read_history_owners; DELETE FROM read_history_children; DELETE FROM read_history_items; DELETE FROM read_history_runs;');this.store.db.run('COMMIT');}catch(error){this.store.db.run('ROLLBACK');throw error;}return this.stats();}
}
