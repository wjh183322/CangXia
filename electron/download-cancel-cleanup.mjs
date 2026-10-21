import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {requireInside} from './model.mjs';

const key=file=>path.resolve(file).toLowerCase();
function safeFile(root,file){
 const resolved=requireInside(root,file);let current=resolved;
 // Inspect every existing ancestor, including the root's parents: junctions must never become deletion routes.
 for(;;){const stat=fs.lstatSync(current,{throwIfNoEntry:false});if(stat?.isSymbolicLink())throw Error('取消清理路径包含链接，原文件保留');if(current===resolved&&stat&&!stat.isFile())throw Error('取消清理目标不是普通文件，原文件保留');const parent=path.dirname(current);if(parent===current)break;current=parent;}
 return resolved;
}
function directorySnapshot(store,dir){
 store.assertDirectory(dir);safeFile(store.root,path.join(dir,'.cancel-path-check'));
 let names=[];try{names=fs.readdirSync(dir);}catch(e){if(e.code!=='ENOENT')throw e;}
 return {dir:path.resolve(dir),existing:names};
}
export function createCancellationOwnership(store,id,{legacyUnknown=false,epoch=randomUUID()}={}){
 if(!store.root||!store.destination||!store.download)return undefined;
 if(!store.work?.(id)&&!store.download(id))return undefined;
 const original=store.download(id),destination=store.work?.(id)?store.destination(id).dir:original?.path,dirs=[...new Set([original?.path,destination].filter(Boolean).map(p=>path.resolve(p)))].map(dir=>directorySnapshot(store,dir));
 const metadata=[];
 for(const snapshot of dirs)for(const name of new Set(['作品信息.json',...(original?.assets||[]).filter(a=>a.kind==='metadata').map(a=>a.file)])){
  if(!snapshot.existing.includes(name))continue;const file=safeFile(store.root,path.join(snapshot.dir,name));metadata.push({file,bytes:fs.readFileSync(file).toString('base64')});
 }
 return {version:1,epoch,root:path.resolve(store.root),dirs,files:[],original:original?structuredClone(original):null,metadata,...(legacyUnknown&&dirs.some(d=>d.existing.length)?{legacyUnknown:true}:{})};
}
export function isPreTaskFile(job,file){
 const ownership=job?.cancelOwnership;if(!ownership)return false;const absolute=path.resolve(file);
 return ownership.dirs.some(d=>key(d.dir)===key(path.dirname(absolute))&&d.existing.some(name=>name.toLowerCase()===path.basename(absolute).toLowerCase()));
}
export function prepareCancellationRelocation(store,job,{targetDir}={}){
 if(!job)return false;
 const ownership=job?.cancelOwnership,old=store.download(job.id);if(!ownership||!old)return false;
 const target=targetDir||store.destination(job.id).dir;if(key(old.path)===key(target))return false;
 const source=ownership.dirs.find(d=>key(d.dir)===key(old.path));if(!source)return false;
 const snapshot=directorySnapshot(store,target),known=ownership.dirs.find(d=>key(d.dir)===key(target));
 const baseline={dir:path.resolve(target),existing:[...new Set([...source.existing,...snapshot.existing,...(known?.existing||[])])]};
 const moved=file=>path.join(target,path.relative(old.path,file)),belongs=file=>key(path.dirname(file))===key(old.path);
 const mapped=ownership.files.filter(f=>belongs(f.file)).map(f=>({...f,file:moved(f.file)}));
 const files=[...ownership.files];for(const f of mapped)if(!files.some(v=>key(v.file)===key(f.file)))files.push(f);
 const metadata=[...(ownership.metadata||[])];for(const m of ownership.metadata||[])if(belongs(m.file)&&!metadata.some(v=>key(v.file)===key(moved(m.file))))metadata.push({...m,file:moved(m.file)});
 job.cancelOwnership={...ownership,dirs:[...ownership.dirs.filter(d=>key(d.dir)!==key(target)),baseline],files,metadata};return true;
}
export function trackCancellationFile(store,job,file,{produced=false}={}){
 const ownership=job?.cancelOwnership;if(!ownership)return false;
 if(key(ownership.root)!==key(store.root))throw Error('下载根目录已变化，无法确认任务文件归属');
 file=safeFile(ownership.root,file);if(ownership.files.some(f=>key(f.file)===key(file)))return false;
 // A destination learned after metadata resolution is sampled before its first write, never after it.
 let dirs=ownership.dirs;if(!dirs.some(d=>key(d.dir)===key(path.dirname(file))))dirs=[...dirs,directorySnapshot(store,path.dirname(file))];
 const preserve=dirs.some(d=>key(d.dir)===key(path.dirname(file))&&d.existing.some(n=>n.toLowerCase()===path.basename(file).toLowerCase()))||(!produced&&!!fs.lstatSync(file,{throwIfNoEntry:false}));
 job.cancelOwnership={...ownership,dirs,files:[...ownership.files,{file,preserve}]};return true;
}
function signature(file){const stat=fs.lstatSync(file,{throwIfNoEntry:false});if(!stat?.isFile()||stat.isSymbolicLink())return null;return JSON.stringify([stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,...(stat.size<=2*1024*1024?[createHash('sha256').update(fs.readFileSync(file)).digest('hex')]:[])]);}
export function recordCancellationIdentity(store,job,file,identity,{settled=false}={}){
 const ownership=job?.cancelOwnership;if(!ownership)return false;file=safeFile(ownership.root,file);const stat=fs.lstatSync(file,{throwIfNoEntry:false}),same=stat?.dev===identity.dev&&stat?.ino===identity.ino;
 const stamp=settled&&same?signature(file):null,files=ownership.files.map(f=>key(f.file)===key(file)?{...f,identity:{dev:identity.dev,ino:identity.ino},...(stamp?{stamp}:{stamp:null})}:f);
 const metadata=ownership.metadata.map(m=>key(m.file)===key(file)&&stamp?{...m,written:stamp}:m);job.cancelOwnership={...ownership,files,metadata};return true;
}
function sharedFiles(store,job,jobs){
 const protectedFiles=new Set();
 for(const d of store.all?.('downloads')||[])if(d.id!==job.id)for(const a of d.assets||[])protectedFiles.add(key(path.join(d.path,a.file)));
 for(const other of jobs)if(other!==job)for(const entry of other.cancelOwnership?.files||[])protectedFiles.add(key(entry.file));
 for(const row of store.rows?.('SELECT body FROM audio_objects')||[]){const a=JSON.parse(row.body);if(a.relative)protectedFiles.add(key(path.join(a.root||store.root,a.relative)));}
 return protectedFiles;
}
async function unlinkSettled(root,file){
 for(let attempt=0;;attempt++){
  safeFile(root,file);
  try{await fs.promises.unlink(file);if(fs.lstatSync(file,{throwIfNoEntry:false}))throw Error('取消清理后文件仍存在');return;}
  catch(error){if(error.code==='ENOENT')return;if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=5)throw error;await delay(50*(attempt+1));}
 }
}
export async function cleanupCancelledDownload(store,job,jobs){
 const ownership=job.cancelOwnership;if(!ownership)return;
 if(key(ownership.root)!==key(store.root))throw Error('下载根目录已变化，取消清理已停止');
 if(ownership.legacyUnknown){
  for(const dir of ownership.dirs)if(directorySnapshot(store,dir.dir).existing.length)throw Error('旧任务文件归属未知，已停止并保留文件；请手动核对并移走需保留文件后再次取消');
 }
 const protectedFiles=ownership.files.length||(ownership.metadata||[]).some(m=>m.written)?sharedFiles(store,job,jobs):new Set(),removed=new Set();let failure;
 for(const entry of ownership.files){if(entry.preserve||protectedFiles.has(key(entry.file)))continue;try{safeFile(ownership.root,entry.file);const stat=fs.lstatSync(entry.file,{throwIfNoEntry:false}),stamp=signature(entry.file);if(stat&&entry.identity&&(stat.dev!==entry.identity.dev||stat.ino!==entry.identity.ino)||entry.stamp&&stamp&&stamp!==entry.stamp)continue;if(stat&&!entry.identity&&!entry.stamp)throw Error('任务文件身份尚未确认，已保留文件，请核对后再次取消');await unlinkSettled(ownership.root,entry.file);removed.add(key(entry.file));}catch(error){failure??=error;}}
 const current=store.download(job.id);
 if(current){
  const assets=(current.assets||[]).filter(a=>!removed.has(key(path.join(current.path,a.file))));
  if(ownership.original){const original=ownership.original,known=new Set((original.assets||[]).map(a=>a.key)),extras=assets.filter(a=>!known.has(a.key));store.put('downloads',job.id,{...original,...(key(original.path)!==key(current.path)?{path:current.path,collectionId:current.collectionId,home:current.home}:{}),assets:[...(original.assets||[]),...extras]});}
  else if(assets.length)store.put('downloads',job.id,{...current,assets,state:'partial'});
  else store.forgetDownloads([job.id],{localOnly:true,pruneHistory:false});
 }
 // Restore metadata that repair/relocation may have rewritten while preserving its original bytes.
 for(const metadata of ownership.metadata||[]){if(protectedFiles.has(key(metadata.file))||!metadata.written)continue;try{const file=safeFile(ownership.root,metadata.file);if(signature(file)===metadata.written)fs.writeFileSync(file,Buffer.from(metadata.bytes,'base64'));}catch(error){failure??=error;}}
 store.fileStates?.invalidate(job.id);store.save();
 if(failure)throw failure;
}
