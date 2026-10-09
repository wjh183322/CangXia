import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as yieldLoop} from 'node:timers/promises';
import {requireInside} from './model.mjs';

const key=file=>path.resolve(file).toLowerCase();
export class LocalReconcile{
 constructor(store){this.store=store;this.progress=null;}
 init(){
  const store=this.store;store.db.run(`CREATE TABLE IF NOT EXISTS local_reconcile(work_id TEXT PRIMARY KEY,token TEXT NOT NULL,source_path TEXT,target_path TEXT,last_error TEXT);`);
  if(!store.getSetting('localReconcileMigrated')){
   store.db.run('BEGIN');try{
    // The old reader could commit its final page then hang before organizing files.
    const latest=store.rows("SELECT id FROM collection_read_runs ORDER BY json_extract(body,'$.updatedAt') DESC LIMIT 1")[0];
    if(latest)store.db.run('INSERT OR IGNORE INTO local_reconcile(work_id,token) SELECT i.work_id,lower(hex(randomblob(16))) FROM collection_read_items i WHERE i.run_key=? AND EXISTS(SELECT 1 FROM downloads d WHERE d.id=i.work_id)',[latest.id]);
    store.setSetting('localReconcileMigrated',true);store.db.run('COMMIT');
   }catch(e){store.db.run('ROLLBACK');throw e;}
  }
 }
 mark(id){this.store.db.run('INSERT INTO local_reconcile(work_id,token) SELECT ?,? WHERE EXISTS(SELECT 1 FROM downloads WHERE id=?) ON CONFLICT(work_id) DO UPDATE SET token=excluded.token,last_error=NULL',[id,randomUUID(),id]);}
 scope(id){for(const row of this.store.rows('SELECT work_id FROM members WHERE collection_id=?',[id]))this.mark(row.work_id);}
 state(){return {...(this.progress||{}),pending:this.store.rows('SELECT COUNT(*) n FROM local_reconcile')[0].n,running:!!this.controller};}
 stop(){this.controller?.abort();}
 async owners(){
  const owners=new Map(),sql="SELECT id,json_extract(body,'$.path') path FROM downloads";
  const rows=this.store.db.iterate?this.store.db.iterate(sql):this.store.rows(sql);let index=0;
  for(const row of rows){if(row.path){const k=key(row.path);if(!owners.has(k))owners.set(k,new Set());owners.get(k).add(row.id);}if(++index%250===0){await yieldLoop();if(this.controller?.signal.aborted)break;}}
  return owners;
 }
 async validate(dir){
  const root=path.resolve(this.store.root);let current=requireInside(root,dir);
  for(;;){try{const stat=await fs.lstat(current);if(stat.isSymbolicLink())throw Error('媒体目录包含符号链接，请选择普通文件夹');}catch(e){if(e.code!=='ENOENT')throw e;}if(current===root)break;current=path.dirname(current);}
 }
 async exists(file){try{await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
 async metadata(id){
  const store=this.store,d=store.download(id);if(!d)return;await this.validate(d.path);
  const file=requireInside(d.path,path.join(d.path,'作品信息.json'));if(!await this.exists(file))return;
  await this.validate(file);
  const before=await fs.readFile(file,'utf8'),info=JSON.parse(before),w=store.work(id);if(!w)return;
  Object.assign(info,{collection:store.collection(d.collectionId)?.name,collectionId:d.collectionId,author:w.author,coAuthors:w.coAuthors||[],workName:w.name,title:w.title,caption:w.caption,description:w.description,tags:w.tags,rawTags:w.rawTags,localTags:store.get('local_tags',id)?.tags||[],remoteState:w.remoteState,checkedAt:w.checkedAt});
  const text=JSON.stringify(info,null,2);if(text===before)return;
  const temporary=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,text,{flag:'wx'});await this.validate(file);await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}
  const asset=d.assets?.find(a=>a.key==='metadata');if(asset)asset.size=(await fs.stat(file)).size;store.put('downloads',id,d);
 }
 async relocate(row,owners){
  const store=this.store,id=row.work_id;let d=store.download(id);if(!d||!store.work(id))return;
  // A persisted move may have reached the filesystem before its database update.
  if(row.source_path&&row.target_path&&d.path===row.source_path&&!await this.exists(row.source_path)&&await this.exists(row.target_path)){
   await this.validate(path.join(row.target_path,'作品信息.json'));let info;try{info=JSON.parse(await fs.readFile(path.join(row.target_path,'作品信息.json'),'utf8'));}catch{throw Error('上次目录移动需要核对，原文件保留');}
   if(String(info.workId)!==id)throw Error('上次目录移动的目标归属无法确认，原文件保留');
   d={...d,path:row.target_path};store.put('downloads',id,d);
   owners.get(key(row.source_path))?.delete(id);if(!owners.has(key(row.target_path)))owners.set(key(row.target_path),new Set());owners.get(key(row.target_path)).add(id);
  }
  let target=store.destination(id,{owners,exists:()=>false,check:false});
  if(target.dir!==path.resolve(d.path)&&await this.exists(target.dir))target=store.destination(id,{owners,exists:()=>true,check:false});
  await this.validate(d.path);await this.validate(target.dir);
  if(path.resolve(d.path)!==target.dir){
   store.db.run('UPDATE local_reconcile SET source_path=?,target_path=? WHERE work_id=?',[d.path,target.dir,id]);
   if(await this.exists(d.path)){
    await fs.mkdir(path.dirname(target.dir),{recursive:true});if(await this.exists(target.dir))throw Error('目标作品目录已存在，已保留原文件，请检查同名目录');
    await fs.rename(d.path,target.dir);
    const parent=path.dirname(d.path);if(parent!==store.root)try{if(!(await fs.readdir(parent)).length)await fs.rmdir(parent);}catch(e){if(!['ENOENT','ENOTEMPTY'].includes(e.code))throw e;}
   }
   owners.get(key(d.path))?.delete(id);if(!owners.has(key(target.dir)))owners.set(key(target.dir),new Set());owners.get(key(target.dir)).add(id);
   store.put('downloads',id,{...d,path:target.dir,collectionId:target.collectionId,home:target.home});
  }
  const current=store.download(id);if(current&&(current.collectionId!==target.collectionId||JSON.stringify(current.home)!==JSON.stringify(target.home)))store.put('downloads',id,{...current,collectionId:target.collectionId,home:target.home});
  await this.metadata(id);
 }
 async run({signal,onProgress=()=>{}}={}){
  if(this.controller)throw Error('已有本地整理任务正在进行');this.controller=new AbortController();const local=this.controller.signal;
  const rows=this.store.rows('SELECT * FROM local_reconcile'),errors=[];this.progress={total:rows.length,processed:0,failed:0};
  const stop=()=>this.controller?.abort();signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
  try{
   onProgress(this.state());await yieldLoop();if(!rows.length||local.aborted)return errors;
   try{if(!(await fs.stat(this.store.root)).isDirectory())throw Error('保存位置不是目录');}catch(e){errors.push('保存目录暂时无法检查，整理进度保留：'+e.message);this.progress.failed=rows.length;return errors;}
   const owners=await this.owners();
   for(const row of rows){if(local.aborted)break;this.progress.current=row.work_id;
    try{await this.relocate(row,owners);this.store.db.run('DELETE FROM local_reconcile WHERE work_id=? AND token=?',[row.work_id,row.token]);}
    catch(e){this.progress.failed++;if(errors.length<20)errors.push(e.message);this.store.db.run('UPDATE local_reconcile SET last_error=? WHERE work_id=? AND token=?',[e.message,row.work_id,row.token]);}
    this.progress.processed++;onProgress(this.state());await yieldLoop();
   }
   this.store.save();return errors;
  }finally{signal?.removeEventListener('abort',stop);this.controller=null;onProgress(this.state());}
 }
}
