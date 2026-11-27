import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomUUID,X509Certificate} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import selfsigned from 'selfsigned';
import {ServerClient,pinnedRequest} from '../../electron/server-client.mjs';
import {openLibrary} from '../../server/library.mjs';
import {createDownloads} from '../../server/downloads.mjs';
import {createSessionService} from '../../server/session.mjs';
import {createHttpsService} from '../../server/http.mjs';

const count=Number(process.argv[2]??50000);
const credentials={pc:{accountId:'test',token:'fixture'.repeat(8)}};
const sample=i=>{
  const id=String(i+1000),type=i%5?'video':'images';
  const url=k=>'https://p3.douyinpic.com/local-fixture/'+id+'/'+k+'?x-signature='+'a'.repeat(96);
  return {id,name:'合成作品 '+id,type,description:'摄影、生活与旅行样本。'.repeat(16+i%13),
    tags:['合成','样本'+i%89],author:{uid:String(300+i%400),nickname:'样本作者 '+i%400},
    music:{id:String(i%40+1)},coverUrls:[url('cover-1'),url('cover-2')],
    ...(type==='video'?{videoUrls:[url('video-1'),url('video-2')]}:{
      images:Array.from({length:3+i%4},(_,index)=>({index,urls:[url('image-'+index)]}))})};
};
if(process.env.CX_BATCH_CHILD){
  const area=process.env.CX_BATCH_CHILD,root=path.join(area,'volume'),library=openLibrary({root});
  const source={account:()=>({uid:'42'})};
  // Keep the tested transport fully local. Ordinary workers stay connected to a synthetic pending transfer.
  const downloads=createDownloads({root,library,source,fetchAsset:(_url,{signal})=>
    new Promise((_,reject)=>{signal.throwIfAborted();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  const sessions=createSessionService({library,downloads,source});
  const server=createHttpsService({key:fs.readFileSync(path.join(area,'key')),cert:fs.readFileSync(path.join(area,'cert')),credentials,sessions,downloads});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  void downloads.run().catch(e=>{console.error(e);process.exitCode=1;});
  process.on('message',message=>{
    if(message==='change'){
      library.write(db=>{
        const w=sample(count-1);w.name='later revision';db.prepare('UPDATE works SET title=?,body=? WHERE id=?').run(w.name,JSON.stringify(w),w.id);
        const more=sample(count);db.prepare('INSERT INTO works VALUES(?,?,?)').run(more.id,more.name,JSON.stringify(more));
        db.prepare("INSERT INTO source_members VALUES('total',?,?,0)").run(more.id,count);
      });
      process.send('changed');
    }
  });
  process.send({port:server.address().port});
}else{
  const area=fs.mkdtempSync(path.join(os.tmpdir(),'cx-batch-benchmark-')),root=path.join(area,'volume');
  let child,client,port,heartbeat,monitoring,renewFailure;
  const renewals=[];
  async function launch(){
    child=fork(fileURLToPath(import.meta.url),[String(count)],{env:{...process.env,CX_BATCH_CHILD:area},stdio:['ignore','inherit','inherit','ipc']});
    const [ready]=await once(child,'message');port=ready.port;
  }
  async function stop(){if(child){const ended=once(child,'exit');child.kill('SIGKILL');await ended;child=null;}}
  async function monitor(){
    if(monitoring)return;
    monitoring=(async()=>{const t=performance.now();try{await client.renew();renewals.push(Math.round(performance.now()-t));}
      catch(e){renewFailure=e;}})().finally(()=>{monitoring=null;});
    return monitoring;
  }
  try{
    assert.ok(count>=150&&count<=50000);
    fs.mkdirSync(root);
    const lib=openLibrary({root,mode:'init'}),libraryId=lib.libraryId;
    let metadataBytes=0,relations=0;
    lib.write(db=>{
      db.exec("INSERT INTO source_account VALUES(1,'42','测试','profile');INSERT INTO download_auth VALUES(1,'fixture')");
      const put=db.prepare('INSERT INTO works VALUES(?,?,?)'),member=db.prepare('INSERT INTO source_members VALUES(?,?,?,0)');
      for(let i=0;i<count;i++){
        const w=sample(i),body=JSON.stringify(w);metadataBytes+=Buffer.byteLength(body);put.run(w.id,w.name,body);
        member.run('total',w.id,i);member.run('folder:'+String(i%50+50),w.id,i);relations+=2;
        if(i%3===0){member.run('author:'+w.author.uid,w.id,i);relations++;}
      }
    });lib.close();
    const tls=await selfsigned.generate([{name:'commonName',value:'localhost'}],{keySize:2048});
    fs.writeFileSync(path.join(area,'key'),tls.private,{mode:0o600});fs.writeFileSync(path.join(area,'cert'),tls.cert);
    const config=()=>({url:'https://127.0.0.1:'+port,deviceId:'pc',token:credentials.pc.token,libraryId,
      fingerprint:new X509Certificate(tls.cert).fingerprint256});
    const connect=async()=>{client=new ServerClient();await client.connect(config());await client.acquire();};
    const cmd=(kind,payload)=>client.command({kind,payload,entityVersion:0,operationId:randomUUID()});
    const status=id=>client.query('download-batch',{id});
    await launch();await connect();
    await cmd('control-download',{action:'pause',ids:null});
    const view=await client.query('list-works',{source:'total'});
    const select={source:'total',scope:view.scope,revision:view.revision,ids:[],all:true};
    heartbeat=setInterval(()=>void monitor(),200);
    let at=performance.now();
    const preview=await client.query('download-selection',select);assert.equal(preview.unsaved,count);
    const previewMs=Math.round(performance.now()-at),operationId=randomUUID();
    const payload={action:'download-missing',selection:{...select,confirmedCount:count}};
    const command={kind:'catalogue-action',payload,entityVersion:0,operationId};
    // Drop the acknowledgement after the real pinned HTTPS response has been received.
    let discarded=false;
    client.request=async(...args)=>{const value=await pinnedRequest(...args);
      if(args[1]==='command'&&!discarded){discarded=true;clearInterval(heartbeat);await monitoring;
        throw Object.assign(Error('fixture lost acknowledgement'),{code:'ECONNRESET'});}return value;};
    at=performance.now();await assert.rejects(client.command(command));const admitMs=Math.round(performance.now()-at);
    clearInterval(heartbeat);await monitoring;heartbeat=null;
    client.request=pinnedRequest;
    // A failed transport locks this client. Restarting the NAS also exercises durable receipts across boots.
    await stop();await launch();await connect();
    const accepted=await client.receipt(operationId);assert.equal(accepted.accepted,count);assert.equal(accepted.queued,0);
    assert.equal((await status(operationId)).pending,count);
    // Replaying the identical operation is valid even after a catalogue revision changes.
    const changed=once(child,'message');child.send('change');await changed;
    assert.deepEqual(await client.command(command),accepted);
    await assert.rejects(cmd('catalogue-action',payload));
    await assert.rejects(client.command({...command,payload:{...payload,action:'download'}}));
    heartbeat=setInterval(()=>void monitor(),250);await monitor();await cmd('control-download',{action:'resume',ids:null});
    at=performance.now();
    let progress=await status(operationId),partial=0;
    while(progress.pending){
      await delay(300);progress=await status(operationId);
      if(progress.pending>0&&progress.queued>0)partial++;
      if(renewFailure)throw renewFailure;
      assert.ok(performance.now()-at<480000,'batch dispatch timeout');
    }
    const dispatchMs=Math.round(performance.now()-at);
    assert.equal(progress.queued,count-1);assert.equal(progress.changed,1);
    assert.deepEqual(progress.items.map(i=>i.workId),[sample(count-1).id]);
    assert.equal(progress.total,count);assert.ok(client.state().owned);
    const controls={};
    for(const action of ['pause','resume','cancel']){
      at=performance.now();await cmd('control-download',{action,ids:null});controls[action]=Math.round(performance.now()-at);
      if(renewFailure)throw renewFailure;
    }
    const remaining=await client.query('download-page',{tab:'active'});
    assert.ok(remaining.total<=6,'only the active workers may still be finalizing cancellation');
    if(count===50000){assert.ok(partial>0);assert.ok(renewals.length>=3);}
    assert.ok(admitMs<6000 && previewMs<7500 && Math.max(...renewals)<7500,'normal Windows timeout margin');
    console.log(JSON.stringify({count,metadataBytes,relations,previewMs,admitMs,dispatchMs,
      renewals:renewals.length,maxRenewalMs:Math.max(...renewals),queued:progress.queued,changed:progress.changed,controls,
      verified:'pinned HTTPS, lost acknowledgement, process restart, stale consent, no later substitutions'}));
  }finally{clearInterval(heartbeat);await monitoring;await client?.release().catch(()=>{});await stop();fs.rmSync(area,{recursive:true,force:true,maxRetries:5});}
}
