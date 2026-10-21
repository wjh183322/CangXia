import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../electron/store.mjs';import {Collector} from '../electron/account-collector.mjs';
import {readCollection} from '../electron/collection-reader.mjs';
const raw=id=>({aweme_id:id,desc:'分组作品 '+id,author:{uid:'7',nickname:'作者'}});
async function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx-log-group-'));let store=await Store.open(path.join(root,'library.sqlite'),path.join(root,'media'));store.setSetting('browserAccountKey','uid:1');store.discoverCollections([{collects_id:'10',collects_name:'同名夹'},{collects_id:'20',collects_name:'同名夹'}]);store.setAdded(['10','20']);let notify=()=>{};const collector=()=>{const c=new Collector(store,()=>notify(),{profile:{},vault:{load:()=>null},browser:{},delay:async()=>{}});c.isAuthenticated=async()=>true;c.request=async()=>({aweme_list:[raw('900')],has_more:0,cursor:'0'});return c;};t.after(async()=>{await store.fileStates.close();store.close();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});return {get store(){return store;},collector,onChange:fn=>notify=fn,async reopen(){await store.fileStates.close();store.close();store=await Store.open(path.join(root,'library.sqlite'),path.join(root,'media'));return store;}};}

test('one batch is one top-level log with ordered independently named child scopes',async t=>{
 const f=await fixture(t),c=f.collector();await c.sync({allAdded:true,mode:'full'});const top=f.store.readHistory.runs();assert.equal(top.total,1);assert.equal(top.items[0].source,'batch');const children=f.store.readHistory.runs({batch:top.items[0].token});assert.deepEqual(children.items.map(s=>s.scope),['10','20']);assert.ok(children.items.every(s=>s.name==='同名夹'));assert.equal(children.items[0].checked,1);assert.equal(top.stats.runs,1);
});

test('linked total lives inside one batch and later standalone reads remain standalone',async t=>{
 const f=await fixture(t),c=f.collector();await c.sync({mode:'full',syncCollections:true});const parent=f.store.readHistory.runs().items[0];assert.equal(f.store.readHistory.runs().total,1);assert.deepEqual(f.store.readHistory.runs({batch:parent.token}).items.map(s=>s.scope),['__all__','10','20']);await c.sync({mode:'full'});assert.equal(f.store.readHistory.runs().total,2);
});

test('stop records the unstarted folders inside its batch and retains them after restart',async t=>{
 const f=await fixture(t),c=f.collector();let stopped=false;f.onChange(()=>{if(!stopped&&c.status.collectionBatch?.succeeded===1){stopped=true;c.stop();}});await c.sync({allAdded:true,mode:'full'});const token=f.store.readHistory.runs().items[0].token;await f.reopen();const children=f.store.readHistory.runs({batch:token});assert.deepEqual(children.items.map(s=>s.batchState),['complete','waiting']);assert.equal(f.store.readHistory.runs().items[0].phase,'stopped');
});

test('resumed child snapshots do not rewrite a previous batch differences or counts',async t=>{
 const f=await fixture(t),c=f.collector();let first=true;c.request=async()=>{if(first){first=false;return {aweme_list:[raw('1')],has_more:1,cursor:'30'};}c.stop();throw Error('pause');};await c.sync({allAdded:true,mode:'full'});const oldParent=f.store.readHistory.runs().items[0],oldChild=f.store.readHistory.runs({batch:oldParent.token}).items[0];assert.equal(oldChild.checked,1);
 c.request=async()=>({aweme_list:[raw('2')],has_more:0,cursor:'0'});await c.sync({mode:'full',syncCollections:true,resume:false});
 const run=f.store.collectionReads.start('10','full');f.store.collectionReads.apply(run,{items:[raw('3')],next:'30',complete:false});f.store.collectionReads.finish(run,'paused');
 const total=f.store.collectionReads.start('__all__','full');f.store.collectionReads.apply(total,{items:[raw('4')],next:'30',complete:false});f.store.collectionReads.finish(total,'paused');
 await c.sync({mode:'full',syncCollections:true,resume:true});assert.equal(f.store.readHistory.runs({batch:oldParent.token}).items[0].checked,1);assert.equal(f.store.readHistory.items(oldChild.token).total,0);
});

test('batch pagination stays inside the group and invalid batch never falls back to all logs',async t=>{
 const f=await fixture(t),c=f.collector();for(let n=100;n<154;n++){f.store.discoverCollections([{collects_id:String(n),collects_name:'夹'+n}]);f.store.setAdded([String(n)]);}await c.sync({allAdded:true,mode:'full'});const top=f.store.readHistory.runs();assert.equal(top.total,1);const first=f.store.readHistory.runs({batch:top.items[0].token}),last=f.store.readHistory.runs({batch:top.items[0].token,page:2});assert.equal(first.items.length,50);assert.equal(last.items.length,6);assert.equal(first.total,56);assert.throws(()=>f.store.readHistory.runs({batch:'missing'}),/日志|批次/);const members=f.store.collectionReads.membership('10');f.store.readHistory.clear();assert.equal(f.store.readHistory.runs().total,0);assert.deepEqual(f.store.collectionReads.membership('10'),members);
});

test('interrupted batch recovery keeps its child inside the saved batch without an extra log',async t=>{
 const f=await fixture(t),batch={mode:'full',includeTotal:false,startedAt:Date.now(),running:true,phase:'running',total:2,processed:0,succeeded:0,failed:0,skipped:0,pending:1,paused:0,items:[{id:'10',name:'同名夹',state:'running'},{id:'20',name:'同名夹',state:'waiting'}]};
 f.store.readHistory.batches.begin(batch);const r=f.store.collectionReads,run=r.start('10','full');r.apply(run,{items:[raw('1')],next:'30',complete:false});await f.reopen();
 const top=f.store.readHistory.runs();assert.equal(top.total,1);assert.equal(top.items[0].phase,'stopped');const children=f.store.readHistory.runs({batch:top.items[0].token});assert.equal(children.items[0].batchState,'paused');assert.equal(children.items[0].checked,1);assert.equal(children.items[0].status,'paused');assert.equal(f.store.collectionReads.info('10').full.canResume,true);
});

function interruptedBatch(){return {mode:'full',includeTotal:false,startedAt:Date.now(),running:true,phase:'running',total:2,processed:0,succeeded:0,failed:0,skipped:0,pending:1,paused:0,items:[{id:'10',name:'同名夹',state:'running'},{id:'20',name:'同名夹',state:'waiting'}]};}
test('a completed child remains complete if process exits before batch status publication',async t=>{
 const f=await fixture(t),batch=interruptedBatch();f.store.readHistory.batches.begin(batch);await readCollection(f.collector(),{collectionId:'10',mode:'full'});await f.reopen();const top=f.store.readHistory.runs();assert.equal(top.total,1);assert.equal(top.items[0].succeeded,1);assert.equal(top.items[0].paused,0);const children=f.store.readHistory.runs({batch:top.items[0].token});assert.equal(children.items[0].batchState,'complete');assert.equal(children.items[0].status,'complete');
});

test('a second interrupted startup still routes running checkpoint recovery into the original child',async t=>{
 const f=await fixture(t),batch=interruptedBatch();f.store.readHistory.batches.begin(batch);const r=f.store.collectionReads,run=r.start('10','full');r.apply(run,{items:[raw('1')],next:'30',complete:false});f.store.readHistory.batches.active=null;f.store.readHistory.batches.init();await f.reopen();const top=f.store.readHistory.runs();assert.equal(top.total,1);assert.equal(f.store.readHistory.runs({batch:top.items[0].token}).items[0].checked,1);assert.equal(f.store.collectionReads.info('10').full.canResume,true);
});

test('standalone continuation recovery never rewrites a frozen child of an older batch',async t=>{
 const f=await fixture(t),batch=interruptedBatch(),r=f.store.collectionReads;f.store.readHistory.batches.begin(batch);let run=r.start('10','full');r.apply(run,{items:[raw('1')],next:'30',complete:false});r.finish(run,'paused');Object.assign(batch,{running:false,phase:'stopped',paused:1});batch.items[0].state='paused';f.store.readHistory.batches.end(batch);const oldChild=f.store.readHistory.runs({batch:batch.historyToken}).items[0];
 run=r.start('10','full',{resume:true});r.apply(run,{items:[raw('2')],next:'60',complete:false});await f.reopen();assert.equal(f.store.readHistory.runs({batch:batch.historyToken}).items[0].checked,1);const top=f.store.readHistory.runs();assert.equal(top.total,2);const standalone=top.items.find(s=>s.source!=='batch');assert.equal(standalone.checked,2);assert.equal(standalone.status,'paused');assert.equal(oldChild.readToken,standalone.token);
});

test('repeated batch continuation copies differences from the actual most recent log owner',async t=>{
 const f=await fixture(t),r=f.store.collectionReads;let run=r.start('10','full');r.apply(run,{items:[raw('1')],next:null,complete:true});
 const tokens=['ffffffff-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','11111111-0000-4000-8000-000000000003'];
 for(let i=0;i<tokens.length;i++){
  const batch=interruptedBatch();batch.historyToken=tokens[i];f.store.readHistory.batches.active=batch;f.store.readHistory.batches.publish(batch);run=r.start('10','full',{resume:i>0});r.apply(run,{items:[raw(String(i+2))],next:String((i+1)*30),complete:false});r.finish(run,'paused');batch.running=false;batch.phase='stopped';batch.items[0].state='paused';f.store.readHistory.batches.end(batch);
 }
 for(let i=0;i<tokens.length;i++){const child=f.store.readHistory.runs({batch:tokens[i]}).items[0];assert.equal(f.store.readHistory.items(child.token).total,i+1);assert.equal(child.added,i+1);}
});
