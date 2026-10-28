const durable=j=>Object.fromEntries(['id','title','state','progress','message','coverOnly','source','catalogueLibrary','cancelOwnership','admission'].filter(k=>j[k]!==undefined).map(k=>[k,j[k]]));
const publicJob=j=>({...Object.fromEntries(['id','title','state','progress','message','phase','coverOnly','source','activeSource'].filter(k=>j[k]!==undefined).map(k=>[k,j[k]])),...(j.admission?.held?{preparationId:j.admission.operationId,held:true}:{})});
const dedupe=jobs=>{const map=new Map(),priority={running:4,waiting:3,unavailable:3,failed:2,complete:1};for(const job of jobs){const old=map.get(job.id);if(!old||(priority[job.state]||0)>=(priority[old.state]||0))map.set(job.id,job);}return [...map.values()];};
export class DownloadTasks{
 constructor(store){this.store=store;this.byId=new Map();this.buckets=new Map();this.dirty=new Set();this.removed=new Set();this.ranks=new Map();this.serialized=new Map();this.jobs=[];this.revision=0;this.maxRank=0;}
 init(){
  const s=this.store;s.db.run(`CREATE TABLE IF NOT EXISTS download_tasks(id TEXT PRIMARY KEY,state TEXT NOT NULL,rank INTEGER NOT NULL,body TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS download_tasks_state ON download_tasks(state,rank,id);
   CREATE INDEX IF NOT EXISTS download_tasks_admission ON download_tasks(json_extract(body,'$.admission.operationId'),json_extract(body,'$.admission.held'));
   CREATE TABLE IF NOT EXISTS download_preparation_counts(operation_id TEXT PRIMARY KEY,held INTEGER NOT NULL);
   CREATE TRIGGER IF NOT EXISTS preparation_count_insert AFTER INSERT ON download_tasks WHEN json_extract(NEW.body,'$.admission.held')=1 BEGIN INSERT INTO download_preparation_counts VALUES(json_extract(NEW.body,'$.admission.operationId'),1) ON CONFLICT(operation_id) DO UPDATE SET held=held+1; END;
   CREATE TRIGGER IF NOT EXISTS preparation_count_delete AFTER DELETE ON download_tasks WHEN json_extract(OLD.body,'$.admission.held')=1 BEGIN UPDATE download_preparation_counts SET held=held-1 WHERE operation_id=json_extract(OLD.body,'$.admission.operationId'); END;
   CREATE TRIGGER IF NOT EXISTS preparation_count_update AFTER UPDATE ON download_tasks WHEN json_extract(OLD.body,'$.admission.held') IS NOT json_extract(NEW.body,'$.admission.held') OR json_extract(OLD.body,'$.admission.operationId') IS NOT json_extract(NEW.body,'$.admission.operationId') BEGIN UPDATE download_preparation_counts SET held=held-1 WHERE json_extract(OLD.body,'$.admission.held')=1 AND operation_id=json_extract(OLD.body,'$.admission.operationId'); INSERT INTO download_preparation_counts SELECT json_extract(NEW.body,'$.admission.operationId'),1 WHERE json_extract(NEW.body,'$.admission.held')=1 ON CONFLICT(operation_id) DO UPDATE SET held=held+1; END;
   CREATE TABLE IF NOT EXISTS local_migrations(key TEXT PRIMARY KEY);`);
  if(!s.rows('SELECT 1 FROM local_migrations WHERE key=?',['download-tasks']).length){
   const legacy=s.rows('SELECT value FROM settings WHERE key=?',['downloadJobs'])[0];const jobs=dedupe(legacy?JSON.parse(legacy.value):[]);
   s.db.run('BEGIN');try{jobs.forEach((j,rank)=>s.db.run('INSERT OR REPLACE INTO download_tasks VALUES(?,?,?,?)',[j.id,j.state||'waiting',rank,JSON.stringify(durable(j))]));s.db.run('INSERT INTO local_migrations VALUES(?)',['download-tasks']);s.db.run('COMMIT');}catch(e){s.db.run('ROLLBACK');throw e;}
  }
  if(!s.rows("SELECT 1 FROM local_migrations WHERE key='preparation-counts'").length){s.db.run('BEGIN');try{s.db.run("DELETE FROM download_preparation_counts;INSERT INTO download_preparation_counts SELECT json_extract(body,'$.admission.operationId'),COUNT(*) FROM download_tasks WHERE json_extract(body,'$.admission.held')=1 GROUP BY json_extract(body,'$.admission.operationId');INSERT INTO local_migrations VALUES('preparation-counts')");s.db.run('COMMIT');}catch(error){s.db.run('ROLLBACK');throw error;}}
  const rows=s.rows('SELECT id,rank,body FROM download_tasks ORDER BY rank,id');this.present=!!rows.length||!!s.rows('SELECT 1 FROM settings WHERE key=?',['downloadJobs']).length||!!s.rows('SELECT 1 FROM local_migrations WHERE key=?',['download-tasks-present']).length;
  for(const row of rows){const job=JSON.parse(row.body);this.ranks.set(row.id,row.rank);this.serialized.set(row.id,JSON.stringify(durable(job)));this.maxRank=Math.max(this.maxRank,row.rank);const proxy=this.wrap(job);this.byId.set(job.id,proxy);this.jobs.push(proxy);this.bucket(job.state).add(job.id);}
 }
 bucket(state){if(!this.buckets.has(state))this.buckets.set(state,new Set());return this.buckets.get(state);}
 wrap(job){const repo=this;return new Proxy({...job},{set(target,key,value){if(target[key]===value)return true;if(key==='id'&&value!==target.id)throw Error('下载任务标识不能改变');if(key==='state'){repo.bucket(target.state).delete(target.id);repo.bucket(value).add(target.id);}target[key]=value;repo.dirty.add(target.id);repo.revision++;return true;}});}
 replace(jobs){
  if(!this.present){this.present=true;this.needsPresence=true;}
  const before=this.byId,next=new Map(),list=[];this.buckets.clear();let previous=-1;
  for(const raw of dedupe(jobs)){const old=before.get(raw.id),job=raw===old?old:this.wrap(raw);let rank=this.ranks.get(raw.id);if(rank===undefined||rank<=previous)rank=++this.maxRank;if(this.ranks.get(raw.id)!==rank||job!==old)this.dirty.add(raw.id);this.ranks.set(raw.id,rank);previous=rank;next.set(raw.id,job);list.push(job);this.bucket(job.state).add(job.id);this.removed.delete(job.id);}
  for(const id of before.keys())if(!next.has(id)){this.removed.add(id);this.dirty.delete(id);this.ranks.delete(id);}
  this.byId=next;this.jobs=list;this.revision++;
 }
 upsertMany(jobs){if(!this.present){this.present=true;this.needsPresence=true;}for(const raw of jobs){let job=this.byId.get(raw.id);if(job)Object.assign(job,raw);else{job=this.wrap(raw);this.byId.set(job.id,job);this.jobs.push(job);this.ranks.set(job.id,++this.maxRank);this.bucket(job.state).add(job.id);}this.dirty.add(job.id);this.removed.delete(job.id);}this.revision++;}
 removeMany(ids){const removed=new Set(ids);for(const id of removed){const job=this.byId.get(id);if(!job)continue;this.bucket(job.state).delete(id);this.byId.delete(id);this.ranks.delete(id);this.dirty.delete(id);this.removed.add(id);}this.jobs=this.jobs.filter(j=>!removed.has(j.id));this.revision++;}
 flush({ids}={}){
  const wanted=ids?new Set(ids):null,dirty=[...this.dirty].filter(id=>!wanted||wanted.has(id)),removed=[...this.removed].filter(id=>!wanted||wanted.has(id));
  if(!dirty.length&&!removed.length&&!this.needsPresence)return;
  const s=this.store;s.db.run('BEGIN');try{
   if(this.needsPresence)s.db.run('INSERT OR IGNORE INTO local_migrations VALUES(?)',['download-tasks-present']);
   for(const id of removed)s.db.run('DELETE FROM download_tasks WHERE id=?',[id]);
   for(const id of dirty){const job=this.byId.get(id);if(!job)continue;const body=JSON.stringify(durable(job));s.db.run('INSERT INTO download_tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,rank=excluded.rank,body=excluded.body',[id,job.state||'waiting',this.ranks.get(id),body]);this.serialized.set(id,body);}
   s.db.run('COMMIT');for(const id of removed){this.serialized.delete(id);this.removed.delete(id);}for(const id of dirty)this.dirty.delete(id);this.needsPresence=false;
  }catch(e){s.db.run('ROLLBACK');throw e;}
 }
 list(){return this.jobs.map(j=>durable(j));}
 counts(){return Object.fromEntries([...this.buckets].map(([state,ids])=>[state,ids.size]));}
 heldCount(operationId){return this.store.rows('SELECT held FROM download_preparation_counts WHERE operation_id=?',[operationId])[0]?.held||0;}
 validateSelection({tab,ids}){if(!['active','failed','unavailable','complete'].includes(tab)||!Array.isArray(ids)||ids.length>100000||ids.some(id=>typeof id!=='string'||!/^\d+$/.test(id)))throw Error('下载选择无效');const selected=[...new Set(ids)],valid=selected.filter(id=>{const state=this.byId.get(id)?.state;return tab==='active'?['waiting','running'].includes(state):state===(tab==='complete'?'complete':tab);});return {ids:valid,invalid:selected.length-valid.length};}
 page({tab='active',page=1,pageSize=50}={}){
  if(!['active','failed','complete','unavailable'].includes(tab)||!Number.isInteger(page)||page<1||pageSize!==50)throw Error('下载任务分页参数无效');
  const order=ids=>[...ids].sort((a,b)=>this.ranks.get(a)-this.ranks.get(b));
  const ids=tab==='active'?[...order(this.bucket('running')),...order(this.bucket('waiting'))]:order(this.bucket(tab==='unavailable'?'unavailable':tab==='failed'?'failed':'complete'));
  const current=Math.min(page,Math.max(1,Math.ceil(ids.length/pageSize)));return {revision:this.revision,total:ids.length,page:current,pageSize,jobs:ids.slice((current-1)*pageSize,current*pageSize).map(id=>publicJob(this.byId.get(id)))};
 }
}
