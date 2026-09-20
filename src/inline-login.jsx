import React,{useEffect,useRef} from 'react';

export function InlineLogin({api,pageId,revision}){
  const slot=useRef(null);
  useEffect(()=>{
    const node=slot.current;if(!node)return;let frame=0,disposed=false,last='';
    const update=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{if(disposed)return;const b=node.getBoundingClientRect(),modal=node.closest('.modal')?.getBoundingClientRect();const fullyVisible=b.width>=150&&b.height>=100&&b.left>=0&&b.top>=50&&b.right<=window.innerWidth&&b.bottom<=window.innerHeight&&(!modal||(b.top>=modal.top&&b.bottom<=modal.bottom));const bounds=fullyVisible?{x:b.x,y:b.y,width:b.width,height:b.height}:null;const key=JSON.stringify(bounds);if(key!==last){last=key;api.setQrPageBounds(pageId,bounds).catch(()=>{});}});};
    const observer=new ResizeObserver(update);observer.observe(node);window.addEventListener('resize',update);document.addEventListener('scroll',update,true);update();
    return()=>{disposed=true;cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',update);document.removeEventListener('scroll',update,true);api.setQrPageBounds(pageId,null).catch(()=>{});};
  },[api,pageId,revision]);
  return <div className="inline-login-section"><div className="inline-login-label">抖音官方验证页面 · 验证码直接交给抖音处理</div><div ref={slot} className="inline-login-host" aria-label="抖音官方验证页面"><span>正在显示原登录页…</span></div><div className="inline-login-help">完成短信或其他验证后，点击下方“检查登录”。<button className="text-button" onClick={()=>api.showQrExternalPage().catch(()=>{})}>显示不全？独立窗口打开</button></div></div>;
}
