import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {redirectHeaders} from '../electron/redirect-headers.mjs';import {resolveAuthorLink} from '../electron/author-sources.mjs';
const id='MS4wLjABAAAA_SYNTHETIC_AUTHOR';
function fakeNet(run){let aborted=0,options;const request=new EventEmitter();request.abort=()=>{aborted++;request.emit('close');};request.end=()=>run(request);return {net:{request:o=>{options=o;return request;}},get aborted(){return aborted;},get options(){return options;}};}
test('Electron redirect event is captured before cancellation and late errors are ignored',async()=>{
  const fake=fakeNet(r=>{r.emit('close');r.emit('redirect',302,'GET',`https://www.douyin.com/user/${id}`);r.emit('error',new Error('Redirect was cancelled'));});
  const result=await resolveAuthorLink('https://v.douyin.com/test/',redirectHeaders(fake.net,{}));assert.equal(result.id,id);assert.equal(fake.aborted,1);assert.equal(fake.options.credentials,'omit');assert.equal(fake.options.redirect,'manual');
});
test('redirect to an unapproved host is never requested',async()=>{
  let requests=0;const fake=fakeNet(r=>{requests++;r.emit('redirect',302,'GET','https://127.0.0.1/private');});
  await assert.rejects(resolveAuthorLink('https://v.douyin.com/test/',redirectHeaders(fake.net,{})),/主页分享链接/);assert.equal(requests,1);
});
test('response returns just status and location without consuming its body',async()=>{
  const fake=fakeNet(r=>{const response=new EventEmitter();response.statusCode=200;response.headers={'set-cookie':['not-exposed']};r.emit('response',response);response.emit('error',Error('aborted body'));});
  const result=await redirectHeaders(fake.net,{})('https://v.douyin.com/test/');assert.equal(result.status,200);assert.equal(result.headers.get('set-cookie'),null);assert.equal(result.body,null);assert.equal(fake.aborted,1);
});
test('stop and timeout cancel the network request without surfacing a redirect error',async()=>{
  const fake=fakeNet(()=>{}),controller=new AbortController();const result=redirectHeaders(fake.net,{})('https://v.douyin.com/test/',{signal:controller.signal});controller.abort();await assert.rejects(result,e=>e.name==='AbortError');assert.equal(fake.aborted,1);
  const already=new AbortController();already.abort();let requests=0;await assert.rejects(redirectHeaders({request:()=>{requests++;}},{} )('https://v.douyin.com/test/',{signal:already.signal}),e=>e.name==='AbortError');assert.equal(requests,0);
});
