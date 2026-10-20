import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../electron/store.mjs';import {SqliteStore} from '../electron/sqlite-store.mjs';import {DefectRepair} from '../electron/defect-repair.mjs';
async function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-problem-identity-')),file=path.join(dir,'library.sqlite');let store=await Store.open(file,path.join(dir,'media')),manager;
 const start=()=>{manager=new DefectRepair({store,backup:{meta:{dirty:true,baseRevision:null},covers:{problems:new Map(),saveProblems(){}},status:{writable:true}},queue:{jobs:[]},collector:{cancelResolve(){}},profile:dir,runForeground:action=>action()});return manager;};
 const close=async()=>{manager?.close();manager=null;await store.fileStates.close();store.close();};t.after(async()=>{await close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});return {dir,file,start,close,get store(){return store;},async reopen(){store=await Store.open(file,path.join(dir,'media'));return start();}};
}
const add=(store,id)=>{const work=store.upsertWork({aweme_id:id,desc:'identity fixture '+id,video:{cover:{url_list:['https://p3.douyinpic.com/fixture.jpg']},play_addr:{url_list:[]}}});store.ingestMembers('__all__',[...store.orderedMemberRows('__all__').map(r=>r.work_id),id],true);return work;};
const mark=(store,id)=>store.put('works',id,{...store.work(id),remoteState:'unavailable',sourceStatus:{state:'unavailable',reason:'old library evidence'}});
test('a replacement local library cannot inherit problems from a previous database',async t=>{
 const f=await fixture(t);add(f.store,'1');mark(f.store,'1');let manager=f.start();assert.equal((await manager.overview()).total,1);const identity=f.store.localIdentity;await f.close();assert.equal(path.dirname(f.file),f.dir);fs.unlinkSync(f.file);manager=await f.reopen();for(let n=2;n<20;n++)add(f.store,String(n));assert.notEqual(f.store.localIdentity,identity);assert.equal((await manager.overview()).total,0);assert.equal(manager.job,null);
});
test('restoring an older copy of the same database resets future derived problems',async t=>{
 const f=await fixture(t);add(f.store,'2');const snapshot=path.join(f.dir,'before.sqlite');await SqliteStore.copyFile(f.file,snapshot);const identity=f.store.localIdentity;add(f.store,'1');mark(f.store,'1');let manager=f.start();assert.equal((await manager.overview()).total,1);await f.close();fs.copyFileSync(snapshot,f.file);manager=await f.reopen();assert.equal(f.store.localIdentity,identity);assert.equal((await manager.overview()).total,0);
});
