import {Worker} from 'node:worker_threads';

export class BackupAnalysis{
 constructor(file){this.file=file;this.sequence=0;this.waiters=new Map();}
 request(command,values={}){
  if(this.closed)return Promise.reject(new Error('备份分析已关闭'));
  if(!this.worker){this.worker=new Worker(new URL('./backup-analysis-worker.mjs',import.meta.url),{execArgv:[]});this.worker.on('message',message=>{const pending=this.waiters.get(message.id);if(!pending)return;this.waiters.delete(message.id);if(message.error)pending.reject(Object.assign(new Error(message.error),{code:message.code}));else try{pending.resolve(JSON.parse(new TextDecoder().decode(message.payload)));}catch(error){pending.reject(error);}});this.worker.on('error',error=>{for(const pending of this.waiters.values())pending.reject(error);this.waiters.clear();});this.worker.unref();}
  this.worker.ref();const id=++this.sequence;return new Promise((resolve,reject)=>{this.waiters.set(id,{resolve:value=>{resolve(value);if(!this.waiters.size)this.worker.unref();},reject:error=>{reject(error);if(!this.waiters.size)this.worker.unref();}});this.worker.postMessage({id,command,file:this.file,...values});});
 }
 inspect(baseline){return this.request('inspect',{baseline});}
 delta(entries,baseline,deletions=[]){return this.request('delta',{entries,baseline,deletions});}
 content(value){return this.request('content',{value}).then(result=>result.hash);}
 async close(){this.closed=true;for(const pending of this.waiters.values())pending.reject(new Error('备份分析已关闭'));this.waiters.clear();await this.worker?.terminate();}
}
