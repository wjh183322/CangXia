import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { once } from 'node:events';
import { ProbeError } from './contracts.mjs';

const invalid = () => new ProbeError('RANGE_NOT_SATISFIABLE');
export function parseRange(header, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw invalid();
  if (header === undefined) return { status: 200, start: 0, end: size - 1, length: size };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || !size || (!match[1] && !match[2])) throw invalid();
  const total = BigInt(size);
  const first = match[1] ? BigInt(match[1]) : total - BigInt(match[2]);
  const last = match[1] && match[2] ? BigInt(match[2]) : total - 1n;
  const start = Number(first < 0n ? 0n : first);
  const end = Number(last >= total ? total - 1n : last);
  if (start > end || start >= size) throw invalid();
  return { status: 206, start, end, length: end - start + 1 };
}

export async function serveResource(req, res, { resource, authorize, signal }) {
  signal?.throwIfAborted();
  authorize();
  const file = await open(resource.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const check = (stat) => {
      signal?.throwIfAborted();
      authorize(stat);
    };
    check(await file.stat({ bigint: true }));
    let range;
    try {
      range = parseRange(req.headers.range, resource.size);
    } catch (error) {
      if (error.code !== 'RANGE_NOT_SATISFIABLE') throw error;
      res.writeHead(416, { 'Content-Range': 'bytes */' + resource.size, 'Content-Length': 0 }).end();
      return;
    }
    const headers = {
      'Content-Type': resource.mime,
      'Content-Length': range.length,
      'Accept-Ranges': 'bytes'
    };
    if (range.status === 206) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${resource.size}`;
    res.writeHead(range.status, headers);
    if (req.method !== 'HEAD') {
      for (let offset = range.start; offset <= range.end; ) {
        check(await file.stat({ bigint: true }));
        const buffer = Buffer.allocUnsafe(Math.min(65536, range.end - offset + 1));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) throw new ProbeError('PROBE_FILE_REVIEW');
        check(await file.stat({ bigint: true }));
        if (!res.write(buffer.subarray(0, bytesRead))) await once(res, 'drain', { signal });
        offset += bytesRead;
      }
    }
    res.end();
  } finally {
    await file.close();
  }
}
