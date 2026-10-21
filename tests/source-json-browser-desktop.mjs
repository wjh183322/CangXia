import {app,session} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=process.env.CANGXIA_SOURCE_TEST_PROFILE;if(!root)throw Error('isolated profile required');app.setPath('userData',root);app.disableHardwareAcceleration();
const timer=setTimeout(()=>{console.error('source JSON browser timeout');app.exit(1);},90000);
void app.whenReady().then(async()=>{
 let browser,collector,store;const checks=[],check=(name,value)=>{assert.ok(value,name);checks.push(name);};
 const id='7682371267983207909',noteId='7698014329241074098',privacyId='7689049403798024377';
 const raw=key=>({aweme_id:key,aweme_type:key===noteId?68:0,desc:'synthetic JSON evidence',...(key===noteId?{images:[{url_list:['https://p3.douyinpic.com/owned.jpg']}]}:{video:{play_addr:{url_list:['https://v3-web.douyinvod.com/owned.mp4']}}})});
 const empty=key=>({status_code:0,aweme_detail:null,filter_detail:{aweme_id:key,filter_reason:''}});
 const base=process.env.CANGXIA_SOURCE_TEST_PACKAGE?pathToFileURL(path.resolve(process.env.CANGXIA_SOURCE_TEST_PACKAGE)+path.sep):new URL('../electron/',import.meta.url);
 try{
  const [{SystemBrowser},{Collector},{Store},{DownloadQueue},{verifyAccountIdentity}]=await Promise.all(['system-browser.mjs','account-collector.mjs','store.mjs','downloads.mjs','account-identity.mjs'].map(file=>import(new URL(file,base).href)));
  browser=new SystemBrowser(path.join(root,'browser'),{background:true});await browser.launch('about:blank');
  const connection=browser.connection,send=connection.send.bind(connection),reader=browser.readerTarget,readerSid=await browser.attach(reader);
  let mode='empty',created=0,workDocuments=0,mediaRequests=0,stall,detailCalls=0;
  connection.send=async(method,params={},sid)=>{const result=await send(method,params,sid);if(method==='Target.createTarget')created++;return result;};
  browser.on('event',(method,p,sid)=>{
   if(method!=='Fetch.requestPaused'||sid!==readerSid)return;
   void(async()=>{
    const url=new URL(p.request.url);let body='{}',type='application/json',status=200;
    if(['Image','Media'].includes(p.resourceType)){mediaRequests++;await send('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'},sid);return;}
    if(p.resourceType==='Document'){
     if(/^\/(?:video|note)\//.test(url.pathname))workDocuments++;
     type='text/html; charset=utf-8';body='<!doctype html><html><body>owned synthetic account page</body></html>';
    }else if(url.pathname.endsWith('/profile/self/'))body=JSON.stringify({status_code:0,user:{uid:'7',nickname:'synthetic'}});
    else if(url.pathname.endsWith('/aweme/detail/')){
     detailCalls++;const key=url.searchParams.get('aweme_id');
     if(mode==='stall'){stall?.();return;}
     if(mode==='network'){await send('Fetch.failRequest',{requestId:p.requestId,errorReason:'ConnectionReset'},sid);return;}
     if(mode==='changed')await send('Network.setCookie',{url:'https://www.douyin.com/',domain:'.douyin.com',path:'/',name:'sessionid',value:'CHANGED-SYNTHETIC-SESSION',secure:true},sid);
     status=mode==='rate'?429:mode==='http'?503:200;
     body=mode==='malformed'?'not-json':JSON.stringify(mode==='available'?{status_code:0,aweme_detail:raw(key)}:mode==='bare'?{status_code:0,aweme_detail:null}:mode==='mismatch'?empty(noteId):mode==='conflicting-message'?{...empty(key),status_msg:'success',message:'请登录后查看'}:mode==='inner-error'?{...empty(key),data:{status_code:8}}:mode==='warning'?{...empty(key),filter_detail:{...empty(key).filter_detail,notice:'请先登录'}}:mode==='privacy'?{status_code:0,aweme_detail:null,filter_detail:{aweme_id:key,filter_reason:'author_secret',detail_msg:'由于对方隐私设置，无法查看，去看看其他作品吧',notice:'作品暂时无法查看'}}:empty(key));
    }
    await send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:type}],body:Buffer.from(body).toString('base64')},sid);
   })().catch(()=>{});
  });
  await send('Fetch.enable',{patterns:[{urlPattern:'*'}]},readerSid);
  store=await Store.open(path.join(root,'library.sqlite'),path.join(root,'media'));
  for(const key of [id,noteId,privacyId])store.upsertWork(raw(key));store.ingestMembers('__all__',[id,noteId,privacyId],true);
  collector=new Collector(store,()=>{},{profile:session.fromPartition('source-json-owned'),browser,vault:{load:()=>null,save(){},clear(){}},verifyIdentity:verifyAccountIdentity});await collector.ready;
  const connect=()=>collector.applyAuth({source:'popup',userAgent:'Synthetic JSON verification',cookies:[{name:'sessionid',value:'OWNED-SYNTHETIC-NO-REAL-LOGIN',domain:'.douyin.com',path:'/',secure:true,expirationDate:Date.now()/1000+3600}]});
  await connect();const queue=new DownloadQueue(store,collector,null,()=>{});queue.jobs=[{id,state:'failed',source:'douyin'},{id:noteId,state:'failed',source:'douyin'}];queue.emit(true);
  const before=detailCalls;let result=await collector.verifySource(id);
  check('matching empty JSON retires a work in one detail request',result.state==='unavailable'&&result.method==='api'&&detailCalls===before+1);
  check('only that failed task is retired and its reading record remains',queue.jobs.find(j=>j.id===id).state==='unavailable'&&queue.jobs.find(j=>j.id===noteId).state==='failed'&&store.hasRead(id));
  mode='privacy';result=await collector.verifySource(privacyId);check('privacy JSON is current inaccessibility',result.state==='unavailable'&&result.method==='api'&&result.reason.includes('隐私'));
  mode='available';result=await collector.verifySource(id);check('positive video JSON restores availability',result.state==='available'&&store.work(id).remoteState==='available');
  collector.markUnavailable(noteId,{method:'api'});result=await collector.verifySource(noteId);check('positive note JSON restores availability with its images',result.state==='available'&&store.work(noteId).images.length===1);
  check('restoring availability does not restart either failed task',queue.jobs.every(j=>j.state==='failed')&&!queue.running);
  for(const value of ['bare','mismatch','warning','conflicting-message','inner-error','network','http']){
   mode=value;result=await collector.verifySource(id);check(value+' response stays unknown using only JSON',result.state==='unknown'&&result.method==='api');
  }
  mode='changed';result=await collector.verifySource(id);check('a changed session during the JSON request cannot mark a work unavailable',result.state==='unknown'&&store.work(id).remoteState!=='unavailable');
  await connect();mode='malformed';result=await collector.verifySource(id);check('malformed response stays unknown and asks for login verification',result.state==='unknown'&&collector.status.needsLogin);
  await connect();mode='rate';result=await collector.verifySource(id);check('HTTP rate limiting stays unknown and pauses further requests',result.state==='unknown'&&Number(store.getSetting('accessHoldUntil'))>Date.now());store.setSetting('accessHoldUntil',0);
  mode='stall';let started;const ready=new Promise(resolve=>started=resolve);stall=started;const controller=new AbortController(),pending=collector.verifySource(id,{signal:controller.signal});
  await ready;controller.abort();await assert.rejects(pending);check('stop cancels the JSON request and clears its waiter',collector.waiters.size===0&&store.work(id).remoteState!=='unavailable');
  check('all source checks create no new browser target or work document',created===0&&workDocuments===0);
  check('source checks request no image or video payload',mediaRequests===0);
  check('removed webpage verification has no browser entry point',typeof browser.verifyWorkPage==='undefined');
  const targets=(await send('Target.getTargets')).targetInfos;check('the original account reader is retained',targets.some(t=>t.targetId===reader)&&browser.readerTarget===reader);
  fs.writeFileSync('.test-output/source-json-browser-result.json',JSON.stringify({ok:true,packaged:!!process.env.CANGXIA_SOURCE_TEST_PACKAGE,checks},null,2));console.log({ok:true,checks});
  await collector.dispose();await store.fileStates.close();store.close();clearTimeout(timer);app.quit();
 }catch(error){
  console.error(error);await collector?.dispose().catch(()=>{});await browser?.close().catch(()=>{});await store?.fileStates.close();store?.close();
  fs.writeFileSync('.test-output/source-json-browser-result.json',JSON.stringify({ok:false,checks,error:error.stack},null,2));clearTimeout(timer);app.exit(1);
 }
});
