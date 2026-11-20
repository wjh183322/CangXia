
import assert from 'node:assert/strict';
import { link, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PROBE, LIMITS, SESSION } from '../src/contracts.mjs';
import { assertIsolatedProbeMount, prepareDataRoot, readProbeConfig, validateDeployment } from '../src/config.mjs';
import { redact } from '../src/redact.mjs';
import { makeSandbox } from './helpers.mjs';

const env = {
  PROBE_MODE: 'feasibility',
  PROBE_ROOT: '/probe',
  PROBE_RUN_ID: 'fixture-run',
  PROBE_LIBRARY_ID: 'fixture-library',
  PROBE_PORT: '8443'
};
const hostPath = '/volume2/docker/Cangxia-Feasibility-B/fixture-run';
const evidence = {
  type: 'bind', source: hostPath, canonicalSource: hostPath, target: '/probe', readOnly: false
};
const deployment = {
  runId: env.PROBE_RUN_ID,
  hostPath,
  lanAddress: '192.168.1.2',
  hostPort: 24443,
  portAvailable: true,
  uid: 1000,
  gid: 1000,
  arch: 'x86_64',
  resources: { cpus: 2, memoryBytes: 2 ** 31, shmBytes: 2 ** 29 },
  mounts: [evidence]
};

test('loads explicit probe identity with fixed safety limits', () => {
  const config = readProbeConfig(env);
  assert.equal(config.root, '/probe');
  assert.equal(config.port, 8443);
  assert.equal(config.runId, 'fixture-run');
  assert.equal(config.libraryId, 'fixture-library');
  assert.deepEqual(config.limits, LIMITS);
  assert.deepEqual(config.session, SESSION);
  assert.deepEqual(Object.values(LIMITS), [2, 2 ** 31, 2 ** 29, 20, 300, 2, 2 ** 30]);
  assert.deepEqual(Object.values(SESSION), [5000, 3000, 20000]);
  assert.equal(PROBE.service, 'cangxia-server-probe');
});

test('rejects implicit/production modes, ambiguous roots and invalid identifiers before writing', () => {
  for (const PROBE_MODE of [undefined, 'production', 'test', 'FEASIBILITY']) {
    assert.throws(() => readProbeConfig({ ...env, PROBE_MODE }), { code: 'INVALID_PROBE_MODE' });
  }
  for (const PROBE_ROOT of ['probe', '/probe/..', '/probe/../data', '/Probe', '/data', 'C:\\probe']) {
    assert.throws(() => readProbeConfig({ ...env, PROBE_ROOT }), { code: 'UNSAFE_DATA_ROOT' });
  }
  assert.throws(() => readProbeConfig({ ...env, PROBE_RUN_ID: '../fixture' }), { code: 'INVALID_PROBE_ID' });
  assert.throws(() => readProbeConfig({ ...env, PROBE_PORT: '18443' }), { code: 'INVALID_PROBE_PORT' });
});

test('requires the fixed container port and keeps host port independent', async t => {
  for (const PROBE_PORT of ['8444', '24443', '08443', undefined]) {
    assert.throws(() => readProbeConfig({ ...env, PROBE_PORT }), { code: 'INVALID_PROBE_PORT' });
  }
  const sandbox = await makeSandbox(t);
  await assert.rejects(sandbox.prepare({ port: 8444 }), { code: 'INVALID_PROBE_PORT' });
  await sandbox.assertUninitialized();
  assert.equal(validateDeployment({ ...deployment, hostPort: 24444 }).hostPort, 24444);
});

const mainMount = '20 19 0:42 / / rw,relatime - overlay overlay rw';
const probeMount = '21 20 8:9 /isolated-run /probe rw,nosuid - ext4 /dev/test rw';
const siblingMount = '22 20 8:9 /other /probe-other rw shared:7 - ext4 /dev/test rw';
const nestedMount = String.raw`23 21 8:9 /foreign /probe/browser/folder\040name rw - ext4 /dev/test rw`;
const mountInfo = (...lines) => lines.join('\n') + '\n';

test('requires one dedicated mount and denies nested and stacked mounts, including same-device binds', () => {
  assert.doesNotThrow(() => assertIsolatedProbeMount(mountInfo(mainMount, probeMount, siblingMount)));
  for (const info of [
    undefined,
    '',
    probeMount,
    mountInfo(mainMount, siblingMount),
    mountInfo(mainMount, probeMount.replace('rw,nosuid', 'ro,nosuid')),
    mountInfo(mainMount, probeMount, nestedMount),
    mountInfo(mainMount, probeMount, '24 21 8:9 /stacked /probe rw - ext4 /dev/test rw'),
    mountInfo(mainMount, probeMount, 'malformed unrelated row')
  ]) {
    assert.throws(() => assertIsolatedProbeMount(info), { code: 'UNSAFE_PROBE_MOUNT' });
  }
});

test('runtime mount preflight rejects unsafe mount data before creating the marker or layout', async t => {
  const sandbox = await makeSandbox(t);
  await assert.rejects(
    prepareDataRoot(sandbox.config, {
      fixtureRoot: sandbox.root,
      fixtureMountInfo: mountInfo(mainMount, probeMount, nestedMount)
    }),
    { code: 'UNSAFE_PROBE_MOUNT' }
  );
  assert.equal(await sandbox.exists(PROBE.marker), false);
  await sandbox.assertUninitialized();
});

test('foreign root is rejected before any initialization', async t => {
  const sandbox = await makeSandbox(t);
  await sandbox.write('foreign.sqlite', 'owned fixture');
  await assert.rejects(sandbox.prepare(), { code: 'FOREIGN_DATA_ROOT' });
  await sandbox.assertUninitialized();
  assert.equal(await sandbox.read('foreign.sqlite'), 'owned fixture');
});

test('malformed and case-aliased markers cannot claim directories', async t => {
  const sandbox = await makeSandbox(t);
  await sandbox.write(PROBE.marker.toUpperCase(), '{}');
  await assert.rejects(sandbox.prepare(), { code: 'FOREIGN_DATA_ROOT' });
  await sandbox.assertUninitialized();

  const malformed = await makeSandbox(t);
  await malformed.write(PROBE.marker, '{malformed');
  await assert.rejects(malformed.prepare(), { code: 'FOREIGN_DATA_ROOT' });
  await malformed.assertUninitialized();
});

test('unsafe layout preflight leaves missing directories untouched', async t => {
  const sandbox = await makeSandbox(t);
  const sibling = await makeSandbox(t);
  await sandbox.write(PROBE.marker, JSON.stringify({
    service: PROBE.service, version: 1, runId: sandbox.config.runId, libraryId: sandbox.config.libraryId
  }));
  await symlink(sibling.root, path.join(sandbox.root, 'reports'), 'junction');
  await assert.rejects(sandbox.prepare(), { code: 'UNSAFE_DATA_ROOT' });
  assert.equal(await sandbox.exists('state'), false);
  assert.equal(await sandbox.exists('browser'), false);
  assert.equal(await sibling.exists('state'), false);
});

test('links and junctions at the root and its ancestors are rejected', async t => {
  const sandbox = await makeSandbox(t);
  const sibling = await makeSandbox(t);
  const alias = path.join(sibling.root, 'link');
  await symlink(sandbox.root, alias, 'junction');
  for (const root of [alias, path.join(alias, 'missing')]) {
    await assert.rejects(
      prepareDataRoot({ ...sandbox.config, root }, { fixtureRoot: root }),
      { code: 'UNSAFE_DATA_ROOT' }
    );
  }
  await sandbox.assertUninitialized();
});

test('resumes only the same probe library and keeps existing content', async t => {
  const sandbox = await makeSandbox(t);
  const layout = await sandbox.prepare();
  assert.deepEqual(Object.keys(layout), ['root', 'state', 'media', 'staging', 'browser', 'reports']);
  await sandbox.write('state/library.sqlite', 'existing fixture');
  const entriesBefore = await readdir(sandbox.root);
  assert.deepEqual(await sandbox.prepare(), layout);
  assert.equal(await sandbox.read('state/library.sqlite'), 'existing fixture');
  for (const change of [{ runId: 'another-run' }, { libraryId: 'another-library' }]) {
    await assert.rejects(sandbox.prepare(change), { code: 'FOREIGN_DATA_ROOT' });
  }
  assert.deepEqual(await readdir(sandbox.root), entriesBefore);
  assert.equal(await sandbox.read('state/library.sqlite'), 'existing fixture');
});

test('rejects layout letter-case aliases and extra root entries', async t => {
  const sandbox = await makeSandbox(t);
  await sandbox.write(PROBE.marker, JSON.stringify({
    service: PROBE.service, version: 1, runId: sandbox.config.runId, libraryId: sandbox.config.libraryId
  }));
  await sandbox.write('STATE/library.sqlite', 'wrong case');
  await assert.rejects(sandbox.prepare(), { code: 'FOREIGN_DATA_ROOT' });
  assert.equal(await sandbox.exists('reports'), false);

  const identified = await makeSandbox(t);
  await identified.prepare();
  await identified.write('foreign.txt', 'fixture');
  await assert.rejects(identified.prepare(), { code: 'FOREIGN_DATA_ROOT' });
});

test('rejects links in the marker and managed data trees', async t => {
  const sandbox = await makeSandbox(t);
  const sibling = await makeSandbox(t);
  await symlink(sibling.root, path.join(sandbox.root, PROBE.marker), 'junction');
  await assert.rejects(sandbox.prepare(), { code: 'FOREIGN_DATA_ROOT' });
  await sandbox.assertUninitialized();

  const identified = await makeSandbox(t);
  const layout = await identified.prepare();
  await sibling.write('existing.sqlite', 'fixture');
  await link(path.join(sibling.root, 'existing.sqlite'), path.join(layout.state, 'library.sqlite'));
  await assert.rejects(identified.prepare(), { code: 'UNSAFE_DATA_ROOT' });
  assert.equal(await sibling.read('existing.sqlite'), 'fixture');
});

test('leaves browser-internal artifact inspection to the browser owner', async t => {
  const sandbox = await makeSandbox(t);
  const layout = await sandbox.prepare();
  await symlink(layout.browser, path.join(layout.browser, 'SingletonSocket'), 'junction');
  assert.deepEqual(await sandbox.prepare(), layout);
});

test('validates host scope and independent observed mount evidence', () => {
  const result = validateDeployment(deployment);
  assert.equal(result.arch, 'amd64');
  assert.equal(result.hostPath, hostPath);
  assert.equal(result.hostPort, 24443);
  assert.equal(result.containerPort, 8443);
  assert.deepEqual(result.mounts, [evidence]);
  assert.equal(validateDeployment({ ...deployment, arch: 'aarch64' }).arch, 'arm64');

  for (const unsafe of [
    '/', '/volume2/docker/Cangxia-Backup/data', '/volume2/docker/Cangxia-Server/data',
    '/volume2/docker/cangxia-feasibility-b/fixture-run',
    '/volume2/docker/Cangxia-Feasibility-B/elsewhere', hostPath + '/../fixture-run',
    hostPath.slice(1)
  ]) {
    assert.throws(() => validateDeployment({ ...deployment, hostPath: unsafe }), { code: 'UNSAFE_HOST_PATH' });
  }

  for (const mounts of [
    [{ ...evidence, canonicalSource: '/volume2/docker/Cangxia-Backup/data' }],
    [{ ...evidence, target: '/data' }],
    [{ ...evidence, readOnly: true }],
    [evidence, { type: 'bind', source: '/' }]
  ]) {
    assert.throws(() => validateDeployment({ ...deployment, mounts }), { code: 'UNSAFE_HOST_MOUNT' });
  }
});

test('requires explicit host UID/GID, architecture, address, port and resource inputs', () => {
  assert.throws(
    () => validateDeployment({ runId: env.PROBE_RUN_ID }),
    error => error.code === 'ENV_INPUT_REQUIRED' &&
      ['uid', 'gid', 'arch', 'hostPort', 'portAvailable', 'resources', 'mounts']
        .every(field => error.details.missing.includes(field))
  );
  assert.throws(() => validateDeployment({ ...deployment, uid: 0 }), { code: 'INVALID_PROBE_IDENTITY' });
  assert.throws(() => validateDeployment({ ...deployment, gid: 0 }), { code: 'INVALID_PROBE_IDENTITY' });
  assert.throws(() => validateDeployment({ ...deployment, arch: 'unknown' }), { code: 'UNSUPPORTED_ARCH' });
  assert.throws(() => validateDeployment({ ...deployment, hostPort: 18443 }), { code: 'INVALID_PROBE_PORT' });
  assert.throws(() => validateDeployment({ ...deployment, portAvailable: false }), { code: 'PROBE_PORT_OCCUPIED' });
  assert.throws(() => validateDeployment({ ...deployment, lanAddress: '0.0.0.0' }), { code: 'INVALID_LAN_ADDRESS' });
  assert.throws(() => validateDeployment({ ...deployment, resources: { ...deployment.resources, cpus: 3 } }),
    { code: 'INVALID_PROBE_RESOURCES' });
});

test('redacts structured secrets and common secret-bearing strings', () => {
  const result = redact({
    status: 'observed', count: 2, sample: null,
    cookie: 'sensitive-cookie', details: [{ accessKey: 'sensitive-access', proof: 'sensitive-proof' }],
    sourceResponse: { marker: 'sensitive-response' }, hostPath: '/sentinel/private',
    body: { arbitrary: 'synthetic-request-body' }, qrFrame: 'synthetic-frame',
    messages: [
      'GET https://guest:password@source.invalid/download?msToken=sensitive-url#frag',
      'Authorization: Bearer sensitive-header\nrequest accepted',
      '-----BEGIN PRIVATE KEY-----\nsensitive-pem\n-----END PRIVATE KEY-----',
      'fs error C:\\Users\\sensitive-folder\\media',
      '{"set-cookie":"sensitive-json; Secure"}',
      'password: synthetic-password',
      'proxy-authorization=synthetic-header'
    ]
  });
  assert.equal(result.status, 'observed');
  assert.equal(result.count, 2);
  assert.equal(result.sample, null);
  assert.match(result.messages[1], /request accepted/);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-|guest|password@|sentinel\/private|msToken|synthetic-/);
});
test('reads only private IP or local DNS as the TLS access host',()=>{
  for(const address of ['10.42.0.19','fd12::5','storage','Server-NAS.local','media.home.arpa']){
    assert.equal(readProbeConfig({...env,PROBE_ACCESS_HOST:address}).accessHost,address.toLowerCase());
  }
  for(const address of ['example.org','8.8.8.8','169.254.3.9','0.0.0.0','::1','localhost','bad_host.local','foo.local:443']){
    assert.throws(()=>readProbeConfig({...env,PROBE_ACCESS_HOST:address}),{code:'INVALID_PROBE_ACCESS_HOST'});
  }
});
