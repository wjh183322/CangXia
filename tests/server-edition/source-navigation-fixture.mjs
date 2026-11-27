import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import selfsigned from 'selfsigned';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const home = 'https://www.douyin.com/user/self',
  root = 'https://www.douyin.com/';
export async function testNavigation(t, openOfficialProvider) {
  const tls = await selfsigned.generate([{ name: 'commonName', value: 'www.douyin.com' }], {
    keySize: 2048,
    algorithm: 'sha256'
  });
  let mode = 'redirect',
    pending,
    owned = true,
    issued = 0,
    unapproved = 0,
    assets = 0,
    clock = Date.now();
  const html = `<!doctype html><meta charset="utf-8">
    <link rel="stylesheet" href="https://lf-c-flwb.bytetos.com/fixture.css">
    <button id="entry">登录</button>
    <div id="panel" role="dialog" hidden style="position:absolute;top:50px;left:50px;width:460px;height:400px;background:white">
      <h2>扫码登录</h2><canvas class="qrcode" width="140" height="140"></canvas>
    </div>
    <script>
      entry.onclick=async()=>{
        history.pushState(null,'','?ordinary-login#clicked');
        await fetch('/passport/web/get_qrcode/');
        panel.hidden=false;
        entry.hidden=true;
        const ctx=document.querySelector('canvas').getContext('2d');
        ctx.fillStyle='white'; ctx.fillRect(0,0,140,140);
        ctx.fillStyle='black'; ctx.fillRect(0,0,70,70);
        history.replaceState(null,'','?panel-mounted#qr');
      };
    </script>`;
  const server = https.createServer({ key: tls.private, cert: tls.cert }, async (req, res) => {
    if (req.headers.host === 'lf-c-flwb.bytetos.com') {
      assets++;
      res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' });
      res.end(':root{--fixture-resource: ' + assets + '}');
      return;
    }
    if (req.headers.host === 'lf-zt.douyin.com') {
      res.writeHead(302, { location: 'https://unapproved.invalid/' });
      res.end();
      return;
    }
    if (req.headers.host !== 'www.douyin.com') {
      unapproved++;
      res.writeHead(403);
      res.end();
      return;
    }
    const path = new URL(req.url, root).pathname;
    let afterReload = false;
    if (path === '/user/self') {
      const gate = pending;
      if (gate) {
        pending = null;
        gate.started.resolve();
        await gate.resume.promise;
        afterReload = true;
      }
      if (mode === 'redirect' || mode === 'foreign') {
        res.writeHead(302, { location: mode === 'redirect' ? '/' : 'https://unapproved.invalid/' });
        res.end();
        return;
      }
    }
    if (path === '/passport/web/get_qrcode/') {
      issued++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
    res.end(
      (afterReload ? "<script>history.replaceState(null,'','?passive-commit#mounted')</script>" : '') + html
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { chromium } = require('playwright-core');
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    if (
      ![
        'www.douyin.com:443',
        'lf-zt.douyin.com:443',
        'lf-c-flwb.bytetos.com:443',
        'unapproved.invalid:443'
      ].includes(req.url)
    ) {
      client.destroy();
      return;
    }
    const local = net.connect(server.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) local.write(head);
      client.pipe(local).pipe(client);
    });
    local.on('error', () => client.destroy());
    client.on('error', () => local.destroy());
    client.on('close', () => local.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  const browser = await chromium.launch({ proxy: { server: 'http://127.0.0.1:' + proxy.address().port } });
  t.after(() => browser.close());
  const links = [];
  let page;
  const provider = await openOfficialProvider(null, new AbortController().signal, {
    now: () => clock,
    createContext: async () => {
      const c = await browser.newContext({
        ignoreHTTPSErrors: true,
        serviceWorkers: 'block',
        viewport: { width: 1000, height: 760 }
      });
      c.on('request', (r) => {
        if (r.isNavigationRequest()) links.push([r.url(), r.redirectedFrom()?.url()]);
      });
      c.on('page', (p) => (page = p));
      return c;
    }
  });
  t.after(() => provider.close());
  await provider.beginLogin(() => {});
  assert.equal(page.url(), root);
  const assetMark = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--fixture-resource').trim()
    );
  const initialAsset = Number(await assetMark());
  assert.ok(initialAsset > 0);
  assert.ok(
    links.some(([to, from]) => to === root && from === home),
    'actual linked browser redirect'
  );
  await page.evaluate(() => history.pushState(null, '', '?late#before'));
  await provider.loginView();
  await page.waitForSelector('canvas.qrcode');
  const ready = await provider.loginView();
  assert.equal(ready.phase, 'ready');
  await page.evaluate(() => (location.hash = 'after-draw'));
  await provider.qrShown(ready.imageToken);
  assert.equal(issued, 1);
  await page.reload().catch(() => {});
  await assert.rejects(provider.loginView());
  mode = 'direct';
  await provider.beginLogin(() => {});
  await page.evaluate(() => history.pushState(null, '', '/settings'));
  await page.evaluate(() => history.replaceState(null, '', '/user/self'));
  await assert.rejects(provider.loginView());
  const testProtocol = await page.context().newCDPSession(page);
  for (const outcome of ['commit', 'deadline', 'cancel', 'inactive']) {
    owned = true;
    await provider.beginLogin(() => assert.ok(owned));
    const gate = { started: Promise.withResolvers(), resume: Promise.withResolvers() };
    pending = gate;
    const nav = page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await gate.started.promise;
    try {
      assert.equal((await provider.loginView()).phase, 'loading');
      if (outcome === 'deadline') {
        clock += 31000;
        await assert.rejects(provider.loginView(), { code: 'SOURCE_TIMEOUT' });
      }
      if (outcome === 'inactive') {
        owned = false;
        await assert.rejects(provider.loginView());
      }
      if (outcome === 'cancel') {
        const failed = page.waitForEvent('requestfailed', { predicate: (r) => r.isNavigationRequest() });
        await testProtocol.send('Page.stopLoading');
        await failed;
        await assert.rejects(provider.loginView());
      }
    } finally {
      gate.resume.resolve();
    }
    await nav;
    if (outcome === 'commit') {
      assert.equal(page.url(), home + '?passive-commit#mounted');
      assert.ok(Number(await assetMark()) > initialAsset);
      await provider.loginView();
      await page.waitForSelector('canvas.qrcode');
      assert.equal((await provider.loginView()).phase, 'ready');
    } else {
      owned = true;
      await assert.rejects(provider.loginView());
    }
  }
  await provider.beginLogin(() => {});
  const helper =
    'https://lf-zt.douyin.com/obj/uc-assets/zt/@byted/x-storage-web/4.0.8/dist/latest/index.html';
  const childFailed = page.waitForEvent('requestfailed', { predicate: (r) => r.url() === helper });
  await page.evaluate((url) => {
    const frame = document.createElement('iframe');
    frame.src = url;
    document.body.append(frame);
  }, helper);
  await childFailed;
  mode = 'foreign';
  await assert.rejects(provider.beginLogin(() => {}));
  assert.equal(unapproved, 0, 'unapproved redirect never contacts the synthetic external host');
  mode = 'direct';
  await provider.beginLogin(() => {});
  assert.equal(page.url(), home);
}
