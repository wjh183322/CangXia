import {NasCatalogue} from './nas-catalogue.mjs';
import {DeletionCoordinator} from './deletion-coordinator.mjs';
import {quiesceSelectedDeletion,waitDeletionWriter,withReleasedPreviews} from './deletion-session.mjs';
import {PreviewFiles} from './preview-files.mjs';
import {WorkAudio} from './work-audio.mjs';
import {CreatorDetails} from './creator-details.mjs';
import {LocalRemoval} from './local-removal.mjs';
import {NASRemoval} from './nas-removal.mjs';
import {HDCover,bestCover} from './hd-cover.mjs';
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session, safeStorage, screen } from 'electron';
import { randomUUID } from 'node:crypto';
import { listDirectory, makeDirectory, absolutePath } from './file-browser.mjs';
import {RepairChecks} from './repair-checks.mjs';
import {DefectRepair} from './defect-repair.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import {SqliteStore} from './sqlite-store.mjs';
import { BackupClient } from './backup-client.mjs';
import {exportRecords,applyChanges} from './backup-model.mjs';
import {requireLocalStorage} from './local-storage.mjs';
import {SnapshotFeed} from './snapshot-feed.mjs';
import {importDestination} from './author-import.mjs';
import {createDiagnostics} from './diagnostics.mjs';
import {buildWorkDiagnostic} from './work-diagnostic.mjs';
import {VerificationView} from './verification-view.mjs';
import { Collector } from './account-collector.mjs';
import {AuthorReader} from './author-reader.mjs';
import {redirectHeaders} from './redirect-headers.mjs';
import { AuthVault } from './auth-data.mjs';
import {verifyAccountIdentity} from './account-identity.mjs';
import { SystemBrowser } from './system-browser.mjs';
import { QrLogin } from './qr-login.mjs';
import { DownloadQueue } from './downloads.mjs';
import {planDownloads} from './download-selection.mjs';
import { FlatDownloadQueue } from './flat-downloads.mjs';
import { isDouyinURL, requireInside } from './model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appVersion=JSON.parse(fs.readFileSync(path.join(here,'..','package.json'),'utf8')).version;
const smoke = process.argv.includes('--smoke');
const packageSmoke=process.argv.includes('--package-smoke')&&!!process.env.CANGXIA_BACKUP_TEST_PROFILE;
const sampleProbe = process.argv.includes('--probe-sample');
const qrProbe = process.argv.includes('--probe-qr');
if (smoke || sampleProbe || qrProbe) app.setPath('userData', path.resolve('.test-output', qrProbe ? 'qr-probe-profile' : sampleProbe ? 'native-probe-profile' : 'native-smoke-profile'));
app.setName('藏匣备份版');
if(process.env.CANGXIA_BACKUP_TEST_PROFILE)app.setPath('userData',process.env.CANGXIA_BACKUP_TEST_PROFILE);
else if(!smoke&&!sampleProbe&&!qrProbe)app.setPath('userData',path.join(app.getPath('appData'),'藏匣备份版'));
fs.mkdirSync(app.getPath('userData'),{recursive:true});app.setPath('sessionData',app.getPath('userData'));
if(!app.requestSingleInstanceLock())app.exit(0);
protocol.registerSchemesAsPrivileged([{ scheme: 'app-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let retentionTimer,nasCatalogue,scopedDeletion,scopedTask,scopedPreparing,scopedExit=false,scopedFileIds=new Set();
const previewFiles=new PreviewFiles((file,options)=>net.fetch(pathToFileURL(file).href,options));
const prunePrivateHistory=()=>{if(quitting||!store||store.deviceScopes.closed)return;void store.deviceScopes.pruneSummaries().catch(error=>diagnostics?.record({event:'operation-summary-prune-failed',code:error.code}));void nasCatalogue?.pruneIntents().catch(error=>diagnostics?.record({event:'recovery-intent-prune-failed',code:error.code}));};
const scopedActive=()=>!!(scopedDeletion?.running||scopedDeletion?.preparing||backup?.deletions?.state().running||nasCatalogue?.restoring||nasCatalogue?.preparingPromise);
let audio,backup,defectRepair,localRemoval,nasRemoval,creatorDetails,repairChecks,removalExit=false,nasExit=false,backupBusy=false,exitApproved=false;
const writes=new Set(['addAuthor','readAuthor','archiveAuthor','confirmCollectionRead','flatPrepare','flatStart','flatResume','flatRetry','sync','addCollections','importLink','download','retryDownloads','resume','clearCompleted','setTags','checkSource','markSourceUnavailable','startRepairs','chooseRoot','importExistingLibrary']);
let rendererReady=false,firstState=true,startupLoading=true,startupClosing=false;
const startupStage=name=>diagnostics?.record({event:"startup-stage",name,elapsedMs:Math.round(process.uptime()*1000)});
let window, store, collector, queue, flatQueue, qrLogin, timer, quitting=false,feed,diagnostics,readStarting=false,loggingOut=false,exitConfirmed=false,exitPrompt=false;
const readLocked=()=>readStarting||!!collector?.busy||!!collector?.batchReading;
const lockedNotice=()=>{if(window&&!window.isDestroyed())window.webContents.send('cangxia:notice',creatorDetails?.running?'请先点击“停止更新”，再关闭软件':'请先点击“停止读取”，保存进度后再关闭软件');};
const deleteIntents=new Map();
const stateTransfers=new Map();
const inFlightActions=new Set(),actionDrains=new Map();
function runtimeState(){return {scopedDeletion:scopedDeletion?.state(),deletionResolution:backup?.deletions?.state(),deletionRevision:store.deviceScopes.revision,nasCatalogue:nasCatalogue?.state(),nasCatalogueOverview:backup.meta.libraryId?nasCatalogue?.overview():null,audioQueue:audio?.state(),repairCheck:repairChecks?.state(),contentRevision:store.backupRevision(),nasRemoval:nasRemoval?.state(),localRemoval:localRemoval?.state(),version:appVersion,collector:{...collector.status,busy:!!(collector.busy||collector.batchReading)},queue:queue.state({summary:true}),flatQueue:flatQueue?.state(),qr:qrLogin?.state(),defectRepair:defectRepair?.state(),storage:{...backup.status,cache:backup.cache.summary(),config:backup.publicConfig(),busy:backupBusy,syncing:!!backup.syncing,reconcile:store.localReconcile.state(),fileCheck:store.fileStates.state()},syncProgress:store.syncProgress?.()||[]};}
function snapshot() { return backup?.applying&&feed.previous?{...feed.previous,libraryRevision:feed.revision,...runtimeState()}:feed.frame(runtimeState(),{full:true}); }
function notify() {
  if (quitting) return;
  if(timer)return;timer = setTimeout(() => { timer=null;if (rendererReady && window && !window.isDestroyed()){if(!store.lightViews.ready){void store.lightViews.prepare().then(notify).catch(error=>diagnostics.record({event:'view-index-failed',reason:error.message}));return;}window.webContents.send('cangxia:change', backup?.applying?{delta:true,...runtimeState()}:feed.frame(runtimeState()));} }, 250);
}
function ids(value) {
  if (!Array.isArray(value) || value.length > 100000 || value.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) throw new Error('作品选择无效');
  return [...new Set(value)];
}
function handler(name, action) {
  ipcMain.handle('cangxia:' + name, async (event, ...args) => {
    const guarded=!['nasCataloguePage','nasCatalogueGroups','nasCatalogueWork','nasCataloguePreview','stopNASCatalogue','deletionPendingPage','validateDeletionSelection','stopScopedDeletion','stopDeletionResolution','cancelPreparedDeletion','audioPage','audioStatus','audioPrepare','audioRelease','audioRenew','cacheStop','readHistoryRuns','readHistoryItems','repairPage','cancelRepairs','state','stateChunk','downloadPage','defectPage','workDetail','validateDefectSelection','validateDownloadSelection','defectOverview','exportWorkDiagnostic','cancelFileCheck','filterWorks','startupReady','reportCoverStatus'].includes(name);let entered=false;
    try {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效调用来源');
      if(backup?.applying&&!['nasCataloguePage','nasCatalogueGroups','nasCatalogueWork','nasCataloguePreview','stopNASCatalogue','deletionPendingPage','validateDeletionSelection','stopScopedDeletion','stopDeletionResolution','cancelPreparedDeletion','readHistoryRuns','readHistoryItems','repairPage','cancelRepairs','state','stateChunk','startupReady','cancelBackup','cancelFileCheck'].includes(name))throw Error('正在应用 NAS 记录，请等待当前批次完成');
      if(repairChecks?.running&&!['nasCataloguePage','nasCatalogueGroups','nasCatalogueWork','nasCataloguePreview','stopNASCatalogue','deletionPendingPage','validateDeletionSelection','stopScopedDeletion','stopDeletionResolution','cancelPreparedDeletion','audioPage','audioStatus','audioRelease','audioRenew','cacheStop','readHistoryRuns','readHistoryItems','state','stateChunk','startupReady','cancelRepairs','repairPage','cancelFileCheck','downloadPage','defectPage','workDetail','validateDefectSelection','validateDownloadSelection','defectOverview','exportWorkDiagnostic','filterWorks','reportCoverStatus'].includes(name))throw Error('正在检查本地文件，请先停止检查');
      if(localRemoval?.running&&!['nasCataloguePage','nasCatalogueGroups','nasCatalogueWork','nasCataloguePreview','stopNASCatalogue','deletionPendingPage','validateDeletionSelection','stopScopedDeletion','stopDeletionResolution','cancelPreparedDeletion','audioPage','audioStatus','audioRelease','audioRenew','cacheStop','readHistoryRuns','readHistoryItems','state','stateChunk','downloadPage','defectPage','workDetail','validateDefectSelection','validateDownloadSelection','defectOverview','exportWorkDiagnostic','cancelFileCheck','filterWorks','startupReady','cancelLocalRemoval','reportCoverStatus'].includes(name))throw new Error('正在删除本地文件，请先取消删除并等待当前作品处理完成');
      if(nasRemoval?.running&&!['nasCataloguePage','nasCatalogueGroups','nasCatalogueWork','nasCataloguePreview','stopNASCatalogue','deletionPendingPage','validateDeletionSelection','stopScopedDeletion','stopDeletionResolution','cancelPreparedDeletion','audioPage','audioStatus','audioRelease','audioRenew','cacheStop','readHistoryRuns','readHistoryItems','state','stateChunk','downloadPage','defectPage','workDetail','validateDefectSelection','validateDownloadSelection','defectOverview','exportWorkDiagnostic','cancelFileCheck','filterWorks','startupReady','cancelNASRemoval','reportCoverStatus'].includes(name))throw Error('正在处理 NAS 备份，请先停止并等待当前批次完成');
      if((readLocked()||loggingOut)&&!['nasCataloguePage','nasCatalogueGroups','nasCatalogueWork','nasCataloguePreview','stopNASCatalogue','deletionPendingPage','validateDeletionSelection','stopScopedDeletion','stopDeletionResolution','cancelPreparedDeletion','audioPage','audioStatus','audioRelease','audioRenew','cacheStop','readHistoryRuns','readHistoryItems','state','stateChunk','downloadPage','defectPage','workDetail','validateDefectSelection','validateDownloadSelection','defectOverview','exportWorkDiagnostic','cancelFileCheck','filterWorks','startupReady','stopSync','stopDefectRepair','stopWorkCreators','reportCoverStatus'].includes(name))throw new Error(readLocked()?'正在读取或补齐，请先停止当前任务':'正在退出登录，请稍候');
      if(backupBusy&&!['nasCataloguePage','nasCatalogueGroups','nasCatalogueWork','nasCataloguePreview','stopNASCatalogue','deletionPendingPage','validateDeletionSelection','stopScopedDeletion','stopDeletionResolution','cancelPreparedDeletion','audioPage','audioStatus','audioRelease','audioRenew','cacheStop','readHistoryRuns','readHistoryItems','state','stateChunk','downloadPage','defectPage','workDetail','validateDefectSelection','validateDownloadSelection','defectOverview','exportWorkDiagnostic','cancelFileCheck','filterWorks','startupReady','pause','stopSync'].includes(name))throw new Error('正在更新本机资料，请稍候');
      if(scopedActive()){
        if(['prepareCatalogueDeletion','prepareNASRestore','confirmNASRestore','resolveDeletionPending','refreshFiles','audioResume','flatStart','flatResume','flatRetry','startRepairs','resume','logout','openAccount','startQrLogin','finishLogin','importLoginConfig','configureBackup','checkBackup','syncBackup','acceptRemoteBackup','importExistingLibrary','chooseRoot','resumeReconcile','sync','confirmCollectionRead','readAuthor','addAuthor','archiveAuthor','addCollections','importLink','prepareScopedDeletion','retryScopedDeletion'].includes(name))throw Error('正在处理删除范围，请先停止并等待当前步骤完成');
        const listMethods=['download','retryDownloads','previewDownloads','repairVideoCover','flatPrepare','audioSave','audioRemove'];
        const targets=name==='retryDownloads'&&args[0]===null?queue.jobs.filter(j=>j.state==='failed').map(j=>j.id):listMethods.includes(name)?(name==='flatPrepare'?args[1]:args[0]):['audioPrepare','audioRefresh','checkSource','setTags','markSourceUnavailable'].includes(name)?[args[0]]:[];
        if(Array.isArray(targets)&&targets.some(id=>scopedFileIds.has(id)))throw Error('所选作品正在进行文件删除，请等待当前步骤完成');
      }
      if(writes.has(name))backup.assertWritable();
      if(guarded){if(inFlightActions.has(name))throw new Error('这个操作正在处理，请稍候');inFlightActions.add(name);let finish;const promise=new Promise(resolve=>finish=resolve);actionDrains.set(name,{promise,finish});entered=true;}
      return { ok: true, data: await action(...args) };
    } catch (error) { notify();return { ok: false, error: error.message || '操作未完成' }; }
    finally{if(entered){inFlightActions.delete(name);actionDrains.get(name)?.finish();actionDrains.delete(name);}}
  });
}
function ensureIdle() { if (scopedActive() || repairChecks?.running || nasRemoval?.running || localRemoval?.running || backupBusy || readLocked() || loggingOut || collector.authenticating || collector.verifyingIdentity || queue.running || flatQueue?.running || collector.waiters.size) throw new Error('请先暂停下载并等待当前读取或账号核验结束，再进行此操作'); }
async function foregroundRead(action){ensureIdle();readStarting=true;const resumeAudio=audio&&!audio.paused;try{await audio?.suspendNetwork();return await backup.withForegroundRead(action);}finally{readStarting=false;if(resumeAudio)audio.resume();notify();}}
function confirmFlatExit(){
 if(exitPrompt)return;exitPrompt=true;
 void dialog.showMessageBox(window,{type:'question',message:'取消剩余单独下载并退出？',detail:'已完成的图片和视频会保留。单独下载仅在本次运行中有效，退出后无法继续这些临时任务。',buttons:['继续使用','取消剩余任务并退出'],defaultId:0,cancelId:0}).then(({response})=>{if(response===1){exitConfirmed=true;app.quit();}}).finally(()=>{exitPrompt=false;});
}

app.whenReady().then(async () => {
try {
  const profile = app.getPath('userData');
  diagnostics=createDiagnostics(profile);
  diagnostics.record({event:'startup',version:appVersion});
  process.on('uncaughtExceptionMonitor',error=>diagnostics.record({event:'uncaught',name:error.name,code:error.code}));
  app.on('child-process-gone',(_event,details)=>diagnostics.record({event:'child-process-gone',reason:details.reason,exitCode:details.exitCode}));
  const area=screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({ title: '藏匣', icon:path.join(here,'..','assets','icon.ico'), useContentSize:true, width:Math.min(1400,Math.floor(area.width*.94)), height:Math.min(area.height-40,Math.max(640,Math.floor(area.height*.92))), minWidth:Math.min(1000,Math.floor(area.width*.94)), minHeight:Math.min(640,area.height-40), show: !smoke && !packageSmoke && !sampleProbe && !qrProbe, backgroundColor: '#f7f8fa', autoHideMenuBar: true, webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.on('close',event=>{if(scopedActive()){event.preventDefault();stopScopedForExit();return;}if(nasRemoval?.running){event.preventDefault();stopNASForExit();return;}if(localRemoval?.running){event.preventDefault();stopRemovalForExit();return;}if(startupLoading)startupClosing=true;});
  window.on('closed',()=>{if(!quitting)app.quit();});
  await window.loadFile(path.join(here,'startup.html'));startupStage('window-visible');
  if(quitting||window.isDestroyed())return;
  store = await Store.open(path.join(profile, 'library.sqlite'), path.join(app.getPath('downloads'), '藏匣备份版'));
  repairChecks=new RepairChecks(store,notify);window.on('close',()=>repairChecks.close());
  backup=new BackupClient(store,profile,{vault:{seal:value=>{if(!safeStorage.isEncryptionAvailable())throw new Error('Windows 凭据加密不可用');return safeStorage.encryptString(value).toString('base64');},open:value=>safeStorage.decryptString(Buffer.from(value,'base64'))},onChange:notify,onDiagnostic:diagnostics.record,onUnavailable:()=>{if(!backup?.localReadDepth)collector?.stop();queue?.pause();flatQueue?.pauseAll();},isIdle:()=>!scopedActive()&&!repairChecks?.running&&!collector?.busy&&!collector?.authenticating&&!collector?.verifyingIdentity&&!queue?.running&&!flatQueue?.running&&!readStarting&&!loggingOut&&!backupBusy&&!localRemoval?.running&&!nasRemoval?.running&&(!audio?.running||audio?.waitingBackup)&&!audio?.pending.size});
  startupStage('library-open');
  if(quitting||window.isDestroyed())return;
  feed=new SnapshotFeed(store,{light:true});store.fileStates.onChange=notify;
  const httpProfile=session.fromPartition('cangxia-http');
  const browser=new SystemBrowser(path.join(profile,'system-browser'),{headless:smoke||sampleProbe,background:!smoke&&!sampleProbe});
  collector = new Collector(store, notify,{profile:httpProfile,vault:new AuthVault(path.join(profile,'login-state.bin'),safeStorage),browser,verifyIdentity:verifyAccountIdentity,onDiagnostic:diagnostics.record});
  collector.mediaRedirect=redirectHeaders(net,httpProfile,{credentials:'include',label:'媒体跳转'});
  // Local browsing must not wait for cookie restoration or account checks.
  collector.ready=collector.ready.catch(()=>collector.update('attention','登录状态未恢复，请重新连接原账号')).finally(()=>startupStage('session-ready'));
  backup.fetchCover=(url,options)=>collector.fetchMedia(url,options);
  creatorDetails=new CreatorDetails(collector);
  const authorReader=new AuthorReader(collector,{fetchLink:redirectHeaders(net,httpProfile)});
  queue = new DownloadQueue(store, collector, (url, options) => collector.fetchMedia(url, options), notify);queue.externalActive=()=>audio?.pending.size||0;
  audio=new WorkAudio({store,backup,collector,cache:backup.cache,notify:()=>{queue.wake?.();notify();},canNetwork:()=>!scopedActive()&&!collector.busy&&!collector.authenticating&&!queue.running&&!flatQueue?.running&&!repairChecks.running&&!localRemoval?.running&&!nasRemoval?.running&&!loggingOut,isIdle:()=>!scopedActive()&&!collector.busy&&!collector.authenticating&&!queue.running&&!flatQueue?.running&&!repairChecks.running&&!localRemoval?.running&&!nasRemoval?.running&&!loggingOut&&!readStarting&&!backup.syncing});backup.audio=audio;
  queue.hdCovers=new HDCover({store,helper:app.isPackaged?path.join(process.resourcesPath,'cover-helper','CangXiaCover.exe'):path.resolve('.test-output/cover-helper-dist/CangXiaCover/CangXiaCover.exe')});
  flatQueue=new FlatDownloadQueue({store,collector,fetchMedia:(url,options)=>collector.fetchMedia(url,options),notify,protectedPaths:[profile]});
  queue.backupRestore=(job,signal,options)=>job.catalogueLibrary?nasCatalogue.restoreJob(job,signal,(w,d)=>queue.metadata(w,d),options):backup.restoreWork(job,signal,(w,d)=>queue.metadata(w,d),options);
  queue.onIdle=()=>backup.afterDownloads();
  retentionTimer=setInterval(prunePrivateHistory,3600000);retentionTimer.unref();setTimeout(prunePrivateHistory,5000).unref();
  nasCatalogue=new NasCatalogue({store,backup,profile,onChange:notify,restoreFiles:async selected=>{const media=selected.filter(id=>store.get('backup_downloads',id)?.assets?.length),sounds=selected.filter(id=>store.get('backup_downloads',id)?.audio);if(media.length)queue.enqueue(media,{source:'nas',catalogueLibrary:backup.meta.libraryId});if(sounds.length)await audio.enqueue(sounds,'restore');}});backup.catalogue=nasCatalogue;
  handler('nasCataloguePage',input=>({...nasCatalogue.page(input),overview:nasCatalogue.overview()}));
  handler('nasCatalogueGroups',input=>nasCatalogue.groups(input));
  handler('refreshNASCatalogue',()=>nasCatalogue.refresh());
  handler('nasCatalogueWork',id=>{ids([id]);return nasCatalogue.workDetail(id);});
  handler('nasCataloguePreview',id=>{ids([id]);return nasCatalogue.preview(id);});
  handler('prepareNASRestore',input=>{ensureIdle();return nasCatalogue.prepareRestore(input);});
  handler('confirmNASRestore',token=>{ensureIdle();return nasCatalogue.restore(token);});
  handler('stopNASCatalogue',()=>{nasCatalogue.stop();return nasCatalogue.state();});

  localRemoval=new LocalRemoval({store,trash:dir=>shell.trashItem(dir),before:async()=>{await audio.suspendNetwork();backup.cancel();if(backup.syncing)await backup.syncing.catch(()=>{});if(backup.checking)await backup.checking.catch(()=>{});},after:()=>{queue.jobs=store.getSetting('downloadJobs')||[];store.invalidateViews();notify();if(!removalExit)backup.deferSync();},notify});
  handler('cancelLocalRemoval',()=>localRemoval.cancel());
  scopedDeletion=new DeletionCoordinator({store,backup,trash:dir=>shell.trashItem(dir),onChange:notify});
  backup.deletions.localCoordinator=scopedDeletion;backup.deletions.trash=dir=>shell.trashItem(dir);
  backup.beforeScopedDeletion=async input=>{scopedFileIds=new Set(input.files?input.ids:[]);const unblock=previewFiles.block(scopedFileIds);try{if(input.files){const pending=['download','audioSave','repairVideoCover','retryDownloads','flatStart','startRepairs'].map(name=>actionDrains.get(name)?.promise).filter(Boolean);await waitDeletionWriter(Promise.all(pending),{signal:input.signal});input.signal?.throwIfAborted();}await quiesceSelectedDeletion(input,{queue,audio,flatQueue,reconcile:store.localReconcile,previews:previewFiles,signal:input.signal});}catch(error){unblock();scopedFileIds.clear();throw error;}return()=>{unblock();scopedFileIds.clear();notify();};};
  const prepareScoped=async input=>{if(readLocked()||loggingOut||repairChecks.running||defectRepair?.running||backupBusy||backup.deletions.state().running)throw Error('请先停止读取或检查再准备删除');ids(input?.ids);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['ids','source','records','files','target'].includes(k)))throw Error('删除范围参数无效');scopedPreparing=scopedDeletion.prepare(input);try{return await scopedPreparing;}finally{scopedPreparing=null;notify();}};
  const beginScoped=promise=>{scopedTask=Promise.resolve(promise).catch(error=>{window?.webContents.send('cangxia:notice',error.message);}).finally(()=>{scopedTask=null;store.invalidateViews();notify();prunePrivateHistory();});notify();return scopedDeletion.state();};
  handler('prepareScopedDeletion',prepareScoped);
  handler('prepareCatalogueDeletion',async input=>{if(!input||!['nas','local-nas','local'].includes(input.target))throw Error('删除范围无效');const selected=nasCatalogue.selection(input.selection);await nasCatalogue.refresh();nasCatalogue.selection(input.selection);return prepareScoped({ids:selected,source:input.source,records:input.records,files:input.files,target:input.target});});
  handler('cancelPreparedDeletion',token=>{const discarded=scopedDeletion.discard(token);if(discarded)prunePrivateHistory();return discarded;});
  handler('confirmScopedDeletion',token=>{if(backup.deletions.state().running)throw Error('请先停止待处理操作');return beginScoped(scopedDeletion.confirm(token));});
  handler('stopScopedDeletion',()=>{scopedDeletion.stop();return scopedDeletion.state();});
  handler('retryScopedDeletion',id=>{if(backup.deletions.state().running)throw Error('请先停止待处理操作');return beginScoped(scopedDeletion.retry(id));});
  handler('deletionPendingPage',options=>backup.deletions.page(options));
  handler('validateDeletionSelection',input=>backup.deletions.validateSelection(input));
  handler('refreshDeletionPending',()=>backup.deletions.refresh());
  handler('resolveDeletionPending',input=>{if(scopedDeletion.running||scopedDeletion.preparing||readLocked()||repairChecks.running||backupBusy)throw Error('请先停止当前读取或文件操作');backup.deletions.selected(input?.selection);if(!['restore','remove-local','later'].includes(input?.action))throw Error('待处理操作无效');return backup.deletions.resolve(input);});
  handler('stopDeletionResolution',()=>{backup.deletions.stop();return backup.deletions.state();});
  // Old direct-removal APIs deliberately cannot bypass the scoped confirmation.
  for(const name of ['prepareNASRemoval','confirmNASRemoval','cancelNASRemoval','resumeNASRemoval'])handler(name,()=>{throw Error('请使用新的删除范围确认窗口');});
  defectRepair=new DefectRepair({store,backup,collector,queue,profile,runForeground:foregroundRead,onChange:notify});
  handler('defectOverview',()=>defectRepair.overview());
  handler('validateDefectSelection',input=>{ids(input?.ids);return defectRepair.validateSelection(input);});
  handler('validateDownloadSelection',input=>{ids(input?.ids);return queue.taskRows.validateSelection(input);});
  handler('inspectDefects',(input={})=>{if(!input||typeof input!=='object'||Array.isArray(input))throw Error('检查选择无效');const selected=input.ids!==undefined?ids(input.ids):input.selection!==undefined?defectRepair.selection(input.selection,{verify:true}):undefined;return foregroundRead(()=>defectRepair.scan({compact:true,ids:selected}));});
  handler('defectPage',options=>defectRepair.page(options));
  handler('startDefectRepair',selected=>{ensureIdle();backup.assertWritable();return defectRepair.start(Array.isArray(selected)?ids(selected):selected);});
  handler('resumeDefectRepair',()=>{ensureIdle();backup.assertWritable();return defectRepair.start(null,{resume:true});});
  handler('stopDefectRepair',()=>{defectRepair.stop();return true;});
  handler('reportCoverStatus',(id,failed)=>{ids([id]);if(scopedFileIds.has(id)||!store.work(id)||typeof failed!=='boolean')return false;const previous=backup.covers.problems.get(id);if(failed&&!previous)backup.covers.reportProblem(id,'界面无法显示封面，可定向检查并补齐','display');else if(!failed&&previous?.kind==='display')backup.covers.clearProblem(id);return true;});
  async function restoreBackupAuth(){await collector.ready;if(collector.verifyingIdentity)return;await collector.profile.clearStorageData({storages:['cookies']});collector.status.connected=false;await collector.restore();}
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
    let legacy=process.env.CANGXIA_BACKUP_TEST_PROFILE&&process.env.CANGXIA_BACKUP_TEST_ORIGINAL?process.env.CANGXIA_BACKUP_TEST_ORIGINAL:path.join(app.getPath('appData'),'藏匣');let file=path.join(legacy,'library.sqlite');
    if(kind==='author'){legacy=process.env.CANGXIA_BACKUP_TEST_PROFILE?(process.env.CANGXIA_BACKUP_TEST_AUTHOR||path.join(path.dirname(profile),'author-original')):path.join(app.getPath('appData'),'藏匣作者下载试验版');file=path.join(legacy,'library.sqlite');}
    if(kind==='nas'){const isolated=path.join(app.getPath('appData'),'藏匣NAS版');if(fs.existsSync(path.join(isolated,'library-location.json')))legacy=isolated;const c=JSON.parse(fs.readFileSync(path.join(legacy,'library-location.json'),'utf8'));if(!c.id||!/^[a-f0-9-]+$/.test(c.id))throw new Error('没有可导入的 NAS 版缓存');let name=c.id+'.sqlite';try{const active=fs.readFileSync(path.join(legacy,'nas-cache',c.id+'.active'),'utf8').trim();if(active.startsWith(c.id+'-')&&/^[a-f0-9-]+\.sqlite$/.test(active))name=active;}catch{}file=path.join(legacy,'nas-cache',name);}
    else if(!['local','author'].includes(kind))throw new Error('导入来源无效');
    if(!fs.existsSync(file))throw new Error('未找到旧版资料');const temp=path.join(profile,'import-preview.sqlite');await SqliteStore.copyFile(file,temp);const source=await Store.open(temp,path.join(app.getPath('downloads'),'藏匣'));
    try{
      const currentKey=store.getSetting('browserAccountKey'),sourceKey=source.getSetting('browserAccountKey');
      if(currentKey&&sourceKey&&currentKey!==sourceKey){
        const currentUid=currentKey.startsWith('uid:')?currentKey.slice(4):store.getSetting('account')?.uid;
        const sourceUid=sourceKey.startsWith('uid:')?sourceKey.slice(4):source.getSetting('account')?.uid;
        if(sourceUid){if(!currentUid||currentUid!==sourceUid)throw new Error('旧资料与当前备份库绑定的抖音账号不同，未合并导入');}
        else{
          if(!currentUid||!collector.status.connected)throw new Error('请先登录当前备份库的抖音账号，再核对旧版资料的归属');
          const identity=await verifyAccountIdentity(httpProfile,collector.userAgent,{legacyCollections:source.all('collections').filter(c=>c.id!== '__all__'&&c.added).map(c=>c.id)});
          if(identity.uid!==currentUid||!identity.ownsLegacyCollection)throw new Error('无法核对旧资料归属，未合并导入');
        }
        if(store.getSetting('browserAccountKey')!==currentKey)throw new Error('资料库账号信息刚发生变化，请重新预览');
        source.setSetting('browserAccountKey',currentKey);source.setSetting('account',store.getSetting('account'));
      }
      await source.pruneDeletedDownloads();return source;
    }catch(e){source.close();throw e;}
  }
  handler('previewExistingLibrary',async kind=>{ensureIdle();if(store.all('works').length)throw new Error('当前备份版本机库已有记录，不能直接合并导入');const source=await oldLibrary(kind);try{const entries=exportRecords(source),downloads=source.all('downloads');let files=0,bytes=0;for(const d of downloads)for(const a of d.assets||[])if(source.assetExists(d,a)){files++;bytes+=a.size||0;}importPreview={token:randomUUID(),kind,works:entries.filter(e=>e.table==='works').length,files,bytes};return importPreview;}finally{source.close();}});
  handler('importExistingLibrary',async token=>{ensureIdle();if(!importPreview||importPreview.token!==token||store.all('works').length)throw new Error('请重新预览导入范围');const kind=importPreview.kind;importPreview=null;backupBusy=true;backup.applying=true;notify();let source;try{
    source=await oldLibrary(kind);const entries=exportRecords(source).filter(e=>e.table!=='downloads');applyChanges(store,entries);const errors=[];let count=0;
    for(const original of source.all('downloads')){if(!store.work(original.id))continue;const target=importDestination(store,source,original);fs.mkdirSync(target.dir,{recursive:true});const assets=[];
      for(const a of original.assets||[]){if(!source.assetExists(original,a))continue;try{backup.status.progress='正在复制已有文件：'+a.file;notify();await fs.promises.copyFile(requireInside(original.path,path.join(original.path,a.file)),requireInside(target.dir,path.join(target.dir,a.file)),fs.constants.COPYFILE_EXCL);assets.push(a);count++;}catch(e){errors.push(e.message);}}
      if(assets.length)store.put('downloads',original.id,{...original,path:target.dir,collectionId:target.collectionId,home:target.home,assets,state:assets.length===original.assets.length?original.state:'partial'});
    }store.save();return {works:entries.filter(e=>e.table==='works').length,files:count,errors};
  }finally{source?.close();backup.applying=false;backupBusy=false;backup.status.progress='';await backup.changed();notify();}});
  collector.onAccessHold=()=>{queue.pause();flatQueue.pauseAll();};
  collector.onBrowserStop=collector.onAccessHold;
  const qrProfile=session.fromPartition('persist:cangxia-popup-login');
  qrProfile.on('will-download',event=>event.preventDefault());
  qrProfile.setPermissionRequestHandler((_wc,permission,callback,details)=>callback(permission==='storage-access'&&isDouyinURL(details?.requestingUrl||'')));
  qrProfile.setPermissionCheckHandler((_wc,permission,origin)=>permission==='storage-access'&&isDouyinURL(origin||''));
  qrLogin=new QrLogin({profile:qrProfile,chromiumVersion:process.versions.chrome,onChange:notify,onAuthenticated:(auth,options)=>collector.applyAuth(auth,true,options),onLimit:()=>collector.holdAccess(),createWindow:()=>new VerificationView({parent:()=>window,partition:'persist:cangxia-popup-login',onVisibility:(inline,pageId,panelFound=false)=>qrLogin.update({inline,pageId,panelFound,pageRevision:(qrLogin.state().pageRevision||0)+1})})});
  const cacheRoot = path.join(profile, 'covers'); fs.mkdirSync(cacheRoot, { recursive: true });
  protocol.handle('app-media', async request => {
    try {
      const u = new URL(request.url); const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const [id, filename] = parts;
      if(u.hostname==='nas-asset')return await nasCatalogue.media(id,filename,{signal:request.signal,range:request.headers.get('range'),method:request.method,libraryId:u.searchParams.get('library'),revision:Number(u.searchParams.get('revision'))}); if (!/^\d+$/.test(id || '')) return new Response('', { status: 404 });
      let file;
      if(scopedFileIds.has(id)&&['audio','asset','cover'].includes(u.hostname))return new Response('',{status:423,headers:{'cache-control':'no-store'}});
      if(u.hostname==='audio'){file=audio.playbackFile(id,filename);} else if (u.hostname === 'stream') {
        if(!backup.status.writable)return new Response('',{status:503});
        const work=store.work(id);if(work?.remoteState==='unavailable')return new Response('',{status:410});const source=work?.videoUrls?.[0];if(!source)return new Response('',{status:404});
        const range=request.headers.get('range');return await collector.fetchMedia(source,{signal:AbortSignal.timeout(120000),headers:range?{Range:range}:{}});
      } else if (u.hostname === 'asset') {
        const d = store.download(id); const asset = d?.assets.find(a => a.file === filename);
        if (!asset || !store.assetExists(d, asset)) return new Response('', { status: 404 });
        file = requireInside(d.path, path.join(d.path, asset.file));
      } else if(u.hostname==='nas-cover'){file=await nasCatalogue.cover(id,{signal:request.signal,libraryId:u.searchParams.get('library')});if(!file)return new Response('',{status:404});
      } else if (u.hostname === 'cover') {
        const d = store.download(id), cover = bestCover(d)||d?.assets.find(a => a.key === 'image-0');
        if (cover && store.assetExists(d, cover)) file = requireInside(d.path, path.join(d.path, cover.file));
        else {
          file=await backup.covers.get(id,{preferDouyin:true,signal:request.signal});
          if(!file)return new Response('',{status:404,headers:{'cache-control':'no-store'}});
        }
      } else return new Response('', { status: 404 });
      const row=store.rows('SELECT key FROM media_cache_objects WHERE file=?',[file])[0],release=row?backup.cache.pin(row.key):()=>{};return await previewFiles.open(id,file,request,{release});
    } catch(error) {try{const u=new URL(request.url),id=u.pathname.split('/').filter(Boolean)[0];if(!request.signal.aborted&&!scopedFileIds.has(id)&&u.hostname==='cover'&&/^\d+$/.test(id)&&!backup.covers.problems.has(id))backup.covers.reportProblem(id,'封面显示失败：'+error.message,'display');}catch{}return new Response('', { status: 404, headers:{'cache-control':'no-store'} }); }
  });
  handler('startupReady',()=>{if(!rendererReady){rendererReady=true;startupStage('library-visible');store.fileStates.monitor();notify();void store.fileStates.scan().catch(error=>diagnostics.record({event:'file-check-failed',reason:error.message}));}return true;});
  handler('cancelFileCheck',()=>store.fileStates.cancelScan());
  handler('audioPage',(page,state)=>audio.page(page,state));
  handler('audioStatus',(id,context)=>{ids([id]);return context?nasCatalogue.audioStatus(id,context):audio.status(id);});
  handler('audioPrepare',(id,requestId,context)=>{ids([id]);if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId))throw Error('播放请求无效');return context?nasCatalogue.prepareAudio(id,requestId,context):audio.preparePlayback(id,requestId);});
  handler('audioRelease',(id,token,requestId)=>{ids([id]);audio.releasePlayback(id,token,requestId);return true;});
  handler('audioRenew',(id,token)=>{ids([id]);audio.renewPlayback(id,token);return true;});
  handler('audioRefresh',id=>{ids([id]);return audio.refresh(id);});
  handler('audioSave',async(selected,mode,context)=>{if(!['local','nas','info','restore'].includes(mode))throw Error('配乐保存方式无效');if(mode==='nas'&&!backup.status.sharedAudio)throw Error('NAS 尚不支持共享配乐，请配套升级');const requested=ids(selected);if(context)return nasCatalogue.saveAudio(requested,mode,context);const nasOnly=[];for(const id of requested)if(!store.work(id)&&nasCatalogue.cachedWork(id)){await nasCatalogue.ensureLocalMetadata(id);if(mode==='local'&&store.get('backup_downloads',id)?.audio?.state==='saved')nasOnly.push(id);}if(nasOnly.length)await audio.enqueue(nasOnly,'restore');const rest=requested.filter(id=>!nasOnly.includes(id));return rest.length?audio.enqueue(rest,mode):audio.state();});
  handler('audioPause',()=>{audio.pause();return audio.state();});handler('audioResume',()=>{audio.resume();return audio.state();});handler('audioCancel',selected=>audio.cancel(selected===undefined?null:ids(selected)));
  handler('audioRemove',async selected=>{const requested=ids(selected);return withReleasedPreviews(requested,previewFiles,async()=>{for(const id of requested)await audio.removeLocal(id,{trash:file=>shell.trashItem(file)});return true;},'audio');});
  handler('cacheSettings',value=>backup.cache.setLimits(value));handler('cacheClear',kinds=>backup.cache.clear(kinds));handler('cacheStop',()=>{backup.cache.stopClear();return true;});
  handler('workDetail',async id=>{ids([id]);return store.lightViews.detail(id);});
  handler('filterWorks',async(selected,options)=>({ids:await store.lightViews.search.query(ids(selected),options)}));
  handler('state', async () => {
    await store.lightViews.prepare();
    const state=snapshot();if(firstState){firstState=false;startupStage('snapshot-ready');}if(state.works.length<=1000)return state;
    for(const [id,transfer]of stateTransfers)if(transfer.expires<Date.now())stateTransfers.delete(id);
    if(stateTransfers.size>=2)stateTransfers.delete(stateTransfers.keys().next().value);
    const token=randomUUID(),{works,...head}=state;stateTransfers.set(token,{works,expires:Date.now()+120000});return {chunkedState:true,token,head,total:works.length};
  });
  handler('stateChunk',(token,offset)=>{const transfer=stateTransfers.get(token);if(!transfer||transfer.expires<Date.now()||!Number.isSafeInteger(offset)||offset<0||offset>=transfer.works.length)throw new Error('界面状态已更新，请重新加载');const works=transfer.works.slice(offset,offset+1000),done=offset+works.length>=transfer.works.length;if(done)stateTransfers.delete(token);return {works,done};});
  handler('openAccount', async preferred => {ensureIdle();qrLogin.cancel();if(store.getSetting('loggedOut'))await browser.clearLoginData();return collector.open(preferred);});
  handler('startQrLogin',async()=>{ensureIdle();collector.assertNotCoolingDown();await browser.hideLogin();collector.status.browserOpened=false;if(collector.status.needsLogin||store.getSetting('loggedOut')){qrLogin.cancel();await qrProfile.clearStorageData();}return qrLogin.start();});
  handler('confirmLegacyAccount',async token=>{ensureIdle();await collector.confirmLegacyAccount(token);qrLogin.cancel();notify();return snapshot();});
  handler('openDiagnostics',()=>shell.openPath(diagnostics.dir));
  handler('exportWorkDiagnostic',async id=>{ids([id]);const report=await buildWorkDiagnostic(store,id);const choice=await dialog.showSaveDialog(window,{title:'导出此作品的诊断记录',defaultPath:'藏匣作品诊断-'+id+'.json',filters:[{name:'JSON',extensions:['json']}]});if(choice.canceled||!choice.filePath)return {cancelled:true};await fs.promises.writeFile(choice.filePath,JSON.stringify(report,null,2),'utf8');return {cancelled:false};});
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
      qrLogin.cancel();queue.pause();await audio?.suspendNetwork();for(const id of networkBatches)flatQueue.pause(id);collector.cancelResolve();await collector.cancelAuthentication();await Promise.all([queue.waitForIdle(),...networkBatches.map(id=>flatQueue.waitForBatch(flatQueue.get(id)))]);
      let failed=false;try{await collector.logout();}catch{failed=true;}
      for(const operation of [()=>qrProfile.clearStorageData(),()=>qrProfile.clearCache()])try{await operation();}catch{failed=true;}
      collector.status.logoutIncomplete=failed;notify();
      if(failed)throw new Error('已断开登录，部分登录缓存未清理完成，请重试清理');
      return {loggedOut:true,collector:{...collector.status,busy:false},queue:queue.state({summary:true}),flatQueue:flatQueue.state()};
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
  handler('checkRepairs',selected=>{ensureIdle();if(backup.syncing||backup.checking)throw Error('请等待 NAS 同步结束后再检查本地文件');return repairChecks.check(ids(selected));});
  handler('cancelRepairs',()=>repairChecks.cancel());
  handler('repairPage',(token,page)=>repairChecks.page(token,page));
  handler('startRepairs',async selected=>{
    ensureIdle();if(backup.syncing||backup.checking)throw Error('请等待 NAS 同步结束后再确认补齐');const requested=typeof selected==='string'?repairChecks.missingIds(selected):ids(selected);
    const report=await repairChecks.check(requested,{confirming:true});if(report.phase!=='done')return {...report,started:0};
    const missing=repairChecks.missingIds(report.token);if(store.getSetting('loggedOut')&&missing.some(id=>!store.get('backup_downloads',id)?.assets?.length))throw Error('请登录原账号后再补齐未备份的作品');
    return {...report,started:missing.length?queue.enqueue(missing):0};
  });
  handler('sync', async(options = {}) => {
    if(!options||typeof options!=='object')throw new Error('读取选项无效');
    const epoch=collector.cancelEpoch;
    return foregroundRead(async()=>{if(epoch!==collector.cancelEpoch)throw Error('已停止，未开始读取');await collector.sync({...options,mode:options.mode||(options.readAll?'full':'quick')});return {collector:{...collector.status,busy:!!(collector.busy||collector.batchReading)},syncProgress:store.syncProgress(),collectionReadInfo:store.collectionReads.snapshot(),readSummary:options.discoverOnly||options.allAdded?null:collector.status.readSummary,...(options.discoverOnly?{collections:store.all('collections').sort((a,b)=>a.rank-b.rank)}:{})};});
  });
  handler('confirmCollectionRead',options=>foregroundRead(async()=>{if(!options||typeof options!=='object')throw new Error('确认选项无效');store.collectionReads.confirm(options.collectionId,options.mode,options.token);const errors=await store.reconcilePending();notify();if(errors.length)throw Error(errors.join('；'));return true;}));
  handler('resumeReconcile',()=>foregroundRead(async()=>{
    collector.busy=true;collector.cancelled=false;collector.stopRequested=false;collector.syncController=new AbortController();
    collector.status.readProgress={name:'本地作品整理',mode:'organize',checked:0,added:0,startedAt:Date.now(),stage:'organizing'};
    try{const errors=await store.reconcilePending({signal:collector.syncController.signal,onProgress:p=>collector.readProgress({stage:'organizing',organizing:p})});if(errors.length)throw Error(errors.join('；'));}
    finally{collector.busy=false;collector.syncController=null;collector.readProgress({stage:'finished'});notify();}
  }));
  handler('stopWorkCreators',id=>{if(!/^\d+$/.test(id))throw Error('作品标识无效');return creatorDetails.cancel(id);});
  handler('refreshWorkCreators',async(id,options={})=>{if(!/^\d+$/.test(id)||!options||typeof options!=='object'||(options.force!==undefined&&typeof options.force!=='boolean'))throw Error('作者信息请求无效');return foregroundRead(()=>creatorDetails.refresh(id,options));});
  handler('addAuthor',async text=>foregroundRead(()=>authorReader.add(text)));
  handler('readAuthor',async options=>{if(!options||typeof options!=='object')throw new Error('作者读取选项无效');return foregroundRead(async()=>{const result=await authorReader.read(options);return {...result,readSummary:collector.status.readSummary};});});
  handler('archiveAuthor',id=>{ensureIdle();store.authorSources.archive(id);notify();return true;});
  handler('clearCompleted', selected => {queue.clearCompleted(selected===null?null:ids(selected));return true;});
  handler('downloadPage', options=>queue.taskRows.page(options));
  handler('retryDownloads',selected=>{if(collector.busy||readLocked()||flatQueue.running)throw Error('请先结束读取或单独下载');return queue.retryFailed(selected===null?null:ids(selected));});
  handler('stopSync', () => {store.localReconcile.stop();if(defectRepair.running)defectRepair.stop();else collector.stop();});
  handler('addCollections', selected => { ensureIdle(); store.setAdded(ids(selected)); notify(); return true; });
  handler('importLink', async text => { ensureIdle(); if (typeof text !== 'string' || text.length > 6000) throw new Error('链接内容无效'); const w = await collector.importLink(text); notify(); return w?.id; });
  handler('previewDownloads',selected=>planDownloads(store,queue,ids(selected)).report);
  handler('readHistoryRuns',options=>store.readHistory.runs(options));
  handler('readHistoryItems',(token,options)=>store.readHistory.items(token,options));
  handler('clearReadHistory',()=>{if(readLocked())throw Error('请先停止当前读取再清理日志');return store.readHistory.clear();});
  handler('download', async(selected,options={}) => {
    if(!options||typeof options!=='object'||(options.source!==undefined&&!['douyin','nas'].includes(options.source)))throw Error('下载来源无效');const source=options.source||'douyin',requested=ids(selected);
    if(collector.busy||(collector.waiters.size&&!queue.running)||flatQueue.running)throw Error('请等待读取完成或暂停单独下载后再下载');
    if(source==='nas'){const sounds=requested.filter(id=>store.get('backup_downloads',id)?.audio),media=requested.filter(id=>store.get('backup_downloads',id)?.assets?.length);const count=queue.enqueue(media,{source});if(sounds.length)audio.enqueue(sounds,'restore');return {queued:count,audioQueued:sounds.length};}
    let plan=planDownloads(store,queue,requested,{scope:options.scope||'missing'});
    if(store.getSetting('loggedOut')&&plan.ids.some(id=>!store.get('backup_downloads',id)?.assets?.length))throw Error('请登录原账号后再下载未备份的作品');
    const removed=plan.excludedTasks.length?(await queue.cancel(plan.excludedTasks)).cancelled:0;
    plan=planDownloads(store,queue,requested,{scope:options.scope||'missing'});
    const queued=plan.ids.length?queue.enqueue(plan.ids,{source}):0;return {...plan.report,queued,removed};
  });
  handler('setDownloadConcurrency',value=>{queue.setConcurrency(value);return true;});
  handler('pause', () => queue.pause());
  handler('repairVideoCover',selected=>{if(collector.busy||flatQueue.running)throw Error('请等待当前读取或单独下载结束');backup.assertWritable();const requested=ids(selected),targets=requested.filter(id=>{const d=store.download(id);return store.work(id)?.type==='video'&&d?.assets?.some(a=>a.key==='video'&&store.assetExists(d,a));});if(!targets.length)throw Error('所选作品没有完整的本地视频，请先下载视频');return {queued:queue.enqueue(targets,{coverOnly:true}),skipped:requested.length-targets.length};});
  handler('cancelDownloads',(selected,options)=>queue.cancel(selected===null?null:ids(selected),options));
  handler('resume', () => { if (collector.busy || flatQueue.running) throw new Error('请等待同步完成或暂停单独下载');if(store.getSetting('loggedOut')&&queue.jobs.some(j=>j.state==='waiting'&&j.source!=='nas'&&!j.coverOnly&&!store.get('backup_downloads',j.id)?.assets?.length&&!store.isDownloaded(j.id)))throw new Error('请登录原账号后再继续下载未备份的作品');queue.resume(); });
  handler('refreshFiles',async()=>{if(!collector.busy&&!queue.running)await store.pruneDeletedDownloads();queue.jobs=store.getSetting('downloadJobs')||[];store.invalidateViews();void store.fileStates.scan().catch(error=>diagnostics.record({event:'file-check-failed',reason:error.message}));await backup.changed();notify();return snapshot();});
  handler('chooseRoot', async value => {
    ensureIdle();
    if (store.hasSavedFiles()||audio?.stats().savedWorks) throw new Error('原目录仍有本地文件，或暂时无法检查。请清空文件后点击“重新检查文件”。');
    store.setDownloadRoot(await requireLocalStorage(absolutePath(value)));notify();
    return store.root;
  });
  handler('openRoot', async () => { fs.mkdirSync(store.root, { recursive: true }); const error = await shell.openPath(store.root); if (error) throw new Error(error); });
  handler('openFolder', async id => {
    ids([id]); const d = store.download(id); if (!d) throw new Error('作品尚未下载'); store.assertDirectory(d.path);
    const error = await shell.openPath(d.path); if (error) throw new Error(error);
  });
  handler('openOriginal', async id => { ids([id]); const url = store.work(id)?.url||'https://www.douyin.com/video/'+id; if (!isDouyinURL(url)) throw new Error('作品链接无效'); await collector.openOriginal(url); });
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
  handler('checkSource',id=>{ids([id]);return foregroundRead(()=>collector.verifySource(id));});
  handler('markSourceUnavailable',id=>{ids([id]);ensureIdle();if(!store.work(id))throw Error('本机已没有此作品记录');return collector.markUnavailable(id,{reason:'用户在抖音确认原作品已失效',method:'user'});});
  handler('verifySources',selected=>{ensureIdle();return defectRepair.startVerification(Array.isArray(selected)?ids(selected):selected);});
  for(const name of ['prepareDelete','confirmDelete'])handler(name,()=>{throw Error('请使用新的删除范围确认窗口');});
  if (process.env.CANGXIA_DEV === '1') await window.loadURL('http://127.0.0.1:5173');
  else await window.loadFile(path.join(here, '..', 'dist', 'index.html'));
  startupLoading=false;
  if(packageSmoke){
    const data=await window.webContents.executeJavaScript('window.cangxia.state()');
    if(!app.isPackaged||data.version!==appVersion||data.storage.mode!=='backup'||data.works.length!==0)throw new Error('安装包启动检查失败');
    fs.writeFileSync(path.join(app.getPath('userData'),'package-smoke.json'),JSON.stringify({ok:true,version:appVersion,packaged:app.isPackaged,preload:true}));
    app.quit();return;
  }
  void collector.ready.then(async()=>{await store.pruneDeletedDownloads();queue.jobs=store.getSetting('downloadJobs')||[];notify();await backup.start();}).then(()=>restoreBackupAuth()).then(()=>backup.migrateCache()).catch(()=>{});
  window.on('close',event=>{if(nasRemoval?.running){event.preventDefault();stopNASForExit();return;}if(localRemoval?.running)return;if(!quitting&&!readLocked()&&!loggingOut&&!flatQueue.hasUnfinished()&&!exitApproved&&(backup.syncing||(backup.config&&backup.status.pending))){event.preventDefault();window.webContents.send('cangxia:exit-requested');}});
  window.on('focus', notify);
  window.on('close',event=>{if(nasRemoval?.running){event.preventDefault();stopNASForExit();return;}if(localRemoval?.running)return;if(!quitting&&readLocked()){event.preventDefault();lockedNotice();return;}if(loggingOut){event.preventDefault();window.webContents.send('cangxia:notice','正在退出登录，请等待登录信息清理完成');return;}if(!quitting&&!exitConfirmed&&flatQueue.hasUnfinished()){event.preventDefault();confirmFlatExit();return;}qrLogin?.cancel();});
  window.webContents.on('render-process-gone',(_event,details)=>{qrLogin?.cancel();diagnostics.record({event:'render-process-gone',reason:details.reason,exitCode:details.exitCode});collector.stop();queue.pause();flatQueue.pauseAll();void dialog.showMessageBox(window,{type:'warning',message:'界面进程已退出，已提交的读取进度仍保留',detail:'可以重新加载界面后继续。诊断记录保存在本机 diagnostics 目录。',buttons:['重新加载','退出'],defaultId:0,cancelId:1}).then(({response})=>{if(response===0)window.reload();else app.quit();});});
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
  if(quitting)return;
  if(startupClosing){app.quit();return;}
  if (smoke || sampleProbe || qrProbe) { fs.mkdirSync('.test-output', {recursive:true}); fs.writeFileSync('.test-output/startup-error.txt', error.stack || error.message); }
  else dialog.showErrorBox('藏匣启动失败', error.message);
  app.exit(1);
}
});
app.on('window-all-closed', () => app.quit());
app.on('second-instance',()=>{if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}});
function stopNASForExit(){if(nasExit)return;nasExit=true;nasRemoval.cancel();void nasRemoval.wait().finally(()=>{nasExit=false;app.quit();});}
function stopRemovalForExit(){if(removalExit)return;removalExit=true;localRemoval.cancel();void localRemoval.wait().finally(()=>{removalExit=false;app.quit();});}
function stopScopedForExit(){if(scopedExit)return;scopedExit=true;scopedDeletion?.stop();backup?.deletions.stop();nasCatalogue?.stop();void Promise.allSettled([scopedTask,scopedPreparing,backup?.deletions.resolutionPromise,nasCatalogue?.preparingPromise,nasCatalogue?.restoringPromise].filter(Boolean)).finally(()=>{scopedExit=false;app.quit();});}
app.on('before-quit', event => {
  if(quitting)return;
  if(scopedActive()){event.preventDefault();stopScopedForExit();return;}
  if(nasRemoval?.running){event.preventDefault();stopNASForExit();return;}
  if(localRemoval?.running){event.preventDefault();stopRemovalForExit();return;}
  if(readLocked()||loggingOut){event.preventDefault();if(readLocked())lockedNotice();return;}
  if(!exitConfirmed&&flatQueue?.hasUnfinished()){event.preventDefault();confirmFlatExit();return;}
  if(!exitApproved&&window&&!window.isDestroyed()&&(backup?.syncing||(backup?.config&&backup?.status.pending))){event.preventDefault();window.webContents.send('cangxia:exit-requested');return;}
  event.preventDefault();quitting=true;qrLogin?.cancel();queue?.pause();const flatClose=flatQueue?.dispose();const browserClose=collector?.dispose();clearTimeout(timer);clearInterval(retentionTimer);
  void (async()=>{
    try{await flatClose;}catch{dialog.showErrorBox('临时文件未完全清理','单独下载任务已取消；目标目录中的 .cangxia-flat- 开头临时文件夹可能仍有未完成片段，可在退出后删除。');}
    for(let i=0;i<50&&(queue?.running||collector?.busy);i++)await new Promise(r=>setTimeout(r,100));
    await Promise.race([browserClose||Promise.resolve(),new Promise(r=>setTimeout(r,3000))]);
    diagnostics?.record({event:'shutdown',reason:collector?.busy?'pending-request':'normal'});diagnostics?.close();await audio?.close();await nasCatalogue?.close();await backup?.close();await store?.fileStates.close();await repairChecks?.close();defectRepair?.close();if(!collector?.busy)store?.close();app.exit(0);
  })();
});
