// Real Chromium geometry regression; intentionally uses generated, offline fixture data.
const {app,BrowserWindow,ipcMain,protocol}=require('electron');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
fs.mkdirSync('.test-output',{recursive:true});
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.disableHardwareAcceleration();app.setPath('userData',path.resolve('.test-output/layout-profile'));
protocol.registerSchemesAsPrivileged([{scheme:'app-media',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.whenReady().then(async()=>{
 let win;const checks=[];
 try{
  const works=Array.from({length:21},(_,i)=>({id:String(1000+i),name:`布局测试 ${i+1}`,title:'',description:'',author:{uid:'1',nickname:'测试作者'},tags:[],localTags:[],type:'images',images:[{index:0}],local:i<2,downloaded:i<2,localRecord:i<2?{collectionId:'__all__',assets:[]}:null}));
  const members={__all__:works.map(w=>w.id)};
  const collectionReadInfo={__all__:{baselineKnown:true,quick:{mode:'quick',baselineKnown:true,count:810,added:120,restored:3,canResume:true,reason:'已停止，已读取内容和进度保留'},full:{mode:'full',count:22000,added:120,canResume:true,reason:'上次读取未正常结束，已有内容保留'}}};
  ipcMain.handle('layout:state',()=>({works,collectionReadInfo,storage:{mode:'backup',writable:true,connected:true,phase:'synced'},collections:[{id:'__all__',name:'收藏',added:true}],members,localMembers:members,root:'测试目录',collector:{phase:'idle',message:'布局测试数据'},queue:{jobs:[]}}));
  protocol.handle('app-media',()=>new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64'),{headers:{'content-type':'image/png'}}));
  win=new BrowserWindow({show:false,useContentSize:true,width:1400,height:960,webPreferences:{offscreen:{deviceScaleFactor:1},contextIsolation:true,sandbox:true,backgroundThrottling:false,preload:path.join(__dirname,'layout-preload.cjs')}});
  const js=s=>win.webContents.executeJavaScript(s,true),sleep=()=>new Promise(r=>setTimeout(r,140));
  async function capture(file){
    let failed;
    for(let i=0;i<4;i++)try{
      const shot=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      assert.ok(!shot.isEmpty(),'empty offscreen capture');fs.writeFileSync(file,shot.toPNG());return;
    }catch(error){failed=error;win.webContents.invalidate();await sleep();}
    throw failed;
  }
  const waitFor=async(description,expression)=>{
    const until=Date.now()+10000;
    do{if(await js(expression))return; await sleep();}while(Date.now()<until);
    throw Error('Timed out waiting for '+description);
  };
  async function viewport(width,height){
    win.setContentSize(width,height);
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{
      width,height,deviceScaleFactor:1,mobile:false,screenWidth:width,screenHeight:height
    });
    await waitFor('fixed CSS viewport',`innerWidth===${width}&&innerHeight===${height}&&devicePixelRatio===1`);
  }
  const measure=()=>js(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return {card:r('.cover-button').width,workspace:r('.workspace').width,main:r('.main-content').width,scrollBottom:r('.work-scroll').bottom,footerTop:r('.list-footer').top,footerBottom:r('.list-footer').bottom,dockTop:document.querySelector('.selection-dock')?.getBoundingClientRect().top,columns:getComputedStyle(document.querySelector('.cover-grid')).gridTemplateColumns.split(' ').length}})()`);
  const assertGeometry=async name=>{const m=await measure();checks.push({name,...m});assert.equal(m.card,216,name);assert.ok(Math.abs(m.workspace-m.main)<1,name);assert.ok(m.scrollBottom<=m.footerTop+1,name);if(m.dockTop)assert.ok(m.footerBottom<=m.dockTop,name);};
  await win.loadFile(path.resolve(process.env.CANGXIA_UI_PACKAGE||'dist/index.html'));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await viewport(1400,960);
  const font=fs.readFileSync(path.join(__dirname,'fixtures','layout-test-font.woff2')).toString('base64');
  await js(`(async()=>{const f=new FontFace('CangXia Layout Fixture',Uint8Array.from(atob('${font}'),c=>c.charCodeAt(0)));
    await f.load();document.fonts.add(f);await document.fonts.ready;})()`);
  await win.webContents.insertCSS(':root,body,button,input,select,textarea{font-family:"CangXia Layout Fixture",sans-serif !important}');
  await waitFor('populated first page', "document.querySelectorAll('.work-card').length===20");
  await js(`(()=>{const input=document.querySelector('[aria-label="顶部跳转页码"]');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'2');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await sleep();
  await js(`window.pageJumpCommit=new Promise(resolve=>{
    const observer=new MutationObserver(()=>{
      const title=document.querySelector('.cover-title')?.textContent;
      if(title!=='布局测试 21')return;
      observer.disconnect();
      resolve({title,top:document.querySelector('[aria-label="顶部跳转页码"]').value,
        bottom:document.querySelector('[aria-label="底部跳转页码"]').value,
        count:document.querySelectorAll('.work-card').length});
    });observer.observe(document.querySelector('#root'),{subtree:true,childList:true,characterData:true});
  });true`);
  for(const type of ['rawKeyDown','char','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',
    {type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,...(type==='char'?{text:'\r',unmodifiedText:'\r'}:{})});
  await waitFor('page two after Enter', "document.querySelector('.cover-title')?.textContent==='布局测试 21'");
  const committed=await js('window.pageJumpCommit');
  assert.deepEqual(committed,{title:'布局测试 21',top:'2',bottom:'2',count:1},'first committed page must agree with both controls');
  assert.equal(await js(`document.querySelector('.cover-title').textContent`),'布局测试 21');assert.equal(await js(`document.querySelector('[aria-label="底部跳转页码"]').value`),'2');
  await js(`document.querySelector('[aria-label="顶部上一页"]').click()`);await sleep();
  await waitFor('both controls and the first page after previous', `document.querySelector('.cover-title')?.textContent==='布局测试 1'&&
    document.querySelector('[aria-label="顶部跳转页码"]').value==='1'&&document.querySelector('[aria-label="底部跳转页码"]').value==='1'`);
  await assertGeometry('unfiltered account');assert.equal(checks[0].columns,5);
  await js(`document.querySelector('[aria-label="本页全选"]').click()`);await sleep();await assertGeometry('bulk action bar has reserved space');
  await js(`(()=>{const i=document.querySelector('[aria-label="搜索作品、作者或标签"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'布局测试 21');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await sleep();
  await waitFor('filtered account work',"document.querySelectorAll('.work-card').length===1");assert.equal(await js(`document.querySelectorAll('.work-card').length`),1);await assertGeometry('one filtered account result');
  await js(`[...document.querySelectorAll('.main-nav>button')].find(b=>b.textContent.includes('本地媒体库')).click()`);await sleep();await waitFor('local archive rows',"document.querySelectorAll('.work-card').length===2");assert.equal(await js(`document.querySelectorAll('.work-card').length`),2);await assertGeometry('two local works');
  await viewport(1100,740);await sleep();await assertGeometry('narrower window keeps card size');
  await js(`[...document.querySelectorAll('.main-nav>button')].find(b=>b.textContent.includes('账号收藏')).click()`);await sleep();await js(`[...document.querySelectorAll('.heading-actions button')].find(b=>b.textContent.includes('同步收藏')).click()`);await sleep();
  for(const expanded of [false,true]){if(expanded){await js(`document.querySelector('.collection-read-full').open=true`);await sleep();}const m=await js(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect(),m=r('.modal'),f=r('.modal-footer'),b=r('.modal-footer .primary');return {top:m.top,bottom:m.bottom,footerBottom:f.bottom,buttonBottom:b.bottom,height:innerHeight}})()`);assert.ok(m.top>=0&&m.bottom<=m.height&&m.buttonBottom<=m.height&&m.footerBottom<=m.height);checks.push({name:expanded?'expanded full-check option remains reachable':'quick-check dialog fits small window',...m});}
  await capture('.test-output/collection-read-setup.png');
  fs.writeFileSync('.test-output/layout-smoke.json',JSON.stringify({ok:true,checks},null,2));await capture('.test-output/layout-smoke.png');app.exit(0);
 }catch(e){
  let renderer=null;
  if(win&&!win.isDestroyed())try{renderer=await win.webContents.executeJavaScript(`({width:innerWidth,height:innerHeight,
    dpr:devicePixelRatio,ready:document.readyState,fixtureFont:document.fonts.check('16px "CangXia Layout Fixture"'),
    cards:document.querySelectorAll('.work-card').length,title:document.querySelector('.cover-title')?.textContent})`);}catch{}
  const report=JSON.stringify({ok:false,error:e.stack,renderer,checks},null,2);
  fs.writeFileSync('.test-output/layout-smoke.json',report);fs.writeSync(2,report+'\n');app.exit(1);
 }
});
