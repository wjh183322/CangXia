import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from '../src/media-http.mjs';

test('single ranges, suffixes, empty and invalid representations', () => {
  assert.deepEqual(parseRange('bytes=-2', 5), { status: 206, start: 3, end: 4, length: 2 });
  assert.deepEqual(parseRange('bytes=2-99', 5), { status: 206, start: 2, end: 4, length: 3 });
  assert.equal(parseRange(undefined, 0).length, 0);
  for (const value of ['bytes=0-1,3-4', 'bytes=-0', 'bytes=5-', 'bytes=4-2', 'units=1-']) {
    assert.throws(() => parseRange(value, 5), { code: 'RANGE_NOT_SATISFIABLE' });
  }
});
import { serveResource } from '../src/media-http.mjs';
import { makeSandbox } from './helpers.mjs';
import { EventEmitter } from 'node:events';
import path from 'node:path';

test('backpressure cancellation closes the opened handle and stops after one bounded chunk', async (t) => {
  const s = await makeSandbox(t),
    file = path.join(s.root, 'fixture.bin'),
    size = 200000;
  await s.write('fixture.bin', Buffer.alloc(size, 7));
  const controller = new AbortController(),
    res = new EventEmitter(),
    stats = [];
  let count = 0;
  res.writeHead = () => {};
  res.write = (chunk) => {
    count += chunk.length;
    queueMicrotask(() => controller.abort());
    return false;
  };
  await assert.rejects(
    serveResource({ method: 'GET', headers: {} }, res, {
      resource: { file, size, mime: 'video/mp4' },
      signal: controller.signal,
      authorize(stat) {
        if (stat) stats.push(stat);
      }
    }),
    { name: 'AbortError' }
  );
  assert.equal(count, 65536);
  assert.ok(stats.length >= 3 && stats.every((stat) => typeof stat.ino === 'bigint'));
});
test('scope revoked after read blocks that chunk from being written', async (t) => {
  const s = await makeSandbox(t),
    file = path.join(s.root, 'fixture.bin');
  await s.write('fixture.bin', 'test');
  let checks = 0,
    written = false;
  await assert.rejects(
    serveResource(
      { method: 'GET', headers: {} },
      {
        writeHead() {},
        write() {
          written = true;
        }
      },
      {
        resource: { file, size: 4, mime: 'video/mp4' },
        authorize(stat) {
          if (stat && ++checks === 3) throw Error('revoked');
        }
      }
    ),
    /revoked/
  );
  assert.equal(written, false);
});
