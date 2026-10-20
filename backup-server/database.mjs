import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {randomUUID} from 'node:crypto';
import {BACKUP_SCHEMA} from '../shared/backup-protocol.mjs';
export function openBackupDatabase(dataDir){
 const file=path.join(dataDir,'library.sqlite'),existed=fs.existsSync(file),db=new DatabaseSync(file,{timeout:5000});let migrationBackup=null;
 try{const meta=db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta'").get();const row=meta?db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get():null,version=row?JSON.parse(row.value):1;
  if(!Number.isInteger(version)||version>BACKUP_SCHEMA)throw Error('备份库版本高于当前服务，不能降级打开；请使用匹配服务或恢复升级前副本');
  if(existed&&meta&&version<BACKUP_SCHEMA){migrationBackup=path.join(dataDir,`library.pre-schema-${BACKUP_SCHEMA}-${Date.now()}-${randomUUID().slice(0,8)}.sqlite`);db.prepare('VACUUM INTO ?').run(migrationBackup);const check=new DatabaseSync(migrationBackup,{readOnly:true});try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('升级前副本校验失败');}finally{check.close();}}
  db.exec('BEGIN IMMEDIATE');try{
   db.exec(`CREATE TABLE IF NOT EXISTS scope_state(work_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,generation INTEGER NOT NULL,deleted INTEGER NOT NULL,revision INTEGER NOT NULL,operation_id TEXT NOT NULL,device_id TEXT NOT NULL,device_name TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(work_id,kind,source_id));
   CREATE UNIQUE INDEX IF NOT EXISTS scope_revision ON scope_state(revision);
   CREATE TABLE IF NOT EXISTS scope_receipts(operation_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS restore_grants(grant_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,command TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS scope_receipts_time ON scope_receipts(created_at);CREATE INDEX IF NOT EXISTS restore_grants_expiry ON restore_grants(expires_at);`);
   const fields=db.prepare('PRAGMA table_info(scope_state)').all().map(r=>r.name);if(!['work_id','kind','source_id','generation','deleted','revision','operation_id','device_id','device_name','at'].every(k=>fields.includes(k)))throw Error('删除范围 schema 迁移失败');
   if(meta&&version<4){const records=db.prepare("SELECT 1 FROM sqlite_master WHERE name='records'").get();if(records){let revision=db.prepare('SELECT COALESCE(MAX(revision),0) n FROM scope_state').get().n;for(const row of db.prepare("SELECT id FROM records WHERE kind='downloads' AND json_extract(body,'$.backupDeleted')=1").all())db.prepare("INSERT OR IGNORE INTO scope_state VALUES(?,'files','',1,1,?,?, 'legacy','旧版本状态（来源未知）','')").run(row.id,++revision,randomUUID());}}
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw Object.assign(Error('删除范围 schema 迁移失败：'+error.message),{cause:error});}
  return {db,migrationBackup};
 }catch(e){db.close();throw e;}
}
