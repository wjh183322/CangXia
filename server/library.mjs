import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { serverIdentity } from '../shared/server-identity.mjs';

export const APP_ID = serverIdentity.appId;
export const APPLICATION_ID = 0x43585346;
export const CURRENT_SCHEMA = 2;
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
    'snapshots',
    'media'
  ];
  const contents = fs.readdirSync(dir);
  for (const name of contents) {
    if (!allowed.includes(name)) throw unsafe();
    if (name === 'snapshots' || name === 'media') directory(path.join(dir, name));
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
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const header = Buffer.alloc(100);
    if (
      !sameFile(fs.fstatSync(fd, { bigint: true }), stat) ||
      fs.readSync(fd, header, 0, header.length, 0) !== header.length ||
      header.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0' ||
      header.readUInt32BE(68) !== APPLICATION_ID
    )
      throw foreign();
  } finally {
    fs.closeSync(fd);
  }
  return {
    root,
    dir,
    file,
    stat,
    libraryId: marker.libraryId,
    hasWal,
    hasJournal: contents.includes('library.sqlite-journal')
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

export function connect(layout, { writable = false, immutable = false } = {}) {
  const checked = inspectLayout(layout.root, layout.libraryId);
  if (!checked || !sameFile(checked.stat, layout.stat)) throw unsafe();
  const uri = pathToFileURL(layout.file).href;
  const cold = immutable && !checked.hasWal && !checked.hasJournal;
  const db = new DatabaseSync(uri + (writable ? '?mode=rw' : '?mode=ro' + (cold ? '&immutable=1' : '')), {
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
    reason: '建立文件路径唯一约束，保存升级回执。',
    impact: '只修改数据库结构，归档媒体保持原位。',
    rollback: '先保全快照之后的新增资料，再用匹配的旧程序在独立目录验证快照与媒体清单，确认后切换。'
  };
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
  const inspection = connect(layout, { immutable: true });
  let status;
  try {
    status = describe(layout, inspection);
  } finally {
    inspection.close();
  }
  if (status.state !== 'ready') return Object.freeze(status);
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
