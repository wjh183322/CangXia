import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
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
  const chain = [];
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
      const node = linux ? fs.fstatSync(fd, { bigint: true }) : fs.lstatSync(current, { bigint: true });
      chain.push({ ...id(node), mount: mount(fd) });
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
      chain,
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
function filesystemId(directory, mountFilesystems) {
  if (!linux) return directory.dev;
  if (!directory.mount) throw invalid('无法识别实际挂载。');
  const prior = mountFilesystems.get(directory.dir);
  if (prior?.mount === directory.mount && prior.dev === directory.dev) return prior.id;
  {
    const value = execFileSync('python3', ['-I', '-S', '-c', 'import os;print(os.fstatvfs(3).f_fsid)'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore', directory.fd],
      timeout: 5000
    }).trim();
    if (!/^[0-9]+$/.test(value) || value === '0') throw invalid('文件系统未提供可核验的卷身份。');
    const pinned = fs.openSync('/proc/self/fd/' + directory.fd, O_RDONLY | O_DIRECTORY);
    if (prior) fs.closeSync(prior.fd);
    mountFilesystems.set(directory.dir, {
      id: value,
      dev: directory.dev,
      mount: directory.mount,
      fd: pinned
    });
  }
  return mountFilesystems.get(directory.dir).id;
}
function directoryId(file, mountFilesystems) {
  const d = directory(file);
  try {
    return {
      path: file,
      dev: d.dev,
      ino: d.ino,
      mount: d.mount,
      filesystem: filesystemId(d, mountFilesystems)
    };
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
  const mountFilesystems = new Map();
  const serviceIdentity = () =>
    linux
      ? [process.geteuid(), process.getegid(), ...process.getgroups()].join(',')
      : process.env.USERNAME || '';
  function binding() {
    if (!bin)
      throw invalid(
        '请在 NAS 配置经厂商支持、可按原路径还原的回收目录映射 CANGXIA_RECYCLE_MEDIA_ROOT，然后验证绿联回收站。'
      );
    layout.assertCurrent();
    const media = directoryId(layout.media, mountFilesystems),
      recycle = directoryId(bin, mountFilesystems);
    if (
      media.dev !== recycle.dev ||
      (linux && (!media.mount || media.mount !== recycle.mount)) ||
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
      service: serviceIdentity(),
      boot: linux ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : ''
    };
  }
  function check(expected) {
    if (JSON.stringify(binding()) !== JSON.stringify(expected))
      throw invalid('回收站、挂载或服务身份已变更，请重新完成现场验证。');
  }
  function sameVolume(previous, current) {
    if (!previous || previous.method !== current.method || previous.service !== current.service) return false;
    const roots = ['media', 'recycle'];
    if (!roots.every((k) => previous[k]?.path === current[k].path && equal(previous[k], current[k])))
      return false;
    if (roots.every((k) => previous[k].filesystem && previous[k].filesystem === current[k].filesystem))
      return true;
    // e23c690 had no filesystem ID. A live, unchanged boot and the two original mount
    // identities establish continuity on Linux. Windows records volume serials in dev.
    return (
      roots.every(
        (k) => !Object.hasOwn(previous[k], 'filesystem') && previous[k].mount === current[k].mount
      ) &&
      previous.boot === current.boot &&
      (!linux || (!!current.boot && roots.every((k) => /^\d+$/.test(current[k].mount))))
    );
  }
  function consistentPaths(old, next, rebound) {
    if (!rebound) return JSON.stringify(old) === JSON.stringify(next);
    return ['original', 'recycled'].every(
      (k) => old[k].length === next[k].length && old[k].every((dir, i) => equal(dir, next[k][i]))
    );
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
  function stamp(st) {
    return (
      st &&
      [
        String(st.dev),
        String(st.ino),
        String(st.nlink),
        String(st.mode),
        String(st.size),
        String(st.mtimeNs),
        String(st.ctimeNs)
      ].join(':')
    );
  }
  // An unchanged singly-linked original is sufficient to abandon a deletion.
  // Recheck its canonical path inside the receipt transaction, even if the bin has gone offline.
  async function intactOriginal(file, expected, paths) {
    if (expected.service !== serviceIdentity() || expected.method !== 'mirror-exclusive-rename-v1')
      throw conflict();
    const parts = components(file),
      name = parts.pop(),
      parent = path.join(layout.media, ...parts);
    function openParent() {
      layout.assertCurrent();
      const media = directoryId(layout.media, mountFilesystems);
      if (
        !equal(media, expected.media) ||
        media.path !== expected.media.path ||
        (expected.media.filesystem && expected.media.filesystem !== media.filesystem)
      )
        throw conflict();
      const d = directory(parent),
        chain = d.chain.slice(-(parts.length + 1));
      if (
        !equal(d, file.parent) ||
        chain.some((n) => n.mount !== media.mount || n.dev !== media.dev) ||
        (paths &&
          (paths.original.length !== chain.length || chain.some((n, i) => !equal(n, paths.original[i]))))
      ) {
        d.close();
        throw conflict();
      }
      return d;
    }
    const d = openParent();
    try {
      const filePath = child(d, name),
        before = stamp(stat(filePath));
      if (!before || !(await matches(filePath, file))) return null;
      return () => {
        const current = openParent();
        try {
          const registered = stat(child(current, name));
          if (stamp(registered) !== before) throw conflict();
          return String(registered.ctimeNs);
        } finally {
          current.close();
        }
      };
    } finally {
      d.close();
    }
  }
  function assertObserved(file, expected, observed) {
    check(expected);
    const parts = components(file),
      name = parts.pop();
    let originalChangeNs;
    for (const [side, root] of [
      ['original', layout.media],
      ['recycled', bin]
    ]) {
      const current = directory(path.join(root, ...parts));
      try {
        if (JSON.stringify(current.chain.slice(-(parts.length + 1))) !== JSON.stringify(observed.paths[side]))
          throw invalid('原目录或回收子目录已被移动或替换。请按回执原路径找回并核对原目录，再重试。');
        const state = stat(child(current, name));
        if (observed.stamps && stamp(state) !== observed.stamps[side]) throw conflict();
        if (side === 'original' && state) originalChangeNs = String(state.ctimeNs);
      } finally {
        current.close();
      }
    }
    return originalChangeNs;
  }
  async function access(file, expected, action, options = {}) {
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
      const paths = {
        original: formal.chain.slice(-(parts.length + 1)),
        recycled: recycled.chain.slice(-(parts.length + 1))
      };
      if (
        Object.entries(paths).some(([side, chain]) => {
          const root = side === 'original' ? expected.media : expected.recycle;
          return chain.some((d) => d.mount !== root.mount || d.dev !== root.dev);
        })
      )
        throw conflict();
      if (options.paths && !consistentPaths(options.paths, paths, options.rebound))
        throw invalid('原路径或回收子目录身份与上次移动不符。请恢复原目录后重试。');
      function observation() {
        return {
          paths,
          stamps: { original: stamp(stat(child(formal, name))), recycled: stamp(stat(child(recycled, name))) }
        };
      }
      const source = action === 'trash' ? formal : recycled,
        dest = action === 'trash' ? recycled : formal;
      const a = child(source, name),
        b = child(dest, name);
      if (action === 'inspect') {
        const before = observation();
        const state = {
          original: stat(b) ? ((await matches(b, file)) ? 'owned' : 'conflict') : 'missing',
          recycled: stat(a) ? ((await matches(a, file)) ? 'owned' : 'conflict') : 'missing'
        };
        assertObserved(file, expected, before);
        return { ...state, ...before };
      }
      if (!stat(a)) {
        if (options.allowSettled === false) throw conflict();
        const before = observation();
        // Linux resolves b through the pinned directory descriptor until the digest and final path check finish.
        if (stat(a) || !(await matches(b, file))) throw conflict();
        assertObserved(file, expected, before);
        return before;
      }
      const before = observation();
      if (stat(b) || !(await matches(a, file))) throw conflict();
      assertObserved(file, expected, before);
      options.beforeMove?.(paths);
      assertObserved(file, expected, before);
      await move(source, dest, name);
      assertObserved(file, expected, { paths });
      const moved = observation();
      if (!(await matches(b, file))) {
        // An external rename raced the syscall. Return the displaced entry only to an empty slot.
        if (!stat(a) && stat(b)) await move(dest, source, name);
        throw conflict();
      }
      if (stat(a)) throw conflict();
      assertObserved(file, expected, moved);
      return moved;
    } finally {
      formal.close();
      recycled?.close();
    }
  }
  return {
    binding,
    check,
    originalOccupied,
    intactOriginal,
    assertObserved,
    sameVolume,
    close() {
      for (const entry of mountFilesystems.values()) fs.closeSync(entry.fd);
      mountFilesystems.clear();
    },
    trash: (file, proof, options) => access(file, proof, 'trash', options),
    restore: (file, proof, options) => access(file, proof, 'restore', options),
    inspect: (file, proof, options) => access(file, proof, 'inspect', options)
  };
}
