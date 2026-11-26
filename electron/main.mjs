import { app, BrowserWindow, ipcMain, powerMonitor, safeStorage, screen } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDiagnostics } from './diagnostics.mjs';
import { connectionProfile, ServerClient } from './server-client.mjs';
import { serverIdentity, serverProfilePath } from '../shared/server-identity.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const development = !app.isPackaged && process.env.CANGXIA_DEV === '1';
const devOrigin = 'http://127.0.0.1:5173';
const profile = serverProfilePath(app.getPath('appData'));
app.setName(serverIdentity.productName);
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
if (process.platform === 'win32') app.setAppUserModelId(serverIdentity.appId);
if (!app.requestSingleInstanceLock()) app.exit(0);

let gate,
  workspace,
  client,
  quitting = false,
  closing = false;
const alive = (w) => w && !w.isDestroyed();
function discardWorkspace() {
  const old = workspace;
  workspace = null;
  if (!alive(old)) return;
  const session = old.webContents.session;
  old.hide();
  old.webContents.setAudioMuted(true);
  old.webContents.stop();
  old.destroy();
  void Promise.allSettled([session.closeAllConnections(), session.clearCache(), session.clearStorageData()]);
}
function changed(state) {
  if (!state.owned) {
    discardWorkspace();
    if (!quitting && alive(gate)) gate.show();
  }
  for (const window of [gate, workspace])
    if (alive(window)) window.webContents.send('cangxia:server-session', state);
}
function createWindow(role) {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    title: serverIdentity.productName,
    icon: path.join(here, '..', 'assets', 'icon.ico'),
    useContentSize: true,
    width: Math.min(1400, Math.floor(area.width * 0.94)),
    height: Math.min(area.height - 40, Math.floor(area.height * 0.92)),
    show: false,
    backgroundColor: '#f7f8fa',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      partition: 'cangxia-' + role + '-' + randomUUID(),
      additionalArguments: ['--cangxia-window=' + role]
    }
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  // Protected content is fetched by the pinned main-process transport only.
  wc.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      const origin = new URL(details.url).origin;
      const devAsset = development && (origin === devOrigin || origin === 'ws://127.0.0.1:5173');
      callback({ cancel: !devAsset });
    }
  );
  return win;
}
const loadWindow = (win) =>
  development ? win.loadURL(devOrigin) : win.loadFile(path.join(here, '..', 'dist', 'index.html'));
function from(event, window) {
  return (
    alive(window) && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
  );
}
function ipc(name, access, action) {
  ipcMain.handle('cangxia:' + name, async (event, ...args) => {
    try {
      const onGate = from(event, gate),
        onWorkspace = from(event, workspace);
      if (!(access === 'gate' ? onGate : access === 'both' ? onGate || onWorkspace : onWorkspace))
        throw Error('当前窗口无使用权。');
      if (onWorkspace) client.assert();
      return { ok: true, data: await action(...args) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}
async function openWorkspace() {
  const state = await client.acquire(),
    epoch = state.epoch;
  client.assert(epoch);
  const win = createWindow('library');
  workspace = win;
  win.on('close', (event) => {
    if (quitting || workspace !== win) return;
    event.preventDefault();
    void quit();
  });
  win.webContents.on('render-process-gone', () => {
    if (workspace === win) client.lock('资料库窗口已关闭。');
  });
  try {
    await loadWindow(win);
    client.assert(epoch);
    if (workspace !== win) throw Error('资料库已锁定。');
    win.show();
    gate.hide();
  } catch (error) {
    if (client.epoch === epoch) client.lock(error.message);
    throw error;
  }
  return state;
}
async function quit() {
  if (closing) return;
  closing = true;
  quitting = true;
  discardWorkspace();
  try {
    if (client?.state().owned) await client.release();
  } catch {
    /* Outstanding operation identities remain in the encrypted profile. */
  } finally {
    client?.lock();
    app.exit(0);
  }
}

app.on('second-instance', () => {
  const win = alive(workspace) ? workspace : gate;
  if (alive(win)) {
    win.show();
    win.focus();
  }
});
app.on('before-quit', (event) => {
  if (!quitting) {
    event.preventDefault();
    void quit();
  }
});
app.on('window-all-closed', () => {
  if (!quitting) void quit();
});
app
  .whenReady()
  .then(async () => {
    const diagnostics = createDiagnostics(profile);
    diagnostics.record({ event: 'startup', version: serverIdentity.version });
    client = new ServerClient({ profile: connectionProfile(profile, safeStorage), onChange: changed });
    for (const event of ['suspend', 'resume', 'lock-screen'])
      powerMonitor.on(event, () => client.lock('电脑已锁定、睡眠或唤醒，请重新取得使用权。'));
    gate = createWindow('connection');
    ipc('serverIdentity', 'both', () => serverIdentity);
    ipc('serverSession', 'both', () => client.state());
    ipc('serverGateReady', 'gate', () =>
      diagnostics.record({ event: 'startup-stage', name: 'connection-visible' })
    );
    ipc('serverConnect', 'gate', (config) => client.connect(config));
    ipc('serverAcquire', 'gate', openWorkspace);
    ipc('serverRelease', 'workspace', () => client.release());
    ipc('serverReceipt', 'workspace', (id) => client.receipt(id));
    ipc('serverCommand', 'workspace', (command) => client.command(command));
    ipc('state', 'workspace', () => client.query('state'));
    ipc('startupReady', 'workspace', () => true);
    ipc('setTags', 'workspace', (id, tags, entityVersion) =>
      client.command({
        operationId: randomUUID(),
        kind: 'set-tags',
        payload: { id, tags },
        entityVersion
      })
    );
    gate.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        void quit();
      }
    });
    await loadWindow(gate);
    gate.show();
  })
  .catch((error) => {
    console.error('Windows 客户端启动失败', error.message);
    app.exit(1);
  });
