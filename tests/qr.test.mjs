import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { QrLogin } from '../electron/qr-login.mjs';
import { qrPageScript, validQrRect, webUserAgent } from '../electron/qr-page.mjs';

function controller({cookieRead=async()=>[],authenticated=async()=>{}}={}){
  const actions=[];let created=0;
  const window=new EventEmitter();window.isDestroyed=()=>false;window.hide=()=>actions.push('hide');window.close=()=>actions.push('close');window.setTitle=()=>{};
  window.setSkipTaskbar=()=>{};window.show=()=>actions.push('show');window.focus=()=>actions.push('focus');window.getContentBounds=()=>({width:1000,height:800});
  window.loadURL=async()=>{actions.push('load');};window.webContents={setUserAgent:()=>{},setWindowOpenHandler:()=>{},on:()=>{}};
  const qr=new QrLogin({profile:{cookies:{get:cookieRead}},chromiumVersion:'150.0.1.2',onChange:()=>{},onAuthenticated:authenticated,createWindow:()=>{created++;return window;}});qr.watch=async()=>{};
  return {qr,window,actions,get created(){return created;}};
}

test('SMS identity choices are recognized before the QR and never clicked automatically',()=>{
 const result=vm.runInNewContext(qrPageScript({openLogin:true,refresh:true}),{document:{body:{innerText:'身份验证 为保障账号安全，请先完成身份验证 接收短信验证码 发送短信验证'},querySelectorAll:()=>[]}});assert.equal(result.phase,'verification');assert.equal(result.kind,'sms');
});
test('identity challenge with code input is detected without reading its value',()=>{
 const input={tagName:'INPUT',getAttribute:k=>k==='autocomplete'?'one-time-code':'',getBoundingClientRect:()=>({width:200,height:30,top:10,bottom:40}),get value(){throw new Error('must not read verification code');}};
 const heading={children:[],innerText:'身份验证',getBoundingClientRect:()=>({width:200,height:30,top:10,bottom:40})};
 const result=vm.runInNewContext(qrPageScript(),{document:{body:{innerText:'身份验证'},querySelectorAll:s=>s==='input,textarea'?[input]:s.startsWith('h1,')?[heading]:[]},innerHeight:800,getComputedStyle:()=>({display:'block',visibility:'visible'})});assert.equal(result.kind,'sms');
});

test('ordinary side-by-side QR and SMS login form keeps the compact QR flow',()=>{
 const rect={x:100,y:100,width:180,height:180,top:100,bottom:280};
 const qr={tagName:'IMG',children:[],id:'',parentElement:null,currentSrc:'data:image/png;base64,TEST_ONLY',getBoundingClientRect:()=>rect,getAttribute:k=>k==='alt'?'登录二维码':''};
 const input={tagName:'INPUT',getBoundingClientRect:()=>({...rect,width:200,height:30}),getAttribute:k=>k==='placeholder'?'请输入验证码':k==='autocomplete'?'one-time-code':'',get value(){throw Error('must not read input');}};
 const context={document:{body:{innerText:'登录后即可观看喜欢、收藏的视频\n扫码登录\n验证码登录\n密码登录\n获取验证码'},querySelectorAll:s=>s==='input,textarea'?[input]:s==='img,canvas,svg'?[qr]:[]},innerHeight:800,getComputedStyle:()=>({display:'block',visibility:'visible'})};
 assert.equal(vm.runInNewContext(qrPageScript(),context).phase,'ready');
 context.document.querySelectorAll=s=>s==='input,textarea'?[input]:[];
 assert.equal(vm.runInNewContext(qrPageScript(),context).phase,'loading');
});
test('ordinary SMS login tab alone is not classified as a verification challenge',()=>{
 const result=vm.runInNewContext(qrPageScript(),{document:{body:{innerText:'扫码登录 短信验证码登录'},querySelectorAll:()=>[]}});assert.equal(result.phase,'loading');
});
test('scanned confirmation clears the stale QR stage',()=>{const result=vm.runInNewContext(qrPageScript(),{document:{body:{innerText:'扫码成功 请在手机上确认登录'},querySelectorAll:()=>[]}});assert.equal(result.phase,'scanned');});
test('instructions describing phone confirmation do not pretend that scanning already succeeded',()=>{const result=vm.runInNewContext(qrPageScript(),{document:{body:{innerText:'扫码后，请在手机上确认登录'},querySelectorAll:()=>[]}});assert.equal(result.phase,'loading');});
test('manual login check reuses the original page instead of refreshing its session',async()=>{const c=controller();await c.qr.start();await c.qr.check();await c.qr.check();assert.equal(c.created,1);assert.equal(c.actions.filter(a=>a==='load').length,1);assert.equal(c.qr.state().phase,'verification');assert.ok(c.actions.includes('show'));c.qr.cancel();});
test('verification page can be opened even when a cached login failed before creating a window',async()=>{const c=controller({cookieRead:async()=>[{name:'sessionid',value:'TEST_ONLY'}],authenticated:async()=>{throw new Error('verification required');}});await c.qr.start();assert.equal(c.created,0);await c.qr.showPage();assert.equal(c.created,1);assert.ok(c.actions.includes('show'));c.qr.cancel();});
test('SMS challenge takes precedence over a candidate cookie and continues after manual verification',async()=>{
 let reads=0,pages=0,resolve;const done=new Promise(r=>{resolve=r;});const c=controller({cookieRead:async()=>++reads===1?[]:[{name:'sessionid',value:'TEST_ONLY'}],authenticated:async()=>{resolve();}});c.qr.watch=QrLogin.prototype.watch.bind(c.qr);c.window.webContents.executeJavaScript=async()=>++pages===1?{phase:'verification',kind:'sms',message:'SMS required'}:{phase:'loading',message:'verified page'};
 await c.qr.start();await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(new Error('verification did not finish')),3500))]);await new Promise(r=>setImmediate(r));assert.equal(c.actions.filter(a=>a==='show').length,1);assert.ok(pages>=2);assert.equal(c.qr.state().phase,'success');c.qr.cancel();
});
test('old-library ownership confirmation has its own state instead of a login failure',async()=>{const c=controller({authenticated:async()=>{throw Object.assign(new Error('confirm owner'),{code:'LEGACY_CONFIRM_REQUIRED'});}});await c.qr.start();await c.qr.complete([{name:'sessionid',value:'TEST_ONLY'}],c.qr.generation);assert.equal(c.qr.state().phase,'confirm-account');c.qr.cancel();});
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
