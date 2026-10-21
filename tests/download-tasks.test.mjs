import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../electron/store.mjs';import {DownloadQueue} from '../electron/downloads.mjs';
async function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-task-rows-')),file=path.join(dir,'library.sqlite'),store=await Store.open(file,path.join(dir,'media'));t.after(()=>{try{store.close();}catch{}assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});return {store,file,dir};}
test('failed tasks have their own bounded page and retry preserves original task type and source',async t=>{
 const {store}=await fixture(t);for(const id of ['1','2','3','4'])store.upsertWork({aweme_id:id,desc:id,images:[{url_list:[]}]});
 store.setSetting('downloadJobs',[{id:'1',state:'running'},{id:'2',state:'failed',coverOnly:true},{id:'3',state:'complete'},{id:'4',state:'failed',source:'nas'}]);
 const q=new DownloadQueue(store,{},null,()=>{});q.run=async()=>{};assert.equal(q.taskRows.page({tab:'active'}).total,1);
 assert.deepEqual(q.taskRows.page({tab:'failed'}).jobs.map(j=>j.id),['2','4']);
 assert.equal((await q.retryFailed()).queued,2);assert.equal(q.jobs.find(j=>j.id==='2').coverOnly,true);assert.equal(q.jobs.find(j=>j.id==='4').source,'nas');assert.equal(q.taskRows.page({tab:'failed'}).total,0);assert.equal(q.jobs.find(j=>j.id==='3').state,'complete');
});
test('large task history has bounded summary and only changed rows are persisted',async t=>{
 const {store}=await fixture(t);store.setSetting('downloadJobs',Array.from({length:3000},(_,i)=>({id:String(i+1),title:'fixture',state:i===0?'waiting':'complete',source:'douyin'})));
 const queue=new DownloadQueue(store,{},null,()=>{});queue.emit(true);let writes=0;const run=store.db.run.bind(store.db);store.db.run=(sql,args)=>{if(sql.startsWith('INSERT OR REPLACE INTO download_tasks'))writes++;return run(sql,args);};
 queue.jobs[0].state='running';queue.jobs[0].progress=10;queue.emit(true);assert.equal(writes,1);const summary=queue.state({summary:true});assert.equal(summary.total,3000);assert.equal(summary.jobs.length,1);assert.ok(Buffer.byteLength(JSON.stringify(summary))<2048);assert.equal(summary.counts.complete,2999);
 const page=queue.taskRows.page({tab:'complete',page:20,pageSize:50});assert.equal(page.jobs.length,50);assert.equal(page.total,2999);assert.equal(page.jobs[0].id,'952');
});
test('cancelled row cannot return from the retained legacy JSON after restart',async t=>{
 const {store,file,dir}=await fixture(t);store.db.run('INSERT OR REPLACE INTO settings VALUES(?,?)',['downloadJobs',JSON.stringify([{id:'9',state:'waiting'}])]);store.setSetting('downloadJobs',[{id:'9',state:'waiting'},{id:'8',state:'complete'}]);const queue=new DownloadQueue(store,{},null,()=>{});await queue.cancel(['9']);store.close();
 const reopened=await Store.open(file,path.join(dir,'media'));try{const next=new DownloadQueue(reopened,{},null,()=>{});assert.deepEqual(next.jobs.map(j=>j.id),['8']);assert.equal(next.taskRows.page({tab:'complete',page:1,pageSize:50}).total,1);}finally{reopened.close();}store.close=()=>{};
});
test('whole-history clear preserves pending tasks and file records',async t=>{const {store}=await fixture(t);store.setSetting('downloadJobs',[{id:'1',state:'complete'},{id:'2',state:'failed'},{id:'3',state:'waiting'}]);store.put('downloads','1',{id:'1',path:store.root,assets:[],state:'complete'});const queue=new DownloadQueue(store,{},null,()=>{});queue.clearCompleted(null);assert.deepEqual(queue.jobs.map(j=>j.id),['2','3']);assert.ok(store.download('1'));});
test('returning to a queue retains only selected IDs still in that tab',async t=>{
 const {store}=await fixture(t);store.setSetting('downloadJobs',[{id:'1',state:'waiting'},{id:'2',state:'running'},{id:'3',state:'failed'}]);
 assert.deepEqual(store.downloadTasks.validateSelection({tab:'active',ids:['1','2','3']}),{ids:['1','2'],invalid:1});store.downloadTasks.byId.get('1').state='complete';assert.deepEqual(store.downloadTasks.validateSelection({tab:'active',ids:['1','2']}),{ids:['2'],invalid:1});assert.throws(()=>store.downloadTasks.validateSelection({tab:'bogus',ids:['1']}));
});

test('download task pages expose cloneable public status without runtime callbacks or ownership metadata',async t=>{
 const {store}=await fixture(t);store.setSetting('downloadJobs',[{id:'1',state:'waiting'}]);const job=store.downloadTasks.byId.get('1');job.phase='transferring';job.activeSource='nas';job.trackDownloadFile=()=>{};job.cancelOwnership={root:'private-root',metadata:[{bytes:'private-original'}]};const page=store.downloadTasks.page({tab:'active',page:1,pageSize:50});assert.doesNotThrow(()=>structuredClone(page));assert.equal(page.jobs[0].phase,'transferring');assert.equal(page.jobs[0].activeSource,'nas');assert.equal('cancelOwnership' in page.jobs[0],false);assert.equal('trackDownloadFile' in page.jobs[0],false);
});
