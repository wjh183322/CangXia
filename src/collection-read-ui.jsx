import React,{useState} from 'react';
import {RefreshCw,ListChecks,Play,Info,AlertCircle} from 'lucide-react';
import './collection-read-ui.css';
const number=n=>Number(n||0).toLocaleString('zh-CN');
export function CollectionReadSetup({info={},busy,onRead}){
  const [fullScan,setFullScan]=useState(null);
  function read(options){const known=options.resume?info.quick?.baselineKnown:info.baselineKnown;if(options.mode==='quick'&&!known)setFullScan(options);else onRead(options);}
  if(fullScan)return <><div className="modal-content collection-read-confirm"><Info size={28}/><h3>这次可能需要读取全部收藏</h3><p>这次检查没有可靠的历史对照，无法通过匹配旧作品提前停止。继续后会检查到当前可访问列表的末尾，收藏较多时可能需要较长时间。</p><div className="info-box"><p>你可以随时停止，已读取内容和进度会保留。读取不会自动下载作品。</p></div></div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={()=>setFullScan(null)}>返回</button><button className="button primary" disabled={busy} onClick={()=>onRead({...fullScan,allowFullScan:true})}>继续检查</button></footer></>;
  return <><div className="modal-content collection-read-setup">
    <div className="collection-read-choice"><span className="collection-read-icon"><RefreshCw size={23}/></span><div><h3>检查新增 <small>日常使用</small></h3><p>从最前面检查。与历史顺序连续匹配后停止，已有作品会更新，不重复添加。</p></div></div>
    <div className="collection-read-baseline"><Info size={15}/><p>{info.baselineKnown?'已有完整对照。连续匹配 60 条历史作品、且跨至少两页时停止；未检查的历史变化需完整核对。':'尚无可确认的完整对照。检查前会提示可能需要读取全部收藏。'}<br/>不设新增数量上限，到达列表末尾也会结束，可随时停止。</p></div>
    {['quick','full'].map(mode=>{const run=info[mode];if(!run)return null;return <div className={`collection-read-result ${run.warning?'attention':''}`} key={mode}><div><strong>{mode==='quick'?'上次新增检查':'上次完整核对'}</strong><span>已检查 {number(run.count)} 条 · {run.legacy?`旧版新增合计 ${number(run.added)} 条`:`前面新增 ${number(run.frontAdded)} 条 · 补齐记录 ${number(run.filled)} 条`}</span><p>{run.reason||'进度已保存在本机'}</p>{run.notReturned!==null&&run.notReturned!==undefined&&<p>历史记录中本轮未返回 {number(run.notReturned)} 条，继续保留。</p>}</div>{run.canResume&&<button className="button secondary" disabled={busy} onClick={()=>read({mode,resume:true})}><Play size={13}/>{mode==='quick'?'继续检查新增':'继续完整核对'}</button>}</div>;})}
    <details className="collection-read-full"><summary><ListChecks size={16}/>需要核对历史收藏？</summary><p>完整核对会从头读到当前可访问列表的末尾，补入中间新取得的记录；未返回的历史记录继续保留。两万条收藏可能需要较长时间，可停止后继续。</p><p>两种读取进度分别保存。结束后显示读取总结，并保存本机读取日志。</p><button className="button secondary" disabled={busy} onClick={()=>onRead({mode:'full'})}>从头完整核对</button></details>
  </div><footer className="modal-footer"><span className="collection-read-footnote">只读取当前收藏夹 · 不自动下载</span><button className="button primary" disabled={busy} onClick={()=>read({mode:'quick'})}><RefreshCw size={15}/>检查新增</button></footer></>;
}
