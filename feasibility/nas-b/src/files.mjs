import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getSystemErrorName, promisify } from 'node:util';
import { safeName } from '../../../electron/model.mjs';
import { LIMITS, ProbeError } from './contracts.mjs';

const metadataName = '作品信息.json';
const metadataEscrow = 'displaced.json';
const tokenPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const stageName = /^payload\.(?:mp4|jpg|png|webp|avif|json)(?:\.part)?$/;
const locks = new Map();
const problem = (code, message) => new ProbeError(code, message);
const review = () => problem('PROBE_FILE_REVIEW', 'A file or directory identity changed. The existing material was preserved for review.');
const unsafe = () => problem('PROBE_FILE_PATH', 'The probe file path is outside its ordinary data directories.');
const missing = () => problem('PROBE_FILE_MISSING', 'A registered file or its directory is missing.');
const budget = () => problem('PROBE_MEDIA_BUDGET', 'The probe media byte budget has been reached.');
const idOf = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (stat, identity) => !!stat && !!identity && String(stat.dev) === identity.dev && String(stat.ino) === identity.ino;
const portable = (...parts) => parts.join('/');
const homePath = home => portable(home.folder, home.workFolder);
const lower = value => value.replaceAll('\\', '/').toLowerCase();
const storageCodes = ['ENOSPC', 'EIO', 'EACCES', 'EPERM', 'EROFS', 'EMFILE', 'ENFILE', 'EDQUOT', 'EBUSY'];
const photoExtensions = ['.jpg', '.png', '.webp', '.avif'];
const execute = promisify(execFile);
const renameAt2 = [
  'import ctypes, errno, os, sys',
  'libc = ctypes.CDLL(None, use_errno=True)',
  'rename = getattr(libc, "renameat2", None)',
  'if rename is None: sys.exit(errno.ENOSYS)',
  'rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]',
  'rename.restype = ctypes.c_int',
  'result = rename(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), int(sys.argv[3]))',
  'sys.exit(ctypes.get_errno() if result else 0)'
].join('\n');
const winMoveFile = Buffer.from([
  'try { [System.IO.File]::Move($env:CANGXIA_PROBE_MOVE_FROM, $env:CANGXIA_PROBE_MOVE_TO); exit 0 }',
  'catch { exit ($_.Exception.InnerException.HResult -band 65535) }'
].join('\n'), 'utf16le').toString('base64');
const winReplaceFile = Buffer.from([
  'try { [System.IO.File]::Replace($env:CANGXIA_PROBE_MOVE_FROM, $env:CANGXIA_PROBE_MOVE_TO, $env:CANGXIA_PROBE_DISPLACED); exit 0 }',
  'catch { exit ($_.Exception.InnerException.HResult -band 65535) }'
].join('\n'), 'utf16le').toString('base64');

export function fileReason(error) {
  if (error instanceof ProbeError) return { code: error.code, message: error.message };
  if (storageCodes.includes(error?.code)) return { code: error.code, message: 'The local probe storage operation could not complete.' };
  return { code: 'PROBE_FILE_OPERATION', message: 'The local probe file operation needs attention.' };
}

function components(relative) {
  if (typeof relative !== 'string' || !relative || relative.split('/').some(part =>
    part === '.' || part === '..' || !part || safeName(part, 255) !== part)) throw unsafe();
  return relative.split('/');
}

async function status(file) {
  try { return await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function retry(operation) {
  for (const wait of [0, 25, 50, 100]) {
    if (wait) await delay(wait);
    try { return await operation(); }
    catch (error) {
      if (wait === 100 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    }
  }
}

async function directory(root, relative = '', { create = false, guard } = {}) {
  const top = await status(root);
  if (!top?.isDirectory()) throw unsafe();
  let current = root;
  let stat = top;
  for (const part of relative ? components(relative) : []) {
    current = path.join(current, part);
    if (current.length > 235) throw problem('PROBE_PATH_TOO_LONG', 'The probe path is too long for the portable download layout.');
    stat = await status(current);
    if (!stat && create) {
      guard?.();
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await status(current);
    }
    if (!stat) throw missing();
    if (!stat.isDirectory() || stat.dev !== top.dev) throw unsafe();
  }
  return { file: current, stat };
}

async function roots(layout) {
  for (const name of ['media', 'staging']) {
    if (!path.isAbsolute(layout.root) || layout[name] !== path.join(layout.root, name)) throw unsafe();
  }
  return {
    media: await directory(layout.root, 'media'),
    staging: await directory(layout.root, 'staging')
  };
}

async function fileAt(root, relative) {
  const parts = components(relative);
  const name = parts.pop();
  const parent = await directory(root, parts.join('/'));
  const file = path.join(parent.file, name);
  if (file.length > 235) throw problem('PROBE_PATH_TOO_LONG', 'The probe path is too long for the portable download layout.');
  const stat = await status(file);
  if (stat && (!stat.isFile() || stat.dev !== parent.stat.dev || stat.nlink > 2n)) throw review();
  return { file, stat, parent };
}

async function syncDirectory(dir) {
  let handle;
  try {
    handle = await fs.open(dir, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'EBADF'].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}

async function runLinuxRename(from, to, flags, unsupported) {
  if (process.platform !== 'linux') throw unsupported;
  try { await execute('python3', ['-I', '-S', '-c', renameAt2, from, to, String(flags)], { timeout: 5000 }); }
  catch (error) {
    const code = Number.isInteger(error.code) && error.code > 0 ? getSystemErrorName(-error.code) : error.code;
    if (['EEXIST', 'ENOENT', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(code)) throw review();
    if (storageCodes.includes(code)) throw Object.assign(new Error('Native file rename failed.'), { code });
    throw unsupported;
  }
}

function runWindowsRename(command, from, to, displaced) {
  return execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    env: { ...process.env, CANGXIA_PROBE_MOVE_FROM: from, CANGXIA_PROBE_MOVE_TO: to,
      ...(displaced && { CANGXIA_PROBE_DISPLACED: displaced }) },
    timeout: 5000, windowsHide: true
  });
}

async function moveExclusive(from, to, { directory = false } = {}) {
  // Windows rejects renaming a directory over an existing directory. Linux
  // needs the exclusive flag even for a target that appears empty.
  if (process.platform === 'win32') {
    if (directory) return fs.rename(from, to);
    try {
      await runWindowsRename(winMoveFile, from, to);
      return;
    } catch (error) {
      if (await status(to)) throw review();
      if ([5, 32].includes(error.code)) throw Object.assign(new Error('Exclusive file move failed.'), { code: 'EACCES' });
      throw problem('PROBE_FILE_MOVE_UNSUPPORTED', 'The probe volume could not perform an exclusive file move.');
    }
  }
  return runLinuxRename(from, to, 1,
    problem('PROBE_FILE_MOVE_UNSUPPORTED', 'The probe volume could not perform an exclusive move.'));
}

async function exchangeMetadata(staged, formal, displaced) {
  const unsupported = problem('PROBE_FILE_EXCHANGE_UNSUPPORTED', 'The probe volume could not atomically replace the work metadata.');
  if (process.platform !== 'win32') return runLinuxRename(staged, formal, 2, unsupported);
  try { await runWindowsRename(winReplaceFile, staged, formal, displaced); }
  catch (error) {
    if ([5, 32].includes(error.code)) throw Object.assign(new Error('Atomic file replacement failed.'), { code: 'EACCES' });
    if ([2, 3, 80, 183].includes(error.code)) throw review();
    throw unsupported;
  }
}

export async function withWorkFiles(layout, workId, callback) {
  const key = path.resolve(layout.root) + '\0' + workId;
  const before = locks.get(key);
  const task = Promise.resolve(before).catch(() => {}).then(callback);
  locks.set(key, task);
  try { return await task; }
  finally { if (locks.get(key) === task) locks.delete(key); }
}

function validHome(home) {
  if (!home || !['collection', 'author'].includes(home.kind) ||
      typeof home.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(home.id)) throw unsafe();
  if (components(home.workFolder).length !== 1) throw unsafe();
  const parts = components(home.folder);
  if (parts.length !== 1 && !(home.kind === 'author' && parts.length === 2 && parts[0] === '作者作品')) throw unsafe();
  return home;
}

export function planDestination({ work, source = { kind: 'total', id: '__all__' }, existingHome, owners = new Map() }) {
  if (existingHome?.kind === 'author') return validHome(existingHome);
  const author = source.kind === 'author';
  const folder = source.folder || (author
    ? '作者作品/' + safeName(source.name ?? work.author?.nickname, 32) + '-' +
      createHash('sha256').update(source.id).digest('hex').slice(0, 10)
    : source.id === '__all__' ? '收藏' : source.name ? safeName(source.name, 52) : '收藏夹-' + source.id);
  const base = safeName(work.name, 52) + '-' + safeName(work.author?.nickname, 24);
  const occupied = leaf => [...(owners.get(lower(portable(folder, leaf))) ?? [])].some(owner => owner !== work.id);
  const workFolder = occupied(base) ? base + '-' + work.id : base;
  if (occupied(workFolder)) throw review();
  return validHome({ kind: author ? 'author' : 'collection', id: source.id, folder, workFolder });
}

function savedHome(store, workId) {
  const row = store.db.prepare("SELECT body FROM records WHERE kind='homes' AND id=?").get(workId);
  return row ? JSON.parse(row.body) : null;
}

function saveHome(db, workId, value, revision) {
  db.prepare("INSERT OR REPLACE INTO records VALUES ('homes',?,?,?)").run(workId, JSON.stringify(value), revision);
}

function sourceFor(store, work, saved) {
  function collection(id) {
    const row = store.db.prepare("SELECT body FROM records WHERE kind='collections' AND id=?").get(id);
    return row ? JSON.parse(row.body) : null;
  }
  const refs = store.db.prepare(
    "SELECT r.source_kind kind,r.source_id id FROM work_refs r WHERE work_id=? AND NOT EXISTS(" +
    "SELECT 1 FROM scope_state s WHERE s.work_id=r.work_id AND s.deleted=1 AND (" +
    "(s.kind=r.source_kind AND s.source_id=r.source_id) OR (r.source_kind<>'author' AND s.kind='account' AND s.source_id='__all__'))) " +
    "ORDER BY CASE kind WHEN 'collection' THEN 0 WHEN 'total' THEN 1 ELSE 2 END,revision,id"
  ).all(work.id);
  const total = refs.find(ref => ref.kind === 'total');
  const old = saved?.home;
  if (old?.kind === 'author') return { ...old, name: saved.collectionName };
  for (const ref of refs.filter(entry => entry.kind === 'collection')) {
    const known = collection(ref.id);
    if (known?.added === false || known?.remoteMissing) continue;
    return { ...known, ...ref };
  }
  if (old && old.id !== '__all__') {
    const known = collection(old.id);
    if (!total || !known?.complete || known?.remoteMissing) {
      return { kind: 'collection', ...old, name: known?.name ?? saved.collectionName };
    }
  }
  if (!total && !saved) {
    const ref = refs.find(entry => entry.kind === 'author');
    if (ref) return { ...ref, name: work.author?.nickname };
  }
  return { kind: 'total', id: '__all__', name: '收藏' };
}

function ownerMap(store) {
  const homes = store.db.prepare("SELECT id,body FROM records WHERE kind='homes'").all();
  const owners = new Map();
  for (const { id, body } of homes) {
    const key = lower(homePath(validHome(JSON.parse(body).home)));
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(id);
  }
  return owners;
}

function collectionName(source) {
  return source.name || (source.id === '__all__' ? '收藏' : source.folder || '收藏夹-' + source.id);
}

async function chooseHome({ store, work, saved, layout, guard }) {
  const source = sourceFor(store, work, saved);
  const owners = ownerMap(store);
  const existingHome = saved?.home;
  let home = planDestination({ work, source, owners, existingHome });
  const media = (await roots(layout)).media.file;
  const parent = await directory(media, home.folder, { create: true, guard });
  const candidate = await status(path.join(parent.file, home.workFolder));
  if (candidate && homePath(home) !== (existingHome && homePath(existingHome))) {
    // A directory which isn't in our home ledger must never be adopted.
    owners.set(lower(homePath(home)), new Set(['external']));
    home = planDestination({ work, source, owners, existingHome });
    if (await status(path.join(parent.file, home.workFolder))) throw review();
  }
  return { home, collectionName: collectionName(source), media };
}

export function assertWorkFiles(store, workId) {
  const protectedFiles = store.db.prepare(
    "SELECT 1 FROM scope_state WHERE work_id=? AND kind IN ('work','files') AND source_id='' AND deleted=1"
  ).get(workId);
  const work = store.work(workId);
  if (protectedFiles || !work) throw problem('PROBE_FILES_PROTECTED', 'The work or its media scope is unavailable.');
  return work;
}

export async function ensureHome({ store, layout, workId }) {
  const work = assertWorkFiles(store, workId);
  const existing = savedHome(store, workId);
  if (existing) {
    const current = await directory(layout.media, homePath(validHome(existing.home)));
    if (!same(current.stat, existing.identity)) throw review();
    return existing;
  }
  const { home, media, collectionName: name } = await chooseHome({ store, layout, work });
  const file = path.join(media, ...components(homePath(home)));
  if (file.length > 235) throw problem('PROBE_PATH_TOO_LONG', 'The probe path is too long for the portable download layout.');
  try { await fs.mkdir(file, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw review(); throw error; }
  const owned = await directory(media, homePath(home));
  await syncDirectory(path.dirname(file));
  const value = { home, identity: idOf(owned.stat), collectionName: name };
  store.withWrite(db => {
    assertWorkFiles(store, workId);
    saveHome(db, workId, value, store.nextRevision());
  });
  return value;
}

function putCommit(db, commit, revision) {
  db.prepare("INSERT INTO file_commits VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET " +
    "stage=excluded.stage,body=excluded.body,revision=excluded.revision")
    .run(commit.id, commit.workId, commit.resourceId, commit.stage, JSON.stringify(commit.body), revision);
}

function updateCommit(store, commit, stage = commit.stage) {
  commit.stage = stage;
  store.withWrite(db => putCommit(db, commit, store.nextRevision()));
}

async function commitDirectory(layout, commit) {
  const { staging } = await roots(layout);
  if (!tokenPattern.test(commit.id)) throw review();
  const result = await directory(staging.file, portable('commits', commit.id));
  if (!same(result.stat, commit.body.directory)) throw review();
  return result.file;
}

function checkStageEntries(dir, commit) {
  return fs.readdir(dir).then(async names => {
    for (const name of names) {
      if (!stageName.test(name)) throw review();
      const stat = await status(path.join(dir, name));
      if (!stat?.isFile() || stat.nlink !== 1n || !same(stat, commit.body.files?.[name])) throw review();
    }
  });
}

export async function assertFileStage(stage, layout) {
  const dir = await commitDirectory(layout, stage.commit);
  if (dir !== stage.dir) throw review();
  await checkStageEntries(dir, stage.commit);
}

export async function openFileStage({ store, layout, jobId, workId, key, kind, resourceIdentity, observationIdentity, group, guard }) {
  guard?.();
  const previous = store.fileCommits(workId).find(entry => entry.stage === 'staged' &&
    entry.body.jobId === jobId && entry.body.key === key && entry.body.resourceIdentity === resourceIdentity && entry.body.group === group);
  if (previous) {
    previous.body.observationIdentity = observationIdentity;
    const stage = { commit: previous, dir: await commitDirectory(layout, previous) };
    await assertFileStage(stage, layout);
    return stage;
  }

  const id = randomUUID();
  const commit = { id, workId, resourceId: kind === 'metadata' ? workId + ':metadata' : workId + ':' + key,
    stage: 'allocating', body: { key, kind, jobId, resourceIdentity, observationIdentity, group, files: {} } };
  updateCommit(store, commit);
  const { staging } = await roots(layout);
  const parent = await directory(staging.file, 'commits', { create: true, guard });
  const dir = path.join(parent.file, id);
  guard?.();
  await fs.mkdir(dir, { mode: 0o700 });
  const stat = (await directory(parent.file, id)).stat;
  await syncDirectory(parent.file);
  commit.body.directory = idOf(stat);
  updateCommit(store, commit, 'staged');
  return { commit, dir };
}

export function trackStagedFile(store, { commit, dir }, file, opened) {
  const name = path.basename(file);
  if (path.dirname(file) !== dir || !stageName.test(name)) throw review();
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n ||
      Number(stat.dev) !== Number(opened.dev) || Number(stat.ino) !== Number(opened.ino)) throw review();
  if (!same(stat, commit.body.files[name])) {
    commit.body.files[name] = idOf(stat);
    updateCommit(store, commit);
  }
}

export function stageCheckpoints(store, { commit }) {
  return {
    get: () => commit.body.checkpoint,
    set(_key, value) {
      commit.body.checkpoint = value;
      updateCommit(store, commit);
    },
    delete() {
      if (commit.body.checkpoint) {
        delete commit.body.checkpoint;
        updateCommit(store, commit);
      }
    }
  };
}

async function digestFile(file, expected, limitLinks, signal) {
  signal?.throwIfAborted();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const first = await handle.stat({ bigint: true });
    if (!first.isFile() || first.nlink > BigInt(limitLinks) || !same(first, expected)) throw review();
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let remaining = Number(first.size);
    while (remaining > 0) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, remaining), null);
      if (!bytesRead) throw review();
      hash.update(chunk.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    signal?.throwIfAborted();
    const last = await handle.stat({ bigint: true });
    const named = await status(file);
    if (!same(named, expected) || first.size !== last.size || first.mtimeNs !== last.mtimeNs ||
        first.size !== named.size || first.mtimeNs !== named.mtimeNs) throw review();
    return { size: Number(first.size), sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

async function assertDigest({ file, stat }, spec, links = 1, signal) {
  if (!stat || !same(stat, spec.identity)) throw review();
  if (Number(stat.size) !== spec.size || (spec.mtimeNs && String(stat.mtimeNs) !== spec.mtimeNs)) throw review();
  const actual = await digestFile(file, spec.identity, links, signal);
  if (actual.sha256 !== spec.sha256 || actual.size !== spec.size) throw review();
}

async function chooseFilename(dir, filename, kind) {
  const extension = path.extname(filename);
  const base = filename.slice(0, -extension.length);
  const extensions = kind === 'image' ? photoExtensions : [extension];
  // Match the current app's common basename for all supported extensions.
  const occupied = new Set((await fs.readdir(dir)).map(lower));
  for (let number = 0; number < 1000; number++) {
    const name = base + (number ? '-补存' + (number === 1 ? '' : '-' + number) : '');
    if (extensions.every(ext => !occupied.has(lower(name + ext)))) return name + extension;
  }
  throw review();
}

export async function verifyAndPlace({ store, layout, stage, transferred, mime, filename, home, previous, signal, guard, dimensions }) {
  signal?.throwIfAborted();
  const { commit, dir } = stage;
  assertWorkFiles(store, commit.workId);
  const { file, sha256, size } = transferred;
  const name = path.basename(file);
  const stat = await status(file);
  if (path.dirname(file) !== dir || !stageName.test(name) || !stat?.isFile() || stat.nlink !== 1n ||
      !same(stat, commit.body.files[name])) throw review();
  const { media } = await roots(layout);
  const workDirectory = await directory(media.file, homePath(home.home));
  if (!same(workDirectory.stat, home.identity)) throw review();
  if (previous?.missing) {
    const old = path.posix.basename(previous.relative);
    if (path.extname(old) !== path.extname(filename) || path.posix.dirname(previous.relative) !== homePath(home.home)) throw review();
    filename = old;
  } else if (commit.body.kind !== 'metadata') filename = await chooseFilename(workDirectory.file, filename, commit.body.kind);
  const relative = portable(homePath(home.home), filename);
  const destination = await fileAt(media.file, relative);
  if (!same(destination.parent.stat, home.identity)) throw review();
  if (destination.stat && (!previous || previous.missing)) throw review();
  const details = { stagedName: name, relative, identity: idOf(stat), mtimeNs: String(stat.mtimeNs),
    size, sha256, mime, homeIdentity: home.identity, previous, dimensions };
  await assertDigest({ file, stat }, details, 1, signal);
  signal?.throwIfAborted();
  guard?.();
  Object.assign(commit.body, details);
  updateCommit(store, commit, 'verified');
  return placeVerified({ store, layout, commit, guard });
}

async function registerFile(store, commit) {
  const { workId, resourceId, body } = commit;
  return store.withWrite(db => {
    assertWorkFiles(store, workId);
    const previous = store.resources(workId).find(asset => asset.key === body.key);
    if (previous && previous.id !== resourceId) throw review();
    if (Boolean(previous) !== Boolean(body.previous) || (previous &&
        (previous.relative_path !== body.previous.relative || previous.sha256 !== body.previous.sha256 ||
          previous.revision !== body.previous.revision || (body.kind !== 'metadata' && !body.previous.missing)))) throw review();
    const revision = store.nextRevision();
    db.prepare("INSERT OR REPLACE INTO resources VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      resourceId, workId, body.key, body.kind, body.relative, body.size, body.sha256, body.mime, 'complete', revision);
    if (body.kind !== 'metadata') {
      const usage = mediaUsage(store);
      usage.newMediaBytes += body.size;
      if (usage.newMediaBytes > LIMITS.requestedMediaBytes) throw budget();
      saveMediaUsage(db, usage);
    }
    commit.stage = 'registered';
    putCommit(db, commit, revision);
    return { id: commit.id, workId, stage: commit.stage };
  });
}

async function restoreMissingMetadata({ dir, destination, displaced, previous }) {
  if (await status(destination.file)) throw review();
  await assertDigest({ file: displaced, stat: await status(displaced) }, previous);
  await moveExclusive(displaced, destination.file);
  await syncDirectory(dir);
  await syncDirectory(destination.parent.file);
  destination.stat = await status(destination.file);
  await assertDigest(destination, previous);
}

async function placeMetadataReplacement({ store, commit, dir, destination, staged, recoverOnly, guard }) {
  const { body } = commit;
  if (body.kind !== 'metadata') throw review();
  const legacyDisplaced = path.join(dir, metadataEscrow);
  // Previous probe builds could leave an unfinished two-step publication.
  if (!body.exchange && ['escrowing', 'escrowed', 'placed'].includes(commit.stage)) {
    const old = await status(legacyDisplaced);
    if (same(destination.stat, body.identity)) {
      await assertDigest({ file: legacyDisplaced, stat: old }, body.previous);
      return settlePlacement({ store, commit, destination, dir, staged });
    }
    if (old && !destination.stat) {
      await restoreMissingMetadata({ dir, destination, displaced: legacyDisplaced, previous: body.previous });
    } else if (old || commit.stage !== 'escrowing') throw review();
    updateCommit(store, commit, 'verified');
  }

  const windows = process.platform === 'win32';
  const mode = windows ? 'windows-replace' : 'linux-exchange';
  if (body.exchange && body.exchange !== mode) throw review();
  const displaced = windows ? legacyDisplaced : staged.file;
  try {
    if (!same(destination.stat, body.identity)) {
      if (commit.stage === 'placed') throw review();
      const backup = windows && await status(displaced);
      if (backup && !destination.stat && commit.stage === 'swapping') {
        // ReplaceFileW can report a native partial failure after creating its backup.
        await restoreMissingMetadata({ dir, destination, displaced, previous: body.previous });
        throw review();
      }
      if (backup) throw review();
      await assertDigest(destination, body.previous);
      await assertDigest(staged, body);
      if (recoverOnly) return null;
      store.fileHook('beforeMetadataExchange', { file: destination.file, displaced });
      if (windows && await status(displaced)) throw review();
      guard?.();
      body.exchange = mode;
      if (commit.stage !== 'swapping') updateCommit(store, commit, 'swapping');
      try { await exchangeMetadata(staged.file, destination.file, displaced); }
      catch (error) {
        if (windows && !await status(destination.file) && await status(displaced)) {
          await restoreMissingMetadata({ dir, destination, displaced, previous: body.previous });
          throw review();
        }
        throw error;
      }
      await syncDirectory(dir);
      await syncDirectory(destination.parent.file);
      store.fileHook('afterMetadataExchange', { file: destination.file, displaced });
    }
    if (!body.exchange || !['swapping', 'placed'].includes(commit.stage)) throw review();
    await assertDigest({ file: displaced, stat: await status(displaced) }, body.previous);
    return await settlePlacement({ store, commit, destination, dir });
  } catch (error) {
    if (error.code === 'PROBE_FILE_REVIEW') updateCommit(store, commit, 'review');
    throw error;
  }
}

async function settlePlacement({ store, commit, destination, dir, staged }) {
  const { body } = commit;
  destination.stat = await status(destination.file);
  const stagingAlias = staged && await status(staged.file);
  if (destination.stat?.nlink === 2n && (!same(stagingAlias, body.identity) || stagingAlias.nlink !== 2n)) throw review();
  if (stagingAlias && !same(stagingAlias, body.identity)) throw review();
  await assertDigest(destination, body, stagingAlias ? 2 : 1);
  await syncDirectory(destination.parent.file);
  if (stagingAlias) {
    await retry(async () => {
      if (!same(await status(staged.file), body.identity)) throw review();
      await fs.unlink(staged.file);
    });
    await syncDirectory(dir);
  }
  updateCommit(store, commit, 'placed');
  return registerFile(store, commit);
}

async function placeVerified({ store, layout, commit, recoverOnly = false, guard }) {
  assertWorkFiles(store, commit.workId);
  const { body } = commit;
  const dir = await commitDirectory(layout, commit);
  if (!stageName.test(body.stagedName) || body.stagedName.endsWith('.part')) throw review();
  const staged = { file: path.join(dir, body.stagedName) };
  staged.stat = await status(staged.file);
  const { media } = await roots(layout);
  const destination = await fileAt(media.file, body.relative);
  if (!same(destination.parent.stat, body.homeIdentity)) throw review();
  if (body.previous && !body.previous.missing) {
    return placeMetadataReplacement({ store, commit, dir, destination, staged, recoverOnly, guard });
  }
  if (!same(destination.stat, body.identity)) {
    if (commit.stage === 'placed' || destination.stat) throw review();
    if (recoverOnly) return null;
    await assertDigest(staged, body);
    guard?.();
    try { await fs.link(staged.file, destination.file); }
    catch (error) { if (error.code === 'EEXIST') throw review(); throw error; }
    store.fileHook('afterFilePlacement', { workId: commit.workId, kind: body.kind, file: destination.file, staged: staged.file });
  }
  return settlePlacement({ store, commit, destination, dir, staged });
}

export function mediaUsage(store) {
  const row = store.db.prepare("SELECT value FROM runtime_meta WHERE key='download:media-usage'").get();
  return row ? JSON.parse(row.value) : { transferredBytes: 0, newMediaBytes: 0 };
}

export function saveMediaUsage(db, usage) {
  db.prepare("INSERT OR REPLACE INTO runtime_meta VALUES ('download:media-usage',?)").run(JSON.stringify(usage));
}

function assetProof(store, workId, asset) {
  return store.fileCommits(workId).findLast(commit => commit.stage === 'registered' && commit.resourceId === asset.id &&
    commit.body.sha256 === asset.sha256 && commit.body.size === asset.size)?.body;
}

function permitsResource(store, workId) {
  return !!store.db.prepare(
    "SELECT 1 FROM records WHERE kind='works' AND id=? AND body IS NOT NULL AND NOT EXISTS (" +
    "SELECT 1 FROM scope_state WHERE work_id=records.id AND kind IN ('work','files') AND source_id='' AND deleted=1)"
  ).get(workId);
}

function assertResourceRegistration(store, resource) {
  const row = store.db.prepare("SELECT * FROM resources WHERE work_id=? AND key=? AND state='complete'")
    .get(resource.work_id, resource.key);
  if (!row || ['id', 'revision', 'relative_path', 'size', 'sha256', 'mime', 'kind']
    .some(key => row[key] !== resource[key])) throw review();
}

// Call after opening, using the stat of the actual handle that will be streamed.
// The registry and scope checks can also be repeated synchronously during reads.
export function assertResourceCurrent({ store, resource, stat }) {
  if (!permitsResource(store, resource.work_id)) {
    throw problem('PROBE_FILES_PROTECTED', 'The work or its media scope is unavailable.');
  }
  assertResourceRegistration(store, resource);
  if (stat !== undefined && (!stat.isFile() || stat.nlink !== 1n || !same(stat, resource.identity) ||
      stat.size !== BigInt(resource.size) || String(stat.mtimeNs) !== resource.mtimeNs)) throw review();
}

export async function resolveResource({ store, layout, workId, key, verify = false, allowMissing = false, signal }) {
  if (!permitsResource(store, workId)) return null;
  const row = store.resources(workId).find(asset => asset.key === key && asset.state === 'complete');
  if (!row) return null;
  const proof = assetProof(store, workId, row);
  if (!proof) throw review();
  const { media } = await roots(layout);
  const located = await fileAt(media.file, row.relative_path);
  if (!permitsResource(store, workId)) return null;
  const home = savedHome(store, workId);
  if (!home || !same(located.parent.stat, home.identity)) throw review();
  const asset = { ...row, file: located.file, identity: proof.identity, mtimeNs: proof.mtimeNs,
    resourceIdentity: proof.resourceIdentity, observationIdentity: proof.observationIdentity, ...proof.dimensions };
  if (!located.stat) {
    if (allowMissing) {
      assertResourceRegistration(store, asset);
      return { ...asset, missing: true };
    }
    throw missing();
  }
  if (!same(located.stat, proof.identity) ||
      located.stat.nlink !== 1n || Number(located.stat.size) !== row.size ||
      String(located.stat.mtimeNs) !== proof.mtimeNs) throw review();
  if (verify) {
    store.fileHook('beforeResourceVerify', asset);
    await assertDigest(located, proof, 1, signal);
  }
  signal?.throwIfAborted();
  if (!permitsResource(store, workId)) return null;
  assertResourceRegistration(store, asset);
  return asset;
}

export async function cleanFileStages({ store, layout, workId, jobId, key }) {
  let pending = false;
  for (const commit of store.fileCommits(workId)) {
    if (commit.body.jobId !== jobId || (key && commit.body.key !== key) ||
        !['staged', 'allocating', 'verified', 'cancel-cleanup'].includes(commit.stage)) continue;
    try {
      const dir = await commitDirectory(layout, commit);
      const names = await fs.readdir(dir);
      for (const name of names) {
        const file = path.join(dir, name);
        const owned = commit.body.files?.[name];
        const stat = await status(file);
        if (!stageName.test(name) || !stat?.isFile() || stat.nlink !== 1n || !same(stat, owned)) {
          pending = true;
          continue;
        }
        store.fileHook('beforeFileCleanup', { workId, file });
        await retry(async () => {
          const current = await status(file);
          if (!current) return;
          if (!current.isFile() || current.nlink !== 1n || !same(current, owned)) throw review();
          await fs.unlink(file);
        });
      }
      delete commit.body.checkpoint;
      const remains = (await fs.readdir(dir)).length !== 0;
      pending ||= remains;
      updateCommit(store, commit, remains ? 'cancel-cleanup' : 'cancelled');
    } catch {
      pending = true;
      updateCommit(store, commit, 'cancel-cleanup');
    }
  }
  return pending;
}

async function checkRecoveryLinks({ store, layout }) {
  const stageRoot = path.join(layout.staging, 'commits');
  if (!(await status(stageRoot))) return;
  await roots(layout);
  await directory(layout.staging, 'commits');
  const commits = new Map(store.fileCommits().map(commit => [commit.id, commit]));
  for (const token of await fs.readdir(stageRoot)) {
    if (!tokenPattern.test(token)) continue;
    const candidate = await status(path.join(stageRoot, token));
    if (!candidate?.isDirectory()) throw review();
    for (const name of await fs.readdir(path.join(stageRoot, token))) {
      const stat = await status(path.join(stageRoot, token, name));
      if (!stat || stat.nlink <= 1n || !stat.isFile()) continue;
      const commit = commits.get(token);
      if (!commit || !['verified', 'escrowed', 'placed'].includes(commit.stage) || commit.body.stagedName !== name ||
          !same(candidate, commit.body.directory) || !same(stat, commit.body.identity) || stat.nlink !== 2n) throw review();
      const formal = await fileAt(layout.media, commit.body.relative);
      if (!same(formal.stat, commit.body.identity)) throw review();
    }
  }
}

export async function recoverFileCommits({ store, layout, workId }) {
  await checkRecoveryLinks({ store, layout });
  const results = [];
  for (const commit of store.fileCommits(workId)) {
    if (!['verified', 'swapping', 'escrowing', 'escrowed', 'placed', 'moving'].includes(commit.stage)) continue;
    try {
      const result = await withWorkFiles(layout, commit.workId, () => {
        const isStopping = () => {
          const job = commit.body.jobId && store.db.prepare('SELECT state FROM download_jobs WHERE id=?').get(commit.body.jobId);
          return ['cancelling', 'cancelled', 'pausing', 'paused'].includes(job?.state);
        };
        const options = { store, layout, commit, recoverOnly: isStopping(), guard() {
          if (isStopping()) throw problem('PROBE_FILE_RECOVERY_PAUSED', 'The stopped job has no new file work to recover.');
          assertWorkFiles(store, commit.workId);
        } };
        if (commit.stage === 'moving') return applyMove(options);
        return placeVerified(options);
      });
      if (result) results.push(result);
    } catch (error) {
      if (error.code === 'PROBE_FILE_RECOVERY_PAUSED') continue;
      if (error.code === 'PROBE_FILE_REVIEW') updateCommit(store, commit, 'review');
      results.push({ id: commit.id, workId: commit.workId, stage: commit.stage, error: fileReason(error) });
    }
  }
  return results;
}

async function applyMove({ store, layout, commit, recoverOnly = false, guard }) {
  const { workId, body } = commit;
  assertWorkFiles(store, workId);
  const { media } = await roots(layout);
  const original = validHome(body.before.home);
  const target = validHome(body.after.home);
  const oldParent = await directory(media.file, original.folder);
  const nextParent = await directory(media.file, target.folder);
  const from = path.join(oldParent.file, original.workFolder);
  const to = path.join(nextParent.file, target.workFolder);
  if (to.length > 235) throw problem('PROBE_PATH_TOO_LONG', 'The probe path is too long for the portable download layout.');
  let previous = await status(from);
  let placed = await status(to);
  if (previous) {
    if (recoverOnly) return null;
    if (!previous.isDirectory() || !same(previous, body.before.identity) || placed) throw review();
    await retry(async () => {
      if (!same(await status(from), body.before.identity) || await status(to)) throw review();
      store.fileHook('beforeFileMove', { workId, file: to });
      guard?.();
      try { await moveExclusive(from, to, { directory: true }); }
      catch (error) {
        if (await status(to)) throw review();
        throw error;
      }
    });
    store.fileHook('afterFilePlacement', { workId, kind: 'move', file: to });
    previous = await status(from);
    placed = await status(to);
  }
  if (previous || !placed?.isDirectory() || !same(placed, body.before.identity)) throw review();
  await syncDirectory(oldParent.file);
  if (nextParent.file !== oldParent.file) await syncDirectory(nextParent.file);

  store.withWrite(db => {
    assertWorkFiles(store, workId);
    const revision = store.nextRevision();
    const replace = db.prepare('UPDATE resources SET relative_path=?,revision=? WHERE id=?');
    for (const asset of store.resources(workId)) {
      if (!asset.relative_path.startsWith(homePath(original) + '/')) throw review();
      replace.run(portable(homePath(target), path.posix.basename(asset.relative_path)), revision, asset.id);
    }
    saveHome(db, workId, body.after, revision);
    commit.stage = 'registered';
    putCommit(db, commit, revision);
  });
  return { id: commit.id, workId, stage: commit.stage };
}

async function writeMetadata({ store, layout, work, home, jobId, signal, guard }) {
  guard();
  const { id: workId } = work;
  const assets = store.resources(workId).filter(row => row.kind !== 'metadata');
  if (!assets.length) return;
  for (const asset of assets) await resolveResource({ store, layout, workId, key: asset.key, verify: true, signal });
  const previous = await resolveResource({ store, layout, workId, key: 'metadata', verify: true, signal });
  guard();
  const previousProof = previous ? { identity: previous.identity, mtimeNs: previous.mtimeNs,
    size: previous.size, sha256: previous.sha256, relative: previous.relative_path, revision: previous.revision } : null;
  const info = {
    schemaVersion: 1, workId, workName: work.name, title: work.title, caption: work.caption, description: work.description,
    author: work.author, coAuthors: work.coAuthors ?? [], tags: work.tags, rawTags: work.rawTags,
    publishedAt: work.publishedAt, originalURL: work.url, music: work.music, collection: home.collectionName,
    collectionId: home.home.kind === 'author' ? 'author:' + home.home.id : home.home.id,
    remoteState: work.remoteState, sourceStatus: work.sourceStatus, checkedAt: work.checkedAt,
    assets: assets.map(row => ({ key: row.key, file: path.posix.basename(row.relative_path), kind: row.kind,
      size: row.size, sha256: row.sha256, mime: row.mime, ...assetProof(store, workId, row)?.dimensions }))
  };
  const bytes = Buffer.from(JSON.stringify(info, null, 2), 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (previous?.sha256 === sha256) return;
  const stage = await openFileStage({ store, layout, jobId, workId, key: 'metadata', kind: 'metadata', resourceIdentity: sha256, guard });
  const file = path.join(stage.dir, 'payload.json');
  store.fileHook('beforeFileWrite', { workId, kind: 'metadata', file });
  const existing = await status(file);
  const owned = stage.commit.body.files['payload.json'];
  if (existing && (!existing.isFile() || existing.nlink !== 1n || !same(existing, owned))) throw review();
  guard();
  const handle = await fs.open(file, existing ? 'r+' : 'wx');
  try {
    const opened = await handle.stat({ bigint: true });
    if (existing && !same(opened, owned)) throw review();
    trackStagedFile(store, stage, file, opened);
    guard();
    await handle.truncate(0);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  await verifyAndPlace({ store, layout, stage, home, previous: previousProof, filename: metadataName,
    mime: 'application/json', transferred: { file, size: bytes.length, sha256 }, signal, guard });
}

const success = () => ({ ok: true, pending: false, errors: [] });

export async function finalizeWorkFiles({ store, layout, workId, jobId = 'reconcile', signal, guard: assertWriter }) {
  const work = store.work(workId);
  const saved = savedHome(store, workId);
  if (!work || !saved) return success();
  const guard = () => {
    signal?.throwIfAborted();
    assertWriter?.();
    assertWorkFiles(store, workId);
  };
  try {
    guard();
    if (store.fileCommits(workId).some(commit => commit.stage === 'review')) throw review();
    const moving = store.fileCommits(workId).find(entry => entry.stage === 'moving');
    if (moving) await applyMove({ store, layout, commit: moving, guard });
    const before = savedHome(store, workId);
    const target = await chooseHome({ store, layout, work, saved: before, guard });
    const after = { home: target.home, identity: before.identity, collectionName: target.collectionName };
    guard();
    if (homePath(before.home) !== homePath(after.home)) {
      const commit = { id: randomUUID(), workId, resourceId: null, stage: 'moving', body: { before, after, kind: 'move', jobId } };
      updateCommit(store, commit);
      await applyMove({ store, layout, commit, guard });
    } else if (JSON.stringify(before) !== JSON.stringify(after)) {
      store.withWrite(db => saveHome(db, workId, after, store.nextRevision()));
    }
    await writeMetadata({ store, layout, work, home: after, jobId, signal, guard });
    return success();
  } catch (error) {
    return { ok: false, pending: true, errors: [{ workId, ...fileReason(error) }] };
  }
}

export async function reconcileWork({ store, layout, workId, guard }) {
  const recovered = await recoverFileCommits({ store, layout, workId });
  const errors = recovered.filter(result => result.error).map(result => ({ workId, ...result.error }));
  if (errors.length) return { ok: false, pending: true, errors };
  return withWorkFiles(layout, workId, () => finalizeWorkFiles({ store, layout, workId, guard }));
}
