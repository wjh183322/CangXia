import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {transferAsset} from '../electron/resumable-transfer.mjs';
import http from 'node:http';
const bytes=Buffer.from('0123456789abcdefghij'),url='https://media.invalid/video?private=synthetic',target={name:'视频',kind:'video'};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-resume-'));t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});return dir;}
const headers=(etag='"v1"',length=bytes.length)=>({'content-type':'video/mp4','content-length':String(length),etag});
const transfer=(dir,fetchMedia,options={})=>transferAsset({dir,target,url,signal:new AbortController().signal,extension:()=>'.mp4',fetchMedia,...options});
async function interrupted(dir,etag='"v1"'){
 const controller=new AbortController();await assert.rejects(transfer(dir,async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,5));c.enqueue(bytes.subarray(5));c.close();}}),{headers:headers(etag)}),{signal:controller.signal,progress:n=>{if(n>=5)controller.abort();}}));
}
test('pause checkpoints a verified prefix and resumes with Range plus strong If-Range',async t=>{
 const dir=fixture(t);await interrupted(dir);const meta=JSON.parse(fs.readFileSync(path.join(dir,'视频.resume.json')));assert.equal(meta.offset,5);assert.ok(!JSON.stringify(meta).includes('private='));let request;
 const result=await transfer(dir,async(_url,options)=>{request=options;return new Response(bytes.subarray(5),{status:206,headers:{...headers(),'content-length':'15','content-range':'bytes 5-19/20'}});});
 assert.equal(request.headers.Range,'bytes=5-');assert.equal(request.headers['If-Range'],'"v1"');assert.equal(result.resumedBytes,5);assert.deepEqual(fs.readFileSync(result.file),bytes);assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));assert.ok(!fs.existsSync(path.join(dir,'视频.resume.json')));
});
test('power-loss tail after last durable checkpoint is discarded before appending',async t=>{
 const dir=fixture(t);await interrupted(dir);fs.appendFileSync(path.join(dir,'视频.mp4.part'),'uncommitted tail');const result=await transfer(dir,async()=>new Response(bytes.subarray(5),{status:206,headers:{...headers(),'content-length':'15','content-range':'bytes 5-19/20'}}));assert.deepEqual(fs.readFileSync(result.file),bytes);
});
test('corrupted prefix forces a whole-file request rather than mixing bytes',async t=>{
 const dir=fixture(t);await interrupted(dir);fs.writeFileSync(path.join(dir,'视频.mp4.part'),'WRONG');let range;
 const result=await transfer(dir,async(_u,o)=>{range=o.headers.Range;return new Response(bytes,{headers:headers()});});assert.equal(range,undefined);assert.deepEqual(fs.readFileSync(result.file),bytes);assert.equal(result.resumedBytes,0);
});
for(const variant of ['changed-etag','wrong-range','ignored-range','expired-range'])test(`unsafe resume response ${variant} produces a complete fresh file`,async t=>{
 const dir=fixture(t);await interrupted(dir);const fresh=Buffer.from('ABCDEFGHIJKLMNOPQRST');let calls=0;
 const result=await transfer(dir,async()=>{calls++;if(calls===1){if(variant==='ignored-range')return new Response(fresh,{headers:headers('"v2"')});if(variant==='expired-range')return new Response('',{status:416});return new Response(fresh.subarray(5),{status:206,headers:{...headers(variant==='changed-etag'?'"v2"':'"v1"'),'content-length':'15','content-range':variant==='wrong-range'?'bytes 4-18/20':'bytes 5-19/20'}});}return new Response(fresh,{headers:headers('"v2"')});});
 assert.deepEqual(fs.readFileSync(result.file),fresh);assert.equal(result.resumedBytes,0);assert.equal(calls,variant==='ignored-range'?1:2);
});
test('weak ETag does not authorize resume',async t=>{const dir=fixture(t);await interrupted(dir,'W/"v1"');assert.ok(!fs.existsSync(path.join(dir,'视频.mp4.part')));assert.ok(!fs.existsSync(path.join(dir,'视频.resume.json')));});
test('short transfer never becomes a completed file',async t=>{const dir=fixture(t);await assert.rejects(transfer(dir,async()=>new Response(bytes.subarray(0,10),{headers:headers()})),/未下载完整/);assert.ok(!fs.existsSync(path.join(dir,'视频.mp4')));assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'视频.resume.json'))).offset,10);});
test('changed signed URL is conservatively downloaded whole',async t=>{const dir=fixture(t);await interrupted(dir);let range;const result=await transfer(dir,async(_u,o)=>{range=o.headers.Range;return new Response(bytes,{headers:headers()});},{url:url+'&new=1'});assert.equal(range,undefined);assert.deepEqual(fs.readFileSync(result.file),bytes);});
test('rate limit is not retried as a whole-file request',async t=>{const dir=fixture(t);await interrupted(dir);let calls=0;await assert.rejects(transfer(dir,async()=>{calls++;return new Response('',{status:429});}),e=>e.httpStatus===429);assert.equal(calls,1);assert.ok(fs.existsSync(path.join(dir,'视频.resume.json')));});
test('redirect destination change cannot reuse a same-looking ETag from another resource',async t=>{
 const dir=fixture(t),controller=new AbortController();const located=(r,value)=>{Object.defineProperty(r,'url',{value});return r;};
 await assert.rejects(transfer(dir,async()=>located(new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,5));c.enqueue(bytes.subarray(5));c.close();}}),{headers:headers()}),'https://cdn.invalid/old'),{signal:controller.signal,progress:n=>{if(n>=5)controller.abort();}}));
 const fresh=Buffer.from('ABCDEFGHIJKLMNOPQRST');let requests=0;const result=await transfer(dir,async()=>{requests++;return located(requests===1?new Response(fresh.subarray(5),{status:206,headers:{...headers(),'content-length':'15','content-range':'bytes 5-19/20'}}):new Response(fresh,{headers:headers()}),'https://cdn.invalid/new');});assert.equal(requests,2);assert.deepEqual(fs.readFileSync(result.file),fresh);
});
test('real HTTP disconnect resumes the saved prefix and reproduces the complete bytes',async t=>{
 const dir=fixture(t),body=Buffer.alloc(131072,83);let first=true,activeResponse,range;
 const server=http.createServer((req,res)=>{if(first){first=false;activeResponse=res;res.writeHead(200,headers('"network-v1"',body.length));res.write(body.subarray(0,65536));return;}range=req.headers.range;const offset=Number(range?.match(/bytes=(\d+)-/)?.[1]||0);res.writeHead(offset?206:200,{...headers('"network-v1"',body.length-offset),...(offset?{'content-range':`bytes ${offset}-${body.length-1}/${body.length}`}:{})});res.end(body.subarray(offset));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});const address=`http://127.0.0.1:${server.address().port}/media`;
 await assert.rejects(transfer(dir,fetch,{url:address,progress:n=>{if(n>=65536)activeResponse.destroy();},checkpointBytes:32768}));const stored=JSON.parse(fs.readFileSync(path.join(dir,'视频.resume.json')));
 const result=await transfer(dir,fetch,{url:address});assert.equal(range,`bytes=${stored.offset}-`);assert.deepEqual(fs.readFileSync(result.file),body);
});
