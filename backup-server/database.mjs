import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {randomUUID} from 'node:crypto';
import {PROTOCOL} from '../shared/backup-protocol.mjs';
export function openBackupDatabase(dataDir){
 const file=path.join(dataDir,'library.sqlite'),existed=fs.existsSync(file),db=new DatabaseSync(file,{timeout:5000});let migrationBackup=null;
 try{const meta=db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta'").get();const row=meta?db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get():null,version=row?JSON.parse(row.value):1;
  if(!Number.isInteger(version)||version>PROTOCOL)throw Error('备份库版本高于当前服务，不能降级打开；请使用匹配服务或恢复升级前副本');
  if(existed&&meta&&version<PROTOCOL){migrationBackup=path.join(dataDir,`library.pre-protocol-${PROTOCOL}-${Date.now()}-${randomUUID().slice(0,8)}.sqlite`);db.prepare('VACUUM INTO ?').run(migrationBackup);const check=new DatabaseSync(migrationBackup,{readOnly:true});try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('升级前副本校验失败');}finally{check.close();}}
  return {db,migrationBackup};
 }catch(e){db.close();throw e;}
}
