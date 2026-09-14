import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session, safeStorage, screen } from 'electron';
import { randomUUID } from 'node:crypto';
import { listDirectory, makeDirectory, absolutePath } from './file-browser.mjs';
import { inspectRepairs } from './repair-check.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { BackupClient } from './backup-client.mjs';
import {exportRecords,applyChanges} from './backup-model.mjs';
import {requireLocalStorage} from './local-storage.mjs';
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
app.setName('藏匣备份版');
if(process.env.CANGXIA_BACKUP_TEST_PROFILE)app.setPath('userData',process.env.CANGXIA_BACKUP_TEST_PROFILE);
else if(!smoke&&!sampleProbe&&!qrProbe)app.setPath('userData',path.join(app.getPath('appData'),'藏匣备份版'));
if(!app.requestSingleInstanceLock())app.exit(0);
protocol.registerSchemesAsPrivileged([{ scheme: 'app-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let window, store, collector, queue, qrLogin, timer, backup, backupBusy=false, quitting=false, exitApproved=false;
const deleteIntents=new Map();
const writes=new Set(['sync','addCollections','importLink','download','resume','clearCompleted','setTags','checkSource','prepareDelete','confirmDelete','startRepairs','chooseRoot','importExistingLibrary']);
function snapshot(){return {...store.snapshot(),collector:{...collector.status,busy:collector.busy||backupBusy},queue:queue.state(),qr:qrLogin?.state(),storage:{...backup.status,config:backup.publicConfig(),busy:backupBusy,syncing:!!backup.syncing}};}
function notify() {
  if (quitting) return;
  clearTimeout(timer); timer = setTimeout(() => { if (window && !window.isDestroyed()) window.webContents.send('cangxia:change', snapshot()); }, 120);
}
function ids(value) {
  if (!Array.isArray(value) || value.length > 100000 || value.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) throw new Error('作品选择无效');
  return [...new Set(value)];
}
function handler(name,action){ipcMain.handle('cangxia:'+name,async(event,...args)=>{try{
 if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('无效调用来源');
 if(backupBusy&&!['state','pause','stopSync'].includes(name))throw new Error('正在更新本机资料，请稍候');
 if(writes.has(name))backup.assertWritable();return {ok:true,data:await action(...args)};
}catch(e){return {ok:false,error:e.message||'操作未完成'};}});}
function ensureIdle(){if(backupBusy||collector.busy||queue.running||collector.waiters.size)throw new Error('请先暂停下载并等待当前读取结束');}

app.whenReady().then(async () => {
try {
  const profile = app.getPath('userData');
  store = await Store.open(path.join(profile, 'library.sqlite'), path.join(app.getPath('downloads'), '藏匣备份版'));
  backup=new BackupClient(store,profile,{vault:{seal:value=>{if(!safeStorage.isEncryptionAvailable())throw new Error('Windows 凭据加密不可用');return safeStorage.encryptString(value).toString('base64');},open:value=>safeStorage.decryptString(Buffer.from(value,'base64'))},onChange:notify,onUnavailable:()=>{collector?.stop();queue?.pause();},isIdle:()=>!collector?.busy&&!queue?.running&&!backupBusy});
  const httpProfile=session.fromPartition('cangxia-http');
  const browser=new SystemBrowser(path.join(profile,'system-browser'),{headless:smoke||sampleProbe});
  collector = new Collector(store, notify,{profile:httpProfile,vault:new AuthVault(path.join(profile,'login-state.bin'),safeStorage),browser});
  await collector.ready;
  queue = new DownloadQueue(store, collector, (url, options) => collector.fetchMedia(url, options), notify);
  queue.backupRestore=(job,signal)=>backup.restoreWork(job,signal,(w,d)=>queue.metadata(w,d));
  queue.onIdle=()=>backup.afterDownloads();
  async function restoreBackupAuth(){await collector.profile.clearStorageData({storages:['cookies']});collector.status.connected=false;await collector.restore();}
  backup.onRemoteApplied=restoreBackupAuth;
  handler('configureBackup',async input=>{ensureIdle();await backup.configure(input);await restoreBackupAuth();return snapshot();});
  handler('checkBackup',async()=>{ensureIdle();await backup.check();await restoreBackupAuth();return snapshot();});
  handler('syncBackup',async()=>{await backup.sync();return snapshot();});
  handler('cancelBackup',()=>{backup.cancel();return true;});
  handler('finishBackupExit',async mode=>{if(!['keep','sync'].includes(mode))throw new Error('退出选项无效');if(mode==='sync'){collector.stop();queue.pause();for(let i=0;i<100&&(queue.running||collector.busy);i++)await new Promise(r=>setTimeout(r,100));if(queue.running||collector.busy)throw new Error('下载正在停止，请稍后再试');await backup.sync();if(backup.status.pending)throw new Error('仍有本机变化待同步，请检查后退出');}exitApproved=true;app.quit();return true;});
  handler('acceptRemoteBackup',async()=>{ensureIdle();backupBusy=true;notify();try{await backup.acceptRemote();queue.jobs=store.getSetting('downloadJobs')||[];await collector.profile.clearStorageData({storages:['cookies']});collector.status.connected=false;await collector.restore();return snapshot();}finally{backupBusy=false;notify();}});
  handler('openBackupRecovery',async()=>{const dir=path.join(profile,'recovery');fs.mkdirSync(dir,{recursive:true});const error=await shell.openPath(dir);if(error)throw new Error(error);});
  let importPreview;
  async function oldLibrary(kind){
    const legacy=process.env.CANGXIA_BACKUP_TEST_PROFILE&&process.env.CANGXIA_BACKUP_TEST_ORIGINAL?process.env.CANGXIA_BACKUP_TEST_ORIGINAL:path.join(app.getPath('appData'),'藏匣');let file=path.join(legacy,'library.sqlite');
    if(kind==='nas'){const c=JSON.parse(fs.readFileSync(path.join(legacy,'library-location.json'),'utf8'));if(!c.id||!/^[a-f0-9-]+$/.test(c.id))throw new Error('没有可导入的 NAS 版缓存');file=path.join(legacy,'nas-cache',c.id+'.sqlite');}
    else if(kind!=='local')throw new Error('导入来源无效');
    if(!fs.existsSync(file))throw new Error('未找到旧版资料');const temp=path.join(profile,'import-preview.sqlite');fs.copyFileSync(file,temp);const source=await Store.open(temp,path.join(app.getPath('downloads'),'藏匣'));const currentKey=store.getSetting('browserAccountKey'),sourceKey=source.getSetting('browserAccountKey');if(currentKey&&sourceKey&&currentKey!==sourceKey){source.close();throw new Error('旧资料与当前备份库绑定的抖音账号不同，未合并导入');}await source.pruneDeletedDownloads();return source;
  }
  handler('previewExistingLibrary',async kind=>{ensureIdle();if(store.all('works').length)throw new Error('当前备份版本机库已有记录，不能直接合并导入');const source=await oldLibrary(kind);try{const entries=exportRecords(source),downloads=source.all('downloads');let files=0,bytes=0;for(const d of downloads)for(const a of d.assets||[])if(source.assetExists(d,a)){files++;bytes+=a.size||0;}importPreview={token:randomUUID(),kind,works:entries.filter(e=>e.table==='works').length,files,bytes};return importPreview;}finally{source.close();}});
  handler('importExistingLibrary',async token=>{ensureIdle();if(!importPreview||importPreview.token!==token||store.all('works').length)throw new Error('请重新预览导入范围');const kind=importPreview.kind;importPreview=null;backupBusy=true;backup.applying=true;notify();let source;try{
    source=await oldLibrary(kind);const entries=exportRecords(source).filter(e=>e.table!=='downloads');applyChanges(store,entries);const errors=[];let count=0;
    for(const original of source.all('downloads')){if(!store.work(original.id))continue;const target=store.destination(original.id);fs.mkdirSync(target.dir,{recursive:true});const assets=[];
      for(const a of original.assets||[]){if(!source.assetExists(original,a))continue;try{backup.status.progress='正在复制已有文件：'+a.file;notify();await fs.promises.copyFile(requireInside(original.path,path.join(original.path,a.file)),requireInside(target.dir,path.join(target.dir,a.file)),fs.constants.COPYFILE_EXCL);assets.push(a);count++;}catch(e){errors.push(e.message);}}
      if(assets.length)store.put('downloads',original.id,{...original,path:target.dir,collectionId:target.collectionId,assets,state:assets.length===original.assets.length?original.state:'partial'});
    }store.save();return {works:entries.filter(e=>e.table==='works').length,files:count,errors};
  }finally{source?.close();backup.applying=false;backupBusy=false;backup.status.progress='';backup.changed();notify();}});
  collector.onAccessHold=()=>queue.pause();
  const qrProfile=session.fromPartition('persist:cangxia-popup-login');
  qrProfile.on('will-download',event=>event.preventDefault());
  qrProfile.setPermissionRequestHandler((_wc,permission,callback,details)=>callback(permission==='storage-access'&&isDouyinURL(details?.requestingUrl||'')));
  qrProfile.setPermissionCheckHandler((_wc,permission,origin)=>permission==='storage-access'&&isDouyinURL(origin||''));
  qrLogin=new QrLogin({profile:qrProfile,chromiumVersion:process.versions.chrome,onChange:notify,onAuthenticated:auth=>collector.applyAuth(auth),onLimit:()=>collector.holdAccess(),createWindow:()=>new BrowserWindow({width:1000,height:800,parent:window,title:'藏匣 · 抖音登录验证',show:false,skipTaskbar:true,autoHideMenuBar:true,backgroundColor:'#ffffff',webPreferences:{partition:'persist:cangxia-popup-login',contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})});
  const cacheRoot = path.join(profile, 'covers'); fs.mkdirSync(cacheRoot, { recursive: true });
  const cachePending = new Map();
  protocol.handle('app-media', async request => {
    try {
      const u = new URL(request.url); const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const [id, filename] = parts; if (!/^\d+$/.test(id || '')) return new Response('', { status: 404 });
      let file;
      if (u.hostname === 'stream') {
        if(!backup.status.writable)return new Response('',{status:503});
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
            if(!backup.status.writable)return new Response('',{status:404});
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
  window = new BrowserWindow({ title: '藏匣备份版', icon:path.join(here,'..','assets','icon.ico'), useContentSize:true, width:Math.min(1400,Math.floor(area.width*.94)), height:Math.min(area.height-40,Math.max(640,Math.floor(area.height*.92))), minWidth:Math.min(1000,Math.floor(area.width*.94)), minHeight:Math.min(640,area.height-40), show: !smoke && !sampleProbe && !qrProbe, backgroundColor: '#f7f8fa', autoHideMenuBar: true, webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
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
  handler('checkRepairs',selected=>{ensureIdle();return inspectRepairs(store,ids(selected));});
  handler('startRepairs',async selected=>{ensureIdle();const report=inspectRepairs(store,ids(selected));const missing=report.items.filter(i=>i.status==='missing');if(missing.length)queue.enqueue(missing.map(i=>i.id));return {...report,started:missing.length};});
  handler('sync', (options = {}) => {
    ensureIdle();
    if(!options||typeof options!=='object')throw new Error('读取选项无效');
    void collector.sync(options).catch(e=>collector.update('attention',e.message));return true;
  });
  handler('clearCompleted', selected => {queue.clearCompleted(ids(selected));return true;});
  handler('stopSync', () => collector.stop());
  handler('addCollections', selected => { ensureIdle(); store.setAdded(ids(selected)); notify(); return true; });
  handler('importLink', async text => { ensureIdle(); if (typeof text !== 'string' || text.length > 6000) throw new Error('链接内容无效'); const w = await collector.importLink(text); notify(); return w?.id; });
  handler('download', selected => { if (collector.busy || collector.waiters.size) throw new Error('请等待读取完成再下载'); queue.enqueue(ids(selected)); return true; });
  handler('pause', () => queue.pause());
  handler('resume', () => { if (collector.busy) throw new Error('请等待同步完成'); queue.resume(); });
  handler('refreshFiles',async()=>{if(!collector.busy&&!queue.running&&backup.status.writable)await store.pruneDeletedDownloads();queue.jobs=store.getSetting('downloadJobs')||[];backup.changed();notify();return snapshot();});
  handler('chooseRoot', async value => {
    ensureIdle();
    if (store.hasSavedFiles()) throw new Error('原目录仍有本地文件，或暂时无法检查。请清空文件后点击“重新检查文件”。');
    store.setDownloadRoot(await requireLocalStorage(absolutePath(value)));notify();
    return store.root;
  });
  handler('openRoot', async () => { fs.mkdirSync(store.root, { recursive: true }); const error = await shell.openPath(store.root); if (error) throw new Error(error); });
  handler('openFolder', async id => {
    ids([id]); const d = store.download(id); if (!d) throw new Error('作品尚未下载'); store.assertDirectory(d.path);
    const error = await shell.openPath(d.path); if (error) throw new Error(error);
  });
  handler('openOriginal', async id => { ids([id]); const url = store.work(id)?.url; if (!isDouyinURL(url)) throw new Error('作品链接无效'); await collector.openOriginal(url); });
  handler('setTags', async (id, tags) => {
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
  handler('prepareDelete',(selected,kind)=>{
    ensureIdle();if(!['local','records'].includes(kind))throw new Error('删除类型无效');
    const selectedIds=ids(selected).filter(id=>kind==='local'?store.download(id):store.hasRead(id));
    const invalid=selectedIds.some(id=>store.work(id)?.remoteState==='unavailable');
    const token=randomUUID();deleteIntents.clear();deleteIntents.set(token,{ids:selectedIds,kind,invalid,expires:Date.now()+600000});
    return {token,kind,count:selectedIds.length,invalid,backup:true};
  });
  handler('confirmDelete',async token=>{
    ensureIdle();const intent=deleteIntents.get(token);if(!intent||intent.expires<Date.now())throw new Error('删除确认已过期，请重新选择');
    deleteIntents.delete(token);
    if(intent.kind==='records'){store.deleteReadRecords(intent.ids);notify();return true;}
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
  void backup.start().then(()=>restoreBackupAuth()).catch(()=>{});
  window.on('close',event=>{if(!quitting&&!exitApproved&&(backup.syncing||(backup.config&&backup.status.pending))){event.preventDefault();window.webContents.send('cangxia:exit-requested');}});
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
  else dialog.showErrorBox('藏匣启动失败', error.message);
  app.exit(1);
}
});
app.on('window-all-closed', () => app.quit());
app.on('second-instance',()=>{if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}});
app.on('before-quit', event => {
  if(quitting)return;
  if(!exitApproved&&window&&!window.isDestroyed()&&(backup?.syncing||(backup?.config&&backup?.status.pending))){event.preventDefault();window.webContents.send('cangxia:exit-requested');return;}
  event.preventDefault();quitting=true;qrLogin?.cancel();queue?.pause();const browserClose=collector?.dispose();clearTimeout(timer);
  void (async()=>{
    for(let i=0;i<30&&queue?.running;i++)await new Promise(r=>setTimeout(r,100));
    await Promise.race([browserClose||Promise.resolve(),new Promise(r=>setTimeout(r,3000))]);
    await backup?.close();store?.close();app.exit(0);
  })();
});
