import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { TOTAL, safeName, requireInside, parseWork } from './model.mjs';
import { imageDimensions } from './media-info.mjs';
const require = createRequire(import.meta.url);

export class Store {
  static async open(file, defaultRoot) {
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let bytes;
    if (fs.existsSync(file)) bytes = fs.readFileSync(file);
    const db = new SQL.Database(bytes);
    const s = new Store(db, file);
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (collection_id TEXT, work_id TEXT, rank INTEGER, PRIMARY KEY(collection_id, work_id));
      CREATE TABLE IF NOT EXISTS downloads (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_tags (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS members_order ON members(collection_id,rank);`);
    if (!s.getSetting('root')) s.setSetting('root', defaultRoot);
    if (!s.collection(TOTAL)) s.put('collections', TOTAL, { id: TOTAL, name: '收藏', folder: '收藏', added: true, rank: -1, count: 0 });
    s.save(); return s;
  }
  constructor(db, file) { this.db = db; this.file = file; }
  rows(sql, args = []) {
    const stmt = this.db.prepare(sql); const out = [];
    try { stmt.bind(args); while (stmt.step()) out.push(stmt.getAsObject()); } finally { stmt.free(); }
    return out;
  }
  put(table, id, body) { this.db.run(`INSERT OR REPLACE INTO ${table} (id,body) VALUES (?,?)`, [String(id), JSON.stringify(body)]); }
  get(table, id) { const r = this.rows(`SELECT body FROM ${table} WHERE id=?`, [String(id)])[0]; return r ? JSON.parse(r.body) : null; }
  all(table) { return this.rows(`SELECT body FROM ${table}`).map(r => JSON.parse(r.body)); }
  getSetting(key) { const r = this.rows('SELECT value FROM settings WHERE key=?', [key])[0]; return r ? JSON.parse(r.value) : null; }
  setSetting(key, value) { this.db.run('INSERT OR REPLACE INTO settings VALUES (?,?)', [key, JSON.stringify(value)]); }
  get root() { return this.getSetting('root'); }
  collection(id) { return this.get('collections', id); }
  work(id) { return this.get('works', id); }
  download(id) { return this.get('downloads', id); }
  save() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, this.db.export());
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
    fs.renameSync(temp, this.file);
  }
  close() { this.save(); this.db.close(); }
  upsertWork(raw) {
    const next = parseWork(raw); if (!next) return null;
    const old = this.work(next.id);
    if (old) {
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
    this.db.run('BEGIN');
    try {
      // A partial read adds to the existing snapshot; only a complete traversal replaces it.
      if (complete) this.db.run('DELETE FROM members WHERE collection_id=?', [id]);
      ids.forEach((wid, rank) => {
        if (id !== TOTAL) this.db.run('DELETE FROM members WHERE work_id=? AND collection_id<>? AND collection_id<>?', [wid, TOTAL, id]);
        this.db.run('INSERT OR REPLACE INTO members VALUES (?,?,?)', [id, wid, rank]);
      });
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
    if (path.resolve(d.path) === target.dir) return;
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
    const infoPath=path.join(target.dir,'作品信息.json');
    if(fs.existsSync(infoPath)){
      const info=JSON.parse(fs.readFileSync(infoPath,'utf8'));const w=this.work(id);
      Object.assign(info,{collection:this.collection(target.collectionId)?.name,collectionId:target.collectionId,author:w.author,workName:w.name,title:w.title,description:w.description});
      fs.writeFileSync(infoPath+'.part',JSON.stringify(info,null,2));fs.renameSync(infoPath+'.part',infoPath);
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
  snapshot() {
    for(const d of this.all('downloads')){
      let changed=false;
      for(const a of d.assets||[])if(a.kind==='image'&&a.width===undefined&&this.assetExists(d,a)){
        if(a.size>50000000)continue;
        Object.assign(a,imageDimensions(fs.readFileSync(path.join(d.path,a.file))));changed=true;
      }
      const cover=d.assets?.find(a=>a.key==='cover');
      const warning=cover?.width&&Math.min(cover.width,cover.height)<720?`原始单图仅 ${cover.width}×${cover.height}，尚未取得更高清版本`:'';
      if(d.coverWarning!==warning){d.coverWarning=warning;changed=true;}
      if(changed)this.put('downloads',d.id,d);
    }
    const downloads = new Map(this.all('downloads').map(d => [d.id, d]));
    const localTags = new Map(this.all('local_tags').map(t => [t.id, t.tags]));
    const works = this.all('works').map(w => {
      const d = downloads.get(w.id);
      return { ...w, videoUrls: undefined, coverUrls: undefined, images: w.images.map(im => ({ index: im.index, width: im.width, height: im.height })), localTags: localTags.get(w.id) || [], downloaded: this.isDownloaded(w.id), local: !!d && (d.assets || []).some(a => this.assetExists(d, a)), localRecord: d ? { ...d, assets: d.assets?.map(a => ({ ...a, url: `app-media://asset/${w.id}/${encodeURIComponent(a.file)}`, exists: this.assetExists(d, a) })) } : null };
    });
    const collections = this.all('collections').sort((a,b) => a.rank - b.rank);
    const members = {};
    for (const c of collections) members[c.id] = this.rows('SELECT work_id FROM members WHERE collection_id=? ORDER BY rank', [c.id]).map(r => r.work_id);
    return { works, collections, members, root: this.root, account: this.getSetting('account') || (this.getSetting('sessionConnected')?{uid:'',nickname:'抖音已连接'}:null), version: '0.1.1' };
  }
}
