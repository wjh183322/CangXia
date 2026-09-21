import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,ArrowUp,Folder,FileJson,Plus,Search,Check,Info,X,Trash2,CheckCircle,AlertCircle} from 'lucide-react';

export function Pagination({page,pages,onChange,location}){
 return <nav className="pagination" aria-label={`${location}分页`}><span>每页 20 个</span><button aria-label={`${location}上一页`} disabled={page<=1} onClick={()=>onChange(page-1)}><ArrowLeft size={15}/></button><strong>{page}<em>/ {pages}</em></strong><button aria-label={`${location}下一页`} disabled={page>=pages} onClick={()=>onChange(page+1)}><ArrowRight size={15}/></button></nav>;
}
export function Toast({message,onClose}){
 const [center,setCenter]=useState('50%');
 useLayoutEffect(()=>{
  const update=()=>{const modals=[...document.querySelectorAll('.modal')];const anchor=modals.at(-1)||document.querySelector('.main-content');if(anchor){const r=anchor.getBoundingClientRect();setCenter(`${r.left+r.width/2}px`);}};
  update();const ro=new ResizeObserver(update);ro.observe(document.body);const observer=new MutationObserver(update);observer.observe(document.getElementById('root'),{childList:true,subtree:true});window.addEventListener('resize',update);
  return()=>{ro.disconnect();observer.disconnect();window.removeEventListener('resize',update);};
 },[]);
 return <div className="toast" role="status" style={{left:center}}><Info size={17}/><span>{message}</span><button aria-label="关闭提示" onClick={onClose}><X size={15}/></button></div>;
}
export {FilePicker} from './file-picker.jsx';
export function DeleteConfirmation({intent,onConfirm,onCancel,busy}){
 const local=intent.kind==='local';
 return <><div className="modal-content confirm-content"><div className={`confirm-symbol ${local?'danger':''}`}><Trash2 size={26}/></div><h3>{local?`删除 ${intent.count} 个作品的本地文件？`:`删除 ${intent.count} 个作品的读取记录？`}</h3><p>{local?(intent.backup?'本机的视频、图片和作品信息会移入系统回收站。NAS 已有的备份副本保留。':'视频、图片和作品信息会移入系统回收站，并撤销已下载标记。抖音账号收藏不受影响。'):'作品会从软件的总收藏与自建收藏夹读取列表中一起移除。抖音收藏、本地文件、标签及本地排序保留。之后重新读取可以恢复。'}</p>{local&&intent.invalid&&<div className="invalid-note"><AlertCircle size={18}/>原作品已失效，删除后将无法从抖音重新下载。</div>}</div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={onCancel}>取消</button><button className="button danger solid" disabled={busy||!intent.count} onClick={onConfirm}>{busy?'正在删除…':local?'删除本地文件':'删除读取记录'}</button></footer></>;
}
export function RepairReport({report,onStart,busy,onClose}){
 return <><div className="modal-content"><div className="repair-summary"><span><CheckCircle size={18}/><b>{report.complete}</b>完整</span><span><Info size={18}/><b>{report.missing}</b>需要补齐</span><span><AlertCircle size={18}/><b>{report.errors}</b>无法检查</span></div>{!report.missing&&!report.errors&&<div className="complete-message"><CheckCircle size={34}/><h3>文件完整，无需补齐</h3><p>未添加任何下载任务。</p></div>}<div className="repair-list">{report.items.filter(i=>i.status!=='complete').map(i=><article key={i.id}><strong>{i.name}</strong><p>{i.status==='error'?`无法检查：${i.error}`:i.missing.map(m=>`${m.label}（${m.reason}）`).join('、')}</p></article>)}</div>{report.errors>0&&<p className="muted">无法检查的作品不会加入补齐任务。请检查磁盘连接或访问权限后重试。</p>}</div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={onClose}>关闭</button>{report.missing>0&&<button className="button primary" disabled={busy} onClick={onStart}>{busy?'正在确认…':`开始补齐 ${report.missing} 个作品`}</button>}</footer></>;
}
