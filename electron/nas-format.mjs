import path from 'node:path';
import { createHash } from 'node:crypto';
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const deviceKeys=new Set(['sessionConnected','accessHoldUntil','authNeedsRefresh','loggedOut']);
export function child(root,relative){
  if(typeof relative!=='string'||/[\x00-\x1f:]/.test(relative)||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>p==='..'||p==='.'||p===''||/[. ]$/.test(p)))throw new Error('NAS 相对路径无效');
  const full=path.resolve(root,relative),rel=path.relative(path.resolve(root),full);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('路径超出 NAS 媒体库');return full;
}
export function headFromLog(bytes){
  const lines=Buffer.from(bytes).subarray(256).toString('utf8').split('\n');let head=null;
  for(const line of lines.slice(0,-1))try{const r=JSON.parse(line);if(r.kind==='commit'&&Number.isSafeInteger(r.revision)&&/^[a-f0-9-]+\.sqlite$/.test(r.file)&&/^[a-f0-9]{64}$/.test(r.sha))head=r;}catch{}
  return head;
}
export function serializeShared(store){
  const copy=new store.SQL.Database(store.db.export());
  try{
    copy.run('DELETE FROM sync_runs; DELETE FROM sync_items; DELETE FROM sync_pages;');
    for(const key of deviceKeys)copy.run('DELETE FROM settings WHERE key=?',[key]);
    copy.run('DELETE FROM settings WHERE key=?',['root']);
    for(const d of store.all('downloads')){
      const relative=path.relative(store.root,d.path).split(path.sep).join('/');child(store.root,relative);
      copy.run('UPDATE downloads SET body=? WHERE id=?',[JSON.stringify({...d,path:relative}),d.id]);
    }
    copy.run('VACUUM');return Buffer.from(copy.export());
  }finally{copy.close();}
}
