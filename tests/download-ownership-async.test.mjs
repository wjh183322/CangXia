import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {createPreparationFixture} from './download-preparation-fixture.mjs';
import {captureCancellationOwnership} from '../electron/download-ownership-async.mjs';
import {cleanupCancelledDownload} from '../electron/download-cancel-cleanup.mjs';
test('async ownership captures exact original metadata and permits heartbeat while directory IO waits',async t=>{
 const f=await createPreparationFixture(t),s=f.store,target=s.destination('1');await fs.mkdir(target.dir,{recursive:true});await fs.writeFile(path.join(target.dir,'作品信息.json'),'original metadata');await fs.writeFile(path.join(target.dir,'video.mp4'),'prior-video');
 let active=0,peak=0,pulses=0;const io=new Proxy(fs,{get(o,k){const value=o[k];if(typeof value!=='function')return value;return async(...args)=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,2));return await value(...args);}finally{active--;}}}}),timer=setInterval(()=>pulses++,1);let ownership;try{ownership=await captureCancellationOwnership(s,'1',{target,epoch:'first-epoch',io});}finally{clearInterval(timer);}
 assert.equal(ownership.epoch,'first-epoch');assert.equal(Buffer.from(ownership.metadata[0].bytes,'base64').toString(),'original metadata');assert.ok(ownership.dirs[0].existing.includes('video.mp4'));assert.ok(pulses>0);assert.ok(peak<=4);
 await cleanupCancelledDownload(s,{id:'1',cancelOwnership:ownership},[]);assert.equal(await fs.readFile(path.join(target.dir,'video.mp4'),'utf8'),'prior-video');
});
test('aborted or changed-root snapshot cannot be admitted and does not create output files',async t=>{
 const f=await createPreparationFixture(t),s=f.store,target=s.destination('1'),c=new AbortController();c.abort();await assert.rejects(captureCancellationOwnership(s,'1',{target,signal:c.signal}),e=>e.name==='AbortError');
 const root=s.root,io=new Proxy(fs,{get(o,k){if(k==='readdir')return async(...args)=>{s.setSetting('root',root+'-changed');return o.readdir(...args);};return o[k];}});await assert.rejects(captureCancellationOwnership(s,'1',{target,io}),/根目录|保存位置/);assert.equal(await fs.stat(target.dir).then(()=>true,()=>false),false);
});
test('ownership rejects traversal and directory links and conservatively preserves unknown legacy data',async t=>{
 const f=await createPreparationFixture(t),s=f.store;await assert.rejects(captureCancellationOwnership(s,'1',{target:{dir:path.dirname(f.root)}}),/超出/);
 const target=s.destination('1');await fs.mkdir(target.dir,{recursive:true});await fs.writeFile(path.join(target.dir,'old.bin'),'keep');const unknown=await captureCancellationOwnership(s,'1',{target,legacyUnknown:true});assert.equal(unknown.legacyUnknown,true);
 const link=path.join(f.root,'link');await fs.symlink(target.dir,link,'junction');await assert.rejects(captureCancellationOwnership(s,'1',{target:{dir:link}}),/链接/);
});
