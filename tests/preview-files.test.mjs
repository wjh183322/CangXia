import test from 'node:test';import assert from 'node:assert/strict';
import {PreviewFiles} from '../electron/preview-files.mjs';
const request=()=>new Request('https://fixture.invalid/');
const held=onCancel=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));},cancel:onCancel}));

test('deletion cancels only selected preview streams and releases their cache pins',async()=>{
 const cancelled=[],released=[];const previews=new PreviewFiles(async file=>held(()=>cancelled.push(file)));
 const a=await previews.open('1','first',request(),{release:()=>released.push('1')}),b=await previews.open('2','second',request(),{release:()=>released.push('2')});
 await previews.closeSelected(['1']);assert.deepEqual(cancelled,['first']);assert.deepEqual(released,['1']);assert.equal(previews.active.has('1'),false);assert.equal(previews.active.has('2'),true);
 await assert.rejects(a.text(),/删除|停止/);await b.body.cancel();assert.deepEqual(released,['1','2']);assert.equal(previews.active.size,0);
});
test('selected works cannot acquire new handles while deletion is in progress',async()=>{
 let calls=0,released=0;const previews=new PreviewFiles(async()=>{calls++;return new Response('ready');});const unblock=previews.block(['1']);
 const blocked=await previews.open('1','file',request(),{release:()=>released++});assert.equal(blocked.status,423);assert.equal(calls,0);assert.equal(released,1);
 unblock();unblock();assert.equal(await(await previews.open('1','file',request())).text(),'ready');assert.equal(previews.active.size,0);
});
test('deletion waits for a late fetch to settle before releasing its eventual file reader',async()=>{
 let finish,cancelled=0;const previews=new PreviewFiles(()=>new Promise(resolve=>finish=resolve));const opening=previews.open('1','late',request());opening.catch(()=>{});await new Promise(r=>setImmediate(r));
 let done=false;const closing=previews.closeSelected(['1']).then(()=>done=true);await new Promise(r=>setImmediate(r));assert.equal(done,false);
 finish(held(()=>cancelled++));await closing;await assert.rejects(opening,/删除|停止/);assert.equal(cancelled,1);assert.equal(previews.active.size,0);
});
test('renderer request cancellation closes the original fetch and its cache pin once',async()=>{
 const external=new AbortController();let closed=0,released=0;const previews=new PreviewFiles(async(_file,{signal})=>{signal.addEventListener('abort',()=>closed++);return held(()=>{});});
 const response=await previews.open('1','file',new Request('https://fixture.invalid/',{signal:external.signal}),{release:()=>released++});const reading=response.text();reading.catch(()=>{});external.abort(Error('client stopped'));await assert.rejects(reading,/client stopped/);
 assert.equal(closed,1);assert.equal(released,1);assert.equal(previews.active.size,0);
});
test('normal EOF preserves range headers and releases the response without a deletion',async()=>{
 let released=0;const previews=new PreviewFiles(async(_file,options)=>{assert.equal(options.headers.get('range'),'bytes=0-2');return new Response('abc',{status:206,headers:{'content-range':'bytes 0-2/3'}});});
 const response=await previews.open('1','file',new Request('https://fixture.invalid/',{headers:{Range:'bytes=0-2'}}),{release:()=>released++});assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 0-2/3');assert.equal(await response.text(),'abc');assert.equal(released,1);assert.equal(previews.active.size,0);
});
test('failed file fetches leave no registered handle or cache pin',async()=>{
 let released=0;const previews=new PreviewFiles(async()=>{throw Error('file unavailable');});await assert.rejects(previews.open('1','file',request(),{release:()=>released++}),/file unavailable/);assert.equal(released,1);assert.equal(previews.active.size,0);await previews.closeSelected(['1']);
});

test('audio-only removal closes and blocks audio handles while the same work cover stays readable',async()=>{
 const cancelled=[];const previews=new PreviewFiles(async file=>held(()=>cancelled.push(file)));
 const audioRequest=()=>new Request('https://audio/1/music');
 const audio=await previews.open('1','music',audioRequest()),cover=await previews.open('1','cover',request());
 const unblock=previews.block(['1'],'audio');await previews.closeSelected(['1'],'audio');
 assert.deepEqual(cancelled,['music']);await assert.rejects(audio.text(),/删除|停止/);
 assert.equal((await previews.open('1','music',audioRequest())).status,423);
 const anotherCover=await previews.open('1','cover-again',request());assert.equal(anotherCover.status,200);
 unblock();await cover.body.cancel();await anotherCover.body.cancel();assert.equal(previews.active.size,0);
});
