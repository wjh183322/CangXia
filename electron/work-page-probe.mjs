import {setTimeout as delay} from 'node:timers/promises';
import {abortable} from './browser-api.mjs';
import {parsePlatformJSON,parseWork} from './model.mjs';
import {filteredSourceState,detailSourceState,needsPageVerification} from '../shared/source-state.mjs';
import {workPageSnapshot} from './work-page-state.mjs';
const unknown=(reason,kind='unknown')=>({state:'unknown',kind,reason});
const messages={login:'网页要求登录，暂无法确认原作品状态',challenge:'网页要求安全验证，暂无法确认原作品状态',frequency:'网页提示访问频繁，已停止自动复核',network:'网页网络异常，暂无法确认原作品状态',redirect:'网页已跳转，未将其他作品当作核验结果'};
export async function probeWorkPage(browser,id,{signal,timeoutMs=10000,pollMs=200,onDiagnostic=()=>{},useCache=true}={}){
 if(!/^\d{1,30}$/.test(id))throw Error('作品标识无效');
 const budget=Math.min(12000,Math.max(1,timeoutMs)),timeout=AbortSignal.timeout(budget),combined=signal?AbortSignal.any([signal,timeout]):timeout;
 const started=performance.now();let stage='browser-start',outcome,lastPage;
 const done=result=>(outcome=result,result);
 let connection,targetId,sid,listener,missing=false,positive=null,negative=null,blocked=null,cachedEvidence=false;const requests=new Map(),bodies=new Set(),knownRequests=new Set();
 const close=key=>connection.send('Target.closeTarget',{targetId:key}).catch(()=>{});
 try{
  combined.throwIfAborted();await abortable(browser.launch('about:blank'),combined);connection=browser.connection;if(!connection)throw Error('浏览器已关闭');
  stage='target-create';const creating=connection.send('Target.createTarget',{url:'about:blank',hidden:true,background:true});
  void creating.then(value=>{if(combined.aborted&&value.targetId&&!targetId)void close(value.targetId);}).catch(()=>{});
  targetId=(await abortable(creating,combined)).targetId;combined.throwIfAborted();
  stage='target-attach';sid=(await abortable(connection.send('Target.attachToTarget',{targetId,flatten:true}),combined)).sessionId;
  listener=(method,p,sessionId)=>{
   if(sessionId!==sid||combined.aborted)return;
   if(method==='Fetch.requestPaused'){let media=['Media','Image'].includes(p.resourceType);try{const u=new URL(p.request.url);media||=/(^|\.)douyinvod\.com$/.test(u.hostname)||/\.(mp4|m3u8|mpd)(?:$|[?#])/i.test(u.pathname);}catch{}if(media)void connection.send('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'},sid).catch(()=>{});return;}
   const matches=url=>{try{const u=new URL(url);return ['https://www.douyin.com','https://douyin.com'].includes(u.origin)&&u.pathname==='/aweme/v1/web/aweme/detail/'&&u.searchParams.get('aweme_id')===id;}catch{return false;}};
   const workDocument=url=>{try{const u=new URL(url);return ['https://www.douyin.com','https://douyin.com'].includes(u.origin)&&new RegExp('^/(?:video|note)/'+id+'/?$').test(u.pathname);}catch{return false;}};
   const fail=kind=>{blocked=unknown(messages[kind]||'网页详情响应未能确认原作品状态',kind);};
   if(method==='Network.requestWillBeSent'&&(matches(p.request?.url)||p.type==='Document'&&workDocument(p.request?.url))){if(knownRequests.size<32)knownRequests.add(p.requestId);else fail('unknown');}
   if(method==='Network.requestServedFromCache'&&knownRequests.has(p.requestId)){cachedEvidence=true;requests.delete(p.requestId);return;}
   if(method==='Network.responseReceived'&&(matches(p.response?.url)||p.type==='Document'&&workDocument(p.response?.url))&&(p.response.fromDiskCache||p.response.fromPrefetchCache||p.response.fromServiceWorker)){cachedEvidence=true;requests.delete(p.requestId);return;}
   if(method==='Network.requestWillBeSent'&&matches(p.request?.url)){
    if(requests.size>=16)fail('unknown');else requests.set(p.requestId,{readable:false});
   }
   if(method==='Network.responseReceived'&&(requests.has(p.requestId)||matches(p.response?.url))){
    const status=p.response.status;
    if(!matches(p.response.url)){requests.delete(p.requestId);fail('redirect');}
    else if(status!==200){requests.delete(p.requestId);fail(status===429?'frequency':status===401?'login':status===403?'challenge':'network');}
    else if(requests.has(p.requestId)||requests.size<16)requests.set(p.requestId,{readable:true});else fail('unknown');
   }
   if(method==='Network.loadingFailed'&&requests.delete(p.requestId))fail('network');
   if(method==='Network.loadingFinished'&&requests.has(p.requestId)){
    const request=requests.get(p.requestId);requests.delete(p.requestId);
    if(!request.readable||bodies.size>=8){fail('unknown');return;}
    const task=(async()=>{try{
     const value=await abortable(connection.send('Network.getResponseBody',{requestId:p.requestId},sid),combined),text=value.base64Encoded?Buffer.from(value.body,'base64').toString('utf8'):value.body;
     if(typeof text!=='string'||Buffer.byteLength(text)>1024*1024){fail('unknown');return;}
     const data=parsePlatformJSON(text),envelope=data.filter_detail||data.aweme_detail?data:data.data||data,success=v=>v===0||v==='0',message=[data.status_msg,data.message,envelope.status_msg,envelope.message,envelope.filter_detail?.detail_msg,envelope.filter_detail?.notice].filter(v=>typeof v==='string').join(' ');
     if(/登录|login/i.test(message)){fail('login');return;}
     if(/验证码|安全验证|captcha|challenge/i.test(message)){fail('challenge');return;}
     if(/频繁|访问受限|rate.?limit/i.test(message)){fail('frequency');return;}
     if(!success(envelope.status_code??data.status_code)||(data.status_code!==undefined&&!success(data.status_code))){fail('unknown');return;}
     const raw=data.aweme_detail||data.data?.aweme_detail;
     if(raw&&String(raw.aweme_id??raw.awemeId)!==id){fail('unknown');return;}
     if(raw){const state=detailSourceState(raw,id,parseWork(raw));if(state.state==='available')positive={state:'available',kind:'api',workId:id,reason:'对应作品网页返回了作品详情和媒体资源',raw};else if(state.state==='unavailable')negative={...state,kind:'api',workId:id};else fail('unknown');}
     else{const state=filteredSourceState(data,id);if(state)negative={...state,kind:'api',workId:id};else if(!needsPageVerification(data,id))fail('unknown');}
    }catch{fail('unknown');}})();bodies.add(task);void task.finally(()=>bodies.delete(task));
   }
  };
  browser.on('event',listener);stage='page-setup';
  await abortable(connection.send('Emulation.setDeviceMetricsOverride',{width:1000,height:760,deviceScaleFactor:1,mobile:false},sid),combined);
  await abortable(connection.send('Network.enable',{},sid),combined);
  await abortable(connection.send('Network.setCacheDisabled',{cacheDisabled:!useCache},sid),combined);
  await abortable(connection.send('Network.setBypassServiceWorker',{bypass:true},sid),combined);
  await abortable(connection.send('Fetch.enable',{patterns:[{resourceType:'Media'},{resourceType:'Image'},{urlPattern:'*://*.douyinvod.com/*'},{urlPattern:'*.mp4*'},{urlPattern:'*.m3u8*'},{urlPattern:'*.mpd*'}]},sid),combined);
await abortable(connection.send('Page.enable',{},sid),combined);
  stage='navigation';await abortable(connection.send('Page.navigate',{url:'https://www.douyin.com/video/'+id},sid),combined);
  for(;;){
   combined.throwIfAborted();if(browser.connection!==connection)throw Error('浏览器连接已变化');
   if(cachedEvidence){
    if(!useCache)return done({...unknown('网页仍返回缓存中的作品状态，暂无法完成实时核验','cache'),workId:id});
    stage='fresh-retry';browser.removeListener('event',listener);listener=null;
    const closed=await abortable(connection.send('Target.closeTarget',{targetId}),combined);if(closed.success===false)throw Error('临时复核页未能关闭');targetId=null;
    return done(await probeWorkPage(browser,id,{signal:combined,timeoutMs:Math.max(1,Math.floor(budget-(performance.now()-started))),pollMs,useCache:false}));
   }
   stage='page-evaluate';const result=await abortable(connection.send('Runtime.evaluate',{expression:'('+workPageSnapshot.toString()+')('+JSON.stringify(id)+')',returnByValue:true},sid),combined),page=result.result?.value;
   lastPage=page;stage=page?.stage||page?.kind||'page-empty';
   if(result.exceptionDetails)throw Error('页面状态不可读取');
   if(cachedEvidence)continue;
   if(Object.hasOwn(messages,page?.kind))return done({...unknown(messages[page.kind],page.kind),workId:id});
   if(page?.workId===id){if(positive)return done(positive);if(blocked)return done({...blocked,workId:id});if(negative&&requests.size===0&&bodies.size===0)return done(negative);
    if(page.kind==='missing'&&requests.size===0&&bodies.size===0){if(missing)return done({state:'unavailable',kind:'missing',workId:id,reason:'对应作品网页明确提示：你要观看的视频不存在'});missing=true;}else missing=false;
   }
   await delay(Math.max(1,pollMs),undefined,{signal:combined});
  }
 }catch(error){signal?.throwIfAborted();const reason=timeout.aborted?(requests.size||bodies.size?'对应作品详情尚未返回完成，网页复核超时，暂无法确认原作品状态':lastPage?.stage==='document-loading'?'作品网页加载超时，尚未取得可核验的页面状态':lastPage?.stage==='error-not-found'?'网页未出现可确认的作品状态提示，复核超时':stage==='navigation'?'作品网页导航超时，暂无法确认原作品状态':'网页复核超时，暂无法确认原作品状态'):'后台网页未能完成复核，暂无法确认原作品状态';return done({...unknown(reason,timeout.aborted?'timeout':'browser'),workId:id});}
 finally{if(listener)browser.removeListener('event',listener);if(connection&&targetId)await Promise.race([close(targetId),delay(1000,undefined,{ref:false})]);try{onDiagnostic({event:'source-page-verification',method:'page',name:id,elapsedMs:Math.round(performance.now()-started),code:signal?.aborted?'cancelled':outcome?.kind==='timeout'?(requests.size||bodies.size?'detail-pending':lastPage?.stage||stage):outcome?.kind||stage,count:requests.size+bodies.size,reason:String(outcome?.reason||'网页核验已停止').slice(0,180)});}catch{}}
}
