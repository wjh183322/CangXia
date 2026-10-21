// Own the file responses served to Chromium so deletion can close its handles.
export class PreviewFiles{
 constructor(fetchFile){this.fetchFile=fetchFile;this.active=new Map();this.blocked=new Map();this.scopedBlocked=new Map();}
 block(ids,kind){const selected=new Set([...ids].map(id=>kind?id+'\0'+kind:id)),blocked=kind?this.scopedBlocked:this.blocked;for(const key of selected)blocked.set(key,(blocked.get(key)||0)+1);let released=false;return()=>{if(released)return;released=true;for(const key of selected){const count=(blocked.get(key)||1)-1;if(count)blocked.set(key,count);else blocked.delete(key);}};}
 async closeSelected(ids,kind){const selected=new Set(ids),pending=[];for(const [id,entries]of this.active)if(selected.has(id))for(const entry of entries)if(!kind||entry.kind===kind)pending.push(entry.close(new DOMException('正在删除所选作品，已停止预览','AbortError')));await Promise.all(pending);}
 async open(id,file,request,{release=()=>{}}={}){
  const kind=new URL(request.url).hostname;
  if(this.blocked.has(id)||this.scopedBlocked.has(id+'\0'+kind)){release();return new Response('',{status:423,headers:{'cache-control':'no-store'}});}
  const control=new AbortController(),entry={reader:null,output:null,closed:false,kind};let finishing;
  if(!this.active.has(id))this.active.set(id,new Set());this.active.get(id).add(entry);
  const external=request.signal,dispose=()=>{external?.removeEventListener('abort',abort);this.active.get(id)?.delete(entry);if(!this.active.get(id)?.size)this.active.delete(id);release();};
  const fetched=Promise.resolve().then(()=>this.fetchFile(file,{headers:request.headers,method:request.method||'GET',signal:control.signal})).then(response=>{entry.reader=response.body?.getReader();return response;});
  const finish=(reason,aborted=true)=>{
   if(finishing)return finishing;if(aborted)control.abort(reason);
   finishing=(async()=>{try{await fetched.catch(()=>{});try{await entry.reader?.cancel(reason);}catch{}finally{try{entry.reader?.releaseLock();}catch{}}}finally{entry.closed=true;if(aborted)try{entry.output?.error(reason);}catch{}dispose();}})();return finishing;
  };
  entry.close=reason=>finish(reason);const abort=()=>{void finish(external.reason||new DOMException('预览已停止','AbortError')).catch(()=>{});};external?.addEventListener('abort',abort,{once:true});if(external?.aborted)abort();
  try{
   const response=await fetched;if(control.signal.aborted){await finish(control.signal.reason);throw control.signal.reason;}
   const headers=new Headers(response.headers);headers.set('cache-control','no-store');
   if(!entry.reader){await finish(undefined,false);return new Response(null,{status:response.status,headers});}
   const body=new ReadableStream({start(output){entry.output=output;},async pull(output){try{const chunk=await entry.reader.read();if(chunk.done){await finish(undefined,false);output.close();}else output.enqueue(chunk.value);}catch(error){await finish(error);try{output.error(error);}catch{}}},cancel:reason=>finish(reason||new DOMException('预览已关闭','AbortError'))});
   return new Response(body,{status:response.status,headers});
  }catch(error){await finish(error);throw error;}
 }
}
