import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const ROUTES=new Set(['/aweme/v1/web/user/profile/self/','/aweme/v1/web/collects/list/','/aweme/v1/web/collects/video/list/','/aweme/v1/web/aweme/listcollection/','/aweme/v1/web/aweme/detail/']);
const failure=(code,message)=>Object.assign(new Error(message),{code});
export function apiRequest(route,{params={},method='GET',form}={}){
 if(!ROUTES.has(route)||method!==(route==='/aweme/v1/web/aweme/listcollection/'?'POST':'GET'))throw failure('BROWSER_ROUTE','不支持的读取接口');
 const url=new URL(route,'https://www.douyin.com');for(const [k,v]of Object.entries({device_platform:'webapp',aid:'6383',channel:'channel_pc_web',...params}))url.searchParams.set(k,String(v));
 return {url:url.href,method,body:form?new URLSearchParams(form).toString():null};
}

export function abortable(promise,signal){
 if(!signal)return promise;
 return new Promise((resolve,reject)=>{
  const aborted=()=>{cleanup();reject(signal.reason||failure('BROWSER_ABORT','读取已停止'));};
  const cleanup=()=>signal.removeEventListener('abort',aborted);
  signal.addEventListener('abort',aborted,{once:true});
  Promise.resolve(promise).then(v=>{cleanup();resolve(v);},e=>{cleanup();reject(e);});
  if(signal.aborted)aborted();
 });
}

// Runs in the normal, already-loaded official page. Only reading endpoints are allowed above.
export function fetchInPage({url,method,body,key,timeout=12000,maxBytes=8*1024*1024}){
 if(location.origin!=='https://www.douyin.com'||document.readyState==='loading')return Promise.resolve({error:'page-changed'});
 const control=new AbortController();window[key]=control;const timer=setTimeout(()=>control.abort('timeout'),timeout);
 return (async()=>{try{
  const headers={Accept:'application/json'};if(body!==null)headers['Content-Type']='application/x-www-form-urlencoded';
  const response=await fetch(url,{method,headers,credentials:'include',redirect:'error',...(body!==null?{body}:{}),signal:control.signal});
  const reader=response.body?.getReader(),parts=[];let size=0;
  if(reader){const decoder=new TextDecoder();try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>maxBytes)return {error:'too-large'};parts.push(decoder.decode(chunk.value,{stream:true}));}parts.push(decoder.decode());}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
  return {status:response.status,text:parts.join(''),retryAfter:Math.min(3600,Math.max(0,Number(response.headers.get('retry-after'))||0))};
 }catch{return {error:control.signal.aborted?(control.signal.reason==='timeout'?'timeout':'cancelled'):'network'};}
 finally{clearTimeout(timer);delete window[key];}})();
}
export const pageApiScript=(request,key)=>`(${fetchInPage.toString()})(${JSON.stringify({...request,key})})`;

export class BrowserAPI{
 constructor(browser){this.browser=browser;this.page=null;this.preparing=null;}
 reset(){this.page=null;}
 async prepare(signal){
  signal?.throwIfAborted();if(this.preparing)return abortable(this.preparing,signal);
  this.preparing=this.preparePage(signal).finally(()=>{this.preparing=null;});return this.preparing;
 }
 async preparePage(signal){
  const b=this.browser;await abortable(b.launch('https://www.douyin.com/user/self'),signal);signal?.throwIfAborted();
  const connection=b.connection;if(!connection)throw failure('BROWSER_CLOSED','专用浏览器已关闭，已保存读取进度');
  const {targetInfos}=await abortable(connection.send('Target.getTargets'),signal);
  let target=this.page?.connection===connection?targetInfos.find(t=>t.targetId===this.page.targetId):null;
  if(this.page?.connection===connection&&!target)throw failure('BROWSER_PAGE_CLOSED','用于读取的浏览器页面已关闭，请重新打开专用浏览器并连接');
  if(!target)target=targetInfos.find(t=>t.type==='page'&&t.url.startsWith('https://www.douyin.com/'));
  if(!target)throw failure('BROWSER_PAGE','请在专用浏览器打开抖音网页并完成登录');
  const sid=await abortable(b.attach(target.targetId),signal);const page=this.page?.connection===connection&&this.page.targetId===target.targetId?this.page:{connection,targetId:target.targetId,sid};
  for(let i=0;i<40;i++){
   signal?.throwIfAborted();if(b.connection!==connection)throw failure('BROWSER_CLOSED','专用浏览器已关闭，已保存读取进度');
   const r=await abortable(connection.send('Runtime.evaluate',{expression:`({origin:location.origin,ready:document.readyState})`,returnByValue:true},sid),signal);
   if(r.result?.value?.origin==='https://www.douyin.com'&&r.result.value.ready!=='loading'){this.page=page;return page;}
   await delay(200,null,{signal});
  }
  throw failure('BROWSER_PAGE','抖音网页尚未就绪，请在专用浏览器确认收藏可读后重试');
 }
 async credentials(page,signal){
  if(page!==this.page||page.connection!==this.browser.connection)throw failure('BROWSER_CLOSED','专用浏览器连接已改变，请重新连接');
  const {cookies}=await abortable(page.connection.send('Network.getCookies',{urls:['https://www.douyin.com/']},page.sid),signal);
  return cookies.filter(c=>['douyin.com','www.douyin.com'].includes(String(c.domain).replace(/^\./,'')));
 }
 async request(route,options={}){
  const request=apiRequest(route,options),signal=options.signal;signal?.throwIfAborted();
  const page=options.page||await this.prepare(signal);if(page!==this.page||page.connection!==this.browser.connection)throw failure('BROWSER_CLOSED','专用浏览器已关闭，已保存读取进度');
  const key='__cangxia_read_'+randomUUID().replaceAll('-','');
  const abort=()=>{void page.connection.send('Runtime.evaluate',{expression:`window[${JSON.stringify(key)}]?.abort('cancelled')`},page.sid).catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  try{
   signal?.throwIfAborted();
   const r=await abortable(page.connection.send('Runtime.evaluate',{expression:pageApiScript(request,key),awaitPromise:true,returnByValue:true},page.sid),signal);
   if(r.exceptionDetails)throw failure('BROWSER_PAGE','浏览器页面已变化，已保留进度，请检查页面后重试');
   const result=r.result?.value;
   if(result?.error){const messages={timeout:'浏览器读取超时，已保留进度，可稍后续读',cancelled:'读取已停止','page-changed':'浏览器页面已变化，请回到抖音页面后重试','too-large':'响应过大，已停止读取',network:'浏览器未能完成请求，请检查网络和网页状态后重试'};throw failure('BROWSER_REQUEST',messages[result.error]||messages.network);}
   if(!Number.isInteger(result?.status)||typeof result.text!=='string'||result.text.length>8*1024*1024)throw failure('BROWSER_RESPONSE','浏览器返回的数据无效，已停止读取');
   return new Response(result.text,{status:result.status,headers:{'retry-after':String(result.retryAfter||0)}});
  }catch(e){abort();if(signal?.aborted)throw signal.reason;throw e.code?e:failure('BROWSER_CONNECTION','专用浏览器连接中断或页面未响应，已保留读取进度');}
  finally{signal?.removeEventListener('abort',abort);}
 }
}
