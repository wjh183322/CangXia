import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';
import {apiRequest,fetchInPage,abortable,BrowserAPI} from '../electron/browser-api.mjs';
import {Collector} from '../electron/account-collector.mjs';import {Store} from '../electron/store.mjs';import {verifyAccountIdentity} from '../electron/account-identity.mjs';
const TOTAL_ROUTE='/aweme/v1/web/aweme/listcollection/';
const raw=id=>({aweme_id:id,desc:'fixture',author:{nickname:'fixture'}});
test('browser API allows only reading routes and their expected methods',()=>{
 assert.equal(apiRequest(TOTAL_ROUTE,{method:'POST',form:{cursor:'30',count:'30'}}).body,'cursor=30&count=30');
 assert.throws(()=>apiRequest('/aweme/v1/web/commit/favorite/',{method:'POST'}));assert.throws(()=>apiRequest(TOTAL_ROUTE));
});
test('browser page POST aborts promptly and never leaks its controller',async()=>{
 const key='fixture',context={window:{},document:{readyState:'complete'},location:{origin:'https://www.douyin.com'},AbortController,TextDecoder,setTimeout,clearTimeout,fetch:(_url,o)=>new Promise((_resolve,reject)=>o.signal.addEventListener('abort',()=>reject(Error('aborted'))))};
 const request={...apiRequest(TOTAL_ROUTE,{method:'POST',form:{cursor:'0',count:'30'}}),key,timeout:30};
 let result=await vm.runInNewContext(`(${fetchInPage.toString()})(${JSON.stringify(request)})`,context);assert.equal(result.error,'timeout');assert.equal(context.window[key],undefined);
 const pending=vm.runInNewContext(`(${fetchInPage.toString()})(${JSON.stringify({...request,timeout:5000})})`,context);context.window[key].abort('cancelled');result=await pending;assert.equal(result.error,'cancelled');assert.equal(context.window[key],undefined);
});
test('aborting a pending browser connection does not wait for its late response',async()=>{const c=new AbortController();let resolve;const pending=abortable(new Promise(r=>{resolve=r;}),c.signal);c.abort();await assert.rejects(pending);resolve(true);});
test('browser API reuses one page and refuses a closed target instead of creating another',async()=>{
 let present=true;const conn={send:async(method)=>method==='Target.getTargets'?{targetInfos:present?[{targetId:'one',type:'page',url:'https://www.douyin.com/user/self'}]:[]}:{result:{value:{origin:'https://www.douyin.com',ready:'complete'}}}};
 const browser={connection:conn,launch:async()=>conn,attach:async()=> 'sid'};const api=new BrowserAPI(browser);const one=await api.prepare();assert.equal(await api.prepare(),one);present=false;await assert.rejects(api.prepare(),e=>e.code==='BROWSER_PAGE_CLOSED');
});
async function setup(t,handler){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-browser-read-'));const store=await Store.open(path.join(root,'library.sqlite'),path.join(root,'media'));
 let cookies=[],uid='123',browserCookies=[{name:'sessionid',value:'SYNTHETIC',domain:'.douyin.com',path:'/'}],direct=0;const calls=[],page={};
 const browser=new EventEmitter();browser.userAgent='Fixture/1';browser.api={prepare:async()=>page,credentials:async()=>browserCookies,request:async(route,options)=>{calls.push({route,options});if(route==='/aweme/v1/web/user/profile/self/')return new Response(JSON.stringify({status_code:0,user:{uid,nickname:'fixture'}}));return handler(route,options);}};browser.close=async()=>{};
 const profile={setUserAgent(){},clearStorageData:async()=>{cookies=[];},cookies:{set:async c=>cookies.push(c),get:async()=>cookies},fetch:async()=>{direct++;throw Error('direct path must not be used');}};
 const c=new Collector(store,()=>{},{profile,browser,vault:{load:()=>null,save(){}},verifyIdentity:verifyAccountIdentity,delay:async()=>{}});await c.ready;await c.applyAuth({source:'chrome',userAgent:'Fixture/1',cookies:browserCookies});
 t.after(async()=>{await c.dispose();store.close();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
 return {c,store,browser,calls,get direct(){return direct;},changeAccount(){uid='456';browserCookies=[{name:'sessionid',value:'ANOTHER_SYNTHETIC',domain:'.douyin.com',path:'/'}];}};
}
test('browser-connected collector reads several pages and preserves exact cursors without direct requests',async t=>{
 const f=await setup(t,async(_route,o)=>{const n=Number(o.form.cursor);return new Response(JSON.stringify({status_code:0,aweme_list:[raw(String(100+n))],has_more:n<60?1:0,cursor:String(n+30)}));});
 await f.c.sync({readAll:true});assert.deepEqual(f.calls.filter(x=>x.route===TOTAL_ROUTE).map(x=>x.options.form.cursor),['0','30','60']);assert.equal(f.store.all('works').length,3);assert.equal(f.direct,0);assert.equal(f.calls.filter(x=>x.route.includes('profile/self')).length,2);
});
test('browser frequency response stops and never falls back to direct requests',async t=>{
 const f=await setup(t,async()=>new Response('',{status:429,headers:{'retry-after':'120'}}));await f.c.sync({readAll:true});assert.equal(f.calls.filter(x=>x.route===TOTAL_ROUTE).length,1);assert.equal(f.direct,0);assert.ok(f.store.getSetting('accessHoldUntil')>Date.now()+110000);
});
test('browser error preserves cursor and resume starts at the failed page',async t=>{
 let fail=true;const f=await setup(t,async(_route,o)=>{if(o.form.cursor==='30'&&fail)throw Error('browser timeout');return new Response(JSON.stringify({status_code:0,aweme_list:[raw(o.form.cursor==='0'?'123':'456')],has_more:o.form.cursor==='0'?1:0,cursor:'30'}));});
 await f.c.sync({readAll:true});assert.equal(f.store.sync.get('__all__').nextCursor,'30');fail=false;await f.c.sync({readAll:true,resume:true});assert.deepEqual(f.calls.filter(x=>x.route===TOTAL_ROUTE).map(x=>x.options.form.cursor),['0','30','30']);assert.equal(f.direct,0);
});
test('account change in dedicated browser is rejected before ingesting more works',async t=>{
 const f=await setup(t,async()=>new Response(JSON.stringify({status_code:0,aweme_list:[raw('1')],has_more:0})));await f.c.sync({readAll:true});f.changeAccount();const before=f.calls.filter(x=>x.route===TOTAL_ROUTE).length;await f.c.sync({readAll:true});assert.equal(f.calls.filter(x=>x.route===TOTAL_ROUTE).length,before);assert.equal(f.store.getSetting('browserAccountKey'),'uid:123');assert.equal(f.store.all('works').length,1);assert.equal(f.c.status.connected,false);
});
test('session changing during a response cannot advance the saved page',async t=>{
 let f;f=await setup(t,async()=>{f.changeAccount();return new Response(JSON.stringify({status_code:0,aweme_list:[raw('999')],has_more:0}));});await f.c.sync({readAll:true});assert.equal(f.store.all('works').length,0);assert.equal(f.store.sync.get('__all__').nextCursor,'0');assert.equal(f.direct,0);
});
test('closing dedicated browser aborts a pending read and retains progress',async t=>{
 let waiting;const ready=new Promise(r=>waiting=r);const f=await setup(t,async(_route,o)=>{waiting();return new Promise((_resolve,reject)=>o.signal.addEventListener('abort',()=>reject(Error('closed')),{once:true}));});const pending=f.c.sync({readAll:true});await ready;f.browser.emit('closed');await pending;assert.equal(f.c.busy,false);assert.equal(f.c.status.connected,false);assert.match(f.c.status.message,/浏览器已关闭/);assert.equal(f.store.sync.get('__all__').nextCursor,'0');
});
