import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { QrLogin } from '../electron/qr-login.mjs';
import { qrPageScript, validQrRect, webUserAgent } from '../electron/qr-page.mjs';

function controller({cookieRead=async()=>[],authenticated=async()=>{}}={}){
  const actions=[];let created=0;
  const window=new EventEmitter();window.isDestroyed=()=>false;window.hide=()=>actions.push('hide');window.close=()=>actions.push('close');window.setTitle=()=>{};
  window.loadURL=async()=>{actions.push('load');};window.webContents={setUserAgent:()=>{},setWindowOpenHandler:()=>{},on:()=>{}};
  const qr=new QrLogin({profile:{cookies:{get:cookieRead}},chromiumVersion:'150.0.1.2',onChange:()=>{},onAuthenticated:authenticated,createWindow:()=>{created++;return window;}});qr.watch=async()=>{};
  return {qr,actions,get created(){return created;}};
}
test('web mode uses the actual Chromium version without inventing another engine',()=>{
  const ua=webUserAgent('150.0.1.2');assert.match(ua,/Chrome\/150\.0\.1\.2/);assert.ok(!ua.includes('Electron'));assert.throws(()=>webUserAgent('broken\nvalue'));
});
test('QR capture rectangles must stay inside the owned page viewport',()=>{
  assert.equal(validQrRect({x:20,y:30,width:220,height:220},{width:600,height:700}),true);
  assert.equal(validQrRect({x:590,y:30,width:220,height:220},{width:600,height:700}),false);
  assert.equal(validQrRect({x:NaN,y:30,width:220,height:220},{width:600,height:700}),false);
});
test('opening the login popup twice does not create two login pages',async()=>{
  const c=controller();await Promise.all([c.qr.start(),c.qr.start()]);assert.equal(c.created,1);assert.equal(c.actions.filter(x=>x==='load').length,1);assert.ok(c.actions.includes('hide'));c.qr.cancel();
});
test('cancel before cookie readiness prevents loading any login page',async()=>{
  let resolve;const pending=new Promise(r=>{resolve=r;});const c=controller({cookieRead:()=>pending});const start=c.qr.start();c.qr.cancel();resolve([]);await start;assert.equal(c.created,0);assert.equal(c.qr.state().image,null);
});
test('successful login invokes connection and closes the hidden page automatically',async()=>{
  let received;const c=controller({authenticated:async auth=>{received=auth;}});await c.qr.start();await c.qr.complete([{name:'sessionid',value:'TEST_ONLY'}],c.qr.generation);assert.equal(received.source,'popup');assert.equal(c.qr.state().phase,'success');assert.equal(c.qr.active,false);assert.ok(c.actions.includes('close'));
});
test('connection validation failure is shown instead of looping indefinitely',async()=>{
  const c=controller({authenticated:async()=>{throw new Error('会话验证失败');}});await c.qr.start();await c.qr.complete([{name:'sessionid',value:'TEST_ONLY'}],c.qr.generation);assert.equal(c.qr.state().phase,'error');assert.equal(c.qr.state().message,'会话验证失败');assert.equal(c.qr.active,false);c.qr.cancel();
});
test('account mismatch clears only the rejected popup session so a fresh QR can be requested',async()=>{
 let cleared=0;const c=controller({cookieRead:async()=>cleared?[]:[{name:'sessionid',value:'TEST_ONLY'}],authenticated:async()=>{throw Object.assign(new Error('different account'),{code:'ACCOUNT_MISMATCH'});}});c.qr.profile.clearStorageData=async options=>{assert.deepEqual(options,{storages:['cookies']});cleared++;};await c.qr.start();assert.equal(c.qr.state().phase,'error');assert.equal(cleared,1);await c.qr.refresh();assert.equal(c.created,1);assert.equal(c.qr.state().phase,'loading');c.qr.cancel();
});
test('cancel during account verification aborts the verification and does not reopen an error dialog',async()=>{
 let signal,release;const gate=new Promise(r=>{release=r;});const c=controller({cookieRead:async()=>[{name:'sessionid',value:'TEST_ONLY'}],authenticated:async(_auth,options)=>{signal=options.signal;await gate;signal.throwIfAborted();}});const pending=c.qr.start();await new Promise(r=>setImmediate(r));assert.equal(c.qr.state().phase,'verifying');c.qr.cancel();release();await pending;assert.equal(signal.aborted,true);assert.equal(c.qr.state().phase,'idle');
});
test('page frequency warning prevents any click even during manual refresh',()=>{
  const result=vm.runInNewContext(qrPageScript({refresh:true}),{document:{body:{innerText:'访问太频繁，请稍后再试'}}});assert.equal(result.phase,'limited');
});
test('page extraction selects a square QR image rather than a portrait poster',()=>{
  const element=(width,height,alt)=>({children:[],id:'',parentElement:null,getBoundingClientRect:()=>({x:100,y:100,width,height,top:100,bottom:100+height}),getAttribute:name=>name==='alt'?alt:''});
  const qr=element(220,220,'登录二维码'),poster=element(220,300,'');
  const context={document:{body:{innerText:'扫码登录'},querySelectorAll:()=>[poster,qr]},innerHeight:800,getComputedStyle:()=>({visibility:'visible'})};
  const result=vm.runInNewContext(qrPageScript(),context);assert.equal(result.phase,'ready');assert.equal(result.rect.width,220);assert.equal(result.rect.height,220);
  context.document.body.innerText='二维码已过期';assert.equal(vm.runInNewContext(qrPageScript(),context).phase,'expired');
});
test('login assistance activates the real button instead of an outer text wrapper',()=>{
  let clicked='';const node=(tag,children)=>({tagName:tag,children,textContent:'登录',innerText:'登录',getAttribute:()=>'',getBoundingClientRect:()=>({width:80,height:30,top:20,bottom:50}),click:()=>{clicked=tag;}});
  const wrapper=node('DIV',[{}]),button=node('BUTTON',[]);
  const context={document:{body:{innerText:'登录'},querySelectorAll:s=>s==='img,canvas,svg'?[]:[wrapper,button]},innerHeight:800,getComputedStyle:()=>({visibility:'visible'})};
  assert.equal(vm.runInNewContext(qrPageScript({openLogin:true}),context).phase,'loading');assert.equal(clicked,'BUTTON');
});
test('opaque QR image classes are recognized by the nearby scan instructions',()=>{
  const panel={className:'opaque-panel',innerText:'如何扫码 打开抖音APP 扫一扫',parentElement:null,getBoundingClientRect:()=>({width:726,height:480})};
  const qr={tagName:'IMG',children:[],id:'',parentElement:panel,currentSrc:'data:image/png;base64,TEST_ONLY',getBoundingClientRect:()=>({x:100,y:100,width:178,height:178,top:100,bottom:278}),getAttribute:()=>''};
  const context={document:{body:{innerText:'扫码登录'},querySelectorAll:()=>[qr]},innerHeight:800,getComputedStyle:()=>({visibility:'visible'})};
  const result=vm.runInNewContext(qrPageScript(),context);assert.equal(result.phase,'ready');assert.equal(result.image,'data:image/png;base64,TEST_ONLY');
});
test('inline QR images are relayed without screenshots or additional network requests',async()=>{
  const c=controller();const data='data:image/png;base64,TEST_ONLY';assert.equal(await c.qr.qrImage({image:data}),data);
  assert.equal(await c.qr.qrImage({imageUrl:'https://unrelated.invalid/private-image'}),null);
});
