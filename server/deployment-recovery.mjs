import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isUuid,syncDirectory,writeDurably} from './library.mjs';

export function prepareRecovery({dir,accountId,env}) {
  const uid=env.CANGXIA_SOURCE_UID, imageDigest=env.CANGXIA_DEPLOYED_DIGEST;
  const restore=env.CANGXIA_RESTORE_NAME, libraryId=env.CANGXIA_RESTORE_LIBRARY, manifestSha256=env.CANGXIA_RESTORE_SHA256;
  if (![uid,imageDigest,restore,libraryId,manifestSha256].some(Boolean)) return;
  if(!/^\d{1,30}$/.test(uid)||!/^sha256:[a-f0-9]{64}$/.test(imageDigest))
    throw Error('请填写已核对的抖音 UID 与当前预构建镜像摘要。');
  for(const name of ['sources','manifests','targets','restores','reports']){
    const folder=path.join(dir,name);
    if(!fs.existsSync(folder))fs.mkdirSync(folder,{mode:0o700});
    if(!fs.lstatSync(folder).isDirectory())throw Error('彩排目录无效。');
  }
  const file=path.join(dir,'rehearsal.json');
  const prior=fs.existsSync(file);
  if(prior && (!fs.lstatSync(file).isFile()||fs.lstatSync(file).nlink!==1))throw Error('彩排配置无效。');
  const settings=prior?JSON.parse(fs.readFileSync(file,'utf8')):{accountId,uid,sources:{},restores:{}};
  if(settings.accountId!==accountId||settings.uid!==uid)throw Error('现有彩排配置的账号不同。');
  const before=JSON.stringify(settings);
  settings.imageDigest=imageDigest;
  if(restore||libraryId||manifestSha256){
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(restore??'') || !isUuid(libraryId)||!/^[a-f0-9]{64}$/.test(manifestSha256))
      throw Error('请提供独立还原目录名、原库标识与原始移交报告的 SHA256。');
    settings.restores??={};
    if(Object.hasOwn(settings.restores,restore)){
      const old=settings.restores[restore];
      if(old.libraryId!==libraryId||old.manifestSha256!==manifestSha256)throw Error('还原名称已登记到不同恢复点。');
    } else Object.defineProperty(settings.restores,restore,{value:{libraryId,manifestSha256},enumerable:true});
  }
  if(prior && before===JSON.stringify(settings))return;
  const temp=path.join(dir,'.rehearsal-'+randomUUID());
  writeDurably(temp,JSON.stringify(settings,null,2)+'\n');
  fs.renameSync(temp,file);syncDirectory(dir);
}
