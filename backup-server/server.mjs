import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import http from 'node:http';import https from 'node:https';import {randomUUID,randomBytes,timingSafeEqual,createHash} from 'node:crypto';import {gzipSync,gunzipSync} from 'node:zlib';import {DatabaseSync} from 'node:sqlite';import {pipeline} from 'node:stream/promises';
import {PROTOCOL,validateEntry,contentHash} from '../shared/backup-protocol.mjs';

const MAX_JSON=32*1024*1024,MAX_CHUNK=4*1024*1024;
function error(status,message){return Object.assign(new Error(message),{status});}
async function body(req,max=MAX_JSON){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw error(413,'请求过大');chunks.push(chunk);}return Buffer.concat(chunks);}
async function json(req){let bytes=await body(req);if(req.headers['content-encoding']==='gzip')bytes=gunzipSync(bytes,{maxOutputLength:MAX_JSON});try{return JSON.parse(bytes);}catch{throw error(400,'JSON 请求无效');}}
function send(req,res,status,data){let bytes=Buffer.from(JSON.stringify(data));const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};if(bytes.length>1024&&req.headers['accept-encoding']?.includes('gzip')){bytes=gzipSync(bytes);headers['content-encoding']='gzip';}res.writeHead(status,{...headers,'content-length':bytes.length});res.end(bytes);}
export async function hashFile(file){const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export function createBackupServer({dataDir,token,tls,leaseMs=90000,now=()=>Date.now(),allowInsecureLoopback=false}={}){
 if(!dataDir||typeof token!=='string'||token.length<24)throw new Error('服务数据目录或访问密钥无效');
 if(!tls&&!allowInsecureLoopback)throw new Error('备份服务必须配置 HTTPS');
 fs.mkdirSync(dataDir,{recursive:true});for(const name of ['objects','uploads'])fs.mkdirSync(path.join(dataDir,name),{recursive:true});
 const db=new DatabaseSync(path.join(dataDir,'library.sqlite'));db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT,revision INTEGER NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS objects(sha TEXT PRIMARY KEY,size INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS commits(revision INTEGER PRIMARY KEY,device TEXT NOT NULL,name TEXT NOT NULL,time TEXT NOT NULL,count INTEGER NOT NULL);`);
 const columns=db.prepare('PRAGMA table_info(commits)').all().map(c=>c.name);if(!columns.includes('request'))db.exec('ALTER TABLE commits ADD COLUMN request TEXT; ALTER TABLE commits ADD COLUMN requestHash TEXT;');db.exec('CREATE UNIQUE INDEX IF NOT EXISTS commits_request ON commits(request) WHERE request IS NOT NULL');
 const get=key=>{const r=db.prepare('SELECT value FROM meta WHERE key=?').get(key);return r?JSON.parse(r.value):null;},set=(key,value)=>db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,JSON.stringify(value));
 if(!get('libraryId')){set('libraryId',randomUUID());set('revision',0);}
 let lease=null;const busyUploads=new Set();
 const validLease=req=>{const device=String(req.headers['x-device-id']||''),proof=String(req.headers['x-lease-token']||'');if(!lease||lease.expires<=now()||lease.device!==device||lease.token!==proof)throw error(423,'当前电脑没有有效写入权，请重新检查同步状态');lease.expires=now()+leaseMs;return device;};
 const status=()=>({protocol:PROTOCOL,libraryId:get('libraryId'),revision:get('revision'),lastSync:db.prepare('SELECT revision,device,name,time,count FROM commits ORDER BY revision DESC LIMIT 1').get()||null,writer:lease&&lease.expires>now()?{device:lease.device,name:lease.name,expires:lease.expires}:null});
 const objectPath=sha=>{if(!/^[a-f0-9]{64}$/.test(sha))throw error(400,'文件标识无效');return path.join(dataDir,'objects',sha);};
 const handler=async(req,res)=>{
  try{
   const url=new URL(req.url,'https://localhost'),route=url.pathname;
   if(route==='/healthz'&&req.method==='GET'){send(req,res,200,{ok:true,service:'cangxia-backup',protocol:PROTOCOL});return;}
   const supplied=Buffer.from(String(req.headers.authorization||'').replace(/^Bearer /,'')),expected=Buffer.from(token);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw error(401,'访问密钥不正确');
   if(route==='/v1/status'&&req.method==='GET'){send(req,res,200,status());return;}
   if(route==='/v1/lease'&&req.method==='POST'){
    const input=await json(req);if(!/^[a-f0-9-]{36}$/.test(input.deviceId)||typeof input.name!=='string'||!input.name.trim()||input.name.length>80)throw error(400,'设备信息无效');
    if(lease&&lease.expires>now()&&(lease.device!==input.deviceId||lease.token!==input.leaseToken))throw error(423,`另一台电脑正在使用：${lease.name}`);
    lease={device:input.deviceId,name:input.name,token:lease?.device===input.deviceId&&lease.expires>now()?lease.token:randomBytes(32).toString('hex'),expires:now()+leaseMs};
    db.prepare('INSERT OR REPLACE INTO devices VALUES(?,?)').run(input.deviceId,input.name);send(req,res,200,{...status(),leaseToken:lease.token,leaseMs});return;
   }
   if(route==='/v1/lease'&&req.method==='DELETE'){validLease(req);lease=null;send(req,res,200,{ok:true});return;}
   if(route==='/v1/changes'&&req.method==='GET'){
    const since=Number(url.searchParams.get('since')||0),revision=get('revision');if(!Number.isSafeInteger(since)||since<0||since>revision)throw error(409,'同步基础状态无效');
    const changes=db.prepare('SELECT kind,id,body,revision FROM records WHERE revision>? ORDER BY revision,kind,id').all(since).map(r=>({table:r.kind,key:r.id,body:r.body===null?null:JSON.parse(r.body),revision:r.revision}));
    send(req,res,200,{...status(),changes});return;
   }
   const receipt=route.match(/^\/v1\/commits\/([a-f0-9-]{36})$/);if(receipt&&req.method==='GET'){const entry=db.prepare('SELECT revision,device,name,time,count,request,requestHash FROM commits WHERE request=?').get(receipt[1]);if(!entry||entry.device!==req.headers['x-device-id'])throw error(404,'未找到提交确认');send(req,res,200,entry);return;}
   if(route==='/v1/commit'&&req.method==='POST'){
    const input=await json(req),device=validLease(req),request=input.requestId||randomUUID();if(!/^[a-f0-9-]{36}$/.test(request))throw error(400,'提交标识无效');const requestHash=contentHash({libraryId:input.libraryId,baseRevision:input.baseRevision,changes:input.changes});const previous=db.prepare('SELECT * FROM commits WHERE request=?').get(request);if(previous){if(previous.device!==device||previous.requestHash!==requestHash)throw error(409,'提交标识被用于不同内容');send(req,res,200,{...status(),ackRevision:previous.revision,requestId:request});return;}
    if(input.libraryId!==get('libraryId')||input.baseRevision!==get('revision'))throw error(409,'NAS 已有其他更新，未覆盖任何记录');
    if(!Array.isArray(input.changes)||input.changes.length>100000)throw error(400,'变更数量无效');const seen=new Set();
    for(const entry of input.changes){validateEntry(entry);const key=entry.table+':'+entry.key;if(seen.has(key))throw error(400,'变更重复');seen.add(key);if(entry.table==='downloads'&&entry.body)for(const a of entry.body.assets){const object=db.prepare('SELECT size FROM objects WHERE sha=?').get(a.sha256);if(!object||object.size!==a.size)throw error(409,'媒体尚未上传并校验完成');}}
    if(!input.changes.length){send(req,res,200,status());return;}
    const revision=get('revision')+1,time=new Date(now()).toISOString();db.exec('BEGIN IMMEDIATE');try{
     const update=db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)');for(const e of input.changes)update.run(e.table,e.key,e.body===null?null:JSON.stringify(e.body),revision);
     set('revision',revision);db.prepare('INSERT INTO commits(revision,device,name,time,count,request,requestHash) VALUES(?,?,?,?,?,?,?)').run(revision,device,lease.name,time,input.changes.length,request,requestHash);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}send(req,res,200,{...status(),ackRevision:revision,requestId:request});return;
   }
   const match=route.match(/^\/v1\/(uploads|objects)\/([a-f0-9]{64})$/);
   if(match){const [,kind,sha]=match,file=objectPath(sha),partial=path.join(dataDir,'uploads',sha+'.part');
    if(kind==='uploads'&&req.method==='GET'){validLease(req);const known=db.prepare('SELECT size FROM objects WHERE sha=?').get(sha);let offset=0;try{offset=(await fsp.stat(partial)).size;}catch(e){if(e.code!=='ENOENT')throw e;}send(req,res,200,{complete:!!known,size:known?.size||0,offset:known?known.size:offset});return;}
    if(kind==='uploads'&&req.method==='PUT'){
     validLease(req);if(busyUploads.has(sha))throw error(409,'此文件正在上传');busyUploads.add(sha);
     try{const total=Number(req.headers['upload-length']),offset=Number(req.headers['upload-offset']);if(!Number.isSafeInteger(total)||total<=0||total>100*1024**3||!Number.isSafeInteger(offset)||offset<0)throw error(400,'上传长度无效');
      const known=db.prepare('SELECT size FROM objects WHERE sha=?').get(sha);if(known){if(known.size!==total)throw error(409,'文件长度冲突');send(req,res,200,{complete:true,offset:total,size:total});return;}
      let actual=0;try{actual=(await fsp.stat(partial)).size;}catch(e){if(e.code!=='ENOENT')throw e;}if(offset!==actual)throw error(409,'上传位置已变化，请重新检查进度');
      const chunk=await body(req,MAX_CHUNK);validLease(req);if(!chunk.length||offset+chunk.length>total)throw error(400,'上传分块无效');await fsp.appendFile(partial,chunk,{flush:true});const next=offset+chunk.length;
      if(next===total){if(await hashFile(partial)!==sha){await fsp.unlink(partial);throw error(422,'文件内容校验失败，原有备份未改变');}await fsp.rename(partial,file);db.prepare('INSERT OR REPLACE INTO objects VALUES(?,?)').run(sha,total);}
      send(req,res,200,{complete:next===total,offset:next,size:total});return;
     }finally{busyUploads.delete(sha);}
    }
    if(kind==='objects'&&req.method==='GET'){
     const known=db.prepare('SELECT size FROM objects WHERE sha=?').get(sha);if(!known)throw error(404,'备份文件不存在');const range=req.headers.range;let start=0;if(range){const m=String(range).match(/^bytes=(\d+)-$/);if(!m||(start=Number(m[1]))>=known.size)throw error(416,'下载范围无效');}
     res.writeHead(range?206:200,{'content-type':'application/octet-stream','content-length':known.size-start,'accept-ranges':'bytes','etag':sha,...(range?{'content-range':`bytes ${start}-${known.size-1}/${known.size}`}:{})});await pipeline(fs.createReadStream(file,{start}),res);return;
    }
   }
   throw error(404,'接口不存在');
  }catch(e){if(res.headersSent){res.destroy();return;}send(req,res,e.status||500,{error:e.status?e.message:'备份服务暂时无法处理请求'});}
 };
 const server=tls?https.createServer(tls,handler):http.createServer(handler);server.requestTimeout=120000;server.headersTimeout=15000;
 return {server,db,status,async listen(port=0,host='127.0.0.1'){if(!tls&&!['127.0.0.1','::1'].includes(host))throw new Error('非 HTTPS 只允许本机测试');await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});return server.address();},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();}};
}
