import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store.mjs';
import { parseWork, classifyResponse, safeName, inside, selectWorks, TOTAL, parsePlatformJSON, joinPages } from '../electron/model.mjs';
import { imageDimensions } from '../electron/media-info.mjs';
import { DownloadQueue } from '../electron/downloads.mjs';

const media='https://v3.douyinvod.com/test.mp4', cover='https://p3.douyinpic.com/cover.jpg';
const raw=(id='123', name='测试标题')=>({ aweme_id:id, item_title:name, desc:'原始文案 #cos #fgo', create_time:1, author:{uid:'42',sec_uid:'MS4wABC',unique_id:'author42',nickname:'原作者'}, text_extra:[{hashtag_name:'cos',hashtag_id:'3'}], video:{duration:7000,play_addr:{url_list:[media]},origin_cover:{url_list:[cover]},cover:{url_list:[cover]}}});
async function setup(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-test-'));
  const store=await Store.open(path.join(root,'db.sqlite'),path.join(root,'media'));
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});}); return store;
}
function localFile(store,id,collectionId=TOTAL) {
  const {dir}=store.destination(id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'视频.mp4'),'video');
  const d={id,path:dir,collectionId,state:'complete',assets:[{key:'video',file:'视频.mp4',kind:'video',size:5}],savedAt:new Date().toISOString()};store.put('downloads',id,d);store.save();return d;
}
test('normalizes author identity, preserves description and tags, prefers original image',()=>{
  const w=parseWork(raw());assert.equal(w.author.uid,'42');assert.equal(w.author.uniqueId,'author42');assert.equal(w.description,'原始文案 #cos #fgo');assert.deepEqual(w.tags,['cos','fgo']);assert.equal(w.coverSource,'origin_cover');
  const r=raw();r.video.origin_cover=null;r.video.cover_original_scale={url_list:[cover]};assert.equal(parseWork(r).coverSource,'cover_original_scale');
});
test('JSON numeric 64-bit identifiers are preserved before Number rounding',()=>{
  const d=parsePlatformJSON('{"collects_id":7683829929179724518,"count":20}');assert.equal(d.collects_id,'7683829929179724518');assert.equal(d.count,20);
});
test('explicit source deletion is retained as invalidity',()=>{
  const r=raw();r.status={is_delete:true};assert.equal(parseWork(r).remoteState,'unavailable');
});
test('pagination requires an unbroken chain from zero and explicit end',()=>{
  const pages=new Map([['10',{items:['b'],more:false,next:'20'}]]);assert.equal(joinPages(pages).complete,false);
  pages.set('0',{items:['a'],more:true,next:'5'});assert.equal(joinPages(pages).complete,false);
  pages.set('5',{items:['c'],more:true,next:'10'});assert.deepEqual(joinPages(pages),{items:['a','c','b'],complete:true});
  pages.set('10',{items:['b'],more:true,next:'10'});assert.equal(joinPages(pages).complete,false);
});
test('bounded image parser reads dimensions and rejects unknown headers safely',()=>{
  const b=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(360,16);b.writeUInt32BE(640,20);assert.deepEqual(imageDimensions(b),{width:360,height:640});assert.deepEqual(imageDimensions(Buffer.from('invalid')),{width:null,height:null});
});
test('selects maximum resolution before bitrate and ignores download_addr watermark candidate',()=>{
  const r=raw();r.video.bit_rate=[{bit_rate:9000,play_addr:{width:720,height:1280,url_list:[media+'?low']}},{bit_rate:8000,play_addr:{width:1080,height:1920,url_list:[media+'?high']}}];r.video.download_addr={url_list:[media+'?watermark']};const w=parseWork(r);assert.match(w.videoUrls[0],/high/);assert.ok(!w.videoUrls.some(x=>x.includes('watermark')));
});
test('photo posts prioritize watermark-free and original image candidates',()=>{
  const r=raw();r.images=[{watermark_free_download_url_list:[cover+'?clean'],display_image:{url_list:[cover+'?display']},owner_watermark_image:{url_list:[cover+'?watermark']}}];const w=parseWork(r);assert.equal(w.type,'images');assert.match(w.images[0].urls[0],/clean/);assert.ok(!w.images[0].urls.some(x=>x.includes('watermark')));
});
test('favorites are distinct from likes and keep ID strings exact',()=>{
  assert.equal(classifyResponse('https://www.douyin.com/aweme/v1/web/aweme/favorite/',{}),null);
  const result=classifyResponse('https://www.douyin.com/aweme/v1/web/collects/video/list/?collects_id=7683829929179724518',{});assert.equal(result.collectionId,'7683829929179724518');
  assert.equal(classifyResponse('https://evil.test/aweme/v1/web/aweme/listcollection/',{}),null);
});
test('safe names handle Windows reserved characters and traversal',()=>{
  assert.equal(safeName('CON'),'_CON');assert.equal(safeName('abc:<>/\\?*.. '),'abc_______');assert.equal(inside('C:/media','C:/other'),false);assert.equal(safeName('标题-作者'),'标题-作者');
});
test('partial sync retains unseen cached rows; full sync preserves server order',async t=>{
  const s=await setup(t);for(const id of ['1','2','3'])s.upsertWork(raw(id));
  s.ingestMembers(TOTAL,['2','1'],true);s.ingestMembers(TOTAL,['3'],false);assert.equal(s.snapshot().members[TOTAL].length,3);
  s.ingestMembers(TOTAL,['3','2'],true);assert.deepEqual(s.snapshot().members[TOTAL],['3','2']);assert.equal(s.work('1').remoteState,'available');
});
test('adding custom collection relocates a single physical copy; total remains visible',async t=>{
  const s=await setup(t);s.upsertWork(raw());s.ingestMembers(TOTAL,['123'],true);const original=localFile(s,'123');
  s.discoverCollections([{collects_id:'9',collects_name:'Cos',total_number:1}],true);s.setAdded(['9']);s.ingestMembers('9',['123'],true);s.reconcile();const d=s.download('123');assert.equal(d.collectionId,'9');assert.ok(d.path.includes(path.join('Cos','测试标题-原作者')));assert.equal(fs.existsSync(original.path),false);assert.equal(s.isDownloaded('123'),true);assert.deepEqual(s.snapshot().members[TOTAL],['123']);
});
test('rename and move follow sync; deleted source collection retains files',async t=>{
  const s=await setup(t);s.upsertWork(raw());s.ingestMembers(TOTAL,['123'],true);s.discoverCollections([{collects_id:'9',collects_name:'旧名字'}],true);s.setAdded(['9']);s.ingestMembers('9',['123'],true);localFile(s,'123','9');
  s.discoverCollections([{collects_id:'9',collects_name:'新名字'}],true);s.reconcile();assert.ok(s.download('123').path.includes('新名字'));s.discoverCollections([],true);s.ingestMembers(TOTAL,[],true);s.reconcile();assert.equal(s.isDownloaded('123'),true);assert.equal(s.download('123').collectionId,'9');
});
test('moving between selected folders leaves total plus exactly one custom relation',async t=>{
  const s=await setup(t);s.upsertWork(raw());s.ingestMembers(TOTAL,['123'],true);s.discoverCollections([{collects_id:'9',collects_name:'A'},{collects_id:'10',collects_name:'B'}],true);s.setAdded(['9','10']);s.ingestMembers('9',['123'],true);localFile(s,'123','9');s.ingestMembers('10',['123'],true);s.reconcile();assert.deepEqual(s.snapshot().members['9'],[]);assert.deepEqual(s.snapshot().members[TOTAL],['123']);assert.equal(s.download('123').collectionId,'10');
});
test('removing from selected folder while still collected moves to total; unfavorite retains archive',async t=>{
  const s=await setup(t);s.upsertWork(raw());s.ingestMembers(TOTAL,['123'],true);s.discoverCollections([{collects_id:'9',collects_name:'A'}],true);s.setAdded(['9']);s.ingestMembers('9',['123'],true);localFile(s,'123','9');s.ingestMembers('9',[],true);s.reconcile();assert.equal(s.download('123').collectionId,TOTAL);s.ingestMembers(TOTAL,[],true);s.reconcile();assert.ok(s.isDownloaded('123'));
});
test('same titles never overwrite another work, downloaded badge checks real assets',async t=>{
  const s=await setup(t);s.upsertWork(raw('1'));s.upsertWork(raw('2'));const a=localFile(s,'1');const b=localFile(s,'2');assert.notEqual(a.path,b.path);assert.equal(s.isDownloaded('1'),true);fs.unlinkSync(path.join(a.path,'视频.mp4'));assert.equal(s.isDownloaded('1'),false);assert.equal(s.isDownloaded('2'),true);
});
test('source and personal tags filter independently and intersect, with any/all per row',()=>{
  const w={...parseWork(raw()),localTags:['待整理'],downloaded:true};
  assert.equal(selectWorks([w],{tags:['cos'],localTags:['待整理']}).length,1);
  assert.equal(selectWorks([w],{tags:['待整理']}).length,0);
  assert.equal(selectWorks([w],{localTags:['cos']}).length,0);
  assert.equal(selectWorks([w],{tags:['cos','不存在'],tagMode:'all'}).length,0);
  assert.equal(selectWorks([w],{tags:['cos','不存在'],tagMode:'any'}).length,1);
  assert.equal(selectWorks([w],{tags:['cos'],localTags:['不存在']}).length,0);
  assert.equal(selectWorks([w],{author:'42',query:'author42'}).length,1);
});

test('folder-only discoveries remain pending in total until total confirms their independent order',async t=>{
  const s=await setup(t);for(const id of ['1','2','3','4','5'])s.upsertWork(raw(id));
  s.discoverCollections([{collects_id:'9',collects_name:'A'}]);s.setAdded(['9']);
  s.ingestMembers(TOTAL,['3','2','1'],true);
  s.ingestMembers('9',['1','4','3'],true);
  assert.deepEqual(s.snapshot().members[TOTAL],['3','2','1','4']);
  assert.deepEqual(s.snapshot().pendingMembers[TOTAL],['4']);
  s.ingestMembers(TOTAL,['5','4','3'],false);
  assert.deepEqual(s.snapshot().members[TOTAL],['5','4','3','2','1']);
  assert.deepEqual(s.snapshot().pendingMembers[TOTAL],[]);
  assert.deepEqual(s.snapshot().members['9'],['1','4','3']);
  s.ingestMembers('9',['2','1'],false);
  assert.deepEqual(s.snapshot().members['9'],['2','1','4','3']);
  assert.deepEqual(s.snapshot().members[TOTAL],['5','4','3','2','1']);
});

test('sparse refresh preserves known identity and missing text, while local tags stay independent',async t=>{
  const s=await setup(t);s.upsertWork(raw());s.put('local_tags','123',{id:'123',tags:['我的分类']});
  s.upsertWork({aweme_id:'123',author:{uid:'42',nickname:'新作者名'}});
  assert.equal(s.work('123').description,'原始文案 #cos #fgo');assert.equal(s.work('123').author.uniqueId,'author42');
  assert.deepEqual(s.snapshot().works[0].localTags,['我的分类']);assert.deepEqual(s.work('123').tags,['cos','fgo']);
});

test('deleting completed queue history preserves library files and does not skip waiting jobs',async t=>{
  const s=await setup(t);for(const id of ['1','2','3'])s.upsertWork(raw(id));localFile(s,'1');
  const q=new DownloadQueue(s,{},async()=>{},()=>{});
  q.jobs=[{id:'1',state:'complete'},{id:'2',state:'waiting'},{id:'3',state:'waiting'}];
  const visited=[];q.saveWork=async job=>{visited.push(job.id);if(job.id==='2')q.clearCompleted(['1','3']);};
  await q.run();assert.deepEqual(visited,['2','3']);assert.equal(s.isDownloaded('1'),true);
  assert.deepEqual(q.jobs.map(j=>j.id),['2','3']);assert.equal(s.download('1').state,'complete');
  q.clearCompleted(['2','3']);assert.equal(q.jobs.length,0);assert.equal(s.getSetting('downloadJobs').length,0);
});
test('download partial completion is retained and retry fetches only the missing asset',async t=>{
  const s=await setup(t);s.upsertWork(raw());let failImage=true;const requests=[];
  const q=new DownloadQueue(s,{resolveWork:async()=>s.work('123')},async url=>{requests.push(url);if(url===cover&&failImage)return new Response('err',{status:403});return new Response(Buffer.from('test-data'),{headers:{'content-type':url===media?'video/mp4':'image/jpeg'}});},()=>{});
  const job={id:'123',title:'测试'};await assert.rejects(q.saveWork(job,new AbortController().signal),/部分已保存/);assert.equal(s.isDownloaded('123'),false);assert.ok(fs.existsSync(path.join(s.download('123').path,'视频.mp4')));failImage=false;await q.saveWork(job,new AbortController().signal);assert.equal(s.isDownloaded('123'),true);assert.equal(requests.filter(x=>x===media).length,1);assert.equal(requests.filter(x=>x===cover).length,2);
});
