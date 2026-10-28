import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createPreparationFixture} from '../tests/download-preparation-fixture.mjs';
import {readDirectorySnapshot} from '../electron/download-directory-index.mjs';

// Isolated verification only: no real media, credentials, or user database.
if(process.argv[2]==='--reader'){
 let began,committed;const snapshot=readDirectorySnapshot(process.argv[3],{onDatabase(db){const exec=db.exec.bind(db);db.exec=sql=>{if(sql==='BEGIN')began=performance.now();const result=exec(sql);if(sql==='COMMIT')committed=performance.now();return result;};}});
 process.send({transactionMs:committed-began,owners:snapshot.index.size});process.disconnect();
}else{
 const fixture=await createPreparationFixture(null,{savedCount:31542,unsavedCount:0});let child;
 try{
  const store=fixture.store;store.db.run('PRAGMA wal_checkpoint(TRUNCATE)');const wal=()=>{try{return fs.statSync(store.file+'-wal').size;}catch{return 0;}},beforeBytes=wal();
  child=fork(new URL(import.meta.url),['--reader',store.file],{stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});
  const snapshot=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>{if(code)reject(Error('snapshot reader failed: '+code));});});
  assert.equal(snapshot.owners,31542);const afterSnapshotBytes=wal();
  // Delay consumption after actual helper reply while committing 200 writes.
  const entry=new URL('../electron/download-analysis-entry.mjs',import.meta.url);child=fork(entry,[],{stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});let reply;
  const message=()=>new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});reply=message();child.send({id:1,session:'benchmark',command:'open',file:store.file,root:fixture.root,operationId:'snapshot-wal'});const opened=await reply;
  assert.ok(opened.done);reply=message();child.send({id:2,session:'benchmark',command:'lookup',snapshotId:opened.value.snapshotId,candidates:[store.download('1').path]});const packet=await reply;assert.equal(packet.sequence,1);
  for(let i=0;i<200;i++)store.db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',['snapshot-bench',JSON.stringify(i)]);
  const afterWritesBytes=wal(),checkpoint=store.rows('PRAGMA wal_checkpoint(TRUNCATE)')[0];assert.equal(checkpoint.busy,0);assert.equal(wal(),0);
  const report={savedCount:31542,transactionMs:snapshot.transactionMs,wal:{beforeBytes,afterSnapshotBytes,afterWritesBytes,afterCheckpointBytes:wal(),checkpoint},ackWithheldDuringWrites:true};fs.mkdirSync('.test-output',{recursive:true});fs.writeFileSync('.test-output/responsiveness-snapshot.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{child?.kill();await fixture.close();}
}
