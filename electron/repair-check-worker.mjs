import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs/promises';import path from 'node:path';
import {requireInside} from './model.mjs';
let cancelled=false;const acknowledgements=new Map();
parentPort.on('message',message=>{if(message.cancel)cancelled=true;if(message.ack!==undefined){acknowledgements.get(message.ack)?.();acknowledgements.delete(message.ack);}});
const db=new DatabaseSync(workerData.file,{readOnly:true,timeout:1000});
const workStatement=db.prepare("SELECT json_extract(body,'$.name') name,json_extract(body,'$.type') type FROM works WHERE id=?"),downloadStatement=db.prepare('SELECT body FROM downloads WHERE id=?'),imageStatement=db.prepare("SELECT json_extract(value,'$.index') idx FROM works,json_each(works.body,'$.images') WHERE works.id=?");
const root=JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('root')?.value||'null');
const context={root,parents:new Map(),unavailable:''};
async function stat(file){let timer;try{return await Promise.race([fs.lstat(file),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('文件访问超时，请检查磁盘连接'),{code:'CHECK_TIMEOUT'})),5000);})]);}catch(error){if(error.code==='CHECK_TIMEOUT')context.unavailable=error.message;throw error;}finally{clearTimeout(timer);}}
async function rootAvailable(){try{const s=await stat(root);if(s.isSymbolicLink()||!s.isDirectory())throw Error('保存目录暂不可用或是链接');return true;}catch(error){context.unavailable=error.message;return false;}}
async function parents(directory){let current=path.resolve(directory),base=path.resolve(root);requireInside(base,current);for(;;){if(cancelled)throw Error('检查已停止');if(!context.parents.has(current)){try{const s=await stat(current);context.parents.set(current,s.isSymbolicLink()?'blocked':s.isDirectory()?'ok':'blocked');}catch(error){if(error.code!=='ENOENT')throw error;context.parents.set(current,'missing');}}if(context.parents.get(current)==='blocked')throw Error('目录是链接或不是文件夹');if(current.toLowerCase()===base.toLowerCase())break;const next=path.dirname(current);if(next===current)throw Error('无法确认目录边界');current=next;}if(context.parents.size>2048)context.parents.clear();}
async function inspect(id){
 const result={id,name:id,status:'complete',missing:[],error:''};
 try{
  const w=workStatement.get(id);if(!w)throw Error('作品信息不存在');result.name=String(w.name||id).slice(0,200);
  if(context.unavailable)throw Error(context.unavailable);
  const record=downloadStatement.get(id),d=record?JSON.parse(record.body):null;
  const expected=w.type==='video'?[['video','视频'],['cover','高清单图']]:imageStatement.all(id).map(im=>['image-'+im.idx,'图片 '+(im.idx+1)]);if(w.type==='images'&&!expected.length)throw Error('缺少原始图片数量，无法判断完整性');expected.push(['metadata','作品信息']);
  if(d)await parents(d.path);const assets=new Map((d?.assets||[]).map(a=>[a.key,a]));
  for(const [key,label]of expected){
   if(cancelled)return null;if(context.unavailable)throw Error(context.unavailable);const a=assets.get(key);if(!a){result.missing.push({key,label,reason:'尚未保存'});continue;}
   const file=requireInside(root,requireInside(d.path,path.join(d.path,a.file)));let value;
   try{value=await stat(file);}catch(error){if(error.code!=='ENOENT')throw error;if(!await rootAvailable())throw Error(context.unavailable);result.missing.push({key,label,reason:'文件不存在'});continue;}
   if(value.isSymbolicLink())throw Error('文件是链接，无法安全检查');if(!value.isFile()||value.size<=0||a.size&&a.size!==value.size)result.missing.push({key,label,reason:'文件大小异常'});
  }
  if(result.missing.length)result.status='missing';
 }catch(error){result.status='error';result.error=String(error.message).slice(0,300);}
 result.missingCount=result.missing.length;result.missing=result.missing.slice(0,20);return result;
}
const heartbeat=setInterval(()=>parentPort.postMessage({heartbeat:true}),500);
try{
 await rootAvailable();let sequence=0;
 for(let start=0;start<workerData.ids.length&&!cancelled;start+=20){
  const results=[];for(const id of workerData.ids.slice(start,start+20)){if(cancelled)break;parentPort.postMessage({current:id});const result=await inspect(id);if(result&&!cancelled)results.push(result);}
  if(results.length){const seq=++sequence;await new Promise(resolve=>{acknowledgements.set(seq,resolve);parentPort.postMessage({sequence:seq,results});});}
  await new Promise(resolve=>setImmediate(resolve));
 }
 parentPort.postMessage({done:true,cancelled});
}catch(error){parentPort.postMessage({failure:String(error.message).slice(0,300)});}
finally{clearInterval(heartbeat);db.close();parentPort.close();}
