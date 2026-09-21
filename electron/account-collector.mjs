import { createHash, randomUUID } from 'node:crypto';
import { TOTAL, isDouyinURL, isMediaURL, parsePlatformJSON, parseWork, sleep } from './model.mjs';
import { validateAuth, parseReferenceConfig } from './auth-data.mjs';
import {validAccountIdentity} from './account-identity.mjs';
import { pageResult, normalizeCollections, paginate } from './api-pagination.mjs';

const API_PATHS=new Set(['/aweme/v1/web/aweme/listcollection/','/aweme/v1/web/collects/list/','/aweme/v1/web/collects/video/list/','/aweme/v1/web/aweme/detail/']);
export class Collector{
  constructor(store,notify,{profile,vault,browser,delay=()=>sleep(1100),verifyIdentity,onDiagnostic=()=>{}}){
    Object.assign(this,{store,notify,profile,vault,browser,delay,verifyIdentity,onDiagnostic});this.busy=false;this.cancelled=false;this.cancelEpoch=0;this.waiters=new Map();this.diagnostics=[];
    this.status={phase:'idle',message:'通过系统 Chrome / Edge 连接抖音账号',count:0,connected:false,browserOpened:false};
    this.ready=this.restore();
    browser.on?.('closed',()=>{this.browserBinding=null;this.status.browserOpened=false;if(this.requestMode==='browser'&&!this.closed){this.cancelled=true;this.syncController?.abort();this.cancelResolve();this.onBrowserStop?.();this.update('attention','后台读取环境已退出，已保留进度；点击继续读取可重新启动');}else this.notify();});
  }
  update(phase,message,count=this.status.count){this.status={...this.status,phase,message,count};this.notify();}
  async restore(){if(this.store.getSetting('loggedOut')){this.update('idle','已退出登录，本地资料保留');return;}if(this.store.getSetting('authNeedsRefresh')){this.status.needsLogin=true;this.update('attention','需要重新登录或完成抖音验证，已有收藏保留');return;}const auth=this.vault.load();if(auth)try{await this.applyAuth(auth,false);}catch{this.update('attention','保存的登录信息不可用，请重新连接浏览器或导入配置');}}
  async applyAuth(input,persist=true,options={}){
    if(this.authenticating)throw new Error('正在核对登录账号，请稍候');
    this.authenticating=true;clearTimeout(this.browserIdle);
    this.authController=new AbortController();const signal=options.signal?AbortSignal.any([options.signal,this.authController.signal]):this.authController.signal;
    this.authTask=this.applyAuthInternal(input,persist,{...options,signal});
    try{return await this.authTask;}finally{this.authenticating=false;this.authTask=null;this.scheduleBrowserIdle();}
  }
  async applyAuthInternal(input,persist=true,{signal,confirmLegacy=false}={}){
    signal?.throwIfAborted();
    if(persist){this.store.backup?.assertWritable();this.store.nas?.assertWritable();}
    const auth=validateAuth(input);
    const identity=auth.cookies.find(c=>c.name==='uid_tt')?.value;
    const key=identity?createHash('sha256').update(identity).digest('hex'):null;
    const previous=this.store.getSetting('browserAccountKey');
    const savedAccount=this.store.getSetting('account');
    const boundUid=typeof previous==='string'&&previous.startsWith('uid:')?previous.slice(4):validAccountIdentity(savedAccount)?savedAccount.uid:null;
    this.status.connected=false;
    await this.profile.clearStorageData({storages:['cookies']});
    this.userAgent=auth.userAgent;
    this.profile.setUserAgent(auth.userAgent);
    for(const c of auth.cookies){
      const cookie={url:'https://www.douyin.com'+(c.path||'/'),domain:c.domain,path:c.path||'/',name:c.name,value:c.value,secure:c.secure!==false,httpOnly:!!c.httpOnly};
      if(c.expires>0)cookie.expirationDate=c.expires;
      if(['strict','lax','no_restriction'].includes(c.sameSite))cookie.sameSite=c.sameSite;
      if(c.sameSite==='None')cookie.sameSite='no_restriction';
      if(c.sameSite==='Lax')cookie.sameSite='lax';if(c.sameSite==='Strict')cookie.sameSite='strict';
      await this.profile.cookies.set(cookie);
    }
    try{
      if(persist&&this.browser.api&&this.browser.prepareSession)await this.browser.prepareSession(auth,{signal,replace:!['chrome','edge'].includes(auth.source)});
      if(this.verifyIdentity&&(persist||auth.identity)){
        const needsLegacyCheck=!!previous&&!boundUid&&key!==previous;
        let verified;this.verifyingIdentity=true;
        try{const verificationProfile=persist&&this.browser.api?this.browserProfile(await this.browser.api.prepare(signal)):this.profile;verified=persist?await this.verifyIdentity(verificationProfile,auth.userAgent,{signal,onLimited:seconds=>this.holdAccess(seconds),legacyCollections:needsLegacyCheck?this.store.all('collections').filter(c=>c.id!==TOTAL&&c.added).map(c=>c.id):[]}):auth.identity;}finally{this.verifyingIdentity=false;}
        signal?.throwIfAborted();
        if(this.store.getSetting('browserAccountKey')!==previous)throw new Error('资料库账号信息刚发生变化，请重新检查连接后登录');
        if(confirmLegacy&&verified.uid!==confirmLegacy)throw new Error('扫码账号已变化，请重新确认');
        if(!validAccountIdentity(verified))throw new Error('未取得可靠的抖音账号标识');
        if(boundUid&&verified.uid!==boundUid)throw Object.assign(new Error('这份媒体库属于另一个抖音账号，请使用原账号重新扫码'),{code:'ACCOUNT_MISMATCH'});
        if(needsLegacyCheck&&!verified.ownsLegacyCollection&&!confirmLegacy){this.pendingAuth={auth,identity:verified,previous,token:randomUUID(),expires:Date.now()+300000};this.status.pendingAccount={uid:verified.uid,nickname:verified.nickname||'当前账号',token:this.pendingAuth.token,records:this.store.rows('SELECT COUNT(*) n FROM works')[0].n};throw Object.assign(new Error('旧版资料没有保存可核对的账号 ID，请确认这是原来收藏的账号'),{code:'LEGACY_CONFIRM_REQUIRED'});}
        auth.identity={uid:verified.uid,nickname:verified.nickname||''};
        this.store.setSetting('browserAccountKey','uid:'+verified.uid);
        for(const row of this.store.rows('SELECT collection_id,body FROM sync_runs')){const run=JSON.parse(row.body);if(run.accountKey===previous){run.accountKey='uid:'+verified.uid;this.store.db.run('UPDATE sync_runs SET body=? WHERE collection_id=?',[JSON.stringify(run),row.collection_id]);}}
        this.store.setSetting('account',{...savedAccount,uid:verified.uid,nickname:verified.nickname||savedAccount?.nickname||'抖音已连接'});
      }else{
        if(previous&&key!==previous)throw Object.assign(new Error('旧版账号绑定需要重新扫码验证，已保留原资料'),{code:'ACCOUNT_UNVERIFIED'});
        if(key)this.store.setSetting('browserAccountKey',key);
      }
      signal?.throwIfAborted();this.store.setSetting('sessionConnected',true);this.store.save();
      if(persist)this.vault.save(auth);
      this.store.setSetting('authNeedsRefresh',false);this.store.setSetting('loggedOut',false);this.store.save();this.pendingAuth=null;this.status.pendingAccount=null;this.status.needsLogin=false;this.status.logoutIncomplete=false;this.status.connected=true;this.status.source=auth.source;
      this.requestMode=this.browser.api?'browser':'direct';this.status.requestMode=this.requestMode;this.browserBinding=null;this.pendingBrowserAuth=persist?null:auth;if(['chrome','edge'].includes(auth.source))this.browser.preferred=auth.source;
    }catch(e){await this.profile.clearStorageData({storages:['cookies']});this.store.setSetting('sessionConnected',false);throw e;}
    if(persist)await this.browser.hideLogin?.();this.status.browserOpened=false;this.scheduleBrowserIdle();
    this.update('ready',this.requestMode==='browser'?'登录已连接，可后台读取收藏，无需保留浏览器窗口':auth.source==='config'?'已导入参考工具的登录会话，可以同步并预览收藏':auth.source==='popup'?'扫码登录成功，可以同步并预览收藏':'已连接系统浏览器，可以同步并预览收藏');
  }
  async isAuthenticated(){await this.ready;if(this.requestMode==='browser')return this.status.connected;const cookies=await this.profile.cookies.get({url:'https://www.douyin.com/'});return this.status.connected&&cookies.some(c=>['sessionid','sessionid_ss'].includes(c.name)&&c.value&&(!c.expirationDate||c.expirationDate>Date.now()/1000));}
  async cancelAuthentication(){this.authController?.abort();await this.authTask?.catch(()=>{});}
  async logout(){
    if(this.busy)throw new Error('请先停止读取，再退出登录');
    await this.cancelAuthentication();clearTimeout(this.browserIdle);this.cancelResolve();
    this.pendingAuth=null;this.pendingBrowserAuth=null;this.browserBinding=null;this.requestMode=null;this.userAgent='';
    this.status={...this.status,connected:false,needsLogin:false,source:null,requestMode:null,pendingAccount:null,browserOpened:false};
    const results=await Promise.allSettled([Promise.resolve().then(()=>{this.store.setSetting('loggedOut',true);this.store.setSetting('sessionConnected',false);this.store.setSetting('authNeedsRefresh',true);this.store.save();}),Promise.resolve().then(()=>this.vault.clear()),this.profile.clearStorageData(),this.browser.clearLoginData()]);
    this.status.logoutIncomplete=results.some(r=>r.status==='rejected');
    this.update('idle',this.status.logoutIncomplete?'已断开登录，但部分登录信息未能清理，请重试':'已退出登录，本地资料和读取进度已保留');
    if(this.status.logoutIncomplete)throw new Error(this.status.message);
  }
  scheduleBrowserIdle(){
    clearTimeout(this.browserIdle);if(!this.browser.background||this.closed)return;
    this.browserIdle=setTimeout(async()=>{const idle=()=>!this.closed&&!this.busy&&!this.waiters.size&&!this.authenticating&&!this.verifyingIdentity&&!this.status.browserOpened;if(!idle())return;if(this.browser.connection)try{const released=await this.browser.releaseIdle?.(idle);if(released)this.browserBinding=null;else this.scheduleBrowserIdle();}catch{}},60000);this.browserIdle.unref();
  }
  browserProfile(page){return {fetch:async(url,options={})=>{
    const u=new URL(url);if(u.origin!=='https://www.douyin.com')throw new Error('不支持的账号核验地址');
    const response=await this.browser.api.request(u.pathname,{params:Object.fromEntries(u.searchParams),method:options.method||'GET',signal:options.signal,page});
    if(response.status===429){this.holdAccess(Number(response.headers.get('retry-after'))||60);throw new Error('平台限制访问频率，已暂停');}
    return response;
  }};}
  browserFingerprint(cookies){return createHash('sha256').update(JSON.stringify(cookies.filter(c=>['sessionid','sessionid_ss','uid_tt'].includes(c.name)).map(c=>[c.name,c.domain,c.path,c.value]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex');}
  async requestBrowser(path,options){
    clearTimeout(this.browserIdle);
    const {signal}=options;let page=await this.browser.api.prepare(signal),cookies=await this.browser.api.credentials(page,signal);
    const logged=values=>values.some(c=>['sessionid','sessionid_ss'].includes(c.name)&&c.value&&(!(c.expires??c.expirationDate)||(c.expires??c.expirationDate)<0||(c.expires??c.expirationDate)>Date.now()/1000));
    if(!logged(cookies)&&this.pendingBrowserAuth&&this.browser.prepareSession){const auth=this.pendingBrowserAuth;this.pendingBrowserAuth=null;if(logged(auth.cookies)){await this.browser.prepareSession(auth,{signal});page=await this.browser.api.prepare(signal);cookies=await this.browser.api.credentials(page,signal);}}
    this.pendingBrowserAuth=null;
    if(!cookies.some(c=>['sessionid','sessionid_ss'].includes(c.name)&&c.value&&(!c.expires||c.expires<0||c.expires>Date.now()/1000))){this.needsLogin('专用浏览器需要重新登录或验证，已有进度保留');throw new Error('请在专用浏览器完成登录并重新连接');}
    const fingerprint=this.browserFingerprint(cookies),key=this.store.getSetting('browserAccountKey'),uid=typeof key==='string'&&key.startsWith('uid:')?key.slice(4):null;
    if(!uid||!this.verifyIdentity){this.needsLogin('请在专用浏览器重新连接并确认原账号，已有资料保留');throw new Error('请在专用浏览器重新连接并确认原账号，已有资料保留');}
    if(this.browserBinding?.page!==page||this.browserBinding?.fingerprint!==fingerprint||this.browserBinding?.uid!==uid){
      const identity=await this.verifyIdentity(this.browserProfile(page),this.browser.userAgent,{signal,onLimited:seconds=>this.holdAccess(seconds)});
      if(!validAccountIdentity(identity)||identity.uid!==uid){this.needsLogin('专用浏览器登录的是另一个账号，已停止读取并保留原资料');throw new Error('专用浏览器账号与资料库不一致，请切回原账号后重新连接');}
      this.browserBinding={page,fingerprint,uid};
    }
    const response=await this.browser.api.request(path,{...options,page});
    if(response.status===429)return response;
    const after=await this.browser.api.credentials(page,signal);
    if(this.browserFingerprint(after)!==fingerprint||this.store.getSetting('browserAccountKey')!==key){this.browserBinding=null;throw new Error('读取期间浏览器登录会话发生变化，本页未写入，请检查账号后重试');}
    return response;
  }
  async confirmLegacyAccount(token){const p=this.pendingAuth;if(!p||p.token!==token||p.expires<Date.now()||this.store.getSetting('browserAccountKey')!==p.previous)throw new Error('账号确认已过期，请重新扫码');await this.applyAuth(p.auth,true,{confirmLegacy:p.identity.uid});}
  needsLogin(message){this.status.connected=false;this.status.needsLogin=true;this.store.setSetting('authNeedsRefresh',true);this.store.setSetting('sessionConnected',false);this.store.save();this.update('attention',message);}
  assertNotCoolingDown(){const ms=Number(this.store.getSetting('accessHoldUntil')||0)-Date.now();if(ms>0)throw new Error(`已暂停自动请求，请至少等待 ${Math.ceil(ms/1000)} 秒后再手动尝试。平台恢复时间无法确定。`);}
  holdAccess(retryAfter=60){this.cancelled=true;this.store.setSetting('accessHoldUntil',Date.now()+Math.max(60,retryAfter)*1000);this.store.save();this.onAccessHold?.();this.update('attention','抖音提示访问频繁，读取与下载已暂停，请稍后手动重试');}
  async open(preferred='chrome'){
    await this.ready;if(this.busy||this.waiters.size)throw new Error('请先停止当前读取或下载任务');
    clearTimeout(this.browserIdle);
    this.browser.preferred=['chrome','edge'].includes(preferred)?preferred:'chrome';
    const name=await this.browser.openLogin();this.browserBinding=null;this.status.browserOpened=true;
    this.update('login',`已打开藏匣专用 ${name==='edge'?'Edge':'Chrome'}。完成登录后回到这里点击“我已登录，连接”。`);return name;
  }
  async finishLogin(){await this.ready;if(this.busy||this.waiters.size)throw new Error('请先停止当前任务');await this.applyAuth(await this.browser.credentials());return true;}
  async importConfig(text){await this.ready;if(this.busy||this.waiters.size)throw new Error('请先停止当前任务');await this.applyAuth(parseReferenceConfig(text));return true;}
  async request(path,{params={},method='GET',form,signal,allowGuest=false,quiet=false}={}){
    const record=event=>{if(!quiet)this.onDiagnostic(event);};
    await this.ready;this.assertNotCoolingDown();if(!API_PATHS.has(path))throw new Error('不支持的读取接口');
    if(!allowGuest&&!(await this.isAuthenticated())){this.needsLogin('登录会话需要更新，请重新扫码或在专用浏览器完成验证');throw new Error('登录会话需要更新，请重新扫码或完成验证');}
    const url=new URL(path,'https://www.douyin.com');for(const [key,value] of Object.entries({device_platform:'webapp',aid:'6383',channel:'channel_pc_web',...params}))url.searchParams.set(key,String(value));
    const response=this.requestMode==='browser'&&!allowGuest?await this.requestBrowser(path,{params,method,form,signal}):await this.profile.fetch(url.href,{method,redirect:'manual',headers:{Referer:'https://www.douyin.com/','User-Agent':this.userAgent||this.profile.getUserAgent(),Accept:'application/json',...(form?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(form?{body:new URLSearchParams(form).toString()}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
    if(!quiet){this.diagnostics.push({path,status:response.status});if(this.diagnostics.length>40)this.diagnostics.shift();}
    if(response.status===429){this.holdAccess(Number(response.headers.get('retry-after'))||60);throw new Error('平台限制访问频率，已暂停');}
    if(!response.ok){const message=response.status===403&&this.requestMode!=='browser'?'读取被拒绝（HTTP 403），请通过“专用浏览器”登录并连接后重试，已有进度保留':`抖音接口未接受请求（HTTP ${response.status}），请在${this.requestMode==='browser'?'专用浏览器':'登录窗口'}检查账号和验证状态`;record({event:'api-error',httpStatus:response.status,path});if([401,403].includes(response.status))this.needsLogin(message);throw new Error(message);}
    const text=await response.text();if(text.length>32*1024*1024)throw new Error('响应过大，已停止读取');
    let data;try{data=parsePlatformJSON(text);}catch{this.needsLogin('抖音未返回有效数据，请在验证窗口检查登录状态');record({event:'api-format',path});throw new Error('接口未返回有效数据，请重新登录或完成验证');}
    const message=String(data.status_msg||data.message||data.data?.status_msg||data.data?.message||'');
    if(/访问太频繁|访问过于频繁|操作频繁|请求过于频繁|too many requests/i.test(message)){this.holdAccess();throw new Error('平台限制访问频率，已暂停');}
    if(Number(data.status_code||0)!==0){
      const code=String(data.status_code).slice(0,32);record({event:'api-business-error',path,businessCode:code});const error=new Error(`抖音接口返回访问提示（代码 ${code}），请重新登录或完成验证，已有读取进度保留`);if(!/作品已删除|视频已删除|作品不存在|视频不存在/.test(message))this.needsLogin(error.message);
      if(/作品已删除|视频已删除|作品不存在|视频不存在/.test(message))error.sourceDeleted=true;
      throw error;
    }
    return data;
  }
  stop(){this.cancelEpoch++;this.stopRequested=true;this.cancelled=true;this.syncController?.abort();if(this.busy)this.readProgress({stage:'stopping'});this.update('idle',this.busy?'正在停止并保存已读取内容…':'已停止，保留已读取内容');}
  readProgress(change){this.status.readProgress={...this.status.readProgress,...change};this.notify();}
  cancelResolve(message='操作已停止'){for(const p of this.waiters.values()){clearTimeout(p.timer);p.reject(new Error(message));}this.waiters.clear();}
  async dispose(){this.closed=true;clearTimeout(this.browserIdle);this.stop();this.cancelResolve();await this.cancelAuthentication();await this.browser.close();}
  async sync({discoverOnly=false,collectionId=TOTAL,readAll=false,maxNew=20,resume=false}={}){
    const epoch=this.cancelEpoch;
    if(this.busy||this.waiters.size)throw new Error('已有读取任务正在进行');
    if(!discoverOnly){
      const c=this.store.collection(collectionId);
      if(!c?.added||c.remoteMissing)throw new Error('请先添加有效的收藏夹');
      if(!Number.isSafeInteger(maxNew)||maxNew<1||maxNew>100000)throw new Error('最大读取数须为 1 到 100000 的整数');
      if(!readAll)this.store.setSetting('readLimit',maxNew);this.store.save();
    }
    await this.ready;
    try{this.assertNotCoolingDown();if(!(await this.isAuthenticated())){this.update('attention','请先点击“连接抖音账号”，使用系统浏览器或导入配置完成连接');return;}}catch(e){this.update('attention',e.message);return;}
    if(epoch!==this.cancelEpoch){this.update('idle','已取消读取，原资料保留');return;}
    this.busy=true;this.cancelled=false;this.stopRequested=false;this.syncController=new AbortController();const signal=this.syncController.signal;
    this.status.readProgress={mode:discoverOnly?'folders':readAll?'all':'partial',name:discoverOnly?'收藏夹目录':this.store.collection(collectionId)?.name||'收藏',goal:!discoverOnly&&!readAll?maxNew:null,checked:0,added:0,startedAt:Date.now(),stage:'preparing'};this.notify();
    let needsReconcile=false,run;
    const delay=async()=>{await this.delay();if(signal.aborted)throw new Error('读取已停止');};
    try{
      if(discoverOnly){
        this.update('syncing','正在读取账号的自建收藏夹',0);
        const result=await paginate(async cursor=>pageResult(await this.request('/aweme/v1/web/collects/list/',{params:{count:30,cursor},signal}),'collects_list'),async(items,complete)=>{
          const normalized=normalizeCollections(items);this.store.discoverCollections(normalized,complete);this.update('syncing',`已发现 ${normalized.length} 个收藏夹`,normalized.length);
          this.readProgress({stage:'reading',checked:normalized.length});
        },{signal,delay});
        this.update(result.complete?'done':'attention',result.complete?'收藏夹目录已读取，请选择添加':'已保留发现的收藏夹，但接口未提供完整分页结束依据');return;
      }
      const c=this.store.collection(collectionId);run=this.store.sync.start(c.id,{resume,readAll});
      this.readProgress({checked:run.count});
      let added=0,complete=false,limited=false;
      this.update('syncing',`正在读取「${c.name}」`,run.count);
      for(let page=0;page<10000&&!this.cancelled;page++){
        const cursor=run.nextCursor;if(cursor===null)break;
        if(this.store.sync.seen(c.id,cursor)){run.nextCursor=null;throw new Error('平台返回重复翻页位置，已保留读取记录，请稍后从头核对');}
        const data=c.id===TOTAL?await this.request('/aweme/v1/web/aweme/listcollection/',{method:'POST',form:{cursor,count:'30'},signal}):await this.request('/aweme/v1/web/collects/video/list/',{params:{collects_id:c.id,cursor,count:30},signal});
        const result=pageResult(data,'aweme_list');const pageState=this.store.sync.applyPage(run,result.items,result,{maxNew:readAll?Infinity:maxNew-added,signal});
        added+=pageState.added;complete=pageState.complete;limited=!readAll&&added>=maxNew;
        this.readProgress({stage:'reading',checked:run.count,added});
        needsReconcile=true;
        this.update('syncing',`「${c.name}」 · 已检查 ${run.count} 个，新增 ${added} 个`,run.count);
        if(complete||limited||run.nextCursor===null||!result.items.length)break;
        await delay();
      }
      this.readProgress({stage:'saving'});const errors=this.store.reconcile();
      needsReconcile=false;
      if(this.cancelled)return;
      this.update((complete||limited)&&!errors.length?'done':'attention',errors.length?errors.join('；'):`「${c.name}」${complete?(run.resumed?'续读到列表末尾；如收藏有变化，请再从头核对':'已读完'):limited?'部分读取完成':'读取未完整结束'} · 已检查 ${run.count} 个，新增 ${added} 个`,run.count);
    }catch(e){if(!this.cancelled)this.update('attention',e.message);}finally{
      let saveFailed=false;
      try{if(run&&run.status!=='complete')this.store.sync.finish(run,false,this.cancelled?'读取已暂停':this.status.message);if(needsReconcile){const errors=this.store.reconcile();if(errors.length)this.update('attention',errors.join('；'));}}
      catch{saveFailed=true;this.update('attention','读取已停止，但进度保存未完成，请检查磁盘空间或目录权限');}
      finally{this.busy=false;this.syncController=null;if(!saveFailed&&this.cancelled&&this.stopRequested)this.update('idle','已停止，已读取内容和进度已保留');this.readProgress({stage:'finished',finishedAt:Date.now(),stopped:this.cancelled,saveFailed});this.scheduleBrowserIdle();this.notify();}
    }
  }
  markUnavailable(id){const w=this.store.work(id);if(w){this.store.put('works',id,{...w,remoteState:'unavailable',checkedAt:new Date().toISOString()});this.store.save();this.notify();}}
  async resolveMediaOnly(id,signal){
    await this.ready;signal?.throwIfAborted();if(!/^\d+$/.test(id))throw new Error('作品标识无效');if(this.busy||this.waiters.size)throw new Error('请等待当前读取任务结束');
    if(!(await this.isAuthenticated()))throw new Error('剩余媒体需要联网，请登录原账号后重试');
    const controller=new AbortController(),key='flat:'+id;const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;this.waiters.set(key,{reject:()=>controller.abort()});
    try{const data=await this.request('/aweme/v1/web/aweme/detail/',{params:{aweme_id:id},signal:combined,quiet:true});const work=parseWork(data.aweme_detail||data.data?.aweme_detail||{});if(!work||work.id!==id)throw new Error('未取得对应作品资源');return work;}
    finally{this.waiters.delete(key);this.scheduleBrowserIdle();}
  }
  async resolveWork(id){
    await this.ready;if(this.store.getSetting('loggedOut'))throw new Error('请登录原账号后再读取在线作品');this.assertNotCoolingDown();if(!/^\d+$/.test(id))throw new Error('作品标识无效');if(this.busy||this.waiters.size)throw new Error('请等待当前读取任务结束');
    if(await this.isAuthenticated()){
      const controller=new AbortController();this.waiters.set(id,{reject:()=>controller.abort()});
      try{const data=await this.request('/aweme/v1/web/aweme/detail/',{params:{aweme_id:id},signal:controller.signal});const raw=data.aweme_detail||data.data?.aweme_detail;if(!raw)throw new Error('未获得作品详情，已有文件仍保留');const w=this.store.upsertWork(raw);this.store.save();this.notify();return w;}
      catch(e){if(e.sourceDeleted)this.markUnavailable(id);throw e;}
      finally{this.waiters.delete(id);this.scheduleBrowserIdle();}
    }
    // Public-link fallback only: observe the normal page's own detail response, never synthesize a signature.
    let cleanup;
    const result=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiters.delete(id);reject(new Error('公开作品读取超时，请连接系统浏览器后重试'));},40000);this.waiters.set(id,{resolve,reject,timer});});
    result.catch(()=>{});
    try{
      cleanup=await this.browser.observeWork(id,(url,status,text)=>{
        if(this.closed||!this.waiters.has(id))return;
        try{if(status!==200)return;const data=parsePlatformJSON(text);const raw=data.aweme_detail;if(!raw||String(raw.aweme_id)!==id)return;const w=this.store.upsertWork(raw);this.store.save();const p=this.waiters.get(id);this.waiters.delete(id);clearTimeout(p.timer);p.resolve(w);this.notify();}catch{}
      });
      this.userAgent=this.browser.userAgent;this.profile.setUserAgent(this.userAgent);
      return await result;
    }finally{const p=this.waiters.get(id);if(p){clearTimeout(p.timer);this.waiters.delete(id);}if(cleanup)await cleanup();}
  }
  async importLink(text){
    if(this.store.getSetting('loggedOut'))throw new Error('请登录原账号后再导入在线作品');
    this.assertNotCoolingDown();const match=String(text).match(/https:\/\/[^\s<>\]]+/);if(!match||!isDouyinURL(match[0]))throw new Error('请粘贴抖音作品链接或分享文案');
    let url=match[0];
    for(let i=0;i<4;i++){
      const id=url.match(/\/(?:video|note)\/(\d+)/)?.[1];if(id)return this.resolveWork(id);
      const response=await this.profile.fetch(url,{redirect:'manual',signal:AbortSignal.timeout(12000)});const location=response.headers.get('location');
      if(!location)break;url=new URL(location,url).href;if(!isDouyinURL(url))throw new Error('分享链接跳转到了不支持的地址');
    }
    await this.browser.open(url);throw new Error('请从已打开的正常浏览器中复制完整作品链接，再粘贴到这里');
  }
  async openOriginal(url){if(!isDouyinURL(url))throw new Error('作品链接无效');return this.browser.open(url);}
  async fetchMedia(url,options={}){
    await this.ready;if(this.store.getSetting('loggedOut'))throw new Error('已退出登录，请登录后查看尚未保存的媒体');let next=url;
    for(let i=0;i<6;i++){
      if(!isMediaURL(next))throw new Error('媒体来源不受支持');
      const response=await this.profile.fetch(next,{...options,redirect:'manual',headers:{Referer:'https://www.douyin.com/','User-Agent':this.userAgent||this.profile.getUserAgent(),...(options.headers||{})}});
      if(response.status===429){this.holdAccess(Number(response.headers.get('retry-after'))||60);throw new Error('媒体请求过于频繁，已暂停下载');}
      if(![301,302,303,307,308].includes(response.status))return response;
      const location=response.headers.get('location');if(!location)throw new Error('媒体跳转地址缺失');next=new URL(location,next).href;
    }
    throw new Error('媒体跳转次数过多');
  }
}
