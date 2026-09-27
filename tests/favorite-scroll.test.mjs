import test from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
import {FavoriteRecorder,requestCursor,isFavoriteRequest} from '../scripts/favorite-scroll/recorder.mjs';import {installFavoriteScroller} from '../scripts/favorite-scroll/page-ui.mjs';
const page=(ids,next,more)=>JSON.stringify({status_code:0,aweme_list:ids.map(id=>({aweme_id:id,desc:'示例 '+id})),cursor:next,has_more:more});
test('scroll observer counts unique IDs and proves only a connected chain ending explicitly',()=>{
  const r=new FavoriteRecorder();r.accept('30',page(['3','4'],'60',0));assert.equal(r.summary().serverEnd,false);assert.equal(r.summary().hasFirstPage,false);
  r.accept('0',page(['1','2','3'],'30',1));assert.equal(r.summary().serverEnd,true);assert.equal(r.summary().uniqueWorks,4);assert.equal(r.summary().continuousWorks,4);assert.deepEqual(r.summary().lastWorks.map(w=>w.id),['1','2','3','4']);
});
test('empty incomplete page, missing cursor and repeated cursor cannot become complete',()=>{
  const r=new FavoriteRecorder();r.accept('0',page([],'0',1));assert.equal(r.summary().serverEnd,false);assert.equal(r.summary().cycle,true);
  const s=new FavoriteRecorder();s.accept('0',JSON.stringify({aweme_list:[{aweme_id:'1'}]}));assert.equal(s.summary().serverEnd,false);
});
test('repeat responses do not inflate counts and changed first page preserves previous evidence',()=>{
  const r=new FavoriteRecorder();r.accept('0',page(['1','2'],'30',1));r.accept('0',page(['1','2'],'30',1));assert.equal(r.summary().uniqueWorks,2);assert.equal(r.summary().responses,2);
  assert.throws(()=>r.accept('0',page(['7','1'],'30',1)),/内容发生变化/);assert.equal(r.summary().uniqueWorks,2);
});
test('exact numeric IDs survive and exported observation excludes credentials and media URLs',()=>{
  const r=new FavoriteRecorder();r.accept('0','{"aweme_list":[{"aweme_id":7687500314652729467,"desc":"test","video":{"play_addr":"signed-secret"}}],"has_more":0,"cookie":"SECRET"}');
  const out=r.export('done');assert.equal(out.works[0].id,'7687500314652729467');assert.equal(out.serverEnd,true);assert.equal(JSON.stringify(out).includes('SECRET'),false);assert.equal(JSON.stringify(out).includes('signed-secret'),false);
});
function pageFixture(){
  const dom=new JSDOM('<!doctype html><div id="list" style="overflow-y:auto"><a href="/video/123">作品</a></div>',{url:'https://www.douyin.com/user/self',runScripts:'outside-only'}),w=dom.window,list=w.document.getElementById('list');
  let top=0;Object.defineProperties(list,{clientHeight:{value:400},scrollHeight:{value:1200},scrollTop:{get:()=>top}});list.getBoundingClientRect=()=>({width:600,height:400,top:0,left:0});list.scrollBy=({top:n})=>{top=Math.min(800,top+n);};w.eval(`(${installFavoriteScroller.toString()})();`);const ui=w.document.getElementById('cangxia-favorite-scroll').shadowRoot,api=w.__cangxiaScroll;
  ui.getElementById('pick').click();list.querySelector('a').click();return {dom,w,list,ui,api};
}
test('scroll UI starts from rendered first-screen links without requiring a captured API first page',()=>{
  const {dom,list,ui,api}=pageFixture();ui.getElementById('start').click();assert.equal(api.phase,'running');assert.ok(api.message.includes('仅供参考'));assert.equal(ui.getElementById('count').textContent,'1');api.tick();assert.equal(api.phase,'running');assert.equal(api.steps,1);assert.ok(list.scrollTop>0);
  list.innerHTML='<a href="/note/456">另一个作品</a>';api.lastTick=0;api.tick();assert.equal(api.observed.size,2);ui.getElementById('pause').click();assert.equal(api.phase,'paused');dom.window.close();
});
test('DOM and API IDs form a deduplicated observation lower bound, not fake full coverage',()=>{
  const r=new FavoriteRecorder();r.observe(['1','2','3']);r.accept('30',page(['3','4'],'60',0));const result=r.export('done');assert.equal(result.observedTotalUnique,4);assert.equal(result.uniqueWorks,2);assert.equal(result.serverEnd,false);assert.equal(result.apiEndObserved,true);assert.equal(result.pages,1);assert.equal(result.pageRecords.length,1);
});
test('cursor parsing accepts form JSON and query strings without inventing zero for missing values',()=>{
  assert.equal(requestCursor('https://www.douyin.com/','cursor=0&count=18'),'0');assert.equal(requestCursor('https://www.douyin.com/','{"cursor":"12345678901234567"}'),'12345678901234567');assert.equal(requestCursor('https://www.douyin.com/?max_cursor=30',''),'30');assert.equal(requestCursor('https://www.douyin.com/',''),null);
});
test('real webpage alternate host is observed while preflight and unrelated endpoints are excluded',()=>{
  const path='/aweme/v1/web/aweme/listcollection/';for(const host of ['www.douyin.com','www-hj.douyin.com']){assert.equal(isFavoriteRequest('https://'+host+path,'POST'),true);assert.equal(isFavoriteRequest('https://'+host+path,'OPTIONS'),false);}
  assert.equal(isFavoriteRequest('https://www-hj.douyin.com/aweme/v1/web/collects/video/list/','POST'),false);assert.equal(isFavoriteRequest('https://www-hj.douyin.com.evil.test'+path,'POST'),false);
});
test('explicit server end stops; stalled page and changed page never claim completion',()=>{
  const {dom,ui,api,w}=pageFixture();api.update({hasFirstPage:true});ui.getElementById('start').click();api.update({hasFirstPage:true,serverEnd:true});api.tick();assert.equal(api.phase,'finished');
  api.update({hasFirstPage:true});ui.getElementById('start').click();for(let i=0;i<5;i++){api.lastTick=0;api.tick();}api.lastGrowth=Date.now()-121000;api.lastTick=0;api.tick();assert.equal(api.phase,'stalled');assert.ok(api.message.includes('不代表'));
  ui.getElementById('start').click();w.history.pushState({},'','?different=1');api.lastTick=0;api.tick();assert.equal(api.phase,'paused');assert.ok(api.message.includes('变化'));dom.window.close();
});
