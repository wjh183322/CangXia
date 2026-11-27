import React,{useEffect,useRef} from 'react';

export function InlineLogin({api,pageId,revision,panelFound}){
  const slot=useRef(null);
  useEffect(()=>{
    const node=slot.current;if(!node)return;let frame=0,disposed=false,last='';
    const update=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{if(disposed)return;const b=node.getBoundingClientRect(),modal=node.closest('.modal')?.getBoundingClientRect();const fullyVisible=b.width>=150&&b.height>=100&&b.left>=0&&b.top>=50&&b.right<=window.innerWidth&&b.bottom<=window.innerHeight&&(!modal||(b.top>=modal.top&&b.bottom<=modal.bottom));const bounds=fullyVisible?{x:b.x,y:b.y,width:b.width,height:b.height}:null;const key=JSON.stringify(bounds);if(key!==last){last=key;api.setQrPageBounds(pageId,bounds).catch(()=>{});}});};
    const observer=new ResizeObserver(update);observer.observe(node);window.addEventListener('resize',update);document.addEventListener('scroll',update,true);update();
    return()=>{disposed=true;cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',update);document.removeEventListener('scroll',update,true);api.setQrPageBounds(pageId,null).catch(()=>{});};
  },[api,pageId,revision]);
  return <div className="inline-login-section"><div className="inline-login-label">抖音官方验证 · 验证码直接交给抖音处理</div><div ref={slot} className="inline-login-host" aria-label="抖音官方验证面板"><span>{panelFound?'正在显示验证面板…':'正在定位验证面板；若一直未显示，请点击下方“打开完整验证页”。'}</span></div><div className="inline-login-help"><span>完成验证后会自动继续。</span><button className="text-button" onClick={()=>api.showQrExternalPage().catch(()=>{})}>打开完整验证页</button></div></div>;
}

const loginMessages = {
  loading: '正在等待 NAS 上的抖音登录二维码…',
  ready: '打开手机抖音扫一扫，并在手机上确认。',
  expired: '二维码已过期，请刷新后重新扫码。',
  limited: '抖音提示访问频繁，请稍后手动重试。',
  verification: '抖音要求人工验证，请按官方提示操作。',
  scanned: '已扫码，请在手机上确认登录。',
  connecting: '正在核验抖音账号…'
};

export function ServerInlineLogin({ api, onSuccess }) {
  const [view, setView] = React.useState({ phase: 'loading' }),
    [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false),
    [code, setCode] = React.useState('');
  const flow = useRef(null),
    finish = useRef(onSuccess);
  finish.current = onSuccess;
  useEffect(() => {
    const current = { id: null, timer: null, active: true, running: false };
    flow.current = current;
    async function run(action) {
      if (!current.active || current.running) return;
      clearTimeout(current.timer);
      current.running = true;
      setBusy(true);
      setError('');
      try {
        const next = await action();
        if (!current.active) {
          if (next?.viewId) void api.cancelQrLogin(next.viewId).catch(() => {});
          return;
        }
        current.id = next?.viewId ?? current.id;
        if (next?.phase === 'success') {
          await finish.current();
          return;
        }
        setView(next);
        if (!['expired', 'limited'].includes(next.phase))
          current.timer = setTimeout(() => void run(() => api.sourceLoginView(current.id)), 1500);
      } catch (e) {
        if (current.active) {
          setError(e.message);
          setView({ phase: 'error' });
        }
      } finally {
        current.running = false;
        if (current.active) setBusy(false);
      }
    }
    current.run = run;
    void run(() => api.startQrLogin());
    return () => {
      current.active = false;
      clearTimeout(current.timer);
      if (current.id) void api.cancelQrLogin(current.id).catch(() => {});
    };
  }, [api]);
  const act = (fn) => flow.current?.run(fn);
  const id = () => flow.current.id;
  const refresh = () => act(() => (id() ? api.refreshQrLogin(id()) : api.startQrLogin()));
  const verify = () => act(async () => ({ phase: 'success', account: await api.finishLogin() }));
  const manual = (input) =>
    act(() => api.sourceManualLogin(id(), { ...input, panelId: view.manual.panelId }));
  return (
    <div className="login-panel qr-login-body">
      {view.image && (
        <div className="qr-image-box">
          <img
            key={view.imageToken}
            src={view.image}
            alt="抖音官方登录二维码"
            onLoad={() => {
              if (view.imageToken) void api.sourceQrShown(view.viewId, view.imageToken).catch(() => {});
            }}
          />
        </div>
      )}
      <p role="status">{error || loginMessages[view.phase]}</p>
      {view.phase === 'verification' && (
        <>
          {view.manual?.send && (
            <button className="button secondary" disabled={busy} onClick={() => manual({ action: 'send' })}>
              请求抖音发送验证码
            </button>
          )}
          {view.manual?.code && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const entered = code;
                setCode('');
                manual({ action: 'submit', code: entered });
              }}
            >
              <label>
                抖音短信验证码
                <input
                  inputMode="numeric"
                  autoComplete="off"
                  pattern="[0-9]{4,8}"
                  maxLength={8}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
              <button className="button primary" disabled={busy}>
                提交给抖音验证
              </button>
            </form>
          )}
          {!view.manual?.code && !view.manual?.send && (
            <p>请查看手机抖音的验证提示。此验证形式目前无法在藏匣中操作。</p>
          )}
        </>
      )}
      <button className="button secondary" disabled={busy} onClick={verify}>
        已在抖音确认，核验账号
      </button>
      <button className="text-button" disabled={busy} onClick={refresh}>
        刷新二维码
      </button>
      {error && (
        <button
          className="text-button"
          disabled={busy}
          onClick={() =>
            act(async () => {
              await api.logout();
              return api.startQrLogin();
            })
          }
        >
          退出当前抖音登录，重新扫码
        </button>
      )}
    </div>
  );
}
