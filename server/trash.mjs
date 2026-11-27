import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { moveExclusive } from './files.mjs';
import { failure } from './service-error.mjs';

const invalid = (message) => failure(409, 'TRASH_REVIEW', message);
const conflict = () => invalid('回收位置或原路径存在冲突。两处文件均保留，请核对文件后重试。');
const id = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino) });
const equal = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const linux = process.platform === 'linux';
const { O_RDONLY, O_NOFOLLOW, O_DIRECTORY } = fs.constants;
const mount = (fd) =>
  linux ? fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8').match(/^mnt_id:\s+(\d+)$/m)?.[1] : '';
function directory(file, createUnder) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) throw conflict();
  const { root } = path.parse(file);
  let current = root,
    fd;
  try {
    if (linux) fd = fs.openSync(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    for (const part of file.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const entry = linux ? '/proc/self/fd/' + fd + '/' + part : current;
      if (createUnder && current.startsWith(createUnder.path + path.sep) && !fs.existsSync(entry))
        try {
          fs.mkdirSync(entry, { mode: 0o700 });
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
      if (linux) {
        const next = fs.openSync(entry, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        fs.closeSync(fd);
        fd = next;
      } else if (!fs.lstatSync(current).isDirectory()) throw conflict();
      if (createUnder && (current === createUnder.path || current.startsWith(createUnder.path + path.sep))) {
        const s = linux ? fs.fstatSync(fd, { bigint: true }) : fs.lstatSync(current, { bigint: true });
        if (
          String(s.dev) !== createUnder.dev ||
          mount(fd) !== createUnder.mount ||
          (current === createUnder.path && !equal(id(s), createUnder))
        )
          throw conflict();
      }
    }
    const stat = linux ? fs.fstatSync(fd, { bigint: true }) : fs.lstatSync(current, { bigint: true });
    return {
      dir: file,
      fd,
      ...id(stat),
      mount: mount(fd),
      close() {
        if (fd !== undefined) fs.closeSync(fd);
      }
    };
  } catch (e) {
    if (fd !== undefined) fs.closeSync(fd);
    throw e;
  }
}
function directoryId(file) {
  const d = directory(file);
  try {
    return { path: file, dev: d.dev, ino: d.ino, mount: d.mount };
  } finally {
    d.close();
  }
}
function child(dir, name) {
  return linux ? '/proc/self/fd/' + dir.fd + '/' + name : path.join(dir.dir, name);
}
function stat(file) {
  try {
    return fs.lstatSync(file, { bigint: true });
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
async function matches(file, proof) {
  const initial = stat(file);
  if (
    !initial ||
    !initial.isFile() ||
    initial.nlink !== 1n ||
    !equal(id(initial), proof.identity) ||
    (proof.mtimeNs && String(initial.mtimeNs) !== proof.mtimeNs) ||
    initial.size !== BigInt(proof.size)
  )
    return false;
  const opened = await fs.promises.open(file, O_RDONLY | (O_NOFOLLOW || 0));
  try {
    const first = await opened.stat({ bigint: true });
    if (!equal(id(first), proof.identity)) return false;
    const hash = createHash('sha256');
    for await (const chunk of opened.createReadStream({ autoClose: false })) hash.update(chunk);
    const last = await opened.stat({ bigint: true }),
      current = stat(file);
    return (
      last.ctimeNs === first.ctimeNs &&
      current &&
      equal(id(current), proof.identity) &&
      current.ctimeNs === last.ctimeNs &&
      hash.digest('hex') === proof.sha256
    );
  } finally {
    await opened.close();
  }
}
const renameCode = [
  'import ctypes,os,sys',
  'libc=ctypes.CDLL(None,use_errno=True)',
  'rename=libc.renameat2',
  'r=rename(3,os.fsencode(sys.argv[1]),4,os.fsencode(sys.argv[2]),1)',
  'sys.exit(ctypes.get_errno() if r else 0)'
].join('\n');
async function move(from, to, name) {
  if (!linux) return moveExclusive(child(from, name), child(to, name));
  await new Promise((resolve, reject) => {
    const p = spawn('python3', ['-I', '-S', '-c', renameCode, name, name], {
      stdio: ['ignore', 'ignore', 'ignore', from.fd, to.fd]
    });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(conflict())));
  });
  fs.fsyncSync(from.fd);
  fs.fsyncSync(to.fd);
}
export function createTrashAdapter({ layout, bin }) {
  function binding() {
    if (!bin)
      throw invalid(
        '请在 NAS 配置经厂商支持、可按原路径还原的回收目录映射 CANGXIA_RECYCLE_MEDIA_ROOT，然后验证绿联回收站。'
      );
    layout.assertCurrent();
    const media = directoryId(layout.media),
      recycle = directoryId(bin);
    if (
      media.dev !== recycle.dev ||
      equal(media, recycle) ||
      [path.relative(bin, layout.media), path.relative(layout.root, bin)].some(
        (rel) => !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)
      )
    )
      throw invalid('回收目录必须独立于归档目录，并支持同卷独占移动。');
    return {
      method: 'mirror-exclusive-rename-v1',
      media,
      recycle,
      service: linux
        ? [process.geteuid(), process.getegid(), ...process.getgroups()].join(',')
        : process.env.USERNAME || '',
      boot: linux ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : ''
    };
  }
  function check(expected) {
    if (JSON.stringify(binding()) !== JSON.stringify(expected))
      throw invalid('回收站、挂载或服务身份已变更，请重新完成现场验证。');
  }
  function components(file) {
    const parts = file.relative_path?.split('/');
    if (!parts?.length || parts.some((p) => !p || p === '.' || p === '..' || /[\\:\0]/.test(p)))
      throw conflict();
    return parts;
  }
  function originalOccupied(file, expected) {
    check(expected);
    const parts = components(file);
    const name = parts.pop(),
      d = directory(path.join(layout.media, ...parts));
    try {
      if (!equal(d, file.parent) || d.mount !== expected.media.mount) throw conflict();
      return !!stat(child(d, name));
    } finally {
      d.close();
    }
  }
  async function access(file, expected, action) {
    check(expected);
    const parts = components(file);
    const name = parts.pop(),
      formal = directory(path.join(layout.media, ...parts));
    let recycled;
    try {
      if (!equal(formal, file.parent) || formal.mount !== expected.media.mount) throw conflict();
      recycled = directory(path.join(bin, ...parts), action === 'trash' ? expected.recycle : undefined);
      if (recycled.dev !== expected.recycle.dev || recycled.mount !== expected.recycle.mount)
        throw conflict();
      const source = action === 'trash' ? formal : recycled,
        dest = action === 'trash' ? recycled : formal;
      const a = child(source, name),
        b = child(dest, name);
      if (action === 'inspect') {
        return {
          original: stat(b) ? ((await matches(b, file)) ? 'owned' : 'conflict') : 'missing',
          recycled: stat(a) ? ((await matches(a, file)) ? 'owned' : 'conflict') : 'missing'
        };
      }
      if (!stat(a) && (await matches(b, file))) return;
      if (stat(b) || !(await matches(a, file))) throw conflict();
      check(expected);
      await move(source, dest, name);
      if (!(await matches(b, file))) {
        // An external rename raced the syscall. Return the displaced entry only to an empty slot.
        if (!stat(a) && stat(b)) await move(dest, source, name);
        throw conflict();
      }
      if (stat(a)) throw conflict();
      check(expected);
    } finally {
      formal.close();
      recycled?.close();
    }
  }
  return {
    binding,
    check,
    originalOccupied,
    trash: (file, proof) => access(file, proof, 'trash'),
    restore: (file, proof) => access(file, proof, 'restore'),
    inspect: (file, proof) => access(file, proof, 'inspect')
  };
}
