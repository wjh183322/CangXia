import React,{useState} from 'react';import {RefreshCw,Square} from 'lucide-react';
const estimated=bytes=>bytes>1073741824?(bytes/1073741824).toFixed(1)+' GB':(bytes/1048576).toFixed(1)+' MB';
export function StorageSize({api,root,estimatedBytes,works,scan,onChange,onError,disabled=false}){
 const [starting,setStarting]=useState(false),current=scan&&scan.root===root?scan:null,result=current?.result&&current.result.root===root?current.result:null,running=starting||current?.running;
 async function refresh(){setStarting(true);try{onChange(await api.refreshStorageSize());}catch(error){onError(error.message);}finally{setStarting(false);}}
 async function stop(){try{await api.cancelStorageSize();}catch(error){onError(error.message);}}
 return <><div className="storage-size-row"><strong>{result?(result.bytes/1073741824).toFixed(2)+' GB':'约 '+estimated(estimatedBytes)}<small>已保存 · {Number(works||0).toLocaleString('zh-CN')} 个作品</small></strong><button className="text-button" aria-label="刷新本机目录大小" title="扫描保存目录内的全部文件，包含临时和未入库文件，不跟随目录链接" disabled={disabled||running} onClick={refresh}><RefreshCw size={12} className={running?'spin':''}/>刷新大小</button></div>
  {running?<div className="storage-size-message" role="status">正在统计 · {Number(current?.files||0).toLocaleString('zh-CN')} 个文件<button className="text-button" aria-label="停止目录大小统计" onClick={stop}><Square size={10}/>停止</button></div>:<>{result?<p className="storage-size-time">目录大小 · 统计于 {new Date(result.scannedAt).toLocaleString('zh-CN',{hour12:false})}</p>:<p className="storage-size-time">当前为登记文件估算，可手动刷新目录总大小。</p>}{current?.message&&(!['idle','done'].includes(current.phase)||current.links>0)&&<p className={`storage-size-message ${['failed','partial'].includes(current.phase)?'danger-text':''}`} role={['failed','partial'].includes(current.phase)?'alert':'status'}>{current.message}</p>}</>}
 </>;
}

export function ServerStorageSize({ api }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(''),
    [revision, refresh] = useState(0),
    [pending, setPending] = useState(false);
  React.useEffect(() => {
    let live = true,
      timer;
    async function load() {
      try {
        const next = await api.storageUsage();
        if (!live) return;
        setData(next);
        if (next.run?.state === 'running' || next.cache.phase === 'running') timer = setTimeout(load, 450);
      } catch (e) {
        if (live) setError(e.message);
      }
    }
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, revision]);
  async function action(fn) {
    setPending(true);
    setError('');
    try {
      await fn();
      refresh((n) => n + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  const { run, cache } = data ?? {},
    totals = run?.totals,
    active = run?.state === 'running' || cache?.phase === 'running';
  return (
    <section>
      <h3>存储占用</h3>
      {totals && (
        <p>
          作品 {totals.works} · 来源归属 {totals.memberships} · 登记文件 {totals.registeredFiles} · 下载任务{' '}
          {totals.jobs}
          <br />
          NAS 归档 {estimated(totals.archiveBytes)} · NAS 暂存 {estimated(totals.stagingBytes)} · 实际文件{' '}
          {totals.files}
        </p>
      )}
      {run && (
        <p>
          NAS 统计
          {
            { running: '进行中', complete: '已完成', paused: '已暂停，显示已统计部分', failed: '失败' }[
              run.state
            ]
          }{' '}
          {run.reason}
        </p>
      )}
      {cache?.bytes !== undefined && (
        <p>
          Windows 缓存目录 {estimated(cache.bytes)} · {cache.message}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        className="button secondary"
        disabled={pending || active}
        onClick={() => action(() => api.refreshStorageSize())}
      >
        刷新存储占用
      </button>
      {active && (
        <button className="button secondary" onClick={() => action(() => api.cancelStorageSize(run.id))}>
          停止统计
        </button>
      )}
    </section>
  );
}
