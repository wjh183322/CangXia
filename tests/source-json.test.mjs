import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../electron/store.mjs';
import {Collector} from '../electron/account-collector.mjs';
import {SystemBrowser} from '../electron/system-browser.mjs';
import {DownloadQueue} from '../electron/downloads.mjs';
import {planDownloads} from '../electron/download-selection.mjs';
import {filteredSourceState} from '../shared/source-state.mjs';

const id='7682371267983207909',noteId='7698014329241074098',privacyId='7689049403798024377';
// Supplied negative response and researched positive types; no credentials or signed URLs.
const empty=(key=id)=>({status_code:0,aweme_detail:null,filter_detail:{aweme_id:key,filter_reason:''}});
const raw=(key=id)=>({aweme_id:key,aweme_type:key===noteId?68:0,desc:'JSON source fixture',author:{uid:'7',nickname:'fixture'},...(key===noteId?{images:[{url_list:['https://p3.douyinpic.com/fixture.jpg']}]}:{video:{play_addr:{url_list:['https://v3-web.douyinvod.com/fixture.mp4']}}})});
const privacy=()=>({status_code:0,aweme_detail:null,filter_detail:{aweme_id:privacyId,filter_reason:'author_secret',detail_msg:'由于对方隐私设置，无法查看，去看看其他作品吧',notice:'作品暂时无法查看'}});

test('matching successful empty filter confirms current inaccessibility without a removal claim',()=>{
 const result=filteredSourceState(empty(),id);
 assert.equal(result?.state,'unavailable');assert.match(result.reason,/当前不可访问/);assert.doesNotMatch(result.reason,/已删除|永久/);
 assert.equal(filteredSourceState({status_code:0,data:empty()},id)?.state,'unavailable');
 assert.equal(filteredSourceState({...empty(),status_code:'0'},id)?.state,'unavailable');
 assert.equal(filteredSourceState({...empty(),status_msg:'success',message:'OK'},id)?.state,'unavailable');
 assert.equal(filteredSourceState(empty(noteId),noteId)?.state,'unavailable');
});

for(const [name,mutate] of [
 ['missing detail field',r=>delete r.aweme_detail],
 ['missing filter',r=>delete r.filter_detail],
 ['missing filter reason',r=>delete r.filter_detail.filter_reason],
 ['null filter reason',r=>r.filter_detail.filter_reason=null],
 ['unrecognized filter reason',r=>r.filter_detail.filter_reason='unknown_filter'],
 ['another ID',r=>r.filter_detail.aweme_id=noteId],
 ['numeric ID',r=>r.filter_detail.aweme_id=Number(id)],
 ['missing success status',r=>delete r.status_code],
 ['business error',r=>r.status_code=8],
 ['filter login message',r=>r.filter_detail.detail_msg='请登录后查看'],
 ['filter challenge notice',r=>r.filter_detail.notice='请完成安全验证'],
 ['top-level login warning',r=>r.status_msg='login required'],
 ['nested rate warning',r=>r.data={message:'访问太频繁'}],
 ['retry warning',r=>r.message='请稍后重试'],
 ['unrecognized notice',r=>r.filter_detail.notice='unrecognized access notice'],
 ['positive detail',r=>r.aweme_detail=raw()],
 ['login hidden behind success text',r=>{r.status_msg='success';r.message='请登录后查看';}],
 ['nested challenge hidden behind success text',r=>{r.status_msg='success';r.data={message:'请完成验证码'};}],
 ['generic verification prompt',r=>r.status_msg='请完成验证'],
 ['server error and retry',r=>r.status_msg='系统异常，请重试'],
 ['unknown status message',r=>r.status_msg='unexpected platform response'],
])test('empty filter remains uncertain for '+name,()=>{
 const reply=empty();mutate(reply);assert.equal(filteredSourceState(reply,id),null);
});

test('nested empty filters reject conflicting business failures and positive details',()=>{
 assert.equal(filteredSourceState({status_code:8,data:empty()},id),null);
 assert.equal(filteredSourceState({status_code:0,data:{...empty(),status_code:8}},id),null);
 assert.equal(filteredSourceState({status_code:0,aweme_detail:raw(),data:empty()},id),null);
 assert.equal(filteredSourceState({...empty(),data:{status_code:8}},id),null);
 assert.equal(filteredSourceState({...empty(),data:{...empty(),status_code:8}},id),null);
 assert.equal(filteredSourceState({...empty(),data:empty(noteId)},id),null);
});

test('known privacy evidence remains supported without claiming permanent deletion',()=>{
 const result=filteredSourceState(privacy(),privacyId);assert.equal(result?.state,'unavailable');assert.match(result.reason,/隐私/);assert.doesNotMatch(result.reason,/已删除/);
 for(const change of [r=>r.filter_detail.aweme_id=id,r=>r.status_code=1,r=>r.status_msg='请登录后查看',r=>r.filter_detail.notice='请完成验证码',r=>r.aweme_detail=raw(privacyId)]){
  const value=privacy();change(value);assert.equal(filteredSourceState(value,privacyId),null);
 }
});

async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-source-json-')),store=await Store.open(path.join(dir,'library.sqlite'),path.join(dir,'media'));
 for(const key of [id,noteId,privacyId])store.upsertWork(raw(key));store.ingestMembers('__all__',[id,noteId,privacyId],true);store.setSetting('browserAccountKey','uid:7');
 const browser=new EventEmitter(),cookies=[{name:'sessionid',domain:'.douyin.com',path:'/',value:'SYNTHETIC_SESSION'}];let pageCalls=0,reply=empty();const requests=[];
 browser.api={credentials:async()=>cookies};browser.verifyWorkPage=async()=>{pageCalls++;throw Error('unexpected webpage verification');};browser.close=async()=>{};
 const collector=new Collector(store,()=>{},{profile:{getUserAgent:()=>''},browser,vault:{load:()=>null}});await collector.ready;
 collector.status.connected=true;collector.isAuthenticated=async()=>true;collector.requestMode='browser';collector.browserBinding={page:{},fingerprint:collector.browserFingerprint(cookies),uid:'7'};
 collector.request=async(route,options)=>{requests.push({route,id:options.params.aweme_id});options.signal?.throwIfAborted();return typeof reply==='function'?reply(options):reply;};
 const queue=new DownloadQueue(store,collector,null,()=>{});queue.jobs=[{id,state:'failed',source:'douyin'},{id:noteId,state:'failed',source:'douyin'}];queue.emit(true);
 t.after(async()=>{await collector.dispose();await store.fileStates.close();store.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 return {store,collector,queue,requests,dir,setReply:value=>reply=value,get pageCalls(){return pageCalls;}};
}

test('JSON-only verification retires the failed work without changing files, NAS data or reading records',async t=>{
 const f=await fixture(t),file=path.join(f.dir,'retained.mp4');fs.writeFileSync(file,'retained media');f.store.put('works',id,{...f.store.work(id),backupMedia:{retained:true}});
 const result=await f.collector.verifySource(id);
 assert.equal(result.state,'unavailable');assert.equal(result.method,'api');assert.equal(f.pageCalls,0);assert.equal(f.requests.length,1);
 assert.equal(f.queue.jobs.find(j=>j.id===id).state,'unavailable');assert.equal(f.queue.jobs.find(j=>j.id===noteId).state,'failed');
 assert.deepEqual(f.store.orderedMemberRows('__all__').map(r=>r.work_id),[id,noteId,privacyId]);assert.equal(fs.readFileSync(file,'utf8'),'retained media');assert.deepEqual(f.store.work(id).backupMedia,{retained:true});
 assert.equal(planDownloads(f.store,f.queue,[id]).report.unavailable,1);assert.equal(f.queue.enqueue([id]),0);
});

test('later positive video and note JSON restore availability without restarting their failed tasks',async t=>{
 const f=await fixture(t);
 for(const key of [id,noteId]){
  f.collector.markUnavailable(key,{method:'api'});f.setReply({status_code:0,aweme_detail:raw(key)});
  const result=await f.collector.verifySource(key);assert.equal(result.state,'available');assert.equal(result.method,'api');assert.equal(f.store.work(key).remoteState,'available');
  assert.equal(f.queue.jobs.find(j=>j.id===key).state,'failed');
 }
 assert.equal(f.pageCalls,0);assert.equal(f.queue.running,false);
});

test('unsupported or failed JSON remains unknown without any page fallback or lost prior evidence',async t=>{
 const f=await fixture(t);f.collector.markUnavailable(id,{reason:'previous confirmed evidence',method:'api'});
 for(const reply of [{status_code:0,aweme_detail:null},{...empty(),filter_detail:{aweme_id:noteId,filter_reason:''}},{...empty(),status_msg:'请先登录'},()=>{throw Error('network timeout');}]){
  f.setReply(reply);const result=await f.collector.verifySource(id);assert.equal(result.state,'unknown');assert.equal(result.method,'api');
  assert.equal(f.store.work(id).sourceStatus.reason,'previous confirmed evidence');
 }
 assert.equal(f.pageCalls,0);assert.equal(f.collector.waiters.size,0);
});

test('conflicting JSON messages or wrappers cannot retire an available work or its failed task',async t=>{
 const f=await fixture(t);
 for(const reply of [{...empty(),status_msg:'success',message:'请登录后查看'},{...empty(),status_msg:'success',data:{message:'请完成验证码'}},{...empty(),data:{status_code:8}},{...empty(),data:empty(noteId)}]){
  f.setReply(reply);assert.equal((await f.collector.verifySource(id)).state,'unknown');assert.notEqual(f.store.work(id).remoteState,'unavailable');assert.equal(f.queue.jobs.find(j=>j.id===id).state,'failed');
 }
 assert.equal(f.pageCalls,0);
});

test('cancelling an in-flight JSON request cannot mark the work unavailable or retain its waiter',async t=>{
 const f=await fixture(t),controller=new AbortController();let started;const ready=new Promise(resolve=>started=resolve);
 f.setReply(({signal})=>{started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
 const pending=f.collector.verifySource(id,{signal:controller.signal});await ready;controller.abort();await assert.rejects(pending);
 assert.notEqual(f.store.work(id).remoteState,'unavailable');assert.equal(f.pageCalls,0);assert.equal(f.collector.waiters.size,0);
});

test('empty JSON discovered during a download retires only the target and continues the queue',async t=>{
 const f=await fixture(t);f.queue.saveResources=async job=>{if(job.id===id)throw Object.assign(Error('expired media'),{refreshable:true});};f.store.fileStates.confirmWritten=async()=>true;
 f.queue.jobs=[];f.queue.enqueue([id,noteId]);await f.queue.waitForIdle();
 assert.equal(f.queue.jobs.find(j=>j.id===id).state,'unavailable');assert.equal(f.queue.jobs.find(j=>j.id===noteId).state,'complete');
 assert.equal(f.queue.paused,false);assert.equal(f.queue.taskRows.page({tab:'failed'}).total,0);assert.equal(f.pageCalls,0);
});

test('the system browser no longer exposes the removed webpage verification feature',()=>{
 assert.equal(SystemBrowser.prototype.verifyWorkPage,undefined);
});
