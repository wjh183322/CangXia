import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ServerClient,pinnedMedia} from '../../electron/server-client.mjs';
import {openLibrary} from '../../server/library.mjs';
import {createDownloads} from '../../server/downloads.mjs';
import {applyUpgrade,inspectUpgrade} from '../../server/upgrade.mjs';

const [mode,rawRoot,rawConfig]=process.argv.slice(2);
const root=rawRoot||'/library', config=rawConfig||'/config/identity';
const id=fs.readFileSync(path.join(config,'library-id'),'utf8');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
if(mode==='seed'){
  const library=openLibrary({root,expectedId:id});
  const source={account:()=>({uid:'42',authEpoch:'fixture'})};
  const work={id:'501',name:'重启核对图集',type:'images',author:{uid:'42',nickname:'样本'},
    images:[{index:0,urls:['https://p3.douyinpic.com/fixture-0']}]};
  library.write(db=>{
    db.exec("INSERT INTO source_account VALUES(1,'42','测试','fixture'); INSERT INTO download_auth VALUES(1,'fixture')");
    db.prepare('INSERT INTO works VALUES(?,?,?)').run(work.id,work.name,JSON.stringify(work));
    db.prepare('INSERT INTO source_members VALUES(?,?,0,0)').run('total',work.id);
  });
  const downloads=createDownloads({root,library,source,fetchAsset:async()=>new Response(png,{headers:{'content-type':'image/png','content-length':String(png.length)}})});
  try{
    library.write(db=>downloads.enqueue(db,[work.id],'missing'));
    await downloads.run();
    assert.ok(downloads.store.resources(work.id).some(r=>r.key==='image-0'));
    library.write(db=>db.exec('UPDATE source_account SET profile_id=NULL'));
  }finally{await downloads.close();library.close();}
}else if(mode==='empty'||mode==='populated'){
  const read=n=>JSON.parse(fs.readFileSync(path.join(config,'windows-'+n+'.json')));
  const a=new ServerClient(),b=new ServerClient();
  try{
    await a.connect(read(1));await a.acquire();
    const list=await a.query('list-works',{source:'total'});
    assert.equal(list.total,mode==='empty'?0:1);
    if(mode==='populated'){
      assert.deepEqual(list.ids,['501']);
      const {media}=await a.query('work-detail',{id:'501'});
      const pic=media.find(r=>r.key==='image-0');assert.ok(pic);
      const res=await pinnedMedia(a.config,a.grant,pic,{range:'bytes=0-15',signal:new AbortController().signal});
      assert.equal(res.statusCode,206);const chunks=[];for await(const chunk of res)chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks),png.subarray(0,16));
    }
    await b.connect(read(2));await assert.rejects(b.acquire());await a.release();await b.acquire();
    const cfg=await b.call('rehearsal',{input:{action:'list'}});assert.equal(cfg.uid,'42');assert.deepEqual(cfg.sources,[]);
  }finally{await a.release().catch(()=>{});await b.release().catch(()=>{});}
}else if(mode==='old'){
  const area=path.join(root,'cangxia-server');fs.mkdirSync(area,{mode:0o700});
  for(const name of ['media','snapshots'])fs.mkdirSync(path.join(area,name),{mode:0o700});
  fs.writeFileSync(path.join(area,'identity.json'),JSON.stringify({appId:'local.cangxia.server',libraryId:id}));
  const db=new DatabaseSync(path.join(area,'library.sqlite'));
  db.exec(fs.readFileSync(new URL('../../server/schema/v1.sql',import.meta.url),'utf8'));
  db.exec('PRAGMA application_id=0x43585346; PRAGMA user_version=1');
  db.prepare('INSERT INTO library_identity VALUES(1,?,?)').run('local.cangxia.server',id);
  db.exec("INSERT INTO works VALUES('501','旧版作品','{}');INSERT INTO source_members VALUES('total','501',0)");
  fs.writeFileSync(path.join(area,'media','fixture.png'),png);
  db.prepare('INSERT INTO media_files VALUES(?,?,?,?,?)').run('m1','501','fixture.png',png.length,createHash('sha256').update(png).digest('hex'));
  db.close();
}else if(mode==='upgrade'){
  const plan=inspectUpgrade(root,id),imageDigest=process.env.CANGXIA_DEPLOYED_DIGEST;
  assert.equal(plan.state,'migration-required');assert.equal(plan.from,1);
  const command={root,expectedId:id,from:1,to:plan.to,imageDigest};
  await assert.rejects(applyUpgrade(command),/approval/i);
  await applyUpgrade({...command,approval:{confirmed:true,operationId:randomUUID(),libraryId:id,from:1,to:plan.to,imageDigest}});
  const library=openLibrary({root,expectedId:id});try{assert.equal(library.read(db=>db.prepare('SELECT title FROM works WHERE id=?').get('501')).title,'旧版作品');}finally{library.close();}
}else throw Error('Unknown fixture action');
