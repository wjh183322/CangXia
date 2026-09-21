import fs from 'node:fs';
import {DatabaseSync,backup} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

// File-backed SQLite: committed pages are durable without serializing the whole DB.
export class SqliteStore {
  static async copyFile(source,destination){const db=new DatabaseSync(source,{readOnly:true,timeout:5000});try{await backup(db,destination);}finally{db.close();}}
  static async open(file){
    const existed=fs.existsSync(file);
    if(existed&&!fs.existsSync(file+'.pre-local-0.2.0')){
      const source=new DatabaseSync(file,{readOnly:true,timeout:5000});
      const temporary=file+'.pre-local-0.2.0.tmp';
      try{if(!source.prepare("SELECT 1 FROM sqlite_master WHERE name='sync_runs'").get()){if(fs.existsSync(temporary))fs.unlinkSync(temporary);await backup(source,temporary);const check=new DatabaseSync(temporary,{readOnly:true});try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('升级前备份校验未通过，未修改原库');}finally{check.close();}fs.renameSync(temporary,file+'.pre-local-0.2.0');}}finally{source.close();}
    }
    return new SqliteStore(file);
  }
  constructor(file){
    this.file=file;
    this.connection=new DatabaseSync(file,{timeout:5000});this.statements=new Map();this.depth=0;
    this.connection.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-16384; PRAGMA wal_autocheckpoint=1000;');
  }
  statement(sql){if(!this.statements.has(sql)){if(this.statements.size>=128)this.statements.delete(this.statements.keys().next().value);this.statements.set(sql,this.connection.prepare(sql));}return this.statements.get(sql);}
  run(sql,args=[]){
    const command=sql.trim().toUpperCase();
    if(command==='BEGIN'||command==='BEGIN IMMEDIATE'){this.connection.exec(this.depth?'SAVEPOINT cx_'+this.depth:'BEGIN IMMEDIATE');this.depth++;return;}
    if(command==='COMMIT'){if(!this.depth)throw new Error('No transaction');this.connection.exec(this.depth>1?'RELEASE SAVEPOINT cx_'+(this.depth-1):'COMMIT');this.depth--;return;}
    if(command==='ROLLBACK'){if(!this.depth)return;if(this.depth>1)this.connection.exec('ROLLBACK TO SAVEPOINT cx_'+(this.depth-1)+'; RELEASE SAVEPOINT cx_'+(this.depth-1));else this.connection.exec('ROLLBACK');this.depth--;return;}
    if(args.length)this.statement(sql).run(...args);else this.connection.exec(sql);
  }
  all(sql,args=[]){return this.statement(sql).all(...args).map(r=>({...r}));}
  iterate(sql,args=[]){return this.statement(sql).iterate(...args);}
  export(){if(this.depth)throw new Error('请等待当前数据库事务完成');const temporary=this.file+'.export-'+randomUUID();try{this.connection.prepare('VACUUM INTO ?').run(temporary);return fs.readFileSync(temporary);}finally{fs.rmSync(temporary,{force:true});}}
  close(){while(this.depth)this.run('ROLLBACK');this.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.statements.clear();this.connection.close();}
}
