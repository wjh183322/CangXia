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
    version: 2,
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
function saveImportedDownloads(db, rows, assets) {
  const works = new Map(rows.filter((r) => r.type === 'work').map((r) => [r.key, r.value]));
  const downloads = new Map(rows.filter((r) => r.type === 'download').map((r) => [r.work, r.value]));
  const tasks = new Map(rows.filter((r) => r.type === 'task').map((r) => [r.work, r.value]));
  const verified = new Map();
  for (const a of assets) {
    const set = verified.get(a.work) ?? new Set();
    set.add(a.key);
    verified.set(a.work, set);
  }
  function put(job, hidden) {
    db.prepare('INSERT INTO download_jobs VALUES(?,?,?)').run(job.id, job.workId, job.state);
    db.prepare('INSERT INTO download_manifests(id,work_id,body,hidden) VALUES(?,?,?,?)').run(
      job.id,
      job.workId,
      JSON.stringify(job),
      Number(hidden)
    );
  }
  // The formal download page shows newest rowids first. Insert imported rows in reverse
  // native display order so future native jobs still appear first. The old active page
  // displayed running jobs ahead of waiting jobs, then used the durable rank in each bucket.
  const ids = [...new Set([...downloads.keys(), ...tasks.keys()])].sort((a, b) => {
    const left = tasks.get(a),
      right = tasks.get(b);
    if (!left || !right) return Number(!!left) - Number(!!right);
    return (
      Number(left.state === 'running') - Number(right.state === 'running') ||
      right.rank - left.rank ||
      (a < b ? 1 : a > b ? -1 : 0)
    );
  });
  for (const id of ids) {
    const work = works.get(id),
      archive = downloads.get(id),
      task = tasks.get(id),
      saved = verified.get(id) ?? new Set();
    const primary = work.type === 'video' ? ['video'] : (work.images?.map((im) => 'image-' + im.index) ?? []);
    const required = [
      ...new Set([
        ...primary,
        ...(archive?.requiredKeys ?? []),
        ...(work.type === 'video' && work.coverUrls?.length ? ['cover'] : [])
      ])
    ];
    const complete =
      archive?.state === 'complete' &&
      primary.length > 0 &&
      required.every((k) => saved.has(k)) &&
      archive.recordedKeys.every((k) => saved.has(k));
    const base = {
      workId: id,
      title: work.name,
      phase: 'legacy',
      expected: required.map((key) => ({ key })),
      completedKeys: required.filter((k) => saved.has(k))
    };
    if (archive) {
      put(
        {
          ...base,
          id: 'legacy-archive:' + id,
          state: complete ? 'complete' : 'partial',
          filesComplete: complete,
          legacyArchive: archive
        },
        true
      );
      if (!complete && saved.size)
        db.prepare("INSERT INTO maintenance_file_state VALUES(?,'partial')").run(id);
    }
    if (task) {
      const state =
        task.state === 'complete'
          ? complete
            ? 'complete'
            : 'review'
          : ['running', 'waiting', 'queued', 'paused'].includes(task.state)
            ? 'paused'
            : ['failed', 'unavailable', 'cancelled'].includes(task.state)
              ? task.state
              : 'review';
      put(
        {
          ...base,
          id,
          state,
          legacyState: task.state,
          legacyRank: task.rank,
          legacyTask: task,
          reason: { code: 'LEGACY_TASK', message: '旧任务状态 ' + task.state + '，按本次选择重新核验来源。' }
        },
        false
      );
    }
  }
}
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
        break; // The legacy primary key was session/work, so multiple items may share the same recorded position.
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
      case 'task':
      case 'download':
        break; // Registered after the actual media and required keys have been checked.
    }
  }
  const logItems = rows
    .filter((r) => r.type === 'logItem')
    .map((r) => r.value)
    .sort((a, b) => a.position - b.position || String(a.body.id).localeCompare(String(b.body.id), 'en'));
  const offsets = new Map();
  for (const item of logItems) {
    const n = offsets.get(item.run) ?? 0;
    offsets.set(item.run, n + 1);
    db.prepare('INSERT INTO read_legacy_items VALUES(?,?,?,?)').run(
      item.run,
      item.kind,
      n,
      JSON.stringify({ ...item.body, position: item.position })
    );
  }
  saveImportedDownloads(db, rows, assets);
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
        ...(a.musicId
          ? {
              resourceIdentity: contentHash({
                workId: a.work,
                key: 'audio',
                kind: 'audio',
                sourceIdentity: 'music:' + a.musicId
              })
            }
          : {}),
        files: {}
      }),
      revision
    );
  }
  db.prepare('UPDATE download_options SET revision=max(revision,?)').run(revision);
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
      uid: receipt.uid,
      libraryId: receipt.libraryId,
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
          const original = child(from.directory, asset.from.relative);
          if (asset.metadataJSON !== undefined) {
            const verified = await fileProof(original);
            if (verified.sha256 !== asset.from.sha256 || verified.size !== asset.from.size)
              throw Error('旧作品信息 JSON 与批准的原始摘要不符。');
            await fs.promises.writeFile(pending, asset.metadataJSON, {
              flag: 'wx',
              mode: 0o600,
              flush: true
            });
          } else await fs.promises.copyFile(original, pending, fs.constants.COPYFILE_EXCL);
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
