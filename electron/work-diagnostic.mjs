import fs from 'node:fs/promises';
import path from 'node:path';
import {requireInside} from './model.mjs';
const MAX_ASSETS=256;
const safeKey=value=>typeof value==='string'&&/^[\w-]{1,80}$/.test(value)?value:'unknown';
const safeFile=value=>typeof value==='string'&&value.length<=160&&path.basename(value)===value&&!/[\\/:<>|?*\x00-\x1f]/.test(value)&&value!=='.'&&value!=='..';
const state=value=>['available','unavailable','unknown','unchecked'].includes(value)?value:'unchecked';

/** Read a single work's facts without exporting paths, signed URLs or raw errors. */
export async function buildWorkDiagnostic(store,id){
 if(typeof id!=='string'||!/^\d+$/.test(id))throw Error('作品 ID 无效');
 const work=store.work(id);if(!work)throw Error('当前资料库已没有此作品记录');
 const d=store.download(id),requiredKeys=work.type==='video'?['video','cover','metadata']:[...(work.images||[]).slice(0,MAX_ASSETS).map(i=>'image-'+i.index),'metadata'];
 const report={schemaVersion:1,workId:id,downloadState:d?.state==='complete'?'complete':d?'partial':'none',requiredKeys,sourceState:state(work.sourceStatus?.state||work.remoteState),assets:[],unregisteredFiles:[],truncated:(d?.assets?.length||0)>MAX_ASSETS,createdAt:new Date().toISOString()};
 if(!d?.path)return report;
 let accessible=true;try{store.assertDirectory(d.path);const s=await fs.lstat(d.path);accessible=s.isDirectory()&&!s.isSymbolicLink();}catch{accessible=false;}
 for(const a of (d.assets||[]).slice(0,MAX_ASSETS)){
  const entry={key:safeKey(a.key),file:safeFile(a.file)?a.file:'[unsafe]',recordedSize:Number.isSafeInteger(a.size)&&a.size>=0?a.size:null,state:'unknown'};
  if(!safeFile(a.file))entry.state='unsafe';else if(accessible)try{const s=await fs.lstat(requireInside(d.path,path.join(d.path,a.file)));entry.state=s.isSymbolicLink()||!s.isFile()?'unsafe':s.size<=0||a.size&&s.size!==a.size?'invalid':'available';entry.actualSize=s.size;}catch(e){entry.state=e.code==='ENOENT'?'missing':'unknown';}
  report.assets.push(entry);
 }
 if(accessible){
  const registered=new Set((d.assets||[]).map(a=>a.file));
  try{const directory=await fs.opendir(d.path);for await(const entry of directory){if(report.unregisteredFiles.length>=MAX_ASSETS){report.truncated=true;break;}if(!safeFile(entry.name)||registered.has(entry.name)||!entry.isFile())continue;const s=await fs.lstat(requireInside(d.path,path.join(d.path,entry.name)));if(s.isFile()&&!s.isSymbolicLink())report.unregisteredFiles.push({file:entry.name,size:s.size});}}catch{report.directoryState='unknown';}
 }else report.directoryState='unknown';
 while(Buffer.byteLength(JSON.stringify(report,null,2))>128*1024){report.truncated=true;const key=report.unregisteredFiles.length?'unregisteredFiles':'assets';report[key]=report[key].slice(0,Math.floor(report[key].length/2));}
 return report;
}
