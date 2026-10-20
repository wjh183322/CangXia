import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {randomUUID} from 'node:crypto';
import {BACKUP_SCHEMA} from '../shared/backup-protocol.mjs';
export function openBackupDatabase(dataDir){
 const file=path.join(dataDir,'library.sqlite'),existed=fs.existsSync(file),db=new DatabaseSync(file,{timeout:5000});let migrationBackup=null;
 try{const meta=db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta'").get();const row=meta?db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get():null,version=row?JSON.parse(row.value):1;
  if(!Number.isInteger(version)||version>BACKUP_SCHEMA)throw Error('备份库版本高于当前服务，不能降级打开；请使用匹配服务或恢复升级前副本');
  if(existed&&meta&&version<BACKUP_SCHEMA){migrationBackup=path.join(dataDir,`library.pre-schema-${BACKUP_SCHEMA}-${Date.now()}-${randomUUID().slice(0,8)}.sqlite`);db.prepare('VACUUM INTO ?').run(migrationBackup);const check=new DatabaseSync(migrationBackup,{readOnly:true});try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('升级前副本校验失败');}finally{check.close();}}
  db.exec('BEGIN IMMEDIATE');try{db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
   db.exec(`CREATE TABLE IF NOT EXISTS scope_state(work_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,generation INTEGER NOT NULL,deleted INTEGER NOT NULL,revision INTEGER NOT NULL,operation_id TEXT NOT NULL,device_id TEXT NOT NULL,device_name TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(work_id,kind,source_id));
   CREATE UNIQUE INDEX IF NOT EXISTS scope_revision ON scope_state(revision);
   CREATE TABLE IF NOT EXISTS scope_receipts(operation_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS restore_grants(grant_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,command TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS scope_receipts_time ON scope_receipts(created_at);CREATE INDEX IF NOT EXISTS restore_grants_expiry ON restore_grants(expires_at);`);
   const fields=db.prepare('PRAGMA table_info(scope_state)').all().map(r=>r.name);if(!['work_id','kind','source_id','generation','deleted','revision','operation_id','device_id','device_name','at'].every(k=>fields.includes(k)))throw Error('删除范围 schema 迁移失败');
   if(meta&&version<4){const records=db.prepare("SELECT 1 FROM sqlite_master WHERE name='records'").get();if(records){let revision=db.prepare('SELECT COALESCE(MAX(revision),0) n FROM scope_state').get().n;const mark=(work,kind,source)=>{if(!/^\d{1,30}$/.test(work))throw Error('旧隐藏记录标识无效');const old=db.prepare('SELECT deleted FROM scope_state WHERE work_id=? AND kind=? AND source_id=?').get(work,kind,source);if(old)return !!old.deleted;db.prepare("INSERT INTO scope_state VALUES(?,?,?,1,1,?,?, 'legacy','旧版本状态（来源未知）','')").run(work,kind,source,++revision,randomUUID());return true;};
    for(const row of db.prepare("SELECT id FROM records WHERE kind='downloads' AND json_extract(body,'$.backupDeleted')=1").all())mark(row.id,'files','');
    const changes=new Map();for(const row of db.prepare("SELECT id,body FROM records WHERE kind='works' AND json_extract(body,'$.readHidden')=1").all()){if(mark(row.id,'account','__all__'))for(const member of db.prepare("SELECT id FROM records WHERE kind='members' AND json_extract(body,'$.workId')=?").all(row.id))changes.set('members:'+member.id,{kind:'members',id:member.id,body:null});const work=JSON.parse(row.body);work.readHidden=false;changes.set('works:'+row.id,{kind:'works',id:row.id,body:JSON.stringify(work)});}
    for(const row of db.prepare("SELECT id,body FROM records WHERE kind='author_members' AND json_extract(body,'$.hidden')=1").all()){const b=JSON.parse(row.body);if(typeof b.authorId!=='string'||!/^MS4wLjAB[A-Za-z0-9_-]{8,240}$/.test(b.authorId))throw Error('旧作者隐藏范围无效');if(mark(b.workId,'author',b.authorId))changes.set('author_members:'+row.id,{kind:'author_members',id:row.id,body:null});else changes.set('author_members:'+row.id,{kind:'author_members',id:row.id,body:JSON.stringify({...b,hidden:false})});}
    if(changes.size){const row=db.prepare("SELECT value FROM meta WHERE key='revision'").get(),dataRevision=(row?JSON.parse(row.value):0)+1;for(const change of changes.values())db.prepare('UPDATE records SET body=?,revision=? WHERE kind=? AND id=?').run(change.body,dataRevision,change.kind,change.id);db.prepare("INSERT OR REPLACE INTO meta VALUES('revision',?)").run(JSON.stringify(dataRevision));}
   }}
   db.prepare("INSERT OR REPLACE INTO meta VALUES('schemaVersion',?)").run(JSON.stringify(BACKUP_SCHEMA));
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw Object.assign(Error('删除范围 schema 迁移失败：'+error.message),{cause:error});}
  return {db,migrationBackup};
 }catch(e){db.close();throw e;}
}
