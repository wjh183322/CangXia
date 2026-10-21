import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const sharingErrors=new Set(['EPERM','EACCES','EBUSY']);

/** Ordered snapshots; never unlink the previous state to force a replacement. */
export class AtomicJsonFile {
 constructor(file,{retryMs=3000,rename=(from,to)=>fs.rename(from,to)}={}){
  this.file=path.resolve(file);this.retryMs=retryMs;this.rename=rename;
  this.tail=Promise.resolve();this.closed=false;
 }
 write(value){
  if(this.closed)return Promise.reject(Error('状态保存器已经关闭'));
  let text;try{text=JSON.stringify(value);}catch(error){return Promise.reject(error);}
  const result=this.tail.then(()=>this.replace(text));
  this.tail=result.catch(()=>{});
  return result;
 }
 async replace(text){
  const temporary=this.file+'.'+randomUUID()+'.tmp';let handle,created=false;
  try{
   await fs.mkdir(path.dirname(this.file),{recursive:true});
   handle=await fs.open(temporary,'wx',0o600);created=true;
   await handle.writeFile(text,'utf8');await handle.sync();await handle.close();handle=null;
   const deadline=performance.now()+this.retryMs;
   for(let attempt=0;;attempt++){
    try{await this.rename(temporary,this.file);created=false;return;}
    catch(error){const remaining=deadline-performance.now();if(!sharingErrors.has(error.code)||remaining<=0)throw error;await delay(Math.min(remaining,250,25*2**attempt));}
   }
  }catch(cause){
   const error=new Error('本机同步状态保存失败（'+(cause.code||'未知错误')+'），请检查保存目录或稍后重试',{cause});
   error.code='BACKUP_STATE_SAVE_FAILED';error.fsCode=cause.code;throw error;
  }finally{
   if(handle)await handle.close().catch(()=>{});
   if(created)await fs.rm(temporary,{force:true}).catch(()=>{});
  }
 }
 async close(){this.closed=true;await this.tail;}
}
