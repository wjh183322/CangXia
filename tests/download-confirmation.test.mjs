import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../electron/store.mjs';
import {DownloadQueue} from '../electron/downloads.mjs';

async function fixture(t,state='partial'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-confirm-'));
 const store=await Store.open(path.join(dir,'library.sqlite'),path.join(dir,'media'));
 const id='1';store.upsertWork({aweme_id:id,desc:'confirmation fixture',author:{nickname:'fixture'},video:{play_addr:{url_list:['https://v3.douyinvod.com/fixture.mp4']},cover:{url_list:['https://p3.douyinpic.com/fixture.jpg']}}});store.ingestMembers('__all__',[id],true);
 let networkCalls=0;const queue=new DownloadQueue(store,{resolveWork:async()=>{throw Error('unexpected platform request');}},async()=>{networkCalls++;throw Error('unexpected transfer');},()=>{});
 const dest=store.destination(id);fs.mkdirSync(dest.dir,{recursive:true});
 const assets=[['video','视频.mp4','video','fixture video bytes'],['cover','单图.jpg','image','fixture cover bytes']].map(([key,file,kind,text])=>{fs.writeFileSync(path.join(dest.dir,file),text);return {key,file,kind,size:Buffer.byteLength(text)};});
 const d={id,...dest,path:dest.dir,state,assets};queue.saveMetadata(store.work(id),d);store.put('downloads',id,d);store.save();
 t.after(async()=>{await queue.waitForIdle();await store.fileStates.close();store.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 return {id,dir,store,queue,d,get networkCalls(){return networkCalls;},hashes:()=>Object.fromEntries(d.assets.map(a=>[a.key,createHash('sha256').update(fs.readFileSync(path.join(dest.dir,a.file))).digest('hex')]))};
}

test('partial record with complete registered files is promoted without download',async t=>{
 const f=await fixture(t),before=f.hashes();
 for(let i=0;i<2;i++){await f.queue.enqueue([f.id]);await f.queue.waitForIdle();assert.equal(f.queue.jobs.find(j=>j.id===f.id).state,'complete');assert.equal(f.store.download(f.id).state,'complete');}
 assert.equal(f.networkCalls,0);assert.deepEqual(f.hashes(),before);assert.equal(f.store.fileStates.get(f.id).status,'complete');
});

test('missing required video never passes even when all listed assets exist',async t=>{
 const f=await fixture(t,'complete');f.store.put('downloads',f.id,{...f.d,assets:f.d.assets.filter(a=>a.key!=='video')});
 let result;assert.equal(await f.store.fileStates.confirmWritten(f.id,{onResult:r=>{result=r;}}),false);
 assert.equal(result.code,'UNREGISTERED_ASSET');assert.ok(result.issues.some(a=>a.key==='video'));
});

test('registered size mismatch reports the specific asset and preserves the partial record',async t=>{
 const f=await fixture(t);fs.appendFileSync(path.join(f.d.path,'视频.mp4'),'changed');let result;
 assert.equal(await f.store.fileStates.confirmWritten(f.id,{onResult:r=>{result=r;}}),false);
 assert.equal(result.code,'SIZE_MISMATCH');assert.ok(result.issues.some(a=>a.key==='video'));assert.equal(f.store.download(f.id).state,'partial');
});

test('a record repeatedly changed during file confirmation is not promoted',async t=>{
 const f=await fixture(t),original=fsp.lstat;let changes=0;
 t.mock.method(fsp,'lstat',async(...args)=>{const stat=await original(...args);if(String(args[0])===path.join(f.d.path,'视频.mp4'))f.store.put('downloads',f.id,{...f.store.download(f.id),changedDuringCheck:++changes});return stat;});
 let result;assert.equal(await f.store.fileStates.confirmWritten(f.id,{onResult:r=>{result=r;}}),false);
 assert.equal(result.code,'RECORD_CHANGED');assert.ok(changes<=4);assert.equal(f.store.download(f.id).state,'partial');
});

test('a linked parent directory is never accepted as an owned asset',async t=>{
 const f=await fixture(t,'complete'),outside=path.join(f.dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'video.mp4'),'fixture video bytes');
 const link=path.join(f.d.path,'link');fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
 f.store.put('downloads',f.id,{...f.d,assets:f.d.assets.map(a=>a.key==='video'?{...a,file:'link/video.mp4'}:a)});
 let result;assert.equal(await f.store.fileStates.confirmWritten(f.id,{onResult:r=>{result=r;}}),false);assert.equal(result.code,'UNSAFE_PATH');
});

test('zero-byte metadata part does not invalidate valid final files',async t=>{
 const f=await fixture(t);fs.writeFileSync(path.join(f.d.path,'作品信息.json.part'),'');
 assert.equal(await f.store.fileStates.confirmWritten(f.id),true);assert.equal(f.store.download(f.id).state,'complete');assert.equal(fs.statSync(path.join(f.d.path,'作品信息.json.part')).size,0);
});

test('confirmation cancelled while files are read never promotes the record',async t=>{
 const f=await fixture(t,'complete'),controller=new AbortController(),original=fsp.lstat;
 t.mock.method(fsp,'lstat',async(...args)=>{const stat=await original(...args);if(String(args[0])===path.join(f.d.path,'视频.mp4'))controller.abort();return stat;});
 let result;assert.equal(await f.store.fileStates.confirmWritten(f.id,{signal:controller.signal,onResult:r=>{result=r;}}),false);assert.equal(result.code,'CANCELLED');assert.equal(f.store.fileStates.get(f.id),undefined);
});

test('a newer manifest cannot receive an older successful file-state cache',async t=>{
 const f=await fixture(t),save=f.store.save.bind(f.store);
 t.mock.method(f.store,'save',()=>{save();f.store.put('downloads',f.id,{...f.store.download(f.id),state:'partial',assets:f.d.assets.filter(a=>a.key!=='video')});});
 let result;assert.equal(await f.store.fileStates.confirmWritten(f.id,{onResult:r=>{result=r;}}),false);
 assert.equal(result.code,'RECORD_CHANGED');assert.equal(f.store.fileStates.get(f.id),undefined);assert.equal(f.store.download(f.id).state,'partial');
});
