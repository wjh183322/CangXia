import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect, inspectLayout, syncDirectory, verifyIdentity } from './library.mjs';

export function recordedWork(db, id) {
  const row = db.prepare('SELECT title,body FROM works WHERE id=?').get(id);
  if (!row) return null;
  const work = JSON.parse(row.body);
  const audio = db.prepare('SELECT body FROM source_audio_hints WHERE work_id=?').get(id);
  return {
    ...work,
    id,
    name: work.name || row.title,
    audioSourceHints: audio ? JSON.parse(audio.body) : null
  };
}

export function openDownloadStore({ root, library, fileHook = () => {} }) {
  const volume = inspectLayout(root, library.libraryId);
  const media = path.join(volume.dir, 'media'),
    staging = path.join(media, '.cangxia-staging');
  const layout = { root: volume.dir, media, staging };
  let created = false;
  try {
    fs.mkdirSync(staging, { mode: 0o700 });
    created = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  if (!fs.lstatSync(staging).isDirectory()) throw Error('下载暂存目录无效。');
  const lockPath = path.join(staging, 'worker.sqlite');
  if (created) fs.closeSync(fs.openSync(lockPath, 'wx', 0o600));
  const stat = fs.lstatSync(lockPath);
  if (!stat.isFile() || stat.nlink !== 1) throw Error('下载锁文件无效。');
  const pinned = [volume.dir, media, staging, lockPath, volume.file].map((file) => [
    file,
    fs.lstatSync(file, { bigint: true })
  ]);
  layout.assertCurrent = () => {
    for (const [file, before] of pinned) {
      const current = fs.lstatSync(file, { bigint: true });
      if (
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.isSymbolicLink() ||
        (!current.isDirectory() && current.nlink !== 1n)
      )
        throw Error('NAS 资料库或下载目录身份发生变化。');
    }
  };
  let lock, db;
  try {
    if (fs.readdirSync(staging).some((n) => !['commits', 'worker.sqlite'].includes(n)))
      throw Error('暂存目录中存在未知文件。');
    lock = new DatabaseSync(lockPath, { timeout: 0 });
    if (created) {
      lock.exec('CREATE TABLE owner(id TEXT PRIMARY KEY) STRICT');
      lock.prepare('INSERT INTO owner VALUES(?)').run(library.libraryId);
      syncDirectory(staging);
      syncDirectory(media);
    }
    if (lock.prepare('SELECT id FROM owner').get()?.id !== library.libraryId)
      throw Error('下载锁属于其他资料库。');
    lock.exec('BEGIN EXCLUSIVE');
    db = connect(volume, { writable: true });
    verifyIdentity(db, library.libraryId);
  } catch (e) {
    db?.close();
    lock?.close();
    throw e;
  }
  function withWrite(fn) {
    layout.assertCurrent();
    if (db.isTransaction) return fn(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } finally {
      if (db.isTransaction) db.exec('ROLLBACK');
    }
  }
  const commits = db.prepare('SELECT * FROM file_commits WHERE work_id=? ORDER BY revision');
  function decode(row) {
    return (
      row && {
        id: row.id,
        workId: row.work_id,
        resourceId: row.resource_id,
        stage: row.stage,
        body: JSON.parse(row.body),
        revision: row.revision
      }
    );
  }
  const store = {
    db,
    layout,
    fileHook,
    withWrite,
    nextRevision: () =>
      db.prepare('UPDATE download_options SET revision=revision+1 RETURNING revision').get().revision,
    work: (id) => recordedWork(db, id),
    fileCommit: (id, workId) =>
      decode(db.prepare('SELECT * FROM file_commits WHERE id=? AND work_id=?').get(id, workId)),
    fileCommits: (workId) =>
      (workId ? commits.all(workId) : db.prepare('SELECT * FROM file_commits ORDER BY revision').all()).map(
        decode
      ),
    resources: (id) => db.prepare('SELECT * FROM archive_resources WHERE work_id=? ORDER BY id').all(id),
    close() {
      db.close();
      lock.close();
    }
  };
  return store;
}
