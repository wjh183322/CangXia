import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import { openLibrary } from '../../server/library.mjs';
import { createDownloads } from '../../server/downloads.mjs';
import { createSessionService } from '../../server/session.mjs';
import { createHttpsService } from '../../server/http.mjs';
import { parseRange } from '../../server/media.mjs';
import { ServerClient, pinnedMedia } from '../../electron/server-client.mjs';
import { ServerMedia, mediaURL } from '../../electron/server-media.mjs';

test('single inclusive byte ranges, suffixes and invalid starts', () => {
  assert.deepEqual(parseRange('bytes=10-19', 40), { status: 206, start: 10, end: 19, length: 10 });
  assert.equal(parseRange('bytes=-4', 40).start, 36);
  assert.throws(() => parseRange('bytes=40-', 40));
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
);
const mp4 = fs.readFileSync(new URL('./fixtures/media-preview.mp4', import.meta.url));
function wav(dataLength = 16000) {
  const bytes = Buffer.alloc(44 + dataLength);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
const music = wav(),
  base = 'https://p3.douyinpic.com/fixture/';
const keypair = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
  keySize: 2048,
  algorithm: 'sha256'
});
async function fixture(t, { audioBytes = music } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-media-'));
  const volume = path.join(root, 'volume'),
    profile = path.join(root, 'profile'),
    directory = path.join(root, 'export');
  for (const p of [volume, profile, directory]) fs.mkdirSync(p);
  const library = openLibrary({ root: volume, mode: 'init' }),
    source = {
      account: () => ({ uid: '42' }),
      recover: async () => null,
      readDownloadDetail: async ({ workId }) => ({
        id: workId,
        music: { id: '98', title: '新版合成配乐' },
        audioSourceHints: { workId, music: { id: '98' }, sources: [{ kind: 'work', urls: [base + 'audio'] }] }
      })
    };
  library.write((db) => {
    db.exec(
      "INSERT INTO source_account VALUES(1,'42','样本','fixture');INSERT INTO download_auth VALUES(1,'key')"
    );
    const author = { nickname: '样本', uid: '42' };
    const works = [
      {
        id: '41',
        name: '视频样本',
        type: 'video',
        author,
        videoUrls: [base + 'video'],
        coverUrls: [base + 'cover']
      },
      {
        id: '42',
        name: '图集样本',
        type: 'images',
        author,
        images: [0, 1].map((index) => ({ index, urls: [base + 'img' + index] })),
        music: { id: '77', title: '合成配乐' }
      },
      { id: '43', name: '未归档', type: 'images', author, images: [{ index: 0, urls: [base + 'remote'] }] }
    ];
    for (const [index, w] of works.entries()) {
      db.prepare('INSERT INTO works VALUES(?,?,?)').run(w.id, w.name, JSON.stringify(w));
      db.prepare("INSERT INTO source_members VALUES('total',?,?,0)").run(w.id, index);
    }
    db.prepare('INSERT INTO source_audio_hints VALUES(?,?)').run(
      '42',
      JSON.stringify({ music: { id: '77' }, sources: [{ kind: 'music', urls: [base + 'audio'] }] })
    );
  });
  let fullVerifications = 0,
    remote = null;
  const downloads = createDownloads({
    library,
    root: volume,
    source,
    fileHook: (name) => {
      if (name === 'beforeResourceVerify') fullVerifications++;
    },
    fetchAsset: async (url, options) => {
      assert.ok(url.startsWith(base));
      if (url === base + 'remote' && remote) return remote(options);
      const [body, mime] = url.endsWith('audio')
        ? [audioBytes, 'audio/wav']
        : url.endsWith('video')
          ? [mp4, 'video/mp4']
          : [png, 'image/png'];
      const { start, end, status, length } = parseRange(
        new Headers(options.headers).get('range'),
        body.length
      );
      return new Response(body.subarray(start, end + 1), {
        status,
        headers: {
          'content-type': mime,
          'content-length': String(length),
          etag: '"synthetic"',
          ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${body.length}` } : {})
        }
      });
    }
  });
  library.write((db) => downloads.enqueue(db, ['41', '42'], 'missing'));
  await downloads.run();
  assert.equal(
    downloads.store.resources('41').some((x) => x.key === 'video'),
    true
  );
  const sessions = createSessionService({ library, source, downloads });
  const tls = await keypair,
    credentials = { pc: { accountId: 'test', token: 's'.repeat(40) } };
  const server = createHttpsService({
    key: tls.private,
    cert: tls.cert,
    credentials,
    sessions,
    source,
    downloads
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = {
    url: 'https://127.0.0.1:' + server.address().port,
    deviceId: 'pc',
    token: credentials.pc.token,
    fingerprint: new X509Certificate(tls.cert).fingerprint256
  };
  const client = new ServerClient(),
    connect = async () => {
      await client.connect(config);
      await client.acquire();
    };
  const manager = new ServerMedia({ client, profile });
  const count = () =>
    library.read((db) => db.prepare('SELECT id,state FROM download_jobs ORDER BY id').all());
  t.after(async () => {
    client.lock();
    await manager.reset();
    manager.cache.db.close();
    sessions.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await downloads.close();
    library.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return {
    root,
    directory,
    config,
    library,
    downloads,
    manager,
    client,
    connect,
    count,
    full: () => fullVerifications,
    setRemote: (fn) => {
      remote = fn;
    }
  };
}
test('pinned ranges, cache versions, foreign files, release, and selection export through real handlers', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const { client: c, manager: m, downloads: d } = f,
    prior = f.count();
  const detail = (id) => c.query('work-detail', { id });
  let video = (await detail('41')).media.find((x) => x.key === 'video');
  const proto = (item, range, extra = {}) =>
    m.protocol(
      new Request(mediaURL(c.grant.libraryId, item), { ...extra, headers: range ? { Range: range } : {} }),
      c.epoch
    );
  const full = f.full(),
    seek = await proto(video, 'bytes=31-75');
  assert.equal(seek.status, 206);
  assert.equal(seek.headers.get('content-range'), 'bytes 31-75/' + mp4.length);
  assert.deepEqual(Buffer.from(await seek.arrayBuffer()), mp4.subarray(31, 76));
  assert.equal(f.full(), full);
  const image = (await detail('42')).media.find((x) => x.key === 'image-0');
  assert.deepEqual(Buffer.from(await (await proto(image)).arrayBuffer()), png);
  const oldkey = JSON.stringify([c.grant.libraryId, image.resourceId, image.version]);
  assert.ok(m.cache.get(oldkey));
  assert.equal((await proto(image, 'bytes=-3')).status, 206);
  f.library.write((db) =>
    db.prepare('UPDATE archive_assets SET revision=revision+1 WHERE id=?').run(image.resourceId)
  );
  const newImage = (await detail('42')).media.find((x) => x.key === 'image-0');
  assert.notEqual(image.version, newImage.version);
  assert.equal((await proto(image)).status, 409);
  assert.equal(
    m.cache.get(JSON.stringify([c.grant.libraryId, newImage.resourceId, newImage.version])),
    undefined
  );
  const album = (await detail('43')).media[0];
  assert.equal(album.saved, false);
  assert.deepEqual(Buffer.from(await (await proto(album)).arrayBuffer()), png);
  const list = await c.query('list-works', { source: 'total' }),
    selection = {
      source: 'total',
      scope: list.scope,
      revision: list.revision,
      all: true,
      ids: ['42'],
      confirmedCount: 2
    };
  fs.writeFileSync(path.join(f.directory, '0001_样本_41.mp4'), 'foreign');
  const plan = m.prepare(f.directory, selection, true);
  assert.equal((await m.start(plan.token, false)).needsConfirmation, true);
  const { id } = await m.start(plan.token, true);
  await m.queue.waitForIdle();
  const batch = m.queue.get(id);
  assert.deepEqual(
    batch.jobs.map((j) => [j.id, j.state]),
    [
      ['41', 'complete'],
      ['43', 'complete']
    ],
    JSON.stringify(m.queue.state())
  );
  assert.deepEqual(fs.readFileSync(path.join(f.directory, '0001_样本_41_2.mp4')), mp4);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, '0001_样本_41_封面.png')), png);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, '0002_样本_43_01.png')), png);
  assert.deepEqual(f.count(), prior);
  const row = d.store.resources('41').find((x) => x.key === 'video'),
    file = path.join(d.layout.media, row.relative_path);
  fs.renameSync(file, file + '.original');
  fs.writeFileSync(file, mp4);
  assert.equal((await proto(video)).status, 409);
  const controller = new AbortController();
  f.setRemote(
    ({ signal }) =>
      new Response(
        new ReadableStream({
          start(ctl) {
            ctl.enqueue(png);
            signal.addEventListener('abort', () => ctl.error(Error('revoked')), { once: true });
          }
        }),
        { headers: { 'content-type': 'image/png' } }
      )
  );
  const res = await pinnedMedia(c.config, c.grant, album, { signal: controller.signal });
  const first = once(res, 'data');
  res.resume();
  await first;
  const closed = once(res, 'close').catch(() => {});
  await c.release();
  await closed;
  assert.equal(res.destroyed, true);
  await f.connect();
  const again = await detail('43');
  assert.equal(again.id, '43');
  controller.abort();
});
test(
  'Windows original UI decodes protected MP4, PNG and WAV and exports the chosen selection',
  { skip: process.platform !== 'win32' || process.env.CANGXIA_DESKTOP_SESSION_TEST !== '1', timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      prior = f.count();
    fs.writeFileSync(path.join(f.root, 'connection.json'), JSON.stringify(f.config));
    const { default: electron } = await import('electron'),
      env = { ...process.env, CANGXIA_MEDIA_FIXTURE: f.root };
    delete env.ELECTRON_RUN_AS_NODE;
    const ui = spawn(electron, [fileURLToPath(new URL('./media-desktop.mjs', import.meta.url))], {
      windowsHide: true,
      env
    });
    t.after(() => ui.kill());
    let output = '';
    for (const s of [ui.stdout, ui.stderr]) s.on('data', (b) => (output += b));
    const [code] = await once(ui, 'exit');
    assert.equal(code, 0, output);
    assert.match(output, /MEDIA_DESKTOP_VERIFIED/);
    assert.deepEqual(
      f.count().filter((r) => !r.id.startsWith('audio:')),
      prior
    );
    assert.ok(f.downloads.store.resources('42').some((r) => r.key === 'audio'));
  }
);
test('a paused or cancelled flat transfer releases its input and leaves independently created files alone', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const { client, manager } = f;
  const report = await client.query('list-works', { source: 'total' });
  const selection = {
    source: 'total',
    scope: report.scope,
    revision: report.revision,
    all: false,
    ids: ['43'],
    confirmedCount: 1
  };
  const prior = f.count();
  const enter = () => {
    let seen;
    const waiting = new Promise((r) => (seen = r));
    f.setRemote(
      ({ signal }) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(png.subarray(0, 10));
              seen();
              signal.addEventListener('abort', () => controller.error(Error('stopped')), { once: true });
            }
          }),
          { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } }
        )
    );
    return waiting;
  };
  const waiting = enter();
  const id = (await manager.start(manager.prepare(f.directory, selection, false).token, true)).id;
  await waiting;
  const batch = manager.queue.get(id);
  fs.writeFileSync(path.join(batch.stage, 'user-note'), 'keep');
  manager.queue.pause(id);
  await manager.queue.waitForIdle();
  assert.equal(batch.jobs[0].state, 'waiting');
  f.setRemote(() => new Response(null, { status: 404 }));
  manager.queue.resume(id);
  await manager.queue.waitForIdle();
  assert.equal(batch.jobs[0].state, 'failed');
  const again = enter();
  manager.queue.retry(id);
  await again;
  await manager.queue.cancel(id);
  assert.equal(batch.jobs[0].state, 'canceled');
  assert.deepEqual(fs.readdirSync(batch.stage), ['user-note']);
  await manager.queue.clear(id);
  assert.equal(manager.queue.state().batches.length, 0);
  assert.deepEqual(f.count(), prior);
});
test('replacing the music identity preserves the old archive and previews the new work audio candidate', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const { client: c, manager: m } = f,
    call = (kind, payload) => c.command({ kind, payload, entityVersion: 0, operationId: randomUUID() });
  await call('enqueue-download', { workIds: ['42'], selection: 'audio' });
  await f.downloads.run();
  assert.equal((await c.query('work-detail', { id: '42' })).media.find((a) => a.key === 'audio').saved, true);
  let prepared = await m.prepareAudio('42', randomUUID());
  const first = prepared.url;
  assert.deepEqual(Buffer.from(await (await m.protocol(new Request(first), c.epoch)).arrayBuffer()), music);
  m.release('42', prepared.token);
  assert.equal((await m.protocol(new Request(first), c.epoch)).status, 403);
  await c.call('media/refresh-audio', { id: '42' });
  const detail = await c.query('work-detail', { id: '42' }),
    audio = detail.media.find((a) => a.key === 'audio');
  assert.equal(detail.music.id, '98');
  assert.equal(detail.images.length, 2);
  assert.equal(audio.saved, false);
  assert.equal(audio.versionMismatch, true);
  assert.equal(f.downloads.store.resources('42').filter((a) => a.key === 'audio').length, 1);
  prepared = await m.prepareAudio('42', randomUUID());
  const response = await m.protocol(new Request(prepared.url), c.epoch);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), music);
});
test('cache eviction counts current reservations and keeps pinned bytes until release', async (t) => {
  const f = await fixture(t),
    cache = f.manager.cache,
    unit = 1048576;
  cache.setLimits({ cover: 16 * unit, audio: 16 * unit });
  const fill = (key) => {
    const write = cache.reservation(key, 'cover', 9 * unit, '"etag"', 'image/png');
    assert.ok(write);
    write.append(Buffer.alloc(9 * unit));
    write.commit();
  };
  fill('first');
  const reader = cache.reader('first', { start: 0, end: 9 * unit - 1 }, async () => {}).getReader();
  fill('second');
  assert.ok(cache.get('first'));
  assert.equal(cache.get('second'), undefined);
  await reader.cancel();
  fill('second');
  assert.equal(cache.get('first'), undefined);
  assert.ok(cache.get('second'));
  assert.equal(cache.summary().used.stage, 0);
  cache.clear(['cover']);
  assert.equal(cache.summary().used.cover, 0);
});
test('a live registered stream aborts on revision change and historical SHA proof is reused across seeks', async (t) => {
  const f = await fixture(t, { audioBytes: wav(16 * 1048576) });
  await f.connect();
  const { client: c, downloads: d } = f;
  await c.command({
    kind: 'enqueue-download',
    entityVersion: 0,
    operationId: randomUUID(),
    payload: { workIds: ['42'], selection: 'audio' }
  });
  await d.run();
  const id = '42:audio';
  f.library.write((db) =>
    db
      .prepare("UPDATE file_commits SET body=json_remove(body,'$.registeredChangeNs') WHERE resource_id=?")
      .run(id)
  );
  const detail = await c.query('work-detail', { id: '42' }),
    audio = detail.media.find((m) => m.key === 'audio');
  const before = f.full();
  const get = (range) => pinnedMedia(c.config, c.grant, audio, { range, signal: c.signal() });
  for (const range of ['bytes=40-55', 'bytes=15000-15050']) {
    const res = await get(range);
    assert.equal(res.statusCode, 206);
    for await (const chunk of res) assert.ok(chunk.length);
  }
  assert.equal(f.full() - before, 1);
  const stream = await get();
  stream.pause();
  f.library.write((db) => db.prepare('UPDATE archive_assets SET revision=revision+1 WHERE id=?').run(id));
  let read = 0;
  await assert.rejects(async () => {
    for await (const chunk of stream) read += chunk.length;
  });
  assert.ok(stream.destroyed);
  assert.ok(read < audio.size);
  const denied = await get('bytes=1-3');
  assert.equal(denied.statusCode, 409);
  denied.resume();
});
test('resume exports the rest of the exact representation using a nonzero pinned HTTPS Range', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const { client, manager } = f,
    report = await client.query('list-works', { source: 'total' });
  const selection = {
    source: 'total',
    scope: report.scope,
    revision: report.revision,
    all: false,
    ids: ['43'],
    confirmedCount: 1
  };
  const ranges = [];
  f.setRemote(({ signal, headers }) => {
    const range = new Headers(headers).get('range');
    ranges.push(range);
    if (!range)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(png.subarray(0, 20));
            signal.addEventListener('abort', () => controller.error(Error('paused')), { once: true });
          }
        }),
        { headers: { 'content-type': 'image/png', 'content-length': String(png.length), etag: '"original"' } }
      );
    assert.equal(range, 'bytes=20-');
    return new Response(png.subarray(20), {
      status: 206,
      headers: {
        'content-type': 'image/png',
        'content-length': String(png.length - 20),
        'content-range': `bytes 20-${png.length - 1}/${png.length}`,
        etag: '"original"'
      }
    });
  });
  const { id } = await manager.start(manager.prepare(f.directory, selection, false).token, true);
  const batch = manager.queue.get(id),
    deadline = Date.now() + 5000;
  while (![...batch.owned.keys()].some((file) => fs.statSync(file).size === 20)) {
    assert.ok(Date.now() < deadline, 'first 20 bytes must reach the Windows stage');
    await new Promise((r) => setTimeout(r, 15));
  }
  manager.queue.pause(id);
  await manager.queue.waitForIdle();
  assert.equal(batch.jobs[0].partial?.size, 20);
  manager.queue.resume(id);
  await manager.queue.waitForIdle();
  assert.deepEqual(ranges, [null, 'bytes=20-']);
  assert.equal(batch.jobs[0].state, 'complete', JSON.stringify(manager.queue.state()));
  assert.deepEqual(fs.readFileSync(path.join(f.directory, '0001_样本_43_01.png')), png);
});
test('an unread cached response revokes on change and a different library cannot reuse its entry', async (t) => {
  const a = await fixture(t),
    b = await fixture(t);
  await a.connect();
  const { client, manager } = a;
  const image = async () =>
    (await client.query('work-detail', { id: '42' })).media.find((x) => x.key === 'image-0');
  const item = await image(),
    old = mediaURL(client.grant.libraryId, item),
    epoch = client.epoch;
  await (await manager.protocol(new Request(old), epoch)).arrayBuffer();
  const cached = await manager.protocol(new Request(old), epoch),
    reader = cached.body.getReader();
  a.library.write((db) =>
    db.prepare('UPDATE archive_assets SET revision=revision+1 WHERE id=?').run(item.resourceId)
  );
  await assert.rejects(reader.closed);
  await client.release();
  await client.connect({ ...b.config, libraryId: null });
  await client.acquire();
  const other = await image();
  assert.equal(
    manager.cache.get(JSON.stringify([client.grant.libraryId, other.resourceId, other.version])),
    undefined
  );
  assert.equal((await manager.protocol(new Request(old), epoch)).status, 403);
  assert.deepEqual(
    Buffer.from(
      await (
        await manager.protocol(new Request(mediaURL(client.grant.libraryId, other)), client.epoch)
      ).arrayBuffer()
    ),
    png
  );
});
