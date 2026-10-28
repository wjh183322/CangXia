import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createPreparationFixture} from './download-preparation-fixture.mjs';
import {DownloadPreparation} from '../electron/download-preparation.mjs';
import {DefectRepair} from '../electron/defect-repair.mjs';

test('continuation initial save failure releases its running lock and preserves the original held epoch',async t=>{
 const f=await createPreparationFixture(t,{unsavedCount:2});let p=new DownloadPreparation({store:f.store,queue:f.queue,onChange:()=>{if(p?.state().accepted===1)p.stop(p.state().operationId);}});f.queue.preparation=p;
 const first=await p.submit({ids:f.ids,kind:'exact'}),epoch=f.queue.jobs[0].cancelOwnership.epoch,states=[];p.onChange=s=>states.push(s);const save=p.repo.save.bind(p.repo);p.repo.save=()=>{throw Error('fixture continuation save failure');};
 await assert.rejects(p.continue(first.operationId),/save failure/);p.repo.save=save;await p.drain();
 assert.equal(p.state().running,false);assert.equal(states.at(-1).running,false);assert.equal(p.state().held,1);assert.equal(f.queue.jobs[0].cancelOwnership.epoch,epoch);
 await p.continue(first.operationId);assert.equal(p.state().held,0);assert.equal(f.queue.jobs[0].cancelOwnership.epoch,epoch);
});

test('actual IPC handler rejects new and continued admissions intersecting a deletion while allowing unrelated scopes and browsing',async()=>{
 const source=fs.readFileSync(new URL('../electron/main.mjs',import.meta.url),'utf8'),handler=source.slice(source.indexOf('function handler('),source.indexOf('function ensureIdle(')),calls=new Map(),frame={},contents={mainFrame:frame},event={sender:null,senderFrame:frame};event.sender=contents;
 const context={ipcMain:{handle:(name,fn)=>calls.set(name,fn)},window:{webContents:contents},queue:{jobs:[{id:'1',admission:{operationId:'held-op',held:true}},{id:'2',admission:{operationId:'other-op',held:true}}]},scopedActive:()=>true,scopedFileIds:new Set(['1']),readLocked:()=>false,writes:new Set(),inFlightActions:new Set(),actionDrains:new Map(),notify:()=>{}};
 for(const name of ['backup','repairChecks','localRemoval','nasRemoval','collector'])context[name]={};for(const name of ['loggingOut','backupBusy'])context[name]=false;
 vm.createContext(context);vm.runInContext(handler+';globalThis.register=handler;',context);
 for(const name of ['download','startDownloadPreparation','continueDownloadPreparation','workDetail'])context.register(name,()=> 'entered');
 const call=(name,input)=>calls.get('cangxia:'+name)(event,input);
 for(const [name,input]of [['download',['1']],['startDownloadPreparation',{ids:['1']}],['continueDownloadPreparation','held-op']]){const r=await call(name,input);assert.equal(r.ok,false,name);assert.match(r.error,/文件删除/);}
 for(const [name,input]of [['startDownloadPreparation',{ids:['2']}],['continueDownloadPreparation','other-op'],['workDetail','1']])assert.equal((await call(name,input)).ok,true,name);
 context.scopedFileIds.clear();assert.equal((await call('startDownloadPreparation',{ids:['1']})).ok,true,'records-only deletion does not block files');
});

test('superseding an indexed query after it enters size sorting aborts the obsolete computation',async t=>{
 const f=await createPreparationFixture(t,{unsavedCount:4000}),search=f.store.lightViews.search;await search.prepare();let sorting,reads=0;const entered=new Promise(r=>sorting=r),get=search.rows.get.bind(search.rows);
 search.rows.get=id=>{if(++reads===f.ids.length)sorting();return get(id);};
 const old=search.query(f.ids,{sort:'size-desc'},{requestKey:'size'}).then(()=>false,e=>e.name==='AbortError');await entered;
 const latest=search.query(['1'],{sort:'size-asc'},{requestKey:'size'});assert.equal(await old,true);assert.deepEqual(await latest,['1']);
});

async function stoppedGroups(t,run){
 const f=await createPreparationFixture(t,{unsavedCount:3}),q=f.queue;await q.enqueue(['1','2']);await q.enqueue(['3'],{source:'nas'});for(const job of q.jobs)job.state='failed';q.taskRows.flush();let p=new DownloadPreparation({store:f.store,queue:q,onChange:()=>{if(p?.state().accepted===1)p.stop(p.state().operationId);}});q.preparation=p;
 await run(f,p);assert.equal(p.state().phase,'stopped');assert.equal(p.state().held,1);assert.equal(q.taskRows.byId.get('3').state,'failed');assert.equal(q.taskRows.byId.get('3').admission.held,false);
}
test('stopping a mixed-source batch retry does not automatically prepare the next source group',async t=>{
 await stoppedGroups(t,async f=>{await assert.rejects(f.queue.retryFailed(),e=>e.code==='PREPARATION_STOPPED'&&e.accepted===1);});
});
test('stopping mixed-source targeted repair leaves subsequent source groups untouched',async t=>{
 await stoppedGroups(t,async f=>{const repair={store:f.store,queue:f.queue,backup:{status:{writable:true}},scanItems:[],selection:ids=>ids,jobItem:id=>({id,state:'waiting',queueFiles:true,downloadOptions:{source:id==='3'?'nas':'douyin'}}),indexJob(){},emit(){},state(){return this.job;},runForeground:fn=>Promise.resolve().then(fn),execute:async function(){this.job.phase='done';}};DefectRepair.prototype.start.call(repair,f.ids);await repair.promise;assert.equal(repair.job.phase,'paused');assert.match(repair.job.message,/停止/);});
});
