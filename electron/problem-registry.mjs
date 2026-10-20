import {randomUUID} from 'node:crypto';
const fileStates=['all','checking','pending','processing','downloadFailed','repairFailed','complete','blocked'];
const sourceStates=['all','available','unavailable','unknown','unchecked'];
const legacyStates=[...fileStates,'sourceAvailable','sourceUnknown','unavailable'];
const kinds=['all','cover','files','video','image','invalid','metadata','blocked','source','download','checking'];
const safeId=id=>typeof id==='string'&&/^\d{1,32}$/.test(id);
const text=(value,max=256)=>String(value??'').slice(0,max);
const reason=value=>text(String(value??'').replace(/https?:\/\/\S+/gi,'[资源地址]').replace(/[A-Za-z]:[\\/]\S+/g,'[本机路径]'));
const time=value=>Date.parse(value)||0;
const actionable=row=>!['complete','processing','checking','blocked'].includes(row.fileStatus)&&!['unavailable','unknown'].includes(row.sourceStatus)&&row.issues.some(i=>!['source','checking','blocked'].includes(i.kind));
function project(facts){
 const file=facts.file||{status:'complete',issues:[]},source=facts.source||{state:'unchecked'},task=facts.task;
 let fileStatus=file.status||'complete';if(task?.state==='failed')fileStatus='downloadFailed';else if(['running','waiting'].includes(task?.state))fileStatus='processing';
 const issues=(file.issues||[]).slice(0,16).map(i=>({kind:kinds.includes(i.kind)?i.kind:'files',...(i.type&&kinds.includes(i.type)?{type:i.type}:{}),label:text(i.label||'文件问题',80),reason:reason(i.reason)}));
 if(task?.state==='failed'&&!issues.some(i=>i.kind==='download'))issues.push({kind:'download',label:'下载失败',reason:reason(task.message||'上次下载未完成')});
 if(source.state==='unknown'||source.state==='unavailable')issues.push({kind:'source',label:source.state==='unknown'?'暂无法确认原作品状态':'原作品已失效',reason:reason(source.reason||'此前保存的原作品状态')});
 let status=fileStatus;if(source.state==='unavailable')status='unavailable';else if(source.state==='unknown'&&fileStatus!=='processing')status='sourceUnknown';else if(source.state==='available'&&!['complete','processing'].includes(status))status='sourceAvailable';
 const flags=[...new Set([...(file.kinds||[]),...issues.flatMap(i=>[i.kind,i.type].filter(Boolean))])];
 return {id:facts.id,name:text(facts.name||facts.id),author:text(facts.author||''),source:facts.sourceLabel||'保留的本地作品',rank:facts.rank??Number.MAX_SAFE_INTEGER,fileStatus,sourceStatus:source.state||'unchecked',status,issues,kinds:flags,message:reason(task?.message||''),facts,problem:issues.length>0};
}
function options(input={}){
 const o={page:input.page??1,limit:input.limit??20,status:input.status??'all',fileStatus:input.fileStatus??'all',sourceStatus:input.sourceStatus??'all',kind:input.kind??'all'};
 if(!Number.isSafeInteger(o.page)||o.page<1||o.limit!==20||!legacyStates.includes(o.status)||!fileStates.includes(o.fileStatus)||!sourceStates.includes(o.sourceStatus)||!kinds.includes(o.kind))throw Error('检查筛选参数无效');return o;
}
function filter(o){const parts=['problem=1'],args=[];for(const [key,column]of [['status','legacy_status'],['fileStatus','file_status'],['sourceStatus','source_status']])if(o[key]!=='all'){parts.push(column+'=?');args.push(o[key]);}if(o.kind!=='all'){parts.push('EXISTS(SELECT 1 FROM problem_kinds WHERE work_id=problems.id AND kind=?)');args.push(o.kind);}return {sql:parts.join(' AND '),args};}
const publicRow=row=>{const {facts,problem,kinds,rank,...body}=row;return body;};

/** Device-local latest facts; job history is deliberately a different table. */
export class ProblemRegistry{
 constructor(db){this.db=db;this.snapshots=new Map();db.exec(`CREATE TABLE IF NOT EXISTS problems(id TEXT PRIMARY KEY,rank REAL NOT NULL,problem INTEGER NOT NULL,file_status TEXT NOT NULL,source_status TEXT NOT NULL,legacy_status TEXT NOT NULL,repairable INTEGER NOT NULL,body TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS problems_order ON problems(problem,rank,id);CREATE INDEX IF NOT EXISTS problems_files ON problems(problem,file_status,rank,id);CREATE INDEX IF NOT EXISTS problems_source ON problems(problem,source_status,rank,id);
 CREATE TABLE IF NOT EXISTS problem_kinds(work_id TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(work_id,kind));CREATE INDEX IF NOT EXISTS problem_kind_lookup ON problem_kinds(kind,work_id);
 CREATE TABLE IF NOT EXISTS problem_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT OR IGNORE INTO problem_meta VALUES('revision','0');`);}
 get revision(){return Number(this.db.prepare("SELECT value FROM problem_meta WHERE key='revision'").get().value);}
 get(id){const row=this.db.prepare('SELECT body FROM problems WHERE id=?').get(id);return row?JSON.parse(row.body):null;}
 patchMany(patches){
  const read=this.db.prepare('SELECT body FROM problems WHERE id=?'),put=this.db.prepare('INSERT OR REPLACE INTO problems VALUES(?,?,?,?,?,?,?,?)'),clearKinds=this.db.prepare('DELETE FROM problem_kinds WHERE work_id=?'),putKind=this.db.prepare('INSERT OR IGNORE INTO problem_kinds VALUES(?,?)');let changed=false;
  this.db.exec('BEGIN IMMEDIATE');try{
   for(const p of patches){if(!safeId(p.id))throw Error('作品 ID 无效');const previous=read.get(p.id)?.body,old=previous?JSON.parse(previous):null,facts={...old?.facts,id:p.id};
    for(const key of ['name','author','sourceLabel'])if(p[key]!==undefined)facts[key]=text(p[key]);if(Number.isFinite(p.rank))facts.rank=p.rank;
    for(const key of ['file','source','task'])if(p[key]){const incoming={...p[key]},oldFact=facts[key],checkedAt=incoming.checkedAt||p.checkedAt||new Date().toISOString();if(time(oldFact?.checkedAt)>time(checkedAt))continue;if(key==='source'&&!sourceStates.includes(incoming.state))throw Error('原作品状态无效');if(key==='file'&&!fileStates.includes(incoming.status))throw Error('文件状态无效');
     if(key==='file'){incoming.kinds=[...new Set((incoming.issues||[]).flatMap(i=>[i.kind,i.type].filter(v=>kinds.includes(v))))];incoming.issues=(incoming.issues||[]).slice(0,16).map(i=>({kind:i.kind,type:i.type,label:text(i.label,80),reason:reason(i.reason)}));}
     if(key==='source')incoming.reason=reason(incoming.reason);if(key==='task')incoming.message=reason(incoming.message);facts[key]={...incoming,checkedAt};}
    const row=project(facts),body=JSON.stringify(row);if(body===previous)continue;put.run(p.id,row.rank,row.problem?1:0,row.fileStatus,row.sourceStatus,row.status,actionable(row)?1:0,body);clearKinds.run(p.id);if(row.problem)for(const kind of row.kinds)putKind.run(p.id,kind);if(!old||JSON.stringify({...row,facts:undefined})!==JSON.stringify({...old,facts:undefined}))changed=true;
   }
   if(changed)this.db.prepare("UPDATE problem_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 selection(input={}){
  const o=options(input),revision=this.revision,key=JSON.stringify({...o,page:1,revision});
  for(const [token,s]of this.snapshots)if(s.key===key&&s.expires>Date.now())return {token,total:s.total};
  const f=filter(o),total=this.db.prepare('SELECT COUNT(*) n FROM problems WHERE '+f.sql).get(...f.args).n,token=randomUUID();while(this.snapshots.size>=8)this.snapshots.delete(this.snapshots.keys().next().value);this.snapshots.set(token,{key,revision,options:o,total,expires:Date.now()+600000});return {token,total};
 }
 page(input={}){
  const o=options(input),f=filter(o),selection=this.selection(o),pages=Math.max(1,Math.ceil(selection.total/20)),page=Math.min(o.page,pages);
  const rows=this.db.prepare('SELECT body FROM problems WHERE '+f.sql+' ORDER BY rank,id LIMIT 20 OFFSET ?').all(...f.args,(page-1)*20).map(r=>publicRow(JSON.parse(r.body))),counts={fileStatus:{},sourceStatus:{},status:{},kind:{}};
  for(const [key,column]of [['fileStatus','file_status'],['sourceStatus','source_status'],['status','legacy_status']])for(const row of this.db.prepare('SELECT '+column+' value,COUNT(*) n FROM problems WHERE problem=1 GROUP BY '+column).all())counts[key][row.value]=row.n;
  for(const row of this.db.prepare('SELECT kind,COUNT(*) n FROM problem_kinds GROUP BY kind').all())counts.kind[row.kind]=row.n;
  const sums=this.db.prepare("SELECT COALESCE(SUM(repairable),0) repairable,COALESCE(SUM(file_status<>'processing'),0) selectable FROM problems WHERE "+f.sql).get(...f.args);
  return {...selection,revision:this.revision,items:rows,total:selection.total,page,pages,counts,...sums};
 }
 resolveSelection(input,{verify=false}={}){
  const snapshot=this.snapshots.get(input.token);if(!snapshot||snapshot.revision!==this.revision||snapshot.expires<Date.now()||input.all!==true||!Array.isArray(input.exclude)||input.exclude.some(id=>!safeId(id)))throw Error('检查结果已更新，请重新选择');
  const a=filter(snapshot.options),b=filter(options(input)),omit=new Set(input.exclude),rows=this.db.prepare('SELECT id FROM problems WHERE ('+a.sql+') AND ('+b.sql+') AND '+(verify?"file_status<>'processing'":'repairable=1')+' ORDER BY rank,id').iterate(...a.args,...b.args),ids=[];
  for(const row of rows)if(!omit.has(row.id))ids.push(row.id);return ids;
 }
 rows(){return this.db.prepare('SELECT body FROM problems WHERE problem=1 ORDER BY rank,id').all().map(r=>publicRow(JSON.parse(r.body)));}
 validateSelection(input){if(!Array.isArray(input.ids)||input.ids.length>100000||input.ids.some(id=>!safeId(id)))throw Error('作品选择无效');const selected=[...new Set(input.ids)],f=filter(options(input)),query=this.db.prepare("SELECT id,repairable FROM problems WHERE id=? AND file_status<>'processing' AND "+f.sql),ids=[],repairableIds=[];for(const id of selected){const row=query.get(id,...f.args);if(row){ids.push(id);if(row.repairable)repairableIds.push(id);}}return {ids,repairableIds,invalid:selected.length-ids.length};}
}
