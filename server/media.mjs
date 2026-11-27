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
  return work ? [...describe(db, work).values()] : [];
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
  const readCurrent = () => {
    signal.throwIfAborted();
    session.guard(store.db);
    const work = store.work(workId),
      item = work && describe(store.db, work).get(key);
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
      guard = () => {
        readCurrent();
        if (contentHash(binding) !== contentHash(downloads.sourceAuthorization())) throw stale();
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
          if (result.ok || result.status === 416) return result;
          lastStatus = result.status;
          await result.body?.cancel();
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
      let mime = (upstream.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if (!mimeTypes[item.kind].test(mime)) throw unavailable();
      const headers = { ...common, 'Content-Type': mime };
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
