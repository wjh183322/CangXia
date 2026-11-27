import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
export async function exerciseProvider(t, openOfficialProvider) {
  assert.equal(typeof openOfficialProvider, 'function', 'normal Chromium provider must exist');
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: process.platform === 'linux' });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1000, height: 760 },
    serviceWorkers: 'block'
  });
  const helper =
    'https://lf-zt.douyin.com/obj/uc-assets/zt/@byted/x-storage-web/4.0.8/dist/latest/index.html';
  let clock = Date.now(),
    holdReload;
  let clicks = 0,
    helperLoads = 0;
  let selfStatus = 200,
    issued = 0,
    polls = 0,
    sms = 0,
    forbiddenCalls = 0,
    owned = true;
  const qrPath = '/passport/web/get_qrcode/',
    pollPath = '/passport/web/check_qrconnect/';
  async function native(page, path, method = 'GET') {
    return page.evaluate(
      ({ path, method }) =>
        new Promise((resolve) => {
          const req = new XMLHttpRequest();
          req.open(method, path);
          req.onload = () => resolve(req.status === 200);
          req.onerror = () => resolve(false);
          req.send(method === 'POST' ? new URLSearchParams({ fixture: 'local' }) : null);
        }),
      { path, method }
    );
  }
  const body =
    '<body><button id="entry">登录</button><script>entry.onclick=()=>{console.log("clicked");fetch("/passport/web/get_qrcode/");}</script>';
  await context.route('**/*', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/user/self' && holdReload) {
      const gate = holdReload;
      holdReload = null;
      gate.enter.resolve();
      return gate.exit.promise.then(() => r.fulfill({ contentType: 'text/html; charset=utf-8', body }));
    }
    if (path === qrPath) {
      issued++;
      return r.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    }
    if (path === pollPath) {
      polls++;
      return r.fulfill({
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'sessionid=synthetic-browser-test; Secure; HttpOnly; Path=/'
        },
        body: '{"ok":true}'
      });
    }
    if (path === '/passport/web/validate_code/') {
      sms++;
      return r.fulfill({ body: '{}' });
    }
    if (path.startsWith('/passport/')) {
      forbiddenCalls++;
      return r.fulfill({ body: '{}' });
    }
    if (path === '/aweme/v1/web/user/profile/self/') {
      return r.fulfill({
        status: selfStatus,
        contentType: 'application/json',
        body:
          selfStatus === 200
            ? '{"status_code":0,"user":{"uid":7345612390836712341,"nickname":"fixture"},"author":{"uid":"999"}}'
            : 'fixture-private-response'
      });
    }
    if (r.request().url() === helper) {
      helperLoads++;
      return r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<body></body>' });
    }
    return r.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  const provider = await openOfficialProvider(null, new AbortController().signal, {
    createContext: async () => context,
    now: () => clock
  });
  t.after(() => provider.close());
  const page = context.pages()[0];
  page.on('console', (e) => {
    if (e.text() === 'clicked') clicks++;
  });
  assert.equal(await native(page, qrPath), false, 'pre-login account check cannot issue a QR');
  assert.equal(await native(page, pollPath, 'POST'), false);
  assert.equal(await native(page, '/passport/web/send_code/', 'POST'), false);
  await provider.beginLogin(() => {
    assert.ok(owned);
  });
  const gate = { enter: Promise.withResolvers(), exit: Promise.withResolvers() };
  holdReload = gate;
  const reload = page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame() });
  await page.evaluate(() => setTimeout(() => location.reload(), 10));
  await gate.enter.promise;
  try {
    assert.equal((await provider.loginView()).phase, 'loading');
    assert.equal(clicks, 0);
  } finally {
    gate.exit.resolve();
  }
  await reload;
  await page.waitForLoadState('domcontentloaded');
  const invalid = 'https://lf-zt.douyin.com/obj/unrecognized-storage/iframe.html';
  const failed = page.waitForEvent('requestfailed', { predicate: (r) => r.url() === invalid });
  await page.evaluate((url) => {
    document.body.append(document.createElement('iframe'));
    document.querySelector('iframe').src = url;
  }, invalid);
  await failed;
  assert.ok(
    ['', 'about:blank'].includes(
      page
        .frames()
        .find((f) => f !== page.mainFrame())
        .url()
    ),
    'refused initial frame remains blank'
  );
  await page.evaluate((url) => {
    document.querySelector('iframe').src = url;
  }, helper);
  await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow !== null);
  assert.equal((await provider.loginView()).phase, 'loading');
  assert.equal((await provider.loginView()).phase, 'loading');
  await page.waitForFunction(() => document.readyState === 'complete');
  assert.equal(issued, 1);
  assert.equal(await native(page, pollPath, 'POST'), false, 'not displayed');
  clock += 4000;
  const html =
    '<div role="dialog" style="position:absolute;top:50px;left:50px;width:460px;height:400px;background:white"><h2>扫码登录</h2><canvas class="qrcode" width="140" height="140"></canvas></div>';
  await page.evaluate((html) => {
    document.body.innerHTML = html;
  }, html);
  assert.equal((await provider.loginView()).phase, 'loading', 'unpainted official QR is still loading');
  await page.evaluate(() => {
    const ctx = document.querySelector('canvas').getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 140, 140);
    ctx.fillStyle = 'black';
    for (let x = 0; x < 14; x++)
      for (let y = 0; y < 14; y++) if ((x + y) % 2) ctx.fillRect(10 * x, 10 * y, 10, 10);
  });
  const first = await provider.loginView();
  assert.equal(first.phase, 'ready');
  assert.match(first.image, /^data:image\/png;base64,/);
  await provider.qrShown(first.imageToken);
  assert.equal(await native(page, pollPath, 'POST'), true);
  assert.ok(await provider.sessionKey(), 'normal official Set-Cookie establishes the synthetic session');
  assert.equal(await native(page, '/passport/web/sms_login/', 'POST'), false);
  await page.evaluate(() => {
    document.querySelector('canvas').getContext('2d').fillRect(8, 8, 30, 30);
  });
  const repainted = await provider.loginView();
  assert.notEqual(repainted.image, first.image);
  assert.equal(await native(page, pollPath, 'POST'), false, 'repaint must be displayed again');
  await provider.qrShown(repainted.imageToken);
  await page.evaluate(() => {
    const message = document.createElement('h2');
    message.innerText = '二维码已过期';
    document.querySelector('[role="dialog"]').append(message);
  });
  const expired = await provider.loginView();
  assert.equal(expired.phase, 'expired');
  assert.equal(expired.image, undefined);
  assert.equal(await native(page, pollPath, 'POST'), false, 'expired QR cannot poll');
  await page.evaluate(() => {
    document.body.innerHTML =
      '<div role="dialog" style="position:absolute;top:50px;left:50px;width:460px;height:400px;background:white"><h2>短信验证</h2><input placeholder="短信验证码" autocomplete="one-time-code"><button onclick="document.body.dataset.confirmed=1">确认</button></div>';
  });
  const manual = await provider.loginView();
  assert.equal(manual.phase, 'verification');
  assert.ok(manual.manual.code);
  await page.evaluate(() => {
    document.querySelector('button').addEventListener('click', () =>
      fetch('/passport/web/validate_code/', {
        method: 'POST',
        body: new URLSearchParams({ fixture: 'synthetic' })
      })
    );
  });
  const confirmed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/passport/web/validate_code/' && r.status() === 200
  );
  await provider.manual({ action: 'submit', panelId: manual.manual.panelId, code: '123456' });
  await confirmed;
  assert.equal(await native(page, '/passport/web/validate_code/', 'POST'), false);
  assert.equal(sms, 1);
  await assert.rejects(
    provider.manual({ action: 'submit', panelId: manual.manual.panelId, code: '123456' }),
    { code: 'MANUAL_UNAVAILABLE' }
  );
  assert.equal(await page.locator('body').getAttribute('data-confirmed'), '1');
  assert.ok(!JSON.stringify(await provider.loginView()).includes('123456'));
  await assert.rejects(provider.manual({ action: 'navigate', url: 'https://fixture.invalid' }));
  await page.evaluate(() => {
    document.body.innerHTML = '<h2>请完成安全验证</h2><p>拖动滑块</p>';
  });
  const unknown = await provider.loginView();
  assert.equal(unknown.phase, 'verification');
  assert.equal(unknown.manual, null);
  assert.deepEqual(await provider.self(), { uid: '7345612390836712341', nickname: 'fixture' });
  selfStatus = 403;
  await assert.rejects(
    provider.self(),
    (e) => e.code === 'SOURCE_REFUSED' && !e.message.includes('fixture-private-response')
  );
  selfStatus = 429;
  await assert.rejects(provider.self(), { code: 'SOURCE_RATE_LIMITED' });
  // A fresh explicit open gets one more bootstrap, then the issued QR must become drawable.
  selfStatus = 200;
  await context.clearCookies();
  await provider.beginLogin(() => assert.ok(owned));
  const issuance = page.waitForResponse((r) => new URL(r.url()).pathname === qrPath);
  await provider.loginView();
  await issuance;
  clock += 45000;
  await assert.rejects(provider.loginView(), { code: 'SOURCE_TIMEOUT' });
  await provider.beginLogin(() => assert.ok(owned));
  await page.reload();
  await page.reload().catch(() => {});
  await assert.rejects(provider.loginView(), { code: 'MANUAL_UNAVAILABLE' });
  await provider.beginLogin(() => assert.ok(owned));
  await page.goto('https://www.douyin.com/').catch(() => {});
  await assert.rejects(provider.loginView(), { code: 'MANUAL_UNAVAILABLE' });
  owned = false;
  assert.equal(await native(page, qrPath), false);
  assert.equal(await native(page, pollPath, 'POST'), false);
  assert.equal(polls, 1);
  assert.equal(forbiddenCalls, 0);
  assert.equal(clicks, 2);
  assert.equal(helperLoads, 1);
}

export async function delayedStatusDuringVerification(t, makeSource, openOfficialProvider, session) {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: process.platform === 'linux' });
  t.after(() => browser.close());
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    finished = Promise.withResolvers();
  t.after(() => release.resolve());
  let polls = 0;
  const contexts = [];
  async function createContext(saved) {
    const context = await browser.newContext({
      storageState: saved || undefined,
      viewport: { width: 1000, height: 760 },
      serviceWorkers: 'block'
    });
    contexts.push(context);
    await context.route('**/*', async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path === '/user/self') {
        const body =
          '<meta charset="utf-8"><button id="entry">登录</button><script>entry.onclick=async()=>{await fetch("/passport/web/get_qrcode/");document.body.innerHTML=\'<div role="dialog" style="position:absolute;top:50px;left:50px;width:460px;height:400px;background:white"><h2>扫码登录</h2><canvas class="qrcode" width="140" height="140"></canvas></div>\';const c=document.querySelector("canvas").getContext("2d");c.fillStyle="white";c.fillRect(0,0,140,140);c.fillStyle="black";for(let x=0;x<14;x++)for(let y=0;y<14;y++)if((x+y)%2)c.fillRect(x*10,y*10,10,10);};</script>';
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
      }
      if (path === '/passport/web/get_qrcode/')
        return route.fulfill({ contentType: 'application/json', body: '{}' });
      if (path === '/passport/web/check_qrconnect/') {
        const delayed = ++polls > 1;
        if (delayed) {
          entered.resolve();
          await release.promise;
        }
        try {
          await route.fulfill({
            headers: {
              'content-type': 'application/json',
              'set-cookie': 'sessionid=' + (delayed ? 'late' : 'first') + '; Secure; HttpOnly; Path=/'
            },
            body: '{}'
          });
        } catch (error) {
          if (!delayed) throw error;
        } finally {
          if (delayed) finished.resolve();
        }
        return;
      }
      if (path === '/aweme/v1/web/user/profile/self/') {
        const cookie = (await req.allHeaders()).cookie || '';
        return route.fulfill({
          json: {
            status_code: 0,
            user: { uid: cookie.includes('sessionid=first') ? '101' : '202', nickname: 'fixture' }
          }
        });
      }
      if (path === '/aweme/v1/web/aweme/listcollection/')
        return route.fulfill({ json: { aweme_list: [], has_more: false } });
      return route.abort();
    });
    return context;
  }
  const source = makeSource((saved, signal) => openOfficialProvider(saved, signal, { createContext }));
  t.after(() => source.close());
  const login = await source.openLogin(session),
    page = contexts[0].pages()[0];
  await page.waitForSelector('canvas.qrcode');
  const view = await source.loginView(session, login.viewId);
  assert.equal(view.phase, 'ready');
  await source.qrShown(session, login.viewId, view.imageToken);
  async function poll(wait) {
    return page.evaluate((wait) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/passport/web/check_qrconnect/');
      const done = new Promise((resolve) => {
        xhr.onload = () => resolve(xhr.status);
        xhr.onerror = () => resolve(0);
      });
      xhr.send(new URLSearchParams({ test: 'fixture' }));
      return wait ? done : undefined;
    }, wait);
  }
  assert.equal(await poll(true), 200);
  await poll(false);
  await entered.promise;
  let verified;
  try {
    verified = await source.verifyAccount(session);
  } finally {
    release.resolve();
  }
  await finished.promise;
  assert.equal(verified.uid, '101');
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].pages().length, 0);
  const result = await source.readSourcePage({
    source: { kind: 'total', id: '__all__' },
    cursor: '0',
    authEpoch: verified.authEpoch,
    signal: session.signal
  });
  assert.equal(result.terminal, true);
  assert.equal(source.account().uid, '101');
}
