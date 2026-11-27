import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { openDownloadStore } from './download-store.mjs';
import { verifyFormat } from './downloads.mjs';
import { audioInfo } from '../electron/audio-info.mjs';
import { mediaList, serveMedia } from './media.mjs';
import { resolveResource, moveExclusive, registeredAssetProof, currentHDCover } from './files.mjs';
import { contentHash } from '../shared/backup-protocol.mjs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  APP_ID,
  CURRENT_SCHEMA,
  openLibrary,
  writeDurably,
  syncDirectory,
  connect,
  describe,
  inspectLayout,
  isUuid,
  verifyIdentity
} from './library.mjs';
import { inventory, verifiedSnapshot } from './upgrade.mjs';
import { child, directory, disjoint, fileProof, segment } from './rehearsal-files.mjs';

// A separate process cannot release the live download worker's POSIX SQLite lock by closing a descriptor.
const checkLock = promisify(execFile);
async function ownWorkerFile(file, libraryId) {
  try {
    await checkLock(
      process.execPath,
      [fileURLToPath(new URL('./verify-worker-lock.mjs', import.meta.url)), file, libraryId],
      { timeout: 10000, windowsHide: true }
    );
    return true;
  } catch {
    return false;
  }
}
export async function verifyRestore({
  snapshot,
  mediaRoot,
  manifestSha256,
  uid,
  libraryId,
  guard = () => {}
}) {
  directory(snapshot);
  directory(mediaRoot);
  disjoint(snapshot, mediaRoot);
  guard();
  if (
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    fs.readdirSync(snapshot).sort().join() !== 'library.sqlite,manifest.json'
  )
    throw Error('需要已封存的快照、独立媒体目录及原始清单摘要。');
  const manifestFile = child(snapshot, 'manifest.json'),
    file = child(snapshot, 'library.sqlite');
  if ((await fileProof(manifestFile)).sha256 !== manifestSha256) throw Error('恢复清单与原始摘要不符。');
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (!isUuid(libraryId) || m.libraryId !== libraryId) throw Error('恢复库身份与批准不符。');
  if (
    !isUuid(m.libraryId) ||
    !isUuid(m.operationId) ||
    !/^sha256:[a-f0-9]{64}$/.test(m.imageDigest) ||
    (await fileProof(file)).sha256 !== m.databaseSha256
  )
    throw Error('恢复数据库身份或文件摘要不符。');
  const db = new DatabaseSync(pathToFileURL(file).href + '?mode=ro&immutable=1', { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema=OFF');
    if (
      verifyIdentity(db, m.libraryId) !== m.from ||
      db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').get()
    )
      throw Error('恢复数据库结构或完整性不符。');
    const account = m.from >= 4 && db.prepare('SELECT uid FROM source_account WHERE singleton=1').get()?.uid;
    if (typeof uid !== 'string' || !account || account !== uid) throw Error('恢复数据库与批准账号不符。');
    const actual = inventory(db);
    if (actual.media.some((r) => r.relative_path.split('/')[0].startsWith('.cangxia-')))
      throw Error('媒体清单引用了服务专用文件。');
    if (
      JSON.stringify(actual.counts) !== JSON.stringify(m.counts) ||
      JSON.stringify(actual.media) !== JSON.stringify(m.media)
    )
      throw Error('快照中的业务记录与媒体清单不符。');
  } finally {
    db.close();
  }
  const matched = [],
    missing = [],
    changed = [],
    extra = [];
  const listed = new Set(m.media.map((i) => i.relative_path));
  async function scan(dir, prefix = '') {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      guard();
      const rel = prefix + entry.name;
      if (entry.isDirectory()) await scan(directory(path.join(dir, entry.name)), rel + '/');
      else if (!listed.has(rel)) {
        if (
          rel === '.cangxia-staging/worker.sqlite' &&
          (await ownWorkerFile(child(mediaRoot, rel), m.libraryId))
        )
          continue;
        extra.push(rel);
      }
    }
  }
  await scan(mediaRoot);
  for (const item of m.media) {
    guard();
    try {
      const proof = await fileProof(child(mediaRoot, item.relative_path));
      if (proof.size === item.size && proof.sha256 === item.sha256) matched.push(item.relative_path);
      else changed.push(item.relative_path);
    } catch (e) {
      if (e.code === 'ENOENT') missing.push(item.relative_path);
      else changed.push(item.relative_path);
    }
  }
  guard();
  if (
    (await fileProof(file)).sha256 !== m.databaseSha256 ||
    (await fileProof(manifestFile)).sha256 !== manifestSha256
  )
    throw Error('核验期间恢复点发生变化。');
  return {
    matched,
    missing,
    changed,
    extra,
    libraryId: m.libraryId,
    schema: m.from,
    imageDigest: m.imageDigest,
    createdAt: m.createdAt,
    counts: m.counts,
    databaseVerified: true,
    verified: !missing.length && !changed.length && !extra.length
  };
}
function businessFingerprint(db) {
  const hash = createHash('sha256');
  for (const { name } of db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('interactive_lease','command_receipts') AND name NOT GLOB 'sqlite_*' ORDER BY name"
    )
    .iterate()) {
    hash.update(name + '\n');
    for (const row of db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').iterate())
      hash.update(JSON.stringify(row) + '\n');
  }
  return hash.digest('hex');
}
export async function preserveBeforeRollback({
  root,
  libraryId,
  imageDigest,
  confirmed,
  guard = () => {},
  destination,
  uid,
  operationId = randomUUID()
}) {
  if (
    confirmed !== true ||
    !isUuid(libraryId) ||
    !isUuid(operationId) ||
    !/^sha256:[a-f0-9]{64}$/.test(imageDigest)
  )
    throw Error('请明确确认要封存的资料库、版本及镜像摘要。');
  const layout = inspectLayout(root, libraryId),
    writer = connect(layout);
  try {
    writer.exec('BEGIN');
    if (destination) {
      directory(destination);
      disjoint(root, destination);
    }
    const boundUid = writer.prepare('SELECT uid FROM source_account WHERE singleton=1').get()?.uid;
    if (!boundUid || (uid && uid !== boundUid)) throw Error('要封存的资料库账号不符。');
    guard();
    const status = describe(layout, writer);
    const before = destination && businessFingerprint(writer);
    writer.exec('COMMIT');
    const s = fs.statfsSync(destination ?? root, { bigint: true });
    if (
      s.bavail * s.bsize <
      BigInt(writer.prepare('PRAGMA page_count').get().page_count) *
        BigInt(writer.prepare('PRAGMA page_size').get().page_size) *
        2n +
        1048576n
    )
      throw Error('快照空间不足。');
    const receipt = await verifiedSnapshot(layout, status, {
      imageDigest,
      rehearsal: true,
      externalRoot: destination,
      approval: { operationId }
    });
    const snapshot = destination
        ? path.join(destination, path.basename(receipt.snapshot))
        : path.join(layout.dir, receipt.snapshot),
      mediaRoot = path.join(layout.dir, 'media');
    const verification = await verifyRestore({
      snapshot,
      mediaRoot,
      manifestSha256: receipt.manifestSha256,
      uid: boundUid,
      libraryId,
      guard
    });
    writer.exec('BEGIN');
    guard();
    const updatedAfterSnapshot = !!destination && before !== businessFingerprint(writer);
    return {
      ...receipt,
      snapshot,
      mediaRoot,
      verified: verification.verified && !updatedAfterSnapshot,
      updatedAfterSnapshot,
      verification,
      requiresExternalCopy: true
    };
  } finally {
    writer.close();
  }
}

function statIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function rebindFiles(db, media, guard) {
  const homes = new Map(),
    paths = new Set();
  for (const row of db.prepare('SELECT work_id,body FROM archive_homes').iterate()) {
    guard();
    const body = JSON.parse(row.body),
      parts = [...body.home.folder.split('/'), body.home.workFolder].map(segment);
    const relative = parts.join('/'),
      folded = relative.normalize('NFC').toLowerCase();
    if (paths.has(folded) || parts[0].startsWith('.cangxia-')) throw Error('归档目录所有权冲突。');
    paths.add(folded);
    const dir = path.join(media, ...parts);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    directory(dir);
    homes.set(row.work_id, relative);
    body.identity = statIdentity(fs.lstatSync(dir, { bigint: true }));
    db.prepare('UPDATE archive_homes SET body=? WHERE work_id=?').run(JSON.stringify(body), row.work_id);
  }
  const rows = db
    .prepare('SELECT m.*,a.key FROM media_files m LEFT JOIN archive_assets a ON a.id=m.id ORDER BY m.id')
    .all();
  for (const r of rows) {
    guard();
    if (!r.key || path.posix.dirname(r.relative_path) !== homes.get(r.work_id))
      throw Error('媒体清单与原归档目录不符。');
    const commit = db
      .prepare(
        "SELECT id,body FROM file_commits WHERE work_id=? AND resource_id=? AND stage='registered' AND json_extract(body,'$.sha256')=? AND json_extract(body,'$.size')=? ORDER BY revision DESC LIMIT 1"
      )
      .get(r.work_id, r.id, r.sha256, r.size);
    if (!commit) throw Error('原数据库缺少媒体登记证明。');
    const proof = JSON.parse(commit.body),
      st = fs.lstatSync(child(media, r.relative_path), { bigint: true });
    Object.assign(proof, {
      identity: statIdentity(st),
      relative: r.relative_path,
      mtimeNs: String(st.mtimeNs),
      registeredChangeNs: String(st.ctimeNs)
    });
    db.prepare('UPDATE file_commits SET body=? WHERE id=?').run(JSON.stringify(proof), commit.id);
  }
  return rows;
}
async function verifyReadable(store, rows, guard, head = false) {
  const session = { signal: new AbortController().signal, guard },
    media = new Map();
  let streamed = 0;
  const inactive = [];
  for (const r of rows) {
    guard();
    const resource = await resolveResource({
      store,
      layout: store.layout,
      workId: r.work_id,
      key: r.key,
      verify: r.key === 'metadata' && !head,
      signal: session.signal
    });
    if (!resource || resource.sha256 !== r.sha256) throw Error('正常归档读取未核实恢复文件。');
    if (r.key === 'metadata') continue;
    if (!media.has(r.work_id))
      media.set(r.work_id, new Map(mediaList(store.db, r.work_id).map((m) => [m.key, m])));
    const item = media.get(r.work_id).get(r.key);
    let inactiveReason;
    if (!item?.saved || item.version !== resource.revision + '-' + r.sha256) {
      const proof = registeredAssetProof(store.db, r.work_id, resource);
      if (!item?.saved && r.key === 'audio') {
        const currentMusic = store.work(r.work_id).music?.id;
        if (
          currentMusic &&
          /^[a-f0-9]{64}$/.test(proof?.resourceIdentity) &&
          proof.resourceIdentity !==
            contentHash({
              workId: r.work_id,
              key: 'audio',
              kind: 'audio',
              sourceIdentity: 'music:' + currentMusic
            })
        )
          inactiveReason = '已保留先前配乐，当前作品音乐身份已更新';
      } else if (!item?.saved && r.key === 'cover-hd' && !currentHDCover(store.db, r.work_id)) {
        const historical = store.db
          .prepare(
            "SELECT 1 FROM hd_covers WHERE work_id=? AND json_extract(body,'$.key')=? AND json_extract(body,'$.sha256')=?"
          )
          .get(r.work_id, r.key, r.sha256);
        if (historical) inactiveReason = '已保留原匹配封面，当前视频或参考图已更新';
      }
      if (!inactiveReason) throw Error('正常播放入口没有此版本的已存资源。');
    }
    if (!head && resource.kind === 'audio') {
      const info = await audioInfo(resource.file, session.signal);
      if (
        { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav' }[info.format] !==
        resource.mime
      )
        throw Error('恢复的配乐格式与登记不符。');
    } else if (!head) await verifyFormat(resource, resource.mime, session.signal);
    if (inactiveReason) {
      if (!head) {
        const verified = await fileProof(resource.file);
        if (verified.sha256 !== r.sha256 || verified.size !== r.size)
          throw Error('非当前资源的归档字节与登记不符。');
      }
      inactive.push({
        workId: r.work_id,
        key: r.relative_path,
        type: 'inactiveMedia',
        reason: inactiveReason
      });
      continue;
    }
    const hash = createHash('sha256');
    let count = 0,
      status;
    const response = new Writable({
      write(chunk, _encoding, done) {
        count += chunk.length;
        hash.update(chunk);
        done();
      }
    });
    response.writeHead = (code) => {
      status = code;
      return response;
    };
    await serveMedia({ headers: {} }, response, {
      downloads: { store, layout: store.layout },
      session,
      body: { resourceId: item.resourceId, version: item.version, head }
    });
    if (status !== 200 || (!head && (count !== r.size || hash.digest('hex') !== r.sha256)))
      throw Error('正式媒体播放接口读回字节不符。');
    streamed++;
  }
  return { streamed, inactive };
}
export async function restoreApproved(input) {
  const { snapshot, mediaRoot, target, manifestSha256, libraryId, uid, confirmed, guard = () => {} } = input;
  if (confirmed !== true || !isUuid(libraryId) || !uid)
    throw Error('请明确批准已核对的恢复点、账号及独立新目标。');
  segment(path.basename(target));
  const parent = directory(path.dirname(target));
  if (path.join(parent, path.basename(target)) !== target) throw Error('恢复目标路径无效。');
  disjoint(snapshot, target);
  disjoint(mediaRoot, target);
  if (fs.existsSync(target)) throw Error('恢复目标名已存在。');
  const checked = await verifyRestore(input);
  if (!checked.verified || checked.schema !== CURRENT_SCHEMA)
    throw Error('该恢复点或媒体尚未完全核实，请匹配程序版本。');
  const manifest = JSON.parse(fs.readFileSync(child(snapshot, 'manifest.json'), 'utf8'));
  const space = fs.statfsSync(parent, { bigint: true }),
    dbSize = fs.statSync(child(snapshot, 'library.sqlite'), { bigint: true }).size;
  if (
    space.bavail * space.bsize <
    dbSize * 3n + manifest.media.reduce((n, r) => n + BigInt(r.size), 1048576n)
  )
    throw Error('独立恢复目标空间不足。');
  const scratch = fs.mkdtempSync(path.join(parent, '.cx-restore-'));
  try {
    const dir = path.join(scratch, 'cangxia-server'),
      archive = path.join(dir, 'media');
    fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, 'snapshots'), { mode: 0o700 });
    writeDurably(path.join(dir, 'identity.json'), JSON.stringify({ appId: APP_ID, libraryId }));
    const file = path.join(dir, 'library.sqlite');
    await fs.promises.copyFile(child(snapshot, 'library.sqlite'), file, fs.constants.COPYFILE_EXCL);
    if ((await fileProof(file)).sha256 !== manifest.databaseSha256)
      throw Error('恢复数据库复制期间发生变化。');
    for (const item of manifest.media) {
      guard();
      const parts = item.relative_path.split('/').map(segment);
      if (parts[0].startsWith('.cangxia-')) throw Error('清单引用了运行时专用目录。');
      const parentDir = path.join(archive, ...parts.slice(0, -1));
      fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
      const out = child(archive, item.relative_path);
      await fs.promises.copyFile(child(mediaRoot, item.relative_path), out, fs.constants.COPYFILE_EXCL);
      const proof = await fileProof(out);
      if (proof.sha256 !== item.sha256 || proof.size !== item.size) throw Error('恢复媒体复制期间发生变化。');
      const fd = fs.openSync(out, 'r+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    const lib = openLibrary({ root: scratch, expectedId: libraryId });
    let streamed, rows;
    try {
      rows = lib.write((db) => {
        if (
          db
            .prepare(
              "SELECT 1 FROM file_commits WHERE stage NOT IN ('registered','complete','cancelled','cleaned','superseded','rejected','moved')"
            )
            .get() ||
          db.prepare(`SELECT 1 FROM removal_batches b JOIN removal_items i ON i.token=b.token
            WHERE b.scope IN ('files','restore-files') AND b.state NOT IN ('preview','discarded')
            AND (i.state NOT IN ('restored','cancelled','kept','done') OR
              (b.state='checking' AND i.ordinal=json_extract(b.body,'$.manual.ordinal'))) LIMIT 1`).get()
        )
          throw Error('存在单独需要恢复的文件操作或回收区，请先核对对应文件。');
        // The new volume cannot grant a confirmation issued against the previous mount and lease.
        db.exec("UPDATE removal_batches SET state='discarded' WHERE state='preview'");
        return rebindFiles(db, archive, guard);
      });
      const store = openDownloadStore({ root: scratch, library: lib });
      try {
        streamed = await verifyReadable(store, rows, guard);
      } finally {
        store.close();
      }
    } finally {
      lib.close();
    }
    if (!(await verifyRestore(input)).verified) throw Error('批准的恢复点在重绑定期间发生变化。');
    guard();
    syncDirectory(dir);
    syncDirectory(scratch);
    await moveExclusive(scratch, target, { directory: true });
    syncDirectory(parent);
    const published = openLibrary({ root: target, expectedId: libraryId });
    try {
      const store = openDownloadStore({ root: target, library: published });
      try {
        const publishedProof = await verifyReadable(store, rows, guard, true);
        if (
          publishedProof.streamed !== streamed.streamed ||
          JSON.stringify(publishedProof.inactive) !== JSON.stringify(streamed.inactive)
        )
          throw Error('恢复目标发布期间的当前媒体身份发生变化。');
      } finally {
        store.close();
      }
    } finally {
      published.close();
    }
    return {
      libraryId,
      uid,
      manifestSha256,
      target,
      registeredFiles: rows.length,
      verifiedPlayback: streamed.streamed,
      inactiveMedia: streamed.inactive,
      databaseVerified: true,
      verified: true
    };
  } finally {
    if (fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true, force: true });
  }
}
