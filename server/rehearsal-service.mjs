import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { child, directory, disjoint, digest, segment, separatePaths } from './rehearsal-files.mjs';
import { previewImport, importApproved } from './migration.mjs';
import { preserveBeforeRollback, verifyRestore, restoreApproved } from './recovery.mjs';
import { connect, inspectLayout, isUuid, writeDurably, syncDirectory } from './library.mjs';

const nameOf = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value))
    throw Error('请选择有效的彩排名称。');
  return segment(value);
};
const readJson = (file) => {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1) throw Error('配置或报告不是独立普通文件。');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
function configAt(root) {
  directory(root);
  for (const n of ['sources', 'manifests', 'targets', 'restores', 'reports']) directory(child(root, n));
  const config = readJson(child(root, 'rehearsal.json'));
  for (const n of [...Object.keys(config.sources), ...Object.keys(config.restores ?? {})]) nameOf(n);
  if (
    !/^[0-9]{1,30}$/.test(config.uid) ||
    !/^sha256:[a-f0-9]{64}$/.test(config.imageDigest) ||
    typeof config.accountId !== 'string'
  )
    throw Error('请配置彩排账号、来源及镜像摘要。');
  return config;
}
function checkRehearsalPaths(root, liveRoot, config, selected) {
  const area = (name) => directory(child(root, name));
  const reports = area('reports'),
    targets = area('targets'),
    sources = area('sources'),
    restores = area('restores'),
    manifests = area('manifests');
  const mountInfo = process.platform === 'linux' ? fs.readFileSync('/proc/self/mountinfo', 'utf8') : null;
  separatePaths([liveRoot, reports, targets, sources, restores, manifests], mountInfo);
  const sourceRoots = Object.keys(config.sources).map((n) => child(sources, nameOf(n)));
  const restoreRoots = Object.keys(config.restores ?? {}).map((n) => child(restores, nameOf(n)));
  const targetRoots = fs.readdirSync(targets).map((n) => child(targets, segment(n)));
  if (selected) {
    const named = child(targets, nameOf(selected));
    if (!targetRoots.includes(named)) targetRoots.push(named);
  }
  separatePaths([liveRoot, reports, manifests, ...sourceRoots, ...restoreRoots, ...targetRoots], mountInfo);
  const operands = restoreRoots.flatMap((base) => [path.join(base, 'snapshot'), path.join(base, 'media')]);
  separatePaths([liveRoot, reports, manifests, ...sourceRoots, ...targetRoots, ...operands], mountInfo);
  return reports;
}
function owner(config, session, accountId) {
  if (accountId !== config.accountId) throw Error('此账号无权访问这组彩排资料。');
  session.read((db) => {
    const active = db.prepare('SELECT uid FROM source_account WHERE singleton=1').get();
    if (active && active.uid !== config.uid) throw Error('当前账号与彩排来源不符。');
  });
}
function filesFor(root, config, names) {
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length)
    throw Error('须选择不重复的来源。');
  // All configured current/deletion sources are one protection set. Omitting one could resurrect deleted data.
  if (Object.keys(config.sources).sort().join() !== [...names].sort().join())
    throw Error('必须核对整组已配置来源及删除范围。');
  return [...names].sort().map((n) => {
    nameOf(n);
    const file = child(root, 'manifests/' + n + '.json'),
      st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink !== 1) throw Error('来源清单无效。');
    const bytes = fs.readFileSync(file);
    if (digest(bytes) !== config.sources[n]) throw Error('来源清单与管理员记录的摘要不符。');
    return { ...JSON.parse(bytes), directory: directory(child(root, 'sources/' + n)) };
  });
}
async function run({ root, liveRoot, input, config }, guard) {
  const action = input.action;
  if (['verify', 'restore'].includes(action)) {
    const restore = nameOf(input.restore),
      expected = config.restores?.[restore];
    if (!expected) throw Error('请选择配置好的独立恢复副本。');
    const base = directory(child(root, 'restores/' + restore));
    const args = {
      snapshot: directory(child(base, 'snapshot')),
      mediaRoot: directory(child(base, 'media')),
      manifestSha256: expected.manifestSha256,
      libraryId: expected.libraryId,
      uid: config.uid,
      guard
    };
    disjoint(liveRoot, args.snapshot);
    disjoint(liveRoot, args.mediaRoot);
    if (action === 'verify')
      return { ...(await verifyRestore(args)), restore, manifestSha256: args.manifestSha256 };
    if (
      input.manifestSha256 !== args.manifestSha256 ||
      input.libraryId !== args.libraryId ||
      input.uid !== config.uid
    )
      throw Error('请重新核对恢复点、库身份和账号后批准。');
    const target = child(root, 'targets/' + nameOf(input.target));
    disjoint(liveRoot, target);
    return restoreApproved({ ...args, target, confirmed: input.confirmed });
  }
  const target = child(root, 'targets/' + nameOf(input.target));
  disjoint(liveRoot, target);
  if (action === 'handoff') {
    if (input.uid !== config.uid || input.confirmed !== true)
      throw Error('请批准当前运行库的独立回退恢复点。');
    const layout = inspectLayout(liveRoot, input.libraryId);
    if (!layout) throw Error('当前运行库身份不符。');
    if (fs.existsSync(target)) throw Error('移交目标名已存在。');
    fs.mkdirSync(target, { mode: 0o700 });
    return preserveBeforeRollback({
      root: liveRoot,
      libraryId: input.libraryId,
      uid: config.uid,
      destination: target,
      imageDigest: config.imageDigest,
      confirmed: true,
      guard
    });
  }
  if (action === 'preserve') {
    const layout = inspectLayout(target, input.libraryId);
    if (!layout) throw Error('找不到指定彩排目标。');
    const db = connect(layout);
    try {
      const published = db
        .prepare(
          "SELECT 1 FROM upgrade_receipts WHERE operation_id=json_extract(body,'$.previewId') AND json_extract(body,'$.libraryId')=? AND json_extract(body,'$.uid')=?"
        )
        .get(input.libraryId, config.uid);
      if (!published) throw Error('仅允许封存本账号已发布的彩排目标。');
    } finally {
      db.close();
    }
    return preserveBeforeRollback({
      root: target,
      uid: config.uid,
      libraryId: input.libraryId,
      imageDigest: config.imageDigest,
      confirmed: input.confirmed,
      guard
    });
  }
  const sources = filesFor(root, config, input.sources),
    args = { sources, target, uid: config.uid, imageDigest: config.imageDigest, guard };
  for (const s of sources) disjoint(liveRoot, s.directory);
  if (action === 'preview') return previewImport(args);
  if (action === 'import')
    return importApproved({
      ...args,
      previewId: input.previewId,
      approval: {
        confirmed: input.confirmed === true && input.uid === config.uid,
        uid: input.uid,
        target,
        previewId: input.previewId
      }
    });
  throw Error('彩排操作无效。');
}
function finishReport(dir, name, value) {
  const pending = path.join(dir, name + '.pending');
  writeDurably(pending, JSON.stringify(value));
  fs.renameSync(pending, path.join(dir, name));
  syncDirectory(dir);
}
function saveResult(dir, result, checkDir) {
  const summary = { ...result };
  const audit = summary.conflicts ?? [],
    verification = summary.verification ?? summary;
  if (Array.isArray(summary.inactiveMedia)) {
    for (const r of summary.inactiveMedia) audit.push(r);
    summary.inactiveMedia = summary.inactiveMedia.length;
  }
  for (const key of ['matched', 'missing', 'changed', 'extra'])
    if (Array.isArray(verification[key])) {
      for (const file of verification[key])
        audit.push({
          type: 'media',
          key: file,
          reason: { matched: '已核验', missing: '缺失', changed: '变动', extra: '清单外文件，须另行核对' }[
            key
          ]
        });
      verification[key] = verification[key].length;
    }
  delete summary.conflicts;
  const disk = fs.statfsSync(dir, { bigint: true });
  const needed = BigInt(
    Buffer.byteLength(JSON.stringify(summary)) +
      audit.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row)) + 2, 0) +
      1048576
  );
  if (disk.bavail * disk.bsize < needed) throw Error('独立报告目录空间不足。');
  for (let pos = 0; pos < audit.length; pos += 50) {
    checkDir();
    writeDurably(
      path.join(dir, 'page-' + (pos / 50 + 1) + '.json'),
      JSON.stringify(audit.slice(pos, pos + 50))
    );
  }
  checkDir();
  finishReport(dir, 'result.json', { ...summary, total: audit.length });
}
if (!isMainThread && workerData?.rehearsalWorker) {
  const { flag, dir } = workerData;
  const guard = () => {
    if (Atomics.load(new Int32Array(flag), 0)) throw Error('彩排已取消或控制权已失效。');
  };
  const checkDir = () => {
    directory(dir);
    const current = fs.lstatSync(dir, { bigint: true });
    if (String(current.dev) + '/' + String(current.ino) !== workerData.reportIdentity)
      throw Error('彩排报告目录身份已变化。');
  };
  const validateOutput = () => {
    checkRehearsalPaths(workerData.root, workerData.liveRoot, workerData.config, workerData.input.target);
    checkDir();
  };
  try {
    validateOutput();
    const result = await run(workerData, guard);
    guard();
    validateOutput();
    saveResult(dir, result, checkDir);
    parentPort.postMessage('ready');
  } catch (e) {
    validateOutput();
    finishReport(dir, 'error.json', { message: e.message });
  }
}
export function createRehearsals({ root, liveRoot }) {
  const running = new Map();
  if (root) {
    directory(root);
    directory(liveRoot);
    disjoint(root, liveRoot);
  }
  function requireConfig() {
    if (!root) throw Error('请在 NAS 配置独立彩排目录和封存清单。');
    return configAt(root);
  }
  return {
    handle(session, accountId, input = {}) {
      const config = requireConfig();
      owner(config, session, accountId);
      const reports = checkRehearsalPaths(root, liveRoot, config, input.target);
      if (input.action === 'list') {
        const jobs = fs
          .readdirSync(reports)
          .filter((id) => isUuid(id) && fs.existsSync(child(reports, id + '/request.json')))
          .map((id) => ({ id, ...readJson(child(reports, id + '/request.json')) }))
          .filter((r) => r.accountId === accountId && r.uid === config.uid)
          .sort((a, b) => b.started.localeCompare(a.started));
        return {
          sources: Object.keys(config.sources).sort(),
          restores: Object.keys(config.restores ?? {}),
          uid: config.uid,
          libraryId: session.read(
            (db) => db.prepare('SELECT library_id FROM library_identity WHERE singleton=1').get().library_id
          ),
          jobs: jobs.slice(0, 50)
        };
      }
      if (['status', 'cancel'].includes(input.action)) {
        if (!isUuid(input.id)) throw Error('彩排编号无效。');
        const dir = directory(child(reports, input.id)),
          request = readJson(child(dir, 'request.json'));
        if (request.accountId !== accountId || request.uid !== config.uid) throw Error('彩排账号不符。');
        if (input.action === 'cancel') {
          running.get(input.id)?.abort();
          return { id: input.id };
        }
        if (fs.existsSync(child(dir, 'error.json')))
          return { state: 'failed', ...readJson(child(dir, 'error.json')) };
        if (!fs.existsSync(child(dir, 'result.json')))
          return { state: running.has(input.id) ? 'running' : 'interrupted' };
        const summary = readJson(child(dir, 'result.json')),
          page = input.page ?? 1;
        if (!Number.isSafeInteger(page) || page < 1 || page > Math.max(1, Math.ceil(summary.total / 50)))
          throw Error('报告页码无效。');
        return {
          state: 'done',
          summary,
          items: summary.total ? readJson(child(dir, 'page-' + page + '.json')) : [],
          page
        };
      }
      if (!['preview', 'import', 'verify', 'preserve', 'restore', 'handoff'].includes(input.action))
        throw Error('彩排操作无效。');
      if (running.size) throw Error('已有彩排正在执行，请先查看或取消。');
      const id = randomUUID(),
        dir = child(reports, id);
      fs.mkdirSync(dir, { mode: 0o700 });
      const created = fs.lstatSync(dir, { bigint: true }),
        reportIdentity = String(created.dev) + '/' + String(created.ino);
      finishReport(dir, 'request.json', {
        accountId,
        uid: config.uid,
        action: input.action,
        target: input.target ?? null,
        started: new Date().toISOString()
      });
      const flag = new SharedArrayBuffer(4),
        abort = () => Atomics.store(new Int32Array(flag), 0, 1);
      const worker = new Worker(fileURLToPath(import.meta.url), {
        workerData: { rehearsalWorker: true, root, liveRoot, input, config, flag, dir, reportIdentity }
      });
      const check = setInterval(() => {
        try {
          owner(config, session, accountId);
        } catch {
          abort();
        }
      }, 250);
      check.unref();
      running.set(id, { abort });
      session.signal.addEventListener('abort', abort, { once: true });
      worker.on('error', () => abort());
      worker.once('exit', () => {
        running.delete(id);
        clearInterval(check);
        session.signal.removeEventListener('abort', abort);
      });
      return { id, state: 'running' };
    },
    close() {
      for (const op of running.values()) op.abort();
    }
  };
}
