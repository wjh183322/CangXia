import React,{useEffect,useState} from 'react';
import {RefreshCw,LoaderCircle,ShieldCheck,Monitor,StopCircle,Clock,CheckCircle,ChevronDown} from 'lucide-react';
import {InlineLogin} from './inline-login.jsx';
const number=n=>Number(n||0).toLocaleString('zh-CN');
const elapsed=(start,now)=>{const seconds=Math.max(0,Math.floor((now-start)/1000));return `${String(Math.floor(seconds/3600)).padStart(2,'0')}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;};
export function ReadProgress({progress={},onStop,stopping=false}){
 const [now,setNow]=useState(Date.now());useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const known=progress.mode==='partial'&&progress.goal>0,percent=known?Math.min(100,Math.floor((progress.added||0)/progress.goal*100)):null;
 const saving=stopping||['stopping','saving'].includes(progress.stage);
 return <div className="read-progress"><div className="read-progress-emblem"><RefreshCw size={25} className="spin"/></div><p className="read-progress-caption">{stopping||progress.stage==='stopping'?'正在停止并保存，请稍候':progress.stage==='saving'?'正在保存已读取内容':progress.stage==='preparing'?'正在准备读取，请稍候':'正在读取，请稍候'}</p>
  <div className="read-progress-main">{known?<><strong>{number(progress.added)}<small> / {number(progress.goal)}</small></strong><span>新增作品 · {percent}%</span></>:<><strong>{number(progress.checked)}<small> {progress.mode==='folders'?'个':'条'}</small></strong><span>{progress.mode==='folders'?'已发现收藏夹':'累计已读取'}</span></>}</div>
  <div className={`read-progress-track ${known?'':'indeterminate'}`} role="progressbar" aria-label={known?'新增作品进度':'读取进行中'} aria-valuemin={known?0:undefined} aria-valuemax={known?progress.goal:undefined} aria-valuenow={known?progress.added:undefined}><i style={known?{width:`${percent}%`}:undefined}/></div>
  <div className="read-progress-metrics"><span>{known?`已检查 ${number(progress.checked)} 条`:progress.mode==='folders'?'正在读取目录':`本次新增 ${number(progress.added)} 条`}</span><span><Clock size={13}/>{elapsed(progress.startedAt||now,now)}</span></div>
  <div className="read-progress-note"><ShieldCheck size={16}/><p>读取期间暂不能进行其他操作。<br/>点击停止后，已读取的内容会保留。</p></div>
  <button className="button secondary read-stop" disabled={saving} onClick={onStop}>{saving?<LoaderCircle size={16} className="spin"/>:<StopCircle size={16}/>} {saving?'正在保存进度…':'停止读取'}</button>
 </div>;
}
export function LoginPanel({data,api,onSuccess,onError,onState}){
 const [help,setHelp]=useState(false),[method,setMethod]=useState('qr'),[busy,setBusy]=useState(false),[now,setNow]=useState(Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const qr=data.qr||{},phase=qr.phase||'loading',pending=data.collector.pendingAccount;
 const waiting=['scanned','connecting'].includes(phase),verifying=phase==='verifying',late=now-(qr.phaseSince||now)>=20000;
 async function act(fn){setBusy(true);try{await fn();}catch(e){onError(e.message);}finally{setBusy(false);}}
 const finish=async()=>{await api.finishLogin();onSuccess();};
 if(method==='browser'&&!pending)return <div className="login-panel"><div className="login-state-icon"><Monitor size={32}/></div><h3>请在专用浏览器中完成登录</h3><p className="muted">完成抖音要求的验证后，返回这里继续。<br/>连接完成后，登录窗口会自动关闭。</p><button className="button primary login-primary" disabled={busy} onClick={()=>act(finish)}>{busy?'正在连接…':'已完成登录，继续'}</button><button className="text-button" disabled={busy} onClick={()=>act(async()=>{await api.startQrLogin();setMethod('qr');})}>返回扫码登录</button></div>;
 return <div className={`qr-login-body login-panel ${qr.inline?'inline':''}`}>
  {pending?<div className="login-state-icon"><ShieldCheck size={34}/></div>:qr.inline?<InlineLogin api={api} pageId={qr.pageId} revision={qr.pageRevision} panelFound={qr.panelFound}/>:<div className="qr-image-box">{qr.image?<img src={qr.image} alt="抖音登录二维码"/>:<div className="qr-placeholder">{waiting?<CheckCircle size={34}/>:<LoaderCircle className={['loading','connecting','verifying'].includes(phase)?'spin':''} size={32}/>}<span>{phase==='scanned'?'请在手机上确认登录':verifying||phase==='connecting'?'正在连接账号':phase==='expired'?'二维码已过期':phase==='error'?'登录未完成':'正在获取二维码'}</span></div>}</div>}
  <p className="qr-login-status" role="status">{qr.message||'正在准备登录…'}</p>
  {pending?<><div className="info-box"><p>当前账号：{pending.nickname}（ID {pending.uid}）<br/>请确认它是已有 {number(pending.records)} 条资料的原账号。</p></div><button className="button primary login-primary" disabled={busy} onClick={()=>act(async()=>{const state=await api.confirmLegacyAccount(pending.token);onState(state);onSuccess();})}>确认原账号并继续</button></>:<>
   {!qr.inline&&!waiting&&!verifying&&<button className={`button ${['expired','error'].includes(phase)?'primary':'secondary'}`} disabled={busy} onClick={()=>act(()=>api.refreshQrLogin())}><RefreshCw size={14}/>{phase==='error'?'重新扫码':'刷新二维码'}</button>}
   {(waiting||qr.inline)&&!verifying&&(late||qr.active===false)&&<button className="button secondary" disabled={busy} onClick={()=>act(()=>api.checkQrLogin())}>已完成？重新检查</button>}
   {!verifying&&(!qr.inline||qr.active===false||phase==='error')&&<div className="login-help"><button className="text-button" aria-expanded={help} onClick={()=>setHelp(!help)}>登录遇到问题？<ChevronDown size={13}/></button>{help&&<div className="login-help-options">{!qr.inline&&<button className="button secondary" disabled={busy} onClick={()=>act(()=>api.showQrLoginPage())}>打开当前验证页</button>}<button className="button secondary" disabled={busy} onClick={()=>act(async()=>{await api.openAccount('chrome');setMethod('browser');})}>使用专用浏览器</button><small>需要额外验证时会自动显示；这里只用于处理未识别或显示异常的情况。</small></div>}</div>}
  </>}
  <div className="qr-login-footer"><ShieldCheck size={14}/>登录成功后自动连接并收起窗口</div>
 </div>;
}
