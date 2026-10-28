import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {Store} from '../electron/store.mjs';import {DownloadQueue} from '../electron/downloads.mjs';
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-work-diagnostic-')),store=await Store.open(path.join(dir,'library.sqlite'),path.join(dir,'media'));
 const id='1';store.upsertWork({aweme_id:id,desc:'private fixture title',author:{nickname:'private fixture author'},video:{play_addr:{url_list:['https://v3.douyinvod.com/fixture.mp4?msToken=secret-value']},cover:{url_list:['https://p3.douyinpic.com/fixture.jpg']}}});store.ingestMembers('__all__',[id],true);
 let transfers=0;const queue=new DownloadQueue(store,{},async()=>{transfers++;return new Response('verified new video',{headers:{'content-type':'video/mp4'}});},()=>{});
 const dest=store.destination(id);fs.mkdirSync(dest.dir,{recursive:true});fs.writeFileSync(path.join(dest.dir,'视频.mp4'),'original unregistered bytes');fs.writeFileSync(path.join(dest.dir,'单图.jpg'),'cover');
 const d={id,path:dest.dir,home:dest.home,collectionId:dest.collectionId,state:'partial',assets:[{key:'cover',file:'单图.jpg',kind:'image',size:5}]};queue.saveMetadata(store.work(id),d);store.put('downloads',id,d);store.save();fs.writeFileSync(path.join(dest.dir,'作品信息.json.part'),'');
 t.after(async()=>{await queue.waitForIdle();await store.fileStates.close();store.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 return {id,dir,store,queue,d,get transfers(){return transfers;}};
}
test('an unregistered existing video survives repair and the second retry does not download again',async t=>{
 const f=await fixture(t);await f.queue.enqueue([f.id]);await f.queue.waitForIdle();
 assert.equal(fs.readFileSync(path.join(f.d.path,'视频.mp4'),'utf8'),'original unregistered bytes');
 const saved=f.store.download(f.id);assert.equal(saved.state,'complete');const video=saved.assets.find(a=>a.key==='video');assert.notEqual(video.file,'视频.mp4');assert.equal(fs.readFileSync(path.join(saved.path,video.file),'utf8'),'verified new video');
 assert.equal(f.queue.jobs.find(j=>j.id===f.id).state,'complete');await f.queue.enqueue([f.id]);await f.queue.waitForIdle();assert.equal(f.transfers,1);
 const metadata=JSON.parse(fs.readFileSync(path.join(saved.path,'作品信息.json'),'utf8'));assert.equal(metadata.workId,f.id);assert.ok(metadata.assets.some(a=>a.key==='video'&&a.file===video.file));
});
test('focused diagnostics include current manifest and file facts without private data or modifying records',async t=>{
 const {buildWorkDiagnostic}=await import('../electron/work-diagnostic.mjs'),f=await fixture(t);f.store.upsertWork({aweme_id:'2',desc:'unrelated private work'});
 f.store.put('downloads',f.id,{...f.store.download(f.id),lastError:'C:/Users/private/file.mp4?msToken=secret-value'});const before=f.store.rows('SELECT body FROM downloads WHERE id=?',[f.id])[0].body;
 const report=await buildWorkDiagnostic(f.store,f.id),text=JSON.stringify(report);
 assert.equal(report.workId,'1');assert.equal(report.downloadState,'partial');assert.deepEqual(report.requiredKeys,['video','cover','metadata']);assert.ok(report.unregisteredFiles.some(a=>a.file==='视频.mp4'&&a.size===27));
 assert.equal(f.store.rows('SELECT body FROM downloads WHERE id=?',[f.id])[0].body,before);for(const privateText of ['secret-value','msToken','C:/Users','unrelated private work',f.dir,'private fixture title','private fixture author'])assert.ok(!text.includes(privateText),privateText);
 assert.ok(Buffer.byteLength(text)<=128*1024);assert.equal(f.transfers,0);
});
test('large and malicious asset summaries remain bounded and do not expose outside paths',async t=>{
 const {buildWorkDiagnostic}=await import('../electron/work-diagnostic.mjs'),f=await fixture(t);
 f.store.put('downloads',f.id,{...f.d,assets:Array.from({length:400},(_,n)=>({key:'image-'+n,file:'../../private-sensitive-file',kind:'image',size:12}))});
 const report=await buildWorkDiagnostic(f.store,f.id);assert.ok(report.assets.length<=256);assert.equal(report.truncated,true);assert.ok(report.assets.every(a=>a.state==='unsafe'));assert.ok(!JSON.stringify(report).includes('private-sensitive-file'));assert.ok(Buffer.byteLength(JSON.stringify(report))<=128*1024);
});
test('diagnostic byte limit includes formatted JSON and long Unicode names',async t=>{
 const {buildWorkDiagnostic}=await import('../electron/work-diagnostic.mjs'),f=await fixture(t);
 f.store.put('downloads',f.id,{...f.d,assets:Array.from({length:256},(_,n)=>({key:'image-'+n,file:'图'.repeat(150)+'.jpg',kind:'image',size:12}))});
 const report=await buildWorkDiagnostic(f.store,f.id);assert.ok(Buffer.byteLength(JSON.stringify(report,null,2))<=128*1024);assert.equal(report.truncated,true);
});
