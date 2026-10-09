import {Worker} from 'node:worker_threads';import {createHash} from 'node:crypto';import fs from 'node:fs/promises';import path from 'node:path';import {requireInside} from './model.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export class FileStates{
 constructor(store){this.store=store;this.cache=new Map();this.pending=new Set();this.sequence=0;this.waiters=new Map();this.queued=[];this.generation=0;}
 init(){this.store.db.run('CREATE TABLE IF NOT EXISTS file_states(id TEXT PRIMARY KEY,body TEXT NOT NULL)');for(const row of this.store.rows('SELECT id,body FROM file_states'))this.cache.set(row.id,JSON.parse(row.body));}
 get(id){return this.cache.get(id);}
 async confirmWritten(id){
  const store=this.store,row=store.rows('SELECT body FROM downloads WHERE id=?',[id])[0];if(!row)return false;const d=JSON.parse(row.body);if(d.state!=='complete'||!d.assets?.length)return false;
  // Called only after a successful downloader/verified NAS restore, never for UI guesses.
  const assets={};for(const a of d.assets){const file=requireInside(d.path,path.join(d.path,a.file)),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0||a.size&&a.size!==stat.size)return false;assets[a.key]={exists:true,state:'available',stamp:[stat.size,stat.mtimeMs,stat.ctimeMs]};}
  if(store.rows('SELECT body FROM downloads WHERE id=?',[id])[0]?.body!==row.body)return false;
  const result={id,signature:hash(row.body),root:store.root,status:'complete',local:d.assets.some(a=>a.kind!=='metadata'),bytes:d.assets.reduce((n,a)=>n+(a.size||0),0),assets,checkedAt:Date.now()};
  store.db.run('INSERT OR REPLACE INTO file_states VALUES(?,?)',[id,JSON.stringify(result)]);this.cache.set(id,result);store.viewCache.delete(id);store.lightViews?.invalidateFiles(id);store.revision++;this.generation++;this.onChange?.();
  return true;
 }
 invalidate(id){this.cache.delete(id);this.pending.add(id);this.store.viewCache.delete(id);this.store.lightViews?.invalidateFiles(id);if(this.onChange)this.schedule();}
 schedule(){if(this.closed||this.timer)return;this.timer=setTimeout(()=>{this.timer=null;const ids=[...this.pending];this.pending.clear();if(ids.length)void this.check(ids).catch(()=>{});},300);this.timer.unref();}
 async check(ids,options={}){
  if(this.closed)return;
  if(!this.worker){this.worker=new Worker(new URL('./file-state-worker.mjs',import.meta.url),{execArgv:[]});this.worker.unref();this.worker.on('message',message=>{
   if(message.event==='watch-state'){this.watchAvailable=message.available;return;}if(message.event==='files-changed'){for(const id of message.ids)this.pending.add(id);this.schedule();return;}
   const pending=this.waiters.get(message.id);if(!pending)return;
   if(message.done||message.error){this.waiters.delete(message.id);message.error?pending.reject(Error(message.error)):pending.resolve({cancelled:message.cancelled});if(this.queued.length){const next=this.queued.shift();this.check(next.ids,next.options).then(next.resolve,next.reject);}if(!this.waiters.size)this.worker.unref();return;}
   const store=this.store;let changed=false;if(pending.scan&&this.progress)this.progress.checked+=message.results.length;
   store.db.run('BEGIN');try{for(const result of message.results){const row=store.rows('SELECT body FROM downloads WHERE id=?',[result.id])[0];if(!row||hash(row.body)!==result.signature||result.root!==store.root)continue;const old=this.cache.get(result.id);store.db.run('INSERT OR REPLACE INTO file_states VALUES(?,?)',[result.id,JSON.stringify(result)]);this.cache.set(result.id,result);if(!old||old.status!==result.status||old.local!==result.local||JSON.stringify(old.assets)!==JSON.stringify(result.assets)){store.viewCache.delete(result.id);changed=true;}}store.db.run('COMMIT');}catch(error){store.db.run('ROLLBACK');this.waiters.delete(message.id);pending.reject(error);}
   if(changed){for(const result of message.results)store.lightViews?.invalidateFiles(result.id);store.revision++;this.generation++;}if(changed||pending.scan)this.onChange?.();this.worker.postMessage({ack:message.id,sequence:message.sequence});
  });this.worker.on('error',error=>{for(const pending of this.waiters.values())pending.reject(error);this.waiters.clear();});}
  if(this.waiters.size>=2)return new Promise((resolve,reject)=>this.queued.push({ids,options,resolve,reject}));
  this.worker.ref();const id=++this.sequence;return new Promise((resolve,reject)=>{this.waiters.set(id,{resolve,reject,scan:options.scan});this.worker.postMessage({id,file:this.store.file,ids:[...new Set(ids)]});});
 }
 state(){return this.progress||{running:false,total:0,checked:0};}
 monitor(){if(this.monitorTimer)return;this.monitorTimer=setInterval(()=>{void this.scan().catch(()=>{});},300000);this.monitorTimer.unref();}
 scan(){if(this.scanning)return this.scanning;const ids=this.store.rows('SELECT id FROM downloads').map(r=>r.id);this.progress={running:true,total:ids.length,checked:0};this.onChange?.();this.scanning=this.check(ids,{scan:true}).finally(()=>{this.progress.running=false;this.scanning=null;this.onChange?.();});return this.scanning;}
 cancelScan(){for(const [id,pending]of this.waiters)if(pending.scan)this.worker?.postMessage({cancel:id});this.queued=this.queued.filter(pending=>{if(!pending.options?.scan)return true;pending.resolve({cancelled:true});return false;});}
 cancel(){for(const id of this.waiters.keys())this.worker?.postMessage({cancel:id});for(const pending of this.queued)pending.resolve({cancelled:true});this.queued=[];}
 async close(){this.closed=true;clearTimeout(this.timer);clearInterval(this.monitorTimer);for(const pending of [...this.waiters.values(),...this.queued])pending.resolve({cancelled:true});this.waiters.clear();this.queued=[];await this.worker?.terminate();}
}
