import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { Collector } from './account-collector.mjs';
import { AuthVault } from './auth-data.mjs';
import { SystemBrowser } from './system-browser.mjs';
import { DownloadQueue } from './downloads.mjs';
import { isDouyinURL, requireInside } from './model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes('--smoke');
const sampleProbe = process.argv.includes('--probe-sample');
if (smoke || sampleProbe) app.setPath('userData', path.resolve('.test-output', sampleProbe ? 'native-probe-profile' : 'native-smoke-profile'));
app.setName('藏匣');
if(!app.requestSingleInstanceLock())app.exit(0);
protocol.registerSchemesAsPrivileged([{ scheme: 'app-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let window, store, collector, queue, timer, quitting=false;
function snapshot() { return { ...store.snapshot(), collector: { ...collector.status, busy: collector.busy }, queue: queue.state() }; }
function notify() {
  if (quitting) return;
  clearTimeout(timer); timer = setTimeout(() => { if (window && !window.isDestroyed()) window.webContents.send('cangxia:change', snapshot()); }, 120);
}
function ids(value) {
  if (!Array.isArray(value) || value.length > 100000 || value.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) throw new Error('作品选择无效');
  return [...new Set(value)];
}
function handler(name, action) {
  ipcMain.handle('cangxia:' + name, async (event, ...args) => {
    try {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效调用来源');
      return { ok: true, data: await action(...args) };
    } catch (error) { return { ok: false, error: error.message || '操作未完成' }; }
  });
}
function ensureIdle() { if (collector.busy || queue.running || collector.waiters.size) throw new Error('请先暂停下载并等待当前读取结束，再进行此操作'); }

app.whenReady().then(async () => {
try {
  const profile = app.getPath('userData');
  store = await Store.open(path.join(profile, 'library.sqlite'), path.join(app.getPath('downloads'), '藏匣'));
  const httpProfile=session.fromPartition('cangxia-http');
  const browser=new SystemBrowser(path.join(profile,'system-browser'),{headless:smoke||sampleProbe});
  collector = new Collector(store, notify,{profile:httpProfile,vault:new AuthVault(path.join(profile,'login-state.bin'),safeStorage),browser});
  await collector.ready;
  queue = new DownloadQueue(store, collector, (url, options) => collector.fetchMedia(url, options), notify);
  collector.onAccessHold=()=>queue.pause();
  const cacheRoot = path.join(profile, 'covers'); fs.mkdirSync(cacheRoot, { recursive: true });
  const cachePending = new Map();
  protocol.handle('app-media', async request => {
    try {
      const u = new URL(request.url); const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const [id, filename] = parts; if (!/^\d+$/.test(id || '')) return new Response('', { status: 404 });
      let file;
      if (u.hostname === 'stream') {
        const work=store.work(id);const source=work?.videoUrls?.[0];if(!source)return new Response('',{status:404});
        const range=request.headers.get('range');return await collector.fetchMedia(source,{signal:AbortSignal.timeout(120000),headers:range?{Range:range}:{}});
      } else if (u.hostname === 'asset') {
        const d = store.download(id); const asset = d?.assets.find(a => a.file === filename);
        if (!asset || !store.assetExists(d, asset)) return new Response('', { status: 404 });
        file = requireInside(d.path, path.join(d.path, asset.file));
      } else if (u.hostname === 'cover') {
        const d = store.download(id), cover = d?.assets.find(a => a.key === 'cover' || a.key === 'image-0');
        if (cover && store.assetExists(d, cover)) file = requireInside(d.path, path.join(d.path, cover.file));
        else {
          file = requireInside(cacheRoot, path.join(cacheRoot, id + '.jpg'));
          if (!fs.existsSync(file)) {
            if (!cachePending.has(id)) cachePending.set(id, (async () => {
              const w = store.work(id); if (!w?.thumbnail) throw new Error('无封面');
              const r = await collector.fetchMedia(w.thumbnail, { signal: AbortSignal.timeout(12000) });
              if (!r.ok || !r.headers.get('content-type')?.startsWith('image/')) throw new Error('封面不可用');
              const bytes = Buffer.from(await r.arrayBuffer()); if (bytes.length > 20000000) throw new Error('封面过大');
              fs.writeFileSync(file, bytes);
            })().finally(() => cachePending.delete(id)));
            await cachePending.get(id);
          }
        }
      } else return new Response('', { status: 404 });
      return net.fetch(pathToFileURL(file).href, { headers: request.headers });
    } catch { return new Response('', { status: 404 }); }
  });
  window = new BrowserWindow({ title: '藏匣', icon:path.join(here,'..','assets','icon.ico'), width: 1440, height: 940, minWidth: 1000, minHeight: 700, show: !smoke && !sampleProbe, backgroundColor: '#f7f8fa', autoHideMenuBar: true, webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  handler('state', () => snapshot());
  handler('openAccount', preferred => {ensureIdle();return collector.open(preferred);});
  handler('finishLogin', () => {ensureIdle();return collector.finishLogin();});
  handler('importLoginConfig', async()=>{ensureIdle();const result=await dialog.showOpenDialog(window,{title:'选择参考工具的 config.json（仅在本机读取）',filters:[{name:'JSON 配置',extensions:['json']}],properties:['openFile']});if(result.canceled)return false;const file=result.filePaths[0];if(fs.statSync(file).size>2*1024*1024)throw new Error('配置文件过大');await collector.importConfig(fs.readFileSync(file,'utf8'));return true;});
  handler('sync', (discoverOnly = false) => { ensureIdle(); void collector.sync({ discoverOnly: !!discoverOnly }); return true; });
  handler('stopSync', () => collector.stop());
  handler('addCollections', selected => { ensureIdle(); store.setAdded(ids(selected)); notify(); return true; });
  handler('importLink', async text => { ensureIdle(); if (typeof text !== 'string' || text.length > 6000) throw new Error('链接内容无效'); const w = await collector.importLink(text); notify(); return w?.id; });
  handler('download', selected => { if (collector.busy || collector.waiters.size) throw new Error('请等待读取完成再下载'); queue.enqueue(ids(selected)); return true; });
  handler('pause', () => queue.pause());
  handler('resume', () => { if (collector.busy) throw new Error('请等待同步完成'); queue.resume(); });
  handler('refreshFiles', () => { notify(); return snapshot(); });
  handler('chooseRoot', async () => {
    ensureIdle();
    if (store.all('downloads').length) throw new Error('媒体库已有作品。此版本不支持移动整个媒体库，请保留当前根目录。');
    const r = await dialog.showOpenDialog(window, { title: '选择下载根目录', defaultPath: store.root, properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0]) { store.setSetting('root', r.filePaths[0]); store.save(); notify(); }
    return store.root;
  });
  handler('openRoot', async () => { fs.mkdirSync(store.root, { recursive: true }); const error = await shell.openPath(store.root); if (error) throw new Error(error); });
  handler('openFolder', async id => {
    ids([id]); const d = store.download(id); if (!d) throw new Error('作品尚未下载'); store.assertDirectory(d.path);
    const error = await shell.openPath(d.path); if (error) throw new Error(error);
  });
  handler('openOriginal', async id => { ids([id]); const url = store.work(id)?.url; if (!isDouyinURL(url)) throw new Error('作品链接无效'); await collector.openOriginal(url); });
  handler('setTags', (id, tags) => {
    ids([id]); if (!Array.isArray(tags) || tags.length > 100 || tags.some(t => typeof t !== 'string' || t.length > 80)) throw new Error('标签格式无效');
    const normalized = [...new Set(tags.map(t => t.trim().replace(/^#/, '')).filter(Boolean))];
    store.put('local_tags', id, { id, tags: normalized }); store.save();
    const d = store.download(id), w = store.work(id);
    if (d && w && fs.existsSync(d.path)) {
      store.assertDirectory(d.path); const meta = path.join(d.path, '作品信息.json');
      fs.writeFileSync(meta + '.part', JSON.stringify(queue.metadata(w,d), null, 2)); fs.renameSync(meta + '.part', meta);
      d.assets = [...d.assets.filter(a => a.key !== 'metadata'), { key: 'metadata', file: '作品信息.json', kind: 'metadata', size: fs.statSync(meta).size }]; store.put('downloads', id, d); store.save();
    }
    notify();
  });
  handler('checkSource', async id => { ids([id]); ensureIdle(); try { await collector.resolveWork(id); } finally { notify(); } });
  handler('deleteWorks', async selected => {
    ensureIdle(); const records = ids(selected).map(id => store.download(id)).filter(Boolean);
    if (!records.length) return false;
    const invalid = records.some(d => store.work(d.id)?.remoteState === 'unavailable');
    const result = await dialog.showMessageBox(window, { type: 'warning', title: '删除本地作品', message: invalid ? '原作品已失效，删除本地副本后将无法从抖音重新下载。确定删除吗？' : `确定删除这 ${records.length} 个作品的本地文件吗？`, detail: '将删除视频、图片及作品信息，并撤销“已下载”标记。抖音账号收藏不受影响。文件会移入系统回收站。', buttons: ['取消', '删除本地文件'], defaultId: 0, cancelId: 0, noLink: true });
    if (result.response !== 1) return false;
    const failed = [];
    for (const d of records) try {
      store.assertDirectory(d.path);
      if (fs.existsSync(d.path)) await shell.trashItem(d.path);
      store.db.run('DELETE FROM downloads WHERE id=?', [d.id]);
    } catch (e) { failed.push(e.message); }
    store.save(); notify(); if (failed.length) throw new Error(`部分文件删除失败：${failed.join('；')}`); return true;
  });
  if (process.env.CANGXIA_DEV === '1') await window.loadURL('http://127.0.0.1:5173');
  else await window.loadFile(path.join(here, '..', 'dist', 'index.html'));
  window.on('focus', notify);
  window.on('closed',()=>{if(!quitting)app.quit();});
  if (smoke) {
    const native = await browser.launch('about:blank');
    const info = await native.send('Browser.getVersion');
    const noImplicitLogin = !(await collector.isAuthenticated());
    const noCollectionRead = collector.diagnostics.length===0;
    fs.writeFileSync('.test-output/login-isolation-result.json',JSON.stringify({systemBrowser:browser.name,userAgent:info.userAgent,noImplicitLogin,noCollectionRead},null,2));
    if(!noImplicitLogin||!noCollectionRead)throw new Error('本机浏览器隔离检查未通过');
    await browser.close();
    await new Promise(r => setTimeout(r, 1800));
    const text = await window.webContents.executeJavaScript('document.body.innerText');
    const screenshot = await window.webContents.capturePage();
    fs.mkdirSync('.test-output', { recursive: true }); fs.writeFileSync('.test-output/desktop-smoke.png', screenshot.toPNG());
    fs.writeFileSync('.test-output/smoke-result.json', JSON.stringify({ ok: text.includes('藏匣') && text.includes('账号收藏'), text, electron: process.versions.electron }, null, 2));
    app.quit();
  }
  if (sampleProbe) {
    store.setSetting('root', path.resolve('.test-output/native-sample-downloads')); store.save();
    try {
      const w = await collector.resolveWork('7683829929179724518');
      fs.writeFileSync('.test-output/sample-metadata.json', JSON.stringify({ id:w.id, name:w.name, tags:w.tags, coverSource:w.coverSource, covers:collector.detailCoverInfo, coverCandidates:w.coverUrls.length, videoCandidates:w.videoUrls.length, author:w.author, width:w.width, height:w.height }, null, 2));
      queue.enqueue([w.id]);
      while (queue.running) await new Promise(r => setTimeout(r, 1000));
      fs.writeFileSync('.test-output/sample-result.json', JSON.stringify({ queue: queue.state(), work: store.snapshot().works.find(x => x.id === w.id) }, null, 2));
    } catch (e) {
      const page = collector.window?.webContents;
      const text = page ? await page.executeJavaScript('document.body.innerText').catch(()=>'(page unavailable)') : '';
      fs.writeFileSync('.test-output/sample-result.json', JSON.stringify({ error: e.message, diagnostics:collector.diagnostics, page:text }, null, 2));
      if (page) { const img=await page.capturePage(); fs.writeFileSync('.test-output/probe-page.png',img.toPNG()); }
    }
    app.quit();
  }
} catch (error) {
  if (smoke || sampleProbe) { fs.mkdirSync('.test-output', {recursive:true}); fs.writeFileSync('.test-output/startup-error.txt', error.stack || error.message); }
  else dialog.showErrorBox('藏匣启动失败', error.message);
  app.exit(1);
}
});
app.on('window-all-closed', () => app.quit());
app.on('second-instance',()=>{if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}});
app.on('before-quit', event => {
  if(quitting)return;
  event.preventDefault();quitting=true;queue?.pause();const browserClose=collector?.dispose();clearTimeout(timer);
  void (async()=>{
    for(let i=0;i<30&&queue?.running;i++)await new Promise(r=>setTimeout(r,100));
    await Promise.race([browserClose||Promise.resolve(),new Promise(r=>setTimeout(r,3000))]);
    store?.close();app.exit(0);
  })();
});
