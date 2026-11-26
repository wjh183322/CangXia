import { createHash, randomInt, randomUUID } from 'node:crypto';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { abortable, apiRequest, fetchInPage } from '../../../electron/browser-api.mjs';
import { validAccountIdentity, verifyAccountIdentity } from '../../../electron/account-identity.mjs';
import { isMediaURL } from '../../../electron/model.mjs';
import { validQrRect } from '../../../electron/qr-page.mjs';
import { readVerificationPanel, validPanel } from '../../../electron/verification-panel.mjs';
import { PROBE, ProbeError } from './contracts.mjs';
import { inspectSourceResponse } from './page-parser.mjs';

const origin = 'https://www.douyin.com';
const home = `${origin}/user/self`;
const selfRoute = '/aweme/v1/web/user/profile/self/';
const collectionListRoute = '/aweme/v1/web/collects/list/';
const detailRoute = '/aweme/v1/web/aweme/detail/';
const passportQr = origin + '/passport/web/get_qrcode';
const passportQrStatus = origin + '/passport/web/check_qrconnect';
const collectionRoute = '/aweme/v1/web/aweme/listcollection/';
const viewport = Object.freeze({ width: 1000, height: 760 });
const requestTimeout = 12000;
const driverTimeout = 2500;
const loginReadinessMs = 4000;
const loginObservationMs = 200;
const loginSessionWaitMs = 8000;
const maxResponseBytes = 8 * 1024 * 1024;
const maxStorageHelperBytes = 64 * 1024;
const maxPassportQrBytes = 256 * 1024;
const maxPassportStatusRequestBytes = 8192;
const passportStatusWindowMs = 45000;
const maxPassportStatusRequests = 24;
const maxQrBitmapSize = 512;
const passportRequestHeaders = [
  'accept', 'accept-language', 'cookie', 'origin', 'referer', 'user-agent',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'
];
const transportResponseHeaders = [
  'connection', 'content-encoding', 'content-length', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'
];
const loginAssetHosts = new Set([
  'lf-c-flwb.bytetos.com', 'lf-headquarters-speed.yhgfb-cn-static.com',
  'lf-ucenter-web.yhgfb-cn-static.com', 'lf-security.bytegoofy.com',
  'lf-security-backup.bytegoofy.com', 'lf-cdn-tos.bytescm.com',
  'lf-static.applogcdn.com', 'lf3-short.ibytedapm.com', 'privacy.zijieapi.com',
  'lf3-static.bytednsdoc.com'
]);
const loginAssetTypes = {
  script: /^(?:application|text)\/(?:x-)?javascript$/,
  stylesheet: /^text\/css$/,
  font: /^(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff2?|octet-stream))$/,
  image: /^image\/(?:png|jpeg|webp|avif|svg\+xml|x-icon|vnd[.]microsoft[.]icon)$/
};
const loginBootstrapPaths = new Set([
  '/aweme/v1/web/social/count', '/aweme/v1/web/solution/resource/list/',
  '/aweme/v1/web/get/user/settings/', '/aweme/v1/web/query/user/'
]);
const maxLoginAssetBytes = 4 * 1024 * 1024;
const maxLoginAssetRequests = 64;

const storageHelperOrigin = 'https://lf-zt.douyin.com';
const storageHelperPrefix = '/obj/uc-assets/zt/@byted/x-storage-web/';
const storageHelperVersions = new Set(['4.0.5', '4.0.7']);
const storageHelperUrls = new Set([...storageHelperVersions].map(version =>
  storageHelperOrigin + storageHelperPrefix + version + '/dist/latest/index.html'));
const reportedPassportNames = new Set(['get_qrcode', 'check_qrconnect', 'challenge']);
const keys = new Set(['Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']);
const pointerTypes = new Set(['click', 'move', 'down', 'up']);
const requestFields = new Set(['authEpoch', 'signal', 'method', 'params', 'form', 'beforeDispatch', 'onReceivedRows']);
const routeParams = new Map([
  [selfRoute, []],
  [collectionRoute, []],
  [collectionListRoute, ['cursor', 'count']],
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
const staleAuth = details => new ProbeError('STALE_AUTH_EPOCH', 'The source authorization changed. Recheck the signed-in account.', details);
const authRequired = () => new ProbeError('PROBE_AUTH_REQUIRED', 'Verify the normal browser login before reading the source.');
const staleView = () => new ProbeError('STALE_BROWSER_VIEW', 'Refresh the verification view before sending input.');
const panelRequired = () => new ProbeError('PROBE_VERIFICATION_PANEL_REQUIRED', 'The official page has no recognized verification panel.');
const restartRequired = () => new ProbeError('PROBE_BROWSER_RESTART_REQUIRED', 'Restart the probe browser to restore verification access.');
const invalidInput = () => new ProbeError('INVALID_BROWSER_INPUT', 'The verification input is outside the supported controls.');
const invalidRoute = () => new ProbeError('PROBE_BROWSER_ROUTE', 'The probe only accepts supported read-only browser requests.');
const notDispatched = () => new ProbeError('PROBE_BROWSER_NOT_DISPATCHED', 'The source page changed before sending a request.');
const requestFailed = () => new ProbeError('PROBE_BROWSER_REQUEST', 'The source browser request failed.');
const timedOut = () => new ProbeError('PROBE_BROWSER_TIMEOUT', 'The source browser operation timed out.');
const qrUnavailable = () => new ProbeError('PROBE_QR_UNAVAILABLE', 'The official login QR is unavailable.');

export function isLoginQrPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > 1024 * 1024 ||
      bytes.readBigUInt64BE() !== 0x89504e470d0a1a0an || bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR') return false;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width >= 100 && width <= maxQrBitmapSize && height >= 100 && height <= maxQrBitmapSize &&
    Math.abs(width / height - 1) <= 0.12;
}

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
      const parentName = path.basename(parent);
      const legacyName = /^\.(?:org\.chromium\.Chromium|com\.google\.Chrome(?:\.[a-z-]+)?)\.[\w-]{6}$/.test(parentName);
      // Current Chromium uses an unhidden mkdtemp directory for its singleton socket.
      const currentName = temp === '/tmp' && /^(?:org\.chromium\.Chromium|com\.google\.Chrome)\.[a-zA-Z0-9]{6}$/.test(parentName);
      return path.join(parent, 'SingletonSocket') === link && path.dirname(parent) === temp && (legacyName || currentName);
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

function directLoginChild(slot, frame) {
  return slot.kind === 'login' && sourcePage(slot.page.url(), 'login') &&
    frame.parentFrame?.() === slot.page.mainFrame();
}

function clearLoginDocument(slot) {
  slot.qrAuthority = undefined;
  slot.storageFrames = new WeakMap();
}

function trustedLoginChild(slot, frame) {
  if (!directLoginChild(slot, frame)) return false;
  const url = frame.url();
  const authorization = slot.storageFrames.get(frame);
  return url === 'about:blank' ||
    (authorization?.phase === 'committed' && authorization.url === url);
}

function commitLoginChild(slot, frame) {
  if (!directLoginChild(slot, frame)) return false;
  const url = frame.url();
  if (url === 'about:blank') {
    slot.storageFrames.delete(frame);
    return true;
  }
  const authorization = slot.storageFrames.get(frame);
  if (authorization?.phase !== 'provided' || authorization.revision !== slot.revision || authorization.url !== url) return false;
  authorization.phase = 'committed';
  if (authorization.observation) authorization.observation.state = 'completed';
  return true;
}

function isDirectResponse(response, url, contentType) {
  return response.status === 200 && !response.redirected && response.url === url &&
    !response.headers.has('location') &&
    response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === contentType;
}

async function boundedResponseBody(response, limit, accepted, onRefusal) {
  const reader = response.body?.getReader();
  if (!reader) {
    if (accepted) onRefusal?.('body-empty');
    return null;
  }
  try {
    if (!accepted) return null;
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        onRefusal?.('body-oversized');
        return null;
      }
      chunks.push(value);
    }
    if (!length) onRefusal?.('body-empty');
    return length ? Buffer.concat(chunks, length) : null;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readStorageHelper(url, fetchStorageHelper) {
  // This is a public asset. Never inherit the browser's cookies or follow a redirect.
  const response = await fetchStorageHelper(url, {
    method: 'GET', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(requestTimeout)
  });
  const body = await boundedResponseBody(response, maxStorageHelperBytes, isDirectResponse(response, url, 'text/html'));
  if (!body) return null;
  const headers = { 'content-type': 'text/html; charset=utf-8' };
  for (const name of ['content-security-policy', 'x-frame-options', 'cross-origin-resource-policy']) {
    if (response.headers.has(name)) headers[name] = response.headers.get(name);
  }
  return { status: 200, headers, body };
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
      (options.onReceivedRows !== undefined && typeof options.onReceivedRows !== 'function') ||
      (options.form !== undefined && route !== collectionRoute)) throw invalidRoute();
  try {
    return apiRequest(route, { method: options.method, params: readParams(options.params, params), form: readParams(options.form, ['cursor', 'count']) });
  } catch {
    throw invalidRoute();
  }
}

function trustedLoginView(slot) {
  return !slot.page.isClosed() && sourcePage(slot.page.url(), 'login') &&
    slot.page.frames().every(frame => frame === slot.page.mainFrame() || trustedLoginChild(slot, frame));
}

function isPassportQrRequest(request, url) {
  const endpoint = url.split('?', 1)[0];
  return (endpoint === passportQr || endpoint === passportQr + '/') && !url.includes('#') &&
    request.method() === 'GET' && !request.isNavigationRequest() && !request.redirectedFrom() &&
    ['fetch', 'xhr'].includes(request.resourceType());
}

function isPassportQrStatusRequest(request, url) {
  const endpoint = url.split('?', 1)[0];
  return (endpoint === passportQrStatus || endpoint === passportQrStatus + '/') && !url.includes('#') &&
    request.method() === 'POST' && !request.isNavigationRequest() && !request.redirectedFrom() &&
    request.resourceType() === 'xhr';
}

function forwardPassportHeaders(observed) {
  const headers = new Headers();
  for (const name of passportRequestHeaders) {
    const value = observed[name];
    if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) continue;
    if (name === 'origin' && value !== origin || name === 'referer' && !sourcePage(value, 'login')) continue;
    headers.set(name, value);
  }
  return headers;
}

function passportFulfillHeaders(source) {
  const omitted = new Set(transportResponseHeaders);
  for (const name of (source.get('connection') ?? '').split(',')) omitted.add(name.trim().toLowerCase());
  const headers = Object.fromEntries([...source].filter(([name]) => name !== 'set-cookie' && !omitted.has(name)));
  const cookies = source.getSetCookie();
  // Playwright's Chromium fulfill path splits this value into separate Set-Cookie headers.
  if (cookies.length && !omitted.has('set-cookie')) headers['set-cookie'] = cookies.join('\n');
  return headers;
}

async function deliverPassportQr(route, pages, slot, frame, url, observation, fetchPassportQr, clock, status = false) {
  const { page, qrAuthority } = slot;
  const statusWindow = status ? qrAuthority?.statusWindow : undefined;
  let refusalReason = 'no-authority', upstreamStatus;
  const current = (delivering = false) => {
    refusalReason = delivering ? 'stale-before-delivery' : 'view-guard';
    if (pages.get(page) !== slot || slot.qrAuthority !== qrAuthority ||
        status && (!statusWindow || clock.now() >= statusWindow.expires)) return false;
    if (slot.assetAuthority?.bootstrap === 'reloading') {
      if (!delivering) refusalReason = 'bootstrap-reloading';
      return false;
    }
    if (frame !== page.mainFrame() || !trustedLoginView(slot)) return false;
    if (!delivering) refusalReason = 'lease-guard';
    try {
      return qrAuthority.assert() === undefined;
    } catch (error) {
      if (error instanceof ProbeError &&
          ['PROBE_UNAUTHENTICATED', 'STALE_LEASE', 'PROBE_VIEW_REQUIRED'].includes(error.code))
        observation.guardFailure = error.code;
      throw error;
    }
  };
  try {
    if (!qrAuthority || !current()) return false;
    refusalReason = 'request-headers';
    const observed = await browserCall(() => route.request().allHeaders());
    const headers = forwardPassportHeaders(observed);
    if (!current()) return false;
    let requestBody;
    if (status) {
      const mime = observed['content-type'];
      if (typeof mime !== 'string' || !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(mime)) return false;
      requestBody = route.request().postDataBuffer();
      if (!requestBody?.length || requestBody.length > maxPassportStatusRequestBytes || statusWindow.remaining <= 0) return false;
      headers.set('content-type', mime);
      statusWindow.remaining--;
    }
    observation.state = 'requested';
    refusalReason = 'fetch-failed';
    // Forward the authorized browser's exact request without using a shared HTTP cookie jar.
    const response = await fetchPassportQr(url, {
      method: status ? 'POST' : 'GET', headers, body: requestBody,
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(requestTimeout)
    });
    refusalReason = 'response-metadata';
    const accepted = isDirectResponse(response, url, 'application/json') && !response.headers.has('refresh');
    if (accepted) refusalReason = 'body-read-failed';
    else {
      const status = response.status;
      if (typeof status === 'number' && status !== 200) {
        refusalReason = 'http-status';
        if (Number.isInteger(status) && status >= 100 && status <= 599) upstreamStatus = status;
      }
    }
    const body = await boundedResponseBody(response, maxPassportQrBytes, accepted, reason => { refusalReason = reason; });
    if (!body || !current(true)) return false;
    refusalReason = 'response-metadata';
    const responseHeaders = passportFulfillHeaders(response.headers);
    if (!responseHeaders['content-type']) return false;
    refusalReason = 'fulfill-failed';
    await route.fulfill({ status: 200, headers: responseHeaders, body });
    if (!status) {
      qrAuthority.qrDelivered = true;
      qrAuthority.timing.qrDeliveredAtMs ??= clock.now();
    }
    observation.state = 'delivered';
    return true;
  } catch {
    return false;
  } finally {
    if (observation.state !== 'delivered') {
      observation.refusalReason = refusalReason;
      if (upstreamStatus !== undefined) observation.upstreamStatus = upstreamStatus;
    }
  }
}

function observedHelperVersion(url) {
  const target = webTarget(url);
  if (target?.origin !== storageHelperOrigin || !target.pathname.startsWith(storageHelperPrefix)) return;
  return /^([0-9]{1,3}(?:\.[0-9]{1,3}){2})\/dist\/latest\/index\.html$/
    .exec(target.pathname.slice(storageHelperPrefix.length))?.[1];
}

function recordBlockedPassport(loginStage, url, method) {
  const target = webTarget(url);
  if (target?.origin !== origin || (method !== 'GET' && method !== 'POST')) return;
  const name = /^\/passport\/web\/([a-z_]{2,30})\/?$/.exec(target.pathname)?.[1];
  if (!name) return;
  loginStage.blockedPassport[method] = Math.min(1000, loginStage.blockedPassport[method] + 1);
  if (reportedPassportNames.has(name)) loginStage.passportRoutes.set(method + '/' + name, { method, name });
}

function loginResourceType(request, url) {
  const target = webTarget(url);
  if (!target || target.hash || !url.startsWith(target.origin + '/') ||
      request.isNavigationRequest() || request.redirectedFrom()) return null;
  const type = request.resourceType();
  const method = request.method();
  if (target.origin === origin && method === 'GET' && ['fetch', 'xhr'].includes(type) &&
      loginBootstrapPaths.has(target.pathname) && url.split('?', 1)[0] === origin + target.pathname)
    return /^application\/json$/;
  if (loginAssetHosts.has(target.hostname) && ['GET', 'HEAD'].includes(method) &&
      assetPaths.get(type)?.test(target.pathname)) return loginAssetTypes[type];
  return null;
}

async function deliverPageAsset(route, pages, slot, frame, url, mimePattern, fetchLoginAsset) {
  const { page, kind, revision, assetAuthority, storageFrames } = slot;
  if (!assetAuthority || assetAuthority.bootstrap === 'initial' || assetAuthority.bootstrap === 'reloading') return false;
  let delivered = false;
  const current = () => pages.get(page) === slot && slot.assetAuthority === assetAuthority &&
    assetAuthority.bootstrap !== 'reloading' && slot.storageFrames === storageFrames &&
    frame === page.mainFrame() && (kind === 'login' ? trustedLoginView(slot) :
      kind === 'reader' && revision === slot.revision && !page.isClosed() && sourcePage(page.url(), kind)) &&
    assetAuthority.assert() === undefined;
  try {
    if (!assetAuthority.remaining || !current()) return false;
    assetAuthority.remaining--;
    const request = route.request();
    const method = request.method();
    const deadline = AbortSignal.timeout(requestTimeout);
    const response = await fetchLoginAsset(url, {
      method, credentials: 'omit', redirect: 'error',
      signal: kind === 'reader' ? AbortSignal.any([deadline, assetAuthority.requestSignal]) : deadline
    });
    const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const accepted = mimePattern.test(type) &&
      isDirectResponse(response, url, type) && !response.headers.has('refresh');
    let body;
    if (method === 'HEAD') {
      await response.body?.cancel().catch(() => {});
      if (accepted) body = Buffer.alloc(0);
    } else body = await boundedResponseBody(response, maxLoginAssetBytes, accepted);
    if (!body || !current()) return false;
    const headers = { 'content-type': response.headers.get('content-type') };
    for (const name of ['access-control-allow-origin', 'cross-origin-resource-policy']) {
      if (response.headers.has(name)) headers[name] = response.headers.get(name);
    }
    await route.fulfill({ status: 200, headers, body });
    delivered = true;
    return true;
  } catch {
    return false;
  } finally {
    const stats = assetAuthority.stats;
    if (delivered) stats.loaded++;
    else stats.refused = Math.min(maxLoginAssetRequests, stats.refused + 1);
  }
}

function browserTraffic(context, pages, fetchStorageHelper, loginStage, fetchPassportQr, fetchLoginAsset, clock) {
  const totals = { completedRequests: 0, sentBytes: 0, receivedBytes: 0, blockedRequests: 0, failedRequests: 0, unknownSizes: 0 };
  const blocked = new WeakSet();
  context.on('request', request => {
    if (!request.isNavigationRequest()) return;
    let slot;
    try {
      const frame = request.frame();
      const page = frame.page();
      if (frame !== page.mainFrame()) return;
      slot = pages.get(page);
      const authority = slot?.assetAuthority;
      if (!authority) return;
      const url = request.url(), from = request.redirectedFrom();
      if (authority.bootstrap === 'initial' && page.url() === 'about:blank' && request.method() === 'GET' &&
          sourcePage(url, slot.kind) &&
          (authority.initialRequest ? from === authority.initialRequest : !from && url === home)) {
        authority.initialRequest = request;
      } else if (authority.open && !authority.requestSignal?.aborted && authority.bootstrap === 'eligible' && !from &&
          request.method() === 'GET' && url === home && page.url() === home && authority.assert() === undefined) {
        // The normal bootstrap can reload the same owned page once before the login action.
        authority.bootstrap = 'reloading';
        authority.reloadFrom = slot.storageFrames;
        authority.initialRequest = request;
        slot.qrAuthority = undefined;
      } else slot.assetAuthority = undefined;
    } catch {
      if (slot) slot.assetAuthority = undefined;
    }
  });
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
      let allowed = false, observation;
      let cancelBlankChildNavigation = false;
      try {
        const frame = request.frame();
        const page = frame.page();
        const slot = pages.get(page);
        const mainFrame = frame === page.mainFrame();
        allowed = !!slot && approvedBrowserTraffic(request, slot, mainFrame);
        if (slot && mainFrame && request.isNavigationRequest() &&
            (slot.kind === 'login' || slot.kind === 'reader' && slot.assetAuthority)) {
          if (allowed) {
            if (slot.kind === 'login') clearLoginDocument(slot);
            const authority = slot.assetAuthority;
            if (authority?.bootstrap === 'reloading' && authority.initialRequest === request) {
              authority.reloadDocument = slot.storageFrames;
              slot.panel = null;
            }
          } else {
            slot.qrAuthority = undefined;
            slot.assetAuthority = undefined;
          }
        }
        const url = request.url();
        if (!allowed && slot?.kind === 'reader' && mainFrame && slot.assetAuthority &&
            ['script', 'stylesheet'].includes(request.resourceType())) {
          const mimePattern = loginResourceType(request, url);
          if (mimePattern && await deliverPageAsset(route, pages, slot, frame, url, mimePattern, fetchLoginAsset)) return;
        }
        if (!allowed && slot?.kind === 'login' && mainFrame && sourcePage(page.url(), 'login')) {
          const mimePattern = loginResourceType(request, url);
          if (mimePattern && await deliverPageAsset(route, pages, slot, frame, url, mimePattern, fetchLoginAsset)) return;
          if (isPassportQrRequest(request, url)) {
            const qrRequest = { state: 'refused' };
            loginStage.qrRequest = qrRequest;
            if (await deliverPassportQr(route, pages, slot, frame, url, qrRequest, fetchPassportQr, clock)) return;
            qrRequest.state = 'refused';
            if (loginStage.qrRequest === qrRequest) recordBlockedPassport(loginStage, url, request.method());
          } else {
            if (isPassportQrStatusRequest(request, url)) {
              const statusRequest = { state: 'refused' };
              loginStage.statusRequest = statusRequest;
              if (await deliverPassportQr(route, pages, slot, frame, url, statusRequest, fetchPassportQr, clock, true)) return;
              statusRequest.state = 'refused';
            }
            recordBlockedPassport(loginStage, url, request.method());
          }
        }
        if (slot && request.isNavigationRequest() && directLoginChild(slot, frame)) {
          // A canceled navigation preserves the current blank document instead of committing a browser error page.
          cancelBlankChildNavigation = frame.url() === 'about:blank' && !slot.storageFrames.has(frame) &&
            !storageHelperUrls.has(url) && request.method() === 'GET' && !request.redirectedFrom() &&
            request.resourceType() === 'document';
          slot.storageFrames.delete(frame);
          const version = observedHelperVersion(url);
          if (version) {
            observation = { version, state: storageHelperVersions.has(version) ? 'refused' : 'new-version' };
            loginStage.helper = observation;
          }
          if (storageHelperUrls.has(url) && request.method() === 'GET' &&
              !request.redirectedFrom() && request.resourceType() === 'document') {
            if (observation) observation.state = 'requested';
            const authorization = { url, revision: slot.revision, phase: 'fetching', observation };
            slot.storageFrames.set(frame, authorization);
            const document = await readStorageHelper(url, fetchStorageHelper);
            if (document && pages.get(page) === slot && !page.isClosed() && slot.revision === authorization.revision &&
                slot.storageFrames.get(frame) === authorization && directLoginChild(slot, frame) && page.frames().includes(frame)) {
              authorization.phase = 'provided';
              try {
                await route.fulfill(document);
                return;
              } catch {
                if (slot.storageFrames.get(frame) === authorization) slot.storageFrames.delete(frame);
              }
            }
          }
        }
      } catch {
        // Requests without an owned frame cannot load a source document.
      }
      if (allowed) await route.continue();
      else {
        if (observation?.state === 'requested') observation.state = 'refused';
        blocked.add(request);
        totals.blockedRequests++;
        await route.abort(cancelBlankChildNavigation ? 'aborted' : undefined);
      }
    })
  };
}

// Executed only in the owned main login document. No form values leave the page.
function inspectLoginPanel(readPanel, { viewProbe, action, checkNotice, x, y }) {
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
  let qrOnly = false;
  const titlesOf = surface => [...surface.querySelectorAll('h1,h2,h3,[role="heading"],button,span,div')]
    .filter(element => element.children.length < 3 && visible(element)).map(compact);
  if (checkNotice) {
    const center = document.elementsFromPoint(innerWidth / 2, innerHeight / 2);
    for (const surface of new Set([...surfaces, ...center])) {
      if (!fits(box(surface)) || !visible(surface) || changesAccount.test(compact(surface))) continue;
      const titles = titlesOf(surface);
      if (!surfaces.includes(surface) && !(parseFloat(getComputedStyle(surface).borderRadius) > 0 &&
          titles.some(title => qrLabel.test(title)))) continue;
      if (titles.some(title => /^(?:请先完成安全验证|请完成身份验证|短信验证码已发送|请使用绑定手机号验证|身份验证|安全验证)$/.test(title)))
        return { loginNotice: 'verification' };
      if (titles.some(title => /^二维码(?:已)?(?:过期|失效)(?:点击刷新)?$/.test(title)))
        return { loginNotice: 'expired' };
    }
  }
  for (const surface of surfaces) {
    const rect = box(surface);
    if (!fits(rect) || !visible(surface) || changesAccount.test(compact(surface))) continue;
    const titles = titlesOf(surface);
    challenge = !!knownRect && sameBox(rect, knownRect) && titles.some(title => challengeLabel.test(title));
    const qr = titles.some(title => qrLabel.test(title)) && !!surface.querySelector('canvas,img,svg');
    if (challenge || qr) { selected = surface; break; }
  }
  if (!selected && ['probe-open', 'open', 'qr'].includes(action)) {
    // The official QR modal can omit dialog attributes. This recognition is only for the QR path.
    selected = document.elementsFromPoint(innerWidth / 2, innerHeight / 2).find(surface => {
      if (!fits(box(surface)) || !visible(surface) || !(parseFloat(getComputedStyle(surface).borderRadius) > 0) ||
          changesAccount.test(compact(surface)) || !surface.querySelector('canvas,img,svg')) return false;
      const titles = titlesOf(surface);
      return titles.includes('如何扫码') && titles.includes('验证码登录') &&
        titles.some(title => qrLabel.test(title)) && !titles.some(title => challengeLabel.test(title));
    });
    qrOnly = !!selected;
  }
  if (!selected) {
    if (action === 'probe-open' || action === 'open') {
      // Opening the ordinary login dialog is the only action outside a recognized panel.
      const entry = [...document.querySelectorAll('button,[role="button"]')]
        .find(element => label(element) === '登录' && !element.closest('a[href]') &&
          !element.disabled && element.getAttribute('aria-disabled') !== 'true' && visible(element));
      if (!entry || document.readyState === 'loading') return { loginEntry: 'not-present' };
      if (action === 'probe-open') return { loginEntry: 'ready' };
      entry.click();
      return { loginEntry: 'clicked' };
    }
    return null;
  }
  const identities = window[viewProbe] ??= { elements: new WeakMap(), next: 0 };
  if (!identities.elements.has(selected)) identities.elements.set(selected, ++identities.next);
  const result = { ...box(selected), id: identities.elements.get(selected), allowed: false, qrOnly };
  if (action === undefined || action === 'open' || action === 'probe-open' || action === 'qr') return result;

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

// QR classification from electron/qr-page.mjs, restricted to the owned login panel.
function loginQrRegion({ key, panel, encode, maxBitmapSize }) {
  const compact = element => (element.innerText || element.textContent || '').replace(/\s+/g, '');
  if (!document.body || scrollX || scrollY) return null;
  const body = compact(document.body);
  if (/访问.{0,3}频繁|操作过于频繁|请求过于频繁|二维码.{0,3}(失效|过期)|扫码成功|扫描成功|请在手机.{0,8}确认登录|已确认[，,].{0,8}正在登录|接收短信验证码|发送短信验证|请输入.{0,16}短信验证码|验证码已发送|请使用绑定手机号.{0,12}验证|请(?:先)?完成.{0,8}验证|拖动.{0,8}滑块|按住.{0,8}滑块|请依次点击/.test(body)) return null;

  const state = window[key];
  const surface = document.elementsFromPoint(panel.x + panel.width / 2, panel.y + panel.height / 2)
    .find(element => state?.elements.get(element) === panel.id);
  if (!surface) return null;

  const visible = element => {
    const { width, height } = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return width > 5 && height > 5 && style.visibility === 'visible' &&
      style.display !== 'none' && style.opacity !== '0';
  };
  const headings = [...surface.querySelectorAll('h1,h2,h3,[role="heading"],button,span,div')]
    .filter(element => element.children.length < 3 && visible(element)).map(compact);
  if (!headings.some(title => /^(扫码登录|二维码登录|使用抖音扫码登录)$/.test(title)) ||
      headings.some(title => /^(身份验证|安全验证|手机号验证|手机验证|短信验证|输入验证码|请输入验证码)$/.test(title)))
    return null;

  const candidates = [];
  for (const element of surface.querySelectorAll('img,canvas,svg')) {
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
    if (!visible(element) || width < 100 || height < 100 || width > 450 || height > 450 ||
        Math.abs(width / height - 1) > 0.12 || left < panel.x || top < panel.y ||
        right > panel.x + panel.width || bottom > panel.y + panel.height) continue;
    candidates.push(element);
  }
  if (candidates.length !== 1) return null;
  const [element] = candidates;
  const label = node => ['aria-label', 'alt', 'id', 'class', 'src'].map(name => node.getAttribute(name)).join(' ');
  let marked = /二维码|qrcode|qr-code|\/qr\//i.test(label(element));
  for (let ancestor = element.parentElement; !marked && ancestor && ancestor !== surface; ancestor = ancestor.parentElement) {
    const { width, height } = ancestor.getBoundingClientRect();
    if (width > 520 || height > 520) break;
    marked = /qrcode|qr-code|扫码登录|二维码登录|如何扫码|扫一扫/i.test(label(ancestor) + compact(ancestor));
  }
  if (!marked) return null;

  const isImage = element.tagName === 'IMG';
  if (!isImage && element.tagName !== 'CANVAS') return null;
  const source = isImage ? element.currentSrc : undefined;
  if (isImage && (!element.complete || !source ||
      !/^data:image\/(?:png|jpeg|webp);base64,/i.test(source) &&
      !/^https:\/\/[^?#]+\.(?:png|jpe?g|webp)(?:[?#]|$)/i.test(source))) return null;
  const pixelWidth = isImage ? element.naturalWidth : element.width;
  const pixelHeight = isImage ? element.naturalHeight : element.height;
  const inlineQr = isImage && /^data:image\/(?:png|jpeg|webp);base64,/i.test(source) &&
    pixelWidth === maxBitmapSize && pixelHeight === maxBitmapSize;
  if (![pixelWidth, pixelHeight].every(size => Number.isInteger(size) && size >= 100 && (size <= 450 || inlineQr)) ||
      Math.abs(pixelWidth / pixelHeight - 1) > 0.12) return null;
  const { left, top, right, bottom } = element.getBoundingClientRect();
  const x = Math.ceil(left), y = Math.ceil(top);
  const width = Math.floor(right) - x, height = Math.floor(bottom) - y;
  // The current inline QR has rounded corners and a separate small SVG logo at its center.
  const inset = inlineQr ? Math.ceil(Math.min(width, height) / 10) : 0;
  const x1 = x + inset, y1 = y + inset, x2 = x + width - 1 - inset, y2 = y + height - 1 - inset;
  if (![[x1, y1], [x2, y1], [x1, y2], [x2, y2]].every(([a, b]) => element.contains(document.elementFromPoint(a, b)))) return null;
  const cx = x + width / 2, cy = y + height / 2;
  const center = document.elementFromPoint(cx, cy);
  if (!element.contains(center)) {
    const logo = inlineQr && center?.closest('svg');
    if (!logo || !element.parentElement.contains(logo) || !document.elementsFromPoint(cx, cy).includes(element)) return null;
    const rect = logo.getBoundingClientRect();
    if (rect.width > width / 3 || rect.height > height / 3 ||
        rect.left < left || rect.right > right || rect.top < top || rect.bottom > bottom) return null;
  }
  const regions = state.qrRegions ??= new WeakMap();
  if (regions.get(element)?.source !== source || !regions.has(element)) {
    regions.set(element, { source, id: ++state.next });
  }
  const region = { id: regions.get(element).id, x, y, width, height, pixelWidth, pixelHeight };
  if (!encode) return region;
  // Draw the element bitmap at its native size, outside the document's compositing tree.
  try {
    const bitmap = document.createElement('canvas');
    bitmap.width = pixelWidth;
    bitmap.height = pixelHeight;
    bitmap.getContext('2d').drawImage(element, 0, 0);
    const url = bitmap.toDataURL('image/png');
    const prefix = 'data:image/png;base64,';
    if (url.startsWith(prefix) && url.length <= prefix.length + 4 * Math.ceil(1024 * 1024 / 3)) {
      return { ...region, png: url.slice(prefix.length) };
    }
  } catch {
    // Tainted or unreadable bitmaps stay in the browser.
  }
  return null;
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

export async function openBrowserGateway({
  config, chromium, store, clock = performance, fetchStorageHelper = globalThis.fetch,
  fetchPassportQr = globalThis.fetch, fetchLoginAsset = globalThis.fetch
}) {
  const root = config?.root;
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root ||
      path.parse(root).root === root || (!chromium && (process.platform !== 'linux' || root !== PROBE.root))) throw unsafeProfile();
  const directory = path.join(root, 'browser');
  const captured = await profileIdentity(root, directory, true);
  let context;
  let state;
  const pages = new Map();
  let observeTraffic;
  const loginStage = {
    helper: { state: 'not-requested' }, qrRequest: { state: 'not-requested' }, loginEntry: 'not-checked',
    loginResources: { loaded: 0, refused: 0 }, blockedPassport: { GET: 0, POST: 0 }, passportRoutes: new Map()
  };
  let lastQr = 'not-requested';
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
    const traffic = browserTraffic(context, pages, fetchStorageHelper, loginStage, fetchPassportQr, fetchLoginAsset, clock);
    await traffic.install();
    await context.routeWebSocket('**/*', socket => socket.close());
    observeTraffic = traffic.observe;
    // Keep startup pages unmanaged. Closing the last headed tab can close Chromium.
    if (context.pages().length === 0) await browserCall(() => context.newPage());
    const startupPages = context.pages();
    if (startupPages.length === 0 || startupPages.some(page => page.isClosed() || page.url() !== 'about:blank')) {
      throw unsafeProfile();
    }
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
  let readerResources;
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

  async function makePage(kind, signal = epochController.signal, assetAuthority) {
    const page = await browserCall(() => context.newPage(), signal);
    const slot = {
      page, kind, revision: 0, pressed: false, panel: null,
      viewProbe: '__cangxia_view_' + randomUUID(), storageFrames: new WeakMap(), assetAuthority
    };
    if (assetAuthority) assetAuthority.bootstrap = 'initial';
    pages.set(page, slot);
    page.on('popup', popup => { void popup.close().catch(() => {}); });
    page.on('close', () => {
      pages.delete(page);
      if (slot === login) pageRevision++;
    });
    const viewChanged = () => { if (kind === 'login') pageRevision++; };
    const rejectChild = () => {
      viewChanged();
      pages.delete(page);
      void page.close().catch(() => {});
    };
    page.on('frameattached', frame => {
      if (kind === 'login' && !directLoginChild(slot, frame)) rejectChild();
    });
    page.on('framedetached', frame => {
      slot.storageFrames.delete(frame);
      viewChanged();
    });
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) {
        if (kind === 'login' && !commitLoginChild(slot, frame)) rejectChild();
        return;
      }
      viewChanged();
      slot.revision++;
      const authority = slot.assetAuthority;
      if ((authority?.bootstrap === 'initial' || authority?.bootstrap === 'reloading') && page.url() !== 'about:blank') {
        if (authority.initialRequest?.url() === page.url() &&
            (authority.bootstrap === 'initial' || authority.open && !authority.requestSignal?.aborted &&
              authority.reloadDocument === slot.storageFrames)) {
          authority.bootstrap = authority.bootstrap === 'initial' && page.url() === home ? 'eligible' : 'done';
          authority.initialRequest = undefined;
        } else slot.assetAuthority = undefined;
      }
      if (slot.pressed || !sourcePage(page.url(), kind)) {
        if (kind === 'login') {
          clearLoginDocument(slot);
          slot.assetAuthority = undefined;
        }
        if (page.url() !== 'about:blank') void page.close().catch(() => {});
      }
    });
    try {
      await browserCall(() => page.goto(home, { waitUntil: 'domcontentloaded', timeout: requestTimeout }), signal, requestTimeout);
      if (kind === 'reader' && slot.assetAuthority) {
        await browserCall(() => page.waitForLoadState('load', { timeout: 2000 }), signal)
          .catch(() => signal.throwIfAborted());
      }
      if (!page.isClosed() && sourcePage(page.url(), kind)) return slot;
    } catch (error) {
      // The browser driver can include source URLs or profile paths in errors.
      if (error instanceof ProbeError || signal.aborted) {
        void page.close().catch(() => {});
        throw error;
      }
    } finally {
      if (kind === 'reader') slot.assetAuthority = undefined;
    }
    void page.close().catch(() => {});
    assertOpen();
    throw new ProbeError('PROBE_BROWSER_PAGE', 'The official source page could not be loaded.');
  }

  async function prepare(kind, signal, guard) {
    assertOpen();
    if (kind === 'detail') {
      if (!detail || detail.page.isClosed()) detail = await makePage(kind, signal);
      return detail;
    }
    if (!reader || reader.page.isClosed()) {
      readerResources = { loaded: 0, refused: 0 };
      const preload = new AbortController();
      const preloadSignal = AbortSignal.any([signal, preload.signal]);
      try {
        reader = await makePage('reader', signal, {
          remaining: maxLoginAssetRequests, stats: readerResources, open: true, requestSignal: preloadSignal,
          assert() { preloadSignal.throwIfAborted(); guard?.(); }
        });
      } finally {
        preload.abort();
      }
    }
    return reader;
  }

  function trustedView(slot) {
    return !!slot && pages.get(slot.page) === slot && trustedLoginView(slot);
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

  function assertMainOnlyView(revision) {
    const slot = assertView(revision);
    if (slot.page.frames().some(frame => frame !== slot.page.mainFrame())) throw staleView();
    return slot;
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

  async function mutateLogin(slot, revision, task, { beforeDispatch, signal = epochController.signal, timeout = driverTimeout } = {}) {
    let dispatched = false;
    try {
      return await browserCall(() => {
        assertView(revision);
        beforeDispatch?.();
        dispatched = true;
        return task();
      }, signal, timeout);
    } catch (error) {
      if (!dispatched) throw error;
      // The driver can reject before the browser has finished applying the action.
      await retireLogin(slot);
      if (error instanceof ProbeError) throw error;
      throw new ProbeError('PROBE_BROWSER_INPUT', 'The verification action could not be confirmed.');
    }
  }

  async function applyPanel(slot, result) {
    let appliedRevision = pageRevision;
    let panel = null;
    if (validPanel(result) && result.x + result.width <= viewport.width && result.y + result.height <= viewport.height &&
        Number.isSafeInteger(result.id) && result.id > 0) {
      const { id, x, y, width, height } = result;
      panel = { id, x, y, width, height };
    }
    if (JSON.stringify(panel) !== JSON.stringify(slot.panel)) {
      slot.panel = panel;
      appliedRevision = ++pageRevision;
      if (slot.pressed) await retireLogin(slot);
    }
    return appliedRevision;
  }

  async function refreshPanel(slot, action) {
    const revision = pageRevision;
    assertView(revision);
    const { page, viewProbe } = slot;
    const checkNotice = action?.action === 'qr' && Boolean(slot.qrAuthority);
    const result = await browserCall(() => page.evaluate(panelScript, { viewProbe, ...action, checkNotice }), epochController.signal);
    assertView(revision);
    await applyPanel(slot, result);
    if (action?.action === 'qr' && slot.qrAuthority) checkLoginNotice(result);
    return result?.allowed === true;
  }

  function checkLoginNotice(result) {
    if (result?.loginNotice === 'expired') throw new ProbeError('PROBE_QR_EXPIRED');
    if (result?.loginNotice === 'verification') throw new ProbeError('PROBE_LOGIN_VERIFICATION_REQUIRED');
  }

  async function waitForLoginPanel(slot, requestSignal, assertOpening) {
    const { page, viewProbe, qrAuthority, assetAuthority } = slot;
    let { storageFrames } = slot;
    const signal = requestSignal ? AbortSignal.any([requestSignal, epochController.signal]) : epochController.signal;
    const started = clock.now();
    const entryDeadline = started + loginReadinessMs;
    let deadline = entryDeadline;
    const remaining = () => Math.ceil(deadline - clock.now());
    const startQrWait = () => {
      if (qrAuthority && deadline === entryDeadline) deadline = clock.now() + requestTimeout;
    };
    let dispatched = false;
    let waitingForQr = false;
    const ready = () => {
      assertOpening();
      assertVerificationAvailable();
      if (slot !== login || pages.get(page) !== slot || page.isClosed()) throw staleView();
      const sameOpening = assetAuthority?.open && slot.assetAuthority === assetAuthority;
      if (!sourcePage(page.url(), 'login')) throw staleView();
      if (sameOpening && assetAuthority.bootstrap === 'reloading') {
        if (dispatched) throw staleView();
        return false;
      }
      const rebind = sameOpening && !dispatched && slot.storageFrames !== storageFrames &&
        assetAuthority.reloadDocument === slot.storageFrames && !slot.qrAuthority;
      if (!rebind && (slot.qrAuthority !== qrAuthority || slot.storageFrames !== storageFrames)) throw staleView();

      const main = page.mainFrame();
      let pendingChild = false;
      for (const frame of page.frames()) {
        if (frame === main) continue;
        const authorization = slot.storageFrames.get(frame);
        const url = frame.url();
        const directChild = directLoginChild(slot, frame);
        // An attached child can have no committed document yet. Wait without trusting it.
        if (dispatched && directChild && url === '') pendingChild = true;
        else if (directChild && authorization?.revision === slot.revision &&
            authorization.observation?.state === 'requested' &&
            ['fetching', 'provided'].includes(authorization.phase) && storageHelperUrls.has(authorization.url) &&
            (url === '' || url === 'about:blank' || url === authorization.url)) {
          pendingChild = true;
        } else if (!trustedLoginChild(slot, frame)) throw staleView();
      }
      if (pendingChild) return false;
      if (rebind) {
        storageFrames = slot.storageFrames;
        slot.qrAuthority = qrAuthority;
      }
      return true;
    };
    const pause = async () => {
      const wait = Math.min(loginObservationMs, remaining());
      if (wait <= 0) return;
      let timer;
      try { await abortable(new Promise(resolve => { timer = schedule(resolve, wait); }), signal); }
      finally { unschedule(timer); }
    };
    loginStage.loginEntry = 'not-checked';

    for (;; await pause()) {
      if (qrAuthority?.qrDelivered) startQrWait();
      if (remaining() <= 0) break;
      if (!ready()) continue;
      const revision = pageRevision;
      let result, sampledDocument;
      try {
        result = await browserCall(() => {
          if (!ready()) return null;
          if (assetAuthority?.bootstrap === 'eligible') sampledDocument = slot.storageFrames;
          return page.evaluate(panelScript, { viewProbe, action: 'probe-open', checkNotice: Boolean(qrAuthority) });
        }, signal, Math.min(driverTimeout, remaining()));
      } catch (error) {
        const trackedReload = sampledDocument && !dispatched && assetAuthority?.open &&
          slot.assetAuthority === assetAuthority && assetAuthority.reloadFrom === sampledDocument &&
          (assetAuthority.bootstrap === 'reloading' ||
           assetAuthority.bootstrap === 'done' && assetAuthority.reloadDocument === slot.storageFrames);
        // Chromium can retire the sampled execution context before returning a passive read.
        if (!trackedReload || signal.aborted || remaining() <= 0 || error instanceof ProbeError ||
            !/^(?:page[.]evaluate: )?Execution context was destroyed(?:,|[.]|$)/.test(error?.message ?? '')) throw error;
        ready();
        continue;
      }
      if (!ready()) continue;
      const appliedRevision = await applyPanel(slot, revision === pageRevision ? result : null);
      if (!ready()) continue;
      if (appliedRevision !== pageRevision) await applyPanel(slot, null);
      if (qrAuthority && revision === pageRevision && appliedRevision === pageRevision) checkLoginNotice(result);
      if (revision === pageRevision && result?.loginEntry === 'not-present' && !dispatched) {
        loginStage.loginEntry = 'not-present';
      }
      waitingForQr = !!(slot.panel && result?.qrOnly && qrAuthority);
      if (slot.panel) {
        if (qrAuthority) qrAuthority.timing.panelSeenAtMs ??= clock.now();
        if (loginStage.loginEntry !== 'clicked') loginStage.loginEntry = 'panel-present';
        if (waitingForQr) {
          startQrWait();
          const { panel } = slot;
          const observedRevision = pageRevision;
          const timeout = Math.min(driverTimeout, remaining());
          if (timeout <= 0) break;
          const region = await browserCall(() => {
            if (!ready() || observedRevision !== pageRevision) return null;
            return page.evaluate(loginQrRegion, { key: viewProbe, panel, encode: false, maxBitmapSize: maxQrBitmapSize });
          }, signal, timeout);
          if (!ready() || observedRevision !== pageRevision || !validQrRect(region, viewport) ||
              !Number.isSafeInteger(region.id)) continue;
        }
        return;
      }
      const entryRemaining = Math.ceil(entryDeadline - clock.now());
      if (!dispatched && revision === pageRevision && result?.loginEntry === 'ready' &&
          clock.now() - started >= loginObservationMs && entryRemaining > 0) {
        dispatched = true;
        const action = await mutateLogin(slot, pageRevision, () => page.evaluate(panelScript, { viewProbe, action: 'open' }), {
          beforeDispatch() {
            if (!ready()) throw staleView();
            if (clock.now() >= entryDeadline || remaining() <= 0) throw timedOut();
            if (assetAuthority?.bootstrap === 'eligible') assetAuthority.bootstrap = 'done';
          },
          signal, timeout: Math.min(driverTimeout, entryRemaining)
        });
        // The authorized click may have started a helper. Validate the scope and let the next poll wait.
        ready();
        if (action?.loginEntry === 'clicked') {
          loginStage.loginEntry = 'clicked';
          startQrWait();
        } else if (action?.loginEntry === 'not-present') loginStage.loginEntry = 'not-present';
      }
    }
    if (!ready()) throw timedOut();
    if (waitingForQr) throw qrUnavailable();
  }

  function openLogin({ signal, guard, assertQrRequest } = {}) {
    const assertOpening = () => {
      signal?.throwIfAborted();
      guard?.();
    };
    return withView(async () => {
      assertOpening();
      assertVerificationAvailable();
      loginStage.loginResources = { loaded: 0, refused: 0 };
      loginStage.accountCheck = undefined;
      const assetAuthority = typeof assertQrRequest === 'function' ?
        { assert: assertQrRequest, remaining: maxLoginAssetRequests, stats: loginStage.loginResources,
          open: true, requestSignal: signal } : undefined;
      try {
        const previousQrViewLost = loginStage.qrRequest.state === 'refused' &&
          loginStage.qrRequest.guardFailure === 'PROBE_VIEW_REQUIRED';
        if (!trustedView(login) || login.qrAuthority?.qrDelivered || previousQrViewLost) {
          invalidate();
          if (login && !login.page.isClosed()) await browserCall(() => login.page.close(), epochController.signal);
          lastQr = 'not-requested';
          loginStage.helper = { state: 'not-requested' };
          loginStage.qrRequest = { state: 'not-requested' };
          loginStage.statusRequest = undefined;
          loginStage.blockedPassport = { GET: 0, POST: 0 };
          loginStage.passportRoutes.clear();
          login = await makePage('login', epochController.signal, assetAuthority);
          pageRevision++;
        } else login.assetAuthority = assetAuthority;
        if (login) {
          loginStage.timing = typeof assertQrRequest === 'function' ? { openedAtMs: clock.now() } : undefined;
          login.qrAuthority = loginStage.timing ? { assert: assertQrRequest, timing: loginStage.timing } : undefined;
          await waitForLoginPanel(login, signal, assertOpening);
        }
        return viewState();
      } catch (error) {
        if (error instanceof ProbeError) throw error;
        throw panelRequired();
      } finally {
        if (assetAuthority) assetAuthority.open = false;
      }
    });
  }

  async function inspectQr(slot, assertCapture, signal, encode = false) {
    await refreshPanel(slot, { action: 'qr' });
    assertCapture();
    if (!slot.panel) throw qrUnavailable();
    const region = await browserCall(
      () => slot.page.evaluate(loginQrRegion, { key: slot.viewProbe, panel: slot.panel, encode, maxBitmapSize: maxQrBitmapSize }),
      signal
    );
    assertCapture();
    if (!validQrRect(region, viewport) || !Number.isSafeInteger(region.id)) throw qrUnavailable();
    return region;
  }

  function loginQr({ pageRevision: revision, signal } = {}) {
    return withView(async () => {
      lastQr = 'requested';
      const slot = assertView(revision);
      const documentRevision = slot.revision;
      const authority = slot.qrAuthority;
      const panelId = slot.panel?.id;
      const assertCapture = () => {
        const currentSlot = assertView(pageRevision);
        if (currentSlot !== slot || slot.revision !== documentRevision || slot.qrAuthority !== authority ||
            slot.panel?.id !== panelId || slot.pressed) throw staleView();
      };
      try {
        signal?.throwIfAborted();
        const captureSignal = signal ? AbortSignal.any([signal, epochController.signal]) : epochController.signal;
        // Repaint can move the existing panel or replace its bitmap without navigating.
        // Retake only this read-only crop; input continues to require the original revision.
        for (let attempt = 0; attempt < 3; attempt++) {
          const { png, ...region } = await inspectQr(slot, assertCapture, captureSignal, true);
          const current = await inspectQr(slot, assertCapture, captureSignal);
          if (Object.keys(region).some(key => region[key] !== current[key])) continue;
          if (typeof png !== 'string') throw qrUnavailable();
          const bytes = Buffer.from(png, 'base64');
          if (!isLoginQrPng(bytes) || bytes.readUInt32BE(16) !== region.pixelWidth ||
              bytes.readUInt32BE(20) !== region.pixelHeight) throw qrUnavailable();
          if (slot.qrAuthority?.qrDelivered) {
            slot.qrAuthority.statusWindow ??= {
              expires: clock.now() + passportStatusWindowMs, remaining: maxPassportStatusRequests
            };
          }
          return { pageRevision: revision, bytes };
        }
        throw staleView();
      } catch (error) {
        assertCapture();
        if (error instanceof ProbeError) throw error;
        throw qrUnavailable();
      }
    }).then(result => {
      lastQr = 'available';
      return result;
    }, error => {
      lastQr = error?.code === 'STALE_BROWSER_VIEW' ? 'stale' :
        error?.code === 'PROBE_BROWSER_CLOSED' ? 'closed' : 'unavailable';
      throw error;
    });
  }

  function frame({ pageRevision: revision } = {}) {
    return withView(async () => {
      const slot = assertMainOnlyView(revision);
      try {
        await refreshPanel(slot);
        assertMainOnlyView(revision);
        if (!slot.panel) throw panelRequired();
        const { x, y, width, height } = slot.panel;
        const bytes = await slot.page.screenshot({ type: 'png', timeout: 3000, scale: 'css', clip: { x, y, width, height } });
        assertMainOnlyView(revision);
        await refreshPanel(slot);
        assertMainOnlyView(revision);
        if (Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4 * 1024 * 1024) {
          return { ...viewState(), mime: 'image/png', bytes };
        }
      } catch (error) {
        assertMainOnlyView(revision);
        if (error instanceof ProbeError) throw error;
      }
      throw new ProbeError('PROBE_BROWSER_FRAME', 'The verification view could not be captured.');
    });
  }

  function input({ pageRevision: revision, type, x, y, text, key } = {}) {
    return withView(async () => {
      const slot = assertMainOnlyView(revision);
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
        assertMainOnlyView(revision);
        if (!allowed) throw invalidInput();
        const run = task => mutateLogin(slot, revision, () => {
          assertMainOnlyView(revision);
          return task();
        });
        if (type === 'text') await run(() => keyboard.insertText(text));
        else if (type === 'key') await run(() => keyboard.press(key));
        else if (type === 'click' && !slot.pressed) await run(() => mouse.click(position.x, position.y));
        else if (type === 'move') await run(() => mouse.move(position.x, position.y));
        else if (type === 'down' || type === 'up') {
          const pressed = type === 'down';
          if (slot.pressed === pressed) throw invalidInput();
          await run(() => mouse.move(position.x, position.y));
          const stillAllowed = await refreshPanel(slot, { action: type, ...position });
          assertMainOnlyView(revision);
          if (!stillAllowed) throw invalidInput();
          slot.pressed = pressed;
          await run(() => mouse[type]());
        } else throw invalidInput();
      } catch (error) {
        if (error instanceof ProbeError) throw error;
        assertMainOnlyView(revision);
        throw new ProbeError('PROBE_BROWSER_INPUT', 'The verification page could not receive input.');
      }
      assertMainOnlyView(revision);
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

  async function read(slot, request, signal, onReceivedRows) {
    const { page, revision } = slot;
    const key = '__cangxia_read_' + randomUUID().replaceAll('-', '');
    const timeout = AbortSignal.timeout(requestTimeout);
    const combined = AbortSignal.any([signal, timeout]);
    const stop = () => {
      void page.evaluate(key => window[key]?.abort('cancelled'), key).catch(() => {});
    };
    if (onReceivedRows) signal.addEventListener('abort', stop, { once: true });
    try {
      combined.throwIfAborted();
      if (page.isClosed() || !sourcePage(page.url(), slot.kind)) throw notDispatched();
      nextStart = clock.now() + 1100;
      const result = await abortable(page.evaluate(fetchInPage, {
        ...request, key, timeout: requestTimeout, maxBytes: maxResponseBytes
      }), onReceivedRows ? timeout : combined);
      const hasBody = typeof result?.text === 'string';
      const validStatus = Number.isInteger(result?.status) && result.status >= 100 && result.status <= 599;
      const tooLarge = result?.error === 'too-large' || hasBody && Buffer.byteLength(result.text) > maxResponseBytes;
      // A rejected response can still consume sample rows. Report only its count
      // before checking cancellation, page generation, or the signed-in session.
      if (onReceivedRows && (hasBody || tooLarge)) {
        let rows = null;
        if (!tooLarge && validStatus) {
          try { rows = inspectSourceResponse(result, true).rows; } catch { /* Body cannot be bounded. */ }
        }
        if (onReceivedRows(rows) !== undefined) throw invalidRoute();
      }
      combined.throwIfAborted();
      // fetchInPage returns this outcome before calling fetch.
      if (result?.error === 'page-changed') throw notDispatched();
      if (result?.error === 'timeout') throw timedOut();
      if (tooLarge) throw new ProbeError('PROBE_BROWSER_RESPONSE_LIMIT', 'The source browser response exceeded the size limit.');
      if (result?.error || revision !== slot.revision || page.isClosed() || !sourcePage(page.url(), slot.kind) ||
          !validStatus || !hasBody) {
        throw requestFailed();
      }
      const { status, text } = result;
      const retryAfter = Number.isFinite(result.retryAfter) ? Math.min(3600, Math.max(0, result.retryAfter)) : 0;
      if (status === 429) rateLimit(retryAfter);
      return { status, text, retryAfter };
    } catch (error) {
      if (timeout.aborted || !onReceivedRows && combined.aborted) stop();
      if (signal.aborted) throw signal.reason;
      if (timeout.aborted) throw timedOut();
      if (error instanceof ProbeError) throw error;
      throw requestFailed();
    } finally {
      if (onReceivedRows) signal.removeEventListener('abort', stop);
    }
  }

  async function fingerprint(signal, accountCheck) {
    signal.throwIfAborted();
    try {
      const cookies = await browserCall(() => context.cookies([home, `${origin}/aweme/v1/web/`]), signal);
      if (accountCheck) {
        accountCheck.sessionCookiePresent = cookies.some(cookie =>
          (cookie.name === 'sessionid' || cookie.name === 'sessionid_ss') && Boolean(cookie.value));
        if (accountCheck.sessionCookiePresent && loginStage.timing) loginStage.timing.sessionSeenAtMs ??= clock.now();
      }
      return sessionFingerprint(cookies);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProbeError) throw error;
      throw requestFailed();
    }
  }

  async function assertSession(authEpoch, signal, phase) {
    assertAuthEpoch(authEpoch);
    const current = await fingerprint(signal);
    assertAuthEpoch(authEpoch);
    if (current !== binding.fingerprint) {
      invalidate();
      throw staleAuth(phase ? { authSessionChange: phase } : undefined);
    }
  }

  async function waitForIssuedLoginSession(signal, assertRequest, accountCheck) {
    const slot = login;
    const statusWindow = slot?.qrAuthority?.statusWindow;
    if (!statusWindow || !trustedView(slot)) return;
    const deadline = Math.min(statusWindow.expires, clock.now() + loginSessionWaitMs);
    accountCheck.state = 'waiting-for-session';
    for (;;) {
      assertRequest();
      if (login !== slot || !trustedView(slot)) throw staleView();
      await fingerprint(signal, accountCheck);
      if (accountCheck.sessionCookiePresent) {
        accountCheck.state = 'checking';
        return;
      }
      const wait = Math.min(loginObservationMs, deadline - clock.now());
      if (wait <= 0) {
        accountCheck.state = 'session-not-established';
        throw authRequired();
      }
      let timer;
      try { await abortable(new Promise(resolve => { timer = schedule(resolve, wait); }), signal); }
      finally { unschedule(timer); }
    }
  }

  function verifyIdentity({ signal: callerSignal, guard } = {}) {
    const assertRequest = () => {
      callerSignal?.throwIfAborted();
      guard?.();
    };
    return withView(async () => {
      assertRequest();
      assertVerificationAvailable();
      const accountCheck = { state: 'checking' };
      loginStage.accountCheck = accountCheck;
      verifying = true;
      try {
        return await withSource(async () => {
          assertRequest();
          assertOpen();
          const signal = callerSignal ? AbortSignal.any([epochController.signal, callerSignal]) : epochController.signal;
          assertNoCooldown();
          await waitForIssuedLoginSession(signal, assertRequest, accountCheck);
          const slot = await prepare('reader', signal, assertRequest);
          const expected = await fingerprint(signal, accountCheck);
          const profile = { fetch: async url => {
            const target = webTarget(url);
            if (target?.origin !== origin || target.pathname !== selfRoute) throw invalidRoute();
            const request = apiRequest(selfRoute, { params: Object.fromEntries(target.searchParams) });
            await beforeRead(signal);
            assertRequest();
            const { status, text, retryAfter } = await read(slot, request, signal);
            accountCheck.httpStatus = status;
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
          assertRequest();
          const userAgent = await browserCall(() => slot.page.evaluate(() => navigator.userAgent), signal);
          if (typeof userAgent !== 'string' || userAgent.length === 0 || userAgent.length > 512 || /[\r\n]/.test(userAgent)) throw requestFailed();
          if (login && !login.page.isClosed()) await browserCall(() => {
            assertRequest();
            return login.page.close();
          }, signal);
          assertRequest();
          login = undefined;
          if (expected !== await fingerprint(signal)) throw staleAuth();
          assertRequest();
          if (binding && expected !== binding.fingerprint) invalidate();
          assertOpen();
          state = store.withWrite(db => {
            const current = authState(db);
            if (current.authEpoch !== state.authEpoch || current.uid !== state.uid) throw staleAuth();
            return current.uid ? current : writeAuth(db, { ...current, uid: identity.uid });
          });
          binding = { fingerprint: expected, userAgent };
          accountCheck.state = 'verified';
          if (loginStage.timing) loginStage.timing.verifiedAtMs ??= clock.now();
          return { ...identity, authEpoch: state.authEpoch };
        });
      } catch (error) {
        if (error?.code === 'PROBE_ACCOUNT_MISMATCH') accountCheck.state = 'account-mismatch';
        else if (accountCheck.httpStatus >= 400) accountCheck.state = 'http-rejected';
        else if (accountCheck.state !== 'session-not-established') {
          accountCheck.state = accountCheck.httpStatus === undefined ? 'request-unavailable' : 'account-unconfirmed';
        }
        assertRequest();
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
    const { authEpoch, signal: callerSignal, beforeDispatch, onReceivedRows } = options;
    assertAuthEpoch(authEpoch);
    const signals = callerSignal ? [epochController.signal, callerSignal] : [epochController.signal];
    const signal = AbortSignal.any(signals);
    let accountingInFlight = false;
    const queued = withSource(async () => {
      assertAuthEpoch(authEpoch);
      signal.throwIfAborted();
      assertNoCooldown();
      const slot = await prepare(route === detailRoute ? 'detail' : 'reader', signal, beforeDispatch);
      await beforeRead(signal);
      await assertSession(authEpoch, signal, 'before-read');
      assertAuthEpoch(authEpoch);
      // The caller may hold a separate server lease. Check it at actual dispatch.
      if (beforeDispatch && beforeDispatch() !== undefined) throw invalidRoute();
      accountingInFlight = Boolean(onReceivedRows);
      const result = await read(slot, query, signal, onReceivedRows);
      await assertSession(authEpoch, signal, 'after-read');
      assertAuthEpoch(authEpoch);
      const issue = inspectSourceResponse(result);
      if (issue.code === 'PROBE_SOURCE_AUTH') {
        invalidate();
        if (route === collectionListRoute) throw new ProbeError(issue.code, 'The collection list was rejected by the source.', {
          sourceOutcome: issue.sourceOutcome, sourceHttpStatus: result.status, sourceCode: issue.sourceCode
        });
      }
      if (issue.code === 'PROBE_SOURCE_RATE_LIMITED' && result.status === 200) rateLimit(issue.retryAfter);
      return result;
    });
    try {
      return await abortable(queued, callerSignal);
    } catch (error) {
      if (callerSignal?.aborted) {
        // An in-flight read gets its original deadline to account for a body
        // already delivered by the driver. The browser fetch is cancelled immediately.
        if (accountingInFlight) await queued.catch(() => {});
        throw new ProbeError('PROBE_BROWSER_CANCELLED', 'The source read was cancelled.');
      }
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

  function reportStage() {
    let main = closed ? 'browser-closed' : 'not-open';
    let frames = 'unavailable';
    if (!closed && login) {
      const { page } = login;
      main = page.isClosed() ? 'retired' : trustedView(login) ? 'trusted' : 'untrusted';
      if (!page.isClosed()) {
        const children = page.frames().filter(frame => frame !== page.mainFrame());
        frames = !children.length ? 'main-only' :
          !children.every(frame => trustedLoginChild(login, frame)) ? 'untrusted-child' :
          children.some(frame => frame.url() !== 'about:blank') ? 'helper-child' : 'blank-child';
      }
    }
    const { qrRequest } = loginStage;
    return {
      main, frames, panelDetected: main === 'trusted' && !!login?.panel, qr: lastQr,
      qrRequest: qrRequest.state, loginEntry: loginStage.loginEntry,
      ...(loginStage.statusRequest ? { qrStatus: loginStage.statusRequest.state } : {}),
      ...(loginStage.accountCheck ? { accountCheck: { ...loginStage.accountCheck } } : {}),
      ...(loginStage.timing ? { loginTimingMs: { ...loginStage.timing } } : {}),
      ...(qrRequest.state === 'refused' && qrRequest.refusalReason ? {
        qrRefusalReason: qrRequest.refusalReason,
        ...(qrRequest.guardFailure === undefined ? {} : { qrGuardFailure: qrRequest.guardFailure }),
        ...(qrRequest.upstreamStatus === undefined ? {} : { qrUpstreamStatus: qrRequest.upstreamStatus })
      } : {}),
      helper: { ...loginStage.helper },
      loginResources: { ...loginStage.loginResources },
      ...(readerResources?.loaded || readerResources?.refused ? { readerResources: { ...readerResources } } : {}),
      blockedPassport: {
        ...loginStage.blockedPassport, routes: [...loginStage.passportRoutes.values()].map(route => ({ ...route }))
      }
    };
  }

  function close() {
    if (closeTask) return closeTask;
    if (closed) return Promise.resolve();
    stopped();
    closeTask = context.close().catch(() => { throw closedBrowser(); });
    return closeTask;
  }

  return Object.freeze({ openLogin, loginQr, frame, input, verifyIdentity, request, assertAuthEpoch, mediaHeaders, traffic: observeTraffic, reportStage, close });
}
