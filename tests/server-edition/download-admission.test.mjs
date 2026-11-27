import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openLibrary} from '../../server/library.mjs';
import {createDownloads} from '../../server/downloads.mjs';
import {createSourceBrowser} from '../../server/source-browser.mjs';
import {createSessionService} from '../../server/session.mjs';
import {preserveBeforeRollback,restoreApproved} from '../../server/recovery.mjs';

const uid='42', fingerprint='synthetic-original-session-fingerprint-937551';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
const address=(id,sig)=>'https://p3.douyinpic.com/batch/'+id+'?x-signature='+sig;
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-admission-auth-')),root=path.join(dir,'live');
  fs.mkdirSync(root);const first=openLibrary({root,mode:'init'});
  first.write(db=>{
    for(let i=0;i<65;i++){
      const id=String(1000+i),work={id,type:'images',name:id,images:[{index:0,urls:[address(id,'old')]}]};
      db.prepare('INSERT INTO works VALUES(?,?,?)').run(id,id,JSON.stringify(work));
      db.prepare("INSERT INTO source_members VALUES('total',?,?,0)").run(id,i);
    }
  });const libraryId=first.libraryId;first.close();
  const provider={uid,key:fingerprint},details=[];
  async function openProvider(saved){
    return {async self(){return {uid:provider.uid,nickname:'fixture'};},async sessionKey(){return provider.key;},
      async storage(){return {cookies:[],origins:[],fixture:'persisted'};},endLogin(){},async close(){},
      async read(request){
        assert.equal(saved?.fixture,'persisted');
        const id=new URL(request.url).searchParams.get('aweme_id');details.push(id);
        return {status:200,text:JSON.stringify({status_code:0,aweme_detail:{aweme_id:id,desc:id,author:{uid},
          images:[{url_list:[address(id,'current')]}]}})};
      }};
  }
  const active=new Set();
  function open(rootDir=root,accountId='owner'){
    const library=openLibrary({root:rootDir,expectedId:libraryId});
    const source=createSourceBrowser({library,root:rootDir,openProvider});
    const downloads=createDownloads({library,root:rootDir,source,fetchAsset:async url=>{
      if(url===address('1000','old'))return new Response(null,{status:403});
      return new Response(png,{headers:{'content-type':'image/png','content-length':String(png.length)}});
    }});
    const sessions=createSessionService({library,source,downloads}),who={deviceId:'desktop',accountId};
    let grant,heartbeat;
    const api={library,source,downloads,acquire(){grant=sessions.acquire(who,{deviceId:who.deviceId,instanceId:randomUUID(),operationId:randomUUID()});
      heartbeat=setInterval(()=>{grant=sessions.renew(who,grant);},3000);heartbeat.unref();},
      verify:()=>source.verifyAccount(sessions.sourceSession(who,grant)),release:()=>{clearInterval(heartbeat);return sessions.release(who,grant,randomUUID());},
      query:(kind,payload)=>sessions.query(who,grant,{kind,payload}),
      command:(kind,payload)=>sessions.command(who,grant,{kind,payload,entityVersion:0,operationId:randomUUID()}),
      admit(){const v=api.query('list-works',{source:'total'});
        return api.command('catalogue-action',{action:'download-missing',selection:{source:'total',all:true,ids:[],confirmedCount:65,revision:v.revision,scope:v.scope}});},
      state:id=>library.read(db=>({...db.prepare('SELECT state,auth FROM download_batches WHERE id=?').get(id),
        queued:db.prepare("SELECT count(*) n FROM download_batch_items WHERE batch=? AND state='queued'").get(id).n,
        changed:db.prepare("SELECT count(*) n FROM download_batch_items WHERE batch=? AND state='changed'").get(id).n})),
      async close(){if(!active.delete(api))return;clearInterval(heartbeat);await sessions.close();await downloads.close();await source.close();library.close();}
    };
    active.add(api);return api;
  }
  t.after(async()=>{for(const service of active)await service.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:5});});
  return {dir,root,open,provider,details,libraryId};
}
for(const cold of [false,true])test('approved 65-item NAS batch survives '+(cold?'cold start':'controller release')+' using its persisted verified source',async t=>{
  const f=fixture(t);let service=f.open();service.acquire();await service.verify();
  const {batchId}=service.admit();service.release();
  assert.throws(()=>service.query('download-batch',{id:batchId}));assert.equal(service.source.account(),null);
  if(cold){await service.close();service=f.open();}
  await service.downloads.run();
  const result=service.state(batchId);assert.equal(result.queued,65);assert.equal(result.changed,0);
  assert.deepEqual(f.details,['1000']);
  const picture=service.downloads.store.resources('1000').find(r=>r.key==='image-0');
  assert.deepEqual(fs.readFileSync(path.join(service.downloads.layout.media,picture.relative_path)),png);
});
test('independent snapshot scrubs batch bindings and retained pending items require explicit reauthorization after restore',async t=>{
  const f=fixture(t),live=f.open();live.acquire();await live.verify();
  live.command('enqueue-download',{workIds:['1000'],selection:'missing'});await live.downloads.run();
  live.command('control-download',{action:'pause',ids:null});
  const {batchId}=live.admit();
  live.library.write(db=>db.prepare("UPDATE works SET title='new title' WHERE id='1064'").run());
  const saved=await preserveBeforeRollback({root:f.root,uid,libraryId:f.libraryId,confirmed:true,imageDigest:'sha256:'+'b'.repeat(64)});
  assert.ok(saved.verified);
  const snapshotFile=path.join(saved.snapshot,'library.sqlite'),db=new DatabaseSync(snapshotFile,{readOnly:true});
  try{
    assert.equal(JSON.parse(db.prepare('SELECT auth FROM download_batches WHERE id=?').get(batchId).auth).sessionKey,undefined);
    assert.equal(db.prepare('SELECT count(*) n FROM download_auth').get().n,0);
  }finally{db.close();}
  assert.equal(fs.readFileSync(snapshotFile).includes(fingerprint),false);
  assert.equal(JSON.parse(live.state(batchId).auth).sessionKey,fingerprint);
  const restored=await restoreApproved({...saved,target:path.join(f.dir,'detached'),uid,libraryId:f.libraryId,confirmed:true});
  const next=f.open(restored.target,'independent-owner');next.acquire();
  next.command('control-download',{action:'resume',ids:null});await next.downloads.run();
  assert.equal(next.state(batchId).state,'restore-auth');assert.equal(next.state(batchId).queued,0);
  assert.throws(()=>next.command('authorize-download-batch',{id:batchId}));
  f.provider.uid='99';await assert.rejects(next.verify(),{code:'ACCOUNT_MISMATCH'});
  assert.throws(()=>next.command('authorize-download-batch',{id:batchId}));
  f.provider.uid=uid;f.provider.key='second-verified-fingerprint';await next.verify();
  await next.downloads.run();assert.equal(next.state(batchId).queued,0);
  next.command('authorize-download-batch',{id:batchId});await next.downloads.run();
  const result=next.query('download-batch',{id:batchId});
  assert.deepEqual([result.queued,result.changed,result.skipped],[63,1,1]);
  assert.equal(result.items[0].workId,'1064');
  assert.equal(JSON.parse(next.state(batchId).auth).sessionKey,f.provider.key);
  assert.equal(live.state(batchId).queued,0);assert.equal(JSON.parse(live.state(batchId).auth).sessionKey,fingerprint);
});

test('missing source profile keeps accepted work pending and another account cannot reauthorize it',async t=>{
  const f=fixture(t),live=f.open();live.acquire();await live.verify();
  const {batchId}=live.admit();live.release();
  const profile=live.library.read(db=>db.prepare('SELECT profile_id FROM source_account').get().profile_id);
  fs.renameSync(path.join(f.root,'cangxia-server','source-session',profile+'.json'),path.join(f.dir,'held-profile.json'));
  await live.downloads.run();
  assert.equal(live.state(batchId).state,'waiting-auth');assert.equal(live.state(batchId).changed,0);
  await live.close();
  const other=f.open(f.root,'other');other.acquire();await other.verify();
  assert.throws(()=>other.command('authorize-download-batch',{id:batchId}));other.release();await other.close();
  const original=f.open();original.acquire();await original.verify();
  original.command('authorize-download-batch',{id:batchId});await original.downloads.run();
  assert.equal(original.state(batchId).queued,65);
});
