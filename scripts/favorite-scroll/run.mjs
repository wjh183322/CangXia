import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {SystemBrowser} from '../../electron/system-browser.mjs';
import {FavoriteRecorder,requestCursor,isFavoriteRequest} from './recorder.mjs';import {installFavoriteScroller} from './page-ui.mjs';

if(Number(process.versions.node.split('.')[0])<24)throw Error('需要 Node.js 24 或更新版本；当前电脑开发环境已具备。');
const desktop=process.env.USERPROFILE?path.join(process.env.USERPROFILE,'Desktop'):path.join(os.homedir(),'Desktop');
const out=process.env.CANGXIA_SCROLL_OUTPUT||path.join(desktop,'收藏网页翻页记录');fs.mkdirSync(out,{recursive:true});
const profile=path.join(process.env.LOCALAPPDATA||os.tmpdir(),'CangXia-FavoriteScroll');fs.mkdirSync(profile,{recursive:true});
const lock=path.join(profile,'runner.lock');let lockHandle;
try{lockHandle=fs.openSync(lock,'wx');fs.writeFileSync(lockHandle,String(process.pid));}
catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(fs.readFileSync(lock,'utf8'));let alive=Number.isSafeInteger(pid)&&pid>0;try{if(alive)process.kill(pid,0);}catch{alive=false;}if(alive)throw Error('翻页脚本已经运行，请使用已经打开的浏览器窗口。');fs.unlinkSync(lock);lockHandle=fs.openSync(lock,'wx');fs.writeFileSync(lockHandle,String(process.pid));}
const browser=new SystemBrowser(profile),requests=new Map();let sid,record=new FavoriteRecorder(),lastState={},closed=false,saveAt=0,sequence=0,reason='等待打开总收藏',outputFile;
function newOutput(){outputFile=path.join(out,`收藏翻页-${new Date().toISOString().replace(/[:.]/g,'-')}-${++sequence}.json`);}newOutput();
function save(message=reason){reason=message;const text=JSON.stringify(record.export(reason,lastState),null,2);fs.writeFileSync(outputFile+'.tmp',text);fs.renameSync(outputFile+'.tmp',outputFile);saveAt=Date.now();}
async function evaluate(expression){if(!browser.connection||!sid)return null;const result=await browser.connection.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sid);if(result.exceptionDetails)return null;return result.result?.value;}
async function pause(message){reason=message;await evaluate(`window.__cangxiaScroll?.pause(${JSON.stringify(message)})`).catch(()=>{});save(message);}
let handling=Promise.resolve();
const route='/aweme/v1/web/aweme/listcollection/';
function networkEvent(method,p,sessionId){
  if(sessionId!==sid||closed)return;
  if(method==='Network.requestWillBeSent'){
    let u;try{u=new URL(p.request.url);}catch{return;}
    if((u.hostname==='douyin.com'||u.hostname.endsWith('.douyin.com'))&&u.pathname.startsWith('/aweme/'))record.endpointPaths.add(u.origin+u.pathname);
    if(!['https://www.douyin.com','https://www-hj.douyin.com'].includes(u.origin)||p.request.method==='OPTIONS')return;
    if(u.pathname==='/aweme/v1/web/collects/video/list/'&&lastState.phase==='running'){void pause('检测到自建收藏夹请求，已暂停。请回到总收藏页面重新开始。');return;}
    if(!isFavoriteRequest(u.href,p.request.method))return;
    if(requests.size>100)requests.delete(requests.keys().next().value);
    const cursor=requestCursor(u.href,p.request.postData);requests.set(p.requestId,{cursor,status:null,hasPostData:p.request.hasPostData});
  }else if(method==='Network.responseReceived'){
    const item=requests.get(p.requestId);if(item)item.status=p.response.status;
  }else if(method==='Network.loadingFailed'){
    if(requests.delete(p.requestId))void pause('收藏页面请求失败，已暂停；请检查网页网络或验证提示。');
  }else if(method==='Network.loadingFinished'){
    const item=requests.get(p.requestId);if(!item)return;requests.delete(p.requestId);
    handling=handling.then(async()=>{
      try{
        if(item.status!==200)throw Error(`收藏页面请求返回 HTTP ${item.status||'未知'}，已暂停，请在网页检查账号状态`);
        if(item.cursor===null&&item.hasPostData){const post=await browser.connection.send('Network.getRequestPostData',{requestId:p.requestId},sid);item.cursor=requestCursor('https://www.douyin.com'+route,post.postData);}
        if(p.encodedDataLength>8*1024*1024)throw Error('收藏响应过大，已暂停');
        const result=await browser.connection.send('Network.getResponseBody',{requestId:p.requestId},sid);
        const text=result.base64Encoded?Buffer.from(result.body,'base64').toString('utf8'):result.body;
        const current=await evaluate('window.__cangxiaScroll?.state()');if(current)lastState=current;
        if(item.cursor==='0'&&record.pages.has('0')&&lastState.phase!=='running'){save('重新加载第一页，上一轮观察结束');record=new FavoriteRecorder();newOutput();}
        const summary=record.accept(item.cursor,text);save('已记录网页正常返回的收藏分页');
        await evaluate(`window.__cangxiaScroll?.update(${JSON.stringify(summary)})`);
        if(summary.cycle)await pause('网页返回重复翻页位置，已暂停，不能据此认定读完。');
        else if(summary.serverEnd)await pause('网页已从第一页连续返回到明确末页；请查看本机翻页记录。');
        else if(summary.apiEndObserved)await pause('已观察到接口末页，但缺少完整从头分页证据；数量仅供参考。');
      }catch(e){record.errors.push({at:new Date().toISOString(),message:e.message});await pause(e.message);}
    }).catch(e=>{console.error('保存观察记录失败：'+e.message);closed=true;});
  }
}
async function finish(){if(closed&& !lockHandle)return;closed=true;try{await handling;save(reason);}catch{}try{await browser.close();}catch{}if(lockHandle!==undefined){fs.closeSync(lockHandle);lockHandle=undefined;try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}}}
process.on('SIGINT',()=>{reason='用户结束脚本';void finish().then(()=>process.exit(0));});process.on('SIGTERM',()=>{reason='脚本终止';void finish().then(()=>process.exit(0));});
try{
  await browser.launch('https://www.douyin.com/user/self');const target=await browser.target();sid=await browser.attach(target.targetId);
  browser.on('event',networkEvent);browser.on('closed',()=>{closed=true;reason='浏览器已关闭；已记录内容保留';});
  await browser.connection.send('Network.enable',{maxTotalBufferSize:16*1024*1024,maxResourceBufferSize:8*1024*1024,maxPostDataSize:65536},sid);
  await browser.connection.send('Page.enable',{},sid);const script=`(${installFavoriteScroller.toString()})();`;
  await browser.connection.send('Page.addScriptToEvaluateOnNewDocument',{source:script},sid);await evaluate(script);
  console.log('已打开独立抖音窗口。登录后打开总收藏，再点击开始自动翻页，工具会自动定位列表。\n记录目录：'+out+'\n关闭浏览器或此窗口即可结束。');
  while(!closed){
    await new Promise(r=>setTimeout(r,750));if(closed)break;
    try{
      await evaluate(script);record.observe(await evaluate('window.__cangxiaScroll?.drainObserved?.()'));await evaluate(`window.__cangxiaScroll?.update(${JSON.stringify(record.summary())})`);
      const current=await evaluate('window.__cangxiaScroll?.tick()');
      if(current){const changed=lastState.phase!==current.phase;lastState=current;if(changed||Date.now()-saveAt>15000)save(current.message);}
      if(lastState.phase==='running'&&os.freemem()<768*1024*1024)await pause('电脑可用内存不足，已暂停并保存观察记录，请关闭其他大型程序后继续。');
      const {targetInfos}=await browser.connection.send('Target.getTargets');if(!targetInfos.some(t=>t.targetId===target.targetId)){reason='翻页标签页已关闭，已记录内容保留';closed=true;}
    }catch{if(browser.connection)await pause('无法连接当前网页，已暂停；请检查浏览器是否仍打开。');else closed=true;}
  }
}catch(e){reason=e.message;console.error(e.message);process.exitCode=1;}
finally{await finish();}
