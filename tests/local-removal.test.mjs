import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../electron/store.mjs';
import {LocalRemoval} from '../electron/local-removal.mjs';

async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-remove-')),store=await Store.open(path.join(root,'library.sqlite'),path.join(root,'media'));
 for(const id of ['1','2','3']){store.upsertWork({aweme_id:id,desc:'work '+id});const dir=store.destination(id).dir;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'image.jpg'),'file');store.put('downloads',id,{id,path:dir,state:'complete',assets:[{file:'image.jpg',key:'image-0',kind:'image',size:4}]});}
 store.setSetting('downloadJobs',['1','2','3'].map(id=>({id,state:'complete'})));
 t.after(()=>{store.close();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});return {store,root};
}
test('cancel during preparation deletes nothing and waits for backup to settle',async t=>{
 const {store}=await fixture(t);let finish,trashed=0;const gate=new Promise(r=>finish=r);
 const task=new LocalRemoval({store,before:()=>gate,trash:async()=>trashed++});task.start(['1','2']);task.cancel();assert.equal(task.running,true);finish();await task.wait();
 assert.equal(trashed,0);assert.equal(task.state().phase,'cancelled');assert.equal(store.all('downloads').length,3);
});
test('cancel finishes one in-flight trash, keeps remaining folders, and reconciles locally even if NAS disconnects',async t=>{
 const {store}=await fixture(t);let finish,started;const begun=new Promise(r=>started=r),gate=new Promise(r=>finish=r),second=store.download('2').path;
 const task=new LocalRemoval({store,trash:async dir=>{started();await gate;await fs.promises.rename(dir,dir+'.recycled');}});
 task.start(['1','2','3']);await begun;task.cancel();store.backup={changed(){},assertWritable(){throw Error('NAS offline');},localKey:k=>['downloadJobs','localRemoval'].includes(k)};finish();await task.wait();
 assert.equal(task.state().deleted,1);assert.equal(task.state().processed,1);assert.equal(task.state().phase,'cancelled');assert.equal(store.download('1'),null);assert.ok(fs.existsSync(second));assert.equal(store.all('works').length,3);assert.deepEqual(store.getSetting('downloadJobs').map(j=>j.id),['2','3']);
});
test('restart marks interrupted deletion, reconciles absent folders, and never resumes destruction',async t=>{
 const {store}=await fixture(t);const dir=store.download('1').path;fs.renameSync(dir,dir+'.recycled');
 store.setSetting('localRemoval',{running:true,phase:'deleting',processed:0,total:3,deleted:0,failed:0,current:'1'});
 let trashed=0;const task=new LocalRemoval({store,trash:async()=>trashed++});assert.equal(task.state().phase,'interrupted');assert.equal(task.running,false);
 await store.pruneDeletedDownloads();assert.equal(trashed,0);assert.equal(store.download('1'),null);assert.ok(store.download('2'));assert.equal(store.all('works').length,3);
});
test('trash failure retains its record and reports partial completion',async t=>{
 const {store}=await fixture(t);const task=new LocalRemoval({store,trash:async dir=>{if(dir===store.download('1').path)throw Error('access denied');await fs.promises.rename(dir,dir+'.recycled');}});
 task.start(['1','2']);await task.wait();assert.equal(task.state().phase,'partial');assert.equal(task.state().failed,1);assert.ok(store.download('1'));assert.equal(store.download('2'),null);
});
