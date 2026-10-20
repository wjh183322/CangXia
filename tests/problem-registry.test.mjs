import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
async function fixture(t){const {ProblemRegistry}=await import('../electron/problem-registry.mjs'),db=new DatabaseSync(':memory:');t.after(()=>db.close());return {db,registry:new ProblemRegistry(db)};}
const at='2026-10-20T12:00:00.000Z';
test('selected verification preserves unrelated unavailable works in the persistent overview',async t=>{
 const {db,registry:r}=await fixture(t);
 r.patchMany([...Array.from({length:204},(_,n)=>({id:String(n+1),rank:n,source:{state:'unavailable',reason:'fixture',checkedAt:at},checkedAt:at})),...Array.from({length:74},(_,n)=>({id:String(1000+n),rank:204+n,file:{status:'downloadFailed',issues:[{kind:'download',reason:'fixture'}]},checkedAt:at}))]);
 r.patchMany(Array.from({length:74},(_,n)=>({id:String(1000+n),source:{state:n<9?'available':'unknown',checkedAt:at},checkedAt:at})));
 assert.equal(r.page({sourceStatus:'unavailable'}).total,204);assert.equal(r.page({fileStatus:'downloadFailed'}).total,74);assert.equal(r.page({}).total,278);
 const {ProblemRegistry}=await import('../electron/problem-registry.mjs'),reopened=new ProblemRegistry(db);assert.equal(reopened.page({sourceStatus:'unavailable'}).total,204);assert.equal(reopened.page({sourceStatus:'unknown'}).total,65);
});
test('repairing nine and cancelling another operation cannot replace unrelated problem facts',async t=>{
 const {registry:r}=await fixture(t);r.patchMany(Array.from({length:15},(_,n)=>({id:String(n+1),file:{status:'pending',issues:[{kind:'files',type:'video',reason:'missing'}]},source:{state:'available'},checkedAt:at})));
 r.patchMany(Array.from({length:9},(_,n)=>({id:String(n+1),file:{status:'complete',issues:[]},task:{state:'complete'},checkedAt:at})));
 assert.equal(r.page({}).total,6);assert.deepEqual(r.page({}).items.map(i=>i.id),['10','11','12','13','14','15']);
});
test('available source and failed download remain independent dimensions with deduplicated total',async t=>{
 const {registry:r}=await fixture(t);r.patchMany([{id:'1',file:{status:'downloadFailed',issues:[{kind:'download',reason:'failed'}]},source:{state:'available'},checkedAt:at},{id:'2',source:{state:'unavailable'},checkedAt:at}]);
 assert.equal(r.page({sourceStatus:'available',fileStatus:'downloadFailed'}).total,1);assert.equal(r.page({}).total,2);assert.equal(r.page({}).counts.sourceStatus.unavailable,1);assert.equal(r.page({}).counts.fileStatus.downloadFailed,1);
});
test('late source evidence cannot overwrite a newer source result',async t=>{
 const {registry:r}=await fixture(t);r.patchMany([{id:'1',source:{state:'unavailable',checkedAt:'2026-10-20T12:00:01.000Z'},checkedAt:at}]);r.patchMany([{id:'1',source:{state:'available',checkedAt:'2026-10-20T12:00:00.000Z'},checkedAt:at}]);assert.equal(r.page({sourceStatus:'unavailable'}).total,1);
});
test('source uncertainty survives a complete-file patch and task-history pruning',async t=>{
 const {db,registry:r}=await fixture(t);r.patchMany([{id:'1',file:{status:'downloadFailed',issues:[{kind:'files'}]},source:{state:'unknown'},checkedAt:at}]);r.patchMany([{id:'1',file:{status:'complete',issues:[]},task:{state:'complete'},checkedAt:at}]);db.exec('CREATE TABLE job(body TEXT);DELETE FROM job');assert.equal(r.page({sourceStatus:'unknown'}).total,1);
});
test('paged cross-page selections cannot expand or silently use a changed problem snapshot',async t=>{
 const {registry:r}=await fixture(t);r.patchMany(Array.from({length:55},(_,n)=>({id:String(n+1),rank:n,file:{status:n<30?'pending':'downloadFailed',issues:[{kind:'files',type:'video'}]},checkedAt:at})));
 const page=r.page({fileStatus:'pending'});assert.equal(page.items.length,20);assert.equal(page.total,30);assert.equal(r.page({fileStatus:'pending',page:2}).items.length,10);
 const selected=r.resolveSelection({token:page.token,all:true,fileStatus:'all',exclude:['1']});assert.equal(selected.length,29);assert.ok(!selected.includes('31'));
 r.patchMany([{id:'99',file:{status:'pending',issues:[{kind:'files'}]},checkedAt:at}]);assert.throws(()=>r.resolveSelection({token:page.token,all:true,exclude:[]}),/更新/);
});
test('one problem page deserializes only its twenty rows and selection reads IDs only',async t=>{
 const {registry:r}=await fixture(t);r.patchMany(Array.from({length:200},(_,n)=>({id:String(n+1),rank:n,file:{status:'pending',issues:[{kind:'files'}]},checkedAt:at})));
 const parse=JSON.parse;let parsed=0;t.mock.method(JSON,'parse',(...args)=>{parsed++;return parse(...args);});const page=r.page({});assert.equal(page.items.length,20);assert.ok(parsed<=20);
 parsed=0;assert.equal(r.resolveSelection({token:page.token,all:true,exclude:[]}).length,200);assert.equal(parsed,0);
});
test('unchanged facts with a newer check time do not invalidate a selection',async t=>{
 const {registry:r}=await fixture(t),file={status:'pending',issues:[{kind:'files'}]};r.patchMany([{id:'1',file,checkedAt:at}]);const page=r.page({});r.patchMany([{id:'1',file,checkedAt:'2026-10-20T12:00:01.000Z'}]);assert.deepEqual(r.resolveSelection({token:page.token,all:true,exclude:[]}),['1']);
});
