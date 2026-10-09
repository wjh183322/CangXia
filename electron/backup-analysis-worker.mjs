import {parentPort} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {exportRecords,recordId} from './backup-model.mjs';
import {contentHash,authorPublic,SHARED_SETTINGS} from '../shared/backup-protocol.mjs';
import {validPreview} from './backup-previews.mjs';
import {sendAnalysisResult} from './backup-analysis-transfer.mjs';
import {analyzeMedia} from './backup-media-analysis.mjs';

let db,file,version=-1,records=new Map(),digests={},covers=new Set(),localWorks=new Set(),related=new Map(),analyzedRecords=0;
function get(table,key){const row=db.prepare('SELECT body FROM '+table+' WHERE id=?').get(key);return row?JSON.parse(row.body):null;}
function eligible(work){return work&&(!work.readHidden||db.prepare('SELECT 1 FROM downloads WHERE id=? UNION SELECT 1 FROM backup_downloads WHERE id=? UNION SELECT 1 FROM author_members WHERE work_id=? LIMIT 1').get(work.id,work.id,work.id));}
function remember(entry,workId){const id=recordId(entry);if(entry.body===null){records.delete(id);delete digests[id];return;}records.set(id,{table:entry.table,key:entry.key,workId});digests[id]=contentHash(entry.body);analyzedRecords++;if(workId){if(!related.has(workId))related.set(workId,new Set());related.get(workId).add(id);}}
function read(meta){const {table,key}=meta;if(table==='settings'){if(!SHARED_SETTINGS.has(key))return null;const row=db.prepare('SELECT value FROM settings WHERE key=?').get(key);return row?{table,key,body:{value:JSON.parse(row.value)}}:null;}if(table==='members'){const index=key.indexOf(':'),r=db.prepare('SELECT collection_id,work_id,rank FROM members WHERE collection_id=? AND work_id=?').get(key.slice(0,index),key.slice(index+1));return r?{table,key,body:{collectionId:r.collection_id,workId:r.work_id,rank:r.rank}}:null;}if(table==='author_members'){const index=key.lastIndexOf(':'),r=db.prepare('SELECT author_id,work_id,position,hidden FROM author_members WHERE author_id=? AND work_id=?').get(key.slice(0,index),key.slice(index+1));return r?{table,key,body:{authorId:r.author_id,workId:r.work_id,position:r.position,hidden:!!r.hidden}}:null;}let body=get(table==='downloads'?'backup_downloads':table,key);if(table==='authors'&&body)body=authorPublic(body);return body?{table,key,body}:null;}
function updateWork(id){
 for(const key of related.get(id)||[]){records.delete(key);delete digests[key];}related.delete(id);covers.delete(id);
 const body=get('works',id);if(!eligible(body))return;remember({table:'works',key:id,body},id);
 for(const r of db.prepare('SELECT collection_id,rank FROM members WHERE work_id=?').all(id))remember({table:'members',key:r.collection_id+':'+id,body:{collectionId:r.collection_id,workId:id,rank:r.rank}},id);
 for(const r of db.prepare('SELECT author_id,position,hidden FROM author_members WHERE work_id=?').all(id))remember({table:'author_members',key:r.author_id+':'+id,body:{authorId:r.author_id,workId:id,position:r.position,hidden:!!r.hidden}},id);
 for(const table of ['local_tags','downloads']){const entry=read({table,key:id});if(entry)remember(entry,id);}
 const d=get('backup_downloads',id),backed=d&&(d.assets?.some(validPreview)||d.backupDeleted||d.backupRemoved);if(!body.readHidden&&body.thumbnail&&!validPreview(body.backupCover)&&!backed)covers.add(id);
}
function refresh(source){
 analyzedRecords=0;
 if(file!==source){db?.close();file=source;db=new DatabaseSync(file,{readOnly:true,timeout:5000});version=-1;}
 db.exec('BEGIN');try{
  const journal=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='backup_changes'").get();const next=journal?db.prepare('SELECT COALESCE(MAX(seq),0) value FROM backup_changes').get().value:db.prepare('PRAGMA data_version').get().data_version;
  if(next===version){db.exec('COMMIT');return;}
  if(version<0||next<version||!journal){
   records=new Map();digests={};covers=new Set();related=new Map();
   const store={rows:(sql,args=[])=>db.prepare(sql).all(...args),all:table=>db.prepare('SELECT body FROM '+table).all().map(r=>JSON.parse(r.body)),getSetting:key=>{const r=db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value):null;}};
   const entries=exportRecords(store);for(const e of entries){const wid=e.table==='works'||e.table==='downloads'||e.table==='local_tags'?e.key:e.table==='members'||e.table==='author_members'?e.body.workId:null;remember(e,wid);}
   const backed=new Set(entries.filter(e=>e.table==='downloads'&&(e.body.assets?.some(validPreview)||e.body.backupDeleted||e.body.backupRemoved)).map(e=>e.key));
   for(const e of entries)if(e.table==='works'&&!e.body.readHidden&&e.body.thumbnail&&!validPreview(e.body.backupCover)&&!backed.has(e.key))covers.add(e.key);
   localWorks=new Set(db.prepare('SELECT id FROM downloads').all().map(r=>r.id));
  }else{
   const events=db.prepare('SELECT kind,key,work_id FROM backup_changes WHERE seq>? AND seq<=?').all(version,next),workIds=new Set(),other=new Map();
   for(const e of events){if(e.work_id)workIds.add(e.work_id);else other.set(e.kind+':'+e.key,{table:e.kind,key:e.key});if(e.kind==='local_downloads'){if(db.prepare('SELECT 1 FROM downloads WHERE id=?').get(e.key))localWorks.add(e.key);else localWorks.delete(e.key);}}
   for(const id of workIds)updateWork(id);for(const meta of other.values()){const entry=read(meta);if(entry)remember(entry);else{records.delete(recordId(meta));delete digests[recordId(meta)];}}
  }
  db.exec('COMMIT');version=next;
 }catch(error){db.exec('ROLLBACK');version=-1;throw error;}
}
async function execute(message){
 try{
  let result;
  if(message.command==='content')result={hash:contentHash(message.value)};
  else if(message.command==='media'){if(file!==message.file){db?.close();file=message.file;db=new DatabaseSync(file,{readOnly:true,timeout:5000});version=-1;}result=await analyzeMedia(db,message);}
  else if(message.command==='delta'){const hashes={},changes=[];for(const entry of message.entries){const key=recordId(entry),hash=contentHash(entry.body);hashes[key]=hash;if(message.baseline[key]!==hash)changes.push(entry);}changes.push(...message.deletions);result={changes,hashes};}
  else{
   refresh(message.file);const changed=[...records.keys()].filter(key=>message.baseline[key]!==digests[key]),deletions=[];
   for(const key of Object.keys(message.baseline))if(!(key in digests)){const colon=key.indexOf(':');deletions.push({table:key.slice(0,colon),key:key.slice(colon+1),body:null});}
   const pendingRecords=changed.filter(key=>!key.startsWith('downloads:')).length+deletions.filter(e=>e.table!=='downloads').length;
   if(message.summary)result={changeCount:changed.length+deletions.length,pendingCovers:covers.size,pendingRecords,analyzedRecords};
   else{
    const keys=new Set(changed);for(const id of covers)keys.add('works:'+id);
    const media=message.mediaIds===undefined?localWorks:new Set(message.mediaIds);
    for(const id of media){if(records.has('works:'+id))keys.add('works:'+id);if(records.has('downloads:'+id))keys.add('downloads:'+id);}
    if(message.mediaIds===undefined)for(const meta of records.values())if(meta.table==='downloads')keys.add(recordId(meta));
    const entries=[...keys].map(key=>records.has(key)?read(records.get(key)):null).filter(Boolean),changes=message.prepare?undefined:[...changed.map(key=>read(records.get(key))).filter(Boolean),...deletions];
    result={...(changes?{changes}:{}),deletions,entries,pendingCovers:covers.size,pendingRecords};
   }
  }
  await sendAnalysisResult(parentPort,message.id,result);
 }catch(error){parentPort.postMessage({id:message.id,error:error.message,code:error.code,stack:error.stack});}
}
let requestTail=Promise.resolve();
parentPort.on('message',message=>{if(message.ack!==undefined)return;requestTail=requestTail.then(()=>execute(message));});
