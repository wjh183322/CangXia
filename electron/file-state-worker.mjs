import {parentPort} from 'node:worker_threads';import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {requireInside} from './model.mjs';
import {FileWatchIndex} from './file-watch-index.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex'),cancelled=new Set();let db,file,watch;
const timed=async action=>{let timer;try{return await Promise.race([action(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('文件检查超时'),{code:'FILE_CHECK_TIMEOUT'})),5000);timer.unref();})]);}finally{clearTimeout(timer);}};
async function rootState(root){try{return (await timed(()=>fs.stat(root))).isDirectory();}catch{return false;}}
async function inspect(id,root,parents,requestId){
 const row=db.prepare('SELECT body FROM downloads WHERE id=?').get(id);if(!row)return null;const d=JSON.parse(row.body),assets=Object.create(null);let unknown=!await rootState(root),usable=0,bytes=0;
 for(const a of d.assets||[]){let exists=false,state=unknown?'unknown':'missing';
  if(cancelled.has(requestId))return null;
  if(!unknown)try{
   const target=requireInside(root,path.join(d.path,a.file));let current=path.resolve(d.path),base=path.resolve(root);
   for(;;){if(!parents.has(current)){try{const s=await timed(()=>fs.lstat(current));parents.set(current,s.isSymbolicLink()?'blocked':'ok');}catch(e){parents.set(current,e.code==='ENOENT'?'missing':'blocked');}}if(parents.get(current)==='blocked')throw Error('目录暂不可用或包含链接');if(current.toLowerCase()===base.toLowerCase())break;const parent=path.dirname(current);if(parent===current)throw Error('无法确认保存目录边界');current=parent;}
   const stat=await timed(()=>fs.lstat(target));exists=stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&(!a.size||stat.size===a.size);state=exists?'available':stat.isSymbolicLink()?'unknown':'invalid';assets[a.key]={stamp:[stat.size,stat.mtimeMs,stat.ctimeMs]};
  }catch(e){if(e.code==='ENOENT'){if(!await rootState(root)){unknown=true;state='unknown';}}else state='unknown';}
  assets[a.key]={...assets[a.key],exists,state};if(state==='unknown')unknown=true;if(exists||state==='unknown')bytes+=a.size||0;if(exists&&a.kind!=='metadata')usable++;
 }
 const required=(d.assets||[]).filter(a=>!a.key.startsWith('cover-hd-')),complete=d.state==='complete'&&required.length>0&&required.every(a=>assets[a.key]?.exists);
 const failedOptional=d.hdCover?.status==='failed'&&['video','cover','metadata'].every(k=>assets[k]?.exists);
 return {id,signature:hash(row.body),root,status:complete||failedOptional?'complete':unknown?'unknown':'partial',local:usable>0,bytes,assets,checkedAt:Date.now()};
}
async function packet(message,results,sequence){const current=sequence;await new Promise(resolve=>{const ack=m=>{if(m.ack===message.id&&m.sequence===current){parentPort.off('message',ack);resolve();}};parentPort.on('message',ack);parentPort.postMessage({id:message.id,sequence:current,results});});}
parentPort.on('message',async message=>{
 if(message.ack!==undefined)return;if(message.cancel!==undefined){cancelled.add(message.cancel);return;}
 try{
  if(file!==message.file){db?.close();file=message.file;db=new DatabaseSync(file,{readOnly:true,timeout:5000});}
  const root=JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('root')?.value||'null');if(!root)throw Error('尚未设置保存目录');if(!watch)watch=new FileWatchIndex(db,ids=>parentPort.postMessage({event:'files-changed',ids}),available=>parentPort.postMessage({event:'watch-state',available}));watch.start(root);
  let sequence=0;for(let start=0;start<message.ids.length&&!cancelled.has(message.id);start+=50){const parents=new Map(),results=[];for(const id of message.ids.slice(start,start+50)){if(cancelled.has(message.id))break;const result=await inspect(id,root,parents,message.id);if(result)results.push(result);}if(results.length)await packet(message,results,++sequence);}
  parentPort.postMessage({id:message.id,done:true,cancelled:cancelled.delete(message.id)});
 }catch(error){parentPort.postMessage({id:message.id,error:error.message});}
});
