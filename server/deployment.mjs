import {directory, segment, separatePaths} from './rehearsal-files.mjs';
import {checkApprovalMount,prepareRecovery} from './deployment-recovery.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, randomUUID, X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {inspectLayout, openLibrary, syncDirectory, writeDurably, isUuid} from './library.mjs';
import {restoreApproved, verifyRestore, verifyRegisteredPlayback} from './recovery.mjs';
import {verifyImportedTarget} from './migration.mjs';

const marker = 'CREATE-NEW-CANGXIA';
// This opt-in uses one dedicated share. Two binds of the same filesystem have
// different Linux mount identities, so a no-replace rename between them fails.
export function storagePaths(mountRoot, libraryChild, recycleRelative, mountInfo, allowNew=false) {
  if (!libraryChild && !recycleRelative) return {root:mountRoot};
  const root = path.join(directory(mountRoot),segment(libraryChild));
  if (!allowNew || fs.existsSync(root)) directory(root);
  const parts = recycleRelative ? recycleRelative.split('/').map(segment) : [];
  if (parts[0] === libraryChild) throw Error('回收路径必须独立于资料库。');
  const allowed = new Set([libraryChild,...parts.slice(0,1)]);
  if (fs.readdirSync(mountRoot).some(name=>!allowed.has(name)) ||
      mountInfo.split('\n').some(line=>line.split(' ')[4]?.startsWith(mountRoot+'/')))
    throw Error('此挂载只能包含专用资料库与已声明的回收路径，不能包含其他目录或子挂载。');
  const bin = parts.length ? directory(path.join(mountRoot,...parts)) : undefined;
  return {root,bin};
}
function privateEntry(file, directory) {
  const st = fs.lstatSync(file);
  if ((directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1) ||
      st.uid !== process.getuid() || (st.mode & 0o077) !== 0)
    throw Error('NAS 目录或文件须由服务 UID 独占读写。请核对所有者及权限。');
}
function requireNew(dir, mark=marker) {
  const names = fs.readdirSync(dir);
  if (names.length !== 1 || names[0] !== mark ||
      !fs.lstatSync(path.join(dir, mark)).isDirectory() || fs.readdirSync(path.join(dir, mark)).length)
    throw Error('请在专用空目录中建立唯一的空标记目录 '+mark+'。');
}
function writeIdentity(config, url, libraryId, mark, initialize) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw Error('请配置 Windows 能访问的 HTTPS 服务地址。');
  const stage = path.join(config,'.initializing');
  fs.mkdirSync(stage,{mode:0o700});
  const accountId = randomUUID();
  execFileSync('openssl',['req','-x509','-newkey','rsa:3072','-nodes','-days','825',
    '-subj','/CN=CangXia NAS','-keyout',path.join(stage,'server.key'),'-out',path.join(stage,'server.crt')],{stdio:'ignore'});
  const fingerprint = new X509Certificate(fs.readFileSync(path.join(stage,'server.crt'))).fingerprint256;
  const devices = {};
  for (const deviceId of ['windows-1','windows-2']) {
    const token = randomBytes(32).toString('base64url');
    devices[deviceId] = {token,accountId};
    writeDurably(path.join(stage,deviceId+'.json'),JSON.stringify({url:endpoint.origin,deviceId,fingerprint,token,libraryId},null,2)+'\n');
  }
  writeDurably(path.join(stage,'devices.json'),JSON.stringify(devices));
  writeDurably(path.join(stage,'library-id'),libraryId);
  syncDirectory(stage);
  initialize?.();
  fs.renameSync(stage,path.join(config,'identity'));
  fs.rmdirSync(path.join(config,mark));
  syncDirectory(config);
}
export function prepareDeployment({root, config, url}) {
  process.umask(0o077);
  privateEntry(root,true);
  privateEntry(config,true);
  const a = fs.statSync(root), b = fs.statSync(config);
  if (a.dev === b.dev && a.ino === b.ino) throw Error('资料与配置挂载重复。');
  const active = path.join(config,'identity');
  if (!fs.existsSync(active)) {
    requireNew(config);
    requireNew(root);
    const libraryId = randomUUID();
    writeIdentity(config,url,libraryId,marker,()=>{
      fs.rmdirSync(path.join(root,marker));
      openLibrary({root,expectedId:libraryId,mode:'init'}).close();
    });
  }
  privateEntry(active,true);
  for (const name of ['server.key','server.crt','devices.json','library-id']) privateEntry(path.join(active,name),false);
  const id = fs.readFileSync(path.join(active,'library-id'),'utf8');
  if (!isUuid(id)) throw Error('NAS 服务配置中的库身份无效。');
  if (!inspectLayout(root,id)) throw Error('资料库挂载为空。');
  return {CANGXIA_LIBRARY_ROOT:root,CANGXIA_LIBRARY_ID:id,CANGXIA_TLS_KEY_FILE:path.join(active,'server.key'),
    CANGXIA_TLS_CERT_FILE:path.join(active,'server.crt'),CANGXIA_DEVICES_FILE:path.join(active,'devices.json')};
}

// Invoked by a separate, explicitly approved Compose one-off with no listening service.
export async function prepareImportHandoff({root,config,inputs,child,url}) {
  process.umask(0o077);
  const mark='PREPARE-IMPORTED-CANGXIA';
  privateEntry(config,true);
  requireNew(config,mark);
  privateEntry(path.dirname(root),true);
  const file=path.join(inputs,'cutover.json');
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.nlink!==1)throw Error('需要独立的管理员切换批准。');
  const approval=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!child || child!==approval.target || !['existing-import','from-backup'].includes(approval.mode) ||
     approval.confirmed!==true || !isUuid(approval.libraryId) || !/^\d{1,30}$/.test(approval.uid) ||
     !/^[a-f0-9]{64}$/.test(approval.manifestSha256) || !/^[a-f0-9]{64}$/.test(approval.previewId))
    throw Error('切换批准缺少精确的目标、来源和恢复点身份。');
  const backup=directory(path.join(inputs,'restores',segment(approval.restore)));
  const {libraryId,uid,manifestSha256,previewId}=approval;
  const restore={snapshot:path.join(backup,'snapshot'),mediaRoot:path.join(backup,'media'),libraryId,uid,manifestSha256};
  separatePaths([root,config,inputs]);
  if(!(await verifyRestore(restore)).verified)throw Error('独立备份的清单或媒体核对失败。');
  const db=new DatabaseSync(pathToFileURL(path.join(restore.snapshot,'library.sqlite')).href+'?mode=ro&immutable=1',{readOnly:true});
  try {
    const marker=db.prepare('SELECT body FROM upgrade_receipts WHERE operation_id=?').get('populate-'+previewId);
    if(!marker||JSON.parse(marker.body).previewId!==previewId)throw Error('此恢复点不属于获准的旧库导入。');
  }finally{db.close();}
  if(approval.mode==='existing-import'){
    privateEntry(root,true);
    const imported=await verifyImportedTarget(root,previewId);
    if(imported.libraryId!==libraryId || imported.uid!==uid || imported.manifestSha256!==manifestSha256)
      throw Error('当前导入目标与外部备份或批准不符。');
    await verifyRegisteredPlayback(root,libraryId);
  }else await restoreApproved({...restore,target:root,confirmed:true});
  writeIdentity(config,url,libraryId,mark);
  return {prepared:true,libraryId,uid,manifestSha256};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.getuid?.()) throw Error('请使用独立非 root 身份运行。');
    const mountInfo = fs.readFileSync('/proc/self/mountinfo','utf8');
    const mounts = new Set(mountInfo.split('\n').map(line=>line.split(' ')[4]));
    for(const dir of ['/library','/config','/rehearsal','/approved']) if(!mounts.has(dir)) throw Error('请挂载独立目录 '+dir);
    separatePaths(['/library','/config','/rehearsal','/approved'],mountInfo);
    checkApprovalMount(mountInfo,'/approved',process.getuid());
    privateEntry('/rehearsal',true);
    const action=process.argv[2]??'start';
    if(!['start','prepare-import'].includes(action) || process.argv.length>3)throw Error('未知部署操作。');
    const child=process.env.CANGXIA_LIBRARY_CHILD;
    const {root,bin}=storagePaths('/library',child,process.env.CANGXIA_NATIVE_RECYCLE_RELATIVE,mountInfo,action==='prepare-import');
    if(action==='prepare-import'){
      if(!child)throw Error('请指定新独立挂载内的切换目标子目录。');
      console.log(JSON.stringify(await prepareImportHandoff({root,config:'/config',inputs:'/approved',child,url:process.env.CANGXIA_URL})));
    }else{
    if(bin) process.env.CANGXIA_RECYCLE_MEDIA_ROOT=bin;
    else delete process.env.CANGXIA_RECYCLE_MEDIA_ROOT;
    Object.assign(process.env,prepareDeployment({root,config:'/config',url:process.env.CANGXIA_URL}));
    const devices=JSON.parse(fs.readFileSync(process.env.CANGXIA_DEVICES_FILE,'utf8'));
    const configuration=prepareRecovery({dir:'/rehearsal',inputsDir:'/approved',accountId:Object.values(devices)[0].accountId,env:process.env});
    const {runService} = await import('./start.mjs');
    const state = await runService(['start'],{inputsRoot:'/approved',configuration});
    console.log(JSON.stringify(state));
    if (state.state !== 'serving') process.exitCode=1;
    }
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
