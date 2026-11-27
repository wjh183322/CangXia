import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  CURRENT_SCHEMA,
  connect,
  describe,
  inspectExisting,
  inspectLayout,
  isUuid,
  syncDirectory,
  upgradeV1,
  upgradeV2,
  upgradeV3,
  upgradeV4,
  upgradeV5,
  upgradeV6,
  upgradeV7,
  upgradeV8,
  upgradeV9,
  upgradeV10,
  upgradeV11,
  upgradeV12,
  verifyIdentity,
  writeDurably
} from './library.mjs';

export function inspectUpgrade(root, expectedId) {
  const layout = inspectLayout(root, expectedId);
  if (!layout) return { state: 'empty', from: null, to: CURRENT_SCHEMA, spaceRequired: 0 };
  return inspectExisting(layout).status;
}

function confirm({ expectedId, from, to, imageDigest, approval }) {
  if (
    !isUuid(expectedId) ||
    !Number.isInteger(from) ||
    from < 1 ||
    from >= CURRENT_SCHEMA ||
    to !== CURRENT_SCHEMA ||
    typeof imageDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(imageDigest) ||
    approval?.confirmed !== true ||
    !isUuid(approval.operationId) ||
    approval.libraryId !== expectedId ||
    approval.from !== from ||
    approval.to !== to ||
    approval.imageDigest !== imageDigest
  )
    throw Error('Explicit matching library, image and version approval is required.');
}

const tables = ['works', 'work_tags', 'source_members', 'download_jobs', 'media_files'];
function inventory(db) {
  const counts = Object.fromEntries(
    tables.map((name) => [name, db.prepare('SELECT count(*) AS n FROM ' + name).get().n])
  );
  const media = db.prepare('SELECT id,work_id,relative_path,size,sha256 FROM media_files ORDER BY id').all();
  for (const item of media) {
    if (
      !item.relative_path ||
      path.win32.isAbsolute(item.relative_path) ||
      /[\\:\x00-\x1f]/.test(item.relative_path) ||
      item.relative_path.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw Error('Media inventory contains an unsafe relative path.');
    }
  }
  return { counts, media };
}

function hashFile(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(128 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let n;
    while ((n = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, n));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

async function verifiedSnapshot(layout, status, request) {
  const parent = path.join(layout.dir, 'snapshots');
  // Each attempt owns its destination; a failure or retry never replaces a recovery point.
  const id = randomUUID();
  const stage = path.join(parent, '.pending-' + id);
  fs.mkdirSync(stage, { mode: 0o700 });
  const file = path.join(stage, 'library.sqlite');
  const owner = fs.lstatSync(stage, { bigint: true });
  function assertOwnedStage(directory = stage) {
    const current = fs.lstatSync(directory, { bigint: true });
    if (!current.isDirectory() || owner.dev !== current.dev || owner.ino !== current.ino) {
      throw Error('Private snapshot staging directory changed.');
    }
    const checked = inspectLayout(layout.root, layout.libraryId);
    if (!checked || checked.stat.dev !== layout.stat.dev || checked.stat.ino !== layout.stat.ino) {
      throw Error('Library changed during snapshot.');
    }
  }
  let source;
  try {
    source = connect(layout);
    source.exec('BEGIN');
    verifyIdentity(source, layout.libraryId);
    const expected = inventory(source);
    writeDurably(file, Buffer.alloc(0));
    await backup(source, file);
    assertOwnedStage();
    const isolated = new DatabaseSync(pathToFileURL(file).href + '?mode=rw');
    try {
      // Make the exported file self-contained even when its source is using WAL.
      if (isolated.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') {
        throw Error('Cannot make snapshot self-contained.');
      }
    } finally {
      isolated.close();
    }
    const check = new DatabaseSync(pathToFileURL(file).href + '?mode=ro&immutable=1', { readOnly: true });
    try {
      const integrity = check.prepare('PRAGMA integrity_check').all();
      if (
        integrity.length !== 1 ||
        integrity[0].integrity_check !== 'ok' ||
        check.prepare('PRAGMA foreign_key_check').get()
      )
        throw Error('Snapshot integrity or foreign key validation failed.');
      if (
        verifyIdentity(check, layout.libraryId) !== status.from ||
        JSON.stringify(inventory(check)) !== JSON.stringify(expected)
      )
        throw Error('Snapshot identity or inventory mismatch.');
    } finally {
      check.close();
    }
    const during = fs.readdirSync(stage);
    if (during.length !== 1 || during[0] !== 'library.sqlite')
      throw Error('Snapshot requires additional files.');
    const createdAt = new Date().toISOString();
    const manifest = {
      libraryId: layout.libraryId,
      from: status.from,
      to: status.to,
      imageDigest: request.imageDigest,
      operationId: request.approval.operationId,
      createdAt,
      databaseSha256: hashFile(file),
      ...expected
    };
    const body = JSON.stringify(manifest) + '\n';
    writeDurably(path.join(stage, 'manifest.json'), body);
    syncDirectory(stage);
    const published = path.join(parent, id);
    fs.renameSync(stage, published);
    syncDirectory(parent);
    const manifestSha256 = createHash('sha256').update(body).digest('hex');
    try {
      assertOwnedStage(published);
      if (
        hashFile(path.join(published, 'manifest.json')) !== manifestSha256 ||
        hashFile(path.join(published, 'library.sqlite')) !== manifest.databaseSha256
      ) {
        throw Error('Published snapshot failed checksum verification.');
      }
    } catch (error) {
      assertOwnedStage(published);
      fs.renameSync(published, stage);
      syncDirectory(parent);
      throw error;
    }
    return {
      operationId: manifest.operationId,
      libraryId: manifest.libraryId,
      from: manifest.from,
      to: manifest.to,
      imageDigest: manifest.imageDigest,
      createdAt,
      snapshot: 'snapshots/' + id,
      manifestSha256,
      verified: true
    };
  } finally {
    source?.close();
    // Only clean our private staging files. A committed recovery directory is never removed.
    if (fs.existsSync(stage)) {
      assertOwnedStage();
      for (const name of [
        'manifest.json',
        'library.sqlite-journal',
        'library.sqlite-wal',
        'library.sqlite-shm',
        'library.sqlite'
      ]) {
        fs.rmSync(path.join(stage, name), { force: true });
      }
      fs.rmdirSync(stage);
    }
  }
}

export async function applyUpgrade(input) {
  const request = structuredClone(input);
  confirm(request);
  const { root, expectedId, from, to, approval, imageDigest } = request;
  const layout = inspectLayout(root, expectedId);
  if (!layout) throw Error('Library is empty.');
  // Validate the formal catalog before opening a read/write connection.
  const { status: preview, recovery } = inspectExisting(layout);
  const writer = connect(layout, { writable: true, recovery });
  try {
    writer.exec('BEGIN IMMEDIATE');
    const status = describe(layout, writer);
    if (status.state === 'ready') {
      const row = writer
        .prepare('SELECT body FROM upgrade_receipts WHERE operation_id=?')
        .get(approval.operationId);
      const receipt = row && JSON.parse(row.body);
      if (
        !receipt ||
        receipt.operationId !== approval.operationId ||
        receipt.libraryId !== expectedId ||
        receipt.from !== from ||
        receipt.to !== to ||
        receipt.imageDigest !== imageDigest
      ) {
        throw Error('No matching completed upgrade for this approval.');
      }
      return receipt;
    }
    if (preview.from !== status.from || status.from !== from || status.to !== to)
      throw Error('Upgrade preview is stale.');
    const space = fs.statfsSync(layout.dir, { bigint: true });
    if (space.bavail * space.bsize < BigInt(status.spaceRequired))
      throw Error('Insufficient space for verified snapshot and migration.');
    const receipt = await verifiedSnapshot(layout, status, request);
    if (from === 1) writer.exec(upgradeV1);
    if (from <= 2) writer.exec(upgradeV2);
    if (from <= 3) writer.exec(upgradeV3);
    if (from <= 4) writer.exec(upgradeV4);
    if (from <= 5) writer.exec(upgradeV5);
    if (from <= 6) writer.exec(upgradeV6);
    if (from <= 7) writer.exec(upgradeV7);
    if (from <= 8) writer.exec(upgradeV8);
    if (from <= 9) writer.exec(upgradeV9);
    if (from <= 10) writer.exec(upgradeV10);
    if (from <= 11) writer.exec(upgradeV11);
    writer.exec(upgradeV12);
    writer.exec(`PRAGMA user_version=${CURRENT_SCHEMA}`);
    if (verifyIdentity(writer, expectedId) !== to) throw Error('Upgraded schema failed verification.');
    writer
      .prepare('INSERT INTO upgrade_receipts VALUES (?,?)')
      .run(approval.operationId, JSON.stringify(receipt));
    writer.exec('COMMIT');
    return receipt;
  } finally {
    try {
      if (writer.isTransaction) writer.exec('ROLLBACK');
    } finally {
      writer.close();
    }
  }
}
