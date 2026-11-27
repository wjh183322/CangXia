import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function segment(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    /[\\/:*?"<>|\x00-\x1f]/.test(value) ||
    /[. ]$/.test(value) ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)
  )
    throw Error('路径分量无效。');
  return value;
}
export function directory(dir) {
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir) throw Error('目录必须使用规范绝对路径。');
  for (let p = dir; ; p = path.dirname(p)) {
    if (!fs.lstatSync(p).isDirectory()) throw Error('目录引用了链接或其他文件。');
    if (path.dirname(p) === p) break;
  }
  return dir;
}
export function child(dir, relative) {
  const parts = relative.split('/').map(segment);
  return path.join(directory(path.join(dir, ...parts.slice(0, -1))), parts.at(-1));
}
export function disjoint(a, b) {
  const within = (x, y) => {
    const rel = path.relative(x, y);
    return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
  };
  const fail = () => {
    throw Error('源、运行库及目标必须使用独立目录。');
  };
  if (within(a, b) || within(b, a)) fail();
  function ancestors(file) {
    const ids = [];
    for (let p = file; ; p = path.dirname(p)) {
      try {
        const s = fs.lstatSync(p, { bigint: true });
        ids.push({ path: p, id: s.dev + '/' + s.ino });
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (path.dirname(p) === p) break;
    }
    return ids;
  }
  const x = ancestors(a),
    y = ancestors(b);
  if (
    x.some((p) => p.path === a && y.some((q) => q.id === p.id)) ||
    y.some((q) => q.path === b && x.some((p) => p.id === q.id))
  )
    fail();
  if (process.platform === 'linux') {
    const unescape = (s) => s.replace(/\\([0-7]{3})/g, (_, v) => String.fromCharCode(parseInt(v, 8)));
    const mounts = fs
      .readFileSync('/proc/self/mountinfo', 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const fields = line.split(' ');
        return { device: fields[2], root: unescape(fields[3]), at: unescape(fields[4]) };
      })
      .sort((l, r) => r.at.length - l.at.length);
    const backing = (file) => {
      const m = mounts.find((m) => within(m.at, file));
      if (!m) fail();
      return { device: m.device, path: path.join(m.root, path.relative(m.at, file)) };
    };
    const p = backing(a),
      q = backing(b);
    if (p.device === q.device && (within(p.path, q.path) || within(q.path, p.path))) fail();
  }
}
export async function fileProof(file) {
  directory(path.dirname(file));
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n) throw Error('清单包含非独立普通文件。');
  const fd = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const stamp = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join('/');
  try {
    const opened = await fd.stat({ bigint: true });
    if (stamp(stat) !== stamp(opened)) throw Error('核验期间文件变化。');
    const hash = createHash('sha256');
    for await (const bytes of fd.createReadStream({ autoClose: false })) hash.update(bytes);
    if (
      stamp(opened) !== stamp(await fd.stat({ bigint: true })) ||
      stamp(opened) !== stamp(fs.lstatSync(file, { bigint: true }))
    )
      throw Error('核验期间文件变化。');
    return { size: Number(stat.size), sha256: hash.digest('hex') };
  } finally {
    await fd.close();
  }
}
export async function sealSource({
  directory: root,
  kind,
  database,
  media = 'archive',
  device = 'device-scope-state.sqlite'
}) {
  directory(root);
  segment(database);
  segment(media);
  segment(device);
  if (!['windows', 'nas', 'recovery'].includes(kind)) throw Error('来源类型无效。');
  const files = [];
  const record = async (rel) => files.push({ relative: rel, ...(await fileProof(child(root, rel))) });
  async function db(rel, required) {
    if (!required && !fs.existsSync(path.join(root, rel))) return;
    await record(rel);
    if (fs.existsSync(path.join(root, rel + '-journal')))
      throw Error('源存在回滚日志，请先用旧端导出一致副本。');
    // SHM is an index rebuilt in private scratch from the exact committed WAL.
    if (fs.existsSync(path.join(root, rel + '-wal'))) await record(rel + '-wal');
  }
  await db(database, true);
  if (kind !== 'nas') await db(device, kind === 'windows');
  const subtree = kind === 'nas' ? 'objects' : media;
  const scan = async (rel) => {
    const dir = directory(path.join(root, ...rel.split('/')));
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      segment(entry.name);
      if (entry.isDirectory()) await scan(rel + '/' + entry.name);
      else await record(rel + '/' + entry.name);
    }
  };
  if (fs.existsSync(path.join(root, subtree))) await scan(subtree);
  if (kind === 'recovery' && subtree !== 'objects' && fs.existsSync(path.join(root, 'objects')))
    await scan('objects');
  const manifest = { version: 1, kind, database, media, device, files };
  return { directory: root, ...manifest, seal: digest(JSON.stringify(manifest)) };
}
export async function validateSeal(source) {
  const current = await sealSource(source);
  if (
    current.seal !== source.seal ||
    digest(JSON.stringify(current.files)) !== digest(JSON.stringify(source.files))
  )
    throw Error('输入与封存清单不符，需重新取得一致副本及批准。');
  return current;
}
// SQLite ignores torn or stale trailing WAL frames when opening a database. A rehearsal
// must not silently present such a detached input as a verified recovery point.
function verifyWal(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return;
    const header = Buffer.alloc(32);
    if (fs.readSync(fd, header) !== 32) throw Error('封存 WAL 头不完整。');
    const magic = header.readUInt32BE(0),
      pageSize = header.readUInt32BE(8),
      frameSize = pageSize + 24;
    if (
      ![0x377f0682, 0x377f0683].includes(magic) ||
      header.readUInt32BE(4) !== 3007000 ||
      pageSize < 512 ||
      pageSize > 65536 ||
      pageSize & (pageSize - 1) ||
      (size - 32) % frameSize
    )
      throw Error('封存 WAL 页或长度无效，请重新取得一致副本。');
    const word = (b, i) => (magic === 0x377f0683 ? b.readUInt32BE(i) : b.readUInt32LE(i));
    let a = 0,
      b = 0;
    function sum(bytes) {
      for (let i = 0; i < bytes.length; i += 8) {
        a = (a + word(bytes, i) + b) >>> 0;
        b = (b + word(bytes, i + 4) + a) >>> 0;
      }
    }
    function check(bytes, offset) {
      if (bytes.readUInt32BE(offset) !== a || bytes.readUInt32BE(offset + 4) !== b)
        throw Error('封存 WAL 校验和不符。');
    }
    sum(header.subarray(0, 24));
    check(header, 24);
    const frame = Buffer.alloc(frameSize);
    for (let at = 32; at < size; at += frameSize) {
      if (
        fs.readSync(fd, frame) !== frameSize ||
        !frame.readUInt32BE(0) ||
        !header.subarray(16, 24).equals(frame.subarray(8, 16))
      )
        throw Error('封存 WAL 代际变化或尾页不完整，请重新导出。');
      sum(frame.subarray(0, 8));
      sum(frame.subarray(24));
      check(frame, 16);
    }
  } finally {
    fs.closeSync(fd);
  }
}
export async function readCopy(source, name, read) {
  const temp = directory(os.tmpdir()),
    space = fs.statfsSync(temp, { bigint: true });
  const bytes = source.files
    .filter((f) => [name, name + '-wal'].includes(f.relative))
    .reduce((sum, f) => sum + BigInt(f.size), 0n);
  if (space.bavail * space.bsize < 2n * bytes + 1048576n) throw Error('临时 SQLite/WAL 副本空间不足。');
  const scratch = fs.mkdtempSync(path.join(temp, 'cangxia-legacy-'));
  try {
    const file = path.join(scratch, 'copy.sqlite');
    for (const suffix of ['', '-wal']) {
      const entry = source.files.find((e) => e.relative === name + suffix);
      if (!entry) {
        if (!suffix) throw Error('数据库未封存。');
        continue;
      }
      fs.copyFileSync(child(source.directory, entry.relative), file + suffix, fs.constants.COPYFILE_EXCL);
      if ((await fileProof(file + suffix)).sha256 !== entry.sha256) throw Error('复制数据库期间输入变化。');
    }
    if (fs.existsSync(file + '-wal')) verifyWal(file + '-wal');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN');
      if (
        db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get()
      )
        throw Error('旧库一致性核验失败。');
      return read(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
