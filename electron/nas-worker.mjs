import {parentPort} from 'node:worker_threads';
import fs from 'node:fs/promises';import syncFs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';import {randomUUID,createHash} from 'node:crypto';import {pipeline} from 'node:stream/promises';
import {child,digest,headFromLog} from './nas-format.mjs';
import {findDeletedDownloads} from './deleted-downloads.mjs';
let root,meta,manifest,broker,writeable=false,revision=0;const replies=new Map();
const post=value=>parentPort.postMessage(value);
async function safe(file,base=root){
  const relative=path.relative(base,file);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('路径超出媒体库');
  let p=file;while(true){try{if((await fs.lstat(p)).isSymbolicLink())throw new Error('NAS 路径不允许符号链接');}catch(e){if(e.code!=='ENOENT')throw e;}if(p===base)break;p=path.dirname(p);}
}
async function readLatest(){
  await safe(meta);const log=await fs.readFile(path.join(meta,'head.log'));const head=headFromLog(log);
  if(!head)return {head:null,bytes:null};
  const file=child(path.join(meta,'versions'),head.file);await safe(file);const bytes=await fs.readFile(file);if(digest(bytes)!==head.sha)throw new Error('NAS 最新版本校验失败，未加载损坏记录');
  return {head,bytes};
}
function callBroker(action,data={}){return new Promise((resolve,reject)=>{
  if(!writeable||!broker)return reject(new Error('NAS 当前不可写'));
  const id=randomUUID();const timer=setTimeout(()=>{replies.delete(id);writeable=false;reject(new Error('NAS 写入确认超时，已停止写入'));post({event:'lost',message:'NAS 写入确认超时'});broker?.kill();},action==='commit'?300000:20000);
  replies.set(id,{resolve,reject,timer});broker.stdin.write(JSON.stringify({id,action,...data})+'\n');
});}
async function closeBroker(){writeable=false;const previous=broker;broker=null;if(previous&&previous.exitCode===null){await new Promise(resolve=>{const timer=setTimeout(()=>{previous.kill();resolve();},3000);previous.once('exit',()=>{clearTimeout(timer);resolve();});previous.stdin.end();});}for(const p of replies.values()){clearTimeout(p.timer);p.reject(new Error('NAS 连接已关闭'));}replies.clear();}
async function acquire(device){
  if(process.platform!=='win32')throw new Error('NAS 写入锁当前只支持 Windows');
  const script=await fs.readFile(new URL('./nas-lock.ps1',import.meta.url),'utf8');
  return new Promise((resolve,reject)=>{
    let done=false,text='';const timeout=setTimeout(()=>{if(!done){done=true;broker?.kill();reject(new Error('NAS 写入锁连接超时'));}},15000);
    broker=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    broker.stdin.write(JSON.stringify({path:path.join(meta,'head.log'),device,token:randomUUID()})+'\n');
    broker.stderr.resume();
    broker.stdout.on('data',chunk=>{text+=chunk.toString('utf8');let i;while((i=text.indexOf('\n'))>=0){const line=text.slice(0,i).trim();text=text.slice(i+1);let r;try{r=JSON.parse(line);}catch{continue;}
      if(r.event==='ready'||r.event==='busy'){writeable=r.event==='ready';revision=r.revision||0;if(!done){done=true;clearTimeout(timeout);resolve(writeable);}}
      if(r.id&&replies.has(r.id)){const p=replies.get(r.id);replies.delete(r.id);clearTimeout(p.timer);p.resolve(r);}
      if(r.event==='lost'){writeable=false;post(r);for(const p of replies.values()){clearTimeout(p.timer);p.reject(new Error(r.message));}replies.clear();}
      if(r.event==='heartbeat')post(r);
    }});
    broker.on('error',e=>{clearTimeout(timeout);if(!done){done=true;reject(e);}});
    broker.on('exit',()=>{const was=writeable;writeable=false;if(was)post({event:'lost',message:'NAS 写入锁已断开'});for(const p of replies.values()){clearTimeout(p.timer);p.reject(new Error('NAS 写入锁已关闭'));}replies.clear();if(!done){done=true;clearTimeout(timeout);reject(new Error('无法取得 NAS 写入锁'));}});
  });
}
async function copyChecked(from,to,size){
  await safe(to);await fs.mkdir(path.dirname(to),{recursive:true});const hash=createHash('sha256');
  const input=syncFs.createReadStream(from);input.on('data',b=>hash.update(b));
  await pipeline(input,syncFs.createWriteStream(to,{flags:'wx',flush:true}));const actual=await fs.stat(to);if(actual.size===0||(size&&actual.size!==size))throw new Error('NAS 文件大小校验失败');
  const sha=hash.digest('hex'),verify=createHash('sha256');for await(const b of syncFs.createReadStream(to))verify.update(b);if(verify.digest('hex')!==sha)throw new Error('NAS 文件内容校验失败');return sha;
}
async function scan(records){
  await fs.stat(root);await safe(root);const results={};
  for(const d of records)for(const a of d.assets||[]){const key=d.id+':'+a.key;try{const file=child(root,d.relative+'/'+a.file);await safe(file);const s=await fs.stat(file);results[key]={exists:s.isFile()&&s.size>0&&(!a.size||a.size===s.size)};}catch(e){if(e.code==='ENOENT')results[key]={exists:false};else results[key]={error:e.message};}}
  return results;
}
const actions={
  async connect(args){
    await closeBroker();root=path.resolve(args.root);await fs.stat(root);await safe(root);meta=path.join(root,'.cangxia');await safe(meta);
    try{manifest=JSON.parse(await fs.readFile(path.join(meta,'library.json'),'utf8'));}catch(e){if(!args.create||e.code!=='ENOENT')throw new Error('此目录没有可打开的 NAS 媒体库');
      await fs.mkdir(path.join(meta,'versions'),{recursive:true});manifest={schema:1,id:randomUUID(),initializer:args.deviceId};await fs.writeFile(path.join(meta,'library.json'),JSON.stringify(manifest),{flag:'wx'});
    }
    if(manifest.schema!==1||!/^[a-f0-9-]+$/.test(manifest.id))throw new Error('NAS 媒体库格式不支持');
    const writable=await acquire(args.device);const latest=await readLatest();revision=latest.head?.revision||0;
    if(!latest.head&&(!args.create||manifest.initializer!==args.deviceId))throw new Error('NAS 媒体库尚未完成初始化，请回到创建它的电脑继续迁移');
    if(args.create&&latest.head)throw new Error('此目录已有 NAS 媒体库，请使用“打开已有 NAS 库”，不会合并覆盖');
    return {manifest,writable,...latest};
  },
  async refresh(){return {...await readLatest(),writable:writeable};},
  async commit({bytes}){await callBroker('ping');const content=Buffer.from(bytes),file=randomUUID()+'.sqlite',sha=digest(content);await fs.writeFile(path.join(meta,'versions',file),content,{flag:'wx',flush:true});const result=await callBroker('commit',{file,sha,expected:revision});revision=result.head.revision;return result.head;},
  scan:({records})=>scan(records),
  async findDeleted({records}){return findDeletedDownloads(records.map(d=>({...d,path:child(root,d.relative)})),{probe:async()=>{await callBroker('ping');const current=JSON.parse(await fs.readFile(path.join(meta,'library.json'),'utf8'));if(current.id!==manifest.id)throw new Error('NAS 媒体库已变化，未清理记录');},validate:dir=>safe(dir)});},
  async copyOut({source,destination,size}){const file=child(root,source);await safe(file);const stat=await fs.stat(file);if(stat.size!==size)throw new Error('NAS 原文件已变化，请重新检查');await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(file,destination);return true;},
  async publishFiles({relative,assets}){
    await callBroker('ping');const target=child(root,relative);await safe(target);const output=[];
    for(const a of assets){await callBroker('ping');const extension=path.extname(a.file);const name=path.basename(a.file,extension).replace(/-[a-f0-9]{32}$/,'')+'-'+randomUUID().replaceAll('-','')+extension;const destination=child(root,relative+'/'+name);const sha=await copyChecked(a.inputPath,destination,a.size);output.push({...a,inputPath:undefined,file:name,sha256:sha});}
    return output;
  },
  async writeInfo({relative,text}){await callBroker('ping');const name='作品信息-'+randomUUID().replaceAll('-','')+'.json',file=child(root,relative+'/'+name);await safe(file);await fs.mkdir(path.dirname(file),{recursive:true});const bytes=Buffer.from(text);await fs.writeFile(file,bytes,{flag:'wx'});return {key:'metadata',kind:'metadata',file:name,size:bytes.length,sha256:digest(bytes)};},
  async archive({files,records}){await callBroker('ping');const batch=randomUUID(),dir=child(root,'.cangxia/trash/'+batch);await safe(dir);await fs.mkdir(dir,{recursive:true});if(records)await fs.writeFile(path.join(dir,'deleted.json'),JSON.stringify({batch,time:new Date().toISOString(),records,restored:[]}),{flag:'wx',flush:true});for(const relative of files){await callBroker('ping');const from=child(root,relative),to=child(root,'.cangxia/trash/'+batch+'/'+relative);await safe(from);await safe(to);try{await fs.mkdir(path.dirname(to),{recursive:true});await fs.rename(from,to);}catch(e){if(e.code!=='ENOENT')throw e;}}return batch;},
  async trash(){const dir=path.join(meta,'trash');await safe(dir);let names;try{names=await fs.readdir(dir);}catch(e){if(e.code==='ENOENT')return [];throw e;}const out=[];for(const name of names){if(!/^[a-f0-9-]{36}$/.test(name))continue;try{const file=child(dir,name+'/deleted.json');await safe(file);const entry=JSON.parse(await fs.readFile(file,'utf8'));out.push({...entry,batch:name});}catch(e){if(e.code!=='ENOENT')throw e;}}return out;},
  async restored({batch,id}){await callBroker('ping');if(!/^[a-f0-9-]{36}$/.test(batch))throw new Error('归档标识无效');const file=child(root,'.cangxia/trash/'+batch+'/deleted.json');await safe(file);const entry=JSON.parse(await fs.readFile(file,'utf8'));entry.restored=[...new Set([...(entry.restored||[]),id])];await fs.writeFile(file,JSON.stringify(entry),{flush:true});return true;},
  async prepareDelete({records}){
    await callBroker('ping');const batch=randomUUID(),dir=child(root,'.cangxia/trash/'+batch),saved=[];await safe(dir);await fs.mkdir(dir,{recursive:true});
    for(const d of records){const assets=[];for(const a of d.assets||[]){await callBroker('ping');const from=child(root,d.relative+'/'+a.file),to=child(dir,d.relative+'/'+a.file);await safe(from);try{await copyChecked(from,to,a.size);assets.push(a);}catch(e){if(e.code!=='ENOENT')throw e;}}saved.push({...d,assets,state:assets.length===d.assets.length?d.state:'partial'});}
    await callBroker('ping');await fs.writeFile(path.join(dir,'deleted.json'),JSON.stringify({batch,time:new Date().toISOString(),records:saved,restored:[]}),{flag:'wx',flush:true});return batch;
  },
  async discardFiles({files}){for(const relative of files){await callBroker('ping');const file=child(root,relative);await safe(file);try{await fs.unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}}return true;},
  async disconnect(){await closeBroker();return true;}
};
let chain=Promise.resolve();
parentPort.on('message',({id,action,args})=>{chain=chain.then(async()=>{try{if(!actions[action])throw new Error('NAS 操作无效');post({id,ok:true,data:await actions[action](args||{})});}catch(e){post({id,ok:false,error:e.message});}});});
