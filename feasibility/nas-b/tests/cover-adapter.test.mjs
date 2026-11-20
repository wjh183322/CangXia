import test from 'node:test';
import assert from 'node:assert/strict';
import { runCoverHelper } from '../src/cover-adapter.mjs';
test('canceled helper does not launch a process', async () => {
  await assert.rejects(runCoverHelper({ mode: 'probe', video: 'fixture' }, { signal: AbortSignal.abort() }), {
    name: 'AbortError'
  });
});
import { assessRegisteredCover } from '../src/cover-adapter.mjs';
import { makeSandbox } from './helpers.mjs';
import path from 'node:path';
test('registered platform image at comparable resolution skips frame matching', async (t) => {
  const s = await makeSandbox(t),
    png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
      'base64'
    );
  await s.write('image.png', png);
  await s.write('video.mp4', 'video');
  let calls = 0,
    checks = 0;
  const result = await assessRegisteredCover({
    cover: { file: path.join(s.root, 'image.png'), size: png.length },
    video: { file: path.join(s.root, 'video.mp4'), size: 5 },
    authorize(_asset, stat) {
      assert.equal(typeof stat.ino, 'bigint');
      checks++;
    },
    helper: async (request) => {
      assert.equal(request.mode, 'probe');
      calls++;
      return { ok: true, width: 1, height: 1 };
    }
  });
  assert.equal(result.source, 'platform');
  assert.equal(calls, 1);
  assert.ok(checks >= 2);
});
