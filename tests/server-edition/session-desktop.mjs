// Launched only by the Windows integration test, using its private temporary profile.
import {auditEntrypoints} from './compatibility-audit.mjs';
import { app, BrowserWindow, powerMonitor, shell, ipcMain, dialog } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.env.CANGXIA_SESSION_FIXTURE;
const config = JSON.parse(fs.readFileSync(path.join(root, 'connection.json'), 'utf8'));
app.setPath('appData', root);
app.commandLine.appendSwitch('disable-gpu');
// Hold only the specified fixture request after the normal HTTPS operation has completed.
const handle=ipcMain.handle.bind(ipcMain);
const channels=new Set();
let hold;
ipcMain.handle=(name,fn)=>{channels.add(name.slice('cangxia:'.length));return handle(name,async(event,...args)=>{
  const result=await fn(event,...args);
  if(name==='cangxia:workDetail'&&hold?.id===args[0]&&!hold.release){
    const pending=hold;
    await new Promise(resolve=>{pending.release=resolve;});
  }
  return result;
});};
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
    ipcMain.handle=handle;
    const exposed=await js(win,"Object.keys(window.cangxia).filter(k=>typeof window.cangxia[k]==='function')");
    const audit=auditEntrypoints(channels,exposed);
    assert.equal(audit.rows,142);assert.equal(audit.migration,8);
    await waitFor(()=>js(win,"document.querySelectorAll('[data-work-id]').length===20"));
    const buttonText=label=>js(win,`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)})?.click()`);
    await buttonText('检查与补齐');
    await waitFor(()=>js(win,"document.querySelector('[data-maintenance-history]')"));
    await buttonText('检查全部文件');
    await waitFor(()=>js(win,"document.querySelector('[data-check-state]')?.dataset.checkState==='complete'"));
    assert.ok(await js(win,"document.querySelector('[role=dialog]').textContent.includes('登记')"));
    let chosen=0;
    const destination=path.join(root,'selected-diagnostic.json'),save=dialog.showSaveDialog;
    dialog.showSaveDialog=async()=>++chosen===1?{canceled:true}:{canceled:false,filePath:destination};
    await buttonText('导出诊断');await waitFor(()=>chosen===1);assert.ok(!fs.existsSync(destination));
    await buttonText('导出诊断');await waitFor(()=>fs.existsSync(destination));
    assert.match(JSON.parse(fs.readFileSync(destination)).workId,/^\d+$/);assert.ok(!fs.readFileSync(destination,'utf8').includes(config.token));
    dialog.showSaveDialog=save;
    await js(win,"document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await waitFor(()=>js(win,"!document.querySelector('[role=dialog]')"));
    await waitFor(()=>js(win,"document.querySelectorAll('[data-work-id]').length===20"));
    const clickText=label=>js(win,`[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(label)})).click()`);
    await clickText('全部结果全选');
    await waitFor(()=>js(win,"document.querySelector('.selection-dock')?.textContent.includes('42')"));
    await js(win,"document.querySelector('[aria-label=顶部下一页]').click()");
    await waitFor(()=>js(win,"!!document.querySelector('[data-work-id=\"9007199254740993143\"]')"));
    await js(win,"document.querySelector('[data-work-id=\"9007199254740993143\"] .card-checkbox').click()");
    await waitFor(()=>js(win,"document.querySelector('.selection-dock')?.textContent.includes('41')"));
    await js(win,`document.querySelector('[data-work-id="9007199254740993143"] .cover-button').click()`);
    await waitFor(()=>js(win,"document.querySelector('.detail-type')?.textContent.includes('9007199254740993143')"));
    let original;
    shell.openExternal=async url=>{original=url;};
    await js(win,"window.cangxia.openOriginal('9007199254740993143')");
    assert.equal(original,'https://www.douyin.com/note/9007199254740993143');
    await js(win,"window.cangxia.openOriginal('9007199254740993999')");
    assert.equal(original,'https://www.douyin.com/video/9007199254740993999');
    await js(win,"document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await waitFor(()=>js(win,"!document.querySelector('.detail-type')"));
    assert.equal(await js(win,"document.querySelector('[aria-label=顶部跳转页码]').value"),'2');
    await clickText('全部作品');
    await waitFor(()=>js(win,"document.querySelector('.list-footer')?.textContent.includes('44')"));
    await clickText('账号收藏');
    await waitFor(()=>js(win,"document.querySelector('.list-footer')?.textContent.includes('42')"));
    assert.equal(await js(win,"!!document.querySelector('.selection-dock')"),false,'returning to the previous source must clear its old select-all and exceptions');
    await clickText('全部结果全选');
    const setSearch=text=>js(win,`var e=document.querySelector('[aria-label="搜索作品、作者或标签"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));`);
    await setSearch('目录 40');
    await waitFor(()=>js(win,"document.querySelectorAll('[data-work-id]').length===1"));
    await setSearch('');
    await waitFor(()=>js(win,"document.querySelectorAll('[data-work-id]').length===20"));
    assert.equal(await js(win,"!!document.querySelector('.selection-dock')"),false,'clearing search must not revive the old selection');
    await clickText('NAS 媒体库');
    const clickWork=index=>js(win,`document.querySelectorAll('.cover-button')[${index}].click()`);
    await waitFor(()=>js(win,"document.querySelectorAll('[data-work-id]').length===4"));
    await clickWork(1);
    await waitFor(()=>js(win,"document.querySelector('.viewer header strong')?.textContent==='目录 1'"));
    const down=()=>js(win,"document.querySelector('[aria-label=下一个作品]').click()");
    const up=()=>js(win,"document.querySelector('[aria-label=上一个作品]').click()");
    hold={id:'9007199254740993125'};await down();await waitFor(()=>hold.release);
    await js(win,"document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await waitFor(()=>js(win,"!document.querySelector('.viewer')"));hold.release();await delay(120);
    assert.equal(await js(win,"!!document.querySelector('.viewer')"),false,'late arrow response reopened a closed viewer');
    hold=undefined;await clickWork(1);
    await waitFor(()=>js(win,"document.querySelector('.viewer header strong')?.textContent==='目录 1'"));
    hold={id:'9007199254740993125'};await down();await waitFor(()=>hold.release);
    await up();
    await waitFor(()=>js(win,"document.querySelector('.viewer header strong')?.textContent==='目录 0'"));
    hold.release();await delay(120);
    assert.equal(await js(win,"document.querySelector('.viewer header strong').textContent"),'目录 0','an older arrow response replaced the latest destination');
    await js(win,"document.querySelector('[aria-label=关闭浏览模式]').click()");
    await clickText('全部作品');
    await waitFor(()=>js(win,"document.querySelector('.list-footer')?.textContent.includes('44')"));
    const {openLibrary}=await import('../../server/library.mjs');
    const external=openLibrary({root:path.join(root,'volume')});
    external.write(db=>db.prepare('INSERT INTO works VALUES(?,?,?)').run('9812345678912345678','新资料','{"type":"video"}'));
    external.close();
    const heading=await js(win,"document.querySelector('.heading-actions').textContent");
    assert(!heading.includes('打开保存目录'));
    await clickText('刷新资料库');
    await waitFor(()=>js(win,"document.querySelector('.list-footer')?.textContent.includes('45')"));
    await js(win,"document.querySelector('[data-work-id] .card-checkbox').click()");
    await clickText('移除作品记录');
    await waitFor(()=>js(win,"document.body.innerText.includes('回执保存作品')"));
    await clickText('确认移除作品记录');
    await waitFor(()=>js(win,"document.body.innerText.includes('删除与恢复记录') && document.body.innerText.includes('预览恢复')"));
    await clickText('预览恢复');
    await waitFor(()=>js(win,"document.body.innerText.includes('确认恢复作品记录')"));
    await clickText('确认恢复作品记录');
    await waitFor(()=>js(win,"document.body.innerText.includes('已还原')"));
    await js(win,"document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await waitFor(()=>js(win,"!document.querySelector('[role=dialog]')"));
    const receipt = await js(win, "window.cangxia.setTags('99',['fixture-tag'],0)");
    assert.equal(receipt.entityVersion, 1);
    await js(win, `document.querySelector('button[aria-label="设置"]').click()`);
    await waitFor(() => js(win, 'document.body.innerText.includes("查询 NAS 回执")'));
    assert.equal(await js(win,"typeof window.cangxia.importLoginConfig"),'undefined');
    assert.ok(await js(win,"document.querySelector('[role=dialog]').textContent.includes('在 NAS 官方登录并核验账号')"));
    await buttonText('刷新存储占用');
    await waitFor(()=>js(win,"document.querySelector('[role=dialog]').textContent.includes('NAS 统计已完成')"));
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
