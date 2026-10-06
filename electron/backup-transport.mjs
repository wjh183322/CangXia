import http from 'node:http';import https from 'node:https';import tls from 'node:tls';import fs from 'node:fs';import fsp from 'node:fs/promises';import {createHash} from 'node:crypto';import {gzipSync,gunzipSync} from 'node:zlib';import {pipeline} from 'node:stream/promises';
import {PROTOCOL} from '../shared/backup-protocol.mjs';
import {setTimeout as retryDelay} from 'node:timers/promises';
const transientCodes=new Set(['ECONNRESET','EPIPE','ETIMEDOUT','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ERR_STREAM_PREMATURE_CLOSE','NAS_CONNECT_TIMEOUT','NAS_RESPONSE_TIMEOUT']);
export const transientNASFailure=error=>transientCodes.has(error?.code);
const diagnosticPath=route=>route.replace(/\/[a-f0-9]{64}(?=$|\?)/g,'/:sha');
export function normalizeEndpoint(value){const url=new URL(value);if(url.username||url.password||url.search||url.hash)throw new Error('服务地址格式无效');if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('备份服务请使用 HTTPS 地址');return url.origin;}
export function normalizeFingerprint(value=''){const result=value.replaceAll(':','').replaceAll(' ','').toLowerCase();if(result&&!/^[a-f0-9]{64}$/.test(result))throw new Error('证书指纹应为 SHA256');return result;}
export class BackupTransport{
 constructor({url,token,fingerprint='',deviceId,leaseToken='',onDiagnostic=()=>{}}){this.url=normalizeEndpoint(url);this.token=token;this.deviceId=deviceId;this.leaseToken=leaseToken;this.onDiagnostic=onDiagnostic;const pin=normalizeFingerprint(fingerprint);
  // Retire free sockets before the server's default five-second keep-alive deadline.
  const Agent=new URL(this.url).protocol==='https:'?https.Agent:http.Agent;
  this.agent=new Agent({keepAlive:true,maxSockets:8,maxFreeSockets:2,timeout:4000,scheduling:'lifo'});
  if(pin){this.agent.createConnection=(options,callback)=>{let finished=false;const socket=tls.connect({...options,rejectUnauthorized:false});const timer=setTimeout(()=>socket.destroy(Object.assign(new Error('NAS TLS 握手超时'),{code:'NAS_CONNECT_TIMEOUT'})),15000);const done=(...args)=>{if(!finished){finished=true;clearTimeout(timer);callback(...args);}};socket.once('secureConnect',()=>{const cert=socket.getPeerCertificate();const actual=cert.raw?createHash('sha256').update(cert.raw).digest('hex'):'';if(actual!==pin){socket.destroy();done(Object.assign(new Error('NAS 服务证书与保存的指纹不一致'),{code:'CERT_PIN_MISMATCH'}));}else done(null,socket);});socket.once('error',e=>done(e));};}
 }
 record(event){try{this.onDiagnostic(event);}catch{}}
 async retry(error,route,method,attempt,signal){signal?.throwIfAborted();this.record({event:'nas-request-retry',path:diagnosticPath(route),method,attempt,code:error.code,reusedSocket:!!error.nasRequest?.reusedSocket});await retryDelay(250*2**attempt,undefined,{signal});}
 async request(method,route,{data,bytes,headers={},signal,timeout=60000,attempt=0}={}){
  const url=new URL(route,this.url);if(url.origin!==this.url)throw new Error('请求地址超出备份服务');let payload=bytes;
  if(data!==undefined){payload=Buffer.from(JSON.stringify(data));headers={...headers,'content-type':'application/json'};if(payload.length>1024){payload=gzipSync(payload);headers['content-encoding']='gzip';}}
  const mod=url.protocol==='https:'?https:http;
  return new Promise((resolve,reject)=>{let timer,receivedHeaders=false;const started=Date.now();
   const mark=error=>{error.nasRequest={path:diagnosticPath(route),method,attempt,reusedSocket:!!req.reusedSocket,receivedHeaders,elapsedMs:Date.now()-started};this.record({event:'nas-request-error',...error.nasRequest,code:error.code,reason:error.message});return error;};
   const req=mod.request(url,{method,agent:this.agent,signal,headers:{authorization:'Bearer '+this.token,'x-device-id':this.deviceId,'x-cangxia-protocol':String(PROTOCOL),'x-lease-token':this.leaseToken,'accept-encoding':'gzip',...(payload?{'content-length':payload.length}:{}),...headers}},res=>{receivedHeaders=true;clearTimeout(timer);res.once('error',mark);resolve(res);});
   req.on('error',error=>{clearTimeout(timer);reject(mark(error));});
   timer=setTimeout(()=>req.destroy(Object.assign(new Error('NAS 服务连接超时'),{code:'NAS_CONNECT_TIMEOUT'})),timeout);req.setTimeout(timeout,()=>req.destroy(Object.assign(new Error('NAS 服务响应超时'),{code:'NAS_RESPONSE_TIMEOUT'})));req.end(payload);
  });
 }
 async json(method,route,options={}){
  const safe=method==='GET'||(method==='POST'&&route==='/v1/commit'&&options.data?.requestId)||(method==='POST'&&route==='/v1/lease'&&options.data?.leaseToken);
  for(let attempt=0;;attempt++)try{
   const res=await this.request(method,route,{...options,attempt}),chunks=[];let total=0;for await(const chunk of res){total+=chunk.length;if(total>32*1024*1024){res.destroy();throw new Error('NAS 响应过大');}chunks.push(chunk);}let body=Buffer.concat(chunks);if(res.headers['content-encoding']==='gzip')body=gunzipSync(body,{maxOutputLength:32*1024*1024});let data;try{data=JSON.parse(body);}catch{throw new Error('NAS 服务返回了无效数据');}if(res.statusCode<200||res.statusCode>=300)throw Object.assign(new Error(data.error||'NAS 请求失败'),{status:res.statusCode});return data;
  }catch(error){if(!safe||attempt>=2||!transientNASFailure(error)||options.signal?.aborted)throw error;await this.retry(error,route,method,attempt,options.signal);}
 }
 async upload(file,asset,{signal,onProgress=()=>{}}={}){
  for(let attempt=0;;attempt++)try{return await this.uploadOnce(file,asset,{signal,onProgress});}catch(error){if(attempt>=2||!transientNASFailure(error)||signal?.aborted)throw error;await this.retry(error,'/v1/uploads/'+asset.sha256,'PUT',attempt,signal);}
 }
 async uploadOnce(file,asset,{signal,onProgress=()=>{}}={}){
  let state=await this.json('GET','/v1/uploads/'+asset.sha256,{signal});if(state.complete){if(state.size!==asset.size)throw new Error('NAS 文件长度不一致');onProgress(asset.size,asset.size);return;}
  if(state.offset===asset.size){state=await this.json('PUT','/v1/uploads/'+asset.sha256,{bytes:Buffer.alloc(0),headers:{'upload-offset':String(asset.size),'upload-length':String(asset.size)},signal,timeout:180000});if(!state.complete)throw new Error('NAS 尚未完成文件校验');onProgress(asset.size,asset.size);return;}
  const handle=await fsp.open(file,'r');try{let offset=state.offset;if(!Number.isSafeInteger(offset)||offset<0||offset>asset.size)throw new Error('NAS 暂存文件长度异常');const buffer=Buffer.alloc(512*1024);while(offset<asset.size){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,asset.size-offset),offset);if(!bytesRead)throw new Error('本机文件在同步时发生变化');state=await this.json('PUT','/v1/uploads/'+asset.sha256,{bytes:buffer.subarray(0,bytesRead),headers:{'content-type':'application/octet-stream','upload-offset':String(offset),'upload-length':String(asset.size)},signal,timeout:180000});if(state.offset!==offset+bytesRead)throw new Error('NAS 上传进度与本机不一致');offset=state.offset;onProgress(offset,asset.size);}if(!state.complete)throw new Error('NAS 尚未确认文件完整');}finally{await handle.close();}
 }
 async download(asset,file,{signal,onProgress=()=>{}}={}){
  for(let attempt=0;;attempt++)try{return await this.downloadOnce(asset,file,{signal,onProgress,attempt});}catch(error){if(attempt>=2||!transientNASFailure(error)||signal?.aborted)throw error;await this.retry(error,'/v1/objects/'+asset.sha256,'GET',attempt,signal);}
 }
 async downloadOnce(asset,file,{signal,onProgress=()=>{},attempt=0}={}){
  const partial=file+'.backup-part';let start=0;try{start=(await fsp.stat(partial)).size;}catch(e){if(e.code!=='ENOENT')throw e;}if(start>asset.size){await fsp.unlink(partial);start=0;}
  if(start<asset.size){const res=await this.request('GET','/v1/objects/'+asset.sha256,{headers:start?{range:`bytes=${start}-`}:{},signal,timeout:180000,attempt});if(res.statusCode!==(start?206:200)){res.destroy();throw new Error('无法从 NAS 获取备份文件');}let received=start;res.on('data',chunk=>{received+=chunk.length;onProgress(received,asset.size);});await pipeline(res,fs.createWriteStream(partial,{flags:start?'a':'w'}),{signal});}
  signal?.throwIfAborted();const hash=createHash('sha256');let size=0;for await(const chunk of fs.createReadStream(partial,{signal})){size+=chunk.length;hash.update(chunk);}if(size!==asset.size||hash.digest('hex')!==asset.sha256){await fsp.unlink(partial).catch(()=>{});throw new Error('下载的备份文件校验失败');}await fsp.rename(partial,file);
 }
 close(){this.agent?.destroy();}
}
