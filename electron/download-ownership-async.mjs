import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';import {requireInside} from './model.mjs';

export async function validateOwnershipPath(root,file,{signal,io=fs}={}){
 const resolved=requireInside(root,file);let part=resolved;
 for(;;){signal?.throwIfAborted();let stat;try{stat=await io.lstat(part);}catch(e){if(e.code!=='ENOENT')throw e;}if(stat?.isSymbolicLink())throw Error('任务文件路径包含链接，原文件保留');const parent=path.dirname(part);if(parent===part)break;part=parent;}
 signal?.throwIfAborted();return resolved;
}
export async function captureCancellationOwnership(store,id,{target,signal,legacyUnknown=false,epoch=randomUUID(),io=fs}={}){
 signal?.throwIfAborted();const root=path.resolve(store.root),original=store.download(id),serialized=JSON.stringify(original),destination=target?.dir||original?.path;if(!destination)throw Error('保存目标尚未确认');
 const check=()=>{signal?.throwIfAborted();if(path.resolve(store.root)!==root)throw Error('下载根目录已变化，保护快照未受理');if(JSON.stringify(store.download(id))!==serialized)throw Error('文件记录已变化，请重新准备');};
 const dirs=[],metadata=[];
 for(const dir of new Set([original?.path,destination].filter(Boolean).map(p=>path.resolve(p)))){
  check();await validateOwnershipPath(root,path.join(dir,'.cancel-path-check'),{signal,io});let existing=[];try{existing=await io.readdir(dir);}catch(e){if(e.code!=='ENOENT')throw e;}check();dirs.push({dir,existing});
  for(const name of new Set(['作品信息.json',...(original?.assets||[]).filter(a=>a.kind==='metadata').map(a=>a.file)])){
   if(!existing.includes(name))continue;const file=await validateOwnershipPath(root,path.join(dir,name),{signal,io}),before=await io.lstat(file);if(!before.isFile())throw Error('原有作品信息不是普通文件');let handle;
   try{handle=await io.open(file,'r');const opened=await handle.stat();if(opened.dev!==before.dev||opened.ino!==before.ino)throw Error('原有文件在检查时被替换，已保留');const bytes=await handle.readFile();const after=await handle.stat();await validateOwnershipPath(root,file,{signal,io});const current=await io.lstat(file);if(before.dev!==current.dev||before.ino!==current.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||after.size!==current.size||after.mtimeMs!==current.mtimeMs)throw Error('原有作品信息在检查时发生变化，已保留');metadata.push({file,bytes:bytes.toString('base64')});}finally{await handle?.close();}
   check();
  }
 }
 check();return {version:1,epoch,root,dirs,files:[],original:original?structuredClone(original):null,metadata,...(legacyUnknown&&dirs.some(d=>d.existing.length)?{legacyUnknown:true}:{})};
}
