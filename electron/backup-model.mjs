import {contentHash,SHARED_SETTINGS,validateEntry} from '../shared/backup-protocol.mjs';
export const recordId=e=>e.table+':'+e.key;
export function exportRecords(store){
 const entries=[],remote=store.all('backup_downloads'),local=store.all('downloads');const saved=new Set([...remote,...local].map(d=>d.id));const works=store.all('works').filter(w=>!w.readHidden||saved.has(w.id)),ids=new Set(works.map(w=>w.id));
 for(const w of works)entries.push({table:'works',key:w.id,body:w});
 for(const c of store.all('collections'))entries.push({table:'collections',key:c.id,body:c});
 for(const r of store.rows('SELECT collection_id,work_id,rank FROM members'))if(ids.has(r.work_id))entries.push({table:'members',key:r.collection_id+':'+r.work_id,body:{collectionId:r.collection_id,workId:r.work_id,rank:r.rank}});
 for(const t of store.all('local_tags'))if(ids.has(t.id))entries.push({table:'local_tags',key:t.id,body:t});
 for(const key of SHARED_SETTINGS){const value=store.getSetting(key);if(value!==null)entries.push({table:'settings',key,body:{value}});}
 for(const d of remote)if(ids.has(d.id))entries.push({table:'downloads',key:d.id,body:d});
 return entries;
}
export function hashes(entries){return Object.fromEntries(entries.map(e=>[recordId(e),contentHash(e.body)]));}
export function changesSince(entries,previous={}){const map=new Map(entries.map(e=>[recordId(e),e]));const changes=entries.filter(e=>previous[recordId(e)]!==contentHash(e.body));for(const key of Object.keys(previous))if(!map.has(key)){const colon=key.indexOf(':');changes.push({table:key.slice(0,colon),key:key.slice(colon+1),body:null});}return changes;}
export function applyChanges(store,changes,{replace=false}={}){
 store.db.run('BEGIN');try{if(changes.length)store.db.run('DELETE FROM sync_runs; DELETE FROM sync_items; DELETE FROM sync_pages;');if(replace){store.db.run('DELETE FROM works; DELETE FROM collections; DELETE FROM members; DELETE FROM local_tags; DELETE FROM downloads; DELETE FROM backup_downloads;');for(const key of SHARED_SETTINGS)store.db.run('DELETE FROM settings WHERE key=?',[key]);}for(const entry of changes){validateEntry(entry);const {table,key,body}=entry;
  if(table==='members'){const [collection,id]=key.split(':');store.db.run('DELETE FROM members WHERE collection_id=? AND work_id=?',[collection,id]);if(body)store.db.run('INSERT INTO members VALUES(?,?,?)',[body.collectionId,body.workId,body.rank]);}
  else if(table==='settings'){if(body)store.setSetting(key,body.value);else store.db.run('DELETE FROM settings WHERE key=?',[key]);}
  else{const target=table==='downloads'?'backup_downloads':table;if(body)store.put(target,key,{...body,id:key});else if(table==='works'&&store.download(key)){const w=store.work(key);if(w)store.put('works',key,{...w,readHidden:true});}else store.db.run(`DELETE FROM ${target} WHERE id=?`,[key]);}
 }store.db.run('COMMIT');}catch(e){store.db.run('ROLLBACK');throw e;}store.invalidateViews();store.save();
}
