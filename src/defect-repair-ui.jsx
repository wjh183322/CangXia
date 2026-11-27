import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {AlertCircle,CheckCircle,ExternalLink,LoaderCircle,Pause,RefreshCw} from 'lucide-react';
import {Pagination} from './workspace-ui.jsx';
import './defect-repair.css';
import {restorePanelScroll} from './stored-detail-navigation.mjs';
const statuses=[['all','全部状态'],['checking','待检查'],['pending','待补齐'],['processing','处理中'],['downloadFailed','下载失败'],['repairFailed','补齐失败'],['complete','已补齐'],['unavailable','原作品已失效'],['sourceAvailable','核验可访问'],['sourceUnknown','暂无法确认原作品状态']];
const fileStatuses=[['all','全部文件状态'],['checking','待检查'],['pending','待补齐'],['processing','处理中'],['downloadFailed','下载失败'],['repairFailed','补齐失败'],['complete','无文件问题'],['blocked','无法检查']];
const sourceStatuses=[['all','全部原作品状态'],['unchecked','尚未核验'],['available','可访问'],['unavailable','原作品已失效'],['unknown','暂无法确认']];
const kinds=[['all','全部问题'],['cover','封面缺失／失败'],['files','缺损文件'],['video','视频缺失'],['image','图文图片缺失'],['invalid','文件异常'],['metadata','作品信息不完整'],['blocked','无法检查'],['source','原作品状态']];
const normalize=i=>{const status=i.status||({done:'complete',skipped:'complete',failed:'repairFailed',queued:'processing',running:'processing'}[i.state]||'pending');return {...i,issues:i.issues||[],status,fileStatus:i.fileStatus||(fileStatuses.some(([v])=>v===status)?status:(i.issues||[]).some(v=>v.kind!=='source')?'pending':'complete'),sourceStatus:i.sourceStatus||i.verification?.state||({unavailable:'unavailable',sourceAvailable:'available',sourceUnknown:'unknown'}[status]||'unchecked')};};
const actionable=value=>{const i=normalize(value);return !['complete','processing','checking','blocked'].includes(i.fileStatus)&&!['unavailable','unknown'].includes(i.sourceStatus)&&i.issues.some(v=>!['blocked','checking','source'].includes(v.kind));};
function fallback(report,job,view,status,sourceFilter,kind,page){const rows=(view==='results'?job?.items:report?.items||[])?.map(normalize)||[],counts={status:{},fileStatus:{},sourceStatus:{},kind:{}};for(const i of rows){for(const key of ['status','fileStatus','sourceStatus'])counts[key][i[key]]=(counts[key][i[key]]||0)+1;for(const key of new Set(i.issues.flatMap(v=>[v.kind,v.type].filter(Boolean))))counts.kind[key]=(counts.kind[key]||0)+1;}const chosen=rows.filter(i=>(status==='all'||i.fileStatus===status)&&(sourceFilter==='all'||i.sourceStatus===sourceFilter)&&(kind==='all'||i.issues.some(v=>v.kind===kind||v.type===kind))),pages=Math.max(1,Math.ceil(chosen.length/20));return {items:chosen.slice((page-1)*20,page*20),page,pages,total:chosen.length,repairable:chosen.filter(actionable).length,counts};}
export function DefectRepairPanel({report,job,busy,canWrite,canScan=true,getPage,onScan,onStart,onVerify,onStop,onResume,onOpenWork,onDetail,onExportDiagnostic,onClose,initialState}){
 const [selectedRepair,setSelectedRepair]=useState(new Set(initialState?.selection?.repairIds||[])),[excludedRepair,setExcludedRepair]=useState(new Set(initialState?.selection?.repairExclude||[])),[selected,setSelected]=useState(new Set(initialState?.selection?.ids||[])),[all,setAll]=useState(initialState?.selection?.all||false),[exclude,setExclude]=useState(new Set(initialState?.selection?.exclude||[])),[kind,setKind]=useState(initialState?.filters?.kind||'all'),[status,setStatus]=useState(initialState?.filters?.status||'all'),[sourceFilter,setSourceFilter]=useState(initialState?.filters?.sourceFilter||'all'),[page,setPage]=useState(initialState?.page||1),[tab,setTab]=useState(initialState?.tab||'problems'),[loaded,setLoaded]=useState(null),[error,setError]=useState(''),[selectionToken,setSelectionToken]=useState(initialState?.selection?.token||null),[selectionNotice,setSelectionNotice]=useState(''),listRef=useRef(null),restore=useRef(initialState),filtersMounted=useRef(false);
 const clear=()=>{setSelectedRepair(new Set());setExcludedRepair(new Set());setSelected(new Set());setAll(false);setExclude(new Set());};
 useEffect(()=>{if(!filtersMounted.current){filtersMounted.current=true;return;}clear();setPage(1);setSelectionNotice('');},[report?.token,report,kind,status,sourceFilter,tab]);
 const key=JSON.stringify([report?.token,job?.id,job?.overviewRevision,tab,status,sourceFilter,kind,page]);
 useEffect(()=>{if(!getPage||!report&&tab==='problems')return;let live=true;setError('');getPage({view:tab,page,fileStatus:status,sourceStatus:sourceFilter,kind}).then(value=>{if(live)setLoaded({key,value:{...value,items:value.items.map(normalize)}});}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[getPage,report,job,key]);
 const data=getPage?(loaded?.key===key?loaded.value:{items:[],total:0,pages:1,page:1,repairable:0,counts:{status:{},kind:{}}}):fallback(report,job,tab,status,sourceFilter,kind,page),active=!!job?.running,scanning=!!job?.scan?.running;
 useLayoutEffect(()=>{if(!restore.current||!data.items.length)return;restorePanelScroll(listRef.current,restore.current);const frame=window.requestAnimationFrame(()=>{restorePanelScroll(listRef.current,restore.current);restore.current=null;});return()=>window.cancelAnimationFrame(frame);},[data.items.length,key]);
 useEffect(()=>{if(all&&selectionToken&&data.token&&selectionToken!==data.token){clear();setSelectionNotice('问题结果已更新，原跨页全选已清除，请重新选择。');}},[all,selectionToken,data.token]);
 const showDetail=id=>onDetail?.(id,{panel:'defects',tab,page:data.page,filters:{status,sourceFilter,kind,jobId:job?.id},selection:{ids:[...selected],repairIds:[...selectedRepair],all,exclude:[...exclude],repairExclude:[...excludedRepair],token:selectionToken},scrollTop:listRef.current?.scrollTop||0,modalScrollTop:listRef.current?.closest('.modal')?.scrollTop||0});
 const progress=job?.kind==='verify'?(job.verified||0):(job?.processed||0),remaining=Math.max(0,(job?.total||0)-progress);
 const chosen=all?Math.max(0,(data.selectable??data.total)-exclude.size):selected.size,repairChosen=all?Math.max(0,data.repairable-excludedRepair.size):selectedRepair.size,checked=i=>all?!exclude.has(i.id):selected.has(i.id);
 const toggle=item=>{const id=item.id;if(actionable(item)){const update=all?setExcludedRepair:setSelectedRepair;update(old=>{const n=new Set(old);n.has(id)?n.delete(id):n.add(id);return n;});}const set=all?setExclude:setSelected;set(old=>{const n=new Set(old);n.has(id)?n.delete(id):n.add(id);return n;});};
 const selection=verify=>all&&data.token?{token:data.token,view:tab,fileStatus:status,sourceStatus:sourceFilter,kind,all:true,exclude:[...exclude]}:all?(tab==='results'?job?.items||[]:report?.items||[]).map(normalize).filter(i=>verify?i.fileStatus!=='processing':actionable(i)).filter(i=>(kind==='all'||i.issues.some(v=>v.kind===kind||v.type===kind))&&(status==='all'||i.fileStatus===status)&&(sourceFilter==='all'||i.sourceStatus===sourceFilter)&&!exclude.has(i.id)).map(i=>i.id):[...(verify?selected:selectedRepair)];
 const start=()=>onStart(selection(false));
 return <><div className="modal-content defect-content">
  <div className="info-box"><AlertCircle size={18}/><p>检查封面、下载失败和已下载作品的文件完整性。文件完整且无其他异常的作品不列入问题总览，原作品失效提示仍保留在列表与详情；本轮结果保留核验记录。未曾下载的正常作品不列入待补齐。按收藏顺序从新到旧排列。</p></div>
  {scanning&&<div className="defect-progress" role="status"><strong><LoaderCircle className="spin" size={16}/>正在后台检查文件与封面</strong><p>文件已检查 {job.scan.files?.checked||0} / {job.scan.files?.total||0} · 作品已检查 {job.scan.checked||0} / {job.scan.total||0}</p></div>}
  {job?.total>0&&<div className="defect-progress" role="status"><div><strong>{active?<LoaderCircle className="spin" size={16}/>:<CheckCircle size={16}/>} {job.message}</strong><span>{progress} / {job.total}</span></div><progress max={Math.max(1,job.total)} value={progress}/><small>{job.kind==='verify'?<>本轮已核验 {job.verified||0} · 可访问 {job.sourceAvailable||0} · 已失效 {job.sourceUnavailable||0} · 暂无法确认 {job.sourceUnknown||0} · 待核验 {remaining}</>:<>已补齐 {job.done} · 等待／下载中 {job.queued} · 仍失败 {job.failed} · 已失效 {job.sourceUnavailable||0}</>}</small></div>}
  <div className="defect-tabs"><button className={tab==='problems'?'active':''} onClick={()=>setTab('problems')}>问题总览 {tab==='problems'?Object.values(data.counts.fileStatus||data.counts.status||{}).reduce((a,b)=>a+b,0):(report?.total??report?.items?.length??0)}</button><button className={tab==='results'?'active':''} disabled={!job?.total} onClick={()=>setTab('results')}>本轮结果</button></div>
  <div className="defect-controls"><span>{report?.checked?`上次全库检查 ${report.checked} 条本机记录`:'尚未进行全库检查，已保留已知问题'}</span><button className="button secondary" disabled={busy||active||scanning||!canScan} onClick={()=>onScan()}><RefreshCw size={14}/>{scanning?'正在检查…':'检查全部'}</button><button className="button secondary" disabled={busy||active||scanning||!canScan||!chosen} onClick={()=>onScan(selection(true))}>检查选中（{chosen}）</button></div>
  <div className="defect-filters"><label>文件与处理状态<select aria-label="处理状态" value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}>{fileStatuses.map(([v,t])=><option key={v} value={v}>{t}{v==='all'?'':`（${(data.counts.fileStatus||data.counts.status||{})[v]||0}）`}</option>)}</select></label><label>原作品状态<select aria-label="原作品状态" value={sourceFilter} onChange={e=>{setSourceFilter(e.target.value);setPage(1);}}>{sourceStatuses.map(([v,t])=><option key={v} value={v}>{t}{v==='all'?'':`（${data.counts.sourceStatus?.[v]||0}）`}</option>)}</select></label><label>问题类型<select aria-label="问题类型" value={kind} onChange={e=>{setKind(e.target.value);setPage(1);}}>{kinds.map(([v,t])=><option key={v} value={v}>{t}{v==='all'?'':`（${data.counts.kind[v]||0}）`}</option>)}</select></label></div><small className="defect-count-note">问题总数按作品去重；文件与原作品状态可同时成立，各类数量可能重叠。</small>
  <div className="defect-select"><button className="text-button" disabled={busy||active||!(data.selectable??data.total)} onClick={()=>{setAll(true);setSelectionToken(data.token||null);setSelectionNotice('');setExclude(new Set());setExcludedRepair(new Set());setSelectedRepair(new Set());setSelected(new Set());}}>全选当前筛选结果（{data.selectable??data.total}）</button><button className="text-button" disabled={busy||active||!chosen} onClick={clear}>取消选择</button><span>已选 {chosen} 个 · 可补齐 {repairChosen} 个 · 覆盖所有分页</span></div>
  {report?.cancelled&&<p role="status">检查已停止，保留已检查的部分结果；剩余作品尚未检查。</p>}{selectionNotice&&<p role="status">{selectionNotice}</p>}{(error||job?.overviewError)&&<p role="alert">{error||job.overviewError}</p>}
  <div className="defect-list" ref={listRef}>{data.items.map(item=><article key={item.id}><input aria-label={'选择补齐 '+item.id} type="checkbox" disabled={item.status==='processing'||active||busy} checked={checked(item)} onChange={()=>toggle(item)}/><div>{onDetail?<button className="defect-work-title" title="查看作品详情" aria-label={'查看检查作品详情 '+item.id} disabled={busy} onClick={()=>showDetail(item.id)}><strong title={item.name}>{item.name}</strong></button>:<strong title={item.name}>{item.name}</strong>}{onExportDiagnostic&&<button className="text-button" aria-label={'导出作品诊断 '+item.id} onClick={()=>onExportDiagnostic(item.id)}>导出诊断</button>}<small>{item.author} · {item.source} · {item.id}</small><span className="defect-status">{fileStatuses.find(([v])=>v===item.fileStatus)?.[1]} · {sourceStatuses.find(([v])=>v===item.sourceStatus)?.[1]}</span>{item.message&&<p>{item.message}</p>}{item.issues.map((issue,index)=><p key={index}><b>{issue.label}</b>：{issue.reason}</p>)}</div><button className="icon-button" aria-label={'打开原作品 '+item.id} disabled={active||busy} onClick={()=>onOpenWork(item.id)}><ExternalLink size={16}/></button></article>)}{!data.items.length&&<div className="complete-message"><CheckCircle size={32}/><h3>{busy?'正在加载已保存的问题…':!report?.checked&&!data.total?'尚无检查结果，请手动检查全部':'没有符合筛选条件的作品'}</h3></div>}</div>
  {data.pages>1&&<Pagination page={data.page} pages={data.pages} onChange={setPage} location="检查列表"/>}
 </div><footer className="modal-footer"><button className="button secondary" disabled={active||busy} onClick={onClose}>关闭</button>{scanning?<button className="button secondary" onClick={onStop}>停止检查</button>:active?<button className="button secondary" onClick={onStop}><Pause size={15}/>{job?.kind==='verify'?'停止核验':'停止补齐'}</button>:<>{job&&(job.phase==='paused'||job.failed>0)&&<button className="button secondary" disabled={busy||!canWrite} onClick={onResume}>继续未完成 / 重试失败项</button>}{onVerify&&<button className="button secondary" disabled={busy||!canWrite||!chosen} onClick={()=>onVerify(selection(true))}>核验原作品状态（{chosen}）</button>}<button className="button primary" disabled={busy||!canWrite||!repairChosen} onClick={start}>补齐选中 {repairChosen} 个</button></>}</footer></>;
}

const stages = {
  files: '文件',
  source: '来源',
  download: '下载',
  registration: '登记',
  cleanup: '清理',
  cover: '封面'
};
const checkKinds = {
  files: '文件检查',
  source: '来源核验',
  repair: '补齐入队',
  storage: '存储统计',
  reconcile: '归档整理'
};
const checkStates = { running: '进行中', complete: '已完成', paused: '已暂停', failed: '失败' };
const fileStates = {
  pending: '待补齐',
  blocked: '需要核对',
  complete: '已核对',
  queued: '已入队',
  failed: '失败'
};
const sourceStates = {
  available: '可访问',
  unavailable: '不可访问',
  unknown: '暂无法确认',
  unchecked: '尚未核验'
};
export function ServerMaintenancePanel({ api, initialId, initialState, onDetail, onClose }) {
  const [id, setId] = useState(initialId),
    [historyPage, setHistoryPage] = useState(initialState?.historyPage ?? 1),
    [history, setHistory] = useState(null);
  const [page, setPage] = useState(initialState?.page ?? 1),
    [fileStatus, setFilter] = useState(initialState?.fileStatus ?? 'all'),
    [stage, setStage] = useState(initialState?.stage ?? 'all'),
    [sourceStatus, setSource] = useState(initialState?.sourceStatus ?? 'all');
  const [report, setReport] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  const [marked, setMarked] = useState(initialState?.marked ?? { key: '', ids: [], all: false });
  const latest = useRef(0);
  useEffect(() => {
    let live = true,
      timer;
    async function load() {
      try {
        const past = await api.defectOverview({ page: historyPage });
        if (!live) return;
        setHistory(past);
        const current = id ?? past.items[0]?.id;
        if (!current) {
          setReport(null);
          return;
        }
        const next = await api.defectPage({
          id: current,
          page,
          fileStatus,
          sourceStatus,
          stage,
          follow: true
        });
        if (!live) return;
        if (next.page !== page) setPage(next.page);
        setReport(next);
        setError('');
        if (next.state === 'running' || next.pendingJobs > 0) timer = setTimeout(load, 450);
      } catch (e) {
        if (live) setError(e.message);
      }
    }
    setReport(null);
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, id, page, stage, sourceStatus, fileStatus, historyPage, refresh]);
  useEffect(
    () => () => {
      latest.current++;
    },
    []
  );
  const key = JSON.stringify([
    report?.id,
    report?.version,
    report?.revision,
    fileStatus,
    sourceStatus,
    stage
  ]);
  const selected = marked.key === key ? marked : { key, ids: [], all: false };
  const selection = report && {
    id: report.id,
    version: report.version,
    revision: report.revision,
    fileStatus,
    sourceStatus,
    stage,
    ids: selected.ids,
    all: selected.all
  };
  const count = selected.all ? (report?.count ?? 0) - selected.ids.length : selected.ids.length;
  const pick = (next) => {
    setId(next);
    setPage(1);
    setFilter('all');
    setSource('all');
    setStage('all');
    setMarked({ key: '', ids: [], all: false });
  };
  async function act(fn, follow = true) {
    const sequence = ++latest.current;
    setBusy(true);
    setError('');
    try {
      const result = await fn();
      if (sequence !== latest.current) return;
      if (follow && result?.id) pick(result.id);
      setRefresh((n) => n + 1);
    } catch (e) {
      if (sequence === latest.current) setError(e.message);
    } finally {
      if (sequence === latest.current) setBusy(false);
    }
  }
  const running = report?.state === 'running';
  return (
    <>
      <div className="modal-content defect-content" data-maintenance-history>
        {history?.problems && (
          <p>
            当前登记问题（按作品） ·{' '}
            {Object.entries(stages)
              .map(([k, label]) => label + ' ' + (history.problems[k] ?? 0))
              .join(' · ')}
          </p>
        )}
        <div className="defect-controls">
          <button
            className="button primary"
            disabled={busy || running}
            onClick={() => act(() => api.inspectDefects())}
          >
            检查全部文件
          </button>
          {history?.pendingArchive > 0 && (
            <button
              className="button secondary"
              disabled={busy || running}
              onClick={() => act(() => api.resumeReconcile(history.revision))}
            >
              继续整理 {history.pendingArchive} 个归档
            </button>
          )}
          <select
            aria-label="检查记录"
            value={id ?? history?.items[0]?.id ?? ''}
            onChange={(e) => pick(e.target.value)}
          >
            {!history?.items.length && <option value="">尚无检查记录</option>}
            {history?.items.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.created).toLocaleString()} · {checkKinds[r.kind]} · {checkStates[r.state]}
              </option>
            ))}
          </select>
          {historyPage > 1 && (
            <button
              onClick={() => {
                setId(undefined);
                setPage(1);
                setHistoryPage((p) => p - 1);
              }}
            >
              较新记录
            </button>
          )}
          {history?.hasMore && (
            <button
              onClick={() => {
                setId(undefined);
                setPage(1);
                setHistoryPage((p) => p + 1);
              }}
            >
              更早记录
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="danger-text">
            {error}
          </p>
        )}
        {report && (
          <>
            <p data-check-state={report.state}>
              {checkKinds[report.kind]} · {checkStates[report.state]} · 已处理 {report.processed} /{' '}
              {report.total} {report.reason}
            </p>
            {report.kind === 'storage' && report.totals && (
              <p>
                归档 {report.totals.archiveBytes} 字节 · 暂存 {report.totals.stagingBytes} 字节
              </p>
            )}
            <div className="defect-filters">
              <label>
                文件状态
                <select
                  value={fileStatus}
                  onChange={(e) => {
                    setPage(1);
                    setFilter(e.target.value);
                  }}
                >
                  <option value="all">全部</option>
                  {Object.entries(fileStates).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                来源状态
                <select
                  value={sourceStatus}
                  onChange={(e) => {
                    setPage(1);
                    setSource(e.target.value);
                  }}
                >
                  <option value="all">全部</option>
                  {Object.entries(sourceStates).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                问题阶段
                <select
                  value={stage}
                  onChange={(e) => {
                    setPage(1);
                    setStage(e.target.value);
                  }}
                >
                  {Object.entries({ all: '全部', ...stages }).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                      {k !== 'all' ? '（' + (report.stageCounts[k] ?? 0) + '）' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="defect-select">
              <button
                disabled={busy || running || !report.count}
                onClick={() => setMarked({ key, ids: [], all: true })}
              >
                全选筛选结果（{report.count}）
              </button>
              <button disabled={!count} onClick={() => setMarked({ key, ids: [], all: false })}>
                取消选择
              </button>
              <span>已选 {count} 个</span>
            </div>
            <div className="defect-list">
              {report.items.map((item) => (
                <article key={item.workId}>
                  <input
                    type="checkbox"
                    aria-label={'选择作品 ' + item.workId}
                    disabled={busy || running}
                    checked={selected.all !== selected.ids.includes(item.workId)}
                    onChange={() =>
                      setMarked({
                        ...selected,
                        ids: selected.ids.includes(item.workId)
                          ? selected.ids.filter((id) => id !== item.workId)
                          : [...selected.ids, item.workId]
                      })
                    }
                  />
                  <div>
                    <button
                      className="text-button"
                      onClick={() =>
                        onDetail(item.workId, {
                          panel: 'serverChecks',
                          run: report.id,
                          page,
                          fileStatus,
                          sourceStatus,
                          stage,
                          historyPage,
                          marked: selected
                        })
                      }
                    >
                      作品 {item.workId}
                    </button>
                    <p>
                      {fileStates[item.fileStatus]}
                      {!item.jobs && item.downloadState && ' · 下载状态 ' + item.downloadState} · 来源
                      {sourceStates[item.sourceStatus]}{' '}
                      {item.verified !== undefined &&
                        ' · 已验证 ' + item.verified + ' 个文件，' + item.bytes + ' 字节'}
                    </p>
                    {item.jobs?.map((j) => (
                      <p key={j.id} data-repair-job={j.id} data-job-state={j.state}>
                        {{ audio: '配乐', 'cover-hd': '高清封面', media: '作品媒体' }[j.scope]} ·{' '}
                        {
                          {
                            queued: '已入队',
                            running: '处理中',
                            complete: '已完成',
                            cancelled: '已取消',
                            failed: '失败',
                            review: '待核对',
                            paused: '已暂停',
                            pausing: '正在暂停',
                            cancelling: '正在取消',
                            unavailable: '来源不可用',
                            'waiting-rate': '等待限流解除',
                            'waiting-auth': '等待登录',
                            'finalization-pending': '等待登记'
                          }[j.state]
                        }
                      </p>
                    ))}
                    {item.registration && (
                      <p>
                        归档登记 ·{' '}
                        {
                          {
                            pending: '等待所选媒体完成后登记',
                            complete: '已完成',
                            failed: '失败，请核对文件后重试'
                          }[item.registration]
                        }
                      </p>
                    )}
                    {item.issues.map((i, n) => (
                      <p key={n}>
                        {i.scope &&
                          { audio: '配乐', 'cover-hd': '高清封面', media: '作品媒体', archive: '归档登记' }[
                            i.scope
                          ] + ' · '}
                        {i.key && i.key + ' · '}
                        {i.reason}
                      </p>
                    ))}
                  </div>
                  <button
                    className="text-button"
                    onClick={() => act(() => api.openOriginal(item.workId), false)}
                  >
                    原作品
                  </button>
                  <button
                    className="text-button"
                    onClick={() => act(() => api.exportWorkDiagnostic(item.workId), false)}
                  >
                    导出诊断
                  </button>
                </article>
              ))}
            </div>
            <div className="defect-select">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                上一页
              </button>
              <span>
                {page} / {report.pages}
              </span>
              <button disabled={page >= report.pages} onClick={() => setPage((p) => p + 1)}>
                下一页
              </button>
            </div>
          </>
        )}
      </div>
      <footer className="modal-footer">
        {running ? (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => act(() => api.stopDefectRepair(report.id))}
          >
            停止本次检查
          </button>
        ) : (
          <>
            {['paused', 'failed'].includes(report?.state) && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => act(() => api.resumeDefectRepair(report.id))}
              >
                继续未处理项
              </button>
            )}
            <button
              className="button secondary"
              disabled={busy || !count}
              onClick={() => act(() => api.verifySources(selection))}
            >
              核验所选来源
            </button>
            <button
              className="button primary"
              disabled={busy || !count}
              onClick={() => act(() => api.startDefectRepair(selection))}
            >
              复查并补齐所选缺失文件
            </button>
          </>
        )}
        <button className="button secondary" onClick={onClose}>
          关闭
        </button>
      </footer>
    </>
  );
}
