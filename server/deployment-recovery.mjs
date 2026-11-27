import fs from 'node:fs';
import path from 'node:path';
import {isUuid,syncDirectory,writeDurably} from './library.mjs';

function readIndependent(file) {
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.nlink!==1)throw Error('彩排配置或登记不是独立普通文件。');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}

export function checkApprovalMount(mountInfo,dir,uid) {
  const entries=mountInfo.trim().split('\n').map(line=>line.split(' '));
  if(!entries.some(f=>f[4]===dir) || entries.some(f=>(f[4]===dir||f[4].startsWith(dir+'/'))&&!f[5].split(',').includes('ro')) ||
      fs.lstatSync(dir).uid===uid)throw Error('彩排输入必须由独立管理员所有并只读挂载，含子挂载。');
}

export function prepareRecovery({dir,inputsDir,accountId,env}) {
  const file=path.join(inputsDir,'rehearsal.json');
  const approved=fs.existsSync(file)?readIndependent(file):null;
  const uid=env.CANGXIA_SOURCE_UID||approved?.uid, imageDigest=env.CANGXIA_DEPLOYED_DIGEST||approved?.imageDigest;
  const restore=env.CANGXIA_RESTORE_NAME,libraryId=env.CANGXIA_RESTORE_LIBRARY,manifestSha256=env.CANGXIA_RESTORE_SHA256;
  if(!approved && ![uid,imageDigest,restore,libraryId,manifestSha256].some(Boolean))return;
  if(!/^\d{1,30}$/.test(uid)||!/^sha256:[a-f0-9]{64}$/.test(imageDigest))
    throw Error('请填写已核对的抖音 UID 与当前预构建镜像摘要。');
  for(const name of ['sources','manifests','restores']){
    if(!fs.lstatSync(path.join(inputsDir,name)).isDirectory())throw Error('请先在只读输入区准备目录。');
  }
  for(const name of ['targets','reports']){
    const folder=path.join(dir,name);
    if(!fs.existsSync(folder))fs.mkdirSync(folder,{mode:0o700});
    if(!fs.lstatSync(folder).isDirectory())throw Error('彩排输出目录无效。');
  }
  const config=approved??{accountId,uid,imageDigest,sources:{},restores:{}};
  if(config.accountId!==accountId||config.uid!==uid||config.imageDigest!==imageDigest)
    throw Error('只读管理员配置与当前账号或镜像摘要不符。');
  if(restore||libraryId||manifestSha256){
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(restore??'')||!isUuid(libraryId)||!/^[a-f0-9]{64}$/.test(manifestSha256))
      throw Error('请提供独立还原目录名、原库标识与原始移交报告的 SHA256。');
    config.restores??={};
    const binding={libraryId,manifestSha256};
    const check=old=>{
      if(old.libraryId!==libraryId||old.manifestSha256!==manifestSha256)throw Error('还原名称已登记到不同恢复点。');
    };
    if(Object.hasOwn(config.restores,restore))check(config.restores[restore]);
    // This receipt can veto reuse of a name. It never supplies an approved input.
    const receipt=path.join(dir,'restore-binding-'+restore+'.json');
    if(fs.existsSync(receipt))check(readIndependent(receipt));
    else {writeDurably(receipt,JSON.stringify(binding));syncDirectory(dir);}
    Object.defineProperty(config.restores,restore,{value:binding,enumerable:true,configurable:true});
  }
  return config;
}
