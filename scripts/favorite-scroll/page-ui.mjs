// This function is serialized into the explicitly launched, dedicated browser.
// It only observes links and scrolls the user-selected list. It never clicks posts.
export function installFavoriteScroller(){
  if(location.hostname!=='www.douyin.com'||window.__cangxiaScroll)return;
  const api={phase:'idle',message:'登录抖音，打开「我 → 收藏」后，先点“选取列表”。',steps:0,observed:new Set(),scopeURL:null,target:null,interval:3500,lastGrowth:Date.now(),lastMetric:null,server:null,lastTick:0};window.__cangxiaScroll=api;
  const host=document.createElement('div');host.id='cangxia-favorite-scroll';host.style.cssText='position:fixed;right:20px;top:88px;width:304px;z-index:2147483647';
  const root=host.attachShadow({mode:'open'});root.innerHTML=`<style>:host{font:13px/1.7 system-ui;color:#334155}*{box-sizing:border-box}section{background:#fff;border:1px solid #e4e8ef;border-radius:14px;box-shadow:0 10px 50px #0003;padding:18px}h3{margin:0 0 8px;font-size:16px}p{margin:10px 0;color:#6c7a90;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}b{color:#f45f4d}button,select{font:inherit;border-radius:7px;border:1px solid #e2e7ee;padding:7px 9px;background:white;color:#607089;cursor:pointer}button:disabled{opacity:.45;cursor:default}.primary{background:#f65f4c;color:white;border-color:#f65f4c}.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.metric{background:#f6f8fb;padding:10px;border-radius:9px}.tiny{font-size:11px;color:#94a0b2}select{max-width:100%}</style><section><h3>收藏网页自动翻页</h3><div class="metric"><b id="count">0</b> 个作品 · <span id="pages">0</span> 页<br/><span class="tiny" id="dom">尚未开始</span></div><p id="message"></p><div class="row"><button id="pick">选取列表</button><button id="start" class="primary">开始自动翻页</button><button id="pause">暂停</button></div><div class="row"><select id="speed" aria-label="翻页间隔"><option value="3500">每 3.5 秒滚动一次</option><option value="6000">每 6 秒滚动一次</option><option value="10000">每 10 秒滚动一次</option></select></div><p class="tiny">进度自动保存在本机。请保持此标签页打开；开始后不要切换收藏夹或账号。可随时暂停。</p></section>`;
  const $=id=>root.getElementById(id);const visible=el=>{const r=el.getBoundingClientRect();return r.width>20&&r.height>20&&getComputedStyle(el).visibility!=='hidden';};
  function paint(){$('message').textContent=api.message;$('count').textContent=String(api.server?.uniqueWorks||0);$('pages').textContent=String(api.server?.pages||0);$('dom').textContent=`滚动 ${api.steps} 次 · 页面累计见到 ${api.observed.size} 个作品链接`;$('start').disabled=!api.target||api.phase==='running';$('pick').disabled=api.phase==='running';$('pause').disabled=api.phase!=='running';}
  function pause(message,phase='paused'){api.phase=phase;api.message=message;paint();}api.pause=pause;
  function links(){if(!api.target)return;const scope=api.target===document.scrollingElement?document.body:api.target;for(const a of scope.querySelectorAll('a[href]')){const m=a.getAttribute('href')?.match(/\/(?:video|note)\/(\d+)/);if(m)api.observed.add(m[1]);}}
  function scrollParent(el){for(let p=el;p&&p!==document.body;p=p.parentElement){const style=getComputedStyle(p);if(/auto|scroll|overlay/.test(style.overflowY)&&p.clientHeight>150)return p;}return document.scrollingElement;}
  function choose(e){if(e.composedPath().includes(host))return;e.preventDefault();e.stopImmediatePropagation();document.removeEventListener('click',choose,true);const target=scrollParent(e.target);if(!target||!visible(target)){pause('没有找到可滚动列表，请重新选取作品区域。');return;}api.target=target;api.scopeURL=location.href;links();pause('列表已选取。确认当前是总收藏页面，然后点击“开始自动翻页”。');}
  $('pick').onclick=()=>{api.phase='picking';api.message='请点击收藏作品列表里的空白处或任意卡片，只选择列表，不会打开作品。';document.addEventListener('click',choose,true);paint();};
  $('start').onclick=()=>{if(!api.target?.isConnected)return pause('列表已变化，请重新选取。');if(location.href!==api.scopeURL)return pause('页面已经切换，请重新选取总收藏列表。');if(!api.server?.hasFirstPage)return pause('尚未观察到总收藏第一页。请刷新网页后重新打开“收藏”，等待作品出现，再选取列表。');api.phase='running';api.lastGrowth=Date.now();api.lastTick=0;api.lastMetric=null;api.message='正在自动翻页；网页要求验证时，请先暂停并完成验证。';paint();};
  $('pause').onclick=()=>pause('已暂停，当前观察记录保留。');$('speed').onchange=e=>{api.interval=Number(e.target.value);};
  api.update=state=>{api.server=state;paint();};
  api.state=()=>({phase:api.phase,message:api.message,steps:api.steps,observedCount:api.observed.size,selected:!!api.target,page:location.origin+location.pathname});
  api.tick=()=>{
    if(api.phase!=='running')return api.state();
    if(Date.now()-api.lastTick<api.interval)return api.state();api.lastTick=Date.now();
    if(location.href!==api.scopeURL||!api.target?.isConnected){pause('页面或列表发生变化，已暂停，请回到总收藏后重新选取。');return api.state();}
    if(api.server?.serverEnd){pause('网页收藏接口已明确返回末页，连续翻页链已记录。请查看本机翻页记录。','finished');return api.state();}
    const dialogs=[...document.querySelectorAll('[role="dialog"],dialog[open]')].filter(visible);
    if(dialogs.some(el=>/身份验证|安全验证|验证码|扫码登录|访问频繁|操作频繁/.test(el.innerText))){pause('网页出现登录、验证或访问提示，已暂停；请在网页手动处理。');return api.state();}
    links();const t=api.target,metric=`${api.observed.size}:${t.scrollHeight}:${Math.round(t.scrollTop)}:${api.server?.uniqueWorks||0}`;
    if(api.lastMetric!==metric){api.lastGrowth=Date.now();api.lastMetric=metric;}
    if(Date.now()-api.lastGrowth>120000){pause('连续两分钟没有新的页面进展，已暂停。这不代表收藏已读全；请检查网页是否需要验证或重试加载。','stalled');return api.state();}
    if(!api.observed.size&&api.steps>=8&&!(api.server?.pages>0)){pause('没有观察到收藏作品或收藏接口，请确认选择的是总收藏列表。','stalled');return api.state();}
    const step=Math.max(180,Math.floor(t.clientHeight*.78));t.scrollBy({top:step,left:0,behavior:'instant'});api.steps++;paint();return api.state();
  };
  const mount=()=>{if(!host.isConnected&&document.documentElement)document.documentElement.append(host);paint();};if(document.documentElement)mount();else document.addEventListener('DOMContentLoaded',mount,{once:true});
}
