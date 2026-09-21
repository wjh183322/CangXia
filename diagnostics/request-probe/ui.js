const $=id=>document.getElementById(id);let state={},pending=false;
const names={success:'成功',denied:'被拒绝',limited:'访问频繁',redirect:'发生跳转','business-error':'平台提示',error:'未成功'};
function render(next){state=next;const running=state.phase==='running';$('status').textContent=state.message||'';$('open').disabled=pending||running;$('browser').disabled=pending||running;$('run').disabled=pending||running||!state.browserReady||!$('confirmed').checked;$('stop').disabled=!running;$('save').disabled=running||!state.report;
 $('results').replaceChildren();for(const r of state.results||[]){const tr=document.createElement('tr');for(const value of [r.route==='direct'?'当前软件方式':'浏览器页面方式',r.httpStatus||'—',r.items??'—',(names[r.outcome]||'未成功')+(r.businessCode?` (${r.businessCode})`:''),r.route==='direct'?'未添加':r.signatureKeys.join(', ')||'未观察到']){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}$('results').append(tr);}}
async function action(fn){pending=true;render(state);$('save-status').textContent='';try{await fn();}catch{$('save-status').textContent='操作未完成。请先在专用浏览器完成登录并打开收藏；两次测试至少间隔一分钟。';}finally{pending=false;render(await window.probe.state());}}
$('open').onclick=()=>action(async()=>{$('confirmed').checked=false;await window.probe.open($('browser').value);});
$('run').onclick=()=>action(()=>window.probe.run($('confirmed').checked));
$('stop').onclick=()=>window.probe.stop();
$('save').onclick=()=>action(async()=>{if(await window.probe.save())$('save-status').textContent='报告已保存，可以把这个 JSON 文件发回给我。';});
$('confirmed').onchange=()=>render(state);window.probe.onState(render);render(await window.probe.state());
