import {clearCollectionCheckpoints} from './collection-checkpoint-reset.mjs';
import {contentHash,SHARED_SETTINGS,validateEntry,authorPublic} from '../shared/backup-protocol.mjs';
export const recordId=e=>e.table+':'+e.key;
export function exportRecords(store){
 const entries=[],remote=store.all('backup_downloads'),local=store.all('downloads');const saved=new Set([...remote,...local].map(d=>d.id)),authorWorks=new Set(store.rows('SELECT work_id FROM author_members').map(r=>r.work_id));const works=store.all('works').filter(w=>!w.readHidden||saved.has(w.id)||authorWorks.has(w.id)),ids=new Set(works.map(w=>w.id));
 for(const w of works)entries.push({table:'works',key:w.id,body:w});
 for(const c of store.all('collections'))entries.push({table:'collections',key:c.id,body:c});
 for(const a of store.all('authors'))entries.push({table:'authors',key:a.id,body:authorPublic(a)});
 for(const r of store.rows('SELECT author_id,work_id,position,hidden FROM author_members'))if(ids.has(r.work_id))entries.push({table:'author_members',key:r.author_id+':'+r.work_id,body:{authorId:r.author_id,workId:r.work_id,position:r.position,hidden:!!r.hidden}});
 for(const r of store.rows('SELECT collection_id,work_id,rank FROM members'))if(ids.has(r.work_id))entries.push({table:'members',key:r.collection_id+':'+r.work_id,body:{collectionId:r.collection_id,workId:r.work_id,rank:r.rank}});
 for(const t of store.all('local_tags'))if(ids.has(t.id))entries.push({table:'local_tags',key:t.id,body:t});
 for(const key of SHARED_SETTINGS){const value=store.getSetting(key);if(value!==null)entries.push({table:'settings',key,body:{value}});}
 for(const d of remote)if(ids.has(d.id))entries.push({table:'downloads',key:d.id,body:d});
 return entries;
}
export function hashes(entries){return Object.fromEntries(entries.map(e=>[recordId(e),contentHash(e.body)]));}
export function changesSince(entries,previous={}){const map=new Map(entries.map(e=>[recordId(e),e]));const changes=entries.filter(e=>previous[recordId(e)]!==contentHash(e.body));for(const key of Object.keys(previous))if(!map.has(key)){const colon=key.indexOf(':');changes.push({table:key.slice(0,colon),key:key.slice(colon+1),body:null});}return changes;}
export function applyChanges(store,changes,{replace=false}={}){
 store.db.run('BEGIN');try{if(changes.length||replace){store.db.run('DELETE FROM sync_runs; DELETE FROM sync_items; DELETE FROM sync_pages; DELETE FROM author_scan; DELETE FROM author_pages;');for(const a of store.all('authors'))if(a.run){delete a.run;store.put('authors',a.id,a);}clearCollectionCheckpoints(store);}if(replace){store.db.run('DELETE FROM works; DELETE FROM collections; DELETE FROM members; DELETE FROM local_tags; DELETE FROM downloads; DELETE FROM backup_downloads; DELETE FROM authors; DELETE FROM author_members;');for(const key of SHARED_SETTINGS)store.db.run('DELETE FROM settings WHERE key=?',[key]);}for(const entry of changes){validateEntry(entry);const {table,key,body}=entry;
  if(table==='members'){const [collection,id]=key.split(':');store.localReconcile.mark(id);store.db.run('DELETE FROM members WHERE collection_id=? AND work_id=?',[collection,id]);if(body)store.db.run('INSERT INTO members VALUES(?,?,?)',[body.collectionId,body.workId,body.rank]);}
  else if(table==='author_members'){const colon=key.lastIndexOf(':'),author=key.slice(0,colon),id=key.slice(colon+1);store.db.run('DELETE FROM author_members WHERE author_id=? AND work_id=?',[author,id]);if(body)store.db.run('INSERT INTO author_members VALUES(?,?,?,?)',[author,id,body.position,body.hidden?1:0]);}
  else if(table==='settings'){if(body)store.setSetting(key,body.value);else store.db.run('DELETE FROM settings WHERE key=?',[key]);}
  else{const target=table==='downloads'?'backup_downloads':table;if(body)store.put(target,key,{...body,id:key});else if(table==='works'&&store.download(key)){const w=store.work(key);if(w)store.put('works',key,{...w,readHidden:true});}else store.db.run(`DELETE FROM ${target} WHERE id=?`,[key]);}
 }store.db.run('COMMIT');}catch(e){store.db.run('ROLLBACK');throw e;}store.invalidateViews();store.save();
}
