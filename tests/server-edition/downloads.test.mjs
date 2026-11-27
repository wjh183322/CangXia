import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openLibrary } from '../../server/library.mjs';
import { createSessionService } from '../../server/session.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
);
test('confirmed NAS download persists independently of its interactive grant and validates each image', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'cx-dl-'));
  const library = openLibrary({ root, mode: 'init' });

  const work = {
    id: '501',
    name: '合成图集',
    type: 'images',
    author: { nickname: '测试' },
    images: [0, 1].map((index) => ({ index, urls: ['https://p3.douyinpic.com/fixture-' + index] }))
  };
  library.write((db) => {
    db.prepare("INSERT INTO source_account VALUES (1,'42','测试','profile')").run();
    db.exec("INSERT INTO download_auth VALUES(1,'fixture-key')");
    db.prepare('INSERT INTO works VALUES (?,?,?)').run(work.id, work.name, JSON.stringify(work));
  });
  let fetches = 0;
  const { createDownloads } = await import('../../server/downloads.mjs');
  const source = { account: () => ({ uid: '42', authEpoch: 'fixture' }) };
  const downloads = createDownloads({
    library,
    root,
    source,
    fetchAsset: async () => {
      fetches++;
      return new Response(png, {
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) }
      });
    }
  });
  const session = createSessionService({ library, source, downloads });
  t.after(async () => {
    session.close();
    await downloads.close();
    library.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 4 });
  });
  const who = { accountId: 'fixture', deviceId: 'pc' };
  function acquire() {
    return session.acquire(who, { deviceId: 'pc', instanceId: randomUUID(), operationId: randomUUID() });
  }
  let grant = acquire();
  const cmd = {
    kind: 'enqueue-download',
    operationId: randomUUID(),
    entityVersion: 0,
    payload: { workIds: ['501'], selection: 'missing' }
  };
  const first = session.command(who, grant, cmd);
  session.release(who, grant, randomUUID());
  await downloads.run();
  grant = acquire();
  assert.equal(session.command(who, grant, cmd).jobId, first.jobId);
  const page = session.query(who, grant, { kind: 'download-page', payload: { tab: 'all' } });
  assert.equal(page.jobs[0].state, 'complete', JSON.stringify(page.jobs[0]));
  assert.equal(fetches, 2);
  assert.equal(
    library.read((db) => db.prepare('SELECT count(*) n FROM media_files WHERE work_id=?').get('501').n),
    3
  );
});
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createDownloads } from '../../server/downloads.mjs';

function album(id, count = 2) {
  return {
    id,
    name: '测试' + id,
    author: { nickname: '离线' },
    type: 'images',
    images: Array.from({ length: count }, (_, index) => ({
      index,
      urls: ['https://p3.douyinpic.com/' + id + '-' + index]
    }))
  };
}
const response = (body = png, status = 200, headers = {}) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length), etag: '"v1"', ...headers }
  });
function model(t, works, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'cx-durable-')),
    library = openLibrary({ root, mode: 'init' }),
    source = { account: () => ({ uid: '42', authEpoch: 'fixture' }) };
  library.write((db) => {
    db.exec(
      "INSERT INTO source_account VALUES (1,'42','样本','profile'); INSERT INTO download_auth VALUES(1,'fixture-key')"
    );
    for (const w of works) db.prepare('INSERT INTO works VALUES(?,?,?)').run(w.id, w.name, JSON.stringify(w));
  });
  let d;
  const open = (opts = {}) =>
    (d = createDownloads({ root, library, source, fetchAsset: async () => response(), ...options, ...opts }));
  open();
  t.after(async () => {
    await d.close();
    library.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 4 });
  });
  return {
    root,
    library,
    get d() {
      return d;
    },
    open,
    enqueue: (ids, scope = 'repair') => library.write((db) => d.enqueue(db, ids, scope)),
    control: (input) => library.write((db) => d.control(db, input)),
    job: (id) =>
      library.read((db) =>
        JSON.parse(db.prepare('SELECT body FROM download_manifests WHERE id=?').get(id).body)
      ),
    assets: (id) => d.store.resources(id),
    file: (a) => path.join(d.layout.media, a.relative_path)
  };
}
test('daemon killed between placement and registration restarts without fetching that asset again', async (t) => {
  const f = model(t, [album('10', 1)]);
  f.enqueue(['10']);
  await f.d.close();
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
  import {openLibrary} from './server/library.mjs';
  import {createDownloads} from './server/downloads.mjs';
  const root=process.argv[1], library=openLibrary({root});
  const d=createDownloads({root,library,fetchAsset:async()=>new Response(Buffer.from(process.argv[2],'base64'),{headers:{'Content-Type':'image/png'}}),
   fileHook(name){if(name==='afterFilePlacement')process.kill(process.pid,'SIGKILL');}});
  await d.run();`,
      f.root,
      png.toString('base64')
    ],
    { encoding: 'utf8', windowsHide: true, cwd: fileURLToPath(new URL('../../', import.meta.url)) }
  );
  assert.notEqual(child.status, 0);
  assert.equal(
    f.library.read((db) => db.prepare('SELECT stage FROM file_commits').get().stage),
    'verified'
  );
  let duplicateAssetFetches = 0;
  f.open({
    fetchAsset: async () => {
      duplicateAssetFetches++;
      return response();
    }
  });
  await f.d.run();
  assert.equal(f.job('10').state, 'complete');
  assert.equal(duplicateAssetFetches, 0);
  const img = f.assets('10').find((r) => r.key === 'image-0');
  assert.deepEqual(fs.readFileSync(f.file(img)), png);
  assert.throws(() => createDownloads({ root: f.root, library: f.library }), /locked|busy/i);
});
test('disk full, invalid bytes, missing files and a foreign replacement retain precise per-resource results', async (t) => {
  const calls = [],
    corrupt = Buffer.from(png);
  corrupt[42] ^= 8;
  let mode = 'disk';
  const f = model(t, [album('22')], {
    fileHook(name, { kind }) {
      if (mode === 'disk' && name === 'beforeFileWrite' && kind === 'image')
        throw Object.assign(Error('full'), { code: 'ENOSPC' });
    },
    fetchAsset: async (url) => {
      calls.push(url);
      return response(mode === 'bad' && url.endsWith('-1') ? corrupt : png);
    }
  });
  f.enqueue(['22']);
  await f.d.run();
  assert.equal(f.job('22').reason.code, 'ENOSPC');
  mode = 'bad';
  f.control({ action: 'retry', jobId: '22' });
  await f.d.run();
  const badHash = f.job('22');
  assert.equal(badHash.state, 'failed');
  assert.deepEqual(badHash.completedKeys, ['image-0']);
  mode = 'good';
  f.control({ action: 'retry', jobId: '22' });
  await f.d.run();
  assert.equal(f.job('22').state, 'complete');
  assert.equal(calls.filter((u) => u.endsWith('-0')).length, 1);
  const assets = f.assets('22'),
    first = f.file(assets.find((a) => a.key === 'image-0')),
    second = f.file(assets.find((a) => a.key === 'image-1'));
  fs.unlinkSync(second);
  fs.unlinkSync(f.file(assets.find((a) => a.key === 'metadata')));
  f.enqueue(['22']);
  await f.d.run();
  assert.equal(f.job('22').state, 'complete');
  assert.equal(calls.filter((u) => u.endsWith('-0')).length, 1);
  fs.renameSync(first, first + '.previous');
  fs.writeFileSync(first, 'foreign');
  f.enqueue(['22']);
  await f.d.run();
  assert.equal(f.job('22').state, 'review');
  assert.equal(fs.readFileSync(first, 'utf8'), 'foreign');
});
test('strong ETag resumes the saved prefix after restart; a changed response restarts only the affected image', async (t) => {
  let attempts = 0;
  const f = model(t, [album('31'), album('32', 1)], { checkpointBytes: 12 });
  await f.d.close();
  const seen = [];
  const transport = async (url, opts) => {
    const headers = new Headers(opts.headers);
    seen.push([url, headers.get('range'), headers.get('if-range')]);
    if (!url.endsWith('31-1')) return response();
    attempts++;
    if (attempts === 1) {
      let sent = false;
      return new Response(
        new ReadableStream({
          pull(c) {
            if (sent) c.error(Error('cut'));
            else {
              sent = true;
              c.enqueue(png.subarray(0, 20));
            }
          }
        }),
        { headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length), etag: '"v1"' } }
      );
    }
    if (attempts === 2)
      return response(png.subarray(20), 206, {
        'Content-Range': 'bytes 20-' + (png.length - 1) + '/' + png.length,
        etag: '"v2"'
      });
    return response();
  };
  f.open({ fetchAsset: transport });
  f.enqueue(['31']);
  await f.d.run();
  assert.equal(f.job('31').state, 'failed');
  await f.d.close();
  f.open({ fetchAsset: transport });
  f.control({ action: 'retry', jobId: '31' });
  await f.d.run();
  assert.equal(f.job('31').state, 'complete');
  assert.deepEqual(
    seen.filter(([u]) => u.endsWith('31-1')).map(([, r, e]) => [r, e]),
    [
      [null, null],
      ['bytes=20-', '"v1"'],
      [null, null]
    ]
  );
  assert.equal(seen.filter(([u]) => u.endsWith('31-0')).length, 1);
  f.control({ action: 'concurrency', value: 1 });
  f.enqueue(['32']);
  f.control({ action: 'pause', ids: null });
  await f.d.close();
  f.open({ fetchAsset: transport });
  await f.d.run();
  assert.equal(f.job('32').state, 'paused');
  assert.equal(f.library.read(f.d.state).concurrency, 1);
  f.control({ action: 'resume', ids: null });
  await f.d.run();
  assert.equal(f.job('32').state, 'complete');
});

test('late callbacks respect cancellation, including retained unknown stage files; cleanup is retriable', async (t) => {
  let entered, unblock;
  const start = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (unblock = r));
  const f = model(t, [album('41', 1)], {
    fetchAsset: async () => {
      entered();
      await gate;
      return response();
    }
  });
  f.enqueue(['41']);
  const running = f.d.run();
  await start;
  const commit = f.d.store.fileCommits('41')[0],
    foreign = path.join(f.d.layout.staging, 'commits', commit.id, 'external.txt');
  fs.writeFileSync(foreign, 'outside');
  f.control({ action: 'cancel', jobId: '41' });
  f.d.run();
  unblock();
  await running;
  assert.equal(f.job('41').state, 'cancelled');
  assert.equal(f.job('41').cleanupPending, true);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'outside');
  assert.equal(f.assets('41').length, 0);
  fs.renameSync(foreign, foreign + '.saved');
  fs.renameSync(foreign + '.saved', path.join(f.d.layout.media, 'external-saved.txt'));
  f.control({ action: 'cancel', jobId: '41' });
  await f.d.run();
  assert.equal(f.job('41').cleanupPending, false);
});
test('bound detail refresh is limited to the queued work; changed NAS authentication waits for the operator', async (t) => {
  const work = album('60', 1);
  work.mediaQuality = { identities: { imageCount: 1, images: ['known-id'] } };
  let requests = 0,
    details = 0;
  const f = model(t, [work], {
    source: {
      account: () => ({ uid: '42' }),
      readDownloadDetail: async (args) => {
        details++;
        assert.equal(args.uid, '42');
        assert.equal(args.workId, '60');
        return { ...work, images: [{ index: 0, urls: ['https://p3.douyinpic.com/refreshed'] }] };
      }
    },
    fetchAsset: async (url) => {
      requests++;
      return url.endsWith('/refreshed') ? response() : new Response(null, { status: 403 });
    }
  });
  f.enqueue(['60']);
  f.library.write((db) => db.prepare('UPDATE download_auth SET session_key=?').run('new-authorized'));
  await f.d.run();
  assert.equal(f.job('60').state, 'waiting-auth');
  assert.equal(requests, 0);
  assert.equal(details, 0);
  f.control({ action: 'retry', jobId: '60' });
  await f.d.run();
  assert.equal(f.job('60').state, 'complete');
  assert.equal(requests, 2);
  assert.equal(details, 1);
});
test('video plus ordinary cover and explicitly selected album music record verified media types and checksums', async (t) => {
  const box = (name, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(data.length + 8);
    h.write(name, 4);
    return Buffer.concat([h, data]);
  };
  const video = Buffer.concat([
    box('ftyp', Buffer.from('isom0000mp42')),
    box('moov', box('trak', Buffer.alloc(8))),
    box('mdat', Buffer.alloc(64))
  ]);
  const wav = Buffer.alloc(44 + 1600);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(1600, 40);
  const images = { ...album('56', 1), music: { id: '505', title: '合成音源' } };
  const film = {
    id: '55',
    name: '视频样本',
    type: 'video',
    author: { nickname: '样本' },
    videoUrls: ['https://v3.douyinvod.com/video'],
    coverUrls: ['https://p3.douyinpic.com/cover']
  };
  const f = model(t, [film, images], {
    fetchAsset: async (u) =>
      u.endsWith('video')
        ? response(video, 200, { 'Content-Type': 'video/mp4' })
        : u.endsWith('sound')
          ? response(wav, 200, { 'Content-Type': 'audio/wav' })
          : response()
  });
  f.library.write((db) =>
    db.prepare('INSERT INTO source_audio_hints VALUES(?,?)').run(
      images.id,
      JSON.stringify({
        music: images.music,
        sources: [{ kind: 'music', urls: ['https://v3.douyinvod.com/sound'] }]
      })
    )
  );
  f.enqueue(['55', '56']);
  await f.d.run();
  assert.equal(f.job('55').state, 'complete');
  assert.equal(f.job('56').state, 'complete');
  assert.deepEqual(
    f
      .assets('55')
      .map((a) => a.key)
      .sort(),
    ['cover', 'metadata', 'video']
  );
  assert(!f.assets('56').some((a) => a.kind === 'audio'));
  f.enqueue(['56'], 'audio');
  await f.d.run();
  assert.equal(f.job('audio:56').state, 'complete');
  const saved = f.assets('56').find((a) => a.key === 'audio');
  assert.equal(saved.mime, 'audio/wav');
  assert.deepEqual(fs.readFileSync(f.file(saved)), wav);
});

test('explicit repair after a changed image identity replaces only that verified resource and checks HTTP content digest', async (t) => {
  const work = album('70');
  work.mediaQuality = { identities: { imageCount: 2, images: ['one', 'two'] } };
  let calls = [],
    mismatch = false;
  const f = model(t, [work], {
    fetchAsset: async (url) => {
      calls.push(url);
      return response(
        png,
        200,
        mismatch ? { 'Content-Digest': 'sha-256=:' + Buffer.alloc(32).toString('base64') + ':' } : {}
      );
    }
  });
  f.enqueue(['70']);
  await f.d.run();
  const previous = f.file(f.assets('70').find((a) => a.key === 'image-1'));
  work.mediaQuality.identities.images[1] = 'new-two';
  work.images[1].urls = ['https://p3.douyinpic.com/70-new'];
  f.library.write((db) => db.prepare('UPDATE works SET body=? WHERE id=?').run(JSON.stringify(work), '70'));
  calls = [];
  mismatch = true;
  f.enqueue(['70']);
  await f.d.run();
  assert.equal(f.job('70').state, 'failed');
  assert.equal(f.job('70').reason.code, 'NAS_HASH_MISMATCH');
  assert.deepEqual(fs.readFileSync(previous), png);
  mismatch = false;
  f.control({ action: 'retry', jobId: '70' });
  await f.d.run();
  assert.equal(f.job('70').state, 'complete');
  assert.deepEqual(calls, ['https://p3.douyinpic.com/70-new', 'https://p3.douyinpic.com/70-new']);
  assert.equal(fs.existsSync(previous), false);
  assert.deepEqual(fs.readFileSync(f.file(f.assets('70').find((a) => a.key === 'image-1'))), png);
});

test('revisioned catalogue selection confirms all pages on the NAS and runs up to the saved concurrency', async (t) => {
  const ids = Array.from({ length: 23 }, (_, i) => String(810 + i));
  let busy = 0,
    peak = 0,
    release,
    began;
  const gate = new Promise((r) => (release = r)),
    started = new Promise((r) => (began = r));
  const f = model(
    t,
    ids.map((id) => ({ ...album(id, 1), name: '同名图集' })),
    {
      fetchAsset: async () => {
        busy++;
        peak = Math.max(peak, busy);
        if (peak === 2) began();
        await gate;
        busy--;
        return response();
      }
    }
  );
  const source = { account: () => ({ uid: '42' }) },
    session = createSessionService({ library: f.library, source, downloads: f.d }),
    who = { accountId: 'fixture', deviceId: 'pc' };
  const grant = session.acquire(who, { deviceId: 'pc', instanceId: randomUUID(), operationId: randomUUID() });
  const { revision, scope } = session.query(who, grant, { kind: 'list-works', payload: { source: 'all' } });
  const selection = { source: 'all', revision, scope, all: true, ids: [ids.at(-1)], confirmedCount: 22 };
  const submit = {
    kind: 'catalogue-action',
    entityVersion: 0,
    operationId: randomUUID(),
    payload: { action: 'download', selection }
  };
  assert.equal(session.query(who, grant, { kind: 'download-selection', payload: selection }).unsaved, 22);
  assert.throws(() =>
    session.command(who, grant, {
      ...submit,
      operationId: randomUUID(),
      payload: { ...submit.payload, selection: { ...selection, confirmedCount: 21 } }
    })
  );
  f.control({ action: 'concurrency', value: 2 });
  assert.equal(session.command(who, grant, submit).queued, 22);
  assert.equal(session.command(who, grant, submit).queued, 22);
  await started;
  assert.throws(() => session.command(who, grant, { ...submit, operationId: randomUUID() }));
  session.release(who, grant, randomUUID());
  session.close();
  release();
  await f.d.run();
  assert.equal(peak, 2);
  assert.equal(f.library.read(f.d.state).counts.complete, 22);
  assert.equal(f.assets(ids.at(-1)).length, 0);
});
