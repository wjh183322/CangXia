import fs from 'node:fs';import assert from 'node:assert/strict';
export async function checkReadHistoryDesktop({win,check,originalVisits}){
 const originalSize=win.getContentSize();win.setContentSize(1100,640);
 const js=s=>win.webContents.executeJavaScript(s,true),sleep=()=>new Promise(r=>setTimeout(r,60));
 const wait=async expression=>{for(let i=0;i<60;i++){if(await js(expression))return;await sleep();}throw Error('Missing history desktop state: '+expression+' '+JSON.stringify(await js(`({title:document.querySelector('h1')?.textContent,modal:document.querySelector('.modal')?.getAttribute('aria-label'),toast:document.querySelector('.toast')?.textContent,cards:[...document.querySelectorAll('.work-card')].map(n=>({id:n.dataset.workId,class:n.className}))})`)));};
 await js(`document.querySelector('.read-log-nav').click()`);await wait(`!!document.querySelector('.read-log-runs>button')`);
 await js(`document.querySelector('.read-log-runs>button').click()`);await wait(`!!document.querySelector('[aria-label="在列表里显示作品 503"]')`);
 const counts=await js(`document.querySelector('.read-log-counts').textContent`);
 check('native history shows reads, disjoint discoveries and unchanged existing records',counts.includes('本轮读取 4')&&counts.includes('前面新增 1')&&counts.includes('本轮补齐 1')&&counts.includes('本轮新增 2')&&counts.includes('已有记录 2'));
 await js(`document.querySelector('[aria-label="打开抖音作品 601"]').click()`);await sleep();check('native log original button opens the correct official work URL',originalVisits.at(-1)==='https://www.douyin.com/video/601');
 fs.writeFileSync('.test-output/read-log-ui-desktop.png',(await win.webContents.capturePage()).toPNG());
 await js(`document.querySelector('[aria-label="在列表里显示作品 503"]').click()`);await wait(`!!document.querySelector('.work-card.located[data-work-id="503"]')`);
 await wait(`(()=>{const n=document.querySelector('.work-card.located');if(!n)return false;const r=n.getBoundingClientRect(),s=document.querySelector('.work-scroll').getBoundingClientRect();return r.top+r.height/2>=s.top-1&&r.top+r.height/2<=s.bottom+1;})()`);
 const result=await js(`(()=>{const r=document.querySelector('.work-card.located').getBoundingClientRect(),s=document.querySelector('.work-scroll').getBoundingClientRect();return {ids:[...document.querySelectorAll('.work-card')].map(n=>n.dataset.workId),overlay:!!document.querySelector('.modal'),viewer:!!document.querySelector('.viewer'),selected:!!document.querySelector('.work-card.selected'),visible:r.top+r.height/2>=s.top-1&&r.top+r.height/2<=s.bottom+1,page:document.querySelector('[aria-label="顶部跳转页码"]').value};})()`);
 assert.deepEqual(result.ids,['601','123','503','501','502']);check('native location preserves actual neighbors and only highlights the visible card',result.visible&&!result.overlay&&!result.viewer&&!result.selected&&result.page==='1');
 fs.writeFileSync('.test-output/read-log-location-desktop.png',(await win.webContents.capturePage()).toPNG());win.setContentSize(...originalSize);
}
