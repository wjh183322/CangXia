import path from 'node:path';
import { lstatSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { comparableResolution } from '../electron/hd-cover.mjs';
import { imageDimensions } from '../electron/media-info.mjs';
import { assertResourceCurrent } from './files.mjs';
import { SourceError } from './source-error.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./cover-helper.py', import.meta.url));
const errors = {
  no_reliable_hd_match: '视频中未找到可靠匹配的高清画面。',
  video_resolution_insufficient: '视频实际分辨率不足。',
  reference_insufficient_detail: '封面细节不足，无法可靠匹配。',
  reference_invalid: '封面无法解码。',
  video_decode_failed: '视频无法解码。',
  matching_timeout: '视频匹配超时，可单独重试。',
  image_encode_failed: '高清图无法编码。'
};
const changed = () => new SourceError('NAS_FILE_REVIEW', '文件与登记不符，请重新核对。');

export function assessCover(options){
  const {store,video,cover,guard}=options;
  return assessSealedCover({...options,guard:()=>{
    guard?.();
    store.layout.assertCurrent();
    for(const asset of [video,cover].filter(Boolean))
      assertResourceCurrent({store,resource:asset,stat:lstatSync(asset.file,{bigint:true})});
  }});
}

// The helper pins and verifies each exact size and SHA-256 before decoding. Formal
// callers also validate their registration above; sealed legacy inputs have no such row yet.
export async function assessSealedCover({
  video,
  cover,
  signal,
  python = process.platform === 'win32' ? 'python' : 'python3',
  guard,
  platform,
  publish
}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cangxia-hd-'));
  function check() {
    signal?.throwIfAborted();
    guard?.();
  }
  const descriptor = ({ file, size, sha256 }) => ({ file, size, sha256 });
  async function call(name, request) {
    const file = path.join(dir, name + '.json');
    await writeFile(file, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    let response;
    try {
      response = await execute(python, ['-I', script, file], {
        signal,
        timeout: 150000,
        maxBuffer: 65536,
        windowsHide: true
      });
    } catch (error) {
      signal?.throwIfAborted();
      response = error;
    }
    check();
    let result;
    try {
      result = JSON.parse(response.stdout);
    } catch {}
    if (result?.error === 'input_changed') throw changed();
    if (result?.ok === false && Object.hasOwn(errors, result.error))
      return { accepted: false, reason: result.error, message: errors[result.error] };
    if (result?.ok !== true || response.code)
      throw new SourceError('NAS_COVER_HELPER', '高清匹配组件未能运行。');
    return result;
  }
  try {
    check();
    const movie = descriptor(video);
    const resolution = await call('probe', { mode: 'probe', video: movie });
    if (resolution.accepted === false) return resolution;
    if (!(resolution.width > 0 && resolution.height > 0))
      return { accepted: false, reason: 'video_decode_failed', message: errors.video_decode_failed };
    const base = {
      accepted: true,
      status: 'ready',
      videoWidth: resolution.width,
      videoHeight: resolution.height
    };
    if (comparableResolution(cover, resolution))
      return {
        ...base,
        source: 'platform',
        key: 'cover',
        sha256: cover.sha256,
        width: cover.width,
        height: cover.height
      };
    const fresh = await platform?.(resolution);
    check();
    if (fresh?.ready) return { ...base, ...fresh.ready };
    const reference = cover ? descriptor(cover) : fresh?.reference;
    if (!reference)
      return { accepted: false, reason: 'reference_invalid', message: '没有可核实的封面可供匹配。' };
    const output = path.join(dir, 'matched.png');
    const match = await call('match', { video: movie, reference, output });
    if (match.accepted === false) return match;
    const bytes = await readFile(output);
    const { width, height } = imageDimensions(bytes);
    if (
      !width ||
      !height ||
      width !== match.width ||
      height !== match.height ||
      width > resolution.width ||
      height > resolution.height ||
      match.crop?.length !== 4 ||
      match.crop[2] !== width ||
      match.crop[3] !== height
    )
      throw changed();
    check();
    const result = {
      ...base,
      source: 'video_frame',
      referenceSha256: reference.sha256,
      width,
      height,
      frame: match.frame,
      seconds: match.seconds,
      correlation: match.correlation,
      crop: match.crop
    };
    return { ...result, ...(await publish?.(bytes, result, check)) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
