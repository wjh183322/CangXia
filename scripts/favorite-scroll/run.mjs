import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {SystemBrowser} from '../../electron/system-browser.mjs';
import {ResponseCapture} from './response-capture.mjs';
import {ScrollStability} from './stability.mjs';
import {FavoriteRecorder,requestCursor,isFavoriteRequest} from './recorder.mjs';import {installFavoriteScroller} from './page-ui.mjs';

if(Number(process.versions.node.split('.')[0])<24)throw Error('需要 Node.js 24 或更新版本；当前电脑开发环境已具备。');
const desktop=process.env.USERPROFILE?path.join(process.env.USERPROFILE,'Desktop'):path.join(os.homedir(),'Desktop');
const out=process.env.CANGXIA_SCROLL_OUTPUT||path.join(desktop,'收藏网页翻页记录');fs.mkdirSync(out,{recursive:true});
const profile=path.join(process.env.LOCALAPPDATA||os.tmpdir(),'CangXia-FavoriteScroll');fs.mkdirSync(profile,{recursive:true});
const lock=path.join(profile,'runner.lock');let lockHandle;
try{lockHandle=fs.openSync(lock,'wx');fs.writeFileSync(lockHandle,String(process.pid));}
catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(fs.readFileSync(lock,'utf8'));let alive=Number.isSafeInteger(pid)&&pid>0;try{if(alive)process.kill(pid,0);}catch{alive=false;}if(alive)throw Error('翻页脚本已经运行，请使用已经打开的浏览器窗口。');fs.unlinkSync(lock);lockHandle=fs.openSync(lock,'wx');fs.writeFileSync(lockHandle,String(process.pid));}
const browser=new SystemBrowser(profile),requests=new Map(),health=new ScrollStability();let ownedTargetId,lightMode=false,lastSample=0;let sid,record=new FavoriteRecorder(),lastState={},closed=false,saveAt=0,sequence=0,reason='等待打开总收藏',outputFile;
function newOutput(){outputFile=path.join(out,`收藏翻页-${new Date().toISOString().replace(/[:.]/g,'-')}-${++sequence}.json`);}newOutput();
function save(message=reason){reason=message;const text=JSON.stringify({...record.export(reason,lastState),stability:{crashed:health.crashed,crashes:health.crashes,samples:health.samples},lightweight:lightMode},null,2);fs.writeFileSync(outputFile+'.tmp',text);fs.renameSync(outputFile+'.tmp',outputFile);saveAt=Date.now();}
async function evaluate(expression){if(!browser.connection||!sid||health.crashed)return null;const result=await browser.connection.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sid);if(result.exceptionDetails)return null;return result.result?.value;}
async function pause(message){reason=message;await evaluate(`window.__cangxiaScroll?.pause(${JSON.stringify(message)})`).catch(()=>{});save(message);}
const capture=new ResponseCapture((method,params)=>{const connection=browser.connection;return connection?connection.send(method,params,sid):Promise.reject(Error('浏览器已关闭，已记录内容保留'));});
let handling=Promise.resolve();
function markCrash(details){if(health.crashed)return;const event=health.crash(details);requests.clear();capture.clear();lastState={...lastState,phase:'crashed'};record.errors.push({...event,message:'网页渲染进程崩溃，读取未完成，已有记录保留'});save('网页渲染进程崩溃，已停止读取；可在浏览器手动重新加载，旧记录保留');console.error('网页渲染进程崩溃；已保存观察记录，未自动重新加载。');}
async function setLightMode(enabled){if(lightMode===enabled||!browser.connection)return;if(enabled)await browser.connection.send('Fetch.enable',{patterns:[{resourceType:'Image',requestStage:'Request'},{resourceType:'Media',requestStage:'Request'}]},sid);else await browser.connection.send('Fetch.disable',{},sid);lightMode=enabled;}

const route='/aweme/v1/web/aweme/listcollection/';
function networkEvent(method,p,sessionId){
  if(closed)return;
  if(method==='Target.targetCrashed'&&p.targetId===ownedTargetId){markCrash(p);return;}
  if(sessionId!==sid)return;
  if(method==='Inspector.targetCrashed'){markCrash(p);return;}
  if(method==='Fetch.requestPaused'){const connection=browser.connection;if(connection)void connection.send(lightMode?'Fetch.failRequest':'Fetch.continueRequest',{requestId:p.requestId,...(lightMode?{errorReason:'BlockedByClient'}:{})},sid).catch(()=>{});return;}
  if(method==='Page.frameNavigated'&&!p.frame.parentId&&p.frame.url?.startsWith('https://www.douyin.com/')){health.navigate();requests.clear();capture.clear();lastState={};void setLightMode(false).catch(()=>{});return;}
  if(health.crashed)return;
  if(method==='Network.requestWillBeSent'){
    let u;try{u=new URL(p.request.url);}catch{return;}
    if((u.hostname==='douyin.com'||u.hostname.endsWith('.douyin.com'))&&u.pathname.startsWith('/aweme/'))record.endpointPaths.add(u.origin+u.pathname);
    if(!['https://www.douyin.com','https://www-hj.douyin.com'].includes(u.origin)||p.request.method==='OPTIONS')return;
    if(u.pathname==='/aweme/v1/web/collects/video/list/'&&lastState.phase==='running'){void pause('检测到自建收藏夹请求，已暂停。请回到总收藏页面重新开始。');return;}
    if(!isFavoriteRequest(u.href,p.request.method))return;
    if(requests.size>=40){void pause('网页请求积压，已暂停以保留观察记录');return;}
    const cursor=requestCursor(u.href,p.request.postData);requests.set(p.requestId,{cursor,status:null,hasPostData:p.request.hasPostData,epoch:health.epoch});
  }else if(method==='Network.responseReceived'){
    const item=requests.get(p.requestId);if(item){item.status=p.response.status;if(item.status===200)try{capture.start(p.requestId);}catch(e){void pause(e.message);}}
  }else if(method==='Network.dataReceived'){
    capture.data(p.requestId,p.data);
  }else if(method==='Network.loadingFailed'){
    capture.discard(p.requestId);if(requests.delete(p.requestId))void pause('收藏页面请求失败，已暂停；请检查网页网络或验证提示。');
  }else if(method==='Network.loadingFinished'){
    const item=requests.get(p.requestId);if(!item)return;requests.delete(p.requestId);
    const captured=capture.finish(p.requestId);
    handling=handling.then(async()=>{
      if(health.crashed||item.epoch!==health.epoch)return;
      try{
        if(item.status!==200)throw Error(`收藏页面请求返回 HTTP ${item.status||'未知'}，已暂停，请在网页检查账号状态`);
        if(item.cursor===null&&item.hasPostData){const connection=browser.connection;if(!connection)throw Error('浏览器已关闭，已记录内容保留');const post=await connection.send('Network.getRequestPostData',{requestId:p.requestId},sid);item.cursor=requestCursor('https://www.douyin.com'+route,post.postData);}
        if(p.encodedDataLength>8*1024*1024)throw Error('收藏响应过大，已暂停');
        const result=await captured;if(health.crashed||item.epoch!==health.epoch)return;if(result.error)throw result.error;
        const text=result.text;
        // Use the polling snapshot; never wait for renderer UI before saving a page.
        if(item.cursor==='0'&&record.pages.has('0')&&lastState.phase!=='running'){save('重新加载第一页，上一轮观察结束');record=new FavoriteRecorder();newOutput();}
        const summary=record.accept(item.cursor,text);save('已记录网页正常返回的收藏分页');
        // The regular UI heartbeat publishes the summary.
        if(summary.cycle)await pause('网页返回重复翻页位置，已暂停，不能据此认定读完。');
        else if(summary.serverEnd)await pause('网页已从第一页连续返回到明确末页；请查看本机翻页记录。');
        else if(summary.apiEndObserved)await pause('已观察到接口末页，但缺少完整从头分页证据；数量仅供参考。');
      }catch(e){if(health.crashed||item.epoch!==health.epoch)return;const message=/evicted|inspector cache|No resource with given identifier/i.test(e.message)?'本次有一页未能核实，已保留已有记录并暂停；不能据此认定读全。':e.message;record.errors.push({at:new Date().toISOString(),cursor:item.cursor,message});await pause(message);}
    }).catch(e=>{console.error('保存观察记录失败：'+e.message);closed=true;});
  }
}
async function finish(){if(closed&& !lockHandle)return;closed=true;try{await handling;save(reason);}catch{}try{await browser.close();}catch{}if(lockHandle!==undefined){fs.closeSync(lockHandle);lockHandle=undefined;try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}}}
process.on('SIGINT',()=>{reason='用户结束脚本';void finish().then(()=>process.exit(0));});process.on('SIGTERM',()=>{reason='脚本终止';void finish().then(()=>process.exit(0));});
try{
  await browser.launch('https://www.douyin.com/user/self');const target=await browser.target();
  ownedTargetId=target.targetId;sid=await browser.attach(target.targetId);
  browser.on('event',networkEvent);browser.on('closed',()=>{closed=true;reason=health.crashed?'网页崩溃后浏览器已关闭，已有记录保留':'浏览器已关闭；已记录内容保留';});
  await browser.connection.send('Network.enable',{maxTotalBufferSize:64*1024*1024,maxResourceBufferSize:8*1024*1024,maxPostDataSize:65536},sid);
  await browser.connection.send('Target.setDiscoverTargets',{discover:true});await browser.connection.send('Inspector.enable',{},sid);await browser.connection.send('Page.enable',{},sid);await evaluate("window.__cangxiaScroll?.pause('正在更新翻页工具');document.getElementById('cangxia-favorite-scroll')?.remove();delete window.__cangxiaScroll;");const script=`(${installFavoriteScroller.toString()})();`;
  await browser.connection.send('Page.addScriptToEvaluateOnNewDocument',{source:script},sid);await evaluate(script);
  console.log('已打开独立抖音窗口。登录后打开总收藏，再点击开始自动翻页，工具会自动定位列表。\n记录目录：'+out+'\n关闭浏览器或此窗口即可结束。');
  while(!closed){
    await new Promise(r=>setTimeout(r,750));if(closed)break;
    try{
      if(health.crashed){const {targetInfos}=await browser.connection.send('Target.getTargets');if(!targetInfos.some(t=>t.targetId===ownedTargetId))closed=true;continue;}
      const result=await evaluate(`(()=>{const api=window.__cangxiaScroll;if(!api)return null;api.update(${JSON.stringify(record.summary())});const state=api.tick();return {state,observed:api.drainObserved()};})()`);
      if(!result){await evaluate(script);continue;}
      record.observe(result.observed);const current=result.state;
      await setLightMode(current.phase==='running'&&current.lightweight!==false);
      if(current){const changed=lastState.phase!==current.phase;lastState=current;if(changed||Date.now()-saveAt>15000)save(current.message);}
      if(lastState.phase==='running'&&os.freemem()<768*1024*1024)await pause('电脑可用内存不足，已暂停并保存观察记录，请关闭其他大型程序后继续。');
      if(Date.now()-lastSample>15000){lastSample=Date.now();try{const connection=browser.connection;const [heap,dom]=await Promise.all([connection.send('Runtime.getHeapUsage',{},sid),connection.send('Memory.getDOMCounters',{},sid)]);if(!health.crashed){const sample=health.sample({...heap,...dom,freeBytes:os.freemem(),rssBytes:process.memoryUsage().rss,works:record.works.size});if(current.phase==='running'&&sample.heapMiB>1024)await pause('网页脚本内存占用较高，已暂停以保护记录。当前结果尚未读全。');}}catch{if(!health.crashed)console.error('暂未取得网页资源统计。');}}
      const {targetInfos}=await browser.connection.send('Target.getTargets');if(!targetInfos.some(t=>t.targetId===target.targetId)){reason='翻页标签页已关闭，已记录内容保留';closed=true;}
    }catch{if(health.crashed)continue;if(browser.connection)await pause('无法连接当前网页，已暂停；请检查浏览器是否仍打开。');else closed=true;}
  }
}catch(e){reason=e.message;console.error(e.message);process.exitCode=1;}
finally{await finish();}
