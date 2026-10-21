import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { isDouyinURL, sleep } from './model.mjs';
import {BrowserAPI,abortable} from './browser-api.mjs';

export function findSystemBrowser(preferred = 'chrome', env = process.env) {
  const roots=[env.PROGRAMFILES,env['PROGRAMFILES(X86)'],env.LOCALAPPDATA].filter(Boolean);
  const names=preferred==='edge'?['edge','chrome']:['chrome','edge'];
  for(const name of names)for(const root of roots){
    const file=path.join(root,...(name==='chrome'?['Google','Chrome','Application','chrome.exe']:['Microsoft','Edge','Application','msedge.exe']));
    if(fs.existsSync(file))return {name,executable:file};
  }
  throw new Error('未找到系统 Chrome 或 Edge，后台读取需要其中一种浏览器，请安装或启用后重试');
}
export function validateDebugURL(value, port) {
  const u=new URL(value);
  if(u.protocol!=='ws:'||u.hostname!=='127.0.0.1'||Number(u.port)!==port||!/^\/devtools\/browser\/[\w-]+$/.test(u.pathname))throw new Error('浏览器本机连接地址不符合预期');
  return u.href;
}
export class CDPConnection extends EventEmitter {
  constructor(ws){super();this.ws=ws;this.pending=new Map();this.sequence=0;
    ws.on('message',bytes=>{let m;try{m=JSON.parse(bytes.toString());}catch{return;}
      if(m.id){const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error('浏览器操作未完成：'+String(m.error.message).slice(0,140))):p.resolve(m.result||{});}
      else if(m.method)this.emit('event',m.method,m.params||{},m.sessionId);
    });
    ws.on('close',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('专用浏览器已关闭'));}this.pending.clear();this.emit('closed');});
    ws.on('error',()=>{});
  }
  static async connect(url){
    const ws=new WebSocket(url,{handshakeTimeout:5000,maxPayload:32*1024*1024});
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',()=>reject(new Error('无法连接藏匣专用浏览器')));});
    return new CDPConnection(ws);
  }
  send(method,params={},sessionId){
    if(this.ws.readyState!==WebSocket.OPEN)return Promise.reject(new Error('专用浏览器未连接'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('浏览器操作超时'));},20000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  }
  close(){this.ws.close();}
}

// Only starts an app-owned profile. Never connects to the user's regular profile or scans ports.
export class SystemBrowser extends EventEmitter {
  constructor(profileRoot,{headless=false,background=false,preferred='chrome'}={}){super();this.profileRoot=profileRoot;this.headless=headless;this.background=background;this.preferred=preferred;this.connection=null;this.launching=null;this.pageSessions=new Map();this.api=new BrowserAPI(this);this.readerTarget=null;this.loginTarget=null;}
  async launch(url='https://www.douyin.com/'){
    if(url!=='about:blank'&&!isDouyinURL(url))throw new Error('只允许打开抖音页面');
    if(this.closing)await this.closing;
    if(this.connection&&this.connection.ws.readyState!==WebSocket.OPEN){this.connection=null;this.readerTarget=null;this.loginTarget=null;this.pageSessions.clear();this.api?.reset();}
    if(this.connection)return this.connection;
    if(this.launching)return this.launching;
    this.launching=(async()=>{const previous=this.process;if(previous&&previous.exitCode===null&&previous.signalCode===null)await Promise.race([new Promise(resolve=>previous.once('exit',resolve)),sleep(2000)]);return this.start(url);})().finally(()=>{this.launching=null;});return this.launching;
  }
  async start(url){
    const browser=findSystemBrowser(this.preferred);this.name=browser.name;
    const directory=path.join(this.profileRoot,browser.name);fs.mkdirSync(directory,{recursive:true});
    if(fs.lstatSync(directory).isSymbolicLink())throw new Error('专用浏览器目录不能为符号链接');
    const reservation=net.createServer();await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
    this.port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
    const args=[`--remote-debugging-port=${this.port}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${directory}`,'--no-first-run','--no-default-browser-check',...(this.background?['--no-startup-window']:[...(this.headless?['--headless=new']:['--new-window']),url])];
    this.process=spawn(browser.executable,args,{stdio:'ignore',windowsHide:true});
    let launchError=false;this.process.once('error',()=>{launchError=true;});
    for(let i=0;i<40;i++){
      if(launchError)break;
      try{
        const response=await fetch(`http://127.0.0.1:${this.port}/json/version`,{signal:AbortSignal.timeout(700)});
        if(response.ok){const info=await response.json();const connection=await CDPConnection.connect(validateDebugURL(info.webSocketDebuggerUrl,this.port));
          this.connection=connection;this.userAgent=(await connection.send('Browser.getVersion')).userAgent;
          connection.on('event',(...event)=>this.emit('event',...event));
          connection.on('closed',()=>{if(this.connection===connection){this.connection=null;this.readerTarget=null;this.loginTarget=null;this.pageSessions.clear();this.api?.reset();this.emit('closed');}});
          if(this.background){try{await this.readerPage(url);}catch{await this.closeNow();throw Object.assign(new Error('当前浏览器未能创建后台读取页面，请更新 Chrome 或 Edge 后重试'),{code:'BACKGROUND_UNAVAILABLE'});}}
          return connection;
        }
      }catch(e){if(e.code==='BACKGROUND_UNAVAILABLE')throw e;}
      await sleep(400);
    }
    throw new Error('专用浏览器连接未就绪。请关闭此前由藏匣打开的专用窗口后重试，或导入参考工具配置。');
  }
  async target(){
    if(!this.connection)throw new Error('请先打开系统浏览器登录');
    const {targetInfos}=await this.connection.send('Target.getTargets');
    const target=targetInfos.find(t=>t.targetId===this.loginTarget&&isDouyinURL(t.url))||targetInfos.find(t=>t.targetId===this.readerTarget&&isDouyinURL(t.url))||targetInfos.find(t=>t.type==='page'&&isDouyinURL(t.url));
    if(!target)throw new Error('专用浏览器中没有抖音页面，请先打开抖音');return target;
  }
  async attach(targetId){
    if(this.pageSessions.has(targetId))return this.pageSessions.get(targetId);
    const {sessionId}=await this.connection.send('Target.attachToTarget',{targetId,flatten:true});this.pageSessions.set(targetId,sessionId);return sessionId;
  }
  async openLogin(){
    this.api?.reset();
    await this.launch('about:blank');
    if(this.background){
      const {targetInfos}=await this.connection.send('Target.getTargets');let target=targetInfos.find(t=>t.targetId===this.loginTarget&&isDouyinURL(t.url));
      if(!target){const r=await this.connection.send('Target.createTarget',{url:'https://www.douyin.com/user/self',newWindow:true});this.loginTarget=r.targetId;target=r;}
      await this.connection.send('Target.activateTarget',{targetId:target.targetId});return this.name;
    }
    let target;try{target=await this.target();}catch{const r=await this.connection.send('Target.createTarget',{url:'https://www.douyin.com/'});target={targetId:r.targetId};}
    await this.connection.send('Target.activateTarget',{targetId:target.targetId});
    return this.name;
  }
  async credentials(){
    const target=await this.target();const sessionId=await this.attach(target.targetId);
    const {cookies}=await this.connection.send('Network.getCookies',{urls:['https://www.douyin.com/']},sessionId);
    const filtered=cookies.filter(c=>c.domain.replace(/^\./,'')==='douyin.com'||c.domain.replace(/^\./,'')==='www.douyin.com');
    if(!filtered.some(c=>['sessionid','sessionid_ss'].includes(c.name)&&c.value))throw new Error('还未检测到登录成功。请在专用 Chrome/Edge 窗口完成登录后，再点击“我已登录，连接”。');
    return {cookies:filtered,userAgent:this.userAgent,source:this.name};
  }
  async readerPage(url='https://www.douyin.com/user/self'){
    if(url!=='about:blank'&&!isDouyinURL(url))throw new Error('只允许读取抖音页面');
    if(!this.connection)await this.launch('about:blank');
    if(!this.readerTarget){
      let r,bootstrap=null;
      const create=()=>this.connection.send('Target.createTarget',{url:'about:blank',hidden:true,background:true});
      try{
        for(let attempt=0;attempt<3;attempt++)try{r=await create();break;}catch(error){if(!error.message.includes('Hidden target can be created only when remote debugging is enabled'))throw error;if(attempt<2)await sleep(100*(attempt+1));}
        // Some Chromium builds require an initial frame before a hidden target.
        // Bootstrap with a minimized blank window and immediately remove it.
        if(!r){bootstrap=await this.connection.send('Target.createTarget',{url:'about:blank',newWindow:true,windowState:'minimized',background:true});r=await create();}
      }finally{if(bootstrap)await this.connection?.send('Target.closeTarget',{targetId:bootstrap.targetId}).catch(()=>{});}
      this.readerTarget=r.targetId;
      const sid=await this.attach(r.targetId);await this.connection.send('Emulation.setDeviceMetricsOverride',{width:1000,height:760,deviceScaleFactor:1,mobile:false},sid);
      if(url!=='about:blank')await this.connection.send('Page.navigate',{url},sid);
    }
    return this.readerTarget;
  }
  async prepareSession(auth,{signal,replace=true}={}){
    signal?.throwIfAborted();await abortable(this.launch('about:blank'),signal);signal?.throwIfAborted();
    const targetId=this.background?await this.readerPage('about:blank'):(await this.target()).targetId;
    const sid=await this.attach(targetId),connection=this.connection;
    if(replace){
      const {cookies}=await abortable(connection.send('Network.getCookies',{urls:['https://www.douyin.com/']},sid),signal);
      for(const c of cookies){signal?.throwIfAborted();if(['douyin.com','www.douyin.com'].includes(String(c.domain).replace(/^\./,'')))await abortable(connection.send('Network.deleteCookies',{name:c.name,domain:c.domain,path:c.path||'/'},sid),signal);}
      for(const c of auth.cookies){
        signal?.throwIfAborted();if(!['douyin.com','www.douyin.com'].includes(String(c.domain).replace(/^\./,'')))continue;
        const expires=Number(c.expires??c.expirationDate),sameSite={strict:'Strict',lax:'Lax',no_restriction:'None',Strict:'Strict',Lax:'Lax',None:'None'}[c.sameSite];
        const cookie={url:'https://www.douyin.com'+(c.path||'/'),name:c.name,value:c.value,domain:c.domain,path:c.path||'/',secure:c.secure!==false,httpOnly:!!c.httpOnly,...(expires>0?{expires}:{}),...(sameSite?{sameSite}:{})};
        const result=await abortable(connection.send('Network.setCookie',cookie,sid),signal);if(result.success===false)throw new Error('未能传递当前登录会话，请重新扫码或完成验证');
      }
    }
    signal?.throwIfAborted();this.api?.reset();await abortable(connection.send('Page.navigate',{url:'https://www.douyin.com/user/self'},sid),signal);
  }
  async hideLogin(){
    if(!this.background||!this.connection||!this.loginTarget)return;
    const targetId=this.loginTarget;this.loginTarget=null;this.pageSessions.delete(targetId);await this.connection.send('Target.closeTarget',{targetId}).catch(()=>{});
  }
  async releaseIdle(canClose=()=>true){
    if(!this.background||!this.connection||!canClose())return false;
    const {targetInfos}=await this.connection.send('Target.getTargets');
    if(!canClose()||targetInfos.some(t=>t.type==='page'))return false;
    await this.close();return true;
  }
  async clearLoginData(){
    await this.close();const root=path.resolve(this.profileRoot);if(!fs.existsSync(root))return;
    if(fs.lstatSync(root).isSymbolicLink())throw new Error('专用浏览器目录为链接，未自动清理');
    const realRoot=fs.realpathSync(root),targets=[];
    for(const name of ['chrome','edge']){const target=path.resolve(root,name);if(path.relative(root,target)!==name)throw new Error('登录目录范围无效');if(!fs.existsSync(target))continue;if(fs.lstatSync(target).isSymbolicLink()||path.relative(realRoot,fs.realpathSync(target))!==name)throw new Error('专用浏览器登录目录超出范围，未清理');targets.push(target);}
    for(const target of targets)await fs.promises.rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
  async open(url){
    if(!isDouyinURL(url))throw new Error('作品链接不是抖音地址');await this.launch(url);
    const {targetId}=await this.connection.send('Target.createTarget',{url});await this.connection.send('Target.activateTarget',{targetId});return targetId;
  }
  async observeWork(id,onResponse){
    if(!/^\d+$/.test(id))throw new Error('作品标识无效');await this.launch('about:blank');
    const {targetId}=await this.connection.send('Target.createTarget',{url:'about:blank'});const sid=await this.attach(targetId);const requests=new Map();
    const listener=(method,p,sessionId)=>{
      if(sessionId!==sid)return;
      if(method==='Network.responseReceived'&&isDouyinURL(p.response.url)&&p.response.url.includes('/aweme/detail/'))requests.set(p.requestId,p.response);
      if(method==='Network.loadingFinished'&&requests.has(p.requestId)){
        const response=requests.get(p.requestId);requests.delete(p.requestId);
        void this.connection?.send('Network.getResponseBody',{requestId:p.requestId},sid).then(body=>onResponse(response.url,response.status,body.base64Encoded?Buffer.from(body.body,'base64').toString('utf8'):body.body)).catch(()=>{});
      }
    };
    this.on('event',listener);await this.connection.send('Network.enable',{},sid);
    await this.connection.send('Page.navigate',{url:`https://www.douyin.com/video/${id}`},sid);
    return async()=>{this.removeListener('event',listener);this.pageSessions.delete(targetId);if(this.connection)await this.connection.send('Target.closeTarget',{targetId}).catch(()=>{});};
  }
  async close(){if(this.closing)return this.closing;const launching=this.launching;this.closing=(async()=>{if(launching)await launching.catch(()=>{});await this.closeNow();})().finally(()=>{this.closing=null;});return this.closing;}
  async closeNow(){const connection=this.connection,child=this.process;this.connection=null;this.readerTarget=null;this.loginTarget=null;this.api?.reset();this.pageSessions.clear();if(connection){await connection.send('Browser.close').catch(()=>{});connection.close();if(child&&child.exitCode===null)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(2000)]);}}
}
