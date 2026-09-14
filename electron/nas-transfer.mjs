import fs from 'node:fs';import fsp from 'node:fs/promises';import {createHash} from 'node:crypto';import {pipeline} from 'node:stream/promises';

export async function copyVerified(from,to,{size,signal,onProgress=()=>{}}={}){
 signal?.throwIfAborted();const total=size||(await fsp.stat(from)).size;let done=0,last=0;
 const report=(phase,force=false)=>{if(force||Date.now()-last>=300){last=Date.now();onProgress({phase,bytes:done,total});}};
 const hash=createHash('sha256'),input=fs.createReadStream(from);input.on('data',bytes=>{hash.update(bytes);done+=bytes.length;report('copy');});report('copy',true);
 const output=fs.createWriteStream(to,{flags:'wx',flush:true});output.once('finish',()=>{report('copy',true);report('flush',true);});
 await pipeline(input,output,{signal});signal?.throwIfAborted();
 const stat=await fsp.stat(to);if(!stat.size||(size&&stat.size!==size))throw new Error('NAS 文件大小校验失败');
 const expected=hash.digest('hex'),verify=createHash('sha256');done=0;report('verify',true);
 for await(const bytes of fs.createReadStream(to,{signal})){signal?.throwIfAborted();verify.update(bytes);done+=bytes.length;report('verify');}
 signal?.throwIfAborted();if(verify.digest('hex')!==expected)throw new Error('NAS 文件内容校验失败');report('verify',true);return expected;
}
