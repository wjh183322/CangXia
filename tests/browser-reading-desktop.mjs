import {app,session} from 'electron';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const root=process.env.CANGXIA_BROWSER_TEST_PROFILE;if(!root)throw Error('isolated runner required');app.setPath('userData',root);app.disableHardwareAcceleration();
const timer=setTimeout(()=>{console.error('browser reading test timeout');app.exit(1);},60000);
void app.whenReady().then(async()=>{
 let browser,collector,store;const checks=[];const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
 const base=process.env.CANGXIA_BROWSER_TEST_PACKAGE?pathToFileURL(path.resolve(process.env.CANGXIA_BROWSER_TEST_PACKAGE)+path.sep):new URL('../electron/',import.meta.url);
 try{
  const [{SystemBrowser},{Collector},{Store},{verifyAccountIdentity}]=await Promise.all(['system-browser.mjs','account-collector.mjs','store.mjs','account-identity.mjs'].map(file=>import(new URL(file,base).href)));
  browser=new SystemBrowser(path.join(root,'browser'),{headless:true});const connection=await browser.launch('about:blank');
  const {targetInfos}=await connection.send('Target.getTargets'),target=targetInfos.find(t=>t.type==='page'),sid=await browser.attach(target.targetId);
  const fixture=()=>{
   window.fixtureCalls=[];window.fixtureTotalPages=3;window.fixtureMode='normal';window.fixtureAbortCount=0;
   window.fetch=async(url,options)=>{
    const u=new URL(url),r=u.pathname;
    if(r.endsWith('/profile/self/'))return new Response(JSON.stringify({status_code:0,user:{uid:'123',nickname:'synthetic'}}));
    if(r==='/aweme/v1/web/collects/list/')return new Response(JSON.stringify({status_code:0,collects_list:[{collects_id:'77',collects_name:'synthetic folder'}],has_more:0}));
    const total=r==='/aweme/v1/web/aweme/listcollection/',cursor=Number(total?new URLSearchParams(options.body).get('cursor'):u.searchParams.get('cursor'));
    window.fixtureCalls.push({route:r,cursor,method:options.method});
    if(total&&cursor===30&&window.fixtureMode==='stall')return new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>{window.fixtureAbortCount++;reject(Error('aborted'));},{once:true});});
    const pages=total?window.fixtureTotalPages:3;
    return new Response(JSON.stringify({status_code:0,aweme_list:[{aweme_id:String((total?10000:20000)+cursor),desc:'synthetic',author:{nickname:'fixture'}}],has_more:cursor/30+1<pages?1:0,cursor:String(cursor+30)}));
   };
  };
  const html='<!doctype html><html><body>仅合成数据，没有真实账号<script>('+fixture.toString()+')()</script></body></html>';
  browser.on('event',(method,p,s)=>{if(s===sid&&method==='Fetch.requestPaused')void connection.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(html).toString('base64')},sid).catch(()=>{});});
  await connection.send('Fetch.enable',{patterns:[{urlPattern:'*'}]},sid);await connection.send('Page.enable',{},sid);await connection.send('Page.navigate',{url:'https://www.douyin.com/user/self'},sid);
  const evaluate=async expression=>(await connection.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sid)).result?.value;
  let end=Date.now()+5000;while(!await evaluate('!!window.fixtureCalls')&&Date.now()<end)await new Promise(r=>setTimeout(r,100));assert.ok(await evaluate('!!window.fixtureCalls'));
  await connection.send('Network.setCookie',{url:'https://www.douyin.com/',name:'sessionid',value:'SYNTHETIC_BROWSER_READING_ONLY',domain:'.douyin.com',path:'/',secure:true},sid);
  const http=session.fromPartition('browser-reading-test');let directCalls=0;http.fetch=async()=>{directCalls++;return new Response('synthetic direct denied',{status:403});};
  store=await Store.open(path.join(root,'library.sqlite'),path.join(root,'media'));collector=new Collector(store,()=>{},{profile:http,browser,vault:{load:()=>null,save(){}},verifyIdentity:verifyAccountIdentity,delay:async()=>{}});await collector.ready;await collector.applyAuth(await browser.credentials());
  check('browser identity verification connects without falling back to rejected direct transport',collector.status.connected&&collector.requestMode==='browser'&&directCalls===0);
  await collector.sync({readAll:true});check('real system browser reads three consecutive total-favorites pages',store.snapshot().members.__all__.join(',')==='10000,10030,10060');
  await collector.sync({discoverOnly:true});store.setAdded(['77']);await collector.sync({collectionId:'77',readAll:true});check('browser transport reads folder directory and paginated custom folder',store.snapshot().members['77'].join(',')==='20000,20030,20060');
  await evaluate('window.fixtureTotalPages=40;window.fixtureCalls=[]');await collector.sync({readAll:true});
  check('forty consecutive pages reuse the same browser target',store.snapshot().members.__all__.length===40&&(await evaluate('window.fixtureCalls.length'))===40&&(await connection.send('Target.getTargets')).targetInfos.filter(t=>t.type==='page').length===targetInfos.filter(t=>t.type==='page').length);
  await evaluate('window.fixtureTotalPages=3;window.fixtureMode="stall";window.fixtureCalls=[]');let pending=collector.sync({readAll:true});
  end=Date.now()+5000;while(!await evaluate('window.fixtureCalls.some(c=>c.cursor===30)')&&Date.now()<end)await new Promise(r=>setTimeout(r,50));assert.ok(await evaluate('window.fixtureCalls.some(c=>c.cursor===30)'));collector.stop();await pending;
  end=Date.now()+3000;while(!await evaluate('window.fixtureAbortCount')&&Date.now()<end)await new Promise(r=>setTimeout(r,50));check('pause aborts the in-page POST and retains its cursor',collector.busy===false&&store.sync.get('__all__').nextCursor==='30'&&(await evaluate('window.fixtureAbortCount'))>0);
  await evaluate('window.fixtureMode="normal"');await collector.sync({readAll:true,resume:true});check('resume requests only the saved remaining pages',JSON.stringify(await evaluate('window.fixtureCalls.map(c=>c.cursor)'))==='[0,30,30,60]');
  await evaluate('window.fixtureMode="stall";window.fixtureCalls=[]');pending=collector.sync({readAll:true});end=Date.now()+5000;while(!await evaluate('window.fixtureCalls.some(c=>c.cursor===30)')&&Date.now()<end)await new Promise(r=>setTimeout(r,50));assert.ok(await evaluate('window.fixtureCalls.some(c=>c.cursor===30)'));await connection.send('Browser.close').catch(()=>{});await pending;
  check('closing real Chrome stops reading and retains the committed page',!collector.busy&&!collector.status.connected&&store.sync.get('__all__').nextCursor==='30');check('no direct API retry occurred during any browser read',directCalls===0);
  fs.writeFileSync('.test-output/browser-reading-desktop-result.json',JSON.stringify({ok:true,checks},null,2));console.log({ok:true,checks});await collector.dispose();store.close();clearTimeout(timer);app.quit();
 }catch(e){console.error(e);await collector?.dispose();await browser?.close();store?.close();fs.writeFileSync('.test-output/browser-reading-desktop-result.json',JSON.stringify({ok:false,checks,error:e.stack},null,2));clearTimeout(timer);app.exit(1);}
});
