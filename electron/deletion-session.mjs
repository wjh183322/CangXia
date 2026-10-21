import {setTimeout as delay} from 'node:timers/promises';
export async function withReleasedPreviews(ids,previews,action,kind){const unblock=previews.block(ids,kind);try{await waitDeletionWriter(previews.closeSelected(ids,kind));return await action();}finally{unblock();}}
export function waitDeletionWriter(promise,{signal,timeout=30000}={}){return new Promise((resolve,reject)=>{let finished=false;const done=(fn,value)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);fn(value);},abort=()=>done(reject,signal.reason||Error('操作已停止')),timer=setTimeout(()=>done(reject,Error('文件任务尚未退出，未执行删除，请稍后重试')),timeout);Promise.resolve(promise).then(value=>done(resolve,value),error=>done(reject,error));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});}
/** Caller holds the deletion lock before entry. Do not stop unrelated queue jobs. */
export async function quiesceSelectedDeletion({ids,files},{queue,audio,flatQueue,reconcile,previews,signal}={}){
 if(!files)return;
 const selected=new Set(ids),deadline=Date.now()+30000,wait=promise=>waitDeletionWriter(promise,{signal,timeout:Math.max(1,deadline-Date.now())});reconcile?.stop();
 await wait(previews?.closeSelected(ids));
 await wait(queue?.cancel(ids));
 for(const batch of flatQueue?.batches||[])if(!batch.canceled&&batch.jobs.some(job=>selected.has(job.id))){flatQueue.pause(batch.id);await wait(flatQueue.waitForBatch(batch));}
 for(const [key,controller]of audio?.playRequests||[])if(selected.has(key.split(':')[0]))controller.abort();
 for(const [token,session]of audio?.sessions||[])if(selected.has(session.id)){session.release();audio.sessions.delete(token);}
 await wait(audio?.cancel(ids));
 // Audio cancellation aborts first; its finally block releases file handles asynchronously.
 while(reconcile?.controller||[...audio?.active?.keys()||[]].some(id=>selected.has(id))||[...queue?.active?.keys()||[]].some(id=>selected.has(id))){signal?.throwIfAborted();if(Date.now()>deadline)throw Error('所选作品仍有文件任务未退出，未执行删除，请稍后重试');await delay(20);}
 signal?.throwIfAborted();
}
