import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Volume2, VolumeX, X, Info, Check, Pause, Play } from 'lucide-react';
import {AudioPlayback} from './work-audio-ui.jsx';
import {restorePanelScroll} from './stored-detail-navigation.mjs';
import {localSize} from '../shared/local-size.mjs';
import './local-size.css';
export function LocalSizeLabel({work}){const value=localSize(work);let bytes=value.bytes,unit=0;const units=['B','KB','MB','GB','TB'];while(bytes>=1024&&unit<units.length-1){bytes/=1024;unit++;}return <small className="local-size-label" title="已登记的作品文件；共享配乐、缓存及未登记文件另计">{work.audioOnly?'仅配乐（共享）':value.known?`${bytes.toFixed(unit?1:0)} ${units[unit]} 已登记文件`:'大小待确认'}{work.localAudio&&!work.audioOnly?' · 配乐另计':''}</small>;}

const Sound = createContext(null);
export const useSound=()=>useContext(Sound);
export function SoundProvider({children}) {
  // Session-only state. Deliberately never read or write localStorage or persisted settings.
  const [volume,setVolume]=useState(0), [last,setLast]=useState(0.5);
  const active=useRef(null);const claim=(key,stop)=>{if(active.current?.key!==key)active.current?.stop?.();active.current={key,stop};};
  const update=value=>{const n=Math.max(0,Math.min(1,Number(value)));if(n>0)setLast(n);setVolume(n);};
  return <Sound.Provider value={{volume,update,claim,toggle:()=>update(volume?0:last)}}>{children}</Sound.Provider>;
}
export function VolumeControl() {
  const {volume,update,toggle}=useContext(Sound);
  return <div className="volume-control"><button aria-label={volume?'静音':'取消静音'} onClick={toggle}>{volume?<Volume2 size={17}/>:<VolumeX size={17}/>}</button><input type="range" min="0" max="100" step="1" aria-label="全局音量" value={Math.round(volume*100)} onChange={e=>update(Number(e.target.value)/100)}/><span>{Math.round(volume*100)}%</span></div>;
}
export function MediaVideo({autoPlay=false,suspended=false,...props}) {
  const ref=useRef(null), {volume,update,claim}=useContext(Sound),key=useRef(crypto.randomUUID());
  useLayoutEffect(()=>{const v=ref.current;if(v){v.volume=volume;v.muted=volume===0;}},[volume]);
  useEffect(()=>{const v=ref.current;if(!v)return;if(suspended)v.pause();else if(autoPlay)v.play().catch(()=>{});},[suspended,autoPlay,props.src]);
  return <video {...props} ref={ref} autoPlay={autoPlay&&!suspended} muted={volume===0} onPlay={e=>{claim('video:'+key.current,()=>ref.current?.pause());props.onPlay?.(e);}} onVolumeChange={e=>{const v=e.currentTarget;const next=v.muted?0:v.volume;if(Math.abs(next-volume)>.001)update(next);}}/>;
}
export function CoverAction({local,onBrowse,onDetail,children,...props}) {
  const timer=useRef(null);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  return <button {...props} title={local?'单击浏览 · 双击详情':'查看作品详情'} onClick={e=>{
    if(!local)return onDetail();clearTimeout(timer.current);
    if(e.detail===0)return onBrowse();
    timer.current=setTimeout(onBrowse,550);
  }} onDoubleClick={()=>{clearTimeout(timer.current);onDetail();}}>{children}</button>;
}
export function mediaFor(work) {
  const assets=(work?.localRecord?.assets||[]).filter(a=>a.exists);
  if(work?.type==='video'){
    const cover=assets.find(a=>a.key===work.localRecord?.hdCover?.key)||assets.filter(a=>a.kind==='image').sort((a,b)=>(b.width||0)*(b.height||0)-(a.width||0)*(a.height||0))[0];
    return [...(cover?[cover]:[]),...assets.filter(a=>a.kind==='video')];
  }
  return [...assets.filter(a=>a.kind==='image').sort((a,b)=>Number(a.key.replace('image-',''))-Number(b.key.replace('image-',''))),...assets.filter(a=>a.kind==='video')];
}
export function Viewer({work,index,total,onWork,onClose,onDetail,suspended,api}) {
  const [mediaIndex,setMediaIndex]=useState(0), [error,setError]=useState(false);
  const media=mediaFor(work), current=media[mediaIndex];
  useEffect(()=>{setMediaIndex(0);setError(false);},[work?.id]);
  useEffect(()=>setError(false),[mediaIndex]);
  useEffect(()=>{
    if(suspended)return;
    const key=e=>{
      if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable)return;
      if(e.key==='Escape'){e.preventDefault();onClose();}
      if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();setMediaIndex(n=>Math.max(0,Math.min(media.length-1,n+(e.key==='ArrowLeft'?-1:1))));}
      if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();onWork(e.key==='ArrowUp'?-1:1);}
    };document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);
  },[suspended,media.length,onWork,onClose]);
  if(!work)return null;
  return <section className="viewer" role="dialog" aria-label="本地浏览模式" aria-modal={!suspended}>
    <header><div><strong>{work.name}</strong><small>@{work.author.nickname} · 作品 {index+1} / {total}</small></div><VolumeControl/><button className="button" onClick={onDetail}><Info size={17}/>详情</button><button aria-label="关闭浏览模式" onClick={onClose}><X/></button></header>
    <div className="viewer-stage"><button aria-label="上一张媒体" disabled={mediaIndex<=0} onClick={()=>setMediaIndex(n=>n-1)}><ArrowLeft/></button>
      <div className="viewer-media" onDoubleClick={onDetail}>{current&&!error?(current.kind==='video'?<MediaVideo key={`${work.id}-${current.key}`} src={current.url} controls autoPlay suspended={suspended} onError={()=>setError(true)}/>:<img key={`${work.id}-${current.key}`} src={current.url} alt={current.file} onError={()=>setError(true)}/>):<p>{error?'本地媒体无法播放或读取，可在详情中检查文件。':'没有可浏览的本地图片或视频，请补齐文件。'}</p>}</div>
      <button aria-label="下一张媒体" disabled={mediaIndex>=media.length-1} onClick={()=>setMediaIndex(n=>n+1)}><ArrowRight/></button>
      <div className="work-arrows"><button aria-label="上一个作品" disabled={index<=0} onClick={()=>onWork(-1)}><ArrowUp/></button><button aria-label="下一个作品" disabled={index>=total-1} onClick={()=>onWork(1)}><ArrowDown/></button></div>
    </div>
    {work.type==='images'&&api?.audioPrepare&&<div className="viewer-audio-bar"><AudioPlayback key={work.id} api={api} work={work} suspended={suspended||current?.kind==='video'}/></div>}<footer><span>{current?`${current.kind==='video'?'视频':current.source==='video_frame'?'视频截帧':'图片'} ${mediaIndex+1} / ${media.length}${current.width&&current.height?` · ${current.width}×${current.height}`:''}`:'媒体缺失'}</span><span>← → 切换图片 / 视频　↑ ↓ 切换作品　双击画面查看详情</span>{work.remoteState==='unavailable'&&<b>原作品已失效</b>}</footer>
  </section>;
}
export function TagRow({title,selected,onRemove,onOpen,mode}) {
  return <div className="tag-filter-row"><button className="button filter-button" onClick={onOpen}>{title}{selected.length?` · ${selected.length}`:''}</button><div>{selected.length?selected.map(t=><button className="tag-chip" key={t} onClick={()=>onRemove(t)}>#{t}<X size={12}/></button>):<span>不限</span>}</div>{!!selected.length&&<small>{mode==='all'?'全部满足':'满足任意'}</small>}</div>;
}
export function TagChoices({values,selected,onChange,mode,onMode}) {
  const [query,setQuery]=useState('');
  const matches=values.filter(t=>t.toLowerCase().includes(query.toLowerCase()));
  return <><input className="choice-search" placeholder="搜索标签" aria-label="搜索标签" value={query} onChange={e=>setQuery(e.target.value)}/><div className="tag-mode">{[['any','满足任意'],['all','全部满足']].map(([v,label])=><button key={v} className={mode===v?'active':''} onClick={()=>onMode(v)}>{label}</button>)}</div><div className="tag-options">{matches.slice(0,200).map(t=><button key={t} className={selected.includes(t)?'selected':''} onClick={()=>onChange(selected.includes(t)?selected.filter(x=>x!==t):[...selected,t])}>#{t}{selected.includes(t)&&<Check size={12}/>}</button>)}{!matches.length&&<p>暂无匹配标签</p>}</div>{matches.length>200&&<p className="muted">显示前 200 项，请搜索缩小范围。</p>}<button className="text-button" onClick={()=>onChange([])}>清空选择</button></>;
}
export function ChoiceList({values,selected,onChange}) {
  const [query,setQuery]=useState('');
  return <><input className="choice-search" aria-label="搜索筛选项" placeholder="搜索筛选项" value={query} onChange={e=>setQuery(e.target.value)}/><div className="choice-list">{values.filter(([,label])=>label.toLowerCase().includes(query.toLowerCase())).map(([id,label])=><button key={id} className={selected===id?'selected':''} onClick={()=>onChange(id)}>{label}{selected===id&&<Check size={16}/>}</button>)}</div></>;
}
export function TagEditor({work,allTags,onSave,onFilter,busy}) {
  const [draft,setDraft]=useState(work.localTags||[]), [input,setInput]=useState(''),[query,setQuery]=useState('');
  useEffect(()=>setDraft(work.localTags||[]),[work.id,JSON.stringify(work.localTags)]);
  return <div className="local-tag-editor"><label>我的标签</label><div className="detail-tags">{(work.localTags||[]).map(t=><button key={t} onClick={()=>onFilter(t)}>#{t}</button>)}</div><p className="muted small">点击上方标签筛选；在下方勾选标注后保存。</p><input className="choice-search" placeholder="搜索已有的我的标签" value={query} onChange={e=>setQuery(e.target.value)}/><div className="tag-options quick-tags">{[...new Set([...draft,...allTags])].filter(t=>t.toLowerCase().includes(query.toLowerCase())).slice(0,150).map(t=><button key={t} className={draft.includes(t)?'selected':''} onClick={()=>setDraft(draft.includes(t)?draft.filter(x=>x!==t):[...draft,t])}>{draft.includes(t)&&<Check size={12}/>}#{t}</button>)}</div><form onSubmit={e=>{e.preventDefault();const t=input.trim().replace(/^#/,'');if(t){setDraft([...new Set([...draft,t])]);setInput('');}}}><input value={input} onChange={e=>setInput(e.target.value)} placeholder="新建我的标签" maxLength={80}/><button type="submit">添加</button></form><button className="button secondary" disabled={busy||JSON.stringify(draft)===JSON.stringify(work.localTags||[])} onClick={()=>onSave(draft)}>保存标注</button></div>;
}
export function DownloadManager({queue,getPage,onClear,onToggle,onRetry,onRetryFailed,onDetail,onVerify,onConcurrency,onCancel,onContinuePreparation,cancelBusy=false,busy,initialState}) {
  const [tab,setTab]=useState(initialState?.tab||'active'),[selected,setSelected]=useState(initialState?.selection?.ids||[]),[page,setPage]=useState(initialState?.page||1),listRef=useRef(null),restore=useRef(initialState),tabMounted=useRef(false);
  const [pageData,setPageData]=useState(null),[pageError,setPageError]=useState(''),request=useRef(0);
  useEffect(()=>{if(!queue.summary||!getPage)return;const token=++request.current;setPageError('');getPage({tab,page,pageSize:50}).then(result=>{if(token===request.current)setPageData({...result,tab});}).catch(e=>{if(token===request.current)setPageError(e.message);});return()=>{request.current++;};},[queue.summary,queue.revision,getPage,tab,page]);
  const completed=queue.jobs.filter(j=>j.state==='complete');
  const active=queue.jobs.filter(j=>j.state==='running');
  const failed=queue.jobs.filter(j=>j.state==='failed'),waiting=queue.jobs.filter(j=>j.state==='waiting'),counts=queue.summary?{active:(queue.counts?.running||0)+(queue.counts?.waiting||0),failed:queue.counts?.failed||0,unavailable:queue.counts?.unavailable||0,complete:queue.counts?.complete||0}:{active:active.length+waiting.length,failed:failed.length,unavailable:queue.jobs.filter(j=>j.state==='unavailable').length,complete:completed.length};
  const jobs=tab==='complete'?completed:tab==='failed'?failed:tab==='unavailable'?queue.jobs.filter(j=>j.state==='unavailable'):[...active,...waiting];
  const count=counts[tab];
  const pages=Math.max(1,Math.ceil(count/50)),current=Math.min(page,pages),visible=queue.summary?(pageData?.tab===tab?pageData.jobs:[]):jobs.slice((current-1)*50,current*50);
  const selectedSet=new Set(selected),validIds=new Set(jobs.map(j=>j.id)),selectedIds=queue.summary?selected:selected.filter(id=>validIds.has(id));
  useEffect(()=>{if(!tabMounted.current){tabMounted.current=true;return;}setPage(1);setSelected([]);},[tab]);
  useLayoutEffect(()=>{if(!restore.current||!visible.length)return;restorePanelScroll(listRef.current,restore.current);const frame=window.requestAnimationFrame(()=>{restorePanelScroll(listRef.current,restore.current);restore.current=null;});return()=>window.cancelAnimationFrame(frame);},[visible.length,pageData?.tab]);
  const showDetail=id=>onDetail?.(id,{panel:'downloads',tab,page:current,selection:{ids:selectedIds},scrollTop:listRef.current?.scrollTop||0,modalScrollTop:listRef.current?.closest('.modal')?.scrollTop||0});
  return <div className="modal-content">
    <div className="tag-mode"><button className={tab==='active'?'active':''} onClick={()=>setTab('active')}>正在下载 · {counts.active}</button><button className={tab==='failed'?'active':''} onClick={()=>setTab('failed')}>下载失败 · {counts.failed}</button><button className={tab==='unavailable'?'active':''} onClick={()=>setTab('unavailable')}>已失效 · {counts.unavailable}</button><button className={tab==='complete'?'active':''} onClick={()=>setTab('complete')}>已下载 · {counts.complete}</button></div>
    {pageError&&<p role="alert">{pageError}</p>}
    {onContinuePreparation&&[...new Set(visible.filter(j=>j.held&&j.preparationId).map(j=>j.preparationId))].map(id=><div className="queue-actions" key={id}><span>本批任务准备已暂停</span><button className="button secondary" disabled={busy} onClick={()=>onContinuePreparation(id)}>继续本批已受理任务</button></div>)}
    <div className="queue-actions"><label>同时下载 <select aria-label="同时下载作品数" disabled={busy} value={queue.concurrency||3} onChange={e=>onConcurrency?.(Number(e.target.value))}>{[1,2,3,4,5,6].map(n=><option value={n} key={n}>{n} 个作品{n===3?'（推荐）':''}</option>)}</select></label><span>正在传输 {active.filter(j=>j.phase==='transferring').length} 个 · 准备 / 等待 {active.filter(j=>j.phase!=='transferring').length} 个</span></div>
    <p className="muted small">默认同时下载 3 个作品。降低数量后，正在下载的作品会先完成；遇到平台限流会暂停。单独下载仍按原方式处理。</p>
    {queue.pauseReason&&<p role="status" className="muted small">{queue.pauseReason}</p>}
    <div className="queue-actions">{tab==='active'?<><span>含等待和暂停任务；失败项在“下载失败”中</span><button className="button secondary" onClick={onToggle}>{queue.paused?<Play size={14}/>:<Pause size={14}/>} {queue.paused?'继续下载':'暂停下载'}</button></>:tab==='failed'?<><button className="button secondary" disabled={busy||!selectedIds.length} onClick={async()=>{await onRetryFailed(selectedIds);setSelected([]);}}>重试所选失败任务</button><button className="button primary" disabled={busy||!count} onClick={async()=>{await onRetryFailed(null);setSelected([]);}}>重试全部失败任务（{count}）</button></>:tab==='unavailable'?<span>原作品已失效且任务未完成，已停止自动补齐；核验恢复后可手动重试。</span>:<><button disabled={busy||!selected.length} className="text-button" onClick={async()=>{await onClear(selected);setSelected([]);}}>删除选中记录</button><button disabled={busy||!counts.complete} className="text-button" onClick={async()=>{await onClear(queue.summary?null:completed.map(j=>j.id));setSelected([]);}}>清空已下载记录</button></>}</div>
    {tab!=='complete'&&<div className="queue-actions"><label><input type="checkbox" aria-label="选择本页下载任务" disabled={cancelBusy||!visible.length} checked={!!visible.length&&visible.every(j=>selectedSet.has(j.id))} onChange={e=>setSelected(e.target.checked?[...new Set([...selected,...visible.map(j=>j.id)])]:selected.filter(id=>!visible.some(j=>j.id===id)))}/> 本页全选</label><button className="text-button" disabled={cancelBusy||!selectedIds.length} onClick={async()=>{await onCancel(selectedIds,tab);setSelected([]);}}>取消所选任务{selectedIds.length?`（${selectedIds.length}）`:''}</button>{tab==='active'&&<button className="text-button" disabled={cancelBusy||!count} onClick={async()=>{await onCancel(null);setSelected([]);}}>取消全部未完成任务</button>}</div>}
    <div className="job-list" ref={listRef}>{visible.map(j=><div className="job" key={j.id}><input type="checkbox" aria-label={`${tab==='complete'?'选择下载记录':'选择下载任务'} ${j.title}`} disabled={cancelBusy} checked={selectedSet.has(j.id)} onChange={()=>setSelected(selectedSet.has(j.id)?selected.filter(x=>x!==j.id):[...selected,j.id])}/><div className="job-body">{onDetail?<button className="job-title" title="点击查看作品详情" aria-label={`${['failed','unavailable'].includes(j.state)?'查看失败作品详情':'查看下载作品详情'} ${j.id}`} disabled={cancelBusy} onClick={()=>showDetail(j.id)}><strong>{j.coverOnly&&<span>高清图补齐 · </span>}{j.title}</strong></button>:<strong>{j.coverOnly&&<span>高清图补齐 · </span>}{j.title}</strong>}<small>{!j.coverOnly&&(j.source==='nas'?'NAS 恢复 · ':'抖音优先 · ')}{{complete:'已完成',running:({preparing:'检查文件',connecting:'连接资源',waitingResource:'等待资源',resolving:'刷新资源',matching:'处理高清图',transferring:'正在传输'}[j.phase]||'准备下载'),waiting:queue.paused?'已暂停':'等待下载',failed:'下载失败',unavailable:'原作品已失效'}[j.state]} · {j.message}</small><div className="progress"><span style={{width:`${j.progress||0}%`}}/></div></div>{['failed','unavailable'].includes(j.state)&&onDetail&&<button className="text-button" disabled={cancelBusy} aria-label={`作品详情按钮 ${j.id}`} onClick={()=>showDetail(j.id)}>详情</button>}{j.state==='unavailable'&&onVerify&&<button className="text-button" disabled={busy} onClick={()=>onVerify(j.id)}>重新核验</button>}{j.state==='failed'&&<button className="text-button" disabled={busy} onClick={async()=>{await onRetry(j.id,!!j.coverOnly,j.source);setSelected(old=>old.filter(id=>id!==j.id));}}>重试</button>}{tab!=='complete'&&<button className="text-button" aria-label={`取消下载 ${j.title}`} disabled={cancelBusy} onClick={()=>onCancel([j.id],tab)}>取消</button>}</div>)}{!count&&<div className="picker-empty">暂无{tab==='complete'?'已下载记录':tab==='failed'?'失败任务':tab==='unavailable'?'已失效任务':'待处理任务'}</div>}</div>
    {pages>1&&<div className="queue-actions"><button className="button secondary" disabled={current<=1} onClick={()=>setPage(current-1)}>上一页</button><span>每页 50 条 · {current} / {pages}</span><button className="button secondary" disabled={current>=pages} onClick={()=>setPage(current+1)}>下一页</button></div>}
    <p className="muted small">{tab==='active'?'暂停可继续；取消会停止并移出下载队列。':'删除记录只清理下载历史，文件、本地作品及“已下载”标记不受影响。'}</p>
  </div>;
}
