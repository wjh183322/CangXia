import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session, safeStorage, screen } from 'electron';
import { randomUUID } from 'node:crypto';
import { listDirectory, makeDirectory, absolutePath } from './file-browser.mjs';
import { inspectRepairs } from './repair-check.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { NasLibrary } from './nas-library.mjs';
import {SnapshotFeed} from './snapshot-feed.mjs';
import {createDiagnostics} from './diagnostics.mjs';
import {verifyAccountIdentity} from './account-identity.mjs';
import {VerificationView} from './verification-view.mjs';
import { Collector } from './account-collector.mjs';
import { AuthVault } from './auth-data.mjs';
import { SystemBrowser } from './system-browser.mjs';
import { QrLogin } from './qr-login.mjs';
import { DownloadQueue } from './downloads.mjs';
import { FlatDownloadQueue } from './flat-downloads.mjs';
import { isDouyinURL, requireInside } from './model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes('--smoke');
const sampleProbe = process.argv.includes('--probe-sample');
const qrProbe = process.argv.includes('--probe-qr');
if (smoke || sampleProbe || qrProbe) app.setPath('userData', path.resolve('.test-output', qrProbe ? 'qr-probe-profile' : sampleProbe ? 'native-probe-profile' : 'native-smoke-profile'));
app.setName('藏匣NAS版');
if(process.env.CANGXIA_LOCAL_TEST_PROFILE)app.setPath('userData',process.env.CANGXIA_LOCAL_TEST_PROFILE);
else if(!smoke&&!sampleProbe&&!qrProbe)app.setPath('userData',path.join(app.getPath('appData'),'藏匣NAS版'));
fs.mkdirSync(app.getPath('userData'),{recursive:true});app.setPath('sessionData',app.getPath('userData'));
if(!app.requestSingleInstanceLock())app.exit(0);
protocol.registerSchemesAsPrivileged([{ scheme: 'app-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let nas,localStore,nasBusy=false,nasMutation=false;
const writes=new Set(['sync','addCollections','importLink','download','resume','clearCompleted','setTags','checkSource','prepareDelete','confirmDelete','startRepairs','chooseRoot','restoreNasDeleted']);
let window, store, collector, queue, flatQueue, qrLogin, timer, quitting=false,feed,diagnostics,readStarting=false,loggingOut=false,exitConfirmed=false,exitPrompt=false;
const readLocked=()=>readStarting||!!collector?.busy;
const lockedNotice=()=>{if(window&&!window.isDestroyed())window.webContents.send('cangxia:notice','请先点击“停止读取”，保存进度后再关闭软件');};
const deleteIntents=new Map();
const stateTransfers=new Map();
function runtimeState(){return {collector:{...collector.status,busy:collector.busy},queue:queue.state(),flatQueue:flatQueue?.state(),qr:qrLogin?.state(),storage:{...nas?.status,busy:nasBusy},syncProgress:store.syncProgress?.()||[]};}
function snapshot() { return feed.frame(runtimeState(),{full:true}); }
function notify() {
  if (quitting) return;
  clearTimeout(timer); timer = setTimeout(() => { if (window && !window.isDestroyed()) window.webContents.send('cangxia:change', feed.frame(runtimeState())); }, 250);
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
      if((readLocked()||loggingOut)&&!['state','stateChunk','stopSync'].includes(name))throw new Error(readLocked()?'正在读取，请先点击“停止读取”':'正在退出登录，请稍候');
      if(nasBusy&&!['state','stateChunk','pause','stopSync','cancelQrLogin','openRoot'].includes(name))throw new Error('正在处理 NAS 媒体库，请等待完成');
      if(nasMutation&&!['state','stateChunk','pause','stopSync','cancelQrLogin'].includes(name))throw new Error('正在保存 NAS 修改，请稍候');
      if(store.nas&&['flatPrepare','flatStart','flatResume','flatRetry'].includes(name))nas.assertWritable();
      if(store.nas&&writes.has(name)){nas.assertWritable();ensureIdle();}
      if(store.nas&&writes.has(name)){nasMutation=true;ownsMutation=true;}
      const result=await action(...args);
      if(store.nas&&writes.has(name)&&!['sync','download','resume','startRepairs','prepareDelete'].includes(name)&&!queue.running){try{await nas.settle();}catch(e){nas.fail(e.message);throw e;}}
      return { ok: true, data:result };
    } catch (error) { return { ok: false, error: error.message || '操作未完成' }; }
    finally{if(ownsMutation){nasMutation=false;notify();}}
  });
}
function ensureIdle() { if (nasBusy || readLocked() || loggingOut || collector.authenticating || collector.verifyingIdentity || queue.running || flatQueue?.running || collector.waiters.size) throw new Error('请先暂停下载并等待当前读取或账号核验结束，再进行此操作'); }
function confirmFlatExit(){
 if(exitPrompt)return;exitPrompt=true;
 void dialog.showMessageBox(window,{type:'question',message:'取消剩余单独下载并退出？',detail:'已完成的图片和视频会保留。单独下载仅在本次运行中有效，退出后无法继续这些临时任务。',buttons:['继续使用','取消剩余任务并退出'],defaultId:0,cancelId:0}).then(({response})=>{if(response===1){exitConfirmed=true;app.quit();}}).finally(()=>{exitPrompt=false;});
}

app.whenReady().then(async () => {
try {
  const profile = app.getPath('userData');
  diagnostics=createDiagnostics(profile);
  diagnostics.record({event:'startup',version:app.getVersion()});
  process.on('uncaughtExceptionMonitor',error=>diagnostics.record({event:'uncaught',name:error.name,code:error.code}));
  app.on('child-process-gone',(_event,details)=>diagnostics.record({event:'child-process-gone',reason:details.reason,exitCode:details.exitCode}));
  store = await Store.open(path.join(profile, 'library.sqlite'), path.join(app.getPath('downloads'), '藏匣NAS版'));
  localStore=store;
  await localStore.pruneDeletedDownloads();
  nas=new NasLibrary(profile,notify,()=>{collector?.stop();queue?.pause();flatQueue?.pauseAll();});
  try{store=await nas.restore()||localStore;}catch(e){nas.status={mode:'local',backupDeferred:true,message:'NAS 无法打开，已返回本机库：'+e.message};}
  feed=new SnapshotFeed(store);
  const httpProfile=session.fromPartition('cangxia-http');
  const browser=new SystemBrowser(path.join(profile,'system-browser'),{headless:smoke||sampleProbe,background:!smoke&&!sampleProbe});
  collector = new Collector(store, notify,{profile:httpProfile,vault:new AuthVault(path.join(profile,'login-state.bin'),safeStorage),browser,verifyIdentity:verifyAccountIdentity,onDiagnostic:diagnostics.record});
  await collector.ready;
  queue = new DownloadQueue(store, collector, (url, options) => collector.fetchMedia(url, options), notify);
  flatQueue=new FlatDownloadQueue({store,collector,fetchMedia:(url,options)=>collector.fetchMedia(url,options),notify,protectedPaths:[profile]});
  collector.onAccessHold=()=>{queue.pause();flatQueue.pauseAll();};
  collector.onBrowserStop=()=>{queue.pause();flatQueue.pauseAll();};
  function attach(next){store=next;feed=new SnapshotFeed(store);stateTransfers.clear();if(flatQueue){flatQueue.store=next;flatQueue.protectedPaths=[profile,...(next.nas?[nas.root]:[])];flatQueue.intents.clear();}collector.store=next;queue=new DownloadQueue(next,collector,(url,options)=>collector.fetchMedia(url,options),notify);if(next.nas)queue.remoteSaveWork=(job,signal)=>nas.saveWork(job,signal,collector,(url,options)=>collector.fetchMedia(url,options),()=>queue.emit());deleteIntents.clear();notify();}
  attach(store);nas.onReload=attach;
  nas.onPruned=()=>{if(queue.store===nas.store&&!queue.running)queue.jobs=store.getSetting('downloadJobs')||[];};
  async function switchNas(action){
    ensureIdle();if(flatQueue?.hasUnfinished())throw new Error('请先完成或取消单独下载，再切换媒体库');if(store.nas&&nas.writable)try{await nas.settle();}catch(e){nas.fail(e.message);}
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
  collector.onAccessHold=()=>{queue.pause();flatQueue.pauseAll();};
  const qrProfile=session.fromPartition('persist:cangxia-popup-login');
  qrProfile.on('will-download',event=>event.preventDefault());
  qrProfile.setPermissionRequestHandler((_wc,permission,callback,details)=>callback(permission==='storage-access'&&isDouyinURL(details?.requestingUrl||'')));
  qrProfile.setPermissionCheckHandler((_wc,permission,origin)=>permission==='storage-access'&&isDouyinURL(origin||''));
  qrLogin=new QrLogin({profile:qrProfile,chromiumVersion:process.versions.chrome,onChange:notify,onAuthenticated:(auth,options)=>collector.applyAuth(auth,true,options),onLimit:()=>collector.holdAccess(),createWindow:()=>new VerificationView({parent:()=>window,partition:'persist:cangxia-popup-login',onVisibility:(inline,pageId,panelFound=false)=>qrLogin.update({inline,pageId,panelFound,pageRevision:(qrLogin.state().pageRevision||0)+1})})});
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
  handler('state', () => {
    const state=snapshot();if(state.works.length<=1000)return state;
    for(const [id,transfer]of stateTransfers)if(transfer.expires<Date.now())stateTransfers.delete(id);
    if(stateTransfers.size>=2)stateTransfers.delete(stateTransfers.keys().next().value);
    const token=randomUUID(),{works,...head}=state;stateTransfers.set(token,{works,expires:Date.now()+120000});return {chunkedState:true,token,head,total:works.length};
  });
  handler('stateChunk',(token,offset)=>{const transfer=stateTransfers.get(token);if(!transfer||transfer.expires<Date.now()||!Number.isSafeInteger(offset)||offset<0||offset>=transfer.works.length)throw new Error('界面状态已更新，请重新加载');const works=transfer.works.slice(offset,offset+250),done=offset+works.length>=transfer.works.length;if(done)stateTransfers.delete(token);return {works,done};});
  handler('openAccount', async preferred => {ensureIdle();qrLogin.cancel();if(store.getSetting('loggedOut'))await browser.clearLoginData();return collector.open(preferred);});
  handler('startQrLogin',async()=>{ensureIdle();collector.assertNotCoolingDown();await browser.hideLogin();collector.status.browserOpened=false;if(collector.status.needsLogin||store.getSetting('loggedOut')){qrLogin.cancel();await qrProfile.clearStorageData();}return qrLogin.start();});
  handler('confirmLegacyAccount',async token=>{ensureIdle();await collector.confirmLegacyAccount(token);qrLogin.cancel();notify();return snapshot();});
  handler('openDiagnostics',()=>shell.openPath(diagnostics.dir));
  handler('refreshQrLogin',()=>{ensureIdle();collector.assertNotCoolingDown();collector.pendingAuth=null;collector.status.pendingAccount=null;return qrLogin.refresh();});
  handler('cancelQrLogin',async()=>{qrLogin.cancel();collector.pendingAuth=null;collector.status.pendingAccount=null;await browser.hideLogin();collector.status.browserOpened=false;notify();});
  handler('showQrLoginPage',()=>qrLogin.showPage());
  handler('setQrPageBounds',(id,bounds)=>{const page=qrLogin.window;if(page?.webContents.id===id&&qrLogin.state().inline)page.setInlineBounds?.(bounds);return true;});
  handler('showQrExternalPage',async()=>{await qrLogin.showPage();qrLogin.window?.openExternal?.();return true;});
  handler('checkQrLogin',()=>{ensureIdle();collector.assertNotCoolingDown();return qrLogin.check();});
  handler('finishLogin', () => {ensureIdle();qrLogin.cancel();return collector.finishLogin();});
  handler('logout',async(pauseDownloads=false)=>{
    if(readLocked())throw new Error('请先停止读取，再退出登录');
    loggingOut=true;
    try{
      const networkBatches=await flatQueue.networkBatchIds();
      if((queue.running||networkBatches.length)&&!pauseDownloads)return {needsPause:true};
      qrLogin.cancel();queue.pause();for(const id of networkBatches)flatQueue.pause(id);collector.cancelResolve();await collector.cancelAuthentication();await Promise.all([queue.waitForIdle(),...networkBatches.map(id=>flatQueue.waitForBatch(flatQueue.get(id)))]);
      let failed=false;try{await collector.logout();}catch{failed=true;}
      for(const operation of [()=>qrProfile.clearStorageData(),()=>qrProfile.clearCache()])try{await operation();}catch{failed=true;}
      collector.status.logoutIncomplete=failed;notify();
      if(failed)throw new Error('已断开登录，部分登录缓存未清理完成，请重试清理');
      return {loggedOut:true,collector:{...collector.status,busy:false},queue:queue.state(),flatQueue:flatQueue.state()};
    }finally{loggingOut=false;notify();}
  });
  handler('importLoginConfig', async value=>{ensureIdle();const file=absolutePath(value),stat=fs.lstatSync(file);if(!file.toLowerCase().endsWith('.json')||!stat.isFile()||stat.isSymbolicLink())throw new Error('请选择普通 JSON 配置文件');if(stat.size>2*1024*1024)throw new Error('配置文件过大');await collector.importConfig(fs.readFileSync(file,'utf8'));return true;});
  handler('listDirectory',(value,mode)=>listDirectory(value,mode));
  handler('pickerLocations',()=>({desktop:app.getPath('desktop'),shortcuts:[['desktop','桌面'],['downloads','下载'],['documents','文档'],['pictures','图片'],['videos','视频'],['music','音乐']].map(([id,name])=>({id,name,path:app.getPath(id)}))}));
  handler('makeDirectory',(parent,name)=>makeDirectory(parent,name));
  handler('flatPrepare',(directory,selected,includeCover)=>{if(queue.running||collector.waiters.size||collector.authenticating)throw new Error('请先暂停普通下载并等待当前操作结束');return flatQueue.prepare(absolutePath(directory),ids(selected),includeCover);});
  handler('flatStart',(token,allowNonempty)=>{if(queue.running||collector.busy||collector.authenticating||collector.verifyingIdentity)throw new Error('请等待当前操作结束');return flatQueue.start(token,allowNonempty===true);});
  handler('flatPause',async id=>{flatQueue.pause(id);await flatQueue.waitForBatch(flatQueue.get(id));});
  handler('flatResume',id=>{if(queue.running||collector.busy||collector.authenticating||collector.verifyingIdentity||collector.waiters.size)throw new Error('请先暂停普通下载并等待当前操作结束');flatQueue.resume(id);});
  handler('flatRetry',id=>{if(queue.running||collector.busy||collector.authenticating||collector.verifyingIdentity||collector.waiters.size)throw new Error('请先暂停普通下载并等待当前操作结束');flatQueue.retry(id);});
  handler('flatCancel',id=>flatQueue.cancel(id));
  handler('flatClear',id=>flatQueue.clear(id));
  handler('flatOpen',async id=>{const b=flatQueue.get(id);const error=await shell.openPath(b.directory);if(error)throw new Error(error);});
  handler('checkRepairs',selected=>{ensureIdle();return store.nas?nas.checkRepairs(ids(selected)):inspectRepairs(store,ids(selected));});
  handler('startRepairs',async selected=>{ensureIdle();if(store.getSetting('loggedOut'))throw new Error('请登录原账号后再补齐文件');const report=store.nas?await nas.checkRepairs(ids(selected)):inspectRepairs(store,ids(selected));const missing=report.items.filter(i=>i.status==='missing');if(missing.length)queue.enqueue(missing.map(i=>i.id));return {...report,started:missing.length};});
  handler('sync', async(options = {}) => {
    ensureIdle();
    if(!options||typeof options!=='object')throw new Error('读取选项无效');
    readStarting=true;if(store.nas)nas.deferCommits=(nas.deferCommits||0)+1;
    try{await collector.sync(options);if(store.nas&&nas.writable){store.save();await nas.settle();}return {collector:{...collector.status,busy:collector.busy},syncProgress:store.syncProgress()};}finally{if(store.nas){nas.deferCommits--;if(nas.dirty&&nas.writable)nas.changed();}readStarting=false;notify();}
  });
  handler('clearCompleted', selected => {queue.clearCompleted(ids(selected));return true;});
  handler('stopSync', () => collector.stop());
  handler('addCollections', selected => { ensureIdle(); store.setAdded(ids(selected)); notify(); return true; });
  handler('importLink', async text => { ensureIdle(); if (typeof text !== 'string' || text.length > 6000) throw new Error('链接内容无效'); const w = await collector.importLink(text); notify(); return w?.id; });
  handler('download', selected => { if (collector.busy || collector.waiters.size || flatQueue.running) throw new Error('请等待读取完成或暂停单独下载后再下载');if(store.getSetting('loggedOut'))throw new Error('请登录原账号后再下载');queue.enqueue(ids(selected)); return true; });
  handler('pause', () => queue.pause());
  handler('resume', () => { if (collector.busy || flatQueue.running) throw new Error('请等待同步完成或暂停单独下载');if(store.getSetting('loggedOut'))throw new Error('请登录原账号后再继续下载');queue.resume(); });
  handler('refreshFiles', async () => {if(collector.busy||queue.running||collector.waiters.size)return snapshot();nasMutation=true;try{if(store.nas){await nas.pruneDeletedDownloads();await nas.refreshFiles();}else await store.pruneDeletedDownloads();queue.jobs=store.getSetting('downloadJobs')||[];notify();store.invalidateViews();return snapshot();}finally{nasMutation=false;}});
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
      store.viewCache.delete(d.id);
    } catch (e) { failed.push(e.message); }
    queue.jobs=store.getSetting('downloadJobs')||[];store.save(); notify(); if (failed.length) throw new Error(`部分文件删除失败：${failed.join('；')}`); return true;
  });
  if (process.env.CANGXIA_DEV === '1') await window.loadURL('http://127.0.0.1:5173');
  else await window.loadFile(path.join(here, '..', 'dist', 'index.html'));
  window.on('focus', notify);
  window.on('close',event=>{if(!quitting&&readLocked()){event.preventDefault();lockedNotice();return;}if(loggingOut){event.preventDefault();window.webContents.send('cangxia:notice','正在退出登录，请等待登录信息清理完成');return;}if(!quitting&&!exitConfirmed&&flatQueue.hasUnfinished()){event.preventDefault();confirmFlatExit();return;}qrLogin?.cancel();});
  window.webContents.on('render-process-gone',(_event,details)=>{qrLogin?.cancel();diagnostics.record({event:'render-process-gone',reason:details.reason,exitCode:details.exitCode});collector.stop();queue.pause();flatQueue.pauseAll();void dialog.showMessageBox(window,{type:'warning',message:'界面进程已退出，已提交的读取进度仍保留',detail:'可以重新加载界面后继续。诊断记录保存在本机 diagnostics 目录。',buttons:['重新加载','退出'],defaultId:0,cancelId:1}).then(({response})=>{if(response===0)window.reload();else app.quit();});});
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
  if(readLocked()||loggingOut){event.preventDefault();if(readLocked())lockedNotice();return;}
  if(!exitConfirmed&&flatQueue?.hasUnfinished()){event.preventDefault();confirmFlatExit();return;}
  event.preventDefault();quitting=true;qrLogin?.cancel();queue?.pause();const flatClose=flatQueue?.dispose();const browserClose=collector?.dispose();clearTimeout(timer);
  void (async()=>{
    try{await flatClose;}catch{dialog.showErrorBox('临时文件未完全清理','单独下载任务已取消；目标目录中的 .cangxia-flat- 开头临时文件夹可能仍有未完成片段，可在退出后删除。');}
    for(let i=0;i<50&&(queue?.running||collector?.busy);i++)await new Promise(r=>setTimeout(r,100));
    await Promise.race([browserClose||Promise.resolve(),new Promise(r=>setTimeout(r,3000))]);
    diagnostics?.record({event:'shutdown',reason:collector?.busy?'pending-request':'normal'});diagnostics?.close();    if(nas?.writable){try{await Promise.race([nas.flush(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('关闭时 NAS 未确认保存')),8000))]);}catch{}}
    await nas?.close();store?.close();if(localStore&&localStore!==store)localStore.close();app.exit(0);
  })();
});
