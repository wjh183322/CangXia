import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Volume2, VolumeX, X, Info, Check, Pause, Play } from 'lucide-react';

const Sound = createContext(null);
export function SoundProvider({children}) {
  // Session-only state. Deliberately never read or write localStorage or persisted settings.
  const [volume,setVolume]=useState(0), [last,setLast]=useState(0.5);
  const update=value=>{const n=Math.max(0,Math.min(1,Number(value)));if(n>0)setLast(n);setVolume(n);};
  return <Sound.Provider value={{volume,update,toggle:()=>update(volume?0:last)}}>{children}</Sound.Provider>;
}
export function VolumeControl() {
  const {volume,update,toggle}=useContext(Sound);
  return <div className="volume-control"><button aria-label={volume?'静音':'取消静音'} onClick={toggle}>{volume?<Volume2 size={17}/>:<VolumeX size={17}/>}</button><input type="range" min="0" max="100" step="1" aria-label="全局音量" value={Math.round(volume*100)} onChange={e=>update(Number(e.target.value)/100)}/><span>{Math.round(volume*100)}%</span></div>;
}
export function MediaVideo({autoPlay=false,suspended=false,...props}) {
  const ref=useRef(null), {volume,update}=useContext(Sound);
  useLayoutEffect(()=>{const v=ref.current;if(v){v.volume=volume;v.muted=volume===0;}},[volume]);
  useEffect(()=>{const v=ref.current;if(!v)return;if(suspended)v.pause();else if(autoPlay)v.play().catch(()=>{});},[suspended,autoPlay,props.src]);
  return <video {...props} ref={ref} autoPlay={autoPlay&&!suspended} muted={volume===0} onVolumeChange={e=>{const v=e.currentTarget;const next=v.muted?0:v.volume;if(Math.abs(next-volume)>.001)update(next);}}/>;
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
  return [...assets.filter(a=>a.kind==='image').sort((a,b)=>Number(a.key.replace('image-',''))-Number(b.key.replace('image-',''))),...assets.filter(a=>a.kind==='video')];
}
export function Viewer({work,index,total,onWork,onClose,onDetail,suspended}) {
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
    <footer><span>{current?`${current.kind==='video'?'视频':'图片'} ${mediaIndex+1} / ${media.length}`:'媒体缺失'}</span><span>← → 切换图片 / 视频　↑ ↓ 切换作品　双击画面查看详情</span>{work.remoteState==='unavailable'&&<b>原作品已失效</b>}</footer>
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
export function DownloadManager({queue,onClear,onToggle,onRetry,busy}) {
  const [tab,setTab]=useState('active'),[selected,setSelected]=useState([]);
  const completed=queue.jobs.filter(j=>j.state==='complete');
  const jobs=queue.jobs.filter(j=>tab==='complete'?j.state==='complete':j.state!=='complete');
  return <div className="modal-content"><div className="tag-mode"><button className={tab==='active'?'active':''} onClick={()=>setTab('active')}>正在下载 · {queue.jobs.length-completed.length}</button><button className={tab==='complete'?'active':''} onClick={()=>setTab('complete')}>已下载 · {completed.length}</button></div><div className="queue-actions">{tab==='active'?<><span>等待、暂停和失败任务保留在此</span><button className="button secondary" onClick={onToggle}>{queue.paused?<Play size={14}/>:<Pause size={14}/>} {queue.paused?'继续下载':'暂停下载'}</button></>:<><button disabled={busy||!selected.length} className="text-button" onClick={async()=>{await onClear(selected);setSelected([]);}}>删除选中记录</button><button disabled={busy||!completed.length} className="text-button" onClick={async()=>{await onClear(completed.map(j=>j.id));setSelected([]);}}>清空已下载记录</button></>}</div><div className="job-list">{jobs.map(j=><div className="job" key={j.id}>{tab==='complete'&&<input type="checkbox" aria-label={`选择下载记录 ${j.title}`} checked={selected.includes(j.id)} onChange={()=>setSelected(selected.includes(j.id)?selected.filter(x=>x!==j.id):[...selected,j.id])}/>}<div className="job-body"><strong>{j.title}</strong><small>{{complete:'已完成',running:'正在下载',waiting:queue.paused?'已暂停':'等待下载',failed:'下载失败'}[j.state]} · {j.message}</small><div className="progress"><span style={{width:`${j.progress||0}%`}}/></div></div>{j.state==='failed'&&<button className="text-button" onClick={()=>onRetry(j.id)}>重试</button>}</div>)}{!jobs.length&&<div className="picker-empty">暂无{tab==='complete'?'已下载记录':'待处理任务'}</div>}</div><p className="muted small">删除记录只清理下载历史，文件、本地作品及“已下载”标记不受影响。</p></div>;
}
