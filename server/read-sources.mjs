import { setTimeout as delay } from 'node:timers/promises';
import { resolveAuthorLink, authorURL } from '../electron/author-sources.mjs';
import { parsePlatformJSON } from '../electron/model.mjs';
import { pageResult, normalizeCollections } from '../electron/api-pagination.mjs';
import { apiRequest } from '../electron/browser-api.mjs';
import { failure } from './service-error.mjs';

// Source URLs and archive candidates belong to the NAS. The Windows details
// drawer receives metadata; playback and thumbnail endpoints are added separately.
export function readWorkDetail(db, { id }) {
  if (typeof id !== 'string' || !/^\d{1,40}$/.test(id))
    throw failure(400, 'INVALID_REQUEST', '作品 ID 无效。');
  const row = db.prepare('SELECT title,body FROM works WHERE id=?').get(id);
  if (!row) return null;
  const work = JSON.parse(row.body);
  const metadata = {
    id,
    name: row.title,
    tags: work.tags ?? [],
    images: (work.images ?? []).map(({ index, width, height }) => ({ index, width, height })),
    localTags: db
      .prepare('SELECT tag FROM work_tags WHERE work_id=? ORDER BY tag')
      .all(id)
      .map((r) => r.tag),
    entityVersion:
      db.prepare('SELECT version FROM entity_versions WHERE entity=?').get('tags:' + id)?.version ?? 0
  };
  for (const key of [
    'title',
    'description',
    'caption',
    'type',
    'publishedAt',
    'duration',
    'url',
    'author',
    'coAuthors',
    'coAuthorsState',
    'creatorsCheckedAt',
    'sourceStatus',
    'remoteState',
    'checkedAt'
  ])
    if (work[key] !== undefined) metadata[key] = work[key];
  if (work.music) {
    const { id, title, author, duration, state, clip, mixPending } = work.music;
    metadata.music = { id, title, author, duration, state, clip, mixPending };
  }
  return metadata;
}
export const totalSource = { kind: 'total', id: '__all__' };
export const sourceFromKey = (key) =>
  key === 'total'
    ? totalSource
    : {
        kind: key.startsWith('link:') ? 'link' : key.startsWith('folder:') ? 'collection' : 'author',
        id: key.slice(key.indexOf(':') + 1)
      };
export function boundIdentity(db, source) {
  const identity = source?.account(),
    bound = db.prepare('SELECT uid,profile_id FROM source_account WHERE singleton=1').get();
  if (!identity?.authEpoch || !bound?.profile_id || bound.uid !== identity.uid)
    throw failure(409, 'LOGIN_REQUIRED', '请先连接资料库绑定的抖音账号。');
  return identity;
}
const rejected = (message) => failure(400, 'INVALID_SOURCE_LINK', message);
export async function resolveWorkLink(text, signal, fetcher = fetch) {
  if (typeof text !== 'string' || text.length > 6000) throw rejected('作品链接内容无效。');
  const match = text.match(/https:\/\/[^\s<>\]"，。]+/);
  if (!match) throw rejected('请粘贴抖音作品的分享链接。');
  let url;
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    try {
      url = authorURL(url ?? match[0]);
    } catch {
      throw rejected('请使用抖音 HTTPS 作品链接。');
    }
    const id = url.pathname.match(/^\/(?:share\/)?(?:video|note|slides)\/(\d{1,40})\/?$/)?.[1];
    if (id && /[1-9]/.test(id) && url.hostname !== 'v.douyin.com') return id;
    if (
      url.hostname !== 'v.douyin.com' ||
      !/^\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname) ||
      seen.has(url.href)
    )
      break;
    seen.add(url.href);
    const response = await fetcher(url, {
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(12000)])
    });
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
    try {
      url = new URL(location, url);
    } catch {
      throw rejected('作品短链接跳转无效。');
    }
  }
  throw rejected('无法解析分享链接，请在抖音打开作品并复制完整链接。');
}
function directoryResponse(raw) {
  if (raw.status !== 200) throw failure(409, 'SOURCE_HTTP', '抖音暂未返回完整来源信息。');
  return parsePlatformJSON(raw.text);
}
export function discoveryReads(read) {
  return {
    async discoverFolders(input) {
      const seen = new Set(),
        folders = new Map();
      let cursor = '0';
      for (;;) {
        seen.add(cursor);
        const page = await read(
          input,
          apiRequest('/aweme/v1/web/collects/list/', { params: { cursor, count: 30 } }),
          (raw) => {
            const data = directoryResponse(raw),
              p = pageResult(data, 'collects_list');
            const flag = data.data?.has_more ?? data.has_more;
            if (![true, false, 0, 1].includes(flag))
              throw failure(409, 'SOURCE_PAGE_INVALID', '收藏夹目录分页状态无效。');
            return p;
          }
        );
        const rows = normalizeCollections(page.items);
        if (rows.length !== page.items.length)
          throw failure(409, 'SOURCE_PAGE_INVALID', '收藏夹目录含无效标识。');
        for (const r of rows)
          folders.set(r.collects_id, {
            id: r.collects_id,
            name: r.collects_name.slice(0, 200),
            count: Number(r.aweme_count) || 0
          });
        if (page.complete) return [...folders.values()];
        if (!rows.length || !/^\d{1,40}$/.test(page.next) || seen.has(page.next))
          throw failure(409, 'SOURCE_PAGE_INVALID', '收藏夹目录未完整返回。');
        cursor = page.next;
        await delay(1100, undefined, { signal: input.signal });
      }
    },
    async lookupAuthor(input, text) {
      let id;
      try {
        ({ id } = await resolveAuthorLink(text, fetch, input.signal));
      } catch {
        throw rejected('未能解析作者主页分享链接。');
      }
      return read(
        input,
        apiRequest('/aweme/v1/web/user/profile/other/', {
          params: { sec_user_id: id, publish_video_strategy_type: 2 }
        }),
        (raw) => {
          const data = directoryResponse(raw),
            u = data.user ?? data.data?.user;
          if (u?.sec_uid !== id || !/^\d+$/.test(String(u.uid)))
            throw failure(409, 'AUTHOR_MISMATCH', '未取得相符的作者身份。');
          return {
            id,
            uid: String(u.uid),
            name: String(u.nickname || '未命名作者').slice(0, 120),
            uniqueId: String(u.unique_id || '').slice(0, 120)
          };
        }
      );
    }
  };
}
export async function sourceAction(source, session, kind, payload) {
  const account = session.read((db) => boundIdentity(db, source)),
    input = { authEpoch: account.authEpoch, signal: session.signal };
  const commit = (fn) =>
    session.write((db) => {
      if (boundIdentity(db, source).authEpoch !== account.authEpoch)
        throw failure(409, 'STALE_SOURCE_READ', '账号状态已变化。');
      return fn(db);
    });
  if (kind === 'folders') {
    const rows = await source.discoverFolders(input);
    return commit((db) => {
      db.prepare("UPDATE read_sources SET missing=1 WHERE uid=? AND source_id LIKE 'folder:%'").run(
        account.uid
      );
      const put = db.prepare(`INSERT INTO read_sources VALUES(?,?,?,?,0,0) ON CONFLICT(source_id)
        DO UPDATE SET name=excluded.name,body=excluded.body,missing=0`);
      for (const row of rows) put.run('folder:' + row.id, account.uid, row.name, JSON.stringify(row));
      return { count: rows.length };
    });
  }
  if (kind === 'author') {
    const row = await source.lookupAuthor(input, payload.text);
    return commit((db) => {
      const key = 'author:' + row.id,
        old = db.prepare('SELECT body FROM read_sources WHERE source_id=?').get(key);
      if (old && JSON.parse(old.body).uid !== row.uid)
        throw failure(409, 'AUTHOR_MISMATCH', '作者身份已变化。');
      db.prepare(
        `INSERT INTO read_sources VALUES(?,?,?,?,1,0) ON CONFLICT(source_id)
        DO UPDATE SET body=excluded.body,name=excluded.name,added=1`
      ).run(key, account.uid, row.name, JSON.stringify(row));
      return { id: row.id };
    });
  }
  const workId = await resolveWorkLink(payload.text, session.signal);
  session.read((db) => boundIdentity(db, source));
  return { kind: 'link', id: workId };
}
