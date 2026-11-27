import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { Readable } from 'node:stream';
import { pinnedMedia, mediaCheckAgent } from './server-client.mjs';
import { ServerMediaCache } from './server-media-cache.mjs';
import { FlatDownloadQueue } from './flat-downloads.mjs';
import { parseRange } from '../shared/media-range.mjs';

const ext = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/x-m4v': '.mp4'
};
const matchId = /^(\d{1,40}):(video|cover|cover-hd|image-\d+|audio|thumbnail)$/;
export function mediaURL(library, item) {
  return item
    ? 'app-media://resource/' +
        library +
        '/' +
        encodeURIComponent(item.resourceId) +
        '/' +
        encodeURIComponent(item.version)
    : undefined;
}
export function attachMedia(work, library) {
  if (!work) return work;
  const assets = work.media
    ?.filter((m) => m.key !== 'thumbnail' && m.key !== 'audio')
    .map((m) => ({
      ...m,
      exists: true,
      url: mediaURL(library, m),
      file:
        m.key === 'cover-hd'
          ? '高清封面'
          : m.key === 'cover'
            ? '视频封面'
            : m.key.startsWith('image-')
              ? '图片 ' + (Number(m.key.slice(6)) + 1)
              : '视频'
    }));
  return {
    ...work,
    serverMedia: true,
    serverCoverURL: mediaURL(library, work.mediaCover),
    ...(assets ? { localRecord: { assets, hdCover: work.hdCover } } : {})
  };
}
function guardedStream(stream, signal, validate, groupBytes = 0) {
  const reader = stream.getReader();
  let watch,
    lastDelivery = -Infinity,
    timer,
    closed = false;
  const dispose = () => {
    closed = true;
    clearInterval(timer);
    watch?.[Symbol.dispose]();
  };
  return new ReadableStream(
    {
      start(controller) {
        const revoke = () => {
          if (closed) return;
          dispose();
          controller.error(Error('媒体请求已停止。'));
          void reader.cancel().catch(() => {});
        };
        watch = addAbortListener(signal, revoke);
        if (validate) timer = setInterval(() => validate().catch(revoke), 750);
      },
      async pull(controller) {
        try {
          signal.throwIfAborted();
          const first = await reader.read();
          if (first.done) {
            dispose();
            controller.close();
            return;
          }
          const chunks = [first.value];
          let bytes = first.value.byteLength;
          while (Number.isFinite(lastDelivery) && bytes < groupBytes) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            chunks.push(next.value);
          }
          // The NAS may already have finished writing every byte to the transport.
          // Reauthorize at the last handoff before the consumer can see these bytes.
          await validate(performance.now() - lastDelivery >= 500);
          signal.throwIfAborted();
          if (closed) return;
          lastDelivery = performance.now();
          controller.enqueue(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, bytes));
        } catch (e) {
          if (!closed) {
            dispose();
            controller.error(e);
            await reader.cancel().catch(() => {});
          }
        }
      },
      async cancel() {
        dispose();
        await reader.cancel();
      }
    },
    { highWaterMark: 0 }
  );
}
export class ServerMedia {
  constructor({ client, profile, notify = () => {} }) {
    this.client = client;
    this.cache = new ServerMediaCache(profile);
    this.profile = profile;
    this.notify = notify;
    this.audio = null;
    this.intents = new Map();
    this.queue = this.newQueue();
  }
  newQueue() {
    return new FlatDownloadQueue({
      store: { root: this.profile, download: () => null },
      notify: this.notify,
      acquireAsset: (batch, job, target, signal) => this.exportAsset(batch, job, target, signal)
    });
  }
  reset() {
    this.release();
    this.intents.clear();
    const previous = this.queue;
    this.queue = this.newQueue();
    this.cleaning = Promise.allSettled([this.cleaning, previous.dispose()]);
    return this.cleaning;
  }
  release(id, token, requestId) {
    const a = this.audio;
    if (
      !a ||
      (id && (id !== a.id || (token && token !== a.token) || (requestId && a.requestId !== requestId)))
    )
      return;
    a.controller.abort();
    clearTimeout(a.timer);
    this.audio = null;
  }
  renew(id, token) {
    const a = this.audio;
    if (!a || a.id !== id || a.token !== token) throw Error('试听已结束。');
    clearTimeout(a.timer);
    a.timer = setTimeout(() => this.release(id, token), 90000);
    a.timer.unref();
  }
  async prepareAudio(id, requestId) {
    this.release();
    const token = randomUUID(),
      a = { id, token, requestId, controller: new AbortController() };
    this.audio = a;
    try {
      const work = await this.client.query('work-detail', { id }),
        item = work?.media.find((m) => m.key === 'audio');
      if (this.audio !== a || !item) throw Error('当前作品没有可试听的配乐。');
      this.renew(id, token);
      return {
        token,
        music: work.music,
        url: mediaURL(this.client.grant.libraryId, item) + '?audio=' + token
      };
    } catch (e) {
      this.release(id, token);
      throw e;
    }
  }
  async raw(item, { signal, range, head = false, guard = false, selectionRevision }) {
    const c = this.client,
      epoch = c.epoch;
    c.assert(epoch);
    let res;
    try {
      if (head && this.pool?.epoch !== epoch)
        this.pool = { epoch, agent: mediaCheckAgent(c.config, c.signal()) };
      res = await pinnedMedia(c.config, c.grant, item, {
        signal,
        range,
        head,
        guard,
        selectionRevision,
        checkAgent: head ? this.pool.agent : undefined
      });
      c.assert(epoch);
    } catch (e) {
      res?.destroy();
      if (!signal.aborted && epoch === c.epoch) c.lock('NAS 媒体连接中断。');
      throw e;
    }
    if ([401, 403, 426].includes(res.statusCode)) {
      res.destroy();
      c.lock('NAS 使用权未能确认。');
      throw Error('NAS 已锁定。');
    }
    return res;
  }
  async protocol(request, epoch) {
    const c = this.client;
    try {
      c.assert(epoch);
      const url = new URL(request.url),
        parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
      const [library, resourceId, version] = parts,
        match = matchId.exec(resourceId);
      if (
        !['GET', 'HEAD'].includes(request.method) ||
        url.hostname !== 'resource' ||
        parts.length !== 3 ||
        library !== c.grant.libraryId ||
        !match ||
        !/^(source|\d+)-[a-f0-9]{64}$/.test(version)
      )
        return new Response(null, { status: 404 });
      const audio = match[2] === 'audio' ? this.audio : null;
      if (
        match[2] === 'audio' &&
        (!audio || audio.id !== match[1] || audio.token !== url.searchParams.get('audio'))
      )
        return new Response(null, { status: 403 });
      const signal = AbortSignal.any([
        request.signal,
        c.signal(),
        ...(audio ? [audio.controller.signal] : [])
      ]);
      return await this.response(
        { resourceId, version },
        {
          library,
          signal,
          range: request.headers.get('range'),
          head: request.method === 'HEAD',
          scope: audio ? 'audio' : match[2] === 'video' ? null : 'cover'
        }
      );
    } catch (e) {
      return new Response(null, { status: e.status || 409 });
    }
  }
  async response(item, { library, signal, range, head, scope }) {
    const key = JSON.stringify([library, item.resourceId, item.version]);
    const present = scope && this.cache.get(key);
    let state;
    const probe = async (cacheEntry) => {
      const response = await this.raw(item, { signal, head: true, guard: !cacheEntry });
      try {
        const stamp = response.headers['x-cangxia-media-state'];
        if (cacheEntry) {
          if (
            response.statusCode !== 200 ||
            response.headers.etag !== cacheEntry.etag ||
            Number(response.headers['content-length']) !== cacheEntry.size
          )
            return false;
          state = stamp;
        } else if (item.version.startsWith('source-')) {
          if (response.statusCode !== 204 || !state || stamp !== state)
            throw Error('来源媒体或使用权已变化。');
        } else if (
          response.statusCode !== 200 ||
          response.headers.etag !== '"' + item.version.split('-')[1] + '"'
        )
          throw Error('媒体版本已更换。');
        return true;
      } finally {
        if (!response.complete) response.destroy();
      }
    };
    const epoch = this.client.epoch;
    let checking,
      checked = -Infinity;
    const validate = async (force = false) => {
      this.client.assert(epoch);
      signal.throwIfAborted();
      if (!force && !checking && performance.now() - checked < 500) return Promise.resolve();
      checking ??= probe()
        .then(() => {
          checked = performance.now();
        })
        .finally(() => {
          checking = null;
        });
      return checking;
    };
    if (present && (await probe(present))) {
      let slice;
      try {
        slice = parseRange(range, present.size);
      } catch {
        return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + present.size } });
      }
      const headers = {
        'content-type': present.mime,
        'content-length': String(slice.length),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        ...(slice.status === 206
          ? { 'content-range': `bytes ${slice.start}-${slice.end}/${present.size}` }
          : {})
      };
      const body = head
        ? null
        : guardedStream(
            this.cache.reader(key, slice, () => signal.throwIfAborted()),
            signal,
            validate
          );
      return new Response(body, { status: slice.status, headers });
    }
    const res = await this.raw(item, { signal, range, head }),
      headers = {};
    for (const h of [
      'content-type',
      'content-length',
      'content-range',
      'etag',
      'accept-ranges',
      'cache-control'
    ])
      if (res.headers[h]) headers[h] = res.headers[h];
    if (head || ![200, 206].includes(res.statusCode)) {
      res.destroy();
      return new Response(null, { status: res.statusCode, headers });
    }
    const size = Number(headers['content-length']),
      whole = res.statusCode === 200 || headers['content-range'] === `bytes 0-${size - 1}/${size}`;
    const capture = whole && this.cache.reservation(key, scope, size, headers.etag, headers['content-type']);
    state = res.headers['x-cangxia-media-state'];
    let body = Readable.toWeb(res, {
      strategy: { highWaterMark: 128 * 1024, size: (chunk) => chunk.byteLength }
    });
    if (capture) {
      res.once('close', () => {
        if (!res.complete) capture.close();
      });
      body = body.pipeThrough(
        new TransformStream({
          transform(chunk, ctl) {
            capture.append(chunk);
            ctl.enqueue(chunk);
          },
          flush() {
            capture.commit();
          },
          cancel() {
            capture.close();
          }
        }),
        { signal }
      );
    }
    return new Response(guardedStream(body, signal, validate, Number.isSafeInteger(size) ? 256 * 1024 : 0), {
      status: res.statusCode,
      headers
    });
  }
  prepare(directory, selection, includeCover) {
    if (!selection || !Number.isSafeInteger(selection.confirmedCount) || selection.confirmedCount < 1)
      throw Error('请重新选择作品。');
    if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(directory))
      throw Error('请选择 Windows 本机目录。');
    const target = this.queue.checkDirectory(directory),
      stat = fs.statSync(target, { bigint: true }),
      token = randomUUID();
    this.intents.clear();
    this.intents.set(token, { target, stat, selection, includeCover, until: Date.now() + 600000 });
    return {
      token,
      directory: target,
      count: selection.confirmedCount,
      nonempty: fs.readdirSync(target).length > 0
    };
  }
  async start(token, allow) {
    const intent = this.intents.get(token);
    if (!intent) throw Error('导出确认已过期。');
    if (!intent.starting)
      intent.starting = this.startIntent(token, allow).finally(() => {
        delete intent.starting;
      });
    return intent.starting;
  }
  async startIntent(token, allow) {
    const intent = this.intents.get(token),
      queue = this.queue,
      epoch = this.client.epoch;
    if (!intent || intent.until < Date.now()) throw Error('导出确认已过期。');
    const check = () => {
      this.client.assert(epoch);
      const dir = queue.checkDirectory(intent.target),
        now = fs.statSync(dir, { bigint: true });
      if (now.dev !== intent.stat.dev || now.ino !== intent.stat.ino) throw Error('导出目录已变化。');
    };
    check();
    if (!allow && fs.readdirSync(intent.target).length) return { needsConfirmation: true };
    const receipt = await this.client.command({
      kind: 'catalogue-action',
      operationId: randomUUID(),
      entityVersion: 0,
      payload: { action: 'flat-download', selection: intent.selection }
    });
    const works = [];
    while (works.length < receipt.count) {
      const page = await this.client.query('export-page', { token: receipt.token, offset: works.length });
      if (!page.length) throw Error('导出清单已变化。');
      for (const work of page) works.push({ ...work, exportRevision: receipt.revision });
    }
    check();
    const plan = queue.prepareWorks(intent.target, works, intent.includeCover),
      result = queue.start(plan.token, allow);
    if (!result.needsConfirmation) this.intents.delete(token);
    return result;
  }
  async exportAsset(batch, job, target, stop) {
    const item = job.work.media.find((r) => r.key === target.key);
    if (!item) throw Error('缺少所选媒体。');
    const signal = AbortSignal.any([stop, this.client.signal()]);
    let part = job.partial?.key === target.key ? job.partial : null;
    let res,
      handle,
      file,
      size = 0,
      digest = createHash('sha256'),
      etag,
      total,
      mime;
    try {
      this.queue.assertStage(batch);
      if (part) {
        try {
          handle = await fs.promises.open(part.file, 'r+');
          const now = await handle.stat({ bigint: true });
          if (
            now.dev !== part.stat.dev ||
            now.ino !== part.stat.ino ||
            now.size !== BigInt(part.size) ||
            now.ctimeNs !== part.stat.ctimeNs ||
            now.mtimeNs !== part.stat.mtimeNs ||
            now.nlink !== 1n
          )
            throw Error('导出片段已变化。');
          file = part.file;
          size = part.size;
          digest = part.digest;
        } catch {
          await handle?.close();
          handle = null;
          // A modified or substituted path belongs to the user until reconciled.
          batch.owned.delete(part.file);
          part = null;
        }
        delete job.partial;
      }
      res = await this.raw(item, {
        signal,
        range: part ? 'bytes=' + size + '-' : undefined,
        selectionRevision: job.work.exportRevision
      });
      if (res.statusCode === 412) {
        batch.stale = '导出清单已变化，请重新确认选择。';
        throw Error(batch.stale);
      }
      mime = res.headers['content-type'];
      etag = res.headers.etag;
      if (res.statusCode === 206) {
        if (
          !part ||
          mime !== part.mime ||
          etag !== part.etag ||
          res.headers['content-range'] !== `bytes ${size}-${part.total - 1}/${part.total}` ||
          Number(res.headers['content-length']) !== part.total - size
        )
          throw Error('导出片段版本已变化。');
        total = part.total;
      } else if (res.statusCode === 200) {
        if (handle) {
          await handle.close();
          handle = null;
          this.queue.removeOwned(batch, file);
          file = null;
        }
        const suffix = ext[mime];
        if (!suffix) throw Error('不支持此媒体格式。');
        this.queue.assertStage(batch);
        file = path.join(batch.stage, randomUUID() + suffix);
        handle = await fs.promises.open(file, 'wx+');
        batch.owned.set(file, await handle.stat({ bigint: true }));
        size = 0;
        digest = createHash('sha256');
        total = Number(res.headers['content-length']);
      } else throw Error('媒体已变化或暂不可读取。');
      for await (const chunk of res) {
        signal.throwIfAborted();
        for (let used = 0; used < chunk.length; ) {
          const { bytesWritten } = await handle.write(chunk, used, chunk.length - used, size + used);
          if (!bytesWritten) throw Error('写入未完成。');
          used += bytesWritten;
        }
        size += chunk.length;
        digest.update(chunk);
      }
      const sha256 = digest.copy().digest('hex');
      if (
        !size ||
        (Number.isSafeInteger(total) && total !== size) ||
        (item.saved && (size !== item.size || !item.version.endsWith('-' + sha256)))
      )
        throw Error('导出媒体校验未通过。');
      await handle.sync();
      signal.throwIfAborted();
      return { file, size, sha256, handle };
    } catch (e) {
      if (
        handle &&
        batch.paused &&
        !batch.canceled &&
        this.client.state().owned &&
        size > 0 &&
        size < total &&
        /^"[^"]+"$/.test(etag || '')
      ) {
        const stat = await handle.stat({ bigint: true });
        if (stat.size === BigInt(size))
          job.partial = { key: target.key, file, size, stat, digest, total, mime, etag };
      }
      await handle?.close();
      if (file && job.partial?.file !== file) this.queue.removeOwned(batch, file);
      throw e;
    } finally {
      res?.destroy();
    }
  }
}
