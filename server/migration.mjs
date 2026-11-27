import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openLibrary, inspectLayout, connect, syncDirectory, CURRENT_SCHEMA } from './library.mjs';
import { moveExclusive } from './files.mjs';
import { reconcile } from './legacy-rehearsal.mjs';
import { child, directory, disjoint, fileProof, segment, validateSeal } from './rehearsal-files.mjs';
import { preserveBeforeRollback, verifyRestore } from './recovery.mjs';
import { contentHash, validId } from '../shared/backup-protocol.mjs';
export { sealSource } from './rehearsal-files.mjs';

async function prepare({ sources, target, uid, imageDigest, guard = () => {} }) {
  if (
    !Array.isArray(sources) ||
    !sources.length ||
    sources.length > 32 ||
    !validId(uid) ||
    !/^sha256:[a-f0-9]{64}$/.test(imageDigest)
  )
    throw Error('请指定来源、核实的账号及运行镜像摘要。');
  segment(path.basename(target));
  const parent = directory(path.dirname(target));
  if (path.join(parent, path.basename(target)) !== target) throw Error('独立目标路径无效。');
  const checked = [];
  for (const s of sources) {
    disjoint(s.directory, target);
    guard();
    checked.push(await validateSeal(s));
  }
  if (checked.every((s) => s.kind === 'recovery')) throw Error('需要当前活动来源以核对历史恢复候选。');
  const plan = await reconcile(checked, uid);
  guard();
  const counts = {};
  for (const r of plan.rows) counts[r.type] = (counts[r.type] ?? 0) + 1;
  counts.media = plan.assets.length;
  const dbBytes = checked.reduce(
    (n, s) => n + s.files.filter((f) => !f.relative.includes('/')).reduce((k, f) => k + f.size, 0),
    0
  );
  const mediaBytes = plan.assets.reduce((n, f) => n + f.size, 0);
  const requiredBytes = 4 * (dbBytes + 1048576) + 2 * mediaBytes;
  const stat = fs.statSync(parent, { bigint: true });
  const previewId = contentHash({
    version: 1,
    schema: CURRENT_SCHEMA,
    target,
    parent: [String(stat.dev), String(stat.ino)],
    uid,
    imageDigest,
    sources: checked.map((s) => [s.directory, s.seal]),
    result: contentHash({ ...plan, assets: plan.assets.map(({ from, ...asset }) => asset) })
  });
  return {
    plan,
    checked,
    report: {
      previewId,
      target,
      uid,
      counts,
      conflicts: plan.conflicts,
      requiredBytes,
      identities: plan.identities,
      bytes: { database: dbBytes, media: mediaBytes },
      imageDigest
    }
  };
}
function checkSpace(target, requiredBytes) {
  const stats = fs.statfsSync(path.dirname(target), { bigint: true });
  if (stats.bavail * stats.bsize < BigInt(requiredBytes)) throw Error('目标、暂存及回退空间不足。');
}
export async function previewImport(input) {
  if (fs.existsSync(input.target)) throw Error('目标名已存在，请为彩排指定新目录。');
  const { report } = await prepare(input);
  checkSpace(input.target, report.requiredBytes);
  return report;
}
const idOf = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino) });
const mimeByExt = {
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav'
};
function populate(db, uid, rows, assets, media) {
  db.prepare('INSERT INTO source_account VALUES(1,?,?,NULL)').run(uid, '');
  const priority = { work: 0, source: 1, run: 2 };
  for (const { type, key, value: v, work } of [...rows].sort(
    (a, b) => (priority[a.type] ?? 3) - (priority[b.type] ?? 3)
  )) {
    const j = JSON.stringify;
    switch (type) {
      case 'work':
        db.prepare('INSERT INTO works VALUES(?,?,?)').run(key, v.title || v.name, j(v));
        break;
      case 'source':
        db.prepare('INSERT INTO read_sources VALUES(?,?,?,?,?,?)').run(
          key,
          uid,
          v.name || key,
          j(v),
          v.added === false || v.archived ? 0 : 1,
          v.remoteMissing ? 1 : 0
        );
        break;
      case 'member':
        db.prepare('INSERT INTO source_members(source_id,work_id,position) VALUES(?,?,?)').run(
          v.source,
          work,
          v.position
        );
        break;
      case 'tags':
        for (const tag of v) db.prepare('INSERT INTO work_tags VALUES(?,?)').run(work, tag);
        break;
      case 'run':
        db.prepare('INSERT INTO read_legacy_runs VALUES(?,?,?)').run(key, v.started, j(v.summary));
        break;
      case 'logItem':
        db.prepare('INSERT INTO read_legacy_items VALUES(?,?,?,?)').run(v.run, v.kind, v.position, j(v.body));
        break;
      case 'profile':
        db.prepare('INSERT INTO source_creator_profiles VALUES(?,?)').run(key, j(v));
        break;
      case 'audioHint':
        db.prepare('INSERT INTO source_audio_hints VALUES(?,?)').run(key, j(v));
        break;
      case 'home': {
        const homeDir = path.join(media, ...v.folder.split('/'), v.workFolder);
        fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
        db.prepare('INSERT INTO archive_homes VALUES(?,?)').run(
          work,
          j({ home: v, identity: idOf(fs.statSync(homeDir, { bigint: true })), collectionName: v.folder })
        );
        break;
      }
      case 'task': {
        const job = {
          id: 'legacy:' + work,
          workId: work,
          title: db.prepare('SELECT title FROM works WHERE id=?').get(work).title,
          state: 'cancelled',
          expected: [],
          completedKeys: [],
          phase: 'legacy',
          legacyTask: v,
          legacyState: v.state,
          legacyRank: v.rank,
          reason: { code: 'LEGACY_TASK', message: '旧任务状态 ' + v.state + '。重新选择下载资源后可入队。' }
        };
        db.prepare('INSERT INTO download_jobs VALUES(?,?,?)').run(job.id, work, job.state);
        db.prepare('INSERT INTO download_manifests(id,work_id,body) VALUES(?,?,?)').run(job.id, work, j(job));
        break;
      }
    }
  }
  let revision = 0;
  for (const a of assets) {
    const file = child(media, a.relative),
      stat = fs.lstatSync(file, { bigint: true }),
      id = a.work + ':' + a.key;
    const mime = mimeByExt[path.extname(a.relative).toLowerCase()] || 'application/octet-stream';
    db.prepare('INSERT INTO media_files VALUES(?,?,?,?,?)').run(id, a.work, a.relative, a.size, a.sha256);
    db.prepare('INSERT INTO archive_assets VALUES(?,?,?,?,?)').run(id, a.key, a.kind, mime, ++revision);
    db.prepare('INSERT INTO file_commits VALUES(?,?,?,?,?,?)').run(
      randomUUID(),
      a.work,
      id,
      'registered',
      JSON.stringify({
        key: a.key,
        kind: a.kind,
        relative: a.relative,
        size: a.size,
        sha256: a.sha256,
        mime,
        identity: idOf(stat),
        mtimeNs: String(stat.mtimeNs),
        registeredChangeNs: String(stat.ctimeNs),
        files: {}
      }),
      revision
    );
  }
}
function databaseDigest(db, ...exclude) {
  const hash = createHash('sha256');
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .iterate()) {
    hash.update(JSON.stringify(name));
    const skip =
      name === 'upgrade_receipts'
        ? ' WHERE operation_id NOT IN (' + exclude.map(() => '?').join(',') + ')'
        : '';
    for (const row of db
      .prepare('SELECT * FROM "' + name + '"' + skip + ' ORDER BY rowid')
      .iterate(...(skip ? exclude : [])))
      hash.update(JSON.stringify(row) + '\n');
  }
  return hash.digest('hex');
}
async function existing(target, previewId, guard) {
  const layout = inspectLayout(target),
    db = connect(layout);
  try {
    db.exec('BEGIN');
    const r = db.prepare('SELECT body FROM upgrade_receipts WHERE operation_id=?').get(previewId);
    if (!r) throw Error('目标已存在且无匹配的迁移批准。');
    const receipt = JSON.parse(r.body),
      snapshot = child(path.join(layout.dir, 'snapshots'), segment(receipt.snapshotId));
    const mediaRoot = path.join(layout.dir, 'media');
    if (receipt.libraryId !== layout.libraryId || receipt.state !== databaseDigest(db, previewId))
      throw Error('彩排目标已有后续变化，请保全新增资料。');
    const verification = await verifyRestore({
      snapshot,
      mediaRoot,
      manifestSha256: receipt.manifestSha256,
      guard
    });
    if (!verification.verified) throw Error('彩排目标媒体发生变化。');
    return { ...receipt, snapshot, mediaRoot, verification };
  } finally {
    db.close();
  }
}
export async function importApproved(input) {
  const { target, approval, uid, imageDigest, previewId, guard = () => {} } = input;
  if (
    approval?.confirmed !== true ||
    approval.uid !== uid ||
    approval.target !== target ||
    approval.previewId !== previewId
  )
    throw Error('需明确确认本次预览、账号与独立目标。');
  const { plan, checked, report } = await prepare(input);
  if (previewId !== report.previewId) throw Error('预览已变化，请重新核对。');
  if (fs.existsSync(target)) return existing(target, previewId, guard);
  checkSpace(target, report.requiredBytes);
  const parent = path.dirname(target),
    scratch = path.join(parent, '.cx-' + previewId.slice(0, 32));
  if (!fs.existsSync(scratch)) {
    const fresh = fs.mkdtempSync(path.join(parent, '.cangxia-rehearsal-init-'));
    try {
      const stage = path.join(fresh, 'volume');
      fs.mkdirSync(stage);
      const initialized = openLibrary({ root: stage, mode: 'init' });
      const binding = {
        previewId,
        target,
        libraryId: initialized.libraryId,
        identity: idOf(fs.statSync(fresh, { bigint: true }))
      };
      initialized.close();
      fs.writeFileSync(path.join(fresh, 'binding.json'), JSON.stringify(binding), {
        flag: 'wx',
        mode: 0o600,
        flush: true
      });
      fs.writeFileSync(path.join(fresh, 'lock.sqlite'), '', { flag: 'wx', mode: 0o600, flush: true });
      syncDirectory(fresh);
      try {
        await moveExclusive(fresh, scratch, { directory: true });
      } catch (e) {
        if (!fs.existsSync(scratch)) throw e;
      }
      syncDirectory(parent);
    } finally {
      if (fs.existsSync(fresh)) fs.rmSync(fresh, { recursive: true, force: true });
    }
  }
  directory(scratch);
  const bindingFile = child(scratch, 'binding.json'),
    lockFile = child(scratch, 'lock.sqlite');
  for (const file of [bindingFile, lockFile]) {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink !== 1) throw Error('彩排暂存目录变化。');
  }
  const binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
  if (
    binding.target !== target ||
    binding.previewId !== previewId ||
    contentHash(binding.identity) !== contentHash(idOf(fs.statSync(scratch, { bigint: true })))
  )
    throw Error('彩排暂存身份不符。');
  const lock = new DatabaseSync(lockFile, { timeout: 0 }),
    stage = child(scratch, 'volume');
  try {
    lock.exec('BEGIN IMMEDIATE');
    if (fs.existsSync(target)) return await existing(target, previewId, guard);
    const library = openLibrary({ root: stage, expectedId: binding.libraryId }),
      layout = inspectLayout(stage, library.libraryId),
      media = path.join(layout.dir, 'media');
    try {
      for (const asset of plan.assets) {
        guard();
        const parentDir = path.join(media, ...asset.relative.split('/').slice(0, -1).map(segment));
        fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
        const out = child(media, asset.relative),
          from = checked[asset.from.index];
        if (!fs.existsSync(out)) {
          const pending = child(scratch, 'transfer.partial');
          if (fs.existsSync(pending)) {
            const st = fs.lstatSync(pending);
            if (!st.isFile() || st.nlink !== 1) throw Error('暂存文件身份不符。');
            fs.unlinkSync(pending);
          }
          await fs.promises.copyFile(
            child(from.directory, asset.from.relative),
            pending,
            fs.constants.COPYFILE_EXCL
          );
          if ((await fileProof(pending)).sha256 !== asset.sha256) throw Error('暂存传输校验失败。');
          guard();
          await moveExclusive(pending, out);
        }
        const verified = await fileProof(out);
        if (verified.sha256 !== asset.sha256 || verified.size !== asset.size)
          throw Error('媒体传输校验失败。');
        const fd = fs.openSync(out, 'r+');
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        syncDirectory(parentDir);
      }
      const phase = 'populate-' + previewId;
      library.write((db) => {
        const marker = db.prepare('SELECT body FROM upgrade_receipts WHERE operation_id=?').get(phase);
        if (marker) {
          const previous = JSON.parse(marker.body);
          if (previous.previewId !== previewId || previous.state !== databaseDigest(db, phase, previewId))
            throw Error('暂存数据库已有后续变化。');
          return;
        }
        if (db.prepare('SELECT 1 FROM works UNION ALL SELECT 1 FROM source_account').get())
          throw Error('暂存目标已有未确认资料。');
        populate(db, uid, plan.rows, plan.assets, media);
        db.prepare('INSERT INTO upgrade_receipts VALUES(?,?)').run(
          phase,
          JSON.stringify({ previewId, state: databaseDigest(db, phase, previewId) })
        );
      });
      if (
        !library.read((db) =>
          db.prepare('SELECT 1 FROM upgrade_receipts WHERE operation_id=?').get(previewId)
        )
      ) {
        const snapshot = await preserveBeforeRollback({
          root: stage,
          libraryId: library.libraryId,
          imageDigest,
          confirmed: true,
          guard
        });
        if (!snapshot.verified) throw Error('彩排数据库或媒体校验未通过。');
        library.write((db) => {
          const receipt = {
            previewId,
            libraryId: library.libraryId,
            snapshotId: path.basename(snapshot.snapshot),
            manifestSha256: snapshot.manifestSha256,
            counts: report.counts,
            uid,
            state: databaseDigest(db, previewId),
            externalBackupRequired: true
          };
          db.prepare('INSERT INTO upgrade_receipts VALUES(?,?)').run(previewId, JSON.stringify(receipt));
        });
      }
      await existing(stage, previewId, guard);
    } finally {
      library.close();
    }
    for (const s of checked) await validateSeal(s);
    guard();
    syncDirectory(stage);
    try {
      await moveExclusive(stage, target, { directory: true });
    } catch (e) {
      if (!fs.existsSync(target)) throw e;
    }
    syncDirectory(parent);
    return await existing(target, previewId, guard);
  } finally {
    lock.close();
  }
}
