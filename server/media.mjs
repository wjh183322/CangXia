import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { once } from 'node:events';
import { addAbortListener } from 'node:events';
import { contentHash } from '../shared/backup-protocol.mjs';
import { recordedWork } from './download-store.mjs';
import { candidateDigest, wantedResources } from './downloads.mjs';
import {
  assertResourceCurrent,
  currentHDCover,
  playbackChangeStamp,
  registeredAssetProof,
  resolveResource
} from './files.mjs';
import { mergeMusic, mergeAudioCandidates } from './source-work-merge.mjs';
import { failure } from './service-error.mjs';

const stale = () => failure(409, 'MEDIA_CHANGED', '媒体或其登记已变化，请刷新作品。');
const unavailable = () => failure(404, 'MEDIA_UNAVAILABLE', '此媒体暂不可读取。');
const badRange = () => failure(416, 'INVALID_RANGE', '请求的字节范围无效。');
export { parseRange } from '../shared/media-range.mjs';
import { parseRange } from '../shared/media-range.mjs';

function sources(work) {
  const targets = [];
  if (work.images?.some((im) => im.index == null))
    work = { ...work, images: work.images.map((im, i) => ({ ...im, index: im.index ?? i })) };
  for (const audio of [false, true]) {
    try {
      targets.push(...wantedResources(work, audio));
    } catch {
      /* incomplete source metadata */
    }
  }
  for (const image of work.images ?? []) {
    const key = 'image-' + image.index;
    if (!targets.some((t) => t.key === key) && image.urls?.length)
      targets.push({
        key,
        kind: 'image',
        sourceIdentity: work.mediaQuality?.identities?.images?.[image.index] ?? null,
        candidates: image.urls
      });
  }
  const thumbnail = work.coverUrls?.length ? work.coverUrls : work.thumbnail ? [work.thumbnail] : [];
  if (thumbnail.length) {
    if (work.type === 'images')
      targets.push({ key: 'thumbnail', kind: 'image', sourceIdentity: null, candidates: thumbnail });
    else {
      const cover = targets.find((t) => t.key === 'cover');
      if (cover && !cover.candidates.length) cover.candidates = thumbnail;
    }
  }
  return targets;
}
function sourceVersion(target) {
  return 'source-' + contentHash([target.sourceIdentity, candidateDigest(target.candidates)]);
}
function describe(db, work) {
  const media = new Map();
  for (const target of sources(work)) {
    if (!target.candidates.length) continue;
    let version;
    try {
      version = sourceVersion(target);
    } catch {
      continue;
    }
    media.set(target.key, {
      key: target.key,
      kind: target.kind,
      resourceId: work.id + ':' + target.key,
      version,
      saved: false
    });
  }
  const hd = currentHDCover(db, work.id);
  for (const row of db
    .prepare("SELECT * FROM archive_resources WHERE work_id=? AND kind<>'metadata'")
    .all(work.id)) {
    if (!['image', 'video', 'audio'].includes(row.kind) || (row.key === 'cover-hd' && row.key !== hd?.key))
      continue;
    if (row.key === 'audio' && work.music?.id) {
      const expected = contentHash({
        workId: work.id,
        key: 'audio',
        kind: 'audio',
        sourceIdentity: 'music:' + work.music.id
      });
      if (registeredAssetProof(db, work.id, row)?.resourceIdentity !== expected) {
        const entry = media.get('audio');
        if (entry) entry.versionMismatch = true;
        continue;
      }
    }
    media.set(row.key, {
      key: row.key,
      kind: row.kind,
      resourceId: row.id,
      version: row.revision + '-' + row.sha256,
      size: row.size,
      mime: row.mime,
      saved: true,
      ...(row.key === hd?.key ? { width: hd.width, height: hd.height } : {})
    });
  }
  return media;
}
export function mediaList(db, id) {
  const work = recordedWork(db, id);
  if (!work) return [];
  const index = (item) => (/^image-\d+$/.test(item.key) ? Number(item.key.slice(6)) : Infinity);
  return [...describe(db, work).values()].sort((a, b) => index(a) - index(b));
}
export async function refreshAudio({ downloads, session, id }) {
  if (typeof id !== 'string' || !/^\d{1,40}$/.test(id)) throw unavailable();
  const snapshot = session.read((db) => recordedWork(db, id));
  if (snapshot?.type !== 'images') throw unavailable();
  const auth = downloads.sourceAuthorization(),
    observed = await downloads.readMediaDetail(id, auth, session.signal);
  if (observed?.id !== id || !observed.music || observed.statusOnly) throw unavailable();
  return session.write((db) => {
    if (
      contentHash(snapshot) !== contentHash(recordedWork(db, id)) ||
      contentHash(auth) !== contentHash(downloads.sourceAuthorization())
    )
      throw stale();
    const music = mergeMusic(snapshot.music, observed.music, new Set(observed.observedFields));
    const previous = snapshot.audioSourceHints;
    const sources = new Map((previous?.sources || []).map((s) => [s.kind, s]));
    mergeAudioCandidates(sources, previous?.music, music, observed.music, observed.audioSourceHints?.sources);
    db.prepare("UPDATE works SET body=json_set(body,'$.music',json(?)) WHERE id=?").run(
      JSON.stringify(music),
      id
    );
    if (sources.size) {
      db.prepare('INSERT OR REPLACE INTO source_audio_hints VALUES(?,?)').run(
        id,
        JSON.stringify({ workId: id, music, sources: [...sources.values()], observedAt: observed.checkedAt })
      );
    } else db.prepare('DELETE FROM source_audio_hints WHERE work_id=?').run(id);
    return { updated: true };
  });
}
export function displayCover(media) {
  return (
    media.find((row) => row.key === 'cover-hd') ||
    media.find((row) => row.key === 'cover') ||
    media.find((row) => row.key === 'image-0' && row.saved) ||
    media.find((row) => row.key === 'thumbnail') ||
    media.find((row) => row.key === 'image-0') ||
    null
  );
}
const mimeTypes = {
  image: /^image\/(jpeg|png|webp|avif)$/,
  video: /^video\/(mp4|x-m4v)$/,
  audio: /^audio\/(mpeg|mp3|mp4|x-m4a|aac|wav|x-wav)$/
};
// A store owns one SQLite connection. data_version covers other connections and
// total_changes covers writes on that connection. Reuse a bounded set of parsed works
// while both remain unchanged, including for cheap buffered-body authorizations.
const mediaSnapshots = new WeakMap();
function snapshots(store) {
  let cache = mediaSnapshots.get(store);
  if (!cache) {
    cache = {
      query: store.db.prepare(
        'SELECT (SELECT data_version FROM pragma_data_version) AS version,total_changes() AS writes'
      ),
      works: new Map()
    };
    mediaSnapshots.set(store, cache);
  }
  const version = cache.query.get();
  if (version.version !== cache.version || version.writes !== cache.writes) {
    cache.works.clear();
    Object.assign(cache, version);
  }
  return cache.works;
}
const prefixLimit = 128;
function detectPrefix(bytes, kind) {
  const tag = (start, end) => bytes.toString('latin1', start, end);
  if (kind === 'image') {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (tag(0, 4) === 'RIFF' && tag(8, 12) === 'WEBP') return 'image/webp';
  }
  if (kind === 'audio') {
    if (tag(0, 4) === 'RIFF' && tag(8, 12) === 'WAVE') return 'audio/wav';
    if (
      bytes.length >= 10 &&
      tag(0, 3) === 'ID3' &&
      [2, 3, 4].includes(bytes[3]) &&
      [...bytes.subarray(6, 10)].every((b) => b < 128)
    )
      return 'audio/mpeg';
    if (bytes.length >= 7 && bytes[0] === 255) {
      if ((bytes[1] & 246) === 240 && ((bytes[2] >> 2) & 15) < 13) return 'audio/aac';
      if (
        (bytes[1] & 224) === 224 &&
        (bytes[1] & 6) !== 0 &&
        (bytes[1] & 24) !== 8 &&
        bytes[2] >> 4 !== 15 &&
        (bytes[2] & 12) !== 12
      )
        return 'audio/mpeg';
    }
  }
  if (bytes.length >= 16 && tag(4, 8) === 'ftyp') {
    const size = bytes.readUInt32BE(0);
    if (size < 16 || size > 4096 || size % 4 !== 0) return null;
    const brands = [tag(8, 12)];
    for (let i = 16; i + 4 <= Math.min(size, bytes.length); i += 4) brands.push(tag(i, i + 4));
    if (kind === 'image' && brands.some((b) => ['avif', 'avis'].includes(b))) return 'image/avif';
    if (kind === 'audio' && brands.some((b) => ['M4A ', 'M4B ', 'F4A '].includes(b))) return 'audio/mp4';
    if (kind === 'audio' && brands.some((b) => /^(isom|iso[2-9]|mp4[12])$/.test(b))) return 'generic-mp4';
    if (
      kind === 'video' &&
      brands.some((b) => /^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(b)) &&
      !brands.some((b) => ['avif', 'avis', 'M4A ', 'M4B ', 'F4A '].includes(b))
    )
      return 'generic-mp4';
  }
  return null;
}
async function sniff(result, kind) {
  if (!result.body) return null;
  const reader = result.body.getReader(),
    held = [];
  let prefix = Buffer.alloc(0),
    mime;
  try {
    while (prefix.length < prefixLimit) {
      const { value, done } = await reader.read();
      if (done) break;
      held.push(value);
      prefix = Buffer.concat([prefix, Buffer.from(value.subarray(0, prefixLimit - prefix.length))]);
      mime = detectPrefix(prefix, kind);
      if (mime || /^\s*</.test(prefix.toString('latin1'))) break;
    }
    if (!mime) {
      await reader.cancel();
      reader.releaseLock();
      return null;
    }
    if (mime === 'generic-mp4') {
      const parts = [];
      let remaining = 8192;
      for (const chunk of held) {
        const part = Buffer.from(chunk.subarray(0, remaining));
        parts.push(part);
        remaining -= part.length;
        if (!remaining) break;
      }
      result.isoPrefix = Buffer.concat(parts);
    }
    result.body = new ReadableStream(
      {
        async pull(controller) {
          if (held.length) {
            controller.enqueue(held.shift());
            return;
          }
          const { value, done } = await reader.read();
          if (done) {
            reader.releaseLock();
            controller.close();
          } else controller.enqueue(value);
        },
        async cancel(reason) {
          await reader.cancel(reason);
          reader.releaseLock();
        }
      },
      { highWaterMark: 0 }
    );
    return mime;
  } catch (e) {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    throw e;
  }
}
const prefixProofs = new WeakMap();
function proofCache(store) {
  let proofs = prefixProofs.get(store);
  if (!proofs) {
    proofs = new Map();
    prefixProofs.set(store, proofs);
  }
  return proofs;
}
function responseSpan(result, range) {
  if (result.status === 200)
    return {
      total: result.headers.has('content-length') ? Number(result.headers.get('content-length')) : null,
      start: 0,
      end: Infinity
    };
  if (result.status !== 206 || !range) return null;
  const part = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.headers.get('content-range') || '');
  if (!part) return null;
  const total = Number(part[3]);
  let expected;
  try {
    expected = parseRange(range, total);
  } catch {
    return null;
  }
  if (
    expected.start !== Number(part[1]) ||
    expected.end !== Number(part[2]) ||
    (result.headers.has('content-length') && Number(result.headers.get('content-length')) !== expected.length)
  )
    return null;
  return { ...expected, total };
}
function matchingObject(result, probe, span, requested) {
  const part = responseSpan(probe, requested);
  if (
    !part ||
    part.total == null ||
    (span.total != null && part.total !== span.total) ||
    probe.url !== result.url
  )
    return null;
  for (const header of ['etag', 'last-modified', 'repr-digest']) {
    if (result.headers.get(header) !== probe.headers.get(header)) return null;
  }
  return part;
}
async function boundedBytes(body, limit) {
  const reader = body.getReader(),
    buf = Buffer.alloc(limit);
  let filled = 0;
  try {
    while (filled < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      const count = Math.min(value.length, limit - filled);
      buf.set(value.subarray(0, count), filled);
      filled += count;
    }
    return buf.subarray(0, filled);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
// ISO generic brands are shared by audio and video. Inspect mdia/hdlr from the
// actual movie index. Jump over mdat using its box length, even if moov is at EOF.
async function matchingTracks(result, span, fetchRange, kind) {
  let total = span.total,
    window = result.isoPrefix,
    offset = 0,
    reads = 0,
    boxes = 0,
    hasAudio = false,
    hasVideo = false;
  async function at(pos, n) {
    if (!window || pos < offset || pos + n > offset + window.length) {
      if (++reads > 16) return null;
      const range = 'bytes=' + pos + '-' + Math.min(pos + 8191, total == null ? Infinity : total - 1);
      const probe = await fetchRange(range);
      try {
        const match = matchingObject(result, probe, span, range);
        if (!match || match.start !== pos || !probe.body) return null;
        total = match.total;
        window = await boundedBytes(probe.body, Math.min(8192, total - pos));
        offset = pos;
      } finally {
        await probe.body?.cancel().catch(() => {});
      }
    }
    return pos + n <= offset + window.length ? window.subarray(pos - offset, pos - offset + n) : null;
  }
  async function scan(begin, end, parent) {
    for (let pos = begin; pos < end; ) {
      if (++boxes > 256 || end - pos < 8) return false;
      const h = await at(pos, 8);
      if (!h) return false;
      let length = h.readUInt32BE(),
        header = 8;
      if (length === 1) {
        const ext = await at(pos + 8, 8);
        if (!ext) return false;
        length = Number(ext.readBigUInt64BE());
        header = 16;
      }
      if (length === 0) length = end - pos;
      if (!Number.isSafeInteger(length) || length < header || length > end - pos) return false;
      const type = h.toString('latin1', 4, 8),
        child = { root: 'moov', moov: 'trak', trak: 'mdia' }[parent];
      if (type === child) {
        if (!(await scan(pos + header, pos + length, type))) return false;
        // moov is the complete track catalogue; later moof/mdat boxes carry samples.
        if (parent === 'root') return true;
      }
      if (parent === 'mdia' && type === 'hdlr') {
        if (length < header + 12) return false;
        const name = (await at(pos + header + 8, 4))?.toString('latin1');
        if (name === 'soun') hasAudio = true;
        if (name === 'vide') hasVideo = true;
      }
      pos += length;
    }
    return parent !== 'root';
  }
  const matches = () => (kind === 'video' ? hasVideo : hasAudio && !hasVideo);
  if (total == null && window) {
    for (let pos = 0; pos + 8 <= window.length; ) {
      const size = window.readUInt32BE(pos);
      if (size < 8 || pos + size > window.length) break;
      if (window.toString('latin1', pos + 4, pos + 8) === 'moov')
        return (await scan(pos + 8, pos + size, 'moov')) && matches();
      pos += size;
    }
    window = null;
  }
  if (!(await at(0, 8)) || !Number.isSafeInteger(total)) return false;
  return (await scan(0, total, 'root')) && matches();
}
// Anonymous CDN responses have no cross-request byte identity. When available, a
// multipart reply carries the metadata and distant span together. Near the start
// a single contiguous reply is cheaper; only the bounded leading bytes are skipped.
const anonymousSkipLimit = 64 * 1024,
  anonymousMetadata = 8192;
const unsupportedMulti = Symbol('origin does not serve multipart ranges');
function rangeReader(body) {
  const reader = body.getReader();
  let buffered = Buffer.alloc(0),
    pushback = Buffer.alloc(0),
    closed = false;
  async function next(limit) {
    if (pushback.length) {
      const part = pushback.subarray(0, limit);
      pushback = pushback.subarray(part.length);
      return part;
    }
    while (!buffered.length) {
      const { done, value } = await reader.read();
      if (done) throw unavailable();
      buffered = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    const part = buffered.subarray(0, limit);
    buffered = buffered.subarray(part.length);
    return part;
  }
  async function exact(size) {
    const value = Buffer.alloc(size);
    for (let at = 0; at < size; ) {
      const chunk = await next(size - at);
      chunk.copy(value, at);
      at += chunk.length;
    }
    return value;
  }
  async function close() {
    if (closed) return;
    closed = true;
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  async function partHeader(boundary, start, end, total, first) {
    const header = Buffer.alloc(4096);
    let length = 0;
    while (length < 4096) {
      const previous = length,
        chunk = await next(header.length - length);
      chunk.copy(header, length);
      length += chunk.length;
      const bytes = header.subarray(0, length),
        split = bytes.indexOf('\r\n\r\n', Math.max(0, previous - 3));
      if (split < 0) continue;
      pushback = Buffer.concat([bytes.subarray(split + 4), pushback]);
      const lines = bytes.toString('latin1', 0, split).split('\r\n');
      if (!first && lines.shift() !== '') return false;
      if (lines.shift() !== '--' + boundary) return false;
      for (const line of lines) {
        if (/^content-length:/i.test(line) && line.slice(15).trim() !== String(end - start + 1)) return false;
        if (
          /^content-(transfer-)?encoding:/i.test(line) &&
          !/^(identity|binary)$/i.test(line.split(':')[1]?.trim())
        )
          return false;
      }
      const ranges = lines.filter((line) => /^content-range:/i.test(line));
      return ranges.length === 1 && ranges[0].slice(14).trim() === `bytes ${start}-${end}/${total}`;
    }
    return false;
  }
  function stream(count, leading, boundary) {
    return new ReadableStream(
      {
        async pull(controller) {
          try {
            let chunk;
            if (leading.length) {
              chunk = leading.subarray(0, count);
              leading = leading.subarray(chunk.length);
            } else chunk = await next(count);
            count -= chunk.length;
            if (!count) {
              if (boundary) {
                const marker = '\r\n--' + boundary + '--';
                if ((await exact(marker.length)).toString('latin1') !== marker) throw unavailable();
              }
              await close();
            }
            controller.enqueue(chunk);
            if (!count) controller.close();
          } catch (error) {
            await close();
            controller.error(error);
          }
        },
        cancel: close
      },
      { highWaterMark: 0 }
    );
  }
  return { exact, close, partHeader, stream };
}
async function anonymousBody(result, item, span, fetchRange) {
  const far = span.start > anonymousSkipLimit;
  const prefixSize = Math.min(span.total, anonymousMetadata);
  const end = Math.max(span.end, prefixSize - 1);
  const request = far ? `bytes=0-${prefixSize - 1},${span.start}-${span.end}` : `bytes=0-${end}`;
  const probe = await fetchRange(request);
  let r,
    handed = false;
  try {
    if (probe.url !== result.url) return null;
    let boundary;
    if (far) {
      const match =
        /^multipart\/byteranges\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=? -]{1,70})"|([A-Za-z0-9._+-]{1,70}))\s*$/i.exec(
          probe.headers.get('content-type') || ''
        );
      if (!match && [200, 206, 400, 405, 416].includes(probe.status)) return unsupportedMulti;
      if (probe.status !== 206 || !match) return null;
      boundary = match[1] || match[2];
    } else {
      const part = matchingObject(result, probe, span, request);
      if (!part || part.start !== 0) return null;
    }
    if (!probe.body) return null;
    r = rangeReader(probe.body);
    if (far && !(await r.partHeader(boundary, 0, prefixSize - 1, span.total, true))) return null;
    const prefix = await r.exact(prefixSize),
      mime = detectPrefix(prefix, item.kind);
    if (!mime) return null;
    let leading = Buffer.alloc(0);
    if (far) {
      if (!(await r.partHeader(boundary, span.start, span.end, span.total, false))) return null;
    } else if (span.start < prefixSize) {
      leading = prefix.subarray(span.start);
    } else await r.exact(span.start - prefixSize);
    result.isoPrefix = prefix;
    await result.body.cancel();
    result.body = r.stream(span.length, leading, boundary);
    handed = true;
    return mime;
  } catch (error) {
    if (error.code === 'MEDIA_UNAVAILABLE') return null;
    throw error;
  } finally {
    if (!handed) {
      if (r) await r.close();
      else await probe.body?.cancel().catch(() => {});
    }
  }
}
async function sourceMime({ result, item, range, head, fetchRange, sourceIdentity, verifyOrigin, proofs }) {
  const declared = (result.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && !mimeTypes[item.kind].test(declared))
    return null;
  const span = responseSpan(result, range);
  if (!span) return null;
  const etag = result.headers.get('etag'),
    strong = /^"[^"]+"$/.test(etag || '');
  const key = strong && JSON.stringify([item.resourceId, item.version, result.url, etag, span.total]);
  if (key && proofs.has(key) && (head || span.start > 0 || span.end < prefixLimit - 1))
    return proofs.get(key);
  let mime;
  if (!head && span.start === 0 && (span.end >= prefixLimit - 1 || span.end === span.total - 1)) {
    mime = await sniff(result, item.kind);
  } else {
    // A corroborating source/version is sufficient to inspect the format for playback.
    // A resumable export still needs a strong byte-level validator.
    const evidence =
      strong ||
      sourceIdentity ||
      /^W\/"[^"]+"$/.test(etag || '') ||
      result.headers.get('repr-digest') ||
      result.headers.get('last-modified');
    const anonymous = (!declared || declared === 'application/octet-stream') && !evidence && !head;
    let prefixNeeded = !anonymous;
    if (anonymous) {
      mime = await anonymousBody(result, item, span, fetchRange);
      if (mime === unsupportedMulti) {
        if (!(await verifyOrigin())) return null;
        prefixNeeded = true;
      }
    }
    if (prefixNeeded) {
      const request = `bytes=0-${prefixLimit - 1}`,
        probe = await fetchRange(request);
      try {
        const prefix = matchingObject(result, probe, span, request);
        if (!prefix || prefix.start !== 0 || !probe.body) return null;
        mime = await sniff(probe, item.kind);
        if (probe.isoPrefix) result.isoPrefix = probe.isoPrefix;
      } finally {
        await probe.body?.cancel().catch(() => {});
      }
    }
  }
  if (mime === 'generic-mp4')
    mime = (await matchingTracks(result, span, fetchRange, item.kind)) ? item.kind + '/mp4' : null;
  if (mime && key) {
    if (proofs.size >= 256) proofs.delete(proofs.keys().next().value);
    proofs.set(key, mime);
  }
  return mime;
}
export async function serveMedia(req, res, { downloads, session, body }) {
  const { resourceId, version, head = false } = body;
  const match = /^(\d{1,40}):(image-\d+|video|cover|cover-hd|audio|thumbnail)$/.exec(resourceId);
  if (!match || typeof version !== 'string' || typeof head !== 'boolean') throw unavailable();
  const [, workId, key] = match,
    { store, layout } = downloads;
  const disconnected = new AbortController(),
    signal = AbortSignal.any([session.signal, disconnected.signal]);
  const close = () => disconnected.abort();
  res.once('close', close);
  const cancel = addAbortListener(signal, () => res.destroy());
  const revision = req.headers['x-cangxia-export-revision'];
  const revisionQuery =
    revision !== undefined ? store.db.prepare('SELECT revision FROM catalogue_version WHERE id=1') : null;
  const readCurrent = () => {
    signal.throwIfAborted();
    session.guard(store.db);
    if (revisionQuery && String(revisionQuery.get().revision) !== revision)
      throw failure(412, 'STALE_SELECTION', '导出清单已变化，请重新确认选择。');
    const current = snapshots(store);
    let saved = current.get(workId);
    if (!saved) {
      const work = store.work(workId);
      if (!work) throw stale();
      saved = { work, media: describe(store.db, work) };
      if (current.size >= 32) current.delete(current.keys().next().value);
      current.set(workId, saved);
    }
    const { work } = saved,
      item = saved.media.get(key);
    if (!item || item.resourceId !== resourceId || item.version !== version) throw stale();
    return { work, item };
  };
  const common = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes'
  };
  let timer, handle, upstream;
  async function send(bytes) {
    if (!res.write(bytes)) await once(res, 'drain', { signal });
  }
  try {
    const { work, item } = readCurrent();
    let guard;
    if (item.saved) {
      let resource;
      try {
        resource = await resolveResource({ store, layout, workId, key, signal });
        if (!resource || resource.revision + '-' + resource.sha256 !== version) throw stale();
        handle = await fs.open(resource.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch {
        throw stale();
      }
      const changeNs = await playbackChangeStamp(store, resource, signal);
      const dbStamp = store.db.prepare(
        'SELECT (SELECT data_version FROM pragma_data_version) AS v,total_changes() AS changes'
      );
      let stamp;
      guard = async () => {
        signal.throwIfAborted();
        session.guard(store.db);
        const state = dbStamp.get(),
          current = state.v + ':' + state.changes;
        if (current !== stamp) {
          readCurrent();
          stamp = current;
        }
        const [opened, named] = await Promise.all([
          handle.stat({ bigint: true }),
          fs.lstat(resource.file, { bigint: true })
        ]);
        try {
          assertResourceCurrent({ store, resource, stat: opened });
          if (
            !named.isFile() ||
            named.dev !== opened.dev ||
            named.ino !== opened.ino ||
            changeNs !== String(opened.ctimeNs)
          )
            throw stale();
        } catch {
          throw stale();
        }
      };
      await guard();
      let range;
      try {
        range = parseRange(req.headers.range, item.size);
      } catch {
        res.writeHead(416, { ...common, 'Content-Range': 'bytes */' + item.size, 'Content-Length': 0 }).end();
        return;
      }
      res.writeHead(range.status, {
        ...common,
        'Content-Type': item.mime,
        'Content-Length': range.length,
        ETag: '"' + resource.sha256 + '"',
        ...(range.status === 206 ? { 'Content-Range': `bytes ${range.start}-${range.end}/${item.size}` } : {})
      });
      if (!head) {
        let checking = false;
        timer = setInterval(() => {
          if (checking) return;
          checking = true;
          guard()
            .catch(() => res.destroy())
            .finally(() => {
              checking = false;
            });
        }, 750);
        for (let pos = range.start; pos <= range.end; ) {
          const buf = Buffer.allocUnsafe(Math.min(256 * 1024, range.end - pos + 1));
          const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
          if (!bytesRead) throw stale();
          await guard();
          await send(buf.subarray(0, bytesRead));
          pos += bytesRead;
        }
      }
    } else {
      const binding = downloads.sourceAuthorization();
      const stamp = contentHash([resourceId, version, binding]);
      common['X-Cangxia-Media-State'] = stamp;
      if (head && req.headers['x-cangxia-media-check'] === '1') {
        res.writeHead(204, common).end();
        return;
      }
      guard = () => {
        readCurrent();
        const auth = downloads.sourceAuthorization();
        if (
          binding.uid !== auth.uid ||
          binding.sessionKey !== auth.sessionKey ||
          binding.authEpoch !== auth.authEpoch
        )
          throw stale();
      };
      const target = sources(work).find((t) => t.key === key);
      const range = req.headers.range;
      if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw badRange();
      let lastStatus;
      async function fetchCandidates(candidate) {
        for (const url of candidate.candidates.slice(0, 5)) {
          const result = await downloads.fetchSourceMedia(
            url,
            { signal, method: head ? 'HEAD' : 'GET', headers: range ? { Range: range } : {} },
            guard
          );
          if (result.status === 416) return result;
          let selected = false;
          try {
            if (result.ok) {
              const mime = await sourceMime({
                result,
                item,
                range,
                head,
                proofs: proofCache(store),
                sourceIdentity: candidate.sourceIdentity,
                verifyOrigin: async () => {
                  let detail;
                  try {
                    detail = await downloads.readMediaDetail(workId, binding, signal);
                  } catch (e) {
                    if (signal.aborted || e.code === 'SOURCE_RATE_LIMITED') throw e;
                    return false;
                  }

                  guard();
                  if (detail?.id !== workId || detail.statusOnly || detail.remoteState === 'unavailable')
                    return false;
                  const attested = sources(detail).find((t) => t.key === key);
                  return (
                    typeof attested?.sourceIdentity === 'string' &&
                    !!attested.sourceIdentity &&
                    attested.candidates.some(
                      (address) => candidateDigest([address]) === candidateDigest([url])
                    )
                  );
                },
                fetchRange: (range) =>
                  downloads.fetchSourceMedia(url, { signal, headers: { Range: range } }, guard)
              });
              if (mime) {
                selected = true;
                result.mime = mime;
                return result;
              }
            }
            lastStatus = result.status;
          } finally {
            if (!selected) await result.body?.cancel().catch(() => {});
          }
        }
      }
      upstream = await fetchCandidates(target);
      if (!upstream && [403, 404, 410].includes(lastStatus)) {
        const refreshed = await downloads.readMediaDetail(workId, binding, signal);
        guard();
        const candidate = refreshed?.id === workId && sources(refreshed).find((t) => t.key === key);
        if (!candidate || sourceVersion(candidate) !== version) throw stale();
        upstream = await fetchCandidates(candidate);
      }
      if (!upstream) throw unavailable();
      if (upstream.status === 416) {
        res
          .writeHead(416, {
            ...common,
            'Content-Range': upstream.headers.get('content-range') || 'bytes */*'
          })
          .end();
        return;
      }
      const headers = { ...common, 'Content-Type': upstream.mime };
      for (const h of ['content-length', 'content-range', 'etag'])
        if (upstream.headers.has(h)) headers[h] = upstream.headers.get(h);
      if (upstream.status === 206) {
        const part = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range']);
        if (!range || !part) throw stale();
        const expected = parseRange(range, Number(part[3]));
        if (expected.start !== Number(part[1]) || expected.end !== Number(part[2])) throw stale();
      }
      guard();
      res.writeHead(upstream.status, headers);
      if (!head) {
        timer = setInterval(() => {
          try {
            guard();
          } catch {
            res.destroy();
          }
        }, 750);
        for await (const chunk of upstream.body) {
          guard();
          await send(chunk);
        }
      }
    }
    res.end();
  } finally {
    clearInterval(timer);
    res.off('close', close);
    cancel[Symbol.dispose]();
    await upstream?.body?.cancel().catch(() => {});
    await handle?.close();
  }
}
