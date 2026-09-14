import {createRequire} from 'node:module';
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {Store} from '../electron/store.mjs';import {inspectRepairs} from '../electron/repair-check.mjs';import {listDirectory,makeDirectory} from '../electron/file-browser.mjs';
const require=createRequire(import.meta.url);const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','MutationObserver','Event','MouseEvent','KeyboardEvent'])globalThis[key]=key==='window'?dom.window:dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});globalThis.ResizeObserver=class{observe(){}disconnect(){}};
dom.window.HTMLElement.prototype.scrollTo=function({top}){this.scrollTop=top;};
// JSDOM has no layout engine: controlled, intentionally different rectangles test anchor selection only.
const originalRect=dom.window.HTMLElement.prototype.getBoundingClientRect;
dom.window.HTMLElement.prototype.getBoundingClientRect=function(){
 if(this.classList.contains('modal'))return {left:100,width:540,right:640,top:100,bottom:700,height:600};
 if(this.classList.contains('main-content'))return {left:210,width:1100,right:1310,top:0,bottom:900,height:900};
 return originalRect.call(this);
};
dom.window.HTMLMediaElement.prototype.pause=function(){};dom.window.HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
const {act}=await import('react');globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const base=fs.mkdtempSync(path.resolve('.test-output/v016-dom-'));const store=await Store.open(path.join(base,'test.sqlite'),path.join(base,'media'));
store.discoverCollections([{collects_id:'9',collects_name:'测试收藏夹'}]);store.setAdded(['9']);
for(let n=0;n<45;n++)store.upsertWork({aweme_id:String(1000+n),item_title:`测试作品 ${n+1}`,desc:n%2?'#摄影':'#cos',author:{uid:String(n%2+1),nickname:n%2?'测试作者乙':'测试作者甲'},video:{play_addr:{url_list:['https://v3.douyinvod.com/test.mp4']}}});
const all=store.all('works').map(w=>w.id);store.ingestMembers('__all__',all,true);store.ingestMembers('9',all,true);
for(const w of store.all('works')){const dir=store.destination(w.id).dir;fs.mkdirSync(dir,{recursive:true});const assets=[];for(const [key,file,kind] of [['video','视频.mp4','video'],['cover','单图.jpg','image'],['metadata','作品信息.json','metadata']]){fs.writeFileSync(path.join(dir,file),'test');assets.push({key,file,kind,size:4});}store.put('downloads',w.id,{id:w.id,path:dir,collectionId:'9',state:'complete',assets});}
const data=()=>({...store.snapshot(),collector:{phase:'done',message:'组件测试'},storage:{mode:'backup',writable:true,connected:true,phase:'synced',config:{}},queue:{jobs:[],paused:true}});let notify=()=>{},intent,started=0;const checks=[];
window.cangxia={state:async()=>data(),onChange:fn=>{notify=fn;return()=>{};},refreshFiles:async()=>data(),prepareDelete:async(ids,kind)=>{intent={token:'test',kind,count:ids.length,ids};return intent;},confirmDelete:async()=>{store.deleteReadRecords(intent.ids);notify(data());return true;},checkRepairs:async ids=>inspectRepairs(store,ids),startRepairs:async ids=>{const r=inspectRepairs(store,ids);r.started=r.missing;started+=r.started;return r;},listDirectory:async(dir,mode)=>listDirectory(dir||base,mode),makeDirectory,chooseRoot:async dir=>{store.setDownloadRoot(dir);notify(data());},importLoginConfig:async()=>true};
const settle=()=>new Promise(r=>setTimeout(r,15));
const click=async text=>{await act(async()=>{const root=document.querySelector('.modal')||document;const b=[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===text);assert.ok(b,'button: '+text);assert.equal(b.disabled,false,'enabled: '+text);b.click();await settle();});};
const aria=async label=>{await act(async()=>{const b=document.querySelector(`[aria-label="${label}"]`);assert.ok(b,label);b.click();await settle();});};
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
try{
 await act(async()=>{await import('../.test-output/dom-build/main.js');await settle();});
 check('20 cards per page',document.querySelectorAll('.work-card').length===20);
 document.querySelector('.work-scroll').scrollTop=500;await aria('顶部下一页');check('top pagination resets scroll and starts at work 21',document.querySelector('.work-scroll').scrollTop===0&&document.querySelector('.cover-title').textContent==='测试作品 21');
 document.querySelector('.work-scroll').scrollTop=500;await aria('底部下一页');check('bottom pagination final page has five and resets scroll',document.querySelectorAll('.work-card').length===5&&document.querySelector('.work-scroll').scrollTop===0);
 await aria('顶部上一页');await aria('顶部上一页');await aria('本页全选');check('page selects 20',document.querySelectorAll('.work-card.selected').length===20);await aria('取消选择');
 await act(async()=>{document.querySelectorAll('.filter-tile')[2].click();await settle();});await click('#cos');await click('完成');
 await act(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('全部结果全选')).click();await settle();});check('filtered all selects only 23 results',document.querySelector('.selection-dock').textContent.includes('23'));
 await click('删除读取记录');check('custom confirmation has selected count',intent.ids.length===23&&!!document.querySelector('[aria-label="删除读取记录"]'));await click('取消');check('cancel leaves account unchanged',store.snapshot().members.__all__.length===45);
 await click('删除读取记录');await click('删除读取记录');check('confirmation hides selected records in total and folder',store.snapshot().members.__all__.length===22&&store.snapshot().members['9'].length===22);
 await act(async()=>{document.querySelectorAll('.main-nav>button')[1].click();await settle();});check('local keeps 45 works and original order',document.querySelector('.cover-title').textContent==='测试作品 1'&&document.querySelectorAll('.work-card').length===20);
 await aria('选择 测试作品 1');await click('检查并补齐');check('complete files report without download',document.querySelector('.modal').textContent.includes('文件完整，无需补齐')&&started===0);await click('关闭');
 fs.unlinkSync(path.join(store.download('1000').path,'单图.jpg'));await click('检查并补齐');check('missing image named before queue starts',document.querySelector('.modal').textContent.includes('高清单图')&&started===0);await click('开始补齐 1 个作品');check('repair starts after confirmation',started===1);
 await aria('设置');await click('重新检查文件');check('refresh uses themed settings and toast',!!document.querySelector('.toast')&&document.querySelector('.modal').textContent.includes('重新检查文件'));
 check('toast uses dialog center instead of sidebar-offset content center',document.querySelector('.toast').style.left==='370px');
 await act(async()=>{document.querySelector('details').open=true;await settle();});await click('导入登录会话配置');check('custom file picker rendered',!!document.querySelector('.file-picker'));await click('取消');await aria('关闭弹窗');
 check('toast returns to content center when dialog closes',document.querySelector('.toast').style.left==='760px');
 fs.writeFileSync('.test-output/workspace-ui-result.json',JSON.stringify({ok:true,checks},null,2));console.log({ok:true,checks});
}catch(e){fs.writeFileSync('.test-output/workspace-ui-result.json',JSON.stringify({ok:false,error:e.stack,checks,text:document.body.textContent},null,2));throw e;}finally{store.close();dom.window.close();}
process.exit(0);
