import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { contentHash } from '../../../shared/backup-protocol.mjs';
import { isMediaURL } from '../../../electron/model.mjs';
import { imageDimensions } from '../../../electron/media-info.mjs';
import { transferAsset } from '../../../electron/resumable-transfer.mjs';
import { LIMITS, ProbeError } from './contracts.mjs';
import {
  assertFileStage, assertWorkFiles, cleanFileStages, ensureHome, fileReason, finalizeWorkFiles, mediaUsage,
  openFileStage, recoverFileCommits, resolveResource, saveMediaUsage, stageCheckpoints,
  trackStagedFile, verifyAndPlace, withWorkFiles
} from './files.mjs';
import { parseSourceDetail } from './page-parser.mjs';

const detailRoute = '/aweme/v1/web/aweme/detail/';
const commandId = /^[A-Za-z0-9_-]{1,128}$/;
const workIdentity = /^\d{1,32}$/;
const runningRoots = new Set();
const redirectCodes = [301, 302, 303, 307, 308];
const detailBudget = 'download:detail-dispatches';
const sampleBudget = 'download:sample-works';
const activeStates = new Set(['queued', 'running', 'pausing', 'cancelling']);
const resumableStates = new Set(['paused', 'failed', 'waiting-auth', 'waiting-rate', 'finalization-pending']);
const authCodes = ['STALE_AUTH_EPOCH', 'PROBE_AUTH_STALE', 'PROBE_AUTH_REQUIRED', 'PROBE_SOURCE_AUTH'];
const protectedQuery = new Set(['authorization', 'cookie', 'setcookie', 'sessionid', 'sessionidss', 'uidtt',
  'uidttss', 'sidguard', 'sidtt', 'mstoken', 'password', 'accesstoken', 'refreshtoken', 'passportcsrftoken',
  'passportcsrftokendefault']);
const mediaTypes = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/avif', '.avif']
]);
const mimeByExtension = new Map([...mediaTypes].map(([mime, ext]) => [ext, mime]).concat([['.mp4', 'video/mp4']]));
const storage = new Set(['ENOSPC', 'EIO', 'EACCES', 'EPERM', 'EROFS', 'EMFILE', 'ENFILE', 'EDQUOT', 'EBUSY']);
const failure = (code, message) => new ProbeError(code, message);
const formatError = () => failure('PROBE_MEDIA_FORMAT', 'The received file is not the expected media format.');
const limit = () => failure('PROBE_MEDIA_BUDGET', 'The probe media byte budget has been reached.');
const needsReview = () => failure('PROBE_MEDIA_SET_REVIEW', 'The queued work returned a different or unconfirmed resource set.');
const notAvailable = () => failure('PROBE_MEDIA_UNAVAILABLE', 'The queued work did not provide an available media resource.');
const retryableStatus = new Set([401, 403, 404, 410]);
const sourceRetry = error => retryableStatus.has(error?.httpStatus) || error?.code === 'PROBE_MEDIA_UNAVAILABLE';

function readValue(db, key, fallback) {
  const row = db.prepare('SELECT value FROM runtime_meta WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

function putValue(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO runtime_meta VALUES (?,?)').run(key, JSON.stringify(value));
}

function getJob(db, id) {
  const row = db.prepare('SELECT body FROM download_jobs WHERE id=?').get(id);
  return row ? JSON.parse(row.body) : null;
}

function getJobs(db) {
  return db.prepare('SELECT body FROM download_jobs ORDER BY rowid').all().map(row => JSON.parse(row.body));
}

function putJob(db, job, revision) {
  db.prepare('INSERT INTO download_jobs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
    'state=excluded.state,body=excluded.body,revision=excluded.revision')
    .run(job.id, job.workId, job.state, JSON.stringify(job), revision);
}

function summarize(job) {
  const { candidates, ...publicJob } = job;
  return publicJob;
}

function validMediaTarget(value, base) {
  try {
    const url = new URL(value, base);
    const credential = [...url.searchParams.keys()].some(key => protectedQuery.has(key.toLowerCase().replace(/[^a-z0-9]/g, '')));
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && !credential &&
        url.href.length <= 8192 && isMediaURL(url.href)) return url.href;
  } catch { /* return a fixed error without the signed address */ }
  throw failure('PROBE_MEDIA_TARGET', 'The target is outside the secure source media allowlist.');
}

function candidateList(urls) {
  return [...new Set(urls ?? [])].slice(0, 9);
}

function candidateDigest(urls) {
  if (!urls.length) return null;
  const objects = urls.map(address => {
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

function wantedResources(work) {
  const identities = work.mediaQuality?.identities ?? {};
  const entry = (key, name, kind, candidates, sourceIdentity) => ({
    key, name, kind, candidates: candidateList(candidates), sourceIdentity: sourceIdentity || null
  });
  if (work.type === 'images' || identities.imageCount) {
    const byIndex = new Map((work.images ?? []).map(image => [image.index, image]));
    const count = identities.imageCount ?? byIndex.size;
    if (!Number.isInteger(count) || count < 1 || count > 100) throw needsReview();
    return Array.from({ length: count }, (_, index) => entry('image-' + index,
      '图片-' + String(index + 1).padStart(3, '0'), 'image', byIndex.get(index)?.urls, identities.images?.[index]));
  }
  // The normalized source keeps video quality and original-image candidates in priority order.
  const cover = [...(work.coverVariants ?? [])]
    .sort((a, b) => (Number(b.width) * Number(b.height)) - (Number(a.width) * Number(a.height)));
  return [
    entry('video', '视频', 'video', work.videoUrls, identities.video),
    entry('cover', '单图', 'image', [...cover.flatMap(variant => variant.urls), ...(work.coverUrls ?? [])], identities.cover)
  ];
}

function freeze(work) {
  const targets = wantedResources(work);
  const expected = targets.map(({ candidates, ...target }) => ({
    ...target, identity: contentHash({ workId: work.id, key: target.key, kind: target.kind, sourceIdentity: target.sourceIdentity })
  }));
  const candidates = Object.fromEntries(targets.map(target => [target.key, target.candidates]));
  return { expected, candidates };
}

function refreshCandidates(job, work) {
  const observed = wantedResources(work);
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
  return Object.fromEntries(observed.map(candidate => [candidate.key, candidate.candidates]));
}

function extension(contentType, kind) {
  const mime = contentType?.split(';', 1)[0].trim().toLowerCase();
  if (kind === 'video' && ['video/mp4', 'video/x-m4v', 'application/octet-stream'].includes(mime)) return '.mp4';
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
    if (tail + 4 > size || !/^[A-Za-z]{4}$/.test(type) ||
        (chunks === 0 ? type !== 'IHDR' || length !== 13 : type === 'IHDR')) throw formatError();
    let crc = crc32(header.subarray(4));
    for (let offset = at + 8; offset < tail;) {
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
      for (let index = 8; index + 4 <= flags.length; index += 4) brands.push(flags.toString('ascii', index, index + 4));
      const movie = boxes.get('moov');
      if (mime === 'video/mp4' && movie?.length && boxes.get('mdat')?.length > 0 &&
          brands.some(value => /^(?:iso[m2-9]|mp4[12]|avc1|M4V |dash)$/.test(value)) &&
          (await isoBoxes(handle, movie.at + movie.length, signal, movie.at)).get('trak')?.length > 0) return {};
      if (mime === 'image/avif' && brands.some(value => /^avi[fs]$/.test(value)) && boxes.get('meta')?.length > 0 &&
          (boxes.get('mdat')?.length > 0 || boxes.get('moov')?.length > 0)) return {};
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
      if (bytes.subarray(0, 2).toString('hex') === 'ffd8' && end.toString('hex') === 'ffd9') return { width, height };
    }
    if (mime === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' &&
        bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) === size - 8) return { width, height };
    throw formatError();
  } finally { await handle.close(); }
}

function rateLimited(response) {
  const raw = response.headers.get('retry-after');
  const retryAfter = raw && /^\d{1,5}$/.test(raw) ? Math.min(Number(raw), 3600) : 60;
  return new ProbeError('PROBE_SOURCE_RATE_LIMITED', 'The source asked the probe to wait.', { retryAfter });
}

function meterBody(body, { signal, handedBytes, assertAuth }) {
  const reader = body.getReader();
  let pulling;
  let closed = false;
  async function close(reason) {
    if (closed) return;
    closed = true;
    try { await reader.cancel(reason); } finally { reader.releaseLock(); }
  }
  return new ReadableStream({
    pull(controller) {
      pulling = (async () => {
        try {
          signal.throwIfAborted();
          assertAuth();
          const { done, value } = await reader.read();
          if (done) {
            if (!closed) {
              closed = true;
              reader.releaseLock();
            }
            controller.close();
            return;
          }
          // Count the bytes delivered to the worker even if the request has since been cancelled.
          handedBytes(value.byteLength);
          signal.throwIfAborted();
          assertAuth();
          controller.enqueue(value);
        } catch (error) {
          await close(error).catch(() => {});
          controller.error(error);
        }
      })();
      return pulling;
    },
    async cancel(reason) {
      await close(reason).catch(() => {});
      await pulling?.catch(() => {});
    }
  }, { highWaterMark: 0 });
}

function issueFor(error) {
  if (error?.code === 'PROBE_SOURCE_RATE_LIMITED') return {
    ...fileReason(error), retryAfter: Number(error.details?.retryAfter) || 60
  };
  if (error instanceof ProbeError || storage.has(error?.code)) return fileReason(error);
  if (authCodes.includes(error?.code)) return { code: error.code, message: 'The source authorization needs to be checked.' };
  return { code: 'PROBE_DOWNLOAD_FAILED', message: 'The media could not be downloaded or validated.' };
}

export function createDownloads({ store, gateway, layout, clock = Date, fetchAsset = globalThis.fetch, testOptions = {} }) {
  const db = store.db;
  const cap = Math.min(testOptions.maxBytes ?? LIMITS.requestedMediaBytes, LIMITS.requestedMediaBytes);
  const checkpointBytes = testOptions.checkpointBytes;
  let task;
  let active;
  let closing = false;
  const time = () => new Date(clock.now()).toISOString();

  function command(operationId, kind, value, perform) {
    if (!commandId.test(typeof operationId === 'string' ? operationId : '')) {
      throw failure('INVALID_PROBE_OPERATION', 'Download commands require an operation ID.');
    }
    const commandHash = contentHash(value);
    return store.withWrite(() => {
      const stored = db.prepare('SELECT * FROM operations WHERE operation_id=?').get(operationId);
      if (stored) {
        if (stored.kind !== kind || stored.command_hash !== commandHash) {
          throw failure('PROBE_OPERATION_CONFLICT', 'The operation ID already belongs to a different command.');
        }
        return { receipt: JSON.parse(stored.body), replay: true };
      }
      const revision = store.nextRevision();
      const fields = perform(revision);
      const receipt = { operationId, kind, revision, ...fields };
      db.prepare('INSERT INTO operations VALUES (?,?,?,?,?)').run(operationId, kind, commandHash, revision, JSON.stringify(receipt));
      return { receipt, replay: false };
    });
  }

  function enqueue({ workIds, operationId } = {}) {
    if (!Array.isArray(workIds) || workIds.length < 1 || workIds.length > LIMITS.detailSamples ||
        workIds.some(id => typeof id !== 'string' || !workIdentity.test(id))) {
      throw failure('INVALID_PROBE_DOWNLOAD', 'Queue explicitly selected stored work IDs.');
    }
    const selected = [...new Set(workIds)];
    return command(operationId, 'download:enqueue', { workIds: selected }, revision => {
      const known = readValue(db, sampleBudget, []);
      const requested = [...new Set([...known, ...selected])];
      if (requested.length > LIMITS.detailSamples) throw failure('PROBE_DETAIL_BUDGET', 'The probe work sample budget is exhausted.');
      const jobs = selected.map(workId => {
        const work = assertWorkFiles(store, workId);
        const existing = getJobs(db).findLast(job => job.workId === workId && job.state !== 'cancelled');
        if (existing) {
          if (existing.state === 'complete') {
            Object.assign(existing, { state: 'queued', reason: null, completedKeys: [], filesComplete: false, updatedAt: time() });
            putJob(db, existing, revision);
          }
          return summarize(existing);
        }
        const job = {
          id: randomUUID(), workId, ...freeze(work), state: 'queued', reason: null,
          completedKeys: [], filesComplete: false, finalizationPending: false, cleanupPending: false,
          queuedAt: time(), updatedAt: time()
        };
        putJob(db, job, revision);
        return summarize(job);
      });
      putValue(db, sampleBudget, requested);
      return { jobs };
    }).receipt.jobs;
  }

  function control(id, operationId, action) {
    const result = command(operationId, 'download:' + action, { id }, revision => {
      const job = typeof id === 'string' && commandId.test(id) ? getJob(db, id) : null;
      if (!job) throw failure('PROBE_DOWNLOAD_MISSING', 'The download job could not be found.');
      if (action === 'pause' && ['queued', 'running'].includes(job.state)) {
        job.state = job.state === 'running' ? 'pausing' : 'paused';
      } else if (action === 'resume' && resumableStates.has(job.state)) {
        job.state = 'queued';
        job.reason = null;
      } else if (action === 'cancel' && (activeStates.has(job.state) || resumableStates.has(job.state) ||
          job.state === 'review' || job.state === 'cancelled' && job.cleanupPending)) {
        job.state = 'cancelling';
        job.reason = null;
      }
      job.updatedAt = time();
      putJob(db, job, revision);
      return { job: summarize(job) };
    });
    if (!result.replay && active?.id === id && ['pausing', 'cancelling'].includes(result.receipt.job.state)) {
      active.controller.abort();
    }
    return result.receipt.job;
  }

  function change(id, callback) {
    return store.withWrite(() => {
      const job = getJob(db, id);
      callback(job);
      job.updatedAt = time();
      putJob(db, job, store.nextRevision());
      return job;
    });
  }

  function requireWriter(job, signal, authEpoch) {
    signal.throwIfAborted();
    if (getJob(db, job.id)?.state !== 'running') throw failure('PROBE_DOWNLOAD_PAUSED', 'The download writer is stopping.');
    assertWorkFiles(store, job.workId);
    if (authEpoch !== undefined) gateway.assertAuthEpoch(authEpoch);
  }

  async function fetchMedia(url, options, job, authEpoch) {
    const { signal } = options;
    const range = new Headers(options.headers);
    const assertAuth = () => requireWriter(job, signal, authEpoch);
    let target = validMediaTarget(url);
    for (let hops = 0; hops < 6; hops++) {
      assertAuth();
      if (mediaUsage(store).transferredBytes >= cap) throw limit();
      const allowed = new Headers(await gateway.mediaHeaders(target));
      const headers = new Headers();
      for (const key of ['Referer', 'User-Agent']) {
        if (allowed.has(key)) headers.set(key, allowed.get(key));
      }
      for (const key of ['Accept-Encoding', 'Range', 'If-Range']) {
        if (range.has(key)) headers.set(key, range.get(key));
      }
      assertAuth();
      const response = await fetchAsset(target, { method: 'GET', headers, redirect: 'manual', credentials: 'omit', signal });
      try {
        assertAuth();
        if (response.url && validMediaTarget(response.url) !== target) {
          throw failure('PROBE_MEDIA_TARGET', 'The media transport changed target without probe validation.');
        }
        if (redirectCodes.includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw notAvailable();
          target = validMediaTarget(location, target);
          await response.body?.cancel();
          continue;
        }
        if (response.status === 429) throw rateLimited(response);
        if (!response.ok || !response.body) return response;
        const length = response.headers.get('content-length');
        if (length !== null && /^\d+$/.test(length) && Number(length) > cap - mediaUsage(store).transferredBytes) throw limit();
        const body = meterBody(response.body, {
          signal, assertAuth, handedBytes(bytes) {
            const exceeded = store.withWrite(() => {
              const usage = mediaUsage(store);
              const remaining = cap - usage.transferredBytes;
              usage.transferredBytes += Math.min(bytes, remaining);
              if (bytes > remaining) usage.overLimitReceivedBytes = (usage.overLimitReceivedBytes ?? 0) + bytes - remaining;
              saveMediaUsage(db, usage);
              return bytes > remaining;
            });
            if (exceeded) throw limit();
          }
        });
        return { url: target, status: response.status, ok: true, headers: response.headers, body };
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        throw error;
      }
    }
    throw failure('PROBE_MEDIA_REDIRECTS', 'The source media redirect limit was reached.');
  }

  async function refresh(job, signal, authEpoch) {
    requireWriter(job, signal, authEpoch);
    const result = await gateway.request(detailRoute, {
      method: 'GET', params: { aweme_id: job.workId }, authEpoch, signal,
      beforeDispatch() {
        store.withWrite(() => {
          requireWriter(job, signal, authEpoch);
          const used = readValue(db, detailBudget, 0);
          if (used >= LIMITS.detailSamples) throw failure('PROBE_DETAIL_BUDGET', 'The probe work detail budget is exhausted.');
          putValue(db, detailBudget, used + 1);
        });
      }
    });
    requireWriter(job, signal, authEpoch);
    const work = parseSourceDetail({ ...result, workId: job.workId, observedAt: time() });
    if (work.remoteState === 'unavailable') throw notAvailable();
    const candidates = refreshCandidates(job, work);
    return change(job.id, current => {
      requireWriter(job, signal, authEpoch);
      current.candidates = candidates;
    });
  }

  async function downloadOne(job, target, home, signal, authEpoch) {
    const existing = await resolveResource({ store, layout, workId: job.workId, key: target.key, verify: true, allowMissing: true, signal });
    const observationIdentity = target.sourceIdentity ? null : candidateDigest(job.candidates[target.key]);
    if (existing) {
      if (existing.resourceIdentity !== target.identity ||
          (!target.sourceIdentity && existing.observationIdentity !== observationIdentity)) throw needsReview();
      if (!existing.missing) return;
      change(job.id, current => {
        current.completedKeys = current.completedKeys.filter(key => key !== target.key);
        current.filesComplete = false;
      });
    }
    if (!job.candidates[target.key].length) throw notAvailable();
    requireWriter(job, signal, authEpoch);
    const cover = target.key === 'cover';
    const handled = new Set();
    const comparisons = [];
    let lastError = notAvailable();
    for (const url of job.candidates[target.key]) {
      requireWriter(job, signal, authEpoch);
      const group = cover ? coverObject(url) : null;
      if (handled.has(group)) continue;
      const stage = await openFileStage({
        store, layout, jobId: job.id, workId: job.workId, key: target.key, kind: target.kind,
        resourceIdentity: target.identity, observationIdentity, group
      });
      try {
        store.fileHook('beforeFileWrite', { workId: job.workId, kind: target.kind, file: stage.dir });
        const result = await transferAsset({
          dir: stage.dir, target: { name: 'payload', kind: target.kind }, url, signal, extension, checkpointBytes,
          fetchMedia: async (address, options) => {
            const response = await fetchMedia(address, options, job, authEpoch);
            try { await assertFileStage(stage, layout); }
            catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
            return response;
          },
          checkpoints: stageCheckpoints(store, stage),
          maxBytes: cap,
          reserve(bytes) {
            requireWriter(job, signal, authEpoch);
            if (bytes > cap - mediaUsage(store).newMediaBytes) throw limit();
          },
          onFileWrite(file, opened) { trackStagedFile(store, stage, file, opened); }
        });
        const ext = path.extname(result.file);
        const mime = mimeByExtension.get(ext);
        const dimensions = await verifyFormat(result, mime, signal);
        comparisons.push({ stage, result, mime, ext, dimensions });
        handled.add(group);
        if (!cover) break;
      } catch (error) {
        if (error?.code === 'PROBE_MEDIA_BUDGET' && comparisons.length) break;
        if (signal.aborted || storage.has(error?.code) || authCodes.includes(error?.code) ||
            ['PROBE_MEDIA_BUDGET', 'PROBE_MEDIA_TARGET', 'PROBE_MEDIA_REDIRECTS', 'PROBE_SOURCE_RATE_LIMITED', 'PROBE_FILE_REVIEW']
              .includes(error?.code)) throw error;
        lastError = error;
      }
    }
    if (!comparisons.length) throw lastError;
    requireWriter(job, signal, authEpoch);
    const area = ({ dimensions }) => (dimensions.width ?? 0) * (dimensions.height ?? 0);
    const best = comparisons.toSorted((a, b) => area(b) - area(a))[0];
    const previous = existing?.missing ? {
      missing: true, relative: existing.relative_path, revision: existing.revision, sha256: existing.sha256
    } : null;
    await verifyAndPlace({ store, layout, stage: best.stage, transferred: best.result, mime: best.mime,
      filename: target.name + best.ext, home, previous, signal, dimensions: best.dimensions,
      guard: () => requireWriter(job, signal, authEpoch) });
    if (cover) {
      const pending = await cleanFileStages({ store, layout, workId: job.workId, jobId: job.id, key: target.key });
      if (pending) change(job.id, current => { current.cleanupPending = true; });
    }
  }

  function saveProgress(id, target) {
    return change(id, job => {
      if (!job.completedKeys.includes(target.key)) job.completedKeys.push(target.key);
      job.filesComplete = job.completedKeys.length === job.expected.length;
    });
  }

  async function saveJob(job, signal) {
    const { workId } = job;
    assertWorkFiles(store, workId);
    if (store.fileCommits(workId).some(commit => commit.stage === 'review')) {
      throw failure('PROBE_FILE_REVIEW', 'A file commit for this work needs review.');
    }
    const home = await ensureHome({ store, layout, workId });
    const authEpoch = readValue(db, 'browser_auth', {}).authEpoch ?? 0;
    let refreshed = false;
    for (const target of job.expected) {
      requireWriter(job, signal);
      try { await downloadOne(job, target, home, signal, authEpoch); }
      catch (error) {
        if (!sourceRetry(error) || refreshed || signal.aborted) throw error;
        refreshed = true;
        job = await refresh(job, signal, authEpoch);
        await downloadOne(job, target, home, signal, authEpoch);
      }
      saveProgress(job.id, target);
    }
    requireWriter(job, signal);
    const result = await finalizeWorkFiles({ store, layout, workId, jobId: job.id });
    change(job.id, current => {
      current.finalizationPending = result.pending;
      if (current.state !== 'running' || closing) return;
      current.state = result.ok ? 'complete' : 'finalization-pending';
      current.reason = result.ok ? null : result.errors[0];
    });
  }

  async function execute(previous, recovered) {
    const { id, workId } = previous;
    const controller = new AbortController();
    active = { id, controller };
    try {
      await withWorkFiles(layout, workId, async () => {
        let job = getJob(db, id);
        if (job.state === 'cancelling' || job.state === 'pausing' || closing) return;
        job = change(id, current => { current.state = 'running'; current.reason = null; });
        if (recovered?.error) throw failure(recovered.error.code, recovered.error.message);
        await saveJob(job, controller.signal);
      });
    } catch (error) {
      change(id, job => {
        if (job.state !== 'running' || closing) return;
        const issue = issueFor(error);
        job.reason = issue;
        job.state = authCodes.includes(error?.code) ? 'waiting-auth'
          : error?.code === 'PROBE_SOURCE_RATE_LIMITED' ? 'waiting-rate'
            : ['PROBE_MEDIA_SET_REVIEW', 'PROBE_FILE_REVIEW', 'PROBE_FILE_MISSING'].includes(error?.code) ? 'review'
              : error?.code === 'PROBE_MEDIA_BUDGET' || error?.code === 'PROBE_DETAIL_BUDGET' ? 'paused' : 'failed';
      });
    } finally {
      active = null;
      const latest = getJob(db, id);
      if (latest.state === 'cancelling') {
        const pending = await withWorkFiles(layout, workId, () => cleanFileStages({ store, layout, workId, jobId: id }));
        change(id, job => {
          job.state = 'cancelled';
          job.cleanupPending = pending;
          job.reason = pending ? { code: 'PROBE_CLEANUP_PENDING', message: 'Some staging files were retained for cleanup review.' } : null;
        });
      }
      if (latest.state === 'pausing') change(id, job => { job.state = 'paused'; });
    }
  }

  function run() {
    if (task) return task;
    if (closing) return Promise.resolve();
    if (runningRoots.has(layout.root)) {
      return Promise.reject(failure('PROBE_DOWNLOAD_ALREADY_RUNNING', 'A download writer already owns this probe data root.'));
    }
    runningRoots.add(layout.root);
    task = (async () => {
      const recovered = await recoverFileCommits({ store, layout });
      while (!closing) {
        const next = getJobs(db).find(job => activeStates.has(job.state));
        if (!next) return;
        await execute(next, recovered.find(result => result.workId === next.workId && result.error));
      }
    })().finally(() => {
      runningRoots.delete(layout.root);
      task = null;
    });
    return task;
  }

  return Object.freeze({
    enqueue,
    pause: (id, operationId) => control(id, operationId, 'pause'),
    resume: (id, operationId) => control(id, operationId, 'resume'),
    cancel: (id, operationId) => control(id, operationId, 'cancel'),
    snapshot: () => ({ jobs: getJobs(db).map(summarize), usage: {
      ...mediaUsage(store), limitBytes: cap, details: readValue(db, detailBudget, 0), selectedWorks: readValue(db, sampleBudget, []).length
    } }),
    run,
    async close() {
      closing = true;
      active?.controller.abort();
      await task;
    }
  });
}
