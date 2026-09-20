import React,{useEffect,useRef} from 'react';

export function InlineLogin({api,pageId,revision,panelFound}){
  const slot=useRef(null);
  useEffect(()=>{
    const node=slot.current;if(!node)return;let frame=0,disposed=false,last='';
    const update=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{if(disposed)return;const b=node.getBoundingClientRect(),modal=node.closest('.modal')?.getBoundingClientRect();const fullyVisible=b.width>=150&&b.height>=100&&b.left>=0&&b.top>=50&&b.right<=window.innerWidth&&b.bottom<=window.innerHeight&&(!modal||(b.top>=modal.top&&b.bottom<=modal.bottom));const bounds=fullyVisible?{x:b.x,y:b.y,width:b.width,height:b.height}:null;const key=JSON.stringify(bounds);if(key!==last){last=key;api.setQrPageBounds(pageId,bounds).catch(()=>{});}});};
    const observer=new ResizeObserver(update);observer.observe(node);window.addEventListener('resize',update);document.addEventListener('scroll',update,true);update();
    return()=>{disposed=true;cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',update);document.removeEventListener('scroll',update,true);api.setQrPageBounds(pageId,null).catch(()=>{});};
  },[api,pageId,revision]);
  return <div className="inline-login-section"><div className="inline-login-label">抖音官方验证 · 验证码直接交给抖音处理</div><div ref={slot} className="inline-login-host" aria-label="抖音官方验证面板"><span>{panelFound?'正在显示验证面板…':'正在定位验证面板；若一直未显示，请点击下方“打开完整验证页”。'}</span></div><div className="inline-login-help"><span>完成验证后，点击下方“检查登录”。</span><button className="text-button" onClick={()=>api.showQrExternalPage().catch(()=>{})}>打开完整验证页</button></div></div>;
}
