import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {nasLibrary,nasWorks} from '../src/nas-library.mjs';
import {Store} from '../electron/store.mjs';import {SnapshotFeed} from '../electron/snapshot-feed.mjs';import {mergeState} from '../electron/state-patch.mjs';
const asset={key:'image-0',file:'image.png',kind:'image',size:10,sha256:'a'.repeat(64)};
const work=(id,collectionId='__all__')=>({id,author:{nickname:'同名作者'},backedUp:true,backupRecord:{id,collectionId,assets:[asset]}});
test('NAS source facets overlap by relation, deduplicate totals and bytes, and retain removed scopes',()=>{
 const data={works:[work('1'),work('2','author:A'),work('3','author:B'),work('4','8'),{...work('5'),backedUp:false,backupRecord:{assets:[],backupRemoved:true}}],collections:[{id:'__all__',name:'收藏'},{id:'9',name:'摄影',rank:0}],localMembers:{__all__:['1'],9:['1']},authors:[{id:'A',name:'同名作者'}],authorMembers:{A:['1','2','5']},backupAuthors:[{id:'B',name:'已移除作者乙',archived:true}],backupAuthorMembers:{B:['3']}};
 const n=nasLibrary(data);assert.deepEqual(n.counts,{all:4,collection:2,author:3});assert.equal(n.bytes,10);assert.deepEqual(nasWorks(n,'all').map(w=>w.id),['1','2','3','4']);assert.deepEqual(nasWorks(n,'collection').map(w=>w.id),['1','4']);assert.deepEqual(nasWorks(n,'author',{author:'A'}).map(w=>w.id),['1','2']);assert.deepEqual(nasWorks(n,'collection',{collection:'9'}).map(w=>w.id),['1']);assert.ok(n.collections.find(c=>c.id==='8').removed);assert.ok(n.authors.find(a=>a.id==='B').removed);
 assert.deepEqual(nasWorks(n,'author',{author:'missing'}),[]);assert.deepEqual(nasWorks(n,'all',{collection:'missing'}),[]);
});
test('author-home fallback remains reachable without current author list and creator names do not create membership',()=>{
 const first=work('1','author:orphan'),second=work('2');first.backupRecord.home={kind:'author',id:'orphan'};
 const n=nasLibrary({works:[first,second],authors:[{id:'unread',name:'同名作者'}]});assert.deepEqual(nasWorks(n,'author').map(w=>w.id),['1']);assert.ok(n.authors[0].removed);assert.deepEqual(nasWorks(n,'collection').map(w=>w.id),['2']);assert.equal(n.authors.length,1);
});
test('archived and hidden author backup relations survive snapshots and delta updates without reappearing on the author reading page',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx-nas-facets-')),store=await Store.open(path.join(root,'db.sqlite'),path.join(root,'media'));t.after(()=>{store.close();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
 const id='MS4wLjABAAAA_NAS_FACET';store.authorSources.add(id,{user:{uid:'123',sec_uid:id,nickname:'作者甲'}});const run=store.authorSources.start(id);store.authorSources.apply(run,{items:[{aweme_id:'1',desc:'作者媒体',author:{uid:'123',sec_uid:id,nickname:'作者甲'},images:[{url_list:['https://p3.douyinpic.com/fixture.png']}]}],next:null,complete:true});store.put('backup_downloads','1',{id:'1',collectionId:'author:'+id,assets:[asset],state:'partial'});
 const feed=new SnapshotFeed(store);let state=feed.frame({}, {full:true});assert.equal(nasLibrary(state).authors[0].removed,false);
 store.authorSources.hide(id,['1']);store.authorSources.archive(id);state=mergeState(state,feed.frame({}));assert.equal(state.authors.length,0);assert.deepEqual(state.backupAuthorMembers[id],['1']);const n=nasLibrary(state);assert.equal(n.authors[0].removed,true);assert.deepEqual(nasWorks(n,'author',{author:id}).map(w=>w.id),['1']);
 store.put('backup_downloads','1',{id:'1',assets:[],state:'partial',backupRemoved:true});store.invalidateViews();state=mergeState(state,feed.frame({}));assert.deepEqual(nasLibrary(state).counts,{all:0,collection:0,author:0});assert.equal(state.backupAuthorMembers[id],undefined);
});
