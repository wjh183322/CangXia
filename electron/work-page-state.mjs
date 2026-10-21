/** Runs in an isolated official work page; returns only bounded, non-private evidence. */
export function workPageSnapshot(id){
 const clean=v=>String(v||'').replace(/\s+/g,'').trim();
 let url;try{url=new URL(location.href);}catch{return {kind:'pending'};}
 if(url.href==='about:blank')return {kind:'pending'};
 if(url.protocol!=='https:'||!['www.douyin.com','douyin.com'].includes(url.hostname)||!new RegExp('^/(?:video|note)/'+id+'/?$').test(url.pathname))return {kind:'redirect'};
 if(!document.body||document.readyState==='loading')return {kind:'pending',workId:id,stage:'document-loading'};
 const visible=el=>{if(!el)return false;for(let p=el,n=0;p&&n++<20;p=p.parentElement){const s=getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||s.opacity==='0')return false;}const r=el.getBoundingClientRect();return !!el.getClientRects().length&&r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;};
 const excluded=el=>{for(let p=el,n=0;p&&p!==document.body&&n++<20;p=p.parentElement){if(/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|NAV|HEADER|FOOTER|ASIDE|INPUT|TEXTAREA)$/.test(p.tagName)||p.isContentEditable)return true;const label=[p.getAttribute('data-e2e'),p.getAttribute('aria-label'),p.getAttribute('role')].join(' ');if(/comment|recommend|related|search|caption|description|video-title|评论|推荐|搜索|简介|标题/i.test(label))return true;}return false;};
 const texts=[],walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node,read=0;
 while((node=walker.nextNode())&&read++<5000){const text=clean(node.nodeValue),el=node.parentElement;if(text&&text.length<=180&&!excluded(el)&&visible(el))texts.push({text,el});}
 for(const {text}of texts){if(/请登录|登录后.*观看|扫码登录/.test(text))return {kind:'login',workId:id};if(/验证码|安全验证|完成验证/.test(text))return {kind:'challenge',workId:id};if(/访问太频繁|访问过于频繁|操作频繁|稍后再试/.test(text))return {kind:'frequency',workId:id};if(/网络异常|网络错误|网络连接失败/.test(text))return {kind:'network',workId:id};}
 // Observed on the real official error view: the action is a P, not a button.
 // The platform's work-bound error marker is stronger than the action's tag.
 for(const {text,el}of texts)if(text==='你要观看的视频不存在'&&el.getAttribute('data-e2e')==='error-page'&&!el.closest('a,button,[role="button"]'))return {kind:'missing',workId:id,message:text};
 const actions=[...document.querySelectorAll('a,button,[role="button"]')].filter(el=>visible(el)&&!excluded(el)&&['去精选页查看更多视频','去看看其他作品'].includes(clean(el.innerText||el.textContent)));
 for(const {text,el}of texts){if(text!=='你要观看的视频不存在'||el.closest('a,button,[role="button"]'))continue;for(let p=el,n=0;p&&p!==document.body&&n++<8;p=p.parentElement){if(actions.some(a=>p.contains(a)))return {kind:'missing',workId:id,message:'你要观看的视频不存在'};}}
 return {kind:'pending',workId:id,stage:'error-not-found'};
}
