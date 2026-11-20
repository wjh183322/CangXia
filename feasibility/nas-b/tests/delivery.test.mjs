
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BASE_IMAGE, IMAGE_REPOSITORY, IMAGE_SOURCE, PROJECT_ROOT, RUNTIME_FILES,
  auditImageManifest, validateImageInputs
} from '../scripts/image-inputs.mjs';
import { renderDeployment } from '../render-deployment.mjs';

const revision = 'a'.repeat(40);
const digest = 'sha256:' + 'b'.repeat(64);
const hostPath = '/volume2/docker/Cangxia-Feasibility-B/test-slot';
const image = {
  arch: 'amd64', revision, digest, repository: 'ghcr.io/wjh183322/cangxia-server-probe',
  source: 'https://github.com/wjh183322/CangXia', tag: '0.4.0-alpha.1-' + revision.slice(0, 12),
  visibility: 'private', visibilityConfirmed: true, pullVerified: true, audited: true
};
const environment = {
  runId: 'test-slot', libraryId: 'test-library', hostPath, lanAddress: '192.168.100.10',
  accessHost: 'test-nas.local', hostPort: 28443, portAvailable: true, slotVerified: true,
  uid: 2468, gid: 3691, arch: 'x86_64', resources: { cpus: 2, memoryBytes: 2147483648, shmBytes: 536870912 },
  mounts: [{ type: 'bind', source: hostPath, canonicalSource: hostPath, target: '/probe', readOnly: false }]
};

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

test('DEPLOY-01 build pins the official amd64 manifest and complete runtime', () => {
  const inputs = validateImageInputs({ arch: 'amd64', revision, baseDigest: BASE_IMAGE.split('@')[1] });
  assert.equal(inputs.baseImage, 'mcr.microsoft.com/playwright:v1.65.1-noble@sha256:766137e2d9caad4744187e53cdc89320ba6f2eb57cff097374020944b44dd0a9');
  assert.equal(inputs.repository, IMAGE_REPOSITORY);
  assert.equal(inputs.source, IMAGE_SOURCE);
  assert.equal(inputs.tag, image.tag);
  assert.throws(() => validateImageInputs({ revision }), { code: 'IMAGE_INPUT_REQUIRED' });
  assert.throws(() => validateImageInputs({ arch: 'arm64', revision, baseDigest: BASE_IMAGE.split('@')[1] }),
    { code: 'UNSUPPORTED_IMAGE_ARCH' });
  assert.throws(() => validateImageInputs({ arch: 'amd64', revision, baseDigest: digest }),
    { code: 'UNVERIFIED_IMAGE_BASE' });

  const dockerfile = source('../Dockerfile');
  for (const marker of [inputs.baseImage, 'npm ci --omit=dev --ignore-scripts', 'python3.12', 'ffmpeg', 'ffprobe',
    'openssl', 'xvfb', 'node:sqlite', '--only-binary=:all:', '--require-hashes', 'USER 1000:1000',
    'HEALTHCHECK', 'cover-frame-test.py']) {
    assert.ok(dockerfile.includes(marker), 'missing Dockerfile requirement: ' + marker);
  }
  const locks = source('../cover-runtime.lock');
  assert.match(locks, /numpy==2\.2\.6[\s\\]+--hash=sha256:[a-f0-9]{64}/);
  assert.match(locks, /opencv-python-headless==4\.11\.0\.86[\s\\]+--hash=sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /source=tests\/cover-frame-test[.]py,target=\/opt\/cangxia\/scripts\/cover-frame-test[.]py/);
  assert.match(dockerfile, /python \/opt\/cangxia\/scripts\/cover-frame-test[.]py/);
  assert.doesNotMatch(dockerfile + locks, /pyinstaller|npm run start/i);
  assert.doesNotMatch(source('../nas-entrypoint.sh'), /\b(?:npm|pip|apt|getent|curl)\b/);
});

test('DEPLOY-02 only renders the verified project, identity, exact binding, and independent test mount', () => {
  const result = renderDeployment({ environment, image, runId: environment.runId });
  const { compose, operatorNotes, requiredFiles } = result;
  assert.match(compose, /image: "ghcr\.io\/wjh183322\/cangxia-server-probe:0\.4\.0-alpha\.1-aaaaaaaaaaaa@sha256:b+"/);
  assert.match(compose, /\n    user: "2468:3691"/);
  assert.match(compose, /\n      - "192\.168\.100\.10:28443:8443"/);
  assert.match(compose, /\n        source: "\/volume2\/docker\/Cangxia-Feasibility-B\/test-slot"/);
  assert.match(compose, /\n        target: \/probe\n/);
  assert.match(compose, /\n        bind:\n          create_host_path: false\n/);
  assert.match(compose, /\n      PROBE_ACCESS_HOST: "test-nas\.local"/);
  assert.match(compose, /\n    shm_size: "536870912b"/);
  assert.match(compose, /\n    read_only: true/);
  assert.equal(compose.match(/\n  [a-z-]+:\n/g)?.length, 1);
  assert.equal(compose.match(/\n      - type: bind\n/g)?.length, 1);
  assert.doesNotMatch(compose, /\b(?:build|command|entrypoint|network_mode|ipc|privileged|env_file):|docker\.sock|seccomp=unconfined|latest|npm/);
  assert.match(operatorNotes, /https:\/\/test-nas\.local:28443/);
  assert.match(operatorNotes, /\/probe\/state\/access\.token/);
  assert.match(operatorNotes, /只读/);
  assert.ok(requiredFiles.some(file => file.name === 'chromium-seccomp.json' && file.content.includes('SCMP_ACT_ERRNO')));
  assert.ok(requiredFiles.some(file => file.name === 'chromium-seccomp.LICENSE'));
  assert.match(compose, /seccomp=\.\/chromium-seccomp\.json/);

  for (const [changes, code] of [
    [{ uid: undefined }, 'ENV_INPUT_REQUIRED'],
    [{ uid: 0 }, 'INVALID_PROBE_IDENTITY'],
    [{ portAvailable: false }, 'PROBE_PORT_OCCUPIED'],
    [{ accessHost: undefined }, 'ENV_INPUT_REQUIRED'],
    [{ accessHost: 'example.com' }, 'INVALID_PROBE_ACCESS_HOST'],
    [{ accessHost: '192.168.100.11' }, 'DEPLOYMENT_ACCESS_HOST_MISMATCH'],
    [{ slotVerified: false }, 'DEPLOYMENT_SLOT_UNVERIFIED'],
    [{ hostPath: '/volume1/production' }, 'UNSAFE_HOST_PATH'],
    [{ mounts: [...environment.mounts, { source: '/var/run/docker.sock', target: '/var/run/docker.sock' }] }, 'UNSAFE_HOST_MOUNT'],
    [{ arch: 'aarch64' }, 'IMAGE_ARCH_MISMATCH']
  ]) {
    assert.throws(() => renderDeployment({ environment: { ...environment, ...changes }, image, runId: environment.runId }), { code });
  }
  assert.throws(() => renderDeployment({ environment, image, runId: 'other-run' }), { code: 'DEPLOYMENT_RUN_MISMATCH' });
});

test('DEPLOY-03 requires the official reviewed registry release and visibility-specific pull verification', () => {
  for (const [changes, code] of [
    [{ digest: undefined }, 'RELEASE_INPUT_REQUIRED'],
    [{ digest: 'sha256:invalid' }, 'UNVERIFIED_IMAGE_RELEASE'],
    [{ repository: 'ghcr.io/another/other' }, 'UNVERIFIED_IMAGE_RELEASE'],
    [{ source: 'https://example.com/other' }, 'UNVERIFIED_IMAGE_RELEASE'],
    [{ tag: 'latest' }, 'UNVERIFIED_IMAGE_RELEASE'],
    [{ visibility: undefined }, 'RELEASE_INPUT_REQUIRED'],
    [{ visibilityConfirmed: false }, 'IMAGE_VISIBILITY_UNVERIFIED'],
    [{ pullVerified: false }, 'IMAGE_PULL_UNVERIFIED'],
    [{ audited: false }, 'IMAGE_AUDIT_UNVERIFIED']
  ]) {
    assert.throws(() => renderDeployment({ environment, image: { ...image, ...changes }, runId: environment.runId }), { code });
  }
  const publicRelease = renderDeployment({ environment, image: { ...image, visibility: 'public' }, runId: environment.runId });
  assert.match(publicRelease.operatorNotes, /匿名/);
});

test('DEPLOY-03 context allowlist and content audit exclude secrets, old app, and real data', () => {
  const ignore = source('../Dockerfile.dockerignore').trim().split(/\r?\n/).filter(line => !line.startsWith('#') && line);
  assert.equal(ignore[0], '**');
  assert.ok(ignore.slice(1).every(line => line.startsWith('!')));
  assert.deepEqual(ignore.slice(1).map(line => line.slice(1)).sort(), [...RUNTIME_FILES, 'tests/cover-frame-test.py'].sort());
  const paths = RUNTIME_FILES.map(file => PROJECT_ROOT + '/' + file);
  paths.push('usr/bin/node', 'usr/bin/Xvfb', 'usr/bin/ffmpeg', 'usr/bin/ffprobe', 'usr/bin/openssl',
    'usr/bin/python3.12', 'opt/cover-runtime/bin/python',
    PROJECT_ROOT + '/feasibility/nas-b/node_modules/playwright-core/LICENSE',
    PROJECT_ROOT + '/feasibility/nas-b/node_modules/jsonc-parser/LICENSE.md',
    PROJECT_ROOT + '/feasibility/nas-b/node_modules/.bin/playwright-core');
  const manifest = { paths };
  assert.equal(auditImageManifest(manifest).ok, true);
  assert.equal(auditImageManifest(manifest).unexpectedGoldenMountParent, false);
  const undisclosed = PROJECT_ROOT + '/ci-unknown/fixture-private-name';
  const oldGoldenMountParent = auditImageManifest({ paths: [...paths, './' + PROJECT_ROOT + '/tests/', undisclosed] });
  assert.equal(oldGoldenMountParent.ok, false);
  assert.equal(oldGoldenMountParent.unexpectedFileCount, 2);
  assert.equal(oldGoldenMountParent.unexpectedProjectFileCount, 2);
  assert.equal(oldGoldenMountParent.unexpectedGoldenMountParent, true);
  assert.ok(!JSON.stringify(oldGoldenMountParent).includes(undisclosed));
  for (const extra of [
    PROJECT_ROOT + '/.evidence/run/private.json', PROJECT_ROOT + '/backup-server/index.mjs',
    PROJECT_ROOT + '/tests/auth.json', PROJECT_ROOT + '/feasibility/nas-b/node_modules/playwright-core/.env',
    'probe/state/access.token', 'probe/browser/Cookies', 'tmp/media/example.mp4', 'root/.ssh/id_rsa'
  ]) {
    assert.equal(auditImageManifest({ paths: [...paths, extra] }).ok, false, extra);
  }
  assert.equal(auditImageManifest({ paths: paths.slice(1) }).ok, false);
  assert.deepEqual(auditImageManifest({ paths, inspect: { Os: 'linux', Architecture: 'arm64' },
    inputs: validateImageInputs({ arch: 'amd64', baseDigest: BASE_IMAGE.split('@')[1], revision }) }).problems,
  ['IMAGE_METADATA_MISMATCH', 'IMAGE_LAYERS_MISMATCH']);

  const seccomp = JSON.parse(source('../chromium-seccomp.json'));
  assert.equal(seccomp.defaultAction, 'SCMP_ACT_ERRNO');
  assert.deepEqual(seccomp.syscalls[0].names, ['clone', 'setns', 'unshare']);

  const workflow = source('../../../.github/workflows/server-probe.yml');
  assert.match(workflow, /branches: \[codex\/server-edition\]/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /audit_image_layers[.]py/);
  assert.match(workflow, /Local build exporter digest/);
  assert.doesNotMatch(workflow, /workflow_dispatch|packages: write|docker (?:push|login)|upload-artifact|backup-v/);
});

test('DEPLOY-01 the probe can install TLS test dependencies independently of the desktop package', () => {
  const pkg = JSON.parse(source('../package.json'));
  const lock = JSON.parse(source('../package-lock.json'));
  assert.equal(pkg.devDependencies?.selfsigned, '5.5.0');
  assert.equal(lock.packages[''].devDependencies?.selfsigned, '5.5.0');
  assert.equal(lock.packages['node_modules/selfsigned']?.version, '5.5.0');
  assert.equal(lock.packages['node_modules/selfsigned']?.dev, true);
  assert.equal(pkg.dependencies.selfsigned, undefined);
});

test('DEPLOY-01 the sandbox rule allows chroot without adding container capabilities', () => {
  const seccomp = JSON.parse(source('../chromium-seccomp.json'));
  const chrootRules = seccomp.syscalls.filter(rule => rule.names?.includes('chroot'));
  assert.deepEqual(chrootRules.map(({ comment, ...rule }) => rule), [
    { names: ['chroot'], action: 'SCMP_ACT_ALLOW' },
    { names: ['chroot'], action: 'SCMP_ACT_ALLOW', includes: { caps: ['CAP_SYS_CHROOT'] } }
  ]);
  const { compose } = renderDeployment({ environment, image, runId: environment.runId });
  const workflow = source('../../../.github/workflows/server-probe.yml');
  assert.match(compose, /cap_drop: \[ALL\]/);
  assert.match(workflow, /--network none .*--read-only .*--cap-drop ALL/);
  assert.match(workflow, /--security-opt no-new-privileges:true/);
  assert.match(workflow, /unshare --user --map-root-user/);
  assert.doesNotMatch(compose + workflow, /cap_add:|--cap-add|apparmor=unconfined|seccomp=unconfined|--privileged|--no-sandbox/);
});
