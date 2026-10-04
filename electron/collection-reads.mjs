import {randomUUID} from 'node:crypto';
import {TOTAL} from './model.mjs';

const terminal=new Set(['matched','end','end-stale','review']);
const messageOf={matched:'新增检查完成；历史收藏未全量核对',end:'当前可访问列表已到末页','end-stale':'已读到末页；期间有其他读取更新，已保留最新顺序，请从头核对',limit:'达到本段检查上限，可继续检查',review:'本次返回数量明显减少，旧记录保留，请核对后确认',paused:'已停止，读取内容和进度保留',error:'读取未完整结束'};
export class CollectionReads{
  constructor(store){this.store=store;this.baselines=new Map();}
  init(){this.store.db.run(`CREATE TABLE IF NOT EXISTS collection_read_runs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS collection_read_baselines(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS collection_read_items(run_key TEXT,work_id TEXT,position INTEGER,PRIMARY KEY(run_key,work_id));
    CREATE INDEX IF NOT EXISTS collection_read_items_order ON collection_read_items(run_key,position);
    CREATE TABLE IF NOT EXISTS collection_read_refs(run_key TEXT,kind TEXT,work_id TEXT,position INTEGER,PRIMARY KEY(run_key,kind,work_id));
    CREATE TABLE IF NOT EXISTS collection_read_pages(run_key TEXT,cursor TEXT,PRIMARY KEY(run_key,cursor));`);}
  key(scope,mode){if((scope!==TOTAL&&!/^\d{1,32}$/.test(scope))||!['quick','full'].includes(mode))throw Error('收藏读取范围无效');return mode+':'+scope;}
  account(){return this.store.getSetting('browserAccountKey')||null;}
  revision(){return Number(this.store.getSetting('collectionMembershipRevision')||0);}
  get(scope,mode){return this.store.get('collection_read_runs',this.key(scope,mode));}
  write(run){const {ids,reference,anchors,...body}=run;body.updatedAt=new Date().toISOString();this.store.put('collection_read_runs',run.key,body);this.store.save();}
  baseline(scope){if(!this.baselines.has(scope))this.baselines.set(scope,this.store.get('collection_read_baselines',scope));const b=this.baselines.get(scope);return b?.accountKey===this.account()?b:null;}
  setBaseline(scope,b){this.store.put('collection_read_baselines',scope,b);this.baselines.set(scope,b);}
  membership(scope){return this.store.rows('SELECT work_id,rank FROM members WHERE collection_id=? ORDER BY rank IS NULL,rank',[scope]);}
  ids(run){return this.store.rows('SELECT work_id FROM collection_read_items WHERE run_key=? ORDER BY position',[run.key]).map(r=>r.work_id);}
  runtime(run){return {...run,ids:new Set(this.ids(run)),reference:new Map(this.store.rows("SELECT work_id,position FROM collection_read_refs WHERE run_key=? AND kind='member'",[run.key]).map(r=>[r.work_id,r.position])),anchors:new Map(this.store.rows("SELECT work_id,position FROM collection_read_refs WHERE run_key=? AND kind='anchor'",[run.key]).map(r=>[r.work_id,r.position]))};}
  managed(scope){return !!(this.get(scope,'quick')||this.get(scope,'full'));}
  importLegacy(scope){
    if(this.store.get('collection_read_baselines',scope)||this.managed(scope))return;
    const run=this.store.sync.get(scope),c=this.store.collection(scope),rows=this.membership(scope);
    if(!this.account()||!run||run.status!=='complete'||run.resumed||run.accountKey!==this.account()||c?.complete!==true||rows.some(r=>r.rank===null)||rows.length!==run.count||c.loadedCount!==run.count)return;
    const ids=rows.map(r=>r.work_id);this.setBaseline(scope,{accountKey:this.account(),fullIds:ids,fullAt:run.updatedAt||c.syncedAt,anchorIds:ids,anchorAt:c.syncedAt,imported:true});
  }
  recover(){
    for(const run of this.store.all('collection_read_runs'))if(run.status==='running')this.finish(this.runtime(run),'paused','上次读取未正常结束，已有内容保留');
    for(const c of this.store.all('collections'))this.importLegacy(c.id);
  }
  rebind(previous,next){
    for(const table of ['collection_read_runs','collection_read_baselines'])for(const r of this.store.rows(`SELECT id,body FROM ${table}`)){const body=JSON.parse(r.body);if(body.accountKey===previous)this.store.put(table,r.id,{...body,accountKey:next});}
    this.baselines.clear();
  }
  start(scope,mode,{resume=false}={}){
    const key=this.key(scope,mode),c=this.store.collection(scope);if(!c?.added||c.remoteMissing)throw Error('请先添加有效的收藏夹');
    this.importLegacy(scope);
    let previous=this.get(scope,mode);
    if(resume&&!previous&&mode==='full')previous=this.adoptLegacy(scope);
    if(resume){if(!previous||terminal.has(previous.outcome)||previous.nextCursor===null||previous.accountKey!==this.account())throw Error('没有可继续的对应读取进度，请从头开始');const run=this.runtime(previous);if(run.publishedRevision!==this.revision())run.conflicted=true;run.status='running';run.outcome=null;run.reason='';run.resumed=true;this.write(run);return run;}
    const members=this.membership(scope),base=this.baseline(scope);
    this.store.db.run('BEGIN');try{
      for(const table of ['collection_read_items','collection_read_refs','collection_read_pages'])this.store.db.run(`DELETE FROM ${table} WHERE run_key=?`,[key]);
      members.forEach((r,i)=>this.store.db.run('INSERT INTO collection_read_refs VALUES(?,?,?,?)',[key,'member',r.work_id,i]));
      (base?.anchorIds||[]).forEach((id,i)=>this.store.db.run('INSERT INTO collection_read_refs VALUES(?,?,?,?)',[key,'anchor',id,i]));
      const run={key,scope,mode,token:randomUUID(),accountKey:this.account(),status:'running',nextCursor:'0',count:0,rawCount:0,pages:0,added:0,restored:0,oldCount:members.length,publishedRevision:this.revision(),conflicted:false,resumed:false,baselineKnown:!!base,streak:0,streakPages:0,lastAnchor:null,lastStreakCursor:null,repeatedPages:0,outcome:null,startedAt:new Date().toISOString()};
      this.write(run);this.store.db.run('COMMIT');return this.runtime(run);
    }catch(e){this.store.db.run('ROLLBACK');throw e;}
  }
  adoptLegacy(scope){
    const old=this.store.sync.get(scope);if(!old||old.status==='complete'||old.nextCursor===null||old.accountKey!==this.account())return null;
    const run=this.start(scope,'full');this.store.db.run('BEGIN');try{
      const ids=this.store.sync.ids(scope);ids.forEach((id,i)=>this.store.db.run('INSERT INTO collection_read_items VALUES(?,?,?)',[run.key,id,i]));
      for(const p of this.store.rows('SELECT cursor FROM sync_pages WHERE collection_id=?',[scope]))this.store.db.run('INSERT INTO collection_read_pages VALUES(?,?)',[run.key,p.cursor]);
      Object.assign(run,{count:ids.length,rawCount:ids.length,pages:old.pages||0,nextCursor:old.nextCursor,status:'paused',outcome:'paused',legacy:true});this.write(run);this.store.db.run('COMMIT');return this.get(scope,'full');
    }catch(e){this.store.db.run('ROLLBACK');throw e;}
  }
  seen(run,cursor){return this.store.rows('SELECT 1 FROM collection_read_pages WHERE run_key=? AND cursor=?',[run.key,cursor]).length>0;}
  apply(run,result,{signal}={}){
    signal?.throwIfAborted();if(run.accountKey!==this.account())throw Error('账号信息发生变化，本页未写入');
    if(!Array.isArray(result.items)||result.items.length>1000)throw Error('本页作品数量或结构异常，已保留记录');
    if(!result.items.length&&!result.complete)throw Error('本页为空，但平台没有明确结束，已保留原翻页位置');
    const cursor=run.nextCursor;if(this.seen(run,cursor))throw Error('平台返回重复翻页位置，已保留进度，请从头核对');
    const {ids,reference,anchors,...before}=run;const inserted=[];let unique=0;
    this.store.db.run('BEGIN');try{
      for(const raw of result.items){
        signal?.throwIfAborted();const id=String(raw.aweme_id||raw.awemeId||'');if(!/^\d{1,32}$/.test(id))throw Error('作品标识无效，本页未写入');
        const old=this.store.work(id),duplicate=ids.has(id);this.store.upsertWork(raw);if(old?.readHidden)this.store.put('works',id,{...this.store.work(id),readHidden:false});
        if(!duplicate){this.store.db.run('INSERT INTO collection_read_items VALUES(?,?,?)',[run.key,id,run.count++]);ids.add(id);inserted.push(id);unique++;if(!reference.has(id))run.added++;else if(old?.readHidden)run.restored++;}
        const position=anchors.get(id);
        if(duplicate||position===undefined){run.streak=0;run.streakPages=0;run.lastAnchor=null;run.lastStreakCursor=null;}
        else{if(run.lastAnchor!==null&&position===run.lastAnchor+1){run.streak++;if(run.lastStreakCursor!==cursor)run.streakPages++;}else{run.streak=1;run.streakPages=1;}run.lastAnchor=position;run.lastStreakCursor=cursor;}
      }
      run.pages++;run.rawCount+=result.items.length;run.repeatedPages=unique?0:run.repeatedPages+1;
      this.store.db.run('INSERT INTO collection_read_pages VALUES(?,?)',[run.key,cursor]);
      const next=result.next;run.nextCursor=typeof next==='string'&&/^\d{1,32}$/.test(next)&&!result.unknown?next:null;
      let outcome=null;
      if(result.complete){run.nextCursor=null;const removed=run.oldCount-run.count;const suspicious=(run.oldCount>0&&run.count===0)||(run.oldCount>=20&&run.count<run.oldCount/2)||removed>=1000;outcome=suspicious?'review':run.conflicted?'end-stale':'end';}
      else if(result.unknown||run.nextCursor===null)throw Object.assign(Error('平台未提供明确分页信息，本页未写入，已有记录保留'),{incomplete:true});
      else if(run.nextCursor===cursor||this.seen(run,run.nextCursor))throw Error('平台返回重复翻页位置，本页未写入，请从头核对');
      else if(run.repeatedPages>=3)throw Error('连续页面没有新的有效作品，已停止重复请求');
      else if(run.mode==='quick'&&run.baselineKnown&&run.streak>=60&&run.streakPages>=2)outcome='matched';
      if(outcome)this.finish(run,outcome);else this.write(run);
      this.store.db.run('COMMIT');return {outcome,unique};
    }catch(e){this.store.db.run('ROLLBACK');for(const id of inserted)ids.delete(id);Object.assign(run,before,{ids,reference,anchors});this.store.invalidateViews();this.baselines.delete(run.scope);throw e;}
  }
  finish(run,outcome,reason=''){
    if(run.accountKey!==this.account())throw Error('账号信息发生变化，未覆盖收藏关系');
    if(run.status!=='running'&&terminal.has(run.outcome))return;
    const before={...run};this.store.db.run('BEGIN');try{
      if(run.publishedRevision!==this.revision())run.conflicted=true;
      if(outcome==='end'&&run.conflicted)outcome='end-stale';
      let ids=this.ids(run);const full=outcome==='end';
      if(run.conflicted){const current=this.membership(run.scope).map(r=>r.work_id),known=new Set(current);ids=[...current,...ids.filter(id=>!known.has(id)&&!run.reference.has(id)&&(run.scope===TOTAL||!this.store.rows('SELECT 1 FROM members WHERE work_id=? AND collection_id<>? AND collection_id<>?',[id,TOTAL,run.scope]).length))];}
      this.store.ingestMembers(run.scope,ids,full,{unhide:false,preserveOther:run.conflicted});
      run.publishedRevision=this.revision();run.status=outcome==='review'?'review':terminal.has(outcome)?'complete':'paused';run.outcome=outcome;run.reason=reason||messageOf[outcome];
      if(full){const ordered=this.ids(run);this.setBaseline(run.scope,{accountKey:run.accountKey,fullIds:ordered,fullAt:new Date().toISOString(),anchorIds:ordered,anchorAt:new Date().toISOString()});}
      else if(outcome==='matched'&&!run.conflicted){const base=this.baseline(run.scope);if(base){const scanned=this.ids(run),seen=new Set(scanned),tail=[...run.anchors].filter(([,p])=>p>run.lastAnchor).sort((a,b)=>a[1]-b[1]).map(([id])=>id);this.setBaseline(run.scope,{...base,anchorIds:[...scanned,...tail.filter(id=>!seen.has(id))],anchorAt:new Date().toISOString()});}}
      this.write(run);this.store.db.run('COMMIT');
    }catch(e){this.store.db.run('ROLLBACK');Object.assign(run,before);this.baselines.delete(run.scope);this.store.invalidateViews();throw e;}
  }
  confirm(scope,mode,token){
    const saved=this.get(scope,mode);if(!saved||saved.token!==token||saved.status!=='review'||saved.accountKey!==this.account()||saved.conflicted||saved.publishedRevision!==this.revision())throw Error('待确认结果或收藏记录已经变化，请重新完整核对');
    const run=this.runtime(saved);run.status='running';run.outcome=null;this.finish(run,'end','已确认采用本次完整列表，本地文件保留');return this.info(scope);
  }
  order(scope,rows){
    const run=['quick','full'].map(mode=>this.get(scope,mode)).find(r=>r?.status==='running');if(!run)return rows;
    const ids=this.ids(run),seen=new Set(ids);if(run.conflicted){const present=new Set(rows.map(r=>r.work_id));return [...rows,...ids.filter(id=>!present.has(id)).map((work_id,i)=>({work_id,rank:rows.length+i}))];}
    return [...ids.map((work_id,rank)=>({work_id,rank})),...rows.filter(r=>!seen.has(r.work_id))];
  }
  view(run){if(!run)return null;return {mode:run.mode,token:run.token,baselineKnown:!!run.baselineKnown,count:run.count,pages:run.pages,added:run.added,restored:run.restored,status:run.status,outcome:run.outcome,reason:run.mode==='quick'&&run.outcome==='limit'?'旧版检查已暂停，可以继续检查':run.reason,oldCount:run.oldCount,canResume:run.status==='paused'&&run.nextCursor!==null&&run.accountKey===this.account(),canConfirm:run.status==='review'&&!run.conflicted&&run.accountKey===this.account()&&run.publishedRevision===this.revision()};}
  info(scope){const b=this.baseline(scope);let full=this.view(this.get(scope,'full'));if(!full){const old=this.store.sync.get(scope);if(old&&old.status!=='complete')full={mode:'full',legacy:true,count:old.count,pages:old.pages,status:'paused',reason:old.reason,canResume:old.nextCursor!==null&&old.accountKey===this.account()};}return {baselineKnown:!!b,fullAt:b?.fullAt||null,quick:this.view(this.get(scope,'quick')),full};}
  snapshot(){return Object.fromEntries(this.store.all('collections').filter(c=>c.added).map(c=>[c.id,this.info(c.id)]));}
  list(){return this.store.all('collection_read_runs').filter(r=>r.status!=='complete').map(r=>({...this.view(r),collectionId:r.scope,name:this.store.collection(r.scope)?.name||'收藏'}));}
}
