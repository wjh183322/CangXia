
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { LIMITS, PROBE, ProbeError, SESSION } from './contracts.mjs';

const DIRECTORIES = ['state', 'media', 'staging', 'browser', 'reports'];
const ALLOWED_ROOT_ENTRIES = new Set([PROBE.marker, ...DIRECTORIES]);
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
  return Object.freeze({ mode, root, runId, libraryId, port: portNumber(port), limits: LIMITS, session: SESSION });
}

function foreignRoot() {
  return new ProbeError('FOREIGN_DATA_ROOT', 'The data root does not belong to this probe run and library.');
}

function unsafeRoot() {
  return new ProbeError('UNSAFE_DATA_ROOT', 'The data root or an entry cannot be inspected as a safe filesystem path.');
}

async function checkDirectoryTree(directory) {
  for (const name of await readdir(directory)) {
    const entry = path.join(directory, name);
    const stat = await lstat(entry);
    if (stat.isDirectory()) await checkDirectoryTree(entry);
    else if (!stat.isFile() || stat.nlink !== 1) throw unsafeRoot();
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

export async function prepareDataRoot(config, { fixtureRoot } = {}) {
  const { mode, root, runId, libraryId, port } = config;
  assertMode(mode);
  assertId(runId);
  assertId(libraryId);
  portNumber(port);
  // Fixture paths are supplied directly by test code. Runtime configuration only admits /probe.
  if ((fixtureRoot === undefined && process.platform !== 'linux') ||
      root !== (fixtureRoot ?? PROBE.root) || !path.isAbsolute(root) ||
      path.normalize(root) !== root || path.parse(root).root === root) {
    throw unsafeRoot();
  }

  const layout = { root };
  const markerPath = path.join(root, PROBE.marker);
  const marker = { service: PROBE.service, version: PROBE.markerVersion, runId, libraryId };
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
      if (!entries.includes(PROBE.marker) || entries.some(name => !ALLOWED_ROOT_ENTRIES.has(name))) {
        throw foreignRoot();
      }
      await verifyMarker(markerPath, marker);
    }
    for (const name of DIRECTORIES) {
      layout[name] = path.join(root, name);
      if (!entries.includes(name)) continue;
      if (!(await lstat(layout[name])).isDirectory()) throw unsafeRoot();
      // Chromium manages transient singleton artifacts inside its profile.
      if (name !== 'browser') await checkDirectoryTree(layout[name]);
    }
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw unsafeRoot();
  }

  try {
    if (!entries.length) {
      const file = await open(markerPath, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(marker) + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
    }
    for (const name of DIRECTORIES) {
      if (!entries.includes(name)) {
        await mkdir(layout[name], { mode: 0o700 });
      }
    }
  } catch {
    throw new ProbeError('DATA_ROOT_INITIALIZATION_FAILED', 'Probe data root initialization failed.');
  }
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
