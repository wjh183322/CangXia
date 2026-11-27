import React,{useEffect,useState} from 'react';
import {RefreshCw,LoaderCircle,ShieldCheck,Monitor,StopCircle,Clock,CheckCircle,ChevronDown} from 'lucide-react';
import {InlineLogin} from './inline-login.jsx';
const number=n=>Number(n||0).toLocaleString('zh-CN');
const elapsed=(start,now)=>{const seconds=Math.max(0,Math.floor((now-start)/1000));return `${String(Math.floor(seconds/3600)).padStart(2,'0')}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;};
export function ReadProgress({progress={},batch,onStop,stopping=false}){
 const [now,setNow]=useState(Date.now());useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const count=progress.source==='author'?(progress.processed||0):(progress.added||0);
 const known=progress.mode==='partial'&&progress.goal>0,percent=known?Math.min(100,Math.floor(count/progress.goal*100)):null;
 const saving=stopping||['stopping','saving'].includes(progress.stage);
 return <div className="read-progress"><div className="read-progress-emblem"><RefreshCw size={25} className="spin"/></div>{batch?.running&&<div className="collection-batch-progress" role="status"><strong>已处理 {number(batch.processed)} / {number(batch.total)} 个收藏夹</strong><span>当前：{batch.currentName||'正在准备'} · 完成 {number(batch.succeeded)} · 失败 {number(batch.failed)} · 跳过 {number(batch.skipped)}</span><small>下方作品数量为当前收藏夹的读取进度</small></div>}<p className="read-progress-caption">{stopping||progress.stage==='stopping'?'正在停止并保存，请稍候':progress.stage==='organizing'?`读取内容已保存，正在整理本地作品 ${number(progress.organizing?.processed)} / ${number(progress.organizing?.total)}`:progress.stage==='saving'?'正在保存已读取内容':progress.stage==='preparing'?'正在准备读取，请稍候':'正在读取，请稍候'}</p>
  <div className="read-progress-main">{known?<><strong>{number(count)}<small> / {number(progress.goal)}</small></strong><span>{progress.source==='author'?'本次读取':'新增作品'} · {percent}%</span></>:<><strong>{number(progress.checked)}<small> {progress.mode==='folders'?'个':'条'}</small></strong><span>{progress.mode==='folders'?'已发现收藏夹':progress.mode==='quick'?'已检查作品':'累计已读取'}</span></>}</div>
  <div className={`read-progress-track ${known?'':'indeterminate'}`} role="progressbar" aria-label={known?(progress.source==='author'?'作者作品读取进度':'新增作品进度'):'读取进行中'} aria-valuemin={known?0:undefined} aria-valuemax={known?progress.goal:undefined} aria-valuenow={known?count:undefined}><i style={known?{width:`${percent}%`}:undefined}/></div>
  <div className="read-progress-metrics"><span>{known?`已检查 ${number(progress.checked)} 条`:progress.mode==='folders'?'正在读取目录':`新增${progress.mode==='quick'||progress.mode==='full'?'收藏':''} ${number(progress.added)} 条${progress.restored?` · 恢复记录 ${number(progress.restored)} 条`:''}`}</span><span><Clock size={13}/>{elapsed(progress.startedAt||now,now)}</span></div>
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

export function ServerConnection({api}){
  const [form,setForm]=useState({url:'',fingerprint:'',deviceId:'',token:''});
  const [state,setState]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [changedLibrary,setChangedLibrary]=useState(false),[acceptLibrary,setAcceptLibrary]=useState(false);
  useEffect(()=>{
    let active=true;
    const off=api.onServerSession(value=>{if(active)setState(value);});
    api.serverSession().then(value=>{
      if(active){setState(value);setForm({...value.settings,token:''});}
    }).catch(e=>{if(active)setError(e.message);});
    return ()=>{active=false;off();};
  },[api]);
  const settingsLoaded=!!state;
  useEffect(()=>{if(settingsLoaded)void api.serverGateReady().catch(()=>{});},[settingsLoaded,api]);
  async function enter(event){
    event.preventDefault();setBusy(true);setError('');
    const config={url:form.url.trim(),deviceId:form.deviceId.trim(),fingerprint:form.fingerprint.trim(),token:form.token};
    try{
      if(acceptLibrary)config.libraryId=null;
      setForm(previous=>({...previous,token:''}));
      await api.serverConnect(config,state.epoch);
      setChangedLibrary(false);setAcceptLibrary(false);
    }catch(e){setError(e.message);setChangedLibrary(e.message.includes('资料库身份已更换'));}
    finally{setBusy(false);}
  }
  const fields=[
    ['url','NAS 服务地址','url','https://nas.example:9443'],
    ['deviceId','设备标识','text','NAS 分配给这台电脑的标识'],
    ['fingerprint','证书 SHA256 指纹','text','从 NAS 核对指纹'],
    ['token','服务访问凭据','password',state?.settings?.url?'留空使用已保存的凭据':'输入此设备的专用凭据']
  ];
  return <main className="connection-screen"><form className="connection-form" onSubmit={enter}>
    <ShieldCheck size={30}/><h1>连接 NAS 资料库</h1>
    {fields.map(([key,label,type,placeholder])=><label key={key}>{label}<input type={type}
      required={key!=='token'||!state?.settings?.url} autoComplete="off" spellCheck={false} placeholder={placeholder}
      value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})}/></label>)}
    {changedLibrary&&<label><input type="checkbox" checked={acceptLibrary} onChange={e=>setAcceptLibrary(e.target.checked)}/>已在 NAS 核对新资料库，同意更换本机绑定</label>}
    <p role="status">{error||state?.reason||'正在读取连接设置…'}</p>
    <button className="button primary" disabled={busy||!state}>{busy?'正在连接…':'连接并取得使用权'}</button>
    {busy&&<button className="button secondary" type="button" onClick={()=>api.cancelBackup().catch(e=>setError(e.message))}>停止等待连接</button>}
  </form></main>;
}
export function SessionHandoff({api}){
  const [busy,setBusy]=useState(false),[state,setState]=useState(null),[error,setError]=useState('');
  useEffect(()=>{void api.serverSession().then(setState).catch(e=>setError(e.message));return api.onServerSession(setState);},[api]);
  return <div className="session-handoff"><small role="status">{error||(state?.reconciling?'正在核对回执':state?.recent?
    (state.recent.confirmed?'最近操作已获 NAS 确认':'上次操作未找到回执'):'')}</small>
    <button className="button secondary" disabled={busy} title={state?.libraryId} onClick={async()=>{
      setBusy(true);try{await api.serverRelease();}catch(e){setError(e.message);setBusy(false);}
    }}> {busy?'正在核对并交接…':'换电脑 / 释放使用权'}</button></div>;
}

export function ServerConnectionSettings({api}){
  const [state,setState]=useState(null),[id,setId]=useState(''),[result,setResult]=useState('');
  async function receipt(event){
    event.preventDefault();
    try{
      const record=await api.serverReceipt(id.trim());
      setResult(record?'NAS 已确认 · '+(record.kind||'会话操作')+(record.jobId?' · 作业 '+record.jobId:''):'NAS 未找到该操作的回执。');
    }catch(error){setResult(error.message);}
  }
  useEffect(()=>{let active=true;api.serverSession().then(value=>{if(active)setState(value);}).catch(()=>{});return()=>{active=false;};},[api]);
  return <div className="modal-content settings-content">{state&&<dl>
    <dt>服务地址</dt><dd>{state.settings.url}</dd><dt>资料库</dt><dd>{state.libraryId}</dd>
    <dt>当前设备</dt><dd>{state.settings.deviceId}</dd><dt>证书 SHA256 指纹</dt><dd style={{overflowWrap:'anywhere'}}>{state.settings.fingerprint}</dd>
    {state.recent&&<><dt>最近操作标识</dt><dd>{state.recent.operationId}</dd></>}</dl>}
    <form onSubmit={receipt}><label>操作标识<input value={id} required onChange={e=>setId(e.target.value)}/></label>
    <button className="button secondary">查询 NAS 回执</button><p role="status">{result}</p></form><p>换电脑前，藏匣会先核对已提交操作的回执，再释放使用权。</p><SessionHandoff api={api}/></div>;
}
