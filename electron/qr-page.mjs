export function webUserAgent(chromiumVersion){
  if(!/^\d+(?:\.\d+){1,3}$/.test(chromiumVersion))throw new Error('浏览器引擎版本无效');
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`;
}

// Reads the normal login page. It never generates a QR code or solves a verification challenge.
export function readQrPage({openLogin=false,refresh=false}={}){
  const visible=e=>{const r=e.getBoundingClientRect(),style=getComputedStyle(e);return r.width>5&&r.height>5&&r.bottom>0&&r.top<innerHeight&&style.visibility!=='hidden'&&style.display!=='none';};
  const text=e=>(e.innerText||e.textContent||'').replace(/\s+/g,'');
  const body=document.body?.innerText||'';
  if(/访问太频繁|访问过于频繁|操作过于频繁|请求过于频繁/.test(body))return {phase:'limited',message:'抖音提示访问频繁，请稍后手动重试'};
  const compact=body.replace(/\s+/g,'');
  const codeInput=[...document.querySelectorAll('input,textarea')].some(e=>['INPUT','TEXTAREA'].includes(e.tagName)&&visible(e)&&/验证码|短信码|短信验证|one-time-code/i.test([e.getAttribute('placeholder'),e.getAttribute('aria-label'),e.getAttribute('autocomplete')].join(' ')));
  const verificationFrame=[...document.querySelectorAll('iframe')].some(e=>e.tagName==='IFRAME'&&visible(e)&&/captcha|verify|验证/i.test([e.getAttribute('src'),e.getAttribute('title')].join(' ')));
  const verificationTitle=[...document.querySelectorAll('h1,h2,h3,[role="heading"],div,span')].some(e=>visible(e)&&(e.children?.length||0)<3&&/^(身份验证|安全验证)$/.test(text(e)));
  // The ordinary login dialog displays a phone/code form beside its QR code.
  // A code field alone is not evidence that scanning requires an extra challenge.
  if((codeInput&&verificationTitle)||/接收短信验证码|发送短信验证|请输入.{0,16}短信验证码|短信验证码已发送|验证码已发送至|发送至.{0,20}手机|请使用绑定手机号.{0,12}验证/.test(compact))return {phase:'verification',kind:'sms',message:'抖音需要短信或手机身份验证，请完成下方验证，软件会自动继续'};
  if(verificationFrame||verificationTitle||/请(?:先)?完成.{0,8}验证|拖动.{0,8}滑块|按住.{0,8}滑块|请依次点击/.test(compact))return {phase:'verification',kind:'challenge',message:'请完成下方身份验证，软件会自动继续'};
  if(body.split(/\r?\n/).some(line=>/^已确认[，,].{0,8}正在登录/.test(line.trim())))return {phase:'connecting',message:'手机已确认，正在连接账号'};
  const scanned=body.split(/\r?\n/).some(line=>/^(?:扫码成功|扫描成功)(?:[，,！!。\s].*)?$/.test(line.trim())||/^请在手机(?:抖音)?(?:上)?确认登录[！!。]?$/.test(line.trim()));
  if(scanned)return {phase:'scanned',message:'已扫码，请在手机确认；若已确认，请打开原登录页检查后续验证'};
  const candidates=[...document.querySelectorAll('img,canvas,svg')].filter(e=>{
    if(!visible(e))return false;const r=e.getBoundingClientRect();if(r.width<100||r.height<100||r.width>450||r.height>450||Math.abs(r.width/r.height-1)>.12)return false;
    const own=[e.getAttribute('alt'),e.id,e.getAttribute('class'),e.getAttribute('src')].join(' ');
    if(/二维码|qrcode|qr-code|\/qr\//i.test(own))return true;
    let p=e.parentElement;for(let i=0;i<6&&p;i++,p=p.parentElement){const b=p.getBoundingClientRect();if(b.width<=900&&b.height<=800&&/qrcode|qr-code|扫码登录|二维码登录|如何扫码|扫一扫|打开.{0,8}抖音/i.test([p.className,p.innerText].join(' ')))return true;}
    return false;
  });
  const qr=candidates[0];
  const exact=label=>[...document.querySelectorAll('button,a,[role="button"],[role="tab"],span,div,p')].filter(e=>visible(e)&&e.children.length<3&&text(e)===label).sort((a,b)=>{
    const priority=e=>['BUTTON','A'].includes(e.tagName)||['button','tab'].includes(e.getAttribute('role'))?0:1;
    return priority(a)-priority(b)||a.children.length-b.children.length;
  })[0];
  if(refresh){const button=exact('点击刷新')||exact('刷新二维码')||exact('重新获取二维码');if(button){button.click();return {phase:'loading',message:'正在刷新二维码'};}return {phase:'needs-page',message:'请打开登录页手动刷新二维码'};}
  if(/二维码失效|二维码已过期|二维码过期/.test(body))return {phase:'expired',message:'二维码已过期，请点击刷新'};
  if(qr){
    const r=qr.getBoundingClientRect();let image=null,imageUrl=null;
    const source=qr.currentSrc||qr.src||'';
    if(/^data:image\/(png|jpeg|webp);base64,/i.test(source))image=source;
    else try{
      if(qr.tagName==='CANVAS')image=qr.toDataURL('image/png');
      else if(qr.tagName==='IMG'&&qr.naturalWidth>0&&qr.naturalWidth<=2048&&qr.naturalHeight<=2048){const canvas=document.createElement('canvas');canvas.width=qr.naturalWidth;canvas.height=qr.naturalHeight;canvas.getContext('2d').drawImage(qr,0,0);image=canvas.toDataURL('image/png');}
    }catch{}
    if(!image&&/^https:\/\//i.test(source))imageUrl=source;
    return {phase:'ready',message:/扫码成功|请在手机|扫描成功/.test(body)?'请在手机抖音上确认登录':'使用手机抖音扫一扫',image,imageUrl,rect:{x:Math.max(0,Math.floor(r.x)),y:Math.max(0,Math.floor(r.y)),width:Math.ceil(r.width),height:Math.ceil(r.height)}};
  }
  if(openLogin){const tab=exact('扫码登录')||exact('二维码登录');if(tab){tab.click();return {phase:'loading',message:'正在打开扫码登录'};}
    const button=exact('登录');if(button){button.click();return {phase:'loading',message:'正在获取二维码'};}
  }
  return {phase:'loading',message:'正在加载抖音网页登录页'};
}
export const qrPageScript=options=>`(${readQrPage.toString()})(${JSON.stringify(options||{})})`;
export function validQrRect(rect,bounds){return !!rect&&['x','y','width','height'].every(k=>Number.isFinite(rect[k]))&&rect.x>=0&&rect.y>=0&&rect.width>=100&&rect.height>=100&&rect.width<=500&&rect.height<=500&&rect.x+rect.width<=bounds.width&&rect.y+rect.height<=bounds.height;}
