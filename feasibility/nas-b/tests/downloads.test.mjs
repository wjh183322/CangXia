import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createDownloads } from '../src/downloads.mjs';
import { recoverFileCommits, resolveResource } from '../src/files.mjs';
import { makeSandbox } from './helpers.mjs';
import { openProbeStore } from '../src/store.mjs';
import { parseSourcePage } from '../src/page-parser.mjs';

const id = '7650000000000000001';
const other = '7650000000000000002';
const videoURL = 'https://v3.douyinvod.com/video/token';
const coverURL = 'https://p3.douyinpic.com/cover/token';
const pictureURL = 'https://p3.douyinpic.com/picture/token';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
function box(type, bytes) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + bytes.length);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, bytes]);
}
const video = Buffer.concat([
  box('ftyp', Buffer.from('isom\x00\x00\x00\x00isommp42')), box('moov', box('trak', Buffer.alloc(8))),
  box('mdat', Buffer.alloc(48, 0x31))
]);
function rawVideo(overrides = {}) {
  return {
    aweme_id: id, desc: '旧标题', author: { uid: '42', nickname: '作者' }, music: { id: '998', title: '配乐' },
    video: { vid: 'platform-video-1', play_addr: { url_list: [videoURL] }, origin_cover: { uri: 'platform-cover-1', url_list: [coverURL] } },
    ...overrides
  };
}
function rawImages(pictures, overrides = {}) {
  return { aweme_id: other, desc: '多图😀', author: { uid: '42', nickname: '作者' },
    images: pictures.map(([uri, url]) => ({ uri, origin_image: { uri, url_list: [url] } })), ...overrides };
}
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const httpAsset = (bytes, mime, headers = {}, status = 200) => new Response(bytes, {
  status, headers: { 'Content-Type': mime, 'Content-Length': String(bytes.length), ETag: '"fixture-tag"', ...headers }
});
const authError = () => Object.assign(new Error('Test authorization changed.'), { code: 'PROBE_AUTH_STALE' });

async function fixture(t, { rows = [rawVideo()], fetchAsset, detail, hooks, maxBytes, checkpointBytes } = {}) {
  const sandbox = await makeSandbox(t);
  const layout = await sandbox.prepare();
  const file = path.join(layout.state, 'fixture.sqlite');
  const open = (initialize, testHooks = hooks) => {
    const store = openProbeStore({ file, libraryId: sandbox.config.libraryId, initialize, testHooks });
    sandbox.onCleanup(() => store.close());
    return store;
  };
  const store = open(true);
  const source = { kind: 'total', id: '__all__' };
  const job = store.createReadJob({ source, authEpoch: 3 });
  const page = parseSourcePage({ source, inputCursor: '0', status: 200, text: JSON.stringify({
    has_more: 0, aweme_list: rows
  }), observedAt: '2026-11-20T00:00:00.000Z' });
  store.commitPage({ jobId: job.id, epoch: job.epoch, authEpoch: 3, operationId: 'seed', page }, () => {});
  let epoch = 3;
  const calls = [], details = [];
  store.db.prepare('INSERT INTO runtime_meta VALUES (?,?)').run('browser_auth', JSON.stringify({ uid: '1234', authEpoch: epoch }));
  const gateway = {
    assertAuthEpoch(expected) { if (expected !== epoch) throw authError(); },
    async mediaHeaders() { return new Headers({ 'User-Agent': 'fixture', Referer: 'https://www.douyin.com/', Cookie: 'forbidden' }); },
    async request(route, options) {
      assert.equal(route, '/aweme/v1/web/aweme/detail/');
      gateway.assertAuthEpoch(options.authEpoch);
      options.beforeDispatch();
      details.push([options.params.aweme_id, options.authEpoch]);
      const raw = await detail?.(options);
      return { status: 200, text: JSON.stringify({ aweme_detail: raw }) };
    }
  };
  const downloadsFor = owner => createDownloads({ store: owner, gateway, layout,
    testOptions: { maxBytes, checkpointBytes },
    fetchAsset(url, options) {
      calls.push([url, new Headers(options.headers)]);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      assert.equal(new Headers(options.headers).has('cookie'), false);
      return fetchAsset?.(url, options) ?? (url.includes('douyinvod') ? httpAsset(video, 'video/mp4') : httpAsset(png, 'image/png'));
    }
  });
  return { sandbox, layout, store, open, calls, details, downloadsFor, downloads: downloadsFor(store),
    setEpoch(value) { epoch = value; } };
}

test('DL-01 durable enqueue, command receipts, and complete video and gallery survive the client', async t => {
  const f = await fixture(t, { rows: [rawVideo(), rawImages([['photo-1', pictureURL]])] });
  const command = { workIds: [id, other], operationId: 'enqueue' };
  const receipts = f.downloads.enqueue(command);
  assert.deepEqual(receipts.map(job => job.expected.map(item => item.key)), [['video', 'cover'], ['image-0']]);
  assert.deepEqual(f.store.operation('enqueue').jobs, receipts);
  assert.equal(JSON.stringify(receipts).includes('douyinvod'), false);
  assert.throws(() => f.downloads.enqueue({ ...command, workIds: [id] }), { code: 'PROBE_OPERATION_CONFLICT' });
  f.store.close();
  const store = f.open(false);
  const downloads = f.downloadsFor(store);
  assert.deepEqual(downloads.enqueue(command), receipts);
  const running = downloads.run();
  assert.equal(downloads.run(), running);
  await running;
  assert.deepEqual(downloads.snapshot().jobs.map(job => job.state), ['complete', 'complete']);
  assert.deepEqual(f.calls.map(([url]) => url), [videoURL, coverURL, pictureURL]);
  const asset = await resolveResource({ store, layout: f.layout, workId: id, key: 'video' });
  assert.equal(path.basename(asset.file), '视频.mp4');
  assert.equal(asset.sha256, checksum(video));
  assert.equal(path.basename((await resolveResource({ store, layout: f.layout, workId: id, key: 'cover' })).file), '单图.png');
  assert.equal(path.basename((await resolveResource({ store, layout: f.layout, workId: other, key: 'image-0' })).file), '图片-001.png');
  const metadata = JSON.parse(await readFile(path.join(path.dirname(asset.file), '作品信息.json'), 'utf8'));
  assert.deepEqual(metadata.assets.map(item => [item.key, item.sha256]), [['video', checksum(video)], ['cover', checksum(png)]]);
  assert.equal((await recoverFileCommits({ store, layout: f.layout })).length, 0);
});

test('DL-02 persisted checkpoint rejects an ETag change and reuses the completed video', async t => {
  let coverAttempts = 0;
  const f = await fixture(t, { checkpointBytes: 1, fetchAsset(url, { headers }) {
    if (url === videoURL) return httpAsset(video, 'video/mp4');
    coverAttempts++;
    if (coverAttempts === 1) return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(png.subarray(0, 20)); controller.close(); }
    }), { headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length), ETag: '"old"' } });
    if (coverAttempts === 2) {
      assert.equal(new Headers(headers).get('Range'), 'bytes=20-');
      return httpAsset(png.subarray(20), 'image/png', { ETag: '"new"', 'Content-Range': `bytes 20-${png.length - 1}/${png.length}` }, 206);
    }
    assert.equal(new Headers(headers).get('Range'), null);
    return httpAsset(png, 'image/png', { ETag: '"new"' });
  } });
  const [job] = f.downloads.enqueue({ workIds: [id], operationId: 'enqueue' });
  await f.downloads.run();
  assert.equal(f.downloads.snapshot().jobs[0].state, 'failed');
  f.store.close();
  const reopened = f.open(false);
  const downloads = f.downloadsFor(reopened);
  downloads.resume(job.id, 'retry');
  await downloads.run();
  assert.equal(downloads.snapshot().jobs[0].state, 'complete');
  assert.equal(f.calls.filter(([url]) => url === videoURL).length, 1);
  assert.equal(coverAttempts, 3);
});

test('DL-03 refresh handles only the queued work and requires the original authorization epoch', async t => {
  const nextURL = 'https://v3.douyinvod.com/video/new-token';
  const f = await fixture(t, { rows: [rawVideo(), rawVideo({ aweme_id: other })],
    fetchAsset(url) { if (url === videoURL) return new Response(null, { status: 403 }); },
    detail() { f.setEpoch(4); return rawVideo({ video: { ...rawVideo().video, play_addr: { url_list: [nextURL] } } }); }
  });
  f.downloads.enqueue({ workIds: [id], operationId: 'enqueue' });
  await f.downloads.run();
  assert.deepEqual(f.details, [[id, 3]]);
  assert.equal(f.downloads.snapshot().jobs[0].state, 'waiting-auth');
  assert.equal(f.calls.some(([url]) => url === nextURL), false);
});

test('DL-03 reordered gallery resources go to review and finished files stay intact', async t => {
  const second = pictureURL + '2';
  const figures = [['photo-1', pictureURL], ['photo-2', second]];
  const f = await fixture(t, { rows: [rawImages(figures)], fetchAsset(url) {
    if (url === second) return new Response(null, { status: 404 });
  }, detail: () => rawImages(figures.toReversed()) });
  f.downloads.enqueue({ workIds: [other], operationId: 'enqueue' });
  await f.downloads.run();
  assert.equal(f.downloads.snapshot().jobs[0].state, 'review');
  const first = await resolveResource({ store: f.store, layout: f.layout, workId: other, key: 'image-0' });
  assert.equal(first.sha256, checksum(png));
  assert.equal(await resolveResource({ store: f.store, layout: f.layout, workId: other, key: 'image-1' }), null);
  assert.deepEqual(f.details, [[other, 3]]);
});

test('DL-03 rotating a signed query on the same video object safely refreshes its request', async t => {
  const url = videoURL + '?x-signature=expired&x-expires=1';
  const next = videoURL + '?x-signature=new&x-expires=2';
  const media = { ...rawVideo().video, vid: undefined, play_addr: { url_list: [url] } };
  const f = await fixture(t, {
    rows: [rawVideo({ video: media })], detail: () => rawVideo({ video: { ...media, play_addr: { url_list: [next] } } }),
    fetchAsset(address) { if (address === url) return new Response(null, { status: 403 }); }
  });
  f.downloads.enqueue({ workIds: [id], operationId: 'enqueue' });
  await f.downloads.run();
  assert.equal(f.downloads.snapshot().jobs[0].state, 'complete');
  assert.deepEqual(f.calls.map(([address]) => address), [url, next, coverURL]);
});

test('DL-04 rejects a successful response with HTML and checks every redirect before egress', async t => {
  const f = await fixture(t, { fetchAsset(url) {
    assert.equal(url, videoURL);
    return httpAsset(Buffer.from('<html>login</html>'), 'video/mp4');
  } });
  f.downloads.enqueue({ workIds: [id], operationId: 'enqueue' });
  await f.downloads.run();
  assert.equal(f.downloads.snapshot().jobs[0].reason.code, 'PROBE_MEDIA_FORMAT');
  assert.equal(f.store.resources(id).length, 0);
  const redirect = await fixture(t, { fetchAsset() {
    return new Response(null, { status: 302, headers: { Location: 'http://v2.douyinvod.com/downgrade' } });
  } });
  redirect.downloads.enqueue({ workIds: [id], operationId: 'enqueue' });
  await redirect.downloads.run();
  assert.equal(redirect.downloads.snapshot().jobs[0].reason.code, 'PROBE_MEDIA_TARGET');
  assert.equal(redirect.calls.length, 1);
});

test('DL-06 cancellation drains in-flight stream before cleanup and records a cleanup error separately', async t => {
  let started, release;
  const inFlight = new Promise(resolve => { started = resolve; });
  const drained = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { hooks: { beforeFileCleanup() { throw Object.assign(Error('fixture'), { code: 'EACCES' }); } },
    fetchAsset() {
      return new Response(new ReadableStream({
        async pull(controller) { started(); await drained; controller.enqueue(video.subarray(0, 16)); controller.close(); }
      }), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(video.length), ETag: '"fixture-tag"' } });
    } });
  const [job] = f.downloads.enqueue({ workIds: [id], operationId: 'enqueue' });
  const running = f.downloads.run();
  await inFlight;
  const staging = path.join(f.layout.staging, 'commits');
  const [token] = await readdir(staging);
  const unknown = path.join(staging, token, 'unknown.part');
  await writeFile(unknown, 'someone else');
  assert.equal(f.downloads.cancel(job.id, 'cancel').state, 'cancelling');
  assert.equal(f.downloads.snapshot().jobs[0].state, 'cancelling');
  release();
  await running;
  const [cancelled] = f.downloads.snapshot().jobs;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.cleanupPending, true);
  assert.equal(cancelled.reason.code, 'PROBE_CLEANUP_PENDING');
  assert.equal(await readFile(unknown, 'utf8'), 'someone else');
  assert.equal(f.store.resources(id).length, 0);
});

test('transfer and new media limits pause durable work without oversaving', async t => {
  const f = await fixture(t, { maxBytes: video.length + 2 });
  f.downloads.enqueue({ workIds: [id], operationId: 'enqueue' });
  await f.downloads.run();
  const { jobs: [job], usage } = f.downloads.snapshot();
  assert.equal(job.state, 'paused');
  assert.equal(job.reason.code, 'PROBE_MEDIA_BUDGET');
  assert.equal(usage.transferredBytes, video.length);
  assert.equal(usage.newMediaBytes, video.length);
  assert.equal(f.store.resources(id).length, 1);
});

test('media signature and tail are insufficient when a PNG data chunk has an invalid CRC', async t => {
  const corrupt = Buffer.from(png);
  corrupt[45] ^= 1;
  const f = await fixture(t, { rows: [rawImages([['photo-1', pictureURL]])],
    fetchAsset: () => httpAsset(corrupt, 'image/png') });
  f.downloads.enqueue({ workIds: [other], operationId: 'enqueue' });
  await f.downloads.run();
  assert.equal(f.downloads.snapshot().jobs[0].reason?.code, 'PROBE_MEDIA_FORMAT');
  assert.equal(f.store.resources(other).length, 0);
});

test('a necessary static cover uses the largest verified candidate dimensions', async t => {
  const larger = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=', 'base64');
  const alternative = 'https://p3.douyinpic.com/cover/alternative';
  const f = await fixture(t, {
    rows: [rawVideo({ video: { ...rawVideo().video, origin_cover: {
      ...rawVideo().video.origin_cover, width: 4096, height: 4096
    }, cover: { url_list: [alternative], width: 10, height: 10 } } })],
    fetchAsset(url) { if (url === alternative) return httpAsset(larger, 'image/png'); }
  });
  f.downloads.enqueue({ workIds: [id], operationId: 'enqueue' });
  await f.downloads.run();
  assert.equal(f.downloads.snapshot().jobs[0].state, 'complete');
  const cover = await resolveResource({ store: f.store, layout: f.layout, workId: id, key: 'cover' });
  assert.equal(cover.sha256, checksum(larger));
});
