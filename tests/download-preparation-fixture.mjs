import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {Store} from '../electron/store.mjs';import {DownloadQueue} from '../electron/downloads.mjs';
export async function createPreparationFixture(t,{savedCount=0,unsavedCount=1,unavailableCount=0,StoreType=Store,QueueType=DownloadQueue}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-preparation-')),root=path.join(dir,'media'),ids=[],operations=[];let store=await StoreType.open(path.join(dir,'library.sqlite'),root),queue;
 let closed=false;const close=async()=>{if(closed)return;closed=true;if(!store.closed){await queue.preparation?.close();queue.pause();await queue.waitForIdle();await store.fileStates.close();store.close();}assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});};
 const assets=Array.from({length:4},(_,i)=>({key:i?'image-'+i:'video',kind:i?'image':'video',file:i?'image-'+i+'.jpg':'video.mp4',size:234567,sha256:'a'.repeat(64)}));
 store.db.run('BEGIN');try{
  for(let i=0;i<savedCount+unsavedCount+unavailableCount;i++){const id=String(i+1);ids.push(id);store.upsertWork({aweme_id:id,desc:'fixture-'+id,author:{uid:'7',nickname:'fixture'},video:{play_addr:{url_list:['https://v3.douyinvod.com/fixture.mp4']}}});if(i<savedCount){store.put('downloads',id,{id,path:path.join(root,'saved',id),collectionId:'__all__',state:'complete',assets});store.fileStates.cache.set(id,{root,status:'complete',assets:{}});}else if(i>=savedCount+unsavedCount)store.put('works',id,{...store.work(id),remoteState:'unavailable'});}
  store.ingestMembers('__all__',ids,true);store.db.run('COMMIT');
 }catch(e){store.db.run('ROLLBACK');throw e;}
 await store.lightViews.prepare();const makeQueue=()=>{queue=new QueueType(store,{},async()=>{throw Error('fixture must not use network');},()=>{});queue.run=async()=>{};};makeQueue();
 t?.after(close);return {dir,root,get store(){return store;},get queue(){return queue;},ids,operations,close,async reopen(){await queue.preparation?.close();queue.pause();await queue.waitForIdle();await store.fileStates.close();store.close();store=await StoreType.open(path.join(dir,'library.sqlite'),root);await store.lightViews.prepare();makeQueue();}};
}
