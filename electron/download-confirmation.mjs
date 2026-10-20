import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {requireInside} from './model.mjs';

const digest=body=>createHash('sha256').update(body).digest('hex');
const stamp=s=>[s.size,s.mtimeMs,s.ctimeMs,s.dev,s.ino];
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const failed=(code,key='',message='')=>({ok:false,code,issues:[{key,code,message}],changed:false});
const required=work=>work?.type==='video'?['video','cover','metadata']:work?.type==='images'&&work.images?.length?[...work.images.map(im=>'image-'+im.index),'metadata']:null;
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;

async function probe(action,signal){
 signal?.throwIfAborted();let timer,onAbort;
 try{return await Promise.race([action(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('文件检查超时'),{code:'FILE_CHECK_TIMEOUT'})),5000);timer.unref();if(signal){onAbort=()=>reject(Object.assign(Error('已停止确认'),{code:'CONFIRM_CANCELLED'}));signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();}})]);}
 finally{clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
}

async function parents(root,dir,signal){
 const base=path.resolve(root);let current=requireInside(base,dir);const result=[];
 for(;;){const stat=await probe(()=>fs.lstat(current),signal);if(stat.isSymbolicLink()||!stat.isDirectory())throw Object.assign(Error('保存目录包含链接或不是文件夹'),{code:'CONFIRM_UNSAFE'});result.push([current,stat.dev,stat.ino]);if(samePath(current,base))return result;const parent=path.dirname(current);if(parent===current)throw Object.assign(Error('无法确认保存目录边界'),{code:'CONFIRM_UNSAFE'});current=parent;}
}

/** Confirm one registered work; never infer media identity from a filename. */
export async function confirmDownload(store,id,{signal}={}){
 for(let attempt=0;attempt<2;attempt++){
  let key='';
  try{
   signal?.throwIfAborted();const root=store.root,row=store.rows('SELECT body FROM downloads WHERE id=?',[id])[0];
   if(!row)return failed('NO_RECORD','','没有此作品的保存清单');
   const d=JSON.parse(row.body),keys=required(store.work(id));
   if(!keys)return failed('WORK_UNKNOWN','','作品类型或原图数量不完整，无法判断文件完整性');
   if(!Array.isArray(d.assets))return failed('UNREGISTERED_ASSET',keys[0],'保存清单没有登记文件');
   for(key of keys)if(!d.assets.some(a=>a.key===key))return failed('UNREGISTERED_ASSET',key,'必需文件未登记，已有同名文件不会直接认领');
   const targets=d.assets.filter(a=>typeof a.key==='string'&&!a.key.startsWith('cover-hd-'));
   const parentBefore=await parents(root,d.path,signal),assets={},files=[];
   for(const a of targets){
    key=a.key;if(typeof a.file!=='string'||!a.file||a.size!==undefined&&(!Number.isSafeInteger(a.size)||a.size<0))return failed('INVALID_RECORD',key,'文件清单内容无效');
    const file=requireInside(d.path,path.join(d.path,a.file)),fileParents=await parents(root,path.dirname(file),signal);
    const stat=await probe(()=>fs.lstat(file),signal);
    if(stat.isSymbolicLink()||!stat.isFile())return failed('UNSAFE_PATH',key,'文件是链接或不是普通文件');
    if(stat.size<=0||a.size&&a.size!==stat.size)return failed('SIZE_MISMATCH',key,'文件为空或大小与保存清单不一致');
    assets[key]={exists:true,state:'available',stamp:[stat.size,stat.mtimeMs,stat.ctimeMs]};files.push({file,stamp:stamp(stat),parents:fileParents});
   }
   let filesChanged=false;
   for(const file of files){const currentParents=await parents(root,path.dirname(file.file),signal),stat=await probe(()=>fs.lstat(file.file),signal);if(!same(currentParents,file.parents)||!stat.isFile()||stat.isSymbolicLink()||!same(stamp(stat),file.stamp)){filesChanged=true;break;}}
   const parentAfter=await parents(root,d.path,signal);
   signal?.throwIfAborted();
   const current=store.rows('SELECT body FROM downloads WHERE id=?',[id])[0]?.body;
   if(filesChanged||!same(parentBefore,parentAfter)||current!==row.body||store.root!==root||!same(required(store.work(id)),keys)){if(attempt===0)continue;return failed('RECORD_CHANGED','','确认期间文件、目录或清单有变化，请稍后重试');}
   const changed=d.state!=='complete',final=changed?{...d,state:'complete',lastError:''}:d,body=changed?JSON.stringify(final):row.body;
   const snapshot={id,signature:digest(body),root,status:'complete',local:targets.some(a=>a.kind!=='metadata'),bytes:targets.reduce((n,a)=>n+(assets[a.key]?.stamp[0]||0),0),assets,checkedAt:Date.now()};
   // There is no asynchronous gap between the final evidence check and commit.
   store.db.run('BEGIN');try{if(changed)store.put('downloads',id,final);store.db.run('INSERT OR REPLACE INTO file_states VALUES(?,?)',[id,JSON.stringify(snapshot)]);store.db.run('COMMIT');}catch(error){store.db.run('ROLLBACK');throw error;}
   if(changed)store.save();return {ok:true,code:'COMPLETE',issues:[],changed,snapshot};
  }catch(error){
   if(signal?.aborted||error.code==='CONFIRM_CANCELLED')return failed('CANCELLED',key,'已停止确认，原文件保留');
   if(error.code==='CONFIRM_UNSAFE'||/超出媒体库目录/.test(error.message))return failed('UNSAFE_PATH',key,'无法安全确认保存目录或文件边界');
   if(error.code==='ENOENT'){let online=false;try{online=(await probe(()=>fs.stat(store.root),signal)).isDirectory();}catch{}return failed(online?'MISSING_FILE':'DIRECTORY_UNAVAILABLE',key,online?'登记的文件或目录不存在':'保存目录暂不可用，未判为文件丢失');}
   if(['EACCES','EPERM','EIO','ENOTDIR','FILE_CHECK_TIMEOUT'].includes(error.code))return failed('DIRECTORY_UNAVAILABLE',key,'目录不可用、没有权限或文件检查超时，原文件保留');
   throw error;
  }
 }
}
