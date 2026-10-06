import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {Store} from '../electron/store.mjs';
import {BackupClient} from '../electron/backup-client.mjs';
import {BackupTransport} from '../electron/backup-transport.mjs';
import {Collector} from '../electron/account-collector.mjs';
import {createBackupServer} from '../backup-server/server.mjs';
import {sha256} from '../shared/backup-protocol.mjs';
import {createDiagnostics} from '../electron/diagnostics.mjs';

const vault={seal:s=>Buffer.from(s).toString('base64'),open:s=>Buffer.from(s,'base64').toString()};
const raw=id=>({aweme_id:String(id),desc:'fixture '+id,author:{uid:'7',nickname:'fixture'}});
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-backup-idle-')),token=randomBytes(32).toString('hex');
 const service=createBackupServer({dataDir:path.join(dir,'server'),token,allowInsecureLoopback:true});
 const address=await service.listen(),url='http://127.0.0.1:'+address.port,clients=[];
 t.after(async()=>{for(const c of clients){await c.close();c.store.close();}await service.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 async function client(name,options={}){
  const profile=path.join(dir,name),store=await Store.open(path.join(profile,'library.sqlite'),path.join(profile,'media'));
  const c=new BackupClient(store,profile,{vault,heartbeatMs:60000,...options});clients.push(c);
  await c.configure({url,token,deviceName:name,intervalMinutes:60});return c;
 }
 return {dir,token,service,url,client};
}
function collectorFor(client,responses){
 const c=new Collector(client.store,()=>{},{profile:{},vault:{load:()=>null},browser:{},delay:async()=>{}});
 c.isAuthenticated=async()=>true;let calls=0;c.request=async()=>responses(++calls,c);
 client.onUnavailable=()=>{if(!client.localReadDepth)c.stop();};return c;
}

test('automatic and manual backup wait while local reading or downloads are busy',async t=>{
 const f=await fixture(t);let idle=true;const a=await f.client('A',{isIdle:()=>idle});
 a.store.upsertWork(raw('1'));a.store.ingestMembers('__all__',['1'],true);idle=false;
 let prepared=0;const original=a.prepare.bind(a);a.prepare=async(...args)=>{prepared++;return original(...args);};
 assert.deepEqual(await a.automaticSync(),{deferred:true});assert.deepEqual(await a.sync(),{deferred:true});
 assert.equal(prepared,0);assert.equal(f.service.status().revision,0);assert.equal(a.status.phase,'waitingIdle');
 idle=true;await a.automaticSync();assert.equal(f.service.status().revision,1);assert.equal(a.status.phase,'synced');
});

test('an active full read survives NAS loss, publishes ordered members and remains local until idle',async t=>{
 const f=await fixture(t),a=await f.client('A');a.store.setSetting('browserAccountKey','uid:1');
 const c=collectorFor(a,n=>{if(n===2)a.unavailable('read ECONNRESET');return {aweme_list:[raw(n)],cursor:String(n),has_more:n<3?1:0};});
 await a.withForegroundRead(async()=>{await c.sync({mode:'full'});assert.deepEqual(await a.automaticSync(),{deferred:true});});
 clearTimeout(a.idleTimer);
 assert.equal(c.status.readProgress.saveFailed,false);assert.equal(c.status.readProgress.stopped,false);
 assert.equal(a.store.collectionReads.get('__all__','full').outcome,'end');
 assert.deepEqual(a.store.collectionReads.membership('__all__').map(r=>r.work_id),['1','2','3']);
 assert.equal(a.store.all('works').length,3);assert.equal(a.meta.dirty,true);assert.equal(f.service.status().revision,0);
 assert.throws(()=>a.store.upsertWork(raw('99')),/ECONNRESET/,'offline permission is limited to the already-started read');
 assert.deepEqual(await a.automaticSync(),{deferred:true});a.reconnectAt=0;
 await a.automaticSync();assert.equal(f.service.status().revision,1);assert.equal(a.status.phase,'synced');
});

test('user stop after NAS loss still publishes the saved page and resumable cursor',async t=>{
 const f=await fixture(t),a=await f.client('A');a.store.setSetting('browserAccountKey','uid:1');
 const c=collectorFor(a,(n,reader)=>{if(n===2){a.unavailable('read ECONNRESET');reader.stop();throw new DOMException('aborted','AbortError');}return {aweme_list:[raw('1')],cursor:'30',has_more:1};});
 await a.withForegroundRead(()=>c.sync({mode:'full'}));clearTimeout(a.idleTimer);
 const run=a.store.collectionReads.get('__all__','full');assert.equal(run.status,'paused');assert.equal(run.nextCursor,'30');
 assert.equal(c.status.readProgress.saveFailed,false);assert.deepEqual(a.store.collectionReads.membership('__all__').map(r=>r.work_id),['1']);
 assert.equal(a.store.collectionReads.info('__all__').full.canResume,true);
});

test('starting a read cancels and waits for an existing upload before allowing local writes',async t=>{
 const f=await fixture(t),a=await f.client('A');a.store.upsertWork(raw('1'));a.store.ingestMembers('__all__',['1'],true);
 const dir=a.store.destination('1').dir;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'video.mp4'),'fixture');
 a.store.put('downloads','1',{id:'1',path:dir,state:'complete',collectionId:'__all__',assets:[{key:'video',file:'video.mp4',kind:'video',size:7}]});
 let began,cleaned=false;const started=new Promise(r=>began=r);
 a.transport.upload=async(_file,_asset,{signal})=>{began();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{cleaned=true;reject(signal.reason);},{once:true}));};
 const syncing=a.sync();syncing.catch(()=>{});await started;
 await a.withForegroundRead(()=>{assert.equal(cleaned,true);assert.equal(a.syncing,null);a.store.upsertWork(raw('2'));});
 await assert.rejects(syncing,e=>e.name==='AbortError');clearTimeout(a.idleTimer);assert.equal(a.store.all('works').length,2);assert.equal(f.service.status().revision,0);
});

test('NAS changes during disconnected local read become a conflict without erasing read progress',async t=>{
 const f=await fixture(t),a=await f.client('A');a.store.setSetting('browserAccountKey','uid:1');await a.sync();
 const c=collectorFor(a,async n=>{if(n===2){a.unavailable('read ECONNRESET');await a.release();const b=await f.client('B');b.store.upsertWork(raw('99'));b.store.ingestMembers('__all__',['99'],true);await b.sync();await b.release();}return {aweme_list:[raw(n)],cursor:String(n),has_more:n<2?1:0};});
 await a.withForegroundRead(()=>c.sync({mode:'full'}));clearTimeout(a.idleTimer);await a.check();
 assert.equal(a.status.phase,'conflict');assert.deepEqual(a.store.all('works').map(w=>w.id).sort(),['1','2']);
 assert.equal(a.store.collectionReads.get('__all__','full').count,2);assert.equal(f.service.status().revision,2);
});

async function httpFixture(t,handler){
 const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const diagnostics=[],transport=new BackupTransport({url:'http://127.0.0.1:'+server.address().port,token:'private-token-not-for-logs',deviceId:'fixture',onDiagnostic:e=>diagnostics.push(e)});
 t.after(async()=>{transport.close();server.closeAllConnections();await new Promise(r=>server.close(r));});return {transport,diagnostics};
}
test('a reused keep-alive socket reset is retried on a fresh connection with safe diagnostics',async t=>{
 let calls=0;const {transport,diagnostics}=await httpFixture(t,(req,res)=>{if(req.url==='/v1/status'&&calls++===0){req.socket.destroy();return;}res.setHeader('content-type','application/json');res.end('{"ok":true}');});
 await transport.json('GET','/warm');assert.deepEqual(await transport.json('GET','/v1/status'),{ok:true});assert.equal(calls,2);
 assert.ok(diagnostics.some(e=>e.event==='nas-request-error'&&e.code==='ECONNRESET'&&e.reusedSocket));
 assert.ok(!JSON.stringify(diagnostics).includes(transport.token));
});

test('a reset after partially accepted chunk resumes from server offset and preserves exact bytes',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-upload-reset-')),bytes=randomBytes(1100000),file=path.join(dir,'file.bin');fs.writeFileSync(file,bytes);
 t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});
 let stored=Buffer.alloc(0),drop=true;const offsets=[];
 const {transport}=await httpFixture(t,async(req,res)=>{
  if(req.method==='GET'){res.end(JSON.stringify({offset:stored.length,complete:stored.length===bytes.length,size:stored.length}));return;}
  const chunks=[];for await(const c of req)chunks.push(c);const chunk=Buffer.concat(chunks),offset=Number(req.headers['upload-offset']);offsets.push(offset);assert.equal(offset,stored.length);
  if(drop){drop=false;stored=Buffer.concat([stored,chunk.subarray(0,300000)]);req.socket.destroy();return;}
  stored=Buffer.concat([stored,chunk]);res.end(JSON.stringify({offset:stored.length,complete:stored.length===bytes.length}));
 });
 await transport.upload(file,{sha256:sha256(bytes),size:bytes.length});assert.deepEqual(stored,bytes);assert.equal(offsets[1],300000);assert.equal(sha256(stored),sha256(bytes));
});

test('lost commit response retries the same request ID without duplicating server revision',async t=>{
 const f=await fixture(t),a=await f.client('A');a.store.upsertWork(raw('1'));a.store.ingestMembers('__all__',['1'],true);
 const original=f.service.server.listeners('request')[0];f.service.server.removeAllListeners('request');let dropped=false;
 f.service.server.on('request',(req,res)=>{if(req.url==='/v1/commit'&&!dropped){dropped=true;res.end=()=>{req.socket.destroy();return res;};}void original(req,res);});
 await a.sync();assert.equal(f.service.status().revision,1);assert.equal(a.status.phase,'synced');assert.equal(a.meta.pendingCommit,undefined);
});

test('initial lease acquisition and certificate failures are not blindly retried',async t=>{
 let count=0;const {transport}=await httpFixture(t,(req)=>{count++;req.socket.destroy();});
 await assert.rejects(transport.json('POST','/v1/lease',{data:{deviceId:'fixture',leaseToken:''}}),e=>e.code==='ECONNRESET');assert.equal(count,1);
});

test('a cover download reset after headers resumes its exact verified prefix',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-cover-reset-')),bytes=randomBytes(400000),file=path.join(dir,'cover.png'),ranges=[];let first=true;
 t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});
 const {transport}=await httpFixture(t,(req,res)=>{
  const start=req.headers.range?Number(/^bytes=(\d+)-$/.exec(req.headers.range)[1]):0;ranges.push(start);
  res.writeHead(start?206:200,{'content-length':bytes.length-start});
  if(first){first=false;res.write(bytes.subarray(0,120000));setTimeout(()=>req.socket.destroy(),25);return;}
  res.end(bytes.subarray(start));
 });
 await transport.download({sha256:sha256(bytes),size:bytes.length},file);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(ranges.length,2);assert.equal(ranges[1],120000);assert.equal(fs.existsSync(file+'.backup-part'),false);
});

test('persistent diagnostics keep request stage and reuse flag without storing credentials',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-nas-log-'));const d=createDiagnostics(dir);
 d.record({event:'nas-request-error',path:'/v1/uploads/:sha',method:'PUT',attempt:1,code:'ECONNRESET',reusedSocket:true,receivedHeaders:false,token:'must-not-write',authorization:'must-not-write'});d.close();
 const records=fs.readFileSync(path.join(dir,'diagnostics','events.jsonl'),'utf8');const event=records.trim().split('\n').map(JSON.parse).find(e=>e.event==='nas-request-error');
 assert.equal(event.reusedSocket,true);assert.equal(event.method,'PUT');assert.equal(event.receivedHeaders,false);assert.ok(!records.includes('must-not-write'));fs.rmSync(dir,{recursive:true,force:true});
});
