import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProbeError } from './contracts.mjs';

const execute = promisify(execFile);
const original = fileURLToPath(new URL('../../../scripts/cover-frame.py', import.meta.url));
const known = new Set([
  'no_reliable_hd_match',
  'video_decode_failed',
  'image_encode_failed',
  'reference_invalid',
  'reference_insufficient_detail',
  'matching_timeout',
  'video_resolution_insufficient'
]);
export async function runCoverHelper(request, { signal, python = 'python', script = original } = {}) {
  signal?.throwIfAborted();
  const directory = await mkdtemp(path.join(tmpdir(), 'cangxia-cover-'));
  try {
    const file = path.join(directory, 'request.json');
    await writeFile(file, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    let response;
    try {
      response = await execute(python, [script, file], {
        signal,
        windowsHide: true,
        timeout: 180000,
        maxBuffer: 65536
      });
    } catch (error) {
      signal?.throwIfAborted();
      response = error;
    }
    let result;
    try {
      result = JSON.parse(response.stdout);
    } catch {
      throw new ProbeError('PROBE_COVER_HELPER_FAILED');
    }
    if (result?.ok === false)
      return { ok: false, error: known.has(result.error) ? result.error : 'cover_helper_failed' };
    if (result?.ok !== true || response.code) throw new ProbeError('PROBE_COVER_HELPER_FAILED');
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { comparableResolution } from '../../../electron/hd-cover.mjs';
import { imageDimensions } from '../../../electron/media-info.mjs';

// Python opens paths itself. Give it private snapshots copied from the verified handles.
export async function assessRegisteredCover({ video, cover, authorize, signal, helper = runCoverHelper }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cangxia-cover-check-'));
  const inputs = [];
  async function check() {
    for (const { asset, file } of inputs) {
      const stat = await file.stat({ bigint: true });
      signal?.throwIfAborted();
      authorize(asset, stat);
    }
  }
  async function snapshot(asset, name) {
    const file = await open(asset.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    inputs.push({ file, asset });
    await check();
    const destination = path.join(directory, name);
    const out = await open(destination, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(256 * 1024);
      for (let position = 0; position < asset.size; ) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, asset.size - position),
          position
        );
        await check();
        if (!bytesRead) throw new ProbeError('PROBE_FILE_REVIEW');
        await out.writeFile(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      await out.close();
    }
    return destination;
  }
  async function dimensions(file) {
    const handle = await open(file, 'r');
    try {
      const prefix = Buffer.alloc(256 * 1024);
      const { bytesRead } = await handle.read(prefix);
      return imageDimensions(prefix.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }
  try {
    const movie = await snapshot(video, 'video'),
      reference = await snapshot(cover, 'reference');
    const probe = await helper({ mode: 'probe', video: movie }, { signal });
    await check();
    if (!probe.ok) return probe;
    const existing = await dimensions(reference);
    if (comparableResolution(existing, probe))
      return {
        ok: true,
        source: 'platform',
        ...existing,
        videoWidth: probe.width,
        videoHeight: probe.height
      };
    const output = path.join(directory, 'matched.png');
    const result = await helper({ video: movie, reference, output }, { signal });
    await check();
    if (!result.ok) return result;
    const { width, height } = await dimensions(output);
    if (
      !width ||
      !height ||
      width !== result.width ||
      height !== result.height ||
      width > probe.width ||
      height > probe.height
    )
      throw new ProbeError('PROBE_COVER_DIMENSIONS');
    return {
      ok: true,
      source: 'video_frame',
      width,
      height,
      frame: result.frame,
      seconds: result.seconds,
      correlation: result.correlation,
      crop: result.crop,
      videoWidth: probe.width,
      videoHeight: probe.height
    };
  } finally {
    try {
      await Promise.all(inputs.map((i) => i.file.close()));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
