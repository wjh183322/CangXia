import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openLibrary } from '../../server/library.mjs';
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
      ['frame', 'reference'],
      ['reject', 'wrong'],
      ['platform', 'reference'],
      ['original', 'hd'],
      ['swapped', 'reference'],
      ['cancel', 'reference']
    ]) {
      const work = structuredClone(film);
      let high = false;
      let intercepted = false;
      const f = fixture(t, work, {
        coverPython: python,
        fileHook(name, event) {
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
          account: () => ({ uid: '42' }),
          readDownloadDetail: async () => ({
            ...work,
            coverUrls: high ? ['https://p3.douyinpic.com/hd'] : work.coverUrls
          })
        },
        fetchAsset: async (url) =>
          new Response(
            fs.readFileSync(
              path.join(
                files,
                url.endsWith('/video') ? 'video.mp4' : url.endsWith('/hd') ? 'hd.png' : reference + '.png'
              )
            ),
            { headers: { 'Content-Type': url.endsWith('/video') ? 'video/mp4' : 'image/png' } }
          )
      });
      f.ipc.download(['72'], { scope: 'missing' });
      await f.d.run();
      assert.equal(f.state('72').state, 'complete', JSON.stringify(f.state('72')));
      high = mode === 'platform';
      const { revision, scope } = f.query('list-works', { source: 'all' });
      const response = f.ipc.catalogueAction('repair-cover', {
        source: 'all',
        revision,
        scope,
        all: true,
        ids: [],
        confirmedCount: 1
      });
      assert.equal(response.queued, 1);
      await f.d.run();
      const outcome = f.state('hd:72');
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
      if (mode === 'reject') {
        assert.equal(outcome.reason.code, 'NAS_COVER_REJECTED', JSON.stringify(outcome));
        assert.equal(f.query('work-detail', { id: '72' }).hdCover, null);
        assert.equal(
          f.rows().some((r) => r.key === 'cover-hd'),
          false
        );
        continue;
      }
      assert.equal(outcome.state, 'complete', JSON.stringify(outcome));
      const hd = f.info().hdCover;
      assert.deepEqual(hd, f.query('work-detail', { id: '72' }).hdCover);
      if (mode === 'frame') {
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
