const {app,BrowserWindow,ipcMain,protocol}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.disableHardwareAcceleration();app.setPath('userData',path.resolve('.test-output/nas-layout-profile'));
protocol.registerSchemesAsPrivileged([{scheme:'app-media',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const deadline=setTimeout(()=>app.exit(1),45000);
app.whenReady().then(async()=>{
 const checks=[];let win;
 try{
  fs.mkdirSync('.test-output',{recursive:true});
  const names=['冬日山间','午后的光','城市漫步','角色记录','花开时节','旅途片段','插画手记','夜色街景','山间清晨'];
  const works=names.map((name,i)=>({id:String(1000+i),name,description:'界面测试示例',author:{uid:i<8?'1':'2',nickname:i<8?'墨白':'青禾'},tags:['摄影'],localTags:[],type:'images',images:[{index:0}],local:false,downloaded:false,backedUp:true,backupRecord:{id:String(1000+i),collectionId:i<6?(i===5?'8':'9'):'author:'+(i===8?'B':'A'),assets:[{key:'image-0',kind:'image',file:'image.png',sha256:String(i+1).repeat(64),size:1024*1024}]}}));
  const members={__all__:works.slice(0,6).map(w=>w.id),'9':works.slice(0,5).map(w=>w.id)};
  ipcMain.handle('layout:state',()=>({works,version:require('../package.json').version,storage:{mode:'backup',writable:true,connected:true,phase:'synced'},collections:[{id:'__all__',name:'收藏',added:true},{id:'9',name:'摄影',added:true},{id:'8',name:'旅行记录',remoteMissing:true}],members,localMembers:members,authors:[{id:'A',name:'墨白',count:5}],authorMembers:{A:['1000','1001','1002','1006','1007']},backupAuthors:[{id:'A',name:'墨白'},{id:'B',name:'青禾',archived:true}],backupAuthorMembers:{A:['1000','1001','1002','1006','1007'],B:['1008']},root:'界面测试目录',collector:{phase:'idle',message:'界面测试'},queue:{jobs:[]}}));
  protocol.handle('app-media',request=>{
   const id=Number(new URL(request.url).pathname.split('/').filter(Boolean)[0])||1000,i=id%5;
   const colors=['#dbe8e9','#ead8c7','#cbdbea','#edddd8','#d7dfd3'];
   return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640"><rect width="480" height="640" fill="${colors[i]}"/><circle cx="340" cy="165" r="70" fill="#fff9e8"/><path d="M0 430L150 210L300 430L400 280L480 400V640H0Z" fill="#849da7"/><path d="M0 550L240 335L480 565V640H0Z" fill="#526d7c"/><path d="M0 580Q230 500 480 585V640H0Z" fill="#bfd3d1"/></svg>`,{headers:{'content-type':'image/svg+xml'}});
  });
  win=new BrowserWindow({show:false,useContentSize:true,width:1568,height:1004,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,backgroundThrottling:false,preload:path.join(__dirname,'layout-preload.cjs')}});
  const js=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){throw new Error('NAS layout script failed: '+code+'\n'+error.stack);}},settle=()=>new Promise(r=>setTimeout(r,180));
  const ready=async expression=>{for(let attempt=0;attempt<100;attempt++){if(await js(expression))return;await settle();}throw new Error('NAS UI did not become ready: '+expression);};
  await win.loadFile(path.resolve('dist/index.html'));await ready(`!!document.querySelector('.main-nav button')`);await js(`[...document.querySelectorAll('.main-nav button')].find(b=>b.textContent.includes('NAS 备份')).click()`);await ready(`!!document.getElementById('nas-tab-all')&&!!document.querySelector('.card-checkbox')`);
  for(const tab of ['all','collection','author']){
   await js(`document.getElementById('nas-tab-${tab}').click()`);await settle();
   if(tab==='author'){await js(`document.querySelector('[aria-label="NAS 作者 墨白"]').click()`);await settle();}
   await js(`[...document.querySelectorAll('.card-checkbox')].slice(0,2).forEach(b=>b.click())`);await settle();
   const layout=await js(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return {sidebars:document.querySelectorAll('.sidebar').length,innerNavigation:document.querySelectorAll('.main-content .nas-context').length,active:document.querySelector('.nas-tabs [aria-selected=true]').id,tabRight:r('.nas-tabs').right,mainLeft:r('.main-content').left,cardLeft:r('.work-card').left,scrollBottom:r('.work-scroll').bottom,footerTop:r('.list-footer').top,dockBottom:r('.selection-dock').bottom,height:innerHeight,width:innerWidth,bodyWidth:document.body.scrollWidth}})()`);
   assert.equal(layout.sidebars,1);assert.equal(layout.innerNavigation,0);assert.equal(layout.active,'nas-tab-'+tab);assert.ok(layout.cardLeft-layout.mainLeft<50);assert.ok(layout.tabRight<=layout.width);assert.ok(layout.bodyWidth<=layout.width);assert.ok(layout.scrollBottom<=layout.footerTop+1);assert.ok(layout.dockBottom<=layout.height);checks.push({tab,...layout});
   fs.writeFileSync(`.test-output/nas-ui-${tab}.png`,(await win.webContents.capturePage()).toPNG());
  }
  win.setContentSize(1100,740);await settle();
  for(const tab of ['all','collection','author']){
   await js(`document.getElementById('nas-tab-${tab}').click()`);await settle();await js(`document.querySelector('.card-checkbox').click()`);await settle();
   const rect=await js(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return {dockBottom:r('.selection-dock').bottom,scrollHeight:r('.work-scroll').height,footerBottom:r('.list-footer').bottom,dockTop:r('.selection-dock').top,storageBottom:r('.storage-card').bottom,height:innerHeight,overflow:document.body.scrollWidth>innerWidth}})()`);
   assert.ok(!rect.overflow&&rect.dockBottom<=rect.height&&rect.footerBottom<=rect.dockTop&&rect.scrollHeight>100&&rect.storageBottom<=rect.height,JSON.stringify({tab,...rect}));checks.push({tab,small:true,...rect});
  }
  fs.writeFileSync('.test-output/nas-layout-result.json',JSON.stringify({ok:true,checks},null,2));console.log({ok:true,checks});clearTimeout(deadline);app.exit(0);
 }catch(error){fs.writeFileSync('.test-output/nas-layout-result.json',JSON.stringify({ok:false,error:error.stack,checks},null,2));console.error(error);clearTimeout(deadline);app.exit(1);}
});
