// Minimal DOM scrolling only. No network interception or work-data collection.
export function installFavoriteScroller(){
  if(location.hostname!=='www.douyin.com'||window.__cangxiaScroll)return;
  const api={phase:'idle',message:'打开「我 → 收藏」，点击开始即可。',target:null,scopeURL:null,speed:1800,frameID:null,lastFrame:null,bottomSince:null,lastHeight:null,lastPaint:0};
  window.__cangxiaScroll=api;
  const host=document.createElement('div');host.id='cangxia-favorite-scroll';host.style.cssText='position:fixed;right:20px;top:88px;width:260px;z-index:2147483647';
  const root=host.attachShadow({mode:'open'});
  root.innerHTML=`<style>:host{font:13px/1.7 system-ui;color:#334155}*{box-sizing:border-box}section{background:#fff;border:1px solid #e4e8ef;border-radius:13px;box-shadow:0 8px 35px #0002;padding:17px}h3{margin:0 0 8px;font-size:15px}p{margin:9px 0;color:#738096;font-size:12px}button,select{font:inherit;border:1px solid #e3e8ee;border-radius:7px;background:white;color:#65748a;padding:7px 10px;cursor:pointer}button:disabled{opacity:.45;cursor:default}.primary{background:#f65f4c;color:white;border-color:#f65f4c}.row{display:flex;gap:9px;margin-top:12px}select{width:100%}.hint{font-size:11px;color:#95a0af}</style><section><h3>收藏自动翻页</h3><p id="message"></p><div class="row"><button id="start" class="primary">开始</button><button id="pause">暂停</button></div><div class="row"><select id="speed" aria-label="滚动速度"><option value="600">舒缓</option><option value="1800" selected>快速</option><option value="3000">更快</option></select></div><p class="hint">底部 60 秒没有变化会暂停，方便比对最后一个作品。操作网页前先暂停。</p></section>`;
  const $=id=>root.getElementById(id);
  const visible=el=>{const r=el.getBoundingClientRect();return r.width>20&&r.height>20&&getComputedStyle(el).visibility!=='hidden';};
  function paint(){$('message').textContent=api.message;$('start').disabled=api.phase==='running';$('pause').disabled=api.phase!=='running';}
  function pause(message='已暂停，可以查看作品。',phase='paused'){api.phase=phase;api.message=message;if(api.frameID!==null)cancelAnimationFrame(api.frameID);api.frameID=null;api.lastFrame=null;paint();}
  api.pause=pause;
  function locate(){
    const tab=[...document.querySelectorAll('[role="tab"][aria-selected="true"]')].find(el=>el.textContent.trim()==='收藏'&&visible(el));
    if(!tab){pause('请先进入自己的收藏作品列表。');return false;}
    const links=scope=>[...scope.querySelectorAll('a[href]')].filter(el=>/\/(?:video|note)\/\d+/.test(el.getAttribute('href'))&&visible(el));
    let pane=document.getElementById(tab.getAttribute('aria-controls'));
    if(!pane||!links(pane).length){const groups=new Map();for(const a of links(document)){const list=a.closest('ul,[role="list"],[role="grid"]');if(list)groups.set(list,(groups.get(list)||0)+1);}const candidates=[...groups].sort((a,b)=>b[1]-a[1]);if(!candidates.length||(candidates[1]&&candidates[0][1]===candidates[1][1])){pause('请等待收藏卡片出现后再开始。');return false;}pane=candidates[0][0];}
    const card=links(pane)[0];if(!card){pause('请在收藏中选择“视频”，等待列表加载。');return false;}
    let target=null;for(let p=card;p&&p!==document.body;p=p.parentElement)if(/auto|scroll|overlay/.test(getComputedStyle(p).overflowY)&&p.clientHeight>150){target=p;break;}
    target??=document.scrollingElement;if(!target||!visible(target)){pause('没有找到可滚动列表，请稍后重试。');return false;}
    api.target=target;api.scopeURL=location.href;return true;
  }
  function schedule(){if(api.phase!=='running'||api.frameID!==null)return;api.frameID=requestAnimationFrame(now=>{api.frameID=null;api.frame(now);schedule();});}
  $('start').onclick=()=>{if(!locate())return;api.phase='running';api.lastFrame=null;api.bottomSince=null;api.lastHeight=null;api.lastPaint=0;api.message='正在连续翻页…';paint();schedule();};
  $('pause').onclick=()=>pause();$('speed').onchange=e=>{const speed=Number(e.target.value);if([600,1800,3000].includes(speed))api.speed=speed;};
  const guard=e=>{if(api.phase==='running'&&!e.composedPath().includes(host)){e.preventDefault();e.stopImmediatePropagation();}};
  const guarded=['pointerdown','mousedown','click','dblclick','auxclick'];for(const name of guarded)window.addEventListener(name,guard,true);
  api.frame=now=>{
    if(api.phase!=='running')return;
    if(location.href!==api.scopeURL||!api.target?.isConnected){pause('页面已变化，已暂停。回到收藏后可继续。');return;}
    const gap=api.lastFrame===null?1000/60:Math.max(0,now-api.lastFrame);api.lastFrame=now;
    if(gap>2000)api.bottomSince=null;
    const t=api.target,height=t.scrollHeight,remaining=Math.max(0,height-t.clientHeight-t.scrollTop);
    if(height!==api.lastHeight){api.lastHeight=height;api.bottomSince=null;}
    if(remaining>2){api.bottomSince=null;t.scrollBy({top:Math.min(remaining,api.speed*Math.min(gap,100)/1000),left:0,behavior:'instant'});api.message='正在连续翻页…';}
    else{api.bottomSince??=now;const seconds=Math.floor((now-api.bottomSince)/1000);if(seconds>=60){pause('底部 60 秒没有变化，已暂停。请比对最后一个作品；若仍在加载，可再点开始。','bottom-paused');return;}api.message=`正在底部等待加载… ${seconds} / 60 秒`;}
    if(now-api.lastPaint>=1000){api.lastPaint=now;const dialogs=[...document.querySelectorAll('[role="dialog"],dialog[open]')].filter(visible);if(dialogs.some(el=>/身份验证|安全验证|验证码|扫码登录|访问频繁|操作频繁/.test(el.innerText))){pause('网页需要登录或验证，已暂停，请手动处理。');return;}paint();}
  };
  api.state=()=>({phase:api.phase,message:api.message,speed:api.speed});
  api.dispose=()=>{pause();for(const name of guarded)window.removeEventListener(name,guard,true);host.remove();delete window.__cangxiaScroll;};
  const mount=()=>{if(!host.isConnected&&document.documentElement)document.documentElement.append(host);paint();};if(document.documentElement)mount();else document.addEventListener('DOMContentLoaded',mount,{once:true});
}
