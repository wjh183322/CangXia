// Real Chromium geometry regression; intentionally uses generated, offline fixture data.
const {app,BrowserWindow,ipcMain,protocol}=require('electron');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
app.disableHardwareAcceleration();app.setPath('userData',path.resolve('.test-output/layout-profile'));
protocol.registerSchemesAsPrivileged([{scheme:'app-media',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.whenReady().then(async()=>{
 let win;const checks=[];
 try{
  const works=Array.from({length:21},(_,i)=>({id:String(1000+i),name:`布局测试 ${i+1}`,title:'',description:'',author:{uid:'1',nickname:'测试作者'},tags:[],localTags:[],type:'images',images:[{index:0}],local:i<2,downloaded:i<2,localRecord:i<2?{collectionId:'__all__',assets:[]}:null}));
  const members={__all__:works.map(w=>w.id)};
  ipcMain.handle('layout:state',()=>({works,collections:[{id:'__all__',name:'收藏',added:true}],members,localMembers:members,root:'测试目录',collector:{phase:'idle',message:'布局测试数据'},queue:{jobs:[]}}));
  protocol.handle('app-media',()=>new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64'),{headers:{'content-type':'image/png'}}));
  win=new BrowserWindow({show:false,useContentSize:true,width:1400,height:960,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,backgroundThrottling:false,preload:path.join(__dirname,'layout-preload.cjs')}});
  const js=s=>win.webContents.executeJavaScript(s,true),sleep=()=>new Promise(r=>setTimeout(r,140));
  const measure=()=>js(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return {card:r('.cover-button').width,workspace:r('.workspace').width,main:r('.main-content').width,scrollBottom:r('.work-scroll').bottom,footerTop:r('.list-footer').top,footerBottom:r('.list-footer').bottom,dockTop:document.querySelector('.selection-dock')?.getBoundingClientRect().top,columns:getComputedStyle(document.querySelector('.cover-grid')).gridTemplateColumns.split(' ').length}})()`);
  const assertGeometry=async name=>{const m=await measure();assert.equal(m.card,216,name);assert.ok(Math.abs(m.workspace-m.main)<1,name);assert.ok(m.scrollBottom<=m.footerTop+1,name);if(m.dockTop)assert.ok(m.footerBottom<=m.dockTop,name);checks.push({name,...m});};
  await win.loadFile(path.resolve(process.env.CANGXIA_UI_PACKAGE||'dist/index.html'));await sleep();
  await assertGeometry('unfiltered account');assert.equal(checks[0].columns,5);
  await js(`document.querySelector('[aria-label="本页全选"]').click()`);await sleep();await assertGeometry('bulk action bar has reserved space');
  await js(`(()=>{const i=document.querySelector('[aria-label="搜索作品、作者或标签"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'布局测试 21');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await sleep();
  assert.equal(await js(`document.querySelectorAll('.work-card').length`),1);await assertGeometry('one filtered account result');
  await js(`document.querySelectorAll('.main-nav>button')[1].click()`);await sleep();assert.equal(await js(`document.querySelectorAll('.work-card').length`),2);await assertGeometry('two local works');
  win.setContentSize(1100,740);await sleep();await assertGeometry('narrower window keeps card size');
  fs.writeFileSync('.test-output/layout-smoke.json',JSON.stringify({ok:true,checks},null,2));fs.writeFileSync('.test-output/layout-smoke.png',(await win.webContents.capturePage()).toPNG());app.exit(0);
 }catch(e){fs.writeFileSync('.test-output/layout-smoke.json',JSON.stringify({ok:false,error:e.stack,checks},null,2));app.exit(1);}
});
