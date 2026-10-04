import React,{useState} from 'react';
import {RefreshCw,ListChecks,Play,Info,AlertCircle} from 'lucide-react';
import './collection-read-ui.css';
const number=n=>Number(n||0).toLocaleString('zh-CN');
export function CollectionReadSetup({info={},busy,onRead,onConfirm}){
  const [confirm,setConfirm]=useState(null);
  if(confirm)return <><div className="modal-content collection-read-confirm"><AlertCircle size={28}/><h3>确认采用这次返回的列表？</h3><p>原有 {number(confirm.oldCount)} 条收藏关系，这次仅返回 {number(confirm.count)} 条。平台可能暂时没有返回全部内容。</p><div className="info-box"><p>确认后，未出现在本次列表中的作品不再属于当前收藏夹；本地已下载的文件和作品资料仍保留。</p></div><p className="muted">若不确定，建议保留旧记录，稍后重新完整核对。</p></div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={()=>setConfirm(null)}>保留旧记录</button><button className="button primary" disabled={busy} onClick={()=>onConfirm(confirm)}>确认采用本次列表</button></footer></>;
  return <><div className="modal-content collection-read-setup">
    <div className="collection-read-choice"><span className="collection-read-icon"><RefreshCw size={23}/></span><div><h3>检查新增 <small>日常使用</small></h3><p>从最前面检查。与历史顺序连续匹配后停止，已有作品会更新，不重复添加。</p></div></div>
    <div className="collection-read-baseline"><Info size={15}/><p>{info.baselineKnown?'已有完整对照。快速检查只核对前段，不能确认历史作品是否取消收藏。':'尚无可确认的完整对照。本次先检查前段，不会自动读完全部收藏。'}<br/>每段约 500 条或 20 页，达到上限后可手动继续。</p></div>
    {['quick','full'].map(mode=>{const run=info[mode];if(!run)return null;return <div className={`collection-read-result ${run.outcome==='review'?'attention':''}`} key={mode}><div><strong>{mode==='quick'?'上次新增检查':'上次完整核对'}</strong><span>已检查 {number(run.count)} 条 · 新增收藏 {number(run.added)} 条{run.restored?` · 恢复记录 ${number(run.restored)} 条`:''}</span><p>{run.reason||'进度已保存在本机'}</p></div>{run.canResume&&<button className="button secondary" disabled={busy} onClick={()=>onRead({mode,resume:true})}><Play size={13}/>{mode==='quick'?'继续检查一段':'继续完整核对'}</button>}{run.canConfirm&&<button className="button secondary" disabled={busy} onClick={()=>setConfirm(run)}>查看并确认</button>}</div>;})}
    <details className="collection-read-full"><summary><ListChecks size={16}/>需要核对历史收藏？</summary><p>完整核对会从头读到当前可访问列表的末尾。两万条收藏可能需要较长时间，可停止后继续。</p><p>两种读取进度分别保存。中途有新的读取更新时，旧进度会保守保留最新顺序。</p><button className="button secondary" disabled={busy} onClick={()=>onRead({mode:'full'})}>从头完整核对</button></details>
  </div><footer className="modal-footer"><span className="collection-read-footnote">只读取当前收藏夹 · 不自动下载</span><button className="button primary" disabled={busy} onClick={()=>onRead({mode:'quick'})}><RefreshCw size={15}/>检查新增</button></footer></>;
}
