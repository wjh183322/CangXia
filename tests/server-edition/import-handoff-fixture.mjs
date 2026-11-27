import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createBackupServer} from '../../backup-server/server.mjs';
import {sealSource,previewImport,importApproved} from '../../server/migration.mjs';

const [base,mount,approved]=process.argv.slice(2);
const nas=path.join(base,'old-nas'),target=path.join(base,'detached');
const legacy=createBackupServer({dataDir:nas,token:'synthetic-migration-test-only'.repeat(2),allowInsecureLoopback:true});
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
const uid='42',id='501',sha=createHash('sha256').update(bytes).digest('hex');
try {
  await legacy.listen();
  const row=legacy.db.prepare('INSERT INTO records VALUES(?,?,?,1)');
  row.run('settings','account',JSON.stringify({value:{uid}}));
  row.run('works',id,JSON.stringify({id,name:'旧版图集',type:'images',images:[{index:0,urls:[]}]}));
  row.run('members','__all__:'+id,JSON.stringify({collectionId:'__all__',workId:id,rank:0}));
  row.run('downloads',id,JSON.stringify({state:'complete',collectionId:'__all__',
    home:{kind:'collection',id:'__all__',folder:'收藏',workFolder:'旧图集'},
    requiredKeys:['image-0'],assets:[{key:'image-0',kind:'image',file:'原件.png',size:bytes.length,sha256:sha}]}));
  fs.writeFileSync(path.join(nas,'objects',sha),bytes);
  legacy.db.prepare('INSERT INTO objects VALUES(?,?)').run(sha,bytes.length);
}finally{await legacy.close();}
const args={uid,target,imageDigest:process.env.CANGXIA_DEPLOYED_DIGEST,
  sources:[await sealSource({directory:nas,kind:'nas',database:'library.sqlite'})]};
const {previewId}=await previewImport(args);
const result=await importApproved({...args,previewId,approval:{confirmed:true,uid,target,previewId}});
const point=path.join(approved,'restores','imported');
fs.mkdirSync(point,{recursive:true});
fs.cpSync(result.snapshot,path.join(point,'snapshot'),{recursive:true});
fs.cpSync(result.mediaRoot,path.join(point,'media'),{recursive:true});
fs.writeFileSync(path.join(approved,'cutover.json'),JSON.stringify({mode:'existing-import',confirmed:true,
  previewId,uid,libraryId:result.libraryId,manifestSha256:result.manifestSha256,restore:'imported',target:'formal'}));
fs.renameSync(target,path.join(mount,'formal'));
fs.chmodSync(path.join(mount,'formal'),0o700);
