import test from 'node:test';import assert from 'node:assert/strict';
import {ResponseCapture} from '../scripts/favorite-scroll/response-capture.mjs';
test('stream receives prefix and later chunks including a split UTF8 character without a cache lookup',async()=>{
  let release;const calls=[];const body=Buffer.from('{"desc":"测试","has_more":0}');const capture=new ResponseCapture(async method=>{calls.push(method);if(method==='Network.streamResourceContent')return new Promise(r=>release=r);throw Error('cache evicted');});
  capture.start('a');capture.data('a',body.subarray(10,12).toString('base64'));capture.data('a',body.subarray(12).toString('base64'));const pending=capture.finish('a');release({bufferedData:body.subarray(0,10).toString('base64')});const result=await pending;assert.equal(result.text,body.toString());assert.equal(result.mode,'stream');assert.deepEqual(calls,['Network.streamResourceContent']);
});
test('all completed responses are captured without waiting for earlier UI or report work',async()=>{
  const calls=[];const capture=new ResponseCapture(async(method,{requestId})=>{calls.push(requestId+':'+method);if(method==='Network.streamResourceContent')throw Error('unsupported');return {body:requestId};});
  capture.start('one');capture.start('two');const one=capture.finish('one'),two=capture.finish('two');await new Promise(r=>setImmediate(r));assert.ok(calls.includes('two:Network.getResponseBody'));assert.equal((await two).text,'two');assert.equal((await one).text,'one');
});
test('oversized and failed captures are explicit failures, never empty successful pages',async()=>{
  const capture=new ResponseCapture(async()=>({bufferedData:Buffer.from('12345').toString('base64')}),{limit:4});capture.start('a');assert.match((await capture.finish('a')).error.message,/过大/);assert.equal(capture.items.size,0);
  const failed=new ResponseCapture(async()=>{throw Error('Request content was evicted from inspector cache');});failed.start('a');assert.ok((await failed.finish('a')).error);assert.ok((await failed.finish('missing')).error);
});
