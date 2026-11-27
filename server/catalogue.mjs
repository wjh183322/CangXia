import { createHmac } from 'node:crypto';
import {
  creatorIndex,
  creatorKey,
  matchesCreator,
  normalizeCreator,
  withCreatorProfile
} from '../shared/creators.mjs';
import { contentHash } from '../shared/backup-protocol.mjs';
import { failure } from './service-error.mjs';
import { readWorkDetail } from './read-sources.mjs';

const invalid = () => failure(400, 'INVALID_CATALOGUE', '资料库查询参数无效。');
const expired = () => failure(409, 'CATALOGUE_CHANGED', '资料库或选择范围已变化，请重新核对选择。');
const pageSize = 20;
const idPattern = /^\d{1,40}$/;
function value(input, max = 256) {
  if (typeof input !== 'string' || input.length > max) throw invalid();
  return input;
}
function option(input, options) {
  if (!options.includes(input)) throw invalid();
  return input;
}
function strings(input, max = 100) {
  if (!Array.isArray(input) || input.length > max) throw invalid();
  return [...new Set(input.map((x) => value(x)))];
}
function scopeOptions(input) {
  const { source = 'total', sort = 'original', filter = {} } = input;
  if (
    !['total', 'all', 'media', 'empty'].includes(source) &&
    !(
      typeof source === 'string' &&
      /^(?:folder:\d{1,40}|author:[A-Za-z0-9_-]{1,240}|media-folder:\d{1,40})$/.test(source)
    )
  )
    throw invalid();
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw invalid();
  return {
    source,
    sort: option(sort, ['original', 'size-asc', 'size-desc']),
    filter: {
      query: value(filter.query ?? '')
        .trim()
        .toLocaleLowerCase(),
      type: option(filter.type ?? 'all', ['all', 'images', 'video']),
      author: value(filter.author ?? ''),
      tags: strings(filter.tags ?? []),
      tagMode: option(filter.tagMode ?? 'any', ['all', 'any']),
      localTags: strings(filter.localTags ?? []),
      localTagMode: option(filter.localTagMode ?? 'any', ['all', 'any']),
      source: option(filter.source ?? 'all', ['all', 'available', 'unavailable', 'unchecked', 'unknown']),
      downloaded: option(filter.downloaded ?? 'all', ['all', 'complete', 'unsaved', 'missing', 'checking'])
    }
  };
}
export const catalogueRevision = (db) =>
  db.prepare('SELECT revision FROM catalogue_version WHERE id=1').get().revision;
function pageNumber(input) {
  if (!Number.isSafeInteger(input) || input < 1 || input > 1e8) throw invalid();
  return input;
}
const srcState =
  "CASE WHEN json_extract(w.body,'$.remoteState')='unavailable' THEN 'unavailable' ELSE coalesce(json_extract(w.body,'$.sourceStatus.state'),'unchecked') END";
const bytes = '(SELECT sum(size) FROM media_files WHERE work_id=w.id)';
const hasMedia =
  "EXISTS(SELECT 1 FROM media_files WHERE work_id=w.id AND lower(relative_path) NOT LIKE '%.json')";
// An archive may contain only a cover or a subset of an album. Count registered primary assets.
const videoFiles =
  "(SELECT count(*) FROM media_files WHERE work_id=w.id AND lower(relative_path) GLOB '*.mp4')";
const imageFiles =
  "(SELECT count(*) FROM media_files WHERE work_id=w.id AND (lower(relative_path) GLOB '*.jpg' OR lower(relative_path) GLOB '*.jpeg' OR lower(relative_path) GLOB '*.webp' OR lower(relative_path) GLOB '*.png') AND lower(relative_path) NOT LIKE '%cover%')";
const checking = "coalesce(json_extract(w.body,'$.localStatus'),'') IN ('checking','unknown')";
const complete = `NOT (${checking}) AND EXISTS(SELECT 1 FROM download_jobs d WHERE d.work_id=w.id AND d.state='complete') AND CASE WHEN json_extract(w.body,'$.type')='images' THEN json_array_length(w.body,'$.images')>0 AND ${imageFiles}>=json_array_length(w.body,'$.images') ELSE ${videoFiles}>0 END`;
const resolvedPerson = `cx_person(p.person,coalesce(
  (SELECT body FROM source_creator_profiles WHERE id='uid:'||json_extract(p.person,'$.uid')),
  (SELECT body FROM source_creator_profiles WHERE json_extract(body,'$.secUid')=nullif(json_extract(p.person,'$.secUid'),'') LIMIT 1)
))`;
const people = `SELECT ${resolvedPerson} AS person FROM catalogue_people p WHERE p.work_id=w.id`;
function installFunctions(db) {
  db.function('cx_person', { deterministic: true }, (raw, body) => {
    const person = JSON.parse(raw);
    return JSON.stringify(
      body ? withCreatorProfile(person, creatorIndex([JSON.parse(body)])) : normalizeCreator(person)
    );
  });
  db.function('cx_key', { deterministic: true }, (raw) => creatorKey(JSON.parse(raw)));
  db.function('cx_author', { deterministic: true }, (raw, key) =>
    Number(matchesCreator(JSON.parse(raw), key))
  );
  db.function('cx_lower', { deterministic: true }, (s) => String(s ?? '').toLocaleLowerCase());
}
function build({ source, sort, filter: f }) {
  let from = ' FROM works w',
    order = 'w.rowid';
  const where = ["coalesce(json_extract(w.body,'$.readHidden'),0)=0"],
    args = [];
  if (source === 'empty') where.push('0');
  else if (source === 'all' || source === 'media') {
    from += " LEFT JOIN source_members m ON m.work_id=w.id AND m.source_id='total'";
    order = 'm.position IS NULL,m.order_generation DESC,m.position,w.rowid';
  } else {
    from = ' FROM source_members m JOIN works w ON w.id=m.work_id';
    where.push('m.source_id=?');
    args.push(source.replace(/^media-folder:/, 'folder:'));
    order = 'm.order_generation DESC,m.position,m.work_id';
  }
  if (source === 'media' || source.startsWith('media-folder:')) where.push(hasMedia);
  if (sort !== 'original')
    order = bytes + ' IS NULL,' + bytes + (sort === 'size-desc' ? ' DESC,' : ' ASC,') + order;
  const add = (sql, arg) => {
    where.push(sql);
    args.push(arg);
  };
  if (f.type !== 'all') add("json_extract(w.body,'$.type')=?", f.type);
  if (f.source !== 'all') add(srcState + '=?', f.source);
  if (f.downloaded === 'complete') where.push(complete);
  if (f.downloaded === 'unsaved') where.push('NOT ' + hasMedia + ' AND NOT (' + checking + ')');
  if (f.downloaded === 'missing')
    where.push(`(${srcState})<>'unavailable' AND NOT (${checking}) AND NOT coalesce((${complete}),0)`);
  if (f.downloaded === 'checking') where.push(checking);
  if (f.author) add(`EXISTS(SELECT 1 FROM (${people}) WHERE cx_author(person,?))`, f.author);
  for (const [list, mode, sub, column] of [
    [f.tags, f.tagMode, "json_each(w.body,'$.tags')", 'value'],
    [f.localTags, f.localTagMode, 'work_tags t', 'tag']
  ]) {
    if (!list.length) continue;
    const predicate =
      (sub === 'work_tags t' ? 't.work_id=w.id AND ' : '') + column + ' IN (SELECT value FROM json_each(?))';
    add(
      mode === 'any'
        ? `EXISTS(SELECT 1 FROM ${sub} WHERE ${predicate})`
        : `(SELECT count(DISTINCT ${column}) FROM ${sub} WHERE ${predicate})=${list.length}`,
      JSON.stringify(list)
    );
  }
  if (f.query) {
    const personText = `SELECT group_concat(json_extract(person,'$.nickname')||' '||json_extract(person,'$.uniqueId')||' '||json_extract(person,'$.uid')||' '||json_extract(person,'$.secUid'),' ') FROM (${people})`;
    add(
      `(w.id=? OR instr(cx_lower(concat_ws(' ',w.title,json_extract(w.body,'$.title'),json_extract(w.body,'$.description'),(${personText}),(SELECT group_concat(value,' ') FROM json_each(w.body,'$.tags')),(SELECT group_concat(tag,' ') FROM work_tags WHERE work_id=w.id))),?)>0)`,
      f.query
    );
    args.push(f.query);
  }
  return { from: from + ' WHERE ' + where.join(' AND '), args, order };
}
function context(db, input, { grant }) {
  installFunctions(db);
  const options = scopeOptions(input),
    revision = catalogueRevision(db);
  if (input.revision != null && input.revision !== revision) throw expired();
  const scope = createHmac('sha256', grant.proof).update(contentHash({ options, revision })).digest('hex');
  return { ...build(options), options, revision, scope };
}
function summary(db, id) {
  const detail = readWorkDetail(db, { id });
  const media = db
    .prepare(
      `SELECT ${hasMedia} AS local,${complete} AS downloaded,${bytes} AS size,json_extract(w.body,'$.localStatus') AS saved_status FROM works w WHERE id=?`
    )
    .get(id);
  const rows = db
    .prepare(`SELECT ${resolvedPerson} AS person FROM catalogue_people p WHERE p.work_id=?`)
    .all(id);
  const index = creatorIndex(rows.map((x) => JSON.parse(x.person)));
  const author = withCreatorProfile(detail.author, index),
    coAuthors = (detail.coAuthors ?? []).map((p) => withCreatorProfile(p, index));
  const { images, ...fields } = detail;
  const recordSources = db
    .prepare(
      "SELECT source_id FROM source_members WHERE work_id=? ORDER BY (source_id='total') DESC,source_id"
    )
    .all(id)
    .map(({ source_id: key }) =>
      key === 'total' ? '__all__' : key.startsWith('folder:') ? key.slice(7) : key
    );
  return {
    ...fields,
    author,
    coAuthors,
    recordSources,
    images: [],
    imageCount: images.length,
    light: true,
    local: !!media.local,
    downloaded: !!media.downloaded,
    localStatus: ['unknown', 'checking'].includes(media.saved_status)
      ? media.saved_status
      : media.downloaded
        ? 'complete'
        : media.local
          ? 'partial'
          : 'none',
    localBytes: media.size ?? 0,
    localBytesKnown: media.size !== null
  };
}
export function catalogueDetail(db, { id }) {
  const detail = readWorkDetail(db, { id });
  if (!detail) return null;
  installFunctions(db);
  const { light, ...card } = summary(db, id);
  return { ...card, ...detail, author: card.author, coAuthors: card.coAuthors };
}
export function listWorks(db, input, owner) {
  const ctx = context(db, input, owner),
    { from, args, order, revision, scope, options } = ctx;
  const total = db.prepare('SELECT count(*) AS n' + from).get(...args).n,
    pages = Math.max(1, Math.ceil(total / pageSize)),
    page = Math.min(pages, pageNumber(input.page ?? 1));
  const ids = db
    .prepare('SELECT w.id' + from + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?')
    .all(...args, pageSize, (page - 1) * pageSize)
    .map((row) => row.id);
  const base = build({ ...options, filter: scopeOptions({}).filter });
  const stats = db
    .prepare(
      "SELECT count(*) AS total,count(*) FILTER(WHERE json_extract(w.body,'$.type')='video') AS videos,count(*) FILTER(WHERE json_extract(w.body,'$.type')='images') AS images" +
        base.from
    )
    .get(...base.args);
  return { ids, items: ids.map((id) => summary(db, id)), page, pages, total, stats, revision, scope };
}
export function cataloguePosition(db, input, owner) {
  if (typeof input.id !== 'string' || !idPattern.test(input.id)) throw invalid();
  const { from, args, order, revision } = context(db, input, owner);
  const row = db
    .prepare(
      'SELECT position FROM (SELECT w.id,row_number() OVER(ORDER BY ' +
        order +
        ')-1 AS position' +
        from +
        ') WHERE id=?'
    )
    .get(...args, input.id);
  return { position: row?.position ?? -1, revision };
}
export function catalogueChoices(db, input, owner) {
  const { from, args, order } = context(db, { source: input.source }, owner);
  const kind = option(input.kind, ['authors', 'tags', 'myTags']);
  const q = value(input.query ?? '')
      .trim()
      .toLocaleLowerCase(),
    page = pageNumber(input.page ?? 1),
    offset = (page - 1) * 50;
  const ordered = `SELECT w.id,w.body,row_number() OVER(ORDER BY ${order}) AS rank${from}`;
  if (kind === 'authors') {
    // Keep the Map insertion order used by the original dropdown. Its latest
    // label wins if two observations of the same creator have different names.
    const rows = db
      .prepare(
        `WITH ordered AS (${ordered}), participants AS (
      SELECT rank,0 AS ordinal,coalesce(json_extract(body,'$.author'),'{}') AS person FROM ordered
      UNION ALL SELECT rank,t.key+1,t.value FROM ordered,json_each(ordered.body,'$.coAuthors') t
    ), resolved AS MATERIALIZED (SELECT rank,ordinal,${resolvedPerson} AS person FROM participants p),
    ranked AS (SELECT cx_key(person) AS id,person,
      first_value(rank) OVER source_order AS first_rank,first_value(ordinal) OVER source_order AS first_ordinal,
      row_number() OVER(PARTITION BY cx_key(person) ORDER BY rank DESC,ordinal DESC) AS last
      FROM resolved WINDOW source_order AS (PARTITION BY cx_key(person) ORDER BY rank,ordinal))
    SELECT id,json_extract(person,'$.nickname') AS label FROM ranked WHERE last=1 AND id<>'' AND
      instr(cx_lower(concat_ws(' ',json_extract(person,'$.nickname'),json_extract(person,'$.uniqueId'),json_extract(person,'$.secUid'),json_extract(person,'$.uid'),id)),?)>0
    ORDER BY first_rank,first_ordinal,id LIMIT 51 OFFSET ?`
      )
      .all(...args, q, offset);
    return { items: rows.slice(0, 50).map((r) => [r.id, r.label]), hasMore: rows.length > 50, page };
  }
  // Node SQLite has no custom collation hook. Sort distinct matching labels on
  // the NAS with the renderer's locale, retaining first occurrence for equal labels.
  const sourceTags = `WITH ordered AS (${ordered}), seen AS (SELECT t.value AS tag,rank,t.key AS ordinal,
      row_number() OVER(PARTITION BY t.value ORDER BY rank,t.key) AS occurrence FROM ordered,json_each(ordered.body,'$.tags') t)
      SELECT tag FROM seen WHERE occurrence=1 AND instr(cx_lower(tag),?)>0 ORDER BY rank,ordinal`;
  const localTags = `SELECT t.tag FROM work_tags t JOIN works w ON w.id=t.work_id WHERE instr(cx_lower(t.tag),?)>0
      GROUP BY t.tag ORDER BY min(w.rowid),min(t.rowid)`;
  const rows = db
    .prepare(kind === 'myTags' ? localTags : sourceTags)
    .all(...(kind === 'myTags' ? [] : args), q);
  const collator = new Intl.Collator('zh-CN');
  rows.sort((a, b) => collator.compare(a.tag, b.tag));
  return {
    items: rows.slice(offset, offset + 50).map((r) => [r.tag, r.tag]),
    hasMore: rows.length > offset + 50,
    page
  };
}
// Called inside the downstream command's write transaction. Materialize NAS-side only,
// before mutating anything, because the command may change its own filter or revision.
export function confirmedSelection(db, input, owner, { collect = false } = {}) {
  const { from, args, order, scope, revision } = context(db, input, owner);
  if (input.scope !== scope || input.revision !== revision || typeof input.all !== 'boolean') throw expired();
  const ids = strings(input.ids, 10000);
  if (ids.some((id) => !idPattern.test(id))) throw invalid();
  const membership = 'w.id IN (SELECT value FROM json_each(?))';
  const inside = db
    .prepare('SELECT count(*) AS n' + from + ' AND ' + membership)
    .get(...args, JSON.stringify(ids)).n;
  if (inside !== ids.length) throw expired();
  const selection = from + ' AND ' + (input.all ? 'NOT ' : '') + membership,
    params = [...args, JSON.stringify(ids)];
  const count = db.prepare('SELECT count(*) AS n' + selection).get(...params).n;
  if (collect && (!Number.isSafeInteger(input.confirmedCount) || input.confirmedCount !== count))
    throw expired();
  return collect
    ? db
        .prepare('SELECT w.id' + selection + ' ORDER BY ' + order)
        .all(...params)
        .map((r) => r.id)
    : { count, revision, scope };
}
