import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {createPreparationFixture} from './download-preparation-fixture.mjs';import {DownloadPreparation} from '../electron/download-preparation.mjs';
import {captureCancellationOwnership} from '../electron/download-ownership-async.mjs';
import {DownloadQueue} from '../electron/downloads.mjs';

function manager(f,options={}){const p=new DownloadPreparation({store:f.store,queue:f.queue,...options});f.queue.preparation=p;return p;}
test('32585 selected records admit exactly 775, build ownership once and keep main-loop heartbeat alive',async t=>{
 const f=await createPreparationFixture(t,{savedCount:31542,unsavedCount:775,unavailableCount:268}),p=manager(f);let scans=0,pulses=0;const all=f.store.all.bind(f.store);f.store.all=table=>{if(table==='downloads')scans++;return all(table);};const timer=setInterval(()=>pulses++,2);let result;try{result=await p.submit({ids:f.ids,kind:'selection',scope:'unsaved',source:'douyin'});}finally{clearInterval(timer);}
 assert.equal(result.queued,775);assert.equal(result.unavailable,268);assert.equal(p.stats.ownershipBuilds,1);assert.equal(scans,0);assert.ok(pulses>5);assert.equal(f.queue.jobs.length,775);assert.ok(f.queue.jobs.every(j=>!j.admission.held&&j.source==='douyin'));assert.equal(f.store.rows('SELECT COUNT(*) n FROM downloads')[0].n,31542);assert.equal(p.results({operationId:result.operationId,page:1}).items.length,50);assert.ok(f.store.rows('SELECT COUNT(*) n FROM download_path_changes')[0].n<=10000);
});
test('stop holds accepted work across restart; continuing releases only this batch and retries preserve epoch',async t=>{
 const f=await createPreparationFixture(t,{unsavedCount:5});await f.queue.enqueue(['1']);const retry=f.queue.jobs[0];retry.state='failed';const epoch=retry.cancelOwnership.epoch;
 let p=manager(f,{onChange:()=>{if(p?.state().accepted===2)p.stop(p.state().operationId);}});const result=await p.submit({ids:f.ids,kind:'exact',source:'douyin'});assert.equal(p.state().phase,'stopped');assert.equal(result.held,2);assert.equal(f.queue.taskRows.byId.get('1').cancelOwnership.epoch,epoch);await p.close();
 await f.reopen();p=manager(f);assert.equal(p.state().phase,'stopped');assert.equal(f.queue.jobs.filter(j=>j.admission?.held).length,2);let started=0;f.queue.saveWork=async()=>{started++;};await DownloadQueue.prototype.run.call(f.queue);assert.equal(started,0);const continued=await p.continue(result.operationId);assert.equal(continued.held,0);assert.ok(f.queue.jobs.every(j=>!j.admission?.held));assert.equal(f.queue.taskRows.byId.get('1').cancelOwnership.epoch,epoch);
});
test('individual snapshot failure releases other successes, global context failure holds every accepted task',async t=>{
 const f=await createPreparationFixture(t,{unsavedCount:3}),p=manager(f,{capture:async(s,id,options)=>{if(id==='2')throw Error('fixture item unreadable');return captureCancellationOwnership(s,id,options);}});const result=await p.submit({ids:f.ids,source:'douyin',kind:'exact'});assert.equal(result.queued,2);assert.equal(result.failed,1);assert.equal(result.held,0);assert.equal(p.state().phase,'partial');await p.close();
 const g=await createPreparationFixture(t,{unsavedCount:3});let other=manager(g,{onChange:()=>{if(other?.state().accepted===1)g.store.setSetting('root',g.root+'-changed');}});const failed=await other.submit({ids:g.ids,source:'douyin',kind:'exact'});assert.equal(other.state().phase,'failed');assert.equal(failed.held,1);assert.equal(failed.remaining,2);await assert.rejects(other.continue(failed.operationId),/根目录|保存位置/);
});
test('own reservations choose distinct directories, concurrent path commits update only affected ownership',async t=>{
 const f=await createPreparationFixture(t,{savedCount:1,unsavedCount:3});for(const id of ['2','3'])f.store.put('works',id,{...f.store.work(id),name:'same'});
 let changed=false;const p=manager(f,{onChange:()=>{if(!changed&&p?.state().accepted===1){changed=true;f.store.put('downloads','1',{...f.store.download('1'),path:path.join(f.root,'moved')});}}});const r=await p.submit({ids:['2','3','4'],kind:'exact',source:'douyin'});assert.equal(r.queued,3);assert.equal(p.stats.ownershipBuilds,1);const jobs=f.queue.jobs;assert.notEqual(jobs[0].admission.target.dir,jobs[1].admission.target.dir);assert.equal(p.state().phase,'complete');
});
test('dropping an unneeded old failed job preserves completed files while explicit cancellation retains its normal cleanup',async t=>{
 const f=await createPreparationFixture(t,{savedCount:1,unsavedCount:0}),d=f.store.download('1');await fs.mkdir(d.path,{recursive:true});const file=path.join(d.path,'keep.mp4');await fs.writeFile(file,'saved');f.queue.jobs=[{id:'1',state:'failed',source:'douyin',cancelOwnership:{version:1,root:f.root,epoch:'old',dirs:[],files:[]}}];manager(f);const r=await f.queue.discardUnneeded(['1']);assert.equal(r.removed,1);assert.equal(await fs.readFile(file,'utf8'),'saved');assert.ok(f.store.download('1'));
});
test('failed transactional admission reports no accepted ghost task and leaves durable queue unchanged',async t=>{
 const f=await createPreparationFixture(t),p=manager(f),result=p.repo.result.bind(p.repo);p.repo.result=(...args)=>{if(args[3]==='accepted')throw Error('fixture transaction failure');return result(...args);};const response=await p.submit({ids:f.ids,kind:'exact',source:'douyin'});assert.equal(response.phase,'failed');assert.equal(response.queued,0);assert.equal(response.held,0);assert.equal(f.queue.jobs.length,0);assert.equal(f.store.rows('SELECT COUNT(*) n FROM download_tasks')[0].n,0);
});
test('release wakes a running queue even after its cursor has passed held admissions',async t=>{
 const f=await createPreparationFixture(t,{unsavedCount:2}),q=f.queue;let finish,second=false;await q.enqueue(['1']);q.saveWork=async job=>{if(job.id==='1')await new Promise(resolve=>finish=resolve);else second=true;};q.store.fileStates.confirmWritten=async()=>true;q.run=DownloadQueue.prototype.run.bind(q);const running=q.run();await new Promise(r=>setTimeout(r,10));q.admitPrepared([{id:'2',title:'second',state:'waiting',source:'douyin'}],{operationId:'held',held:true});q.wake?.();await new Promise(r=>setTimeout(r,10));q.releaseAdmission('held');await new Promise(r=>setTimeout(r,30));finish();await running;assert.equal(second,true);
});
test('continuation rechecks context after async validation and keeps a batch held on release persistence failure',async t=>{
 const f=await createPreparationFixture(t,{unsavedCount:2});let p=manager(f,{onChange:()=>{if(p?.state().accepted===1)p.stop(p.state().operationId);}});const first=await p.submit({ids:f.ids,kind:'exact'});await p.close();
 p=manager(f,{capture:async(s,id,options)=>{const r=await captureCancellationOwnership(s,id,options);s.setSetting('root',f.root+'-changed');return r;}});await assert.rejects(p.continue(first.operationId),/根目录|保存位置/);assert.equal(f.queue.jobs[0].admission.held,true);
});
test('a failed release commit cannot expose unheld jobs in memory',async t=>{
 const f=await createPreparationFixture(t);let p=manager(f,{onChange:()=>{if(p?.state().accepted===1)p.stop(p.state().operationId);}});const r=await p.submit({ids:f.ids,kind:'exact'}),flush=f.queue.taskRows.flush.bind(f.queue.taskRows);f.queue.taskRows.flush=()=>{throw Error('fixture flush failure');};assert.throws(()=>f.queue.releaseAdmission(r.operationId),/flush/);assert.equal(f.queue.jobs[0].admission.held,true);f.queue.taskRows.flush=flush;
});
