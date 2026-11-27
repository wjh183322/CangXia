import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getSystemErrorName, promisify } from 'node:util';
import { safeName } from '../electron/model.mjs';
import { SourceError } from './source-error.mjs';

export function currentHDCover(db, workId) {
  const row = db
    .prepare(
      `SELECT h.body FROM hd_covers h
    JOIN archive_resources v ON v.work_id=h.work_id AND v.key='video' AND v.sha256=h.video_sha
    JOIN archive_resources c ON c.work_id=h.work_id AND c.key='cover' AND c.sha256=h.cover_sha
    JOIN archive_resources output ON output.work_id=h.work_id AND output.key=json_extract(h.body,'$.key') AND output.sha256=json_extract(h.body,'$.sha256')
    WHERE h.work_id=?`
    )
    .get(workId);
  return row && JSON.parse(row.body);
}

const metadataName = '作品信息.json';
const metadataEscrow = 'displaced.json';
const tokenPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const stageName = /^payload\.(?:mp4|jpg|png|webp|avif|mp3|aac|wav|m4a|bin|json)(?:\.part)?$/;
const locks = new Map();
const problem = (code, message) => new SourceError(code, message);
const review = () => problem('NAS_FILE_REVIEW', '文件或目录的身份与登记不一致，已保留现场供核对。');
const unsafe = () => problem('NAS_FILE_PATH', '归档路径超出已核对的 NAS 目录。');
const missing = () => problem('NAS_FILE_MISSING', '已登记的文件或其目录缺失。');
const idOf = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (stat, identity) =>
  !!stat && !!identity && String(stat.dev) === identity.dev && String(stat.ino) === identity.ino;
const portable = (...parts) => parts.join('/');
const homePath = (home) => portable(home.folder, home.workFolder);
const lower = (value) => value.replaceAll('\\', '/').toLowerCase();
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
const winMoveFile = Buffer.from(
  [
    'try { [System.IO.File]::Move($env:CANGXIA_NAS_MOVE_FROM, $env:CANGXIA_NAS_MOVE_TO); exit 0 }',
    'catch { exit ($_.Exception.InnerException.HResult -band 65535) }'
  ].join('\n'),
  'utf16le'
).toString('base64');
const winReplaceFile = Buffer.from(
  [
    'try { [System.IO.File]::Replace($env:CANGXIA_NAS_MOVE_FROM, $env:CANGXIA_NAS_MOVE_TO, $env:CANGXIA_NAS_DISPLACED); exit 0 }',
    'catch { exit ($_.Exception.InnerException.HResult -band 65535) }'
  ].join('\n'),
  'utf16le'
).toString('base64');

export function fileReason(error) {
  if (error instanceof SourceError) return { code: error.code, message: error.message };
  if (storageCodes.includes(error?.code))
    return { code: error.code, message: 'NAS 存储操作失败，请检查磁盘与权限。' };
  return { code: 'NAS_FILE_OPERATION', message: 'NAS 文件操作未完成，请检查后重试。' };
}

function components(relative) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.split('/').some((part) => part === '.' || part === '..' || !part || safeName(part, 255) !== part)
  )
    throw unsafe();
  return relative.split('/');
}

async function status(file) {
  try {
    return await fs.lstat(file, { bigint: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function retry(operation) {
  for (const wait of [0, 25, 50, 100]) {
    if (wait) await delay(wait);
    try {
      return await operation();
    } catch (error) {
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
    if (process.platform === 'win32' && current.length > 32760)
      throw problem('NAS_PATH_TOO_LONG', 'The archive path is too long for the portable download layout.');
    stat = await status(current);
    if (!stat && create) {
      guard?.();
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      stat = await status(current);
    }
    if (!stat) throw missing();
    if (!stat.isDirectory() || stat.dev !== top.dev) throw unsafe();
  }
  return { file: current, stat };
}

async function roots(layout) {
  layout.assertCurrent();
  if (
    !path.isAbsolute(layout.root) ||
    layout.media !== path.join(layout.root, 'media') ||
    layout.staging !== path.join(layout.media, '.cangxia-staging')
  )
    throw unsafe();
  return {
    media: await directory(layout.root, 'media'),
    staging: await directory(layout.media, '.cangxia-staging')
  };
}

async function fileAt(root, relative) {
  const parts = components(relative);
  const name = parts.pop();
  const parent = await directory(root, parts.join('/'));
  const file = path.join(parent.file, name);
  if (process.platform === 'win32' && file.length > 32760)
    throw problem('NAS_PATH_TOO_LONG', 'The archive path is too long for the portable download layout.');
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
    if (
      process.platform !== 'win32' ||
      !['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'EBADF'].includes(error.code)
    )
      throw error;
  } finally {
    await handle?.close();
  }
}

async function runLinuxRename(from, to, flags, unsupported) {
  if (process.platform !== 'linux') throw unsupported;
  try {
    await execute('python3', ['-I', '-S', '-c', renameAt2, from, to, String(flags)], { timeout: 5000 });
  } catch (error) {
    const code =
      Number.isInteger(error.code) && error.code > 0 ? getSystemErrorName(-error.code) : error.code;
    if (['EEXIST', 'ENOENT', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(code)) throw review();
    if (storageCodes.includes(code)) throw Object.assign(new Error('Native file rename failed.'), { code });
    throw unsupported;
  }
}

function runWindowsRename(command, from, to, displaced) {
  return execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    env: {
      ...process.env,
      CANGXIA_NAS_MOVE_FROM: from,
      CANGXIA_NAS_MOVE_TO: to,
      ...(displaced && { CANGXIA_NAS_DISPLACED: displaced })
    },
    timeout: 5000,
    windowsHide: true
  });
}

export async function moveExclusive(from, to, { directory = false } = {}) {
  // Windows rejects renaming a directory over an existing directory. Linux
  // needs the exclusive flag even for a target that appears empty.
  if (process.platform === 'win32') {
    if (directory) return fs.rename(from, to);
    try {
      await runWindowsRename(winMoveFile, from, to);
      return;
    } catch (error) {
      if (await status(to)) throw review();
      if ([5, 32].includes(error.code))
        throw Object.assign(new Error('Exclusive file move failed.'), { code: 'EACCES' });
      throw problem(
        'NAS_FILE_MOVE_UNSUPPORTED',
        'The archive volume could not perform an exclusive file move.'
      );
    }
  }
  return runLinuxRename(
    from,
    to,
    1,
    problem('NAS_FILE_MOVE_UNSUPPORTED', 'The archive volume could not perform an exclusive move.')
  );
}

async function exchangeMetadata(staged, formal, displaced) {
  const unsupported = problem(
    'NAS_FILE_EXCHANGE_UNSUPPORTED',
    'The archive volume could not atomically replace the work metadata.'
  );
  if (process.platform !== 'win32') return runLinuxRename(staged, formal, 2, unsupported);
  try {
    await runWindowsRename(winReplaceFile, staged, formal, displaced);
  } catch (error) {
    if ([5, 32].includes(error.code))
      throw Object.assign(new Error('Atomic file replacement failed.'), { code: 'EACCES' });
    if ([2, 3, 80, 183].includes(error.code)) throw review();
    throw unsupported;
  }
}

export async function withWorkFiles(layout, workId, callback) {
  const key = path.resolve(layout.root) + '\0' + workId;
  const before = locks.get(key);
  const task = Promise.resolve(before)
    .catch(() => {})
    .then(callback);
  locks.set(key, task);
  try {
    return await task;
  } finally {
    if (locks.get(key) === task) locks.delete(key);
  }
}

function validHome(home) {
  if (
    !home ||
    !['collection', 'author'].includes(home.kind) ||
    typeof home.id !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(home.id)
  )
    throw unsafe();
  if (components(home.workFolder).length !== 1) throw unsafe();
  const parts = components(home.folder);
  if (parts.length !== 1 && !(home.kind === 'author' && parts.length === 2 && parts[0] === '作者作品'))
    throw unsafe();
  return home;
}

export function planDestination({
  work,
  source = { kind: 'total', id: '__all__' },
  existingHome,
  owners = new Map()
}) {
  if (existingHome?.kind === 'author') return validHome(existingHome);
  const author = source.kind === 'author';
  const folder =
    source.folder ||
    (author
      ? '作者作品/' +
        safeName(source.name ?? work.author?.nickname, 32) +
        '-' +
        createHash('sha256').update(source.id).digest('hex').slice(0, 10)
      : source.id === '__all__'
        ? '收藏'
        : source.name
          ? safeName(source.name, 52)
          : '收藏夹-' + source.id);
  const base = safeName(work.name, 52) + '-' + safeName(work.author?.nickname, 24);
  const occupied = (leaf) =>
    [...(owners.get(lower(portable(folder, leaf))) ?? [])].some((owner) => owner !== work.id);
  const workFolder = occupied(base) ? base + '-' + work.id : base;
  if (occupied(workFolder)) throw review();
  return validHome({ kind: author ? 'author' : 'collection', id: source.id, folder, workFolder });
}

export function archiveRevision(store, workId) {
  return store.db.prepare('SELECT revision FROM archive_state WHERE work_id=?').get(workId)?.revision ?? 0;
}

function savedHome(store, workId) {
  const row = store.db.prepare('SELECT body FROM archive_homes WHERE work_id=?').get(workId);
  return row ? JSON.parse(row.body) : null;
}
function saveHome(db, workId, value) {
  db.prepare('INSERT OR REPLACE INTO archive_homes VALUES(?,?)').run(workId, JSON.stringify(value));
}
// Old libraries may not yet have a folder field from directory discovery.
function collectionFolder(db, id, name) {
  const assigned = new Set(['收藏']);
  for (const row of db
    .prepare("SELECT source_id,name,body FROM read_sources WHERE source_id LIKE 'folder:%' ORDER BY rowid")
    .iterate()) {
    const folderId = row.source_id.slice(7);
    const label = safeName(row.name, 52);
    const folder =
      JSON.parse(row.body).folder ||
      (assigned.has(label.toLowerCase()) ? label + '-' + folderId.slice(-6) : label);
    if (folderId === id) return folder;
    assigned.add(folder.toLowerCase());
  }
  return name && safeName(name, 52);
}

function sourceFor(store, work, saved) {
  if (saved?.home.kind === 'author') {
    const row = store.db
      .prepare('SELECT name FROM read_sources WHERE source_id=?')
      .get('author:' + saved.home.id);
    return { ...saved.home, name: row?.name || saved.collectionName };
  }
  const ref = store.db
    .prepare(
      `SELECT m.source_id,s.name FROM source_members m LEFT JOIN read_sources s USING(source_id)
    WHERE work_id=? AND (s.source_id IS NULL OR (s.added=1 AND s.missing=0))
    ORDER BY CASE WHEN m.source_id LIKE 'folder:%' THEN 0 WHEN m.source_id='total' THEN 1 ELSE 2 END,m.rowid LIMIT 1`
    )
    .get(work.id);
  if (ref?.source_id.startsWith('folder:'))
    return {
      kind: 'collection',
      id: ref.source_id.slice(7),
      name: ref.name,
      folder: collectionFolder(store.db, ref.source_id.slice(7), ref.name)
    };
  if (saved?.home.kind === 'collection' && saved.home.id !== '__all__') {
    const key = 'folder:' + saved.home.id;
    const old = store.db.prepare('SELECT name,missing FROM read_sources WHERE source_id=?').get(key);
    const complete = store.db
      .prepare(
        "SELECT 1 FROM read_steps WHERE source_id=? AND mode='full' AND outcome='end' AND status IN ('complete','finalizing') LIMIT 1"
      )
      .get(key);
    if (old && (old.missing || !complete || ref?.source_id !== 'total'))
      return {
        kind: 'collection',
        id: saved.home.id,
        name: old.name,
        folder: collectionFolder(store.db, saved.home.id, old.name)
      };
  }
  if (!saved && ref?.source_id.startsWith('author:'))
    return { kind: 'author', id: ref.source_id.slice(7), name: ref.name };
  return { kind: 'total', id: '__all__', name: '收藏' };
}
function ownerMap(store) {
  return new Map(
    store.db
      .prepare('SELECT work_id,body FROM archive_homes')
      .all()
      .map((row) => [lower(homePath(validHome(JSON.parse(row.body).home))), new Set([row.work_id])])
  );
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
    if (
      (!existingHome || homePath(home) !== homePath(existingHome)) &&
      (await status(path.join(parent.file, home.workFolder)))
    )
      throw review();
  }
  return { home, collectionName: collectionName(source), media };
}

export function assertWorkFiles(store, workId) {
  const work = store.work(workId);
  if (!work) throw problem('NAS_FILES_PROTECTED', '作品记录已不存在。');
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
  // Filename allocation is shared by different works with the same title and author.
  return withWorkFiles(layout, '\0home-allocation', async () => {
    const { home, media, collectionName: name } = await chooseHome({ store, layout, work });
    const file = path.join(media, ...components(homePath(home)));
    if (process.platform === 'win32' && file.length > 32760)
      throw problem('NAS_PATH_TOO_LONG', 'The archive path is too long for the portable download layout.');
    try {
      await fs.mkdir(file, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') throw review();
      throw error;
    }
    const owned = await directory(media, homePath(home));
    await syncDirectory(path.dirname(file));
    const value = { home, identity: idOf(owned.stat), collectionName: name };
    store.withWrite((db) => {
      assertWorkFiles(store, workId);
      saveHome(db, workId, value, store.nextRevision());
    });
    return value;
  });
}

function putCommit(db, commit, revision) {
  db.prepare(
    'INSERT INTO file_commits VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
      'stage=excluded.stage,body=excluded.body,revision=excluded.revision'
  ).run(commit.id, commit.workId, commit.resourceId, commit.stage, JSON.stringify(commit.body), revision);
  commit.revision = revision;
}

function updateCommit(store, commit, stage = commit.stage) {
  commit.stage = stage;
  store.withWrite((db) => putCommit(db, commit, store.nextRevision()));
}

function markCommitForReview(store, commit) {
  if (['registered', 'review'].includes(commit.stage)) return;
  store.withWrite((db) => {
    const current = store.fileCommit(commit.id, commit.workId);
    if (!current || current.stage !== commit.stage || current.revision !== commit.revision) return;
    commit.stage = 'review';
    putCommit(db, commit, store.nextRevision());
  });
}

async function commitDirectory(layout, commit) {
  const { staging } = await roots(layout);
  if (!tokenPattern.test(commit.id)) throw review();
  const result = await directory(staging.file, portable('commits', commit.id));
  if (!same(result.stat, commit.body.directory)) throw review();
  return result.file;
}

// Older writers linked an already tracked payload.part to a second name and then
// unlinked the first before recording the second. Only its original inode proves
// ownership; a copied file with identical bytes does not.
async function recoverLegacyStage(dir, commit) {
  if (commit.body.transfer || commit.body.kind === 'metadata') return;
  for (const [part, identity] of Object.entries(commit.body.files)) {
    if (!stageName.test(part) || !part.endsWith('.part')) continue;
    const name = part.slice(0, -5);
    if (commit.body.files[name]) continue;
    const from = path.join(dir, name),
      to = path.join(dir, part);
    const alias = await status(from),
      original = await status(to);
    if (!alias?.isFile() || !same(alias, identity)) continue;
    if (!original && alias.nlink === 1n) await moveExclusive(from, to);
    else if (original?.isFile() && same(original, identity) && original.nlink === 2n && alias.nlink === 2n)
      await fs.unlink(from);
    else continue;
    await syncDirectory(dir);
  }
}

function checkStageEntries(dir, commit) {
  return fs.readdir(dir).then(async (names) => {
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

export async function openFileStage({
  store,
  layout,
  jobId,
  workId,
  key,
  kind,
  resourceIdentity,
  observationIdentity,
  urlHash,
  group,
  guard
}) {
  guard?.();
  const previous = store
    .fileCommits(workId)
    .findLast(
      (entry) =>
        entry.stage === 'staged' &&
        entry.body.jobId === jobId &&
        entry.body.key === key &&
        entry.body.resourceIdentity === resourceIdentity &&
        entry.body.observationIdentity === observationIdentity &&
        (!entry.body.transfer || entry.body.transfer.urlHash === urlHash) &&
        entry.body.group === group &&
        (kind === 'metadata' || !Object.keys(entry.body.files).some((name) => !name.endsWith('.part')))
    );
  if (previous) {
    previous.body.observationIdentity = observationIdentity;
    const stage = { commit: previous, dir: await commitDirectory(layout, previous) };
    await recoverLegacyStage(stage.dir, previous);
    await assertFileStage(stage, layout);
    return stage;
  }

  const id = randomUUID();
  const commit = {
    id,
    workId,
    resourceId: kind === 'metadata' ? workId + ':metadata' : workId + ':' + key,
    stage: 'allocating',
    body: { key, kind, jobId, resourceIdentity, observationIdentity, group, files: {} }
  };
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

// Verify the opened handle before allowing a truncate, even on a fresh non-Range response.
export async function openStagedPartial(stage, file, layout) {
  await assertFileStage(stage, layout);
  const name = path.basename(file);
  if (path.dirname(file) !== stage.dir || !stageName.test(name) || !name.endsWith('.part')) throw review();
  const stat = await status(file),
    owned = stage.commit.body.files[name];
  if (stat && (!stat.isFile() || stat.nlink !== 1n || !same(stat, owned))) throw review();
  const handle = await fs.open(file, stat ? constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) : 'wx+', 0o600);
  try {
    const opened = await handle.stat({ bigint: true }),
      named = await status(file);
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !same(named, idOf(opened)) ||
      (stat && !same(opened, owned))
    )
      throw review();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function trackStagedFile(store, { commit, dir }, file, opened) {
  const name = path.basename(file);
  if (path.dirname(file) !== dir || !stageName.test(name)) throw review();
  const stat = lstatSync(file, { bigint: true });
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    Number(stat.dev) !== Number(opened.dev) ||
    Number(stat.ino) !== Number(opened.ino)
  )
    throw review();
  if (!same(stat, commit.body.files[name])) {
    commit.body.files[name] = idOf(stat);
    updateCommit(store, commit);
  }
}

export async function sealTransfer({ store, layout, stage, result, urlHash, guard }) {
  await assertFileStage(stage, layout);
  const { file, size, sha256, extension } = result,
    name = path.basename(file),
    stat = await status(file);
  if (
    path.dirname(file) !== stage.dir ||
    name !== 'payload' + extension + '.part' ||
    !stageName.test(name) ||
    !stat?.isFile() ||
    stat.nlink !== 1n ||
    !same(stat, stage.commit.body.files[name]) ||
    Number(stat.size) !== size
  )
    throw review();
  guard();
  const transfer = {
    name,
    size,
    sha256,
    extension,
    urlHash,
    identity: idOf(stat),
    mtimeNs: String(stat.mtimeNs)
  };
  stage.commit.body.transfer = transfer;
  delete stage.commit.body.checkpoint;
  updateCommit(store, stage.commit);
  store.fileHook('afterStagedDigest', { workId: stage.commit.workId, file });
}
export async function stagedTransfer(stage, urlHash, signal) {
  const proof = stage.commit.body.transfer;
  if (!proof) return null;
  if (!stageName.test(proof.name) || proof.name !== 'payload' + proof.extension + '.part') throw review();
  if (proof.urlHash !== urlHash) return null;
  const file = path.join(stage.dir, proof.name);
  await assertDigest({ file, stat: await status(file) }, proof, 1, signal);
  return { file, size: proof.size, sha256: proof.sha256, extension: proof.extension };
}
export function discardInvalidTransfer(store, stage) {
  if (stage.commit.body.transfer) updateCommit(store, stage.commit, 'rejected');
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
    if (
      !same(named, expected) ||
      first.size !== last.size ||
      first.mtimeNs !== last.mtimeNs ||
      first.size !== named.size ||
      first.mtimeNs !== named.mtimeNs
    )
      throw review();
    return { size: Number(first.size), sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function assertDigest({ file, stat }, spec, links = 1, signal) {
  if (!stat || !same(stat, spec.identity)) throw review();
  if (Number(stat.size) !== spec.size || (spec.mtimeNs && String(stat.mtimeNs) !== spec.mtimeNs))
    throw review();
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
    if (extensions.every((ext) => !occupied.has(lower(name + ext)))) return name + extension;
  }
  throw review();
}

export async function verifyAndPlace({
  store,
  layout,
  stage,
  transferred,
  mime,
  filename,
  home,
  previous,
  signal,
  guard,
  dimensions
}) {
  signal?.throwIfAborted();
  const { commit, dir } = stage;
  assertWorkFiles(store, commit.workId);
  const { file, sha256, size } = transferred;
  const name = path.basename(file);
  const stat = await status(file);
  if (
    path.dirname(file) !== dir ||
    !stageName.test(name) ||
    !stat?.isFile() ||
    stat.nlink !== 1n ||
    !same(stat, commit.body.files[name])
  )
    throw review();
  const { media } = await roots(layout);
  const workDirectory = await directory(media.file, homePath(home.home));
  if (!same(workDirectory.stat, home.identity)) throw review();
  if (previous?.missing) {
    const old = path.posix.basename(previous.relative);
    if (
      path.extname(old) !== path.extname(filename) ||
      path.posix.dirname(previous.relative) !== homePath(home.home)
    )
      throw review();
    filename = old;
  } else if (commit.body.kind !== 'metadata')
    filename = await chooseFilename(workDirectory.file, filename, commit.body.kind);
  const relative = portable(homePath(home.home), filename);
  const destination = await fileAt(media.file, relative);
  if (!same(destination.parent.stat, home.identity)) throw review();
  if (destination.stat && (!previous || previous.missing)) throw review();
  const details = {
    stagedName: name,
    relative,
    identity: idOf(stat),
    mtimeNs: String(stat.mtimeNs),
    size,
    sha256,
    mime,
    homeIdentity: home.identity,
    previous,
    dimensions
  };
  await assertDigest({ file, stat }, details, 1, signal);
  signal?.throwIfAborted();
  guard?.();
  Object.assign(commit.body, details);
  updateCommit(store, commit, 'verified');
  return placeVerified({ store, layout, commit, guard });
}

async function registerFile(store, commit) {
  const { workId, resourceId, body } = commit;
  return store.withWrite((db) => {
    assertWorkFiles(store, workId);
    const previous = store.resources(workId).find((asset) => asset.key === body.key);
    if (
      previous
        ? previous.id !== resourceId
        : db.prepare('SELECT 1 FROM media_files WHERE id=?').get(resourceId)
    )
      throw review();
    if (
      Boolean(previous) !== Boolean(body.previous) ||
      (previous &&
        (previous.relative_path !== body.previous.relative ||
          previous.sha256 !== body.previous.sha256 ||
          previous.revision !== body.previous.revision ||
          (body.kind !== 'metadata' && !body.previous.missing && !body.previous.superseded)))
    )
      throw review();
    const revision = store.nextRevision();
    db.prepare(
      `INSERT INTO media_files VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      relative_path=excluded.relative_path,size=excluded.size,sha256=excluded.sha256`
    ).run(resourceId, workId, body.relative, body.size, body.sha256);
    db.prepare('INSERT OR REPLACE INTO archive_assets VALUES(?,?,?,?,?)').run(
      resourceId,
      body.key,
      body.kind,
      body.mime,
      revision
    );
    commit.stage = 'registered';
    if (body.exchange || body.previous?.superseded) body.discardPrevious = true;
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
  const windows = process.platform === 'win32';
  const mode = windows ? 'windows-replace' : 'linux-exchange';
  if (body.exchange && body.exchange !== mode) throw review();
  const displaced = windows ? path.join(dir, metadataEscrow) : staged.file;
  try {
    if (!same(destination.stat, body.identity)) {
      if (commit.stage === 'placed') throw review();
      const backup = windows && (await status(displaced));
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
      if (windows && (await status(displaced))) throw review();
      guard?.();
      body.exchange = mode;
      if (commit.stage !== 'swapping') updateCommit(store, commit, 'swapping');
      try {
        await exchangeMetadata(staged.file, destination.file, displaced);
      } catch (error) {
        if (windows && !(await status(destination.file)) && (await status(displaced))) {
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
    if (error.code === 'NAS_FILE_REVIEW') markCommitForReview(store, commit);
    throw error;
  }
}

async function settlePlacement({ store, commit, destination, dir, staged }) {
  const { body } = commit;
  destination.stat = await status(destination.file);
  const stagingAlias = staged && (await status(staged.file));
  if (destination.stat?.nlink === 2n && (!same(stagingAlias, body.identity) || stagingAlias.nlink !== 2n))
    throw review();
  if (stagingAlias && !same(stagingAlias, body.identity)) throw review();
  await assertDigest(destination, body, stagingAlias ? 2 : 1);
  await syncDirectory(destination.parent.file);
  if (stagingAlias) {
    await retry(async () => {
      if (!same(await status(staged.file), body.identity)) throw review();
      await fs.unlink(staged.file);
    });
    await syncDirectory(dir);
    store.fileHook('afterStagingUnlink', { workId: commit.workId, file: destination.file });
  }
  updateCommit(store, commit, 'placed');
  return registerFile(store, commit);
}

async function placeVerified({ store, layout, commit, recoverOnly = false, guard }) {
  assertWorkFiles(store, commit.workId);
  const { body } = commit;
  const dir = await commitDirectory(layout, commit);
  if (
    !stageName.test(body.stagedName) ||
    (body.stagedName.endsWith('.part') &&
      (body.transfer?.name !== body.stagedName ||
        body.transfer.sha256 !== body.sha256 ||
        body.transfer.size !== body.size))
  )
    throw review();
  const staged = { file: path.join(dir, body.stagedName) };
  staged.stat = await status(staged.file);
  const { media } = await roots(layout);
  const destination = await fileAt(media.file, body.relative);
  if (!same(destination.parent.stat, body.homeIdentity)) throw review();
  if (body.previous && !body.previous.missing && !body.previous.superseded) {
    return placeMetadataReplacement({ store, commit, dir, destination, staged, recoverOnly, guard });
  }
  if (!same(destination.stat, body.identity)) {
    if (commit.stage === 'placed' || destination.stat) throw review();
    if (recoverOnly) return null;
    await assertDigest(staged, body);
    store.fileHook('beforeFormalPlacement', { workId: commit.workId, file: destination.file });
    guard?.();
    try {
      await fs.link(staged.file, destination.file);
    } catch (error) {
      if (error.code === 'EEXIST') throw review();
      throw error;
    }
    store.fileHook('afterFilePlacement', {
      workId: commit.workId,
      kind: body.kind,
      file: destination.file,
      staged: staged.file
    });
  }
  return settlePlacement({ store, commit, destination, dir, staged });
}

function assetProof(store, workId, asset) {
  return store
    .fileCommits(workId)
    .findLast(
      (commit) =>
        commit.stage === 'registered' &&
        commit.resourceId === asset.id &&
        commit.body.sha256 === asset.sha256 &&
        commit.body.size === asset.size
    )?.body;
}

function permitsResource(store, workId) {
  return !!store.db.prepare('SELECT 1 FROM works WHERE id=?').get(workId);
}

function assertResourceRegistration(store, resource) {
  const row = store.db
    .prepare("SELECT * FROM archive_resources WHERE work_id=? AND key=? AND state='complete'")
    .get(resource.work_id, resource.key);
  if (
    !row ||
    ['id', 'revision', 'relative_path', 'size', 'sha256', 'mime', 'kind'].some(
      (key) => row[key] !== resource[key]
    )
  )
    throw review();
}

// Call after opening, using the stat of the actual handle that will be streamed.
// The registry and scope checks can also be repeated synchronously during reads.
export function assertResourceCurrent({ store, resource, stat }) {
  if (!permitsResource(store, resource.work_id)) {
    throw problem('NAS_FILES_PROTECTED', 'The work or its media scope is unavailable.');
  }
  assertResourceRegistration(store, resource);
  if (
    stat !== undefined &&
    (!stat.isFile() ||
      stat.nlink !== 1n ||
      !same(stat, resource.identity) ||
      stat.size !== BigInt(resource.size) ||
      String(stat.mtimeNs) !== resource.mtimeNs)
  )
    throw review();
}

export async function resolveResource({
  store,
  layout,
  workId,
  key,
  verify = false,
  allowMissing = false,
  signal
}) {
  if (!permitsResource(store, workId)) return null;
  const row = store.resources(workId).find((asset) => asset.key === key && asset.state === 'complete');
  if (!row) return null;
  const proof = assetProof(store, workId, row);
  if (!proof) throw review();
  const { media } = await roots(layout);
  const located = await fileAt(media.file, row.relative_path);
  if (!permitsResource(store, workId)) return null;
  const home = savedHome(store, workId);
  if (!home || !same(located.parent.stat, home.identity)) throw review();
  const asset = {
    ...row,
    file: located.file,
    identity: proof.identity,
    mtimeNs: proof.mtimeNs,
    resourceIdentity: proof.resourceIdentity,
    observationIdentity: proof.observationIdentity,
    ...proof.dimensions
  };
  if (!located.stat) {
    if (allowMissing) {
      assertResourceRegistration(store, asset);
      return { ...asset, missing: true };
    }
    throw missing();
  }
  if (
    !same(located.stat, proof.identity) ||
    located.stat.nlink !== 1n ||
    Number(located.stat.size) !== row.size ||
    String(located.stat.mtimeNs) !== proof.mtimeNs
  )
    throw review();
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
    if (
      commit.stage === 'registered' &&
      commit.body.jobId === jobId &&
      (!key || commit.body.key === key) &&
      commit.body.discardPrevious
    ) {
      try {
        const { body } = commit;
        const current = await resolveResource({ store, layout, workId, key: body.key, verify: true });
        if (!current || current.sha256 !== body.sha256) throw review();
        let old;
        if (body.previous.superseded) old = await fileAt(layout.media, body.previous.relative);
        else {
          const dir = await commitDirectory(layout, commit),
            file = path.join(dir, body.exchange === 'windows-replace' ? metadataEscrow : body.stagedName);
          old = { file, stat: await status(file) };
        }
        if (old.stat) {
          await assertDigest(old, body.previous);
          await fs.unlink(old.file);
          await syncDirectory(path.dirname(old.file));
        }
        delete body.discardPrevious;
        updateCommit(store, commit);
      } catch {
        pending = true;
      }
      continue;
    }
    if (
      commit.body.jobId !== jobId ||
      (key && commit.body.key !== key) ||
      !['staged', 'rejected', 'allocating', 'verified', 'cancel-cleanup'].includes(commit.stage)
    )
      continue;
    try {
      const dir = await commitDirectory(layout, commit);
      await recoverLegacyStage(dir, commit);
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

export async function recoverFileCommits({ store, layout, workId, jobId, guard }) {
  const results = [];
  const stages = ['verified', 'swapping', 'placed', 'moving'];
  for (const candidate of store.fileCommits(workId)) {
    if (!stages.includes(candidate.stage) || (jobId && candidate.body.jobId !== jobId)) continue;
    const result = await withWorkFiles(layout, candidate.workId, async () => {
      const commit = store.fileCommit(candidate.id, candidate.workId);
      if (!commit || !stages.includes(commit.stage) || commit.revision !== candidate.revision) return null;
      try {
        const isStopping = () => {
          const job =
            commit.body.jobId &&
            store.db.prepare('SELECT state FROM download_jobs WHERE id=?').get(commit.body.jobId);
          return (
            job &&
            (!['queued', 'running'].includes(job.state) || !store.canPublishDownload?.(commit.body.jobId))
          );
        };
        const hdChanged =
          commit.body.hdInputs &&
          ['video', 'cover'].some(
            (key) =>
              store.resources(commit.workId).find((r) => r.key === key)?.sha256 !== commit.body.hdInputs[key]
          );
        const obsolete =
          hdChanged ||
          (commit.body.archiveRevision !== undefined &&
            commit.body.archiveRevision !== archiveRevision(store, commit.workId));
        const options = {
          store,
          layout,
          commit,
          recoverOnly: isStopping() || obsolete,
          guard() {
            guard?.();
            if (
              commit.body.archiveRevision !== undefined &&
              commit.body.archiveRevision !== archiveRevision(store, commit.workId)
            )
              throw problem('NAS_ARCHIVE_STALE', '作品信息已更新。');
            if (isStopping())
              throw problem('NAS_FILE_RECOVERY_PAUSED', 'The stopped job has no new file work to recover.');
            assertWorkFiles(store, commit.workId);
          }
        };
        const result = await (commit.stage === 'moving' ? applyMove(options) : placeVerified(options));
        const cancelling =
          commit.stage === 'moving' &&
          commit.body.jobId &&
          store.db.prepare('SELECT state FROM download_jobs WHERE id=?').get(commit.body.jobId)?.state ===
            'cancelling';
        if (!result && (obsolete || cancelling))
          updateCommit(store, commit, commit.stage === 'moving' ? 'cancelled' : 'rejected');
        return result;
      } catch (error) {
        if (error.code === 'NAS_FILE_RECOVERY_PAUSED') return null;
        if (error.code === 'NAS_FILE_REVIEW') markCommitForReview(store, commit);
        return { id: commit.id, workId: commit.workId, stage: commit.stage, error: fileReason(error) };
      }
    });
    if (result) results.push(result);
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
  if (process.platform === 'win32' && to.length > 32760)
    throw problem('NAS_PATH_TOO_LONG', 'The archive path is too long for the portable download layout.');
  let previous = await status(from);
  let placed = await status(to);
  if (previous) {
    if (!previous.isDirectory() || !same(previous, body.before.identity) || placed) throw review();
    if (recoverOnly) return null;
    await retry(async () => {
      store.fileHook('beforeFileMove', { workId, file: to });
      if (!same(await status(from), body.before.identity) || (await status(to))) throw review();
      if (
        !same(await status(oldParent.file), idOf(oldParent.stat)) ||
        !same(await status(nextParent.file), idOf(nextParent.stat))
      )
        throw review();
      guard?.();
      try {
        await moveExclusive(from, to, { directory: true });
      } catch (error) {
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

  store.withWrite((db) => {
    assertWorkFiles(store, workId);
    const revision = store.nextRevision();
    const replace = db.prepare('UPDATE media_files SET relative_path=? WHERE id=?');
    for (const asset of store.resources(workId)) {
      if (!asset.relative_path.startsWith(homePath(original) + '/')) throw review();
      replace.run(portable(homePath(target), path.posix.basename(asset.relative_path)), asset.id);
      db.prepare('UPDATE archive_assets SET revision=? WHERE id=?').run(revision, asset.id);
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
  const assets = store.resources(workId).filter((row) => row.kind !== 'metadata');
  if (!assets.length) return;
  for (const asset of assets)
    await resolveResource({ store, layout, workId, key: asset.key, verify: true, signal });
  const previous = await resolveResource({
    store,
    layout,
    workId,
    key: 'metadata',
    verify: true,
    allowMissing: true,
    signal
  });
  guard();
  const previousProof = previous
    ? {
        missing: !!previous.missing,
        identity: previous.identity,
        mtimeNs: previous.mtimeNs,
        size: previous.size,
        sha256: previous.sha256,
        relative: previous.relative_path,
        revision: previous.revision
      }
    : null;
  const info = {
    schemaVersion: 1,
    workId,
    workName: work.name,
    title: work.title,
    caption: work.caption,
    description: work.description,
    author: work.author,
    coAuthors: work.coAuthors ?? [],
    tags: work.tags,
    rawTags: work.rawTags,
    localTags: store.db
      .prepare('SELECT tag FROM work_tags WHERE work_id=? ORDER BY rowid')
      .all(workId)
      .map((row) => row.tag),
    hdCover: currentHDCover(store.db, workId) ?? undefined,
    publishedAt: work.publishedAt,
    originalURL: work.url,
    music: work.music,
    collection: home.collectionName,
    collectionId: home.home.kind === 'author' ? 'author:' + home.home.id : home.home.id,
    remoteState: work.remoteState,
    sourceStatus: work.sourceStatus,
    checkedAt: work.checkedAt,
    assets: assets.map((row) => ({
      key: row.key,
      file: path.posix.basename(row.relative_path),
      kind: row.kind,
      size: row.size,
      sha256: row.sha256,
      mime: row.mime,
      ...assetProof(store, workId, row)?.dimensions
    }))
  };
  const bytes = Buffer.from(JSON.stringify(info, null, 2), 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!previous?.missing && previous?.sha256 === sha256) return;
  const stage = await openFileStage({
    store,
    layout,
    jobId,
    workId,
    key: 'metadata',
    kind: 'metadata',
    resourceIdentity: sha256,
    guard
  });
  stage.commit.body.archiveRevision = archiveRevision(store, workId);
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
  } finally {
    await handle.close();
  }
  await verifyAndPlace({
    store,
    layout,
    stage,
    home,
    previous: previousProof,
    filename: metadataName,
    mime: 'application/json',
    transferred: { file, size: bytes.length, sha256 },
    signal,
    guard
  });
}

const success = () => ({ ok: true, pending: false, errors: [] });

export async function finalizeWorkFiles({
  store,
  layout,
  workId,
  jobId = 'reconcile',
  signal,
  guard: assertWriter
}) {
  const revision = archiveRevision(store, workId);
  const work = store.work(workId);
  const saved = savedHome(store, workId);
  if (!work || !saved) throw missing();
  const guard = () => {
    signal?.throwIfAborted();
    assertWriter?.();
    if (archiveRevision(store, workId) !== revision)
      throw problem('NAS_ARCHIVE_STALE', '作品信息已更新，请重新整理。');
    assertWorkFiles(store, workId);
  };
  try {
    guard();
    if (store.fileCommits(workId).some((commit) => commit.stage === 'review')) throw review();
    const after = await withWorkFiles(layout, '\0home-allocation', async () => {
      guard();
      const moving = store.fileCommits(workId).find((entry) => entry.stage === 'moving');
      if (moving) {
        const stale = moving.body.archiveRevision !== undefined && moving.body.archiveRevision !== revision;
        const settled = await applyMove({ store, layout, commit: moving, recoverOnly: stale, guard });
        if (!settled && stale) updateCommit(store, moving, 'cancelled');
      }
      const before = savedHome(store, workId);
      const target = await chooseHome({ store, layout, work, saved: before, guard });
      const after = { home: target.home, identity: before.identity, collectionName: target.collectionName };
      guard();
      if (homePath(before.home) !== homePath(after.home)) {
        const owned = await directory(layout.media, homePath(before.home));
        if (!same(owned.stat, before.identity)) throw review();
        const assets = store.resources(workId);
        const names = new Set(assets.map((row) => path.posix.basename(row.relative_path)));
        if ((await fs.readdir(owned.file)).some((name) => !names.has(name))) throw review();
        for (const asset of assets)
          await resolveResource({ store, layout, workId, key: asset.key, verify: true, signal });
        guard();
        const commit = {
          id: randomUUID(),
          workId,
          resourceId: null,
          stage: 'moving',
          body: { before, after, kind: 'move', jobId, archiveRevision: revision }
        };
        updateCommit(store, commit);
        await applyMove({ store, layout, commit, guard });
      } else if (JSON.stringify(before) !== JSON.stringify(after)) {
        store.withWrite((db) => saveHome(db, workId, after, store.nextRevision()));
      }
      return after;
    });
    await writeMetadata({ store, layout, work, home: after, jobId, signal, guard });
    guard();
    return { ...success(), home: after.home };
  } catch (error) {
    return { ok: false, pending: true, errors: [{ workId, ...fileReason(error) }] };
  }
}

export async function reconcileWork({ store, layout, workId, guard }) {
  const recovered = await recoverFileCommits({ store, layout, workId, guard });
  const errors = recovered.filter((result) => result.error).map((result) => ({ workId, ...result.error }));
  if (errors.length) return { ok: false, pending: true, errors };
  return withWorkFiles(layout, workId, () => finalizeWorkFiles({ store, layout, workId, guard }));
}
