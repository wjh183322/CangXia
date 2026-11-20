import { createHash, randomInt, randomUUID } from 'node:crypto';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { abortable, apiRequest, fetchInPage } from '../../../electron/browser-api.mjs';
import { validAccountIdentity, verifyAccountIdentity } from '../../../electron/account-identity.mjs';
import { isMediaURL } from '../../../electron/model.mjs';
import { readVerificationPanel, validPanel } from '../../../electron/verification-panel.mjs';
import { PROBE, ProbeError } from './contracts.mjs';
import { inspectSourceResponse } from './page-parser.mjs';

const origin = 'https://www.douyin.com';
const home = `${origin}/user/self`;
const selfRoute = '/aweme/v1/web/user/profile/self/';
const detailRoute = '/aweme/v1/web/aweme/detail/';
const collectionRoute = '/aweme/v1/web/aweme/listcollection/';
const viewport = Object.freeze({ width: 1000, height: 760 });
const requestTimeout = 12000;
const driverTimeout = 2500;
const maxResponseBytes = 8 * 1024 * 1024;
const keys = new Set(['Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']);
const pointerTypes = new Set(['click', 'move', 'down', 'up']);
const requestFields = new Set(['authEpoch', 'signal', 'method', 'params', 'form', 'beforeDispatch']);
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
const assetPaths = new Map([
  ['script', /\.(?:js|mjs)$/i], ['stylesheet', /\.css$/i], ['font', /\.(?:woff2?|ttf|otf)$/i],
  ['image', /\.(?:png|jpe?g|gif|webp|svg|avif|ico)(?:~[^/]*)?$/i]
]);

const unsafeProfile = () => new ProbeError('UNSAFE_BROWSER_PROFILE', 'The isolated browser directory is unavailable or unsafe.');
const closedBrowser = () => new ProbeError('PROBE_BROWSER_CLOSED', 'The probe browser is closed.');
const staleAuth = () => new ProbeError('STALE_AUTH_EPOCH', 'The source authorization changed. Recheck the signed-in account.');
const authRequired = () => new ProbeError('PROBE_AUTH_REQUIRED', 'Verify the normal browser login before reading the source.');
const staleView = () => new ProbeError('STALE_BROWSER_VIEW', 'Refresh the verification view before sending input.');
const panelRequired = () => new ProbeError('PROBE_VERIFICATION_PANEL_REQUIRED', 'The official page has no recognized verification panel.');
const restartRequired = () => new ProbeError('PROBE_BROWSER_RESTART_REQUIRED', 'Restart the probe browser to restore verification access.');
const invalidInput = () => new ProbeError('INVALID_BROWSER_INPUT', 'The verification input is outside the supported controls.');
const invalidRoute = () => new ProbeError('PROBE_BROWSER_ROUTE', 'The probe only accepts supported read-only browser requests.');
const requestFailed = () => new ProbeError('PROBE_BROWSER_REQUEST', 'The source browser request failed.');
const timedOut = () => new ProbeError('PROBE_BROWSER_TIMEOUT', 'The source browser operation timed out.');

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

function approvedBrowserTraffic(request, slot, mainFrame) {
  const url = request.url();
  const target = webTarget(url);
  if (!target || !mainFrame) return false;
  const method = request.method();
  if (request.isNavigationRequest()) return method === 'GET' && sourcePage(url, slot.kind);
  const type = request.resourceType();
  if (type === 'fetch' || type === 'xhr') {
    if (target.origin !== origin) return false;
    // No official auth-write endpoints have been verified for this probe.
    if (slot.kind === 'login') return method === 'GET' && target.pathname === selfRoute;
    return routeParams.has(target.pathname) && method === (target.pathname === collectionRoute ? 'POST' : 'GET');
  }
  return method === 'GET' && isMediaURL(url) && !!assetPaths.get(type)?.test(target.pathname);
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
      (options.beforeDispatch !== undefined && typeof options.beforeDispatch !== 'function') ||
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
        const slot = pages.get(page);
        // Child verification documents require a reviewed exact origin and path.
        allowed = !!slot && approvedBrowserTraffic(request, slot, frame === page.mainFrame());
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

// Executed only in the owned main login document. No form values leave the page.
function inspectLoginPanel(readPanel, { viewProbe, action, x, y }) {
  const box = element => {
    const rect = element.getBoundingClientRect();
    return { x: Math.floor(rect.left), y: Math.floor(rect.top), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
  };
  const compact = element => (element.innerText || '').replace(/\s+/g, '');
  const label = element => (element.getAttribute('aria-label') || compact(element)).trim();
  const fits = rect => rect.width >= 260 && rect.height >= 160 && rect.width <= 920 && rect.height <= 720 &&
    rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= innerWidth && rect.y + rect.height <= innerHeight;
  const visible = element => {
    const { width, height } = box(element);
    const style = getComputedStyle(element);
    return width > 5 && height > 5 && style.visibility === 'visible' && style.display !== 'none' && style.opacity !== '0';
  };
  const sameBox = (first, second) => Object.keys(first).every(key => first[key] === second[key]);
  const changesAccount = /(?:更换|修改|换绑|解绑|重置)(?:绑定)?(?:手机号|密码|邮箱)|(?:注销|删除)(?:抖音)?账号|授权管理|隐私设置/;
  const challengeLabel = /^(身份验证|安全验证|手机号验证|手机验证|短信验证|输入验证码|请输入验证码|接收短信验证码|发送短信验证)$/;
  const qrLabel = /^(扫码登录|二维码登录|使用抖音扫码登录)$/;
  if (scrollX !== 0 || scrollY !== 0) return null;
  const knownRect = readPanel();
  const surfaces = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')];
  if (knownRect && fits(knownRect)) {
    const center = document.elementsFromPoint(knownRect.x + knownRect.width / 2, knownRect.y + knownRect.height / 2);
    surfaces.unshift(...center.filter(element => sameBox(box(element), knownRect)));
  }
  let selected;
  let challenge;
  for (const surface of surfaces) {
    const rect = box(surface);
    if (!fits(rect) || !visible(surface) || changesAccount.test(compact(surface))) continue;
    const titles = [...surface.querySelectorAll('h1,h2,h3,[role="heading"],button,span,div')]
      .filter(element => element.children.length < 3 && visible(element)).map(compact);
    challenge = !!knownRect && sameBox(rect, knownRect) && titles.some(title => challengeLabel.test(title));
    const qr = titles.some(title => qrLabel.test(title)) && !!surface.querySelector('canvas,img,svg');
    if (challenge || qr) { selected = surface; break; }
  }
  if (!selected) {
    if (action === 'open') {
      // Opening the ordinary login dialog is the only action outside a recognized panel.
      const entry = [...document.querySelectorAll('button,[role="button"]')]
        .find(element => label(element) === '登录' && !element.closest('a[href]') && visible(element));
      entry?.click();
    }
    return null;
  }
  const identities = window[viewProbe] ??= { elements: new WeakMap(), next: 0 };
  if (!identities.elements.has(selected)) identities.elements.set(selected, ++identities.next);
  const result = { ...box(selected), id: identities.elements.get(selected), allowed: false };
  if (action === undefined || action === 'open') return result;

  const keyboard = action === 'key' || action === 'text';
  const target = keyboard ? document.activeElement : document.elementFromPoint(x, y);
  if (!target || !selected.contains(target) || target.closest('a[href],[contenteditable],select')) return result;
  if (action === 'move' || action === 'up') return { ...result, allowed: true };
  const field = target.closest('input,textarea');
  if (field) {
    const purpose = [field.getAttribute('placeholder'), field.getAttribute('aria-label'), field.getAttribute('autocomplete')].join(' ');
    const type = field.getAttribute('type') || 'text';
    result.allowed = !field.disabled && selected.contains(field) &&
      ((type === 'text' || type === 'tel' || type === 'number') && /手机号|验证码|短信码|one-time-code/i.test(purpose) ||
       (type === 'range' && challenge && action !== 'text'));
    return result;
  }
  const control = target.closest('button,[role="button"],[role="tab"],[role="slider"]');
  if (control && selected.contains(control) && !control.disabled && action !== 'text') {
    result.allowed = /^(扫码登录|二维码登录|刷新二维码|重新获取二维码|点击刷新|获取验证码|发送验证码|接收短信验证码|发送短信验证|重新发送|确认|继续验证|完成验证)$/.test(label(control)) ||
      (challenge && control.getAttribute('role') === 'slider');
  } else if (challenge && !keyboard && target.tagName === 'CANVAS') {
    result.allowed = true;
  }
  return result;
}

// Serialize only fixed repository functions for the browser realm.
const panelScript = new Function('options', `return (${inspectLoginPanel})(${readVerificationPanel}, options)`);

async function browserCall(task, signal, timeout = driverTimeout) {
  signal?.throwIfAborted();
  let timer;
  const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(timedOut()), timeout); });
  try {
    const pending = Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return task();
    });
    return await abortable(Promise.race([deadline, pending]), signal);
  } finally {
    clearTimeout(timer);
  }
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
    await context.routeWebSocket('**/*', socket => socket.close());
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
  let verificationBlocked = false;
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

  async function makePage(kind, signal = epochController.signal) {
    const page = context.pages().find(page => page.url() === 'about:blank' && !pages.has(page)) ??
      await browserCall(() => context.newPage(), signal);
    const slot = { page, kind, revision: 0, pressed: false, panel: null, viewProbe: '__cangxia_view_' + randomUUID() };
    pages.set(page, slot);
    page.on('popup', popup => { void popup.close().catch(() => {}); });
    page.on('close', () => {
      pages.delete(page);
      if (slot === login) pageRevision++;
    });
    const viewChanged = () => { if (kind === 'login') pageRevision++; };
    page.on('frameattached', viewChanged);
    page.on('framedetached', viewChanged);
    page.on('framenavigated', frame => {
      viewChanged();
      if (frame !== page.mainFrame()) {
        if (kind === 'login' && frame.url() !== 'about:blank') void page.close().catch(() => {});
        return;
      }
      slot.revision++;
      if ((slot.pressed || !sourcePage(page.url(), kind)) && page.url() !== 'about:blank') {
        void page.close().catch(() => {});
      }
    });
    try {
      await browserCall(() => page.goto(home, { waitUntil: 'domcontentloaded', timeout: requestTimeout }), signal, requestTimeout);
      if (!page.isClosed() && sourcePage(page.url(), kind)) return slot;
    } catch (error) {
      // The browser driver can include source URLs or profile paths in errors.
      if (error instanceof ProbeError || signal.aborted) {
        void page.close().catch(() => {});
        throw error;
      }
    }
    void page.close().catch(() => {});
    assertOpen();
    throw new ProbeError('PROBE_BROWSER_PAGE', 'The official source page could not be loaded.');
  }

  async function prepare(kind, signal) {
    assertOpen();
    if (kind === 'detail') {
      if (!detail || detail.page.isClosed()) detail = await makePage(kind, signal);
      return detail;
    }
    if (!reader || reader.page.isClosed()) reader = await makePage('reader', signal);
    return reader;
  }

  function trustedView(slot) {
    return !!slot && !slot.page.isClosed() && sourcePage(slot.page.url(), 'login') &&
      slot.page.frames().every(frame => frame === slot.page.mainFrame());
  }

  function viewState() {
    return { pageRevision, width: login?.panel?.width ?? 0, height: login?.panel?.height ?? 0 };
  }

  function assertVerificationAvailable() {
    assertOpen();
    if (verificationBlocked) throw restartRequired();
  }

  function assertView(revision) {
    assertVerificationAvailable();
    if (!trustedView(login) || revision !== pageRevision) throw staleView();
    return login;
  }

  async function retireLogin(slot) {
    if (login === slot) {
      login = undefined;
      pageRevision++;
    }
    pages.delete(slot.page);
    if (!slot.page.isClosed()) {
      await browserCall(() => slot.page.close({ runBeforeUnload: false })).catch(() => {});
    }
    if (!slot.page.isClosed()) {
      verificationBlocked = true;
      throw restartRequired();
    }
  }

  async function mutateLogin(slot, revision, task) {
    let dispatched = false;
    try {
      return await browserCall(() => {
        assertView(revision);
        dispatched = true;
        return task();
      }, epochController.signal);
    } catch (error) {
      if (!dispatched) throw error;
      // The driver can reject before the browser has finished applying the action.
      await retireLogin(slot);
      if (error instanceof ProbeError) throw error;
      throw new ProbeError('PROBE_BROWSER_INPUT', 'The verification action could not be confirmed.');
    }
  }

  async function refreshPanel(slot, action) {
    const revision = pageRevision;
    assertView(revision);
    const { page, viewProbe } = slot;
    const inspect = () => page.evaluate(panelScript, { viewProbe, ...action });
    const result = await (action?.action === 'open' ? mutateLogin(slot, revision, inspect) : browserCall(inspect, epochController.signal));
    assertView(revision);
    let panel = null;
    if (validPanel(result) && result.x + result.width <= viewport.width && result.y + result.height <= viewport.height &&
        Number.isSafeInteger(result.id) && result.id > 0) {
      const { id, x, y, width, height } = result;
      panel = { id, x, y, width, height };
    }
    if (JSON.stringify(panel) !== JSON.stringify(slot.panel)) {
      slot.panel = panel;
      pageRevision++;
      if (slot.pressed) await retireLogin(slot);
    }
    return result?.allowed === true;
  }

  function openLogin() {
    return withView(async () => {
      assertVerificationAvailable();
      try {
        if (!trustedView(login)) {
          invalidate();
          if (login && !login.page.isClosed()) await browserCall(() => login.page.close(), epochController.signal);
          login = await makePage('login');
          pageRevision++;
          await refreshPanel(login, { action: 'open' });
        } else await refreshPanel(login);
        return viewState();
      } catch (error) {
        if (error instanceof ProbeError) throw error;
        throw panelRequired();
      }
    });
  }

  function frame({ pageRevision: revision } = {}) {
    return withView(async () => {
      const slot = assertView(revision);
      try {
        await refreshPanel(slot);
        assertView(revision);
        if (!slot.panel) throw panelRequired();
        const { x, y, width, height } = slot.panel;
        const bytes = await slot.page.screenshot({ type: 'png', timeout: 3000, scale: 'css', clip: { x, y, width, height } });
        assertView(revision);
        await refreshPanel(slot);
        assertView(revision);
        if (Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4 * 1024 * 1024) {
          return { ...viewState(), mime: 'image/png', bytes };
        }
      } catch (error) {
        assertView(revision);
        if (error instanceof ProbeError) throw error;
      }
      throw new ProbeError('PROBE_BROWSER_FRAME', 'The verification view could not be captured.');
    });
  }

  function input({ pageRevision: revision, type, x, y, text, key } = {}) {
    return withView(async () => {
      const slot = assertView(revision);
      const { mouse, keyboard } = slot.page;
      try {
        if (!slot.panel) throw panelRequired();
        const pointer = pointerTypes.has(type);
        const panel = slot.panel;
        const valid = pointer ? Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x < panel.width && y >= 0 && y < panel.height :
          type === 'key' ? keys.has(key) : type === 'text' && typeof text === 'string' && text.length > 0 && text.length <= 256 && !/[\u0000-\u001f\u007f]/.test(text);
        if (!valid) throw invalidInput();
        const position = pointer ? { x: x + panel.x, y: y + panel.y } : {};
        const allowed = await refreshPanel(slot, { action: type, ...position });
        assertView(revision);
        if (!allowed) throw invalidInput();
        const run = task => mutateLogin(slot, revision, task);
        if (type === 'text') await run(() => keyboard.insertText(text));
        else if (type === 'key') await run(() => keyboard.press(key));
        else if (type === 'click' && !slot.pressed) await run(() => mouse.click(position.x, position.y));
        else if (type === 'move') await run(() => mouse.move(position.x, position.y));
        else if (type === 'down' || type === 'up') {
          const pressed = type === 'down';
          if (slot.pressed === pressed) throw invalidInput();
          await run(() => mouse.move(position.x, position.y));
          const stillAllowed = await refreshPanel(slot, { action: type, ...position });
          assertView(revision);
          if (!stillAllowed) throw invalidInput();
          slot.pressed = pressed;
          await run(() => mouse[type]());
        } else throw invalidInput();
      } catch (error) {
        if (error instanceof ProbeError) throw error;
        assertView(revision);
        throw new ProbeError('PROBE_BROWSER_INPUT', 'The verification page could not receive input.');
      }
      assertView(revision);
      return viewState();
    });
  }

  function rateLimit(seconds) {
    heldUntil = Math.max(heldUntil, clock.now() + 1000 * (seconds || 60));
  }

  function assertNoCooldown() {
    const retryAfter = Math.ceil((heldUntil - clock.now()) / 1000);
    if (retryAfter > 0) throw new ProbeError('PROBE_SOURCE_RATE_LIMITED', 'The source requested a pause.', { retryAfter });
  }

  async function beforeRead(signal) {
    signal.throwIfAborted();
    assertNoCooldown();
    const wait = Math.ceil(nextStart - clock.now());
    if (wait > 0) {
      let timer;
      try { await abortable(new Promise(resolve => { timer = schedule(resolve, wait); }), signal); }
      finally { unschedule(timer); }
    }
    signal.throwIfAborted();
    assertNoCooldown();
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
      nextStart = clock.now() + 1100;
      const result = await abortable(page.evaluate(fetchInPage, {
        ...request, key, timeout: requestTimeout, maxBytes: maxResponseBytes
      }), combined);
      combined.throwIfAborted();
      if (result?.error === 'timeout') throw timedOut();
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
      if (timeout.aborted) throw timedOut();
      if (error instanceof ProbeError) throw error;
      throw requestFailed();
    }
  }

  async function fingerprint(signal) {
    signal.throwIfAborted();
    try {
      return sessionFingerprint(await browserCall(() => context.cookies([home, `${origin}/aweme/v1/web/`]), signal));
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProbeError) throw error;
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
      assertVerificationAvailable();
      verifying = true;
      try {
        return await withSource(async () => {
          assertOpen();
          const signal = epochController.signal;
          assertNoCooldown();
          const slot = await prepare('reader', signal);
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
          const userAgent = await browserCall(() => slot.page.evaluate(() => navigator.userAgent), signal);
          if (typeof userAgent !== 'string' || userAgent.length === 0 || userAgent.length > 512 || /[\r\n]/.test(userAgent)) throw requestFailed();
          if (login && !login.page.isClosed()) await browserCall(() => login.page.close(), signal);
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
    const { authEpoch, signal: callerSignal, beforeDispatch } = options;
    assertAuthEpoch(authEpoch);
    const signals = callerSignal ? [epochController.signal, callerSignal] : [epochController.signal];
    const signal = AbortSignal.any(signals);
    try {
      return await abortable(withSource(async () => {
        assertAuthEpoch(authEpoch);
        signal.throwIfAborted();
        assertNoCooldown();
        const slot = await prepare(route === detailRoute ? 'detail' : 'reader', signal);
        await beforeRead(signal);
        await assertSession(authEpoch, signal);
        assertAuthEpoch(authEpoch);
        // The caller may hold a separate server lease. Check it at actual dispatch.
        if (beforeDispatch && beforeDispatch() !== undefined) throw invalidRoute();
        const result = await read(slot, query, signal);
        await assertSession(authEpoch, signal);
        assertAuthEpoch(authEpoch);
        const issue = inspectSourceResponse(result);
        if (issue.code === 'PROBE_SOURCE_AUTH') invalidate();
        if (issue.code === 'PROBE_SOURCE_RATE_LIMITED' && result.status === 200) rateLimit(issue.retryAfter);
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
