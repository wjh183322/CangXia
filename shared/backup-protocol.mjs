import {createHash} from 'node:crypto';
export const PROTOCOL=2;
export const TABLES=new Set(['works','collections','members','authors','author_members','local_tags','settings','downloads']);
export const SHARED_SETTINGS=new Set(['account','browserAccountKey','readLimit']);
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';return JSON.stringify(value);}
export const contentHash=value=>sha256(stable(value));
export function validId(id){return typeof id==='string'&&/^\d{1,30}$/.test(id);}
export function validCollection(id){return id==='__all__'||validId(id);}
export function validAuthor(id){return typeof id==='string'&&/^MS4wLjAB[A-Za-z0-9_-]{8,240}$/.test(id);}
const segment=value=>typeof value==='string'&&value.length>0&&value.length<=150&&!/[\\/:\x00-\x1f<>"|?*]/.test(value)&&!/[. ]$/.test(value)&&value!=='.'&&value!=='..'&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
export function validHome(home){return !!home&&!Array.isArray(home)&&Object.keys(home).every(k=>['kind','id','folder','workFolder'].includes(k))&&['collection','author'].includes(home.kind)&&segment(home.workFolder)&&(home.kind==='author'?validAuthor(home.id)&&typeof home.folder==='string'&&home.folder.startsWith('作者作品/')&&segment(home.folder.slice(5)):validCollection(home.id)&&segment(home.folder));}
export function validSource(id){return validCollection(id)||(typeof id==='string'&&id.startsWith('author:')&&validAuthor(id.slice(7)));}
export function authorPublic(a){const fields=['id','uid','name','uniqueId','avatar','url','folder','reportedCount','updatedAt','archived'];const body={};for(const key of fields)if(a[key]!==undefined)body[key]=a[key];if(a.run)body.readSummary={count:a.run.count||0,pages:a.run.pages||0,complete:a.run.status==='complete',time:a.updatedAt};else if(a.readSummary)body.readSummary=a.readSummary;return body;}
export function commitBatches(changes,{maxBytes=8*1024*1024,maxEntries=1000}={}){const priority={authors:0,works:1,collections:2,settings:3,members:4,author_members:5,local_tags:6,downloads:7};const ordered=[...changes].sort((a,b)=>(a.body===null?10:priority[a.table])-(b.body===null?10:priority[b.table]));const batches=[];let batch=[],bytes=1024;for(const e of ordered){const size=Buffer.byteLength(JSON.stringify(e))+1;if(size+1024>maxBytes)throw Error('单条记录过大，未提交备份');if(batch.length&&(bytes+size>maxBytes||batch.length>=maxEntries)){batches.push(batch);batch=[];bytes=1024;}batch.push(e);bytes+=size;}if(batch.length)batches.push(batch);return batches;}
export function validateEntry(entry){
 if(!entry||!TABLES.has(entry.table)||typeof entry.key!=='string'||entry.key.length>320)throw new Error('同步记录标识无效');
 const {table,key,body}=entry;if(table==='settings'){if(!SHARED_SETTINGS.has(key))throw new Error('禁止同步设备设置或凭据');}
 else if(table==='members'){if(!/^(__all__|\d+):\d+$/.test(key))throw new Error('收藏夹成员标识无效');}
 else if(table==='authors'){if(!validAuthor(key))throw Error('作者标识无效');}
 else if(table==='author_members'){const split=key.lastIndexOf(':');if(!validAuthor(key.slice(0,split))||!validId(key.slice(split+1)))throw Error('作者作品关系标识无效');}
 else if(table==='collections'?!validCollection(key):!validId(key))throw new Error('作品标识无效');
 if(body===null)return;
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('同步记录内容无效');
 if(table==='works'&&(!Array.isArray(body.images)||!body.author||typeof body.name!=='string'||!['video','images'].includes(body.type)))throw new Error('作品内容不完整');
 if(table==='members'&&(!validCollection(body.collectionId)||!validId(body.workId)||!(body.rank===null||Number.isSafeInteger(body.rank))))throw new Error('收藏夹顺序无效');
 if(table==='authors'){
  const allowed=new Set(['id','uid','name','uniqueId','avatar','url','folder','reportedCount','updatedAt','archived','readSummary']);
  if(Object.keys(body).some(k=>!allowed.has(k))||body.id!==key||!validId(body.uid)||typeof body.name!=='string'||body.name.length>120||body.url!=='https://www.douyin.com/user/'+key||!validHome({kind:'author',id:key,folder:body.folder,workFolder:'test'}))throw Error('作者资料无效或包含本机会话');
  if(body.readSummary&&(!Number.isSafeInteger(body.readSummary.count)||body.readSummary.count<0||!Number.isSafeInteger(body.readSummary.pages)||body.readSummary.pages<0||typeof body.readSummary.complete!=='boolean'||Object.keys(body.readSummary).some(k=>!['count','pages','complete','time'].includes(k))))throw Error('作者读取摘要无效');
 }
 if(table==='author_members'&&(!validAuthor(body.authorId)||!validId(body.workId)||key!==body.authorId+':'+body.workId||!Number.isSafeInteger(body.position)||body.position<0||typeof body.hidden!=='boolean'))throw Error('作者作品顺序无效');
 if(table==='downloads'){
  if(body.collectionId!==undefined&&!validSource(body.collectionId))throw Error('下载来源无效');
  if(body.home!==undefined&&(!validHome(body.home)||body.collectionId!==(body.home.kind==='author'?'author:':'')+body.home.id))throw Error('下载目录归属无效');
  if(!Array.isArray(body.assets)||body.assets.length>1000||'path' in body)throw new Error('备份文件清单无效');
  if(new Set(body.assets.map(a=>a.key)).size!==body.assets.length)throw Error('备份文件标识重复');
  if(body.requiredKeys!==undefined&&(!Array.isArray(body.requiredKeys)||!body.requiredKeys.length||body.requiredKeys.length>1000||body.requiredKeys.some(k=>typeof k!=='string'||!/^video$|^cover$|^image-\d+$/.test(k))||new Set(body.requiredKeys).size!==body.requiredKeys.length))throw Error('必需媒体清单无效');
  if(body.state==='complete'&&body.requiredKeys?.some(k=>!body.assets.some(a=>a.key===k)))throw Error('媒体缺失，不能声明完整备份');
  for(const a of body.assets){if(!/^[a-f0-9]{64}$/.test(a.sha256)||!Number.isSafeInteger(a.size)||a.size<=0||typeof a.file!=='string'||!a.file||/[\\/:\x00-\x1f]/.test(a.file)||a.file==='..'||typeof a.key!=='string')throw new Error('备份文件校验信息无效');}
 }
}
