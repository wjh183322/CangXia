import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../electron/store.mjs';import {findDeletedDownloads} from '../electron/deleted-downloads.mjs';
import {exportRecords} from '../electron/backup-model.mjs';

async function fixture(t){const base=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-prune-')),s=await Store.open(path.join(base,'db.sqlite'),path.join(base,'media'));t.after(()=>{s.close();assert.equal(path.dirname(base),os.tmpdir());fs.rmSync(base,{recursive:true,force:true});});for(const id of ['1','2','3','4','5']){s.upsertWork({aweme_id:id,desc:'fixture',author:{nickname:'test'},video:{play_addr:{url_list:[]}}});const d={id,path:s.destination(id).dir,state:'complete',assets:[{key:'video',file:'video.mp4',kind:'video',size:4}]};fs.mkdirSync(d.path,{recursive:true});s.put('downloads',id,d);}return s;}

test('forget wholly deleted files and finished history while retaining favorites, partial files and queued jobs',async t=>{
 const s=await fixture(t);s.ingestMembers('__all__',['5','4','3','2','1'],true);s.put('local_tags','1',{id:'1',tags:['keep']});
 fs.writeFileSync(path.join(s.download('2').path,'video.mp4'),'good');
 fs.writeFileSync(path.join(s.download('3').path,'video.mp4'),''); // Damaged is not deleted.
 fs.writeFileSync(path.join(s.download('4').path,'video.mp4.part'),'partial');
 const d=s.download('5');d.assets.push({key:'metadata',file:'info.json',size:2});s.put('downloads','5',d);fs.writeFileSync(path.join(d.path,'info.json'),'{}');
 s.setSetting('downloadJobs',[{id:'1',state:'complete'},{id:'1',state:'waiting'},{id:'2',state:'complete'},{id:'9',state:'complete'},{id:'8',state:'failed'}]);
 assert.deepEqual(await s.pruneDeletedDownloads(),['1']);assert.equal(s.download('1'),null);for(const id of ['2','3','4','5'])assert.ok(s.download(id));
 assert.deepEqual(s.snapshot().members.__all__,['5','4','3','2','1']);assert.deepEqual(s.get('local_tags','1').tags,['keep']);
 assert.deepEqual(s.getSetting('downloadJobs').map(j=>[j.id,j.state]),[['1','waiting'],['2','complete'],['8','failed']]);
});

test('an unavailable storage probe or an unreadable path cannot authorize cleanup',async t=>{
 const s=await fixture(t),records=s.all('downloads');let probes=0;
 await assert.rejects(findDeletedDownloads(records,{validate:()=>{},probe:async()=>{if(++probes===2)throw new Error('offline');}}),/offline/);
 assert.equal(s.all('downloads').length,5);
 assert.deepEqual(await findDeletedDownloads(records,{probe:async()=>{},validate:async()=>{throw new Error('access denied');}}),[]);
});

test('backup export omits hidden records after obsolete file records are cleared',async t=>{
 const s=await fixture(t);await s.pruneDeletedDownloads();s.deleteReadRecords(['1','2']);const entries=exportRecords(s);assert.equal(entries.filter(e=>e.table==='works').length,3);assert.equal(entries.filter(e=>e.table==='downloads').length,0);assert.equal(s.all('downloads').length,0);
});
