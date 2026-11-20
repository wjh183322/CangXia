import { createHash } from 'node:crypto';
import { pageResult } from '../../../electron/api-pagination.mjs';
import { parsePlatformJSON, parseWork } from '../../../electron/model.mjs';
import { audioSources } from '../../../electron/work-audio.mjs';
import { mergeCreator, sameCreator } from '../../../shared/creators.mjs';
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

function readEnvelope(text) {
  if (!isText(text)) throw invalid('需要完整的来源响应文本');
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

  const imageRows = raw.images || raw.image_post_info?.images ||
    raw.image_post_info?.image_list || raw.image_list;
  if (work.images.length && work.images.length === imageRows?.length) fields.push('images');
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

function verifyMediaReferences(work, hints) {
  const urls = [
    ...work.videoUrls, ...work.coverUrls,
    ...work.images.flatMap(image => image.urls),
    ...work.coverVariants.flatMap(variant => variant.urls),
    ...hints.flatMap(hint => hint.urls)
  ];
  for (const url of urls) {
    const { username, password, searchParams } = new URL(url);
    const hasSessionParameter = [...searchParams.keys()].some(key =>
      /^(authorization|cookie|sessionid|sid_guard|msToken|password|access_token)$/i.test(key));
    if (username || password || hasSessionParameter) throw invalid('媒体地址包含登录凭据');
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

function observe(raw, observedAt) {
  if (!isRecord(raw)) throw invalid('来源页包含无效作品');
  const id = integerText(raw.aweme_id ?? raw.awemeId);
  if (!isCursor(id) || !/[1-9]/.test(id) ||
      (raw.awemeId != null && integerText(raw.awemeId) !== id)) {
    throw invalid('来源页包含无效作品标识');
  }
  validateCreator(raw.author);
  const coCreators = raw.cooperation_info?.co_creators;
  if (Array.isArray(coCreators)) for (const creator of coCreators) validateCreator(creator);

  let work;
  let hints;
  try {
    work = parseWork({ ...raw, aweme_id: id });
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
  return { work: { ...work, observedFields: fields }, hints };
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
    if (previous?.work.music?.id && work.music?.id && previous.work.music.id !== work.music.id) {
      sources.delete('music');
    }
    for (const hint of hints) sources.set(hint.kind, hint);
    observations.set(work.id, {
      work: mergeObservedWork(previous?.work, work),
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
