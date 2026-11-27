import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openLibrary } from '../../server/library.mjs';
import { saveWorks } from '../../server/read-store.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { parseSourceDetail } from '../../server/source-parser.mjs';
import { createDownloads } from '../../server/downloads.mjs';
import { createSessionService } from '../../server/session.mjs';
import { registerCatalogueHandlers } from '../../electron/server-ipc.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const small = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
);
const album = {
  id: '71',
  name: '旧标题',
  type: 'images',
  author: { nickname: '作者' },
  images: [{ index: 0, urls: ['https://p3.douyinpic.com/img'] }]
};
function fixture(t, work, options = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cx-archive-'));
  const library = openLibrary({ root, mode: 'init' });
  library.write((db) => {
    db.exec(
      "INSERT INTO source_account VALUES(1,'42','fixture','profile'); INSERT INTO download_auth VALUES(1,'fixture')"
    );
    db.prepare('INSERT INTO works VALUES(?,?,?)').run(work.id, work.name, JSON.stringify(work));
    db.prepare("INSERT INTO source_members VALUES('total',?,0,0)").run(work.id);
  });
  const source = { account: () => ({ uid: '42', authEpoch: 'fixture' }), ...options.source };
  let downloads, session, grant;
  const who = { accountId: 'fixture', deviceId: 'pc' };
  const query = (kind, payload) => session.query(who, grant, { kind, payload });
  const command = (kind, payload, entityVersion = 0) =>
    session.command(who, grant, { kind, payload, operationId: randomUUID(), entityVersion });
  const ipc = {};
  function start() {
    downloads = createDownloads({
      root,
      library,
      source,
      fetchAsset: async () => new Response(small, { headers: { 'Content-Type': 'image/png' } }),
      ...options
    });
    session = createSessionService({ library, source, downloads, readDelay: 0 });
    grant = session.acquire(who, { deviceId: 'pc', instanceId: randomUUID(), operationId: randomUUID() });
    registerCatalogueHandlers({
      ipc: (name, scope, fn) => (ipc[name] = fn),
      client: { query, command: (cmd) => session.command(who, grant, JSON.parse(JSON.stringify(cmd))) }
    });
  }
  async function close() {
    session.close();
    await downloads.close();
  }
  start();
  t.after(async () => {
    await close();
    library.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const rows = () => downloads.store.resources(work.id);
  const file = (key) => path.join(downloads.layout.media, rows().find((r) => r.key === key).relative_path);
  const info = () => JSON.parse(fs.readFileSync(file('metadata')));
  const state = (id) => query('download-page', { tab: 'all' }).jobs.find((j) => j.id === id);
  return {
    root,
    library,
    ipc,
    discover: () => session.sourceOperation(who, grant, 'folders', {}),
    start,
    close,
    command,
    query,
    file,
    info,
    state,
    rows,
    get d() {
      return downloads;
    }
  };
}

test('real download and tag commands reconcile one copy, folder collisions, old homes and stale metadata', async (t) => {
  let hook;
  const f = fixture(t, album, { fileHook: (name, args) => hook?.(name, args) });
  f.ipc.download([album.id], { scope: 'missing' });
  await f.d.run();
  assert.equal(f.state('71').state, 'complete');
  const inode = fs.statSync(f.file('image-0'), { bigint: true }).ino;
  f.command('set-tags', { id: '71', tags: ['本地标签'] });
  await f.d.run();
  assert.deepEqual(f.info().localTags, ['本地标签']);
  const updateName = (name) =>
    f.library.write((db) =>
      db.prepare("UPDATE works SET title=?,body=json_set(body,'$.name',?) WHERE id='71'").run(name, name)
    );
  updateName('新标题');
  const foreign = path.join(f.d.layout.media, '收藏', '新标题-作者');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, '不可覆盖'), '保留');
  await f.d.run();
  assert.equal(path.basename(path.dirname(f.file('metadata'))), '新标题-作者-71');
  f.library.write((db) => {
    db.exec(
      "INSERT INTO read_sources VALUES('folder:88','42','自建夹','{}',1,0); INSERT INTO source_members VALUES('folder:88','71',0,0)"
    );
  });
  await f.d.run();
  const firstHome = path.dirname(f.file('metadata'));
  assert.equal(f.info().collectionId, '88');
  f.command('remove-membership', { source: { kind: 'collection', id: '88' }, workId: '71' });
  await f.d.run();
  assert.equal(path.dirname(f.file('metadata')), firstHome);
  assert.equal(fs.statSync(f.file('image-0'), { bigint: true }).ino, inode);
  assert.equal(f.rows().filter((r) => r.kind === 'image').length, 1);
  assert.equal(fs.readFileSync(path.join(foreign, '不可覆盖'), 'utf8'), '保留');
  hook = (name) => {
    if (name === 'beforeMetadataExchange') {
      hook = null;
      f.library.write((db) =>
        db.exec("UPDATE works SET body=json_set(body,'$.caption','最终值') WHERE id='71'")
      );
    }
  };
  f.library.write((db) => db.exec("UPDATE works SET body=json_set(body,'$.caption','旧修改') WHERE id='71'"));
  await f.d.run();
  assert.notEqual(f.info().caption, '旧修改');
  await f.d.run();
  assert.equal(f.info().caption, '最终值');
  assert.equal(
    digest(fs.readFileSync(f.file('metadata'))),
    f.rows().find((r) => r.key === 'metadata').sha256
  );
});

test('directory move killed after rename restarts by inode and retains a changed target for review', async (t) => {
  const f = fixture(t, album);
  f.ipc.download(['71'], { scope: 'missing' });
  await f.d.run();
  const old = f.file('image-0');
  const stat = fs.statSync(old, { bigint: true });
  f.library.write((db) =>
    db.exec("UPDATE works SET title='移夹',body=json_set(body,'$.name','移夹') WHERE id='71'")
  );
  await f.close();
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {openLibrary} from './server/library.mjs';
    import {createDownloads} from './server/downloads.mjs';
    const root=process.argv[1],library=openLibrary({root}),d=createDownloads({root,library,
      fileHook(name,args){if(name==='afterFilePlacement' && args.kind==='move')process.kill(process.pid,'SIGKILL');}});
    await d.run();`,
      f.root
    ],
    { cwd: repo, windowsHide: true }
  );
  assert.notEqual(child.status, 0);
  assert.equal(
    f.library.read((db) => db.prepare("SELECT count(*) AS n FROM file_commits WHERE stage='moving'").get().n),
    1
  );
  assert.equal(fs.existsSync(old), false);
  f.start();
  await f.d.run();
  assert.equal(fs.statSync(f.file('image-0'), { bigint: true }).ino, stat.ino);
  assert.equal(f.info().workName, '移夹');
  fs.renameSync(f.file('image-0'), f.file('image-0') + '.backup');
  fs.writeFileSync(f.file('image-0'), small);
  f.command('set-tags', { id: '71', tags: ['待核对'] });
  await f.d.run();
  assert.notDeepEqual(f.info().localTags, ['待核对']);
  assert.match(
    f.library.read((db) => db.prepare("SELECT error FROM archive_state WHERE work_id='71'").get().error),
    /核对|登记/
  );
});

for (const mutation of ['added', 'same-bytes-replaced', 'modified', 'missing']) {
  test('restart before journaled rename rejects a source whose inventory was ' + mutation, async (t) => {
    const f = fixture(t, album);
    f.ipc.download(['71'], { scope: 'missing' });
    await f.d.run();
    const file = f.file('image-0'),
      directory = path.dirname(file);
    f.library.write((db) =>
      db.exec("UPDATE works SET title='移动后',body=json_set(body,'$.name','移动后') WHERE id='71'")
    );
    await f.close();
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import {openLibrary} from './server/library.mjs';
      import {createDownloads} from './server/downloads.mjs';
      const root=process.argv[1],library=openLibrary({root}),d=createDownloads({root,library,
        fileHook(name){if(name==='beforeFileMove')process.kill(process.pid,'SIGKILL');}});
      await d.run();`,
        f.root
      ],
      { cwd: repo, windowsHide: true }
    );
    assert.notEqual(child.status, 0);
    assert.equal(
      f.library.read((db) => db.prepare("SELECT COUNT(*) n FROM file_commits WHERE stage='moving'").get().n),
      1
    );
    if (mutation === 'added') fs.writeFileSync(path.join(directory, '外部文件'), '保留');
    if (mutation === 'same-bytes-replaced') {
      fs.renameSync(file, path.join(path.dirname(directory), '原图'));
      fs.copyFileSync(path.join(path.dirname(directory), '原图'), file);
    }
    if (mutation === 'modified') fs.writeFileSync(file, Buffer.alloc(small.length, 7));
    if (mutation === 'missing') fs.renameSync(file, path.join(path.dirname(directory), '原图'));
    f.start();
    await f.d.run();
    assert.equal(fs.existsSync(directory), true);
    assert.equal(fs.existsSync(path.join(path.dirname(directory), '移动后-作者')), false);
    assert.equal(
      f.library.read(
        (db) =>
          db.prepare("SELECT revision<>completed dirty FROM archive_state WHERE work_id='71'").get().dirty
      ),
      1
    );
    if (mutation === 'added') {
      assert.equal(fs.readFileSync(path.join(directory, '外部文件'), 'utf8'), '保留');
      fs.renameSync(path.join(directory, '外部文件'), path.join(path.dirname(directory), '用户另存'));
      await f.d.run();
      assert.equal(f.info().workName, '移动后');
    }
  });
}

test('repeated folder discovery and count-only updates perform no archive hashing; real presence and name changes reconcile', async (t) => {
  let entries = [{ id: '88', name: '归档夹', count: 1 }];
  let digests = 0;
  const f = fixture(t, album, {
    source: { account: () => ({ uid: '42', authEpoch: 'fixture' }), discoverFolders: async () => entries },
    fileHook(name) {
      if (name === 'beforeResourceVerify') digests++;
    }
  });
  await f.discover();
  f.command('add-folders', { ids: ['88'] });
  f.library.write((db) => db.exec("INSERT INTO source_members VALUES('folder:88','71',0,0)"));
  f.ipc.download(['71'], { scope: 'missing' });
  await f.d.run();
  const revision = () =>
    f.library.read(
      (db) => db.prepare("SELECT revision FROM archive_state WHERE work_id='71'").get()?.revision ?? 0
    );
  const baseline = revision();
  let wakes = 0;
  const drain = f.d.run;
  f.d.run = () => {
    wakes++;
    return drain();
  };
  for (const count of [1, 1, 9]) {
    entries = [{ ...entries[0], count }];
    digests = 0;
    await f.discover();
    assert.equal(wakes, 0);
    await drain();
    assert.equal(revision(), baseline);
    assert.equal(digests, 0);
  }
  entries = [{ ...entries[0], name: '新夹名' }];
  await f.discover();
  await f.d.run();
  const renamed = revision();
  assert.ok(renamed > baseline);
  assert.ok(digests > 0);
  assert.equal(f.info().collection, '新夹名');
  entries = [];
  digests = 0;
  await f.discover();
  await f.d.run();
  assert.ok(revision() > renamed);
  assert.ok(digests > 0);
});

test('multiple author sources use sorted IDs after membership recreation, and later works share the original author directory', async (t) => {
  const f = fixture(t, album);
  f.library.write((db) =>
    db.exec(
      "DELETE FROM source_members; INSERT INTO read_sources VALUES('author:B','42','作者B','{}',1,0),('author:A','42','原昵称','{}',1,0); INSERT INTO source_members VALUES('author:B','71',0,0),('author:A','71',0,0)"
    )
  );
  f.ipc.download(['71'], { scope: 'missing' });
  await f.d.run();
  const first = f.info();
  assert.equal(first.collectionId, 'author:A');
  const authorDir = path.dirname(path.dirname(f.file('image-0')));
  const second = { ...album, id: '73', name: '另外的作品' };
  f.library.write((db) => {
    db.prepare('INSERT INTO works VALUES(?,?,?)').run(second.id, second.name, JSON.stringify(second));
    db.exec(
      "DELETE FROM source_members; INSERT INTO source_members VALUES('author:A','71',0,0),('author:B','71',0,0),('author:B','73',1,0),('author:A','73',1,0); UPDATE read_sources SET name='新昵称' WHERE source_id='author:A'"
    );
  });
  f.ipc.download(['73'], { scope: 'missing' });
  await f.d.run();
  const secondRow = f.d.store.resources('73').find((row) => row.key === 'metadata');
  const secondPath = path.join(f.d.layout.media, secondRow.relative_path);
  assert.equal(path.dirname(path.dirname(secondPath)), authorDir);
  assert.equal(JSON.parse(fs.readFileSync(secondPath)).collectionId, 'author:A');
  assert.equal(JSON.parse(fs.readFileSync(secondPath)).collection, '新昵称');
});

test('an author-owned archive keeps its physical directory after collection and title changes', async (t) => {
  const f = fixture(t, album);
  f.library.write((db) =>
    db.exec(
      "DELETE FROM source_members; INSERT INTO read_sources VALUES('author:creator1','42','昵称','{}',1,0); INSERT INTO source_members VALUES('author:creator1','71',0,0)"
    )
  );
  f.ipc.download(['71'], { scope: 'missing' });
  await f.d.run();
  const original = f.file('image-0');
  assert.equal(f.info().collectionId, 'author:creator1');
  const other = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {openLibrary} from './server/library.mjs';
    import {createDownloads} from './server/downloads.mjs';
    const root=process.argv[1],library=openLibrary({root});
    try{createDownloads({root,library});process.exitCode=1;}catch(e){process.exitCode=/locked|busy/i.test(e.message)?0:2;}`,
      f.root
    ],
    { cwd: repo, windowsHide: true }
  );
  assert.equal(other.status, 0);
  f.library.write((db) =>
    db.exec(
      "INSERT INTO source_members VALUES('total','71',0,0); UPDATE read_sources SET name='新昵称' WHERE source_id='author:creator1'; UPDATE works SET title='新名称',body=json_set(body,'$.name','新名称') WHERE id='71'"
    )
  );
  await f.d.run();
  assert.equal(f.file('image-0'), original);
  assert.equal(f.info().workName, '新名称');
  assert.equal(f.info().collection, '新昵称');
  assert.equal(f.info().collectionId, 'author:creator1');
});

const python =
  process.env.CANGXIA_TEST_COVER_PYTHON ||
  (process.platform === 'win32' &&
  fs.existsSync(
    path.join(repo, '.test-output/baseline-08e6436/.test-output/cover-build-venv/Scripts/python.exe')
  )
    ? path.join(repo, '.test-output/baseline-08e6436/.test-output/cover-build-venv/Scripts/python.exe')
    : null);
test(
  'bulk NAS repair runs original matcher, compares native crop and bytes, rejects unrelated images, prefers full platform pixels',
  { skip: !python && 'requires pinned OpenCV runtime' },
  async (t) => {
    const files = fs.mkdtempSync(path.join(tmpdir(), 'cx-hd-fixtures-'));
    t.after(() => fs.rmSync(files, { recursive: true, force: true, maxRetries: 5 }));
    execFileSync(python, ['-I', path.join(repo, 'tests/server-edition/fixtures/archive-cover.py'), files], {
      windowsHide: true
    });
    const film = {
      id: '72',
      name: '高清视频',
      type: 'video',
      author: { nickname: '合成' },
      videoUrls: ['https://v3.douyinvod.com/video'],
      coverUrls: ['https://p3.douyinpic.com/ref']
    };
    for (const [mode, reference] of [
      ['only-video-platform', 'reference'],
      ['only-video-frame', 'reference'],
      ['only-video-wrong', 'wrong'],
      ['reread-disjoint', 'reference'],
      ['reread-retained', 'reference'],
      ['late-disjoint', 'reference'],
      ['reread-fallback', 'reference'],
      ['recovery-disjoint', 'reference'],
      ['parsed-upgrade', 'reference'],
      ['changed-video', 'reference'],
      ['disjoint-cover', 'reference'],
      ['frame', 'reference'],
      ['reject', 'wrong'],
      ['platform', 'reference'],
      ['original', 'hd'],
      ['swapped', 'reference'],
      ['cancel', 'reference']
    ]) {
      const onlyVideo = mode.startsWith('only-video');
      let late = false;
      const parsed = (extra = false, changed = false) =>
        parseSourceDetail({
          workId: '72',
          status: 200,
          observedAt: '2026-11-26T10:00:00Z',
          text: JSON.stringify({
            aweme_detail: {
              aweme_id: '72',
              item_title: '高清视频',
              author: { uid: '12', nickname: '合成' },
              video: {
                vid: changed ? 'new-video' : 'same-video',
                play_addr: { uri: 'video-id', url_list: film.videoUrls },
                cover: {
                  uri: mode === 'reread-fallback' && extra ? 'alternate-page' : 'page-cover',
                  url_list:
                    (mode === 'disjoint-cover' ||
                      mode === 'reread-disjoint' ||
                      mode === 'reread-fallback' ||
                      late) &&
                    extra
                      ? ['https://p3.douyinpic.com/other-page']
                      : film.coverUrls
                },
                ...(extra
                  ? { origin_cover: { uri: 'origin-hd', url_list: ['https://p3.douyinpic.com/hd'] } }
                  : mode === 'reread-fallback'
                    ? { origin_cover: { uri: 'origin-hd', url_list: ['https://p3.douyinpic.com/tiny'] } }
                    : {})
              }
            }
          })
        });
      const realParser = [
        'parsed-upgrade',
        'changed-video',
        'disjoint-cover',
        'reread-disjoint',
        'reread-retained',
        'late-disjoint',
        'reread-fallback',
        'recovery-disjoint'
      ].includes(mode);
      const work = realParser ? parsed() : structuredClone(film);
      if (realParser)
        assert.equal(
          parsed(true).mediaQuality.identities.cover === work.mediaQuality.identities.cover,
          mode === 'reread-fallback'
        );
      let high = false,
        repair = false,
        fetchedVideo = 0;
      let intercepted = false;
      const f = fixture(t, work, {
        coverPython: python,
        fileHook(name, event) {
          if (
            mode === 'recovery-disjoint' &&
            !intercepted &&
            name === 'beforeFormalPlacement' &&
            path.basename(event.file).startsWith('高清封面-')
          ) {
            intercepted = true;
            throw Object.assign(Error('simulated storage interruption'), { code: 'EIO' });
          }
          if (
            mode === 'late-disjoint' &&
            !late &&
            name === 'beforeFormalPlacement' &&
            path.basename(event.file).startsWith('高清封面-')
          ) {
            late = true;
            f.library.write((db) =>
              saveWorks(db, { works: [parsed(true)], aux: { audioSourceHints: [], creatorProfiles: [] } })
            );
          }
          if (
            intercepted ||
            !['swapped', 'cancel'].includes(mode) ||
            name !== 'beforeFormalPlacement' ||
            !path.basename(event.file).startsWith('视频截帧-')
          )
            return;
          intercepted = true;
          if (mode === 'cancel') f.command('control-download', { action: 'cancel', jobId: 'hd:72' });
          else {
            const original = f.file('video');
            fs.renameSync(original, original + '.saved');
            fs.copyFileSync(original + '.saved', original);
          }
        },
        source: {
          account: () => ({ uid: '42', authEpoch: 'fixture' }),
          readDetail: async () => parsed(true),
          readDownloadDetail: async () =>
            realParser
              ? parsed(repair, repair && mode === 'changed-video')
              : {
                  ...work,
                  coverUrls: high ? ['https://p3.douyinpic.com/hd', ...work.coverUrls] : work.coverUrls
                }
        },
        fetchAsset: async (url) => {
          if (url.endsWith('/tiny')) return new Response(small, { headers: { 'Content-Type': 'image/png' } });
          if (url.endsWith('/video')) fetchedVideo++;
          else if (onlyVideo && !repair) return new Response(null, { status: 404 });
          return new Response(
            fs.readFileSync(
              path.join(
                files,
                url.endsWith('/video') ? 'video.mp4' : url.endsWith('/hd') ? 'hd.png' : reference + '.png'
              )
            ),
            { headers: { 'Content-Type': url.endsWith('/video') ? 'video/mp4' : 'image/png' } }
          );
        }
      });
      f.ipc.download(['72'], { scope: 'missing' });
      await f.d.run();
      assert.equal(f.state('72').state, onlyVideo ? 'failed' : 'complete', JSON.stringify(f.state('72')));
      assert.equal(
        f.rows().some((r) => r.key === 'cover'),
        !onlyVideo
      );
      if (mode.startsWith('reread-')) {
        const { jobId } = f.command('start-read', { source: { kind: 'link', id: '72' }, mode: 'full' });
        let job;
        for (let n = 0; n < 600; n++) {
          job = f.query('read-job', { jobId });
          if (job.status === 'complete') break;
          await delay(10);
        }
        assert.equal(job.status, 'complete', JSON.stringify(job));
        const row = f.library.read((db) =>
          JSON.parse(db.prepare("SELECT body FROM works WHERE id='72'").get().body)
        );
        assert.equal(row.mediaQuality.identities.cover, parsed(true).mediaQuality.identities.cover);
        assert.equal(
          row.coverVariants.some((v) => v.urls.includes(film.coverUrls[0])),
          mode === 'reread-retained'
        );
        assert.equal(
          digest(fs.readFileSync(f.file('cover'))),
          digest(fs.readFileSync(path.join(files, 'reference.png')))
        );
      }
      repair = true;
      high = mode === 'platform' || mode === 'only-video-platform';
      const { revision, scope } = f.query('list-works', { source: 'all' });
      const enqueue = () =>
        f.ipc.catalogueAction('repair-cover', {
          source: 'all',
          revision,
          scope,
          all: true,
          ids: [],
          confirmedCount: 1
        });
      if (mode === 'reread-disjoint' || mode === 'reread-fallback') {
        assert.throws(enqueue, (e) => e.code === 'NAS_MEDIA_SET_REVIEW');
        assert.equal(f.query('work-detail', { id: '72' }).hdCover, null);
        assert.equal(
          f.rows().some((r) => r.key === 'cover-hd'),
          false
        );
        continue;
      }
      const response = enqueue();
      assert.equal(response.queued, 1);
      await f.d.run();
      if (mode === 'recovery-disjoint') {
        assert.equal(f.state('hd:72').reason.code, 'EIO');
        assert.equal(
          f.d.store.fileCommits('72').filter((c) => c.stage === 'verified' && c.body.key === 'cover-hd')
            .length,
          1
        );
        await f.close();
        late = true;
        f.library.write((db) =>
          saveWorks(db, { works: [parsed(true)], aux: { audioSourceHints: [], creatorProfiles: [] } })
        );
        f.start();
        f.command('control-download', { action: 'retry', jobId: 'hd:72' });
        await f.d.run();
        assert.equal(
          fs.readdirSync(path.dirname(f.file('cover'))).some((name) => name.startsWith('高清封面-')),
          false
        );
      }
      const outcome = f.state('hd:72');
      assert.equal(fetchedVideo, 1);
      if (['changed-video', 'disjoint-cover', 'late-disjoint', 'recovery-disjoint'].includes(mode)) {
        assert.equal(outcome.reason?.code, 'NAS_MEDIA_SET_REVIEW');
        assert.equal(f.query('work-detail', { id: '72' }).hdCover, null);
        assert.equal(
          f.rows().some((r) => r.key === 'cover-hd'),
          false
        );
        continue;
      }
      if (['swapped', 'cancel'].includes(mode)) {
        assert.equal(intercepted, true);
        assert.equal(f.query('work-detail', { id: '72' }).hdCover, null);
        assert.equal(
          f.rows().some((r) => r.key === 'cover-hd'),
          false
        );
        assert.equal(
          mode === 'cancel' ? outcome.downloadState : outcome.reason.code,
          mode === 'cancel' ? 'cancelled' : 'NAS_FILE_REVIEW'
        );
        continue;
      }
      if (mode === 'reject' || mode === 'only-video-wrong') {
        assert.equal(outcome.reason.code, 'NAS_COVER_REJECTED', JSON.stringify(outcome));
        assert.equal(f.query('work-detail', { id: '72' }).hdCover, null);
        assert.equal(
          f.rows().some((r) => r.key === 'cover-hd'),
          false
        );
        continue;
      }
      assert.equal(outcome.state, 'complete', JSON.stringify(outcome));
      if (onlyVideo) {
        assert.equal(f.state('72').state, 'failed');
        assert.equal(Boolean(f.query('work-detail', { id: '72' }).downloaded), false);
        assert.equal(
          f.rows().some((r) => r.key === 'cover'),
          false
        );
      }
      const hd = f.info().hdCover;
      assert.deepEqual(hd, f.query('work-detail', { id: '72' }).hdCover);
      if (mode === 'frame' || mode === 'only-video-frame') {
        const desktop = JSON.parse(fs.readFileSync(path.join(files, 'golden.json')));
        assert.deepEqual(hd.crop, desktop.crop);
        assert.equal(hd.frame, desktop.frame);
        assert.equal(hd.sha256, digest(fs.readFileSync(path.join(files, 'desktop.png'))));
      } else {
        assert.equal(hd.source, 'platform');
        assert.equal(hd.width, 960);
        assert.equal(hd.key, mode === 'original' ? 'cover' : 'cover-hd');
      }
      assert.equal(hd.sha256, digest(fs.readFileSync(f.file(hd.key))));
    }
  }
);
