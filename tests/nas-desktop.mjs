import {app, session} from 'electron';
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
app.disableHardwareAcceleration();
const base=process.env.CANGXIA_NAS_TEST_PROFILE;
if(!base)throw new Error('Use scripts/nas-desktop-test.mjs to create the isolated fixture');
app.setPath('appData',path.join(base,'roaming'));
app.setPath('downloads',path.join(base,'downloads'));
const checks=[];let started=false;
const deadline=setTimeout(()=>{console.error('NAS desktop timeout');app.exit(1);},90000);
app.on('browser-window-created',(_event,win)=>{
 if(started)return;started=true;
 win.webContents.once('did-finish-load',()=>{void (async()=>{
  const call=(method,...args)=>win.webContents.executeJavaScript(`window.cangxia[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
  try{
   const root=path.join(base,'share');fs.mkdirSync(root);
   let data=await call('state');check('real app starts with original local data',data.works.length===1&&data.storage.mode==='local');
   const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
   const pageTitle=await win.webContents.executeJavaScript('document.title');check('window title, document title and settings use the NAS edition and package version',data.version===version&&pageTitle.includes(`藏匣NAS版 v${version} ·`)&&win.getTitle()===pageTitle);
   const profile=path.join(base,'roaming','藏匣NAS版');
   check('NAS profile and Chromium session data are isolated',app.getPath('userData')===profile&&app.getPath('sessionData')===profile&&session.fromPartition('persist:cangxia-popup-login').storagePath.startsWith(profile+path.sep));
   check('default media directory belongs to NAS edition',data.root===path.join(base,'downloads','藏匣NAS版'));
   for(const name of ['藏匣','藏匣备份版'])check(`${name} data and login state are untouched`,fs.readFileSync(path.join(base,'roaming',name,'library.sqlite'),'utf8')==='unrelated-database'&&fs.readFileSync(path.join(base,'roaming',name,'login-state.bin'),'utf8')==='unrelated-login');
   const plan=await call('planNas',root);check('migration review has files and leaves local state unchanged',plan.files===1&&(await call('state')).storage.mode==='local');
   await call('migrateNas',plan.token);data=await call('state');check('real IPC migration activates writer',data.storage.writable&&data.works[0].local);
   await call('setTags','123',['desktop-test']);check('tag commit acknowledged',!(await call('state')).storage.pending);
   const intent=await call('prepareDelete',['123'],'local');check('NAS deletion confirmation identifies archive',intent.nas===true);
   await call('confirmDelete',intent.token);check('delete removes saved record',(await call('state')).works[0].local===false);
   const deleted=await call('nasTrash');await call('restoreNasDeleted',deleted[0].batch,'123');check('restore returns saved media',(await call('state')).works[0].local===true);
   await call('leaveNas');data=await call('state');check('local original and original tags retained',data.storage.mode==='local'&&data.works[0].local&&!data.works[0].localTags.length);
   await call('openNas',root);data=await call('state');check('reopen NAS loads shared tags',data.storage.writable&&data.works[0].localTags.includes('desktop-test'));
   const saved=data.works[0].localRecord;for(const asset of saved.assets)fs.unlinkSync(path.join(saved.path,asset.file));
   data=await call('refreshFiles');check('external deletion clears stale record without removing work or tags',data.works.length===1&&data.works[0].localRecord===null&&data.works[0].localTags.includes('desktop-test'));
   await win.webContents.executeJavaScript(`document.querySelector('[aria-label="设置"]').click()`);await new Promise(r=>setTimeout(r,600));
   const ui=await win.webContents.executeJavaScript(`({text:document.querySelector('.modal').innerText,scroll:document.querySelector('.modal-content').scrollHeight})`);check('NAS controls visible in settings',ui.text.includes('当前电脑可写')&&ui.text.includes('恢复已删除作品')&&ui.text.includes('后续事项'));
   fs.mkdirSync('.test-output',{recursive:true});fs.writeFileSync('.test-output/nas-desktop.png',(await win.webContents.capturePage()).toPNG());fs.writeFileSync('.test-output/nas-desktop-result.json',JSON.stringify({ok:true,checks},null,2));console.log({ok:true,checks});clearTimeout(deadline);app.quit();
  }catch(e){console.error(e);fs.mkdirSync('.test-output',{recursive:true});fs.writeFileSync('.test-output/nas-desktop-result.json',JSON.stringify({ok:false,error:e.stack,checks},null,2));clearTimeout(deadline);app.quit();process.exitCode=1;}
 })();});
});
await import(process.env.CANGXIA_TEST_MAIN?pathToFileURL(path.resolve(process.env.CANGXIA_TEST_MAIN)).href:'../electron/main.mjs');
