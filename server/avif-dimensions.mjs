// ISO BMFF primary item, property container and association tables (also used by libavif).
// The first ispe may belong to a thumbnail, an alpha plane or an individual grid tile.
export function avifDimensions(meta, mediaData) {
  const invalid = () => {
    throw Error('AVIF 主图信息无效。');
  };
  let boxCount = 0;
  function boxes(bytes) {
    const result = [];
    for (let at = 0; at < bytes.length; ) {
      if (++boxCount > 4096 || bytes.length - at < 8) invalid();
      let size = bytes.readUInt32BE(at),
        header = 8;
      if (size === 1) {
        size = Number(bytes.readBigUInt64BE(at + 8));
        header = 16;
      }
      if (!size) size = bytes.length - at;
      if (!Number.isSafeInteger(size) || size < header || size > bytes.length - at) invalid();
      result.push({
        type: bytes.toString('ascii', at + 4, at + 8),
        data: bytes.subarray(at + header, at + size)
      });
      at += size;
    }
    return result;
  }
  function one(list, type) {
    const matches = list.filter((box) => box.type === type);
    if (matches.length !== 1) invalid();
    return matches[0].data;
  }
  function reader(bytes) {
    let at = 0;
    return {
      number(n) {
        if (!Number.isInteger(n) || n < 0 || n > 8 || at + n > bytes.length) invalid();
        let value = 0;
        for (let i = 0; i < n; i++) value = value * 256 + bytes[at++];
        if (!Number.isSafeInteger(value)) invalid();
        return value;
      },
      done() {
        if (at !== bytes.length) invalid();
      }
    };
  }
  if (meta.readUInt32BE() !== 0) invalid();
  const children = boxes(meta.subarray(4));
  const item = one(children, 'pitm'),
    version = item[0];
  if (version > 1 || item.length !== (version ? 8 : 6) || item.readUIntBE(1, 3) !== 0) invalid();
  const primary = item.readUIntBE(4, version ? 4 : 2);
  const info = one(children, 'iinf'),
    countSize = info[0] ? 4 : 2;
  const entries = boxes(info.subarray(4 + countSize));
  if (info.readUIntBE(4, countSize) !== entries.length) invalid();
  const supported = entries.filter(({ type, data }) => {
    if (type !== 'infe' || ![2, 3].includes(data[0])) return false;
    const n = data[0] === 2 ? 2 : 4;
    return (
      data.readUIntBE(4, n) === primary &&
      data.readUInt16BE(4 + n) === 0 &&
      ['av01', 'grid'].includes(data.toString('ascii', 6 + n, 10 + n))
    );
  });
  if (supported.length !== 1) invalid();

  function containsExtent(ranges, start, length) {
    // Top-level payloads are in file order. One extent must fit one payload, never a box header or gap.
    let left = 0,
      right = ranges.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (ranges[mid].at <= start) left = mid + 1;
      else right = mid;
    }
    const range = ranges[left - 1];
    return !!range && length > 0 && start + length <= range.at + range.length;
  }
  const locations = reader(one(children, 'iloc')),
    layoutVersion = locations.number(1);
  if (layoutVersion > 2 || locations.number(3) !== 0) invalid();
  const sizes = locations.number(1),
    base = locations.number(1),
    itemCount = locations.number(layoutVersion < 2 ? 2 : 4);
  let foundLocation = false;
  for (let i = 0; i < itemCount; i++) {
    const id = locations.number(layoutVersion < 2 ? 2 : 4),
      method = layoutVersion ? locations.number(2) : 0;
    const reference = locations.number(2),
      offset = locations.number(base >> 4),
      extents = locations.number(2);
    let ranges = mediaData;
    if (id === primary) {
      if (foundLocation || reference !== 0 || method > 1 || !extents) invalid();
      if (method === 1) ranges = [{ at: 0, length: one(children, 'idat').length }];
      foundLocation = true;
    }
    for (let e = 0; e < extents; e++) {
      if (layoutVersion) locations.number(base & 15);
      const start = offset + locations.number(sizes >> 4),
        length = locations.number(sizes & 15);
      if (id !== primary) continue;
      if (!containsExtent(ranges, start, length)) invalid();
    }
  }
  locations.done();
  if (!foundLocation) invalid();

  const properties = boxes(one(children, 'iprp')),
    items = boxes(one(properties, 'ipco'));
  let dimensions,
    found = false,
    rotate = false;
  for (const { data } of properties.filter((box) => box.type === 'ipma')) {
    const r = reader(data),
      v = r.number(1),
      flags = r.number(3);
    if (v > 1 || flags > 1) invalid();
    const n = r.number(4);
    for (let i = 0; i < n; i++) {
      const id = r.number(v ? 4 : 2),
        associations = r.number(1);
      if (id === primary) {
        if (found) invalid();
        found = true;
      }
      for (let j = 0; j < associations; j++) {
        const index = r.number(flags ? 2 : 1) & (flags ? 32767 : 127);
        if (index > items.length) invalid();
        if (id !== primary || !index) continue;
        const { type, data: property } = items[index - 1];
        if (type === 'irot') {
          if (property.length !== 1 || property[0] > 3) invalid();
          rotate = !!(property[0] & 1);
        }
        if (type !== 'ispe') continue;
        if (dimensions || property.length !== 12 || property.readUInt32BE() !== 0) invalid();
        const width = property.readUInt32BE(4),
          height = property.readUInt32BE(8);
        if (!width || !height || width * height > 268435456) invalid();
        dimensions = { width, height };
      }
    }
    r.done();
  }
  if (!found || !dimensions) invalid();
  return rotate ? { width: dimensions.height, height: dimensions.width } : dimensions;
}
