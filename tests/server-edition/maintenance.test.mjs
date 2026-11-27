import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash, X509Certificate } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import selfsigned from 'selfsigned';
import { openLibrary } from '../../server/library.mjs';
import { createDownloads } from '../../server/downloads.mjs';
import { createSessionService } from '../../server/session.mjs';
import { createHttpsService } from '../../server/http.mjs';
import { ServerClient } from '../../electron/server-client.mjs';

const keys = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
  keySize: 2048,
  algorithm: 'sha256'
});
async function fixture(t, optionsForDownloads = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-maint-'));
  const library = openLibrary({ root, mode: 'init' });
  const observed = new Map();
  const source = {
    account: () => ({ uid: '22' }),
    readDownloadDetail: async ({ workId, signal }) => {
      signal.throwIfAborted();
      const verdict = observed.get(workId);
      if (typeof verdict === 'function') return verdict(signal);
      if (verdict instanceof Error) throw verdict;
      return { id: workId, remoteState: verdict, sourceStatus: { state: verdict } };
    }
  };
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64'
  );
  const downloads = createDownloads({
    root,
    library,
    source,
    fetchAsset: async () =>
      new Response(image, {
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(image.length) }
      }),
    ...optionsForDownloads
  });
  const file = path.join(downloads.layout.media, 'folder', 'one', 'video.mp4');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'test');
  const sha = createHash('sha256').update('test').digest('hex');
  const identity = (p) => {
    const stat = fs.statSync(p, { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino) };
  };
  library.write((db) => {
    for (const id of ['11', '12']) {
      const body = {
        id,
        type: 'video',
        name: 'private-token',
        remoteState: 'available',
        cookie: 'private-token',
        url: 'https://example.invalid/?token=private-token'
      };
      db.prepare('INSERT INTO works VALUES(?,?,?)').run(id, 'private-token', JSON.stringify(body));
      db.prepare("INSERT INTO source_members VALUES('total',?,1,1)").run(id);
    }
    db.exec(
      "INSERT INTO media_files VALUES('11:video','11','folder/one/video.mp4',4,'" +
        sha +
        "'); INSERT INTO archive_assets VALUES('11:video','video','video','video/mp4',1)"
    );
    db.prepare('INSERT INTO file_commits VALUES(?,?,?,?,?,1)').run(
      'file',
      '11',
      '11:video',
      'registered',
      JSON.stringify({
        identity: identity(file),
        mtimeNs: String(fs.statSync(file, { bigint: true }).mtimeNs),
        size: 4,
        sha256: sha
      })
    );
    db.prepare('INSERT INTO archive_homes VALUES(?,?)').run(
      '11',
      JSON.stringify({
        identity: identity(path.dirname(file)),
        home: { kind: 'collection', id: 'one', folder: 'folder', workFolder: 'one' }
      })
    );
    db.exec(
      "INSERT INTO source_account VALUES(1,'22','test','synthetic'); INSERT INTO download_auth VALUES(1,'test');"
    );
  });
  let sessions = createSessionService({ library, source, downloads });
  const tls = await keys,
    token = 'a'.repeat(48);
  const options = {
    sessions,
    downloads,
    source,
    key: tls.private,
    cert: tls.cert,
    credentials: { A: { accountId: 'family', token } }
  };
  const server = createHttpsService(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new ServerClient();
  t.after(async () => {
    client.lock();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await sessions.close();
    await downloads.close();
    library.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config = {
    url: 'https://127.0.0.1:' + server.address().port,
    deviceId: 'A',
    token,
    fingerprint: new X509Certificate(tls.cert).fingerprint256
  };
  await client.connect(config);
  await client.acquire();
  const query = (kind, payload = {}) => client.query(kind, payload);
  const command = (kind, payload, operationId = randomUUID()) =>
    client.command({ kind, payload, operationId, entityVersion: 0 });
  async function start(kind, ids) {
    const view = await query('list-works', { source: 'all' });
    return command('start-check', {
      kind,
      selection: {
        source: 'all',
        scope: view.scope,
        revision: view.revision,
        all: false,
        ids,
        confirmedCount: ids.length
      }
    });
  }
  async function result(id) {
    for (let i = 0; i < 100; i++) {
      const page = await query('check-page', { id });
      if (page.state !== 'running') return page;
      await delay(10);
    }
    assert.fail('maintenance operation did not settle');
  }
  async function restart() {
    client.lock();
    await sessions.close();
    options.sessions = sessions = createSessionService({ library, source, downloads });
    await client.connect(config);
    await client.acquire();
  }
  return { file, observed, query, command, start, result, library, downloads, client, restart };
}
test('file checks distinguish a missing archive from an identity conflict and retain works and memberships', async (t) => {
  const f = await fixture(t);
  fs.renameSync(f.file, f.file + '.saved');
  const first = await f.result((await f.start('files', ['11'])).id);
  assert.equal(first.state, 'complete');
  assert.ok(first.items[0].issues.some((i) => i.code === 'NAS_FILE_MISSING'));
  assert.equal(first.stageCounts.files, 1);
  const overview = await f.query('check-history');
  assert.equal(overview.problems.files, 1);
  assert.equal((await f.query('list-works', { source: 'total' })).total, 2);
  fs.writeFileSync(f.file, 'test');
  const second = await f.result((await f.start('files', ['11'])).id);
  assert.ok(second.items[0].issues.some((i) => i.code === 'NAS_FILE_REVIEW'));
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'test');
  const diagnostic = await f.query('work-diagnostic', { workId: '11' });
  assert.equal(diagnostic.workId, '11');
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-token|https?:|cookie|sessionKey/i);
  assert.ok(diagnostic.checks.some((c) => c.issues.some((i) => i.code === 'NAS_FILE_REVIEW')));
  f.library.write((db) =>
    db
      .prepare(
        "UPDATE maintenance_items SET result=json_set(result,'$.raw','private-token','$.issues[0].reason','private-token') WHERE run=?"
      )
      .run(second.id)
  );
  assert.doesNotMatch(JSON.stringify(await f.query('work-diagnostic', { workId: '11' })), /private-token/);
});
test('temporary source failure preserves reliable state, confirmed unavailability affects only its work', async (t) => {
  const f = await fixture(t);
  f.observed.set('11', Object.assign(Error('private-token'), { code: 'SOURCE_ACCESS_DENIED' }));
  const first = await f.result((await f.start('source', ['11'])).id);
  assert.equal(first.items[0].issues[0].code, 'SOURCE_ACCESS_DENIED');
  assert.equal((await f.query('work-detail', { id: '11' })).remoteState, 'available');
  f.observed.set('11', 'unavailable');
  const second = await f.result((await f.start('source', ['11'])).id);
  assert.equal(second.items[0].sourceStatus, 'unavailable');
  assert.equal((await f.query('work-detail', { id: '12' })).remoteState, 'available');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'test');
  assert.equal((await f.query('list-works', { source: 'total' })).total, 2);
});
test('repair confirmation uses the exact checked page and checks the disk once more before enqueue', async (t) => {
  const f = await fixture(t);
  fs.renameSync(f.file, f.file + '.saved');
  const run = await f.result((await f.start('files', ['11'])).id);
  const selection = { id: run.id, version: run.version, revision: run.revision, ids: ['11'], all: false };
  await assert.rejects(f.command('retry-repair', { selection: { ...selection, ids: ['12'] } }));
  await assert.rejects(f.command('retry-repair', { selection: { ...selection, version: run.version - 1 } }));
  fs.renameSync(f.file + '.saved', f.file);
  const op = randomUUID();
  const receipt = await f.command('retry-repair', { selection }, op);
  assert.deepEqual(await f.command('retry-repair', { selection }, op), receipt);
  const results = await f.result(receipt.id);
  assert.equal(results.items[0].queued, false);
  assert.equal((await f.query('download-page', { page: 1, tab: 'all' })).total, 0);
});
test('storage refresh counts actual archived and staged bytes separately and preserves completed history', async (t) => {
  const f = await fixture(t);
  const run = await f.result((await f.command('start-check', { kind: 'storage' })).id);
  assert.equal(run.state, 'complete');
  assert.equal(run.totals.archiveBytes, 4);
  assert.equal(run.totals.works, 2);
  assert.equal(run.totals.memberships, 2);
  assert.ok(run.totals.stagingBytes >= 0);
  assert.ok((await f.query('check-history')).items.some((r) => r.id === run.id));
});
test('rate limit stops at the item boundary and resume never replays already committed observations', async (t) => {
  const f = await fixture(t);
  f.observed.set('11', 'available');
  f.observed.set('12', Object.assign(Error('busy'), { code: 'SOURCE_RATE_LIMITED' }));
  const run = await f.result((await f.start('source', ['11', '12'])).id);
  assert.equal(run.state, 'paused');
  f.observed.set('12', 'available');
  await f.command('control-check', { id: run.id, action: 'resume' });
  const done = await f.result(run.id);
  assert.equal(done.state, 'complete');
  assert.equal(done.processed, 2);
});
test('manual status and cover reports stay per-work and stale manual confirmation cannot change source', async (t) => {
  const f = await fixture(t);
  f.library.write((db) =>
    db.exec(
      "UPDATE works SET body=json_set(body,'$.coverUrls',json('[\"https://p3.douyinpic.com/fixture/cover\"]')) WHERE id='11'"
    )
  );
  const identity = (await f.query('work-detail', { id: '11' })).mediaCover;
  const { revision } = await f.query('list-works', { source: 'all' });
  await assert.rejects(f.command('mark-source-unavailable', { workId: '11', revision: revision - 1 }));
  await f.command('mark-source-unavailable', { workId: '11', revision });
  fs.renameSync(f.file, f.file + '.saved');
  await f.command('cover-display', { workId: '11', failed: true, identity });
  assert.ok(
    (await f.query('work-diagnostic', { workId: '11' })).stages.some((i) => i.code === 'COVER_DISPLAY_FAILED')
  );
  const page = await f.result((await f.start('files', ['11'])).id);
  assert.equal(page.items[0].repairable, false);
  assert.equal(page.items[0].fileStatus, 'pending');
  assert.ok(page.items[0].issues.some((i) => i.stage === 'cover'));
  const fresh = (await f.query('list-works', { source: 'all' })).items.find((w) => w.id === '11');
  assert.equal(fresh.coverFailed, true);
  await assert.rejects(
    f.command('cover-display', {
      workId: '11',
      failed: false,
      identity: { ...identity, version: 'obsolete' }
    })
  );
  f.library.write((db) =>
    db
      .prepare("UPDATE works SET body=json_set(body,'$.coverUrls',json(?)) WHERE id='11'")
      .run(JSON.stringify(['https://p3.douyinpic.com/fixture/replaced']))
  );
  const replacement = (await f.query('work-detail', { id: '11' })).mediaCover;
  assert.notEqual(replacement.version, identity.version);
  await f.command('cover-display', { workId: '11', failed: true, identity: replacement });
  await assert.rejects(f.command('cover-display', { workId: '11', failed: false, identity }));
  await f.command('cover-display', { workId: '11', failed: false, identity: replacement });
  assert.ok(!(await f.query('work-diagnostic', { workId: '11' })).stages.some((i) => i.stage === 'cover'));
});
test('audio-only removal preview never selects registered video and cannot confirm an empty audio scope', async (t) => {
  const f = await fixture(t),
    view = await f.query('list-works', { source: 'media' });
  const selection = { source: 'media', scope: view.scope, revision: view.revision, all: false, ids: ['11'] };
  const preview = await f.command('preview-removal', { scope: 'files', asset: 'audio', selection });
  assert.equal(preview.files, 0);
  await assert.rejects(f.command('confirm-removal', { token: preview.token }));
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'test');
});
test('download selection validation drops jobs outside the requested tab', async (t) => {
  const f = await fixture(t);
  const value = await f.query('validate-downloads', { tab: 'failed', ids: ['11', '12'] });
  assert.deepEqual(value.ids, []);
  assert.equal(value.invalid, 2);
});
test('stopping a multi-category cache cleanup preserves unprocessed cache objects', async (t) => {
  const { ServerMediaCache } = await import('../../electron/server-media-cache.mjs');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-maint-cache-')),
    cache = new ServerMediaCache(profile);
  t.after(() => {
    cache.db.close();
    fs.rmSync(profile, { recursive: true, force: true });
  });
  for (const scope of ['audio', 'cover'])
    for (let n = 0; n < 4; n++)
      cache.db
        .prepare('INSERT INTO objects VALUES(?,?,?,?,?,?,?)')
        .run(scope + n, scope, 'test', 'test', 1, n, Buffer.from('x'));
  const cleaning = cache.clearCancellable(['audio', 'cover']);
  cache.stopClear();
  await cleaning;
  assert.ok(cache.summary().used.cover > 0);
  assert.equal(cache.summary().cleaning, false);
  await cache.clearCancellable(['audio', 'cover']);
  assert.equal(cache.summary().used.cover + cache.summary().used.audio, 0);
});
test('selected repair uses the NAS queue, replaces only missing bytes and retains the final job result', async (t) => {
  const f = await fixture(t);
  const work = {
    id: '77',
    name: 'album',
    type: 'images',
    author: { nickname: 'test' },
    images: [0, 1].map((index) => ({ index, urls: ['https://p3.douyinpic.com/test-' + index] }))
  };
  f.library.write((db) =>
    db.prepare('INSERT INTO works VALUES(?,?,?)').run(work.id, work.name, JSON.stringify(work))
  );
  await f.command('enqueue-download', { workIds: ['77'], selection: 'missing' });
  await f.downloads.run();
  const stored = f.downloads.store.resources('77'),
    asset = (n) =>
      path.join(f.downloads.layout.media, stored.find((a) => a.key === 'image-' + n).relative_path);
  const keep = fs.statSync(asset(0), { bigint: true }).ino;
  fs.renameSync(asset(1), asset(1) + '.outside');
  const scan = await f.result((await f.start('files', ['77'])).id),
    selection = { id: scan.id, revision: scan.revision, version: scan.version, ids: ['77'], all: false };
  assert.equal(
    (await f.query('list-works', { source: 'media' })).items.find((w) => w.id === '77').downloaded,
    false
  );
  assert.equal((await f.query('preview-download', { workIds: ['77'] })).partial, 1);
  const receipt = await f.command('retry-repair', { selection });
  assert.equal((await f.result(receipt.id)).items[0].queued, true);
  await f.downloads.run();
  const complete = await f.result(receipt.id);
  assert.equal(complete.items[0].downloadState, 'complete');
  assert.equal(complete.items[0].fileStatus, 'complete');
  assert.equal(
    (await f.query('list-works', { source: 'media' })).items.find((w) => w.id === '77').downloaded,
    true
  );
  assert.equal(fs.statSync(asset(0), { bigint: true }).ino, keep);
  assert.deepEqual(fs.readFileSync(asset(1)), fs.readFileSync(asset(1) + '.outside'));
});
test('resume archive reconciles pending work only and reports a missing registered file', async (t) => {
  const f = await fixture(t);
  fs.renameSync(f.file, f.file + '.saved');
  f.library.write((db) =>
    db.exec(
      "INSERT INTO archive_state(work_id,revision) VALUES('11',2) ON CONFLICT(work_id) DO UPDATE SET revision=revision+1"
    )
  );
  const history = await f.query('check-history');
  assert.equal(history.pendingArchive, 1);
  const run = await f.result(
    (await f.command('start-check', { kind: 'reconcile', revision: history.revision })).id
  );
  assert.equal(run.items.length, 1);
  assert.equal(run.items[0].fileStatus, 'failed');
  assert.equal(run.items[0].issues[0].stage, 'registration');
  assert.equal((await f.query('check-history')).pendingArchive, 1);
});
test('replayed stop receipt cannot interrupt resumed source work; late source results after stop do not publish', async (t) => {
  const f = await fixture(t);
  let resolve, entered;
  const wait = new Promise((r) => (entered = r));
  f.observed.set('11', async () => {
    entered();
    return new Promise((r) => {
      resolve = r;
    });
  });
  const id = (await f.start('source', ['11'])).id;
  await wait;
  const op = randomUUID();
  await f.command('control-check', { id, action: 'stop' }, op);
  assert.equal((await f.result(id)).state, 'paused');
  let resume, notifyReady;
  const restarted = new Promise((r) => (notifyReady = r));
  f.observed.set('11', async (signal) => {
    notifyReady();
    await new Promise((r) => (resume = r));
    signal.throwIfAborted();
    return { id: '11', remoteState: 'available' };
  });
  await f.command('control-check', { id, action: 'resume' });
  resolve({ id: '11', remoteState: 'unavailable' });
  await Promise.race([restarted, delay(2000)]);
  assert.ok(resume, 'resumed source check must start');
  await f.command('control-check', { id, action: 'stop' }, op);
  resume();
  assert.equal((await f.result(id)).state, 'complete');
  assert.equal((await f.query('work-detail', { id: '11' })).remoteState, 'available');
});
test('missing archive directory requires mount review; prevents repair admission', async (t) => {
  const f = await fixture(t);
  fs.renameSync(path.dirname(f.file), path.dirname(f.file) + '.renamed');
  const scan = await f.result((await f.start('files', ['11'])).id);
  assert.equal(scan.items[0].fileStatus, 'blocked');
  assert.equal(scan.items[0].repairable, false);
});
test('dismissing removal preview invalidates its token and preserves the record', async (t) => {
  const f = await fixture(t),
    view = await f.query('list-works', { source: 'all' });
  const selection = { source: 'all', scope: view.scope, revision: view.revision, all: false, ids: ['11'] };
  const { token } = await f.command('preview-removal', { scope: 'records', selection });
  await f.command('control-removal', { token, action: 'discard' });
  await assert.rejects(f.command('confirm-removal', { token }));
  assert.equal((await f.query('list-works', { source: 'total' })).total, 2);
});
test('a later manual decision survives an older in-flight platform observation', async (t) => {
  const f = await fixture(t);
  let notify, finish;
  const started = new Promise((r) => (notify = r));
  f.observed.set('11', () => {
    notify();
    return new Promise((r) => (finish = r));
  });
  const run = await f.start('source', ['11']);
  await started;
  const { revision } = await f.query('list-works', { source: 'all' });
  await f.command('mark-source-unavailable', { revision, workId: '11' });
  finish({ id: '11', remoteState: 'available' });
  const page = await f.result(run.id);
  assert.equal(page.items[0].issues[0].code, 'SOURCE_CHANGED');
  assert.equal((await f.query('work-detail', { id: '11' })).sourceStatus.method, 'manual');
});
test('saved check pages and cross-page exceptions survive a new service boot; stale versions are rejected', async (t) => {
  const f = await fixture(t),
    ids = Array.from({ length: 55 }, (_, i) => String(100 + i));
  f.library.write((db) => {
    const insert = db.prepare("INSERT INTO works VALUES(?,'test','{}')");
    for (const id of ids) insert.run(id);
  });
  const run = await f.start('files', ids),
    first = await f.result(run.id);
  assert.equal(first.count, 55);
  assert.equal(first.items.length, 50);
  await f.restart();
  const second = await f.query('check-page', { id: run.id, page: 2, version: first.version });
  assert.equal(second.items.length, 5);
  const selection = {
    id: run.id,
    revision: second.revision,
    version: second.version,
    all: true,
    ids: [first.items[0].workId, second.items[0].workId]
  };
  assert.equal((await f.query('validate-check-selection', selection)).count, 53);
  await assert.rejects(f.query('check-page', { id: run.id, page: 3 }));
  await f.command('set-tags', { id: '100', tags: ['test'] });
  await assert.rejects(f.query('validate-check-selection', selection));
});

test('cancelled storage scan retains its state across reboot and recounts exact bytes on resume', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.downloads.layout.media, 'synthetic-size');
  fs.mkdirSync(directory);
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(directory, String(i)), '1234');
  const { id } = await f.command('start-check', { kind: 'storage' });
  await f.command('control-check', { id, action: 'stop' });
  await f.restart();
  assert.equal((await f.result(id)).state, 'paused');
  await f.command('control-check', { id, action: 'resume' });
  const done = await f.result(id);
  assert.equal(done.state, 'complete');
  assert.equal(done.totals.archiveBytes, 2404);
});

test('whole-library maintenance includes retained media after record removal and excludes removed records without files', async (t) => {
  const f = await fixture(t);
  for (const id of ['11', '12']) {
    const view = await f.query('list-works', { source: 'all' });
    const { token } = await f.command('preview-removal', {
      scope: 'records',
      selection: { source: 'all', scope: view.scope, revision: view.revision, all: false, ids: [id] }
    });
    await f.command('confirm-removal', { token });
  }
  const view = await f.query('list-works', { source: 'maintenance' });
  assert.deepEqual(view.ids, ['11']);
  const receipt = await f.command('start-check', {
    kind: 'files',
    selection: {
      source: 'maintenance',
      scope: view.scope,
      revision: view.revision,
      all: true,
      ids: [],
      confirmedCount: 1
    }
  });
  assert.equal((await f.result(receipt.id)).items[0].workId, '11');
});

function addAlbum(f, id = '77') {
  const work = {
    id,
    name: 'album',
    type: 'images',
    author: { nickname: 'test' },
    images: [{ index: 0, urls: ['https://p3.douyinpic.com/picture-' + id] }],
    music: { id: '100' }
  };
  f.library.write((db) => {
    db.prepare('INSERT INTO works VALUES(?,?,?)').run(id, work.name, JSON.stringify(work));
    db.prepare('INSERT INTO source_audio_hints(work_id,body) VALUES(?,?)').run(
      id,
      JSON.stringify({
        workId: id,
        music: work.music,
        sources: [{ kind: 'music', urls: ['https://p3.douyinpic.com/sound-' + id] }]
      })
    );
  });
}
async function repairWork(f, id) {
  const scan = await f.result((await f.start('files', [id])).id);
  return f.command('retry-repair', {
    selection: { id: scan.id, revision: scan.revision, version: scan.version, all: false, ids: [id] }
  });
}
test('maintenance retries the failed audio scope and preserves individual outcomes for a multi-scope repair', async (t) => {
  const f = await fixture(t, { fetchAsset: async () => new Response(null, { status: 503 }) });
  addAlbum(f);
  await f.command('enqueue-download', { workIds: ['77'], selection: 'audio' });
  await f.downloads.run();
  await f.command('control-download', { action: 'pause', ids: null });
  const single = await f.result((await repairWork(f, '77')).id);
  assert.deepEqual(single.items[0].jobs, [{ id: 'audio:77', scope: 'audio', state: 'queued' }]);
  assert.deepEqual(
    (await f.query('download-page', { tab: 'all' })).jobs.map((j) => j.id),
    ['audio:77']
  );
  await f.command('control-download', { action: 'resume', ids: null });
  await f.downloads.run();
  await f.command('enqueue-download', { workIds: ['77'], selection: 'missing' });
  await f.downloads.run();
  await f.command('control-download', { action: 'pause', ids: null });
  const multi = await f.result((await repairWork(f, '77')).id);
  assert.deepEqual(multi.items[0].jobs.map((j) => j.id).sort(), ['77', 'audio:77']);
  assert.equal(multi.pendingJobs, 2);
  await f.command('control-download', { action: 'cancel', ids: ['audio:77'] });
  await f.downloads.run();
  const partial = await f.result(multi.id);
  assert.equal(partial.pendingJobs, 1);
  assert.equal(partial.items[0].jobs.find((j) => j.id === 'audio:77').state, 'cancelled');
  await f.command('control-download', { action: 'resume', ids: null });
  await f.downloads.run();
  const end = await f.result(multi.id);
  assert.equal(end.pendingJobs, 0);
  assert.equal(end.items[0].fileStatus, 'failed');
  const exported = await f.query('work-diagnostic', { workId: '77' });
  assert.deepEqual(exported.checks.find((r) => r.kind === 'repair').jobs, end.items[0].jobs);
});
test('selected registration-only repair reconciles metadata without admitting a download', async (t) => {
  let requests = 0;
  const f = await fixture(t, {
    fetchAsset: async () => {
      requests++;
      throw Error('unexpected transfer');
    }
  });
  f.library.write((db) =>
    db.exec(
      "INSERT INTO archive_state(work_id,revision,error) VALUES('11',3,'interrupted') ON CONFLICT(work_id) DO UPDATE SET revision=revision+1,error='interrupted'"
    )
  );
  const run = await f.result((await repairWork(f, '11')).id);
  assert.equal(run.items[0].registration, 'complete');
  assert.equal(run.items[0].fileStatus, 'complete');
  assert.equal((await f.query('check-history')).pendingArchive, 0);
  assert.equal((await f.query('download-page', { tab: 'all' })).total, 0);
  assert.equal(requests, 0);
});
test('confirmed unavailability fences active I/O and paused work; later verified availability allows exact-job retry', async (t) => {
  const transfers = [],
    inFlight = Promise.withResolvers(),
    release = Promise.withResolvers();
  const f = await fixture(t, {
    fetchAsset: async (url) => {
      transfers.push(url);
      inFlight.resolve();
      await release.promise;
      return new Response(null, { status: 503 });
    }
  });
  addAlbum(f);
  addAlbum(f, '78');
  addAlbum(f, '79');
  await f.command('control-download', { action: 'pause', ids: null });
  await f.command('enqueue-download', { workIds: ['77', '78', '79'], selection: 'missing' });
  await f.command('control-download', { action: 'pause', ids: ['79'] });
  await f.command('set-tags', { id: '78', tags: ['test'] });
  f.observed.set('79', 'unavailable');
  await f.result((await f.start('source', ['79'])).id);
  await f.command('control-download', { action: 'resume', ids: null });
  await inFlight.promise;
  const view = await f.query('list-works', { source: 'all' });
  await f.command('mark-source-unavailable', { workId: '77', revision: view.revision });
  const before = await f.query('download-page', { tab: 'all' });
  release.resolve();
  await f.downloads.run();
  assert.equal(before.jobs.find((j) => j.id === '77').downloadState, 'unavailable');
  assert.ok(!transfers.some((url) => url.endsWith('-79')));
  assert.equal(f.downloads.store.resources('77').length, 0);
  assert.equal(
    (await f.query('download-page', { tab: 'all' })).jobs.find((j) => j.id === '78').downloadState,
    'failed'
  );
  assert.equal((await f.command('control-download', { action: 'retry', ids: ['77', '79'] })).queued, 0);
  f.observed.set('77', 'available');
  await f.result((await f.start('source', ['77'])).id);
  assert.equal((await f.command('control-download', { action: 'retry', ids: ['77', '79'] })).queued, 1);
});

test('interrupted download registration is retried without fetching the primary resource again', async (t) => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64'
  );
  let fail = true,
    transfers = 0;
  const f = await fixture(t, {
    fileHook(name, info) {
      if (fail && name === 'beforeFileWrite' && info.kind === 'metadata')
        throw Object.assign(Error('storage'), { code: 'EIO' });
    },
    fetchAsset: async () => {
      transfers++;
      return new Response(png, {
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) }
      });
    }
  });
  addAlbum(f);
  await f.command('enqueue-download', { selection: 'missing', workIds: ['77'] });
  await f.downloads.run();
  assert.equal(
    (await f.query('download-page', { tab: 'all' })).jobs[0].downloadState,
    'finalization-pending'
  );
  const bytes = f.downloads.store.resources('77').find((i) => i.key === 'image-0'),
    count = transfers;
  fail = false;
  const { id } = await repairWork(f, '77');
  await f.result(id);
  await f.downloads.run();
  assert.equal((await f.result(id)).items[0].fileStatus, 'complete');
  assert.equal(transfers, count);
  assert.equal(f.downloads.store.resources('77').find((i) => i.key === 'image-0').revision, bytes.revision);
});
test('a fresh source observation at file placement blocks registration and other paused scopes of the same work', async (t) => {
  const { saveWorks } = await import('../../server/read-store.mjs');
  let f,
    marked = false;
  f = await fixture(t, {
    fileHook(name, info) {
      if (marked || name !== 'afterFilePlacement' || info.workId !== '77') return;
      marked = true;
      try {
        f.library.write((db) =>
          saveWorks(db, {
            works: [
              {
                id: '77',
                name: 'album',
                type: 'images',
                images: [],
                coverUrls: [],
                coverVariants: [],
                videoUrls: [],
                observedFields: [],
                remoteState: 'unavailable',
                sourceStatus: { state: 'unavailable', method: 'platform' }
              }
            ],
            aux: { creatorProfiles: [], audioSourceHints: [] }
          })
        );
      } catch (e) {
        t.diagnostic(e.stack);
        throw e;
      }
    }
  });
  addAlbum(f);
  await f.command('control-download', { action: 'pause', ids: null });
  await f.command('enqueue-download', { selection: 'audio', workIds: ['77'] });
  await f.command('control-download', { action: 'pause', ids: ['audio:77'] });
  // An individual job may stay paused even when the global worker is enabled.
  f.library.write((db) => db.exec('UPDATE download_options SET paused=0'));
  await f.command('enqueue-download', { selection: 'missing', workIds: ['77'] });
  await f.downloads.run();
  assert.ok(marked);
  assert.equal((await f.query('work-detail', { id: '77' })).remoteState, 'unavailable');
  assert.equal(f.downloads.store.resources('77').length, 0);
  assert.deepEqual(
    (await f.query('download-page', { tab: 'all' })).jobs.map((j) => j.downloadState),
    ['unavailable', 'unavailable']
  );
  f.observed.set('77', 'available');
  await f.result((await f.start('source', ['77'])).id);
  await f.command('control-download', { action: 'retry', ids: ['77'] });
  await f.downloads.run();
  assert.equal(f.downloads.store.resources('77').filter((i) => i.key === 'image-0').length, 1);
  assert.equal(
    (await f.query('download-page', { tab: 'all' })).jobs.find((j) => j.id === 'audio:77').downloadState,
    'unavailable'
  );
});

test('a newly forbidden response chunk cannot extend the retained transfer prefix', async (t) => {
  let controller, stage;
  const f = await fixture(t, {
    fileHook(name, info) {
      if (name === 'beforeFileWrite' && info.kind === 'image') stage = info.file;
    },
    fetchAsset: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            controller = c;
            c.enqueue(new Uint8Array(32));
          }
        }),
        { headers: { 'Content-Type': 'image/png', 'Content-Length': '256', etag: '"same-asset"' } }
      )
  });
  addAlbum(f);
  await f.command('enqueue-download', { workIds: ['77'], selection: 'missing' });
  let partial;
  for (let i = 0; i < 150; i++) {
    const name = stage && fs.readdirSync(stage).find((n) => n.endsWith('.part'));
    if (name) {
      partial = path.join(stage, name);
      if (fs.statSync(partial).size === 32) break;
    }
    await delay(10);
  }
  assert.equal(fs.statSync(partial).size, 32);
  f.library.write((db) =>
    db.exec("UPDATE works SET body=json_set(body,'$.remoteState','unavailable') WHERE id='77'")
  );
  controller.enqueue(new Uint8Array(32));
  controller.close();
  await f.downloads.run();
  assert.equal(fs.statSync(partial).size, 32);
  assert.equal(f.downloads.store.resources('77').length, 0);
});
