import React,{useState} from 'react';
import {Link,Users,RefreshCw,Play,Info} from 'lucide-react';
import './author-ui.css';

export function AuthorSetup({busy,onAdd}){
  const [link,setLink]=useState('');
  return <form onSubmit={e=>{e.preventDefault();if(link.trim()&&!busy)onAdd(link.trim());}}>
    <div className="modal-content author-setup"><div className="author-emblem"><Users size={28}/></div><p>粘贴作者主页的分享文案或完整链接。<br/>先核对作者信息，再选择读取和下载范围。</p><label htmlFor="author-link">作者主页链接</label><textarea id="author-link" className="link-input" value={link} onChange={e=>setLink(e.target.value)} placeholder="https://www.douyin.com/user/…" maxLength={6000}/><div className="info-box"><Info size={16}/><p>只读取当前登录账号可以访问的作品。<br/>作者列表独立保存，不会加入或改变你的抖音收藏。</p></div></div>
    <footer className="modal-footer"><button className="button primary" disabled={busy||!link.trim()} type="submit"><Link size={16}/>{busy?'正在核对…':'核对并添加作者'}</button></footer>
  </form>;
}

export function AuthorReadSetup({author,busy,onRead}){
  const [limit,setLimit]=useState('20');const invalid=!Number.isInteger(Number(limit))||Number(limit)<1||Number(limit)>100000;
  return <><div className="modal-content author-read"><div className="author-identity"><span className="author-emblem"><Users size={23}/></span><div><strong>{author.name}</strong><small>抖音号：{author.uniqueId||'未提供'} · ID {author.uid}</small></div></div>
    <p className="muted">按主页返回顺序读取，置顶作品可能在前。已有作品也计入本次读取数量，不会重复加入列表。</p>
    <div className="author-limit-options">{[20,50,100].map(n=><button key={n} className={`button ${Number(limit)===n?'primary':'secondary'}`} onClick={()=>setLimit(String(n))}>{n} 条</button>)}</div>
    <label className="read-label">本次读取作品数<input aria-label="作者读取作品数" type="number" min="1" max="100000" value={limit} onChange={e=>setLimit(e.target.value)}/></label>
    {author.run?.canResume&&<div className="author-resume"><p>上次累计读取 {author.run.count} 条。续读会从保存的位置继续；从头读取可检查新增作品。</p><button className="button secondary" disabled={busy||invalid} onClick={()=>onRead({limit:Number(limit),resume:true})}><Play size={14}/>继续读取 {invalid?'':limit} 条</button><button className="text-button" disabled={busy} onClick={()=>onRead({limit:20,resume:true,readAll:true})}>继续读到末尾</button></div>}
    <div className="info-box"><Info size={16}/><p>“全部”仅指当前可访问的列表。中途可停止，已读取内容保留。不会自动开始下载，也不会删除之前保存的作品。</p></div></div>
    <footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={()=>onRead({limit:20,readAll:true})}>从头全部读取</button><button className="button primary" disabled={busy||invalid} onClick={()=>onRead({limit:Number(limit)})}><RefreshCw size={15}/>从头读取 {invalid?'':limit} 条</button></footer></>;
}
