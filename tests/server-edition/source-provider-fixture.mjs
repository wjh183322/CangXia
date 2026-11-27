import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
export async function exerciseProvider(t, openOfficialProvider) {
  assert.equal(typeof openOfficialProvider, 'function', 'normal Chromium provider must exist');
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1000, height: 760 },
    serviceWorkers: 'block'
  });
  const helper =
    'https://lf-zt.douyin.com/obj/uc-assets/zt/@byted/x-storage-web/4.0.8/dist/latest/index.html';
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
    createContext: async () => context
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
    document
      .querySelector('button')
      .addEventListener('click', () =>
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
  owned = false;
  assert.equal(await native(page, qrPath), false);
  assert.equal(await native(page, pollPath, 'POST'), false);
  assert.equal(polls, 1);
  assert.equal(forbiddenCalls, 0);
  assert.equal(clicks, 1);
  assert.equal(helperLoads, 1);
}
