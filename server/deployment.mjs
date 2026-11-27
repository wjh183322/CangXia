import {separatePaths} from './rehearsal-files.mjs';
import {prepareRecovery} from './deployment-recovery.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, randomUUID, X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {openLibrary, syncDirectory, writeDurably, isUuid} from './library.mjs';

const marker = 'CREATE-NEW-CANGXIA';
function privateEntry(file, directory) {
  const st = fs.lstatSync(file);
  if ((directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1) ||
      st.uid !== process.getuid() || (st.mode & 0o077) !== 0)
    throw Error('NAS 目录或文件须由服务 UID 独占读写。请核对所有者及权限。');
}
function requireNew(dir) {
  const names = fs.readdirSync(dir);
  if (names.length !== 1 || names[0] !== marker ||
      !fs.lstatSync(path.join(dir, marker)).isDirectory() || fs.readdirSync(path.join(dir, marker)).length)
    throw Error('首次创建须在两个独立空目录内各建立 CREATE-NEW-CANGXIA 空文件夹。');
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
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
        endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw Error('请配置 Windows 能访问的 HTTPS 服务地址。');
    const stage = path.join(config,'.initializing');
    fs.mkdirSync(stage,{mode:0o700});
    const libraryId = randomUUID(), accountId = randomUUID();
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
    fs.rmdirSync(path.join(root,marker));
    openLibrary({root,expectedId:libraryId,mode:'init'}).close();
    fs.renameSync(stage,active);
    fs.rmdirSync(path.join(config,marker));
    syncDirectory(config);
  }
  privateEntry(active,true);
  for (const name of ['server.key','server.crt','devices.json','library-id']) privateEntry(path.join(active,name),false);
  const id = fs.readFileSync(path.join(active,'library-id'),'utf8');
  if (!isUuid(id)) throw Error('NAS 服务配置中的库身份无效。');
  return {CANGXIA_LIBRARY_ROOT:root,CANGXIA_LIBRARY_ID:id,CANGXIA_TLS_KEY_FILE:path.join(active,'server.key'),
    CANGXIA_TLS_CERT_FILE:path.join(active,'server.crt'),CANGXIA_DEVICES_FILE:path.join(active,'devices.json')};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.getuid?.()) throw Error('请使用独立非 root 身份运行。');
    const mountInfo = fs.readFileSync('/proc/self/mountinfo','utf8');
    const mounts = new Set(mountInfo.split('\n').map(line=>line.split(' ')[4]));
    for(const dir of ['/library','/config','/rehearsal']) if(!mounts.has(dir)) throw Error('请挂载独立目录 '+dir);
    separatePaths(['/library','/config','/rehearsal'],mountInfo);
    privateEntry('/rehearsal',true);
    Object.assign(process.env,prepareDeployment({root:'/library',config:'/config',url:process.env.CANGXIA_URL}));
    const devices=JSON.parse(fs.readFileSync(process.env.CANGXIA_DEVICES_FILE,'utf8'));
    prepareRecovery({dir:'/rehearsal',accountId:Object.values(devices)[0].accountId,env:process.env});
    const {runService} = await import('./start.mjs');
    const state = await runService(['start']);
    console.log(JSON.stringify(state));
    if (state.state !== 'serving') process.exitCode=1;
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
