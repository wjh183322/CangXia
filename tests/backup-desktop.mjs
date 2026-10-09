import {checkAuthorDesktop} from './author-desktop-checks.mjs';
import {app,session,shell} from 'electron';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
app.disableHardwareAcceleration();const settings=JSON.parse(process.env.CANGXIA_BACKUP_TEST_SETTINGS||'null');if(!settings)throw new Error('Run scripts/backup-desktop-test.mjs');const checks=[];let started=false,hdProbeCalls=0;
const timeout=setTimeout(()=>{console.error('Backup desktop timeout');app.exit(1);},90000);
app.on('browser-window-created',(_e,win)=>{if(started)return;started=true;win.webContents.on('did-finish-load',()=>{if(!win.webContents.getURL().endsWith('/index.html'))return;void(async()=>{
 const call=(method,...args)=>win.webContents.executeJavaScript(`window.cangxia[${JSON.stringify(method)}](...${JSON.stringify(args)})`);const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
 try{
  let data=await call('state');check('backup starts isolated and read-only',data.storage.mode==='backup'&&!data.storage.writable&&data.works.length===0);
  const title=await win.webContents.executeJavaScript('document.title');check('backup title and settings identify the correct edition',title.includes('藏匣备份版 v'+data.version)&&win.getTitle()===title);
  await call('setDownloadConcurrency',6);check('native concurrency setting works without NAS and rejects invalid limits',(await call('state')).queue.concurrency===6);await assert.rejects(call('setDownloadConcurrency',7));await call('setDownloadConcurrency',3);
  await assert.rejects(call('setTags','123',['blocked']));check('mutations rejected before NAS comparison',true);
  await call('configureBackup',settings);data=await call('state');check('pinned HTTPS service permits local use after comparison',data.storage.writable===true);
  const preview=await call('previewExistingLibrary','local');check('import preview reports fixture records and preserves the empty destination',preview.works===1&&preview.files===3&&(await call('state')).works.length===0);
  await call('importExistingLibrary',preview.token);data=await call('state');check('copy import retains local media and marks pending changes',data.works[0].local&&data.storage.pending&&fs.existsSync(path.join(process.env.CANGXIA_BACKUP_TEST_ORIGINAL,'library.sqlite')));
  await call('syncBackup');data=await call('state');check('background sync confirms NAS state without removing local media',data.storage.phase==='synced'&&data.works[0].local&&data.works[0].backedUp);
  const searched=await call('filterWorks',data.works.map(w=>w.id),{query:'备份版桌面'});check('native indexed search returns matching IDs without restoring heavy list descriptions',searched.ids.join(',')==='123'&&data.works[0].description===undefined);
  const intent=await call('prepareDelete',['123'],'local');assert.equal(intent.backup,true);check('list state omits local paths and full file manifests',data.works[0].localRecord.path===undefined);const local=(await call('workDetail','123')).localRecord;assert.ok(local.path.startsWith(path.dirname(process.env.CANGXIA_BACKUP_TEST_PROFILE)+path.sep));for(const a of local.assets)fs.unlinkSync(path.join(local.path,a.file));data=await call('refreshFiles');check('clearing local files retains NAS backup',!data.works[0].local&&data.works[0].backedUp);
  const image=await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve({width:img.naturalWidth,height:img.naturalHeight});img.onerror=()=>reject(new Error('NAS cover failed to decode'));img.src='app-media://cover/123?fresh-profile-test';})`);
  check('NAS cover decodes without local media or Douyin credentials',image.width===1&&image.height===1&&!(await call('state')).works[0].local&&!fs.existsSync(path.join(process.env.CANGXIA_BACKUP_TEST_PROFILE,'login-state.bin')));
  await call('download',['123'],{source:'nas'});const end=Date.now()+15000;do{await new Promise(r=>setTimeout(r,100));data=await call('state');}while(data.queue.running&&Date.now()<end);
  check('download restores from NAS without a Douyin login',data.works[0].local&&data.works[0].downloaded);while((await call('state')).storage.syncing)await new Promise(r=>setTimeout(r,100));
  await call('setTags','123',['desktop-tag']);data=await call('state');check('local tag edit does not wait for NAS upload',data.works[0].localTags.includes('desktop-tag')&&data.storage.pending);
  await call('syncBackup');await win.webContents.executeJavaScript(`document.querySelector('[aria-label="设置"]').click()`);await new Promise(r=>setTimeout(r,300));const text=await win.webContents.executeJavaScript(`document.querySelector('.backup-connection').open=true;document.querySelector('.modal').innerText`);
  check('settings display sync time, device and connection controls',text.includes('上次同步')&&text.includes('最近提交电脑')&&text.includes('NAS 服务地址'));
  const http=session.fromPartition('cangxia-http'),originalFetch=http.fetch,identityCalls=[];http.fetch=async url=>{const route=new URL(url).pathname;identityCalls.push(route);if(route==='/aweme/v1/web/user/profile/self/')return new Response(JSON.stringify({status_code:0,user:{uid:'456',nickname:'fixture account'}}));if(route==='/aweme/v1/web/collects/list/')return new Response(JSON.stringify({status_code:0,collects_list:[{collects_id_str:'9'}],has_more:0}));throw new Error('Unexpected account request');};
  const loginFile=path.join(path.dirname(process.env.CANGXIA_BACKUP_TEST_PROFILE),'fixture-login.json');fs.writeFileSync(loginFile,JSON.stringify({cookie:'sessionid=SYNTHETIC_ONLY; uid_tt=SYNTHETIC_CHANGED_COOKIE',user_agent:'Fixture/1'}));
  try{await call('importLoginConfig',loginFile);data=await call('state');check('real desktop upgrades legacy binding only after verifying self identity and folder ownership',data.collector.connected&&data.account.uid==='456'&&identityCalls.length===2);const sealed=fs.readFileSync(path.join(process.env.CANGXIA_BACKUP_TEST_PROFILE,'login-state.bin'));check('verified desktop login remains encrypted on disk',!sealed.includes(Buffer.from('SYNTHETIC_ONLY')));}finally{http.fetch=originalFetch;}
  const directoryFetch=http.fetch;let directoryRead=0;
  http.fetch=async url=>{if(new URL(url).pathname==='/aweme/v1/web/collects/list/')return new Response(JSON.stringify({status_code:0,collects_list:(directoryRead++===0?['11','12']:['12']).map(id=>({collects_id_str:id,collects_name:'穹'})),has_more:0}));return directoryFetch.call(http,url);};
  try{const first=await call('sync',{discoverOnly:true});check('native directory result returns both same-name folder IDs without the full work library',first.collections.filter(c=>c.name==='穹'&&!c.remoteMissing).length===2&&first.works===undefined);const second=await call('sync',{discoverOnly:true});check('native read completion directly supplies the refreshed directory and preserves the removed record',second.collector.phase==='done'&&second.collections.filter(c=>c.name==='穹'&&!c.remoteMissing).length===1&&second.collections.find(c=>c.id==='11').remoteMissing);await assert.rejects(call('addCollections',['11']),/当前目录/);}finally{http.fetch=directoryFetch;}
  await checkAuthorDesktop({win,http,call,check,profile:process.env.CANGXIA_BACKUP_TEST_PROFILE});
  const savedFetch=http.fetch;let activeTransfers=0,peakTransfers=0,detailQueries=0;
  const mediaBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6kAAAAASUVORK5CYII=','base64');
  http.fetch=async(url,options={})=>{
    if(new URL(url).pathname.includes('/aweme/detail/')){detailQueries++;throw Error('cached media must not refresh first');}
    const tracked=options.headers?.['Accept-Encoding']==='identity';if(!tracked)return new Response(mediaBytes,{headers:{'content-type':'image/png'}});
    activeTransfers++;peakTransfers=Math.max(peakTransfers,activeTransfers);let timer,finished=false;
    const finish=()=>{if(!finished){finished=true;activeTransfers--;clearTimeout(timer);}};
    const body=new ReadableStream({start(controller){timer=setTimeout(()=>{controller.enqueue(mediaBytes);controller.close();finish();},500);options.signal?.addEventListener('abort',()=>{if(!finished){finish();controller.error(Error('aborted'));}},{once:true});},cancel(){finish();}});
    return new Response(body,{headers:{'content-type':url.includes('douyinvod')?'video/mp4':'image/png','content-length':String(mediaBytes.length)}});
  };
  try{
    await call('setDownloadConcurrency',6);await call('download',['100002','100003','100004','100005','100006','100007']);let simultaneous=false;
    for(let i=0;i<120;i++){data=await call('state');if(data.queue.transferring===6)simultaneous=true;if(!data.queue.running)break;await new Promise(r=>setTimeout(r,50));}
    const completedPage=await call('downloadPage',{tab:'complete',page:1,pageSize:50});
    check('native normal queue transfers six cached works simultaneously without refreshing details',peakTransfers===6&&simultaneous&&detailQueries===0&&completedPage.jobs.filter(j=>Number(j.id)>=100002&&Number(j.id)<=100007).length===6);
    const report=await call('previewDownloads',['100002','100009']);check('native selection preview separates complete old media from unsaved works',report.selected===2&&report.unsaved===1&&report.complete===1);
    const oldMedia=await call('workDetail','100002'),oldFile=path.join(oldMedia.localRecord.path,oldMedia.localRecord.assets.find(a=>a.kind==='image').file),oldStamp=fs.statSync(oldFile).mtimeMs;
    const selectedDownload=await call('download',['100002','100009'],{source:'douyin',scope:'unsaved'});for(let i=0;i<120&&(await call('state')).queue.running;i++)await new Promise(r=>setTimeout(r,50));
    check('native new-only download queues one work and leaves the old media file untouched',selectedDownload.queued===1&&fs.statSync(oldFile).mtimeMs===oldStamp&&(await call('workDetail','100009')).downloaded);
  }finally{http.fetch=savedFetch;await call('setDownloadConcurrency',3);}
  const cancelFetch=http.fetch;let blockedTransfers=0;
  http.fetch=async(url,options={})=>{if(options.headers?.['Accept-Encoding']!=='identity')return new Response(mediaBytes,{headers:{'content-type':'image/png'}});blockedTransfers++;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));};
  try{
    await call('download',['100008','100010']);for(let i=0;i<100&&blockedTransfers<2;i++)await new Promise(r=>setTimeout(r,20));assert.equal(blockedTransfers,2);
    const one=await call('cancelDownloads',['100008']);data=await call('state');check('native single download cancellation leaves the other transfer and collection intact',one.cancelled===1&&!data.queue.jobs.some(j=>j.id==='100008')&&data.queue.jobs.some(j=>j.id==='100010')&&data.works.some(w=>w.id==='100008'));
    await call('cancelDownloads',null);for(let i=0;i<100;i++){data=await call('state');if(!data.queue.running)break;await new Promise(r=>setTimeout(r,20));}
    check('native bulk cancellation retains completed downloads and NAS copies',data.queue.counts.complete>=6&&data.queue.total===data.queue.counts.complete&&data.works.find(w=>w.id==='123').local&&data.works.find(w=>w.id==='123').backedUp);
  }finally{http.fetch=cancelFetch;}
  const originalTrash=shell.trashItem;let trashStarted,finishTrash;const begunTrash=new Promise(r=>trashStarted=r),trashGate=new Promise(r=>finishTrash=r);let trashCalls=0;
  shell.trashItem=async dir=>{assert.ok(dir.startsWith(path.dirname(process.env.CANGXIA_BACKUP_TEST_PROFILE)+path.sep));trashCalls++;trashStarted();await trashGate;await fs.promises.rename(dir,dir+'.fixture-recycled');};
  try{
    const intent=await call('prepareDelete',['100002','100003'],'local');await call('confirmDelete',intent.token);await begunTrash;
    check('native local deletion waits for NAS upload to stop',!(await call('state')).storage.syncing);
    await assert.rejects(call('download',['100004']),/删除本地文件/);await call('cancelLocalRemoval');finishTrash();
    for(let i=0;i<100;i++){data=await call('state');if(!data.localRemoval.running)break;await new Promise(r=>setTimeout(r,50));}
    check('native cancellation finishes current folder only and retains remaining local work',trashCalls===1&&data.localRemoval.phase==='cancelled'&&data.localRemoval.deleted===1&&!data.works.find(w=>w.id==='100002').local&&data.works.find(w=>w.id==='100003').local);
  }finally{finishTrash?.();shell.trashItem=originalTrash;}
  check('ordinary native download and NAS restore never launch HD processing',hdProbeCalls===0);
  const hdStart=await call('repairVideoCover',['100003','100004']);for(let i=0;i<100;i++){data=await call('state');if(!data.queue.running)break;await new Promise(r=>setTimeout(r,30));}
  const hdCompleted=await call('downloadPage',{tab:'complete',page:1,pageSize:50});
  check('explicit native bulk HD processing skips images and marks its own task',hdStart.queued===1&&hdStart.skipped===1&&hdProbeCalls===1&&hdCompleted.jobs.some(j=>j.id==='100003'&&j.coverOnly&&j.state==='complete'));
  const defectReport=await call('inspectDefects');check('native defect inspection returns typed per-work issues without starting a read',Array.isArray(defectReport.items)&&defectReport.items.every(i=>typeof i.id==='string'&&Array.isArray(i.issues))&&!(await call('state')).collector.busy);
  const defectUIWait=Date.now()+3000;while(await win.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='补齐失败').disabled")&&Date.now()<defectUIWait)await new Promise(r=>setTimeout(r,50));
  await win.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='补齐失败').click()");await new Promise(r=>setTimeout(r,250));
  check('native defect panel exposes selected-only repair with themed controls',await win.webContents.executeJavaScript("!!document.querySelector('[aria-label=\"检查并补齐失败作品\"] .defect-list')&&document.querySelector('[aria-label=\"检查并补齐失败作品\"]').textContent.includes('补齐选中')"));
  try{fs.writeFileSync('.test-output/defect-repair-desktop.png',(await win.webContents.capturePage()).toPNG());}catch(e){fs.writeFileSync('.test-output/defect-capture-note.txt',String(e));}
  await win.webContents.executeJavaScript("document.querySelector('.modal-head [aria-label=\"关闭弹窗\"]').click()");
  const nasPlan=await call('prepareNASRemoval',['123'],'delete');check('native NAS deletion preparation is non-destructive',nasPlan.count===1&&(await call('state')).works.find(w=>w.id==='123').backedUp);await assert.rejects(call('confirmDelete',nasPlan.token),/类型无效/);check('NAS confirmation cannot be used to delete local files',(await call('state')).works.find(w=>w.id==='123').local);await call('confirmNASRemoval',nasPlan.token);
  for(let i=0;i<100;i++){data=await call('state');if(!data.nasRemoval.running)break;await new Promise(r=>setTimeout(r,50));}
  check('native NAS deletion retains local files and removes backed-up state',data.nasRemoval.phase==='complete'&&data.works.find(w=>w.id==='123').local&&data.works.find(w=>w.id==='123').downloaded&&!data.works.find(w=>w.id==='123').backedUp);
  await call('syncBackup');check('native automatic backup uploads retained local media after NAS deletion',(await call('state')).works.find(w=>w.id==='123').backedUp);

  const creatorFetch=http.fetch,shared=JSON.parse(fs.readFileSync('tests/fixtures/coauthor-work.json','utf8'));let creatorProfiles=0;
  http.fetch=async url=>{const route=new URL(url);if(route.pathname.includes('/aweme/detail/')){const body=structuredClone(shared);if(route.searchParams.get('update_version_code')!=='170400'||route.searchParams.get('pc_client_type')!=='1'||route.searchParams.get('version_code')!=='190500'||route.searchParams.get('version_name')!=='19.5.0')delete body.cooperation_info;return new Response(JSON.stringify({status_code:0,aweme_detail:body}));}if(route.pathname.includes('/user/profile/other/')){creatorProfiles++;return new Response(JSON.stringify({status_code:0,user:{...shared.cooperation_info.co_creators[0],unique_id:'37386365831'}}));}return creatorFetch.call(http,url);};
  try{await call('importLink','https://www.douyin.com/video/'+shared.aweme_id);await call('refreshWorkCreators',shared.aweme_id);data=await call('state');const work=data.works.find(w=>w.id===shared.aweme_id);check('native detail repair retrieves the co-creator profile and preserves separate publisher identity',work.author.uniqueId==='ffff1111fff'&&work.coAuthors[0].uniqueId==='37386365831'&&work.coAuthors[0].roleTitle==='出镜'&&creatorProfiles===1);await call('refreshWorkCreators',shared.aweme_id);check('native creator cache avoids repeated online requests',creatorProfiles===1);}finally{http.fetch=creatorFetch;}
  fs.mkdirSync('.test-output',{recursive:true});let captured=false;try{fs.writeFileSync('.test-output/backup-desktop.png',(await win.webContents.capturePage()).toPNG());captured=true;}catch(e){fs.writeFileSync('.test-output/backup-capture-note.txt',String(e));}await call('setTags','123',['pending-on-exit']);win.close();await new Promise(r=>setTimeout(r,250));check('closing with unsynced changes prompts instead of silently discarding',await win.webContents.executeJavaScript(`!!document.querySelector('[aria-label="还有内容未同步"]')`));fs.writeFileSync('.test-output/backup-desktop-result.json',JSON.stringify({ok:true,checks,captured},null,2));console.log({ok:true,checks,captured});clearTimeout(timeout);await call('finishBackupExit','keep');
 }catch(e){console.error(e);fs.mkdirSync('.test-output',{recursive:true});fs.writeFileSync('.test-output/backup-desktop-result.json',JSON.stringify({ok:false,error:e.stack,checks},null,2));clearTimeout(timeout);app.exit(1);}
})();});});
const mainURL=process.env.CANGXIA_BACKUP_TEST_MAIN?pathToFileURL(path.resolve(process.env.CANGXIA_BACKUP_TEST_MAIN)):new URL('../electron/main.mjs',import.meta.url);
const {SystemBrowser:FixtureBrowser}=await import(new URL('system-browser.mjs',mainURL));Object.defineProperty(FixtureBrowser.prototype,'api',{configurable:true,get(){return null;},set(){}});
// Existing IPC fixtures use literal "fixture-media", not encoded videos. Real decoding
// and matching are covered separately by cover-frame-test.py and the packaged helper smoke test.
const {HDCover:FixtureCover}=await import(new URL('hd-cover.mjs',mainURL));FixtureCover.prototype.runHelper=async request=>{hdProbeCalls++;assert.equal(request.mode,'probe');return {width:1,height:1};};
await import(mainURL.href);
