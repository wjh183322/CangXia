import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../electron/store.mjs';
import {Collector} from '../electron/account-collector.mjs';
import {DownloadQueue} from '../electron/downloads.mjs';
import {planDownloads} from '../electron/download-selection.mjs';
import {filteredSourceState} from '../shared/source-state.mjs';

// User-supplied responses. Unrelated icons and request traces are omitted.
const samples=[
 {name:'friend-visibility',id:'7689008683628901478',reason:'status_friend_see',message:'由于对方隐私设置，无法查看，去看看其他作品吧',notice:'作品暂时无法查看',expected:/隐私限制/},
 {name:'partial-visibility',id:'7590781747764989413',reason:'status_part_see',message:'由于对方隐私设置，无法查看，去看看其他作品吧',notice:'作品暂时无法查看',expected:/隐私限制/},
 {name:'deleted-status',id:'7684245301557820859',reason:'status_deleted',message:'因作品权限或已被删除，无法观看，去看看其他作品吧',notice:'抱歉，作品不见了',expected:/权限限制或已删除/},
];
for(const sample of samples){
const {id,name}=sample,response=()=>({aweme_detail:null,filter_detail:{aweme_id:id,detail_msg:sample.message,filter_reason:sample.reason,notice:sample.notice},status_code:0});

test('supplied '+name+' JSON confirms current inaccessibility without claiming permanent deletion',()=>{
 const result=filteredSourceState(response(),id);assert.equal(result?.state,'unavailable');assert.match(result.reason,sample.expected);assert.doesNotMatch(result.reason,/确认已删除|永久/);
 assert.equal(filteredSourceState({status_code:0,data:response()},id)?.state,'unavailable');
});

test(name+' JSON cannot override wrong IDs, failed requests or access warnings',()=>{
 for(const mutate of [r=>r.filter_detail.aweme_id='2',r=>r.status_code=8,r=>delete r.status_code,r=>delete r.aweme_detail,r=>r.filter_detail.notice='请完成安全验证',r=>r.filter_detail.detail_msg='请登录后查看',r=>{r.status_msg='success';r.message='请先登录';},r=>r.data={status_code:8},r=>r.aweme_detail={aweme_id:id,images:[]},r=>r.filter_detail.detail_msg='平台没有提供可判断的作品状态',r=>r.filter_detail.filter_reason='captcha_required']){
  const data=response();mutate(data);assert.equal(filteredSourceState(data,id),null);
 }
});

test(name+' JSON retires only the failed task and retains records, files and NAS metadata',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-source-friend-')),store=await Store.open(path.join(dir,'library.sqlite'),path.join(dir,'media'));
 let collector;t.after(async()=>{await collector?.dispose();await store.fileStates.close();store.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 for(const key of [id,'2'])store.upsertWork({aweme_id:key,desc:'privacy fixture',images:[{url_list:['https://p3.douyinpic.com/fixture.jpg']}]});store.ingestMembers('__all__',[id,'2'],true);
 const file=path.join(dir,'retained.jpg');fs.writeFileSync(file,'previous media');store.put('works',id,{...store.work(id),backupMedia:{retained:true}});
 let reply=response(),pageCalls=0;collector=new Collector(store,()=>{},{profile:{getUserAgent:()=>''},browser:{on(){},close:async()=>{},verifyWorkPage:async()=>{pageCalls++;throw Error('unexpected webpage verification');}},vault:{load:()=>null}});await collector.ready;collector.isAuthenticated=async()=>true;collector.request=async()=>reply;
 const queue=new DownloadQueue(store,collector,null,()=>{});queue.jobs=[{id,state:'failed',source:'douyin'},{id:'2',state:'failed',source:'douyin'}];queue.emit(true);
 const result=await collector.verifySource(id);assert.equal(result.state,'unavailable');assert.equal(result.method,'api');assert.equal(pageCalls,0);
 assert.equal(queue.jobs.find(job=>job.id===id).state,'unavailable');assert.equal(queue.jobs.find(job=>job.id==='2').state,'failed');assert.equal(planDownloads(store,queue,[id]).report.unavailable,1);
 assert.deepEqual(store.orderedMemberRows('__all__').map(row=>row.work_id),[id,'2']);assert.equal(fs.readFileSync(file,'utf8'),'previous media');assert.deepEqual(store.work(id).backupMedia,{retained:true});
 reply={status_code:0,aweme_detail:{aweme_id:id,images:[{url_list:['https://p3.douyinpic.com/fixture.jpg']}]}};
 assert.equal((await collector.verifySource(id)).state,'available');assert.equal(queue.jobs.find(job=>job.id===id).state,'failed');assert.equal(queue.running,false);
});
test(name+' clear platform text remains evidence when its reason code changes',()=>{const data=response();data.filter_detail.filter_reason='new_unlisted_reason';assert.equal(filteredSourceState(data,id)?.state,'unavailable');});
}
