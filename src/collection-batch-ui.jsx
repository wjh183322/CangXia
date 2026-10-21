import React,{useState} from 'react';
import {RefreshCw,Info} from 'lucide-react';
const number=value=>Number(value||0).toLocaleString('zh-CN');

export function CollectionBatchSetup({collections,readInfo={},busy,onRead,onClose}){
 const [mode,setMode]=useState('quick'),[acknowledged,setAcknowledged]=useState(false);
 const folders=collections.filter(folder=>folder.added&&folder.id!=='__all__'),available=folders.filter(folder=>!folder.remoteMissing),missing=available.filter(folder=>!readInfo[folder.id]?.baselineKnown),needsAck=mode==='quick'&&missing.length>0;
 return <><div className="modal-content collection-batch-setup"><h3>同步已添加的 {number(folders.length)} 个自建收藏夹</h3><p>依次读取夹内作品，保留各夹历史记录和读取顺序。不会自动添加其他收藏夹或下载作品。</p>
  <fieldset disabled={busy}><legend>读取方式</legend><label><input type="radio" name="collection-batch-mode" aria-label="批量检查新增" checked={mode==='quick'} onChange={()=>setMode('quick')}/>检查新增（推荐）</label><small>从最新作品开始，与历史顺序连续匹配后停止。</small><label><input type="radio" name="collection-batch-mode" aria-label="批量完整核对" checked={mode==='full'} onChange={()=>setMode('full')}/>完整核对</label><small>每个收藏夹从头读到当前可访问列表末尾，可能需要较长时间。</small></fieldset>
  {needsAck&&<div className="collection-batch-warning"><p><Info size={15}/>以下 {number(missing.length)} 个收藏夹没有可靠的历史对照，检查新增也可能需要读到列表末尾：</p><ul>{missing.map(folder=><li key={folder.id}>{folder.name} · {folder.id}</li>)}</ul><label><input type="checkbox" aria-label="确认可能读到列表末尾" checked={acknowledged} disabled={busy} onChange={event=>setAcknowledged(event.target.checked)}/>我了解这些收藏夹可能需要完整读取</label></div>}
  {folders.length>available.length&&<p>其中 {number(folders.length-available.length)} 个收藏夹已不在可读取目录中，将跳过并保留已有内容。</p>}
  <p className="muted small">可随时停止，已读取内容及各夹进度保留。登录失效或平台限流时停止整批，其他单夹失败会记录原因。</p>
 </div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" aria-label="开始批量同步" disabled={busy||!available.length||needsAck&&!acknowledged} onClick={()=>onRead({allAdded:true,mode,allowFullScan:needsAck&&acknowledged})}><RefreshCw size={15}/>开始同步</button></footer></>;
}

export function CollectionBatchResults({batch,onClose,onLogs}){
 const labels={complete:'已完成',failed:'失败',skipped:'已跳过',paused:'已暂停',waiting:'待处理',running:'处理中'};
 return <><div className="modal-content collection-batch-results"><h3>{batch.message||'批量同步结束'}</h3><p>完成 {number(batch.succeeded)} · 失败 {number(batch.failed)} · 跳过 {number(batch.skipped)} · 未完成 {number((batch.pending||0)+(batch.paused||0))}</p><p className="muted small">{batch.includeTotal?'总收藏与自建收藏夹分别统计，同一作品可能出现在多个列表中。':'作品数量按各收藏夹分别统计。'}每个收藏夹保留独立读取日志；未完成的读取可进入对应收藏夹继续。</p><div className="collection-batch-list">{batch.items.map(item=><article key={item.id}><strong>{item.name}</strong><small>收藏夹 {item.id} · {labels[item.state]||item.state}</small>{item.summary&&<p>读取 {number(item.summary.checked)} 条 · 新增 {number(item.summary.added)} 条</p>}<p className={item.state==='failed'?'danger-text':'muted'}>{item.message||'尚未开始，已有记录保留'}</p></article>)}</div></div><footer className="modal-footer"><button className="button secondary" onClick={onLogs}>查看读取日志</button><button className="button primary" onClick={onClose}>关闭</button></footer></>;
}
