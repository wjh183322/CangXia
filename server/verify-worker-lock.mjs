import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

// Inspect only the known application's lock DB. Other staging files are recovery evidence.
function ownWorkerFile(file, libraryId) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) return false;
  let db;
  try {
    db = new DatabaseSync(pathToFileURL(file).href + '?mode=ro&immutable=1', { readOnly: true });
    db.exec('PRAGMA trusted_schema=OFF');
    const schema = db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type').all();
    if (
      schema.length !== 2 ||
      schema[0].type !== 'index' ||
      schema[0].name !== 'sqlite_autoindex_owner_1' ||
      schema[0].sql !== null ||
      schema[1].type !== 'table' ||
      schema[1].name !== 'owner' ||
      schema[1].sql !== 'CREATE TABLE owner(id TEXT PRIMARY KEY) STRICT'
    )
      return false;
    if (
      db.prepare('PRAGMA freelist_count').get().freelist_count !== 0 ||
      db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size !==
        stat.size
    )
      return false;
    const rows = db.prepare('SELECT id FROM owner LIMIT 2').all();
    return (
      rows.length === 1 &&
      rows[0].id === libraryId &&
      db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok'
    );
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
process.exitCode = ownWorkerFile(process.argv[2], process.argv[3]) ? 0 : 2;
