import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NasLibrary} from '../electron/nas-library.mjs';
import {Store} from '../electron/store.mjs';
import {headFromLog,child,serializeShared} from '../electron/nas-format.mjs';

test('NAS writer lock, migration, immutable media, read-only and handoff', {skip:process.platform!=='win32',timeout:60000},async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-nas-test-'));
 const root=process.env.CANGXIA_NAS_TEST_ROOT?fs.mkdtempSync(path.join(process.env.CANGXIA_NAS_TEST_ROOT,'cangxia-owned-test-')):path.join(base,'share');if(!fs.existsSync(root))fs.mkdirSync(root);
 const source=await Store.open(path.join(base,'source.sqlite'),path.join(base,'original'));
 source.upsertWork({aweme_id:'123',desc:'test',author:{nickname:'author'},video:{play_addr:{url_list:[]}}});
 const dir=source.destination('123').dir;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'video.mp4'),'test-content');
 source.put('downloads','123',{id:'123',path:dir,state:'partial',assets:[{key:'video',file:'video.mp4',kind:'video',size:12}]});source.save();
 const a=new NasLibrary(path.join(base,'pc-a')),b=new NasLibrary(path.join(base,'pc-b'));
 try{
   await a.migrate(source,root);
   assert.equal(a.writable,true);assert.ok(fs.existsSync(path.join(dir,'video.mp4')));
   a.store.setSetting('sessionConnected',true);a.store.setSetting('accessHoldUntil',Date.now());
   const shared=serializeShared(a.store);assert.ok(shared.length>0);const sql=new a.store.SQL.Database(shared);assert.equal(sql.exec("SELECT * FROM settings WHERE key IN ('root','sessionConnected','accessHoldUntil')").length,0);const download=JSON.parse(sql.exec('SELECT body FROM downloads')[0].values[0][0]);assert.equal(path.isAbsolute(download.path),false);sql.close();
   await b.open(root);assert.equal(b.writable,false);assert.equal(b.store.assetExists(b.store.download('123'),b.store.download('123').assets[0]),true);
   assert.throws(()=>b.store.put('local_tags','123',{tags:['no']}),/只读/);
   const old=a.store.download('123');await a.refreshInfo('123');assert.equal(a.store.download('123').assets[0].file,old.assets[0].file);
   await a.deleteFiles(['123']);assert.equal(a.store.download('123'),null);assert.ok(fs.readdirSync(path.join(root,'.cangxia','trash')).length);
   const deleted=await a.trash();assert.equal(deleted.length,1);await a.restoreDeleted(deleted[0].batch,'123');assert.equal((await a.trash()).length,0);assert.ok(a.store.download('123'));assert.notEqual(a.store.download('123').assets[0].file,old.assets[0].file);
   await a.close();await b.open(root);assert.equal(b.writable,true);assert.ok(b.store.download('123'));
   // Simulate a disconnected writer with an unacknowledged local edit.
   b.store.put('local_tags','123',{id:'123',tags:['unconfirmed']});b.store.save();b.fail('simulated disconnect');await b.open(root);assert.ok(b.status.recovery);assert.ok(fs.existsSync(b.status.recovery));assert.equal(b.store.get('local_tags','123'),null);
   assert.ok(b.store.assetExists(b.store.download('123'),b.store.download('123').assets[0]));
   await assert.rejects(b.migrationPlan(source,root),/已有媒体库/);
   // A torn final record is ignored; the next committed edit still appends safely.
   await b.close();fs.appendFileSync(path.join(root,'.cangxia','head.log'),'\n{"kind":"commit","revision":999');await b.open(root);
   b.store.put('local_tags','123',{id:'123',tags:['confirmed']});b.store.save();await b.flush();
   // Repair stages on this PC; the NAS receives only checked immutable files.
   const w=b.store.work('123');w.coverUrls=['https://p3.douyinpic.com/test.png'];b.store.put('works','123',w);
   const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');let fetched=0;
   const job={id:'123'};await b.saveWork(job,new AbortController().signal,{resolveWork:async()=>w},async()=>{fetched++;return new Response(png,{headers:{'content-type':'image/png'}});},()=>{});
   assert.equal(fetched,1);assert.equal(b.store.isDownloaded('123'),true);
   assert.equal(fs.readFileSync(path.join(b.store.download('123').path,b.store.download('123').assets.find(a=>a.key==='video').file),'utf8'),'test-content');
   b.store.upsertWork({aweme_id:'456',desc:'deleted fixture',author:{nickname:'test'},video:{play_addr:{url_list:[]}}});
   b.store.put('downloads','456',{id:'456',path:path.join(b.store.root,'deleted-fixture'),state:'complete',assets:[{key:'video',file:'absent.mp4',size:4}]});b.store.setSetting('downloadJobs',[{id:'456',state:'complete'}]);b.store.save();await b.flush();
   assert.deepEqual(await b.pruneDeletedDownloads(),['456']);assert.ok(b.store.work('456'));assert.equal(b.store.download('456'),null);assert.equal(b.store.getSetting('downloadJobs').length,0);
   // A new mount path uses the same relative library paths and ID.
   if(!process.env.CANGXIA_NAS_TEST_ROOT){await b.close();const moved=path.join(base,'new-mount');fs.renameSync(root,moved);await b.open(moved);assert.equal(b.store.isDownloaded('123'),true);assert.ok(b.store.download('123').path.startsWith(moved));
     await b.close();const head=headFromLog(fs.readFileSync(path.join(moved,'.cangxia','head.log')));fs.writeFileSync(path.join(moved,'.cangxia','versions',head.file),'corrupted');await assert.rejects(b.open(moved),/校验失败/);assert.equal(b.writable,false);
   }
 }finally{await a.close();await b.close();source.close();if(process.env.CANGXIA_NAS_TEST_ROOT){assert.equal(path.dirname(root),path.resolve(process.env.CANGXIA_NAS_TEST_ROOT));assert.ok(path.basename(root).startsWith('cangxia-owned-test-'));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});}assert.equal(path.dirname(base),os.tmpdir());fs.rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:150});}
});

test('NAS paths and torn head reject unsafe/incomplete records',()=>{
 assert.throws(()=>child('C:\\library','../secret'));assert.throws(()=>child('C:\\library','C:\\secret'));
 const entry={kind:'commit',revision:1,file:'abc.sqlite',sha:'a'.repeat(64)};
 const head=Buffer.concat([Buffer.alloc(256),Buffer.from('\n'+JSON.stringify(entry)+'\n{"kind":')]);assert.deepEqual(headFromLog(head),entry);
});
