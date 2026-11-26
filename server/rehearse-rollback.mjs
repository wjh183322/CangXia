import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { APPLICATION_ID, APP_ID, describe, inspectLayout, recoveryFingerprint } from './library.mjs';

// This separate process owns no live SQLite handles. Closing the copy source
// descriptor here cannot release the server process's POSIX SQLite locks.
function rehearse(root, libraryId, expected) {
  const layout = inspectLayout(root, libraryId);
  if (!layout?.journal || recoveryFingerprint(layout) !== expected) throw Error('Rollback input changed.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cangxia-rollback-'));
  try {
    const copy = path.join(scratch, 'library.sqlite');
    fs.copyFileSync(layout.file, copy, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(layout.file + '-journal', copy + '-journal', fs.constants.COPYFILE_EXCL);
    if (recoveryFingerprint(inspectLayout(root, libraryId)) !== expected)
      throw Error('Rollback input changed.');
    // Formal writers never ATTACH a second database. Reject a super-journal
    // pointer so SQLite cannot follow or remove a path outside this copy.
    const journal = fs.openSync(copy + '-journal', 'r');
    try {
      const tail = Buffer.alloc(8);
      const offset = fs.fstatSync(journal).size - tail.length;
      if (
        offset < 0 ||
        fs.readSync(journal, tail, 0, tail.length, offset) !== tail.length ||
        tail.equals(Buffer.from('d9d505f920a163d7', 'hex'))
      )
        throw Error('Unsupported rollback journal.');
    } finally {
      fs.closeSync(journal);
    }
    const uri = pathToFileURL(copy).href;
    // Pin the identity of the base itself as well as the recovered catalog.
    // Only this detached copy may be examined ignoring its journal.
    const base = new DatabaseSync(uri + '?mode=ro&immutable=1', { readOnly: true });
    try {
      base.exec('PRAGMA trusted_schema=OFF');
      if (
        base.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID ||
        base.prepare("SELECT type FROM sqlite_schema WHERE name='library_identity'").get()?.type !== 'table'
      ) {
        throw Error('Foreign rollback base.');
      }
      const row = base.prepare('SELECT app_id,library_id FROM library_identity WHERE singleton=1').get();
      if (row?.app_id !== APP_ID || row.library_id !== libraryId)
        throw Error('Foreign rollback base identity.');
    } finally {
      base.close();
    }
    const db = new DatabaseSync(uri + '?mode=rw');
    try {
      db.exec('PRAGMA trusted_schema=OFF; BEGIN');
      const status = describe(layout, db);
      const integrity = db.prepare('PRAGMA integrity_check').all();
      if (
        integrity.length !== 1 ||
        integrity[0].integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get()
      ) {
        throw Error('Rollback rehearsal failed integrity verification.');
      }
      return status;
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  console.log(JSON.stringify(rehearse(...process.argv.slice(2))));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
