import test from 'node:test';import assert from 'node:assert/strict';import {createPreparationFixture} from './download-preparation-fixture.mjs';import {DownloadPreparation} from '../electron/download-preparation.mjs';import {captureCancellationOwnership} from '../electron/download-ownership-async.mjs';
test('all direct queue admissions return a promise and retain Douyin, NAS-library and cover-only options',async t=>{
 const f=await createPreparationFixture(t,{unsavedCount:3}),q=f.queue;
 const result=q.enqueue(['1']);assert.equal(typeof result?.then,'function');assert.equal(await result,1);assert.equal(await q.enqueue(['2'],{source:'nas',catalogueLibrary:'fixture-library'}),1);assert.equal(await q.enqueue(['3'],{coverOnly:true}),1);
 assert.equal(q.taskRows.byId.get('1').source,'douyin');assert.equal(q.taskRows.byId.get('2').catalogueLibrary,'fixture-library');assert.equal(q.taskRows.byId.get('3').coverOnly,true);assert.ok(q.jobs.every(j=>!j.admission.held));
});
test('queue pause stops preparation before the next admission and drain settles before database shutdown',async t=>{
 const f=await createPreparationFixture(t,{unsavedCount:3});let p=new DownloadPreparation({store:f.store,queue:f.queue,onChange:()=>{if(p?.state().accepted===1)f.queue.pause();}});f.queue.preparation=p;await p.submit({ids:f.ids,kind:'exact'});assert.equal(p.state().phase,'stopped');assert.equal(p.state().accepted,1);assert.equal(f.queue.jobs[0].admission.held,true);await p.drain();assert.equal(p.state().running,false);assert.equal(f.store.closed,undefined);
});
test('retrying a failed download routes through preparation without resetting the original ownership epoch',async t=>{
 const f=await createPreparationFixture(t),q=f.queue;await q.enqueue(['1']);const job=q.jobs[0],epoch=job.cancelOwnership.epoch;job.state='failed';const before=q.preparation.stats.ownershipBuilds;assert.equal((await q.retryFailed()).queued,1);assert.ok(q.preparation.stats.ownershipBuilds>before);assert.equal(q.taskRows.byId.get('1').cancelOwnership.epoch,epoch);
});
test('abort while asynchronous original-file validation waits cannot publish a ghost task',async t=>{
 const f=await createPreparationFixture(t);let entered;const gate=new Promise(r=>entered=r),p=new DownloadPreparation({store:f.store,queue:f.queue,capture:async(s,id,options)=>{entered();await new Promise(r=>setTimeout(r,20));return captureCancellationOwnership(s,id,options);}});f.queue.preparation=p;const result=p.submit({ids:f.ids,kind:'exact'});await gate;await p.drain();assert.equal((await result).queued,0);assert.equal(f.queue.jobs.length,0);
});
