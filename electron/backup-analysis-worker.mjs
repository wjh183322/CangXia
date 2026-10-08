import {parentPort} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {exportRecords,recordId} from './backup-model.mjs';
import {contentHash} from '../shared/backup-protocol.mjs';
import {validPreview} from './backup-previews.mjs';
import {sendAnalysisResult} from './backup-analysis-transfer.mjs';

let db,file,version=-1,entries=[],digests={},covers=[],localWorks=new Set();
function refresh(source){
 if(file!==source){db?.close();file=source;db=new DatabaseSync(file,{readOnly:true,timeout:5000});version=-1;}
 const next=db.prepare('PRAGMA data_version').get().data_version;if(next===version)return;
 const store={rows:(sql,args=[])=>db.prepare(sql).all(...args),all:table=>db.prepare('SELECT body FROM '+table).all().map(r=>JSON.parse(r.body)),getSetting:key=>{const r=db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value):null;}};
 db.exec('BEGIN');try{
  entries=exportRecords(store);digests={};for(const entry of entries)digests[recordId(entry)]=contentHash(entry.body);
  const backed=new Set(entries.filter(e=>e.table==='downloads'&&(e.body.assets?.some(validPreview)||e.body.backupDeleted||e.body.backupRemoved)).map(e=>e.key));
  covers=entries.filter(e=>e.table==='works'&&!e.body.readHidden&&e.body.thumbnail&&!validPreview(e.body.backupCover)&&!backed.has(e.key));
  localWorks=new Set(store.all('downloads').map(d=>d.id));db.exec('COMMIT');version=next;
 }catch(error){db.exec('ROLLBACK');version=-1;throw error;}
}
parentPort.on('message',async message=>{
 if(message.ack!==undefined)return;
 try{
  let result;
  if(message.command==='content')result={hash:contentHash(message.value)};
  else if(message.command==='delta'){
   const hashes={},changes=[];for(const entry of message.entries){const key=recordId(entry),hash=contentHash(entry.body);hashes[key]=hash;if(message.baseline[key]!==hash)changes.push(entry);}changes.push(...message.deletions);result={changes,hashes};
  }else{
   refresh(message.file);const changes=entries.filter(e=>message.baseline[recordId(e)]!==digests[recordId(e)]),deletions=[];
   for(const key of Object.keys(message.baseline))if(!(key in digests)){const colon=key.indexOf(':');deletions.push({table:key.slice(0,colon),key:key.slice(colon+1),body:null});}
   const pendingRecords=changes.filter(e=>e.table!=='downloads').length+deletions.filter(e=>e.table!=='downloads').length;
   if(message.summary)result={changeCount:changes.length+deletions.length,pendingCovers:covers.length,pendingRecords};
   else{
   const prepared=new Map(changes.map(e=>[recordId(e),e]));for(const entry of covers)prepared.set(recordId(entry),entry);
   for(const entry of entries)if(entry.table==='downloads'||(entry.table==='works'&&localWorks.has(entry.key)))prepared.set(recordId(entry),entry);
   result={...(message.prepare?{}:{changes:[...changes,...deletions]}),deletions,entries:[...prepared.values()],pendingCovers:covers.length,pendingRecords};
   }
  }
  await sendAnalysisResult(parentPort,message.id,result);
 }catch(error){parentPort.postMessage({id:message.id,error:error.message,code:error.code,stack:error.stack});}
});
