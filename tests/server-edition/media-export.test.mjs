import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
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
async function fixture(t, { audioBytes = music, readDetail, removalHook } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-media-'));
  const volume = path.join(root, 'volume'),
    profile = path.join(root, 'profile'),
    directory = path.join(root, 'export');
  for (const p of [volume, profile, directory]) fs.mkdirSync(p);
  const library = openLibrary({ root: volume, mode: 'init' }),
    source = {
      account: () => ({ uid: '42' }),
      recover: async () => null,
      readDownloadDetail:
        readDetail ??
        (async ({ workId }) => ({
          id: workId,
          music: { id: '98', title: '新版合成配乐' },
          audioSourceHints: {
            workId,
            music: { id: '98' },
            sources: [{ kind: 'work', urls: [base + 'audio'] }]
          }
        }))
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
    fileHook: (name,info) => {
      removalHook?.(name,info);
      if (name === 'beforeResourceVerify') fullVerifications++;
    },
    fetchAsset: async (url, options) => {
      assert.ok(url.startsWith(base));
      if (url.startsWith(base + 'remote') && remote) return remote(options, url);
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
  const bin=path.join(root,'native-bin');if(removalHook)fs.mkdirSync(bin);
  const sessions = createSessionService({ library, source, downloads,removalFiles:removalHook?{...downloads,bin}:undefined });
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
    directory,bin,
    server,
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
    assert.equal(f.library.read(db=>db.prepare("SELECT count(*) n FROM command_receipts WHERE json_extract(result,'$.kind')='cover-display' AND json_extract(result,'$.workId')='41'").get().n),2,'one synthetic failure and one actual recovery');
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
test('unconsumed cache misses cannot release buffered bytes after the pinned NAS response finishes and its version changes', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const { client, manager } = f;
  for (const mode of ['whole', 'range', 'lease', 'foreign']) {
    const item = (await client.query('work-detail', { id: '41' })).media.find((m) => m.key === 'video');
    const finished = new Promise((resolve) =>
      f.server.once('request', (req, res) => {
        assert.equal(req.method, 'GET');
        res.once('finish', resolve);
      })
    );
    const response = await manager.protocol(
      new Request(mediaURL(client.grant.libraryId, item), {
        headers: mode === 'range' ? { range: 'bytes=30-74' } : {}
      }),
      client.epoch
    );
    assert.equal(response.status, mode === 'range' ? 206 : 200);
    await finished;
    const row = f.downloads.store.resources('41').find((a) => a.key === 'video');
    const file = path.join(f.downloads.layout.media, row.relative_path);
    if (mode === 'foreign') {
      fs.renameSync(file, file + '.held');
      fs.writeFileSync(file, mp4);
    } else if (mode === 'lease') await client.release();
    else
      f.library.write((db) =>
        db.prepare('UPDATE archive_assets SET revision=revision+1 WHERE id=?').run(item.resourceId)
      );
    try {
      await assert.rejects(response.body.getReader().read());
    } finally {
      if (mode === 'lease') await f.connect();
      if (mode === 'foreign') {
        fs.unlinkSync(file);
        fs.renameSync(file + '.held', file);
      }
    }
  }
});
test('export pages check confirmed versions before the first and after the 64th manifest', async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.library.write((db) => {
    for (let i = 0; i < 64; i++) {
      const id = String(100 + i);
      db.prepare('INSERT INTO works VALUES(?,?,?)').run(
        id,
        'fixture ' + id,
        JSON.stringify({ type: 'images', author: { uid: '42', nickname: '样本' }, images: [] })
      );
      db.prepare("INSERT INTO source_members VALUES('total',?,?,0)").run(id, 3 + i);
    }
  });
  async function confirm() {
    const list = await f.client.query('list-works', { source: 'total' });
    return f.client.command({
      kind: 'catalogue-action',
      entityVersion: 0,
      operationId: randomUUID(),
      payload: {
        action: 'flat-download',
        selection: {
          source: 'total',
          scope: list.scope,
          revision: list.revision,
          all: true,
          ids: [],
          confirmedCount: list.total
        }
      }
    });
  }
  const get = (r, offset) => f.client.query('export-page', { token: r.token, offset });
  let receipt = await confirm();
  assert.equal(receipt.count, 67);
  f.library.write((db) => db.prepare("UPDATE works SET title='updated' WHERE id='163'").run());
  await assert.rejects(get(receipt, 0), /重新确认/);
  receipt = await confirm();
  assert.equal((await get(receipt, 0)).length, 64);
  f.library.write((db) => db.exec("INSERT INTO work_tags VALUES('41','fresh')"));
  await assert.rejects(get(receipt, 64), /重新确认/);
  receipt = await confirm();
  f.library.write((db) => db.exec("UPDATE archive_assets SET revision=revision+1 WHERE id='41:video'"));
  await assert.rejects(get(receipt, 0), /重新确认/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});
test('album detail and flat export retain numeric order when earlier pictures are registered only', async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.library.write((db) =>
    db.prepare("UPDATE works SET body=json_set(body,'$.images',json(?)) WHERE id='42'").run(
      JSON.stringify([
        { index: 2, urls: [base + 'img2'] },
        { index: 1, urls: [base + 'img1'] }
      ])
    )
  );
  const detail = await f.client.query('work-detail', { id: '42' });
  assert.deepEqual(
    detail.media.filter((a) => a.key.startsWith('image-')).map((a) => a.key),
    ['image-0', 'image-1', 'image-2']
  );
  const list = await f.client.query('list-works', { source: 'total' });
  const selection = {
    source: 'total',
    scope: list.scope,
    revision: list.revision,
    all: false,
    ids: ['42'],
    confirmedCount: 1
  };
  const { id } = await f.manager.start(f.manager.prepare(f.directory, selection, false).token, true);
  await f.manager.queue.waitForIdle();
  const job = f.manager.queue.get(id).jobs[0];
  assert.equal(job.state, 'complete', job.message);
  assert.deepEqual(
    job.targets.map((t) => t.key),
    ['image-0', 'image-1', 'image-2']
  );
  assert.deepEqual(
    [...job.results.values()].map((r) => path.basename(r.file)),
    ['0001_样本_42_01.png', '0001_样本_42_02.png', '0001_样本_42_03.png']
  );
});
test('lowered cache budget is enforced on final reader release without another cache request', async (t) => {
  const f = await fixture(t),
    cache = f.manager.cache,
    unit = 1048576;
  const pin = (key) => {
    const w = cache.reservation(key, 'cover', 9 * unit, '"etag"', 'image/png');
    w.append(Buffer.alloc(9 * unit));
    w.commit();
    return cache.reader(key, { start: 0, end: 9 * unit - 1 }, async () => {}).getReader();
  };
  const first = pin('a'),
    second = pin('b');
  cache.setLimits({ audio: 16 * unit, cover: 16 * unit });
  assert.equal(cache.summary().used.cover, 18 * unit);
  await first.cancel();
  assert.equal(cache.summary().used.cover, 9 * unit);
  await second.cancel();
});
async function contents(res) {
  const chunks = [];
  for await (const b of res) chunks.push(b);
  return Buffer.concat(chunks);
}
test('octet-stream WAV and MP4 use checked signatures, fallback candidates and a bounded independent seek prefix', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const visits = [];
  f.library.write((db) => {
    db.prepare("UPDATE works SET body=? WHERE id='43'").run(
      JSON.stringify({
        type: 'video',
        author: { uid: '42' },
        videoUrls: [base + 'remote-vbad', base + 'remote-vgood']
      })
    );
    db.prepare('UPDATE source_audio_hints SET body=? WHERE work_id=?').run(
      JSON.stringify({
        music: { id: '77' },
        sources: [{ kind: 'music', urls: [base + 'remote-abad', base + 'remote-agood'] }]
      }),
      '42'
    );
  });
  f.setRemote(({ headers }, url) => {
    const range = new Headers(headers).get('range');
    visits.push([url.slice(base.length), range]);
    const buf = url.endsWith('bad')
      ? Buffer.from('<html>missing media</html>')
      : url.includes('-v')
        ? mp4
        : music;
    if (url.endsWith('bad'))
      return new Response(buf, { headers: { 'content-type': 'application/octet-stream' } });
    const part = parseRange(range, buf.length);
    return new Response(buf.subarray(part.start, part.end + 1), {
      status: part.status,
      headers: {
        etag: '"asset"',
        'content-type': 'application/octet-stream',
        'content-length': String(part.length),
        ...(part.status === 206 ? { 'content-range': `bytes ${part.start}-${part.end}/${buf.length}` } : {})
      }
    });
  });
  for (const [id, key, bytes, mime] of [
    ['43', 'video', mp4, 'video/mp4'],
    ['42', 'audio', music, 'audio/wav']
  ]) {
    const work = await f.client.query('work-detail', { id }),
      item = work.media.find((m) => m.key === key);
    let res = await pinnedMedia(f.client.config, f.client.grant, item, {
      range: 'bytes=100-110',
      signal: f.client.signal()
    });
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-type'], mime);
    assert.deepEqual(await contents(res), bytes.subarray(100, 111));
    res = await pinnedMedia(f.client.config, f.client.grant, item, { signal: f.client.signal() });
    assert.deepEqual(await contents(res), bytes);
  }
  assert.ok(visits.some(([url, range]) => url === 'remote-vgood' && range === 'bytes=0-127'));
  assert.ok(visits.some(([url, range]) => url === 'remote-agood' && range === 'bytes=0-127'));
  f.setRemote(() => new Response('<html>wrong</html>', { headers: { 'content-type': 'video/mp4' } }));
  const item = (await f.client.query('work-detail', { id: '43' })).media.find((m) => m.key === 'video');
  const denied = await pinnedMedia(f.client.config, f.client.grant, item, { signal: f.client.signal() });
  assert.equal(denied.statusCode, 404);
  denied.resume();
});
test('many remote chunks share a parsed work until a committed source identity change interrupts the live stream', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const setHints = (name) =>
    f.library.write((db) =>
      db
        .prepare('UPDATE source_audio_hints SET body=? WHERE work_id=?')
        .run(JSON.stringify({ music: { id: '77' }, sources: [{ kind: 'music', urls: [base + name] }] }), '42')
    );
  setHints('remote-stream');
  let lookups = 0,
    iterations = 0;
  const original = f.downloads.store.work;
  f.downloads.store.work = (id) => {
    lookups++;
    return original(id);
  };
  const bytes = wav(512 * 1024);
  f.setRemote(({ signal }) => {
    let pos = 0;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 2));
          if (signal.aborted) return controller.error(Error('aborted'));
          if (pos === bytes.length) return controller.close();
          const end = Math.min(pos + 1024, bytes.length);
          controller.enqueue(bytes.subarray(pos, end));
          pos = end;
          iterations++;
          if (iterations === 35) setHints('different');
        }
      }),
      { headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.length) } }
    );
  });
  const item = (await f.client.query('work-detail', { id: '42' })).media.find((m) => m.key === 'audio');
  const response = await pinnedMedia(f.client.config, f.client.grant, item, { signal: f.client.signal() });
  assert.equal(response.statusCode, 200);
  await assert.rejects(contents(response));
  assert.ok(iterations >= 35);
  assert.ok(lookups <= 3, `expected reuse across ${iterations} chunks, observed ${lookups} decoded works`);
});
test('generic ISO audio and untagged or weakly tagged byte seeks retain the real track and reject conflicting evidence', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const bytes = fs.readFileSync(new URL('./fixtures/generic-audio.m4a', import.meta.url));
  assert.equal(bytes.toString('ascii', 8, 12), 'isom');
  f.library.write((db) =>
    db.prepare('UPDATE source_audio_hints SET body=? WHERE work_id=?').run(
      JSON.stringify({
        music: { id: '77' },
        sources: [{ kind: 'music', urls: [base + 'remote-iso'] }]
      }),
      '42'
    )
  );
  const item = (await f.client.query('work-detail', { id: '42' })).media.find((m) => m.key === 'audio');
  let buffer = bytes,
    mime = 'audio/mp4',
    tag = null,
    conflict = false;
  f.setRemote(({ headers }) => {
    const range = new Headers(headers).get('range'),
      r = parseRange(range, buffer.length);
    return new Response(buffer.subarray(r.start, r.end + 1), {
      status: r.status,
      headers: {
        'content-type': mime,
        'content-length': String(r.length),
        ...(tag ? { etag: conflict && r.start === 0 ? 'W/"different"' : tag } : {}),
        ...(r.status === 206 ? { 'content-range': `bytes ${r.start}-${r.end}/${buffer.length}` } : {})
      }
    });
  });
  const get = (range) =>
    pinnedMedia(f.client.config, f.client.grant, item, { range, signal: f.client.signal() });
  let res = await get();
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'audio/mp4');
  assert.deepEqual(await contents(res), bytes);
  mime = 'application/octet-stream';
  for (tag of [null, 'W/"track"', '"track"']) {
    res = await get('bytes=400-464');
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-type'], 'audio/mp4');
    assert.deepEqual(await contents(res), bytes.subarray(400, 465));
  }
  tag = null;
  res = await get('bytes=0-127');
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-type'], 'audio/mp4');
  assert.deepEqual(await contents(res), bytes.subarray(0, 128));
  tag = 'W/"track"';
  conflict = true;
  res = await get('bytes=400-464');
  assert.equal(res.statusCode, 404);
  res.resume();
  conflict = false;
  mime = 'audio/mp4';
  tag = null;
  buffer = mp4;
  res = await get();
  assert.equal(res.statusCode, 404);
  res.resume();
  buffer = Buffer.from('<html>invalid</html>');
  res = await get();
  assert.equal(res.statusCode, 404);
  res.resume();
});
test('large select-all confirmation leaves descriptor reads to bounded pages and allows heartbeat within the command budget', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const add = 5000;
  f.library.write((db) => {
    const put = db.prepare('INSERT INTO works VALUES(?,?,?)'),
      member = db.prepare("INSERT INTO source_members VALUES('total',?,?,0)");
    const work = JSON.stringify({
      type: 'images',
      author: { uid: '42', nickname: '样本' },
      images: Array.from({ length: 18 }, (_, index) => ({ index, urls: [base + 'image' + index] }))
    });
    for (let i = 0; i < add; i++) {
      const id = String(1000 + i);
      put.run(id, '图集' + id, work);
      member.run(id, i + 3);
    }
  });
  const list = await f.client.query('list-works', { source: 'total' }),
    start = performance.now();
  const [receipt] = await Promise.all([
    f.client.command({
      kind: 'catalogue-action',
      entityVersion: 0,
      operationId: randomUUID(),
      payload: {
        action: 'flat-download',
        selection: {
          source: 'total',
          scope: list.scope,
          revision: list.revision,
          all: true,
          ids: ['43'],
          confirmedCount: list.total - 1
        }
      }
    }),
    f.client.renew()
  ]);
  const elapsed = Math.round(performance.now() - start);
  assert.ok(elapsed < 4500, `command and renewal took ${elapsed} ms`);
  t.diagnostic(`${receipt.count} works confirmed plus concurrent renewal in ${elapsed} ms`);
  const page = await f.client.query('export-page', { token: receipt.token, offset: 64 });
  assert.equal(page.length, 64);
  assert.equal(page[0].id, '1062');
  assert.equal(page.at(-1).id, '1125');
  f.library.write((db) => db.exec("UPDATE archive_assets SET revision=revision+1 WHERE id='41:video'"));
  await assert.rejects(f.client.query('export-page', { token: receipt.token, offset: 128 }), /重新确认/);
});
test('after a pause a changed export scope stops the remaining batch and retains already published files', async (t) => {
  const f = await fixture(t);
  await f.connect();
  let started;
  const entered = new Promise((r) => (started = r));
  f.setRemote(
    ({ signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(png.subarray(0, 20));
            started();
            signal.addEventListener('abort', () => controller.error(Error('paused')), { once: true });
          }
        }),
        { headers: { 'content-type': 'image/png', 'content-length': String(png.length), etag: '"prefix"' } }
      )
  );
  const list = await f.client.query('list-works', { source: 'total' }),
    selection = {
      source: 'total',
      scope: list.scope,
      revision: list.revision,
      all: false,
      ids: ['41', '43'],
      confirmedCount: 2
    };
  const { id } = await f.manager.start(f.manager.prepare(f.directory, selection, false).token, true);
  await entered;
  const batch = f.manager.queue.get(id);
  f.manager.queue.pause(id);
  await f.manager.queue.waitForIdle();
  assert.equal(batch.jobs[0].state, 'complete');
  f.library.write((db) => db.exec("INSERT INTO work_tags VALUES('43','changed')"));
  f.manager.queue.resume(id);
  await f.manager.queue.waitForIdle();
  assert.match(batch.stale, /重新确认/);
  assert.equal(batch.jobs[1].state, 'failed');
  assert.throws(() => f.manager.queue.retry(id), /重新确认/);
  assert.equal(fs.readdirSync(f.directory).filter((n) => n.endsWith('.mp4') || n.endsWith('.png')).length, 1);
});
test('large cached, streamed and unknown-length playback bounds authorization checks by elapsed time and reuses pinned TLS', async (t) => {
  const bytes = wav(8 * 1048576),
    f = await fixture(t, { audioBytes: bytes });
  await f.connect();
  await f.client.command({
    kind: 'enqueue-download',
    entityVersion: 0,
    operationId: randomUUID(),
    payload: { workIds: ['42'], selection: 'audio' }
  });
  await f.downloads.run();
  const sockets = new Set();
  let checks = 0;
  f.server.on('request', (req) => {
    if (req.headers['x-cangxia-media-check']) {
      checks++;
      sockets.add(req.socket);
    }
  });
  async function measure(url, name, pause) {
    const initial = checks,
      start = performance.now(),
      res = await f.manager.protocol(new Request(url), f.client.epoch);
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    let size = 0,
      chunks = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      chunks++;
      if (pause && chunks === 1) await new Promise((r) => setTimeout(r, 850));
    }
    assert.equal(size, bytes.length);
    const count = checks - initial,
      duration = performance.now() - start;
    assert.ok(count <= Math.ceil(duration / 500) + 3, `${name}: ${chunks} chunks required ${count} checks`);
    assert.ok(chunks > count);
    t.diagnostic(
      `${name}: ${chunks} renderer blocks, ${count} authorization requests in ${Math.round(duration)} ms`
    );
  }
  const prepared = await f.manager.prepareAudio('42', randomUUID());
  await measure(prepared.url, 'NAS archive', true);
  await measure(prepared.url, 'Windows cache', true);
  assert.equal(sockets.size, 1, 'archive and cache playback reuse the same pinned check socket');
  const paused = (await f.manager.protocol(new Request(prepared.url), f.client.epoch)).body.getReader();
  await paused.read();
  await new Promise((r) => setTimeout(r, 850));
  f.library.write((db) => db.exec("UPDATE archive_assets SET revision=revision+1 WHERE id='42:audio'"));
  await assert.rejects(
    paused.read(),
    'a resumed buffered reader must revalidate even just after the idle monitor checked'
  );

  f.library.write((db) => {
    db.prepare("UPDATE works SET body=json_set(body,'$.music.id','88') WHERE id='42'").run();
    db.prepare('UPDATE source_audio_hints SET body=? WHERE work_id=?').run(
      JSON.stringify({
        music: { id: '88' },
        sources: [{ kind: 'music', urls: [base + 'remote-no-length'] }]
      }),
      '42'
    );
  });
  f.setRemote(() => {
    let pos = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (pos === bytes.length) return controller.close();
          const end = Math.min(bytes.length, pos + 8192);
          controller.enqueue(bytes.subarray(pos, end));
          pos = end;
        }
      }),
      { headers: { 'content-type': 'audio/wav' } }
    );
  });
  const remote = await f.manager.prepareAudio('42', randomUUID());
  // Revoking the preceding reader can retire its in-flight socket. Measure reuse on the next reader independently.
  sockets.clear();
  await measure(remote.url, 'unknown-length source', true);
  assert.equal(sockets.size, 1, 'unknown-length playback reuses its pinned TLS check socket');
});
test('an anonymous untagged octet-stream short seek derives the type and returned bytes from one bounded reply', async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.library.write((db) =>
    db
      .prepare("UPDATE works SET body=? WHERE id='43'")
      .run(JSON.stringify({ type: 'video', author: { uid: '42' }, videoUrls: [base + 'remote-anonymous'] }))
  );
  const ranges = [];
  f.setRemote(({ headers }) => {
    const range = new Headers(headers).get('range');
    ranges.push(range);
    const part = parseRange(range, mp4.length);
    return new Response(part.start ? Buffer.alloc(part.length, 0) : mp4.subarray(part.start, part.end + 1), {
      status: 206,
      headers: {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${part.start}-${part.end}/${mp4.length}`,
        'content-length': String(part.length)
      }
    });
  });
  const item = (await f.client.query('work-detail', { id: '43' })).media.find((m) => m.key === 'video');
  const res = await pinnedMedia(f.client.config, f.client.grant, item, {
    range: 'bytes=400-464',
    signal: f.client.signal()
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.deepEqual(await contents(res), mp4.subarray(400, 465));
  assert.deepEqual(ranges, ['bytes=400-464', 'bytes=0-' + (mp4.length - 1)]);
});
function fragmentedMovie() {
  const seed = fs.readFileSync(new URL('./fixtures/synthetic-fragment.mp4', import.meta.url));
  const start = seed.indexOf('moof') - 4,
    end = seed.indexOf('mfra') - 4;
  const fragment = seed.subarray(start, end),
    sequence = fragment.indexOf('mfhd') + 8,
    time = fragment.indexOf('tfdt') + 8;
  const pieces = [seed.subarray(0, start)];
  for (let i = 0; i < 600; i++) {
    const copy = Buffer.from(fragment);
    copy.writeUInt32BE(i + 1, sequence);
    copy.writeBigUInt64BE(BigInt(125 * i), time);
    pieces.push(copy);
  }
  return Buffer.concat(pieces);
}
function originRange(bytes, range, type = 'application/octet-stream') {
  const part = parseRange(range, bytes.length);
  return new Response(bytes.subarray(part.start, part.end + 1), {
    status: part.status,
    headers: {
      'content-type': type,
      'content-length': String(part.length),
      ...(part.status === 206 ? { 'content-range': `bytes ${part.start}-${part.end}/${bytes.length}` } : {})
    }
  });
}
function multipartBytes(bytes, start, boundary, reportedStart = start) {
  const total = bytes.length;
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Range: bytes 0-8191/${total}\r\n\r\n`),
    bytes.subarray(0, 8192),
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${reportedStart}-${total - 1}/${total}\r\n\r\n`
    ),
    bytes.subarray(start),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}
async function unarchivedVideo(f, paths) {
  f.library.write((db) =>
    db.prepare("UPDATE works SET body=? WHERE id='43'").run(
      JSON.stringify({
        type: 'video',
        author: { uid: '42' },
        videoUrls: paths.map((p) => base + p)
      })
    )
  );
  return (await f.client.query('work-detail', { id: '43' })).media.find((m) => m.key === 'video');
}
test('a fully checked moov identifies fragmented generic audio and skips an audio-only video candidate', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const audio = fs.readFileSync(new URL('./fixtures/fragmented-generic-audio.m4a', import.meta.url));
  assert.ok(audio.toString('latin1').split('moof').length > 128);
  f.library.write((db) =>
    db.prepare('UPDATE source_audio_hints SET body=? WHERE work_id=?').run(
      JSON.stringify({
        music: { id: '77' },
        sources: [{ kind: 'music', urls: [base + 'remote-fragment-audio'] }]
      }),
      '42'
    )
  );
  const calls = [];
  f.setRemote(({ headers }, url) => {
    const range = new Headers(headers).get('range');
    calls.push([url, range]);
    return originRange(url.endsWith('-audio') ? audio : mp4, range);
  });
  const music = (await f.client.query('work-detail', { id: '42' })).media.find((m) => m.key === 'audio');
  const get = (item, range) =>
    pinnedMedia(f.client.config, f.client.grant, item, { range, signal: f.client.signal() });
  let r = await get(music);
  assert.equal(r.headers['content-type'], 'audio/mp4');
  assert.deepEqual(await contents(r), audio);
  assert.deepEqual(
    calls,
    [[base + 'remote-fragment-audio', null]],
    'sample fragments are not worth fetching to classify the track'
  );
  calls.length = 0;
  const video = await unarchivedVideo(f, ['remote-fragment-audio', 'remote-real-video']);
  r = await get(video);
  assert.equal(r.headers['content-type'], 'video/mp4');
  assert.deepEqual(await contents(r), mp4);
  assert.deepEqual(
    calls.map((c) => c[0]),
    [base + 'remote-fragment-audio', base + 'remote-real-video']
  );
  r = await get(await unarchivedVideo(f, ['remote-fragment-audio']));
  assert.equal(r.statusCode, 404);
  r.resume();
});
test('an open-ended anonymous seek streams an authoritative multi-megabyte suffix before the origin finishes', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const bytes = fragmentedMovie();
  assert.ok(bytes.length > 2 * 1048576);
  const item = await unarchivedVideo(f, ['remote-normal-seek']),
    ranges = [];
  let release,
    used = 0;
  const pause = new Promise((r) => (release = r));
  t.after(release);
  f.setRemote(({ headers, signal }) => {
    const range = new Headers(headers).get('range'),
      part = parseRange(range, bytes.length);
    ranges.push(range);
    let at = part.start;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          if (!part.start && at >= 16384) await pause;
          if (signal.aborted) return controller.error(Error('aborted'));
          if (at > part.end) return controller.close();
          const end = Math.min(part.end + 1, at + 8192);
          controller.enqueue(part.start ? Buffer.alloc(end - at) : bytes.subarray(at, end));
          if (!part.start) used += end - at;
          at = end;
        }
      }),
      {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(part.length),
          'content-range': `bytes ${part.start}-${part.end}/${bytes.length}`
        }
      }
    );
  });
  const signal = AbortSignal.any([f.client.signal(), AbortSignal.timeout(8000)]);
  try {
    const res = await pinnedMedia(f.client.config, f.client.grant, item, { range: 'bytes=1024-', signal });
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], `bytes 1024-${bytes.length - 1}/${bytes.length}`);
    assert.equal(Number(res.headers['content-length']), bytes.length - 1024);
    assert.equal(res.headers['content-type'], 'video/mp4');
    const read = res[Symbol.asyncIterator](),
      first = await read.next();
    assert.equal(first.done, false);
    assert.ok(used <= 16384, 'the first output must not wait for or accumulate the entire suffix');
    release();
    const chunks = [first.value];
    for await (const chunk of read) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes.subarray(1024));
    assert.deepEqual(ranges, ['bytes=1024-', 'bytes=0-' + (bytes.length - 1)]);
  } finally {
    release();
  }
});
test('a distant anonymous 206 needs one sparse multipart reply even when the source attests the URL and logical ID', async (t) => {
  const bytes = fragmentedMovie(),
    start = bytes.length - 90000,
    total = bytes.length;
  let mode = 'multipart',
    refreshes = 0;
  const f = await fixture(t, {
    readDetail: async ({ workId }) => {
      refreshes++;
      return {
        id: workId,
        type: 'video',
        videoUrls: [base + 'remote-distant'],
        mediaQuality: { identities: { video: 'origin-object-id' } }
      };
    }
  });
  await f.connect();
  const item = await unarchivedVideo(f, ['remote-distant']),
    ranges = [];
  f.setRemote(({ headers }) => {
    const range = new Headers(headers).get('range');
    ranges.push(range);
    if (range.includes(',')) {
      if (mode !== 'multipart' && mode !== 'bad-header') return new Response(null, { status: 416 });
      const boundary = 'controlled-boundary',
        body = multipartBytes(bytes, start, boundary, mode === 'bad-header' ? start + 1 : start);
      let pos = 0;
      return new Response(
        new ReadableStream({
          pull(c) {
            if (pos === body.length) return c.close();
            const end = Math.min(body.length, pos + 103);
            c.enqueue(body.subarray(pos, end));
            pos = end;
          }
        }),
        {
          status: 206,
          headers: {
            'content-type': 'multipart/byteranges; boundary="' + boundary + '"',
            'content-length': String(body.length)
          }
        }
      );
    }
    const payload = mode === 'multipart' && range.startsWith('bytes=' + start) ? Buffer.alloc(total) : bytes;
    return originRange(payload, range);
  });
  const get = () =>
    pinnedMedia(f.client.config, f.client.grant, item, {
      range: 'bytes=' + start + '-',
      signal: f.client.signal()
    });
  let res = await get();
  assert.equal(res.statusCode, 206);
  assert.deepEqual(await contents(res), bytes.subarray(start));
  assert.equal(refreshes, 0);
  assert.deepEqual(ranges, ['bytes=' + start + '-', `bytes=0-8191,${start}-${total - 1}`]);
  mode = 'bad-header';
  res = await get();
  assert.equal(res.statusCode, 404);
  res.resume();
  assert.equal(refreshes, 0);
  mode = 'single-range';
  ranges.length = 0;
  res = await get();
  assert.equal(res.statusCode, 404);
  res.resume();
  assert.deepEqual(ranges, ['bytes=' + start + '-', `bytes=0-8191,${start}-${total - 1}`]);
});
function delayedIndex(name, indexOffset, total) {
  const seed = fs.readFileSync(new URL('./fixtures/' + name, import.meta.url));
  const head = seed.readUInt32BE(0),
    padding = free(indexOffset - head);
  assert.equal(seed.toString('ascii', head + 4, head + 8), 'moov');
  return Buffer.concat([
    seed.subarray(0, head),
    padding,
    seed.subarray(head),
    free(total - seed.length - padding.length)
  ]);
}
function free(size) {
  const box = Buffer.alloc(size);
  box.writeUInt32BE(size);
  box.write('free', 4);
  return box;
}
test('generic MP4 track reads beyond the selected response prefix require a representation validator', async (t) => {
  const indexOffset = 12 * 1024,
    total = 128 * 1024,
    distant = 96 * 1024;
  const audio = delayedIndex('fragmented-generic-audio.m4a', indexOffset, total),
    video = delayedIndex('synthetic-fragment.mp4', indexOffset, total);
  const f = await fixture(t);
  await f.connect();
  const item = await unarchivedVideo(f, ['remote-delayed-index']),
    ranges = [];
  let stable = false;
  f.setRemote(({ headers }) => {
    const range = new Headers(headers).get('range');
    ranges.push(range);
    if (range?.includes(',')) {
      return new Response(multipartBytes(audio, distant, 'mixed'), {
        status: 206,
        headers: { 'content-type': 'multipart/byteranges; boundary=mixed' }
      });
    }
    const source = stable || parseRange(range, total).start === indexOffset ? video : audio;
    const reply = originRange(source, range);
    if (stable) reply.headers.set('etag', '"fixed-video"');
    return reply;
  });
  const get = (range) =>
    pinnedMedia(f.client.config, f.client.grant, item, { range, signal: f.client.signal() });
  for (const start of [null, 1024, distant]) {
    ranges.length = 0;
    const range = start === null ? null : `bytes=${start}-`;
    const res = await get(range);
    assert.equal(res.statusCode, 404);
    res.resume();
    const expected = [range];
    if (start === 1024) expected.push('bytes=0-' + (total - 1));
    if (start === distant) expected.push(`bytes=0-8191,${distant}-${total - 1}`);
    assert.deepEqual(ranges, expected);
  }
  stable = true;
  ranges.length = 0;
  const res = await get(`bytes=${distant}-`);
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.deepEqual(await contents(res), video.subarray(distant));
  assert.ok(ranges.includes(`bytes=${indexOffset}-${indexOffset + 8191}`));
});

test('one music ID and URL cannot bind a different equal-length MP4 track index to the selected bytes', async (t) => {
  const total = 128 * 1024,
    indexOffset = 12 * 1024,
    distant = 96 * 1024;
  const audio = delayedIndex('fragmented-generic-audio.m4a', indexOffset, total),
    video = delayedIndex('synthetic-fragment.mp4', indexOffset, total);
  const inline = delayedIndex('fragmented-generic-audio.m4a', 128, total);
  inline[total - 1] = 0x42;
  const digest = (bytes) => 'sha-256=:' + createHash('sha256').update(bytes).digest('base64') + ':';
  const f = await fixture(t);
  await f.connect();
  f.library.write((db) =>
    db.prepare('UPDATE source_audio_hints SET body=? WHERE work_id=?').run(
      JSON.stringify({ music: { id: '77' }, sources: [{ kind: 'music', urls: [base + 'remote-track'] }] }),
      '42'
    )
  );
  const item = (await f.client.query('work-detail', { id: '42' })).media.find((m) => m.key === 'audio');
  const calls = [];
  let mode;
  f.setRemote(({ headers }) => {
    const range = new Headers(headers).get('range');
    calls.push(range);
    if (range?.includes(',')) {
      return new Response(multipartBytes(mode === 'inline' ? inline : video, distant, 'parts'), {
        status: 206,
        headers: { 'content-type': 'multipart/byteranges; boundary=parts' }
      });
    }
    const { start } = parseRange(range, total);
    let bytes = video;
    if (start === indexOffset || mode === 'stable-digest') bytes = audio;
    if (mode === 'inline' && start === 0) bytes = inline;
    const reply = originRange(bytes, range);
    if (mode === 'weak') reply.headers.set('etag', 'W/"same-music"');
    if (mode === 'invalid-digest') reply.headers.set('repr-digest', 'sha-256=:AA==:');
    if (mode === 'changed-digest' || mode === 'stable-digest') reply.headers.set('repr-digest', digest(bytes));
    return reply;
  });
  const get = (range) =>
    pinnedMedia(f.client.config, f.client.grant, item, { range, signal: f.client.signal() });
  for (mode of ['untagged', 'weak', 'invalid-digest', 'changed-digest']) {
    for (const start of [null, 1024, distant]) {
      const range = start === null ? null : `bytes=${start}-`;
      calls.length = 0;
      const res = await get(range);
      assert.equal(res.statusCode, 404, `${mode} at ${start}`);
      res.resume();
      if (mode !== 'changed-digest') assert.ok(!calls.some((r) => r?.startsWith('bytes=' + indexOffset + '-')));
    }
  }
  mode = 'stable-digest';
  calls.length = 0;
  const res = await get(`bytes=${distant}-`);
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-type'], 'audio/mp4');
  assert.deepEqual(await contents(res), audio.subarray(distant));
  assert.ok(calls.includes(`bytes=${indexOffset}-${indexOffset + 8191}`));
  mode = 'inline';
  const head = await pinnedMedia(f.client.config, f.client.grant, item, { head: true, signal: f.client.signal() });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['content-type'], 'audio/mp4');
  assert.equal(Number(head.headers['content-length']), total);
  assert.equal((await contents(head)).length, 0);
  for (const start of [1024, distant]) {
    const res = await get(`bytes=${start}-`);
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-type'], 'audio/mp4');
    assert.deepEqual(await contents(res), inline.subarray(start));
  }
});

test('verified cancellation on an offline recycle mount refreshes a registered video version and real HTTPS playback', async t=>{
  const f=await fixture(t,{removalHook(stage,info){if(stage==='afterRemovalMove'&&info.file.key==='video')throw Error('simulated receipt interruption');}});
  await f.connect();const c=f.client;
  const cmd=(kind,payload)=>c.command({kind,payload,operationId:randomUUID(),entityVersion:0});
  async function waitFor(kind,payload,matches){for(let i=0;i<200;i++){const r=await c.query(kind,payload);if(matches(r))return r;await new Promise(resolve=>setTimeout(resolve,40));}assert.fail('timed out '+kind);}
  const before=(await c.query('work-detail',{id:'41'})).media.find(x=>x.key==='video');
  const stream=(asset)=>f.manager.protocol(new Request(mediaURL(c.grant.libraryId,asset),{headers:{Range:'bytes=100-122'}}),c.epoch);
  assert.deepEqual(Buffer.from(await(await stream(before)).arrayBuffer()),mp4.subarray(100,123));
  await cmd('start-trash-probe',{supported:true,reference:'fixture',retention:'fixture'});
  const p=await waitFor('trash-status',{},s=>s.phase==='await-native'&&!s.busy);
  fs.renameSync(p.bin,p.original);await cmd('control-trash-probe',{token:p.token,observed:true,action:'verify'});
  await waitFor('trash-status',{},s=>s.verified&&!s.busy);
  const {scope,revision}=await c.query('list-works',{source:'media'});
  const r=await cmd('preview-removal',{scope:'files',selection:{source:'media',scope,revision,ids:['41'],all:false}});
  await cmd('confirm-removal',{token:r.token});await waitFor('removal-status',{token:r.token},s=>s.state==='paused');
  const asset=f.downloads.store.resources('41').find(r=>r.key==='video');
  const saved=()=>f.library.read(db=>JSON.parse(db.prepare("SELECT body FROM file_commits WHERE resource_id=? AND stage='registered' ORDER BY revision DESC LIMIT 1").get(asset.id).body));
  assert.ok(saved().registeredChangeNs);
  const original=path.join(f.downloads.layout.media,asset.relative_path);
  fs.renameSync(path.join(f.bin,asset.relative_path),original);fs.renameSync(f.bin,f.bin+'.offline');
  // Some filesystems retain change time across a rename. Force a metadata-only change there.
  const initialStamp=saved().registeredChangeNs;
  if(String(fs.statSync(original,{bigint:true}).ctimeNs)===initialStamp){
    const arm=path.join(path.dirname(original),'fixture-alias');
    fs.linkSync(original,arm);fs.unlinkSync(arm);
  }
  fs.renameSync(original,original+'.owned');fs.copyFileSync(original+'.owned',original);
  await cmd('control-removal',{token:r.token,action:'cancel'});
  await waitFor('removal-status',{token:r.token},s=>s.state==='paused'&&s.cancelling);
  assert.equal(saved().registeredChangeNs,initialStamp);
  assert.equal((await c.query('work-detail',{id:'41'})).media.find(x=>x.key==='video').version,before.version);
  fs.renameSync(original,original+'.foreign');fs.renameSync(original+'.owned',original);
  await cmd('control-removal',{token:r.token,action:'resume'});
  await waitFor('removal-status',{token:r.token},s=>s.state==='cancelled');
  assert.deepEqual(fs.readFileSync(original+'.foreign'),mp4);
  const current=(await c.query('work-detail',{id:'41'})).media.find(x=>x.key==='video');
  const response=await stream(current);assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),mp4.subarray(100,123));
  assert.notEqual(current.version,before.version);assert.equal((await stream(before)).status,409);
  assert.equal(saved().registeredChangeNs,String(fs.statSync(original,{bigint:true}).ctimeNs));
});

test('repairing an HD-only failure retries its original cover job without touching the completed ordinary download', async (t) => {
  let fail = false;
  const f = await fixture(t, {
    removalHook(name, info) {
      if (fail && name === 'beforeResourceVerify' && info.work_id === '41')
        throw Object.assign(Error('simulated I/O'), { code: 'EIO' });
    }
  });
  await f.connect();
  const command = (kind, payload) =>
    f.client.command({ kind, payload, operationId: randomUUID(), entityVersion: 0 });
  fail = true;
  await command('enqueue-download', { workIds: ['41'], selection: 'repair-cover' });
  await f.downloads.run();
  fail = false;
  const jobs = () => f.client.query('download-page', { tab: 'all' });
  assert.equal((await jobs()).jobs.find((j) => j.id === '41').downloadState, 'complete');
  assert.ok(['failed', 'review'].includes((await jobs()).jobs.find((j) => j.id === 'hd:41').downloadState));
  await command('control-download', { action: 'pause', ids: null });
  const view = await f.client.query('list-works', { source: 'all' }),
    selection = {
      source: 'all',
      revision: view.revision,
      scope: view.scope,
      all: false,
      ids: ['41'],
      confirmedCount: 1
    };
  async function result(id) {
    for (let i = 0; i < 100; i++) {
      const page = await f.client.query('check-page', { id });
      if (page.state === 'complete') return page;
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.fail('check did not finish');
  }
  const scan = await result((await command('start-check', { kind: 'files', selection })).id);
  const selected = { id: scan.id, version: scan.version, revision: scan.revision, ids: ['41'], all: false };
  const repair = await result((await command('retry-repair', { selection: selected })).id);
  assert.deepEqual(repair.items[0].jobs, [{ id: 'hd:41', scope: 'cover-hd', state: 'queued' }]);
  assert.equal((await jobs()).jobs.find((j) => j.id === '41').downloadState, 'complete');
});

test('audio restoration recomputes only its work status, retaining independent missing media', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const cmd = (kind, payload) =>
    f.client.command({ operationId: randomUUID(), kind, payload, entityVersion: 0 });
  const page = () => f.client.query('list-works', { source: 'media' });
  async function settle(id) {
    for (let n = 0; n < 200; n++) {
      const p = await f.client.query('check-page', { id });
      if (p.state === 'complete') return p;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail('scan did not finish');
  }
  await cmd('enqueue-download', { workIds: ['42'], selection: 'audio' });
  await f.downloads.run();
  const audio = path.join(
    f.downloads.layout.media,
    f.downloads.store.resources('42').find((r) => r.key === 'audio').relative_path
  );
  for (const extraMissing of [false, true]) {
    fs.renameSync(audio, audio + '.saved-' + extraMissing);
    const p = await page(),
      scan = await settle(
        (
          await cmd('start-check', {
            kind: 'files',
            selection: {
              source: 'media',
              scope: p.scope,
              revision: p.revision,
              ids: ['42'],
              all: false,
              confirmedCount: 1
            }
          })
        ).id
      );
    assert.equal((await page()).items.find((w) => w.id === '42').localStatus, 'partial');
    await cmd('control-download', { action: 'pause', ids: null });
    const repair = await settle(
      (
        await cmd('retry-repair', {
          selection: { id: scan.id, revision: scan.revision, version: scan.version, ids: ['42'], all: false }
        })
      ).id
    );
    if (extraMissing)
      f.library.write((db) =>
        db
          .prepare("UPDATE works SET body=json_insert(body,'$.images[#]',json(?)) WHERE id='42'")
          .run(JSON.stringify({ index: 2, urls: [base + 'new-picture'] }))
      );
    await cmd('control-download', { action: 'resume', ids: null });
    await f.downloads.run();
    assert.equal(
      (await page()).items.find((w) => w.id === '42').localStatus,
      extraMissing ? 'partial' : 'complete'
    );
    assert.equal(
      f.library.read(
        (db) => db.prepare("SELECT status FROM maintenance_file_state WHERE work_id='42'").get()?.status
      ),
      extraMissing ? 'partial' : undefined
    );
    const report = (await settle(repair.id)).items[0];
    assert.equal(report.jobs[0].state, 'complete');
    assert.equal(report.fileStatus, extraMissing ? 'pending' : 'complete');
    assert.deepEqual(fs.readFileSync(audio), fs.readFileSync(audio + '.saved-' + extraMissing));
  }
});
