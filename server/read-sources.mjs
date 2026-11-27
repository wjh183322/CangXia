import { recordedAuthorFolder } from './files.mjs';
import {mergeCreatorFields} from './source-work-merge.mjs';
import {workCreators,sameCreator,mergeCreator} from '../shared/creators.mjs';
import {saveWorks} from './read-store.mjs';
import { randomUUID } from 'node:crypto';
import { isUuid } from './library.mjs';
import { abortable } from '../electron/browser-api.mjs';
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
    'author',
    'coAuthors',
    'coAuthorsState',
    'creatorsCheckedAt',
    'remoteState',
    'checkedAt'
  ])
    if (work[key] !== undefined) metadata[key] = work[key];
  if (work.url) {
    try {
      const url=new URL(work.url);
      const match=url.pathname.match(/^\/(video|note|slides)\/(\d{1,40})\/?$/);
      if(url.protocol!=='https:'||url.port||url.username||url.password||!['douyin.com','www.douyin.com'].includes(url.hostname)||match?.[2]!==id)throw Error();
      metadata.url=url.origin+url.pathname;
    }catch{metadata.invalidOriginal=true;}
  }
  if(work.sourceStatus){
    const {state,reason,checkedAt}=work.sourceStatus;
    metadata.sourceStatus={state,reason,checkedAt};
  }
  if (work.music) {
    const { id, title, author, duration, state, clip, mixPending } = work.music;
    metadata.music = { id, title, author, duration, state, mixPending, ...(clip?{clip:{begin:clip.begin,end:clip.end,volume:clip.volume,unit:clip.unit}}:{}) };
  }
  return metadata;
}
export function authorEntryVersion(db,key){
  return db.prepare('SELECT version FROM entity_versions WHERE entity=?').get(key)?.version??0;
}
function advanceAuthorEntry(db,key){
  db.prepare('INSERT INTO entity_versions VALUES(?,1) ON CONFLICT(entity) DO UPDATE SET version=version+1').run(key);
  db.prepare('UPDATE catalogue_version SET revision=revision+1 WHERE id=1').run();
}
export function archiveAuthor(db,{payload:{id},entityVersion}){
  if(typeof id!=='string'||!/^MS4wLjAB[A-Za-z0-9_-]{8,240}$/.test(id))throw failure(400,'INVALID_REQUEST','作者标识无效。');
  const key='author:'+id;
  if(db.prepare("SELECT 1 FROM read_batches WHERE status='running'").get()||db.prepare("SELECT 1 FROM download_jobs WHERE state='running'").get())
    throw failure(409,'READ_CONFLICT','请先暂停下载并等待当前读取结束。');
  if(authorEntryVersion(db,key)!==entityVersion)throw failure(409,'STALE_ENTITY','作者入口已更新，请重新核对。');
  if(!db.prepare('UPDATE read_sources SET added=0 WHERE source_id=? AND added=1 AND uid=(SELECT uid FROM source_account WHERE singleton=1)').run(key).changes)
    throw failure(404,'AUTHOR_UNKNOWN','找不到作者入口。');
  advanceAuthorEntry(db,key);
  return {id,entityVersion:entityVersion+1};
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
            ...(typeof u.nickname==='string'&&u.nickname.trim()?{name:u.nickname.trim().slice(0,120)}:{}),
            ...(typeof u.unique_id==='string'&&u.unique_id.trim()?{uniqueId:u.unique_id.trim().slice(0,120)}:{})
          };
        }
      );
    }
  };
}
export function createSourceOperations() {
  const slots = new WeakMap();
  const stopped = () => failure(409, 'SOURCE_STOPPED', '来源读取已停止。');
  function begin(session, action, id) {
    if (!['folders', 'author', 'resolve-work','creator-profiles'].includes(action) || !isUuid(id))
      throw failure(400, 'INVALID_REQUEST', '来源操作无效。');
    if (
      slots.has(session.signal) ||
      session.read((db) => db.prepare("SELECT 1 FROM read_batches WHERE status='running'").get())
    )
      throw failure(409, 'READ_CONFLICT', '已有读取任务正在进行。');
    const slot = { action, id, controller: new AbortController(), started: false };
    slots.set(session.signal, slot);
    return slot;
  }
  return {
    busy: (signal) => slots.has(signal),
    async call(source, session, action, payload) {
      const { operationId } = payload;
      if (action === 'begin') {
        begin(session, payload.action, operationId);
        return { operationId };
      }
      if (action === 'stop') {
        const current = slots.get(session.signal);
        if (current && current.id === operationId) {
          current.controller.abort(stopped());
          slots.delete(session.signal);
        }
        return { stopped: true };
      }
      const slot =
        operationId === undefined ? begin(session, action, randomUUID()) : slots.get(session.signal);
      if (
        !slot ||
        slot.started ||
        slot.action !== action ||
        (operationId !== undefined && slot.id !== operationId)
      )
        throw stopped();
      slot.started = true;
      const signal = AbortSignal.any([slot.controller.signal, session.signal]);
      const guarded = {
        signal,
        read: (fn) =>
          session.read((db) => {
            signal.throwIfAborted();
            return fn(db);
          }),
        write: (fn) =>
          session.write((db) => {
            signal.throwIfAborted();
            return fn(db);
          })
      };
      try {
        return await abortable(sourceAction(source, guarded, action, payload), signal);
      } finally {
        if (slots.get(session.signal) === slot) slots.delete(session.signal);
      }
    }
  };
}
// A stored account identity can fill a missing secUid, but two conflicting
// UID/secUid pairs must never rekey or replace one another's shared profile.
function knownCreator(db,person){
  const rows=db.prepare("SELECT body FROM source_creator_profiles WHERE id=? OR json_extract(body,'$.secUid')=nullif(?,'')").all(person.uid?'uid:'+person.uid:'',person.secUid??'');
  const matches=rows.map(row=>JSON.parse(row.body));
  if(matches.some(known=>!sameCreator(person,known)))return null;
  return matches.reduce((resolved,known)=>sameCreator(resolved,known)?mergeCreator(resolved,known):resolved,person);
}
async function sourceAction(source, session, kind, payload) {
  const account = session.read((db) => boundIdentity(db, source)),
    input = { authEpoch: account.authEpoch, signal: session.signal };
  const commit = (fn) =>
    session.write((db) => {
      if (boundIdentity(db, source).authEpoch !== account.authEpoch)
        throw failure(409, 'STALE_SOURCE_READ', '账号状态已变化。');
      return fn(db);
    });
  if(kind==='creator-profiles'){
    const work=session.read(db=>readWorkDetail(db,{id:payload.id}));
    if(!work)throw failure(404,'WORK_UNKNOWN','找不到作品。');
    function mayContinue(error){
      session.signal.throwIfAborted();
      if(['SOURCE_AUTH','SOURCE_RATE_LIMITED','LOGIN_REQUIRED','STALE_SOURCE_READ','SESSION_LOST'].includes(error.code))throw error;
      session.read(db=>{if(boundIdentity(db,source).authEpoch!==account.authEpoch)throw failure(409,'STALE_SOURCE_READ','账号状态已变化。');});
    }
    let observation,detailMissing=false;
    try{
      const detail=await source.readDetail({...input,workId:work.id});
      if(detail?.id===work.id&&!detail.statusOnly)observation=detail;
      else detailMissing=true;
    }catch(error){mayContinue(error);detailMissing=true;}
    const fields=new Set(observation?.observedFields?.filter(key=>['author','coAuthors'].includes(key)));
    const updated={...work};
    if(observation)mergeCreatorFields(updated,work,observation,fields);
    const profiles=[],people=session.read(db=>workCreators(updated).map(person=>knownCreator(db,person)));
    let attempted=0,unconfirmed=0;
    for(const person of people){
      if(!person){unconfirmed++;continue;}
      if(!/^MS4wLjAB[A-Za-z0-9_-]{8,240}$/.test(person.secUid))continue;
      if(attempted++)await delay(1100,undefined,{signal:session.signal});
      try{
        const row=await source.lookupAuthor(input,'https://www.douyin.com/user/'+person.secUid);
        const profile={uid:row.uid,secUid:row.id,nickname:row.name,uniqueId:row.uniqueId};
        if(row.id!==person.secUid||!sameCreator(person,profile)){unconfirmed++;continue;}
        profiles.push(profile);
      }catch(error){mayContinue(error);unconfirmed++;}
    }
    return commit(db=>{
      const row=db.prepare('SELECT body FROM works WHERE id=?').get(work.id);
      if(!row)throw failure(404,'WORK_UNKNOWN','找不到作品。');
      const current=JSON.parse(row.body),next={...current};
      if(JSON.stringify([current.author,current.coAuthors])!==JSON.stringify([work.author,work.coAuthors]))
        throw failure(409,'STALE_ENTITY','作品作者已更新，请重新核对。');
      if(fields.size){
        mergeCreatorFields(next,current,observation,fields);
        next.observedFields=[...new Set([...(current.observedFields??[]),...fields])];
        db.prepare('UPDATE works SET body=? WHERE id=?').run(JSON.stringify(next),work.id);
      }
      const accepted=profiles.filter(p=>knownCreator(db,p)&&workCreators(next).some(a=>sameCreator(a,p)));
      saveWorks(db,{works:[],aux:{audioSourceHints:[],creatorProfiles:accepted}});
      return {updated:accepted.length,message:'已核对 '+accepted.length+' 位作者'+(detailMissing?'；详情暂不可用，已沿用现有作者记录':'')+(unconfirmed?'；未核实的主页资料已保留原值':'')};
    });
  }
  if (kind === 'folders') {
    const rows = await source.discoverFolders(input);
    return commit((db) => {
      const observed = rows.map(row => 'folder:' + row.id);
      const removed=db.prepare(`UPDATE read_sources SET missing=1 WHERE uid=? AND source_id LIKE 'folder:%' AND missing=0
        AND source_id NOT IN (SELECT value FROM json_each(?))`).run(account.uid,JSON.stringify(observed)).changes;
      const previous=db.prepare("SELECT name,missing,json_extract(body,'$.folder') AS folder FROM read_sources WHERE source_id=?");
      let archiveChanged=removed>0;
      const put = db.prepare(`INSERT INTO read_sources VALUES(?,?,?,?,0,0) ON CONFLICT(source_id)
        DO UPDATE SET name=excluded.name,body=excluded.body,missing=0
        WHERE read_sources.missing<>0 OR read_sources.name<>excluded.name OR read_sources.body<>excluded.body`);
      for (const row of rows) {
        const key='folder:'+row.id, old=previous.get(key);
        if (old && (old.missing || old.name!==row.name)) archiveChanged=true;
        const body=old?.folder && old.name===row.name ? {...row,folder:old.folder} : row;
        put.run(key,account.uid,row.name,JSON.stringify(body));
      }
      return { count: rows.length, archiveChanged };
    });
  }
  if (kind === 'author') {
    const row = await source.lookupAuthor(input, payload.text);
    return commit((db) => {
      const key = 'author:' + row.id,
        old = db.prepare('SELECT body,added,name FROM read_sources WHERE source_id=?').get(key);
      const previous=old&&JSON.parse(old.body);
      if (previous && previous.uid !== row.uid)
        throw failure(409, 'AUTHOR_MISMATCH', '作者身份已变化。');
      const entry={...previous,...row,name:row.name||previous?.name||'未命名作者',uniqueId:row.uniqueId||previous?.uniqueId||''};
      entry.folder=recordedAuthorFolder(db,row.id,old?.name || entry.name);
      db.prepare(
        `INSERT INTO read_sources VALUES(?,?,?,?,1,0) ON CONFLICT(source_id)
        DO UPDATE SET body=excluded.body,name=excluded.name,added=1`
      ).run(key, account.uid, entry.name, JSON.stringify(entry));
      if(!old?.added)advanceAuthorEntry(db,key);
      return { id: row.id };
    });
  }
  const workId = await resolveWorkLink(payload.text, session.signal);
  session.read((db) => boundIdentity(db, source));
  return { kind: 'link', id: workId };
}
