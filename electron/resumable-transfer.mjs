import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {requireInside} from './model.mjs';
const strongTag=value=>typeof value==='string'&&/^"[\x21\x23-\x7e]{1,512}"$/.test(value);
const digest=value=>createHash('sha256').update(value).digest('hex');
function ordinary(file){const stat=fs.lstatSync(file,{throwIfNoEntry:false});if(stat&&(!stat.isFile()||stat.isSymbolicLink()))throw new Error('下载临时文件不是普通文件，已停止');}
async function remove(file){ordinary(file);await fs.promises.unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});}
async function hashPrefix(file,bytes,signal){const hash=createHash('sha256');if(bytes)for await(const chunk of fs.createReadStream(file,{start:0,end:bytes-1})){signal?.throwIfAborted();hash.update(chunk);}return hash;}
async function readCheckpoint(dir,name,url,signal){
 const meta=requireInside(dir,path.join(dir,name+'.resume.json'));ordinary(meta);if(!fs.existsSync(meta))return null;
 try{
  if(fs.statSync(meta).size>8192)return null;const value=JSON.parse(await fs.promises.readFile(meta,'utf8'));
  if(value.version!==1||value.urlHash!==digest(url)||!/^[a-f0-9]{64}$/.test(value.responseHash)||!strongTag(value.etag)||!Number.isSafeInteger(value.total)||value.total<=0||!Number.isSafeInteger(value.offset)||value.offset<=0||value.offset>=value.total||!/^[a-f0-9]{64}$/.test(value.prefixHash))return null;
  if(!['.mp4','.jpg','.png','.webp','.avif'].some(ext=>value.part===name+ext+'.part'))return null;
  const partial=requireInside(dir,path.join(dir,value.part));ordinary(partial);if(!fs.existsSync(partial)||fs.statSync(partial).size<value.offset)return null;
  const hash=await hashPrefix(partial,value.offset,signal);if(hash.copy().digest('hex')!==value.prefixHash)return null;
  return {...value,hash,partial};
 }catch(e){if(signal?.aborted)throw e;return null;}
}
export async function transferAsset({dir,target,url,signal,fetchMedia,extension,progress=()=>{},checkpointBytes=2*1024*1024}){
 const meta=requireInside(dir,path.join(dir,target.name+'.resume.json')),metaTemp=meta+'.tmp';ordinary(meta);ordinary(metaTemp);
 let saved=target.name.startsWith('.cangxia-')?null:await readCheckpoint(dir,target.name,url,signal);
 const get=async resume=>{signal?.throwIfAborted();return fetchMedia(url,{headers:{'Accept-Encoding':'identity',...(resume?{Range:`bytes=${resume.offset}-`,'If-Range':resume.etag}:{})},signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])});};
 let response=await get(saved);
 if(saved&&response.status===206){
  const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||'');
  const valid=match&&Number(match[1])===saved.offset&&Number(match[2])===saved.total-1&&Number(match[3])===saved.total&&response.headers.get('etag')===saved.etag&&digest(response.url||url)===saved.responseHash&&(!response.headers.get('content-length')||Number(response.headers.get('content-length'))===saved.total-saved.offset);
  if(!valid){await response.body?.cancel().catch(()=>{});saved=null;response=await get(null);}
 }else if(saved&&response.status===416){await response.body?.cancel().catch(()=>{});saved=null;response=await get(null);}
 else if(response.status===200)saved=null;
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw Object.assign(new Error(`资源请求失败（${response.status}）`),{httpStatus:response.status});}
 if(response.status!==200&&!(saved&&response.status===206)){await response.body?.cancel().catch(()=>{});throw new Error('资源区间响应无效，未拼接文件');}
 if(response.headers.get('content-encoding')&&!/^identity$/i.test(response.headers.get('content-encoding'))){await response.body?.cancel().catch(()=>{});throw new Error('资源编码不适合安全续传，未写入文件');}
 let file,partial;
 try{const ext=extension(response.headers.get('content-type'),target.kind);file=requireInside(dir,path.join(dir,target.name+ext));partial=file+'.part';ordinary(file);ordinary(partial);}catch(e){await response.body?.cancel().catch(()=>{});throw e;}
 if(saved&&saved.partial!==partial){await response.body?.cancel().catch(()=>{});throw new Error('资源文件类型发生变化，未拼接文件');}
 const lengthHeader=response.headers.get('content-length');
 if(lengthHeader!==null&&(!/^\d+$/.test(lengthHeader)||!Number.isSafeInteger(Number(lengthHeader)))){await response.body?.cancel().catch(()=>{});throw new Error('资源长度无效，未标记为完整');}
 const total=saved?.total??(lengthHeader===null?null:Number(lengthHeader)),etag=response.headers.get('etag'),resumable=!target.name.startsWith('.cangxia-')&&Number.isSafeInteger(total)&&total>0&&strongTag(etag);
 if(target.kind==='image'&&total>50000000){await response.body?.cancel().catch(()=>{});throw new Error('图片文件过大，已停止');}
 let hash=saved?.hash||createHash('sha256'),offset=saved?.offset||0,lastSaved=offset,lastTime=Date.now(),handle,reader,finished=false;
 const checkpoint=async()=>{
  if(!resumable||!offset||offset>=total)return;
  await handle.truncate(offset);await handle.sync();
  const body=JSON.stringify({version:1,part:path.basename(partial),urlHash:digest(url),responseHash:digest(response.url||url),etag,total,offset,prefixHash:hash.copy().digest('hex')});
  ordinary(metaTemp);const record=await fs.promises.open(metaTemp,'w');try{await record.writeFile(body);await record.sync();}finally{await record.close();}ordinary(meta);await fs.promises.rename(metaTemp,meta);lastSaved=offset;lastTime=Date.now();
 };
 try{
  handle=await fs.promises.open(partial,saved?'r+':'w');if(saved)await handle.truncate(offset);else{await remove(meta);await remove(metaTemp);}
  reader=response.body?.getReader();if(!reader)throw new Error('资源没有返回文件内容');progress(offset);
  while(true){
   signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;signal?.throwIfAborted();
   if((total!==null&&offset+value.byteLength>total)||(target.kind==='image'&&offset+value.byteLength>50000000))throw new Error('资源长度异常，未标记为完整');
   let used=0;while(used<value.byteLength){const write=await handle.write(value,used,value.byteLength-used,offset+used);if(!write.bytesWritten)throw new Error('文件写入未完成');used+=write.bytesWritten;}
   hash.update(value);offset+=value.byteLength;progress(offset);
   if(offset-lastSaved>=checkpointBytes||Date.now()-lastTime>=2000)await checkpoint();
  }
  signal?.throwIfAborted();if(!offset||(total!==null&&offset!==total))throw new Error('文件未下载完整，已保留可续传进度');
  await handle.sync();await handle.close();handle=null;
  const sha256=hash.copy().digest('hex');if(fs.statSync(partial).size!==offset||(await hashPrefix(partial,offset,signal)).digest('hex')!==sha256)throw new Error('文件校验未通过，未标记为完整');
  signal?.throwIfAborted();ordinary(file);await fs.promises.rename(partial,file);await remove(meta);await remove(metaTemp);finished=true;
  return {file,size:offset,sha256,resumedBytes:saved?.offset||0};
 }catch(e){if(handle)try{await checkpoint();}catch{await remove(meta).catch(()=>{});}throw e;}
 finally{
  await reader?.cancel().catch(()=>{});reader?.releaseLock();await handle?.close().catch(()=>{});
  if(!finished&&!resumable){await remove(partial).catch(()=>{});await remove(meta).catch(()=>{});await remove(metaTemp).catch(()=>{});}
 }
}
