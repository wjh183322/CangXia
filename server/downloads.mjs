import { planDownloads } from '../electron/download-selection.mjs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { contentHash } from '../shared/backup-protocol.mjs';
import { isMediaURL } from '../electron/model.mjs';
import { imageDimensions } from '../electron/media-info.mjs';
import { transferAsset } from '../electron/resumable-transfer.mjs';
import { SourceError } from './source-error.mjs';
import { openDownloadStore, recordedWork } from './download-store.mjs';
import { audioInfo } from '../electron/audio-info.mjs';
import {
  assertFileStage,
  assertWorkFiles,
  cleanFileStages,
  ensureHome,
  fileReason,
  finalizeWorkFiles,
  openFileStage,
  openStagedPartial,
  recoverFileCommits,
  resolveResource,
  stageCheckpoints,
  trackStagedFile,
  verifyAndPlace,
  withWorkFiles
} from './files.mjs';

const redirectCodes = [301, 302, 303, 307, 308];
const protectedQuery = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'sessionid',
  'sessionidss',
  'uidtt',
  'uidttss',
  'sidguard',
  'sidtt',
  'mstoken',
  'password',
  'accesstoken',
  'refreshtoken',
  'passportcsrftoken',
  'passportcsrftokendefault'
]);
const mediaTypes = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif']
]);
const mimeByExtension = new Map(
  [...mediaTypes].map(([mime, ext]) => [ext, mime]).concat([['.mp4', 'video/mp4']])
);
const storage = new Set(['ENOSPC', 'EIO', 'EACCES', 'EPERM', 'EROFS', 'EMFILE', 'ENFILE', 'EDQUOT', 'EBUSY']);
const failure = (code, message) => new SourceError(code, message);
const formatError = () => failure('NAS_MEDIA_FORMAT', '文件格式或内容校验未通过。');

const needsReview = () => failure('NAS_MEDIA_SET_REVIEW', '作品资源身份或数量已改变，请重新核对。');
const notAvailable = () => failure('NAS_MEDIA_UNAVAILABLE', '此资源没有可用的来源地址。');
const retryableStatus = new Set([401, 403, 404, 410]);
const sourceRetry = (error) =>
  retryableStatus.has(error?.httpStatus) || error?.code === 'NAS_MEDIA_UNAVAILABLE';

function validMediaTarget(value, base) {
  try {
    const url = new URL(value, base);
    const credential = [...url.searchParams.keys()].some((key) =>
      protectedQuery.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
    );
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      !credential &&
      url.href.length <= 8192 &&
      isMediaURL(url.href)
    )
      return url.href;
  } catch {
    /* return a fixed error without the signed address */
  }
  throw failure('NAS_MEDIA_TARGET', 'The target is outside the secure source media allowlist.');
}

function candidateList(urls) {
  return [...new Set(urls ?? [])];
}

function candidateDigest(urls) {
  if (!urls.length) return null;
  const objects = urls.map((address) => {
    const url = new URL(validMediaTarget(address));
    for (const field of ['x-signature', 'x-expires']) url.searchParams.delete(field);
    url.searchParams.sort();
    return url.href;
  });
  return contentHash([...new Set(objects)].sort());
}

function coverObject(address) {
  const url = new URL(validMediaTarget(address));
  for (const field of ['x-signature', 'x-expires', 'l', 'from', 's', 'lk3s']) url.searchParams.delete(field);
  url.searchParams.sort();
  return contentHash(url.pathname + '?' + url.searchParams.toString());
}

function wantedResources(work, audioOnly) {
  if (audioOnly) {
    const source = work.audioSourceHints;
    if (work.type !== 'images' || !work.music?.id || (source?.music?.id && source.music.id !== work.music.id))
      throw needsReview();
    return [
      {
        key: 'audio',
        name: '配乐',
        kind: 'audio',
        sourceIdentity: 'music:' + work.music.id,
        candidates: candidateList(source?.sources?.filter((s) => s.kind === 'music').flatMap((s) => s.urls))
      }
    ];
  }
  const identities = work.mediaQuality?.identities ?? {};
  const entry = (key, name, kind, candidates, sourceIdentity) => ({
    key,
    name,
    kind,
    candidates: candidateList(candidates),
    sourceIdentity: sourceIdentity || null
  });
  if (work.type === 'images' || identities.imageCount) {
    const byIndex = new Map((work.images ?? []).map((image) => [image.index, image]));
    const count = identities.imageCount ?? byIndex.size;
    if (!Number.isInteger(count) || count < 1) throw needsReview();
    return Array.from({ length: count }, (_, index) =>
      entry(
        'image-' + index,
        '图片-' + String(index + 1).padStart(3, '0'),
        'image',
        byIndex.get(index)?.urls,
        identities.images?.[index]
      )
    );
  }
  // The normalized source keeps video quality and original-image candidates in priority order.
  const cover = [...(work.coverVariants ?? [])].sort(
    (a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height)
  );
  return [
    entry('video', '视频', 'video', work.videoUrls, identities.video),
    entry(
      'cover',
      '单图',
      'image',
      [...cover.flatMap((variant) => variant.urls), ...(work.coverUrls ?? [])],
      identities.cover
    )
  ];
}

function freeze(work, audioOnly) {
  const targets = wantedResources(work, audioOnly);
  const expected = targets.map(({ candidates, ...target }) => ({
    ...target,
    identity: contentHash({
      workId: work.id,
      key: target.key,
      kind: target.kind,
      sourceIdentity: target.sourceIdentity
    })
  }));
  const candidates = Object.fromEntries(targets.map((target) => [target.key, target.candidates]));
  return { expected, candidates };
}

function refreshCandidates(job, work) {
  const observed = wantedResources(work, job.audioOnly);
  if (observed.length !== job.expected.length) throw needsReview();
  for (const [index, expected] of job.expected.entries()) {
    const candidate = observed[index];
    if (candidate.key !== expected.key || candidate.kind !== expected.kind) throw needsReview();
    if (expected.sourceIdentity && candidate.sourceIdentity) {
      if (expected.sourceIdentity !== candidate.sourceIdentity) throw needsReview();
      continue;
    }
    const before = job.candidates[expected.key];
    if (!before.length && ['video', 'cover'].includes(expected.key)) continue;
    if (candidateDigest(before) !== candidateDigest(candidate.candidates)) throw needsReview();
  }
  return Object.fromEntries(observed.map((candidate) => [candidate.key, candidate.candidates]));
}

function extension(contentType, kind) {
  const mime = contentType?.split(';', 1)[0].trim().toLowerCase();
  if (
    kind === 'audio' &&
    [
      'audio/mpeg',
      'audio/mp3',
      'audio/mp4',
      'audio/x-m4a',
      'audio/aac',
      'audio/wav',
      'audio/x-wav',
      'application/octet-stream'
    ].includes(mime)
  )
    return '.bin';
  if (kind === 'video' && ['video/mp4', 'video/x-m4v', 'application/octet-stream'].includes(mime))
    return '.mp4';
  if (kind === 'image' && mediaTypes.has(mime)) return mediaTypes.get(mime);
  throw formatError();
}

async function headAt(file, size, position) {
  const bytes = Buffer.allocUnsafe(size);
  if ((await file.read(bytes, 0, size, position)).bytesRead !== size) throw formatError();
  return bytes;
}

async function isoBoxes(file, size, signal, start = 0) {
  const boxes = new Map();
  let at = start;
  let count = 0;
  while (at < size) {
    signal.throwIfAborted();
    if (++count > 4096 || size - at < 8) throw formatError();
    const header = await headAt(file, 8, at);
    const type = header.toString('ascii', 4, 8);
    let length = header.readUInt32BE(0);
    let headerBytes = 8;
    if (length === 0) length = size - at;
    if (length === 1) {
      if (size - at < 16) throw formatError();
      length = Number((await headAt(file, 8, at + 8)).readBigUInt64BE());
      headerBytes = 16;
    }
    if (length < headerBytes || length > size - at) throw formatError();
    if (!boxes.has(type)) boxes.set(type, { at: at + headerBytes, length: length - headerBytes });
    at += length;
  }
  return boxes;
}

async function verifyPng(file, size, signal) {
  let at = 8;
  let hasData = false;
  const block = Buffer.allocUnsafe(64 * 1024);
  for (let chunks = 0; chunks < 16384 && at + 12 <= size; chunks++) {
    signal.throwIfAborted();
    const header = await headAt(file, 8, at);
    const length = header.readUInt32BE();
    const type = header.toString('ascii', 4, 8);
    const tail = at + 8 + length;
    if (
      tail + 4 > size ||
      !/^[A-Za-z]{4}$/.test(type) ||
      (chunks === 0 ? type !== 'IHDR' || length !== 13 : type === 'IHDR')
    )
      throw formatError();
    let crc = crc32(header.subarray(4));
    for (let offset = at + 8; offset < tail; ) {
      signal.throwIfAborted();
      const count = Math.min(block.length, tail - offset);
      if ((await file.read(block, 0, count, offset)).bytesRead !== count) throw formatError();
      crc = crc32(block.subarray(0, count), crc);
      offset += count;
    }
    if (crc !== (await headAt(file, 4, tail)).readUInt32BE()) throw formatError();
    if (type === 'IDAT' && length > 0) hasData = true;
    at = tail + 4;
    if (type === 'IEND' && length === 0 && hasData && at === size) return;
    if (type === 'IEND') break;
  }
  throw formatError();
}

async function verifyFormat(asset, mime, signal) {
  signal.throwIfAborted();
  const { file, size } = asset;
  if (size < 16) throw formatError();
  const handle = await open(file, 'r');
  try {
    const bytes = await headAt(handle, Math.min(size, 64 * 1024), 0);
    if (mime === 'video/mp4' || mime === 'image/avif') {
      const boxes = await isoBoxes(handle, size, signal);
      const brand = boxes.get('ftyp');
      if (!brand || brand.length < 8 || brand.length > 512) throw formatError();
      const flags = await headAt(handle, brand.length, brand.at);
      const brands = [flags.toString('ascii', 0, 4)];
      for (let index = 8; index + 4 <= flags.length; index += 4)
        brands.push(flags.toString('ascii', index, index + 4));
      const movie = boxes.get('moov');
      if (
        mime === 'video/mp4' &&
        movie?.length &&
        boxes.get('mdat')?.length > 0 &&
        brands.some((value) => /^(?:iso[m2-9]|mp4[12]|avc1|M4V |dash)$/.test(value)) &&
        (await isoBoxes(handle, movie.at + movie.length, signal, movie.at)).get('trak')?.length > 0
      )
        return {};
      if (
        mime === 'image/avif' &&
        brands.some((value) => /^avi[fs]$/.test(value)) &&
        boxes.get('meta')?.length > 0 &&
        (boxes.get('mdat')?.length > 0 || boxes.get('moov')?.length > 0)
      )
        return {};
      throw formatError();
    }

    const { width, height } = imageDimensions(bytes);
    if (!width || !height) throw formatError();
    if (mime === 'image/png') {
      if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        await verifyPng(handle, size, signal);
        return { width, height };
      }
    }
    if (mime === 'image/jpeg') {
      const end = await headAt(handle, 2, size - 2);
      if (bytes.subarray(0, 2).toString('hex') === 'ffd8' && end.toString('hex') === 'ffd9')
        return { width, height };
    }
    if (
      mime === 'image/webp' &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP' &&
      bytes.readUInt32LE(4) === size - 8
    )
      return { width, height };
    throw formatError();
  } finally {
    await handle.close();
  }
}

const invalid = () => failure('INVALID_DOWNLOAD', '下载选择或队列操作无效。');
const authRequired = () => failure('LOGIN_REQUIRED', '请在 Windows 核验原账号并手动继续下载。');
const authErrors = new Set([
  'LOGIN_REQUIRED',
  'SOURCE_SESSION_LOST',
  'ACCOUNT_MISMATCH',
  'SOURCE_AUTH',
  'SOURCE_VERIFICATION'
]);
const retryStates = new Set(['failed', 'waiting-auth', 'waiting-rate', 'finalization-pending', 'review']);
const stopping = new Set(['pausing', 'cancelling']);
function binding(db) {
  const value = db
    .prepare(
      'SELECT uid,profile_id,session_key,auth_epoch FROM source_account,download_auth,download_options'
    )
    .get();
  if (!value?.profile_id) throw authRequired();
  return { uid: value.uid, sessionKey: value.session_key, authEpoch: value.auth_epoch };
}
function getJob(db, id) {
  const row = db.prepare('SELECT body FROM download_manifests WHERE id=?').get(id);
  return row ? JSON.parse(row.body) : null;
}
function put(db, job) {
  db.prepare(
    'INSERT INTO download_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state WHERE state<>excluded.state'
  ).run(job.id, job.workId, job.state);
  db.prepare(
    'INSERT INTO download_manifests(id,work_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,hidden=0'
  ).run(job.id, job.workId, JSON.stringify(job));
  db.exec('UPDATE download_options SET revision=revision+1');
}
function publicJob(job) {
  const state = ['queued', 'paused', 'pausing'].includes(job.state)
    ? 'waiting'
    : retryStates.has(job.state) || job.cleanupPending
      ? 'failed'
      : job.state;
  const n = job.completedKeys.length,
    total = job.expected.length;
  const partial =
    job.phase === 'transferring' && job.byteTotal ? Math.min(1, (job.bytes || 0) / job.byteTotal) : 0;
  const detail =
    job.phase === 'transferring' && job.bytes
      ? ' · 当前资源已传 ' + (job.bytes / 1048576).toFixed(1) + ' MiB'
      : '';
  return {
    id: job.id,
    workId: job.workId,
    title: job.title,
    state,
    downloadState: job.state,
    phase: job.phase,
    message:
      job.reason?.message || (job.state === 'paused' ? '已暂停' : n + '/' + total + ' 项已校验' + detail),
    reason: job.reason,
    progress: job.state === 'complete' ? 100 : Math.min(99, Math.floor((100 * (n + partial)) / total)),
    bytes: job.bytes || 0,
    cleanupPending: job.cleanupPending,
    filesComplete: job.filesComplete,
    finalizationPending: job.finalizationPending
  };
}
const tabs = {
  active: ['queued', 'running', 'paused', 'pausing', 'cancelling'],
  failed: [...retryStates],
  complete: ['complete'],
  unavailable: ['unavailable']
};
function filterSql(tab) {
  if (tab === 'all') return '1';
  if (!Object.hasOwn(tabs, tab)) throw invalid();
  const match = 'j.state IN (' + tabs[tab].map((s) => "'" + s + "'").join(',') + ')';
  return tab === 'failed'
    ? '(' + match + " OR (j.state='cancelled' AND json_extract(m.body,'$.cleanupPending')=1))"
    : match;
}
const join = ' FROM download_manifests m JOIN download_jobs j ON m.id=j.id WHERE m.hidden=0 AND ';
function downloadPage(db, { tab = 'active', page = 1 } = {}) {
  if (!Number.isSafeInteger(page) || page < 1) throw invalid();
  const query = join + filterSql(tab);
  const total = db.prepare('SELECT COUNT(*) AS n' + query).get().n,
    pages = Math.max(1, Math.ceil(total / 50));
  page = Math.min(page, pages);
  return {
    total,
    page,
    pages,
    jobs: db
      .prepare('SELECT m.body' + query + ' ORDER BY m.rowid DESC LIMIT 50 OFFSET ?')
      .all((page - 1) * 50)
      .map((r) => publicJob(JSON.parse(r.body)))
  };
}
function queueState(db) {
  const opts = db.prepare('SELECT * FROM download_options').get();
  const rows = db
    .prepare(
      'SELECT j.state,count(*) n' +
        join +
        "(j.state<>'cancelled' OR json_extract(m.body,'$.cleanupPending')=1) GROUP BY j.state"
    )
    .all();
  const counts = { waiting: 0, running: 0, complete: 0, failed: 0, unavailable: 0 };
  for (const r of rows) {
    const key = tabs.active.includes(r.state)
      ? r.state === 'running'
        ? 'running'
        : 'waiting'
      : r.state === 'cancelled' || retryStates.has(r.state)
        ? 'failed'
        : r.state;
    counts[key] = (counts[key] || 0) + r.n;
  }
  return {
    summary: true,
    paused: !!opts.paused,
    revision: opts.revision,
    concurrency: opts.concurrency,
    counts,
    running: counts.running > 0,
    jobs: db
      .prepare('SELECT m.body' + join + "j.state='running' LIMIT 6")
      .all()
      .map((r) => publicJob(JSON.parse(r.body)))
  };
}
function preview(db, ids) {
  const groups = { unsaved: [], partial: [], complete: [], unavailable: [], checking: [] };
  const selected = [...new Set(ids)],
    bases = new Map(),
    locals = new Map(),
    fileStates = new Map(),
    jobs = [];
  const files = db.prepare(
    "SELECT 1 FROM media_files WHERE work_id=? AND lower(relative_path) NOT LIKE '%.json' LIMIT 1"
  );
  const completed = db.prepare(
    "SELECT 1 FROM download_jobs WHERE work_id=? AND state='complete' AND id NOT LIKE 'audio:%' LIMIT 1"
  );
  for (const id of selected) {
    if (typeof id !== 'string' || !/^\d{1,40}$/.test(id)) throw invalid();
    const work = recordedWork(db, id);
    if (!work) throw invalid();
    const group =
      work.remoteState === 'unavailable'
        ? 'unavailable'
        : !files.get(id)
          ? 'unsaved'
          : ['checking', 'unknown'].includes(work.localStatus)
            ? 'checking'
            : completed.get(id)
              ? 'complete'
              : 'partial';
    groups[group].push(id);
    bases.set(id, work);
    if (!['unsaved', 'unavailable'].includes(group)) {
      locals.set(id, { hasMedia: true });
      fileStates.set(id, { root: 'NAS', status: group });
    }
    const job = getJob(db, id);
    if (job && job.state !== 'cancelled') jobs.push(publicJob(job));
  }
  const context = { root: 'NAS', fileStates, lightViews: { ready: true, bases, locals } };
  return { groups, report: planDownloads(context, { jobs }, selected).report };
}

export function createDownloads({
  library,
  root,
  source,
  fetchAsset = globalThis.fetch,
  fileHook,
  checkpointBytes
}) {
  const store = openDownloadStore({ library, root, fileHook }),
    { db, layout } = store;
  const active = new Map();
  let task,
    rerun = false,
    closing = false;
  const change = (id, fn) =>
    store.withWrite((conn) => {
      const job = getJob(conn, id);
      fn(job);
      put(conn, job);
      return job;
    });
  function enqueue(conn, ids, scope = 'unsaved') {
    if (!Array.isArray(ids) || !ids.length || !['unsaved', 'missing', 'repair', 'audio'].includes(scope))
      throw invalid();
    const auth = binding(conn);
    if (source?.account()?.uid !== auth.uid) throw authRequired();
    const { groups, report } = preview(conn, ids);
    const eligible =
      scope === 'unsaved'
        ? groups.unsaved
        : scope === 'missing'
          ? [...groups.unsaved, ...groups.partial]
          : scope === 'repair'
            ? [...groups.partial, ...groups.complete, ...groups.unsaved]
            : ids.filter(
                (id) => recordedWork(conn, id).type === 'images' && !groups.unavailable.includes(id)
              );
    let existing = 0,
      queued = 0,
      first,
      removed = 0;
    for (const workId of eligible) {
      const jobId = scope === 'audio' ? 'audio:' + workId : workId;
      const old = getJob(conn, jobId);
      first ??= jobId;
      if (!old && conn.prepare('SELECT 1 FROM download_jobs WHERE id=?').get(jobId)) throw needsReview();
      if (
        conn
          .prepare(
            'SELECT 1 FROM media_files m LEFT JOIN archive_assets a ON m.id=a.id WHERE m.work_id=? AND a.id IS NULL LIMIT 1'
          )
          .get(workId)
      )
        throw needsReview();
      if (old && (tabs.active.includes(old.state) || old.cleanupPending)) {
        existing++;
        continue;
      }
      if (old?.state === 'waiting-auth' && old.auth.uid !== auth.uid) throw authRequired();
      const work = recordedWork(conn, workId);
      const frozen = freeze(work, scope === 'audio');
      for (const candidates of Object.values(frozen.candidates))
        for (const url of candidates) validMediaTarget(url);
      put(conn, {
        id: jobId,
        workId,
        title: work.name,
        ...frozen,
        auth,
        audioOnly: scope === 'audio',
        state: 'queued',
        completedKeys: [],
        filesComplete: false,
        cleanupPending: false,
        finalizationPending: false,
        reason: null
      });
      queued++;
    }
    if (scope === 'unsaved') {
      for (const id of [...groups.partial, ...groups.complete, ...groups.checking, ...groups.unavailable]) {
        const job = getJob(conn, id);
        if (job && job.state !== 'complete' && job.state !== 'cancelled') {
          job.state = 'cancelling';
          put(conn, job);
          removed++;
        }
      }
    }
    return { jobId: first, queued, existing, removed, unavailable: report.unavailable };
  }
  function control(conn, { action, jobId, ids, value, state }) {
    if (action === 'concurrency') {
      if (!Number.isInteger(value) || value < 1 || value > 6) throw invalid();
      conn.prepare('UPDATE download_options SET concurrency=?,revision=revision+1').run(value);
      return { concurrency: value };
    }
    if (!['pause', 'resume', 'retry', 'cancel', 'clear'].includes(action)) throw invalid();
    const all = ids === null && !jobId;
    if (!all && !jobId && !Array.isArray(ids)) throw invalid();
    if (all && ['pause', 'resume'].includes(action))
      conn
        .prepare('UPDATE download_options SET paused=?,revision=revision+1')
        .run(Number(action === 'pause'));
    const keys = all
      ? conn
          .prepare('SELECT id FROM download_manifests WHERE hidden=0')
          .all()
          .map((r) => r.id)
      : jobId
        ? [jobId]
        : [...new Set(ids)];
    let changed = 0;
    for (const id of keys) {
      const job = getJob(conn, id);
      if (!job) {
        if (jobId) throw invalid();
        continue;
      }
      if (state && publicJob(job).state !== state) continue;
      if (action === 'clear' && job.state === 'complete') {
        conn.prepare('UPDATE download_manifests SET hidden=1 WHERE id=?').run(id);
        conn.exec('UPDATE download_options SET revision=revision+1');
        changed++;
        continue;
      }
      if (action === 'pause' && ['running', 'queued'].includes(job.state))
        job.state = job.state === 'running' ? 'pausing' : 'paused';
      else if (
        (action === 'resume' && job.state === 'paused') ||
        (['resume', 'retry'].includes(action) && retryStates.has(job.state) && (!all || action === 'retry'))
      ) {
        const auth = binding(conn);
        if (auth.uid !== job.auth.uid || source?.account()?.uid !== auth.uid) throw authRequired();
        job.auth = auth;
        job.state = 'queued';
        job.reason = null;
      } else if (
        action === 'cancel' &&
        ((job.state !== 'complete' && job.state !== 'cancelled') || job.cleanupPending)
      )
        job.state = 'cancelling';
      else continue;
      put(conn, job);
      changed++;
    }
    return { queued: changed, cancelled: changed, changed };
  }
  function requireWriter(job, signal) {
    signal.throwIfAborted();
    if (closing || db.prepare('SELECT state FROM download_jobs WHERE id=?').get(job.id)?.state !== 'running')
      throw failure('NAS_DOWNLOAD_STOP', '下载任务已停止。');
    const auth = binding(db);
    if (
      auth.uid !== job.auth.uid ||
      auth.sessionKey !== job.auth.sessionKey ||
      auth.authEpoch !== job.auth.authEpoch
    )
      throw authRequired();
  }
  async function fetchMedia(url, options, job) {
    let target = validMediaTarget(url);
    const headers = new Headers(options.headers);
    headers.set('Referer', 'https://www.douyin.com/');
    for (let hops = 0; hops < 6; hops++) {
      requireWriter(job, options.signal);
      const response = await fetchAsset(target, {
        method: 'GET',
        headers,
        redirect: 'manual',
        credentials: 'omit',
        signal: options.signal
      });
      try {
        requireWriter(job, options.signal);
        if (response.url && validMediaTarget(response.url) !== target)
          throw failure('NAS_MEDIA_TARGET', '来源返回了未核对的资源地址。');
        if (redirectCodes.includes(response.status)) {
          target = validMediaTarget(response.headers.get('location'), target);
          await response.body?.cancel();
          continue;
        }
        if (response.status === 429) throw failure('SOURCE_RATE_LIMITED', '来源要求稍后重试。');
        return {
          url: target,
          status: response.status,
          headers: response.headers,
          ok: response.ok,
          body: response.body
        };
      } catch (e) {
        await response.body?.cancel().catch(() => {});
        throw e;
      }
    }
    throw failure('NAS_MEDIA_REDIRECTS', '资源重定向次数过多。');
  }
  async function refresh(job, signal) {
    requireWriter(job, signal);
    const observed = await source.readDownloadDetail({ workId: job.workId, ...job.auth, signal });
    requireWriter(job, signal);
    if (observed?.id !== job.workId) throw needsReview();
    if (observed.remoteState === 'unavailable') throw failure('NAS_SOURCE_UNAVAILABLE', '原作品已失效。');
    if (observed.statusOnly) throw notAvailable();
    const candidates = refreshCandidates(job, observed);
    return change(job.id, (current) => {
      current.candidates = candidates;
    });
  }

  async function downloadOne(job, target, home, signal) {
    const existing = await resolveResource({
      store,
      layout,
      workId: job.workId,
      key: target.key,
      verify: true,
      allowMissing: true,
      signal
    });
    const observationIdentity = target.sourceIdentity ? null : candidateDigest(job.candidates[target.key]);
    const changed =
      !!existing &&
      (existing.resourceIdentity !== target.identity ||
        (!target.sourceIdentity && existing.observationIdentity !== observationIdentity));
    if (existing) {
      if (!existing.missing && !changed) return;
      change(job.id, (current) => {
        current.completedKeys = current.completedKeys.filter((key) => key !== target.key);
        current.filesComplete = false;
      });
    }
    if (!job.candidates[target.key].length) throw notAvailable();
    requireWriter(job, signal);
    const cover = target.key === 'cover';
    const handled = new Set();
    const comparisons = [];
    let lastError = notAvailable();
    for (const url of job.candidates[target.key]) {
      requireWriter(job, signal);
      const group = cover ? coverObject(url) : null;
      if (handled.has(group)) continue;
      const stage = await openFileStage({
        store,
        layout,
        jobId: job.id,
        workId: job.workId,
        key: target.key,
        kind: target.kind,
        resourceIdentity: target.identity,
        observationIdentity,
        group
      });
      try {
        store.fileHook('beforeFileWrite', { workId: job.workId, kind: target.kind, file: stage.dir });
        let lastProgress = 0,
          expectedHash;
        const result = await transferAsset({
          dir: stage.dir,
          target: { name: 'payload', kind: target.kind },
          url,
          signal,
          extension,
          checkpointBytes,
          fetchMedia: async (address, options) => {
            const response = await fetchMedia(address, options, job);
            try {
              if (response.status === 200) {
                const digest = response.headers
                  .get('content-digest')
                  ?.match(/(?:^|,\s*)sha-256=:([A-Za-z0-9+/]{43}=):(?:$|,)/i);
                expectedHash = digest ? Buffer.from(digest[1], 'base64').toString('hex') : null;
              }
              await assertFileStage(stage, layout);
            } catch (error) {
              await response.body?.cancel().catch(() => {});
              throw error;
            }
            return response;
          },
          preserveExisting: true,
          openPartial: (file) => openStagedPartial(stage, file, layout),
          checkpoints: stageCheckpoints(store, stage),
          maxBytes: target.kind === 'audio' ? 256 * 1024 * 1024 : Infinity,
          progress(bytes, totalBytes) {
            requireWriter(job, signal);
            if (bytes === 0 || Date.now() - lastProgress >= 750) {
              lastProgress = Date.now();
              change(job.id, (current) => {
                current.bytes = bytes;
                current.byteTotal = totalBytes;
                current.phase = 'transferring';
              });
            }
          },
          onFileWrite(file, opened) {
            trackStagedFile(store, stage, file, opened);
          }
        });
        if (
          (expectedHash && expectedHash !== result.sha256) ||
          (existing?.missing && !changed && existing.sha256 !== result.sha256)
        )
          throw failure('NAS_HASH_MISMATCH', '下载内容与已知 SHA-256 摘要不同。');
        const audio = target.kind === 'audio' ? await audioInfo(result.file, signal) : null;
        const ext = audio ? '.' + audio.format : path.extname(result.file);
        const mime = audio
          ? { wav: 'audio/wav', mp3: 'audio/mpeg', aac: 'audio/aac', m4a: 'audio/mp4' }[audio.format]
          : mimeByExtension.get(ext);
        const dimensions = audio ? { duration: audio.duration } : await verifyFormat(result, mime, signal);
        comparisons.push({ stage, result, mime, ext, dimensions });
        handled.add(group);
        if (!cover) break;
      } catch (error) {
        if (
          signal.aborted ||
          storage.has(error?.code) ||
          authErrors.has(error?.code) ||
          ['NAS_MEDIA_TARGET', 'NAS_MEDIA_REDIRECTS', 'SOURCE_RATE_LIMITED', 'NAS_FILE_REVIEW'].includes(
            error?.code
          )
        )
          throw error;
        lastError = error;
      }
    }
    if (!comparisons.length) throw lastError;
    requireWriter(job, signal);
    const area = ({ dimensions }) => (dimensions.width ?? 0) * (dimensions.height ?? 0);
    const best = comparisons.toSorted((a, b) => area(b) - area(a))[0];
    const previous = existing
      ? {
          missing: !!existing.missing,
          superseded: changed && !existing.missing,
          size: existing.size,
          identity: existing.identity,
          mtimeNs: existing.mtimeNs,
          relative: existing.relative_path,
          revision: existing.revision,
          sha256: existing.sha256
        }
      : null;
    await verifyAndPlace({
      store,
      layout,
      stage: best.stage,
      transferred: best.result,
      mime: best.mime,
      filename: target.name + best.ext,
      home,
      previous,
      signal,
      dimensions: best.dimensions,
      guard: () => requireWriter(job, signal)
    });
    {
      const pending = await cleanFileStages({
        store,
        layout,
        workId: job.workId,
        jobId: job.id,
        key: target.key
      });
      if (pending)
        change(job.id, (current) => {
          current.cleanupPending = true;
        });
    }
  }

  function saveProgress(id, target) {
    return change(id, (job) => {
      job.phase = 'preparing';
      job.bytes = 0;
      job.byteTotal = null;
      if (!job.completedKeys.includes(target.key)) job.completedKeys.push(target.key);
      job.filesComplete = job.completedKeys.length === job.expected.length;
    });
  }

  async function saveJob(job, signal) {
    const { workId } = job;
    assertWorkFiles(store, workId);
    if (store.fileCommits(workId).some((commit) => commit.stage === 'review')) {
      throw failure('NAS_FILE_REVIEW', 'A file commit for this work needs review.');
    }
    const home = await ensureHome({ store, layout, workId });

    let refreshed = false;
    for (const target of job.expected) {
      requireWriter(job, signal);
      try {
        await downloadOne(job, target, home, signal);
      } catch (error) {
        if (!sourceRetry(error) || refreshed || signal.aborted) throw error;
        refreshed = true;
        job = await refresh(job, signal);
        await downloadOne(job, target, home, signal);
      }
      requireWriter(job, signal);
      saveProgress(job.id, target);
    }
    requireWriter(job, signal);
    const result = await finalizeWorkFiles({
      store,
      layout,
      workId,
      jobId: job.id,
      signal,
      guard: () => requireWriter(job, signal)
    });
    const cleanupPending = await cleanFileStages({ store, layout, workId, jobId: job.id });
    change(job.id, (current) => {
      if (current.state !== 'running' || closing) return;
      current.cleanupPending = cleanupPending;
      current.state = result.ok && !current.cleanupPending ? 'complete' : 'finalization-pending';
      current.finalizationPending = current.state !== 'complete';
      current.reason = !result.ok
        ? result.errors[0]
        : current.cleanupPending
          ? { code: 'CLEANUP_PENDING', message: '下载已登记，临时文件仍待清理。' }
          : null;
    });
  }

  async function execute(id, controller) {
    const { workId } = getJob(db, id);
    try {
      const recovered = await recoverFileCommits({ store, layout, workId });
      await withWorkFiles(layout, workId, async () => {
        const current = getJob(db, id);
        if (!['queued', 'running'].includes(current.state) || closing) return;
        const error = recovered.find((r) => r.error)?.error;
        if (error) throw failure(error.code, error.message);
        const job = change(id, (j) => {
          j.state = 'running';
          j.reason = null;
          j.phase = 'preparing';
        });
        requireWriter(job, controller.signal);
        await saveJob(job, controller.signal);
      });
    } catch (e) {
      if (!closing)
        change(id, (job) => {
          if (stopping.has(job.state)) return;
          job.reason =
            e.code === 'ENOSPC'
              ? { code: e.code, message: 'NAS 空间不足，腾出空间后可重试。' }
              : fileReason(e);
          job.state =
            e.code === 'NAS_SOURCE_UNAVAILABLE'
              ? 'unavailable'
              : authErrors.has(e.code)
                ? 'waiting-auth'
                : e.code === 'SOURCE_RATE_LIMITED'
                  ? 'waiting-rate'
                  : e.code === 'NAS_FILE_REVIEW' || e.code === 'NAS_MEDIA_SET_REVIEW'
                    ? 'review'
                    : 'failed';
        });
    } finally {
      const job = getJob(db, id);
      if (job.state === 'pausing')
        change(id, (j) => {
          j.state = 'paused';
        });
      if (job.state === 'cancelling') {
        const pending = await withWorkFiles(layout, workId, () =>
          cleanFileStages({ store, layout, workId, jobId: id })
        );
        change(id, (j) => {
          j.state = 'cancelled';
          j.cleanupPending = pending;
          j.reason = pending
            ? { code: 'CLEANUP_PENDING', message: '临时文件清理未完成，可再次取消重试。' }
            : null;
        });
      }
    }
  }
  let wake;
  function run() {
    if (closing) return task || Promise.resolve();
    for (const [id, slot] of active) if (stopping.has(getJob(db, id)?.state)) slot.controller.abort();
    if (task) {
      rerun = true;
      wake?.();
      return task;
    }
    rerun = false;
    task = (async () => {
      while (!closing) {
        const opts = db.prepare('SELECT concurrency,paused FROM download_options').get();
        const candidates = db
          .prepare(
            `SELECT j.id,j.work_id FROM download_jobs j JOIN download_manifests m ON j.id=m.id
      WHERE j.state IN ('pausing','cancelling') OR (?=0 AND j.state IN ('queued','running')) ORDER BY m.rowid`
          )
          .all(opts.paused);
        for (const row of candidates) {
          if (active.size >= opts.concurrency) break;
          if (active.has(row.id) || [...active.values()].some((a) => a.workId === row.work_id)) continue;
          const controller = new AbortController(),
            slot = { workId: row.work_id, controller };
          active.set(row.id, slot);
          slot.task = execute(row.id, controller).finally(() => active.delete(row.id));
        }
        if (!active.size) break;
        await Promise.race(
          [...active.values()]
            .map((s) => s.task)
            .concat(
              new Promise((resolve) => {
                wake = resolve;
              })
            )
        );
        wake = null;
      }
      await Promise.all([...active.values()].map((s) => s.task));
    })().finally(() => {
      task = null;
      if (rerun && !closing) return run();
    });
    return task;
  }
  return {
    enqueue,
    control,
    preview: (conn, ids) => preview(conn, ids).report,
    page: downloadPage,
    state: queueState,
    store,
    layout,
    run,
    async close() {
      if (closing) return;
      closing = true;
      wake?.();
      for (const slot of active.values()) slot.controller.abort();
      try {
        await task;
      } finally {
        store.close();
      }
    }
  };
}
