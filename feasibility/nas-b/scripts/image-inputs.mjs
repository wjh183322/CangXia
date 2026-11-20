
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { PROBE, ProbeError } from '../src/contracts.mjs';

const BASE_DIGEST = 'sha256:766137e2d9caad4744187e53cdc89320ba6f2eb57cff097374020944b44dd0a9';
export const BASE_IMAGE = 'mcr.microsoft.com/playwright:v1.65.1-noble@' + BASE_DIGEST;
export const IMAGE_REPOSITORY = 'ghcr.io/wjh183322/cangxia-server-probe';
export const IMAGE_SOURCE = 'https://github.com/wjh183322/CangXia';
export const PROJECT_ROOT = 'opt/cangxia';

const baseLayers = [
  '21210938f5a37a9887b2d0a20428917b923a636ca6efe038c3c7d9cd9f1f9b61',
  'e375075734df9119510306075facca662aea75b3fe4d2c966fab220810e9131a',
  '0929356d0ff97336848918f513a781f2516a7dd84834fd11c729694745c94dc0',
  '19943b80cee793da1a5b610909a13e72029679a43e584084129b095653003e3d',
  '5383defbe315f6eec79a40bb96079e642e2fe0526c5ff3769f1cb96c9eb02607',
  '8e7c16482a3fc9b31dcf1a22384b9718c3403b373fb701b1f1683870057c0457',
  'a3130d16e3e3740084a5dc5d77cdc3123a1085bafb6002fb87f63a2566a88da7'
].map(hash => 'sha256:' + hash);
const runtime = 'feasibility/nas-b/';
const packages = ['jsonc-parser', 'playwright-core'];

export const RUNTIME_FILES = Object.freeze([
  ...['account-identity', 'api-pagination', 'audio-info', 'browser-api', 'filter', 'hd-cover', 'media-info',
    'model', 'qr-page', 'resumable-transfer', 'verification-panel', 'work-audio'].map(name => 'electron/' + name + '.mjs'),
  ...['cover-runtime.lock', 'nas-entrypoint.sh', 'package-lock.json', 'package.json',
    'scripts/container-start.mjs', 'scripts/health.mjs', 'web/app.mjs', 'web/index.html', 'web/style.css',
    ...['browser', 'config', 'contracts', 'cover-adapter', 'downloads', 'files', 'lease', 'media-http',
      'page-parser', 'read-jobs', 'redact', 'server', 'store', 'work-merge'].map(name => 'src/' + name + '.mjs')
  ].map(name => runtime + name),
  'scripts/cover-frame.py',
  ...['backup-protocol', 'creators', 'douyin-web', 'music', 'source-state'].map(name => 'shared/' + name + '.mjs')
]);

export function validateImageInputs(input = {}) {
  const { arch, revision, baseDigest } = input ?? {};
  const missing = Object.entries({ arch, revision, baseDigest }).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    throw new ProbeError('IMAGE_INPUT_REQUIRED', 'Supply the verified image build inputs.', { missing });
  }
  if (arch !== 'amd64') throw new ProbeError('UNSUPPORTED_IMAGE_ARCH', 'The probe build supports only linux/amd64.');
  if (baseDigest !== BASE_DIGEST) throw new ProbeError('UNVERIFIED_IMAGE_BASE', 'Use the fixed official amd64 base digest.');
  if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new ProbeError('INVALID_IMAGE_REVISION', 'Supply a full Git commit hash for the build.');
  }
  return Object.freeze({
    arch, revision, baseImage: BASE_IMAGE, platform: 'linux/amd64', source: IMAGE_SOURCE, repository: IMAGE_REPOSITORY,
    tag: PROBE.version + '-' + revision.slice(0, 12)
  });
}

const expectedFiles = new Set([
  ...RUNTIME_FILES.map(file => PROJECT_ROOT + '/' + file),
  'usr/bin/Xvfb', 'usr/bin/ffmpeg', 'usr/bin/ffprobe', 'usr/bin/node', 'usr/bin/openssl', 'usr/bin/python3.12',
  'opt/cover-runtime/bin/python',
  'opt/cangxia/feasibility/nas-b/node_modules/jsonc-parser/LICENSE.md',
  'opt/cangxia/feasibility/nas-b/node_modules/playwright-core/LICENSE',
  'opt/cangxia/feasibility/nas-b/node_modules/.bin/playwright-core'
]);
const permittedDirectories = new Set([...expectedFiles].flatMap(file => {
  const segments = file.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}));
const packageRoot = PROJECT_ROOT + '/' + runtime + 'node_modules/';
const secretPath = /(?:^|\/)(?:\.evidence|\.git|\.ssh|access\.token|id_rsa|id_ed25519|server\.key|Cookies|Login Data)(?:\/|$)|(?:^|\/)\.env(?:\.|\/|$)|\.(?:sqlite|key|pfx|p12)$/i;
const protectedRoots = /^(?:probe|workspace|volume[0-9]+|tmp\/(?:browser|media|reports|state))(?:\/|$)/;

export function auditImageManifest({ paths, inspect, inputs } = {}) {
  const problems = [];
  if (!Array.isArray(paths) || paths.some(file => typeof file !== 'string')) {
    return { ok: false, problems: ['MISSING_FILESYSTEM_MANIFEST'] };
  }
  const files = new Set(paths.map(file => file.replace(/^\.\//, '').replace(/\/$/, '')));
  const missingRuntimeFiles = [...expectedFiles].filter(file => !files.has(file));
  if (missingRuntimeFiles.length) problems.push('RUNTIME_FILES_MISSING');
  let unexpectedFileCount = 0;
  for (const file of files) {
    if (!file) continue;
    if (file.startsWith(PROJECT_ROOT + '/')) {
      const packageFile = packages.some(name => file.startsWith(packageRoot + name + '/'));
      if ((!expectedFiles.has(file) && !permittedDirectories.has(file) &&
        !packageFile && file !== packageRoot + '.package-lock.json') || secretPath.test(file)) unexpectedFileCount++;
    } else if (/^\.\.?\/|\/\.\.?(?:\/|$)/.test(file) ||
      /^(?:root|home)\/(?:.*\/)?\.ssh(?:\/|$)/.test(file) ||
      (protectedRoots.test(file) && file !== 'probe') ||
      /^(?:root|home|tmp)\/(?:.*\/)?(?:\.evidence|access\.token|server\.key|id_rsa|id_ed25519)(?:\/|$)/.test(file)) {
      unexpectedFileCount++;
    }
  }
  if (unexpectedFileCount) problems.push('UNEXPECTED_IMAGE_FILES');
  let layerCount;
  if (inspect || inputs) {
    const { Config, RootFS } = inspect ?? {};
    const labels = Config?.Labels ?? {};
    if (!inputs || inspect?.Os !== 'linux' || inspect?.Architecture !== inputs.arch ||
        Config?.User !== '1000:1000' || JSON.stringify(Config.Entrypoint) !== JSON.stringify([
          '/' + PROJECT_ROOT + '/' + runtime + 'nas-entrypoint.sh'
        ]) || !Config.Healthcheck?.Test ||
        labels['org.opencontainers.image.source'] !== inputs.source ||
        labels['org.opencontainers.image.revision'] !== inputs.revision ||
        labels['org.opencontainers.image.version'] !== inputs.tag ||
        labels['org.opencontainers.image.base.digest'] !== BASE_DIGEST) problems.push('IMAGE_METADATA_MISMATCH');
    const layers = RootFS?.Layers;
    layerCount = layers?.length;
    if (!Array.isArray(layers) || layers.length <= baseLayers.length ||
        baseLayers.some((digest, index) => layers[index] !== digest) ||
        layers.some(digest => !/^sha256:[a-f0-9]{64}$/.test(digest))) problems.push('IMAGE_LAYERS_MISMATCH');
  }
  // File names from an unknown build may themselves contain credentials.
  return { ok: !problems.length, problems, fileCount: files.size, unexpectedFileCount, missingRuntimeFiles, layerCount };
}

async function cli() {
  const inputs = validateImageInputs({ arch: process.env.PROBE_ARCH, revision: process.env.GITHUB_SHA, baseDigest: BASE_DIGEST });
  if (process.argv[2] === 'plan') {
    console.log(JSON.stringify(inputs));
    return;
  }
  if (process.argv[2] !== 'audit' || !process.argv[3]) throw new Error('Use plan or audit with an image inspect file.');
  const [inspect] = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const paths = [];
  for await (const file of createInterface({ input: process.stdin, crlfDelay: Infinity })) paths.push(file);
  const result = auditImageManifest({ paths, inspect, inputs });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(error => {
    console.error(error instanceof ProbeError ? error.code : 'IMAGE_AUDIT_FAILED');
    process.exitCode = 1;
  });
}
