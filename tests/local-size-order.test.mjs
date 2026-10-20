import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {Store} from '../electron/store.mjs';
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-size-order-')),store=await Store.open(path.join(dir,'library.sqlite'),path.join(dir,'media'));
 t.after(async()=>{await store.fileStates.close();store.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 for(const [id,bytes]of [['1',10],['2',null],['3',30],['4',10]]){store.upsertWork({aweme_id:id,desc:'size fixture '+id,author:{uid:['3','4'].includes(id)?'2':'1',nickname:'fixture'},images:[{url_list:['https://p3.douyinpic.com/fixture.jpg']}]});store.put('downloads',id,{id,path:path.join(store.root,id),state:bytes===null?'partial':'complete',assets:[{key:'image-0',file:'image.jpg',kind:'image',...(bytes===null?{}:{size:bytes-2})},{key:'metadata',file:'info.json',kind:'metadata',size:2}]});store.fileStates.cache.set(id,{id,root:store.root,status:bytes===null?'unknown':'complete',local:true,bytes:bytes??0,assets:{'image-0':{exists:bytes!==null,state:bytes===null?'unknown':'available'},metadata:{exists:true,state:'available'}}});}
 await store.lightViews.prepare();return store;
}
test('indexed size sorting keeps original ties and puts unknown sizes last in both directions',async t=>{
 const store=await fixture(t),ids=['1','2','3','4'];store.fileStates.check=async()=>{throw Error('sorting must not check disk');};
 assert.deepEqual(await store.lightViews.search.query(ids,{sort:'size-desc'}),['3','1','4','2']);assert.deepEqual(await store.lightViews.search.query(ids,{sort:'size-asc'}),['1','4','3','2']);assert.deepEqual(await store.lightViews.search.query(ids,{sort:'original'}),ids);assert.deepEqual(ids,['1','2','3','4']);
 assert.deepEqual(await store.lightViews.search.query(['4','1','2','3'],{sort:'size-asc'}),['4','1','3','2']);
});
test('filtering precedes size ordering and a changed file index invalidates the saved size',async t=>{
 const store=await fixture(t);assert.deepEqual(await store.lightViews.search.query(['1','2','3','4'],{sort:'size-asc',author:'uid:2'}),['4','3']);
 store.fileStates.cache.set('1',{...store.fileStates.get('1'),bytes:40});store.lightViews.invalidateFiles('1');assert.deepEqual(await store.lightViews.search.query(['1','2','3','4'],{sort:'size-desc'}),['1','3','4','2']);
 await assert.rejects(store.lightViews.search.query(['1'],{sort:'unsupported'}));
});
test('shared audio does not inflate per-work size and audio-only works have no ordinary file-size proof',async t=>{
 const store=await fixture(t);store.upsertWork({aweme_id:'5',desc:'audio fixture',images:[{url_list:[]}]});store.audio={localIndex:new Map(['1','4','5'].map(id=>[id,{local_saved:1,sha:'a'.repeat(64)}]))};for(const id of ['1','4','5'])store.lightViews.invalidateFiles(id);
 assert.deepEqual(await store.lightViews.search.query(['1','2','3','4','5'],{sort:'size-asc'}),['1','4','3','2','5']);assert.equal(store.lightViews.view('1').localBytes,10);assert.equal(store.lightViews.view('5').audioOnly,true);assert.equal(store.lightViews.view('5').localBytesKnown,false);
});
test('confirmation counts present optional HD files without requiring missing optional files',async t=>{
 const store=await fixture(t),d=store.download('1');fs.mkdirSync(d.path,{recursive:true});fs.writeFileSync(path.join(d.path,'image.jpg'),'12345678');fs.writeFileSync(path.join(d.path,'info.json'),'{}');fs.writeFileSync(path.join(d.path,'hd.jpg'),'12345');store.put('downloads','1',{...d,assets:[...d.assets,{key:'cover-hd-original',file:'hd.jpg',kind:'image',size:5}]});
 assert.equal(await store.fileStates.confirmWritten('1'),true);assert.equal(store.fileStates.get('1').bytes,15);fs.unlinkSync(path.join(d.path,'hd.jpg'));assert.equal(await store.fileStates.confirmWritten('1'),true);assert.equal(store.fileStates.get('1').bytes,10);
});
test('known on-disk bytes include an invalid registered file without calling it complete',async t=>{
 const store=await fixture(t),d=store.download('1');fs.mkdirSync(d.path,{recursive:true});fs.writeFileSync(path.join(d.path,'image.jpg'),'123456789012');fs.writeFileSync(path.join(d.path,'info.json'),'{}');await store.fileStates.check(['1']);assert.equal(store.fileStates.get('1').status,'partial');assert.equal(store.fileStates.get('1').bytes,14);
});
