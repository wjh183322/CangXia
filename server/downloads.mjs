import {getJob,putJob as put,fenceUnavailable} from './download-records.mjs';
import {inspectInventory} from './maintenance-inventory.mjs';
import {sharedRepairPeers,needsResourceWork} from './maintenance-queue.mjs';
import {removalOwnsFiles} from './removal.mjs';
import { planDownloads } from '../electron/download-selection.mjs';
import { createArchive } from './archive.mjs';
import { assessCover } from './covers.mjs';
import { comparableResolution } from '../electron/hd-cover.mjs';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { contentHash } from '../shared/backup-protocol.mjs';
import { isMediaURL } from '../electron/model.mjs';
import { imageDimensions } from '../electron/media-info.mjs';
import { transferAsset } from '../electron/resumable-transfer.mjs';
import { SourceError } from './source-error.mjs';
import { openDownloadStore, recordedWork } from './download-store.mjs';
import { avifDimensions } from './avif-dimensions.mjs';
import { audioInfo } from '../electron/audio-info.mjs';
import {
  assertFileStage,
  assertResourceCurrent,
  currentHDCover,
  assertWorkFiles,
  cleanFileStages,
  ensureHome,
  fileReason,
  finalizeWorkFiles,
  openFileStage,
  openStagedPartial,
  recoverFileCommits,
  registeredAssetProof,
  resolveResource,
  stageCheckpoints,
  sealTransfer,
  stagedTransfer,
  discardInvalidTransfer,
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

export function candidateDigest(urls) {
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

export function wantedResources(work, audioOnly) {
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
        candidates: candidateList(source?.sources?.filter((s) => ['music','work'].includes(s.kind)).sort((a,b)=>Number(b.kind==='music')-Number(a.kind==='music')).flatMap((s) => s.urls))
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

function hdSourceProof(db, workId) {
  const hdInputs = {},
    hdSources = {};
  for (const asset of db
    .prepare("SELECT * FROM archive_resources WHERE work_id=? AND key IN ('video','cover')")
    .all(workId)) {
    const proof = registeredAssetProof(db, workId, asset);
    if (!proof?.identity || !proof.mtimeNs) throw needsReview();
    hdInputs[asset.key] = asset.sha256;
    hdSources[asset.key] = {
      identity: proof.resourceIdentity ?? null,
      observation: proof.observationIdentity ?? null,
      group: proof.group ?? null,
      selectedIdentity: proof.selectedCoverIdentity ?? null,
      fileIdentity: proof.identity,
      mtimeNs: proof.mtimeNs
    };
  }
  if (!hdSources.video) throw needsReview();
  return { hdInputs, hdSources };
}

function assertHDSources(frozen, sources) {
  for (const [key, proof] of Object.entries(sources)) {
    const target = frozen.expected.find((item) => item.key === key);
    if (!target) throw needsReview();
    const urls = frozen.candidates[key];
    if (key === 'cover') {
      // A manifest's preferred URI can belong to a different variant than the pixel winner.
      if (proof.group && urls.some((url) => coverObject(url) === proof.group)) continue;
      if (target.sourceIdentity && target.identity === proof.selectedIdentity) continue;
      if (!proof.group && proof.observation && proof.observation === candidateDigest(urls)) continue;
    } else if (
      target.identity === proof.identity &&
      (target.sourceIdentity || (proof.observation && proof.observation === candidateDigest(urls)))
    )
      continue;
    throw needsReview();
  }
}

function refreshCandidates(job, work) {
  const observed = wantedResources(work, job.audioOnly);
  if (observed.length !== job.expected.length) throw needsReview();
  for (const [index, expected] of job.expected.entries()) {
    const candidate = observed[index];
    if (candidate.key !== expected.key || candidate.kind !== expected.kind) throw needsReview();
    // The verified detail may add an original-cover URI ahead of its old page-cover URI.
    // This exception only reads candidates for HD repair. The video still has to match its frozen identity.
    if (job.hdInputs && expected.key === 'cover') continue;
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
  const boxes = new Map(),
    mediaData = [];
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
    const extent = { at: at + headerBytes, length: length - headerBytes };
    if (!boxes.has(type)) boxes.set(type, extent);
    if (type === 'mdat') mediaData.push(extent);
    at += length;
  }
  return { boxes, mediaData };
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

export async function verifyFormat(asset, mime, signal) {
  signal.throwIfAborted();
  const { file, size } = asset;
  if (size < 16) throw formatError();
  const handle = await open(file, 'r');
  try {
    const bytes = await headAt(handle, Math.min(size, 64 * 1024), 0);
    if (mime === 'video/mp4' || mime === 'image/avif') {
      const { boxes, mediaData } = await isoBoxes(handle, size, signal);
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
        (await isoBoxes(handle, movie.at + movie.length, signal, movie.at)).boxes.get('trak')?.length > 0
      )
        return {};
      if (
        mime === 'image/avif' &&
        brands.some((value) => /^avi[fs]$/.test(value)) &&
        boxes.get('meta')?.length > 0
      ) {
        const meta = boxes.get('meta');
        if (meta.length > 2 * 1024 * 1024) throw formatError();
        try {
          return avifDimensions(await headAt(handle, meta.length, meta.at), mediaData);
        } catch {
          throw formatError();
        }
      }
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
function publicJob(job) {
  const state = ['queued', 'paused', 'pausing','awaiting-registration'].includes(job.state)
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
    progress: job.state === 'complete' ? 100 : total ? Math.min(99, Math.floor((100 * (n + partial)) / total)) : 0,
    bytes: job.bytes || 0,
    cleanupPending: job.cleanupPending,
    filesComplete: job.filesComplete,
    finalizationPending: job.finalizationPending
  };
}
const tabs = {
  active: ['queued', 'running', 'paused', 'pausing', 'cancelling','awaiting-registration'],
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
function downloadPage(db, { tab = 'active', page = 1 } = {}, audioOnly=false) {
  if (!Number.isSafeInteger(page) || page < 1) throw invalid();
  const audioFilter=audioOnly && ['waiting','running'].includes(tab);
  const condition=audioFilter ? (tab==='running'?"j.state='running'":"j.state IN ('queued','paused','pausing','awaiting-registration')") : filterSql(tab);
  const query = join + (audioOnly?"j.id LIKE 'audio:%' AND ":"") + condition;
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
function queueState(db,audioOnly=false) {
  const opts = db.prepare('SELECT * FROM download_options').get();
  const family = audioOnly?"j.id LIKE 'audio:%' AND ":"";
  const rows = db
    .prepare(
      'SELECT j.state,count(*) n' +
        join + family +
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
    paused: audioOnly?rows.some(r=>['paused','pausing'].includes(r.state)):!!opts.paused,
    revision: opts.revision,
    concurrency: opts.concurrency,
    counts,
    running: counts.running > 0,
    jobs: db
      .prepare('SELECT m.body' + join + family + "j.state='running' LIMIT 6")
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
    "SELECT 1 FROM download_jobs WHERE work_id=? AND state='complete' AND id NOT LIKE 'audio:%' AND id NOT LIKE 'hd:%' LIMIT 1"
  );
  for (const id of selected) {
    if (typeof id !== 'string' || !/^\d{1,40}$/.test(id)) throw invalid();
    const work = recordedWork(db, id);
    if (!work) throw invalid();
    const saved=db.prepare('SELECT status FROM maintenance_file_state WHERE work_id=?').get(id)?.status??work.localStatus;
    const group =
      work.remoteState === 'unavailable'
        ? 'unavailable'
        : !files.get(id)
          ? 'unsaved'
          : ['checking', 'unknown'].includes(saved)
            ? 'checking'
            : saved!=='partial' && completed.get(id)
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
  checkpointBytes,
  coverPython
}) {
  const store = openDownloadStore({ library, root, fileHook }),
    { db, layout } = store;
  const archive = createArchive(store);
  const unavailable = () =>
    failure('NAS_SOURCE_UNAVAILABLE', '原作品已失效，已保留现有文件。核验来源可访问后可手动重试。');
  const sourceState = (conn, id) =>
    conn.prepare("SELECT json_extract(body,'$.remoteState') AS state FROM works WHERE id=?").get(id)?.state;
  function assertSource(conn, id) {
    if (sourceState(conn, id) === 'unavailable') throw unavailable();
  }
  store.assertDownloadSource = (conn, workId, jobId) => {
    if (!jobId) return;
    const row = conn
      .prepare(
        "SELECT coalesce(json_extract(body,'$.sourceFence'),0) fence FROM download_manifests WHERE id=? AND work_id=?"
      )
      .get(jobId, workId);
    if (!row) return;
    assertSource(conn, workId);
    const slot = active.get(jobId);
    if (slot && slot.fence !== row.fence) throw unavailable();
  };
  function stopUnavailable(workId) {
    for (const slot of active.values())
      if (slot.workId === workId && sourceState(db, workId) === 'unavailable')
        slot.controller.abort(unavailable());
  }
  function validateHDSource(workId, expected) {
    const current = hdSourceProof(db, workId);
    if (
      contentHash(current.hdInputs) !== contentHash(expected.hdInputs) ||
      (expected.hdSources && contentHash(current.hdSources) !== contentHash(expected.hdSources))
    )
      throw needsReview();
    assertHDSources(freeze(store.work(workId), false), current.hdSources);
    return current.hdSources;
  }
  store.hdCommitCurrent = (commit) => {
    try {
      validateHDSource(commit.workId, commit.body);
      return true;
    } catch (error) {
      if (['NAS_MEDIA_SET_REVIEW', 'NAS_MEDIA_TARGET'].includes(error.code)) return false;
      throw error;
    }
  };
  store.canPublishDownload = (id) => {
    const job = getJob(db, id);
    if (!job) return false;
    let current;
    try {
      current = binding(db);
      store.assertDownloadSource(db,job.workId,id);
    } catch {
      return false;
    }
    return (
      current.uid === job.auth.uid &&
      current.sessionKey === job.auth.sessionKey &&
      current.authEpoch === job.auth.authEpoch
    );
  };
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
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      !['unsaved', 'missing', 'repair', 'audio', 'repair-cover'].includes(scope)
    )
      throw invalid();
    if(ids.some(id=>removalOwnsFiles(conn,id)))throw failure('NAS_REMOVAL_BUSY','作品正在处理删除或恢复，请先核对回执。');
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
            : scope === 'repair-cover'
              ? [...new Set(ids)].filter(
                  (id) =>
                    !groups.unavailable.includes(id) &&
                    recordedWork(conn, id).type === 'video' &&
                    conn.prepare("SELECT 1 FROM archive_resources WHERE work_id=? AND key='video'").get(id)
                )
              : ids.filter(
                  (id) => recordedWork(conn, id).type === 'images' && !groups.unavailable.includes(id)
                );
    let existing = 0,
      queued = 0,
      first,
      removed = 0;
    for (const workId of eligible) {
      const jobId =
        scope === 'audio' ? 'audio:' + workId : scope === 'repair-cover' ? 'hd:' + workId : workId;
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
      if (old && !old.legacyTask && (tabs.active.includes(old.state) || old.cleanupPending)) {
        existing++;
        continue;
      }
      if (old?.state === 'waiting-auth' && old.auth.uid !== auth.uid) throw authRequired();
      const work = recordedWork(conn, workId);
      const frozen = freeze(work, scope === 'audio');
      for (const candidates of Object.values(frozen.candidates))
        for (const url of candidates) validMediaTarget(url);
      let hd;
      if (scope === 'repair-cover') {
        hd = hdSourceProof(conn, workId);
        assertHDSources(frozen, hd.hdSources);
      }
      put(conn, {
        id: jobId,
        workId,
        sourceFence:old?.sourceFence??0,
        title: work.name,
        ...frozen,
        auth,
        audioOnly: scope === 'audio',
        ...hd,
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
    const keys = all && action==='retry'
      ? conn.prepare('SELECT j.id'+join+filterSql('failed')).all().map(row=>row.id)
      : all
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
      if(['resume','retry'].includes(action)&&sourceState(conn,job.workId)==='unavailable'){
        fenceUnavailable(conn,job.workId);continue;
      }
      if(['resume','retry','cancel'].includes(action)&&removalOwnsFiles(conn,job.workId))throw failure('NAS_REMOVAL_BUSY','请先处理此作品的删除或恢复回执。');
      if (job.legacyTask && !['complete', 'cancelled'].includes(job.state)) {
        if (action === 'cancel') {
          job.state = 'cancelled';
          put(conn, job);
          changed++;
          continue;
        }
        const resume = action === 'resume' && job.state === 'paused';
        const retry = action === 'retry' && ['failed', 'review', 'unavailable'].includes(job.state);
        if (resume || retry) {
          changed += enqueue(conn, [job.workId], job.legacyTask.coverOnly ? 'repair-cover' : 'repair').queued;
          continue;
        }
      }
      if (action === 'clear' && job.state === 'complete') {
        conn.prepare('UPDATE download_manifests SET hidden=1 WHERE id=?').run(id);
        conn.exec('UPDATE download_options SET revision=revision+1');
        changed++;
        continue;
      }
      if (action === 'pause' && ['running', 'queued','awaiting-registration'].includes(job.state))
        job.state = job.state === 'running' ? 'pausing' : 'paused';
      else if (
        (action === 'resume' && job.state === 'paused') ||
        (action==='retry'&&!all&&job.state==='unavailable'&&sourceState(conn,job.workId)==='available') ||
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
    store.assertDownloadSource(db,job.workId,job.id);
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
  async function fetchSourceMedia(url, options, guard) {
    let target = validMediaTarget(url);
    const headers = new Headers(options.headers);
    headers.set('Referer', 'https://www.douyin.com/');
    headers.set('Accept-Encoding','identity');
    for (let hops = 0; hops < 6; hops++) {
      guard();
      const response = await fetchAsset(target, {
        method: options.method==='HEAD'?'HEAD':'GET',
        headers,
        redirect: 'manual',
        credentials: 'omit',
        signal: options.signal
      });
      try {
        guard();
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
  const fetchMedia = (url, options, job) =>
    fetchSourceMedia(url, options, () => requireWriter(job, options.signal));
  async function refresh(job, signal) {
    requireWriter(job, signal);
    const observed = await source.readDownloadDetail({ workId: job.workId, ...job.auth, signal });
    requireWriter(job, signal);
    if (observed?.id !== job.workId) throw needsReview();
    if (observed.remoteState === 'unavailable') {
      store.withWrite((conn) => {
        requireWriter(job, signal);
        conn
          .prepare(
            "UPDATE works SET body=json_set(body,'$.remoteState','unavailable','$.sourceStatus',json(?)) WHERE id=?"
          )
          .run(
            JSON.stringify(observed.sourceStatus ?? { state: 'unavailable', method: 'platform' }),
            job.workId
          );
        fenceUnavailable(conn, job.workId);
      });
      stopUnavailable(job.workId);
      throw unavailable();
    }
    if (observed.statusOnly) throw notAvailable();
    if (job.hdInputs) assertHDSources(freeze(observed, false), validateHDSource(job.workId, job));
    const candidates = refreshCandidates(job, observed);
    return change(job.id, (current) => {
      current.candidates = candidates;
    });
  }

  async function downloadOne(job, target, home, signal, candidateOnly = false) {
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
    if (existing && !candidateOnly) {
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
      const urlHash = contentHash(url);
      const stage = await openFileStage({
        store,
        layout,
        jobId: job.id,
        workId: job.workId,
        key: candidateOnly ? 'cover-hd' : target.key,
        kind: target.kind,
        resourceIdentity: target.identity,
        observationIdentity,
        urlHash,
        group,guard:()=>requireWriter(job,signal)
      });
      try {
        store.fileHook('beforeFileWrite', { workId: job.workId, kind: target.kind, file: stage.dir });
        let lastProgress = 0;
        const result =
          (await stagedTransfer(stage, urlHash, signal)) ??
          (await transferAsset({
            dir: stage.dir,
            target: { name: 'payload', kind: target.kind },
            url,
            signal,
            extension,
            checkpointBytes,
            fetchMedia: async (address, options) => {
              const response = await fetchMedia(address, options, job);
              try {
                await assertFileStage(stage, layout);
              } catch (error) {
                await response.body?.cancel().catch(() => {});
                throw error;
              }
              return response;
            },
            sealPartial: (result) =>
              sealTransfer({
                store,
                layout,
                stage,
                result,
                urlHash,
                guard: () => requireWriter(job, signal)
              }),
            verifyDigests: true,
            beforeWrite:()=>store.assertDownloadSource(db,job.workId,job.id),
            openPartial: (file) => {requireWriter(job,signal);return openStagedPartial(stage, file, layout);},
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
          }));
        if (existing?.missing && !changed && existing.sha256 !== result.sha256)
          throw failure('NAS_HASH_MISMATCH', '下载内容与已知 SHA-256 摘要不同。');
        const audio = target.kind === 'audio' ? await audioInfo(result.file, signal) : null;
        const ext = audio ? '.' + audio.format : result.extension;
        const mime = audio
          ? { wav: 'audio/wav', mp3: 'audio/mpeg', aac: 'audio/aac', m4a: 'audio/mp4' }[audio.format]
          : mimeByExtension.get(ext);
        const dimensions = audio ? { duration: audio.duration } : await verifyFormat(result, mime, signal);
        comparisons.push({ stage, result, mime, ext, dimensions });
        handled.add(group);
        if (!cover) break;
      } catch (error) {
        if (error.code === 'CONTENT_DIGEST_MISMATCH') error = failure('NAS_HASH_MISMATCH', error.message);
        if (
          signal.aborted ||
          storage.has(error?.code) ||
          authErrors.has(error?.code) ||
          ['NAS_MEDIA_TARGET', 'NAS_MEDIA_REDIRECTS', 'SOURCE_RATE_LIMITED', 'NAS_FILE_REVIEW'].includes(
            error?.code
          )
        )
          throw error;
        discardInvalidTransfer(store, stage);
        lastError = error;
      }
    }
    if (!comparisons.length) throw lastError;
    requireWriter(job, signal);
    const area = ({ dimensions }) => (dimensions.width ?? 0) * (dimensions.height ?? 0);
    const best = comparisons.toSorted((a, b) => area(b) - area(a))[0];
    if (candidateOnly) return best;
    if (cover && target.sourceIdentity && new Set(job.candidates.cover.map(coverObject)).size === 1) {
      best.stage.commit.body.selectedCoverIdentity = target.identity;
    }
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

  async function repairCover(job, home, signal) {
    const { workId } = job;
    const resolve = (key,allowMissing=false) => resolveResource({ store, layout, workId, key, verify: true, allowMissing, signal });
    const video = await resolve('video'),
      cover = await resolve('cover');
    if (!video) throw failure('NAS_FILE_MISSING', '请先补齐视频。');
    if (video.sha256 !== job.hdInputs.video || cover?.sha256 !== job.hdInputs.cover) throw needsReview();
    const hdSources = validateHDSource(workId, job);
    assertHDSources(job, hdSources);
    let freshReference;
    const guard = () => {
      validateHDSource(workId, job);
      requireWriter(job, signal);
      if (!cover && store.resources(workId).some((row) => row.key === 'cover')) throw needsReview();
      freshReference?.();
      for (const asset of [video, cover].filter(Boolean))
        assertResourceCurrent({ store, resource: asset, stat: lstatSync(asset.file, { bigint: true }) });
    };
    guard();
    const old = currentHDCover(db, workId);
    if(old){
      const registered=await resolve(old.key,true);
      if(registered&&!registered.missing&&registered.sha256===old.sha256)return;
    }
    const target = job.expected.find((item) => item.key === 'cover');
    const identity = contentHash(job.hdInputs);
    const publish = async ({ stage, result, mime, ext, dimensions }, source) => {
      guard();
      const existing = await resolveResource({
        store,
        layout,
        workId,
        key: 'cover-hd',
        verify: true,
        allowMissing: true,
        signal
      });
      if (!existing || existing.sha256 !== result.sha256 || existing.missing) {
        stage.commit.body.hdInputs = job.hdInputs;
        stage.commit.body.hdSources = hdSources;
        const previous = existing && {
          missing: !!existing.missing,
          superseded: !existing.missing,
          size: existing.size,
          identity: existing.identity,
          mtimeNs: existing.mtimeNs,
          relative: existing.relative_path,
          revision: existing.revision,
          sha256: existing.sha256
        };
        await verifyAndPlace({
          store,
          layout,
          stage,
          transferred: result,
          mime,
          filename: (source === 'platform' ? '高清封面-' : '视频截帧-') + result.sha256.slice(0, 16) + ext,
          home,
          previous,
          signal,
          guard,
          dimensions: { width: dimensions.width, height: dimensions.height }
        });
      }
      guard();
      return {
        key: 'cover-hd',
        source,
        sha256: result.sha256,
        width: dimensions.width,
        height: dimensions.height
      };
    };
    const result = await assessCover({
      store,
      video,
      cover,
      signal,
      guard,
      python: coverPython,
      async platform(resolution) {
        let best;
        function handleCandidateError(error) {
          guard();
          if (
            storage.has(error.code) ||
            authErrors.has(error.code) ||
            [
              'SOURCE_RATE_LIMITED',
              'NAS_MEDIA_SET_REVIEW',
              'NAS_FILE_REVIEW',
              'NAS_MEDIA_TARGET',
              'NAS_FILE_OPERATION'
            ].includes(error.code)
          )
            throw error;
        }
        if (source?.readDownloadDetail) {
          try {
            job = await refresh(job, signal);
          } catch (error) {
            handleCandidateError(error);
          }
        }
        try {
          best = await downloadOne(job, target, home, signal, true);
        } catch (error) {
          handleCandidateError(error);
        }
        if (!best) return;
        if (comparableResolution(best.dimensions, resolution))
          return { ready: await publish(best, 'platform') };
        if (!cover) {
          const { file, size, sha256 } = best.result;
          const proof = best.stage.commit.body.transfer;
          freshReference = () => {
            const stat = lstatSync(file, { bigint: true }),
              dirStat = lstatSync(best.stage.dir, { bigint: true });
            if (
              !dirStat.isDirectory() ||
              String(dirStat.dev) !== best.stage.commit.body.directory.dev ||
              String(dirStat.ino) !== best.stage.commit.body.directory.ino
            )
              throw failure('NAS_FILE_REVIEW', '候选封面暂存目录已变更。');
            if (
              !proof ||
              !stat.isFile() ||
              stat.nlink !== 1n ||
              String(stat.dev) !== proof.identity.dev ||
              String(stat.ino) !== proof.identity.ino ||
              String(stat.mtimeNs) !== proof.mtimeNs ||
              Number(stat.size) !== size ||
              proof.sha256 !== sha256
            )
              throw failure('NAS_FILE_REVIEW', '候选封面身份已变更。');
          };
          freshReference();
          return { reference: { file, size, sha256 } };
        }
      },
      async publish(bytes, dimensions) {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const stage = await openFileStage({
          store,
          layout,
          jobId: job.id,
          workId,
          key: 'cover-hd',
          kind: 'image',
          resourceIdentity: identity,
          guard
        });
        const file = path.join(stage.dir, 'payload.png');
        const handle = await open(file, 'wx', 0o600);
        try {
          trackStagedFile(store, stage, file, await handle.stat({ bigint: true }));
          guard();
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        return publish(
          { stage, result: { file, size: bytes.length, sha256 }, mime: 'image/png', ext: '.png', dimensions },
          'video_frame'
        );
      }
    });
    if (!result.accepted) {
      const pending = await cleanFileStages({ store, layout, workId, jobId: job.id });
      if (pending)
        change(job.id, (current) => {
          current.cleanupPending = true;
        });
      throw failure('NAS_COVER_REJECTED', result.message);
    }
    store.withWrite((conn) => {
      guard();
      conn
        .prepare('INSERT OR REPLACE INTO hd_covers VALUES(?,?,?,?)')
        .run(workId, video.sha256, cover?.sha256 ?? '', JSON.stringify(result));
    });
  }

  async function saveJob(job, signal) {
    const { workId } = job;
    assertWorkFiles(store, workId);
    if (store.fileCommits(workId).some((commit) => commit.stage === 'review')) {
      throw failure('NAS_FILE_REVIEW', 'A file commit for this work needs review.');
    }
    const home = await ensureHome({ store, layout, workId, guard: () => requireWriter(job, signal) });

    let refreshed = false;
    if (job.hdInputs && !job.finalizationPending) {
      change(job.id, (current) => {
        current.phase = 'matching';
      });
      await withWorkFiles(layout, '\0hd-matching', () => repairCover(job, home, signal));
      for (const item of job.expected) saveProgress(job.id, item);
    }
    for (const target of job.hdInputs || job.finalizationPending ? [] : job.expected) {
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
    if (sharedRepairPeers(db, job).some(needsResourceWork) && getJob(db, job.id).filesComplete) {
      const cleanup = await cleanFileStages({ store, layout, workId, jobId: job.id });
      requireWriter(job, signal);
      if (!cleanup && sharedRepairPeers(db, job).some(needsResourceWork)) {
        const keys = job.hdInputs ? [currentHDCover(db, workId)?.key] : job.expected.map((t) => t.key);
        const rows = store.resources(workId);
        const assets = keys.map((key) => {
          const row = rows.find((a) => a.key === key),
            proof = row && registeredAssetProof(db, workId, row);
          if (!proof?.identity) throw needsReview();
          return { id: row.id, sha256: row.sha256, identity: proof.identity };
        });
        change(job.id, (current) => {
          current.state = 'awaiting-registration';
          current.finalizationPending = true;
          current.cleanupPending = false;
          current.reason = {
            code: 'NAS_REGISTRATION_PENDING',
            message: '此范围字节已保存，等待同一作品的其他范围完成后核验登记。'
          };
          current.registrationAssets = assets;
        });
        return;
      }
    }
    const deferred = db
      .prepare(
        "SELECT 1 FROM maintenance_queue_links l JOIN maintenance_items i ON i.run=l.run AND i.work_id=l.work_id WHERE l.job=? AND json_extract(i.result,'$.registration')='pending' LIMIT 1"
      )
      .get(job.id);
    if (deferred||sharedRepairPeers(db,job).some(p=>p.state==='awaiting-registration')) return job;
    const result = await finalizeWorkFiles({
      store,
      layout,
      workId,
      jobId: job.id,
      signal,
      guard: () => requireWriter(job, signal)
    });
    await finishJob(job, signal, result);
  }
  async function finishJob(job, signal, result) {
    const { workId } = job;
    requireWriter(job, signal);
    const cleanupPending = await cleanFileStages({ store, layout, workId, jobId: job.id });
    const checkNeeded = db
      .prepare(
        'SELECT 1 FROM maintenance_file_state WHERE work_id=? UNION ALL SELECT 1 FROM maintenance_queue_links WHERE job=? LIMIT 1'
      )
      .get(workId, job.id);
    const inventory = checkNeeded
      ? await inspectInventory({ store, layout, work: store.work(workId), signal, wantedResources })
      : null;
    if (inventory) inventory.registrationConfirmed = !!result.ok && inventory.metadataVerified;
    requireWriter(job, signal);
    store.withWrite((conn) => {
      const current = getJob(conn, job.id);
      if (current.state !== 'running' || closing) return;
      current.cleanupPending = cleanupPending;
      current.state = result.ok && !current.cleanupPending ? 'complete' : 'finalization-pending';
      current.finalizationPending = current.state !== 'complete';
      current.reason = !result.ok
        ? result.errors[0]
        : current.cleanupPending
          ? { code: 'CLEANUP_PENDING', message: '下载已登记，临时文件仍待清理。' }
          : null;
      put(conn, current, inventory);
    });
  }

  async function execute(id, controller) {
    const { workId } = getJob(db, id);
    try {
      const before=getJob(db,id);
      const guardRecovery=()=>{
        controller.signal.throwIfAborted();
        if(!stopping.has(before.state))store.assertDownloadSource(db,workId,id);
      };
      guardRecovery();
      const recovered = await recoverFileCommits({
        store,
        layout,
        workId,
        jobId: id,
        guard: guardRecovery
      });
      const deferred=await withWorkFiles(layout, workId, async () => {
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
        return saveJob(job, controller.signal);
      });
      if(deferred){
        const signal=controller.signal;
        const result=await archive.reconcileArchive({workId,signal,guard:()=>requireWriter(deferred,signal)});
        await withWorkFiles(layout,workId,()=>finishJob(deferred,signal,result));
      }
    } catch (e) {
      if (!closing)
        change(id, (job) => {
          if (stopping.has(job.state)||job.state==='unavailable'||active.get(id)?.fence!==(job.sourceFence??0)) return;
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
        let reviewReason;
        const pending = await withWorkFiles(layout, workId, () =>
          cleanFileStages({
            store,
            layout,
            workId,
            jobId: id,
            onReview(reason) {
              reviewReason = reason;
            }
          })
        );
        change(id, (j) => {
          j.state = 'cancelled';
          j.cleanupPending = pending;
          j.reason = pending
            ? reviewReason ?? { code: 'CLEANUP_PENDING', message: '临时文件清理未完成，可再次取消重试。' }
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
            `SELECT j.id,j.work_id,
              j.state IN ('queued','running') AND json_extract(m.body,'$.finalizationPending') IS 1 AS registration_only
              FROM download_jobs j JOIN download_manifests m ON j.id=m.id
      WHERE j.state IN ('pausing','cancelling') OR (?=0 AND j.state IN ('queued','running')) ORDER BY m.rowid`
          )
          .all(opts.paused);
        // Registration checks every registered file. Run this work's admitted byte repairs first.
        const nextByWork = new Map();
        for (const row of candidates) {
          const next = nextByWork.get(row.work_id);
          if (!next || (next.registration_only && !row.registration_only)) nextByWork.set(row.work_id, row);
        }
        for (const row of nextByWork.values()) {
          if (active.size >= opts.concurrency) break;
          if (active.has(row.id) || [...active.values()].some((a) => a.workId === row.work_id)) continue;
          const controller = new AbortController(),
            slot = { workId: row.work_id, controller, fence: getJob(db,row.id).sourceFence ?? 0 };
          active.set(row.id, slot);
          // A catalogue reader may revoke the source while this socket is waiting for a response.
          const monitor = setInterval(() => {
            if (controller.signal.aborted) return;
            try {
              const state = db.prepare('SELECT state FROM download_jobs WHERE id=?').get(row.id)?.state;
              if (!stopping.has(state)) store.assertDownloadSource(db, row.work_id, row.id);
            } catch (error) {
              controller.abort(error);
            }
          }, 350);
          monitor.unref();
          slot.task = execute(row.id, controller).finally(() => {
            clearInterval(monitor);
            active.delete(row.id);
          });
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
      if (!closing) await archive.run();
    })().finally(() => {
      task = null;
      if (rerun && !closing) return run();
    });
    return task;
  }
  return {
    enqueue,
    fenceUnavailable,stopUnavailable,
    fetchSourceMedia,
    sourceAuthorization: () => binding(db),
    readMediaDetail:(workId,auth,signal)=>source.readDownloadDetail({workId,...auth,signal}),
    archive,
    control,
    preview: (conn, ids) => preview(conn, ids).report,
    page: (db,input)=>downloadPage(db,input),
    validateSelection:(db,{tab,ids})=>{
      if(!Array.isArray(ids)||ids.length>10000||ids.some(id=>typeof id!=='string'||id.length>100))throw invalid();
      const visible=new Set(db.prepare('SELECT j.id'+join+filterSql(tab)+' AND j.id IN(SELECT value FROM json_each(?))').all(JSON.stringify(ids)).map(r=>r.id));
      const kept=ids.filter(id=>visible.has(id));
      return {ids:kept,invalid:ids.length-kept.length};
    },
    audioPage:(db,{page,filter})=>{
      const tab={all:'all',waiting:'waiting',running:'running',failed:'failed',complete:'complete'}[filter];
      if(!tab)throw invalid();
      return downloadPage(db,{page,tab},true);
    },
    audioState:db=>queueState(db,true),
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
        await archive.close();
        await task;
      } finally {
        store.close();
      }
    }
  };
}
