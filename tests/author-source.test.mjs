import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';
import {Store} from '../electron/store.mjs';import {Collector} from '../electron/account-collector.mjs';import {AuthorReader} from '../electron/author-reader.mjs';
import {authorId,resolveAuthorLink} from '../electron/author-sources.mjs';import {apiRequest} from '../electron/browser-api.mjs';import {SnapshotFeed} from '../electron/snapshot-feed.mjs';import {mergeState} from '../electron/state-patch.mjs';import {DownloadQueue} from '../electron/downloads.mjs';
const ID='MS4wLjABAAAA_SYNTHETIC_AUTHOR',OTHER='MS4wLjABAAAA_OTHER_AUTHOR';
const raw=(n,who=ID)=>({aweme_id:String(n),desc:'作者测试 '+n,author:{uid:who===ID?'777':'888',sec_uid:who,nickname:'示例作者'},images:[{url_list:['https://p3.douyinpic.com/synthetic.jpg']}],create_time:1000+Number(n)});
const page=(items,more=0,cursor='0')=>({status_code:0,aweme_list:items,has_more:more,max_cursor:cursor});
async function fixture(t,fetcher){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-author-test-')),file=path.join(root,'library.sqlite');const store=await Store.open(file,path.join(root,'media'));store.setSetting('browserAccountKey','uid:123');
  const browser=new EventEmitter();browser.close=async()=>{};let cookies=[{name:'sessionid',value:'TEST_ONLY'}];
  const calls=[];const profile={getUserAgent:()=> 'Fixture',cookies:{get:async()=>cookies,set:async c=>cookies.push(c)},clearStorageData:async()=>{},setUserAgent(){},fetch:async(url,o)=>{calls.push(new URL(url));if(new URL(url).pathname==='/aweme/v1/web/user/profile/other/')return Response.json({status_code:0,user:{uid:'777',sec_uid:ID,nickname:'示例作者',unique_id:'fixture',aweme_count:999}});return fetcher(new URL(url),o);}};
  const collector=new Collector(store,()=>{},{profile,browser,vault:{load:()=>null},delay:async()=>{}});await collector.ready;collector.status.connected=true;
  const reader=new AuthorReader(collector);await reader.add(`https://www.douyin.com/user/${ID}`);
  t.after(async()=>{await collector.dispose();store.close();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});return {root,file,store,collector,reader,calls};
}
test('author links accept share redirects but reject unrelated hosts credentials and work links',async()=>{
  assert.equal(authorId(ID),ID);for(const id of ['self','../bad','123',ID+'/x'])assert.throws(()=>authorId(id));
  const r=await resolveAuthorLink('作者主页 https://v.douyin.com/fixture/ 分享文案',async()=>new Response(null,{status:302,headers:{location:`https://www.douyin.com/user/${ID}?from=share`}}));assert.equal(r.id,ID);
  for(const text of [`https://www.douyin.com.evil.test/user/${ID}`,`https://user@www.douyin.com/user/${ID}`,`https://www.douyin.com:444/user/${ID}`,'https://www.douyin.com/video/123'])await assert.rejects(resolveAuthorLink(text,async()=>{throw Error('must not fetch');}));
  let calls=0;await assert.rejects(resolveAuthorLink('https://v.douyin.com/fixture/',async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/secret'}});}));assert.equal(calls,1);
});
test('new browser routes are read-only and retain precise author IDs',()=>{
  for(const route of ['/aweme/v1/web/user/profile/other/','/aweme/v1/web/aweme/post/']){assert.equal(new URL(apiRequest(route,{params:{sec_user_id:ID}}).url).searchParams.get('sec_user_id'),ID);assert.throws(()=>apiRequest(route,{method:'POST'}));}
});
test('20-item limit includes known works, then resumes the same page without losing the remaining ten',async t=>{
  const f=await fixture(t,async()=>Response.json(page(Array.from({length:30},(_,i)=>raw(i+1)))));
  f.store.upsertWork(raw(1));f.store.ingestMembers('__all__',['1'],true);const before=JSON.stringify(f.store.snapshot().members);
  const first=await f.reader.read({id:ID,limit:20});assert.equal(first.processed,20);assert.equal(first.complete,false);assert.equal(f.store.authorSources.get(ID).run.nextCursor,'0');assert.equal(f.store.snapshot().authorMembers[ID].length,20);
  const second=await f.reader.read({id:ID,limit:20,resume:true});assert.equal(second.processed,10);assert.equal(second.complete,true);assert.deepEqual(f.store.snapshot().authorMembers[ID],Array.from({length:30},(_,i)=>String(i+1)));assert.equal(JSON.stringify(f.store.snapshot().members),before);
  const third=await f.reader.read({id:ID,limit:20});assert.equal(third.processed,20);assert.equal(third.added,0);assert.equal(f.store.snapshot().authorMembers[ID].length,30);
});
test('repeated pinned posts deduplicate, and reading an existing first item does not hide later new works',async t=>{
  let round=0;const f=await fixture(t,async url=>Response.json(url.searchParams.get('max_cursor')==='0'?page([raw(1),raw(round?4:2)],1,'30'):page([raw(1),raw(3)],0,'60')));
  await f.reader.read({id:ID,readAll:true});round=1;const result=await f.reader.read({id:ID,readAll:true});assert.equal(result.added,1);assert.deepEqual(f.store.snapshot().authorMembers[ID],['1','4','2','3']);assert.equal(f.collector.status.readSummary.filled,1);assert.equal(f.collector.status.readSummary.notReturned,1);assert.equal(f.store.snapshot().members.__all__.length,0);
});
test('403 preserves prior page and durable checkpoint; relogin resumes from that page',async t=>{
  let fail=true;const f=await fixture(t,async url=>url.searchParams.get('max_cursor')==='0'?Response.json(page([raw(1)],1,'30')):fail?new Response('blocked',{status:403}):Response.json(page([raw(2)])));
  await assert.rejects(f.reader.read({id:ID,readAll:true}),/403/);assert.equal(f.collector.status.needsLogin,true);assert.deepEqual(f.store.snapshot().authorMembers[ID],['1']);assert.equal(f.store.authorSources.get(ID).run.nextCursor,'30');assert.equal(f.collector.busy,false);
  fail=false;f.collector.status.connected=true;await f.reader.read({id:ID,resume:true,readAll:true});assert.deepEqual(f.calls.filter(u=>u.pathname.endsWith('/post/')).map(u=>u.searchParams.get('max_cursor')),['0','30','30']);
});
test('malformed or wrong-author page rolls back all its works and does not advance cursor',async t=>{
  const f=await fixture(t,async()=>Response.json(page([raw(1),raw(2,OTHER)])));
  await assert.rejects(f.reader.read({id:ID,readAll:true}),/核实作者/);assert.equal(f.store.work('1'),null);assert.equal(f.store.work('2'),null);assert.equal(f.store.authorSources.get(ID).run.nextCursor,'0');
});
test('missing pagination, empty continuation and cursor loops are not reported complete',async t=>{
  let mode=0;const f=await fixture(t,async()=>Response.json(mode===0?{aweme_list:[raw(1)]}:mode===1?page([],1,'30'):page([raw(1)],1,'0')));
  await assert.rejects(f.reader.read({id:ID,readAll:true}),/分页/);assert.notEqual(f.store.authorSources.get(ID).run.status,'complete');mode=1;
  await assert.rejects(f.reader.read({id:ID,readAll:true}),/本页为空/);mode=2;await assert.rejects(f.reader.read({id:ID,readAll:true}),/重复/);assert.equal(f.store.authorSources.snapshot().authors[0].run.canResume,false);
});
test('stop aborts the in-flight page, prevents logout while running, and preserves completed pages',async t=>{
  let arrived;const waiting=new Promise(r=>arrived=r);const f=await fixture(t,async(url,o)=>{if(url.searchParams.get('max_cursor')==='0')return Response.json(page([raw(1)],1,'30'));arrived();return new Promise((_resolve,reject)=>o.signal.addEventListener('abort',()=>reject(o.signal.reason),{once:true}));});
  const running=f.reader.read({id:ID,readAll:true});await waiting;await assert.rejects(f.collector.logout(),/先停止/);f.collector.stop();assert.equal((await running).stopped,true);assert.equal(f.collector.busy,false);assert.deepEqual(f.store.snapshot().authorMembers[ID],['1']);assert.equal(f.store.authorSources.get(ID).run.nextCursor,'30');
});
test('store reopen recovers interrupted author run and forbids cross-account continuation',async t=>{
  const f=await fixture(t,async()=>Response.json(page([raw(1)])));const a=f.store.authorSources.start(ID);f.store.authorSources.apply(a,{items:[raw(1)],next:'30',complete:false});
  const second=await Store.open(f.file,path.join(f.root,'media'));try{assert.equal(second.authorSources.get(ID).run.status,'paused');assert.equal(second.authorSources.get(ID).run.nextCursor,'30');assert.deepEqual(second.snapshot().authorMembers[ID],['1']);second.setSetting('browserAccountKey','uid:456');assert.throws(()=>second.authorSources.start(ID,{resume:true}),/无法续读/);}finally{second.close();}
});
test('author downloads use their own folder and never move an existing collected download',async t=>{
  const f=await fixture(t,async()=>Response.json(page([raw(1),raw(2)])));f.store.upsertWork(raw(1));f.store.ingestMembers('__all__',['1'],true);
  const collected=f.store.destination('1');f.store.put('downloads','1',{id:'1',collectionId:collected.collectionId,path:collected.dir,assets:[]});
  await f.reader.read({id:ID,readAll:true});assert.equal(f.store.destination('1').dir,collected.dir);const d=f.store.destination('2');assert.equal(d.collectionId,'author:'+ID);assert.ok(d.dir.includes('作者作品'));
  f.store.put('downloads','2',{id:'2',collectionId:d.collectionId,path:d.dir,assets:[]});f.store.ingestMembers('__all__',['2','1'],true);assert.equal(f.store.destination('2').dir,d.dir);
});
test('normal download skips an already complete author file and maintains one copy across sources',async t=>{
  const f=await fixture(t,async()=>Response.json(page([raw(1)])));await f.reader.read({id:ID,readAll:true});const target=f.store.destination('1');fs.mkdirSync(target.dir,{recursive:true});const file=path.join(target.dir,'图片-001.jpg');fs.writeFileSync(file,Buffer.from([1,2,3]));const meta=path.join(target.dir,'作品信息.json');fs.writeFileSync(meta,'{}');f.store.put('downloads','1',{id:'1',path:target.dir,collectionId:target.collectionId,state:'complete',assets:[{key:'image-0',file:path.basename(file),kind:'image',size:3},{key:'metadata',file:path.basename(meta),kind:'metadata',size:2}]});
  let requests=0;const queue=new DownloadQueue(f.store,{resolveWork:async()=>{requests++;throw Error('no network');}},async()=>{requests++;throw Error('no network');},()=>{});await queue.saveWork({id:'1'},new AbortController().signal);assert.equal(requests,0);
});
test('author membership updates use delta patches and never alter favorites in the renderer',async t=>{
  const f=await fixture(t,async()=>Response.json(page([raw(1)])));const feed=new SnapshotFeed(f.store),initial=feed.frame({}, {full:true});await f.reader.read({id:ID,readAll:true});const delta=feed.frame({});assert.ok(delta.membershipPatches.authorMembers[ID]);const next=mergeState(initial,delta);assert.deepEqual(next.authorMembers[ID],['1']);assert.deepEqual(next.members,initial.members);
});
