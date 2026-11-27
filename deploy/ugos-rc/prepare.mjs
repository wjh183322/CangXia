import fs from 'node:fs';
import { separatePaths } from '/opt/cangxia/server/rehearsal-files.mjs';

const storage = ['/library', '/config', '/rehearsal', '/approved'];
const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8');
const locations = [...storage, '/install'];
const mountpoints = new Set(mounts.trim().split('\n').map(line => line.split(' ')[4]));
if (!locations.every(dir => mountpoints.has(dir))) throw Error('专用目录挂载不完整。');
separatePaths(locations, mounts);

if (fs.existsSync('/install/initialized')) {
  console.log('已有初始化记录，继续启动现有服务。');
} else {
  const ticket = '/install/first-install';
  const info = fs.lstatSync(ticket);
  if (!info.isFile() || info.nlink !== 1 || fs.readFileSync(ticket, 'utf8').trim() !== 'cangxia-server-041-rc') {
    throw Error('未找到有效的首次安装标记。');
  }
  for (const dir of storage) {
    if (fs.readdirSync(dir).length) throw Error('首次安装需要全新目录，请检查 ' + dir + '。已保留现有内容。');
  }
  for (const dir of storage) {
    const approved = dir === '/approved';
    fs.chmodSync(dir, approved ? 0o750 : 0o700);
    fs.chownSync(dir, approved ? 0 : 1000, 1000);
  }
  for (const dir of ['/library', '/config']) {
    const marker = dir + '/CREATE-NEW-CANGXIA';
    fs.mkdirSync(marker, {mode: 0o700});
    fs.chownSync(marker, 1000, 1000);
  }
  for (const name of ['sources', 'manifests', 'restores']) {
    const dir = '/approved/' + name;
    fs.mkdirSync(dir, {mode: 0o750});
    fs.chownSync(dir, 0, 1000);
    fs.chmodSync(dir, 0o750);
  }
  fs.renameSync(ticket, '/install/initialized');
  console.log('NAS 目录已就绪，正在启动藏匣服务。');
}
