import {initObjectReferences} from './object-references.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {contentHash,validateEntry} from '../shared/backup-protocol.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});

export function createBackupActions({db,dataDir,now,status,setMeta,busyUploads,activeReads,gcBusy,protectedObjects=()=>new Set()}){
 db.exec('CREATE TABLE IF NOT EXISTS backup_actions(request TEXT PRIMARY KEY,device TEXT,hash TEXT,result TEXT); CREATE TABLE IF NOT EXISTS garbage(sha TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS deleted_hashes(sha TEXT,work TEXT,PRIMARY KEY(sha,work));');
 initObjectReferences(db);const directory=path.resolve(dataDir,'objects');let collecting=null,partialCursor='';
 // Upgrade old exclusions once. Keep the empty manifest so preview-only sync cannot
 // recreate deleted copies when no computer has local media left.
 if(!db.prepare("SELECT 1 FROM meta WHERE key='automaticRebackupPolicy'").get()){
  db.exec('BEGIN IMMEDIATE');try{
   const rows=db.prepare("SELECT id,body FROM records WHERE kind='downloads' AND body IS NOT NULL").all().filter(r=>JSON.parse(r.body).backupDeleted);
   if(rows.length){const revision=status().revision+1;for(const row of rows){const old=JSON.parse(row.body);delete old.deletedHashes;old.backupDeleted=false;old.backupRemoved=true;db.prepare("UPDATE records SET body=?,revision=? WHERE kind='downloads' AND id=?").run(JSON.stringify(old),revision,row.id);}setMeta('revision',revision);db.prepare('INSERT INTO commits(revision,device,name,time,count) VALUES(?,?,?,?,?)').run(revision,'service','自动备份策略更新',new Date(now()).toISOString(),rows.length);}
   setMeta('automaticRebackupPolicy',1);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 function referenced(){return new Set(db.prepare('SELECT DISTINCT sha FROM object_references').all().map(row=>row.sha));}
 async function oldPartials(){const dir=path.join(dataDir,'uploads');let names;try{const root=await fs.realpath(dataDir),actual=await fs.realpath(dir);if(actual!==path.join(root,'uploads'))return [];names=(await fs.readdir(dir)).filter(name=>/^[a-f0-9]{64}\.part$/.test(name)).sort();}catch{return [];}const chosen=names.filter(name=>name>partialCursor).slice(0,100);if(!chosen.length){partialCursor='';return [];}partialCursor=chosen.at(-1);const result=[];for(const name of chosen){const file=path.resolve(dir,name);if(path.dirname(file)!==path.resolve(dir))throw Error('临时文件路径不属于上传目录');const stat=await fs.lstat(file).catch(()=>null);if(stat?.isFile()&&!stat.isSymbolicLink()&&now()-stat.mtimeMs>24*60*60*1000)result.push({sha:name.slice(0,64),file,size:stat.size});}return result;}
 async function collect(){
  if(collecting)return collecting;
  collecting=(async()=>{const partials=await oldPartials();if(!partials.length&&!db.prepare('SELECT 1 FROM garbage LIMIT 1').get())return {removedObjects:0,freedBytes:0,pendingObjects:0,removedPartials:0,freedPartialBytes:0};let refs=referenced(),revision=status().revision,removed=0,bytes=0,pending=0,removedPartials=0,freedPartialBytes=0;const started=Date.now();let handled=0;
   for(const {sha} of db.prepare('SELECT sha FROM garbage').all()){
    if(handled++>=5000||Date.now()-started>5000)break;if(!db.prepare('SELECT 1 FROM garbage WHERE sha=?').get(sha))continue;
    if(!/^[a-f0-9]{64}$/.test(sha))continue;
    if(status().revision!==revision){refs=referenced();revision=status().revision;}
    if(refs.has(sha)){db.prepare('DELETE FROM garbage WHERE sha=?').run(sha);continue;}
    if(busyUploads.has(sha)||activeReads.has(sha)||protectedObjects().has(sha)){pending++;continue;}
    gcBusy.add(sha);try{
     const known=db.prepare('SELECT size FROM objects WHERE sha=?').get(sha),file=path.resolve(directory,sha);if(path.dirname(file)!==directory)throw Error('Invalid object path');
     try{await fs.unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}
     db.prepare('DELETE FROM objects WHERE sha=?').run(sha);db.prepare('DELETE FROM garbage WHERE sha=?').run(sha);if(known){removed++;bytes+=known.size;}
    }catch{pending++;}finally{gcBusy.delete(sha);}
   }
   for(const part of partials){if(status().revision!==revision){refs=referenced();revision=status().revision;}if(refs.has(part.sha)||busyUploads.has(part.sha)||activeReads.has(part.sha)||protectedObjects().has(part.sha))continue;gcBusy.add(part.sha);try{const current=await fs.lstat(part.file).catch(()=>null);if(!current?.isFile()||current.isSymbolicLink()||current.size!==part.size||now()-current.mtimeMs<=24*60*60*1000)continue;await fs.unlink(part.file);removedPartials++;freedPartialBytes+=part.size;}catch(error){if(error.code!=='ENOENT')pending++;}finally{gcBusy.delete(part.sha);}}
   return {removedPartials,freedPartialBytes,removedObjects:removed,freedBytes:bytes,pendingObjects:db.prepare('SELECT COUNT(*) n FROM garbage').get().n};
  })().finally(()=>collecting=null);return collecting;
 }
 async function execute(action,input,device,name){
  if(!/^[a-f0-9-]{36}$/.test(input.requestId||'')||!Array.isArray(input.ids)||!input.ids.length||input.ids.length>100||input.ids.some(id=>typeof id!=='string'||!/^\d+$/.test(id))||new Set(input.ids).size!==input.ids.length)throw fail(400,'所选作品或删除请求无效');
  const hash=contentHash({action,libraryId:input.libraryId,baseRevision:input.baseRevision,ids:input.ids}),previous=db.prepare('SELECT * FROM backup_actions WHERE request=?').get(input.requestId);
  if(previous){if(previous.device!==device||previous.hash!==hash)throw fail(409,'请求标识被用于其他操作');await collect();return JSON.parse(db.prepare('SELECT result FROM backup_actions WHERE request=?').get(input.requestId).result);}
  const head=status();if(input.libraryId!==head.libraryId||input.baseRevision!==head.revision)throw fail(409,'NAS 已有其他更新，请重新检查后再操作');
  const changes=[],candidates=new Set(),reenabledHashes=new Set();let count=0;
  for(const id of input.ids){
   const row=db.prepare("SELECT body FROM records WHERE kind='downloads' AND id=?").get(id);if(!row?.body)continue;const old=JSON.parse(row.body);
   if(action==='delete'){
    if(!old.assets?.length&&!old.audio&&!old.backupDeleted)continue;
    for(const asset of old.assets||[])candidates.add(asset.sha256);
    if(old.audio?.object?.sha256)candidates.add(old.audio.object.sha256);
    const body={id,collectionId:old.collectionId,home:old.home,state:'partial',assets:[],backupDeleted:false,backupRemoved:true,deletedAt:new Date(now()).toISOString()};
    changes.push({table:'downloads',key:id,body});
    const work=db.prepare("SELECT body FROM records WHERE kind='works' AND id=?").get(id);
    if(work?.body){const updated=JSON.parse(work.body);if(updated.backupCover){candidates.add(updated.backupCover.sha256);delete updated.backupCover;changes.push({table:'works',key:id,body:updated});}}
   }else{if(!old.backupDeleted)continue;for(const sha of old.deletedHashes||[])reenabledHashes.add(sha);changes.push({table:'downloads',key:id,body:{id,collectionId:old.collectionId,home:old.home,state:'partial',assets:[],backupDeleted:false}});}
   count++;
  }
  for(const change of changes)validateEntry(change);
  if(Buffer.byteLength(JSON.stringify(changes))>8*1024*1024)throw fail(413,'本批作品资料过大，请减少所选数量');
  const revision=head.revision+(changes.length?1:0),time=new Date(now()).toISOString(),result={ackRevision:revision,libraryId:head.libraryId,changes,count,requestId:input.requestId};
  db.exec('BEGIN IMMEDIATE');try{
   const update=db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)');for(const change of changes)update.run(change.table,change.key,JSON.stringify(change.body),revision);
   for(const change of changes)if(change.table==='downloads')db.prepare('DELETE FROM deleted_hashes WHERE work=?').run(change.key);
   for(const sha of reenabledHashes)db.prepare('DELETE FROM garbage WHERE sha=?').run(sha);
   for(const sha of candidates)if(/^[a-f0-9]{64}$/.test(sha))db.prepare('INSERT OR IGNORE INTO garbage VALUES(?)').run(sha);
   if(changes.length){setMeta('revision',revision);db.prepare('INSERT INTO commits(revision,device,name,time,count,request,requestHash) VALUES(?,?,?,?,?,?,?)').run(revision,device,name,time,changes.length,input.requestId,hash);}
   db.prepare('INSERT INTO backup_actions VALUES(?,?,?,?)').run(input.requestId,device,hash,JSON.stringify(result));db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  const completed={...result,lastSync:status().lastSync,cleanup:await collect()};db.prepare('UPDATE backup_actions SET result=? WHERE request=?').run(JSON.stringify(completed),input.requestId);return completed;
 }
 return {execute,collect};
}
