export function parseRange(header, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw Error('请求的字节范围无效。');
  if (header == null) return { status: 200, start: 0, end: size - 1, length: size };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || !size || !(match[1] || match[2])) throw Error('请求的字节范围无效。');
  const total = BigInt(size),
    first = match[1] ? BigInt(match[1]) : total - BigInt(match[2]);
  const start = Number(first < 0n ? 0n : first);
  const last = match[1] && match[2] ? BigInt(match[2]) : total - 1n,
    end = Number(last >= total ? total - 1n : last);
  if (start > end || start >= size) throw Error('请求的字节范围无效。');
  return { status: 206, start, end, length: end - start + 1 };
}
