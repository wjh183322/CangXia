import {ReadCountLine,ReadReturnNote} from './read-history-counts.jsx';
import React,{useState} from 'react';
import {RefreshCw,ListChecks,Play,Info,AlertCircle} from 'lucide-react';
import './collection-read-ui.css';
const number=n=>Number(n||0).toLocaleString('zh-CN');
export function CollectionReadSetup({info={},busy,onRead,followupFolders=null,readInfo={}}){
  const [fullScan,setFullScan]=useState(null),[syncCollections,setSyncCollections]=useState(false);
  const linked=followupFolders!==null&&syncCollections;
  function read(options){
    const request={...options,...(linked?{syncCollections:true}:{})};
    const missing=[];
    if(!(options.resume?info.quick?.baselineKnown:info.baselineKnown))missing.push('当前收藏');
    if(linked)for(const folder of followupFolders){const data=readInfo[folder.id]||{};if(!(options.resume&&data.quick?.canResume?data.quick.baselineKnown:data.baselineKnown))missing.push(folder.name+' · '+folder.id);}
    if(options.mode==='quick'&&missing.length)setFullScan({request,missing});else onRead(request);
  }
  if(fullScan)return <><div className="modal-content collection-read-confirm"><Info size={28}/><h3>这次可能需要读取全部收藏</h3><p>以下收藏没有可靠的历史对照，无法通过匹配旧作品提前停止。继续后会检查到当前可访问列表的末尾，收藏较多时可能需要较长时间。</p><ul>{fullScan.missing.map(name=><li key={name}>{name}</li>)}</ul><div className="info-box"><p>你可以随时停止，已读取内容和进度会保留。读取不会自动下载作品。</p></div></div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={()=>setFullScan(null)}>返回</button><button className="button primary" disabled={busy} onClick={()=>onRead({...fullScan.request,allowFullScan:true})}>继续检查</button></footer></>;
  return <><div className="modal-content collection-read-setup">
    <div className="collection-read-choice"><span className="collection-read-icon"><RefreshCw size={23}/></span><div><h3>检查新增 <small>日常使用</small></h3><p>从最前面检查。与历史顺序连续匹配后停止，已有作品会更新，不重复添加。</p></div></div>
    <div className="collection-read-baseline"><Info size={15}/><p>{info.baselineKnown?'已有完整对照。连续匹配 60 条历史作品、且跨至少两页时停止；未检查的历史变化需完整核对。':'尚无可确认的完整对照。检查前会提示可能需要读取全部收藏。'}<br/>不设新增数量上限，到达列表末尾也会结束，可随时停止。</p></div>
    {followupFolders!==null&&<div className="collection-followup"><label><input type="checkbox" aria-label="同步自建收藏夹" checked={syncCollections} disabled={busy} onChange={event=>setSyncCollections(event.target.checked)}/>同步自建收藏夹</label><p>总收藏完成后，以相同方式依次读取已添加的 {number(followupFolders.length)} 个可读取自建收藏夹。继续读取时，各夹有对应进度就继续，没有则从头开始。停止会结束整个流程。</p></div>}
    {['quick','full'].map(mode=>{const run=info[mode];if(!run)return null;return <div className={`collection-read-result ${run.warning?'attention':''}`} key={mode}><div><strong>{mode==='quick'?'上次新增检查':'上次完整核对'}</strong><ReadCountLine summary={run}/><ReadReturnNote summary={run}/><p>{run.reason||'进度已保存在本机'}</p>{run.notReturned!==null&&run.notReturned!==undefined&&<p>历史记录中本轮未返回 {number(run.notReturned)} 条，继续保留。</p>}</div>{run.canResume&&<button className="button secondary" disabled={busy} onClick={()=>read({mode,resume:true})}><Play size={13}/>{mode==='quick'?'继续检查新增':'继续完整核对'}</button>}</div>;})}
    <details className="collection-read-full"><summary><ListChecks size={16}/>需要核对历史收藏？</summary><p>完整核对会从头读到当前可访问列表的末尾，补入中间新取得的记录；未返回的历史记录继续保留。两万条收藏可能需要较长时间，可停止后继续。</p><p>两种读取进度分别保存。结束后显示读取总结，并保存本机读取日志。</p><button className="button secondary" disabled={busy} onClick={()=>read({mode:'full'})}>从头完整核对</button></details>
  </div><footer className="modal-footer"><span className="collection-read-footnote">{linked?'总收藏及已添加自建收藏夹':'只读取当前收藏夹'} · 不自动下载</span><button className="button primary" disabled={busy} onClick={()=>read({mode:'quick'})}><RefreshCw size={15}/>检查新增</button></footer></>;
}
