import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const run=promisify(execFile);
export async function requireLocalStorage(value){
 const target=path.resolve(value);if(/^\\\\/.test(target))throw new Error('备份版的下载目录请选择本机磁盘，NAS 通过后台服务同步');
 if(process.platform==='win32'){const root=path.parse(target).root;if(!/^[a-z]:\\$/i.test(root))throw new Error('本机保存目录无效');const script=`[Console]::Write(([IO.DriveInfo]::new('${root}')).DriveType.ToString())`;const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');const {stdout}=await run(exe,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000});if(!['Fixed','Removable','Ram'].includes(stdout.trim()))throw new Error('备份版的下载目录请选择本机磁盘，不能使用 NAS 映射盘');}
 return target;
}
