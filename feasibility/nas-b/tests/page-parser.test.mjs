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
    const { observedFields, ...work } = page.works[index];
    assert.ok(observedFields.includes('author'));
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
