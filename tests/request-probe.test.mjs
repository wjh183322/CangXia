import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {REQUEST_URL,FORM,MAX_BYTES,signatureNames,summarize,conclusion,limitedText,pageFetchScript,compareOnce} from '../diagnostics/request-probe/core.mjs';

test('probe report retains counts and signature names without secrets, IDs or titles',()=>{
 const secret='SYNTHETIC_SECRET';const names=signatureNames(REQUEST_URL+'&a_bogus='+secret+'&msToken='+secret);
 const result=summarize({status:200,text:JSON.stringify({status_code:0,aweme_list:[{aweme_id:secret,desc:secret}],has_more:1,other:secret}),signatureKeys:names});
 assert.equal(result.outcome,'success');assert.equal(result.items,1);assert.deepEqual(result.signatureKeys,['a_bogus']);assert.ok(!JSON.stringify(result).includes(secret));
 assert.deepEqual(signatureNames('https://other.invalid'+new URL(REQUEST_URL).pathname+'?a_bogus=secret'),[]);
});
test('probe distinguishes denied, platform restriction, malformed and empty valid results',()=>{
 assert.equal(summarize({status:403,text:'forbidden'}).outcome,'denied');
 assert.equal(summarize({status:429}).outcome,'limited');
 assert.equal(summarize({status:200,text:JSON.stringify({status_code:4,status_msg:'访问太频繁'})}).outcome,'limited');
 assert.equal(summarize({status:200,text:'<html>private content</html>'}).format,'html');
 assert.equal(summarize({status:200,text:'{"status_code":0}'}).outcome,'error');
 assert.equal(summarize({status:200,text:'{"status_code":0,"aweme_list":[]}'}).items,0);
 assert.ok(!JSON.stringify(summarize({error:'private cookie value'})).includes('private'));
});
test('comparison stops on frequency restriction with no fallback request',async()=>{
 let calls=0;const results=await compareOnce({direct:async()=>summarize({status:429}),page:async()=>{calls++;},signal:new AbortController().signal,delay:async()=>{throw Error('must not wait');}});
 assert.equal(results.length,1);assert.equal(calls,0);assert.match(conclusion(results),/未切换方式/);
});
test('explicit comparison runs each method once after 403 and reports bounded inference',async()=>{
 const calls=[];const results=await compareOnce({direct:async()=>{calls.push('direct');return summarize({status:403});},page:async()=>{calls.push('page');return summarize({status:200,text:'{"status_code":0,"aweme_list":[]}'});},signal:new AbortController().signal,delay:async()=>calls.push('delay')});
 assert.deepEqual(calls,['direct','delay','page']);assert.match(conclusion(results),/不能单独证明/);
});
test('cancel between requests does not start the browser request',async()=>{
 const control=new AbortController();let called=false;const results=await compareOnce({direct:async()=>summarize({status:403}),page:async()=>{called=true;},signal:control.signal,delay:async()=>control.abort()});
 assert.equal(results.length,1);assert.equal(called,false);
});
test('bounded direct response reader cancels an oversized body',async()=>{
 let cancelled=false;const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(MAX_BYTES+1));},cancel(){cancelled=true;}}));
 await assert.rejects(limitedText(response),/too-large/);assert.equal(cancelled,true);
});
function context(fetch){return {location:{origin:'https://www.douyin.com'},window:{},AbortController,TextDecoder,setTimeout,clearTimeout,fetch};}
test('browser POST uses page fetch with same first-page parameters and removes abort controller',async()=>{
 let request;const ctx=context(async(url,opts)=>{request={url,opts};return new Response('{"status_code":0,"aweme_list":[]}');});
 const result=await vm.runInNewContext(pageFetchScript('probe_test'),ctx);assert.equal(result.status,200);assert.equal(request.url,REQUEST_URL);assert.equal(request.opts.body,FORM);assert.equal(request.opts.method,'POST');assert.equal(request.opts.credentials,'include');assert.equal(request.opts.redirect,'error');assert.ok(request.opts.signal);assert.equal(ctx.window.probe_test,undefined);
});
test('browser POST supports timeout and explicit cancellation',async()=>{
 const stalled=(_u,opts)=>new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
 let ctx=context(stalled);let result=await vm.runInNewContext(pageFetchScript('probe_test',10),ctx);assert.equal(result.error,'timeout');assert.equal(ctx.window.probe_test,undefined);
 ctx=context(stalled);const pending=vm.runInNewContext(pageFetchScript('probe_test'),ctx);ctx.window.probe_test.abort('cancelled');result=await pending;assert.equal(result.error,'cancelled');assert.equal(ctx.window.probe_test,undefined);
});
test('page moved away from official origin is rejected before requesting',async()=>{
 const ctx=context(()=>{throw Error('must not request');});ctx.location.origin='https://other.invalid';const result=await vm.runInNewContext(pageFetchScript('probe_test'),ctx);assert.equal(result.error,'page-changed');
});
