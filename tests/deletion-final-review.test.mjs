import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {crossDeviceFixture,author} from './cross-device-fixture.mjs';
import {DeletionCoordinator} from '../electron/deletion-coordinator.mjs';
import {WorkAudio} from '../electron/work-audio.mjs';
import {audioFixture} from './audio-fixture.mjs';

test('legacy-hidden account recovery clears its old flag without changing other source masks',async t=>{
 const f=await crossDeviceFixture(t,{media:false}),b=f.b,c=f.catalogue(b);await c.refresh();
 b.store.put('works','1',{...b.store.work('1'),readHidden:true});
 b.store.deviceScopes.hide([{workId:'1',kind:'account',sourceId:'__all__'},{workId:'1',kind:'author',sourceId:author}]);
 let p=await c.prepareRestore({ids:['1'],records:true,sources:[{kind:'author',sourceId:author}]});
 await c.restore(p.token);assert.equal(b.store.hasRead('1'),false);assert.equal(b.store.work('1').readHidden,true);
 assert.equal(b.store.visibleAuthorRows('1').length,1);
 b.store.deviceScopes.hide([{workId:'1',kind:'author',sourceId:author}]);
 p=await c.prepareRestore({ids:['1'],records:true,sources:[{kind:'account',sourceId:'__all__'}]});
 const result=await c.restore(p.token);assert.equal(result.restoredRecords,1);
 assert.equal(b.store.hasRead('1'),true);assert.equal(b.store.work('1').readHidden,false);
 assert.equal(b.store.visibleAuthorRows('1').length,0);
});

test('a restore between local-nas batch items protects the remaining local file',async t=>{
 const f=await crossDeviceFixture(t),b=f.b;
 await b.restoreWork({id:'2'},new AbortController().signal,()=>({}));await b.sync();
 let trashed=0;
 const c=new DeletionCoordinator({store:b.store,backup:b,trash:async target=>{
  await fs.promises.rename(target,target+'.owned-recycled');
  if(++trashed===1){await b.release();await f.a.check();
   const page=f.a.deletions.page({kind:'files',query:'2'});
   assert.equal((await f.a.deletions.resolve({selection:{token:page.token,all:false,ids:['2']},action:'restore'})).restored,1);
  }
 }});
 const p=await c.prepare({ids:['1','2'],files:true,target:'local-nas'}),r=await c.confirm(p.token);
 assert.equal(trashed,1);assert.equal(r.localSucceeded,1);assert.equal(r.failed,1);
 assert.ok(b.store.download('2'));assert.ok(fs.existsSync(b.store.download('2').path));
 assert.ok(JSON.parse(f.server.db.prepare("SELECT body FROM records WHERE kind='downloads' AND id='2'").get().body).assets.length);
});

for(const changed of [false,true])test('retry after folder removal '+(changed?'protects replacement audio':'finishes the originally confirmed audio'),async t=>{
 const f=await crossDeviceFixture(t),b=f.b;
 const audio=new WorkAudio({store:b.store,backup:b,cache:b.cache,collector:{},canNetwork:()=>false,isIdle:()=>false});f.registerAudio(audio);
 const make=async n=>{const bytes=audioFixture();bytes[bytes.length-1]=n;const sha256=createHash('sha256').update(bytes).digest('hex'),file=path.join(f.root,'owned-audio-'+n+'.wav');await fs.promises.writeFile(file,bytes);return {file,sha256,size:bytes.length,format:'wav',duration:1};};
 const original=await make(1),replacement=await make(2);await audio.saveLocal('1',original,new AbortController().signal);
 let fail=true,trashes=0;
 const c=new DeletionCoordinator({store:b.store,backup:b,trash:async target=>{if(target.endsWith('.wav')&&fail)throw Error('owned audio trash denied');trashes++;await fs.promises.rename(target,target+'.owned-recycled');}});
 const p=await c.prepare({ids:['1'],files:true,target:'local'}),first=await c.confirm(p.token);assert.equal(first.failed,1);assert.equal(trashes,1);
 if(changed){await audio.removeLocal('1',{trash:target=>fs.promises.rename(target,target+'.owned-replaced')});
 await audio.saveLocal('1',replacement,new AbortController().signal);}fail=false;
 const chosen=changed?replacement:original,location=path.join(b.store.root,audio.getObject(chosen.sha256).relative),result=await c.retry(first.operationId);
 assert.equal(result.filesSucceeded,changed?0:1);assert.equal(result.failed,changed?1:0);assert.equal(trashes,changed?1:2);
 assert.equal(audio.ref('1').sha,chosen.sha256);assert.equal(audio.ref('1').local_saved,changed?1:0);assert.equal(fs.existsSync(location),changed);
});
