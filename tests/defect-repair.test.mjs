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

test('scanner lists unbacked cover and downloaded defect but excludes never-downloaded healthy works',async t=>{
 const f=await setup(t);missingFile(f);const report=await f.manager.scan();assert.equal(report.checked,3);assert.deepEqual(report.items.map(i=>i.id),['1','3']);assert.equal(report.covers,1);assert.equal(report.files,1);assert.equal(f.calls.length,0);assert.equal(f.queued.length,0);
});
test('single missing cover refreshes only its work, writes local cache and keeps collection order',async t=>{
 const f=await setup(t),before=f.store.orderedMemberRows('__all__');f.manager.start(['1']);await f.manager.wait();
 assert.deepEqual(f.calls,['1']);assert.deepEqual(f.store.orderedMemberRows('__all__'),before);assert.deepEqual(fs.readFileSync(path.join(f.dir,'covers','1.jpg')),png);assert.equal(f.manager.state().done,1);assert.equal(f.store.all('downloads').length,0);assert.equal(f.store.work('1').backupCover,undefined,'not advertised as NAS-backed before upload');
});
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
