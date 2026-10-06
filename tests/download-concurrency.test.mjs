import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {DownloadQueue} from '../electron/downloads.mjs';
import {Store} from '../electron/store.mjs';

async function until(predicate){for(let i=0;i<500;i++){if(predicate())return;await delay(10);}assert.fail('timed out');}
function fixture(){const settings=new Map();let writes=0;const store={getSetting:k=>settings.get(k),setSetting:(k,v)=>{settings.set(k,structuredClone(v));if(k==='downloadJobs')writes++;},save(){},work:id=>({id,name:id})};const q=new DownloadQueue(store,{},null,()=>{});return {q,settings,writes:()=>writes};}

test('pool enforces live limits, deduplicates enqueue, isolates failure and persists final states',async()=>{
 const {q,settings}=fixture(),gates=new Map(),starts=[];
 q.setConcurrency(2);q.saveWork=job=>new Promise((resolve,reject)=>{starts.push(job.id);gates.set(job.id,job.id==='3'?()=>reject(Error('fixture failed')):resolve);});
 q.enqueue(['1','2','3','4','5','6']);await until(()=>starts.length===2);
 q.enqueue(['1','2','3']);assert.equal(q.jobs.length,6);
 q.setConcurrency(3);await until(()=>starts.length===3);assert.equal(q.active.size,3);
 q.setConcurrency(1);gates.get('1')();gates.get('2')();await delay(30);assert.equal(starts.length,3);
 gates.get('3')();await until(()=>starts.length===4);assert.equal(q.active.size,1);
 for(const id of ['4','5','6']){await until(()=>gates.has(id));gates.get(id)();}
 await q.waitForIdle();assert.deepEqual(starts,['1','2','3','4','5','6']);assert.equal(q.jobs.filter(j=>j.state==='failed').length,1);
 assert.equal(settings.get('downloadJobs').filter(j=>j.state==='complete').length,5);assert.equal(settings.get('downloadConcurrency'),1);
 assert.throws(()=>q.setConcurrency(7));assert.throws(()=>q.setConcurrency('3'));
});

test('pause drains all active jobs, blocks queued metadata queries and resumes without duplicate work',async()=>{
 const {q}=fixture();let calls=0,release;
 q.collector={resolveWork:()=>{calls++;return new Promise((resolve,reject)=>{release=resolve;q.collector.cancelResolve=()=>reject(Error('paused'));});}};
 q.saveWork=(job,signal)=>q.resolveWork(job.id,signal);
 q.enqueue(['1','2','3','4']);await until(()=>calls===1&&q.active.size===3);q.pause();await q.waitForIdle();
 assert.equal(calls,1);assert.equal(q.active.size,0);assert.ok(q.jobs.every(j=>j.state==='waiting'));
 q.collector.resolveWork=async()=>{calls++;await delay(5);};q.resume();await q.waitForIdle();assert.equal(calls,5);assert.ok(q.jobs.every(j=>j.state==='complete'));
});

test('progress updates do not repeatedly serialize the full persisted queue',()=>{
 const {q,writes}=fixture();q.jobs=Array.from({length:30000},(_,i)=>({id:String(i),state:'waiting'}));
 q.emit(true);for(let i=0;i<1000;i++)q.emit();assert.equal(writes(),1);q.pause();assert.equal(writes(),2);
});

test('cancel one active task removes it durably while other tasks continue',async()=>{
 const {q,settings}=fixture(),finish=new Map();
 q.saveWork=(job,signal)=>new Promise((resolve,reject)=>{finish.set(job.id,resolve);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 q.enqueue(['1','2','3']);await until(()=>finish.size===3);assert.equal((await q.cancel(['1'])).cancelled,1);
 assert.equal(q.paused,false);assert.deepEqual(q.jobs.map(j=>j.id),['2','3']);assert.ok(!settings.get('downloadJobs').some(j=>j.id==='1'));
 finish.get('2')();finish.get('3')();await q.waitForIdle();assert.ok(q.jobs.every(j=>j.state==='complete'));
 const restarted=new DownloadQueue(q.store,{},null,()=>{});assert.deepEqual(restarted.jobs.map(j=>j.id),['2','3']);
});

test('cancel a queued resource lookup returns promptly without interrupting the resolver ahead',async()=>{
 const {q}=fixture();let release;const calls=[];
 q.collector.resolveWork=async(id,{signal})=>{calls.push(id);if(id==='1')await new Promise(r=>release=r);assert.equal(signal.aborted,false);};
 q.saveWork=(job,signal)=>q.resolveWork(job.id,signal,job);q.enqueue(['1','2','3']);await until(()=>calls.length===1);
 await Promise.race([q.cancel(['2']),delay(1000).then(()=>{throw Error('cancel waited for another task');})]);
 assert.deepEqual(calls,['1']);release();await q.waitForIdle();assert.deepEqual(calls,['1','3']);
});

test('cancel all removes waiting and failed jobs, preserving completed history',async()=>{
 const {q,settings}=fixture();q.jobs=[{id:'1',state:'complete'},{id:'2',state:'waiting'},{id:'3',state:'failed'}];q.paused=true;
 assert.equal((await q.cancel()).cancelled,2);assert.deepEqual(q.jobs,[{id:'1',state:'complete'}]);assert.deepEqual(settings.get('downloadJobs').map(j=>j.id),['1']);
});

test('cancel during a later image transfer retains saved files, collection and NAS records',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-cancel-')),store=await Store.open(path.join(root,'db.sqlite'),path.join(root,'media'));
 let secondStarted=false;const q=new DownloadQueue(store,{},async(url,{signal})=>{
  if(url.endsWith('/1.jpg'))return new Response('retained-image',{headers:{'content-type':'image/jpeg'}});
  secondStarted=true;return new Response(new ReadableStream({start(controller){signal.addEventListener('abort',()=>controller.error(signal.reason),{once:true});}}),{headers:{'content-type':'image/jpeg'}});
 },()=>{});
 t.after(async()=>{q.pause();await q.waitForIdle();store.close();fs.rmSync(root,{recursive:true,force:true});});
 store.upsertWork({aweme_id:'1',desc:'retain',images:[{url_list:['https://p3.douyinpic.com/1.jpg']},{url_list:['https://p3.douyinpic.com/2.jpg']}]});store.ingestMembers('__all__',['1'],true);store.put('backup_downloads','1',{id:'1',assets:[{file:'NAS-preserved'}]});
 const backup=store.get('backup_downloads','1');q.enqueue(['1']);await until(()=>secondStarted);await q.cancel(['1']);await q.waitForIdle();
 assert.equal(q.jobs.length,0);const d=store.download('1');assert.equal(fs.readFileSync(path.join(d.path,d.assets[0].file),'utf8'),'retained-image');assert.ok(store.hasRead('1'));assert.deepEqual(store.rows('SELECT work_id FROM members'),[{work_id:'1'}]);assert.deepEqual(store.get('backup_downloads','1'),backup);
});

test('six cached HTTP transfers run without metadata queries and resume verified prefixes',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-pool-'));const store=await Store.open(path.join(root,'db.sqlite'),path.join(root,'media'));
 const bytes=Buffer.alloc(256*1024,117);let sockets=0,peak=0,ranges=0,queries=0,queryPeak=0;
 const server=http.createServer((req,res)=>{
  const offset=Number(/bytes=(\d+)-/.exec(req.headers.range||'')?.[1]||0);if(offset)ranges++;
  res.writeHead(offset?206:200,{'Content-Type':'image/jpeg','Content-Length':bytes.length-offset,ETag:'"fixture-1"',...(offset?{'Content-Range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{})});
  sockets++;peak=Math.max(peak,sockets);let cursor=offset;
  const timer=setInterval(()=>{if(cursor>=bytes.length){clearInterval(timer);res.end();return;}res.write(bytes.subarray(cursor,cursor+8192));cursor+=8192;},10);
  res.on('close',()=>{clearInterval(timer);sockets--;});
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const q=new DownloadQueue(store,{resolveWork:async id=>{queries++;queryPeak=Math.max(queryPeak,queries);await delay(10);queries--;return store.work(id);}},(url,opts)=>fetch(`http://127.0.0.1:${server.address().port}/${new URL(url).pathname}`,opts),()=>{});
 t.after(async()=>{q.pause();await q.waitForIdle();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();fs.rmSync(root,{recursive:true,force:true});});
 for(let id=1;id<=6;id++)store.upsertWork({aweme_id:String(id),desc:'pool '+id,images:[{url_list:[`https://p3.douyinpic.com/${id}.jpg`]}]});
 q.setConcurrency(6);q.enqueue(['1','2','3','4','5','6']);await until(()=>sockets===6);await delay(80);q.pause();await q.waitForIdle();await until(()=>sockets===0);
 assert.equal(q.active.size,0);assert.ok(q.jobs.every(j=>j.state==='waiting'));q.resume();await q.waitForIdle();
 assert.equal(peak,6);assert.equal(queryPeak,0);assert.ok(ranges>=6,'each interrupted transfer resumed');assert.ok(q.jobs.every(j=>j.state==='complete'));
 for(let id=1;id<=6;id++){const d=store.download(String(id));const a=d.assets.find(a=>a.key==='image-0');assert.deepEqual(fs.readFileSync(path.join(d.path,a.file)),bytes);}
});
