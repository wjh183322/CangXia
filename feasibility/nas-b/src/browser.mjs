import { createHash, randomInt, randomUUID } from 'node:crypto';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { abortable, apiRequest, fetchInPage } from '../../../electron/browser-api.mjs';
import { validAccountIdentity, verifyAccountIdentity } from '../../../electron/account-identity.mjs';
import { isMediaURL } from '../../../electron/model.mjs';
import { PROBE, ProbeError } from './contracts.mjs';

const origin = 'https://www.douyin.com';
const home = `${origin}/user/self`;
const selfRoute = '/aweme/v1/web/user/profile/self/';
const detailRoute = '/aweme/v1/web/aweme/detail/';
const collectionRoute = '/aweme/v1/web/aweme/listcollection/';
const viewport = Object.freeze({ width: 1000, height: 760 });
const requestTimeout = 12000;
const maxResponseBytes = 8 * 1024 * 1024;
const keys = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']);
const requestFields = new Set(['authEpoch', 'signal', 'method', 'params', 'form']);
const routeParams = new Map([
  [selfRoute, []],
  [collectionRoute, []],
  ['/aweme/v1/web/collects/list/', ['cursor', 'count']],
  ['/aweme/v1/web/collects/video/list/', ['collects_id', 'cursor', 'count']],
  [detailRoute, ['aweme_id', 'origin_type']],
  ['/aweme/v1/web/user/profile/other/', ['sec_user_id', 'publish_video_strategy_type']],
  ['/aweme/v1/web/aweme/post/', ['sec_user_id', 'max_cursor', 'count', 'locate_query', 'publish_video_strategy_type']]
]);
const sessionNames = new Set(['sessionid', 'sessionid_ss', 'uid_tt']);

const unsafeProfile = () => new ProbeError('UNSAFE_BROWSER_PROFILE', 'The isolated browser directory is unavailable or unsafe.');
const closedBrowser = () => new ProbeError('PROBE_BROWSER_CLOSED', 'The probe browser is closed.');
const staleAuth = () => new ProbeError('STALE_AUTH_EPOCH', 'The source authorization changed. Recheck the signed-in account.');
const authRequired = () => new ProbeError('PROBE_AUTH_REQUIRED', 'Verify the normal browser login before reading the source.');
const staleView = () => new ProbeError('STALE_BROWSER_VIEW', 'Refresh the verification view before sending input.');
const invalidInput = () => new ProbeError('INVALID_BROWSER_INPUT', 'The verification input is outside the supported controls.');
const invalidRoute = () => new ProbeError('PROBE_BROWSER_ROUTE', 'The probe only accepts supported read-only browser requests.');
const requestFailed = () => new ProbeError('PROBE_BROWSER_REQUEST', 'The source browser request failed.');

function owned(stat) {
  return process.getuid === undefined || stat.uid === process.getuid();
}

async function chromiumSingleton(directory, name) {
  if (process.platform !== 'linux') return false;
  const link = await readlink(path.join(directory, name));
  switch (name) {
    case 'SingletonLock': return /^[\w.-]{1,253}-[1-9]\d{0,9}$/.test(link);
    case 'SingletonCookie': return /^\d{1,20}$/.test(link);
    case 'SingletonSocket': {
      const parent = path.dirname(link);
      const temp = path.resolve(tmpdir());
      return path.join(parent, 'SingletonSocket') === link && path.dirname(parent) === temp &&
        /^\.(?:org\.chromium\.Chromium|com\.google\.Chrome(?:\.[a-z-]+)?)\.[\w-]{6}$/.test(path.basename(parent));
    }
    default: return false;
  }
}

async function checkProfileTree(directory, base = directory) {
  for (const name of await readdir(directory)) {
    const target = path.join(directory, name);
    const stat = await lstat(target);
    if (!owned(stat)) throw unsafeProfile();
    if (stat.isDirectory()) await checkProfileTree(target, base);
    else if (stat.isFile() && stat.nlink === 1) continue;
    else if (stat.isSymbolicLink() && directory === base && await chromiumSingleton(directory, name)) continue;
    else throw unsafeProfile();
  }
}

async function profileIdentity(root, directory, scan = false) {
  try {
    const base = await lstat(root);
    const stat = await lstat(directory);
    if (!base.isDirectory() || !stat.isDirectory() || !owned(stat) || (process.platform === 'linux' && (stat.mode & 0o077)) ||
        await realpath(directory) !== directory) {
      throw unsafeProfile();
    }
    if (scan) await checkProfileTree(directory);
    return `${base.dev}:${base.ino}:${stat.dev}:${stat.ino}`;
  } catch {
    throw unsafeProfile();
  }
}

function authState(db) {
  const row = db.prepare("SELECT value FROM runtime_meta WHERE key='browser_auth'").get();
  if (!row) return { authEpoch: 0, uid: null };
  try {
    const { authEpoch, uid } = JSON.parse(row.value);
    if (Number.isSafeInteger(authEpoch) && authEpoch >= 1 && (uid === null || validAccountIdentity({ uid }))) {
      return { authEpoch, uid };
    }
  } catch {
    // Corrupt state must never reset an existing library binding.
  }
  throw new ProbeError('PROBE_AUTH_STATE', 'The stored source authorization is invalid.');
}

function writeAuth(db, state) {
  db.prepare(`
    INSERT INTO runtime_meta VALUES ('browser_auth',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(JSON.stringify(state));
  return state;
}

function advanceAuth(db, knownEpoch) {
  const state = authState(db);
  if (knownEpoch !== undefined && knownEpoch !== state.authEpoch) throw staleAuth();
  if (state.authEpoch === Number.MAX_SAFE_INTEGER) throw new ProbeError('PROBE_AUTH_STATE', 'The source authorization epoch is exhausted.');
  return writeAuth(db, { ...state, authEpoch: state.authEpoch + 1 });
}

function webTarget(value) {
  try {
    const target = new URL(value);
    if (target.protocol === 'https:' && !target.username && !target.password && !target.port) return target;
  } catch {
    // Caller receives a fixed error, never the submitted URL.
  }
  return null;
}

function sourcePage(url, kind) {
  const target = webTarget(url);
  return target?.origin === origin && (target.pathname === '/user/self' || (kind === 'login' && target.pathname === '/'));
}

function readParams(value, allowed) {
  if (value === undefined) return undefined;
  if (!value || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw invalidRoute();
  const entries = Object.entries(value);
  for (const [key, entry] of entries) {
    if (!allowed.includes(key) ||
        !(typeof entry === 'string' && entry.length <= 1024 || typeof entry === 'boolean' || Number.isSafeInteger(entry))) throw invalidRoute();
  }
  return Object.fromEntries(entries);
}

function approvedRead(route, options) {
  const params = routeParams.get(route);
  if (!params || !options || Object.keys(options).some(key => !requestFields.has(key)) ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
      (options.form !== undefined && route !== collectionRoute)) throw invalidRoute();
  try {
    return apiRequest(route, { method: options.method, params: readParams(options.params, params), form: readParams(options.form, ['cursor', 'count']) });
  } catch {
    throw invalidRoute();
  }
}

function browserTraffic(context, pages) {
  const totals = { completedRequests: 0, sentBytes: 0, receivedBytes: 0, blockedRequests: 0, failedRequests: 0, unknownSizes: 0 };
  const blocked = new WeakSet();
  context.on('requestfailed', request => {
    if (!blocked.has(request)) totals.failedRequests++;
  });
  context.on('requestfinished', async request => {
    totals.completedRequests++;
    try {
      const sizes = await request.sizes();
      const counts = [sizes.requestBodySize, sizes.requestHeadersSize, sizes.responseBodySize, sizes.responseHeadersSize];
      if (counts.some(size => !Number.isSafeInteger(size) || size < 0)) throw new Error();
      totals.sentBytes += counts[0] + counts[1];
      totals.receivedBytes += counts[2] + counts[3];
    } catch {
      totals.unknownSizes++;
    }
  });
  return {
    observe: () => ({ browser: { ...totals } }),
    install: () => context.route('**/*', async route => {
      const request = route.request();
      let allowed = false;
      try {
        const frame = request.frame();
        const page = frame.page();
        const ownedPage = pages.get(page);
        const url = request.url();
        const target = webTarget(url);
        const preload = target && isMediaURL(url) && /\.(?:mp4|m4s|mov|webm|flv|mp3|m4a|aac|m3u8)$/i.test(target.pathname);
        allowed = !!ownedPage && !!target && request.resourceType() !== 'media' && !preload &&
          (!request.isNavigationRequest() || frame !== page.mainFrame() || sourcePage(url, ownedPage.kind));
      } catch {
        // Requests without an owned frame cannot load a source document.
      }
      if (allowed) await route.continue();
      else {
        blocked.add(request);
        totals.blockedRequests++;
        await route.abort();
      }
    })
  };
}

function sessionFingerprint(cookies) {
  const values = cookies
    .filter(({ name, domain }) => sessionNames.has(name) && ['douyin.com', 'www.douyin.com'].includes(domain.replace(/^\./, '')))
    .map(({ name, domain, path: cookiePath, value }) => JSON.stringify([name, domain, cookiePath, value]))
    .sort();
  return createHash('sha256').update(values.join('\n')).digest('hex');
}

function queue() {
  let last = Promise.resolve();
  return callback => {
    const next = last.then(callback);
    last = next.catch(() => {});
    return next;
  };
}

export async function openBrowserGateway({ config, chromium, store, clock = performance }) {
  const root = config?.root;
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root ||
      path.parse(root).root === root || (!chromium && (process.platform !== 'linux' || root !== PROBE.root))) throw unsafeProfile();
  const directory = path.join(root, 'browser');
  const captured = await profileIdentity(root, directory, true);
  let context;
  let state;
  const pages = new Map();
  let observeTraffic;
  try {
    chromium ??= (await import('playwright-core')).chromium;
    if (await profileIdentity(root, directory) !== captured) throw unsafeProfile();
    context = await chromium.launchPersistentContext(directory, {
      headless: false,
      timeout: 20000,
      viewport,
      deviceScaleFactor: 1,
      acceptDownloads: false,
      chromiumSandbox: true,
      serviceWorkers: 'block',
      args: ['--autoplay-policy=user-gesture-required']
    });
    if (await profileIdentity(root, directory) !== captured) throw unsafeProfile();
    const traffic = browserTraffic(context, pages);
    await traffic.install();
    observeTraffic = traffic.observe;
    if (context.pages().some(page => page.url() !== 'about:blank')) throw unsafeProfile();
    state = store.withWrite(db => advanceAuth(db));
  } catch (error) {
    await context?.close().catch(() => {});
    if (error instanceof ProbeError) throw error;
    throw new ProbeError('PROBE_BROWSER_START', 'The dedicated Chromium session could not start.');
  }

  const withView = queue();
  const withSource = queue();
  const schedule = clock.setTimeout?.bind(clock) ?? setTimeout;
  const unschedule = clock.clearTimeout?.bind(clock) ?? clearTimeout;
  let nextStart = -Infinity;
  let heldUntil = -Infinity;
  let closed = false;
  let closeTask;
  let verifying = false;
  let binding;
  let pageRevision = randomInt(1, 2 ** 31);
  let epochController = new AbortController();
  let login;
  let reader;
  let detail;

  function invalidate() {
    binding = undefined;
    epochController.abort(staleAuth());
    state = store.withWrite(db => advanceAuth(db, state.authEpoch));
    epochController = new AbortController();
  }

  function assertOpen() {
    if (closed) throw closedBrowser();
  }

  function assertAuthEpoch(authEpoch) {
    assertOpen();
    const current = authState(store.db);
    if (!current.uid && !binding) throw authRequired();
    if (state.authEpoch !== authEpoch || current.authEpoch !== authEpoch || current.uid !== state.uid ||
        !binding || verifying) throw staleAuth();
  }

  function stopped() {
    if (closed) return;
    closed = true;
    pageRevision++;
    binding = undefined;
    epochController.abort(closedBrowser());
  }
  context.on('close', stopped);

  async function makePage(kind) {
    const page = context.pages().find(page => page.url() === 'about:blank' && !pages.has(page)) ?? await context.newPage();
    const slot = { page, kind, revision: 0, pressed: false };
    pages.set(page, slot);
    page.on('popup', popup => { void popup.close().catch(() => {}); });
    page.on('close', () => {
      pages.delete(page);
      if (slot === login) pageRevision++;
    });
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return;
      slot.revision++;
      if (kind === 'login') pageRevision++;
      if ((slot.pressed || !sourcePage(page.url(), kind)) && page.url() !== 'about:blank') {
        void page.close().catch(() => {});
      }
    });
    try {
      await page.goto(home, { waitUntil: 'domcontentloaded', timeout: requestTimeout });
      if (!page.isClosed() && sourcePage(page.url(), kind)) return slot;
    } catch {
      // The browser driver can include source URLs or profile paths in errors.
    }
    await page.close().catch(() => {});
    assertOpen();
    throw new ProbeError('PROBE_BROWSER_PAGE', 'The official source page could not be loaded.');
  }

  async function prepare(kind) {
    assertOpen();
    if (kind === 'detail') {
      if (!detail || detail.page.isClosed()) detail = await makePage(kind);
      return detail;
    }
    if (!reader || reader.page.isClosed()) reader = await makePage('reader');
    return reader;
  }

  function viewState() {
    return { pageRevision, ...viewport };
  }

  function assertView(revision) {
    assertOpen();
    if (!login || login.page.isClosed() || !sourcePage(login.page.url(), 'login') || revision !== pageRevision) throw staleView();
    return login;
  }

  function openLogin() {
    return withView(async () => {
      assertOpen();
      if (login && !login.page.isClosed() && sourcePage(login.page.url(), 'login')) return viewState();
      invalidate();
      login = await makePage('login');
      pageRevision++;
      return viewState();
    });
  }

  function frame({ pageRevision: revision } = {}) {
    return withView(async () => {
      const { page } = assertView(revision);
      try {
        const bytes = await page.screenshot({ type: 'png', timeout: 3000, scale: 'css' });
        assertView(revision);
        if (Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4 * 1024 * 1024) {
          return { ...viewState(), mime: 'image/png', bytes };
        }
      } catch {
        assertView(revision);
      }
      throw new ProbeError('PROBE_BROWSER_FRAME', 'The verification view could not be captured.');
    });
  }

  function input({ pageRevision: revision, type, x, y, text, key } = {}) {
    return withView(async () => {
      const slot = assertView(revision);
      const { mouse, keyboard } = slot.page;
      try {
        if (type === 'text' && typeof text === 'string' && text.length > 0 && text.length <= 256 && !/[\u0000-\u001f\u007f]/.test(text)) {
          await keyboard.insertText(text);
        } else if (type === 'key' && keys.has(key)) {
          await keyboard.press(key);
        } else if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x < viewport.width && y >= 0 && y < viewport.height) {
          if (type === 'click' && !slot.pressed) await mouse.click(x, y);
          else if (type === 'move') await mouse.move(x, y);
          else if (type === 'down' || type === 'up') {
            const pressed = type === 'down';
            if (slot.pressed === pressed) throw invalidInput();
            await mouse.move(x, y);
            assertView(revision);
            slot.pressed = pressed;
            await mouse[type]();
          } else throw invalidInput();
        } else throw invalidInput();
      } catch (error) {
        assertView(revision);
        if (error instanceof ProbeError) throw error;
        throw new ProbeError('PROBE_BROWSER_INPUT', 'The verification page could not receive input.');
      }
      assertView(revision);
      return viewState();
    });
  }

  function rateLimit(seconds) {
    heldUntil = Math.max(heldUntil, clock.now() + 1000 * (seconds || 60));
  }

  async function beforeRead(signal) {
    signal.throwIfAborted();
    const retryAfter = Math.ceil((heldUntil - clock.now()) / 1000);
    if (retryAfter > 0) throw new ProbeError('PROBE_SOURCE_RATE_LIMITED', 'The source requested a pause.', { retryAfter });
    const wait = Math.ceil(nextStart - clock.now());
    if (wait > 0) {
      let timer;
      try { await abortable(new Promise(resolve => { timer = schedule(resolve, wait); }), signal); }
      finally { unschedule(timer); }
    }
    signal.throwIfAborted();
    nextStart = clock.now() + 1100;
  }

  async function read(slot, request, signal) {
    const { page, revision } = slot;
    const key = '__cangxia_read_' + randomUUID().replaceAll('-', '');
    const timeout = AbortSignal.timeout(requestTimeout);
    const combined = AbortSignal.any([signal, timeout]);
    const stop = () => {
      void page.evaluate(key => window[key]?.abort('cancelled'), key).catch(() => {});
    };
    try {
      combined.throwIfAborted();
      const result = await abortable(page.evaluate(fetchInPage, {
        ...request, key, timeout: requestTimeout, maxBytes: maxResponseBytes
      }), combined);
      combined.throwIfAborted();
      if (result?.error === 'timeout') throw new ProbeError('PROBE_BROWSER_TIMEOUT', 'The source browser request timed out.');
      if (result?.error === 'too-large' || typeof result?.text === 'string' && Buffer.byteLength(result.text) > maxResponseBytes) {
        throw new ProbeError('PROBE_BROWSER_RESPONSE_LIMIT', 'The source browser response exceeded the size limit.');
      }
      if (result?.error || revision !== slot.revision || page.isClosed() || !sourcePage(page.url(), slot.kind) ||
          !Number.isInteger(result?.status) || result.status < 100 || result.status > 599 || typeof result.text !== 'string') {
        throw requestFailed();
      }
      const { status, text } = result;
      const retryAfter = Number.isFinite(result.retryAfter) ? Math.min(3600, Math.max(0, result.retryAfter)) : 0;
      if (status === 429) rateLimit(retryAfter);
      return { status, text, retryAfter };
    } catch (error) {
      if (combined.aborted) stop();
      if (signal.aborted) throw signal.reason;
      if (timeout.aborted) throw new ProbeError('PROBE_BROWSER_TIMEOUT', 'The source browser request timed out.');
      if (error instanceof ProbeError) throw error;
      throw requestFailed();
    }
  }

  async function fingerprint(signal) {
    signal.throwIfAborted();
    try {
      return sessionFingerprint(await abortable(context.cookies([home, `${origin}/aweme/v1/web/`]), signal));
    } catch {
      signal.throwIfAborted();
      throw requestFailed();
    }
  }

  async function assertSession(authEpoch, signal) {
    assertAuthEpoch(authEpoch);
    const current = await fingerprint(signal);
    assertAuthEpoch(authEpoch);
    if (current !== binding.fingerprint) {
      invalidate();
      throw staleAuth();
    }
  }

  function verifyIdentity() {
    return withView(async () => {
      assertOpen();
      verifying = true;
      try {
        return await withSource(async () => {
          assertOpen();
          const signal = epochController.signal;
          const slot = await prepare('reader');
          const expected = await fingerprint(signal);
          const profile = { fetch: async url => {
            const target = webTarget(url);
            if (target?.origin !== origin || target.pathname !== selfRoute) throw invalidRoute();
            const request = apiRequest(selfRoute, { params: Object.fromEntries(target.searchParams) });
            await beforeRead(signal);
            const { status, text, retryAfter } = await read(slot, request, signal);
            return { status, ok: status >= 200 && status < 300, text: async () => text, headers: new Headers({ 'retry-after': String(retryAfter) }) };
          } };
          let identity;
          try {
            identity = await verifyAccountIdentity(profile, undefined, { signal, onLimited: rateLimit });
          } catch (error) {
            if (error instanceof ProbeError) throw error;
            const retryAfter = Math.ceil((heldUntil - clock.now()) / 1000);
            if (retryAfter > 0) throw new ProbeError('PROBE_SOURCE_RATE_LIMITED', 'The source requested a pause.', { retryAfter });
            throw authRequired();
          }
          if (state.uid && state.uid !== identity.uid) {
            throw new ProbeError('PROBE_ACCOUNT_MISMATCH', 'The signed-in account differs from the account bound to this library.');
          }
          const userAgent = await slot.page.evaluate(() => navigator.userAgent);
          if (typeof userAgent !== 'string' || userAgent.length === 0 || userAgent.length > 512 || /[\r\n]/.test(userAgent)) throw requestFailed();
          if (login && !login.page.isClosed()) await login.page.close();
          login = undefined;
          if (expected !== await fingerprint(signal)) throw staleAuth();
          if (binding && expected !== binding.fingerprint) invalidate();
          assertOpen();
          state = store.withWrite(db => {
            const current = authState(db);
            if (current.authEpoch !== state.authEpoch || current.uid !== state.uid) throw staleAuth();
            return current.uid ? current : writeAuth(db, { ...current, uid: identity.uid });
          });
          binding = { fingerprint: expected, userAgent };
          return { ...identity, authEpoch: state.authEpoch };
        });
      } catch (error) {
        if (binding && !closed) invalidate();
        if (error instanceof ProbeError) throw error;
        throw authRequired();
      } finally {
        verifying = false;
      }
    });
  }

  async function request(route, options = {}) {
    const query = approvedRead(route, options);
    const { authEpoch, signal: callerSignal } = options;
    assertAuthEpoch(authEpoch);
    const signals = callerSignal ? [epochController.signal, callerSignal] : [epochController.signal];
    const signal = AbortSignal.any(signals);
    try {
      return await abortable(withSource(async () => {
        assertAuthEpoch(authEpoch);
        signal.throwIfAborted();
        const slot = await prepare(route === detailRoute ? 'detail' : 'reader');
        await beforeRead(signal);
        await assertSession(authEpoch, signal);
        const result = await read(slot, query, signal);
        await assertSession(authEpoch, signal);
        assertAuthEpoch(authEpoch);
        if (result.status === 401 || result.status === 403) {
          // Return the source status to the caller while invalidating the write fence.
          invalidate();
        }
        return result;
      }), callerSignal);
    } catch (error) {
      if (callerSignal?.aborted) throw new ProbeError('PROBE_BROWSER_CANCELLED', 'The source read was cancelled.');
      if (error instanceof ProbeError) throw error;
      throw requestFailed();
    }
  }

  async function mediaHeaders(url) {
    const target = webTarget(url);
    if (!target || !isMediaURL(target.href)) throw new ProbeError('PROBE_MEDIA_TARGET', 'The media target is outside the approved source domains.');
    const authEpoch = state.authEpoch;
    try {
      await assertSession(authEpoch, epochController.signal);
      assertAuthEpoch(authEpoch);
      return new Headers({ Referer: `${origin}/`, 'User-Agent': binding.userAgent });
    } catch (error) {
      if (error instanceof ProbeError) throw error;
      throw requestFailed();
    }
  }

  function close() {
    if (closeTask) return closeTask;
    if (closed) return Promise.resolve();
    stopped();
    closeTask = context.close().catch(() => { throw closedBrowser(); });
    return closeTask;
  }

  return Object.freeze({ openLogin, frame, input, verifyIdentity, request, assertAuthEpoch, mediaHeaders, traffic: observeTraffic, close });
}
