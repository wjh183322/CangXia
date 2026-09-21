import {app,BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {SystemBrowser} from '../electron/system-browser.mjs';
import {pageFetchScript} from '../diagnostics/request-probe/core.mjs';

app.disableHardwareAcceleration();
const profile=process.env.CANGXIA_PROBE_TEST_PROFILE;if(!profile)throw Error('isolated runner required');
const checks=[];let started=false,browser;
const watchdog=setTimeout(()=>{console.error('probe desktop timeout');app.exit(1);},60000);
app.on('browser-window-created',(_e,win)=>{
 if(started)return;started=true;
 win.webContents.once('did-finish-load',()=>void(async()=>{
  const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
  try{
   await new Promise(r=>setTimeout(r,400));
   const state=await win.webContents.executeJavaScript('window.probe.state()');
   check('diagnostic uses isolated profile and version',app.getPath('userData')===profile&&state.version==='0.1.0');
   check('initial UI is loaded and requires explicit browser confirmation',await win.webContents.executeJavaScript(`document.querySelector('#status').textContent.includes('先打开')&&document.querySelector('#run').disabled`));
   check('diagnostic renderer is sandboxed without Node',win.webContents.getLastWebPreferences().sandbox&&await win.webContents.executeJavaScript(`typeof require==='undefined'`));
   await assert.rejects(win.webContents.executeJavaScript('window.probe.run(false)'));checks.push('unconfirmed test cannot start');
   win.webContents.send('probe-state',{...state,phase:'done',message:'合成测试：直接请求 403，浏览器页面请求成功。',results:[{route:'direct',httpStatus:403,items:null,outcome:'denied',signatureKeys:[]},{route:'page',httpStatus:200,items:10,outcome:'success',signatureKeys:['a_bogus']}],report:{test:true}});
   await new Promise(r=>setTimeout(r,500));
   check('report UI displays two routes, counts and signature field names',await win.webContents.executeJavaScript(`document.querySelectorAll('#results tr').length===2&&document.querySelector('#results').textContent.includes('403')&&document.querySelector('#results').textContent.includes('a_bogus')&&!document.querySelector('#save').disabled`));
   win.webContents.invalidate();await new Promise(r=>setTimeout(r,300));fs.writeFileSync('.test-output/request-probe-desktop.png',(await win.webContents.capturePage()).toPNG());

   // Real headless system-browser engine; every target request is fulfilled locally.
   // No actual Douyin requests or account data are used.
   browser=new SystemBrowser(path.join(profile,'synthetic-browser'),{headless:true});
   const c=await browser.launch('about:blank');
   const {targetInfos}=await c.send('Target.getTargets');const target=targetInfos.find(t=>t.type==='page');assert.ok(target);
   const sid=await browser.attach(target.targetId);let requests=0;
   const html='<!doctype html><html><body><h1>合成测试页面</h1><script>window.fetch=async function(url,options){window.lastProbe={url,method:options.method,body:options.body,hasSignal:!!options.signal};return new Response(JSON.stringify({status_code:0,aweme_list:[]}));};</script></body></html>';
   const intercept=(method,p,s)=>{if(s===sid&&method==='Fetch.requestPaused'){requests++;void c.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(html).toString('base64')},sid).catch(()=>{});}};
   browser.on('event',intercept);await c.send('Fetch.enable',{patterns:[{urlPattern:'*'}]},sid);await c.send('Page.enable',{},sid);
   await c.send('Page.navigate',{url:'https://www.douyin.com/user/self'},sid);
   let ready=false;const end=Date.now()+5000;while(!ready&&Date.now()<end){await new Promise(r=>setTimeout(r,100));const r=await c.send('Runtime.evaluate',{expression:`location.origin==='https://www.douyin.com'&&document.readyState==='complete'`,returnByValue:true},sid);ready=!!r.result?.value;}
   assert.ok(ready);const result=await c.send('Runtime.evaluate',{expression:pageFetchScript('synthetic_probe'),returnByValue:true,awaitPromise:true},sid);
   check('page probe executes in real system browser with bounded POST and no real network',result.result?.value?.status===200&&requests>=1);
   const details=await c.send('Runtime.evaluate',{expression:'window.lastProbe',returnByValue:true},sid);
   check('system browser receives same first page and abort signal',details.result?.value?.method==='POST'&&details.result?.value?.body==='cursor=0&count=10'&&details.result?.value?.hasSignal);
   await browser.close();browser=null;
   fs.writeFileSync('.test-output/request-probe-desktop-result.json',JSON.stringify({ok:true,checks},null,2));console.log({ok:true,checks});clearTimeout(watchdog);win.close();
  }catch(error){console.error(error);await browser?.close();fs.writeFileSync('.test-output/request-probe-desktop-result.json',JSON.stringify({ok:false,error:error.stack,checks},null,2));clearTimeout(watchdog);app.exit(1);}
 })());
});
await import(process.env.CANGXIA_PROBE_TEST_MAIN?pathToFileURL(path.resolve(process.env.CANGXIA_PROBE_TEST_MAIN)).href:'../diagnostics/request-probe/main.mjs');
