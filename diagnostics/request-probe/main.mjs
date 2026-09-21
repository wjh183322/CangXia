import {app,BrowserWindow,ipcMain,session,dialog} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {SystemBrowser} from '../../electron/system-browser.mjs';
import {PROBE_VERSION,ENDPOINT,REQUEST_URL,FORM,signatureNames,summarize,conclusion,limitedText,pageFetchScript,compareOnce} from './core.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
app.setName('藏匣读取诊断');
app.setPath('userData',process.env.CANGXIA_PROBE_TEST_PROFILE||path.join(app.getPath('appData'),'藏匣读取诊断'));
if(!app.requestSingleInstanceLock()){app.quit();}else{
void app.whenReady().then(async()=>{
const uiURL=pathToFileURL(path.join(root,'index.html')).href;
let win,browser,busy=false,opening=false,controller,activePage=null,lastRun=0,closing=false;
const state={version:PROBE_VERSION,phase:'idle',message:'先打开专用浏览器，在抖音网页里登录并确认收藏可以加载。',results:[],report:null,browserReady:false};
const push=()=>{if(win&&!win.isDestroyed())win.webContents.send('probe-state',state);};
const set=(data)=>{Object.assign(state,data);push();};
const safeHandle=(name,fn)=>ipcMain.handle(name,async(e,...args)=>{
 if(e.sender!==win.webContents||e.senderFrame!==win.webContents.mainFrame||e.senderFrame.url!==uiURL)throw Error('不允许的操作来源');
 try{return await fn(...args);}catch{throw Error('操作未完成，请确认专用浏览器已登录，且停留在抖音收藏页面后重试。');}
});
browser=new SystemBrowser(path.join(app.getPath('userData'),'system-browser'));
browser.on('closed',()=>{controller?.abort();set({browserReady:false,message:'专用浏览器已关闭。再次测试前请重新打开并确认登录。'});});
const http=session.fromPartition('cangxia-request-probe-http');
http.setPermissionRequestHandler((_w,_p,callback)=>callback(false));
async function abort(){controller?.abort();const p=activePage;if(p&&browser.connection)await browser.connection.send('Runtime.evaluate',{expression:`window[${JSON.stringify(p.key)}]?.abort('cancelled')`},p.sid).catch(()=>{});}
safeHandle('probe-state',()=>state);
safeHandle('probe-open',async preferred=>{
 if(busy||opening)throw Error('busy');opening=true;
 try{browser.preferred=preferred==='edge'?'edge':'chrome';await browser.openLogin();set({browserReady:true,message:'在专用浏览器登录，进入“我的 → 收藏”并确认能加载，再返回这里开始对比。'});return state;}finally{opening=false;}
});
safeHandle('probe-stop',async()=>{await abort();return true;});
safeHandle('probe-run',async confirmed=>{
 if(confirmed!==true||busy||opening||!browser.connection)throw Error('not ready');
 if(Date.now()-lastRun<60000)throw Error('cooldown');
 busy=true;lastRun=Date.now();controller=new AbortController();const signal=controller.signal;
 let sid,listener;
 const results=[];const observed={direct:new Set(),page:new Set()};let route=null;
 set({phase:'running',message:'正在比较同一页收藏，每种方式最多请求一次。',results:[],report:null});
 try{
  const target=await browser.target();sid=await browser.attach(target.targetId);
  const page=await browser.connection.send('Runtime.evaluate',{expression:'({origin:location.origin,ready:document.readyState})',returnByValue:true},sid);
  if(page.result?.value?.origin!=='https://www.douyin.com'||page.result?.value?.ready==='loading')throw Error('not ready');
  const {cookies}=await browser.connection.send('Network.getCookies',{urls:['https://www.douyin.com/']},sid);
  if(!cookies.some(c=>['sessionid','sessionid_ss'].includes(c.name)&&c.value&&(!c.expires||c.expires<0||c.expires>Date.now()/1000)))throw Error('no login');
  await http.clearStorageData({storages:['cookies']});http.setUserAgent(browser.userAgent);
  for(const c of cookies){
   if(!['douyin.com','www.douyin.com'].includes(String(c.domain).replace(/^\./,'')))continue;
   const cookie={url:'https://www.douyin.com'+(c.path||'/'),name:c.name,value:c.value,domain:c.domain,path:c.path||'/',secure:c.secure!==false,httpOnly:!!c.httpOnly};
   if(c.expires>0)cookie.expirationDate=c.expires;
   if(['Strict','Lax','None'].includes(c.sameSite))cookie.sameSite={Strict:'strict',Lax:'lax',None:'no_restriction'}[c.sameSite];
   await http.cookies.set(cookie);
  }
  listener=(method,p,sessionId)=>{if(method==='Network.requestWillBeSent'&&sessionId===sid&&route==='page'&&p.request.method==='POST'&&p.request.postData===FORM)for(const name of signatureNames(p.request.url))observed.page.add(name);};
  browser.on('event',listener);await browser.connection.send('Network.enable',{},sid);
  const run=async mode=>{
   route=mode;const start=Date.now();let response;
   set({message:mode==='direct'?'正在检查当前软件使用的直接请求方式…':'正在检查浏览器页面请求方式…'});
   try{
    signal.throwIfAborted();
    if(mode==='direct'){
     const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(12000)]);
     const r=await http.fetch(REQUEST_URL,{method:'POST',redirect:'manual',headers:{Referer:'https://www.douyin.com/','User-Agent':browser.userAgent,Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:FORM,signal:requestSignal});
     response={status:r.status,text:await limitedText(r,requestSignal)};
    }else{
     const key='__cangxia_probe_'+randomUUID().replaceAll('-','');activePage={key,sid};
     const r=await browser.connection.send('Runtime.evaluate',{expression:pageFetchScript(key),awaitPromise:true,returnByValue:true},sid);
     response=r.exceptionDetails?{error:'network'}:r.result?.value||{error:'network'};
    }
   }catch(e){response={error:signal.aborted?'cancelled':e.code==='too-large'?'too-large':e.name==='TimeoutError'?'timeout':'network'};}
   finally{activePage=null;route=null;}
   return summarize({...response,durationMs:Date.now()-start,signatureKeys:[...observed[mode]]});
  };
  await compareOnce({direct:()=>run('direct'),page:()=>run('page'),signal,delay:s=>delay(2000,null,{signal:s}),onResult:r=>{results.push(r);set({results:[...results]});}});
  const message=signal.aborted?'已停止测试，已完成的结果保留。':conclusion(results);
  set({phase:'done',message,report:{tool:'CangXia request probe',version:PROBE_VERSION,time:new Date().toISOString(),platform:process.platform,electron:process.versions.electron,browser:browser.name,browserVersion:(browser.userAgent||'').match(/(?:Edg|Chrome)\/([\d.]+)/)?.[1]||'unknown',officialFavoritesConfirmed:true,endpoint:ENDPOINT,pageSize:10,results,conclusion:message,notes:['同一专用浏览器会话的 Cookie 复制到临时 Electron 会话进行直接请求。','页面请求在已打开的抖音网页内执行 fetch；不生成签名。','签名字段仅记录名称，存在不代表有效；测试不能单独证明 403 原因。','没有读取全部收藏，没有导入资料库或下载媒体。']}});
 }catch{set({phase:'error',message:signal.aborted?'已停止。':'尚不能开始对比。请在专用浏览器完成登录和验证，停留在抖音收藏页面后重试。'});}
 finally{busy=false;activePage=null;if(listener)browser.removeListener('event',listener);if(sid&&browser.connection)await browser.connection.send('Network.disable',{},sid).catch(()=>{});await http.clearStorageData({storages:['cookies']}).catch(()=>{});push();}
 return state;
});
safeHandle('probe-save',async()=>{
 if(busy||!state.report)throw Error('no report');
 const result=await dialog.showSaveDialog(win,{title:'保存诊断报告',defaultPath:'藏匣读取诊断-'+new Date().toISOString().slice(0,10)+'.json',filters:[{name:'诊断报告',extensions:['json']}]});
 if(!result.canceled&&result.filePath){fs.writeFileSync(result.filePath,JSON.stringify(state.report,null,2),'utf8');return true;}return false;
});
win=new BrowserWindow({width:900,height:780,minWidth:700,minHeight:650,title:'藏匣读取诊断 v'+PROBE_VERSION,autoHideMenuBar:true,webPreferences:{preload:path.join(root,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(e,url)=>{if(url!==uiURL)e.preventDefault();});
win.on('close',e=>{if(closing)return;e.preventDefault();closing=true;void(async()=>{await abort();await browser.close();win.destroy();app.quit();})();});
app.on('second-instance',()=>{win.show();win.focus();});
await win.loadURL(uiURL);
});
}
