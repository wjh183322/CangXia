import {normalizeCreator,sameCreator,workCreators} from '../shared/creators.mjs';
import {createHash} from 'node:crypto';
import {safeName,parseWork,isMediaURL} from './model.mjs';

export function authorId(value){
  if(typeof value!=='string'||!/^MS4wLjAB[A-Za-z0-9_-]{8,240}$/.test(value))throw new Error('作者主页标识无效，请复制完整主页链接');
  return value;
}
export function authorURL(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port||!['www.douyin.com','douyin.com','v.douyin.com','www.iesdouyin.com','www.amemv.com'].includes(url.hostname))throw new Error('请使用抖音作者主页分享链接');
  return url;
}
export async function resolveAuthorLink(text,fetcher,signal){
  if(typeof text!=='string'||text.length>6000)throw new Error('主页链接内容无效');
  const match=text.match(/https:\/\/[^\s<>\]"，。]+/);
  if(!match)throw new Error('请粘贴作者主页链接或主页分享文案');
  let url=authorURL(match[0]);
  const seen=new Set();
  for(let i=0;i<5;i++){
    signal?.throwIfAborted();
    const candidate=url.pathname.match(/^\/(?:share\/)?user\/([^/]+)\/?$/)?.[1];
    if(candidate){const id=authorId(decodeURIComponent(candidate));return {id,url:`https://www.douyin.com/user/${id}`};}
    if(!['v.douyin.com','www.iesdouyin.com','www.amemv.com'].includes(url.hostname)||seen.has(url.href))break;
    seen.add(url.href);
    const response=await fetcher(url.href,{redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});
    const location=response.headers.get('location');await response.body?.cancel();
    if(![301,302,303,307,308].includes(response.status)||!location)break;
    url=authorURL(new URL(location,url).href);
  }
  throw new Error('未能解析作者主页，请在抖音网页打开作者后复制地址栏中的完整主页链接');
}

// Author membership and checkpoints never write collection membership or order.
export class AuthorSources{
  constructor(store){this.store=store;}
  init(){
    this.store.db.run(`CREATE TABLE IF NOT EXISTS authors(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS author_members(author_id TEXT,work_id TEXT,position INTEGER,PRIMARY KEY(author_id,work_id));
      CREATE INDEX IF NOT EXISTS author_members_order ON author_members(author_id,position);
      CREATE TABLE IF NOT EXISTS author_scan(author_id TEXT,work_id TEXT,position INTEGER,PRIMARY KEY(author_id,work_id));
      CREATE TABLE IF NOT EXISTS author_pages(author_id TEXT,cursor TEXT,PRIMARY KEY(author_id,cursor));`);
    const migrated=!this.store.rows('PRAGMA table_info(author_members)').some(c=>c.name==='hidden');if(migrated)this.store.db.run('ALTER TABLE author_members ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
    this.store.db.run('BEGIN');try{for(const a of this.store.all('authors')){if(this.store.rows('SELECT 1 FROM author_scan s LEFT JOIN author_members m ON m.author_id=s.author_id AND m.work_id=s.work_id WHERE s.author_id=? AND (m.work_id IS NULL OR m.position<>s.position) LIMIT 1',[a.id]).length)this.publish(a.id);if(a.run?.status==='running'){a.run.status='paused';a.run.reason='上次读取未正常结束，已保留进度';this.save(a);}}if(migrated)for(const w of this.store.all('works'))if(w.readHidden)this.store.db.run('UPDATE author_members SET hidden=1 WHERE work_id=?',[w.id]);this.store.db.run('COMMIT');}catch(e){this.store.db.run('ROLLBACK');throw e;}
  }
  get(id){return this.store.get('authors',authorId(id));}
  save(a){this.store.put('authors',a.id,a);this.store.save();}
  add(id,data){
    authorId(id);const u=data?.user||data?.data?.user;
    if(!u||String(u.sec_uid||'')!==id||!/^\d+$/.test(String(u.uid||'')))throw new Error('未获得匹配的作者信息，未添加作者');
    const old=this.get(id);if(old?.uid&&old.uid!==String(u.uid))throw new Error('作者身份信息不一致，已保留原记录');
    const nickname=String(u.nickname||'未命名作者').slice(0,120),hash=createHash('sha256').update(id).digest('hex').slice(0,10);
    const a={...old,id,uid:String(u.uid),name:nickname,archived:false,uniqueId:normalizeCreator(u).uniqueId,avatar:(u.avatar_thumb?.url_list||[]).find(isMediaURL)||'',url:`https://www.douyin.com/user/${id}`,folder:old?.folder||`作者作品/${safeName(nickname,32)}-${hash}`,reportedCount:Number.isSafeInteger(u.aweme_count)&&u.aweme_count>=0?u.aweme_count:null,updatedAt:new Date().toISOString()};
    this.store.rememberCreator(u);this.save(a);return a;
  }
  ids(id,table='author_members'){if(!['author_members','author_scan'].includes(table))throw new Error('无效作者列表');return this.store.rows(`SELECT work_id FROM ${table} WHERE author_id=? ORDER BY position`,[id]).map(r=>r.work_id);}
  order(id){const scan=this.ids(id,'author_scan'),seen=new Set(scan);return [...scan,...this.ids(id).filter(x=>!seen.has(x))];}
  publish(id){const hidden=new Map(this.store.rows('SELECT work_id,hidden FROM author_members WHERE author_id=?',[id]).map(r=>[r.work_id,r.hidden]));const ordered=this.order(id);this.store.db.run('DELETE FROM author_members WHERE author_id=?',[id]);ordered.forEach((wid,i)=>this.store.db.run('INSERT INTO author_members VALUES(?,?,?,?)',[id,wid,i,hidden.get(wid)||0]));}
  hide(id,ids){authorId(id);this.store.db.run('BEGIN');try{for(const wid of ids)this.store.db.run('UPDATE author_members SET hidden=1 WHERE author_id=? AND work_id=?',[id,wid]);this.store.db.run('COMMIT');}catch(e){this.store.db.run('ROLLBACK');throw e;}this.store.save();}
  archive(id){const a=this.get(id);if(!a)throw Error('作者不存在');a.archived=true;this.save(a);}
  start(id,{resume=false}={}){
    const a=this.get(id);if(!a)throw new Error('请先添加作者');const accountKey=this.store.getSetting('browserAccountKey');
    if(resume){if(!a.run||a.run.status==='complete'||a.run.nextCursor===null||a.run.accountKey!==accountKey)throw new Error('当前进度无法续读，请从头读取，已有记录保留');a.run.status='running';a.run.reason='';a.run.resumed=true;this.save(a);return a;}
    this.store.db.run('BEGIN');try{this.publish(id);this.store.db.run('DELETE FROM author_scan WHERE author_id=?',[id]);this.store.db.run('DELETE FROM author_pages WHERE author_id=?',[id]);a.run={status:'running',nextCursor:'0',count:0,pages:0,accountKey,resumed:false,reason:''};this.save(a);this.store.db.run('COMMIT');return a;}catch(e){this.store.db.run('ROLLBACK');throw e;}
  }
  seen(id,cursor){return this.store.rows('SELECT 1 FROM author_pages WHERE author_id=? AND cursor=?',[id,cursor]).length>0;}
  apply(a,result,{limit=Infinity,signal}={}){
    const before=structuredClone(a),run=a.run,cursor=run.nextCursor;let taken=0,added=0,consumed=0;
    this.store.db.run('BEGIN');try{
      for(const raw of result.items){
        signal?.throwIfAborted();const w=parseWork(raw);
        if(!w||!workCreators(w).some(person=>sameCreator(person,{uid:a.uid,secUid:a.id})))throw new Error('列表含有无法核实作者的作品，本页未写入');
        const duplicate=this.store.rows('SELECT 1 FROM author_scan WHERE author_id=? AND work_id=?',[a.id,w.id]).length>0;
        if(!duplicate&&taken>=limit)break;
        const known=this.store.rows('SELECT 1 FROM author_members WHERE author_id=? AND work_id=?',[a.id,w.id]).length>0;
        this.store.upsertWork(raw);
        this.store.db.run('UPDATE author_members SET hidden=0 WHERE author_id=? AND work_id=?',[a.id,w.id]);
        if(!duplicate){this.store.db.run('INSERT INTO author_scan VALUES(?,?,?)',[a.id,w.id,run.count++]);taken++;if(!known)added++;}
        consumed++;
      }
      const entire=consumed===result.items.length;run.pages++;
      if(entire)this.store.db.run('INSERT OR IGNORE INTO author_pages VALUES(?,?)',[a.id,cursor]);
      run.nextCursor=entire?result.next:cursor;
      const complete=entire&&result.complete;
      if(complete){run.status='complete';run.nextCursor=null;this.publish(a.id);this.store.db.run('DELETE FROM author_scan WHERE author_id=?',[a.id]);this.store.db.run('DELETE FROM author_pages WHERE author_id=?',[a.id]);}
      if(!complete)this.publish(a.id);a.updatedAt=new Date().toISOString();this.save(a);this.store.db.run('COMMIT');return {taken,added,complete};
    }catch(e){this.store.db.run('ROLLBACK');Object.assign(a,before);this.store.invalidateViews();throw e;}
  }
  pause(a,reason){if(a.run.status!=='complete'){a.run.status='paused';a.run.reason=reason;this.save(a);}}
  destination(workId){const row=this.store.rows('SELECT author_id FROM author_members WHERE work_id=? UNION SELECT author_id FROM author_scan WHERE work_id=? ORDER BY author_id LIMIT 1',[workId,workId])[0];if(!row)return null;return this.collection('author:'+row.author_id);}
  collection(id){if(typeof id!=='string'||!id.startsWith('author:'))return null;const a=this.get(id.slice(7));return a?{id,name:a.name,folder:a.folder,source:'author',added:true}:null;}
  snapshot(backups=new Map(this.store.all('backup_downloads').map(d=>[d.id,d]))){
    const accountKey=this.store.getSetting('browserAccountKey'),authorMembers={},allAuthors=this.store.all('authors');
    const authors=allAuthors.filter(a=>!a.archived).map(a=>{const hidden=new Set(this.store.rows('SELECT work_id FROM author_members WHERE author_id=? AND hidden=1',[a.id]).map(r=>r.work_id));const ids=this.order(a.id).filter(id=>!hidden.has(id));authorMembers[a.id]=ids;return {...a,count:ids.length,run:a.run?{status:a.run.status,count:a.run.count,pages:a.run.pages,resumed:a.run.resumed,reason:a.run.reason,canResume:a.run.status!=='complete'&&a.run.nextCursor!==null&&a.run.accountKey===accountKey}:null};});
    const backupAuthorMembers={};
    for(const row of this.store.rows('SELECT author_id,work_id FROM author_members ORDER BY author_id,position')){const d=backups.get(row.work_id);if(!d?.assets?.length||d.backupDeleted)continue;(backupAuthorMembers[row.author_id]||=[]).push(row.work_id);}
    const backupAuthors=allAuthors.map(a=>({id:a.id,name:a.name,uid:a.uid,uniqueId:a.uniqueId,archived:!!a.archived}));
    return {authors,authorMembers,backupAuthors,backupAuthorMembers};
  }
}
