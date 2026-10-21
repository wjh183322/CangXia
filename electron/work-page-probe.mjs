import {setTimeout as delay} from 'node:timers/promises';
import {abortable} from './browser-api.mjs';
import {parsePlatformJSON,parseWork} from './model.mjs';
import {filteredSourceState,detailSourceState} from '../shared/source-state.mjs';
import {workPageSnapshot} from './work-page-state.mjs';
const unknown=(reason,kind='unknown')=>({state:'unknown',kind,reason});
const messages={login:'网页要求登录，暂无法确认原作品状态',challenge:'网页要求安全验证，暂无法确认原作品状态',frequency:'网页提示访问频繁，已停止自动复核',network:'网页网络异常，暂无法确认原作品状态',redirect:'网页已跳转，未将其他作品当作核验结果'};
export async function probeWorkPage(browser,id,{signal,timeoutMs=10000,pollMs=200}={}){
 if(!/^\d{1,30}$/.test(id))throw Error('作品标识无效');
 const timeout=AbortSignal.timeout(Math.min(12000,Math.max(1,timeoutMs))),combined=signal?AbortSignal.any([signal,timeout]):timeout;
 let connection,targetId,sid,listener,missing=false,positive=null,negative=null;const requests=new Map(),bodies=new Set();
 const close=key=>connection.send('Target.closeTarget',{targetId:key}).catch(()=>{});
 try{
  combined.throwIfAborted();await abortable(browser.launch('about:blank'),combined);connection=browser.connection;if(!connection)throw Error('浏览器已关闭');
  const creating=connection.send('Target.createTarget',{url:'about:blank',hidden:true,background:true});
  void creating.then(value=>{if(combined.aborted&&value.targetId&&!targetId)void close(value.targetId);}).catch(()=>{});
  targetId=(await abortable(creating,combined)).targetId;combined.throwIfAborted();
  sid=(await abortable(connection.send('Target.attachToTarget',{targetId,flatten:true}),combined)).sessionId;
  listener=(method,p,sessionId)=>{
   if(sessionId!==sid||combined.aborted)return;
   if(method==='Fetch.requestPaused'){let media=['Media','Image'].includes(p.resourceType);try{const u=new URL(p.request.url);media||=/(^|\.)douyinvod\.com$/.test(u.hostname)||/\.(mp4|m3u8|mpd)(?:$|[?#])/i.test(u.pathname);}catch{}if(media)void connection.send('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'},sid).catch(()=>{});return;}
   if(method==='Network.responseReceived')try{const u=new URL(p.response.url);if(p.response.status===200&&u.origin==='https://www.douyin.com'&&u.pathname==='/aweme/v1/web/aweme/detail/'&&u.searchParams.get('aweme_id')===id&&requests.size<16)requests.set(p.requestId,true);}catch{}
   if(method==='Network.loadingFailed')requests.delete(p.requestId);
   if(method==='Network.loadingFinished'&&requests.delete(p.requestId)&&bodies.size<8){
    const task=(async()=>{try{const value=await abortable(connection.send('Network.getResponseBody',{requestId:p.requestId},sid),combined),text=value.base64Encoded?Buffer.from(value.body,'base64').toString('utf8'):value.body;if(typeof text!=='string'||Buffer.byteLength(text)>1024*1024)return;const data=parsePlatformJSON(text),envelope=data.filter_detail||data.aweme_detail?data:data.data||data,success=v=>v===0||v==='0';if(!success(envelope.status_code??data.status_code)||(data.status_code!==undefined&&!success(data.status_code))||/登录|验证码|安全验证|频繁|访问受限|captcha|login|challenge|rate.?limit/i.test(String(data.status_msg||data.message||envelope.status_msg||envelope.message||'')))return;const raw=data.aweme_detail||data.data?.aweme_detail;if(raw&&String(raw.aweme_id??raw.awemeId)!==id)return;
     if(raw){const state=detailSourceState(raw,id,parseWork(raw));if(state.state==='available')positive={state:'available',kind:'api',workId:id,reason:'对应作品网页返回了作品详情和媒体资源',raw};else if(state.state==='unavailable')negative={...state,kind:'api',workId:id};}
     else{const state=filteredSourceState(data,id);if(state)negative={...state,kind:'api',workId:id};}
    }catch{}})();bodies.add(task);void task.finally(()=>bodies.delete(task));
   }
  };
  browser.on('event',listener);
  await abortable(connection.send('Emulation.setDeviceMetricsOverride',{width:1000,height:760,deviceScaleFactor:1,mobile:false},sid),combined);
  await abortable(connection.send('Network.enable',{},sid),combined);
  await abortable(connection.send('Network.setCacheDisabled',{cacheDisabled:true},sid),combined);
  await abortable(connection.send('Network.setBypassServiceWorker',{bypass:true},sid),combined);
  await abortable(connection.send('Fetch.enable',{patterns:[{resourceType:'Media'},{resourceType:'Image'},{urlPattern:'*://*.douyinvod.com/*'},{urlPattern:'*.mp4*'},{urlPattern:'*.m3u8*'},{urlPattern:'*.mpd*'}]},sid),combined);
await abortable(connection.send('Page.enable',{},sid),combined);
  await abortable(connection.send('Page.navigate',{url:'https://www.douyin.com/video/'+id},sid),combined);
  for(;;){
   combined.throwIfAborted();if(browser.connection!==connection)throw Error('浏览器连接已变化');
   const result=await abortable(connection.send('Runtime.evaluate',{expression:'('+workPageSnapshot.toString()+')('+JSON.stringify(id)+')',returnByValue:true},sid),combined),page=result.result?.value;
   if(result.exceptionDetails)throw Error('页面状态不可读取');
   if(Object.hasOwn(messages,page?.kind))return {...unknown(messages[page.kind],page.kind),workId:id};
   if(page?.workId===id){if(positive)return positive;if(negative)return negative;
    if(page.kind==='missing'&&bodies.size===0){if(missing)return {state:'unavailable',kind:'missing',workId:id,reason:'对应作品网页明确提示：你要观看的视频不存在'};missing=true;}else missing=false;
   }
   await delay(Math.max(1,pollMs),undefined,{signal:combined});
  }
 }catch(error){signal?.throwIfAborted();return {...unknown(timeout.aborted?'网页复核超时，暂无法确认原作品状态':'后台网页未能完成复核，暂无法确认原作品状态',timeout.aborted?'timeout':'browser'),workId:id};}
 finally{if(listener)browser.removeListener('event',listener);if(connection&&targetId)await Promise.race([close(targetId),delay(1000,undefined,{ref:false})]);}
}
