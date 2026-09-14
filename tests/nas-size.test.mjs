import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {Store} from '../electron/store.mjs';import {NasLibrary} from '../electron/nas-library.mjs';

test('multi-megabyte metadata migration and subsequent commit retain writer ownership', {skip:process.platform!=='win32',timeout:240000},async()=>{
 const local=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-large-')),share=process.env.CANGXIA_NAS_LARGE_TEST_ROOT;
 const root=share?fs.mkdtempSync(path.join(share,'cangxia-owned-test-')):path.join(local,'share');if(!share)fs.mkdirSync(root);
 const source=await Store.open(path.join(local,'source.sqlite'),path.join(local,'media'));const payload=randomBytes(2400000).toString('base64');source.setSetting('syntheticFixture',payload);source.save();
 const nas=new NasLibrary(path.join(local,'profile'));const start=Date.now();
 try{
  await nas.migrate(source,root);assert.equal(nas.writable,true);assert.equal(nas.store.getSetting('syntheticFixture'),payload);
  nas.store.setSetting('fixtureRevision',2);nas.store.save();await nas.flush();assert.equal(nas.writable,true);assert.equal(nas.status.connected,true);assert.equal(nas.dirty,false);
  await nas.open(root);assert.equal(nas.store.getSetting('fixtureRevision'),2);assert.equal(nas.store.getSetting('syntheticFixture'),payload);
  console.log({largeMetadataBytes:fs.statSync(source.file).size,elapsedMs:Date.now()-start,remote:!!share});
 }finally{await nas.close();source.close();if(share){assert.equal(path.dirname(root),path.resolve(share));assert.ok(path.basename(root).startsWith('cangxia-owned-test-'));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});}assert.equal(path.dirname(local),os.tmpdir());fs.rmSync(local,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
