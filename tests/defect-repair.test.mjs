import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../electron/store.mjs';
import {BackupClient} from '../electron/backup-client.mjs';
import {DefectRepair} from '../electron/defect-repair.mjs';
import {exportRecords,hashes} from '../electron/backup-model.mjs';
import {sha256} from '../shared/backup-protocol.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
test('targeted repair uses the indexed browsing cache without refreshing already available work',async t=>{const f=await setup(t);const cache=await f.backup.cache.writeCover(png,'.png',{alias:'1'});f.backup.fetchCover=async()=>{throw Error('no network request expected');};f.manager.start(['1']);await f.manager.wait();assert.equal(f.manager.state().done,1);assert.equal(f.calls.length,0);assert.equal(f.queued.length,0);assert.deepEqual(fs.readFileSync(cache.file),png);assert.equal(f.store.work('1').backupCover,undefined);assert.equal(f.backup.status.pendingCovers,1);});
const raw=id=>({aweme_id:id,desc:'fixture '+id,author:{nickname:'fixture'},video:{cover:{url_list:['https://p3.douyinpic.com/'+id+'.png']},play_addr:{url_list:[]}}});
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-defect-')),store=await Store.open(path.join(dir,'library.sqlite'),path.join(dir,'media'));store.setSetting('browserAccountKey','uid:1');
 for(const id of ['1','2','3'])store.upsertWork(raw(id));store.ingestMembers('__all__',['3','1','2'],true);
 const asset={key:'preview',kind:'image',file:'cover.png',sha256:sha256(png),size:png.length};for(const id of ['2','3'])store.put('works',id,{...store.work(id),backupCover:asset});
 const backup=new BackupClient(store,dir,{vault:{}});backup.status.writable=true;backup.status.connected=true;backup.meta.baseRevision=1;backup.meta.baseline=hashes(exportRecords(store));backup.meta.dirty=false;backup.fetchCover=async()=>new Response(png,{headers:{'content-type':'image/png'}});
 const calls=[],queued=[],queue={jobs:[],enqueue:ids=>queued.push(...ids)};
 const collector={resolveWork:async id=>{calls.push(id);return store.upsertWork(raw(id));},cancelResolve:()=>{}};
 let manager=new DefectRepair({store,backup,collector,queue,profile:dir,runForeground:action=>backup.withForegroundRead(action)});
 t.after(async()=>{manager.close();await backup.close();store.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 return {dir,store,backup,queue,collector,calls,queued,get manager(){return manager;},reopen(){manager.close();manager=new DefectRepair({store,backup,collector,queue,profile:dir,runForeground:action=>backup.withForegroundRead(action)});return manager;}};
}
function missingFile(f,id='3'){
 const dir=f.store.destination(id).dir;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'cover.png'),png);fs.writeFileSync(path.join(dir,'作品信息.json'),'{}');
 f.store.put('downloads',id,{id,path:dir,state:'partial',collectionId:'__all__',assets:[{key:'cover',file:'cover.png',kind:'image',size:png.length},{key:'metadata',file:'作品信息.json',kind:'metadata',size:2}]});
}
test('problem scan follows saved collection order and supports pending category without duplicates',async t=>{
 const f=await setup(t);missingFile(f);const report=await f.manager.scan();assert.deepEqual(report.items.map(i=>i.id),['3','1']);
 const pending=f.manager.page({status:'pending',page:1});assert.equal(pending.total,2);assert.equal(pending.counts.status.pending,2);assert.ok(pending.items.every(i=>i.status==='pending'));
});
test('cross-page all selection uses a scan token and only the filtered repairable works',async t=>{
 const f=await setup(t);missingFile(f);const report=await f.manager.scan();f.manager.start({token:report.token,status:'pending',kind:'files',all:true,exclude:[]});await f.manager.wait();assert.deepEqual(f.queued,['3']);assert.equal(f.manager.job.items.length,1);
});
test('confirmed unavailable works can be selected for status verification but not file repair',async t=>{const f=await setup(t);missingFile(f);f.store.put('works','3',{...f.store.work('3'),remoteState:'unavailable',sourceStatus:{state:'unavailable',reason:'用户确认失效',method:'user'}});const report=await f.manager.scan();assert.equal(f.manager.page({status:'unavailable'}).total,1);assert.equal(f.manager.page({status:'unavailable'}).repairable,0);const input={token:report.token,status:'unavailable',kind:'all',all:true,exclude:[]};assert.deepEqual(f.manager.selection(input),[]);assert.deepEqual(f.manager.selection(input,{verify:true}),['3']);f.manager.start(['3']);await f.manager.wait();assert.deepEqual(f.queued,[]);assert.equal(f.manager.job.items[0].state,'unavailable');});
test('batch source verification is ordered, cancellable and does not queue media',async t=>{const f=await setup(t),seen=[];f.collector.verifySource=async(id,{signal})=>{assert.equal(signal.aborted,false);seen.push(id);if(id==='1')f.manager.stop();return {id,state:id==='3'?'unavailable':'unknown',reason:'fixture status'};};await f.manager.scan();f.manager.startVerification(['3','1','2']);await f.manager.wait();assert.deepEqual(seen,['3','1']);assert.equal(f.manager.state().phase,'paused');assert.equal(f.manager.state().verified,2);assert.deepEqual(f.queued,[]);});
test('resumed source verification can stop again and retain its unchecked suffix',async t=>{const f=await setup(t),seen=[];f.collector.verifySource=async id=>{seen.push(id);f.manager.stop();return {id,state:'unknown',reason:'fixture stop'};};f.manager.startVerification(['3','1','2']);await f.manager.wait();assert.equal(f.manager.state().verified,1);f.manager.start(null,{resume:true});await f.manager.wait();assert.equal(f.manager.state().phase,'paused');assert.equal(f.manager.state().verified,2);assert.deepEqual(seen,['3','1']);f.reopen();assert.equal(f.manager.job.items[2].state,'waiting');});

test('saved unknown source state survives rescans and task-database reopening without another network check',async t=>{
 const f=await setup(t);missingFile(f);f.queue.jobs=[{id:'3',state:'failed',message:'fixture download failure'}];
 let requests=0;f.collector.verifySource=async id=>{requests++;const sourceStatus={state:'unknown',reason:'fixture empty detail',method:'api',checkedAt:'2026-10-20T03:00:00Z'};f.store.put('works',id,{...f.store.work(id),remoteState:'unknown',sourceStatus});return {id,...sourceStatus};};
 await f.manager.scan();f.manager.startVerification(['3']);await f.manager.wait();
 for(const reopen of [false,true]){
  if(reopen)f.reopen();const scan=await f.manager.scan();
  const unknown=f.manager.page({status:'sourceUnknown'});assert.equal(unknown.total,1);assert.equal(unknown.items[0].id,'3');assert.equal(unknown.repairable,0);
  assert.ok(unknown.items[0].issues.some(i=>i.kind==='files'));assert.ok(unknown.items[0].issues.some(i=>i.kind==='source'));
  assert.equal(f.manager.page({status:'downloadFailed'}).total,0);
  const selection={token:scan.token,status:'sourceUnknown',kind:'all',all:true,exclude:[]};assert.deepEqual(f.manager.selection(selection,{verify:true}),['3']);assert.deepEqual(f.manager.selection(selection),[]);
  assert.equal(f.manager.page({view:'results',status:'sourceUnknown'}).total,1);
 }
 assert.equal(requests,1);assert.deepEqual(f.queued,[]);
});
test('source-only uncertainty is a persistent problem without requiring downloaded files or a current job',async t=>{
 const f=await setup(t);f.store.put('works','2',{...f.store.work('2'),remoteState:'unknown',sourceStatus:{state:'unknown',reason:'fixture source uncertainty'}});
 await f.manager.scan();const page=f.manager.page({status:'sourceUnknown',kind:'source'});
 assert.equal(page.total,1);assert.equal(page.items[0].id,'2');assert.equal(page.repairable,0);assert.equal(f.manager.job,null);
});
test('persisted available source remains filterable for file defects but does not list healthy works',async t=>{
 const f=await setup(t);missingFile(f);for(const id of ['2','3'])f.store.put('works',id,{...f.store.work(id),remoteState:'available',sourceStatus:{state:'available',reason:'fixture available'}});
 await f.manager.scan();const page=f.manager.page({status:'sourceAvailable'});
 assert.equal(page.total,1);assert.equal(page.items[0].id,'3');assert.equal(page.repairable,1);
});
test('current problems follow saved source changes while previous verification results remain historical',async t=>{
 const f=await setup(t);missingFile(f);await f.manager.scan();
 f.collector.verifySource=async id=>{f.store.put('works',id,{...f.store.work(id),remoteState:'unknown',sourceStatus:{state:'unknown',reason:'old attempt'}});return {id,state:'unknown',reason:'old attempt'};};
 f.manager.startVerification(['3']);await f.manager.wait();
 f.store.put('works','3',{...f.store.work('3'),remoteState:'unavailable',sourceStatus:{state:'unavailable',reason:'new explicit evidence'}});
 assert.equal(f.manager.page({status:'unavailable'}).total,1);assert.equal(f.manager.page({status:'sourceUnknown'}).total,0);
 assert.equal(f.manager.page({view:'results',status:'sourceUnknown'}).total,1);assert.equal(f.manager.state().sourceUnavailable,0);
 f.store.put('works','3',{...f.store.work('3'),remoteState:'available',sourceStatus:{state:'available',reason:'new available evidence'}});
 assert.equal(f.manager.page({status:'sourceAvailable'}).total,1);
});
test('verification progress after reopening counts saved completed checks instead of waiting unavailable works',async t=>{
 const f=await setup(t);for(const id of ['1','2','3'])f.store.put('works',id,{...f.store.work(id),remoteState:'unavailable',sourceStatus:{state:'unavailable',reason:'historical'}});
 f.collector.verifySource=async id=>{f.manager.stop();return {id,state:'unknown',reason:'new uncertain attempt',preservedUnavailable:true};};
 f.manager.startVerification(['3','1','2']);await f.manager.wait();f.reopen();
 const state=f.manager.state();assert.equal(state.verified,1);assert.equal(state.processed,1);assert.equal(state.sourceUnavailable,0);assert.equal(state.sourceUnknown,1);assert.equal(state.pendingVerification,2);
});
test('repair results follow queued downloads through failure and later completion',async t=>{
 const f=await setup(t);missingFile(f);f.manager.start(['3']);await f.manager.wait();f.queue.jobs=[{id:'3',state:'failed',message:'fixture offline'}];
 assert.equal(f.manager.page({view:'results',status:'downloadFailed'}).total,1);f.queue.jobs[0].state='complete';assert.equal(f.manager.page({view:'results',status:'complete'}).total,1);
});
test('completed repair remains complete after download-history clearing and manager restart',async t=>{const f=await setup(t);missingFile(f);f.manager.start(['3']);await f.manager.wait();const task={id:'3',state:'complete',message:'文件已保存'};f.queue.jobs=[task];f.queue.onJobSettled(task);f.queue.jobs=[];assert.equal(f.manager.page({view:'results',status:'complete'}).total,1);f.reopen();assert.equal(f.manager.page({view:'results',status:'complete'}).total,1);});
test('stopping in the worker stage retains the missing works already checked',async t=>{const f=await setup(t);missingFile(f);const template=f.store.download('3');for(let n=10;n<110;n++){const id=String(n);f.store.upsertWork(raw(id));f.store.put('downloads',id,{...template,id});}f.manager.checks.notify=()=>{if(f.manager.checks.state()?.checked>=20)f.manager.stop();};const report=await f.manager.scan({compact:true});assert.equal(report.cancelled,true);assert.ok(report.checked>=20);assert.ok(report.items.length>0);});
test('pure file repair yields to stop requests before all selected works are processed',async t=>{const f=await setup(t);missingFile(f);const template=f.store.download('3'),ids=[];for(let n=10;n<510;n++){const id=String(n);f.store.upsertWork(raw(id));f.store.put('works',id,{...f.store.work(id),backupCover:f.store.work('3').backupCover});f.store.put('downloads',id,{...template,id});ids.push(id);}f.manager.start(ids);setImmediate(()=>f.manager.stop());await f.manager.wait();assert.equal(f.manager.state().phase,'paused');assert.ok(f.manager.state().processed<ids.length);});
test('a failed checking worker pauses repair without claiming unchecked files are complete',async t=>{const f=await setup(t);missingFile(f);f.manager.checks.check=async()=>({phase:'failed',checked:0,message:'fixture worker timeout'});f.manager.start(['3']);await f.manager.wait();assert.equal(f.manager.state().phase,'paused');assert.equal(f.manager.state().done,0);assert.equal(f.manager.job.items[0].state,'waiting');assert.match(f.manager.state().message,/fixture worker timeout/);});
test('repair of a failed NAS task preserves its explicit source',async t=>{const f=await setup(t);missingFile(f);f.queue.jobs=[{id:'3',state:'failed',source:'nas'}];let options;f.queue.enqueue=(ids,o)=>{f.queued.push(...ids);options=o;};f.manager.start(['3']);await f.manager.wait();assert.equal(options.source,'nas');assert.deepEqual(f.queued,['3']);});
test('large scan is cancellable and returns a bounded page instead of all problem details',async t=>{const f=await setup(t);f.store.db.run('BEGIN');for(let n=10;n<5010;n++)f.store.db.run('INSERT INTO works VALUES(?,?)',[String(n),JSON.stringify({id:String(n),name:'large '+n,type:'video',images:[],author:{nickname:'fixture'},thumbnail:'https://p3.douyinpic.com/x.png'})]);f.store.db.run('COMMIT');let pulses=0;const timer=setInterval(()=>pulses++,1);f.manager.onChange=()=>{if(f.manager.scanState?.checked>=200)f.manager.stop();};const report=await f.manager.scan({compact:true});clearInterval(timer);assert.ok(pulses>1);assert.equal(report.cancelled,true);assert.ok(report.checked<5003);assert.ok(report.items.length<=20);assert.ok(Buffer.byteLength(JSON.stringify(report))<16000);});

test('scanner lists unbacked cover and downloaded defect but excludes never-downloaded healthy works',async t=>{
 const f=await setup(t);missingFile(f);const report=await f.manager.scan();assert.equal(report.checked,3);assert.deepEqual(report.items.map(i=>i.id),['3','1']);assert.equal(report.covers,1);assert.equal(report.files,1);assert.equal(f.calls.length,0);assert.equal(f.queued.length,0);
});
test('single missing cover refreshes only its work, writes local cache and keeps collection order',async t=>{
 const f=await setup(t),before=f.store.orderedMemberRows('__all__');f.manager.start(['1']);await f.manager.wait();
 assert.deepEqual(f.calls,['1']);assert.deepEqual(f.store.orderedMemberRows('__all__'),before);assert.deepEqual(fs.readFileSync(path.join(f.dir,'covers','1.jpg')),png);assert.equal(f.manager.state().done,1);assert.equal(f.store.all('downloads').length,0);assert.equal(f.store.work('1').backupCover,undefined,'not advertised as NAS-backed before upload');
});
test('bulk cover refresh uses background-only lookup and passes the cancellation signal',async t=>{const f=await setup(t),resolve=f.collector.resolveWork;f.collector.resolveWork=async(id,options)=>{assert.equal(options?.backgroundOnly,true);assert.equal(options?.signal,f.manager.controller.signal);return resolve(id);};f.manager.start(['1']);await f.manager.wait();assert.equal(f.manager.state().done,1);});
test('source 404 is retained as one failed item and does not stop other cover repairs',async t=>{
 const f=await setup(t);f.store.put('works','3',{...f.store.work('3'),backupCover:undefined});f.backup.fetchCover=async url=>url.includes('/1.')?new Response('{}',{status:404}):new Response(png,{headers:{'content-type':'image/png'}});
 f.manager.start(['1','3']);await f.manager.wait();assert.equal(f.manager.state().failed,1);assert.equal(f.manager.state().done,1);assert.match(f.manager.state().items[0].message,/404/);assert.equal(f.backup.covers.problems.get('1').kind,'source');
});
test('media repairs are queued after cover work ends and only for previously requested media',async t=>{
 const f=await setup(t);missingFile(f);f.queue.enqueue=ids=>{assert.equal(f.backup.localReadDepth,0);f.queued.push(...ids);};f.manager.start(['1','2','3']);await f.manager.wait();assert.deepEqual(f.calls,['1']);assert.deepEqual(f.queued,['3']);assert.equal(f.manager.state().items.find(i=>i.id==='2').state,'skipped');
});
test('a failed cover does not prevent independent file repair for the same work',async t=>{
 const f=await setup(t);missingFile(f,'1');f.backup.fetchCover=async()=>new Response('{}',{status:404});f.manager.start(['1']);await f.manager.wait();assert.deepEqual(f.queued,['1']);assert.equal(f.manager.state().failed,1);
});
test('stop keeps completed cover and resumes only waiting items without re-reading healthy collection',async t=>{
 const f=await setup(t);f.store.put('works','3',{...f.store.work('3'),backupCover:undefined});const original=f.collector.resolveWork;let stopped=false;
 f.collector.resolveWork=async id=>{if(id==='3'&&!stopped){stopped=true;f.manager.stop();throw new DOMException('aborted','AbortError');}return original(id);};
 f.manager.start(['1','3']);await f.manager.wait();assert.equal(f.manager.state().phase,'paused');assert.equal(f.manager.state().done,1);assert.deepEqual(f.calls,['1']);
 f.manager.start(null,{resume:true});await f.manager.wait();assert.deepEqual(f.calls,['1','3']);assert.equal(f.manager.state().done,2);
});
test('local SQLite task record survives restart and resume excludes successful items',async t=>{
 const f=await setup(t);f.collector.resolveWork=async()=>{f.manager.stop();throw new DOMException('aborted','AbortError');};f.manager.start(['1']);await f.manager.wait();
 const resumed=f.reopen();assert.equal(resumed.state().phase,'paused');f.collector.resolveWork=async id=>{f.calls.push(id);return f.store.upsertWork(raw(id));};resumed.start(null,{resume:true});await resumed.wait();assert.equal(resumed.state().done,1);
});
test('changed account refuses saved task continuation',async t=>{
 const f=await setup(t);f.manager.start(['1']);await f.manager.wait();f.store.setSetting('browserAccountKey','uid:2');assert.throws(()=>f.manager.start(null,{resume:true}),/同账号/);
});
test('rate limit pauses remaining defects instead of repeatedly calling platform',async t=>{
 const f=await setup(t);f.store.put('works','3',{...f.store.work('3'),backupCover:undefined});f.collector.resolveWork=async id=>{f.calls.push(id);f.store.setSetting('accessHoldUntil',Date.now()+60000);throw new Error('平台限制访问');};
 f.manager.start(['1','3']);await f.manager.wait();assert.deepEqual(f.calls,['1']);assert.equal(f.manager.state().phase,'paused');assert.equal(f.manager.job.items.find(i=>i.id==='3').state,'waiting');
});
test('repair refresh can finish locally after NAS goes offline, but new media jobs do not start offline',async t=>{
 const f=await setup(t);missingFile(f);f.collector.resolveWork=async id=>{f.backup.unavailable('read ECONNRESET');return f.store.upsertWork(raw(id));};
 f.manager.start(['1','3']);await f.manager.wait();assert.equal(f.manager.state().phase,'paused');assert.equal(f.manager.state().done,1);assert.deepEqual(f.queued,[]);assert.equal(f.manager.state().items.find(i=>i.id==='3').state,'waiting');
});
