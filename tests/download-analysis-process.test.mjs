import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {EventEmitter} from 'node:events';
import {createPreparationFixture} from './download-preparation-fixture.mjs';
import {DownloadAnalysis} from '../electron/download-analysis-process.mjs';
import {readDirectorySnapshot} from '../electron/download-directory-index.mjs';

test('independent readonly helper reuses one committed snapshot across bounded candidate requests',async t=>{
 const f=await createPreparationFixture(t,{savedCount:2}),packets=[],a=new DownloadAnalysis({file:f.store.file,root:f.root,libraryId:'fixture',onPacket:p=>packets.push(p)});t.after(()=>a.close());
 const opened=await a.open({operationId:'fixture-op'});assert.notEqual(opened.pid,process.pid);assert.equal(opened.context.root,f.root);
 const old=f.store.download('1').path;f.store.put('downloads','1',{...f.store.download('1'),path:old+'-changed'});
 const candidates=Array.from({length:430},(_,i)=>i?path.join(f.root,'unused',String(i)):old),rows=await a.lookup(opened.snapshotId,candidates);
 assert.deepEqual(rows[0].owners,['1']);assert.equal(rows.length,430);assert.equal((await a.lookup(opened.snapshotId,[old+'-changed']))[0].owners.length,0);
 assert.ok(packets.every(p=>p.count<=200&&p.bytes<=256*1024));assert.ok(packets.filter(p=>p.kind==='request'&&p.command==='lookup').length>=3);
 assert.ok(f.store.pathJournal.head()>opened.baseSeq);assert.equal(a.pending.size,0);
 await assert.rejects(a.open({operationId:'another'}),e=>e.code==='ANALYSIS_BUSY');await a.release(opened.snapshotId);
 const next=await a.open({operationId:'next'});assert.deepEqual((await a.lookup(next.snapshotId,[old+'-changed']))[0].owners,['1']);
});
test('snapshot connection cannot write and closes before result consumption',async t=>{
 const f=await createPreparationFixture(t,{savedCount:1});let connection;
 const snapshot=readDirectorySnapshot(f.store.file,{onDatabase:db=>{connection=db;assert.throws(()=>db.exec('CREATE TABLE forbidden(value TEXT)'),/readonly|read-only/i);}});
 assert.equal(snapshot.index.size,1);assert.throws(()=>connection.prepare('SELECT 1'),/not open|closed/i);assert.equal(f.store.rows("SELECT name FROM sqlite_master WHERE name='forbidden'").length,0);
});
test('helper crash rejects current work, old replies cannot complete a new session, idle helper is reclaimed',async t=>{
 const f=await createPreparationFixture(t,{savedCount:1}),a=new DownloadAnalysis({file:f.store.file,root:f.root,idleMs:25});t.after(()=>a.close());const s=await a.open({operationId:'one'});a.child.kill();await new Promise(r=>setTimeout(r,100));
 await assert.rejects(a.lookup(s.snapshotId,[f.root]),/退出|变化|关闭|snapshot/i);const next=await a.open({operationId:'two'});assert.notEqual(next.pid,s.pid);await a.release(next.snapshotId);await new Promise(r=>setTimeout(r,100));assert.equal(a.child,null);
});
test('missing helper response times out visibly and abort settles all waiters without synchronous fallback',async()=>{
 const fake=()=>{const p=new EventEmitter();p.postMessage=()=>{};p.kill=()=>p.emit('exit',1);return p;};
 const a=new DownloadAnalysis({file:'unused',root:'unused',spawn:fake,timeoutMs:25});await assert.rejects(a.open({operationId:'timeout'}),e=>e.code==='ANALYSIS_TIMEOUT');assert.equal(a.pending.size,0);await a.close();
 const b=new DownloadAnalysis({file:'unused',root:'unused',spawn:fake,timeoutMs:500}),controller=new AbortController(),promise=b.open({operationId:'cancel',signal:controller.signal});controller.abort();await assert.rejects(promise,e=>e.name==='AbortError');assert.equal(b.pending.size,0);await b.close();
});
