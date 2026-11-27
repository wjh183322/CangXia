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

function allowRequest(request, page) {
  const url = new URL(request.url());
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  const frame = request.frame();
  if (frame.page() !== page) return false;
  const main = frame === page.mainFrame(),
    method = request.method(),
    type = request.resourceType();
  if (request.isNavigationRequest()) {
    if (method !== 'GET') return false;
    if (main) return official(url);
    return (
      frame.parentFrame() === page.mainFrame() &&
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
    if (method === 'GET') return true;
    if (method === 'POST')
      return (
        url.pathname === '/aweme/v1/web/aweme/listcollection/' ||
        /^\/passport\/web\/(?:check_qrconnect|send_code|validate_code|verify|sms_login)\/?$/.test(
          url.pathname
        )
      );
  }
  return (
    method === 'GET' &&
    ['script', 'stylesheet', 'font', 'image'].includes(type) &&
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

export async function openOfficialProvider(saved, signal, { createContext = launchContext } = {}) {
  let context;
  try {
    signal.throwIfAborted();
    context = await createContext(saved);
    signal.throwIfAborted();
    const page = await context.newPage();
    let key = 'cx' + randomUUID(),
      manualPanel;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        key = 'cx' + randomUUID();
        manualPanel = null;
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
        allowed = allowRequest(route.request(), page);
      } catch {}
      await (allowed ? route.fallback() : route.abort()).catch(() => {});
    });
    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 15000 });
    let clicked = false;
    async function fixed(fn) {
      try {
        signal.throwIfAborted();
        if (!official(new URL(page.url()))) throw sourceFailure();
        const value = await abortable(fn(), AbortSignal.any([signal, AbortSignal.timeout(16000)]));
        signal.throwIfAborted();
        if (!official(new URL(page.url()))) throw sourceFailure();
        return value;
      } catch (e) {
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
      loginView: () =>
        fixed(async () => {
          const state = await page.evaluate(stateScript);
          if (['limited', 'expired', 'scanned'].includes(state.phase)) return { phase: state.phase };
          const panel = await page.evaluate(panelScript, { key, action: 'locate' });
          if (state.phase === 'verification' || panel?.challenge) {
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
          if (panel?.id) {
            const qr = await page.evaluate(loginQrRegion, { key, panel, encode: true, maxBitmapSize: 512 });
            if (qr?.png) return { phase: 'ready', image: 'data:image/png;base64,' + qr.png };
          }
          if (panel?.loginEntry === 'ready' && !clicked) {
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
          return { phase: 'loading' };
        }),
      refresh: () =>
        fixed(async () => {
          await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 15000 });
          clicked = false;
        }),
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
          manualPanel = null;
          if (
            !panel?.challenge ||
            panel.id !== approved?.node ||
            key !== approved.key ||
            !(await page.evaluate(smsControls, { key, panel, command: { ...command, panelId: panel.id } }))
          )
            throw unsupported();
        }),
      close
    };
  } catch (e) {
    await context?.close().catch(() => {});
    if (e.name === 'TimeoutError') throw new SourceError('SOURCE_TIMEOUT', '抖音登录页面加载超时。');
    throw sourceFailure();
  }
}
