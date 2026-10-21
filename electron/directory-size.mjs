import fs from 'node:fs/promises';import path from 'node:path';
import {setImmediate as yieldLoop} from 'node:timers/promises';
const inside=(root,target)=>{const relative=path.relative(root,target);return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
export class DirectorySize{
 constructor({getRoot,getSaved=()=>null,save=()=>{},onChange=()=>{},io=fs}){Object.assign(this,{getRoot,getSaved,save,onChange,io});this.progress={running:false,phase:'idle'};}
 state(){const root=path.resolve(this.getRoot()),saved=this.getSaved(),same=this.progress.root===root;return {root,...(same?this.progress:{running:!!this.progress.running,phase:this.progress.running?'running':'idle',message:this.progress.running?'正在结束原目录的统计':'请刷新当前保存目录大小'}),result:saved?.root===root?{...saved}:null};}
 emit(){this.onChange(this.state());}
 cancel(){this.controller?.abort(Object.assign(Error('大小统计已停止'),{code:'ABORT_ERR'}));}
 async close(){this.cancel();await this.task?.catch(()=>{});}
 start(){if(this.task)return this.task;const root=path.resolve(this.getRoot());this.controller=new AbortController();this.task=this.run(root,this.controller.signal).finally(()=>{this.task=null;this.controller=null;});return this.task;}
 async run(root,signal){
  const check=()=>{signal.throwIfAborted();if(path.resolve(this.getRoot())!==root)throw Object.assign(Error('保存目录已变化，未采用原目录结果'),{code:'ROOT_CHANGED'});};
  const read=async action=>{check();let timer,abort;try{return await Promise.race([Promise.resolve().then(action),new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>reject(Object.assign(Error('读取目录超时'),{code:'ETIMEDOUT'})),5000);})]);}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);check();}};
  const progress=this.progress={root,running:true,phase:'running',files:0,bytes:0,errors:0,links:0,message:'正在统计保存目录大小'};let last=0;const publish=force=>{if(force||Date.now()-last>=200){last=Date.now();this.emit();}};publish(true);
  try{
   const initial=await read(()=>this.io.lstat(root));if(!initial.isDirectory()||initial.isSymbolicLink())throw Error('保存目录不可用或为目录链接');const realRoot=await read(()=>this.io.realpath(root)),stack=[root],directories=new Map();
   const verify=async(directory,identity)=>{const stat=await read(()=>this.io.lstat(directory)),real=await read(()=>this.io.realpath(directory));if(stat.isSymbolicLink()||!stat.isDirectory()||stat.dev!==identity.dev||stat.ino!==identity.ino||real!==identity.real||!inside(realRoot,real))throw Object.assign(Error('子目录在统计期间已变化，未采用本轮结果'),{code:'DIRECTORY_CHANGED'});};
   while(stack.length){
    const directory=stack.pop();let names;
    try{const stat=await read(()=>this.io.lstat(directory));if(stat.isSymbolicLink()){progress.links++;continue;}if(!stat.isDirectory())throw Error('目录在统计期间发生变化');const real=await read(()=>this.io.realpath(directory));if(!inside(realRoot,real)){progress.links++;continue;}const identity={dev:stat.dev,ino:stat.ino,real};directories.set(directory,identity);names=await read(()=>this.io.readdir(directory));await verify(directory,identity);}
    catch(error){check();if(directory===root)throw error;progress.errors++;progress.lastCode=error.code||'READ_FAILED';continue;}
    for(const name of names){
     check();const file=path.join(directory,name);if(!inside(root,file))throw Error('目录项超出保存范围');
     try{const stat=await read(()=>this.io.lstat(file));if(stat.isSymbolicLink())progress.links++;else if(stat.isDirectory())stack.push(file);else if(stat.isFile()){if(!Number.isSafeInteger(stat.size)||!Number.isSafeInteger(progress.bytes+stat.size))throw Error('目录大小超出可统计范围');progress.bytes+=stat.size;progress.files++;}}
     catch(error){check();progress.errors++;progress.lastCode=error.code||'READ_FAILED';}
     publish();if(progress.files%100===0)await yieldLoop();
    }
   }
   for(const [directory,identity]of directories)await verify(directory,identity);
   const final=await read(()=>this.io.lstat(root));if(initial.dev!==final.dev||initial.ino!==final.ino)throw Error('保存目录在统计期间已被替换');check();
   if(progress.errors){progress.phase='partial';progress.message=`有 ${progress.errors} 项未能统计（${progress.lastCode}），保留上次完整结果，请稍后重试`;}
   else{await this.save({root,bytes:progress.bytes,files:progress.files,scannedAt:new Date().toISOString()});check();progress.phase='done';progress.message=progress.links?`大小已更新，已跳过 ${progress.links} 个链接`:'目录大小已更新';}
  }catch(error){progress.phase=signal.aborted||error.code==='ROOT_CHANGED'?'cancelled':'failed';progress.message=progress.phase==='cancelled'?'大小统计已停止，未覆盖上次结果':`大小统计失败${error.code?'（'+error.code+'）':''}：${error.message}`;}
  finally{progress.running=false;publish(true);}return this.state();
 }
}
