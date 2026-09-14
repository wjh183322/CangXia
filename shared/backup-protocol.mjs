import {createHash} from 'node:crypto';
export const PROTOCOL=1;
export const TABLES=new Set(['works','collections','members','local_tags','settings','downloads']);
export const SHARED_SETTINGS=new Set(['account','browserAccountKey','readLimit']);
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';return JSON.stringify(value);}
export const contentHash=value=>sha256(stable(value));
export function validId(id){return typeof id==='string'&&/^\d{1,30}$/.test(id);}
export function validCollection(id){return id==='__all__'||validId(id);}
export function validateEntry(entry){
 if(!entry||!TABLES.has(entry.table)||typeof entry.key!=='string'||entry.key.length>100)throw new Error('同步记录标识无效');
 const {table,key,body}=entry;if(table==='settings'){if(!SHARED_SETTINGS.has(key))throw new Error('禁止同步设备设置或凭据');}
 else if(table==='members'){if(!/^(__all__|\d+):\d+$/.test(key))throw new Error('收藏夹成员标识无效');}
 else if(table==='collections'?!validCollection(key):!validId(key))throw new Error('作品标识无效');
 if(body===null)return;
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('同步记录内容无效');
 if(table==='works'&&(!Array.isArray(body.images)||!body.author||typeof body.name!=='string'||!['video','images'].includes(body.type)))throw new Error('作品内容不完整');
 if(table==='members'&&(!validCollection(body.collectionId)||!validId(body.workId)||!(body.rank===null||Number.isSafeInteger(body.rank))))throw new Error('收藏夹顺序无效');
 if(table==='downloads'){
  if(!Array.isArray(body.assets)||body.assets.length>1000||'path' in body)throw new Error('备份文件清单无效');
  for(const a of body.assets){if(!/^[a-f0-9]{64}$/.test(a.sha256)||!Number.isSafeInteger(a.size)||a.size<=0||typeof a.file!=='string'||!a.file||/[\\/:\x00-\x1f]/.test(a.file)||a.file==='..'||typeof a.key!=='string')throw new Error('备份文件校验信息无效');}
 }
}
