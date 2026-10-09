export function initializeRecordJournal(store){
 const db=store.db;db.run(`CREATE TABLE IF NOT EXISTS backup_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,key TEXT NOT NULL,work_id TEXT);
  CREATE INDEX IF NOT EXISTS backup_changes_kind ON backup_changes(kind,seq);`);
 const tables=[['works','works','id','id'],['downloads','local_downloads','id','id'],['backup_downloads','downloads','id','id'],['local_tags','local_tags','id','id'],['collections','collections','id',null],['authors','authors','id',null],['members','members',"collection_id||':'||",'work_id'],['author_members','author_members',"author_id||':'||",'work_id'],['settings','settings','key',null]];
 for(const [table,kind,key,work]of tables)for(const [event,prefix]of [['INSERT','NEW'],['UPDATE','NEW'],['DELETE','OLD']]){
  const expression=key.endsWith('||')?`${prefix}.${key.slice(0,key.indexOf('||'))}||':'||${prefix}.work_id`:`${prefix}.${key}`;
  const when=table==='settings'?` WHEN ${event==='UPDATE'?"OLD.key IN ('account','browserAccountKey','readLimit') OR ":''}${prefix}.key IN ('account','browserAccountKey','readLimit')`:'';
  const oldExpression=expression.replaceAll('NEW.','OLD.');
  const old=event==='UPDATE'?`INSERT INTO backup_changes(kind,key,work_id) VALUES('${kind}',${oldExpression},${work?`OLD.${work}`:'NULL'});`:'';
  db.run(`CREATE TRIGGER IF NOT EXISTS journal_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}${when} BEGIN ${old}INSERT INTO backup_changes(kind,key,work_id) VALUES('${kind}',${expression},${work?`${prefix}.${work}`:'NULL'}); END;`);
 }
}
