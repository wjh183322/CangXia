
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { readProbeConfig, validateDeployment } from './src/config.mjs';
import { PROBE, ProbeError } from './src/contracts.mjs';
import { BASE_IMAGE, IMAGE_REPOSITORY, IMAGE_SOURCE, validateImageInputs } from './scripts/image-inputs.mjs';

const profile = 'chromium-seccomp.json';
const requiredFiles = [profile, 'chromium-seccomp.LICENSE'].map(name => Object.freeze({
  name, content: readFileSync(new URL(name, import.meta.url), 'utf8')
}));

function requireFields(value, fields, code) {
  const missing = fields.filter(field => value?.[field] == null || value[field] === '');
  if (missing.length) throw new ProbeError(code, 'Collect the required probe deployment inputs.', { missing });
}

export function renderDeployment({ environment, image, runId } = {}) {
  requireFields({ runId }, ['runId'], 'ENV_INPUT_REQUIRED');
  requireFields(environment, ['libraryId', 'accessHost', 'slotVerified'], 'ENV_INPUT_REQUIRED');
  const slot = validateDeployment(environment);
  if (runId !== slot.runId) throw new ProbeError('DEPLOYMENT_RUN_MISMATCH', 'The trial slot must match this run.');
  if (environment.slotVerified !== true) throw new ProbeError('DEPLOYMENT_SLOT_UNVERIFIED', 'Verify the dedicated Docker slot and sandbox support on the NAS.');
  const runtime = readProbeConfig({
    PROBE_MODE: PROBE.mode, PROBE_ROOT: PROBE.root, PROBE_RUN_ID: slot.runId, PROBE_LIBRARY_ID: environment.libraryId,
    PROBE_PORT: PROBE.containerPort, PROBE_ACCESS_HOST: environment.accessHost
  });

  const formatHost = host => host.includes(':') ? '[' + host + ']' : host;
  const canonicalHost = host => new URL('https://' + formatHost(host)).hostname;
  if (isIP(runtime.accessHost) && canonicalHost(runtime.accessHost) !== canonicalHost(slot.lanAddress)) {
    throw new ProbeError('DEPLOYMENT_ACCESS_HOST_MISMATCH', 'The access IP must match the verified LAN binding.');
  }

  requireFields(image, ['arch', 'revision', 'digest', 'repository', 'source', 'tag', 'visibility',
    'visibilityConfirmed', 'pullVerified', 'audited'], 'RELEASE_INPUT_REQUIRED');
  const build = validateImageInputs({ arch: image.arch, revision: image.revision, baseDigest: BASE_IMAGE.split('@')[1] });
  if (slot.arch !== build.arch) throw new ProbeError('IMAGE_ARCH_MISMATCH', 'The NAS architecture must match the verified image.');
  if (image.repository !== IMAGE_REPOSITORY || image.source !== IMAGE_SOURCE || image.tag !== build.tag ||
      typeof image.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(image.digest)) {
    throw new ProbeError('UNVERIFIED_IMAGE_RELEASE', 'Use the exact registry release and digest from the reviewed build.');
  }
  if (!['public', 'private'].includes(image.visibility) || image.visibilityConfirmed !== true) {
    throw new ProbeError('IMAGE_VISIBILITY_UNVERIFIED', 'Confirm the registry package visibility before deployment.');
  }
  if (image.pullVerified !== true) {
    throw new ProbeError('IMAGE_PULL_UNVERIFIED', 'Verify the exact registry digest can be pulled through the approved access path.');
  }
  if (image.audited !== true) throw new ProbeError('IMAGE_AUDIT_UNVERIFIED', 'Verify the image and smoke results first.');

  const lanBinding = formatHost(slot.lanAddress) + ':' + slot.hostPort + ':' + slot.containerPort;
  const reference = image.repository + ':' + image.tag + '@' + image.digest;
  const quote = JSON.stringify;
  const { cpus, memoryBytes, shmBytes } = slot.resources;
  const compose = [
    'name: ' + PROBE.service + '-' + slot.runId,
    'services:',
    '  probe:',
    '    image: ' + quote(reference),
    '    platform: ' + build.platform,
    '    user: ' + quote(slot.uid + ':' + slot.gid),
    '    init: true',
    '    read_only: true',
    '    cap_drop: [ALL]',
    '    security_opt:',
    '      - no-new-privileges:true',
    '      - seccomp=./' + profile,
    '    tmpfs:',
    '      - /tmp:rw,nosuid,nodev,mode=1777',
    '    cpus: ' + cpus,
    '    mem_limit: ' + quote(memoryBytes + 'b'),
    '    shm_size: ' + quote(shmBytes + 'b'),
    '    ports:',
    '      - ' + quote(lanBinding),
    '    environment:',
    '      PROBE_MODE: ' + quote(PROBE.mode),
    '      PROBE_ROOT: ' + quote(PROBE.root),
    '      PROBE_RUN_ID: ' + quote(slot.runId),
    '      PROBE_LIBRARY_ID: ' + quote(runtime.libraryId),
    '      PROBE_PORT: ' + quote(String(slot.containerPort)),
    '      PROBE_ACCESS_HOST: ' + quote(runtime.accessHost),
    '    volumes:',
    '      - type: bind',
    '        source: ' + quote(slot.hostPath),
    '        target: /probe',
    '        read_only: false',
    '        bind:',
    '          create_host_path: false',
    ''
  ].join('\n');
  const operatorNotes = [
    '将 compose.yaml 与 ' + profile + ' 放在 NAS Docker 新建试验项目的同一配置目录。保留随附的许可证。',
    '使用已确认的独立试验目录 ' + slot.hostPath + '，以 UID/GID ' + slot.uid + '/' + slot.gid + ' 运行一个容器。',
    image.visibility === 'private'
      ? '在 NAS 镜像库界面用只读凭据登录 GHCR，然后拉取已核对的镜像。凭据只输入 NAS 镜像库界面。'
      : '该发布已验证可匿名拉取，选择已核对的镜像 digest。',
    '启动后在 NAS 本地核对 /probe/state/server.pem 的指纹，在试验客户端信任此证书，并打开 https://' +
      formatHost(runtime.accessHost) + ':' + slot.hostPort + '。',
    '在 NAS 本地的试验容器终端读取 /probe/state/access.token，仅输入试验控台。'
  ].join('\n') + '\n';
  return { compose, operatorNotes, requiredFiles: [...requiredFiles] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Read the reviewed private manifest from standard input. The caller writes the output locally.
    const input = JSON.parse(readFileSync(0, 'utf8'));
    console.log(JSON.stringify(renderDeployment(input)));
  } catch (error) {
    const code = error instanceof ProbeError ? error.code : 'INVALID_DEPLOYMENT_MANIFEST';
    console.error(JSON.stringify({ code, message: error instanceof ProbeError ? error.message : undefined,
      missing: error?.details?.missing }));
    process.exitCode = 1;
  }
}
