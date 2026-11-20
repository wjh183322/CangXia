
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { LIMITS, PROBE, ProbeError, SESSION } from './contracts.mjs';

const DIRECTORIES = ['state', 'media', 'staging', 'browser', 'reports'];
const BOOTSTRAP_FILES = new Set([
  'library.sqlite', 'library.sqlite-journal', 'library.sqlite-wal', 'library.sqlite-shm',
  'access.token', 'server.pem', 'server.key'
]);
const BOOTSTRAP_DATABASE = 'library.sqlite';
const BOOTSTRAP_DB_ENTRIES = new Set(['', '-journal', '-wal', '-shm'].map(suffix => BOOTSTRAP_DATABASE + suffix));
const HOST_BASE = '/volume2/docker/Cangxia-Feasibility-B';
const ARCHITECTURES = new Map([
  ['x86_64', 'amd64'], ['amd64', 'amd64'],
  ['aarch64', 'arm64'], ['arm64', 'arm64']
]);

function assertId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new ProbeError('INVALID_PROBE_ID', 'Probe run and library IDs must use lowercase letters, digits or hyphens.');
  }
}

function assertMode(mode) {
  if (mode !== PROBE.mode) {
    throw new ProbeError('INVALID_PROBE_MODE', 'Explicit feasibility mode is required.');
  }
}

function portNumber(value) {
  const port = typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 18443) {
    throw new ProbeError('INVALID_PROBE_PORT', 'Use an unprivileged test port distinct from the backup service port.');
  }
  return port;
}

function containerPort(value) {
  if (value !== PROBE.containerPort && value !== String(PROBE.containerPort)) {
    throw new ProbeError('INVALID_PROBE_PORT', 'The container API must use port 8443.');
  }
  return PROBE.containerPort;
}

export function readProbeConfig(env) {
  const {
    PROBE_MODE: mode, PROBE_ROOT: root, PROBE_RUN_ID: runId, PROBE_LIBRARY_ID: libraryId, PROBE_PORT: port
  } = env;
  assertMode(mode);
  if (root !== PROBE.root) {
    throw new ProbeError('UNSAFE_DATA_ROOT', 'The runtime probe root must be /probe.');
  }
  assertId(runId);
  assertId(libraryId);
  const accessHost = env.PROBE_ACCESS_HOST === undefined ? undefined : validateAccessHost(env.PROBE_ACCESS_HOST);
  return Object.freeze({ mode, root, runId, libraryId, port: containerPort(port), accessHost, limits: LIMITS, session: SESSION });
}

function foreignRoot() {
  return new ProbeError('FOREIGN_DATA_ROOT', 'The data root does not belong to this probe run and library.');
}

function unsafeRoot() {
  return new ProbeError('UNSAFE_DATA_ROOT', 'The data root or an entry cannot be inspected as a safe filesystem path.');
}

async function checkDirectoryTree(directory, root, links) {
  for (const name of await readdir(directory)) {
    const entry = path.join(directory, name);
    const stat = await lstat(entry, { bigint: true });
    if (stat.isDirectory()) await checkDirectoryTree(entry, root, links);
    else if (!stat.isFile() || (stat.nlink !== 1n && stat.nlink !== 2n)) throw unsafeRoot();
    else if (stat.nlink === 2n) {
      const relative = path.relative(root, entry).split(path.sep).join('/');
      const knownStaging = /^staging\/commits\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/payload\.(mp4|jpg|png|webp|avif|json)$/.test(relative);
      const knownMedia = /^media\/(?:[^/]+\/){2,3}[^/]+\.(mp4|jpg|png|webp|avif|json)$/.test(relative);
      if (!knownStaging && !knownMedia) throw unsafeRoot();
      const key = String(stat.dev) + ':' + String(stat.ino);
      const pair = links.get(key) ?? [];
      pair.push({ staged: knownStaging, extension: path.extname(name) });
      links.set(key, pair);
    }
  }
}

async function verifyMarker(markerPath, expected) {
  const stat = await lstat(markerPath);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512) throw foreignRoot();
  const file = await open(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev ||
        opened.ino !== stat.ino || opened.size !== stat.size) throw foreignRoot();
    const bytes = Buffer.alloc(513);
    const { bytesRead } = await file.read(bytes);
    if (bytesRead !== stat.size) throw foreignRoot();
    let marker;
    try {
      marker = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    } catch {
      throw foreignRoot();
    }
    if (!marker || Object.keys(marker).length !== Object.keys(expected).length ||
        !Object.entries(expected).every(([key, value]) => marker[key] === value)) {
      throw foreignRoot();
    }
  } finally {
    await file.close();
  }
}

function unsafeMount() {
  return new ProbeError('UNSAFE_PROBE_MOUNT', 'The probe requires one isolated, writable data mount.');
}

const MOUNT_ESCAPES = { '040': ' ', '011': '\t', '012': '\n', '134': '\\' };

export function assertIsolatedProbeMount(mountInfo) {
  if (typeof mountInfo !== 'string' || !mountInfo.endsWith('\n')) throw unsafeMount();

  // Linux mountinfo's fifth field is the mount point in the current namespace.
  let rootMounts = 0;
  for (const line of mountInfo.slice(0, -1).split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 10 || fields[fields.length - 4] !== '-' || fields.includes('') ||
        !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1]) || !/^\d+:\d+$/.test(fields[2]) ||
        !fields[3].startsWith('/') || !fields[4].startsWith('/') || /\\(?!040|011|012|134)/.test(fields[4])) {
      throw unsafeMount();
    }
    const point = fields[4].replace(/\\(040|011|012|134)/g, (_, escape) => MOUNT_ESCAPES[escape]);
    if (point.startsWith(PROBE.root + '/')) throw unsafeMount();
    if (point === PROBE.root) {
      if (!fields[5].split(',').includes('rw')) throw unsafeMount();
      rootMounts++;
    }
  }
  if (rootMounts !== 1) throw unsafeMount();
}

async function readRuntimeMountInfo() {
  try {
    return await readFile('/proc/self/mountinfo', 'utf8');
  } catch {
    throw unsafeMount();
  }
}

const bootstrapLayouts = new WeakMap();

export async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const file = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readBootstrapState(stamp) {
  if (!(await lstat(stamp)).isDirectory()) throw foreignRoot();
  const entries = await readdir(stamp);
  if (entries.includes('complete')) {
    const complete = path.join(stamp, 'complete');
    if (entries.length !== 1 || !(await lstat(complete)).isDirectory() ||
        (await readdir(complete)).length) throw foreignRoot();
    return true;
  }
  for (const entry of entries) {
    if (!BOOTSTRAP_DB_ENTRIES.has(entry)) throw foreignRoot();
    const stat = await lstat(path.join(stamp, entry));
    if (!stat.isFile() || stat.nlink !== 1) throw foreignRoot();
  }
  return false;
}

function assertRootEntries(entries, identity) {
  if (!entries.includes(identity) || entries.some(name => name !== identity && !DIRECTORIES.includes(name))) {
    throw foreignRoot();
  }
}

export async function bootstrapDatabasePath(layout) {
  const stamp = bootstrapLayouts.get(layout);
  if (!stamp) return null;
  assertRootEntries(await readdir(layout.root), path.basename(stamp));
  if (await readBootstrapState(stamp)) return null;
  for (const name of DIRECTORIES) {
    const entries = await readdir(layout[name], { withFileTypes: true });
    if (entries.some(entry => name !== 'state' || !BOOTSTRAP_FILES.has(entry.name) || !entry.isFile())) {
      throw foreignRoot();
    }
  }
  return path.join(stamp, BOOTSTRAP_DATABASE);
}

export async function completeDataRootBootstrap(layout) {
  const stamp = bootstrapLayouts.get(layout);
  if ((await readdir(stamp)).length) throw foreignRoot();
  await syncDirectory(layout.state);
  await mkdir(path.join(stamp, 'complete'), { mode: 0o700 });
  await syncDirectory(stamp);
}

export async function prepareDataRoot(config, { fixtureRoot, fixtureMountInfo } = {}) {
  const { mode, root, runId, libraryId, port } = config;
  assertMode(mode);
  assertId(runId);
  assertId(libraryId);
  containerPort(port);
  // Fixture paths are supplied directly by test code. Runtime configuration only admits /probe.
  if ((fixtureRoot === undefined && process.platform !== 'linux') ||
      root !== (fixtureRoot ?? PROBE.root) || !path.isAbsolute(root) ||
      path.normalize(root) !== root || path.parse(root).root === root) {
    throw unsafeRoot();
  }

  if (fixtureRoot === undefined) {
    assertIsolatedProbeMount(await readRuntimeMountInfo());
  } else if (fixtureMountInfo !== undefined) {
    assertIsolatedProbeMount(fixtureMountInfo);
  }

  const layout = { root };
  const markerPath = path.join(root, PROBE.marker);
  const marker = { service: PROBE.service, version: PROBE.markerVersion, runId, libraryId };
  // The name claims the exact identity in one filesystem operation, even if startup exits immediately.
  const stampName = '.' + PROBE.service + '.bootstrap-v' + PROBE.markerVersion + '.' + runId + '.' + libraryId;
  const stamp = path.join(root, stampName);
  let entries;
  try {
    const ancestors = [];
    for (let current = root; current !== path.parse(current).root; current = path.dirname(current)) {
      ancestors.unshift(current);
    }
    for (const directory of ancestors) {
      if (!(await lstat(directory)).isDirectory()) throw unsafeRoot();
    }
    entries = await readdir(root);
    if (entries.length) {
      const legacy = entries.includes(PROBE.marker);
      const identity = legacy ? PROBE.marker : stampName;
      assertRootEntries(entries, identity);
      if (legacy) await verifyMarker(markerPath, marker);
      else await readBootstrapState(stamp);
    }
    const links = new Map();
    for (const name of DIRECTORIES) {
      layout[name] = path.join(root, name);
      if (!entries.includes(name)) continue;
      if (!(await lstat(layout[name])).isDirectory()) throw unsafeRoot();
      // Chromium manages transient singleton artifacts inside its profile.
      if (name !== 'browser') await checkDirectoryTree(layout[name], root, links);
    }
    // A crash can leave both names from a no-clobber placement. The probe
    // checks the journal and recorded digest before it accepts either as media.
    for (const pair of links.values()) {
      if (pair.length !== 2 || pair[0].staged === pair[1].staged ||
          pair[0].extension !== pair[1].extension) throw unsafeRoot();
    }
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw unsafeRoot();
  }

  try {
    if (!entries.length) {
      await mkdir(stamp, { mode: 0o700 });
      assertRootEntries(await readdir(root), stampName);
      await syncDirectory(root);
    }
    for (const name of DIRECTORIES) {
      if (!entries.includes(name)) {
        await mkdir(layout[name], { mode: 0o700 });
      }
    }
    if (DIRECTORIES.some(name => !entries.includes(name))) await syncDirectory(root);
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError('DATA_ROOT_INITIALIZATION_FAILED', 'Probe data root initialization failed.');
  }
  if (!entries.includes(PROBE.marker)) bootstrapLayouts.set(layout, stamp);
  return Object.freeze(layout);
}

function isLanAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 6) return /^f[cd]/i.test(address);
  if (family !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export function validateAccessHost(value) {
  if (isLanAddress(value)) return value;
  // Local DNS only. No wildcard, port, URL, resolver search sequence, or OpenSSL option syntax.
  if (typeof value === 'string' && value.length <= 253 && !value.toLowerCase().startsWith('localhost') &&
      /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.local|\.home\.arpa)?$/i.test(value)) {
    return value.toLowerCase();
  }
  throw new ProbeError('INVALID_PROBE_ACCESS_HOST', 'A verified private address or local DNS name is required.');
}

export function validateDeployment(input) {
  input ??= {};
  const required = ['runId', 'hostPath', 'lanAddress', 'hostPort', 'portAvailable', 'uid', 'gid', 'arch',
    'resources', 'mounts'];
  const missing = required.filter(name => input[name] == null || input[name] === '');
  for (const field of ['cpus', 'memoryBytes', 'shmBytes']) {
    if (input.resources && input.resources[field] == null) missing.push('resources.' + field);
  }
  if (missing.length) {
    throw new ProbeError('ENV_INPUT_REQUIRED', 'Collect the required NAS deployment inputs.', { missing });
  }

  const { runId, hostPath, lanAddress, uid, gid, resources, mounts } = input;
  assertId(runId);
  if (hostPath !== HOST_BASE + '/' + runId) {
    throw new ProbeError('UNSAFE_HOST_PATH', 'The host path must be the dedicated directory for this probe run.');
  }
  const hostPort = portNumber(input.hostPort);
  if (input.portAvailable !== true) {
    throw new ProbeError('PROBE_PORT_OCCUPIED', 'The test port must be confirmed available on the NAS.');
  }
  if (!isLanAddress(lanAddress)) {
    throw new ProbeError('INVALID_LAN_ADDRESS', 'An explicit private LAN address is required.');
  }
  if ([uid, gid].some(value => !Number.isInteger(value) || value < 1 || value > 0xfffffffe)) {
    throw new ProbeError('INVALID_PROBE_IDENTITY', 'The NAS probe requires a positive numeric UID and GID.');
  }
  const arch = ARCHITECTURES.get(input.arch);
  if (!arch) throw new ProbeError('UNSUPPORTED_ARCH', 'The NAS architecture must be amd64 or arm64.');

  const { cpus, memoryBytes, shmBytes } = resources;
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > LIMITS.cpus ||
      !Number.isInteger(memoryBytes) || memoryBytes <= 0 || memoryBytes > LIMITS.memoryBytes ||
      !Number.isInteger(shmBytes) || shmBytes <= 0 || shmBytes > LIMITS.shmBytes || shmBytes > memoryBytes) {
    throw new ProbeError('INVALID_PROBE_RESOURCES', 'Container resources must stay within the probe ceilings.');
  }

  // Supply actual mount evidence from NAS inspection. The container cannot resolve the host path.
  const mount = Array.isArray(mounts) && mounts.length === 1 ? mounts[0] : null;
  if (!mount || mount.type !== 'bind' || mount.source !== hostPath || mount.canonicalSource !== hostPath ||
      mount.target !== PROBE.root || mount.readOnly !== false) {
    throw new ProbeError('UNSAFE_HOST_MOUNT', 'The probe accepts one confirmed writable bind to the dedicated runtime root.');
  }
  const verifiedMount = {
    type: mount.type, source: mount.source, canonicalSource: mount.canonicalSource,
    target: mount.target, readOnly: mount.readOnly
  };
  return Object.freeze({
    runId, hostPath, lanAddress, hostPort, containerPort: PROBE.containerPort, uid, gid, arch,
    resources: Object.freeze({ cpus, memoryBytes, shmBytes }),
    mounts: Object.freeze([Object.freeze(verifiedMount)])
  });
}
