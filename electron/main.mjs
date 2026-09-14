import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session, safeStorage, screen } from 'electron';
import { randomUUID } from 'node:crypto';
import { listDirectory, makeDirectory, absolutePath } from './file-browser.mjs';
import { inspectRepairs } from './repair-check.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { NasLibrary } from './nas-library.mjs';
import { Collector } from './account-collector.mjs';
import { AuthVault } from './auth-data.mjs';
import { SystemBrowser } from './system-browser.mjs';
import { QrLogin } from './qr-login.mjs';
import { DownloadQueue } from './downloads.mjs';
import { isDouyinURL, requireInside } from './model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes('--smoke');
const sampleProbe = process.argv.includes('--probe-sample');
const qrProbe = process.argv.includes('--probe-qr');
if (smoke || sampleProbe || qrProbe) app.setPath('userData', path.resolve('.test-output', qrProbe ? 'qr-probe-profile' : sampleProbe ? 'native-probe-profile' : 'native-smoke-profile'));
app.setName('藏匣NAS版');
if (!smoke && !sampleProbe && !qrProbe) app.setPath('userData', path.join(app.getPath('appData'), '藏匣NAS版'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
app.setPath('sessionData', app.getPath('userData'));
if(!app.requestSingleInstanceLock())app.exit(0);
protocol.registerSchemesAsPrivileged([{ scheme: 'app-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let window, store, collector, queue, qrLogin, timer, nas, localStore, nasBusy=false, nasMutation=false, quitting=false;
const deleteIntents=new Map();
const writes=new Set(['sync','addCollections','importLink','download','resume','clearCompleted','setTags','checkSource','prepareDelete','confirmDelete','startRepairs','chooseRoot','restoreNasDeleted']);
function snapshot() { return { ...store.snapshot(), collector: { ...collector.status, busy: collector.busy||nasBusy }, queue: queue.state(), qr:qrLogin?.state(), storage:{...nas?.status,busy:nasBusy} }; }
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
    let ownsMutation=false;
    try {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效调用来源');
      if(nasBusy&&!['state','pause','stopSync','cancelQrLogin','openRoot'].includes(name))throw new Error('正在处理 NAS 媒体库，请等待完成');
      if(nasMutation&&!['state','pause','stopSync','cancelQrLogin'].includes(name))throw new Error('正在保存 NAS 修改，请稍候');
      if(store.nas&&writes.has(name)){nas.assertWritable();ensureIdle();}
      if(store.nas&&writes.has(name)){nasMutation=true;ownsMutation=true;}
      const result=await action(...args);
      if(store.nas&&writes.has(name)&&!['sync','download','resume','startRepairs','prepareDelete'].includes(name)&&!queue.running){try{await nas.settle();}catch(e){nas.fail(e.message);throw e;}}
      return { ok: true, data:result };
    } catch (error) { return { ok: false, error: error.message || '操作未完成' }; }
    finally{if(ownsMutation){nasMutation=false;notify();}}
  });
}
function ensureIdle() { if (nasBusy||collector.busy || queue.running || collector.waiters.size) throw new Error('请先暂停下载并等待当前读取结束，再进行此操作'); }

app.whenReady().then(async () => {
try {
  const profile = app.getPath('userData');
  store = await Store.open(path.join(profile, 'library.sqlite'), path.join(app.getPath('downloads'), '藏匣NAS版'));
  localStore=store;
  await localStore.pruneDeletedDownloads();
  nas=new NasLibrary(profile,notify,()=>{collector?.stop();queue?.pause();});
  try{store=await nas.restore()||localStore;}catch(e){nas.status={mode:'local',backupDeferred:true,message:'NAS 无法打开，已返回本机库：'+e.message};}
  const httpProfile=session.fromPartition('cangxia-http');
  const browser=new SystemBrowser(path.join(profile,'system-browser'),{headless:smoke||sampleProbe});
  collector = new Collector(store, notify,{profile:httpProfile,vault:new AuthVault(path.join(profile,'login-state.bin'),safeStorage),browser});
  await collector.ready;
  queue = new DownloadQueue(store, collector, (url, options) => collector.fetchMedia(url, options), notify);
  function attach(next){store=next;collector.store=next;queue=new DownloadQueue(next,collector,(url,options)=>collector.fetchMedia(url,options),notify);if(next.nas)queue.remoteSaveWork=(job,signal)=>nas.saveWork(job,signal,collector,(url,options)=>collector.fetchMedia(url,options),()=>queue.emit());deleteIntents.clear();notify();}
  attach(store);nas.onReload=attach;
  nas.onPruned=()=>{if(queue.store===nas.store&&!queue.running)queue.jobs=store.getSetting('downloadJobs')||[];};
  async function switchNas(action){
    ensureIdle();if(store.nas&&nas.writable)try{await nas.settle();}catch(e){nas.fail(e.message);}
    const old=store,previous={root:nas.root,libraryId:nas.libraryId,status:{...nas.status},assets:nas.assetStates};nasBusy=true;notify();
    try{const next=await action();attach(next);if(old!==localStore&&old!==next)old.close();await collector.profile.clearStorageData({storages:['cookies']});collector.status.connected=false;await collector.restore();return snapshot();}
    catch(e){if(old.nas){nas.store=old;nas.root=previous.root;nas.libraryId=previous.libraryId;nas.assetStates=previous.assets;nas.status={...previous.status,connected:false,writable:false,message:e.message};}else await nas.leave();throw e;}
    finally{nasBusy=false;notify();}
  }
  let nasPlan;
  handler('planNas',async value=>{ensureIdle();const plan=await nas.migrationPlan(store,absolutePath(value));queue.jobs=store.getSetting('downloadJobs')||[];notify();nasPlan={...plan,token:randomUUID(),expires:Date.now()+600000};return nasPlan;});
  handler('migrateNas',async token=>{if(!nasPlan||nasPlan.token!==token||nasPlan.expires<Date.now())throw new Error('迁移预览已过期，请重新选择目录');const root=nasPlan.root;nasPlan=null;return switchNas(async()=>{await nas.migrationPlan(store,root);return nas.migrate(store,root);});});
  handler('openNas',value=>switchNas(async()=>{await nas.open(absolutePath(value));nas.remember();return nas.store;}));
  handler('reconnectNas',()=>{if(!store.nas)throw new Error('当前为本机库');const root=nas.root;return switchNas(async()=>{await nas.open(root);nas.remember();return nas.store;});});
  handler('leaveNas',()=>switchNas(async()=>{await nas.leave();return localStore;}));
  handler('openNasRecovery',async()=>{const dir=nas.status.staging||path.join(profile,'nas-cache');const error=await shell.openPath(dir);if(error)throw new Error(error);});
  handler('nasTrash',()=>nas.trash());
  handler('restoreNasDeleted',async(batch,id)=>{ids([id]);ensureIdle();nasBusy=true;notify();try{await nas.restoreDeleted(batch,id);return await nas.trash();}finally{nasBusy=false;notify();}});
  handler('openNasTrash',async()=>{if(!store.nas||!nas.status.connected)throw new Error('请先连接 NAS');const error=await shell.openPath(path.join(nas.root,'.cangxia','trash'));if(error)throw new Error('尚无归档文件，或目录暂时无法打开');});
  collector.onAccessHold=()=>queue.pause();
  const qrProfile=session.fromPartition('persist:cangxia-popup-login');
  qrProfile.on('will-download',event=>event.preventDefault());
  qrProfile.setPermissionRequestHandler((_wc,permission,callback,details)=>callback(permission==='storage-access'&&isDouyinURL(details?.requestingUrl||'')));
  qrProfile.setPermissionCheckHandler((_wc,permission,origin)=>permission==='storage-access'&&isDouyinURL(origin||''));
  qrLogin=new QrLogin({profile:qrProfile,chromiumVersion:process.versions.chrome,onChange:notify,onAuthenticated:auth=>collector.applyAuth(auth),onLimit:()=>collector.holdAccess(),createWindow:()=>new BrowserWindow({width:1000,height:800,parent:window,title:'藏匣NAS版 · 抖音登录验证',show:false,skipTaskbar:true,autoHideMenuBar:true,backgroundColor:'#ffffff',webPreferences:{partition:'persist:cangxia-popup-login',contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})});
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
  const area=screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({ title: '藏匣NAS版', icon:path.join(here,'..','assets','icon.ico'), useContentSize:true, width:Math.min(1400,Math.floor(area.width*.94)), height:Math.min(area.height-40,Math.max(640,Math.floor(area.height*.92))), minWidth:Math.min(1000,Math.floor(area.width*.94)), minHeight:Math.min(640,area.height-40), show: !smoke && !sampleProbe && !qrProbe, backgroundColor: '#f7f8fa', autoHideMenuBar: true, webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  handler('state', () => snapshot());
  handler('openAccount', preferred => {ensureIdle();return collector.open(preferred);});
  handler('startQrLogin',()=>{ensureIdle();collector.assertNotCoolingDown();return qrLogin.start();});
  handler('refreshQrLogin',()=>{collector.assertNotCoolingDown();return qrLogin.refresh();});
  handler('cancelQrLogin',()=>qrLogin.cancel());
  handler('showQrLoginPage',()=>qrLogin.showPage());
  handler('finishLogin', () => {ensureIdle();return collector.finishLogin();});
  handler('importLoginConfig', async value=>{ensureIdle();const file=absolutePath(value),stat=fs.lstatSync(file);if(!file.toLowerCase().endsWith('.json')||!stat.isFile()||stat.isSymbolicLink())throw new Error('请选择普通 JSON 配置文件');if(stat.size>2*1024*1024)throw new Error('配置文件过大');await collector.importConfig(fs.readFileSync(file,'utf8'));return true;});
  handler('listDirectory',(value,mode)=>listDirectory(value,mode));
  handler('makeDirectory',(parent,name)=>makeDirectory(parent,name));
  handler('checkRepairs',selected=>{ensureIdle();return store.nas?nas.checkRepairs(ids(selected)):inspectRepairs(store,ids(selected));});
  handler('startRepairs',async selected=>{ensureIdle();const report=store.nas?await nas.checkRepairs(ids(selected)):inspectRepairs(store,ids(selected));const missing=report.items.filter(i=>i.status==='missing');if(missing.length)queue.enqueue(missing.map(i=>i.id));return {...report,started:missing.length};});
  handler('sync', (options = {}) => {
    ensureIdle();
    if(!options||typeof options!=='object')throw new Error('读取选项无效');
    const shared=!!store.nas;
    void collector.sync(options).then(async()=>{if(shared){nasBusy=true;notify();await nas.settle();}}).catch(e=>{collector.update('attention',e.message);}).finally(()=>{nasBusy=false;notify();}); return true;
  });
  handler('clearCompleted', selected => {queue.clearCompleted(ids(selected));return true;});
  handler('stopSync', () => collector.stop());
  handler('addCollections', selected => { ensureIdle(); store.setAdded(ids(selected)); notify(); return true; });
  handler('importLink', async text => { ensureIdle(); if (typeof text !== 'string' || text.length > 6000) throw new Error('链接内容无效'); const w = await collector.importLink(text); notify(); return w?.id; });
  handler('download', selected => { if (collector.busy || collector.waiters.size) throw new Error('请等待读取完成再下载'); queue.enqueue(ids(selected)); return true; });
  handler('pause', () => queue.pause());
  handler('resume', () => { if (collector.busy) throw new Error('请等待同步完成'); queue.resume(); });
  handler('refreshFiles', async () => {if(collector.busy||queue.running||collector.waiters.size)return snapshot();nasMutation=true;try{if(store.nas){await nas.pruneDeletedDownloads();await nas.refreshFiles();}else await store.pruneDeletedDownloads();queue.jobs=store.getSetting('downloadJobs')||[];notify();return snapshot();}finally{nasMutation=false;}});
  handler('chooseRoot', async value => {
    ensureIdle();
    if (store.hasSavedFiles()) throw new Error('原目录仍有本地文件，或暂时无法检查。请清空文件后点击“重新检查文件”。');
    store.setDownloadRoot(absolutePath(value));notify();
    return store.root;
  });
  handler('openRoot', async () => { if(!store.nas)fs.mkdirSync(store.root, { recursive: true }); const error = await shell.openPath(store.root); if (error) throw new Error(error); });
  handler('openFolder', async id => {
    ids([id]); const d = store.download(id); if (!d) throw new Error('作品尚未下载'); store.assertDirectory(d.path);
    const error = await shell.openPath(d.path); if (error) throw new Error(error);
  });
  handler('openOriginal', async id => { ids([id]); const url = store.work(id)?.url; if (!isDouyinURL(url)) throw new Error('作品链接无效'); await collector.openOriginal(url); });
  handler('setTags', async (id, tags) => {
    ids([id]); if (!Array.isArray(tags) || tags.length > 100 || tags.some(t => typeof t !== 'string' || t.length > 80)) throw new Error('标签格式无效');
    const normalized = [...new Set(tags.map(t => t.trim().replace(/^#/, '')).filter(Boolean))];
    store.put('local_tags', id, { id, tags: normalized }); store.save();
    if(store.nas){await nas.refreshInfo(id);notify();return;}
    const d = store.download(id), w = store.work(id);
    if (d && w && fs.existsSync(d.path)) {
      store.assertDirectory(d.path); const meta = path.join(d.path, '作品信息.json');
      fs.writeFileSync(meta + '.part', JSON.stringify(queue.metadata(w,d), null, 2)); fs.renameSync(meta + '.part', meta);
      d.assets = [...d.assets.filter(a => a.key !== 'metadata'), { key: 'metadata', file: '作品信息.json', kind: 'metadata', size: fs.statSync(meta).size }]; store.put('downloads', id, d); store.save();
    }
    notify();
  });
  handler('checkSource', async id => { ids([id]); ensureIdle(); try { await collector.resolveWork(id); } finally { notify(); } });
  handler('prepareDelete',(selected,kind)=>{
    ensureIdle();if(!['local','records'].includes(kind))throw new Error('删除类型无效');
    const selectedIds=ids(selected).filter(id=>kind==='local'?store.download(id):store.hasRead(id));
    const invalid=selectedIds.some(id=>store.work(id)?.remoteState==='unavailable');
    const token=randomUUID();deleteIntents.clear();deleteIntents.set(token,{ids:selectedIds,kind,invalid,expires:Date.now()+600000});
    return {token,kind,count:selectedIds.length,invalid,nas:!!store.nas};
  });
  handler('confirmDelete',async token=>{
    ensureIdle();const intent=deleteIntents.get(token);if(!intent||intent.expires<Date.now())throw new Error('删除确认已过期，请重新选择');
    deleteIntents.delete(token);
    if(intent.kind==='records'){store.deleteReadRecords(intent.ids);notify();return true;}
    if(store.nas){await nas.deleteFiles(intent.ids);notify();return true;}
    const records=intent.ids.map(id=>store.download(id)).filter(Boolean);
    if(!intent.invalid&&records.some(d=>store.work(d.id)?.remoteState==='unavailable'))throw new Error('原作品状态已变化，请重新确认删除');
    const failed = [];
    for (const d of records) try {
      store.assertDirectory(d.path);
      if (fs.existsSync(d.path)) await shell.trashItem(d.path);
      store.forgetDownloads([d.id]);
    } catch (e) { failed.push(e.message); }
    queue.jobs=store.getSetting('downloadJobs')||[];store.save(); notify(); if (failed.length) throw new Error(`部分文件删除失败：${failed.join('；')}`); return true;
  });
  if (process.env.CANGXIA_DEV === '1') await window.loadURL('http://127.0.0.1:5173');
  else await window.loadFile(path.join(here, '..', 'dist', 'index.html'));
  window.on('focus', notify);
  window.on('closed',()=>{if(!quitting)app.quit();});
  if(qrProbe){
    await qrLogin.start();const deadline=Date.now()+35000;
    while(Date.now()<deadline&&!['ready','limited','error','verification'].includes(qrLogin.state().phase))await new Promise(r=>setTimeout(r,500));
    const state=qrLogin.state();
    const diagnostic=qrLogin.window?await qrLogin.window.webContents.executeJavaScript(`({ready:document.readyState,title:document.title,viewport:[innerWidth,innerHeight],text:(document.body?.innerText||'').slice(0,1000),visibility:document.visibilityState,images:[...document.images].slice(-20).map(i=>({width:i.width,height:i.height,naturalWidth:i.naturalWidth,alt:i.alt,cls:i.className,visible:getComputedStyle(i).visibility,srcKind:(i.currentSrc||i.src||'').split(':')[0]})),qrNodes:[...document.querySelectorAll('[class*=qrcode],[class*=qr-code]')].slice(0,12).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,visibility:getComputedStyle(e).visibility,display:getComputedStyle(e).display}))})`).catch(()=>null):null;
    fs.writeFileSync('.test-output/qr-readiness.json',JSON.stringify({phase:state.phase,hasQrImage:!!state.image,message:state.message,hiddenPage:qrLogin.window?!qrLogin.window.isVisible():true,usesActualChromiumVersion:qrLogin.userAgent.includes(process.versions.chrome),diagnostic},null,2));
    qrLogin.cancel();app.quit();
  }
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
  if (smoke || sampleProbe || qrProbe) { fs.mkdirSync('.test-output', {recursive:true}); fs.writeFileSync('.test-output/startup-error.txt', error.stack || error.message); }
  else dialog.showErrorBox('藏匣NAS版启动失败', error.message);
  app.exit(1);
}
});
app.on('window-all-closed', () => app.quit());
app.on('second-instance',()=>{if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}});
app.on('before-quit', event => {
  if(quitting)return;
  event.preventDefault();quitting=true;qrLogin?.cancel();queue?.pause();const browserClose=collector?.dispose();clearTimeout(timer);
  void (async()=>{
    for(let i=0;i<30&&queue?.running;i++)await new Promise(r=>setTimeout(r,100));
    await Promise.race([browserClose||Promise.resolve(),new Promise(r=>setTimeout(r,3000))]);
    if(nas?.writable){try{await Promise.race([nas.flush(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('关闭时 NAS 未确认保存')),8000))]);}catch{}}
    await nas?.close();store?.close();if(localStore&&localStore!==store)localStore.close();app.exit(0);
  })();
});
