import React,{useState} from 'react';import {RefreshCw,Square} from 'lucide-react';
const estimated=bytes=>bytes>1073741824?(bytes/1073741824).toFixed(1)+' GB':(bytes/1048576).toFixed(1)+' MB';
export function StorageSize({api,root,estimatedBytes,works,scan,onChange,onError,disabled=false}){
 const [starting,setStarting]=useState(false),current=scan?.root===root?scan:null,result=current?.result?.root===root?current.result:null,running=starting||current?.running;
 async function refresh(){setStarting(true);try{onChange(await api.refreshStorageSize());}catch(error){onError(error.message);}finally{setStarting(false);}}
 async function stop(){try{await api.cancelStorageSize();}catch(error){onError(error.message);}}
 return <><div className="storage-size-row"><strong>{result?(result.bytes/1073741824).toFixed(2)+' GB':'约 '+estimated(estimatedBytes)}<small>已保存 · {Number(works||0).toLocaleString('zh-CN')} 个作品</small></strong><button className="text-button" aria-label="刷新本机目录大小" title="扫描保存目录内的全部文件，包含临时和未入库文件，不跟随目录链接" disabled={disabled||running} onClick={refresh}><RefreshCw size={12} className={running?'spin':''}/>刷新大小</button></div>
  {running?<div className="storage-size-message" role="status">正在统计 · {Number(current?.files||0).toLocaleString('zh-CN')} 个文件<button className="text-button" aria-label="停止目录大小统计" onClick={stop}><Square size={10}/>停止</button></div>:<>{result?<p className="storage-size-time">目录大小 · 统计于 {new Date(result.scannedAt).toLocaleString('zh-CN',{hour12:false})}</p>:<p className="storage-size-time">当前为登记文件估算，可手动刷新目录总大小。</p>}{current?.message&&(!['idle','done'].includes(current.phase)||current.links>0)&&<p className={`storage-size-message ${['failed','partial'].includes(current.phase)?'danger-text':''}`} role={['failed','partial'].includes(current.phase)?'alert':'status'}>{current.message}</p>}</>}
 </>;
}
