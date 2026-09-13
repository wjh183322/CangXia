import { BrowserWindow, session } from 'electron';
import { TOTAL, classifyResponse, isDouyinURL, isMediaURL, sleep, parsePlatformJSON, joinPages } from './model.mjs';

export class Collector {
  constructor(store, notify) {
    this.store = store; this.notify = notify; this.window = null; this.busy = false; this.cancelled = false;
    this.status = { phase: 'idle', message: '连接抖音，读取你的收藏', count: 0 };
    this.pages = new Map(); this.collectionPages = new Map(); this.waiters = new Map(); this.requests = new Map();
    this.diagnostics = [];
    this.loginWindowActive = false;
    this.profile = session.fromPartition('persist:cangxia-douyin');
    this.profile.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.profile.setPermissionCheckHandler(() => false);
  }
  update(phase, message, count = this.status.count) { this.status = { phase, message, count }; this.notify(); }
  async ensureWindow(show = true, capture = true) {
    if (this.window && !this.window.isDestroyed()) { if (show) this.window.show(); if(capture)this.enableCapture(this.window); return this.window; }
    const win = new BrowserWindow({ title: '藏匣 · 抖音账号', width: 1180, height: 820, show, autoHideMenuBar: true, backgroundColor: '#141414', webPreferences: { partition: 'persist:cangxia-douyin', nodeIntegration: false, contextIsolation: true, sandbox: true } });
    this.window = win;
    win.on('page-title-updated', event => event.preventDefault());
    win.setTitle('藏匣 · 抖音网页登录（本机独立会话）');
    win.webContents.setWindowOpenHandler(({ url }) => { if (isDouyinURL(url)) void win.loadURL(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => { if (!isDouyinURL(url)) e.preventDefault(); });
    win.webContents.on('will-redirect', (e, url) => { if (!isDouyinURL(url)) e.preventDefault(); });
    win.on('closed', () => { this.window = null; this.cancelled = true; this.update('idle', '抖音窗口已关闭，已读取数据保留'); });
    if(capture)this.enableCapture(win);
    return win;
  }
  enableCapture(win) {
    const dbg = win.webContents.debugger;
    if(dbg.isAttached())return;
    dbg.removeAllListeners('message');
    dbg.attach('1.3');
    void dbg.sendCommand('Network.enable', { maxTotalBufferSize: 60000000, maxResourceBufferSize: 16000000 }).catch(() => this.update('attention', '无法监听抖音页面，请关闭账号窗口后重新打开'));
    dbg.on('message', (_event, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const url = params.request.url;
        if (!isDouyinURL(url) || !/\/aweme\/v1\/web\//.test(url)) return;
        const u = new URL(url); const form = new URLSearchParams(params.request.postData || '');
        this.requests.set(params.requestId, { url, cursor: u.searchParams.get('cursor') ?? form.get('cursor') ?? '0' });
        this.diagnostics.push({ path: u.pathname }); if (this.diagnostics.length > 60) this.diagnostics.shift();
      }
      if (method === 'Network.loadingFailed') this.requests.delete(params.requestId);
      if (method === 'Network.responseReceived' && this.requests.has(params.requestId)) this.requests.get(params.requestId).status=params.response.status;
      if (method === 'Network.loadingFinished' && this.requests.has(params.requestId)) {
        const request = this.requests.get(params.requestId); this.requests.delete(params.requestId);
        void dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then(result => {
          if (request.status === 429) { this.holdAccess(); return; }
          if (request.status && request.status !== 200) return;
          const text = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
          if (text.length > 16000000) return;
          let data; try { data = parsePlatformJSON(text); } catch { if(request.url.includes('/aweme/detail/'))this.diagnostics.push({stage:'detail-body',bytes:text.length,format:'not-json'}); return; }
          if(request.url.includes('/aweme/detail/'))this.diagnostics.push({stage:'detail-response',keys:Object.keys(data),status:data.status_code,message:data.status_msg});
          this.ingest(request.url, request.cursor, data);
        }).catch(e => { if(request.url.includes('/aweme/detail/'))this.diagnostics.push({stage:'detail-error',message:e.message}); });
      }
    });
  }
  async isAuthenticated() {
    const cookies=await this.profile.cookies.get({url:'https://www.douyin.com/'});
    return cookies.some(c=>['sessionid','sessionid_ss'].includes(c.name)&&Boolean(c.value));
  }
  holdAccess() {
    this.store.setSetting('accessHoldUntil',Date.now()+60000);this.store.save();
    this.cancelled=true;this.cancelResolve('抖音提示访问过于频繁，已停止自动操作');
    this.onAccessHold?.();
    this.update('attention','抖音提示访问过于频繁，已停止自动操作。请暂停刷新，待平台恢复后再手动尝试。');
  }
  assertNotCoolingDown() {
    const remaining=Number(this.store.getSetting('accessHoldUntil')||0)-Date.now();
    if(remaining>0)throw new Error(`软件已暂停自动请求，请至少等待 ${Math.ceil(remaining/1000)} 秒再手动尝试。平台限制的恢复时间无法确定。`);
  }
  async open(show = true) {
    if(this.busy||this.waiters.size){this.window?.show();this.update('attention','当前读取尚未结束，请先停止读取再打开登录页面');return;}
    const win = await this.ensureWindow(show,false);
    this.loginWindowActive=true;
    if(win.webContents.debugger.isAttached())win.webContents.debugger.detach();
    this.requests.clear();
    if (!win.webContents.getURL() || win.webContents.getURL()==='about:blank') await this.navigate('https://www.douyin.com/');
    this.update('ready', '请在标题含“藏匣 · 抖音网页登录”的窗口登录；官方抖音客户端的登录状态不共用。');
  }
  async navigate(url) {
    const win = this.window; if (!win || win.isDestroyed()) throw new Error('抖音窗口已关闭');
    // Some third-party resources never finish. Do not let them block the app's controls.
    await Promise.race([win.loadURL(url).catch(e => { if (e.code !== 'ERR_ABORTED') this.update('attention', '页面加载未完成，请检查抖音窗口'); }), sleep(4000)]);
  }
  ingest(url, cursor, data) {
    if (this.closed) return;
    if (/\/user\/profile\/self\//.test(url) && data.user?.uid) {
      const account = { uid: String(data.user.uid), nickname: String(data.user.nickname || '') };
      const old = this.store.getSetting('account');
      if (old && old.uid !== account.uid) { this.accountMismatch = true; this.cancelled = true; this.update('error', '检测到账号切换。为避免混合收藏，请登录原账号。'); return; }
      this.accountMismatch = false;
      this.store.setSetting('account', account); this.store.save(); this.notify(); return;
    }
    const parsed = classifyResponse(url, data); if (!parsed) return;
    if(/访问太频繁|访问过于频繁|操作频繁|请求过于频繁|too many requests/i.test(String(data.status_msg || data.message || ''))){this.holdAccess();return;}
    if (Number(data.status_code || 0) !== 0) {
      // Only explicit platform deletion messages mark invalidity, never auth/rate-limit errors.
      if (parsed.kind === 'detail' && /作品已删除|视频已删除|作品不存在|视频不存在/.test(String(data.status_msg || ''))) {
        const w = this.store.work(parsed.id); if (w) { this.store.put('works', w.id, { ...w, remoteState: 'unavailable', checkedAt: new Date().toISOString() }); this.store.save(); }
        this.finishWaiter(parsed.id, new Error('原作品已失效，已有本地文件已保留'));
      } else {
        this.cancelled=true;this.cancelResolve('抖音返回访问限制或登录提示，已停止自动读取');this.onAccessHold?.();
        this.update('attention', '抖音返回访问限制或登录提示，已停止自动读取，请在抖音窗口处理后手动重试');
      }
      return;
    }
    if (parsed.kind === 'detail') {
      if (!parsed.raw) { this.finishWaiter(parsed.id, new Error('没有取得作品详情，请检查登录或作品状态')); return; }
      this.detailCoverInfo = Object.keys(parsed.raw.video || {}).filter(k=>/cover/i.test(k)).map(key => ({ key, width:parsed.raw.video?.[key]?.width, height:parsed.raw.video?.[key]?.height, paths:(parsed.raw.video?.[key]?.url_list || []).map(value=>{try{return new URL(value).pathname;}catch{return '';}}) }));
      const work = this.store.upsertWork(parsed.raw); this.store.save(); this.notify();
      if (work) this.finishWaiter(work.id, null, work);
      return;
    }
    if (this.accountMismatch) return;
    if (parsed.kind === 'collections') {
      if (!Array.isArray(data.collects_list)) return;
      if (cursor === '0') this.collectionPages.clear();
      this.collectionPages.set(String(cursor), { items: parsed.collections, next: String(data.cursor ?? ''), more: ![false,0].includes(data.has_more) });
      const result = this.chain(this.collectionPages);
      this.store.discoverCollections(result.items, result.complete);
      this.notify(); return;
    }
    const id = String(parsed.collectionId || '');
    if (!this.store.collection(id)?.added || !Array.isArray(data.aweme_list)) return;
    if(id===TOTAL)this.store.setSetting('sessionConnected',true);
    if (!this.pages.has(id) || cursor === '0') this.pages.set(id, new Map());
    const ids = [];
    for (const raw of data.aweme_list) { const w = this.store.upsertWork(raw); if (w) ids.push(w.id); }
    this.pages.get(id).set(String(cursor), { items: ids, next: String(data.cursor ?? data.max_cursor ?? ''), more: ![false,0].includes(data.has_more) });
    const result = this.chain(this.pages.get(id)); result.items = [...new Set(result.items)];
    this.store.ingestMembers(id, result.items, result.complete);
    this.status.count = result.items.length; this.notify();
  }
  chain(pages) {
    return joinPages(pages);
  }
  finishWaiter(id, error, work) {
    const pending = this.waiters.get(id); if (!pending) return;
    this.waiters.delete(id); clearTimeout(pending.timer); clearTimeout(pending.retry); error ? pending.reject(error) : pending.resolve(work);
  }
  cancelResolve(message='操作已停止') { for(const id of [...this.waiters.keys()])this.finishWaiter(id,new Error(message)); }
  dispose() { this.closed=true;this.stop();this.cancelResolve(); }
  async resolveWork(id) {
    this.assertNotCoolingDown();
    if (!/^\d+$/.test(id)) throw new Error('作品 ID 无效');
    if (this.busy) throw new Error('收藏正在同步，请稍后下载');
    if (this.waiters.size) throw new Error('另一条作品正在解析，请稍后重试');
    if(this.loginWindowActive && !(await this.isAuthenticated()))throw new Error('请先在藏匣的抖音网页登录窗口完成登录，避免中断扫码');
    this.loginWindowActive=false;
    const win = await this.ensureWindow(false);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error('作品解析超时，未自动刷新。请检查抖音窗口的登录或访问提示')); }, 30000);
      this.waiters.set(id, { resolve, reject, timer });
    });
    void win.loadURL(`https://www.douyin.com/video/${id}`).catch(() => this.finishWaiter(id, new Error('作品页面无法打开，请检查网络')));
    return result;
  }
  async importLink(text) {
    this.assertNotCoolingDown();
    if(this.loginWindowActive && !(await this.isAuthenticated()))throw new Error('请先完成网页登录，再读取作品链接');
    const match = String(text).match(/https:\/\/[^\s<>\]]+/);
    if (!match || !isDouyinURL(match[0])) throw new Error('请粘贴抖音作品链接或分享文案');
    const direct = match[0].match(/\/video\/(\d+)/);
    if (direct) return this.resolveWork(direct[1]);
    const win = await this.ensureWindow(true);
    await this.navigate(match[0]);
    for (let i = 0; i < 30; i++) {
      const id = win.webContents.getURL().match(/\/video\/(\d+)/)?.[1];
      if (id) { const existing = this.store.work(id); return existing || this.resolveWork(id); }
      await sleep(500);
    }
    throw new Error('分享链接未跳转到作品，请在抖音窗口完成验证后重试');
  }
  async clickText(text) {
    if (!this.window || this.window.isDestroyed()) return false;
    return this.window.webContents.executeJavaScript(`(() => {
      const text = ${JSON.stringify(text)};
      const nodes = Array.from(document.querySelectorAll('[role="tab"],button,a,span,div'));
      const element = nodes.find(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0 && e.textContent.trim() === text && e.children.length < 3);
      if (!element) return false; element.click(); return true;
    })()`);
  }
  stop() { this.cancelled = true; this.update('idle', '已停止，保留已读取的内容'); }
  async sync({ discoverOnly = false } = {}) {
    try{this.assertNotCoolingDown();}catch(e){this.update('attention',e.message);return;}
    if (this.busy || this.waiters.size) throw new Error('已有读取任务正在进行');
    if(!(await this.isAuthenticated())){await this.open();this.update('attention','尚未检测到藏匣的网页登录状态，请先完成登录；没有发起收藏读取。');return;}
    this.loginWindowActive=false;
    this.busy = true; this.cancelled = false; this.pages.clear(); this.collectionPages.clear();
    const failures = [];
    try {
      const win = await this.ensureWindow(true);
      this.update('syncing', '正在打开账号收藏', 0);
      await this.navigate('https://www.douyin.com/user/self');
      let clicked = false;
      for (let i = 0; i < 12 && !this.cancelled; i++) { await sleep(750); clicked = await this.clickText('收藏'); if (clicked) break; }
      if (!clicked) throw new Error('请先在抖音窗口登录，并打开自己的“收藏”页面');
      await sleep(1400);
      if (discoverOnly) {
        await this.clickText('收藏夹');
        const complete=await this.readUntil(TOTAL, true);
        const known = this.store.all('collections').filter(c => c.id !== TOTAL && !c.remoteMissing).length;
        this.update(complete?'done':'attention', complete?`已发现 ${known} 个收藏夹，请选择添加`:`收藏夹目录读取未完成，已发现 ${known} 个。请检查抖音窗口后重试。`); return;
      }
      for (const c of this.store.all('collections').filter(c => c.added && !c.remoteMissing).sort((a,b) => a.rank - b.rank)) {
        if (this.cancelled) break;
        this.update('syncing', `正在读取「${c.name}」`, 0);
        if (c.id !== TOTAL) {
          await this.clickText('收藏夹'); await sleep(800);
          if (!(await this.clickText(c.name))) { failures.push(`${c.name}：请在抖音窗口打开这个收藏夹后重试`); continue; }
        }
        const complete = await this.readUntil(c.id, false);
        if (!complete && !this.cancelled) failures.push(`${c.name}读取未完成`);
        if (c.id !== TOTAL && !this.cancelled) { await this.navigate('https://www.douyin.com/user/self'); await sleep(1500); await this.clickText('收藏'); await sleep(1000); }
      }
      if (this.cancelled) return;
      const errors = this.store.reconcile(); failures.push(...errors);
      this.update(failures.length ? 'attention' : 'done', failures.length ? failures.join('；') : '收藏已同步，本地目录已更新');
    } catch (e) { this.update('attention', e.message); }
    finally { this.busy = false; this.notify(); }
  }
  async readUntil(id, directory) {
    let stagnant = 0, lastCount = -1;
    for (let tick = 0; tick < 600 && !this.cancelled; tick++) {
      const result = this.chain(directory ? this.collectionPages : (this.pages.get(id) || new Map()));
      if (result.complete) return true;
      if (result.items.length === lastCount) stagnant++; else { stagnant = 0; lastCount = result.items.length; }
      if (stagnant > 12) return false;
      if (!this.window || this.window.isDestroyed()) return false;
      await this.window.webContents.executeJavaScript(`(() => {
        const elements = [document.scrollingElement, ...document.querySelectorAll('main,section,div')].filter(Boolean);
        for (const e of elements) {
          const r=e.getBoundingClientRect();
          if(r.width > 250 && r.height > 180 && e.scrollHeight > e.clientHeight + 80 && ['auto','scroll'].includes(getComputedStyle(e).overflowY)) e.scrollBy(0, Math.max(e.clientHeight * .8, 500));
        }
        window.scrollBy(0, innerHeight * .8);
      })()`);
      await sleep(1300);
    }
    return false;
  }
  async fetchMedia(url, options = {}) {
    if (!isMediaURL(url)) throw new Error('媒体来源不受支持');
    // Redirects are checked before each request; cookies remain in the isolated Chromium session.
    let next = url;
    for (let i = 0; i < 6; i++) {
      if (!isMediaURL(next)) throw new Error('媒体跳转到了不受支持的来源');
      const response = await this.profile.fetch(next, { ...options, redirect: 'manual', headers: { Referer: 'https://www.douyin.com/', ...(options.headers || {}) } });
      if (![301,302,303,307,308].includes(response.status)) return response;
      const location = response.headers.get('location'); if (!location) throw new Error('媒体跳转地址缺失');
      next = new URL(location, next).href;
    }
    throw new Error('媒体跳转次数过多');
  }
}
