import { app, BrowserWindow, powerMonitor, shell } from 'electron';
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
              "({role:window.cangxia?.windowRole,status:document.querySelector('[role=status]')?.textContent, modal:document.querySelector('.modal')?.textContent?.slice(-300),toast:document.querySelector('.toast')?.textContent,selection:document.querySelector('.selection-dock')?.textContent})"
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
    assert.ok(await js(win,"[...document.querySelectorAll('button')].some(b=>b.textContent==='在独立窗口查看验证')"));
    await js(win,"[...document.querySelectorAll('button')].find(b=>b.textContent==='在独立窗口查看验证').click()");
    const detached=await waitFor(()=>BrowserWindow.getAllWindows().find(w=>w!==win&&w!==gate&&w.isVisible()));
    await waitFor(()=>js(detached,"!!document.querySelector('img[alt=抖音官方登录二维码]')"));
    await assert.rejects(js(detached,'window.cangxia.state()'),/无使用权/);
    detached.close();
    await js(
      win,
      `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('核验账号')).click()`
    );
    await waitFor(() => js(win, "document.querySelector('.account-button')?.textContent.includes('样本')"));
    assert.equal(await js(win, 'window.cangxia.state().then(s=>s.account.uid)'), '7345612390836712341');
    let opened;
    shell.openExternal = async (url) => {
      opened = url;
    };
    const click = async (label) =>
      waitFor(() =>
        js(
          win,
          `(()=>{const b=[...document.querySelectorAll('button')].find(x=>!x.disabled&&(x.textContent.trim()===${JSON.stringify(label)}||x.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)return false;b.click();return true;})()`
        )
      ).catch(e=>{throw Error(label+'\n'+e.message);});
    const scenario = (name) => fs.writeFileSync(path.join(root, 'scenario'), name);
    const hits = (name, route) =>
      fs
        .readFileSync(path.join(root, 'requests'), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith(name + ' ') && line.includes(route));
    await click('添加收藏夹');
    scenario('stop-folders');
    await click('读取账号里的收藏夹');
    await waitFor(
      () => fs.existsSync(path.join(root, 'requests')) && hits('stop-folders', 'collects/list/').length === 1
    );
    await click('停止读取');
    await waitFor(() => js(win, "!document.querySelector('.read-progress')"));
    assert.equal(await js(win, "window.cangxia.state().then(s=>s.collections.some(c=>c.id==='55'))"), false);
    scenario('normal');
    await click('读取账号里的收藏夹');
    await waitFor(() =>
      js(
        win,
        "(()=>{const el=[...document.querySelectorAll('label')].find(l=>l.textContent.includes('离线夹'));if(!el)return false;el.querySelector('input').click();return true;})()"
      )
    );
    await click('添加 1 个收藏夹');
    async function run() {
      await click('同步收藏');
      await js(win, "document.querySelector('[aria-label=同步自建收藏夹]').click()");
      await js(win, "document.querySelector('.collection-read-full').open=true");
      await click('从头完整核对');
      await waitFor(() => js(win, "!!document.querySelector('.collection-batch-results')"));
    }
    await run();
    await click('关闭');
    for (const source of [
      { kind: 'total', id: '__all__' },
      { kind: 'collection', id: '77' }
    ]) {
      const key=source.kind==='total'?'total':'folder:'+source.id;
      await js(win,`(async()=>{const source=${JSON.stringify(key)},api=window.cangxia;const {revision,scope}=await api.listWorks({source});const {token}=await api.previewRemoval({scope:'membership',selection:{source,revision,scope,all:false,ids:['9191']}});await api.confirmRemoval({token});})()`);
    }
    await run();
    await click('查看读取日志');
    await waitFor(() =>
      js(
        win,
        "(()=>{const b=document.querySelector('.read-log-runs button');if(!b)return false;b.click();return true;})()"
      )
    );
    await waitFor(() =>
      js(
        win,
        "(()=>{const b=document.querySelector('.read-log-group .read-log-runs button');if(!b)return false;b.click();return true;})()"
      )
    );
    await click('本轮恢复');
    await click('打开抖音作品 9191');
    await waitFor(() => opened === 'https://www.douyin.com/video/9191');
    await assert.rejects(js(win, "window.cangxia.openOriginal('https://evil.invalid')"));
    await click('关闭');
    const fill = async (selector, value) =>
      js(
        win,
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
      );
    await click('作品链接');
    await fill('textarea.link-input', 'https://www.douyin.com/video/9192');
    await click('读取作品');
    await waitFor(() =>
      js(win, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('打开抖音原作品'))")
    );
    await click('关闭弹窗');
    for (const wasLinked of [true, false]) {
      scenario('fail-total');
      await js(win, `window.cangxia.sync({collectionId:'__all__',mode:'full',syncCollections:${wasLinked}})`);
      scenario('restart-' + wasLinked);
      await click('同步收藏');
      if (!wasLinked) await js(win, "document.querySelector('[aria-label=同步自建收藏夹]').click()");
      await js(win, "document.querySelector('.collection-read-full').open=true");
      await click('从头完整核对');
      await click('确认从头读取');
      if (wasLinked) {
        await waitFor(() => js(win, "!!document.querySelector('.read-result')"));
        await click('完成');
      } else {
        await waitFor(() => js(win, "!!document.querySelector('.collection-batch-results')"));
        await click('关闭');
      }
      assert.equal(hits('restart-' + wasLinked, 'collects/video/list/').length, wasLinked ? 0 : 1);
    }
    scenario('two-folders');
    await click('添加收藏夹');
    await click('读取账号里的收藏夹');
    await waitFor(() =>
      js(
        win,
        "(()=>{const l=[...document.querySelectorAll('label')].find(l=>l.textContent.includes('第二夹'));if(!l)return false;l.querySelector('input').click();return true;})()"
      )
    );
    await click('添加 1 个收藏夹');
    scenario('bad-folders');
    await js(win, "window.cangxia.sync({allAdded:true,mode:'full'})");
    scenario('retry-second');
    await waitFor(() =>
      js(
        win,
        "(()=>{const b=[...document.querySelectorAll('button.collection-nav')].find(b=>b.textContent.includes('第二夹'));if(!b)return false;b.click();return true;})()"
      )
    );
    await click('同步收藏');
    await click('继续完整核对');
    await waitFor(() => js(win, "!!document.querySelector('.read-result')"));
    await click('完成');
    const retried = hits('retry-second', 'collects/video/list/');
    assert.equal(retried.length, 1);
    assert.match(retried[0], /collects_id=78/);
    await click('作者作品');
    await click('添加作者');
    await fill('#author-link', 'https://www.douyin.com/user/MS4wLjABsynthetic001');
    scenario('stop-author');
    await click('核对并添加作者');
    await waitFor(() => hits('stop-author', 'profile/other/').length === 1);
    await click('停止读取');
    await waitFor(() => js(win, "!document.querySelector('.read-progress')"));
    assert.equal(await js(win, 'window.cangxia.state().then(s=>s.authors.length)'), 0);
    scenario('normal');
    await click('添加作者');
    await fill('#author-link', 'https://www.douyin.com/user/MS4wLjABsynthetic001');
    await click('核对并添加作者');
    await click('从头读取 20 条');
    await waitFor(() => js(win, "!!document.querySelector('.read-result')"));
    assert.equal(await js(win, "document.querySelector('.read-result h3').textContent"), '本段读取完成');
    await click('查看读取日志');
    await waitFor(() =>
      js(
        win,
        "(()=>{const b=document.querySelector('.read-log-runs button');if(!b)return false;b.click();return true;})()"
      )
    );
    await click('在列表里显示作品 9200');
    await waitFor(() =>
      js(
        win,
        `!document.querySelector('.read-history-dialog')&&!!document.querySelector('[data-work-id="9200"].located')`
      )
    );
    await click('读取作者作品');
    await click('继续读到末尾');
    await waitFor(() => js(win, "document.querySelector('.read-result h3')?.textContent==='本轮读取完成'"));
    await click('完成');
    scenario('shrink-author');
    await click('读取作者作品');
    await click('从头全部读取');
    await waitFor(() =>
      js(win, "document.querySelector('.read-result')?.textContent.includes('本轮返回数量明显减少')")
    );
    assert.equal(await js(win, "document.querySelector('.read-result h3').textContent"), '本轮读取完成');
    assert.equal(hits('stop-folders', 'collects/list/').length, 1);
    await click('移除作者');
    await js(win,"document.querySelector('.modal-footer .primary').click()");
    await waitFor(()=>js(win,"!document.querySelector('.author-nav-list .collection-nav')"));
    await click('添加作者');
    await fill('#author-link','https://www.douyin.com/user/MS4wLjABsynthetic001');
    await click('核对并添加作者');
    await waitFor(()=>js(win,"!!document.querySelector('.author-nav-list .collection-nav')"));
    assert.equal(await js(win,"window.cangxia.listWorks({source:'author:MS4wLjABsynthetic001'}).then(r=>r.ids.includes('9200'))"),true);
    await js(win,"document.querySelector('.author-nav-list .collection-nav').click()");
    await waitFor(()=>js(win,`(()=>{const b=document.querySelector('[data-work-id="9200"] .card-checkbox');if(!b)return false;b.click();return true;})()`));
    await click('下载所选作品');
    await click('只下载未保存的 1 个');
    await waitFor(()=>js(win,"!document.querySelector('.modal')&&!document.querySelector('.selection-dock')"));
    await js(win,"document.querySelector('.downloads-nav').click()");
    await click('已下载 · 1');
    await waitFor(()=>js(win,"document.querySelector('.job-title')?.textContent.includes('作者样本')"));
    await js(win,`(()=>{const el=document.querySelector('[aria-label="同时下载作品数"]');el.value='2';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(()=>js(win,"window.cangxia.state().then(s=>s.queue.concurrency===2)"));
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
