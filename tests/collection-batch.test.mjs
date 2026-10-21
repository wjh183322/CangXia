import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../electron/store.mjs';import {Collector} from '../electron/account-collector.mjs';
const raw=id=>({aweme_id:id,desc:'批量作品 '+id,author:{uid:'7',nickname:'作者'}});
async function fixture(t,request){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx-collection-batch-')),store=await Store.open(path.join(root,'library.sqlite'),path.join(root,'media'));store.setSetting('browserAccountKey','uid:1');
 store.discoverCollections([{collects_id:'10',collects_name:'同名夹'},{collects_id:'20',collects_name:'同名夹'},{collects_id:'30',collects_name:'未添加夹'}]);store.setAdded(['10','20']);
 let onChange=()=>{};const c=new Collector(store,()=>onChange(),{profile:{},vault:{load:()=>null},browser:{},delay:async()=>{}});await c.ready;c.status.connected=true;c.isAuthenticated=async()=>true;
 const calls=[];c.request=async(route,options)=>{calls.push({route,...options});return request?request(calls.at(-1),c,store):{aweme_list:[raw(options.params?.collects_id==='10'?'101':'102')],has_more:0,cursor:'0'};};
 t.after(async()=>{clearTimeout(c.browserIdle);await store.fileStates.close();store.close();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 return {store,c,calls,onChange:fn=>onChange=fn};
}
test('one sync reads only added custom folders in order, with separate checkpoints and logs',async t=>{
 const {store,c,calls}=await fixture(t);await c.sync({allAdded:true,mode:'quick',allowFullScan:true});
 assert.deepEqual(calls.map(x=>x.params?.collects_id),['10','20']);assert.ok(calls.every(x=>x.route==='/aweme/v1/web/collects/video/list/'));
 assert.equal(store.collectionReads.get('__all__','quick'),null);assert.equal(store.collectionReads.info('30').quick,null);
 for(const id of ['10','20'])assert.equal(store.collectionReads.info(id).quick.status,'complete');
 assert.equal(store.readHistory.runs({}).total,2);const batch=c.status.collectionBatch;assert.equal(batch.running,false);assert.equal(batch.succeeded,2);assert.equal(batch.pending,0);assert.equal(batch.items.length,2);
});
test('quick batch requires one explicit full-scan acknowledgement before requesting any folder',async t=>{
 const {c,calls}=await fixture(t);await assert.rejects(c.sync({allAdded:true,mode:'quick'}),/历史对照/);assert.equal(calls.length,0);assert.equal(c.busy,false);
});
test('quick batch uses reliable folder baselines and stops after ordered overlap',async t=>{
 const {c,store,calls}=await fixture(t,async opts=>{const start=Number(opts.params.cursor),items=Array.from({length:30},(_,i)=>raw(String(1000+start+i)));return {aweme_list:items,has_more:1,cursor:String(start+30)};});
 for(const id of ['10','20']){const run=store.collectionReads.start(id,'full');store.collectionReads.apply(run,{items:Array.from({length:90},(_,i)=>raw(String(1000+i))),complete:true,next:null});}
 await c.sync({allAdded:true,mode:'quick'});assert.equal(calls.length,4);assert.equal(c.status.collectionBatch.succeeded,2);assert.equal(c.status.collectionBatch.mode,'quick');
});
test('full batch retains historical members, deduplicates works and preserves saved files',async t=>{
 const {c,store}=await fixture(t,async()=>({aweme_list:[raw('500')],has_more:0,cursor:'0'}));store.upsertWork(raw('999'));store.ingestMembers('10',['999'],true);
 const saved=path.join(store.root,'keep.mp4');fs.mkdirSync(store.root,{recursive:true});fs.writeFileSync(saved,'keep');store.put('backup_downloads','999',{id:'999',assets:[{key:'video',hash:'fixture'}]});
 await c.sync({allAdded:true,mode:'full'});assert.equal(store.all('works').filter(w=>w.id==='500').length,1);assert.ok(store.collectionReads.membership('10').some(r=>r.work_id==='999'));assert.equal(fs.readFileSync(saved,'utf8'),'keep');assert.equal(store.get('backup_downloads','999').assets[0].hash,'fixture');assert.equal(c.status.collectionBatch.succeeded,2);
});
test('a folder error does not prevent the next folder, and results retain the reason',async t=>{
 const {c,calls}=await fixture(t,async opts=>{if(opts.params.collects_id==='10')throw Error('单夹响应异常');return {aweme_list:[],has_more:0,cursor:'0'};});
 await c.sync({allAdded:true,mode:'full'});assert.equal(calls.length,2);assert.equal(c.status.collectionBatch.failed,1);assert.equal(c.status.collectionBatch.succeeded,1);assert.match(c.status.collectionBatch.items[0].message,/单夹响应异常/);
});
test('stopping between folders prevents the next folder from starting',async t=>{
 const f=await fixture(t);let stopped=false;f.onChange(()=>{if(!stopped&&f.c.status.collectionBatch?.succeeded===1){stopped=true;f.c.stop();}});await f.c.sync({allAdded:true,mode:'full'});
 assert.equal(f.calls.length,1);assert.equal(f.c.status.collectionBatch.pending,1);assert.equal(f.c.status.collectionBatch.phase,'stopped');assert.equal(f.store.collectionReads.info('10').full.status,'complete');
});
test('a late page after stop is discarded and remaining folders stay pending',async t=>{
 const {c,store,calls}=await fixture(t,async(_opts,c)=>{c.stop();return {aweme_list:[raw('500')],has_more:0,cursor:'0'};});await c.sync({allAdded:true,mode:'full'});
 assert.equal(calls.length,1);assert.equal(store.work('500'),null);assert.equal(c.status.collectionBatch.pending,1);assert.equal(c.status.collectionBatch.items[0].state,'paused');assert.equal(store.collectionReads.info('10').full.canResume,true);
});
for(const reason of ['login','rate'])test(reason+' interruption stops the entire batch with untouched remaining folders',async t=>{
 const {c,calls}=await fixture(t,async(_opts,c)=>{if(reason==='login')c.needsLogin('请重新登录');else c.holdAccess(60);throw Error(reason==='login'?'请重新登录':'平台限制访问频率');});
 await c.sync({allAdded:true,mode:'full'});assert.equal(calls.length,1);assert.equal(c.status.collectionBatch.pending,1);assert.equal(c.status.collectionBatch.phase,'stopped');assert.match(c.status.collectionBatch.message,/登录|频率|频繁/);
});
test('known missing folders are skipped and unadded folders never enter the batch',async t=>{
 const {c,store,calls}=await fixture(t);store.put('collections','10',{...store.collection('10'),remoteMissing:true});await c.sync({allAdded:true,mode:'full'});
 assert.deepEqual(calls.map(x=>x.params.collects_id),['20']);assert.equal(c.status.collectionBatch.skipped,1);assert.equal(c.status.collectionBatch.total,2);
});
test('invalid modes and empty added-folder lists never fall back to total favourites',async t=>{
 const {c,store,calls}=await fixture(t);await assert.rejects(c.sync({allAdded:true,mode:'invalid'}),/方式|模式/);for(const id of ['10','20'])store.put('collections',id,{...store.collection(id),added:false});await assert.rejects(c.sync({allAdded:true,mode:'full'}),/没有|尚未/);assert.equal(calls.length,0);
});
test('a stopped batch never resumes under another account',async t=>{
 const {c,store,calls,onChange}=await fixture(t);onChange(()=>{if(c.status.collectionBatch?.succeeded===1)store.setSetting('browserAccountKey','uid:2');});await c.sync({allAdded:true,mode:'full'});assert.equal(calls.length,1);assert.equal(c.status.collectionBatch.pending,1);assert.equal(c.status.collectionBatch.phase,'stopped');assert.match(c.status.collectionBatch.message,/账号/);
});

test('a second sync cannot enter while a batch owns the foreground read',async t=>{
 let finish;const {c,calls}=await fixture(t,async()=>new Promise(resolve=>finish=resolve));const first=c.sync({allAdded:true,mode:'full'});while(!finish)await new Promise(r=>setImmediate(r));
 await assert.rejects(c.sync({allAdded:true,mode:'full'}),/正在进行/);await assert.rejects(c.sync({collectionId:'20',mode:'full'}),/正在进行/);c.stop();finish({aweme_list:[],has_more:0,cursor:'0'});await first;assert.equal(calls.length,1);
});

test('saved-page finalization failure stops the batch and leaves remaining folders untouched',async t=>{
 const {c,store,calls}=await fixture(t);store.reconcilePending=async()=>{throw Error('磁盘保存失败');};await c.sync({allAdded:true,mode:'full'});
 assert.equal(calls.length,1);assert.equal(c.status.collectionBatch.failed,1);assert.equal(c.status.collectionBatch.pending,1);assert.match(c.status.collectionBatch.items[0].message,/保存失败/);assert.equal(c.status.collectionBatch.phase,'stopped');
});

test('a completed read with an organization error reports a failed folder rather than success',async t=>{
 const {c,store}=await fixture(t);store.reconcilePending=async()=>['本机文件整理失败'];await c.sync({allAdded:true,mode:'full'});
 assert.equal(c.status.collectionBatch.succeeded,0);assert.equal(c.status.collectionBatch.failed,2);assert.equal(c.status.collectionBatch.phase,'partial');
});

test('concurrent launches waiting on initialization cannot both acquire the batch',async t=>{
 let ready;const finishes=[];const {c,calls}=await fixture(t,async()=>new Promise(resolve=>finishes.push(resolve)));c.ready=new Promise(resolve=>ready=resolve);
 const first=c.sync({allAdded:true,mode:'full'}),second=c.sync({allAdded:true,mode:'full'});second.catch(()=>{});ready();
 try{await assert.rejects(Promise.race([second,new Promise((_,reject)=>setTimeout(()=>reject(Error('duplicate launch did not reject')),150))]),/正在进行/);}finally{c.stop();for(const finish of finishes)finish({aweme_list:[],has_more:0,cursor:'0'});await Promise.allSettled([first,second]);}assert.equal(calls.length,1);
});

test('an unexpected between-folder error leaves a stopped result with its concrete reason',async t=>{
 const {c,calls}=await fixture(t);c.delay=async()=>{throw Error('准备下一收藏夹失败');};await c.sync({allAdded:true,mode:'full'});
 assert.equal(calls.length,1);assert.equal(c.status.collectionBatch.running,false);assert.equal(c.status.collectionBatch.phase,'stopped');assert.match(c.status.collectionBatch.message,/准备下一收藏夹失败/);
});

test('expired cookies detected before a folder starts stop the whole batch without inventing read logs',async t=>{
 const {c,store,calls}=await fixture(t);c.isAuthenticated=async()=>false;await c.sync({allAdded:true,mode:'full'});
 assert.equal(calls.length,0);assert.equal(c.status.collectionBatch.phase,'stopped');assert.equal(c.status.collectionBatch.pending,1);assert.equal(store.readHistory.runs({}).total,0);assert.equal(c.status.needsLogin,true);
});
