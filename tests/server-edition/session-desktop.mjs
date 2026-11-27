// Launched only by the Windows integration test, using its private temporary profile.
import { app, BrowserWindow, powerMonitor } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.env.CANGXIA_SESSION_FIXTURE;
const config = JSON.parse(fs.readFileSync(path.join(root, 'connection.json'), 'utf8'));
app.setPath('appData', root);
app.commandLine.appendSwitch('disable-gpu');
await import('../../electron/main.mjs');
async function waitFor(fn) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(50);
  }
  throw Error(
    'Desktop fixture timed out: ' +
      JSON.stringify(
        BrowserWindow.getAllWindows().map((win) => ({
          visible: win.isVisible(),
          loaded: !win.webContents.isLoading(),
          role: win.webContents.getURL().split('/').at(-1),
          title: win.getTitle()
        }))
      )
  );
}
app.whenReady().then(async () => {
  try {
    const gate = await waitFor(() =>
      BrowserWindow.getAllWindows().find(
        (win) => !win.webContents.isLoading() && win.webContents.getURL().endsWith('/index.html')
      )
    );
    const js = (win, script) => win.webContents.executeJavaScript(script);
    assert.equal(await js(gate, 'window.cangxia.windowRole'), 'connection');
    assert.ok(await js(gate, 'document.body.innerText.includes("连接 NAS 资料库")'));
    await assert.rejects(js(gate, 'window.cangxia.state()'), /无使用权/);
    // Deliver the native wake notification exactly after pinned status succeeds
    // and before the same user's click can request a lease.
    const send = gate.webContents.send.bind(gate.webContents);
    let wakeBetweenStages = true;
    gate.webContents.send = (channel, ...args) => {
      send(channel, ...args);
      if (
        wakeBetweenStages &&
        channel === 'cangxia:server-session' &&
        args[0]?.reason === '可以取得使用权。'
      ) {
        wakeBetweenStages = false;
        powerMonitor.emit('resume');
      }
    };
    const fields = JSON.stringify([config.url, config.deviceId, config.fingerprint, config.token]);
    await js(
      gate,
      `const values=${fields};[...document.querySelectorAll('form input')].forEach((el,i)=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,values[i]);
    el.dispatchEvent(new Event('input',{bubbles:true}));
  }); document.querySelector('form button').click();`
    );
    await waitFor(() => js(gate, 'document.body.innerText.includes("资料库已锁定，请重新连接。")'));
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal((await js(gate, 'window.cangxia.serverSession()')).owned, false);
    gate.webContents.send = send;
    await js(gate, "document.querySelector('form button').click()");
    const win = await waitFor(() => BrowserWindow.getAllWindows().find((w) => w !== gate && w.isVisible()));
    await waitFor(() => js(win, 'document.body.innerText.includes("释放使用权")'));
    assert.equal((await js(win, 'window.cangxia.state()')).storage.mode, 'server');
    assert.equal(await js(win, 'window.cangxia.windowRole'), 'library');
    const receipt = await js(win, "window.cangxia.setTags('99',['fixture-tag'],0)");
    assert.equal(receipt.entityVersion, 1);
    await js(win, `document.querySelector('button[aria-label="设置"]').click()`);
    await waitFor(() => js(win, 'document.body.innerText.includes("查询 NAS 回执")'));
    await js(
      win,
      `const input=document.querySelector('.settings-content form input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(receipt.operationId)});
      input.dispatchEvent(new Event('input',{bubbles:true}));input.form.querySelector('button').click();`
    );
    await waitFor(() => js(win, 'document.body.innerText.includes("NAS 已确认 · set-tags")'));
    await js(
      win,
      `document.querySelector('#root').append(Object.assign(document.createElement('video'),{title:'fixture-secret-media'}));`
    );
    const protectedContents = win.webContents;
    powerMonitor.emit('resume');
    assert.equal(win.isDestroyed(), true);
    await waitFor(() => protectedContents.isDestroyed());
    await waitFor(() => gate.isVisible());
    await assert.rejects(js(gate, 'window.cangxia.state()'), /无使用权/);
    assert.equal(await js(gate, '!!document.querySelector("video")'), false);
    const profile = app.getPath('userData');
    const sealed = fs.readFileSync(path.join(profile, 'nas-connection.dpapi'));
    assert.equal(sealed.includes(config.token), false);
    assert.equal(fs.existsSync(path.join(profile, 'library.sqlite')), false);
    console.log('SESSION_DESKTOP_VERIFIED');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
