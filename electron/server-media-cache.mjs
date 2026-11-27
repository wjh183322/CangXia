import fs from 'node:fs';
import path from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

import { CACHE_DEFAULTS, validCacheLimit } from './media-cache.mjs';
const MiB = 1048576;
const defaults = { cover: CACHE_DEFAULTS.cover, audio: CACHE_DEFAULTS.audio };
export class ServerMediaCache {
  constructor(profile) {
    this.directory = path.join(profile, 'media-cache');
    fs.mkdirSync(this.directory, { recursive: true });
    if (fs.realpathSync(this.directory) !== this.directory) throw Error('缓存目录已变化。');
    const file = path.join(this.directory, 'media.sqlite');
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw Error('缓存文件身份异常。');
    if (stat) {
      const check = new DatabaseSync(file, { readOnly: true });
      try {
        if (check.prepare('PRAGMA application_id').get().application_id !== 0x43584d43)
          throw Error('缓存位置已有其他数据库。');
      } finally {
        check.close();
      }
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA application_id=0x43584d43');
    this.db.exec(`PRAGMA auto_vacuum=FULL;
      CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY,scope TEXT NOT NULL,etag TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,touched INTEGER NOT NULL,bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS limits(scope TEXT PRIMARY KEY,size INTEGER NOT NULL);`);
    this.pins = new Map();
    this.pending = new Map();
    this.reserved = 0;
    this.overBudget = new Set();
  }
  limits() {
    return {
      ...defaults,
      ...Object.fromEntries(
        this.db
          .prepare('SELECT scope,size FROM limits')
          .all()
          .map((r) => [r.scope, r.size])
      )
    };
  }
  summary() {
    const used = { audio: 0, cover: 0, stage: this.reserved };
    for (const row of this.db.prepare('SELECT scope,sum(size) n FROM objects GROUP BY scope').all())
      used[row.scope] = row.n;
    return { used, limits: this.limits(),cleaning:!!this.cleanup };
  }
  setLimits(input) {
    for (const k of Object.keys(defaults))
      if (!validCacheLimit(input?.[k])) throw Error('缓存额度应为 16 至 16384 MiB。');
    for (const k of Object.keys(defaults)) {
      this.db.prepare('INSERT OR REPLACE INTO limits VALUES(?,?)').run(k, input[k]);
      if (this.trim(k, input[k])) this.overBudget.delete(k);
      else this.overBudget.add(k);
    }
    return this.summary();
  }
  trim(scope, limit) {
    let size = this.db.prepare('SELECT coalesce(sum(size),0) AS n FROM objects WHERE scope=?').get(scope).n;
    if (size <= limit) return true;
    for (const row of this.db
      .prepare('SELECT key,size FROM objects WHERE scope=? ORDER BY touched')
      .all(scope)) {
      if (size <= limit) break;
      if (this.pins.has(row.key)) continue;
      this.db.prepare('DELETE FROM objects WHERE key=?').run(row.key);
      size -= row.size;
    }
    return size <= limit;
  }
  clear(scopes) {
    for (const scope of scopes) if (Object.hasOwn(defaults, scope)) this.trim(scope, 0);
    return this.summary();
  }
  async clearCancellable(scopes,notify=()=>{},signal){
    if(!Array.isArray(scopes)||scopes.some(s=>!Object.hasOwn(defaults,s)))throw Error('缓存类别无效。');
    if(this.cleanup)throw Error('已有缓存清理正在进行。');
    const controller=this.cleanup=new AbortController();
    notify();
    try{
      for(const scope of new Set(scopes)){
        let after=0;
        for(;;){
          await nextTurn();
          if(controller.signal.aborted||signal?.aborted)break;
          const rows=this.db.prepare('SELECT rowid AS n,key FROM objects WHERE scope=? AND rowid>? ORDER BY rowid LIMIT 16').all(scope,after);
          for(const row of rows)if(!this.pins.has(row.key))this.db.prepare('DELETE FROM objects WHERE rowid=? AND key=?').run(row.n,row.key);
          if(rows.length<16)break;
          after=rows.at(-1).n;
        }
      }
    }finally{this.cleanup=null;notify();}
    return this.summary();
  }
  stopClear(){this.cleanup?.abort();return this.summary();}
  get(key) {
    return this.db.prepare('SELECT mime,etag,size FROM objects WHERE key=?').get(key);
  }
  reader(key, range, check) {
    this.db.prepare('UPDATE objects SET touched=? WHERE key=?').run(Date.now(), key);
    this.pins.set(key, (this.pins.get(key) || 0) + 1);
    let offset = range.start,
      done = false;
    const release = () => {
      if (done) return;
      done = true;
      const n = this.pins.get(key) - 1;
      if (n) this.pins.set(key, n);
      else {
        this.pins.delete(key);
        for (const scope of this.overBudget)
          if (this.trim(scope, this.limits()[scope])) this.overBudget.delete(scope);
      }
    };
    return new ReadableStream({
      pull: async (controller) => {
        try {
          await check();
          if (offset > range.end) {
            release();
            controller.close();
            return;
          }
          const n = Math.min(128 * 1024, range.end - offset + 1);
          const bytes = this.db
            .prepare('SELECT substr(bytes,?,?) bytes FROM objects WHERE key=?')
            .get(offset + 1, n, key)?.bytes;
          if (bytes?.length !== n) throw Error('缓存条目已变化。');
          offset += n;
          controller.enqueue(bytes);
        } catch (e) {
          release();
          controller.error(e);
        }
      },
      cancel: release
    });
  }
  reservation(key, scope, size, etag, mime) {
    if (
      !scope ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > 16 * MiB ||
      this.reserved + size > 32 * MiB ||
      this.pending.has(key) ||
      !/^"[^"]+"$/.test(etag || '')
    )
      return null;
    this.pending.set(key, true);
    this.reserved += size;
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0,
      done = false;
    const close = () => {
      if (done) return;
      done = true;
      this.pending.delete(key);
      this.reserved -= size;
    };
    return {
      append(chunk) {
        if (!done && offset + chunk.length <= size) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        } else close();
      },
      commit: () => {
        try {
          if (
            !done &&
            offset === size &&
            !this.pins.has(key) &&
            this.trim(scope, this.limits()[scope] - size)
          )
            this.db
              .prepare('INSERT OR REPLACE INTO objects VALUES(?,?,?,?,?,?,?)')
              .run(key, scope, etag, mime, size, Date.now(), bytes);
        } finally {
          close();
        }
      },
      close
    };
  }
}
