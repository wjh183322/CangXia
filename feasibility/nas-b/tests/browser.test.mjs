import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { link, mkdir, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { openBrowserGateway } from '../src/browser.mjs';
import { ProbeError } from '../src/contracts.mjs';
import { createLeaseManager } from '../src/lease.mjs';
import { createReadCoordinator } from '../src/read-jobs.mjs';
import { openProbeStore } from '../src/store.mjs';
import { makeSandbox, sourceFixture } from './helpers.mjs';
import { parseSourcePage } from '../src/page-parser.mjs';

const self = 'https://www.douyin.com/user/self';
const collection = '/aweme/v1/web/aweme/listcollection/';
const detail = '/aweme/v1/web/aweme/detail/';
const passportQr = 'https://www.douyin.com/passport/web/get_qrcode';
const storageHelper = version => 'https://lf-zt.douyin.com/obj/uc-assets/zt/@byted/x-storage-web/' + version + '/dist/latest/index.html';
const ownId = '9357260389275234771';
const authorId = '8765602039312834059';
const sourceText = ` { "aweme_list": [{ "aweme_id": 8999555333221111111, "author": {"uid":${authorId}} }], "has_more": 0 } `;
const panelRect = { x: 220, y: 180, width: 480, height: 320 };
const qrRect = { x: 260, y: 280, width: 120, height: 120 };
const qrPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4CAAAAAAcD2kOAAAATElEQVR4nO3NAQkAAAwDoPUvvcU4HC1geiRisVgsFovFYrFYLBaLxWKxWCwWi8VisVgsFovFYrFYLBaLxWKxWCwWi8VisVgsFou/xQMh7wsJH5s1mQAAAABJRU5ErkJggg==', 'base64');
const qrWithNoticePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4CAAAAAAcD2kOAAAAU0lEQVR4nO3NsREAIAgEsN9/aay9s0UKkgWSGhKxWCwWi8VisVjcE+dBLBaLxeKl8Q9isVgsFovFYrFYLBaLxWKxWCwWi8VisVgsFovFYrFYLL4cg+7gFzmifzsAAAAASUVORK5CYII=', 'base64');

function fixtureNode(tagName, { attrs = {}, rect = { x: 240, y: 230, width: 140, height: 30 }, text = '', children = [] } = {}) {
  const { x, y, width, height } = rect;
  const node = {
    tagName: tagName.toUpperCase(), children,
    innerText: [text, ...children.map(child => child.innerText)].join(' '),
    getBoundingClientRect: () => ({ left: x, top: y, right: x + width, bottom: y + height, width, height }),
    getAttribute: name => attrs[name] ?? null,
    matches(selectors) {
      return selectors.split(',').some(selector => {
        const [, tag, attr, value] = /^([a-z\d]*)(?:\[([\w-]+)(?:="([^"]+)")?\])?$/.exec(selector) ?? [];
        return (tag || attr) && (!tag || tag === tagName) && (!attr || (Object.hasOwn(attrs, attr) && (!value || attrs[attr] === value)));
      });
    },
    querySelectorAll(selectors) {
      return children.flatMap(child => [...(child.matches(selectors) ? [child] : []), ...child.querySelectorAll(selectors)]);
    },
    querySelector(selectors) { return this.querySelectorAll(selectors)[0] ?? null; },
    closest(selectors) { return this.matches(selectors) ? this : this.parentElement?.closest(selectors) ?? null; },
    contains(other) { return other === this || children.some(child => child.contains(other)); }
  };
  for (const child of children) child.parentElement = node;
  return node;
}

class FakeContext extends EventEmitter {
  opened = [];
  reads = [];
  input = [];
  navigations = [];
  fulfillments = [];
  uid = ownId;
  session = 'private-fixture-session';
  panel = { id: 1, ...panelRect };
  reply = () => new Response(sourceText, { headers: { 'retry-after': '23' } });

  pages() { return this.opened.filter(page => !page.isClosed()); }
  sourcePages() { return this.pages().filter(page => page.url() !== 'about:blank'); }
  async cookies(urls) {
    assert.deepEqual(urls, [self, 'https://www.douyin.com/aweme/v1/web/']);
    await this.onCookies?.();
    return this.session ? [{ name: 'sessionid', domain: '.douyin.com', path: '/', value: this.session }] : [];
  }

  async route(pattern, handler) { this.routeRequest = handler; }
  async routeWebSocket(pattern, handler) { this.routeSocket = handler; }
  async trySocket() {
    let closed = false;
    await this.routeSocket?.({ close: async () => { closed = true; } });
    return !closed;
  }

  async newPage() {
    const context = this;
    const page = new EventEmitter();
    const frame = { page: () => page, url: () => href };
    const children = [];
    let href = 'about:blank';
    let closed = false;
    const input = async (type, ...args) => {
      await context.beforeInput?.(type, page);
      if (!closed) context.input.push({ page, type, args });
    };
    const window = {};
    page.url = () => href;
    page.mainFrame = () => frame;
    page.frames = () => [frame, ...children];
    page.isClosed = () => closed;
    page.goto = async url => {
      context.navigations.push({ page, url });
      const request = {
        frame: () => frame, url: () => url, method: () => 'GET',
        isNavigationRequest: () => true, redirectedFrom: () => null
      };
      context.emit('request', request);
      const destination = context.onInitialRequest?.(request) ?? url;
      page.navigate(destination);
      await context.onGoto?.(page, destination);
    };
    page.navigate = url => { href = url; page.emit('framenavigated', frame); };
    page.childNavigate = (url, parent = frame) => {
      let childUrl = 'about:blank';
      const child = { page: () => page, url: () => childUrl, parentFrame: () => parent };
      child.navigate = next => { childUrl = next; page.emit('framenavigated', child); };
      children.push(child);
      page.emit('frameattached', child);
      child.navigate(url);
      return child;
    };
    page.detachChild = child => {
      children.splice(children.indexOf(child), 1);
      page.emit('framedetached', child);
    };
    page.close = async () => {
      await context.beforePageClose?.(page);
      closed = true;
      page.emit('close');
      if (context.closesOnLastPage && context.pages().length === 0) context.emit('close');
    };
    page.screenshot = async options => {
      assert.equal(options.path, undefined);
      context.lastShot = options;
      return context.screenshot ? context.screenshot() : Buffer.from('fixture frame');
    };
    page.mouse = {
      click: async (...args) => input('click', ...args), move: async (...args) => input('move', ...args),
      down: async () => input('down'), up: async () => input('up')
    };
    page.keyboard = { insertText: async text => input('text', text), press: async key => input('key', key) };
    page.evaluate = async (fn, arg) => {
      if (arg?.viewProbe) {
        await context.beforePanel?.(arg.action, page);
        if (closed) return null;
      }
      if (arg?.viewProbe && !context.panelDocument) {
        if (context.panel) return { ...context.panel, allowed: context.allowTarget !== false };
        if (arg.action === 'probe-open' || arg.action === 'open') return {
          loginEntry: context.entryVisible === false ? 'not-present' : arg.action === 'open' ? 'clicked' : 'ready'
        };
        return null;
      }
      if (fn.toString().includes('navigator.userAgent')) await context.onUserAgent?.();
      return runInNewContext(`(${fn})(arg)`, {
      arg, window, location: new URL(href), navigator: { userAgent: 'Fixture chromium' },
      document: context.panelDocument ?? { readyState: context.readyState ?? 'complete' }, AbortController, TextDecoder, setTimeout, clearTimeout,
      scrollX: 0, scrollY: 0, innerWidth: 1000, innerHeight: 760,
      getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1', borderRadius: '0px' }),
      fetch: async (url, options) => {
        const target = new URL(url);
        context.reads.push({ page, target, options, clock: context.clock.now() });
        context.emit('browser-fetch');
        if (target.pathname === '/aweme/v1/web/user/profile/self/') {
          return new Response(`{"user":{"uid":${context.uid},"nickname":"fixture-account"}}`);
        }
        return context.reply(url, options);
      }
      });
    };
    this.opened.push(page);
    return page;
  }

  async visit(frame, url, type, method = 'GET', isNavigation = type === 'document', redirectedFrom = null) {
    const request = {
      url: () => url, resourceType: () => type, method: () => method,
      isNavigationRequest: () => isNavigation, redirectedFrom: () => redirectedFrom, frame: () => frame,
      allHeaders: async () => {
        await this.beforeRequestHeaders?.();
        return this.requestHeaders ?? {};
      },
      sizes: async () => ({ requestBodySize: 2, requestHeadersSize: 3, responseBodySize: 50, responseHeadersSize: 4 })
    };
    this.emit('request', request);
    let permitted;
    await this.routeRequest({
      request: () => request,
      abort: async () => { permitted = false; this.emit('requestfailed', request); },
      continue: async () => { permitted = true; this.emit('requestfinished', request); },
      fulfill: async response => {
        this.fulfillments.push(response);
        await this.beforeFulfill?.();
        permitted = true;
        this.emit('requestfinished', request);
      }
    });
    return permitted;
  }

  async close() { await Promise.all(this.pages().map(page => page.close())); this.emit('close'); }
}

async function fixture(t, {
  launch, defer = false,
  fetchStorageHelper = () => assert.fail('unexpected helper request'),
  fetchPassportQr = () => assert.fail('unexpected provider QR request'),
  fetchLoginAsset = () => assert.fail('unexpected guest asset request')
} = {}) {
  const sandbox = await makeSandbox(t);
  const layout = await sandbox.prepare();
  const store = openProbeStore({ file: path.join(layout.state, 'library.sqlite'), libraryId: sandbox.config.libraryId, initialize: true });
  sandbox.onCleanup(() => store.close());
  const browser = new FakeContext();
  let time = 0;
  const clock = {
    now: () => time,
    advance(ms) { time += ms; },
    setTimeout(callback, ms) {
      time += ms;
      return setImmediate(() => { clock.onPaceWait?.(); callback(); });
    },
    clearTimeout: clearImmediate
  };
  browser.clock = clock;
  const chromium = { launchPersistentContext: async (directory, options) => {
    assert.equal(directory, layout.browser);
    assert.equal(options.headless, false);
    await launch?.(directory);
    return browser;
  } };
  const open = async () => {
    const gateway = await openBrowserGateway({ config: sandbox.config, store, chromium, clock, fetchStorageHelper, fetchPassportQr, fetchLoginAsset });
    sandbox.onCleanup(() => gateway.close());
    return gateway;
  };
  const gateway = defer ? undefined : await open();
  return { sandbox, layout, browser, gateway, store, open };
}

test('only the normal read routes accept typed params and an authorized epoch', async t => {
  const { browser, gateway } = await fixture(t);
  await assert.rejects(gateway.request(collection, { method: 'POST', form: { cursor: '0' }, authEpoch: 0 }), { code: 'PROBE_AUTH_REQUIRED' });
  const identity = await gateway.verifyIdentity();
  const read = { authEpoch: identity.authEpoch };
  for (const [route, options] of [
    ['https://www.douyin.com' + detail, read],
    ['/aweme/v1/web/commit/favorite/', { ...read, method: 'POST' }],
    [collection, read],
    [detail, { ...read, params: { aweme_id: ['123'] } }],
    [detail, { ...read, params: { aweme_id: '123', msToken: 'opaque' } }],
    [detail, { ...read, body: 'opaque' }]
  ]) await assert.rejects(gateway.request(route, options), { code: 'PROBE_BROWSER_ROUTE' });
  assert.equal(browser.reads.length, 1);
  const response = await gateway.request(collection, { ...read, method: 'POST', form: { cursor: '0', count: 30 } });
  assert.deepEqual(response, { status: 200, text: sourceText, retryAfter: 23 });
  const [, sent] = browser.reads;
  assert.equal(sent.target.origin, 'https://www.douyin.com');
  assert.equal(sent.options.method, 'POST');
  assert.equal(sent.options.body, 'cursor=0&count=30');
  assert.equal(sent.options.redirect, 'error');
  assert.equal(sent.target.searchParams.get('update_version_code'), '170400');
  await gateway.request('/aweme/v1/web/aweme/post/', {
    ...read, params: { sec_user_id: 'fixture', max_cursor: '9223372036854775807', count: 30, locate_query: false, publish_video_strategy_type: 2 }
  });
  assert.equal(browser.reads[2].target.searchParams.get('locate_query'), 'false');
  assert.equal(browser.reads[2].target.searchParams.get('max_cursor'), '9223372036854775807');
});

test('self endpoint binds the exact UID even if source author has another UID', async t => {
  const { browser, gateway } = await fixture(t);
  const identity = await gateway.verifyIdentity();
  assert.deepEqual(identity, { uid: ownId, nickname: 'fixture-account', authEpoch: 1 });
  const response = await gateway.request(detail, { authEpoch: identity.authEpoch, params: { aweme_id: '8999555333221111111' } });
  assert.match(response.text, new RegExp(authorId));
  assert.equal(browser.reads[0].target.pathname, '/aweme/v1/web/user/profile/self/');
  assert.notEqual(browser.reads[0].page, browser.reads[1].page);
  assert.ok(browser.reads[1].clock - browser.reads[0].clock >= 1100);
  assert.doesNotThrow(() => gateway.assertAuthEpoch(identity.authEpoch));
});

test('opening login fences a pending read and refuses to rebind the library to another account', async t => {
  const { browser, gateway, store } = await fixture(t);
  const identity = await gateway.verifyIdentity();
  const page = parseSourcePage(sourceFixture('media'));
  const command = {
    ...store.createReadJob({ source: page.source, authEpoch: identity.authEpoch }),
    operationId: 'browser-fixture-page', page
  };
  const { id: jobId, epoch, authEpoch, operationId } = command;
  let send;
  browser.reply = () => new Promise(resolve => { send = resolve; });
  const sent = once(browser, 'browser-fetch');
  const read = gateway.request(collection, { authEpoch, method: 'POST', form: { cursor: '0' } });
  const rejected = assert.rejects(read, { code: 'STALE_AUTH_EPOCH' });
  await sent;
  const view = await gateway.openLogin();
  assert.throws(() => store.commitPage({ jobId, epoch, authEpoch, operationId, page }, ({ authEpoch: captured }) => {
    gateway.assertAuthEpoch(captured);
  }), { code: 'STALE_AUTH_EPOCH' });
  assert.equal(store.operation(operationId), null);
  send(new Response(sourceText));
  await rejected;
  browser.uid = authorId;
  browser.session = 'replacement-fixture-session';
  await assert.rejects(gateway.verifyIdentity(), { code: 'PROBE_ACCOUNT_MISMATCH' });
  await assert.rejects(gateway.request(detail, { authEpoch, params: { aweme_id: '1' } }), { code: 'STALE_AUTH_EPOCH' });
  assert.equal((await gateway.frame(view)).pageRevision, view.pageRevision);
  browser.uid = ownId;
  const restored = await gateway.verifyIdentity();
  assert.ok(restored.authEpoch > authEpoch);
  assert.equal(restored.uid, ownId);
});

test('a rotating session stops a pending detail response before it can reach a writer', async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  browser.reply = () => {
    browser.session = 'rotated-session';
    return new Response(sourceText);
  };
  await assert.rejects(gateway.request(detail, { authEpoch, params: { aweme_id: '1' } }), { code: 'STALE_AUTH_EPOCH' });
  assert.throws(() => gateway.assertAuthEpoch(authEpoch), { code: 'STALE_AUTH_EPOCH' });
});

test('only the current owned login page accepts frames and human input', async t => {
  const { browser, gateway } = await fixture(t);
  await assert.rejects(gateway.frame({ pageRevision: 1 }), { code: 'STALE_BROWSER_VIEW' });
  const view = await gateway.openLogin();
  const login = browser.sourcePages()[0];
  const frame = await gateway.frame(view);
  assert.deepEqual(frame, { ...view, mime: 'image/png', bytes: Buffer.from('fixture frame') });
  assert.equal(view.width, panelRect.width);
  assert.equal(view.height, panelRect.height);
  assert.deepEqual(browser.lastShot.clip, panelRect);
  await gateway.input({ ...view, type: 'click', x: 12, y: 34 });
  await gateway.input({ ...view, type: 'text', text: '确认' });
  await gateway.input({ ...view, type: 'key', key: 'Enter' });
  await assert.rejects(gateway.input({ ...view, type: 'key', key: 'Control+L' }), { code: 'INVALID_BROWSER_INPUT' });
  await assert.rejects(gateway.input({ ...view, type: 'click', x: -1, y: 0 }), { code: 'INVALID_BROWSER_INPUT' });
  await assert.rejects(gateway.input({ ...view, type: 'click', x: 600, y: 30 }), { code: 'INVALID_BROWSER_INPUT' });
  browser.allowTarget = false;
  await assert.rejects(gateway.input({ ...view, type: 'text', text: 'other field' }), { code: 'INVALID_BROWSER_INPUT' });
  await assert.rejects(gateway.input({ ...view, type: 'click', x: 1, y: 1 }), { code: 'INVALID_BROWSER_INPUT' });
  browser.allowTarget = true;
  login.navigate(self + '?login=finished');
  await assert.rejects(gateway.input({ ...view, type: 'click', x: 1, y: 2 }), { code: 'STALE_BROWSER_VIEW' });
  assert.deepEqual(browser.input.map(({ page, type, args }) => [page === login, type, ...args]), [
    [true, 'click', 232, 214], [true, 'text', '确认'], [true, 'key', 'Enter']
  ]);
  const current = await gateway.openLogin();
  browser.screenshot = async () => {
    login.navigate('https://outside.invalid/');
    return Buffer.from('foreign frame');
  };
  await assert.rejects(gateway.frame(current), { code: 'STALE_BROWSER_VIEW' });
  assert.ok(browser.navigations.every(({ url }) => url === self));
});

test('retiring the only managed login cannot close headed Chromium', async t => {
  for (const hasStartupPage of [true, false]) {
    await t.test(hasStartupPage ? 'driver supplies a blank page' : 'driver supplies no pages', async t => {
      const { browser, open } = await fixture(t, { defer: true });
      browser.closesOnLastPage = true;
      const initial = hasStartupPage ? await browser.newPage() : undefined;
      const gateway = await open();
      const blank = initial ?? browser.pages()[0];

      const view = await gateway.openLogin();
      const login = browser.navigations.at(-1).page;
      const retired = once(login, 'close');
      login.childNavigate('data:text/plain,disallowed-fixture');
      await retired;
      await assert.rejects(gateway.frame(view), { code: 'STALE_BROWSER_VIEW' });
      assert.deepEqual(browser.pages(), [blank]);
      assert.equal(blank.url(), 'about:blank');
      assert.equal(await browser.visit(blank.mainFrame(), self, 'document'), false);

      const next = await gateway.openLogin();
      assert.notEqual(next.pageRevision, view.pageRevision);
      assert.notEqual(browser.navigations.at(-1).page, login);
      assert.equal((await gateway.frame(next)).pageRevision, next.pageRevision);
    });
  }
});

test('explicit login waits for a late ordinary button, clicks once, and re-observes after a same-document change', async t => {
  const { browser, gateway } = await fixture(t);
  loginQrFixture(browser);
  const loadedPanel = browser.panelDocument;
  const entry = fixtureNode('button', { text: '登录' });
  let page, observations = 0, clicks = 0, firstAfterClick = true;
  browser.panelDocument = {
    querySelectorAll(selectors) {
      return selectors === 'button,[role="button"]' && observations >= 2 ? [entry] : [];
    },
    elementsFromPoint: () => []
  };
  entry.click = () => {
    clicks++;
    page.navigate(self + '?ordinary-login');
  };
  browser.beforePanel = (action, current) => {
    page = current;
    if (action === 'probe-open') {
      observations++;
      if (clicks && firstAfterClick) {
        firstAfterClick = false;
        page.navigate(self + '?panel-mounted');
      } else if (clicks) browser.panelDocument = loadedPanel;
    }
  };
  const view = await gateway.openLogin({ assertQrRequest() {} });
  assert.equal(view.width, panelRect.width);
  assert.equal(gateway.reportStage().loginEntry, 'clicked');
  assert.equal(gateway.reportStage().panelDetected, true);
  assert.equal(clicks, 1);
  assert.ok(observations >= 4);
  assert.deepEqual(await gateway.loginQr(view), { pageRevision: view.pageRevision, bytes: qrPng });
  assert.equal(clicks, 1);
});

test('readiness reports a missing ordinary entry after a bounded read-only wait', async t => {
  const { browser, gateway } = await fixture(t);
  browser.panel = null;
  browser.entryVisible = false;
  const actions = [];
  browser.beforePanel = action => { actions.push(action); };
  const view = await gateway.openLogin();
  assert.equal(view.width, 0);
  assert.equal(gateway.reportStage().loginEntry, 'not-present');
  assert.ok(actions.length > 1 && actions.length < 30);
  assert.ok(actions.every(action => action === 'probe-open'));
});

test('an expired lease during the readiness wait cannot click a late login entry', async t => {
  const { browser, gateway } = await fixture(t);
  browser.panel = null;
  browser.entryVisible = false;
  const actions = [];
  let live = true;
  browser.beforePanel = action => { actions.push(action); };
  browser.clock.onPaceWait = () => {
    live = false;
    browser.entryVisible = true;
  };
  await assert.rejects(gateway.openLogin({ guard() {
    if (!live) throw new ProbeError('STALE_LEASE');
  } }), { code: 'STALE_LEASE' });
  assert.ok(actions.length > 0);
  assert.ok(actions.every(action => action === 'probe-open'));
});

test('an explicit second opening retries a missing panel on the same trusted login page', async t => {
  const { browser, gateway } = await fixture(t);
  browser.panel = null;
  let attempts = 0;
  browser.beforePanel = action => {
    if (action === 'open' && ++attempts === 2) browser.panel = { id: 1, ...panelRect };
  };
  const first = await gateway.openLogin();
  assert.equal(first.width, 0);
  await assert.rejects(gateway.loginQr(first), { code: 'PROBE_QR_UNAVAILABLE' });
  assert.equal(gateway.reportStage().qr, 'unavailable');
  assert.equal(gateway.reportStage().panelDetected, false);
  assert.equal(attempts, 1);
  const second = await gateway.openLogin();
  assert.equal(second.width, panelRect.width);
  assert.equal(browser.navigations.length, 1);
  assert.equal(attempts, 2);
});

test('a canceled queued opening and a lost lease before dispatch cannot retry the login click', async t => {
  const { browser, gateway } = await fixture(t);
  browser.panel = null;
  const clickStarted = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let clicks = 0;
  browser.beforePanel = async action => {
    if (action !== 'open') return;
    if (++clicks === 1) {
      clickStarted.resolve();
      await finish.promise;
    }
  };
  const first = gateway.openLogin();
  await clickStarted.promise;
  const request = new AbortController();
  const canceled = assert.rejects(gateway.openLogin({ signal: request.signal }), { code: 'STALE_LEASE' });
  request.abort(new ProbeError('STALE_LEASE'));
  finish.resolve();
  await first;
  await canceled;
  assert.equal(clicks, 1);

  let checks = 0;
  await assert.rejects(gateway.openLogin({ guard() {
    if (++checks === 2) throw new ProbeError('STALE_LEASE');
  } }), { code: 'STALE_LEASE' });
  assert.equal(checks, 2);
  assert.equal(clicks, 1);
  assert.equal(browser.sourcePages()[0].isClosed(), false);
});

test('ordinary profile with no recognized auth panel produces no pixels or input', async t => {
  const { browser, gateway } = await fixture(t);
  browser.panel = null;
  const view = await gateway.openLogin();
  assert.equal(view.width, 0);
  await assert.rejects(gateway.frame(view), { code: 'PROBE_VERIFICATION_PANEL_REQUIRED' });
  await assert.rejects(gateway.input({ ...view, type: 'click', x: 1, y: 1 }), { code: 'PROBE_VERIFICATION_PANEL_REQUIRED' });
  assert.equal(browser.lastShot, undefined);
  assert.equal(browser.input.length, 0);
});

function loginQrFixture(browser, {
  challenge = false, ambiguous = false, tag = 'canvas', tainted = false, overlay = false,
  qrUrl = tainted ? 'https://p3.douyinpic.com/qr/test.png' : 'https://www.douyin.com/qr/test.png'
} = {}) {
  const qr = fixtureNode(tag, { attrs: { 'aria-label': '登录二维码' }, rect: qrRect });
  Object.assign(qr, {
    width: 120, height: 120, naturalWidth: 120, naturalHeight: 120, complete: true,
    currentSrc: tag === 'img' ? qrUrl : undefined,
    toDataURL(type) {
      assert.equal(type, 'image/png');
      browser.onQrEncode?.();
      return 'data:image/png;base64,' + qrPng.toString('base64');
    }
  });
  const headings = [fixtureNode('h2', { text: '扫码登录' })];
  if (challenge) headings.push(fixtureNode('h2', { text: '安全验证' }));
  const panel = fixtureNode('section', {
    attrs: { role: 'dialog' }, rect: panelRect,
    children: [...headings, qr, ...(ambiguous ? [fixtureNode('canvas', { rect: qrRect })] : [])]
  });
  const notice = fixtureNode('div', {
    text: '与登录无关的通知', rect: { x: 280, y: 305, width: 20, height: 15 }
  });
  const body = fixtureNode('body', { children: [panel, ...(overlay ? [notice] : [])] });
  browser.panelDocument = {
    body, querySelectorAll: selectors => body.querySelectorAll(selectors),
    // The notice is drawn above the QR but has pointer-events: none.
    elementsFromPoint: () => [panel, body], elementFromPoint: () => qr,
    createElement(tagName) {
      assert.equal(tagName, 'canvas');
      let drawn;
      return {
        getContext(type) {
          assert.equal(type, '2d');
          return { drawImage(node, x, y) {
            assert.equal(x, 0);
            assert.equal(y, 0);
            drawn = node;
          } };
        },
        toDataURL(type) {
          assert.equal(drawn, qr);
          assert.equal(this.width, 120);
          assert.equal(this.height, 120);
          if (tainted) throw Object.assign(new Error('fixture canvas tainted'), { name: 'SecurityError' });
          return qr.toDataURL(type);
        }
      };
    }
  };
  browser.screenshot = () => overlay ? qrWithNoticePng : qrPng;
  return qr;
}

test('a current official login QR produces its isolated canvas bitmap without an overlapping notice', async t => {
  const { browser, gateway } = await fixture(t);
  const qr = loginQrFixture(browser, { overlay: true });
  const view = await gateway.openLogin();
  assert.deepEqual(await gateway.loginQr(view), { pageRevision: view.pageRevision, bytes: qrPng });
  assert.equal(browser.lastShot, undefined);
  await assert.rejects(gateway.loginQr({ pageRevision: view.pageRevision - 1 }), { code: 'STALE_BROWSER_VIEW' });
  qr.toDataURL = () => 'data:image/png;base64,ZmFrZQ==';
  await assert.rejects(gateway.loginQr(view), { code: 'PROBE_QR_UNAVAILABLE' });
});

test('an origin-clean IMG can produce its own PNG while tainted images and SVG are withheld', async t => {
  const { browser, gateway } = await fixture(t);
  loginQrFixture(browser, { tag: 'img', overlay: true });
  const view = await gateway.openLogin();
  assert.deepEqual(await gateway.loginQr(view), { pageRevision: view.pageRevision, bytes: qrPng });
  assert.equal(browser.lastShot, undefined);
  for (const options of [
    { tag: 'img', tainted: true },
    { tag: 'img', qrUrl: 'data:image/svg+xml,<svg/>' },
    { tag: 'svg' }
  ]) {
    loginQrFixture(browser, options);
    const unsafe = await gateway.openLogin();
    await assert.rejects(gateway.loginQr(unsafe), { code: 'PROBE_QR_UNAVAILABLE' });
    assert.equal(browser.lastShot, undefined);
  }
});

test('challenge, ambiguous crop, and changed official page withhold QR pixels', async t => {
  const { browser, gateway } = await fixture(t);
  for (const options of [{ challenge: true }, { ambiguous: true }]) {
    loginQrFixture(browser, options);
    const view = await gateway.openLogin();
    await assert.rejects(gateway.loginQr(view), { code: 'PROBE_QR_UNAVAILABLE' });
    assert.equal(browser.lastShot, undefined);
  }
  loginQrFixture(browser);
  const view = await gateway.openLogin();
  const login = browser.sourcePages()[0];
  browser.onQrEncode = () => {
    login.navigate('https://outside.invalid/');
  };
  await assert.rejects(gateway.loginQr(view), { code: 'STALE_BROWSER_VIEW' });
});

test('auth panel DOM hit testing rejects ordinary controls and focus outside the panel', async t => {
  const { browser, gateway } = await fixture(t);
  const code = fixtureNode('input', { attrs: { placeholder: '请输入验证码', autocomplete: 'one-time-code' } });
  const ordinary = fixtureNode('button', { text: '打开设置' });
  const overlay = fixtureNode('input', { attrs: { placeholder: '请输入验证码' } });
  const panel = fixtureNode('section', {
    attrs: { role: 'dialog' }, rect: panelRect,
    children: [fixtureNode('h2', { text: '身份验证' }), code, ordinary]
  });
  const body = fixtureNode('body', { rect: { x: 0, y: 0, width: 1000, height: 760 }, children: [panel, overlay] });
  let hit = code;
  browser.panelDocument = {
    body, querySelectorAll: selectors => body.querySelectorAll(selectors), activeElement: overlay,
    elementsFromPoint: () => [panel, body], elementFromPoint: () => hit
  };
  const view = await gateway.openLogin();
  const frame = await gateway.frame(view);
  assert.equal(frame.width, panelRect.width);
  await gateway.input({ ...view, type: 'click', x: 20, y: 50 });
  for (const forbidden of [ordinary, overlay]) {
    hit = forbidden;
    await assert.rejects(gateway.input({ ...view, type: 'click', x: 20, y: 50 }), { code: 'INVALID_BROWSER_INPUT' });
  }
  await assert.rejects(gateway.input({ ...view, type: 'text', text: 'outside' }), { code: 'INVALID_BROWSER_INPUT' });
  browser.panelDocument.activeElement = code;
  await gateway.input({ ...view, type: 'text', text: 'fixture' });
  assert.deepEqual(browser.input.map(action => action.type), ['click', 'text']);
});

test('panel redraw or movement retires an older frame revision', async t => {
  const { browser, gateway } = await fixture(t);
  const view = await gateway.openLogin();
  browser.panel = { id: 2, ...panelRect };
  await assert.rejects(gateway.input({ ...view, type: 'click', x: 1, y: 1 }), { code: 'STALE_BROWSER_VIEW' });
  assert.equal(browser.input.length, 0);
  const updated = await gateway.openLogin();
  browser.screenshot = () => { browser.panel = { id: 2, ...panelRect, x: panelRect.x + 10 }; return Buffer.from('stale pixels'); };
  await assert.rejects(gateway.frame(updated), { code: 'STALE_BROWSER_VIEW' });
});

test('timed-out pointer dispatch retires its page before replacement input', async t => {
  const { browser, gateway } = await fixture(t);
  const view = await gateway.openLogin();
  const old = browser.sourcePages()[0];
  let releaseClick;
  let releaseClose;
  browser.beforeInput = () => new Promise(resolve => { releaseClick = resolve; });
  browser.beforePageClose = () => new Promise(resolve => {
    releaseClose = resolve;
    browser.emit('closing-login');
  });
  const closing = once(browser, 'closing-login');
  const timedOut = assert.rejects(gateway.input({ ...view, type: 'click', x: 2, y: 3 }), { code: 'PROBE_BROWSER_TIMEOUT' });
  await closing;
  const reopening = gateway.openLogin();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(browser.sourcePages(), [old]);
  browser.beforePageClose = undefined;
  releaseClose();
  await timedOut;
  assert.equal(old.isClosed(), true);
  await assert.rejects(gateway.input({ ...view, type: 'click', x: 2, y: 3 }), { code: 'STALE_BROWSER_VIEW' });
  browser.beforeInput = undefined;
  const replacement = await reopening;
  assert.notEqual(replacement.pageRevision, view.pageRevision);
  assert.notEqual(browser.sourcePages()[0], old);
  await gateway.input({ ...replacement, type: 'click', x: 2, y: 3 });
  releaseClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(browser.input.map(action => action.page), [browser.sourcePages()[0]]);
});

test('timed-out login-opening action retires its page before creating a new view', async t => {
  const { browser, gateway } = await fixture(t);
  browser.panel = null;
  let releaseOpen;
  let old;
  browser.beforePanel = (action, page) => {
    if (action !== 'open') return;
    old = page;
    return new Promise(resolve => { releaseOpen = resolve; });
  };
  await assert.rejects(gateway.openLogin(), { code: 'PROBE_BROWSER_TIMEOUT' });
  assert.equal(old.isClosed(), true);
  browser.beforePanel = undefined;
  browser.panel = { id: 1, ...panelRect };
  const replacement = await gateway.openLogin();
  releaseOpen();
  assert.notEqual(browser.sourcePages()[0], old);
  assert.equal((await gateway.frame(replacement)).width, panelRect.width);
});

test('if retirement cannot be confirmed the login view remains locked until restart', async t => {
  const { browser, gateway, open } = await fixture(t);
  const view = await gateway.openLogin();
  const old = browser.sourcePages()[0];
  browser.beforeInput = () => { throw new Error('fixture error after dispatch'); };
  browser.beforePageClose = () => { throw new Error('fixture close failed'); };
  await assert.rejects(gateway.input({ ...view, type: 'text', text: 'test' }), { code: 'PROBE_BROWSER_RESTART_REQUIRED' });
  browser.beforeInput = undefined;
  browser.beforePageClose = undefined;
  await old.close();
  await assert.rejects(gateway.openLogin(), { code: 'PROBE_BROWSER_RESTART_REQUIRED' });
  await assert.rejects(gateway.input({ ...view, type: 'click', x: 2, y: 3 }), { code: 'PROBE_BROWSER_RESTART_REQUIRED' });
  await assert.rejects(gateway.verifyIdentity(), { code: 'PROBE_BROWSER_RESTART_REQUIRED' });
  await gateway.close();
  assert.equal((await (await open()).openLogin()).width, panelRect.width);
});

test('a read-only panel inspection failure leaves the same view usable', async t => {
  const { browser, gateway } = await fixture(t);
  const view = await gateway.openLogin();
  const page = browser.sourcePages()[0];
  browser.beforePanel = () => { throw new Error('fixture inspect failure'); };
  await assert.rejects(gateway.frame(view), { code: 'PROBE_BROWSER_FRAME' });
  browser.beforePanel = undefined;
  assert.equal(page.isClosed(), false);
  assert.equal((await gateway.frame(view)).pageRevision, view.pageRevision);
});

function helperResponse(url, { status = 200, type = 'text/html; charset=utf-8', location, body = '<!doctype html><script></script>' } = {}) {
  const headers = { 'Content-Type': type };
  if (location) headers.Location = location;
  const response = new Response(body, { status, headers });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

test('only both verified direct login helpers can coexist with a main-document QR', async t => {
  const fetched = [];
  const { browser, gateway } = await fixture(t, { fetchStorageHelper: async (url, options) => {
    fetched.push(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    return helperResponse(url);
  } });
  loginQrFixture(browser);
  const view = await gateway.openLogin();
  const page = browser.sourcePages()[0];
  for (const version of ['4.0.5', '4.0.7']) {
    const child = page.childNavigate('about:blank');
    const url = storageHelper(version);
    assert.equal(await browser.visit(child, url, 'document'), true);
    child.navigate(url);
    assert.equal(await browser.visit(child, url, 'xhr'), false);
    assert.equal(await browser.visit(child, 'https://static.douyinstatic.com/helper.js', 'script'), false);
  }
  assert.equal(await browser.visit(page.mainFrame(), storageHelper('4.0.5'), 'document'), false);
  assert.deepEqual(fetched, [storageHelper('4.0.5'), storageHelper('4.0.7')]);
  assert.equal(browser.fulfillments.length, 2);
  assert.equal((await gateway.openLogin()).pageRevision, view.pageRevision);
  assert.deepEqual(await gateway.loginQr(view), { pageRevision: view.pageRevision, bytes: qrPng });
  await assert.rejects(gateway.frame(view), { code: 'STALE_BROWSER_VIEW' });
  await assert.rejects(gateway.input({ ...view, type: 'move', x: 1, y: 1 }), { code: 'STALE_BROWSER_VIEW' });
  assert.equal(browser.lastShot, undefined);
  assert.equal(browser.input.length, 0);
});

test('opening waits passively for a current direct storage helper before observing the QR panel', async t => {
  for (const trigger of ['probe-open', 'open']) {
    await t.test(trigger, async t => {
      const url = storageHelper('4.0.7');
      const started = Promise.withResolvers();
      const response = Promise.withResolvers();
      const { browser, gateway } = await fixture(t, { fetchStorageHelper: () => {
        started.resolve();
        return response.promise;
      } });
      loginQrFixture(browser);
      const completedPanel = browser.panelDocument;
      browser.panelDocument = undefined;
      browser.panel = null;
      browser.entryVisible = trigger === 'open';
      let pending = false, delivered = false, visit, pauses = 0, clicks = 0;
      browser.beforePanel = async (action, page) => {
        assert.equal(pending, false, 'driver inspection while the helper is pending');
        if (action === 'open') clicks++;
        if (visit || action !== trigger) return;
        const child = page.childNavigate('about:blank');
        const committedUrl = child.url;
        child.url = () => trigger === 'open' ? url : '';
        pending = true;
        visit = browser.visit(child, url, 'document').then(result => {
          delivered = result;
          return result;
        });
        await started.promise;
        browser.clock.onPaceWait = () => {
          pauses++;
          if (pauses === 1) {
            response.resolve(helperResponse(url));
            return;
          }
          if (!delivered) return;
          browser.clock.onPaceWait = undefined;
          child.url = committedUrl;
          child.navigate(url);
          pending = false;
          browser.panelDocument = completedPanel;
        };
      };
      const view = await gateway.openLogin({ assertQrRequest() {} });
      assert.equal(view.width, panelRect.width);
      assert.equal(await visit, true);
      assert.ok(pauses >= 2);
      assert.equal(clicks, trigger === 'open' ? 1 : 0);
      assert.equal(gateway.reportStage().loginEntry, trigger === 'open' ? 'clicked' : 'panel-present');
      assert.deepEqual(await gateway.loginQr(view), { pageRevision: view.pageRevision, bytes: qrPng });
      await assert.rejects(gateway.frame(view), { code: 'STALE_BROWSER_VIEW' });
    });
  }
});

test('a pending helper does not extend readiness beyond current frame, lease or timeout', async t => {
  for (const stop of ['unmarked sibling', 'nested', 'lost lease', 'canceled', 'timeout']) {
    await t.test(stop, async t => {
      const started = Promise.withResolvers();
      const { browser, gateway } = await fixture(t, { fetchStorageHelper: () => {
        started.resolve();
        return new Promise(() => {});
      } });
      browser.panel = null;
      browser.entryVisible = false;
      let live = true, inspections = 0;
      const request = new AbortController();
      browser.beforePanel = async (action, page) => {
        assert.equal(action, 'probe-open');
        assert.equal(++inspections, 1);
        const child = page.childNavigate('about:blank');
        child.url = () => '';
        void browser.visit(child, storageHelper('4.0.7'), 'document');
        await started.promise;
        if (stop === 'unmarked sibling') page.childNavigate('about:blank').url = () => '';
        if (stop === 'nested') page.childNavigate('about:blank', child);
        if (stop === 'lost lease') browser.clock.onPaceWait = () => { live = false; };
        if (stop === 'canceled') browser.clock.onPaceWait = () => request.abort(new ProbeError('STALE_LEASE'));
      };
      const code = stop === 'timeout' ? 'PROBE_BROWSER_TIMEOUT' :
        ['lost lease', 'canceled'].includes(stop) ? 'STALE_LEASE' : 'STALE_BROWSER_VIEW';
      await assert.rejects(gateway.openLogin({
        signal: request.signal,
        guard() { if (!live) throw new ProbeError('STALE_LEASE'); },
        assertQrRequest() {}
      }), { code });
      assert.equal(inspections, 1);
    });
  }
});

test('login diagnostics report only bounded public stages and blocked operation summaries', async t => {
  const url = storageHelper('4.0.7');
  const gate = Promise.withResolvers();
  const { browser, gateway } = await fixture(t, { fetchStorageHelper: () => gate.promise });
  assert.equal(gateway.reportStage().main, 'not-open');
  assert.equal(gateway.reportStage().qr, 'not-requested');
  loginQrFixture(browser);
  const view = await gateway.openLogin();
  const page = browser.sourcePages()[0];
  const child = page.childNavigate('about:blank');
  assert.equal(gateway.reportStage().frames, 'blank-child');
  const pending = browser.visit(child, url, 'document');
  assert.deepEqual(gateway.reportStage().helper, { state: 'requested', version: '4.0.7' });
  gate.resolve(helperResponse(url));
  assert.equal(await pending, true);
  child.navigate(url);
  assert.equal(gateway.reportStage().frames, 'helper-child');
  assert.deepEqual(gateway.reportStage().helper, { state: 'completed', version: '4.0.7' });
  await gateway.loginQr(view);
  assert.equal(gateway.reportStage().qr, 'available');

  const main = page.mainFrame();
  assert.equal(await browser.visit(main, 'https://www.douyin.com/passport/web/get_qrcode/?token=never-export', 'xhr'), false);
  assert.equal(await browser.visit(main, 'https://www.douyin.com/passport/web/check_qrconnect/', 'fetch', 'POST'), false);
  assert.equal(await browser.visit(main, 'https://www.douyin.com/passport/web/possible_username/', 'xhr'), false);
  assert.equal(await browser.visit(main, 'https://login.douyin.com/passport/web/challenge/', 'xhr', 'POST'), false);
  const next = page.childNavigate('about:blank');
  assert.equal(await browser.visit(next, url + '?token=never-export', 'document'), false);
  assert.deepEqual(gateway.reportStage().helper, { state: 'refused', version: '4.0.7' });
  assert.equal(await browser.visit(next, storageHelper('4.0.8') + '?token=never-export', 'document'), false);
  const stage = gateway.reportStage();
  assert.deepEqual(stage, {
    main: 'trusted', frames: 'helper-child', panelDetected: true, qr: 'available', qrRequest: 'refused', qrRefusalReason: 'no-authority', loginEntry: 'panel-present',
    helper: { state: 'new-version', version: '4.0.8' },
    loginResources: { loaded: 0, refused: 0 },
    blockedPassport: { GET: 2, POST: 1, routes: [
      { method: 'GET', name: 'get_qrcode' },
      { method: 'POST', name: 'check_qrconnect' }
    ] }
  });
  assert.doesNotMatch(JSON.stringify(stage), /never-export|possible_username|https|89504e47|private-fixture-session/);
  for (let n = 0; n < 1000; n++) {
    assert.equal(await browser.visit(main, 'https://www.douyin.com/passport/web/get_qrcode/', 'xhr'), false);
  }
  assert.equal(gateway.reportStage().blockedPassport.GET, 1000);
  assert.deepEqual(gateway.reportStage().blockedPassport.routes, stage.blockedPassport.routes);
  const retired = once(page, 'close');
  page.navigate('https://outside.invalid/');
  await retired;
  assert.equal(gateway.reportStage().main, 'retired');
  await gateway.openLogin();
  assert.equal(gateway.reportStage().qr, 'not-requested');
  assert.deepEqual(gateway.reportStage().helper, { state: 'not-requested' });
  assert.deepEqual(gateway.reportStage().blockedPassport, { GET: 0, POST: 0, routes: [] });
});

test('storage helpers reject unverified URLs, uncontrolled frames and non-login requests', async t => {
  const { browser, gateway } = await fixture(t);
  await gateway.openLogin();
  const page = browser.sourcePages()[0];
  const child = page.childNavigate('about:blank');
  const url = storageHelper('4.0.7');
  for (const invalid of [
    storageHelper('4.0.6'), url + '?version=1', url + '#target', url.replace('https:', 'http:'),
    url.replace('lf-zt.douyin.com', 'lf-zt.douyin.com.outside.invalid'),
    url.replace('lf-zt.douyin.com', 'user:pass@lf-zt.douyin.com'),
    url.replace('lf-zt.douyin.com', 'lf-zt.douyin.com:443'),
    url.replace('@byted', 'unrelated'), url.replace('index.html', 'extra/index.html')
  ]) assert.equal(await browser.visit(child, invalid, 'document'), false);

  const blank = browser.pages().find(tab => tab.url() === 'about:blank');
  assert.equal(await browser.visit(blank.childNavigate('about:blank'), url, 'document'), false);
  assert.equal(await browser.visit(child, url, 'document', 'POST'), false);
  assert.equal(await browser.visit(child, url, 'document', 'GET', true, {}), false);
  await gateway.verifyIdentity();
  const reader = browser.sourcePages()[0];
  assert.notEqual(reader, page);
  assert.equal(await browser.visit(reader.childNavigate('about:blank'), url, 'document'), false);

  const next = await gateway.openLogin();
  const active = browser.sourcePages().at(-1);
  const parent = active.childNavigate('about:blank');
  const nested = { page: () => active, parentFrame: () => parent, url: () => 'about:blank' };
  assert.equal(await browser.visit(nested, url, 'document'), false);
  const retired = once(active, 'close');
  active.childNavigate('about:blank', parent);
  await retired;
  await assert.rejects(gateway.loginQr(next), { code: 'STALE_BROWSER_VIEW' });
  assert.equal(browser.fulfillments.length, 0);
});

test('helper redirects, wrong responses and unfulfilled committed frames fail closed', async t => {
  const url = storageHelper('4.0.7');
  let reply;
  const { browser, gateway } = await fixture(t, { fetchStorageHelper: async () => reply() });
  await gateway.openLogin();
  const page = browser.sourcePages()[0];
  const child = page.childNavigate('about:blank');
  for (const response of [
    () => helperResponse(url, { status: 302, location: 'https://outside.invalid/redirect' }),
    () => helperResponse(url, { type: 'text/javascript' }),
    () => helperResponse(url, { location: 'https://outside.invalid/redirect' }),
    () => helperResponse(url, { body: 'x'.repeat(64 * 1024 + 1) }),
    () => helperResponse('https://outside.invalid/redirect'),
    () => helperResponse(url, { status: 500 }),
    () => { throw new Error('private redirect fixture'); }
  ]) {
    reply = response;
    assert.equal(await browser.visit(child, url, 'document'), false);
  }
  assert.equal(browser.fulfillments.length, 0);
  const retired = once(page, 'close');
  child.navigate(url);
  await retired;
});

test('pending storage helpers cannot fulfill after the direct frame or trusted document is lost', async t => {
  for (const change of ['detach', 'fresh blank in the same frame', 'replace main document', 'close login']) {
    await t.test(change, async t => {
      const response = Promise.withResolvers();
      const started = Promise.withResolvers();
      const url = storageHelper('4.0.5');
      const { browser, gateway } = await fixture(t, {
        fetchStorageHelper: async () => { started.resolve(); return response.promise; }
      });
      await gateway.openLogin();
      const page = browser.sourcePages()[0];
      const child = page.childNavigate('about:blank');
      const visit = browser.visit(child, url, 'document');
      await started.promise;
      if (change === 'detach') page.detachChild(child);
      else if (change === 'fresh blank in the same frame') child.navigate('about:blank');
      else if (change === 'replace main document') page.navigate(self + '?refresh');
      else await page.close();
      response.resolve(helperResponse(url));
      assert.equal(await visit, false);
      assert.equal(browser.fulfillments.length, 0);
    });
  }
});

test('a provided helper cannot commit after the main page changes its navigation revision', async t => {
  const provided = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const url = storageHelper('4.0.7');
  const { browser, gateway } = await fixture(t, { fetchStorageHelper: async () => helperResponse(url) });
  browser.beforeFulfill = () => { provided.resolve(); return finish.promise; };
  const view = await gateway.openLogin();
  const page = browser.sourcePages()[0];
  const child = page.childNavigate('about:blank');
  const visit = browser.visit(child, url, 'document');
  await provided.promise;

  page.navigate(self + '?same-document');
  child.navigate(url);
  finish.resolve();
  await visit;
  assert.equal(page.isClosed(), true);
  await assert.rejects(gateway.loginQr(view), { code: 'STALE_BROWSER_VIEW' });
});

test('a newer request in a direct child supersedes a pending helper response', async t => {
  const previous = Promise.withResolvers();
  const started = Promise.withResolvers();
  const oldUrl = storageHelper('4.0.5');
  const newUrl = storageHelper('4.0.7');
  const { browser, gateway } = await fixture(t, { fetchStorageHelper: async url => {
    if (url === oldUrl) { started.resolve(); return previous.promise; }
    return helperResponse(url);
  } });
  loginQrFixture(browser);
  const view = await gateway.openLogin();
  const child = browser.sourcePages()[0].childNavigate('about:blank');
  const oldVisit = browser.visit(child, oldUrl, 'document');
  await started.promise;
  assert.equal(await browser.visit(child, newUrl, 'document'), true);
  child.navigate(newUrl);
  previous.resolve(helperResponse(oldUrl));
  assert.equal(await oldVisit, false);
  assert.equal(browser.fulfillments.length, 1);
  assert.deepEqual(await gateway.loginQr(view), { pageRevision: view.pageRevision, bytes: qrPng });

  const retired = once(browser.sourcePages()[0], 'close');
  child.navigate('about:blank');
  child.navigate(newUrl);
  await retired;
  await assert.rejects(gateway.loginQr(view), { code: 'STALE_BROWSER_VIEW' });
});

test('foreign child document requests and a committed redirected frame cannot be exposed', async t => {
  const { browser, gateway } = await fixture(t);
  const view = await gateway.openLogin();
  const page = browser.sourcePages()[0];
  const child = { page: () => page, url: () => 'about:blank' };
  assert.equal(await browser.visit(child, 'https://outside.invalid/verify', 'document'), false);
  assert.equal(await browser.visit(child, 'https://www.douyin.com/user/self', 'document'), false);
  browser.screenshot = () => {
    page.childNavigate('https://outside.invalid/redirected');
    return Buffer.from('foreign frame');
  };
  await assert.rejects(gateway.frame(view), { code: 'STALE_BROWSER_VIEW' });
  await assert.rejects(gateway.input({ ...view, type: 'click', x: 1, y: 1 }), { code: 'STALE_BROWSER_VIEW' });
  const refreshed = await gateway.openLogin();
  assert.notEqual(refreshed.pageRevision, view.pageRevision);
  assert.equal(browser.input.length, 0);
});

const qrFixtureCookies = [
  'fixture_one=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Secure',
  'fixture_two=two; Path=/; HttpOnly'
];

function passportResponse(url, {
  status = 200, type = 'application/json; charset=utf-8', location, body = '{"fixture":true}',
  redirected = false
} = {}) {
  const headers = new Headers({
    'content-type': type, 'content-encoding': 'gzip', 'content-length': '99',
    'cache-control': 'no-store', connection: 'x-hop', 'x-hop': 'discard'
  });
  for (const cookie of qrFixtureCookies) headers.append('set-cookie', cookie);
  if (location) headers.set('location', location);
  const response = new Response(body, { status, headers });
  Object.defineProperties(response, { url: { value: url }, redirected: { value: redirected } });
  return response;
}

test('only the current owned main login view forwards the original official QR GET', async t => {
  const calls = [];
  const { browser, gateway } = await fixture(t, { fetchPassportQr: async (url, options) => {
    calls.push({ url, options });
    return passportResponse(url);
  } });
  assert.equal(gateway.reportStage().qrRequest, 'not-requested');
  await gateway.openLogin();
  let page = browser.sourcePages()[0];
  assert.equal(await browser.visit(page.mainFrame(), passportQr, 'xhr'), false);
  assert.equal(gateway.reportStage().qrRequest, 'refused');
  assert.equal(gateway.reportStage().qrRefusalReason, 'no-authority');
  assert.equal(calls.length, 0);

  let checks = 0;
  await gateway.openLogin({ assertQrRequest() { checks++; } });
  page = browser.sourcePages()[0];
  const main = page.mainFrame();
  browser.requestHeaders = {
    accept: 'application/json', cookie: 'browser_fixture=private-marker', referer: self,
    host: 'wrong.invalid', 'content-length': '99', authorization: 'private-authorization'
  };
  for (const [type, url] of [['xhr', passportQr + '/?fixture=never-reported'], ['fetch', passportQr]]) {
    assert.equal(await browser.visit(main, url, type), true);
    assert.equal(gateway.reportStage().qrRequest, 'delivered');
    assert.equal(Object.hasOwn(gateway.reportStage(), 'qrRefusalReason'), false);
    assert.equal(Object.hasOwn(gateway.reportStage(), 'qrUpstreamStatus'), false);
  }
  assert.equal(checks, 6);
  assert.deepEqual(calls.map(({ url, options }) => [url, options.method, options.redirect, options.credentials]), [
    [passportQr + '/?fixture=never-reported', 'GET', 'error', 'omit'],
    [passportQr, 'GET', 'error', 'omit']
  ]);
  for (const { options } of calls) {
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(Object.fromEntries(new Headers(options.headers)),
      { accept: 'application/json', cookie: 'browser_fixture=private-marker', referer: self });
  }
  for (const { status, headers, body } of browser.fulfillments) {
    assert.equal(status, 200);
    assert.equal(headers['set-cookie'], qrFixtureCookies.join('\n'));
    assert.equal(headers['cache-control'], 'no-store');
    for (const name of ['content-encoding', 'content-length', 'connection', 'x-hop']) assert.equal(headers[name], undefined);
    assert.equal(body.toString(), '{"fixture":true}');
  }
  assert.doesNotMatch(JSON.stringify(gateway.reportStage()), /never-reported|https:|private-marker|fixture_one/);

  for (const [frame, url, type, method, nav, redirected] of [
    [main, passportQr, 'xhr', 'POST'],
    [main, passportQr, 'document', 'GET', true],
    [main, passportQr, 'fetch', 'GET', false, {}],
    [main, passportQr.replace('www.douyin.com', 'www.douyin.com.outside.invalid'), 'xhr', 'GET'],
    [main, passportQr.replace('www.douyin.com', 'www.douyin.com:443'), 'xhr', 'GET'],
    [main, passportQr.replace('www.', 'login.'), 'xhr', 'GET'],
    [main, passportQr.replace('get_qrcode', 'challenge'), 'xhr', 'POST'],
    [main, passportQr.replace('get_qrcode', 'check_qrconnect'), 'xhr', 'GET'],
    [page.childNavigate('about:blank'), passportQr, 'xhr', 'GET']
  ]) assert.equal(await browser.visit(frame, url, type, method, nav, redirected), false);
  await gateway.verifyIdentity();
  assert.equal(await browser.visit(browser.sourcePages()[0].mainFrame(), passportQr, 'xhr'), false);
  assert.equal(calls.length, 2);
});

test('provider QR GET rejects redirects, oversized or wrong responses, and lost authority', async t => {
  let nextResponse, calls = 0;
  const { browser, gateway } = await fixture(t, { fetchPassportQr: async () => {
    calls++;
    return nextResponse();
  } });
  let live = true;
  await gateway.openLogin({ assertQrRequest() { if (!live) throw new ProbeError('STALE_LEASE'); } });
  const page = browser.sourcePages()[0];
  const main = page.mainFrame();
  const brokenBody = new ReadableStream({
    pull(reader) { reader.error(new Error('fixture-body-private')); }
  });
  for (const [response, reason, status] of [
    [passportResponse(passportQr, { status: 302, location: 'https://outside.invalid/' }), 'http-status', 302],
    [passportResponse(passportQr, { location: 'https://outside.invalid/' }), 'response-metadata'],
    [passportResponse(passportQr, { type: 'text/html' }), 'response-metadata'],
    [passportResponse('https://outside.invalid/'), 'response-metadata'],
    [passportResponse(passportQr, { redirected: true }), 'response-metadata'],
    [passportResponse(passportQr, { status: 403 }), 'http-status', 403],
    [passportResponse(passportQr, { body: 'x'.repeat(256 * 1024 + 1) }), 'body-oversized'],
    [passportResponse(passportQr, { body: null }), 'body-empty'],
    [passportResponse(passportQr, { body: '' }), 'body-empty'],
    [passportResponse(passportQr, { body: brokenBody }), 'body-read-failed']
  ]) {
    nextResponse = () => response;
    assert.equal(await browser.visit(main, passportQr, 'xhr'), false);
    const stage = gateway.reportStage();
    assert.equal(stage.qrRequest, 'refused');
    assert.equal(stage.qrRefusalReason, reason);
    assert.equal(stage.qrUpstreamStatus, status);
    assert.doesNotMatch(JSON.stringify(stage), /fixture-body-private|outside[.]invalid|https:/);
  }

  const started = Promise.withResolvers();
  const pending = Promise.withResolvers();
  nextResponse = () => { started.resolve(); return pending.promise; };
  const visit = browser.visit(main, passportQr, 'xhr');
  await started.promise;
  assert.equal(gateway.reportStage().qrRequest, 'requested');
  live = false;
  pending.resolve(passportResponse(passportQr));
  assert.equal(await visit, false);
  assert.equal(gateway.reportStage().qrRefusalReason, 'stale-before-delivery');
  assert.equal(await browser.visit(main, passportQr, 'xhr'), false);
  assert.equal(gateway.reportStage().qrRefusalReason, 'lease-guard');
  assert.equal(calls, 11);
  assert.equal(browser.fulfillments.length, 0);
  assert.equal(gateway.reportStage().qrRequest, 'refused');
});

test('provider QR refuses separately at view, header, fetch and fulfill stages without exposing errors', async t => {
  for (const phase of ['view-guard', 'request-headers', 'fetch-failed', 'fulfill-failed']) {
    await t.test(phase, async t => {
      let fetches = 0;
      const { browser, gateway } = await fixture(t, { fetchPassportQr: async url => {
        fetches++;
        if (phase === 'fetch-failed') throw new Error('fixture-private-error');
        return passportResponse(url);
      } });
      await gateway.openLogin({ assertQrRequest() {} });
      const page = browser.sourcePages()[0];
      if (phase === 'view-guard') page.childNavigate('about:blank').url = () => '';
      if (phase === 'request-headers') browser.beforeRequestHeaders = () => { throw new Error('fixture-private-error'); };
      if (phase === 'fulfill-failed') browser.beforeFulfill = () => { throw new Error('fixture-private-error'); };
      assert.equal(await browser.visit(page.mainFrame(), passportQr + '?test=fixture-private-query', 'xhr'), false);
      const stage = gateway.reportStage();
      assert.equal(stage.qrRequest, 'refused');
      assert.equal(stage.qrRefusalReason, phase);
      assert.equal(Object.hasOwn(stage, 'qrUpstreamStatus'), false);
      assert.equal(fetches, ['fetch-failed', 'fulfill-failed'].includes(phase) ? 1 : 0);
      assert.doesNotMatch(JSON.stringify(stage), /fixture-private-|https:|set-cookie/);
    });
  }
});

test('approved same-document login preserves QR authority but a real main reload revokes it', async t => {
  let nextResponse = url => passportResponse(url), calls = 0;
  const { browser, gateway } = await fixture(t, {
    fetchStorageHelper: async url => helperResponse(url),
    fetchPassportQr: async url => { calls++; return nextResponse(url); }
  });
  const assertQrRequest = () => {};
  await gateway.openLogin({ assertQrRequest });
  const page = browser.sourcePages()[0];
  const main = page.mainFrame();
  const helper = page.childNavigate('about:blank');
  const helperUrl = storageHelper('4.0.7');
  assert.equal(await browser.visit(helper, helperUrl, 'document'), true);
  helper.navigate(helperUrl);
  page.navigate(self + '?same-document');
  assert.equal(gateway.reportStage().frames, 'helper-child');
  assert.equal(await browser.visit(main, passportQr, 'xhr'), true);

  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  nextResponse = () => { started.resolve(); return reply.promise; };
  const pending = browser.visit(main, passportQr, 'xhr');
  await started.promise;
  assert.equal(await browser.visit(main, self + '?reload', 'document'), true);
  page.navigate(self + '?reload');
  reply.resolve(passportResponse(passportQr));
  assert.equal(await pending, false);
  assert.equal(await browser.visit(main, passportQr, 'xhr'), false);
  assert.equal(calls, 2);
  assert.equal(browser.fulfillments.length, 2);
});

const loginAsset = 'https://lf-ucenter-web.yhgfb-cn-static.com/static/login-boot.js';

function guestAssetResponse(url, { status = 200, type = 'application/javascript', body = '/* guest fixture */' } = {}) {
  const response = new Response(body, {
    status, headers: { 'content-type': type, 'set-cookie': 'fixture=must-not-reach-browser' }
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

test('leased public static loading is active inside the first owned login goto', async t => {
  const calls = [];
  const { browser, gateway } = await fixture(t, { fetchLoginAsset: async (url, options) => {
    calls.push({ url, options });
    return guestAssetResponse(url, { body: options.method === 'HEAD' ? null : '/* guest fixture */' });
  } });
  const observed = [];
  browser.onGoto = async page => {
    observed.push(await browser.visit(page.mainFrame(), loginAsset, 'script'));
  };
  // An unleased open retains the old deny boundary.
  await gateway.openLogin();
  assert.deepEqual(observed, [false]);
  await browser.sourcePages()[0].close();

  const view = await gateway.openLogin({ assertQrRequest() {} });
  assert.equal(view.width, panelRect.width);
  assert.deepEqual(observed, [false, true]);
  const page = browser.sourcePages()[0];
  const main = page.mainFrame();
  assert.equal(await browser.visit(main, loginAsset, 'script', 'HEAD'), true);
  assert.deepEqual(calls.map(({ url, options }) => [url, options.method, options.credentials, options.redirect]), [
    [loginAsset, 'GET', 'omit', 'error'], [loginAsset, 'HEAD', 'omit', 'error']
  ]);
  assert.ok(calls.every(({ options }) => options.signal instanceof AbortSignal));
  assert.equal(browser.fulfillments[0].headers['set-cookie'], undefined);
  assert.equal(browser.fulfillments[0].body.toString(), '/* guest fixture */');
  assert.equal(browser.fulfillments[1].body.length, 0);
  assert.deepEqual(gateway.reportStage().loginResources, { loaded: 2, refused: 0 });

  for (const [frame, url, resource, method, navigation, redirected] of [
    [main, loginAsset.replace('https:', 'http:'), 'script'],
    [main, loginAsset.replace('lf-ucenter', 'lookalike'), 'script'],
    [main, loginAsset.replace('lf-ucenter-web.yhgfb-cn-static.com', '10.0.0.1'), 'script'],
    [main, loginAsset.replace('/static', ':443/static'), 'script'],
    [main, loginAsset.replace('/static', ':8443/static'), 'script'],
    [main, loginAsset, 'fetch'],
    [main, loginAsset, 'script', 'POST'],
    [main, loginAsset, 'script', 'GET', false, {}],
    [main, loginAsset, 'document', 'GET', true],
    [page.childNavigate('about:blank'), loginAsset, 'script'],
    [main, loginAsset.replace('/static/login-boot.js', '/passport/web/challenge/'), 'script']
  ]) assert.equal(await browser.visit(frame, url, resource, method, navigation, redirected), false);
  browser.onGoto = undefined;
  await gateway.verifyIdentity();
  assert.equal(await browser.visit(browser.sourcePages()[0].mainFrame(), loginAsset, 'script'), false);
  assert.equal(calls.length, 2);
});

test('a linked initial login redirect loads assets but a later real reload cannot inherit that grant', async t => {
  const { browser, gateway } = await fixture(t, {
    fetchLoginAsset: async url => guestAssetResponse(url)
  });
  const root = 'https://www.douyin.com/';
  browser.onInitialRequest = initial => {
    browser.emit('request', { ...initial, url: () => root, redirectedFrom: () => initial });
    return root;
  };
  let duringGoto;
  browser.onGoto = async page => {
    duringGoto = await browser.visit(page.mainFrame(), loginAsset, 'script');
  };
  const assertQrRequest = () => {};
  await gateway.openLogin({ assertQrRequest });
  assert.equal(duringGoto, true);
  const page = browser.sourcePages()[0];
  const main = page.mainFrame();
  page.navigate(root + '?same-document');
  assert.equal(await browser.visit(main, loginAsset, 'script'), true);
  assert.equal(await browser.visit(main, self + '?reload', 'document'), true);
  page.navigate(self + '?reload');
  assert.equal(await browser.visit(main, loginAsset, 'script'), false);
  await gateway.openLogin({ assertQrRequest });
  assert.equal(browser.sourcePages()[0], page);
  assert.equal(await browser.visit(main, loginAsset, 'script'), true);
});

test('one same-URL bootstrap reload during passive opening starts fresh public resource loading', async t => {
  const firstStarted = Promise.withResolvers();
  const firstResponse = Promise.withResolvers();
  const earlierAsset = loginAsset + '?fixture=first-document';
  const { browser, gateway } = await fixture(t, {
    fetchLoginAsset: async url => {
      if (url === earlierAsset) {
        firstStarted.resolve();
        return firstResponse.promise;
      }
      return guestAssetResponse(url);
    }
  });
  browser.panel = null;
  browser.entryVisible = false;
  let oldRequest, duringReload, freshRequest;
  browser.onGoto = async page => {
    oldRequest = browser.visit(page.mainFrame(), earlierAsset, 'script');
    await firstStarted.promise;
  };
  let reloaded = false;
  browser.beforePanel = async (action, page) => {
    if (action !== 'probe-open' || reloaded) return;
    reloaded = true;
    const main = page.mainFrame();
    assert.equal(await browser.visit(main, self, 'document'), true);
    duringReload = await browser.visit(main, loginAsset, 'script');
    // Return from the old inspection before the reload commits.
    browser.clock.onPaceWait = () => {
      browser.clock.onPaceWait = undefined;
      page.navigate(self);
      freshRequest = browser.visit(main, loginAsset, 'script');
      firstResponse.resolve(guestAssetResponse(earlierAsset));
      page.navigate(self + '?same-document');
      browser.panel = { id: 1, ...panelRect };
    };
  };
  const result = await gateway.openLogin({ assertQrRequest() {} });
  assert.ok(reloaded);
  assert.equal(duringReload, false);
  assert.equal(await freshRequest, true);
  assert.equal(await oldRequest, false);
  assert.equal(result.width, panelRect.width);
  assert.equal(browser.fulfillments.length, 1);
});

test('a passive execution-context error is resampled only across the tracked bootstrap reload', async t => {
  const contextError = 'page.evaluate: Execution context was destroyed, most likely because of a navigation';
  for (const transition of ['pending', 'committed', 'none', 'other-error']) {
    await t.test(transition, async t => {
      const { browser, gateway } = await fixture(t);
      browser.panel = null;
      browser.entryVisible = false;
      let observations = 0;
      browser.beforePanel = async (action, page) => {
        assert.equal(action, 'probe-open');
        if (++observations !== 1) return;
        if (transition !== 'none') {
          assert.equal(await browser.visit(page.mainFrame(), self, 'document'), true);
          const commit = () => {
            browser.clock.onPaceWait = undefined;
            page.navigate(self);
            browser.panel = { id: 1, ...panelRect };
          };
          if (transition === 'pending') browser.clock.onPaceWait = commit;
          else commit();
        }
        throw new Error(transition === 'other-error' ? 'fixture evaluator failed' : contextError);
      };
      const opening = gateway.openLogin({ assertQrRequest() {} });
      if (transition === 'none' || transition === 'other-error') {
        await assert.rejects(opening, { code: 'PROBE_VERIFICATION_PANEL_REQUIRED' });
        assert.equal(observations, 1);
      } else {
        assert.equal((await opening).width, panelRect.width);
        assert.equal(observations, 2);
      }
    });
  }
});

test('unrelated, third, inactive and post-opening main reloads cannot obtain the bootstrap exception', async t => {
  for (const change of ['unrelated', 'third', 'inactive', 'canceled', 'post-opening']) {
    await t.test(change, async t => {
      let live = true, loads = 0, second, final;
      const request = new AbortController();
      const { browser, gateway } = await fixture(t, { fetchLoginAsset: async url => {
        loads++;
        return guestAssetResponse(url);
      } });
      const authorize = () => { if (!live) throw new ProbeError('STALE_LEASE'); };
      const navigateAndRequest = async (page, url) => {
        const main = page.mainFrame();
        assert.equal(await browser.visit(main, url, 'document'), true);
        page.navigate(url);
        return browser.visit(main, loginAsset, 'script');
      };
      if (change !== 'post-opening') browser.onGoto = async page => {
        if (change === 'third') second = await navigateAndRequest(page, self);
        if (change === 'inactive') live = false;
        if (change === 'canceled') request.abort(new ProbeError('STALE_LEASE'));
        final = await navigateAndRequest(page, change === 'unrelated' ? self + '?different' : self);
      };
      const opening = gateway.openLogin({ assertQrRequest: authorize, signal: request.signal });
      if (change === 'canceled') await assert.rejects(opening, { code: 'STALE_LEASE' });
      else await opening;
      if (change === 'post-opening') final = await navigateAndRequest(browser.sourcePages()[0], self);
      if (change === 'third') assert.equal(second, true);
      assert.equal(final, false);
      assert.equal(loads, change === 'third' ? 1 : 0);
    });
  }
});

test('the same-URL bootstrap reload cannot obtain a grant after the opening click was dispatched', async t => {
  let loads = 0, actionObserved = false;
  const { browser, gateway } = await fixture(t, { fetchLoginAsset: async url => {
    loads++;
    return guestAssetResponse(url);
  } });
  browser.panel = null;
  browser.beforePanel = async (action, page) => {
    if (action !== 'open') return;
    actionObserved = true;
    const main = page.mainFrame();
    assert.equal(await browser.visit(main, self, 'document'), true);
    page.navigate(self);
    assert.equal(await browser.visit(main, loginAsset, 'script'), false);
  };
  await assert.rejects(gateway.openLogin({ assertQrRequest() {} }), { code: 'STALE_BROWSER_VIEW' });
  assert.equal(actionObserved, true);
  assert.equal(loads, 0);
});

test('an unrelated request cannot extend the initial login redirect grant', async t => {
  let loads = 0;
  const { browser, gateway } = await fixture(t, {
    fetchLoginAsset: async url => { loads++; return guestAssetResponse(url); }
  });
  const root = 'https://www.douyin.com/';
  browser.onInitialRequest = initial => {
    browser.emit('request', { ...initial, url: () => root, redirectedFrom: () => ({}) });
    return root;
  };
  await gateway.openLogin({ assertQrRequest() {} });
  const page = browser.sourcePages()[0];
  assert.equal(await browser.visit(page.mainFrame(), loginAsset, 'script'), false);
  assert.equal(loads, 0);
});

test('leased login admits only the four observed credentialless public bootstrap GETs', async t => {
  const calls = [];
  const { browser, gateway } = await fixture(t, { fetchLoginAsset: async (url, options) => {
    calls.push({ url, options });
    return guestAssetResponse(url, { type: 'application/json', body: '{"fixture":true}' });
  } });
  await gateway.openLogin({ assertQrRequest() {} });
  const page = browser.sourcePages()[0];
  const main = page.mainFrame();
  const paths = ['/aweme/v1/web/social/count', '/aweme/v1/web/solution/resource/list/',
    '/aweme/v1/web/get/user/settings/', '/aweme/v1/web/query/user/'];
  for (const pathname of paths) {
    assert.equal(await browser.visit(main, 'https://www.douyin.com' + pathname + '?fixture=value', 'fetch'), true);
  }
  for (const [frame, pathname, method] of [
    [main, paths[0] + '/', 'GET'],
    [main, paths[1], 'POST'],
    [main, paths[2], 'HEAD'],
    [main, paths[3] + 'other', 'GET'],
    [main, '/aweme/v1/web/other/boot/', 'GET'],
    [page.childNavigate('about:blank'), paths[0], 'GET']
  ]) assert.equal(await browser.visit(frame, 'https://www.douyin.com' + pathname, 'fetch', method), false);
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), paths);
  assert.ok(calls.every(({ options }) => options.credentials === 'omit' && options.redirect === 'error'));
  assert.ok(browser.fulfillments.every(({ headers }) => !('set-cookie' in headers)));
});

test('added static loads cannot fulfill redirects, non-static bodies, or a request after its lease is lost', async t => {
  let reply, live = true;
  const { browser, gateway } = await fixture(t, { fetchLoginAsset: () => reply() });
  await gateway.openLogin({ assertQrRequest() { if (!live) throw new ProbeError('STALE_LEASE'); } });
  const frame = browser.sourcePages()[0].mainFrame();
  for (const response of [
    guestAssetResponse(loginAsset, { status: 302 }),
    guestAssetResponse('https://outside.invalid/boot.js'),
    guestAssetResponse(loginAsset, { type: 'text/html' }),
    guestAssetResponse(loginAsset, { body: 'x'.repeat(4 * 1024 * 1024 + 1) })
  ]) {
    reply = async () => response;
    assert.equal(await browser.visit(frame, loginAsset, 'script'), false);
  }
  const started = Promise.withResolvers();
  const pending = Promise.withResolvers();
  reply = () => { started.resolve(); return pending.promise; };
  const visit = browser.visit(frame, loginAsset, 'script');
  await started.promise;
  live = false;
  pending.resolve(guestAssetResponse(loginAsset));
  assert.equal(await visit, false);
  assert.equal(browser.fulfillments.length, 0);
  assert.deepEqual(gateway.reportStage().loginResources, { loaded: 0, refused: 5 });
});

test('browser routes admit the known page and read API without permitting account writes', async t => {
  const { browser, gateway } = await fixture(t);
  await gateway.openLogin();
  const login = browser.sourcePages()[0].mainFrame();
  assert.equal(await browser.visit(login, 'https://www.douyin.com/aweme/v1/web/commit/favorite/', 'fetch', 'POST'), false);
  assert.equal(await browser.visit(login, 'https://www.douyin.com/settings/account', 'fetch'), false);
  assert.equal(await browser.visit(login, 'https://www.douyin.com' + collection, 'fetch', 'POST'), false);
  assert.equal(await browser.visit(login, 'https://outside.invalid/script.js', 'script'), false);
  assert.equal(await browser.visit(login, 'https://static.douyinstatic.com/login.js', 'script'), true);
  assert.equal(await browser.trySocket(), false);
  await gateway.verifyIdentity();
  const reader = browser.sourcePages()[0].mainFrame();
  assert.equal(await browser.visit(reader, 'https://www.douyin.com' + collection, 'fetch', 'POST'), true);
  assert.equal(await browser.visit(reader, 'https://www.douyin.com' + detail, 'fetch'), true);
  assert.equal(await browser.visit(reader, 'https://www.douyin.com/aweme/v1/web/commit/favorite/', 'fetch', 'POST'), false);
});

test('media headers put no session data on any hop and reject unknown targets', async t => {
  const { gateway } = await fixture(t);
  await gateway.verifyIdentity();
  for (const url of ['https://v.douyinvod.com/fixture', 'https://www.douyin.com/fixture', 'https://cdn.douyinpic.com/fixture']) {
    const headers = await gateway.mediaHeaders(url);
    assert.deepEqual(Object.fromEntries(headers), { referer: 'https://www.douyin.com/', 'user-agent': 'Fixture chromium' });
  }
  for (const url of ['https://douyinvod.com.outside.invalid/', 'http://v.douyinvod.com/', 'https://user:pass@v.douyinvod.com/', 'https://v.douyinvod.com:8080/']) {
    await assert.rejects(gateway.mediaHeaders(url), { code: 'PROBE_MEDIA_TARGET' });
  }
  for (const name of ['cookies', 'storageState', 'send', 'navigate', 'context', 'evaluate']) assert.equal(gateway[name], undefined);
});

test('a browser account change fences media setup before it issues headers', async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  browser.session = 'rotated-session';
  await assert.rejects(gateway.mediaHeaders('https://v.douyinvod.com/fixture'), { code: 'STALE_AUTH_EPOCH' });
  assert.throws(() => gateway.assertAuthEpoch(authEpoch), { code: 'STALE_AUTH_EPOCH' });
});

test('a restarted browser requires rechecking the durable account binding', async t => {
  const { browser, gateway, open, store } = await fixture(t);
  const first = await gateway.verifyIdentity();
  await gateway.close();
  const reopened = await open();
  await assert.rejects(reopened.request(detail, { authEpoch: first.authEpoch, params: { aweme_id: '1' } }), { code: 'STALE_AUTH_EPOCH' });
  browser.uid = authorId;
  await assert.rejects(reopened.verifyIdentity(), { code: 'PROBE_ACCOUNT_MISMATCH' });
  browser.uid = ownId;
  const restored = await reopened.verifyIdentity();
  assert.equal(restored.uid, first.uid);
  assert.ok(restored.authEpoch > first.authEpoch);
  const saved = store.db.prepare("SELECT value FROM runtime_meta WHERE key='browser_auth'").get();
  assert.deepEqual(JSON.parse(saved.value), { authEpoch: restored.authEpoch, uid: first.uid });
});

test('source rate limits preserve raw evidence and pause both reader and detail traffic', async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  browser.reply = () => new Response('fixture rate limit', { status: 429, headers: { 'retry-after': '15' } });
  const result = await gateway.request(detail, { authEpoch, params: { aweme_id: '1' } });
  assert.deepEqual(result, { status: 429, text: 'fixture rate limit', retryAfter: 15 });
  await assert.rejects(gateway.request(collection, { authEpoch, method: 'POST', form: { cursor: '0' } }), {
    code: 'PROBE_SOURCE_RATE_LIMITED', details: { retryAfter: 15 }
  });
  assert.equal(browser.reads.length, 2);
});

test('cooldown blocks cold detail navigation before loading the page', async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  browser.reply = () => new Response('limit', { status: 429, headers: { 'retry-after': '15' } });
  await gateway.request(collection, { authEpoch, method: 'POST', form: { cursor: '0' } });
  const navigationCount = browser.navigations.length;
  await assert.rejects(gateway.request(detail, { authEpoch, params: { aweme_id: '1' } }), { code: 'PROBE_SOURCE_RATE_LIMITED' });
  assert.equal(browser.navigations.length, navigationCount);
});

test('a slow authorization check cannot collapse the spacing between actual fetches', async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  browser.onCookies = () => { browser.clock.advance(1600); browser.onCookies = undefined; };
  const opts = { authEpoch, params: { aweme_id: '1' } };
  await gateway.request(detail, opts);
  await gateway.request(detail, opts);
  assert.ok(browser.reads[2].clock - browser.reads[1].clock >= 1100);
});

test('session changes during pacing reject before dispatching a source read', async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  browser.clock.onPaceWait = () => { browser.session = 'different-account-session'; };
  await assert.rejects(gateway.request(detail, { authEpoch, params: { aweme_id: '1' } }), { code: 'STALE_AUTH_EPOCH' });
  assert.equal(browser.reads.length, 1);
});

test('stalled cookie reads time out and release the source queue', { timeout: 6000 }, async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  browser.onCookies = () => new Promise(() => {});
  await assert.rejects(gateway.request(detail, { authEpoch, params: { aweme_id: '1' } }), { code: 'PROBE_BROWSER_TIMEOUT' });
  browser.onCookies = undefined;
  assert.equal((await gateway.request(detail, { authEpoch, params: { aweme_id: '1' } })).status, 200);
});

test('caller cancellation releases an in-flight cookie admission before its deadline', { timeout: 1500 }, async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  browser.onCookies = () => {
    browser.onCookies = undefined;
    browser.emit('cookies-started');
    return new Promise(() => {});
  };
  const controller = new AbortController();
  const firstStarted = once(browser, 'cookies-started');
  const options = { authEpoch, params: { aweme_id: '1' } };
  const pending = gateway.request(detail, { ...options, signal: controller.signal });
  await firstStarted;
  controller.abort();
  await assert.rejects(pending, { code: 'PROBE_BROWSER_CANCELLED' });
  assert.equal((await gateway.request(detail, options)).status, 200);
});

test('stalled user agent verification times out and releases the view queue', { timeout: 6000 }, async t => {
  const { browser, gateway } = await fixture(t);
  browser.onUserAgent = () => new Promise(() => {});
  await assert.rejects(gateway.verifyIdentity(), { code: 'PROBE_BROWSER_TIMEOUT' });
  browser.onUserAgent = undefined;
  assert.equal((await gateway.verifyIdentity()).uid, ownId);
});

test('oversized browser responses and arbitrary driver errors are bounded', async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  browser.reply = () => new Response('页'.repeat(3 * 1024 * 1024));
  await assert.rejects(gateway.request(detail, { authEpoch, params: { aweme_id: '1' } }), { code: 'PROBE_BROWSER_RESPONSE_LIMIT' });
  browser.reply = () => { throw Error('private-fixture-session'); };
  await assert.rejects(gateway.request(detail, { authEpoch, params: { aweme_id: '1' } }), error => {
    assert.equal(error.code, 'PROBE_BROWSER_REQUEST');
    assert.doesNotMatch(JSON.stringify(error), /private-fixture-session/);
    assert.doesNotMatch(error.message, /private-fixture-session/);
    return true;
  });
});

test('browser resource accounting blocks media requests while preserving official document and script', async t => {
  const { browser, gateway } = await fixture(t);
  await gateway.openLogin();
  const page = browser.sourcePages()[0];
  const visit = (url, type) => browser.visit(page.mainFrame(), url, type);
  await visit(self, 'document');
  await visit('https://static.douyinstatic.com/fixture.js', 'script');
  await visit('https://v.douyinvod.com/fixture.mp4', 'media');
  await visit('https://outside.invalid/', 'document');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(gateway.traffic(), {
    browser: { completedRequests: 2, sentBytes: 10, receivedBytes: 108, blockedRequests: 2, failedRequests: 0, unknownSizes: 0 }
  });
});

test('profile roots that redirect Chromium-owned state are refused before launch', async t => {
  const { layout, sandbox, open } = await fixture(t, { defer: true, launch: () => assert.fail('unsafe Chromium root launched') });
  const shared = path.join(sandbox.root, 'other-state');
  await mkdir(shared);
  await sandbox.write('other-state/fixture-db', 'unrelated fixture');
  await link(path.join(shared, 'fixture-db'), path.join(layout.browser, 'Local State'));
  await assert.rejects(open(), { code: 'UNSAFE_BROWSER_PROFILE' });
});

test('profile root replacement during launch fails closed', async t => {
  const { open } = await fixture(t, { defer: true, launch: async directory => {
    await rename(directory, directory + '-original');
    await mkdir(directory);
  } });
  await assert.rejects(open(), { code: 'UNSAFE_BROWSER_PROFILE' });
});

test('a direct browser-directory link is rejected without touching its target', async t => {
  const { layout, sandbox, open } = await fixture(t, { defer: true, launch: () => assert.fail('redirected directory launched') });
  const target = layout.browser + '-outside';
  await rename(layout.browser, target);
  await sandbox.write('browser-outside/preferences', 'fixture');
  await symlink(target, layout.browser, 'junction');
  await assert.rejects(open(), { code: 'UNSAFE_BROWSER_PROFILE' });
  assert.equal(await sandbox.read('browser-outside/preferences'), 'fixture');
});

test('Linux Chromium accepts only its known stale singleton names and locations', { skip: process.platform !== 'linux' }, async t => {
  const temp = path.resolve(tmpdir());
  for (const [parent, allowed] of [
    [path.join(temp, '.org.chromium.Chromium.abc123'), true],
    [path.join(temp, '.com.google.Chrome.beta.Ab_12-'), true],
    ['/tmp/org.chromium.Chromium.aBc123', temp === '/tmp'],
    ['/tmp/com.google.Chrome.Zx0129', temp === '/tmp'],
    [path.join(temp + '-sibling', 'org.chromium.Chromium.abc123'), false],
    [path.join(temp, 'elsewhere', 'org.chromium.Chromium.abc123'), false],
    [path.join(temp, 'org.chromium.Chromium.abc12'), false],
    [path.join(temp, 'org.chromium.Chromium.Ab_12-'), false],
    [path.join(temp, 'com.google.Chrome.beta.abc123'), false],
    [path.join(temp, 'some-other-browser.abc123'), false]
  ]) {
    await t.test(parent, async t => {
      const { layout, open } = await fixture(t, {
        defer: true, launch: allowed ? undefined : () => assert.fail('unsafe singleton link reached Chromium')
      });
      await symlink('fixture-host-2147483647', path.join(layout.browser, 'SingletonLock'));
      await symlink('987654321', path.join(layout.browser, 'SingletonCookie'));
      await symlink(path.join(parent, 'SingletonSocket'), path.join(layout.browser, 'SingletonSocket'));
      if (allowed) await open();
      else await assert.rejects(open(), { code: 'UNSAFE_BROWSER_PROFILE' });
    });
  }
});

test('Linux Chromium cannot use a singleton shortcut below the profile root', { skip: process.platform !== 'linux' }, async t => {
  const { layout, open } = await fixture(t, { defer: true, launch: () => assert.fail('nested singleton link reached Chromium') });
  const nested = path.join(layout.browser, 'Default');
  await mkdir(nested);
  await symlink('/tmp/org.chromium.Chromium.aBc123/SingletonSocket', path.join(nested, 'SingletonSocket'));
  await assert.rejects(open(), { code: 'UNSAFE_BROWSER_PROFILE' });
});

test('the synchronous request fence runs after pacing and session checks but before the source fetch', async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  let stillHeld = true;
  browser.clock.onPaceWait = () => { stillHeld = false; };
  const fence = () => {
    assert.equal(stillHeld, false);
    assert.equal(browser.reads.length, 1);
    throw new ProbeError('STALE_LEASE', 'Expired fixture lease');
  };
  await assert.rejects(gateway.request(detail, { authEpoch, params: { aweme_id: '1' }, beforeDispatch: fence }),
    { code: 'STALE_LEASE' });
  assert.equal(browser.reads.length, 1);
  await gateway.request(detail, { authEpoch, params: { aweme_id: '1' } });
  browser.clock.onPaceWait = () => { browser.session = 'new-session-before-dispatch'; };
  let called = false;
  await assert.rejects(gateway.request(detail, {
    authEpoch, params: { aweme_id: '2' }, beforeDispatch: () => { called = true; }
  }), { code: 'STALE_AUTH_EPOCH' });
  assert.equal(called, false);
});

test('an HTTP 200 source rate message holds both list and detail requests for the shared cooldown', async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  const text = '{"status_code":0,"status_msg":"访问太频繁","aweme_list":[],"has_more":0}';
  browser.reply = () => new Response(text);
  assert.equal((await gateway.request(collection, { authEpoch, method: 'POST', form: { cursor: '0', count: '30' } })).text, text);
  const reads = browser.reads.length;
  await assert.rejects(gateway.request(detail, { authEpoch, params: { aweme_id: '1' } }), {
    code: 'PROBE_SOURCE_RATE_LIMITED'
  });
  await assert.rejects(gateway.request(collection, { authEpoch, method: 'POST', form: { cursor: '0', count: '30' } }), {
    code: 'PROBE_SOURCE_RATE_LIMITED'
  });
  assert.equal(browser.reads.length, reads);
  browser.clock.advance(60_000);
  browser.reply = () => new Response(sourceText);
  await gateway.request(detail, { authEpoch, params: { aweme_id: '1' } });
  assert.equal(browser.reads.length, reads + 1);
});

test('an HTTP 200 business authentication rejection invalidates the verified session immediately', async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  const text = '{"status_code":8,"status_msg":"login required"}';
  browser.reply = () => new Response(text);
  assert.equal((await gateway.request(collection, { authEpoch, method: 'POST', form: { cursor: '0', count: '30' } })).text, text);
  assert.throws(() => gateway.assertAuthEpoch(authEpoch), { code: 'STALE_AUTH_EPOCH' });
  const reads = browser.reads.length;
  await assert.rejects(gateway.request(detail, { authEpoch, params: { aweme_id: '1' } }), { code: 'STALE_AUTH_EPOCH' });
  assert.equal(browser.reads.length, reads);
});

test('a page that starts loading at reservation time reports a definitely unsent browser request', async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  const prior = browser.reads.length;
  await assert.rejects(gateway.request(detail, {
    authEpoch, params: { aweme_id: '1' },
    beforeDispatch() { browser.readyState = 'loading'; }
  }), { code: 'PROBE_BROWSER_NOT_DISPATCHED' });
  assert.equal(browser.reads.length, prior);
  browser.readyState = 'complete';
  assert.equal((await gateway.request(detail, { authEpoch, params: { aweme_id: '1' } })).status, 200);
  assert.equal(browser.reads.length, prior + 1);
});

function workPageBody(count, id, caption) {
  return JSON.stringify({
    aweme_list: Array.from({ length: count }, () => ({ aweme_id: id, desc: caption })),
    has_more: 0
  });
}

test('a received page rejected after cookie rotation still reduces the durable NAS sample budget', async t => {
  const { browser, gateway, store } = await fixture(t);
  const leaseManager = createLeaseManager({ store, bootId: 'body-receipt-boot' });
  const lease = leaseManager.acquire({ deviceId: 'device', instanceId: 'instance', operationId: 'receipt-lease' });
  const reads = createReadCoordinator({ store, leases: leaseManager, gateway,
    finalize: async () => ({ ok: true, pending: false, errors: [] }) });
  const total = { kind: 'total', id: '__all__' };
  const folder = { kind: 'collection', id: '10' };
  async function settled(id) {
    for (let i = 0; i < 40; i++) {
      const job = reads.snapshot(id);
      if (['paused', 'failed', 'complete'].includes(job.state)) return job;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('The read did not reach a persisted boundary.');
  }

  const privateFixtureText = 'old-browser-reply-sentinel';
  const initial = await gateway.verifyIdentity();
  browser.reply = () => {
    browser.session = 'fixture-renewed-cookie';
    return new Response(workPageBody(272, '9991', privateFixtureText));
  };
  const first = reads.start({ source: total, operationId: 'old-session-source', lease, authEpoch: initial.authEpoch });
  const fenced = await settled(first.id);
  assert.deepEqual(fenced.reason, { code: 'STALE_AUTH_EPOCH', scope: 'global' });
  assert.equal(store.readHead(total), null);
  assert.equal(store.work('9991'), null);
  const saved = store.db.prepare('SELECT value FROM runtime_meta WHERE key LIKE ?').all('read:%');
  assert.equal(JSON.stringify(saved).includes(privateFixtureText), false);

  const verifiedAgain = await gateway.verifyIdentity();
  assert.equal(verifiedAgain.uid, initial.uid);
  assert.notEqual(verifiedAgain.authEpoch, initial.authEpoch);
  browser.reply = () => new Response(workPageBody(28, '9992', 'current reply'));
  const next = reads.start({ source: folder, operationId: 'new-session-source', lease, authEpoch: verifiedAgain.authEpoch });
  assert.equal((await settled(next.id)).savedReceived, 28);
  assert.equal(browser.reads.at(-1).target.searchParams.get('count'), '28');
  assert.throws(() => reads.start({ source: { kind: 'collection', id: '20' },
    operationId: 'budget-exhausted-after-rotation', lease, authEpoch: verifiedAgain.authEpoch }), { code: 'PROBE_SAMPLE_LIMIT' });
});

test('a completed body is counted before a post-fetch cookie timeout without exposing its text', { timeout: 6000 }, async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  const observed = [];
  const sentinel = 'private-fixture-timeout-value';
  browser.reply = () => {
    browser.onCookies = () => new Promise(() => {});
    return new Response(workPageBody(3, '9991', sentinel));
  };
  await assert.rejects(gateway.request(detail, {
    authEpoch, params: { aweme_id: '9991' }, onReceivedRows(rows) { observed.push(rows); }
  }), error => error.code === 'PROBE_BROWSER_TIMEOUT' && !JSON.stringify(error).includes(sentinel));
  assert.deepEqual(observed, [3]);
});

test('a complete body delivered during fetch cancellation is accounted before rejecting', async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  const controller = new AbortController();
  const observed = [];
  browser.reply = () => {
    controller.abort();
    return new Response(workPageBody(4, '9991', 'private fixture data'));
  };
  await assert.rejects(gateway.request(detail, {
    authEpoch, params: { aweme_id: '9991' }, signal: controller.signal,
    onReceivedRows(rows) { observed.push(rows); }
  }), { code: 'PROBE_BROWSER_CANCELLED' });
  assert.deepEqual(observed, [4]);
});

test('a response with a stale page revision is accounted before it is rejected', async t => {
  const { browser, gateway } = await fixture(t);
  const { authEpoch } = await gateway.verifyIdentity();
  const observed = [];
  browser.reply = () => {
    browser.reads.at(-1).page.navigate(self + '?different-document=1');
    return new Response(workPageBody(5, '9991', 'private fixture data'));
  };
  await assert.rejects(gateway.request(detail, {
    authEpoch, params: { aweme_id: '9991' }, onReceivedRows(rows) { observed.push(rows); }
  }), { code: 'PROBE_BROWSER_REQUEST' });
  assert.deepEqual(observed, [5]);
});
