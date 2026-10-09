import {setImmediate as yieldLoop} from 'node:timers/promises';import {creatorIndex,workCreators} from '../shared/creators.mjs';
export class SearchIndex{
 constructor(views){this.views=views;this.store=views.store;this.rows=new Map();this.buckets=new Map();this.dirty=new Set();this.profilesDirty=true;}
 mark(id){this.dirty.add(id);}
 bucket(key){if(!this.buckets.has(key))this.buckets.set(key,new Set());return this.buckets.get(key);}
 init(){if(this.initialized)return;const db=this.store.db;db.run('CREATE TABLE IF NOT EXISTS search_rows(id TEXT PRIMARY KEY,text TEXT NOT NULL)');try{
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(text,content='search_rows',content_rowid='rowid',tokenize='trigram case_sensitive 1');
   CREATE TRIGGER IF NOT EXISTS search_insert AFTER INSERT ON search_rows BEGIN INSERT INTO search_fts(rowid,text) VALUES(new.rowid,new.text); END;
   CREATE TRIGGER IF NOT EXISTS search_delete AFTER DELETE ON search_rows BEGIN INSERT INTO search_fts(search_fts,rowid,text) VALUES('delete',old.rowid,old.text); END;
   CREATE TRIGGER IF NOT EXISTS search_update AFTER UPDATE ON search_rows BEGIN INSERT INTO search_fts(search_fts,rowid,text) VALUES('delete',old.rowid,old.text); INSERT INTO search_fts(rowid,text) VALUES(new.rowid,new.text); END;`);this.fts=true;
 }catch{this.fts=false;}this.stored=new Map(this.store.rows('SELECT id,text FROM search_rows').map(r=>[r.id,r.text]));this.initialized=true;}
 remove(id){const old=this.rows.get(id);if(old)for(const key of old.keys)this.bucket(key).delete(id);this.rows.delete(id);}
 update(id){const base=this.views.bases.get(id),work=this.views.view(id),old=this.rows.get(id);if(!base||!work){this.remove(id);if(this.stored.has(id)){this.store.db.run('DELETE FROM search_rows WHERE id=?',[id]);this.stored.delete(id);}return;}
  const localTags=work.localTags,unchanged=old&&old.base===base&&old.localTags===localTags&&old.profile===this.profile;
  const people=unchanged?old.people:workCreators(base,this.profile),text=unchanged?old.text:[base.name,base.title,base.description,...people.flatMap(a=>[a.nickname,a.uniqueId,a.uid,a.secUid]),...(base.tags||[]),...localTags].join(' ').toLocaleLowerCase();
  const keys=new Set(['type:'+work.type,'download:'+(work.downloaded?'complete':['checking','unknown'].includes(work.localStatus)?'checking':'missing'),...(work.tags||[]).map(t=>'tag:'+t),...localTags.map(t=>'localtag:'+t)]);
  if(work.localStatus==='none')keys.add('download:unsaved');
  for(const person of people)for(const [prefix,value]of [['uid',person.uid],['sec',person.secUid],['handle',person.uniqueId]])if(value){keys.add('creator:'+prefix+':'+value);keys.add('creator:'+value);}
  this.remove(id);for(const key of keys)this.bucket(key).add(id);this.rows.set(id,{base,localTags,profile:this.profile,people,text,keys});
  if(this.stored.get(id)!==text){this.store.db.run('INSERT INTO search_rows(id,text) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text',[id,text]);this.stored.set(id,text);}
 }
 async prepare(){
  await this.views.prepare();this.init();if(this.loading)return this.loading;
  this.loading=(async()=>{if(!this.ready||this.profilesDirty){this.profile=creatorIndex(this.store.creatorProfiles());for(const id of this.views.bases.keys())this.dirty.add(id);this.profilesDirty=false;for(const id of this.rows.keys())if(!this.views.bases.has(id))this.dirty.add(id);}
   while(this.dirty.size){const ids=[...this.dirty].slice(0,200);this.store.db.run('BEGIN');try{for(const id of ids){this.dirty.delete(id);this.update(id);}this.store.db.run('COMMIT');}catch(e){this.store.db.run('ROLLBACK');this.stored=new Map(this.store.rows('SELECT id,text FROM search_rows').map(r=>[r.id,r.text]));for(const id of ids)this.dirty.add(id);throw e;}await yieldLoop();}
   this.ready=true;
  })().finally(()=>this.loading=null);return this.loading;
 }
 async query(ids,options={}){
  const {query='',type='all',tags=[],tagMode='any',localTags=[],localTagMode='any',author='',downloaded='all'}=options;
  if(typeof query!=='string'||query.length>6000||!['all','video','images'].includes(type)||!['all','unsaved','complete','missing','checking'].includes(downloaded)||typeof author!=='string'||![tags,localTags].every(a=>Array.isArray(a)&&a.length<=1000&&a.every(t=>typeof t==='string'&&t.length<=256))||![tagMode,localTagMode].every(m=>['any','all'].includes(m)))throw Error('搜索筛选参数无效');
  await this.prepare();const filters=[];if(type!=='all')filters.push(this.bucket('type:'+type));if(author)filters.push(this.bucket('creator:'+author));if(downloaded!=='all')filters.push(this.bucket('download:'+downloaded));
  for(const [selected,prefix,mode]of [[tags,'tag:',tagMode],[localTags,'localtag:',localTagMode]])if(selected.length){if(mode==='all')for(const value of selected)filters.push(this.bucket(prefix+value));else{const union=new Set();for(const value of selected)for(const id of this.bucket(prefix+value))union.add(id);filters.push(union);}}
  const text=query.trim().toLocaleLowerCase();if(this.fts&&Array.from(text).length>=3&&!text.includes('\0')){try{const phrase='"'+text.replaceAll('"','""')+'"';filters.push(new Set(this.store.rows('SELECT search_rows.id FROM search_fts JOIN search_rows ON search_rows.rowid=search_fts.rowid WHERE search_fts MATCH ?',[phrase]).map(r=>r.id)));}catch{/* Exact cached substring matching remains available. */}}
  return ids.filter(id=>filters.every(set=>set.has(id))&&(!text||this.rows.get(id)?.text.includes(text)));
 }
}
