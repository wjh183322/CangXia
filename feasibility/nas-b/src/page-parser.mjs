import { createHash } from 'node:crypto';
import { visit } from 'jsonc-parser';
import { pageResult } from '../../../electron/api-pagination.mjs';
import { goneMessage } from '../../../shared/source-state.mjs';
import { normalizeCreator, mergeCreator, sameCreator } from '../../../shared/creators.mjs';
import { parsePlatformJSON, parseWork } from '../../../electron/model.mjs';
import { audioSources } from '../../../electron/work-audio.mjs';
import { ProbeError } from './contracts.mjs';
import { mergeObservedWork } from './work-merge.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string';
const isCursor = value => isText(value) && /^\d+$/.test(value);
const integerText = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
const sourceTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function invalid(message) {
  return new ProbeError('SOURCE_PAGE_INVALID', message);
}

function validateSource(source) {
  if (!isRecord(source) || !isText(source.id)) throw invalid('来源标识无效');
  const { kind, id } = source;
  const valid = kind === 'total' && id === '__all__' ||
    kind === 'collection' && isCursor(id) && /[1-9]/.test(id) ||
    kind === 'author' && /^[A-Za-z0-9_-]+$/.test(id) && id !== '__all__';
  if (!valid) throw invalid('来源标识无效');
  return { kind, id };
}

const maxPageBytes = 8 * 1024 * 1024;
const maxJsonDepth = 128;
const integerKeys = new Set([
  'aweme_id', 'awemeId', 'uid', 'user_id', 'short_id', 'shortId', 'unique_id', 'uniqueId',
  'hashtag_id', 'tag_id', 'cid', 'cha_id', 'cursor', 'max_cursor', 'has_more', 'status_code', 'invite_status'
]);

// Keep the baseline parser as the value decoder. The visitor sees key repetitions
// and exact numeric tokens before JSON.parse could discard or round them.
function validateJson(text, checkIntegers = true) {
  const containers = [];
  function enter(keys) {
    if (containers.length === maxJsonDepth) throw invalid('来源响应 JSON 嵌套过深');
    containers.push(keys);
  }
  visit(text, {
    onObjectBegin: () => enter(new Set()),
    onArrayBegin: () => enter(null),
    onObjectEnd: () => containers.pop(),
    onArrayEnd: () => containers.pop(),
    onObjectProperty(key) {
      const keys = containers.at(-1);
      if (keys.has(key)) throw invalid('来源响应 JSON 包含重复属性');
      keys.add(key);
    },
    onLiteralValue(value, offset, length, line, column, getPath) {
      if (!checkIntegers || typeof value !== 'number') return;
      const path = getPath();
      const key = path.at(-1);
      if (integerKeys.has(key) || (path.at(-2) === 'music' && ['id', 'id_str'].includes(key))) {
        if (!isCursor(text.slice(offset, offset + length))) throw invalid('来源标识或分页数值不是十进制整数');
      }
    },
    onError() { throw invalid('来源响应不是严格 JSON'); }
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
}

export function inspectSourceResponse({ status, text, retryAfter }, countRows = false) {
  let data;
  let parsed = false;
  try {
    if (!isText(text) || Buffer.byteLength(text, 'utf8') > maxPageBytes) throw invalid('来源响应大小无效');
    if (countRows) validateJson(text, false);
    data = JSON.parse(text);
    parsed = true;
  } catch {
    // Error responses often have no JSON body. A successful response with
    // malformed JSON can conceal an arbitrary section of the requested list.
  }
  const body = isRecord(data?.data) ? data.data : data;
  const message = String(data?.status_msg || data?.message || body?.status_msg || body?.message || '');
  const lists = [...new Set([data?.aweme_list, body?.aweme_list])].filter(items => items !== undefined);
  const plainError = status !== 200 && isText(text) && !/^\s*[[{]/.test(text);
  const rows = parsed && lists.every(Array.isArray)
    ? lists.reduce((sum, items) => sum + items.length, 0)
    : plainError ? 0 : null;
  if (status === 429) return { rows, code: 'PROBE_SOURCE_RATE_LIMITED', retryAfter: retryAfter || 60 };
  if (status === 401 || status === 403) return { rows, code: 'PROBE_SOURCE_AUTH' };
  if (status !== 200) return { rows };
  if (/访问太频繁|访问过于频繁|操作频繁|请求过于频繁|too many requests/i.test(message)) {
    return { rows, code: 'PROBE_SOURCE_RATE_LIMITED', retryAfter: 60 };
  }
  const rejected = [data?.status_code, body?.status_code].some(code => code != null && Number(code) !== 0);
  if (!parsed || rejected && !goneMessage(message)) {
    return { rows, code: 'PROBE_SOURCE_AUTH' };
  }
  return { rows };
}

function readEnvelope(text) {
  if (!isText(text)) throw invalid('需要完整的来源响应文本');
  if (Buffer.byteLength(text, 'utf8') > maxPageBytes) throw invalid('来源响应超过页面大小上限');
  validateJson(text);
  let data;
  try {
    data = parsePlatformJSON(text);
  } catch {
    throw invalid('来源响应不是可精确解析的 JSON');
  }
  if (!isRecord(data)) throw invalid('来源响应结构无效');

  const body = isRecord(data.data) ? data.data : data;
  for (const envelope of new Set([data, body])) {
    if (Object.hasOwn(envelope, 'status_code') && ![0, '0'].includes(envelope.status_code)) {
      throw invalid('平台拒绝了来源读取');
    }
  }
  const flags = [...new Set([data, body])]
    .filter(envelope => Object.hasOwn(envelope, 'has_more'))
    .map(envelope => envelope.has_more);
  if (!flags.length || flags.some(flag => ![true, false, 1, 0].includes(flag) ||
      Boolean(flag) !== Boolean(flags[0]))) {
    throw invalid('来源响应缺少一致的明确分页状态');
  }

  let result;
  try {
    result = pageResult(data, 'aweme_list');
  } catch {
    throw invalid('来源响应缺少完整作品列表');
  }
  const cursor = body.cursor ?? body.max_cursor ?? data.cursor ?? data.max_cursor;
  if (!result.complete && (!isCursor(integerText(cursor)) || result.items.length === 0)) {
    throw invalid('未结束的来源页缺少有效的后续游标或作品');
  }
  return result;
}

// The legacy export exposes tag rows. Preserve their display and identity fields
// without copying unrelated response metadata into the library.
const tagKeys = [
  'start', 'end', 'type', 'sub_type', 'hashtag_id', 'hashtag_name', 'tag_id', 'tag_name',
  'is_commerce', 'cid', 'cha_id', 'cha_name', 'name', 'desc', 'user_count', 'view_count'
];

function tagFragments(rows) {
  return (Array.isArray(rows) ? rows : []).filter(isRecord).map(row =>
    Object.fromEntries(tagKeys.filter(key => Object.hasOwn(row, key) &&
      ['string', 'number', 'boolean'].includes(typeof row[key])).map(key => [
      key, ['hashtag_id', 'tag_id', 'cid', 'cha_id'].includes(key) ? String(row[key]) : row[key]
    ])));
}

const imageRowsOf = raw => raw.images || raw.image_post_info?.images ||
  raw.image_post_info?.image_list || raw.image_list;

function observedFields(raw, work) {
  const video = raw.video;
  const fields = ['id', 'url', 'checkedAt'];
  const explicitName = raw.item_title || raw.preview_title || raw.title;
  if (isText(explicitName) && explicitName.trim()) fields.push('name');
  if (isText(raw.item_title || raw.title)) fields.push('title');
  if (isText(raw.caption)) fields.push('caption');
  if (isText(raw.desc ?? raw.caption)) fields.push('description');
  if (Array.isArray(raw.text_extra || raw.textExtra)) fields.push('textExtra');
  if (Array.isArray(raw.cha_list)) fields.push('challenges');
  if (work.author.uid || work.author.secUid) fields.push('author');
  if (work.coAuthorsState === 'verified') fields.push('coAuthors');

  if (work.images.length && work.images.length === imageRowsOf(raw)?.length) fields.push('images');
  if (work.videoUrls.length) fields.push('videoUrls');
  if (work.coverVariants.length) fields.push('coverVariants');
  if (work.coverUrls.length) fields.push('coverUrls');
  if (work.thumbnail) fields.push('thumbnail');
  for (const key of ['duration', 'width', 'height', 'publishedAt']) {
    if (Number.isFinite(work[key]) && work[key] > 0) fields.push(key);
  }
  if (work.music) fields.push('music');
  if (Array.isArray(video?.audio?.original_sound_infos)) fields.push('music.mixPending');
  if ([raw.is_delete, raw.status?.is_delete].some(value => [true, false, 0, 1].includes(value))) {
    fields.push('remoteState');
  }
  return fields;
}

function candidateUrls(address) {
  const urls = typeof address === 'string' ? [address] : address?.url_list || address?.urlList;
  return Array.isArray(urls) ? urls.filter(isText).map(url => url.replace(/^http:/, 'https:')) : [];
}

function mediaQuality(raw, work) {
  const images = imageRowsOf(raw);
  const imageOriginals = Object.fromEntries(work.images.map(({ index, urls }) => {
    const row = images[index];
    const original = [
      ...candidateUrls({ url_list: row.watermark_free_download_url_list }),
      ...candidateUrls(row.origin_image)
    ];
    return [index, new Set(original.filter(url => urls.includes(url))).size];
  }));

  const video = raw.video ?? {};
  const normalized = new Set(work.videoUrls);
  const variants = (video.bit_rate || video.bitRate || []).map(row => ({
    address: row.play_addr || row.playAddr, ranked: true, bitRate: Number(row.bit_rate || row.bitRate || 0)
  }));
  const addresses = [
    ...variants,
    { address: video.play_addr_h264_1080p, pixels: 1080 * 1920 },
    { address: video.play_addr_1080p, pixels: 1080 * 1920 },
    { address: video.play_addr_h264_720p, pixels: 720 * 1280 },
    { address: video.play_addr_720p, pixels: 720 * 1280 },
    { address: video.play_addr_h264, ranked: true },
    { address: video.play_addr_265, ranked: true },
    { address: video.play_addr || video.playAddr }
  ];
  const rankedUrls = new Set();
  let videoPixels = 0;
  let videoBitRate = 0;
  for (const { address, ranked, pixels, bitRate } of addresses) {
    const urls = candidateUrls(address).filter(url => normalized.has(url));
    if (!urls.length) continue;
    if (ranked || pixels) for (const url of urls) rankedUrls.add(url);
    const area = Number(address?.width ?? 0) * Number(address?.height ?? 0);
    const size = (Number.isFinite(area) && area) || pixels || 0;
    const rate = Number.isFinite(bitRate) ? bitRate : 0;
    if (size > videoPixels) {
      videoPixels = size;
      videoBitRate = rate;
    } else if (size === videoPixels) {
      videoBitRate = Math.max(videoBitRate, rate);
    }
  }
  return {
    imageOriginals, videoRanked: rankedUrls.size, videoPixels, videoBitRate,
    ...(work.videoUrls.length ? { videoObservedAt: work.checkedAt } : {})
  };
}

const sessionKeys = new Set([
  'authorization', 'cookie', 'setcookie', 'sessionid', 'sessionidss', 'uidtt', 'uidttss',
  'sidguard', 'sidtt', 'mstoken', 'password', 'accesstoken', 'refreshtoken',
  'passportcsrftoken', 'passportcsrftokendefault'
]);

function isSessionKey(key) {
  return sessionKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function verifyMediaReferences(work, hints) {
  const urls = [
    ...work.videoUrls, ...work.coverUrls,
    ...work.images.flatMap(image => image.urls),
    ...work.coverVariants.flatMap(variant => variant.urls),
    ...hints.flatMap(hint => hint.urls)
  ];
  for (const url of urls) {
    const { username, password, searchParams, hash } = new URL(url);
    const fragmentParams = new URLSearchParams(hash.slice(1).replaceAll('?', '&'));
    if (username || password || [...searchParams.keys(), ...fragmentParams.keys()].some(isSessionKey)) {
      throw invalid('媒体地址包含登录凭据');
    }
  }
}

function validateCreator(creator) {
  for (const id of [creator?.uid, creator?.user_id]) {
    if (id != null && id !== '' && !isCursor(integerText(id))) {
      throw invalid('来源页包含无效作者 UID');
    }
  }
  for (const id of [creator?.sec_uid, creator?.secUid]) {
    if (id != null && id !== 0 && (!isText(id) || !/^[A-Za-z0-9_-]*$/.test(id))) {
      throw invalid('来源页包含无效作者标识');
    }
  }
}

function verifiedCoCreators(rows) {
  if (!Array.isArray(rows) || rows.length > 64) return false;
  return rows.every(row => {
    if (!isRecord(row)) return false;
    if (row.invite_status != null) {
      if (typeof row.invite_status !== 'boolean' && !isCursor(integerText(row.invite_status))) return false;
      if (Number(row.invite_status) !== 1) return true;
    }
    try {
      validateCreator(row);
    } catch {
      return false;
    }
    const creator = normalizeCreator(row);
    return Boolean(creator.uid || creator.secUid);
  });
}

function observe(raw, observedAt) {
  if (!isRecord(raw)) throw invalid('来源页包含无效作品');
  const id = integerText(raw.aweme_id ?? raw.awemeId);
  if (!isCursor(id) || !/[1-9]/.test(id) ||
      (raw.awemeId != null && integerText(raw.awemeId) !== id)) {
    throw invalid('来源页包含无效作品标识');
  }
  validateCreator(raw.author);
  const coCreators = raw.cooperation_info?.co_creators;
  const malformedCoCreators = coCreators != null && !verifiedCoCreators(coCreators);

  let work;
  let hints;
  try {
    work = parseWork({
      ...raw, aweme_id: id,
      ...(malformedCoCreators ? { cooperation_info: undefined } : {})
    });
    if (malformedCoCreators) work.coAuthorsState = 'unknown';
    hints = audioSources(raw);
    verifyMediaReferences(work, hints);
    const dimensions = [
      work.duration, work.width, work.height, work.publishedAt,
      ...[...work.images, ...work.coverVariants].flatMap(({ width, height }) => [width, height])
    ];
    if (dimensions.some(value => !Number.isFinite(Number(value)))) {
      throw invalid('来源页包含无效作品数值');
    }
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw invalid('来源页包含无法解析的作品字段');
  }

  work.checkedAt = observedAt;
  if (work.creatorsCheckedAt) work.creatorsCheckedAt = observedAt;
  const fields = observedFields(raw, work);
  work.rawTags = {
    textExtra: tagFragments(raw.text_extra || raw.textExtra),
    challenges: tagFragments(raw.cha_list)
  };
  if (work.remoteState === 'unavailable') {
    work.sourceStatus = {
      state: 'unavailable', reason: '平台返回明确的作品删除标记',
      method: 'platform', checkedAt: observedAt
    };
  }
  return { work: { ...work, observedFields: fields, mediaQuality: mediaQuality(raw, work) }, hints };
}

function collectProfiles(works) {
  const profiles = [];
  for (const work of works) {
    for (const creator of [work.author, ...(work.coAuthors ?? [])]) {
      const { roleTitle, ...profile } = creator;
      if (!profile.uid && !profile.secUid) continue;
      const index = profiles.findIndex(previous => sameCreator(previous, profile));
      if (index < 0) profiles.push(profile);
      else profiles[index] = mergeCreator(profiles[index], profile);
    }
  }
  return profiles;
}

const musicIdentity = work => work?.music?.id && work.music.id !== '0' ? work.music.id : '';

export function parseSourcePage({ source, inputCursor, status, text, observedAt } = {}) {
  source = validateSource(source);
  if (!isCursor(inputCursor)) throw invalid('输入游标无效');
  if (!isText(observedAt) || !sourceTimestamp.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) {
    throw invalid('来源核验时间无效');
  }
  observedAt = new Date(observedAt).toISOString();
  if (status !== 200) throw new ProbeError('SOURCE_HTTP', '未取得 HTTP 200 完整来源页');

  const { items, next, complete } = readEnvelope(text);
  const observations = new Map();
  for (const [rank, raw] of items.entries()) {
    const { work, hints } = observe(raw, observedAt);
    const previous = observations.get(work.id);
    const sources = previous?.sources ?? new Map();
    const mergedWork = mergeObservedWork(previous?.work, work);
    const musicId = musicIdentity(mergedWork);
    if (musicId !== musicIdentity(previous?.work)) sources.delete('music');
    for (const hint of hints) {
      if (hint.kind === 'music' && musicIdentity(work) !== musicId) continue;
      sources.set(hint.kind, hint);
    }
    observations.set(work.id, {
      work: mergedWork,
      rank: previous?.rank ?? rank,
      sources
    });
  }

  const values = [...observations.values()];
  const works = values.map(entry => entry.work);
  const refs = values.map(({ work, rank }) => ({ workId: work.id, rank }));
  const audioSourceHints = values.filter(({ sources }) => sources.size).map(({ work, sources }) => ({
    workId: work.id, sources: [...sources.values()], observedAt, ...(work.music ? { music: work.music } : {})
  }));

  return {
    source, inputCursor, nextCursor: complete ? null : next, terminal: complete,
    receivedCount: items.length, uniqueCount: works.length, works,
    aux: { creatorProfiles: collectProfiles(works), audioSourceHints },
    refs, digest: createHash('sha256').update(text).digest('hex'), observedAt
  };
}
