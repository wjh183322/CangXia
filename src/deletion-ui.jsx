import React,{useEffect,useRef,useState} from 'react';
const choices={restore:'保留并上传 NAS','remove-local':'删除本机对应内容',later:'稍后处理'};
export function ScopedDeleteDialog({Modal,api,request,storage,onClose,onStarted}){
 const [records,setRecords]=useState(request.records),[files,setFiles]=useState(request.files),[target,setTarget]=useState(request.target||'local');
 const [plan,setPlan]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),sequence=useRef(0),submitted=useRef(false),prepared=useRef(null);
 const canNAS=!!storage.connected&&!!storage.writable&&!!storage.scopedDeletion;
 useEffect(()=>{let live=true;const n=++sequence.current;setPlan(null);setError('');if(!records&&!files){setError('请选择读取记录或作品文件');return;}setBusy(true);
  Promise.resolve(request.catalogueSelection?api.prepareCatalogueDeletion({selection:request.catalogueSelection,source:request.source,records,files,target}):api.prepareScopedDeletion({ids:request.ids,source:request.source,records,files,target})).then(value=>{if(!live||n!==sequence.current){void api.cancelPreparedDeletion?.(value.token).catch(()=>{});return;}prepared.current=value.token;setPlan(value);},e=>{if(live)setError(e.message);}).finally(()=>{if(live)setBusy(false);});
  return()=>{live=false;const token=prepared.current;prepared.current=null;if(token&&!submitted.current)void api.cancelPreparedDeletion?.(token).catch(()=>{});};
 },[records,files,target,request]);
 async function confirm(){setBusy(true);setError('');try{await api.confirmScopedDeletion(plan.token);submitted.current=true;onStarted();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <Modal title={request.target==='nas'?'删除 NAS 备份':request.files?'删除本地作品':'删除读取记录'} className="scoped-delete-dialog" onClose={onClose} dismissible={!busy}>
  <div className="modal-content"><h3>处理 {plan?.summary.total??(request.count??request.ids?.length??0)} 个作品</h3><fieldset disabled={busy}><legend>删除内容</legend><label><input type="checkbox" checked={records} onChange={e=>setRecords(e.target.checked)}/>当前来源的读取记录</label><label><input type="checkbox" checked={files} onChange={e=>setFiles(e.target.checked)}/>作品文件（含永久配乐）</label></fieldset>
   {records&&<p>{request.source?.startsWith('author:')?'仅删除当前作者来源。':'账号收藏含该作品全部自建收藏夹关联。'}其他来源的读取记录保留。</p>}
   {files&&<p>所有来源共用这一份本机文件。作品文件夹内的其他文件也会移入系统回收站；仍被其他作品使用的共享配乐保留。</p>}
   {files&&<p className="invalid-note" role="note">{target==='local'?'若原作品已失效，删除本机文件后不能从抖音重新下载。NAS 或其他位置仍保留完整备份时，可以从备份恢复。':target==='nas'?'若原作品已失效，删除 NAS 文件后不能从抖音重新下载。请确认本机或其他位置仍有完整可用副本。':'若原作品已失效，本机和 NAS 文件一起删除后不能从抖音重新下载；如果没有其他可用副本，可能无法恢复。'}</p>}
   <fieldset disabled={busy}><legend>删除位置</legend><label><input type="radio" name="delete-target" checked={target==='local'} onChange={()=>setTarget('local')}/>仅本机移除，NAS 保留</label><label><input type="radio" name="delete-target" checked={target==='local-nas'} disabled={!canNAS} onChange={()=>setTarget('local-nas')}/>本机和 NAS 一起删除</label>{request.target==='nas'&&<label><input type="radio" name="delete-target" checked={target==='nas'} disabled={!canNAS} onChange={()=>setTarget('nas')}/>仅删除 NAS，本地文件、收藏和作者记录保留</label>}</fieldset>
   {target==='local'?<p className="muted small">下次同步不会自动补回。可在 NAS 目录中找回记录，或另行恢复文件。</p>:<p className="muted small">NAS 删除成功后才执行本机步骤。其他电脑保留的对应内容需要明确选择后才能重新上传，空闲同步不会自动备份回来。</p>}
   {!canNAS&&<p className="muted small">NAS 未连接、不可写或尚未配套升级；仍可仅删除本机内容。</p>}{busy&&<p role="status">正在核对确认范围…</p>}{error&&<p role="alert" className="danger-text">{error}</p>}
  </div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button danger solid" disabled={busy||!plan} onClick={confirm}>{target==='nas'?'确认删除 NAS 备份':'确认删除'}</button></footer>
 </Modal>;
}
export function DeletionProgress({Modal,api,operation,onClose,onRefresh}){
 const [error,setError]=useState(''),[busy,setBusy]=useState(false);async function action(method,...args){setBusy(true);try{await api[method](...args);onRefresh?.();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <Modal title="删除处理进度" className="deletion-progress" onClose={onClose}><div className="modal-content"><h3>{operation.message}</h3><p>已处理 {operation.processed||0} / {operation.total||0} 个作品</p><progress style={{width:'100%'}} value={operation.processed||0} max={Math.max(1,operation.total||0)}/><p>NAS 成功 {operation.nasSucceeded||0} · NAS 失败 {operation.nasFailed||0}<br/>本机成功 {operation.localSucceeded||0} · 本机失败 {operation.localFailed||0}{operation.localRetained?` · 本机保留 ${operation.localRetained}`:''}</p>{operation.failed>0&&operation.lastError&&<p role="alert" className="danger-text">{operation.lastError}</p>}{operation.nasSucceeded>0&&operation.localFailed>0&&<p>NAS 已确认的结果保留；重试只继续未完成步骤，不会重复删除 NAS。</p>}<p className="muted small">停止后保留已完成结果；剩余内容保持原样。关闭窗口可继续浏览，重启不会自动继续删除。</p>{error&&<p role="alert">{error}</p>}</div><footer className="modal-footer"><button className="button secondary" onClick={onClose}>{operation.running?'后台继续':'关闭'}</button>{operation.running?<button className="button danger" disabled={busy} onClick={()=>action('stopScopedDeletion')}>停止后续批次</button>:['paused','interrupted','failed','partial'].includes(operation.phase)&&<button className="button danger" disabled={busy} onClick={()=>action('retryScopedDeletion',operation.operationId)}>重试未完成步骤</button>}</footer></Modal>;
}
export function DeletionPendingPanel({Modal,api,storage,progress,revision,onClose}){
 const [report,setReport]=useState(null),[page,setPage]=useState(1),[query,setQuery]=useState(''),[kind,setKind]=useState('all'),[sourceId,setSourceId]=useState(''),[includeOwn,setIncludeOwn]=useState(false),[selection,setSelection]=useState({token:null,all:false,ids:[],exclude:[]});
 const [error,setError]=useState(''),[loading,setLoading]=useState(false),[confirmation,setConfirmation]=useState(null),[refresh,setRefresh]=useState(0),[submitting,setSubmitting]=useState(false),selected=useRef(selection),request=useRef(0);selected.current=selection;
 useEffect(()=>{let live=true;const n=++request.current;setLoading(true);Promise.resolve(api.deletionPendingPage({page,query,kind,sourceId,includeOwn,limit:20})).then(async value=>{
   let prior=selected.current;if(prior.token&&prior.token!==value.token){if(prior.all){prior={token:value.token,all:false,ids:[],exclude:[]};if(live)setError('清单已有更新，跨页全选已清除，请重新确认');}else if(prior.ids.length){const checked=await api.validateDeletionSelection({token:prior.token,ids:prior.ids});prior={token:value.token,all:false,ids:checked.ids,exclude:[]};if(live&&checked.invalid)setError(`有 ${checked.invalid} 个范围已变化，已清除相应选择`);}}
   if(live&&request.current===n){setReport(value);setSelection({...prior,token:value.token});}
  },e=>{if(live)setError(e.message);}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};
 },[page,query,kind,sourceId,includeOwn,refresh,api,storage.deletionPending,progress?.running,revision]);
 const count=selection.all?Math.max(0,(report?.total||0)-selection.exclude.length):selection.ids.length,active=submitting||progress?.running;
 function toggle(id){setSelection(old=>{const field=old.all?'exclude':'ids',values=new Set(old[field]);values.has(id)?values.delete(id):values.add(id);return {...old,[field]:[...values]};});}
 function filter(set,value){set(value);setPage(1);setSelection({token:null,all:false,ids:[],exclude:[]});setConfirmation(null);}
 async function submit(){setSubmitting(true);setError('');try{await api.resolveDeletionPending({action:confirmation,selection});setConfirmation(null);setSelection({token:null,all:false,ids:[],exclude:[]});setRefresh(v=>v+1);}catch(e){setError(e.message);setConfirmation(null);setRefresh(v=>v+1);}finally{setSubmitting(false);}}
 return <Modal title="NAS 删除待处理" wide className="deletion-pending-panel" onClose={onClose}><div className="modal-content"><p>以下对应内容已从 NAS 删除，本机仍保留。仅处理选择的来源或文件，其他内容继续使用。</p><div className="deletion-filters"><input aria-label="搜索删除待处理" placeholder="搜索标题、作者或作品 ID" value={query} disabled={active} onChange={e=>filter(setQuery,e.target.value)}/><select aria-label="删除待处理内容类型" value={kind} disabled={active} onChange={e=>filter(setKind,e.target.value)}><option value="all">记录和文件</option><option value="records">读取记录</option><option value="files">作品文件</option></select><input aria-label="删除待处理来源 ID" placeholder="来源 ID（可选）" value={sourceId} disabled={active} onChange={e=>filter(setSourceId,e.target.value)}/></div>
  <label className="deletion-include-own"><input type="checkbox" aria-label="包含本机删除后保留的副本" checked={includeOwn} disabled={active} onChange={e=>filter(setIncludeOwn,e.target.checked)}/>包含本机从 NAS 删除后保留的副本</label><div className="deletion-toolbar"><button className="text-button" disabled={loading||active||!report?.total} onClick={()=>setSelection({token:report.token,all:true,ids:[],exclude:[]})}>全选当前筛选结果（{report?.total||0}）</button><button className="text-button" onClick={()=>setSelection({token:report?.token,all:false,ids:[],exclude:[]})} disabled={active}>取消选择</button><span>已选 {count} 个作品</span><button className="button secondary" disabled={loading||active||!storage.connected} onClick={async()=>{try{await api.refreshDeletionPending();setRefresh(v=>v+1);}catch(e){setError(e.message);}}}>重新核对 NAS</button></div>
  {error&&<p role="alert" className="danger-text">{error}</p>}{loading&&<p role="status">正在读取清单…</p>}
  <div className="deletion-list">{report?.items.map(work=><article key={work.id}><label><input type="checkbox" aria-label={`选择删除待处理作品 ${work.id}`} disabled={active||loading} checked={selection.all?!selection.exclude.includes(work.id):selection.ids.includes(work.id)} onChange={()=>toggle(work.id)}/><strong>{work.name}</strong></label><small>{work.author} · {work.id}</small>{work.scopes.map(s=><p key={s.scope.kind+':'+s.scope.sourceId}>{s.sourceName} · {s.deviceName} · {s.at?new Date(s.at).toLocaleString('zh-CN'):'时间未知'}{s.localPresence==='unknown'?' · 本机文件暂无法确认':''}</p>)}{work.scopeCount>work.scopes.length&&<small>共 {work.scopeCount} 个范围；选择将处理当前筛选下全部范围，可用来源 ID 进一步筛选。</small>}</article>)}{report&&!report.total&&<p>当前没有待处理作品。</p>}</div>
  <div className="deletion-toolbar"><button className="button secondary" aria-label="删除待处理列表上一页" disabled={page<=1||loading||active} onClick={()=>setPage(v=>v-1)}>上一页</button><span>{report?.page||page} / {report?.pages||1} · 每页 20 个</span><button className="button secondary" aria-label="删除待处理列表下一页" disabled={page>=(report?.pages||1)||loading||active} onClick={()=>setPage(v=>v+1)}>下一页</button></div>
  {progress?.total>0&&<p role="status">{progress.message} · 已恢复 {progress.restored||0} · 本机删除 {progress.removed||0} · 状态已变化 {progress.updated||0} · 失败 {progress.failed||0} · 未处理 {progress.unprocessed||0}</p>}
  {confirmation&&<div className="deletion-action-confirm"><h3>{choices[confirmation]}：{count} 个作品</h3><p>{confirmation==='restore'?'只上传本机实际拥有的所选内容，不从抖音重新下载。':confirmation==='remove-local'?'仅删除本机对应范围；作品文件移入回收站。NAS 不执行第二次删除。':'保留本机内容且暂停这些范围的自动上传。'}</p><button className="button secondary" disabled={active} onClick={()=>setConfirmation(null)}>返回清单</button><button className="button danger" disabled={active||!count} onClick={submit}>{confirmation==='restore'?'确认保留并上传':confirmation==='remove-local'?'确认删除本机内容':'确认稍后处理'}</button></div>}
 </div><footer className="modal-footer"><button className="button secondary" onClick={onClose}>关闭</button>{progress?.running?<button className="button danger" onClick={()=>api.stopDeletionResolution().catch(e=>setError(e.message))}>停止后续处理</button>:Object.entries(choices).map(([action,label])=><button key={action} className="button secondary" disabled={!count||loading||active||action!=='later'&&(!storage.connected||!storage.writable)} onClick={()=>{setConfirmation(action);setError('');}}>{label}</button>)}</footer></Modal>;
}

const removalNames={membership:'移除当前来源归属',records:'移除作品记录',files:'删除 NAS 文件','restore-records':'恢复作品记录','restore-files':'还原 NAS 文件'};
const removalStates={preview:'等待确认',running:'正在处理',paused:'已暂停',done:'已完成',restoring:'正在还原',restored:'已还原',cancelled:'已结束剩余项目',checking:'正在核对原文件'};
const sourceName=source=>source==='total'?'总收藏':source?.startsWith('folder:')?'收藏夹 '+source.slice(7):source?.startsWith('author:')?'作者 '+source.slice(7):'全部作品';
export function ServerRemovalDialog({Modal,api,initial,onClose,onConfirm,onVerify}){
  const [plan,setPlan]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function action(fn){setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}}
  const readOnly=initial.state!=='preview';
  async function confirm(){await api[plan.scope.startsWith('restore-')?'restoreRemoval':'confirmRemoval']({token:plan.token});await onConfirm();}
  const dismiss=(after=onClose)=>action(async()=>{if(!readOnly)await api.controlRemoval({token:plan.token,action:'discard'});after();});
  return <Modal title={removalNames[plan.scope]} onClose={()=>dismiss()} dismissible={!busy}>
    <div className="modal-content"><h3>{plan.count} 个作品</h3>
      {plan.scope==='membership'&&<p>从{sourceName(plan.source)}移除 {plan.relations} 条归属。下次读取该来源且平台返回作品时，归属会自动恢复。其他来源和 {plan.files} 个已登记文件保留。</p>}
      {plan.scope==='records'&&<p>在全部作品和来源列表中移除记录。回执保存作品、标签和 {plan.relations} 条归属的恢复信息；{plan.files} 个 NAS 文件继续在媒体库可用。</p>}
      {plan.scope==='files'&&<p>将下列 {plan.files} 个登记文件移入已验证的 NAS 回收位置。所有来源共用这些文件。作品记录、{plan.relations} 条来源归属和本机缓存保留。</p>}
      {plan.scope==='restore-files'&&<p>将 {plan.files} 个文件还原至下列原路径。每个文件核对身份和 SHA-256；原路径已被占用时暂停。</p>}
      {plan.scope==='restore-records'&&<p>恢复作品在原来源和全部作品中的显示，保留已登记的标签、文件和次序。</p>}
      {plan.manualReconcile&&<p>旧回执未记录持久卷标识。若无法重新绑定，请在绿联回收站逐项执行「还原」，然后核对下列对应文件。藏匣核对原位置的文件身份和 SHA-256 后更新登记。</p>}
      {plan.items.map((i,n)=><p key={n}>{i.title} · {i.workId}{i.path&&<><br/>{i.path} · {i.size} 字节<br/>原路径：{i.original||'待核对'}<br/>回收位置：{i.recycled||'待核对'}<br/>SHA-256：{i.sha256}{readOnly&&<><br/>处理结果：{({ready:'待处理',done:'已完成',cancelled:'已取消',restored:'已还原'})[i.state]}</>}{plan.manualReconcile&&(i.state==='ready'||(plan.scope==='files'&&i.state==='done'))&&<button className="button secondary" disabled={busy} onClick={()=>action(async()=>{await api.controlRemoval({token:plan.token,action:'manual',ordinal:i.ordinal,restored:true});onClose();})}>此文件已手动还原，核对并登记</button>}</>}</p>)}
      <div><button className="text-button" disabled={busy||!plan.offset} onClick={()=>action(async()=>setPlan(await api.removalStatus({token:plan.token,offset:plan.offset-20})))}>上一页</button>
      <button className="text-button" disabled={busy||plan.offset+20>=plan.total} onClick={()=>action(async()=>setPlan(await api.removalStatus({token:plan.token,offset:plan.offset+20})))}>下一页</button></div>
      {plan.reason&&<p role="alert">{plan.reason}</p>}{plan.scope==='files'&&plan.reason&&<button className="text-button" onClick={()=>dismiss(onVerify)}>查看回收站验证</button>}{error&&<p role="alert">{error}</p>}
    </div><footer className="modal-footer"><button className="button secondary" onClick={()=>dismiss()} disabled={busy}>{readOnly?'返回记录':'取消'}</button>{!readOnly&&<button className="button danger solid" disabled={busy||!!plan.reason} onClick={()=>action(confirm)}>确认{removalNames[plan.scope]}</button>}</footer>
  </Modal>;
}
export function ServerRemovalHistory({Modal,api,onClose,onPlan}){
  const [rows,setRows]=useState([]),[offset,setOffset]=useState(0),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false);
  useEffect(()=>{let live=true,timer;async function load(){try{const r=await api.removalHistory({offset});if(live){setRows(r);if(r.some(b=>b.state==='running'||b.state==='restoring'||b.state==='checking'))timer=setTimeout(load,800);}}catch(e){if(live)setError(e.message);}}void load();return()=>{live=false;clearTimeout(timer);};},[api,offset,refresh]);
  async function action(fn){setBusy(true);try{setError('');await fn();setRefresh(n=>n+1);}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <Modal title="删除与恢复记录" onClose={onClose}><div className="modal-content">
    {!rows.length&&<p>此页没有已确认的删除操作。</p>}{rows.map(b=><article key={b.token}><h3>{removalNames[b.scope]} · {removalStates[b.state]}</h3>
    <p>{new Date(b.created).toLocaleString()} · {b.count} 个作品 · 已处理 {b.done}/{b.total} 项{b.cancelled>0&&' · 已取消 '+b.cancelled+' 项'}</p>
    {['files','restore-files'].includes(b.scope)&&<button className="text-button" disabled={busy} onClick={()=>action(async()=>onPlan(await api.removalStatus({token:b.token})))}>查看文件路径及摘要</button>}
    {b.scope==='membership'&&<p>{sourceName(b.source)}。重新读取此来源可恢复平台仍返回的作品。</p>}
    {b.reason&&<p role="alert">{b.reason}</p>}{b.rebindRequired&&<button className="button secondary" disabled={busy} onClick={()=>action(()=>api.controlRemoval({token:b.token,action:'rebind'}))}>确认重新绑定已验证的同一卷和目录</button>}
    {['done','paused','cancelled'].includes(b.state)&&b.restorable>0&&['files','records'].includes(b.scope)&&<button className="button secondary" disabled={busy} onClick={()=>action(async()=>onPlan(await api.previewRestore({token:b.token})))}>预览恢复</button>}
    {['paused','running'].includes(b.state)&&<button className="button secondary" disabled={busy} onClick={()=>action(()=>api.controlRemoval({token:b.token,action:b.state==='paused'?'resume':'pause'}))}>{b.state==='paused'?(b.cancelling?'重新核对在途文件':'重试剩余项目'):'暂停后续项目'}</button>}{b.state==='paused'&&!b.cancelling&&<button className="button secondary" disabled={busy} onClick={()=>action(()=>api.controlRemoval({token:b.token,action:'cancel'}))}>取消剩余项目并核对在途文件</button>}</article>)}
    {error&&<p role="alert">{error}</p>}<button className="text-button" disabled={!offset} onClick={()=>setOffset(v=>v-20)}>上一页</button><button className="text-button" disabled={rows.length<20} onClick={()=>setOffset(v=>v+20)}>下一页</button>
    </div></Modal>;
}
export function TrashVerification({Modal,api,onClose}){
  const [status,setStatus]=useState(null),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [supported,setSupported]=useState(false),[reference,setReference]=useState(''),[retention,setRetention]=useState(''),[observed,setObserved]=useState(false);
  useEffect(()=>{let live=true,timer;async function load(){try{const s=await api.trashStatus({});if(live){setStatus(s);if(s.busy)timer=setTimeout(load,500);}}catch(e){if(live)setError(e.message);}}void load();return()=>{live=false;clearTimeout(timer);};},[api,refresh]);
  async function action(fn){setBusy(true);setError('');try{await fn();setObserved(false);setRefresh(n=>n+1);}catch(e){setError(e.message);}finally{setBusy(false);}}
  const blocked=busy||status?.busy;
  return <Modal title="验证 NAS 回收站" onClose={onClose}><div className="modal-content">
    <p>绿联公开说明要求通过回收站界面管理文件。仅当厂商另行确认当前机型和固件支持服务端独占移动、保留原目录结构时，由 NAS 管理员配置该接口提供的媒体映射目录 CANGXIA_RECYCLE_MEDIA_ROOT。没有支持依据时，保持 NAS 文件删除停用。</p>
    {status?.verified&&<p>已通过当前挂载和服务身份的样本还原。已核对清理期限：{status.retention}。支持依据：{status.reference}</p>}
    {status?.reason&&<p>{status.reason}</p>}
    {status?.sample&&<p>验证样本：{status.sample}<br/>服务端原路径：{status.original}<br/>回收位置：{status.bin}<br/>SHA-256：{status.sha256||'正在登记'}</p>}
    {(!status?.token||['verified','failed'].includes(status.phase))?<fieldset disabled={blocked}><label><input type="checkbox" checked={supported} onChange={e=>setSupported(e.target.checked)}/>厂商已确认此映射和移动方式受支持，目标共享文件夹已启用回收站。</label>
      <label>机型、固件及厂商支持文档或工单 <input value={reference} maxLength={400} onChange={e=>setReference(e.target.value)}/></label>
      <label>已核对的清理期限 <input value={retention} maxLength={160} onChange={e=>setRetention(e.target.value)}/></label>
      <button className="button secondary" disabled={!supported||!retention.trim()||!reference.trim()} onClick={()=>action(()=>api.startTrashProbe({supported,retention,reference}))}>创建并移入专用验证样本</button></fieldset>:
    <><p>在绿联文件管理器的「回收站」内核对唯一文件名及原位置，并使用其「还原」操作。请保留验证样本，服务将继续核验字节并实测藏匣的还原入口。</p>
    {status.phase==='await-native'?<><label><input type="checkbox" checked={observed} onChange={e=>setObserved(e.target.checked)}/>已在绿联回收站核对该文件和原位置，并使用「还原」恢复。</label><button className="button primary" disabled={blocked||!observed} onClick={()=>action(()=>api.controlTrashProbe({token:status.token,action:'verify',observed}))}>核验原路径和内容</button></>:<button className="button secondary" disabled={blocked} onClick={()=>action(()=>api.controlTrashProbe({token:status.token,action:'retry'}))}>继续验证</button>}
    <button className="text-button" disabled={blocked} onClick={()=>action(()=>api.controlTrashProbe({token:status.token,action:'end'}))}>结束本次验证并保留样本</button></>}
    {error&&<p role="alert">{error}</p>}</div></Modal>;
}
