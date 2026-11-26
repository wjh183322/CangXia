import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openLibrary } from '../../server/library.mjs';
import { inspectUpgrade, applyUpgrade } from '../../server/upgrade.mjs';

const entry = fileURLToPath(new URL('../../server/start.mjs', import.meta.url));
const v1 = new URL('../../server/schema/v1.sql', import.meta.url);
const imageDigest = 'sha256:' + 'b'.repeat(64);
const digest = (data) => createHash('sha256').update(data).digest('hex');
const dbFile = (root) => path.join(root, 'cangxia-server', 'library.sqlite');
const owner = (root) => path.join(root, 'cangxia-server', 'identity.json');
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cangxia-formal-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}
function command(root, expectedId) {
  return {
    root,
    expectedId,
    from: 1,
    to: 2,
    imageDigest,
    approval: {
      confirmed: true,
      operationId: randomUUID(),
      libraryId: expectedId,
      from: 1,
      to: 2,
      imageDigest
    }
  };
}
function cli(...args) {
  return JSON.parse(
    execFileSync(process.execPath, [entry, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  );
}
function oldLibrary(t) {
  const root = temporary(t),
    libraryId = randomUUID(),
    data = path.dirname(dbFile(root));
  fs.mkdirSync(data);
  for (const name of ['media', 'snapshots']) fs.mkdirSync(path.join(data, name));
  fs.writeFileSync(owner(root), JSON.stringify({ appId: 'local.cangxia.server', libraryId }));
  const db = new DatabaseSync(dbFile(root));
  db.exec(fs.readFileSync(v1, 'utf8'));
  db.exec('PRAGMA application_id=0x43585346; PRAGMA user_version=1');
  db.prepare('INSERT INTO library_identity VALUES (1,?,?)').run('local.cangxia.server', libraryId);
  db.exec(`INSERT INTO works VALUES ('9007199254740993123','A','{}'),('9007199254740993124','B','{}');
    INSERT INTO work_tags VALUES ('9007199254740993123','旅行');
    INSERT INTO source_members VALUES ('folder:1','9007199254740993123',2),('total','9007199254740993123',7);
    INSERT INTO download_jobs VALUES ('job-1','9007199254740993124','queued');`);
  const bytes = Buffer.from('sample media bytes');
  fs.writeFileSync(path.join(data, 'media', 'photo.jpg'), bytes);
  db.prepare('INSERT INTO media_files VALUES (?,?,?,?,?)').run(
    'm1',
    '9007199254740993123',
    'photo.jpg',
    bytes.length,
    digest(bytes)
  );
  db.close();
  return { root, libraryId };
}

test('explicit clean init is the sole bootstrap path, normal CLI starts perform no migration', (t) => {
  const root = temporary(t);
  assert.equal(cli('inspect', '--root', root).state, 'empty');
  assert.throws(() => cli('start', '--root', root));
  assert.deepEqual(fs.readdirSync(root), []);
  const { libraryId, state } = cli('init', '--root', root);
  assert.equal(state, 'ready');
  assert.match(libraryId, /^[0-9a-f-]{36}$/);
  const before = fs.readFileSync(dbFile(root));
  assert.equal(cli('start', '--root', root, '--library-id', libraryId).state, 'ready');
  assert.throws(() => cli('init', '--root', root));
  assert.throws(() => cli('start', '--root', root, '--library-id', randomUUID()));
  assert.deepEqual(fs.readFileSync(dbFile(root)), before);
  const handle = openLibrary({ root, expectedId: libraryId });
  handle.write((db) => db.prepare('INSERT INTO works VALUES (?,?,?)').run('1', 'works', '{}'));
  assert.throws(() =>
    handle.write((db) => {
      db.exec('DELETE FROM works');
      throw Error('cancel');
    })
  );
  assert.equal(
    handle.read((db) => db.prepare('SELECT title FROM works').get().title),
    'works'
  );
  handle.close();
});

test('foreign files, backup and probe volumes, hardlinked databases, and symlinked ancestors fail closed', (t) => {
  for (const name of ['old-backup.sqlite', '.feasibility-probe', 'foreign.txt']) {
    const root = temporary(t);
    fs.writeFileSync(path.join(root, name), 'original');
    assert.throws(() => openLibrary({ root, mode: 'init' }));
    assert.deepEqual(fs.readdirSync(root), [name]);
    assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), 'original');
  }
  const { root, libraryId } = oldLibrary(t);
  const other = temporary(t);
  fs.linkSync(dbFile(root), path.join(other, 'foreign.db'));
  assert.throws(() => inspectUpgrade(root));
  fs.unlinkSync(path.join(other, 'foreign.db'));
  const alias = path.join(other, 'alias');
  fs.symlinkSync(root, alias, 'junction');
  assert.throws(() => openLibrary({ root: alias, expectedId: libraryId }));
  for (const appId of [0, 0x43585042]) {
    const db = new DatabaseSync(dbFile(root));
    db.exec('PRAGMA application_id=' + appId);
    db.close();
    const before = fs.readFileSync(dbFile(root));
    assert.throws(() => inspectUpgrade(root));
    assert.deepEqual(fs.readFileSync(dbFile(root)), before);
  }
});

test('startup and bad confirmations leave an existing old library byte-for-byte intact', async (t) => {
  const { root, libraryId } = oldLibrary(t);
  const before = fs.readFileSync(dbFile(root));
  const unapproved = cli('start', '--root', root, '--library-id', libraryId);
  assert.equal(unapproved.state, 'migration-required');
  assert.equal(unapproved.from, 1);
  assert.equal(unapproved.to, 2);
  assert.ok(unapproved.spaceRequired >= before.length);
  assert.ok(unapproved.reason && unapproved.impact && unapproved.rollback);
  assert.throws(() => openLibrary({ root, expectedId: libraryId }).write(() => {}));
  const valid = command(root, libraryId);
  for (const approval of [
    null,
    true,
    {},
    { ...valid.approval, confirmed: false },
    { ...valid.approval, libraryId: randomUUID() },
    { ...valid.approval, to: 3 },
    { ...valid.approval, from: 2 },
    { ...valid.approval, imageDigest: 'other' }
  ]) {
    await assert.rejects(applyUpgrade({ ...valid, approval }));
  }
  assert.deepEqual(fs.readFileSync(dbFile(root)), before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'cangxia-server', 'snapshots')), []);
});

test('online snapshot and durable retry receipt include committed WAL rows and media inventory', async (t) => {
  const { root, libraryId } = oldLibrary(t);
  const db = new DatabaseSync(dbFile(root));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO works VALUES ('wal-only','WAL','{}')"
    );
    assert.ok(fs.statSync(dbFile(root) + '-wal').size > 32);
    const req = command(root, libraryId);
    const receipt = await applyUpgrade(req);
    assert.equal(receipt.libraryId, libraryId);
    assert.equal(receipt.imageDigest, imageDigest);
    const directory = path.join(root, 'cangxia-server', receipt.snapshot);
    const snap = new DatabaseSync(path.join(directory, 'library.sqlite'), { readOnly: true });
    assert.equal(snap.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(snap.prepare("SELECT title FROM works WHERE id='wal-only'").get().title, 'WAL');
    snap.close();
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
    assert.deepEqual(manifest.counts, {
      works: 3,
      work_tags: 1,
      source_members: 2,
      download_jobs: 1,
      media_files: 1
    });
    assert.deepEqual(manifest.media, [
      {
        id: 'm1',
        work_id: '9007199254740993123',
        relative_path: 'photo.jpg',
        size: 18,
        sha256: digest('sample media bytes')
      }
    ]);
    assert.equal(manifest.databaseSha256, digest(fs.readFileSync(path.join(directory, 'library.sqlite'))));
    assert.equal(receipt.manifestSha256, digest(fs.readFileSync(path.join(directory, 'manifest.json'))));
    assert.equal(inspectUpgrade(root).state, 'ready');
    const replay = cli(
      'upgrade',
      '--root',
      root,
      '--library-id',
      libraryId,
      '--from',
      '1',
      '--to',
      '2',
      '--image-digest',
      imageDigest,
      '--approval',
      JSON.stringify(req.approval)
    );
    assert.deepEqual(replay, receipt);
    await assert.rejects(applyUpgrade(command(root, libraryId)));
    assert.equal(fs.readdirSync(path.dirname(directory)).length, 1);
    assert.equal(
      fs.readFileSync(path.join(root, 'cangxia-server', 'media', 'photo.jpg'), 'utf8'),
      'sample media bytes'
    );
  } finally {
    db.close();
  }
});

test('a writer at an unsafe boundary blocks migration; a transaction and peer approval cannot enter during backup', async (t) => {
  const { root, libraryId } = oldLibrary(t);
  const writer = new DatabaseSync(dbFile(root));
  try {
    writer.exec('BEGIN IMMEDIATE');
    const req = command(root, libraryId);
    await assert.rejects(applyUpgrade(req));
    assert.deepEqual(fs.readdirSync(path.join(root, 'cangxia-server', 'snapshots')), []);
    writer.exec('ROLLBACK');
    const pending = applyUpgrade(req);
    assert.throws(() => writer.exec("INSERT INTO works VALUES ('race','late','{}')"), /locked|busy/i);
    await assert.rejects(applyUpgrade(command(root, libraryId)));
    await pending;
    assert.equal(writer.prepare('SELECT count(*) AS n FROM works').get().n, 2);
  } finally {
    writer.close();
  }
});

test('snapshot validation and migration failures keep old version and all original data', async (t) => {
  for (const failure of ['snapshot', 'migration']) {
    const { root, libraryId } = oldLibrary(t);
    const db = new DatabaseSync(dbFile(root));
    if (failure === 'snapshot') {
      db.exec("PRAGMA foreign_keys=OFF; INSERT INTO work_tags VALUES ('missing-work','bad reference')");
    } else {
      db.exec("INSERT INTO media_files SELECT 'm2',work_id,relative_path,size,sha256 FROM media_files");
    }
    db.close();
    const before = fs.readFileSync(dbFile(root));
    await assert.rejects(
      applyUpgrade(command(root, libraryId)),
      failure === 'snapshot' ? /integrity|foreign key/i : /unique/i
    );
    const failedSnapshot = inspectUpgrade(root);
    assert.equal(failedSnapshot.from, 1);
    assert.deepEqual(fs.readFileSync(dbFile(root)), before);
    if (failure === 'migration') {
      const snapshots = path.join(root, 'cangxia-server', 'snapshots');
      const [id] = fs.readdirSync(snapshots);
      assert.equal(JSON.parse(fs.readFileSync(path.join(snapshots, id, 'manifest.json'))).from, 1);
      const existing = new DatabaseSync(dbFile(root), { readOnly: true });
      assert.equal(
        existing.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='upgrade_receipts'").get().n,
        0
      );
      existing.close();
    }
  }
});

test('required missing WAL fails before SQLite opens it; cleanly checkpointed WAL mode libraries still open', (t) => {
  const { root } = oldLibrary(t);
  const db = new DatabaseSync(dbFile(root));
  db.exec('PRAGMA journal_mode=WAL');
  db.close();
  assert.equal(fs.existsSync(dbFile(root) + '-wal'), false);
  const detached = temporary(t);
  fs.cpSync(root, detached, { recursive: true });
  assert.equal(inspectUpgrade(root).state, 'migration-required');
  // A normal SQLite read-only transaction may create empty WAL-index sidecars
  // on the mounted live database. The detached fixture still has none.
  const marker = JSON.parse(fs.readFileSync(owner(detached)));
  fs.writeFileSync(owner(detached), JSON.stringify({ ...marker, requiredWal: true }));
  assert.throws(() => inspectUpgrade(detached), /WAL/);
  assert.equal(fs.existsSync(dbFile(detached) + '-wal'), false);
});

test('invalid init UUID fails before claiming an empty mount, unknown control files and schema fail closed', (t) => {
  const root = temporary(t);
  assert.throws(() => openLibrary({ root, mode: 'init', expectedId: null }));
  assert.deepEqual(fs.readdirSync(root), []);
  const old = oldLibrary(t);
  const snapshots = path.join(old.root, 'cangxia-server', 'snapshots');
  fs.writeFileSync(path.join(snapshots, 'foreign-archive'), 'foreign');
  assert.throws(() => inspectUpgrade(old.root));
  fs.unlinkSync(path.join(snapshots, 'foreign-archive'));
  const db = new DatabaseSync(dbFile(old.root));
  db.exec('CREATE TRIGGER unknown_change AFTER INSERT ON works BEGIN DELETE FROM work_tags; END');
  db.close();
  assert.throws(() => inspectUpgrade(old.root));
});

test('space check stops before the first snapshot byte or schema change', async (t) => {
  const { root, libraryId } = oldLibrary(t);
  const before = fs.readFileSync(dbFile(root));
  t.mock.method(fs, 'statfsSync', () => ({ bsize: 4096n, bavail: 1n }));
  await assert.rejects(applyUpgrade(command(root, libraryId)), /space/i);
  assert.deepEqual(fs.readFileSync(dbFile(root)), before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'cangxia-server', 'snapshots')), []);
});

test('a supplied approval is bound once across the asynchronous backup', async (t) => {
  const { root, libraryId } = oldLibrary(t);
  const req = command(root, libraryId);
  const confirmed = structuredClone(req);
  const pending = applyUpgrade(req);
  req.approval.operationId = randomUUID();
  req.imageDigest = 'sha256:' + 'c'.repeat(64);
  const receipt = await pending;
  assert.equal(receipt.operationId, confirmed.approval.operationId);
  assert.equal(receipt.imageDigest, confirmed.imageDigest);
  assert.deepEqual(await applyUpgrade(confirmed), receipt);
});

test('known required WAL rejects an empty or malformed replacement', (t) => {
  const { root } = oldLibrary(t);
  fs.writeFileSync(
    owner(root),
    JSON.stringify({ ...JSON.parse(fs.readFileSync(owner(root))), requiredWal: true })
  );
  fs.writeFileSync(dbFile(root) + '-wal', Buffer.alloc(4120));
  assert.throws(() => inspectUpgrade(root), /WAL/);
});

test('snapshot publication must preserve the verified database bytes and manifest before migration commits', async (t) => {
  const { root, libraryId } = oldLibrary(t);
  const before = fs.readFileSync(dbFile(root));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (path.basename(from).startsWith('.pending-'))
      fs.appendFileSync(path.join(to, 'manifest.json'), 'corrupted');
  });
  await assert.rejects(applyUpgrade(command(root, libraryId)), /snapshot/i);
  assert.deepEqual(fs.readFileSync(dbFile(root)), before);
  assert.equal(inspectUpgrade(root).from, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, 'cangxia-server', 'snapshots')), []);
});

test('substitution of the private snapshot directory must never delete files on the replacement target', async (t) => {
  const { root, libraryId } = oldLibrary(t);
  const foreign = temporary(t);
  const sentinel = path.join(foreign, 'library.sqlite');
  fs.writeFileSync(sentinel, 'keep');
  const parent = path.join(root, 'cangxia-server', 'snapshots');
  const pending = applyUpgrade(command(root, libraryId));
  const [stage] = fs.readdirSync(parent);
  const old = path.join(parent, stage);
  try {
    fs.renameSync(old, old + '-saved');
  } catch (error) {
    // Windows locks the active SQLite destination. Its storage guarantee
    // prevents this substitution during backup.
    if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
    await pending;
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
    return;
  }
  fs.symlinkSync(foreign, old, 'junction');
  await assert.rejects(pending);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  const original = new DatabaseSync(dbFile(root), { readOnly: true });
  try {
    assert.equal(original.prepare('PRAGMA user_version').get().user_version, 1);
  } finally {
    original.close();
  }
});

test('inspect honors another process exclusive rollback transaction without any on-disk journal', (t) => {
  const { root } = oldLibrary(t);
  const db = new DatabaseSync(dbFile(root));
  try {
    db.exec('BEGIN EXCLUSIVE');
    assert.equal(fs.existsSync(dbFile(root) + '-journal'), false);
    assert.throws(() => cli('inspect', '--root', root), /locked|busy/i);
  } finally {
    db.close();
  }
});

test('a second process cannot obtain a rollback-mode write reservation during snapshot', async (t) => {
  const { root, libraryId } = oldLibrary(t);
  const pending = applyUpgrade(command(root, libraryId));
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);
    try { db.exec('BEGIN IMMEDIATE'); console.log('acquired'); }
    catch (error) { console.log(error.errcode); }
    finally { db.close(); }
  `,
      dbFile(root)
    ],
    { encoding: 'utf8' }
  ).trim();
  await pending;
  assert.equal(result, '5', 'SQLITE_BUSY expected from the competing OS process');
});

test('a compatible read-only data file cannot report writable service readiness', (t) => {
  const root = temporary(t);
  const { libraryId } = cli('init', '--root', root);
  const file = dbFile(root);
  const before = fs.readFileSync(file);
  fs.chmodSync(file, 0o444);
  try {
    assert.throws(() => cli('start', '--root', root, '--library-id', libraryId));
    assert.deepEqual(fs.readFileSync(file), before);
  } finally {
    fs.chmodSync(file, 0o600);
  }
});

function crashWriter(root) {
  const file = dbFile(root);
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=DELETE; WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<120)
    INSERT INTO works SELECT 'spill-'||i,'committed',json_quote(hex(zeroblob(2200))) FROM n;`);
  db.close();
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA cache_size=3; BEGIN IMMEDIATE; UPDATE works SET title='UNCOMMITTED',body=json_quote(hex(zeroblob(3400)))");
    process.kill(process.pid,'SIGKILL');
  `,
        file
      ],
      { stdio: 'pipe' }
    )
  );
  assert.equal(
    fs
      .readFileSync(file + '-journal')
      .subarray(0, 8)
      .toString('hex'),
    'd9d505f920a163d7'
  );
}

test('an approved retry safely recovers a real crashed writer; preview and wrong identity leave both files intact', async (t) => {
  const { root, libraryId } = oldLibrary(t);
  crashWriter(root);
  const file = dbFile(root);
  const hashes = () => [file, file + '-journal'].map((p) => digest(fs.readFileSync(p)));
  const before = hashes();
  const validMarker = fs.readFileSync(owner(root));
  const foreignId = randomUUID();
  fs.writeFileSync(owner(root), JSON.stringify({ appId: 'local.cangxia.server', libraryId: foreignId }));
  await assert.rejects(applyUpgrade(command(root, foreignId)));
  assert.deepEqual(hashes(), before);
  fs.writeFileSync(owner(root), validMarker);
  const preview = inspectUpgrade(root);
  assert.equal(preview.state, 'migration-required');
  assert.deepEqual(hashes(), before);
  await applyUpgrade(command(root, libraryId));
  const current = openLibrary({ root, expectedId: libraryId });
  assert.equal(
    current.read((db) => db.prepare("SELECT count(*) n FROM works WHERE title='committed'").get().n),
    120
  );
  assert.equal(
    current.read((db) => db.prepare("SELECT count(*) n FROM works WHERE title='UNCOMMITTED'").get().n),
    0
  );
  current.close();
});
