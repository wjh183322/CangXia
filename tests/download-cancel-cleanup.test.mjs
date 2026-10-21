import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../electron/store.mjs';
import {DownloadQueue} from '../electron/downloads.mjs';
import {BackupClient} from '../electron/backup-client.mjs';
import {BackupTransport} from '../electron/backup-transport.mjs';
import http from 'node:http';

async function until(predicate){for(let n=0;n<500;n++){if(predicate())return;await delay(10);}assert.fail('download fixture timed out');}
async function fixture(t){const base=fs.mkdtempSync(path.join(os.tmpdir(),'cx-cancel-owned-')),file=path.join(base,'db.sqlite'),media=path.join(base,'media');let store=await Store.open(file,media),queue;
 t.after(async()=>{queue?.pause();await queue?.waitForIdle();store.close();assert.equal(path.dirname(base),os.tmpdir());fs.rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 return {base,file,media,get store(){return store;},queue(fetcher,collector={}){queue=new DownloadQueue(store,collector,fetcher,()=>{});return queue;},async reopen(){await queue?.waitForIdle();store.close();store=await Store.open(file,media);return store;}};
}
function images(store,id='1'){store.upsertWork({aweme_id:id,desc:'cancel fixture '+id,images:[{url_list:['https://p3.douyinpic.com/1.jpg']},{url_list:['https://p3.douyinpic.com/2.jpg']}]});}
function slowImages(){let started=false;return {get started(){return started;},fetch:async(url,{signal})=>{if(url.endsWith('/1.jpg'))return new Response('first-image',{headers:{'content-type':'image/jpeg'}});started=true;return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2,3]));signal.addEventListener('abort',()=>controller.error(signal.reason),{once:true});}}),{headers:{'content-type':'image/jpeg','content-length':'100',etag:'"fixture"'}});}};}

test('a NAS restore without queue ownership preserves a pre-existing metadata temporary file',async t=>{
 const f=await fixture(t),s=f.store;images(s);const dir=s.destination('1').dir;fs.mkdirSync(dir,{recursive:true});const temporary=path.join(dir,'作品信息.json.tmp');fs.writeFileSync(temporary,'prior-temporary');s.put('downloads','1',{id:'1',path:dir,state:'partial',assets:[]});s.put('backup_downloads','1',{id:'1',state:'complete',assets:[{key:'image-0',kind:'image',file:'nas.jpg',size:3,sha256:'0'.repeat(64)}]});
 const client=Object.create(BackupClient.prototype);Object.assign(client,{store:s,assertWritable(){},transport:{download:async(_asset,file)=>fs.writeFileSync(file,'nas')}});assert.equal(await client.restoreWork({id:'1'},new AbortController().signal,()=>({workId:'1'})),true);assert.equal(fs.readFileSync(temporary,'utf8'),'prior-temporary');assert.ok(fs.existsSync(path.join(dir,'作品信息.json')));
});

test('cancelling queued jobs with no outputs does not rescan the saved media library per job',async t=>{
 const f=await fixture(t),s=f.store,ids=Array.from({length:20},(_,i)=>String(100+i));for(const id of ids)images(s,id);for(let n=0;n<50;n++)s.put('downloads',String(1000+n),{id:String(1000+n),path:path.join(f.media,'existing-'+n),state:'complete',assets:[]});const q=f.queue(null);q.run=async()=>{};q.enqueue(ids);let scans=0;const all=s.all.bind(s);s.all=table=>{if(table==='downloads')scans++;return all(table);};const result=await q.cancel(ids);assert.equal(result.cancelled,20);assert.equal(result.cleanupFailed,0);assert.equal(scans,0);assert.equal(s.all('downloads').length,50);
});

test('cancel removes finalized and resumable files of an unfinished task while retaining records and completed tasks',async t=>{
 const f=await fixture(t),s=f.store;images(s);images(s,'2');s.ingestMembers('__all__',['1'],true);s.put('backup_downloads','1',{id:'1',state:'complete',assets:[{file:'NAS-original'}]});
 const other=path.join(f.media,'completed');fs.mkdirSync(other,{recursive:true});fs.writeFileSync(path.join(other,'done.jpg'),'completed');s.put('downloads','2',{id:'2',path:other,state:'complete',assets:[{key:'image-0',file:'done.jpg',kind:'image'}]});s.setSetting('downloadJobs',[{id:'2',state:'complete'}]);
 const source=slowImages(),q=f.queue(source.fetch);q.enqueue(['1']);await until(()=>source.started&&s.download('1')?.assets.length===1);const dir=s.download('1').path;
 const result=await q.cancel();await q.waitForIdle();assert.equal(result.cancelled,1);assert.deepEqual(fs.readdirSync(dir),[]);assert.equal(s.download('1'),null);assert.ok(s.hasRead('1'));assert.deepEqual(s.get('backup_downloads','1').assets,[{file:'NAS-original'}]);assert.equal(fs.readFileSync(path.join(other,'done.jpg'),'utf8'),'completed');assert.deepEqual(q.jobs.map(j=>j.id),['2']);
});

test('pause and restart preserve the first task baseline so cancel still removes files written before pause',async t=>{
 const f=await fixture(t);images(f.store);const source=slowImages(),q=f.queue(source.fetch);q.enqueue(['1']);await until(()=>source.started);q.pause();await q.waitForIdle();const dir=f.store.download('1').path;assert.ok(fs.readdirSync(dir).includes('图片-001.jpg'));assert.ok(fs.readdirSync(dir).some(n=>n.endsWith('.part')));
 await f.reopen();const restarted=f.queue(null);assert.equal(restarted.jobs[0].state,'waiting');await restarted.cancel(['1']);assert.deepEqual(fs.readdirSync(dir),[]);assert.equal(f.store.download('1'),null);
});

test('pre-task files and partial progress survive cancel, including repair assets and unrelated new files',async t=>{
 const f=await fixture(t),s=f.store;images(s);const dir=s.destination('1').dir;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'old.jpg'),'original');fs.writeFileSync(path.join(dir,'图片-002.jpg.part'),'old-partial');fs.writeFileSync(path.join(dir,'图片-002.resume.json'),'old-checkpoint');fs.writeFileSync(path.join(dir,'作品信息.json'),'{"original":true}');fs.writeFileSync(path.join(dir,'作品信息.json.part'),'metadata-progress');
 const original={id:'1',path:dir,state:'partial',assets:[{key:'image-0',file:'old.jpg',kind:'image',size:8},{key:'metadata',file:'作品信息.json',kind:'metadata',size:17}]};s.put('downloads','1',original);
 const source=slowImages(),q=f.queue(source.fetch);q.enqueue(['1']);await until(()=>source.started);fs.writeFileSync(path.join(dir,'unrelated.txt'),'someone else');await q.cancel(['1']);
 assert.equal(fs.readFileSync(path.join(dir,'old.jpg'),'utf8'),'original');assert.ok(fs.existsSync(path.join(dir,'图片-002.jpg.part')));assert.ok(fs.existsSync(path.join(dir,'图片-002.resume.json')));assert.equal(fs.readFileSync(path.join(dir,'unrelated.txt'),'utf8'),'someone else');assert.equal(fs.readFileSync(path.join(dir,'作品信息.json'),'utf8'),'{"original":true}');assert.equal(fs.readFileSync(path.join(dir,'作品信息.json.part'),'utf8'),'metadata-progress');assert.deepEqual(s.download('1'),original);
});

test('a source lookup canceled before any owned writes preserves existing and independently created files',async t=>{
 const f=await fixture(t),s=f.store;images(s);let lookup=false;const q=f.queue(async()=>{throw Object.assign(Error('expired'),{refreshable:true,sourceUnavailable:true});},{resolveWork:async(_id,{signal})=>{lookup=true;await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
 q.enqueue(['1']);await until(()=>lookup);const dir=s.download('1').path;fs.writeFileSync(path.join(dir,'external.jpg'),'external');await q.cancel(['1']);assert.equal(fs.readFileSync(path.join(dir,'external.jpg'),'utf8'),'external');assert.equal(q.jobs.length,0);
});

test('cleanup refuses a swapped directory junction, retains a visible failed row, and retries after restart',async t=>{
 const f=await fixture(t);images(f.store);const source=slowImages(),q=f.queue(source.fetch);q.enqueue(['1']);await until(()=>source.started);q.pause();await q.waitForIdle();const dir=f.store.download('1').path,moved=dir+'-held',outside=path.join(f.base,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'图片-001.jpg'),'outside-preserved');fs.renameSync(dir,moved);fs.symlinkSync(outside,dir,'junction');
 const report=await q.cancel(['1']);assert.equal(report.cancelled,0);assert.equal(report.cleanupFailed,1);assert.equal(q.jobs[0].state,'failed');assert.match(q.jobs[0].message,/清理失败/);assert.equal(fs.readFileSync(path.join(outside,'图片-001.jpg'),'utf8'),'outside-preserved');assert.equal((await q.retryFailed()).queued,0);assert.throws(()=>q.enqueue(['1']),/清理/);
 await f.reopen();const restarted=f.queue(null);assert.equal(restarted.jobs[0].state,'failed');fs.unlinkSync(dir);fs.renameSync(moved,dir);const retried=await restarted.cancel(['1']);assert.equal(retried.cancelled,1);assert.deepEqual(fs.readdirSync(dir),[]);assert.equal(f.store.download('1'),null);
});

test('cancel protects task output referenced by another work and shared audio',async t=>{
 const f=await fixture(t),s=f.store;images(s);images(s,'2');const source=slowImages(),q=f.queue(source.fetch);q.enqueue(['1']);await until(()=>source.started);const d=s.download('1'),file=path.join(d.path,'图片-001.jpg');s.put('downloads','2',{id:'2',path:d.path,assets:[{key:'image-0',file:'图片-001.jpg',kind:'image'}],state:'complete'});
 const audio=path.join(d.path,'shared-audio.mp3');q.trackDownloadFile(q.jobs[0],audio);fs.writeFileSync(audio,'audio');s.db.run('INSERT INTO audio_objects VALUES(?,?)',['shared',JSON.stringify({relative:path.relative(s.root,audio),root:s.root})]);
 const report=await q.cancel(['1']);assert.equal(report.cancelled,1);assert.equal(fs.readFileSync(file,'utf8'),'first-image');assert.equal(fs.readFileSync(audio,'utf8'),'audio');assert.ok(!fs.readdirSync(d.path).some(n=>n.endsWith('.part')));assert.equal(s.download('1').assets[0].file,'图片-001.jpg');assert.ok(s.download('2'));
});

test('retry failed and re-enqueue unfinished work retain its epoch; a new task after completion protects old outputs',async t=>{
 const f=await fixture(t),s=f.store;images(s);const q=f.queue(async()=>{throw Object.assign(Error('offline'),{sourceUnavailable:true});});q.enqueue(['1']);await q.waitForIdle();const job=q.jobs[0],epoch=job.cancelOwnership.epoch,dir=s.download('1').path,file=path.join(dir,'task-created.jpg');q.writeOwnedFile(job,file,'owned');
 await q.retryFailed(['1']);await q.waitForIdle();assert.equal(q.jobs[0].cancelOwnership.epoch,epoch);q.enqueue(['1']);await q.waitForIdle();assert.equal(q.jobs[0].cancelOwnership.epoch,epoch);await q.cancel(['1']);assert.equal(fs.existsSync(file),false);
 const source=slowImages(),next=f.queue(source.fetch);next.enqueue(['1']);await until(()=>source.started);next.pause();await next.waitForIdle();next.jobs[0].state='complete';next.emit(true);const firstEpoch=next.jobs[0].cancelOwnership.epoch,old=path.join(s.download('1').path,'图片-001.jpg');next.run=async()=>{};next.enqueue(['1']);assert.notEqual(next.jobs[0].cancelOwnership.epoch,firstEpoch);await next.cancel(['1']);assert.equal(fs.readFileSync(old,'utf8'),'first-image');
});

test('cancel during NAS restore removes its exact registered files and partials while preserving previous complete local content',async t=>{
 const f=await fixture(t),s=f.store;images(s);const dir=s.destination('1').dir;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'original.jpg'),'keep');const original={id:'1',path:dir,state:'complete',assets:[{key:'image-0',file:'original.jpg',kind:'image'}]};s.put('downloads','1',original);const q=f.queue(null);let started=false;
 q.backupRestore=async(job,signal)=>{const added=path.join(dir,'restored.jpg'),partial=path.join(dir,'next.jpg');job.trackDownloadFile(added);job.trackDownloadFile(partial);q.writeOwnedFile(job,added,'new');q.writeOwnedFile(job,partial+'.backup-part','partial');s.put('downloads','1',{...original,state:'partial',assets:[...original.assets,{key:'image-1',file:'restored.jpg',kind:'image'}]});started=true;await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
 q.enqueue(['1'],{source:'nas'});await until(()=>started);await q.cancel(['1']);assert.deepEqual(fs.readdirSync(dir),['original.jpg']);assert.deepEqual(s.download('1'),original);
});

test('a partial cleanup failure immediately removes deleted files from the registered manifest',async t=>{
 const f=await fixture(t),s=f.store;images(s);const source=slowImages(),q=f.queue(source.fetch);q.enqueue(['1']);await until(()=>source.started);q.pause();await q.waitForIdle();const dir=s.download('1').path,blocked=path.join(dir,'图片-002.jpg.part');fs.unlinkSync(blocked);fs.mkdirSync(blocked);
 const report=await q.cancel(['1']);assert.equal(report.cleanupFailed,1);assert.equal(fs.existsSync(path.join(dir,'图片-001.jpg')),false);assert.ok(!s.download('1')?.assets.some(a=>a.file==='图片-001.jpg'),'deleted files cannot remain registered while cleanup awaits retry');fs.rmdirSync(blocked);assert.equal((await q.cancel(['1'])).cancelled,1);
});

test('a paused task moved to another collection folder retains ownership of files written before the move',async t=>{
 const f=await fixture(t),s=f.store;images(s);const source=slowImages(),q=f.queue(source.fetch);q.enqueue(['1']);await until(()=>source.started);q.pause();await q.waitForIdle();const old=s.download('1').path,c=s.collection('__all__');s.put('collections','__all__',{...c,folder:'renamed-folder'});q.resume();await until(()=>s.download('1').path!==old&&q.jobs[0].phase==='transferring');q.pause();await q.waitForIdle();const moved=s.download('1').path;await q.cancel(['1']);assert.deepEqual(fs.readdirSync(moved),[]);assert.equal(s.download('1'),null);
});


test('canceling an unfinished cover-only repair removes its newly published cover and retains the original video and cover',async t=>{
 const f=await fixture(t),s=f.store;s.upsertWork({aweme_id:'1',desc:'video fixture',video:{play_addr:{url_list:[]}}});const dir=s.destination('1').dir;fs.mkdirSync(dir,{recursive:true});for(const name of ['video.mp4','cover.jpg'])fs.writeFileSync(path.join(dir,name),'original');const original={id:'1',path:dir,state:'complete',assets:[{key:'video',file:'video.mp4',kind:'video',size:8},{key:'cover',file:'cover.jpg',kind:'image',size:8}]};s.put('downloads','1',original);const q=f.queue(null);let published=false;
 q.hdCovers={ensure:async(_queue,_work,d,signal,_progress,writeOutput)=>{writeOutput(path.join(dir,'高清封面-new.jpg'),Buffer.from('new-cover'));d.assets.push({key:'cover-hd-new',file:'高清封面-new.jpg',kind:'image',size:9});published=true;await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}};
 q.enqueue(['1'],{coverOnly:true});await until(()=>published);await q.cancel(['1']);assert.deepEqual(fs.readdirSync(dir),['cover.jpg','video.mp4']);assert.deepEqual(s.download('1'),original);
});

test('real NAS restoration registers ownership before relocation, transport writes, and metadata publication',async t=>{
 const f=await fixture(t),s=f.store;images(s);const old=s.destination('1').dir;fs.mkdirSync(old,{recursive:true});fs.writeFileSync(path.join(old,'legacy.txt'),'pre-existing');s.put('downloads','1',{id:'1',path:old,state:'partial',assets:[]});s.put('collections','__all__',{...s.collection('__all__'),folder:'nas-moved'});s.put('backup_downloads','1',{id:'1',state:'complete',assets:[{key:'image-0',kind:'image',file:'nas.jpg',size:3,sha256:'0'.repeat(64)}]});
 const q=f.queue(null);q.run=async()=>{};q.enqueue(['1'],{source:'nas'});const job=q.jobs[0],target=s.destination('1').dir;let relocationPrepared=false;const tracked=[];
 job.trackDownloadRelocation=()=>{assert.ok(fs.existsSync(old),'ownership must be remapped before the old directory moves');assert.equal(fs.existsSync(target),false);q.prepareDownloadRelocation(job);relocationPrepared=true;};
 job.trackDownloadFile=file=>{assert.equal(fs.existsSync(file),false,'ownership must be durable before file publication');tracked.push(file);q.trackDownloadFile(job,file);q.trackDownloadFile(job,file+'.backup-part');};
 job.downloadFileIdentity=(file,stat,options)=>q.downloadFileIdentity(job,file,stat,options);
 const client=Object.create(BackupClient.prototype);Object.assign(client,{store:s,assertWritable(){},transport:{download:async(_asset,file,{onFileWrite})=>{assert.equal(relocationPrepared,true,'NAS relocation must retain the original task epoch');assert.ok(job.cancelOwnership.files.some(v=>v.file===file&&!v.preserve));assert.ok(job.cancelOwnership.files.some(v=>v.file===file+'.backup-part'&&!v.preserve));const descriptor=fs.openSync(file,'wx');try{onFileWrite(file,fs.fstatSync(descriptor));fs.writeFileSync(descriptor,'nas');onFileWrite(file,fs.fstatSync(descriptor),{settled:true});}finally{fs.closeSync(descriptor);}}}});
 await client.restoreWork(job,new AbortController().signal,()=>({workId:'1'}));
 assert.deepEqual(tracked,[path.join(target,'nas.jpg'),path.join(target,'作品信息.json'),path.join(target,'作品信息.json.tmp')]);await q.cancel(['1']);assert.deepEqual(fs.readdirSync(target),['legacy.txt']);assert.equal(fs.readFileSync(path.join(target,'legacy.txt'),'utf8'),'pre-existing');
});

test('cancel does not claim unused extension filenames created by an independent writer',async t=>{
 const f=await fixture(t),s=f.store;images(s);const source=slowImages(),q=f.queue(source.fetch);q.enqueue(['1']);await until(()=>source.started);const dir=s.download('1').path,unrelated=path.join(dir,'图片-002.png');fs.writeFileSync(unrelated,'independent-png');await q.cancel(['1']);assert.equal(fs.readFileSync(unrelated,'utf8'),'independent-png');assert.deepEqual(fs.readdirSync(dir),['图片-002.png']);
});

test('cancel preserves metadata replaced by an independent writer after the task saved metadata',async t=>{
 const f=await fixture(t),s=f.store;images(s);const dir=s.destination('1').dir;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'作品信息.json'),'{"original":true}');s.put('downloads','1',{id:'1',path:dir,state:'partial',assets:[{key:'metadata',file:'作品信息.json',kind:'metadata',size:17}]});const q=f.queue(async()=>{throw Object.assign(Error('offline'),{sourceUnavailable:true});});q.enqueue(['1']);await q.waitForIdle();const file=path.join(s.download('1').path,'作品信息.json');fs.writeFileSync(file,'independent metadata');await q.cancel(['1']);assert.equal(fs.readFileSync(file,'utf8'),'independent metadata');
});

test('real NAS restore leaves progress that existed before task creation in place',async t=>{
 const f=await fixture(t),s=f.store;images(s);const dir=s.destination('1').dir;fs.mkdirSync(dir,{recursive:true});const partial=path.join(dir,'nas.jpg.backup-part');fs.writeFileSync(partial,'original-progress');s.put('downloads','1',{id:'1',path:dir,state:'partial',assets:[]});s.put('backup_downloads','1',{id:'1',state:'complete',assets:[{key:'image-0',kind:'image',file:'nas.jpg',size:3,sha256:'0'.repeat(64)}]});const q=f.queue(null);q.run=async()=>{};q.enqueue(['1'],{source:'nas'});const job=q.jobs[0];job.downloadFileIdentity=(file,stat,options)=>q.downloadFileIdentity(job,file,stat,options);job.isPreTaskDownloadFile=file=>job.cancelOwnership.dirs.some(d=>d.dir===path.dirname(file)&&d.existing.includes(path.basename(file)));job.trackDownloadFile=file=>{q.trackDownloadFile(job,file);q.trackDownloadFile(job,file+'.backup-part');};const client=Object.create(BackupClient.prototype);Object.assign(client,{store:s,assertWritable(){},transport:{download:async(_asset,file,{onFileWrite})=>{const temporary=file+'.backup-part',descriptor=fs.openSync(temporary,'wx');let identity;try{onFileWrite(temporary,fs.fstatSync(descriptor));fs.writeFileSync(descriptor,'nas');identity=fs.fstatSync(descriptor);onFileWrite(temporary,identity,{settled:true});}finally{fs.closeSync(descriptor);}fs.renameSync(temporary,file);onFileWrite(file,identity,{settled:true});}}});await client.restoreWork(job,new AbortController().signal,()=>({}));assert.equal((await q.cancel(['1'])).cleanupFailed,0);assert.equal(fs.readFileSync(partial,'utf8'),'original-progress');
});


test('cancel restores original metadata even when its pre-task contents exceed two megabytes',async t=>{
 const f=await fixture(t),s=f.store;images(s);const dir=s.destination('1').dir;fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'作品信息.json'),original=JSON.stringify({padding:'x'.repeat(2*1024*1024),original:true});fs.writeFileSync(file,original);s.put('downloads','1',{id:'1',path:dir,state:'partial',assets:[{key:'metadata',file:'作品信息.json',kind:'metadata',size:Buffer.byteLength(original)}]});const q=f.queue(async()=>{throw Object.assign(Error('offline'),{sourceUnavailable:true});});q.enqueue(['1']);await q.waitForIdle();await q.cancel(['1']);assert.equal(fs.readFileSync(file,'utf8')===original,true,'original metadata bytes must be preserved');
});


test('canceling a legacy task with unprovable existing files reports retained data instead of claiming cleanup',async t=>{
 const f=await fixture(t),s=f.store;images(s);const dir=s.destination('1').dir;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'legacy.jpg.part'),'unknown-original');s.put('downloads','1',{id:'1',path:dir,state:'partial',assets:[]});s.setSetting('downloadJobs',[{id:'1',state:'failed'}]);const q=f.queue(null),report=await q.cancel(['1']);assert.equal(report.cancelled,0);assert.equal(report.cleanupFailed,1);assert.match(q.jobs[0].message,/旧任务|归属/);assert.equal(fs.readFileSync(path.join(dir,'legacy.jpg.part'),'utf8'),'unknown-original');await f.reopen();const restarted=f.queue(null);assert.equal(restarted.jobs[0].state,'failed');assert.equal((await restarted.retryFailed()).queued,0);fs.unlinkSync(path.join(dir,'legacy.jpg.part'));assert.equal((await restarted.cancel(['1'])).cancelled,1);
});

for(const name of ['图片-002.jpg.part','图片-002.resume.json'])test('cancel preserves an independently replaced paused '+name,async t=>{
 const f=await fixture(t),s=f.store;images(s);const source=slowImages(),q=f.queue(source.fetch);q.enqueue(['1']);await until(()=>source.started&&s.download('1')&&fs.statSync(path.join(s.download('1').path,'图片-002.jpg.part'),{throwIfNoEntry:false})?.size>0);q.pause();await q.waitForIdle();const file=path.join(s.download('1').path,name);assert.ok(fs.existsSync(file));fs.unlinkSync(file);fs.writeFileSync(file,'independent replacement');await q.cancel(['1']);assert.equal(fs.readFileSync(file,'utf8'),'independent replacement');
});

test('paused task ownership follows the real background reconciliation move',async t=>{
 const f=await fixture(t),s=f.store;images(s);s.ingestMembers('__all__',['1'],true);const source=slowImages(),q=f.queue(source.fetch);q.enqueue(['1']);await until(()=>source.started);q.pause();await q.waitForIdle();const old=s.download('1').path;s.put('collections','__all__',{...s.collection('__all__'),folder:'background-move'});assert.deepEqual(await s.reconcilePending(),[]);const moved=s.download('1').path;assert.notEqual(moved,old);const report=await q.cancel(['1']);assert.equal(report.cleanupFailed,0);assert.deepEqual(fs.readdirSync(moved),[]);assert.equal(s.download('1'),null);
});

test('failed metadata relocation publication leaves a registered temporary file that cancel removes',async t=>{
 const f=await fixture(t),s=f.store;images(s);const dir=s.destination('1').dir;fs.mkdirSync(dir,{recursive:true});const info=path.join(dir,'作品信息.json');fs.writeFileSync(info,'{"original":true}');s.put('downloads','1',{id:'1',path:dir,state:'partial',assets:[{key:'metadata',file:'作品信息.json',kind:'metadata',size:17}]});const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(to===info)throw Object.assign(Error('metadata sharing violation'),{code:'EACCES'});return rename(from,to);};const q=f.queue(null);try{q.enqueue(['1']);await q.waitForIdle();}finally{fs.renameSync=rename;}assert.ok(fs.existsSync(info+'.part'));assert.equal(q.jobs[0].state,'failed');assert.equal((await q.cancel(['1'])).cleanupFailed,0);assert.deepEqual(fs.readdirSync(dir),['作品信息.json']);assert.equal(fs.readFileSync(info,'utf8'),'{"original":true}');
});

test('real NAS partial writer identity protects an independent replacement after pause',async t=>{
 const f=await fixture(t),s=f.store;images(s);const dir=s.destination('1').dir,asset={key:'image-0',kind:'image',file:'nas.jpg',size:100,sha256:'0'.repeat(64)};s.put('backup_downloads','1',{id:'1',state:'complete',assets:[asset]});const server=http.createServer((_request,response)=>{response.writeHead(200,{'content-length':'100'});response.write('nas');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const transport=new BackupTransport({url:'http://127.0.0.1:'+server.address().port,token:'fixture',deviceId:'fixture'});t.after(()=>{transport.close();server.closeAllConnections();server.close();});const client=Object.create(BackupClient.prototype);Object.assign(client,{store:s,transport,assertWritable(){},emit(){}});const q=f.queue(null);q.backupRestore=(job,signal)=>client.restoreWork(job,signal,()=>({}));q.enqueue(['1'],{source:'nas'});const file=path.join(dir,'nas.jpg.backup-part');await until(()=>{if(q.jobs[0]?.state==='failed')throw Error(q.jobs[0].message);return fs.statSync(file,{throwIfNoEntry:false})?.size>0;});q.pause();await q.waitForIdle();assert.ok(q.jobs[0].cancelOwnership.files.find(v=>v.file===file)?.identity,'partial writer must persist actual opened identity');fs.unlinkSync(file);fs.writeFileSync(file,'independent nas replacement');await q.cancel(['1']);assert.equal(fs.readFileSync(file,'utf8'),'independent nas replacement');
});


test('cover-only cancellation preserves an independently replaced published HD cover',async t=>{
 const f=await fixture(t),s=f.store;s.upsertWork({aweme_id:'1',desc:'video fixture',video:{play_addr:{url_list:[]}}});const dir=s.destination('1').dir;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'video.mp4'),'original');s.put('downloads','1',{id:'1',path:dir,state:'partial',assets:[{key:'video',file:'video.mp4',kind:'video',size:8}]});const q=f.queue(null),file=path.join(dir,'高清封面-new.jpg');let published=false;
 q.hdCovers={ensure:async(_queue,_work,d,signal,_progress,writeOutput)=>{if(writeOutput)writeOutput(file,Buffer.from('new-cover'));else fs.writeFileSync(file,'new-cover');d.assets.push({key:'cover-hd-new',file:'高清封面-new.jpg',kind:'image',size:9});published=true;await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}};q.enqueue(['1'],{coverOnly:true});await until(()=>published);fs.unlinkSync(file);fs.writeFileSync(file,'independent hd replacement');await q.cancel(['1']);assert.equal(fs.readFileSync(file,'utf8'),'independent hd replacement');
});
