// Return geometry only. Never read form values or move/replace official DOM nodes.
export function readVerificationPanel(){
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>5&&r.height>5&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';};
 const text=e=>(e.innerText||e.textContent||'').replace(/\s+/g,'');
 const fits=r=>r.width>=260&&r.height>=160&&r.width<=920&&r.height<=720&&r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;
 const pack=e=>{const r=e.getBoundingClientRect();return {x:Math.floor(r.left),y:Math.floor(r.top),width:Math.ceil(r.width),height:Math.ceil(r.height)};};
 const anchors=[...document.querySelectorAll('h1,h2,h3,[role="heading"],div,span')].filter(e=>visible(e)&&e.children.length<3&&/^(身份验证|安全验证|手机号验证|手机验证|短信验证|输入验证码|请输入验证码|接收短信验证码|发送短信验证)$/.test(text(e)));
 anchors.push(...[...document.querySelectorAll('input')].filter(e=>visible(e)&&/验证码|one-time-code/i.test([e.getAttribute('placeholder'),e.getAttribute('autocomplete')].join(' '))));
 for(const anchor of anchors){
  let p=anchor;for(let depth=0;p&&p!==document.body&&depth<12;depth++,p=p.parentElement){
   if(!visible(p)||!fits(p.getBoundingClientRect()))continue;
   const s=getComputedStyle(p),r=p.getBoundingClientRect();
   const controls=[...p.querySelectorAll('input,button,[role="button"],iframe')].some(visible)||/接收短信验证码|发送短信验证/.test(text(p));
   const surface=p.getAttribute('role')==='dialog'||p.getAttribute('aria-modal')==='true'||parseFloat(s.borderRadius)>0||(!['transparent','rgba(0, 0, 0, 0)',''].includes(s.backgroundColor)&&s.backgroundColor!==undefined);
   if(controls&&surface&&r.width*r.height<innerWidth*innerHeight*.9)return pack(p);
  }
 }
 // Cross-origin challenge frames cannot be inspected; keep the whole bounded frame.
 for(const frame of document.querySelectorAll('iframe'))if(visible(frame)&&fits(frame.getBoundingClientRect())&&/captcha|verify|验证/i.test([frame.getAttribute('src'),frame.getAttribute('title')].join(' ')))return pack(frame);
 return null;
}
export const verificationPanelScript=()=>`(${readVerificationPanel.toString()})()`;
export function validPanel(rect){return !!rect&&['x','y','width','height'].every(k=>Number.isFinite(rect[k]))&&rect.x>=0&&rect.y>=0&&rect.width>=260&&rect.height>=160&&rect.width<=920&&rect.height<=720&&rect.x+rect.width<=1001&&rect.y+rect.height<=761;}
export function panelLayout(rect,slot){
 if(!validPanel(rect))return null;
 const zoom=Math.min(1,slot.width/rect.width,slot.height/rect.height);
 const width=Math.ceil(rect.width*zoom),height=Math.ceil(rect.height*zoom);
 return {zoom,clip:{x:slot.x+Math.floor((slot.width-width)/2),y:slot.y+Math.floor((slot.height-height)/2),width,height},page:{x:-Math.floor(rect.x*zoom),y:-Math.floor(rect.y*zoom),width:Math.ceil(1000*zoom),height:Math.ceil(760*zoom)}};
}
