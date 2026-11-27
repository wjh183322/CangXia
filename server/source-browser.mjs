import { discoveryReads } from './read-sources.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { apiRequest } from '../electron/browser-api.mjs';
import { validAccountIdentity } from '../electron/account-identity.mjs';
import {
  validateSource,
  parseSourcePage,
  parseSourceDetail,
  inspectSourceResponse
} from './source-parser.mjs';
import { openOfficialProvider } from './source-provider.mjs';
import { SourceError } from './source-error.mjs';
import { inspectLayout, isUuid, syncDirectory, writeDurably } from './library.mjs';

const stale = () => new SourceError('SOURCE_SESSION_LOST', '来源会话已结束，请重新核验账号。');
const loginRequired = () => new SourceError('LOGIN_REQUIRED', '请先使用抖音官方页面完成登录。');
const wrong = () => new SourceError('ACCOUNT_MISMATCH', '抖音账号与此资料库绑定的 UID 不同，请登录原账号。');
const decimal = (v) => typeof v === 'string' && /^\d{1,40}$/.test(v);

function privateStorage(root, libraryId) {
  // Outside the archive database and its migration snapshots.
  function directory() {
    const layout = inspectLayout(root, libraryId);
    const dir = path.join(layout.dir, 'source-session');
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const stat = fs.lstatSync(dir);
    if (
      !stat.isDirectory() ||
      (process.platform !== 'win32' && (stat.mode & 0o077 || stat.uid !== process.getuid()))
    )
      throw Error('NAS 来源会话目录权限无效。');
    return dir;
  }
  function location(id) {
    if (!isUuid(id)) throw Error('无效的 NAS 浏览器会话标识。');
    return path.join(directory(), id + '.json');
  }
  return {
    filesForLogout() {
      const dir = directory();
      return fs
        .readdirSync(dir)
        .filter((name) => name === 'browser.json' || (name.endsWith('.json') && isUuid(name.slice(0, -5))));
    },
    discardFiles(names) {
      const dir = directory();
      for (const name of names) {
        if (name !== 'browser.json' && !(name.endsWith('.json') && isUuid(name.slice(0, -5))))
          throw Error('来源会话文件标识无效。');
        fs.rmSync(path.join(dir, name), { force: true });
      }
      if (names.length) syncDirectory(dir);
    },
    load(id) {
      if (!id) return null;
      const file = location(id);
      let st;
      try {
        st = fs.lstatSync(file);
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
      if (
        !st.isFile() ||
        st.nlink !== 1 ||
        st.size > 8 * 1024 * 1024 ||
        (process.platform !== 'win32' && (st.mode & 0o077 || st.uid !== process.getuid()))
      )
        throw Error('NAS 来源会话文件无效。');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    stage(id, state) {
      const file = location(id);
      const data = JSON.stringify(state);
      if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw Error('来源会话过大。');
      writeDurably(file, data);
      syncDirectory(path.dirname(file));
    },
    discard(id) {
      if (!id) return;
      const file = location(id);
      fs.rmSync(file, { force: true });
      syncDirectory(path.dirname(file));
    }
  };
}
function requestFor(source, cursor, count = 30) {
  source = validateSource(source);
  if (!decimal(cursor)) throw new SourceError('SOURCE_PAGE_INVALID', '来源游标无效。');
  if (!Number.isInteger(count) || count < 1 || count > 30)
    throw new SourceError('SOURCE_PAGE_INVALID', '读取页大小无效。');
  if (source.kind === 'total')
    return apiRequest('/aweme/v1/web/aweme/listcollection/', { method: 'POST', form: { cursor, count } });
  if (source.kind === 'collection')
    return apiRequest('/aweme/v1/web/collects/video/list/', {
      params: { collects_id: source.id, cursor, count }
    });
  return apiRequest('/aweme/v1/web/aweme/post/', {
    params: {
      sec_user_id: source.id,
      max_cursor: cursor,
      count,
      locate_query: false,
      publish_video_strategy_type: 2
    }
  });
}

export function createSourceBrowser({ library, root, openProvider = openOfficialProvider }) {
  const storage = privateStorage(root, library.libraryId);
  let slot = null,
    closed = false,
    pending = Promise.resolve(),
    resumeAt = 0;
  function serial(fn) {
    const next = pending.then(fn);
    pending = next.catch(() => {});
    return next;
  }
  const limited = () => new SourceError('SOURCE_RATE_LIMITED', '抖音提示访问频繁，请稍后重试。');
  function pause(seconds) {
    resumeAt = Date.now() + 1000 * Math.max(1, Number(seconds) || 60);
    throw limited();
  }
  function guard(session) {
    if (closed || session.signal.aborted) throw stale();
    session.read(() => null);
  }
  function retire(current) {
    if (!current) return Promise.resolve();
    if (slot === current) slot = null;
    current.session.signal.removeEventListener('abort', current.stop);
    current.end.abort();
    return current.provider?.close().catch(() => {});
  }
  async function browser(session, { recoveryOnly = false } = {}) {
    guard(session);
    if (slot?.session.signal === session.signal) return slot;
    await retire(slot);
    guard(session);
    const saved = storage.load(bound(session)?.profile_id);
    if (recoveryOnly && !saved) return null;
    const current = { session, end: new AbortController(), identity: null, view: null };
    current.stop = () => {
      void retire(current);
    };
    slot = current;
    session.signal.addEventListener('abort', current.stop, { once: true });
    try {
      current.provider = await openProvider(saved, current.end.signal);
      guard(session);
      if (slot !== current) throw stale();
      return current;
    } catch (e) {
      await retire(current);
      throw e;
    }
  }
  function bound(session) {
    return session.read((db) =>
      db.prepare('SELECT uid,nickname,profile_id FROM source_account WHERE singleton=1').get()
    );
  }
  async function identify(current, signal) {
    if (Date.now() < resumeAt) throw limited();
    let identity;
    try {
      identity = await current.provider.self(signal);
    } catch (error) {
      if (error.code === 'SOURCE_RATE_LIMITED') pause(error.retryAfter);
      throw error;
    }
    guard(current.session);
    if (!validAccountIdentity(identity)) {
      current.identity = null;
      throw loginRequired();
    }
    const account = bound(current.session);
    if (account && account.uid !== identity.uid) {
      current.identity = null;
      throw wrong();
    }
    return { uid: identity.uid, nickname: String(identity.nickname || '').slice(0, 100) };
  }
  async function verify(current) {
    const previous = current.identity;
    current.identity = null;
    let sessionKey = await current.provider.sessionKey();
    if (!sessionKey) throw loginRequired();
    const identity = await identify(current, current.end.signal);
    let state = await current.provider.storage();
    if (sessionKey !== (await current.provider.sessionKey())) throw stale();
    if (current.view) {
      // Replies to already-issued login requests belong to the old cookie jar.
      current.view = null;
      current.provider.endLogin();
      await current.provider.close();
      try {
        guard(current.session);
        current.provider = await openProvider(state, current.end.signal);
        guard(current.session);
        sessionKey = await current.provider.sessionKey();
        if (!sessionKey) throw loginRequired();
        const pinned = await identify(current, current.end.signal);
        if (pinned.uid !== identity.uid) throw wrong();
        state = await current.provider.storage();
        if (sessionKey !== (await current.provider.sessionKey())) throw stale();
      } catch (error) {
        await retire(current);
        throw error;
      }
    }
    guard(current.session);
    const profileId = randomUUID();
    let prior;
    try {
      prior = current.session.write((db) => {
        const row = db.prepare('SELECT uid,profile_id FROM source_account WHERE singleton=1').get();
        if (row && row.uid !== identity.uid) throw wrong();
        storage.stage(profileId, state);
        db.prepare(
          'INSERT INTO source_account(singleton,uid,nickname,profile_id) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET nickname=excluded.nickname,profile_id=excluded.profile_id'
        ).run(identity.uid, identity.nickname, profileId);
        return row?.profile_id;
      });
    } catch (error) {
      // After an ambiguous COMMIT, preserve files unless the durable pointer is known.
      try {
        if (
          library.read(
            (db) => db.prepare('SELECT profile_id FROM source_account WHERE singleton=1').get()?.profile_id
          ) !== profileId
        )
          storage.discard(profileId);
      } catch {}
      throw error;
    }
    storage.discard(prior);
    const sameSession = previous?.uid === identity.uid && current.sessionKey === sessionKey;
    current.sessionKey = sessionKey;
    current.identity = {
      ...identity,
      authEpoch: sameSession ? previous.authEpoch : randomUUID()
    };
    current.view = null;
    current.provider.endLogin();
    return { ...current.identity };
  }
  async function login(session, id, action, value) {
    return serial(async () => {
      guard(session);
      const current = action === 'open' ? await browser(session) : slot;
      if (!current || current.session.signal !== session.signal) throw stale();
      if (Date.now() < resumeAt && action !== 'close') throw limited();
      if (action === 'open') {
        current.identity = null;
        current.view = randomUUID();
      } else if (!id || !current.view || current.view !== id) throw stale();
      if (action === 'close') {
        current.view = null;
        await retire(current);
        return {};
      }
      if (action === 'open' || action === 'refresh') {
        const viewId = current.view;
        await current.provider.beginLogin(() => {
          guard(session);
          if (current !== slot || current.view !== viewId) throw stale();
        });
      }
      if (action === 'shown') return current.provider.qrShown(value);
      if (action === 'manual') await current.provider.manual(value);
      const result = await current.provider.loginView();
      guard(session);
      if (result.phase === 'limited') pause(60);
      if (result.signedIn) {
        const account = await verify(current);
        return { phase: 'success', account };
      }
      const { signedIn, ...view } = result;
      return { ...view, viewId: current.view };
    });
  }
  async function read({ authEpoch, signal }, request, parse) {
    return serial(async () => {
      const current = slot;
      if (!current?.identity || current.identity.authEpoch !== authEpoch) throw stale();
      const stop = signal ? AbortSignal.any([signal, current.end.signal]) : current.end.signal;
      stop.throwIfAborted();
      guard(current.session);
      const check = async () => {
        if (Date.now() < resumeAt) throw limited();
        try {
          if ((await current.provider.sessionKey()) !== current.sessionKey) throw stale();
          await identify(current, stop);
          if ((await current.provider.sessionKey()) !== current.sessionKey) throw stale();
        } catch (e) {
          if (e.code !== 'SOURCE_RATE_LIMITED') current.identity = null;
          throw e;
        }
        stop.throwIfAborted();
      };
      await check();
      const raw = await current.provider.read(request, stop);
      stop.throwIfAborted();
      const issue = inspectSourceResponse(raw);
      if (issue.code === 'SOURCE_RATE_LIMITED') pause(issue.retryAfter);
      if (issue.code) {
        current.identity = null;
        throw new SourceError(issue.code, '抖音拒绝了此次来源读取，请检查登录或验证要求。');
      }
      await check();
      return parse({ ...raw, observedAt: new Date().toISOString() });
    });
  }
  return {
    account: () => (slot?.identity ? { ...slot.identity } : null),
    recover: (session) =>
      serial(async () => {
        const current = await browser(session, { recoveryOnly: true });
        return current ? verify(current) : null;
      }),
    verifyAccount: (session) => serial(async () => verify(await browser(session))),
    openLogin: (session) => login(session, null, 'open'),
    loginView: (session, id) => login(session, id, 'view'),
    refreshLogin: (session, id) => login(session, id, 'refresh'),
    qrShown: (session, id, token) => login(session, id, 'shown', token),
    manualLogin: (session, id, value) => login(session, id, 'manual', value),
    cancelLogin: (session, id) => login(session, id, 'close'),
    logout: (session) =>
      serial(async () => {
        guard(session);
        const prior = session.write((db) => {
          const files = storage.filesForLogout();
          db.exec('UPDATE source_account SET profile_id=NULL WHERE singleton=1');
          return files;
        });
        try {
          storage.discardFiles(prior);
        } finally {
          await retire(slot);
        }
        return {};
      }),
    ...discoveryReads(read),
    async readSourcePage({ source, cursor, authEpoch, signal, count }) {
      return read({ authEpoch, signal }, requestFor(source, cursor, count), (raw) =>
        parseSourcePage({ ...raw, source, inputCursor: cursor })
      );
    },
    async readDetail({ workId, authEpoch, signal }) {
      if (!decimal(workId)) throw new SourceError('SOURCE_PAGE_INVALID', '作品 ID 无效。');
      return read(
        { authEpoch, signal },
        apiRequest('/aweme/v1/web/aweme/detail/', { params: { aweme_id: workId } }),
        (raw) => parseSourceDetail({ ...raw, workId })
      );
    },
    async close() {
      closed = true;
      await retire(slot);
      await pending;
    }
  };
}
