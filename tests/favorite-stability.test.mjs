import test from 'node:test';import assert from 'node:assert/strict';import {ScrollStability} from '../scripts/favorite-scroll/stability.mjs';import {ResponseCapture} from '../scripts/favorite-scroll/response-capture.mjs';
test('production capture never calls experimental response streaming',async()=>{
  const calls=[];const capture=new ResponseCapture(async(method)=>{calls.push(method);return {body:'{"has_more":0}'};});capture.start('a');assert.deepEqual(calls,[]);assert.equal((await capture.finish('a')).text,'{"has_more":0}');assert.deepEqual(calls,['Network.getResponseBody']);
});
test('crash invalidates old page generation and navigation is an explicit recovery',()=>{
  const health=new ScrollStability(),oldEpoch=health.epoch;health.crash({status:'crashed',errorCode:-2147483645});assert.equal(health.crashed,true);assert.notEqual(health.epoch,oldEpoch);assert.equal(health.crashes.length,1);const crashedEpoch=health.epoch;health.navigate();assert.equal(health.crashed,false);assert.ok(health.epoch>crashedEpoch);assert.equal(health.crashes.length,1);
});
test('resource history is bounded and includes no webpage content or credentials',()=>{
  const h=new ScrollStability();for(let i=0;i<140;i++)h.sample({usedSize:2*1048576,totalSize:4*1048576,nodes:1000,freeBytes:5*1048576,rssBytes:3*1048576,works:i,cookie:'not saved'});assert.equal(h.samples.length,120);assert.equal(h.samples.at(-1).heapMiB,2);assert.equal(h.samples.at(-1).works,139);assert.equal(JSON.stringify(h.samples).includes('not saved'),false);
});
