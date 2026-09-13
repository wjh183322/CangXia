import { createHash } from 'node:crypto';
import { TOTAL, isDouyinURL, isMediaURL, parsePlatformJSON, sleep } from './model.mjs';
import { validateAuth, parseReferenceConfig } from './auth-data.mjs';
import { pageResult, normalizeCollections, paginate } from './api-pagination.mjs';

const API_PATHS=new Set(['/aweme/v1/web/aweme/listcollection/','/aweme/v1/web/collects/list/','/aweme/v1/web/collects/video/list/','/aweme/v1/web/aweme/detail/']);
export class Collector{
  constructor(store,notify,{profile,vault,browser,delay=()=>sleep(1100)}){
    Object.assign(this,{store,notify,profile,vault,browser,delay});this.busy=false;this.cancelled=false;this.waiters=new Map();this.diagnostics=[];
    this.status={phase:'idle',message:'通过系统 Chrome / Edge 连接抖音账号',count:0,connected:false,browserOpened:false};
    this.ready=this.restore();
    browser.on?.('closed',()=>{this.status.browserOpened=false;this.notify();});
  }
  update(phase,message,count=this.status.count){this.status={...this.status,phase,message,count};this.notify();}
  async restore(){const auth=this.vault.load();if(auth)try{await this.applyAuth(auth,false);}catch{this.update('attention','保存的登录信息不可用，请重新连接浏览器或导入配置');}}
  async applyAuth(input,persist=true){
    const auth=validateAuth(input);
    const identity=auth.cookies.find(c=>c.name==='uid_tt')?.value;
    const key=identity?createHash('sha256').update(identity).digest('hex'):null;
    const previous=this.store.getSetting('browserAccountKey');
    if(key&&previous&&key!==previous)throw new Error('这份媒体库已绑定另一个账号，请使用原账号的登录会话');
    if(persist)this.vault.save(auth);
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
    if(key)this.store.setSetting('browserAccountKey',key);
    this.store.setSetting('sessionConnected',true);this.store.save();this.status.connected=true;this.status.source=auth.source;
    this.update('ready',auth.source==='config'?'已导入参考工具的登录会话，可以同步并预览收藏':auth.source==='popup'?'扫码登录成功，可以同步并预览收藏':'已连接系统浏览器，可以同步并预览收藏');
  }
  async isAuthenticated(){await this.ready;const cookies=await this.profile.cookies.get({url:'https://www.douyin.com/'});return cookies.some(c=>['sessionid','sessionid_ss'].includes(c.name)&&c.value);}
  assertNotCoolingDown(){const ms=Number(this.store.getSetting('accessHoldUntil')||0)-Date.now();if(ms>0)throw new Error(`已暂停自动请求，请至少等待 ${Math.ceil(ms/1000)} 秒后再手动尝试。平台恢复时间无法确定。`);}
  holdAccess(retryAfter=60){this.cancelled=true;this.store.setSetting('accessHoldUntil',Date.now()+Math.max(60,retryAfter)*1000);this.store.save();this.onAccessHold?.();this.update('attention','抖音提示访问频繁，读取与下载已暂停，请稍后手动重试');}
  async open(preferred='chrome'){
    await this.ready;if(this.busy||this.waiters.size)throw new Error('请先停止当前读取或下载任务');
    this.browser.preferred=['chrome','edge'].includes(preferred)?preferred:'chrome';
    const name=await this.browser.openLogin();this.status.browserOpened=true;
    this.update('login',`已打开藏匣专用 ${name==='edge'?'Edge':'Chrome'}。完成登录后回到这里点击“我已登录，连接”。`);return name;
  }
  async finishLogin(){await this.ready;if(this.busy||this.waiters.size)throw new Error('请先停止当前任务');await this.applyAuth(await this.browser.credentials());return true;}
  async importConfig(text){await this.ready;if(this.busy||this.waiters.size)throw new Error('请先停止当前任务');await this.applyAuth(parseReferenceConfig(text));return true;}
  async request(path,{params={},method='GET',form,signal,allowGuest=false}={}){
    await this.ready;this.assertNotCoolingDown();if(!API_PATHS.has(path))throw new Error('不支持的读取接口');
    if(!allowGuest&&!(await this.isAuthenticated())){this.status.connected=false;throw new Error('请先通过系统浏览器登录，或导入参考工具配置');}
    const url=new URL(path,'https://www.douyin.com');for(const [key,value] of Object.entries({device_platform:'webapp',aid:'6383',channel:'channel_pc_web',...params}))url.searchParams.set(key,String(value));
    const response=await this.profile.fetch(url.href,{method,redirect:'manual',headers:{Referer:'https://www.douyin.com/','User-Agent':this.userAgent||this.profile.getUserAgent(),Accept:'application/json',...(form?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(form?{body:new URLSearchParams(form).toString()}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
    this.diagnostics.push({path,status:response.status});if(this.diagnostics.length>40)this.diagnostics.shift();
    if(response.status===429){this.holdAccess(Number(response.headers.get('retry-after'))||60);throw new Error('平台限制访问频率，已暂停');}
    if(!response.ok)throw new Error(`抖音接口未接受请求（${response.status}），已停止读取，请检查正常浏览器的登录状态`);
    const text=await response.text();if(text.length>32*1024*1024)throw new Error('响应过大，已停止读取');
    let data;try{data=parsePlatformJSON(text);}catch{throw new Error('接口未返回有效数据，可能需要在系统浏览器完成登录或验证');}
    const message=String(data.status_msg||data.message||data.data?.status_msg||data.data?.message||'');
    if(/访问太频繁|访问过于频繁|操作频繁|请求过于频繁|too many requests/i.test(message)){this.holdAccess();throw new Error('平台限制访问频率，已暂停');}
    if(Number(data.status_code||0)!==0){
      const error=new Error('抖音接口返回访问提示，已停止读取，请在系统浏览器检查账号状态');
      if(/作品已删除|视频已删除|作品不存在|视频不存在/.test(message))error.sourceDeleted=true;
      throw error;
    }
    return data;
  }
  stop(){this.cancelled=true;this.syncController?.abort();this.update('idle','已停止，保留已读取内容');}
  cancelResolve(message='操作已停止'){for(const p of this.waiters.values()){clearTimeout(p.timer);p.reject(new Error(message));}this.waiters.clear();}
  async dispose(){this.closed=true;this.stop();this.cancelResolve();await this.browser.close();}
  async sync({discoverOnly=false}={}){
    if(this.busy||this.waiters.size)throw new Error('已有读取任务正在进行');
    await this.ready;
    try{this.assertNotCoolingDown();if(!(await this.isAuthenticated())){this.update('attention','请先点击“连接抖音账号”，使用系统浏览器或导入配置完成连接');return;}}catch(e){this.update('attention',e.message);return;}
    this.busy=true;this.cancelled=false;this.syncController=new AbortController();const signal=this.syncController.signal;
    const delay=async()=>{await this.delay();if(signal.aborted)throw new Error('读取已停止');};
    try{
      if(discoverOnly){
        this.update('syncing','正在读取账号的自建收藏夹',0);
        const result=await paginate(async cursor=>pageResult(await this.request('/aweme/v1/web/collects/list/',{params:{count:30,cursor},signal}),'collects_list'),async(items,complete)=>{
          const normalized=normalizeCollections(items);this.store.discoverCollections(normalized,complete);this.update('syncing',`已发现 ${normalized.length} 个收藏夹`,normalized.length);
        },{signal,delay});
        this.update(result.complete?'done':'attention',result.complete?'收藏夹目录已读取，请选择添加':'已保留发现的收藏夹，但接口未提供完整分页结束依据');return;
      }
      let allComplete=true;
      for(const c of this.store.all('collections').filter(c=>c.added&&!c.remoteMissing).sort((a,b)=>a.rank-b.rank)){
        if(this.cancelled)break;this.update('syncing',`正在读取「${c.name}」`,0);
        let processed=0;const memberIds=new Set();
        const result=await paginate(async cursor=>{
          const data=c.id===TOTAL?await this.request('/aweme/v1/web/aweme/listcollection/',{method:'POST',form:{cursor,count:'30'},signal}):await this.request('/aweme/v1/web/collects/video/list/',{params:{collects_id:c.id,cursor,count:30},signal});
          return pageResult(data,'aweme_list');
        },async(items,complete)=>{
          for(const raw of items.slice(processed)){const id=this.store.upsertWork(raw)?.id;if(!id)throw new Error('作品结构无法识别，已停止更新列表并保留已有收藏');memberIds.add(id);}processed=items.length;
          const ids=[...memberIds];this.store.ingestMembers(c.id,ids,complete);this.update('syncing',`正在读取「${c.name}」 · ${ids.length} 个作品`,ids.length);
        },{signal,delay});
        if(!result.complete)allComplete=false;
        await delay();
      }
      if(this.cancelled)return;
      const errors=this.store.reconcile();
      this.update(allComplete&&!errors.length?'done':'attention',errors.length?errors.join('；'):allComplete?'收藏已同步，可先预览再勾选下载':'已保留读取内容，但部分列表未完整读取，请勿将显示数量视为全部收藏');
    }catch(e){if(!this.cancelled)this.update('attention',e.message);}finally{this.busy=false;this.syncController=null;this.notify();}
  }
  markUnavailable(id){const w=this.store.work(id);if(w){this.store.put('works',id,{...w,remoteState:'unavailable',checkedAt:new Date().toISOString()});this.store.save();this.notify();}}
  async resolveWork(id){
    await this.ready;this.assertNotCoolingDown();if(!/^\d+$/.test(id))throw new Error('作品标识无效');if(this.busy||this.waiters.size)throw new Error('请等待当前读取任务结束');
    if(await this.isAuthenticated()){
      const controller=new AbortController();this.waiters.set(id,{reject:()=>controller.abort()});
      try{const data=await this.request('/aweme/v1/web/aweme/detail/',{params:{aweme_id:id},signal:controller.signal});const raw=data.aweme_detail||data.data?.aweme_detail;if(!raw)throw new Error('未获得作品详情，已有文件仍保留');const w=this.store.upsertWork(raw);this.store.save();this.notify();return w;}
      catch(e){if(e.sourceDeleted)this.markUnavailable(id);throw e;}
      finally{this.waiters.delete(id);}
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
    await this.ready;let next=url;
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
