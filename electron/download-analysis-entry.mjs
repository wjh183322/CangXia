import {randomUUID} from 'node:crypto';import {readDirectorySnapshot,directoryKey} from './download-directory-index.mjs';
const port=process.parentPort,post=value=>port?port.postMessage(value):process.send?.(value),acks=new Map();let snapshot=null;
const error=(message,code='ANALYSIS_PROTOCOL')=>Object.assign(Error(message),{code});
function sendPacket(request,sequence,items){const message={id:request.id,session:request.session,sequence,items};if(items.length>200||Buffer.byteLength(JSON.stringify(message))>256*1024)throw error('下载分析单项结果过大，请缩小范围','ANALYSIS_TOO_LARGE');return new Promise((resolve,reject)=>{const key=request.id+':'+sequence,timer=setTimeout(()=>{acks.delete(key);reject(error('下载分析接收超时','ANALYSIS_TIMEOUT'));},30000);acks.set(key,()=>{clearTimeout(timer);acks.delete(key);resolve();});post(message);});}
async function handle(request){
 if(request?.ack){acks.get(request.ack+':'+request.sequence)?.();return;}
 if(!Number.isSafeInteger(request?.id)||typeof request.session!=='string')return;
 try{
  if(request.command==='open'){if(snapshot)throw error('已有下载目录分析正在使用','ANALYSIS_BUSY');if(typeof request.file!=='string'||typeof request.root!=='string'||typeof request.operationId!=='string')throw error('下载分析参数无效');const data=readDirectorySnapshot(request.file);snapshot={...data,id:randomUUID(),session:request.session,operationId:request.operationId};post({id:request.id,session:request.session,done:true,value:{snapshotId:snapshot.id,baseSeq:data.baseSeq,pid:process.pid,context:{root:request.root,libraryId:request.libraryId||null}}});return;}
  if(!snapshot||request.snapshotId!==snapshot.id||request.session!==snapshot.session)throw error('下载目录 snapshot 已变化，请重新准备','ANALYSIS_STALE');
  if(request.command==='release'){snapshot=null;post({id:request.id,session:request.session,done:true});return;}
  if(request.command!=='lookup'||!Array.isArray(request.candidates)||request.candidates.length>200||Buffer.byteLength(JSON.stringify(request))>256*1024)throw error('下载分析请求超出范围');
  const current=snapshot,rows=[];for(const file of request.candidates){if(typeof file!=='string'||file.length>32768)throw error('下载目录候选无效');rows.push({path:file,owners:[...(current.index.get(directoryKey(file))||[])]});}
  let chunk=[],bytes=0,sequence=0;for(const row of rows){const size=Buffer.byteLength(JSON.stringify(row))+1;if(chunk.length&&(chunk.length>=200||bytes+size>250*1024)){await sendPacket(request,++sequence,chunk);chunk=[];bytes=0;}chunk.push(row);bytes+=size;}if(chunk.length)await sendPacket(request,++sequence,chunk);post({id:request.id,session:request.session,done:true});
 }catch(e){post({id:request.id,session:request.session,error:e.message,code:e.code||'ANALYSIS_FAILED'});}
}
if(port)port.on('message',event=>void handle(event.data));else process.on('message',request=>void handle(request));
