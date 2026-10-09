import {normalizeCreator,creatorKey,sameCreator,mergeCreator} from '../shared/creators.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {SqliteStore} from './sqlite-store.mjs';
import {SyncState} from './sync-state.mjs';
import {AuthorSources} from './author-sources.mjs';
import {CollectionReads} from './collection-reads.mjs';
import { TOTAL, safeName, requireInside, parseWork } from './model.mjs';
import { imageDimensions } from './media-info.mjs';
import {validHome} from '../shared/backup-protocol.mjs';
import {findDeletedDownloads} from './deleted-downloads.mjs';
import {LocalReconcile} from './local-reconcile.mjs';
import {DownloadTasks} from './download-tasks.mjs';
import {FileStates} from './file-states.mjs';
import {WorkViews} from './work-views.mjs';
import {initializeRecordJournal} from './record-journal.mjs';

export class Store {
  static async open(file, defaultRoot) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = await SqliteStore.open(file);
    const s = new Store(db, file);
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (collection_id TEXT, work_id TEXT, rank INTEGER, PRIMARY KEY(collection_id, work_id));
      CREATE TABLE IF NOT EXISTS downloads (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_downloads (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_tags (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creator_profiles (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS members_order ON members(collection_id,rank);
      CREATE TABLE IF NOT EXISTS sync_runs(collection_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_items(collection_id TEXT NOT NULL,work_id TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(collection_id,work_id));
      CREATE INDEX IF NOT EXISTS sync_items_order ON sync_items(collection_id,position);
      CREATE TABLE IF NOT EXISTS sync_pages(collection_id TEXT NOT NULL,cursor TEXT NOT NULL,PRIMARY KEY(collection_id,cursor));`);
    if (!s.getSetting('root')) s.setSetting('root', defaultRoot);
    if (!s.collection(TOTAL)) s.put('collections', TOTAL, { id: TOTAL, name: '收藏', folder: '收藏', added: true, rank: -1, count: 0 });
    s.authorSources.init();
    s.collectionReads.init();
    s.localReconcile.init();
    s.downloadTasks=new DownloadTasks(s);s.downloadTasks.init();
    s.fileStates.init();
    db.run(`CREATE INDEX IF NOT EXISTS members_work ON members(work_id,collection_id);
      CREATE INDEX IF NOT EXISTS members_display ON members(collection_id,(rank IS NULL),rank,work_id);
      CREATE INDEX IF NOT EXISTS author_members_work ON author_members(work_id,author_id);
      CREATE INDEX IF NOT EXISTS author_scan_work ON author_scan(work_id,author_id);
      CREATE INDEX IF NOT EXISTS author_scan_order ON author_scan(author_id,position);
      CREATE INDEX IF NOT EXISTS creator_profiles_sec ON creator_profiles(json_extract(body,'$.secUid'));`);
    initializeRecordJournal(s);
    db.run(`CREATE TABLE IF NOT EXISTS backup_file_hashes(file TEXT PRIMARY KEY,stamp TEXT NOT NULL,sha TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preview_file_hashes(file TEXT PRIMARY KEY,stamp TEXT NOT NULL,sha TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_hash_epoch(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);
      INSERT OR IGNORE INTO backup_hash_epoch VALUES(1,0);
      CREATE TRIGGER IF NOT EXISTS hash_epoch_insert AFTER INSERT ON backup_file_hashes BEGIN UPDATE backup_hash_epoch SET value=value+1 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS hash_epoch_update AFTER UPDATE ON backup_file_hashes BEGIN UPDATE backup_hash_epoch SET value=value+1 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS hash_epoch_delete AFTER DELETE ON backup_file_hashes BEGIN UPDATE backup_hash_epoch SET value=value+1 WHERE id=1; END;`);
    s.sync.recover();
    s.collectionReads.recover();
    s.save(); return s;
  }
  constructor(db, file) { this.db = db; this.file = file; this.viewCache=new Map();this.revision=0;this.sync=new SyncState(this);this.authorSources=new AuthorSources(this);this.collectionReads=new CollectionReads(this);this.localReconcile=new LocalReconcile(this);this.fileStates=new FileStates(this);this.lightViews=new WorkViews(this);this.db.onRollback=()=>{this.viewCache.clear();this.lightViews.rollback();this.revision++;}; }
  syncProgress(){return [...this.sync.list().filter(r=>!this.collectionReads.managed(r.collectionId)),...this.collectionReads.list()];}
  backupRevision(){return this.rows('SELECT COALESCE(MAX(seq),0) value FROM backup_changes')[0].value;}
  rows(sql, args = []) {
    return this.db.all(sql,args);
  }
  put(table, id, body) {
    this.backup?.assertWritable();const old=['collections','works','local_tags'].includes(table)?this.get(table,id):null;
    if(table==='collections'&&old&&(old.name!==body.name||old.folder!==body.folder))this.localReconcile.scope(String(id));
    this.db.run(`INSERT OR REPLACE INTO ${table} (id,body) VALUES (?,?)`, [String(id), JSON.stringify(body)]);
    if(['works','downloads','backup_downloads','local_tags'].includes(table))this.viewCache.delete(String(id));this.revision++;
    if(table==='downloads')this.fileStates.invalidate(String(id));
    this.lightViews?.invalidate(table,String(id),body);
    const metadataKeys=['name','title','caption','description','author','coAuthors','tags','rawTags','remoteState','checkedAt'];
    if(table==='local_tags'||table==='works'&&(!old||metadataKeys.some(key=>JSON.stringify(old[key])!==JSON.stringify(body[key]))))this.localReconcile.mark(String(id));
  }
  get(table, id) { const r = this.rows(`SELECT body FROM ${table} WHERE id=?`, [String(id)])[0]; return r ? JSON.parse(r.body) : null; }
  all(table) { return this.rows(`SELECT body FROM ${table}`).map(r => JSON.parse(r.body)); }
  getSetting(key) { if(key==='downloadJobs'&&this.downloadTasks)return this.downloadTasks.present?this.downloadTasks.list():null;const r = this.rows('SELECT value FROM settings WHERE key=?', [key])[0]; return r ? JSON.parse(r.value) : null; }
  setSetting(key, value) { if(key==='downloadJobs'&&this.downloadTasks){this.downloadTasks.replace(value);this.downloadTasks.flush();return;}if(JSON.stringify(this.getSetting(key))===JSON.stringify(value))return;if(this.backup&&!this.backup.localKey(key))this.backup.assertWritable();this.db.run('INSERT OR REPLACE INTO settings VALUES (?,?)', [key, JSON.stringify(value)]);if(key==='root')this.viewCache.clear();this.revision++; }
  get root() { return this.getSetting('root'); }
  collection(id) { return this.authorSources.collection(id)||this.get('collections', id); }
  work(id) { return this.get('works', id); }
  hasRead(id) { const w=this.work(id);return !!w&&!w.readHidden; }
  deleteReadRecords(ids) {
    this.db.run('BEGIN');
    try { for(const id of new Set(ids)){const w=this.work(id);if(w)this.put('works',id,{...w,readHidden:true});}this.db.run('COMMIT'); }
    catch(e){this.db.run('ROLLBACK');throw e;}
    // Keep the underlying membership and rank for the independent local library.
    this.save();
  }
  download(id) { return this.get('downloads', id); }
  forgetDownloads(ids,{localOnly=false,pruneHistory=true}={}){
    if(!localOnly)this.backup?.assertWritable();
    const removed=new Set(ids),jobs=pruneHistory?(this.getSetting('downloadJobs')||[]):[];
    let changed=false;this.db.run('BEGIN');try{
      for(const id of removed){this.db.run('DELETE FROM downloads WHERE id=?',[id]);this.viewCache.delete(id);}
      const present=new Set(pruneHistory?this.rows('SELECT id FROM downloads').map(r=>r.id):[]);
      const kept=jobs.filter(j=>!((j.state==='complete'&&!present.has(j.id))||(j.state==='failed'&&removed.has(j.id))));
      if(kept.length!==jobs.length)this.setSetting('downloadJobs',kept);
      this.db.run('COMMIT');changed=removed.size||kept.length!==jobs.length;
    }catch(e){this.db.run('ROLLBACK');throw e;}
    if(changed)this.save();
    return [...removed];
  }
  async pruneDeletedDownloads(){
    try{const removed=await findDeletedDownloads(this.all('downloads'),{probe:()=>fs.promises.stat(path.parse(path.resolve(this.root)).root),validate:dir=>this.assertDirectory(dir)});return this.forgetDownloads(removed,{localOnly:true});}catch{return [];}
  }
  save() {
    // SQLite commits directly to WAL. Never rewrite or duplicate the full file here.
    this.revision++;
    this.backup?.changed();
  }
  invalidateViews(){this.viewCache.clear();this.lightViews?.reset();this.revision++;}
  close() { void this.fileStates.close();this.save(); this.db.close(); }
  creatorProfiles(){return [...this.all('authors').map(a=>({uid:a.uid,secUid:a.id,uniqueId:a.uniqueId,nickname:a.name})),...this.all('creator_profiles')];}
  cachedCreator(person){const key=creatorKey(person);if(!key)return null;let p=this.get('creator_profiles',key);if(!p&&person.secUid)p=this.rows("SELECT body FROM creator_profiles WHERE json_extract(body,'$.secUid')=? LIMIT 1",[person.secUid]).map(r=>JSON.parse(r.body))[0];if(!p&&person.secUid){const a=this.get('authors',person.secUid);if(a)p={uid:a.uid,secUid:a.id,uniqueId:a.uniqueId,nickname:a.name};}return p&&sameCreator(person,p)?p:null;}
  rememberCreator(raw){const p=normalizeCreator(raw),key=creatorKey(p);if(!key||(!p.uid&&!p.secUid))return;const cached={...mergeCreator(this.cachedCreator(p)||{},p),fetchedAt:new Date().toISOString()};delete cached.roleTitle;this.put('creator_profiles',key,cached);const source=p.secUid?this.get('authors',p.secUid):null;if(source&&sameCreator(p,{uid:source.uid,secUid:source.id}))this.put('authors',source.id,{...source,uniqueId:p.uniqueId||source.uniqueId,name:p.nickname==='未知作者'?source.name:p.nickname});}
  upsertWork(raw,options={}) {
    const next = parseWork(raw,options); if (!next) return null;
    const old = this.work(next.id);
    if (old) {
      for (const key of ['title','caption','description','thumbnail']) if (!next[key]) next[key] = old[key];
      if (next.name === '未命名作品') next.name = old.name;
      if (!('text_extra' in raw || 'textExtra' in raw || 'cha_list' in raw || 'desc' in raw || 'caption' in raw)) { next.tags = old.tags; next.rawTags = old.rawTags; }
      next.author=mergeCreator(old.author,next.author);
      if(next.coAuthors)next.coAuthors=next.coAuthors.map(a=>{const previous=old.coAuthors?.find(p=>sameCreator(p,a));return previous?mergeCreator(previous,a):a;});
      if (!next.videoUrls.length) next.videoUrls = old.videoUrls || [];
      if (!next.coverUrls.length) { next.coverUrls = old.coverUrls || []; next.coverSource = old.coverSource; }
      if (!next.images.length && old.type === 'images') { next.images = old.images; next.type = old.type; }
      if (!next.author.uid && !next.author.secUid) next.author = old.author;
    }
    const cached=this.cachedCreator(next.author);if(cached)next.author=mergeCreator(cached,next.author);
    if(next.coAuthors)next.coAuthors=next.coAuthors.map(a=>mergeCreator(this.cachedCreator(a)||{},a));
    if(options.fullDetail&&next.author.uniqueId)this.rememberCreator(next.author);
    this.put('works', next.id, { ...old, ...next }); return this.work(next.id);
  }
  discoverCollections(list, complete = false) {
    const seen = new Set();
    list.forEach((raw, index) => {
      const id = String(raw.collects_id || ''); if (!/^\d+$/.test(id)) return;
      seen.add(id); const old = this.collection(id);
      const name = String(raw.collects_name || '未命名收藏夹');
      let folder = safeName(name, 52);
      if (folder === '收藏' || this.all('collections').some(c => c.id !== id && c.folder.toLowerCase() === folder.toLowerCase())) folder += '-' + id.slice(-6);
      if(old&&(old.name!==name||old.folder!==folder))this.localReconcile.scope(id);
      this.put('collections', id, { ...old, id, name, folder, added: old?.added || false, remoteMissing: false, count: Number(raw.total_number || 0), rank: index, discoveredAt: new Date().toISOString() });
    });
    if (complete) for (const c of this.all('collections')) if (c.id !== TOTAL && !seen.has(c.id)) this.put('collections', c.id, { ...c, remoteMissing: true });
    this.save();
  }
  setAdded(ids) {
    const collections=[...new Set(ids)].map(id=>this.get('collections',id));
    if(collections.some(c=>!c||c.remoteMissing))throw new Error('所选收藏夹已不在当前目录中，请重新读取收藏夹后再选择');
    for (const c of collections) this.put('collections', c.id, { ...c, added: true });
    this.save();
  }
  orderedMemberRows(id) {
    const rows=this.rows('SELECT work_id,rank FROM members WHERE collection_id=? ORDER BY rank IS NULL,rank,work_id',[id]);
    if(id!==TOTAL)return rows;
    // Pending total members have no confirmed total position. Use their saved
    // folder positions as a stable display order, never SQLite insertion order.
    const folders=new Map(this.all('collections').map(c=>[c.id,c]));
    const pendingOrder=new Map();
    const members=this.rows('SELECT collection_id,work_id,rank FROM members WHERE collection_id<>? AND rank IS NOT NULL',[TOTAL]);
    members.sort((a,b)=>(folders.get(a.collection_id)?.rank??0)-(folders.get(b.collection_id)?.rank??0)||a.collection_id.localeCompare(b.collection_id)||a.rank-b.rank||a.work_id.localeCompare(b.work_id));
    members.forEach((row,index)=>{if(!pendingOrder.has(row.work_id))pendingOrder.set(row.work_id,index);});
    return rows.sort((a,b)=>Number(a.rank===null)-Number(b.rank===null)||(a.rank!==null?a.rank-b.rank:(pendingOrder.get(a.work_id)??Number.MAX_SAFE_INTEGER)-(pendingOrder.get(b.work_id)??Number.MAX_SAFE_INTEGER))||a.work_id.localeCompare(b.work_id));
  }
  ingestMembers(id, ids, complete, options={}) {
    const c = this.collection(id); if (!c || !c.added) return;
    ids = [...new Set(ids)];
    const seen = new Set(ids);
    const previous = this.orderedMemberRows(id);
    const ordered = complete ? ids : [...ids, ...previous.filter(r => r.rank !== null && !seen.has(r.work_id)).map(r => r.work_id)];
    const pending = complete ? [] : previous.filter(r => r.rank === null && !seen.has(r.work_id)).map(r => r.work_id);
    this.db.run('BEGIN');
    try {
      // Each scope owns its order. A partial prefix retains the unvisited suffix without rank collisions.
      const beforeIds=new Set(previous.map(r=>r.work_id)),afterIds=new Set([...ordered,...pending]);
      for(const wid of new Set([...beforeIds,...afterIds]))if(beforeIds.has(wid)!==afterIds.has(wid))this.localReconcile.mark(wid);
      if(options.unhide!==false)for(const wid of ids){const w=this.work(wid);if(w?.readHidden)this.put('works',wid,{...w,readHidden:false});}
      this.db.run('DELETE FROM members WHERE collection_id=?', [id]);
      ordered.forEach((wid, rank) => this.db.run('INSERT INTO members VALUES (?,?,?)', [id, wid, rank]));
      pending.forEach(wid => this.db.run('INSERT INTO members VALUES (?,?,NULL)', [id, wid]));
      if (id !== TOTAL) for (const wid of ids) {
        if(!options.preserveOther)this.db.run('DELETE FROM members WHERE work_id=? AND collection_id<>? AND collection_id<>?', [wid, TOTAL, id]);
        // A folder proves total membership, but cannot establish the total's position.
        this.db.run('INSERT OR IGNORE INTO members VALUES (?,?,NULL)', [TOTAL, wid]);
      }
      this.put('collections', id, { ...c, syncedAt: new Date().toISOString(), complete, count: complete ? ids.length : Math.max(c.count || 0, ids.length), loadedCount: ids.length });
      this.setSetting('collectionMembershipRevision',Number(this.getSetting('collectionMembershipRevision')||0)+1);
      this.db.run('COMMIT');
    } catch (e) { this.db.run('ROLLBACK'); throw e; }
    this.save();
  }
  canonicalCollection(id) {
    // An existing author download keeps its location even if later collected.
    const saved=this.download(id)||this.get('backup_downloads',id);if(saved?.collectionId?.startsWith('author:')){const source=this.collection(saved.collectionId);if(source)return source;}
    for (const r of this.rows('SELECT collection_id FROM members WHERE work_id=? AND collection_id<>?', [id, TOTAL])) {
      const c = this.collection(r.collection_id); if (c?.added && !c.remoteMissing) return c;
    }
    // An archived file keeps its physical folder when a source membership disappears.
    const d = this.download(id);
    if (d?.collectionId && d.collectionId !== TOTAL) {
      const old = this.collection(d.collectionId);
      const stillCollected = this.rows('SELECT work_id FROM members WHERE collection_id=? AND work_id=?', [TOTAL, id]).length > 0;
      if (old && (old.remoteMissing || !old.complete || !stillCollected)) return old;
    }
    const collected=this.rows('SELECT 1 FROM members WHERE collection_id=? AND work_id=?',[TOTAL,id]).length>0;
    return (!collected&&!saved&&this.authorSources.destination(id))||this.collection(TOTAL);
  }
  assertDirectory(dir) {
    requireInside(this.root, dir);
    let part = path.resolve(dir), root = path.resolve(this.root);
    while (true) {
      if (fs.existsSync(part) && fs.lstatSync(part).isSymbolicLink()) throw new Error('媒体目录包含符号链接，请选择普通文件夹');
      if (part === root) break;
      const parent = path.dirname(part); if (parent === part) break; part = parent;
    }
  }
  destination(id,{owners,exists=fs.existsSync,check=true}={}) {
    const work = this.work(id); if (!work) throw new Error('作品不存在');
    const remembered=this.download(id)?.home||this.get('backup_downloads',id)?.home;
    if(remembered&&(remembered.kind==='author'||!this.download(id))){if(!validHome(remembered))throw Error('备份目录归属无效');const dir=requireInside(this.root,path.join(this.root,remembered.folder,remembered.workFolder));if(check)this.assertDirectory(dir);if(dir.length>235)throw Error('恢复路径过长，请选择更短的下载目录');return {dir,collectionId:(remembered.kind==='author'?'author:':'')+remembered.id,home:remembered};}
    const c = this.canonicalCollection(id);
    const parent = requireInside(this.root, path.join(this.root, c.folder));
    const basename = `${safeName(work.name, 52)}-${safeName(work.author.nickname, 24)}`;
    let dir = requireInside(this.root, path.join(parent, basename));
    const current = this.download(id);
    const occupied = owners ? [...(owners.get(dir.toLowerCase())||[])].some(owner=>owner!==id) : this.all('downloads').some(d => d.id !== id && path.resolve(d.path).toLowerCase() === dir.toLowerCase());
    if (occupied || (exists(dir) && path.resolve(current?.path || '.') !== dir)) dir += '-' + id;
    if (dir.length > 235) throw new Error('保存路径过长，请选择更短的下载根目录');
    if(check)this.assertDirectory(dir);
    return { dir, collectionId: c.id,home:{kind:c.id.startsWith('author:')?'author':'collection',id:c.id.startsWith('author:')?c.id.slice(7):c.id,folder:c.folder,workFolder:path.basename(dir)} };
  }
  relocate(id,context) {
    const d = this.download(id); if (!d) return;
    const target = this.destination(id,context);
    if (path.resolve(d.path) === target.dir) { this.refreshMetadata(id); return; }
    this.assertDirectory(d.path); this.assertDirectory(target.dir);
    if (fs.existsSync(d.path)) {
      fs.mkdirSync(path.dirname(target.dir), { recursive: true });
      if (fs.existsSync(target.dir)) throw new Error('目标作品目录已存在，已保留原文件，请检查同名目录');
      fs.renameSync(d.path, target.dir);
      const oldParent = path.dirname(d.path);
      if (oldParent !== this.root && fs.existsSync(oldParent) && fs.readdirSync(oldParent).length === 0) fs.rmdirSync(oldParent);
    }
    const moved={ ...d, path: target.dir, collectionId: target.collectionId,home:target.home };
    this.put('downloads', id, moved);
    this.refreshMetadata(id);
  }
  refreshMetadata(id) {
    const moved=this.download(id); if(!moved)return;
    this.assertDirectory(moved.path);
    const infoPath=path.join(moved.path,'作品信息.json');
    if(fs.existsSync(infoPath)){
      const info=JSON.parse(fs.readFileSync(infoPath,'utf8'));const w=this.work(id);
      Object.assign(info,{collection:this.collection(moved.collectionId)?.name,collectionId:moved.collectionId,author:w.author,workName:w.name,title:w.title,caption:w.caption,description:w.description,tags:w.tags,rawTags:w.rawTags,localTags:this.get('local_tags',id)?.tags||[],remoteState:w.remoteState,checkedAt:w.checkedAt});
      const text=JSON.stringify(info,null,2);
      if(fs.readFileSync(infoPath,'utf8')!==text){fs.writeFileSync(infoPath+'.part',text);fs.renameSync(infoPath+'.part',infoPath);}
      const asset=moved.assets.find(a=>a.key==='metadata');if(asset)asset.size=fs.statSync(infoPath).size;
      this.put('downloads',id,moved);
    }
  }
  reconcilePending(options){return this.localReconcile.run(options);}
  reconcile() {
    const errors = [],owners=new Map();
    for(const row of this.rows("SELECT id,json_extract(body,'$.path') path FROM downloads")){if(!row.path)continue;const key=path.resolve(row.path).toLowerCase();if(!owners.has(key))owners.set(key,new Set());owners.get(key).add(row.id);}
    for (const row of this.rows('SELECT work_id,token FROM local_reconcile')) try {const before=this.download(row.work_id)?.path;this.relocate(row.work_id,{owners});const after=this.download(row.work_id)?.path;if(before)owners.get(path.resolve(before).toLowerCase())?.delete(row.work_id);if(after){const k=path.resolve(after).toLowerCase();if(!owners.has(k))owners.set(k,new Set());owners.get(k).add(row.work_id);}this.db.run('DELETE FROM local_reconcile WHERE work_id=? AND token=?',[row.work_id,row.token]);} catch (e) { errors.push(e.message); }
    this.save(); return errors;
  }
  assetExists(d, asset) {
    try {
      this.assertDirectory(d.path);
      const file = requireInside(d.path, path.join(d.path, asset.file));
      const stat = fs.lstatSync(file);
      return !stat.isSymbolicLink() && stat.isFile() && stat.size > 0 && (!asset.size || stat.size === asset.size);
    } catch { return false; }
  }
  isDownloaded(id) {
    const d = this.download(id); if (!d || !d.assets?.length) return false;
    // A failed optional cover task in 0.3.10 must not hide otherwise complete media.
    if(d.state!=='complete')return d.hdCover?.status==='failed'&&this.work(id)?.type==='video'&&['video','cover','metadata'].every(key=>d.assets.some(a=>a.key===key&&this.assetExists(d,a)));
    return d.assets.filter(a=>!a.key.startsWith('cover-hd-')).every(a => this.assetExists(d, a));
  }
  hasSavedFiles() {
    const records=this.all('downloads');
    if(!records.length)return false;
    // An unavailable drive is not evidence that its files were deleted.
    try { if(!fs.statSync(path.parse(path.resolve(this.root)).root).isDirectory())return true; } catch { return true; }
    for(const d of records){
      try {
        this.assertDirectory(d.path);
        const pending=[d.path];
        while(pending.length){
          const dir=pending.pop();
          let stat;
          try{stat=fs.lstatSync(dir);}catch(e){if(e.code==='ENOENT')continue;throw e;}
          if(stat.isSymbolicLink()||!stat.isDirectory())return true;
          for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
            if(!entry.isDirectory()||entry.isSymbolicLink())return true;
            pending.push(path.join(dir,entry.name));
          }
        }
      } catch { return true; }
    }
    return false;
  }
  setDownloadRoot(root) {
    if(typeof root!=='string'||!root.trim())throw new Error('保存目录无效');
    const target=path.resolve(root);
    if(target===path.resolve(this.root))return this.root;
    if(this.hasSavedFiles())throw new Error('原目录仍有本地文件，或暂时无法检查。请保留当前目录，清空文件后重新检查。');
    const stat=fs.lstatSync(target);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('请选择普通文件夹作为保存目录');
    this.db.run('BEGIN');
    try {
      // These are now missing-file locations, not the independent download history.
      this.db.run('DELETE FROM downloads');
      this.setSetting('root',target);
      this.db.run('COMMIT');
    }catch(e){this.db.run('ROLLBACK');throw e;}
    this.save();return target;
  }
  snapshot({cache=false}={}) {
    if(!cache)this.viewCache.clear();
    for(const d of (this.backup&&!this.backup.canWrite())?[]:this.all('downloads')){
      let changed=false;
      for(const a of d.assets||[])if(a.kind==='image'&&a.width===undefined&&this.assetExists(d,a)){
        if(a.size>50000000)continue;
        Object.assign(a,imageDimensions(fs.readFileSync(path.join(d.path,a.file))));changed=true;
      }
      const cover=d.assets?.find(a=>a.key==='cover');
      const warning=d.hdCover?.status==='ready'?'':d.hdCover?.status==='failed'?'未取得与视频清晰度相当的封面：'+d.hdCover.message:cover?.width?`当前封面 ${cover.width}×${cover.height}，尚未与视频实际分辨率核对`:'';
      if(d.coverWarning!==warning){d.coverWarning=warning;changed=true;}
      if(changed)this.put('downloads',d.id,d);
    }
    const downloads = new Map(this.all('downloads').map(d => [d.id, d]));
    const backups = new Map(this.all('backup_downloads').map(d=>[d.id,d]));
    const localTags = new Map(this.all('local_tags').map(t => [t.id, t.tags]));
    const works = this.rows('SELECT id FROM works').map(({id}) => {
      if(this.viewCache.has(id))return this.viewCache.get(id);
      const w=this.work(id);
      const d = downloads.get(w.id);
      const view={ ...w, videoUrls: undefined, coverUrls: undefined, coverVariants: undefined, images: w.images.map(im => ({ index: im.index, width: im.width, height: im.height })), localTags: localTags.get(w.id) || [], downloaded: this.isDownloaded(w.id), local: !!d && (d.assets || []).some(a => this.assetExists(d, a)), backedUp:!!backups.get(w.id)?.assets?.length&&!backups.get(w.id).backupDeleted,backupRecord:backups.get(w.id)||null, localRecord: d ? { ...d, assets: d.assets?.map(a => ({ ...a, url: `app-media://asset/${w.id}/${encodeURIComponent(a.file)}`, exists: this.assetExists(d, a) })) } : null };
      this.viewCache.set(id,view);return view;
    });
    const collections = this.all('collections').sort((a,b) => a.rank - b.rank);
    const members = {}, pendingMembers = {},localMembers={},localPendingMembers={};
    const hidden=new Set(works.filter(w=>w.readHidden).map(w=>w.id));
    for (const c of collections) {
      const baseRows=this.orderedMemberRows(c.id);
      const rows = this.collectionReads.managed(c.id)?this.collectionReads.order(c.id,baseRows):this.sync.order(c.id,baseRows);
      localMembers[c.id]=rows.map(r=>r.work_id);
      localPendingMembers[c.id]=rows.filter(r=>r.rank===null).map(r=>r.work_id);
      members[c.id] = localMembers[c.id].filter(id=>!hidden.has(id));
      pendingMembers[c.id] = localPendingMembers[c.id].filter(id=>!hidden.has(id));
    }
    return { works, creatorProfiles:this.creatorProfiles(), collections, members, pendingMembers,localMembers,localPendingMembers,...this.authorSources.snapshot(backups),collectionReadInfo:this.collectionReads.snapshot(), readLimit:this.getSetting('readLimit')||20, rootLocked:this.hasSavedFiles(), root: this.root, account: this.getSetting('account') || (this.getSetting('sessionConnected')?{uid:'',nickname:'抖音已连接'}:null), version: '0.3.0' };
  }
}
