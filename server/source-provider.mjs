import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { abortable, apiRequest, fetchInPage } from '../electron/browser-api.mjs';
import { parsePlatformJSON } from '../electron/model.mjs';
import { validAccountIdentity } from '../electron/account-identity.mjs';
import { readVerificationPanel } from '../electron/verification-panel.mjs';
import { readQrPage } from '../electron/qr-page.mjs';
import { inspectLoginPanel, loginQrRegion } from './source-login-dom.mjs';
import { SourceError } from './source-error.mjs';
import { inspectSourceResponse } from './source-parser.mjs';

const origin = 'https://www.douyin.com',
  home = origin + '/user/self';
const selfRoute = '/aweme/v1/web/user/profile/self/';
const storageHelper =
  /^\/obj\/uc-assets\/zt\/@byted\/x-storage-web\/(4\.0\.5|4\.0\.7|4\.0\.8)\/dist\/latest\/index\.html$/;
const bootstrapReads = new Set([
  selfRoute,
  '/aweme/v1/web/social/count',
  '/aweme/v1/web/solution/resource/list/',
  '/aweme/v1/web/get/user/settings/',
  '/aweme/v1/web/query/user/'
]);
const assetTypes = new Set(['script', 'stylesheet', 'font', 'image']);
const staticHosts = [
  'douyincdn.com',
  'douyinpic.com',
  'douyinstatic.com',
  'bytetos.com',
  'bytegoofy.com',
  'bytescm.com',
  'yhgfb-cn-static.com',
  'ibytedapm.com',
  'applogcdn.com',
  'bytednsdoc.com',
  'zijieapi.com'
];
const official = (url) => url.origin === origin && ['/', '/user/self'].includes(url.pathname);
const sourceFailure = () =>
  new SourceError('SOURCE_BROWSER', 'NAS 无法打开抖音官方页面，请检查浏览器和网络。');
const unsupported = () => new SourceError('MANUAL_UNAVAILABLE', '当前验证控件已变化，请重新查看抖音的提示。');

async function allowRequest(request, page, authorize, authorizeNavigation) {
  const url = new URL(request.url());
  const frame = request.frame();
  if (frame.page() !== page) return false;
  const main = frame === page.mainFrame(),
    method = request.method(),
    type = request.resourceType();
  if (main && request.isNavigationRequest()) return authorizeNavigation(request);
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  if (request.isNavigationRequest()) {
    if (method !== 'GET') return false;
    return (
      frame.parentFrame() === page.mainFrame() &&
      (['', 'about:blank'].includes(frame.url()) ||
        (new URL(frame.url()).origin === url.origin && storageHelper.test(new URL(frame.url()).pathname))) &&
      url.origin === 'https://lf-zt.douyin.com' &&
      storageHelper.test(url.pathname)
    );
  }
  if (
    !main &&
    !(
      frame.parentFrame() === page.mainFrame() &&
      frame.url().startsWith('https://lf-zt.douyin.com/') &&
      storageHelper.test(new URL(frame.url()).pathname)
    )
  )
    return false;
  if (url.origin === origin && main) {
    if (assetTypes.has(type)) return method === 'GET' && !url.pathname.startsWith('/passport/');
    if (!['fetch', 'xhr'].includes(type) || request.redirectedFrom()) return false;
    if (method === 'GET' && bootstrapReads.has(url.pathname)) return true;
    return authorize(request, url, method);
  }
  return (
    method === 'GET' &&
    assetTypes.has(type) &&
    staticHosts.some((host) => url.hostname === host || url.hostname.endsWith('.' + host))
  );
}

// Only the recognized official SMS dialog exposes semantic controls. No field value is read.
function smsControls({ key, panel, command }) {
  const surface = document
    .elementsFromPoint(panel.x + panel.width / 2, panel.y + panel.height / 2)
    .find((e) => window[key]?.elements.get(e) === panel.id);
  if (!surface || !panel.challenge) return null;
  const visible = (e) =>
    e.getBoundingClientRect().width > 0 &&
    e.getBoundingClientRect().height > 0 &&
    !e.disabled &&
    getComputedStyle(e).visibility === 'visible' &&
    !e.closest('a,[contenteditable]');
  const unique = (arr) => (arr.length === 1 ? arr[0] : null);
  const code = unique(
    [...surface.querySelectorAll('input')].filter(
      (e) =>
        visible(e) &&
        ['text', 'number', 'tel'].includes(e.type) &&
        /验证码|短信码|one-time-code/i.test(
          [e.placeholder, e.autocomplete, e.getAttribute('aria-label')].join(' ')
        )
    )
  );
  const buttons = [...surface.querySelectorAll('button,[role="button"]')].filter(visible);
  const button = (pattern) => unique(buttons.filter((e) => pattern.test((e.innerText || '').trim())));
  const send = button(/^(获取验证码|发送验证码|接收短信验证码|发送短信验证|重新发送)$/);
  const submit = button(/^(确认|继续验证|完成验证)$/);
  if (!command) return { panelId: panel.id, code: !!(code && submit), send: !!send };
  if (command.panelId !== panel.id) return null;
  if (command.action === 'send' && send) {
    send.click();
    return true;
  }
  if (command.action === 'submit' && code && submit && /^\d{4,8}$/.test(command.code)) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(code, command.code);
    code.dispatchEvent(new Event('input', { bubbles: true }));
    code.dispatchEvent(new Event('change', { bubbles: true }));
    if (submit.isConnected && !submit.disabled) {
      submit.click();
      return true;
    }
  }
  return null;
}
// The official document executes fixed repository functions. No caller-supplied script or selector.
const panelScript = new Function(
  'options',
  `return (${inspectLoginPanel})(${readVerificationPanel},options)`
);
const stateScript = new Function(`const {phase,kind}=(${readQrPage})({});return {phase,kind}`);
async function launchContext(saved) {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: process.platform === 'linux' });
  try {
    const context = await browser.newContext({
      viewport: { width: 1000, height: 760 },
      storageState: saved || undefined,
      serviceWorkers: 'block',
      acceptDownloads: false
    });
    context.on('close', () => void browser.close().catch(() => {}));
    return context;
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function openOfficialProvider(
  saved,
  signal,
  { createContext = launchContext, now = Date.now } = {}
) {
  let context;
  try {
    signal.throwIfAborted();
    context = await createContext(saved);
    signal.throwIfAborted();
    const page = await context.newPage();
    let key = 'cx' + randomUUID(),
      manualPanel,
      login,
      pendingRead;
    let startup = true,
      clicked = false;
    function authorizeNavigation(req) {
      const exact = req.url() === home && req.method() === 'GET' && !req.redirectedFrom();
      if (startup) {
        startup = false;
        return exact;
      }
      const view = login;
      if (!view) return false;
      try {
        view.check();
        signal.throwIfAborted();
        const passive =
          view.passive &&
          view.document === key &&
          page.url() === home &&
          !clicked &&
          !view.issueRequest &&
          !manualPanel &&
          now() < view.openUntil;
        if (!exact || view.navigation || (!view.opening && !passive)) throw unsupported();
        view.passiveFrom = passive ? key : null;
        view.navigation = { request: req, initial: view.opening, confirmed: false };
        view.passive = false;
        view.opening = false;
        view.document = null;
        manualPanel = null;
        pendingRead = null;
        return true;
      } catch {
        login = null;
        manualPanel = null;
        return false;
      }
    }
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      key = 'cx' + randomUUID();
      manualPanel = null;
      const nav = login?.navigation;
      if (!nav || !nav.confirmed || frame.url() !== home) {
        login = null;
        return;
      }
      try {
        login.check();
        signal.throwIfAborted();
      } catch {
        login = null;
        return;
      }
      login.document = key;
      login.passive = nav.initial;
      login.navigation = null;
    });
    function live() {
      signal.throwIfAborted();
      if (!login || login.document !== key || !official(new URL(page.url()))) throw unsupported();
      login.check();
      return login;
    }
    async function bitmap() {
      const panel = await page.evaluate(panelScript, { key, action: 'locate' });
      if (!panel?.id || panel.challenge) return null;
      const qr = await page.evaluate(loginQrRegion, { key, panel, encode: true, maxBitmapSize: 512 });
      return qr?.png ? { png: qr.png, hash: createHash('sha256').update(qr.png).digest('hex') } : null;
    }
    async function authorize(request, url, method) {
      if (!url.pathname.startsWith('/passport/')) {
        if (
          pendingRead?.method !== method ||
          pendingRead.url !== url.href ||
          pendingRead.body !== request.postData()
        )
          return false;
        pendingRead.stop.throwIfAborted();
        pendingRead = null;
        return true;
      }
      const view = live(),
        route = url.pathname.replace(/\/$/, '');
      if (route === '/passport/web/get_qrcode') {
        if (method !== 'GET' || view.issueRequest || now() >= view.openUntil) return false;
        view.issueRequest = request;
        return true;
      }
      if (method !== 'POST' || (request.postDataBuffer()?.length ?? 0) > 8192) return false;
      if (route === '/passport/web/check_qrconnect') {
        const mime = request.headers()['content-type'] || '';
        if (
          request.resourceType() !== 'xhr' ||
          !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(mime) ||
          !request.postDataBuffer()?.length ||
          !view.shown ||
          view.remaining <= 0 ||
          now() >= view.pollUntil
        )
          return false;
        const state = await page.evaluate(stateScript);
        if (!['scanned', 'connecting'].includes(state.phase) && (await bitmap())?.hash !== view.shown)
          return false;
        if (live() !== view || !view.shown || view.remaining <= 0 || now() >= view.pollUntil) return false;
        view.remaining--;
        return true;
      }
      const action = view.manual;
      if (!action || now() >= action.until || !action.routes.includes(route)) return false;
      const panel = await page.evaluate(panelScript, { key, action: 'locate' });
      if (
        live() !== view ||
        view.manual !== action ||
        !panel?.challenge ||
        panel.id !== action.node ||
        now() >= action.until
      )
        return false;
      view.manual = null;
      return true;
    }
    page.on('response', (response) => {
      const view = login;
      if (view?.navigation?.request === response.request()) {
        view.navigation.confirmed = response.status() === 200 && response.url() === home;
      }
      if (view?.issueRequest !== response.request()) return;
      view.issued =
        response.status() === 200 && /^application\/json\b/i.test(response.headers()['content-type'] || '');
      if (view.issued) view.observeUntil = now() + 15000;
      if (!view.issued) {
        view.shown = null;
        view.issueFailure = response.status() === 429 ? 'limited' : 'refused';
      }
    });
    const close = () => context.close().catch(() => {});
    signal.addEventListener('abort', close, { once: true });
    context.on('close', () => signal.removeEventListener('abort', close));
    context.on('page', (other) => {
      if (other !== page) void other.close().catch(() => {});
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    await context.route('**/*', async (route) => {
      let allowed = false;
      try {
        allowed = await allowRequest(route.request(), page, authorize, authorizeNavigation);
      } catch {}
      let preserveBlank = false;
      if (!allowed)
        try {
          const req = route.request(),
            frame = req.frame();
          preserveBlank =
            (req.isNavigationRequest() && frame === page.mainFrame()) ||
            (req.isNavigationRequest() &&
              frame.parentFrame() === page.mainFrame() &&
              ['', 'about:blank'].includes(frame.url()));
        } catch {}
      await (allowed ? route.fallback() : route.abort(preserveBlank ? 'aborted' : undefined)).catch(() => {});
    });
    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 15000 });
    async function fixed(fn, observeBootstrap = false) {
      const initial = key,
        view = login;
      const reloaded = () =>
        observeBootstrap && view && view === login && view.passiveFrom === initial && !clicked;

      try {
        signal.throwIfAborted();
        if (!official(new URL(page.url()))) throw sourceFailure();
        if (observeBootstrap && view?.navigation && !view.navigation.initial) {
          view.check();
          return { phase: 'loading' };
        }
        const value = await abortable(fn(), AbortSignal.any([signal, AbortSignal.timeout(16000)]));
        signal.throwIfAborted();
        if (!official(new URL(page.url()))) throw sourceFailure();
        if (reloaded()) {
          view.check();
          return { phase: 'loading' };
        }
        if (observeBootstrap && (view !== login || key !== initial)) throw unsupported();
        return value;
      } catch (e) {
        if (
          reloaded() &&
          (e.code === 'MANUAL_UNAVAILABLE' || /Execution context was destroyed/.test(e.message))
        ) {
          view.check();
          return { phase: 'loading' };
        }
        if (e instanceof SourceError) throw e;
        if (e.name === 'TimeoutError')
          throw new SourceError('SOURCE_TIMEOUT', '抖音页面响应超时，请稍后重试。');
        throw sourceFailure();
      }
    }
    async function read(request, stop = signal) {
      const requestKey = 'cx' + randomUUID();
      const cancel = () => void page.evaluate((k) => window[k]?.abort(), requestKey).catch(() => {});
      stop.throwIfAborted();
      pendingRead = { ...request, stop };
      stop.addEventListener('abort', cancel, { once: true });
      try {
        const result = await abortable(
          fixed(() => page.evaluate(fetchInPage, { ...request, key: requestKey })),
          stop
        );
        if (result.error === 'timeout') throw new SourceError('SOURCE_TIMEOUT', '抖音读取超时，请稍后重试。');
        if (result.error) throw sourceFailure();
        return result;
      } finally {
        pendingRead = null;
        stop.removeEventListener('abort', cancel);
      }
    }
    return {
      read,
      sessionKey: () =>
        fixed(async () => {
          const cookies = (await context.cookies(origin)).filter(
            (c) => ['sessionid', 'sessionid_ss', 'uid_tt'].includes(c.name) && c.value
          );
          if (!cookies.some((c) => ['sessionid', 'sessionid_ss'].includes(c.name))) return null;
          return createHash('sha256')
            .update(JSON.stringify(cookies.map((c) => [c.domain, c.path, c.name, c.value]).sort()))
            .digest('hex');
        }),
      async self(stop) {
        const raw = await read(apiRequest(selfRoute), stop);
        const issue = inspectSourceResponse(raw);
        if (issue.code === 'SOURCE_RATE_LIMITED')
          throw Object.assign(new SourceError(issue.code, '抖音提示访问频繁，请稍后重试。'), {
            retryAfter: issue.retryAfter
          });
        if (raw.status === 401) return null;
        if (raw.status !== 200 || issue.code)
          throw new SourceError('SOURCE_REFUSED', '抖音未确认身份，请检查官方登录或验证页面。');
        const data = parsePlatformJSON(raw.text),
          user = data?.user ?? data?.data?.user;
        const identity = {
          uid: String(user?.uid_str ?? user?.uid ?? ''),
          nickname: typeof user?.nickname === 'string' ? user.nickname.slice(0, 100) : ''
        };
        return validAccountIdentity(identity) ? identity : null;
      },
      storage: () => fixed(() => context.storageState()),
      beginLogin: (check) =>
        fixed(async () => {
          check();
          login = { check, opening: true, openUntil: now() + 30000, remaining: 24 };
          clicked = false;
          await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 15000 });
          if (login?.navigation && !login.navigation.initial) login.check();
          else live();
        }),
      endLogin: () => {
        login = null;
        manualPanel = null;
      },
      qrShown: (token) =>
        fixed(async () => {
          const view = live();
          if (
            !view.issued ||
            (!view.pollUntil && now() >= view.observeUntil) ||
            view.token !== token ||
            !view.image ||
            (await bitmap())?.hash !== view.image ||
            live() !== view
          )
            throw unsupported();
          view.shown = view.image;
          view.pollUntil ??= now() + 45000;
          return {};
        }),
      loginView: () =>
        fixed(async () => {
          const view = live();
          if (view.issueFailure === 'limited') return { phase: 'limited' };
          if (view.issueFailure)
            throw new SourceError('SOURCE_REFUSED', '抖音未签发登录二维码，请检查官方登录要求。');
          const state = await page.evaluate(stateScript);
          if (['limited', 'expired', 'scanned'].includes(state.phase)) {
            if (state.phase !== 'scanned') {
              view.shown = null;
              view.image = null;
              view.issued = false;
              view.manual = null;
            }
            return { phase: state.phase };
          }
          const panel = await page.evaluate(panelScript, { key, action: 'locate' });
          if (state.phase === 'verification' || panel?.challenge) {
            view.passive = false;
            view.shown = null;
            view.image = null;
            const manual = panel?.challenge ? await page.evaluate(smsControls, { key, panel }) : null;
            if (manual && (manual.code || manual.send)) {
              if (manualPanel?.node !== panel.id || manualPanel.key !== key)
                manualPanel = { node: panel.id, key, token: randomUUID() };
              return { phase: 'verification', manual: { ...manual, panelId: manualPanel.token } };
            }
            manualPanel = null;
            return { phase: 'verification', manual: null };
          }
          manualPanel = null;
          const unread = () => view.issued && !view.pollUntil && now() >= view.observeUntil;
          const unpainted = () => new SourceError('SOURCE_TIMEOUT', '抖音二维码未能显示，请刷新。');
          if (panel?.id && view.issued) {
            if (unread()) throw unpainted();
            if (view.remaining <= 0 || (view.pollUntil && now() >= view.pollUntil))
              return { phase: 'expired' };
            const qr = await bitmap();
            if (qr && live() === view) {
              if (view.image !== qr.hash) {
                view.image = qr.hash;
                view.shown = null;
                view.token = randomUUID();
              }
              return { phase: 'ready', image: 'data:image/png;base64,' + qr.png, imageToken: view.token };
            }
          }
          if (panel?.loginEntry === 'ready' && !clicked) {
            if (live() !== view) throw unsupported();
            clicked = true;
            view.passive = false;
            const result = await page.evaluate(panelScript, { key, action: 'open' });
            clicked = result?.loginEntry === 'clicked';
          } else if (
            !panel?.id &&
            (await context.cookies(origin)).some(
              (c) => ['sessionid', 'sessionid_ss'].includes(c.name) && c.value
            )
          ) {
            return { phase: 'connecting', signedIn: true };
          }
          if (unread()) throw unpainted();
          if (!view.issued && now() >= view.openUntil)
            throw new SourceError('SOURCE_TIMEOUT', '等待抖音二维码超时，请刷新。');
          return { phase: 'loading' };
        }, true),
      manual: (command) =>
        fixed(async () => {
          if (
            !command ||
            !['submit', 'send'].includes(command.action) ||
            !manualPanel ||
            command.panelId !== manualPanel.token ||
            Object.keys(command).some((k) => !['panelId', 'action', 'code'].includes(k)) ||
            (command.action === 'submit' &&
              (typeof command.code !== 'string' || !/^\d{4,8}$/.test(command.code)))
          )
            throw unsupported();
          const panel = await page.evaluate(panelScript, { key, action: 'locate' });
          const approved = manualPanel;
          const view = live();
          if (!approved || !panel?.challenge || panel.id !== approved.node || key !== approved.key)
            throw unsupported();
          view.manual = {
            node: approved.node,
            until: now() + 3000,
            routes:
              command.action === 'send'
                ? ['/passport/web/send_code']
                : ['/passport/web/validate_code', '/passport/web/verify', '/passport/web/sms_login']
          };
          manualPanel = null;
          try {
            if (
              !(await page.evaluate(smsControls, { key, panel, command: { ...command, panelId: panel.id } }))
            )
              throw unsupported();
          } catch (error) {
            view.manual = null;
            throw error;
          }
        }),
      close
    };
  } catch (e) {
    await context?.close().catch(() => {});
    if (e.name === 'TimeoutError') throw new SourceError('SOURCE_TIMEOUT', '抖音登录页面加载超时。');
    throw sourceFailure();
  }
}
