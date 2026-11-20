import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { link, mkdir, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { openBrowserGateway } from '../src/browser.mjs';
import { openProbeStore } from '../src/store.mjs';
import { makeSandbox, sourceFixture } from './helpers.mjs';
import { parseSourcePage } from '../src/page-parser.mjs';

const self = 'https://www.douyin.com/user/self';
const collection = '/aweme/v1/web/aweme/listcollection/';
const detail = '/aweme/v1/web/aweme/detail/';
const ownId = '9357260389275234771';
const authorId = '8765602039312834059';
const sourceText = ` { "aweme_list": [{ "aweme_id": 8999555333221111111, "author": {"uid":${authorId}} }], "has_more": 0 } `;

class FakeContext extends EventEmitter {
  opened = [];
  reads = [];
  input = [];
  navigations = [];
  uid = ownId;
  session = 'private-fixture-session';
  reply = () => new Response(sourceText, { headers: { 'retry-after': '23' } });

  pages() { return this.opened.filter(page => !page.isClosed()); }
  async cookies(urls) {
    assert.deepEqual(urls, [self, 'https://www.douyin.com/aweme/v1/web/']);
    return this.session ? [{ name: 'sessionid', domain: '.douyin.com', path: '/', value: this.session }] : [];
  }

  async route(pattern, handler) { this.routeRequest = handler; }

  async newPage() {
    const context = this;
    const page = new EventEmitter();
    const frame = {};
    let href = 'about:blank';
    let closed = false;
    const input = (type, ...args) => context.input.push({ page, type, args });
    const window = {};
    page.url = () => href;
    page.mainFrame = () => frame;
    page.isClosed = () => closed;
    page.goto = async url => {
      context.navigations.push({ page, url });
      page.navigate(url);
    };
    page.navigate = url => { href = url; page.emit('framenavigated', frame); };
    page.close = async () => { closed = true; page.emit('close'); };
    page.screenshot = async options => {
      assert.equal(options.path, undefined);
      return context.screenshot ? context.screenshot() : Buffer.from('fixture frame');
    };
    page.mouse = {
      click: async (...args) => input('click', ...args), move: async (...args) => input('move', ...args),
      down: async () => input('down'), up: async () => input('up')
    };
    page.keyboard = { insertText: async text => input('text', text), press: async key => input('key', key) };
    page.evaluate = async (fn, arg) => runInNewContext(`(${fn})(arg)`, {
      arg, window, location: new URL(href), navigator: { userAgent: 'Fixture chromium' },
      document: { readyState: 'complete' }, AbortController, TextDecoder, setTimeout, clearTimeout,
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
    this.opened.push(page);
    return page;
  }

  async close() { await Promise.all(this.pages().map(page => page.close())); this.emit('close'); }
}

async function fixture(t, { launch, defer = false } = {}) {
  const sandbox = await makeSandbox(t);
  const layout = await sandbox.prepare();
  const store = openProbeStore({ file: path.join(layout.state, 'library.sqlite'), libraryId: sandbox.config.libraryId, initialize: true });
  sandbox.onCleanup(() => store.close());
  const browser = new FakeContext();
  let time = 0;
  const clock = {
    now: () => time,
    setTimeout(callback, ms) { time += ms; return setImmediate(callback); },
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
    const gateway = await openBrowserGateway({ config: sandbox.config, store, chromium, clock });
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
  const login = browser.pages()[0];
  const frame = await gateway.frame(view);
  assert.deepEqual(frame, { ...view, mime: 'image/png', bytes: Buffer.from('fixture frame') });
  await gateway.input({ ...view, type: 'click', x: 12, y: 34 });
  await gateway.input({ ...view, type: 'text', text: '确认' });
  await gateway.input({ ...view, type: 'key', key: 'Enter' });
  await assert.rejects(gateway.input({ ...view, type: 'key', key: 'Control+L' }), { code: 'INVALID_BROWSER_INPUT' });
  await assert.rejects(gateway.input({ ...view, type: 'click', x: -1, y: 0 }), { code: 'INVALID_BROWSER_INPUT' });
  login.navigate(self + '?login=finished');
  await assert.rejects(gateway.input({ ...view, type: 'click', x: 1, y: 2 }), { code: 'STALE_BROWSER_VIEW' });
  assert.deepEqual(browser.input.map(({ page, type, args }) => [page === login, type, ...args]), [
    [true, 'click', 12, 34], [true, 'text', '确认'], [true, 'key', 'Enter']
  ]);
  const current = await gateway.openLogin();
  browser.screenshot = async () => {
    login.navigate('https://outside.invalid/');
    return Buffer.from('foreign frame');
  };
  await assert.rejects(gateway.frame(current), { code: 'STALE_BROWSER_VIEW' });
  assert.ok(browser.navigations.every(({ url }) => url === self));
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
  const page = browser.pages()[0];
  async function visit(url, type) {
    const request = {
      url: () => url, resourceType: () => type, isNavigationRequest: () => type === 'document',
      frame: () => Object.assign(page.mainFrame(), { page: () => page }),
      sizes: async () => ({ requestBodySize: 2, requestHeadersSize: 3, responseBodySize: 50, responseHeadersSize: 4 })
    };
    await browser.routeRequest({
      request: () => request,
      abort: async () => browser.emit('requestfailed', request),
      continue: async () => browser.emit('requestfinished', request)
    });
  }
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

test('Linux Chromium may check its own stale singleton artifacts', { skip: process.platform !== 'linux' }, async t => {
  const { layout, open } = await fixture(t, { defer: true });
  await symlink('fixture-host-2147483647', path.join(layout.browser, 'SingletonLock'));
  await symlink('987654321', path.join(layout.browser, 'SingletonCookie'));
  await symlink(path.join(tmpdir(), '.org.chromium.Chromium.abc123', 'SingletonSocket'), path.join(layout.browser, 'SingletonSocket'));
  await open();
});
