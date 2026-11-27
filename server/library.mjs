import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serverIdentity } from '../shared/server-identity.mjs';

export const APP_ID = serverIdentity.appId;
export const APPLICATION_ID = 0x43585346;
export const CURRENT_SCHEMA = 15;
export const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

const v1 = fs.readFileSync(new URL('./schema/v1.sql', import.meta.url), 'utf8');
export const upgradeV1 = `
  CREATE TABLE upgrade_receipts (
    operation_id TEXT PRIMARY KEY,
    body TEXT NOT NULL CHECK(json_valid(body))
  ) STRICT;
  CREATE UNIQUE INDEX media_file_location ON media_files(relative_path);
`;
export const upgradeV2 = fs.readFileSync(new URL('./schema/v3.sql', import.meta.url), 'utf8');
export const upgradeV3 = fs.readFileSync(new URL('./schema/v4.sql', import.meta.url), 'utf8');
export const upgradeV4 = 'ALTER TABLE source_account ADD COLUMN profile_id TEXT';
export const upgradeV5 = fs.readFileSync(new URL('./schema/v6.sql', import.meta.url), 'utf8');
export const upgradeV6 = fs.readFileSync(new URL('./schema/v7.sql', import.meta.url), 'utf8');
export const upgradeV7 = fs.readFileSync(new URL('./schema/v8.sql', import.meta.url), 'utf8');
export const upgradeV8 = fs.readFileSync(new URL('./schema/v9.sql', import.meta.url), 'utf8');
export const upgradeV9 = fs.readFileSync(new URL('./schema/v10.sql', import.meta.url), 'utf8');
export const upgradeV10 = fs.readFileSync(new URL('./schema/v11.sql', import.meta.url), 'utf8');
export const upgradeV11 = fs.readFileSync(new URL('./schema/v12.sql', import.meta.url), 'utf8');
export const upgradeV12 = fs.readFileSync(new URL('./schema/v13.sql', import.meta.url), 'utf8');
export const upgradeV13 = fs.readFileSync(new URL('./schema/v14.sql', import.meta.url), 'utf8');
export const upgradeV14 = fs.readFileSync(new URL('./schema/v15.sql', import.meta.url), 'utf8');
const catalog = (db) =>
  db
    .prepare(
      `
  SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name
`
    )
    .all();
const reference = new DatabaseSync(':memory:');
reference.exec(v1);
const schemas = new Map([[1, JSON.stringify(catalog(reference))]]);
reference.exec(upgradeV1);
schemas.set(2, JSON.stringify(catalog(reference)));
reference.exec(upgradeV2);
schemas.set(3, JSON.stringify(catalog(reference)));
reference.exec(upgradeV3);
schemas.set(4, JSON.stringify(catalog(reference)));
reference.exec(upgradeV4);
schemas.set(5, JSON.stringify(catalog(reference)));
reference.exec(upgradeV5);
schemas.set(6, JSON.stringify(catalog(reference)));
reference.exec(upgradeV6);
schemas.set(7, JSON.stringify(catalog(reference)));
reference.exec(upgradeV7);
schemas.set(8, JSON.stringify(catalog(reference)));
reference.exec(upgradeV8);
schemas.set(9, JSON.stringify(catalog(reference)));
reference.exec(upgradeV9);
schemas.set(10, JSON.stringify(catalog(reference)));
reference.exec(upgradeV10);
schemas.set(11, JSON.stringify(catalog(reference)));
reference.exec(upgradeV11);
schemas.set(12, JSON.stringify(catalog(reference)));
reference.exec(upgradeV12);
schemas.set(13, JSON.stringify(catalog(reference)));
reference.exec(upgradeV13);
schemas.set(14, JSON.stringify(catalog(reference)));
reference.exec(upgradeV14);
schemas.set(15, JSON.stringify(catalog(reference)));
reference.close();

const foreign = () => Error('The mounted volume or database does not match the formal library.');
const unsafe = () => Error('Unsafe library path or unexpected filesystem entry.');
function directory(file) {
  if (!fs.lstatSync(file).isDirectory()) throw unsafe();
}
function regular(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n) throw unsafe();
  return stat;
}
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}
function entries(root) {
  if (
    typeof root !== 'string' ||
    !path.isAbsolute(root) ||
    path.normalize(root) !== root ||
    path.dirname(root) === root
  )
    throw unsafe();
  for (let dir = root; path.dirname(dir) !== dir; dir = path.dirname(dir)) directory(dir);
  return fs.readdirSync(root);
}

export function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, fs.constants.O_DIRECTORY | fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function writeDurably(file, body) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function inspectLayout(root, expectedId) {
  if (expectedId !== undefined && !isUuid(expectedId)) throw foreign();
  const names = entries(root);
  if (!names.length) return null;
  if (names.length !== 1 || names[0] !== 'cangxia-server') throw foreign();
  const dir = path.join(root, 'cangxia-server');
  directory(dir);
  const file = path.join(dir, 'library.sqlite');
  const allowed = [
    'identity.json',
    'library.sqlite',
    'library.sqlite-journal',
    'library.sqlite-wal',
    'library.sqlite-shm',
    'source-session',
    'snapshots',
    'media'
  ];
  let contents = fs.readdirSync(dir);
  // Windows can briefly list this temporary name just after SQLite closes its WAL sidecars.
  // Require a clean enumeration before opening the volume. Never open or remove the unknown entry.
  if (
    process.platform === 'win32' &&
    contents.some((name) => name.toLowerCase() === 'library.sqlite-shm.tmp')
  ) {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (
      let attempt = 0;
      attempt < 20 && contents.some((name) => name.toLowerCase() === 'library.sqlite-shm.tmp');
      attempt++
    ) {
      Atomics.wait(wait, 0, 0, 10);
      contents = fs.readdirSync(dir);
    }
  }
  for (const name of contents) {
    if (!allowed.includes(name)) throw unsafe();
    if (name === 'snapshots' || name === 'media' || name === 'source-session')
      directory(path.join(dir, name));
    else regular(path.join(dir, name));
  }
  if (!['media', 'snapshots', 'identity.json', 'library.sqlite'].every((name) => contents.includes(name)))
    throw foreign();
  const snapshots = path.join(dir, 'snapshots');
  for (const name of fs.readdirSync(snapshots)) {
    const pending = name.startsWith('.pending-');
    if (!isUuid(pending ? name.slice(9) : name)) throw unsafe();
    const snapshot = path.join(snapshots, name);
    directory(snapshot);
    const allowedFiles = pending
      ? [
          'manifest.json',
          'library.sqlite',
          'library.sqlite-journal',
          'library.sqlite-wal',
          'library.sqlite-shm'
        ]
      : ['manifest.json', 'library.sqlite'];
    for (const file of fs.readdirSync(snapshot)) {
      if (!allowedFiles.includes(file)) throw unsafe();
      regular(path.join(snapshot, file));
    }
  }
  const markerFile = path.join(dir, 'identity.json');
  if (regular(markerFile).size > 1024n) throw foreign();
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  if (
    marker?.appId !== APP_ID ||
    !isUuid(marker.libraryId) ||
    Object.keys(marker).some((key) => !['appId', 'libraryId', 'requiredWal'].includes(key)) ||
    ('requiredWal' in marker && typeof marker.requiredWal !== 'boolean') ||
    (expectedId !== undefined && expectedId !== marker.libraryId)
  )
    throw foreign();
  const hasWal = contents.includes('library.sqlite-wal');
  if (
    (marker.requiredWal && (!hasWal || regular(file + '-wal').size < 56n)) ||
    (!hasWal && contents.includes('library.sqlite-shm'))
  )
    throw Error('Required SQLite WAL is missing.');
  if (marker.requiredWal) {
    // This is external restore evidence. Without a manifest binding the bytes,
    // an arbitrary replacement sidecar cannot establish a complete library.
    throw Error('Detached WAL-dependent copy requires verified restoration to a separate volume.');
  }
  const stat = regular(file);
  return {
    root,
    dir,
    file,
    stat,
    libraryId: marker.libraryId,
    journal: contents.includes('library.sqlite-journal') ? regular(file + '-journal') : null
  };
}

export function verifyIdentity(db, id) {
  const application = db.prepare('PRAGMA application_id').get().application_id;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (
    application !== APPLICATION_ID ||
    !schemas.has(version) ||
    JSON.stringify(catalog(db)) !== schemas.get(version)
  )
    throw foreign();
  const identity = db.prepare('SELECT app_id,library_id FROM library_identity WHERE singleton=1').get();
  if (identity?.app_id !== APP_ID || identity.library_id !== id) throw foreign();
  return version;
}

function fingerprint(stat) {
  return stat && [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
export function recoveryFingerprint(layout) {
  return [fingerprint(layout.stat), fingerprint(layout.journal)].join('/');
}
export function connect(layout, { writable = false, recovery = null } = {}) {
  const checked = inspectLayout(layout.root, layout.libraryId);
  if (!checked || !sameFile(checked.stat, layout.stat)) throw unsafe();
  const uri = pathToFileURL(layout.file).href;
  if (writable && recovery && recoveryFingerprint(checked) !== recovery) {
    throw Error('Rollback journal changed after isolated recovery verification.');
  }
  if (writable && checked.journal && !recovery) {
    // A journal appeared after preview. A hot one must pass the independent rehearsal.
    const guard = new DatabaseSync(uri + '?mode=ro', { readOnly: true, timeout: 0 });
    try {
      guard.exec('BEGIN');
      verifyIdentity(guard, layout.libraryId);
    } finally {
      guard.close();
    }
  }
  const db = new DatabaseSync(uri + (writable ? '?mode=rw' : '?mode=ro'), {
    readOnly: !writable,
    timeout: 0
  });
  try {
    if (!sameFile(regular(layout.file), layout.stat)) throw unsafe();
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON');
    if (writable) db.exec('PRAGMA synchronous=FULL');
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

export function describe(layout, db) {
  const from = verifyIdentity(db, layout.libraryId);
  if (from === CURRENT_SCHEMA)
    return { state: 'ready', libraryId: layout.libraryId, from, to: CURRENT_SCHEMA, spaceRequired: 0 };
  const pages = db.prepare('PRAGMA page_count').get().page_count;
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  return {
    state: 'migration-required',
    libraryId: layout.libraryId,
    from,
    to: CURRENT_SCHEMA,
    spaceRequired: pages * pageSize * 4 + 1048576,
    reason:
      from === 13 ? '建立删除范围、回收站验证及逐项恢复回执。' : from === 9 ? '保存 NAS 下载队列、资源清单及可恢复的文件提交记录。' : from === 7
        ? '保存用户选择的续读来源及每轮当时的历史数量。旧日志缺失的累计数量保留为未知。'
        : '建立独立来源排序、归属移除版本、恢复明细、来源读取断点、指定来源续读和当轮计数。版本 1 的升级另建立路径唯一约束及升级回执。',
    impact: '只修改数据库结构，归档媒体保持原位。',
    rollback: '先保全快照之后的新增资料，再用匹配的旧程序在独立目录验证快照与媒体清单，确认后切换。'
  };
}

export function inspectExisting(layout) {
  let db;
  try {
    db = connect(layout);
    db.exec('BEGIN');
    return { status: describe(layout, db), recovery: null };
  } catch (error) {
    // SQLITE_READONLY_ROLLBACK means SQLite identified a hot journal. Only an
    // isolated copy is allowed to roll back before the stored identity is proven.
    if (error.errcode !== 776 || !layout.journal) throw error;
  } finally {
    db?.close();
  }
  const recovery = recoveryFingerprint(layout);
  const helper = fileURLToPath(new URL('./rehearse-rollback.mjs', import.meta.url));
  const result = execFileSync(process.execPath, [helper, layout.root, layout.libraryId, recovery], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return { status: JSON.parse(result), recovery };
}

function initialize(root, id) {
  if (entries(root).length) throw Error('Explicit initialization requires an empty directory.');
  if (!isUuid(id)) throw foreign();
  const stage = path.join(root, '.cangxia-initializing');
  fs.mkdirSync(stage, { mode: 0o700 });
  const names = entries(root);
  if (names.length !== 1 || names[0] !== '.cangxia-initializing') throw unsafe();
  const file = path.join(stage, 'library.sqlite');
  writeDurably(file, Buffer.alloc(0));
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    db.exec(v1);
    db.exec(upgradeV1);
    db.exec(upgradeV2);
    db.exec(upgradeV3);
    db.exec(upgradeV4);
    db.exec(upgradeV5);
    db.exec(upgradeV6);
    db.exec(upgradeV7);
    db.exec(upgradeV8);
    db.exec(upgradeV9);
    db.exec(upgradeV10);
    db.exec(upgradeV11);
    db.exec(upgradeV12);
    db.exec(upgradeV13);
    db.exec(upgradeV14);
    db.prepare('INSERT INTO library_identity VALUES (1,?,?)').run(APP_ID, id);
    db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${CURRENT_SCHEMA}; COMMIT`);
    if (db.prepare('PRAGMA journal_mode=WAL').get().journal_mode !== 'wal') throw Error('WAL unavailable.');
  } finally {
    db.close();
  }
  writeDurably(path.join(stage, 'identity.json'), JSON.stringify({ appId: APP_ID, libraryId: id }) + '\n');
  for (const name of ['media', 'snapshots']) fs.mkdirSync(path.join(stage, name), { mode: 0o700 });
  syncDirectory(stage);
  if (entries(root).length !== 1) throw unsafe();
  fs.renameSync(stage, path.join(root, 'cangxia-server'));
  syncDirectory(root);
}

// A callback is one synchronous safe boundary. Writers across workers/processes
// contend for the same SQLite reservation as an approved schema migration.
export function openLibrary({ root, expectedId, mode = 'open' }) {
  if (!['open', 'init'].includes(mode)) throw Error('Unknown library open mode.');
  if (mode === 'init') initialize(root, expectedId === undefined ? randomUUID() : expectedId);
  const layout = inspectLayout(root, expectedId);
  if (!layout) throw Error('Library is empty. Explicit initialization is required.');
  const { status, recovery } = inspectExisting(layout);
  if (status.state !== 'ready') return Object.freeze(status);
  for (const target of [
    layout.file,
    layout.dir,
    path.join(layout.dir, 'media'),
    path.join(layout.dir, 'snapshots')
  ]) {
    fs.accessSync(target, fs.constants.W_OK);
  }
  const check = connect(layout, { writable: true, recovery });
  try {
    check.exec('BEGIN IMMEDIATE');
    if (verifyIdentity(check, layout.libraryId) !== CURRENT_SCHEMA) throw foreign();
    // SQLite distinguishes writable and read-only handles even with zero matched rows.
    check.exec('UPDATE library_identity SET app_id=app_id WHERE 0; ROLLBACK');
  } finally {
    check.close();
  }
  let closed = false;
  function access(writable, callback) {
    if (closed) throw Error('Library is closed.');
    if (typeof callback !== 'function' || callback.constructor.name === 'AsyncFunction') {
      throw Error('Library transactions require a synchronous callback.');
    }
    const db = connect(layout, { writable });
    try {
      db.exec(writable ? 'BEGIN IMMEDIATE' : 'BEGIN');
      if (verifyIdentity(db, layout.libraryId) !== CURRENT_SCHEMA) throw foreign();
      const value = callback(db);
      if (value && typeof value.then === 'function') throw Error('Library transactions must be synchronous.');
      db.exec('COMMIT');
      return value;
    } finally {
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } finally {
        db.close();
      }
    }
  }
  return Object.freeze({
    ...status,
    read: (fn) => access(false, fn),
    write: (fn) => access(true, fn),
    close() {
      closed = true;
    }
  });
}
