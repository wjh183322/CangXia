import { app, BrowserWindow, powerMonitor } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.env.CANGXIA_SESSION_FIXTURE;
app.setPath('appData', root);
app.commandLine.appendSwitch('disable-gpu');
await import('../../electron/main.mjs');
const js = (win, script) => win.webContents.executeJavaScript(script);
async function waitFor(fn) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(50);
  }
  throw Error(
    'Windows source login fixture timed out at ' +
      fn.toString() +
      '; ' +
      JSON.stringify(
        await Promise.all(
          BrowserWindow.getAllWindows().map((w) =>
            js(
              w,
              "({role:window.cangxia?.windowRole,status:document.querySelector('[role=status]')?.textContent, modal:document.querySelector('.modal')?.textContent?.slice(-300)})"
            )
          )
        )
      )
  );
}
app.whenReady().then(async () => {
  try {
    const gate = await waitFor(() =>
      BrowserWindow.getAllWindows().find(
        (w) => !w.webContents.isLoading() && w.webContents.getURL().endsWith('/index.html')
      )
    );
    await assert.rejects(js(gate, 'window.cangxia.startQrLogin()'), /无使用权/);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'connection.json'), 'utf8'));
    const epoch = await js(gate, 'window.cangxia.serverSession().then(s=>s.epoch)');
    await js(gate, `window.cangxia.serverConnect(${JSON.stringify(config)},${epoch})`);
    const win = await waitFor(() => BrowserWindow.getAllWindows().find((w) => w !== gate && w.isVisible()));
    await waitFor(() => js(win, '!!document.querySelector(".account-button")'));
    await js(win, 'document.querySelector(".account-button").click()');
    await waitFor(() => js(win, '!!document.querySelector(\'img[alt="抖音官方登录二维码"]\')'));
    await js(
      win,
      `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('核验账号')).click()`
    );
    await waitFor(() => js(win, "document.querySelector('.account-button')?.textContent.includes('样本')"));
    assert.equal(await js(win, 'window.cangxia.state().then(s=>s.account.uid)'), '7345612390836712341');
    powerMonitor.emit('resume');
    await waitFor(() => win.isDestroyed() && gate.isVisible());
    assert.equal(await js(gate, '!!document.querySelector(".qr-image-box img")'), false);
    console.log('SOURCE_DESKTOP_VERIFIED');
    app.exit(0);
  } catch (e) {
    console.error(e.message);
    app.exit(1);
  }
});
