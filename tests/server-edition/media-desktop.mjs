import { app, BrowserWindow, powerMonitor, shell } from 'electron';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.env.CANGXIA_MEDIA_FIXTURE,
  config = JSON.parse(fs.readFileSync(path.join(root, 'connection.json')));
app.setPath('appData', root);
app.commandLine.appendSwitch('disable-gpu');
await import('../../electron/main.mjs');
let win,
  stage = '';
async function wait(check, label) {
  stage = label;
  for (let i = 0; i < 180; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw Error(
    'Timed out: ' +
      label +
      ' ' +
      JSON.stringify(
        BrowserWindow.getAllWindows().map((w) => [
          w.isVisible(),
          w.webContents.getURL(),
          w.webContents.isLoading()
        ])
      )
  );
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
const button = (label) =>
  js(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)} && !b.disabled).click()`
  );
const visible = (selector) =>
  wait(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const escape = () => js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
app.whenReady().then(async () => {
  try {
    await wait(() => {
      win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html'));
      return win && !win.webContents.isLoading();
    }, 'connection');
    const gate = win;
    async function connect() {
      const deadline = Date.now() + 24000;
      for (;;) {
        const epoch = (await gate.webContents.executeJavaScript('window.cangxia.serverSession()')).epoch;
        try {
          await gate.webContents.executeJavaScript(
            `window.cangxia.serverConnect(${JSON.stringify(config)},${epoch})`
          );
          break;
        } catch (e) {
          if (Date.now() > deadline || !e.message.includes('正在使用')) throw e;
          await delay(600);
        }
      }
      await wait(() => {
        win = BrowserWindow.getAllWindows().find((w) => w !== gate && w.isVisible());
        return win;
      }, 'workspace');
      await visible('[data-work-id="41"]');
    }
    await connect();
    await wait(
      () => js('document.querySelector(\'[data-work-id="41"] img\')?.naturalWidth===1'),
      'PNG cover'
    );
    await click('[data-work-id="41"] .cover-button');
    await wait(() => js('document.querySelector(".detail-media video")?.videoWidth===64'), 'H264 metadata');
    await js('var v=document.querySelector("video");v.currentTime=1;v.play()');
    await wait(() => js('v.currentTime>1.15'), 'H264 playback after seek');
    await escape();
    await click('[data-work-id="42"] .cover-button');
    await visible('.asset-strip a');
    await click('.asset-strip a');
    await wait(
      () =>
        js('[...document.querySelectorAll(".image-gallery img")].filter(i=>i.naturalWidth===1).length===2'),
      'gallery PNGs'
    );
    await escape();
    await visible('[aria-label="播放图文配乐"]');
    await click('[aria-label="播放图文配乐"]');
    await wait(() => js('document.querySelector("audio")?.currentTime>0.1'), 'unarchived WAV playback');
    await click('[aria-label="暂停图文配乐"]');
    await wait(
      () => js('!document.querySelector("audio") || document.querySelector("audio").paused'),
      'audio pause'
    );
    await button('保存／补齐 NAS 配乐');
    await wait(() => js('window.cangxia.audioStatus("42").then(s=>s.nasSaved)'), 'permanent NAS audio');
    await escape();
    await button('全部作品');
    await visible('[data-work-id="43"]');
    await button('账号收藏');
    await visible('[data-work-id="43"]');
    await click('[data-work-id="43"] .card-checkbox');
    await button('单独下载');
    await visible('.flat-directory');
    await click('.flat-directory');
    await visible('.picker-address input');
    const dir = path.join(root, 'export');
    await wait(
      () => js('document.querySelector(".file-entries")?.getAttribute("aria-busy")==="false"'),
      'picker ready'
    );
    await js(
      `var input=document.querySelector('.picker-address input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(dir)});input.dispatchEvent(new Event('input',{bubbles:true}));`
    );
    await button('前往');
    await wait(
      () => js(`document.querySelector('.picker-selected strong')?.textContent===${JSON.stringify(dir)}`),
      'chosen output'
    );
    await button('使用此目录');
    await button('开始单独下载');
    await wait(() => js("document.querySelector('.flat-badge')?.textContent==='已完成'"), 'export complete');
    let opened;
    shell.openPath = async (dir) => {
      opened = dir;
      return '';
    };
    await click('.flat-path');
    await wait(() => opened === dir, 'open export folder');
    assert.ok(fs.existsSync(path.join(dir, '0001_样本_43_01.png')));
    await escape();
    await wait(()=>js("window.cangxia.downloadPage({tab:'all'}).then(r=>r.jobs.some(j=>j.id==='audio:42'&&j.downloadState==='complete'))"),'audio finalized');
    const conn=new DatabaseSync(path.join(root,'volume','cangxia-server','library.sqlite'),{readOnly:true});
    const audioFile=path.join(root,'volume','cangxia-server','media',conn.prepare("SELECT relative_path FROM archive_resources WHERE work_id='42' AND key='audio'").get().relative_path);
    conn.close();
    fs.renameSync(audioFile,audioFile+'.fixture');
    await js('window.cangxia.pause()');
    await button('检查与补齐');await button('检查全部文件');
    const marked='input[aria-label="选择作品 42"]';
    await wait(()=>js("document.querySelector('[data-check-state]')?.dataset.checkState==='complete'"),'check complete');
    await click(marked);await button('复查并补齐所选缺失文件');
    await wait(()=>js("!!document.querySelector('[data-repair-job][data-job-state=queued]')"),'repair queued');
    await js("window.cangxia.cancelDownloads(['audio:42'])");
    await wait(()=>js("!!document.querySelector('[data-repair-job][data-job-state=cancelled]')"),'visible result follows queued repair cancellation');
    await escape();fs.renameSync(audioFile+'.fixture',audioFile);await js('window.cangxia.resume()');
    await js("window.cangxia.workDetail('41').then(w=>window.cangxia.reportCoverStatus('41',true,{resourceId:w.mediaCover.resourceId,version:w.mediaCover.version}))");
    assert.equal(await js("window.cangxia.defectOverview({}).then(r=>r.problems.cover)"),1);
    const old = win;
    powerMonitor.emit('resume');
    assert.ok(old.isDestroyed());
    await assert.rejects(gate.webContents.executeJavaScript('window.cangxia.audioStatus("42")'), /无使用权/);
    await connect();
    assert.equal(await js('window.cangxia.state().then(s=>s.flatQueue.batches.length)'), 0);
    await wait(
      () => js('document.querySelector(\'[data-work-id="41"] img\')?.naturalWidth===1'),
      'cache after reconnect'
    );
    await wait(()=>js("window.cangxia.defectOverview({}).then(r=>!r.problems.cover)"),'successful cover on new renderer clears its recorded failure');
    await js(`for(let i=0;i<12;i++)document.querySelector('[data-work-id="41"] img').dispatchEvent(new Event('load'));`);
    await delay(150);
    console.log('MEDIA_DESKTOP_VERIFIED');
    app.exit(0);
  } catch (e) {
    console.error(stage, e);
    if (win && !win.isDestroyed())
      console.error(
        await js(
          'document.body.innerText.slice(-1600)+" "+JSON.stringify([...document.querySelectorAll("video,audio")].map(x=>[x.currentSrc,x.error?.message,x.readyState]))'
        ).catch(() => '')
      );
    app.exit(1);
  }
});
