import {app,dialog} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const profile=process.env.CANGXIA_LOCAL_TEST_PROFILE;
if(!profile)throw Error('isolated runner required');
app.disableHardwareAcceleration();
const start=performance.now(),main=pathToFileURL(path.resolve(process.env.CANGXIA_STARTUP_MAIN||'electron/main.mjs'));
const {Collector}=await import(new URL('account-collector.mjs',main));
const result={label:process.env.CANGXIA_STARTUP_LABEL||'current'};
let authFinished=false,releaseAuth;const authGate=new Promise(resolve=>{releaseAuth=resolve;});
Collector.prototype.restore=async function(){if(result.label==='before')await new Promise(r=>setTimeout(r,2500));else await authGate;authFinished=true;this.update('ready','模拟登录恢复完成');};
const timeout=setTimeout(()=>{console.error('startup timeout');app.exit(1);},30000);
app.on('browser-window-created',(_event,win)=>{
 result.windowMs=Math.round(performance.now()-start);win.hide();win.webContents.setBackgroundThrottling(false);
 if(process.env.CANGXIA_STARTUP_CLOSE==='1'){
  dialog.showErrorBox=(...args)=>{console.error(...args);app.exit(1);};setTimeout(()=>{result.closedDuringStartup=true;fs.writeFileSync(path.join(profile,'startup-result.json'),JSON.stringify(result));clearTimeout(timeout);win.close();},0);return;
 }
 win.webContents.on('did-finish-load',()=>{if(!win.webContents.getURL().endsWith('/index.html'))return;
 void(async()=>{try{
  const state=await win.webContents.executeJavaScript('window.cangxia.state()');assert.equal(state.works.length,20000);
  for(let i=0;i<150;i++){if(await win.webContents.executeJavaScript("document.querySelectorAll('.work-card').length===20"))break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('.work-card').length"),20);
  result.libraryVisibleMs=Math.round(performance.now()-start);result.authFinishedAtLibrary=authFinished;
  if(result.label!=='before')assert.equal(authFinished,false,'local library must not wait for session restore');
  releaseAuth();
  while(!authFinished)await new Promise(r=>setTimeout(r,50));
  const final=await win.webContents.executeJavaScript('window.cangxia.state()');assert.equal(final.collector.connected,false);assert.equal(final.works.length,20000);
  if(result.label!=='before'){
   let shown=0;win.show=()=>{shown++;};const event=new Promise(resolve=>app.once('second-instance',resolve));
   const child=spawn(process.execPath,[fileURLToPath(main)],{windowsHide:true,stdio:'ignore',env:process.env});
   const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,0);await event;assert.equal(shown,1);result.secondInstanceReusesWindow=true;
  }
  fs.writeFileSync(path.join(profile,'startup-result.json'),JSON.stringify(result,null,2));console.log(result);clearTimeout(timeout);app.quit();
 }catch(e){console.error(e);clearTimeout(timeout);app.exit(1);}})();
 });
});
await import(main.href);
