import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {filteredSourceState} from '../shared/source-state.mjs';import {Store} from '../electron/store.mjs';import {Collector} from '../electron/account-collector.mjs';import {DownloadQueue} from '../electron/downloads.mjs';
const id='7697291053141527218';
const response=()=>({status_code:0,aweme_detail:null,filter_detail:{aweme_id:id,filter_reason:'status_audit_self_see',detail_msg:'',notice:'',icon:''}});
test('known empty audit self-see response confirms current inaccessibility without claiming deletion',()=>{
 const result=filteredSourceState(response(),id);assert.equal(result?.state,'unavailable');assert.equal(result.reason,'原作品当前不可访问，平台未提供具体原因');
});
test('audit response accepts the matching nested envelope',()=>{assert.equal(filteredSourceState({status_code:0,data:response()},id)?.state,'unavailable');});
test('success status alone and unsupported filter evidence stay uncertain',()=>{
 assert.equal(filteredSourceState({status_code:0,aweme_detail:null},id),null);
 for(const mutate of [r=>r.filter_detail.aweme_id='2',r=>r.filter_detail.filter_reason='unknown_filter',r=>r.status_code=1,r=>delete r.aweme_detail,r=>r.filter_detail.notice='请先登录',r=>r.filter_detail.detail_msg='请稍后重试',r=>r.status_msg='captcha required',r=>r.status_msg='访问太频繁',r=>r.aweme_detail={aweme_id:id,video:{}}]){const data=response();mutate(data);assert.equal(filteredSourceState(data,id),null);}
});
test('confirmed audit response retires only the failed source task and preserves its work record',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-source-audit-')),store=await Store.open(path.join(dir,'library.sqlite'),path.join(dir,'media'));
 t.after(async()=>{await store.fileStates.close();store.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 store.upsertWork({aweme_id:id,desc:'audit fixture',images:[{url_list:['https://p3.douyinpic.com/fixture.jpg']}]});store.setSetting('downloadJobs',[{id,state:'failed',source:'douyin'}]);
 const collector=new Collector(store,()=>{},{profile:{getUserAgent:()=>''},browser:{on(){}},vault:{load:()=>null}});await collector.ready;collector.isAuthenticated=async()=>true;collector.request=async()=>response();
 const queue=new DownloadQueue(store,collector,null,()=>{}),result=await collector.verifySource(id);
 assert.equal(result.state,'unavailable');assert.equal(queue.jobs.find(j=>j.id===id).state,'unavailable');assert.equal(queue.taskRows.page({tab:'failed'}).total,0);assert.ok(store.work(id));
});
