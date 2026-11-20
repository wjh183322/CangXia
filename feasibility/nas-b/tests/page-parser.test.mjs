import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parsePlatformJSON, parseWork } from '../../../electron/model.mjs';
import { audioSources } from '../../../electron/work-audio.mjs';
import { parseSourcePage } from '../src/page-parser.mjs';
import { mergeObservedWork } from '../src/work-merge.mjs';
import { sourceFixture } from './helpers.mjs';

const pageOf = (items, page = {}) => parseSourcePage({
  ...sourceFixture('two-works'),
  text: JSON.stringify({ aweme_list: items, has_more: false, ...page })
});

test('keeps 19-digit integer identity text and the exact continuation cursor', () => {
  const input = sourceFixture('unsafe-integer');
  assert.match(input.text, /"aweme_id":7345612390836712343/);
  const page = parseSourcePage(input);
  const [work] = page.works;
  assert.equal(work.id, '7345612390836712343');
  assert.equal(work.author.uid, '7345612390836712341');
  assert.equal(work.music.id, '7345612390836712347');
  assert.equal(page.inputCursor, '0');
  assert.equal(page.nextCursor, '7345612390836712345');
  assert.equal(page.terminal, false);
  assert.equal(page.digest, createHash('sha256').update(input.text).digest('hex'));
});

test('rejects unproven pages before exposing work or a cursor', () => {
  const input = sourceFixture('two-works');
  const bad = [
    { text: '<html>private-fixture-text</html>' },
    { text: '{"aweme_list":[' },
    { text: { aweme_list: [] } },
    { text: '{"aweme_list":[]}' },
    { text: '{"aweme_list":[],"has_more":"0"}' },
    { text: '{"aweme_list":[],"has_more":2}' },
    { text: '{"aweme_list":{},"has_more":false}' },
    { text: '{"aweme_list":[null],"has_more":false}' },
    { text: '{"aweme_list":[{"aweme_id":"bad-id"}],"has_more":false}' },
    { text: '{"aweme_list":[{"aweme_id":["101"]}],"has_more":false}' },
    { text: '{"aweme_list":[{"aweme_id":0}],"has_more":false}' },
    { text: '{"aweme_list":[{"aweme_id":"101","awemeId":"202"}],"has_more":false}' },
    { text: '{"aweme_list":[{"aweme_id":"101","author":{"uid":["12"]}}],"has_more":false}' },
    { text: '{"aweme_list":[{"aweme_id":"101","video":{"duration":1e400}}],"has_more":false}' },
    { text: '{"aweme_list":[{"aweme_id":7345612390836712343.0}],"has_more":false}' },
    { text: '{"aweme_list":[{"aweme_id":"101"}],"has_more":true}' },
    { text: '{"aweme_list":[{"aweme_id":"101"}],"has_more":true,"cursor":-1}' },
    { text: '{"aweme_list":[],"has_more":false,"status_code":403}' },
    { text: '{"has_more":false,"data":{"aweme_list":[],"has_more":true,"cursor":1}}' },
    { inputCursor: 0 },
    { observedAt: 'unrelated text 2025' },
    { source: { kind: 'total', id: 'wrong' } },
    { status: 206 },
    { status: 403 }
  ];
  for (const change of bad) {
    assert.throws(() => parseSourcePage({ ...input, ...change }), error =>
      error.name === 'ProbeError' && !JSON.stringify(error).includes('private-fixture-text') &&
      !error.message.includes('private-fixture-text'), JSON.stringify(change));
  }
});

test('accepts an explicitly terminal empty source', () => {
  const page = pageOf([]);
  assert.equal(page.terminal, true);
  assert.equal(page.nextCursor, null);
  assert.equal(page.receivedCount, 0);
  assert.equal(page.uniqueCount, 0);
  assert.deepEqual(page.refs, []);
});

test('merges duplicate records and retains source relation and first row order', () => {
  const input = sourceFixture('duplicates');
  const page = parseSourcePage({ ...input, source: { kind: 'collection', id: '33' } });

  assert.deepEqual(page.source, { kind: 'collection', id: '33' });
  assert.equal(page.receivedCount, 3);
  assert.equal(page.uniqueCount, 2);
  assert.deepEqual(page.refs, [{ workId: '101', rank: 0 }, { workId: '102', rank: 2 }]);
  assert.equal(page.works[0].duration, 4310);
  assert.equal(page.works[0].caption, 'Another observation');
  assert.deepEqual(page.works[0].author, {
    uid: '41', secUid: 'fixture-author', uniqueId: '', nickname: 'Enriched'
  });
});

test('matches original parsers for all fields of complete media fixtures', () => {
  const input = sourceFixture('media');
  const page = parseSourcePage(input);
  const items = parsePlatformJSON(input.text).data.aweme_list;
  assert.equal(page.nextCursor, null);
  for (const [index, raw] of items.entries()) {
    const old = parseWork(raw);
    const { observedFields, mediaQuality, ...work } = page.works[index];
    assert.ok(observedFields.includes('author'));
    assert.ok(mediaQuality.videoRanked >= 0);
    old.checkedAt = input.observedAt;
    if (old.creatorsCheckedAt) old.creatorsCheckedAt = input.observedAt;
    assert.deepEqual(work, old);
  }
  const [work] = page.works;
  assert.deepEqual(work.images.map(image => [image.index, image.width, image.height]), [[0, 1200, 900], [1, 640, 800]]);
  assert.deepEqual(work.images[0].urls.map(url => url.split('/').at(-1)), ['photo-1-original', 'photo-1-preview']);
  assert.deepEqual(work.videoUrls.map(url => url.split('/').at(-1)), ['video-high', 'video-1080', 'video-low', 'work-audio']);
  assert.deepEqual(work.coverVariants.map(variant => variant.source), ['origin_cover', 'cover_original_scale', 'cover']);
  assert.equal(work.coverSource, 'origin_cover');
  assert.equal(work.thumbnail, 'https://fixture.douyinpic.com/cover-display');
  assert.equal(work.coAuthorsState, 'verified');
  assert.deepEqual(work.coAuthors.map(creator => [creator.uid, creator.uniqueId, creator.roleTitle]), [['112', 'fixture-co', 'Camera']]);
  assert.deepEqual(work.music.clip, { begin: 0, end: 4310, volume: 0, unit: 'ms' });
  assert.deepEqual(page.aux.audioSourceHints, [{
    workId: '101', sources: audioSources(items[0]), observedAt: input.observedAt, music: work.music
  }]);
  assert.deepEqual(page.aux.audioSourceHints[0].sources.map(source => source.kind), ['music', 'work']);
  assert.deepEqual(page.aux.creatorProfiles.map(creator => creator.uid), ['111', '112', '114']);
});

test('keeps source identity independent of work author identity', () => {
  const input = sourceFixture('media');
  const page = parseSourcePage({ ...input, source: { kind: 'author', id: 'fixture-author-source' } });
  assert.equal(page.source.id, 'fixture-author-source');
  assert.deepEqual(page.works.map(work => work.author.uid), ['111', '114']);
});

test('sparse observations cannot replace reliable fields or local bookkeeping', () => {
  const [known] = parseSourcePage(sourceFixture('media')).works;
  const previous = { ...known, localTags: ['manual'], backupCover: { fixture: true }, readHidden: true };
  const [partial] = pageOf([{
    aweme_id: '101',
    desc: 'New #partial',
    music: { id: '877', title: 'Track renamed' },
    author: { uid: '999', nickname: 'Unrelated author' },
    video: { duration: 0 },
    backupCover: { restored: true },
    localTags: ['platform-forgery'],
    readHidden: false
  }]).works;
  const merged = mergeObservedWork(previous, partial);
  assert.equal(merged.description, 'New #partial');
  assert.equal(merged.name, known.name);
  assert.deepEqual(merged.tags, ['structured', 'challenge', 'description', 'partial']);
  assert.deepEqual(merged.rawTags, known.rawTags);
  for (const field of ['author', 'coAuthors', 'creatorsCheckedAt', 'images', 'type', 'videoUrls',
    'coverVariants', 'coverUrls', 'coverSource', 'thumbnail', 'duration', 'width', 'height', 'publishedAt']) {
    assert.deepEqual(merged[field], known[field], field);
  }
  assert.deepEqual(merged.music, { ...known.music, title: 'Track renamed' });
  assert.deepEqual(merged.localTags, ['manual']);
  assert.deepEqual(merged.backupCover, { fixture: true });
  assert.equal(merged.readHidden, true);
  assert.equal(partial.observedFields.includes('coAuthors'), false);
});

test('keeps a known music state and distinguishes missing collaborators from verified empty', () => {
  const [known] = parseSourcePage(sourceFixture('media')).works;
  const [sparse] = pageOf([{ aweme_id: '101', music: {} }]).works;
  assert.deepEqual(mergeObservedWork(known, sparse).music, known.music);
  assert.deepEqual(mergeObservedWork(known, sparse).coAuthors, known.coAuthors);
  const [explicit] = pageOf([{ aweme_id: '101', cooperation_info: { co_creators: [] } }]).works;
  assert.deepEqual(mergeObservedWork(known, explicit).coAuthors, []);
  assert.equal(mergeObservedWork(known, explicit).coAuthorsState, 'verified');
});

test('keeps explicit deletion through an ordinary list observation', () => {
  const [removed] = pageOf([{ aweme_id: '101', is_delete: 1 }]).works;
  const [sparse] = pageOf([{ aweme_id: '101', desc: 'Still listed' }]).works;
  const merged = mergeObservedWork(removed, sparse);
  assert.equal(merged.remoteState, 'unavailable');
  assert.equal(merged.sourceStatus.method, 'platform');
  assert.equal(merged.sourceStatus.checkedAt, removed.checkedAt);
});

test('keeps supported tag fragments and excludes arbitrary response data', () => {
  const input = sourceFixture('two-works');
  const page = parseSourcePage({
    ...input,
    source: { ...input.source, cookie: 'synthetic-envelope-secret' },
    text: JSON.stringify({
      status_code: 0, has_more: false, response: { cookie: 'synthetic-envelope-secret' },
      aweme_list: [{
        aweme_id: '101',
        headers: { authorization: 'synthetic-auth-secret' },
        text_extra: [{ hashtag_name: 'fixture', hashtag_id: 501, cookie: 'synthetic-tag-secret' }]
      }]
    })
  });
  assert.deepEqual(page.works[0].rawTags.textExtra, [{ hashtag_name: 'fixture', hashtag_id: '501' }]);
  assert.doesNotMatch(JSON.stringify(page), /synthetic-(?:envelope|auth|tag)-secret/);
  assert.throws(() => pageOf([{ aweme_id: '101', video: {
    cover: { url_list: ['https://fixture:synthetic-userinfo-secret@fixture.douyinpic.com/cover'] }
  } }]), { name: 'ProbeError' });
});

test('rejects duplicate decoded object keys and holds strict JSON limits', () => {
  const input = sourceFixture('two-works');
  const pages = [
    '{"has_more":true,"has_more":false,"aweme_list":[]}',
    String.raw`{"has_more":true,"has_\u006dore":false,"aweme_list":[]}`,
    '{"aweme_list":[{"aweme_id":101,"aweme_id":102}],"has_more":false}',
    '{"unused":{"x":1,"x":2},"aweme_list":[],"has_more":false}',
    '{"aweme_list":[],"has_more":false,}',
    '{"aweme_list":[],"has_more":false/* comment */}',
    '{"aweme_list":[],"has_more":false,"unused":' + '['.repeat(128) + '0' + ']'.repeat(128) + '}',
    '{"aweme_list":[],"has_more":false,"unused":"' + 'ü'.repeat(4 * 1024 * 1024) + '"}'
  ];
  for (const [index, text] of pages.entries()) {
    assert.throws(() => parseSourcePage({ ...input, text }), { code: 'SOURCE_PAGE_INVALID' }, 'page ' + index);
  }
  assert.equal(pageOf([{ aweme_id: '101' }, { aweme_id: '102' }]).uniqueCount, 2);
});

test('rejects rounded decimal and exponent tokens in numeric identities and cursors', () => {
  const input = sourceFixture('two-works');
  const pages = [
    '{"aweme_list":[{"aweme_id":100.000000000000001}],"has_more":false}',
    '{"aweme_list":[{"awemeId":1e2}],"has_more":false}',
    '{"aweme_list":[{"aweme_id":100,"author":{"uid":100.000000000000001}}],"has_more":false}',
    '{"aweme_list":[{"aweme_id":100,"music":{"id":100.000000000000001}}],"has_more":false}',
    '{"aweme_list":[{"aweme_id":100}],"has_more":true,"max_cursor":21.000000000000001}',
    '{"aweme_list":[{"aweme_id":100}],"has_more":true,"cursor":2.1e1}'
  ];
  for (const text of pages) {
    assert.throws(() => parseSourcePage({ ...input, text }), { code: 'SOURCE_PAGE_INVALID' }, text);
  }
});

test('keeps coherent prior media when a later row supplies sparse nonempty candidates', () => {
  const [known] = parseSourcePage(sourceFixture('media')).works;
  const [partial] = pageOf([{
    aweme_id: '101',
    images: [{ url_list: ['https://fixture.douyinpic.com/new-preview'] }],
    video: {
      play_addr: { url_list: ['https://fixture.douyinvod.com/new-low'] },
      origin_cover: { url_list: ['https://fixture.douyinpic.com/new-cover'] }
    }
  }]).works;
  const merged = mergeObservedWork(known, partial);
  for (const field of ['images', 'videoUrls', 'coverVariants', 'coverUrls', 'coverSource', 'thumbnail']) {
    assert.deepEqual(merged[field], known[field], field);
  }
});

test('retains original image candidates and ranked video when candidate counts are unchanged', () => {
  const url = name => 'https://fixture.douyinvod.com/' + name;
  const [known] = pageOf([{
    aweme_id: '101',
    images: [{ width: 512, height: 512, origin_image: { url_list: [url('original')] } }],
    video: { play_addr_h264_1080p: { url_list: [url('high')] } }
  }]).works;
  const [weak] = pageOf([{
    aweme_id: '101',
    images: [{ width: 512, height: 512, display_image: { url_list: [url('preview')] } }],
    video: { play_addr: { url_list: [url('low')] } }
  }]).works;
  assert.deepEqual(mergeObservedWork(known, weak).images, known.images);
  assert.deepEqual(mergeObservedWork(known, weak).videoUrls, known.videoUrls);
});

test('replaces media with the exact normalized output of a complete refresh', () => {
  const input = sourceFixture('media');
  const [known] = parseSourcePage(input).works;
  const refresh = parsePlatformJSON(input.text).data.aweme_list[0];
  for (const owner of [refresh.images[0], refresh.images[1], refresh.video.origin_cover,
    refresh.video.cover, refresh.video.cover_original_scale]) {
    for (const key of ['url_list', 'watermark_free_download_url_list']) {
      if (owner[key]) owner[key] = owner[key].map(url => url + '?x-signature=refresh');
    }
  }
  refresh.video.bit_rate[0].play_addr.url_list = ['https://fixture.douyinvod.com/changed-encoded-video'];
  const [updated] = pageOf([refresh]).works;
  const merged = mergeObservedWork(known, updated);
  for (const field of ['images', 'videoUrls', 'coverVariants', 'coverUrls', 'coverSource', 'thumbnail']) {
    assert.deepEqual(merged[field], updated[field], field);
  }
  assert.notDeepEqual(merged.videoUrls, known.videoUrls);
  assert.notDeepEqual(merged.images, known.images);
  assert.notDeepEqual(merged.coverVariants, known.coverVariants);
});

test('keeps malformed coauthor observations unknown while honoring deliberate filter rules', () => {
  const [known] = parseSourcePage(sourceFixture('media')).works;
  const variants = [[{}], [null], [{ invite_status: 'broken' }], [{ uid: '111' }, {}]];
  for (const co_creators of variants) {
    const [partial] = pageOf([{ aweme_id: known.id, cooperation_info: { co_creators } }]).works;
    assert.equal(partial.coAuthorsState, 'unknown');
    assert.equal(partial.coAuthors, undefined);
    assert.deepEqual(mergeObservedWork(known, partial).coAuthors, known.coAuthors);
    assert.equal(mergeObservedWork(known, partial).creatorsCheckedAt, known.creatorsCheckedAt);
  }

  const [filtered] = pageOf([{
    aweme_id: known.id, cooperation_info: { co_creators: [{ invite_status: 0 }, { invite_status: false }] }
  }]).works;
  assert.equal(filtered.coAuthorsState, 'verified');
  assert.deepEqual(filtered.coAuthors, []);
});

test('rejects credentials in media URL query and fragment but retains CDN signatures', () => {
  const base = 'https://fixture.douyinvod.com/track';
  for (const suffix of ['?sessionid_ss=synthetic-session', '?%75ID_TT=synthetic-session',
    '#sessionid_ss=synthetic-session', '#track?SID_GUARD=synthetic-session',
    '#sessionid_ss=synthetic-session?name=value', '?passport_csrf_token=synthetic-session']) {
    assert.throws(() => pageOf([{
      aweme_id: '101', music: { id: '877', play_url: { url_list: [base + suffix] } }
    }]), { code: 'SOURCE_PAGE_INVALID' }, suffix);
  }
  const signed = base + '?x-signature=synth&x-expires=99';
  const page = pageOf([{ aweme_id: '101', video: { play_addr: { url_list: [signed] } } }]);
  assert.deepEqual(page.works[0].videoUrls, [signed]);
});

test('keeps a compatible known music hint across duplicate rows', () => {
  const row = (id, filename) => ({
    aweme_id: '101',
    music: { id, play_url: { url_list: ['https://fixture.douyinvod.com/' + filename] } }
  });
  const first = row('877', 'known');
  const page = pageOf([first, row(undefined, 'unidentified')]);
  assert.equal(page.works[0].music.id, '877');
  assert.deepEqual(page.aux.audioSourceHints[0].sources, audioSources(first));
  assert.deepEqual(page.aux.audioSourceHints[0].music, page.works[0].music);

  const changed = row('878', 'changed');
  const refreshed = pageOf([first, changed]);
  assert.equal(refreshed.works[0].music.id, '878');
  assert.deepEqual(refreshed.aux.audioSourceHints[0].sources, audioSources(changed));
});

test('keeps the higher bit rate and known same-source cover dimensions', () => {
  const row = (rate, coverWidth) => ({
    aweme_id: '101',
    video: {
      bit_rate: [{
        bit_rate: rate,
        play_addr: { width: 1440, height: 900, url_list: ['https://fixture.douyinvod.com/video-' + rate] }
      }],
      origin_cover: {
        width: coverWidth, height: 900, url_list: ['https://fixture.douyinpic.com/cover-' + rate]
      }
    }
  });
  const [known] = pageOf([row(1400, 1440)]).works;
  const [partial] = pageOf([row(400, undefined)]).works;
  const merged = mergeObservedWork(known, partial);
  assert.deepEqual(merged.videoUrls, known.videoUrls);
  assert.deepEqual(merged.coverVariants, known.coverVariants);
});

test('preserves known video dimensions when an otherwise matching candidate is sparse', () => {
  const row = (name, width, height) => ({
    aweme_id: '101',
    video: { width, height, play_addr: { url_list: ['https://fixture.douyinvod.com/' + name] } }
  });
  const [known] = pageOf([row('known', 1920, 1080)]).works;
  const [partial] = pageOf([row('short', 640, undefined)]).works;
  const merged = mergeObservedWork(known, partial);
  assert.deepEqual(merged.videoUrls, known.videoUrls);
  assert.equal(merged.width, 1920);
  assert.equal(merged.height, 1080);
});

test('enriches cover variants by source and keeps the display thumbnail', () => {
  const cover = (name, width) => ({
    url_list: ['https://fixture.douyinpic.com/' + name + '?x-signature=synthetic'],
    width,
    height: width / 2
  });
  const [listed] = pageOf([{ aweme_id: '101', video: { cover: cover('display', 480) } }]).works;
  const [scaled] = pageOf([{ aweme_id: '101', video: { cover_original_scale: cover('scale', 960) } }]).works;
  const [detailed] = pageOf([{ aweme_id: '101', video: { origin_cover: cover('original', 1920) } }]).works;
  const [sparse] = pageOf([{
    aweme_id: '101', video: { origin_cover: cover('temporary', 0), cover: cover('display-refreshed', 480) }
  }]).works;

  const withScale = mergeObservedWork(listed, scaled);
  assert.deepEqual(withScale.coverUrls, scaled.coverUrls);
  assert.equal(withScale.coverSource, 'cover_original_scale');
  assert.equal(withScale.thumbnail, listed.thumbnail);

  const withOriginal = mergeObservedWork(withScale, detailed);
  assert.deepEqual(withOriginal.coverVariants, [
    detailed.coverVariants[0], scaled.coverVariants[0], listed.coverVariants[0]
  ]);
  assert.deepEqual(withOriginal.coverUrls, detailed.coverUrls);
  assert.equal(withOriginal.coverSource, 'origin_cover');
  assert.equal(withOriginal.thumbnail, listed.thumbnail);

  const refreshed = mergeObservedWork(withOriginal, sparse);
  assert.deepEqual(refreshed.coverVariants, [
    detailed.coverVariants[0], scaled.coverVariants[0], sparse.coverVariants[1]
  ]);
  assert.deepEqual(refreshed.coverUrls, detailed.coverUrls);
  assert.equal(refreshed.coverSource, 'origin_cover');
  assert.equal(refreshed.thumbnail, sparse.thumbnail);
});

test('refreshes a proven 1080p URL while preserving omitted video metadata', () => {
  const observeVideo = (video, observedAt) => parseSourcePage({
    ...sourceFixture('two-works'),
    observedAt,
    text: JSON.stringify({ aweme_list: [{ aweme_id: '101', video }], has_more: false })
  }).works[0];
  const oldTime = '2026-01-01T00:00:00.000Z';
  const newTime = '2026-01-02T00:00:00.000Z';
  const sparseTime = '2026-01-03T00:00:00.000Z';
  const address = name => ({ url_list: ['https://fixture.douyinvod.com/' + name] });
  const known = observeVideo({
    width: 1920, height: 1080, duration: 4500, play_addr_h264_1080p: address('known')
  }, oldTime);
  const fresh = observeVideo({ play_addr_h264_1080p: address('fresh') }, newTime);
  const merged = mergeObservedWork(known, fresh);
  assert.deepEqual(merged.videoUrls, fresh.videoUrls);
  assert.deepEqual([merged.width, merged.height, merged.duration], [1920, 1080, 4500]);
  assert.equal(merged.mediaQuality.videoObservedAt, newTime);

  const weak = observeVideo({ play_addr: address('weak') }, sparseTime);
  const retained = mergeObservedWork(merged, weak);
  assert.equal(retained.checkedAt, sparseTime);
  assert.deepEqual(retained.videoUrls, fresh.videoUrls);
  assert.equal(retained.mediaQuality.videoObservedAt, newTime);
});
