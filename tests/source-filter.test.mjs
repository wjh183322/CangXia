import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../electron/store.mjs';
import {Collector} from '../electron/account-collector.mjs';
import {DownloadQueue} from '../electron/downloads.mjs';
import {planDownloads} from '../electron/download-selection.mjs';
import {exportRecords} from '../electron/backup-model.mjs';

const id='7697574101783645864';
const raw=workId=>({aweme_id:workId,desc:'source-filter fixture',author:{uid:'7',nickname:'fixture'},images:[{url_list:['https://p3.douyinpic.com/fixture.jpg']}]});
// Actual response supplied by the user, with unrelated icon and request trace omitted.
const filtered=(workId=id)=>({aweme_detail:null,filter_detail:{aweme_id:workId,detail_msg:'因作品权限或已被删除，无法观看，去看看其他作品吧',filter_reason:'status_self_see',notice:'抱歉，作品不见了'},status_code:0});
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-source-filter-'));
 const store=await Store.open(path.join(dir,'library.sqlite'),path.join(dir,'media'));
 for(const workId of [id,'2'])store.upsertWork(raw(workId));store.ingestMembers('__all__',[id,'2'],true);
 let reply=filtered();const calls=[];
 const collector=new Collector(store,()=>{},{profile:{getUserAgent:()=>'FixtureBrowser',cookies:{get:async()=>[{name:'sessionid',value:'SYNTHETIC_TEST_SESSION'}]},fetch:async(url,options)=>{calls.push({url,options});return Response.json(reply);}},browser:{on(){}},vault:{load:()=>null}});
 await collector.ready;collector.status.connected=true;
 t.after(async()=>{await store.fileStates.close();store.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 return {store,collector,dir,calls,setReply:value=>{reply=value;}};
}

test('supplied filter_detail response confirms unavailability with its permission-or-deletion evidence',async t=>{
 const f=await fixture(t),result=await f.collector.verifySource(id);
 assert.equal(result.state,'unavailable');assert.equal(result.method,'api');
 assert.match(result.reason,/权限限制或已删除/);assert.match(result.reason,/当前无法观看/);
 assert.ok(!result.reason.includes('确认已删除'));assert.ok(!Number.isNaN(Date.parse(result.checkedAt)));
 assert.equal(f.store.work(id).remoteState,'unavailable');
 assert.notEqual(f.store.getSetting('authNeedsRefresh'),true);assert.equal(f.collector.status.connected,true);
 assert.equal(f.calls.length,1);assert.equal(new URL(f.calls[0].url).searchParams.get('aweme_id'),id);
 assert.deepEqual(f.store.orderedMemberRows('__all__').map(r=>r.work_id),[id,'2']);
});

const uncertain=[
 ['empty detail without filter',()=>({status_code:0,aweme_detail:null})],
 ['another work ID',()=>filtered('2')],
 ['missing work ID',()=>{const d=filtered();delete d.filter_detail.aweme_id;return d;}],
 ['unrecognized filter reason and message',()=>{const d=filtered();d.filter_detail.filter_reason='unverified_reason';d.filter_detail.detail_msg='平台未提供可判断的作品状态';return d;}],
 ['login challenge',()=>{const d=filtered();d.filter_detail.detail_msg='请登录后观看作品';return d;}],
 ['captcha',()=>{const d=filtered();d.filter_detail.detail_msg='请完成验证码后观看';return d;}],
 ['ambiguous permission hint',()=>{const d=filtered();d.filter_detail.detail_msg='可能是作品权限问题，请稍后重试';return d;}],
 ['missing disappearance notice',()=>{const d=filtered();delete d.filter_detail.notice;return d;}],
 ['nonzero business status',()=>({...filtered(),status_code:42})],
 ['no explicit success code',()=>{const d=filtered();delete d.status_code;return d;}],
 ['top-level login warning',()=>({...filtered(),status_msg:'请登录后观看'})],
 ['nested nonzero business status',()=>({status_code:0,data:{...filtered(),status_code:42}})],
 ['detail for another work',()=>({...filtered(),aweme_detail:raw('2')})],
];
for(const [name,reply]of uncertain)test('filter response stays unknown for '+name,async t=>{
 const f=await fixture(t);f.setReply(reply());const result=await f.collector.verifySource(id);
 assert.equal(result.state,'unknown');assert.notEqual(f.store.work(id).remoteState,'unavailable');assert.notEqual(f.store.work('2').remoteState,'unavailable');
});

test('matching available detail takes precedence over stale filter information',async t=>{
 const f=await fixture(t);f.setReply({...filtered(),aweme_detail:raw(id)});
 assert.equal((await f.collector.verifySource(id)).state,'available');
});

test('nested filter response is bound to its own success code and work ID',async t=>{
 const f=await fixture(t);f.setReply({status_code:0,data:filtered()});
 assert.equal((await f.collector.verifySource(id)).state,'unavailable');
});

test('filtered unavailable works retire failed tasks and skip normal repair selection',async t=>{
 const f=await fixture(t);f.store.setSetting('downloadJobs',[{id,state:'failed',source:'douyin'},{id:'2',state:'waiting',source:'douyin'}]);
 const queue=new DownloadQueue(f.store,f.collector,null,()=>{});queue.run=async()=>{};const pausedBefore=queue.paused;
 await f.collector.verifySource(id);
 assert.equal(queue.taskRows.page({tab:'unavailable'}).total,1);assert.equal(queue.taskRows.page({tab:'failed'}).total,0);
 assert.equal(queue.jobs.find(j=>j.id==='2').state,'waiting');assert.equal(queue.paused,pausedBefore);
 assert.equal(planDownloads(f.store,queue,[id]).report.unavailable,1);assert.equal(queue.enqueue([id]),0);
 // Ordinary list refresh cannot clear the evidence; explicit positive verification can.
 f.store.upsertWork(raw(id));assert.equal(f.store.work(id).remoteState,'unavailable');
 f.setReply({status_code:0,aweme_detail:raw(id)});await f.collector.verifySource(id);
 assert.equal(queue.jobs.find(j=>j.id===id).state,'failed');assert.equal(f.store.work(id).remoteState,'available');
});

test('filter verification retains complete files, completed history, NAS copies and exportable evidence',async t=>{
 const f=await fixture(t),mediaDir=f.store.destination(id).dir;fs.mkdirSync(mediaDir,{recursive:true});
 const bytes=Buffer.from('previously saved media');fs.writeFileSync(path.join(mediaDir,'fixture.jpg'),bytes);
 f.store.put('downloads',id,{id,path:mediaDir,state:'complete',assets:[{key:'image-0',kind:'image',file:'fixture.jpg',size:bytes.length}]});
 f.store.put('works',id,{...f.store.work(id),backupMedia:{fixture:'existing NAS metadata'}});
 f.store.setSetting('downloadJobs',[{id,state:'complete',source:'douyin'}]);
 const queue=new DownloadQueue(f.store,f.collector,null,()=>{});await f.collector.verifySource(id);
 assert.equal(queue.jobs.find(j=>j.id===id).state,'complete');assert.equal(f.store.download(id).state,'complete');
 assert.deepEqual(fs.readFileSync(path.join(mediaDir,'fixture.jpg')),bytes);assert.deepEqual(f.store.work(id).backupMedia,{fixture:'existing NAS metadata'});
 assert.match(exportRecords(f.store).find(e=>e.table==='works'&&e.key===id).body.sourceStatus.reason,/权限限制或已删除/);
});

test('filter response discovered while downloading retires only the target and continues the queue',async t=>{
 const f=await fixture(t);f.setReply(filtered());
 const queue=new DownloadQueue(f.store,f.collector,async()=>new Response('fixture'),()=>{});
 f.store.fileStates.confirmWritten=async()=>true;
 queue.saveResources=async job=>{if(job.id===id)throw Object.assign(Error('expired media'),{refreshable:true});};
 queue.enqueue([id,'2']);await queue.waitForIdle();
 assert.equal(queue.jobs.find(j=>j.id===id).state,'unavailable');assert.equal(queue.jobs.find(j=>j.id==='2').state,'complete');
 assert.equal(queue.paused,false);assert.equal(queue.taskRows.page({tab:'failed'}).total,0);
 assert.match(f.store.work(id).sourceStatus.reason,/权限限制或已删除/);
});
