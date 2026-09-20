import fs from 'node:fs';
import path from 'node:path';
import {SqliteStore} from './sqlite-store.mjs';
import {SyncState} from './sync-state.mjs';
import { TOTAL, safeName, requireInside, parseWork } from './model.mjs';
import { imageDimensions } from './media-info.mjs';

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
      CREATE TABLE IF NOT EXISTS local_tags (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS members_order ON members(collection_id,rank);
      CREATE TABLE IF NOT EXISTS sync_runs(collection_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_items(collection_id TEXT NOT NULL,work_id TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(collection_id,work_id));
      CREATE INDEX IF NOT EXISTS sync_items_order ON sync_items(collection_id,position);
      CREATE TABLE IF NOT EXISTS sync_pages(collection_id TEXT NOT NULL,cursor TEXT NOT NULL,PRIMARY KEY(collection_id,cursor));`);
    if (!s.getSetting('root')) s.setSetting('root', defaultRoot);
    if (!s.collection(TOTAL)) s.put('collections', TOTAL, { id: TOTAL, name: '收藏', folder: '收藏', added: true, rank: -1, count: 0 });
    s.sync.recover();
    s.save(); return s;
  }
  constructor(db, file) { this.db = db; this.file = file; this.viewCache=new Map();this.revision=0;this.sync=new SyncState(this); }
  syncProgress(){return this.sync.list();}
  rows(sql, args = []) {
    return this.db.all(sql,args);
  }
  put(table, id, body) { this.db.run(`INSERT OR REPLACE INTO ${table} (id,body) VALUES (?,?)`, [String(id), JSON.stringify(body)]);if(['works','downloads','local_tags'].includes(table))this.viewCache.delete(String(id));this.revision++; }
  get(table, id) { const r = this.rows(`SELECT body FROM ${table} WHERE id=?`, [String(id)])[0]; return r ? JSON.parse(r.body) : null; }
  all(table) { return this.rows(`SELECT body FROM ${table}`).map(r => JSON.parse(r.body)); }
  getSetting(key) { const r = this.rows('SELECT value FROM settings WHERE key=?', [key])[0]; return r ? JSON.parse(r.value) : null; }
  setSetting(key, value) { if(JSON.stringify(this.getSetting(key))===JSON.stringify(value))return;this.db.run('INSERT OR REPLACE INTO settings VALUES (?,?)', [key, JSON.stringify(value)]);if(key==='root')this.viewCache.clear();this.revision++; }
  get root() { return this.getSetting('root'); }
  collection(id) { return this.get('collections', id); }
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
  save() {
    // SQLite commits directly to WAL. Never rewrite or duplicate the full file here.
    this.revision++;
  }
  invalidateViews(){this.viewCache.clear();this.revision++;}
  close() { this.save(); this.db.close(); }
  upsertWork(raw) {
    const next = parseWork(raw); if (!next) return null;
    const old = this.work(next.id);
    if (old) {
      for (const key of ['title','caption','description','thumbnail']) if (!next[key]) next[key] = old[key];
      if (next.name === '未命名作品') next.name = old.name;
      if (!('text_extra' in raw || 'textExtra' in raw || 'cha_list' in raw || 'desc' in raw || 'caption' in raw)) { next.tags = old.tags; next.rawTags = old.rawTags; }
      for (const key of ['uid','secUid','uniqueId','nickname']) if (!next.author[key] || next.author[key] === '未知作者') next.author[key] = old.author[key];
      if (!next.videoUrls.length) next.videoUrls = old.videoUrls || [];
      if (!next.coverUrls.length) { next.coverUrls = old.coverUrls || []; next.coverSource = old.coverSource; }
      if (!next.images.length && old.type === 'images') { next.images = old.images; next.type = old.type; }
      if (!next.author.uid && !next.author.secUid) next.author = old.author;
    }
    this.put('works', next.id, { ...old, ...next }); return next;
  }
  discoverCollections(list, complete = false) {
    const seen = new Set();
    list.forEach((raw, index) => {
      const id = String(raw.collects_id || ''); if (!/^\d+$/.test(id)) return;
      seen.add(id); const old = this.collection(id);
      const name = String(raw.collects_name || '未命名收藏夹');
      let folder = safeName(name, 52);
      if (folder === '收藏' || this.all('collections').some(c => c.id !== id && c.folder.toLowerCase() === folder.toLowerCase())) folder += '-' + id.slice(-6);
      this.put('collections', id, { ...old, id, name, folder, added: old?.added || false, remoteMissing: false, count: Number(raw.total_number || 0), rank: index, discoveredAt: new Date().toISOString() });
    });
    if (complete) for (const c of this.all('collections')) if (c.id !== TOTAL && !seen.has(c.id)) this.put('collections', c.id, { ...c, remoteMissing: true });
    this.save();
  }
  setAdded(ids) {
    for (const id of ids) { const c = this.collection(id); if (c) this.put('collections', id, { ...c, added: true }); }
    this.save();
  }
  ingestMembers(id, ids, complete) {
    const c = this.collection(id); if (!c || !c.added) return;
    ids = [...new Set(ids)];
    const seen = new Set(ids);
    const previous = this.rows('SELECT work_id,rank FROM members WHERE collection_id=? ORDER BY rank IS NULL,rank', [id]);
    const ordered = complete ? ids : [...ids, ...previous.filter(r => r.rank !== null && !seen.has(r.work_id)).map(r => r.work_id)];
    const pending = complete ? [] : previous.filter(r => r.rank === null && !seen.has(r.work_id)).map(r => r.work_id);
    this.db.run('BEGIN');
    try {
      // Each scope owns its order. A partial prefix retains the unvisited suffix without rank collisions.
      for(const wid of ids){const w=this.work(wid);if(w?.readHidden)this.put('works',wid,{...w,readHidden:false});}
      this.db.run('DELETE FROM members WHERE collection_id=?', [id]);
      ordered.forEach((wid, rank) => this.db.run('INSERT INTO members VALUES (?,?,?)', [id, wid, rank]));
      pending.forEach(wid => this.db.run('INSERT INTO members VALUES (?,?,NULL)', [id, wid]));
      if (id !== TOTAL) for (const wid of ids) {
        this.db.run('DELETE FROM members WHERE work_id=? AND collection_id<>? AND collection_id<>?', [wid, TOTAL, id]);
        // A folder proves total membership, but cannot establish the total's position.
        this.db.run('INSERT OR IGNORE INTO members VALUES (?,?,NULL)', [TOTAL, wid]);
      }
      this.put('collections', id, { ...c, syncedAt: new Date().toISOString(), complete, count: complete ? ids.length : Math.max(c.count || 0, ids.length), loadedCount: ids.length });
      this.db.run('COMMIT');
    } catch (e) { this.db.run('ROLLBACK'); throw e; }
    this.save();
  }
  canonicalCollection(id) {
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
    return this.collection(TOTAL);
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
  destination(id) {
    const work = this.work(id); if (!work) throw new Error('作品不存在');
    const c = this.canonicalCollection(id);
    const parent = requireInside(this.root, path.join(this.root, c.folder));
    const basename = `${safeName(work.name, 52)}-${safeName(work.author.nickname, 24)}`;
    let dir = requireInside(this.root, path.join(parent, basename));
    const current = this.download(id);
    const occupied = this.all('downloads').some(d => d.id !== id && path.resolve(d.path).toLowerCase() === dir.toLowerCase());
    if (occupied || (fs.existsSync(dir) && path.resolve(current?.path || '.') !== dir)) dir += '-' + id;
    if (dir.length > 235) throw new Error('保存路径过长，请选择更短的下载根目录');
    this.assertDirectory(dir);
    return { dir, collectionId: c.id };
  }
  relocate(id) {
    const d = this.download(id); if (!d) return;
    const target = this.destination(id);
    if (path.resolve(d.path) === target.dir) { this.refreshMetadata(id); return; }
    this.assertDirectory(d.path); this.assertDirectory(target.dir);
    if (fs.existsSync(d.path)) {
      fs.mkdirSync(path.dirname(target.dir), { recursive: true });
      if (fs.existsSync(target.dir)) throw new Error('目标作品目录已存在，已保留原文件，请检查同名目录');
      fs.renameSync(d.path, target.dir);
      const oldParent = path.dirname(d.path);
      if (oldParent !== this.root && fs.existsSync(oldParent) && fs.readdirSync(oldParent).length === 0) fs.rmdirSync(oldParent);
    }
    const moved={ ...d, path: target.dir, collectionId: target.collectionId };
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
  reconcile() {
    const errors = [];
    for (const d of this.all('downloads')) try { this.relocate(d.id); } catch (e) { errors.push(e.message); }
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
    const d = this.download(id); if (!d || d.state !== 'complete' || !d.assets?.length) return false;
    return d.assets.every(a => this.assetExists(d, a));
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
    for(const d of this.all('downloads')){
      let changed=false;
      for(const a of d.assets||[])if(a.kind==='image'&&a.width===undefined&&this.assetExists(d,a)){
        if(a.size>50000000)continue;
        Object.assign(a,imageDimensions(fs.readFileSync(path.join(d.path,a.file))));changed=true;
      }
      const cover=d.assets?.find(a=>a.key==='cover');
      const warning=cover?.width&&Math.min(cover.width,cover.height)<720?`当前单图仅 ${cover.width}×${cover.height}，尚未取得更高清版本`:'';
      if(d.coverWarning!==warning){d.coverWarning=warning;changed=true;}
      if(changed)this.put('downloads',d.id,d);
    }
    const downloads = new Map(this.all('downloads').map(d => [d.id, d]));
    const localTags = new Map(this.all('local_tags').map(t => [t.id, t.tags]));
    const works = this.rows('SELECT id FROM works').map(({id}) => {
      if(this.viewCache.has(id))return this.viewCache.get(id);
      const w=this.work(id);
      const d = downloads.get(w.id);
      const view={ ...w, videoUrls: undefined, coverUrls: undefined, coverVariants: undefined, images: w.images.map(im => ({ index: im.index, width: im.width, height: im.height })), localTags: localTags.get(w.id) || [], downloaded: this.isDownloaded(w.id), local: !!d && (d.assets || []).some(a => this.assetExists(d, a)), localRecord: d ? { ...d, assets: d.assets?.map(a => ({ ...a, url: `app-media://asset/${w.id}/${encodeURIComponent(a.file)}`, exists: this.assetExists(d, a) })) } : null };
      this.viewCache.set(id,view);return view;
    });
    const collections = this.all('collections').sort((a,b) => a.rank - b.rank);
    const members = {}, pendingMembers = {},localMembers={},localPendingMembers={};
    const hidden=new Set(works.filter(w=>w.readHidden).map(w=>w.id));
    for (const c of collections) {
      const rows = this.sync.order(c.id,this.rows('SELECT work_id,rank FROM members WHERE collection_id=? ORDER BY rank IS NULL,rank', [c.id]));
      localMembers[c.id]=rows.map(r=>r.work_id);
      localPendingMembers[c.id]=rows.filter(r=>r.rank===null).map(r=>r.work_id);
      members[c.id] = localMembers[c.id].filter(id=>!hidden.has(id));
      pendingMembers[c.id] = localPendingMembers[c.id].filter(id=>!hidden.has(id));
    }
    return { works, collections, members, pendingMembers,localMembers,localPendingMembers, readLimit:this.getSetting('readLimit')||20, rootLocked:this.hasSavedFiles(), root: this.root, account: this.getSetting('account') || (this.getSetting('sessionConnected')?{uid:'',nickname:'抖音已连接'}:null), version: '0.2.3' };
  }
}
