import React,{useState} from 'react';
const labels={unconfigured:'尚未连接',checking:'正在比对',synced:'已同步',pending:'本机有更新',syncing:'正在同步',readonly:'只读使用',offline:'无法检查',conflict:'双方都有更新',remoteChanges:'NAS 有更新'};
export function BackupStatus({storage={},onOpen}){const warning=!storage.writable&&storage.phase!=='checking';return <button className={`backup-status-pill ${warning?'warning':''}`} onClick={onOpen}><span className="status-dot"/>{labels[storage.phase]||'同步状态'}{storage.pending&&storage.phase==='offline'?' · 有待同步内容':''}</button>;}
export function BackupPanel({storage={},busy,api,onUpdated,onImport,onConflict}){
 const config=storage.config||{};const [url,setUrl]=useState(config.url||''),[token,setToken]=useState(''),[fingerprint,setFingerprint]=useState(config.fingerprint||''),[deviceName,setDeviceName]=useState(config.deviceName||''),[intervalMinutes,setInterval]=useState(String(config.intervalMinutes||5)),[working,setWorking]=useState(false),[error,setError]=useState('');
 const run=async fn=>{setWorking(true);setError('');try{await fn();await onUpdated();}catch(e){setError(e.message);}finally{setWorking(false);}};
 const [showConnection,setShowConnection]=useState(!config.url);const blocked=busy||working;
 return <section className="backup-panel"><div className={`backup-status-box ${!storage.writable?'warning':''}`} role="status"><strong>{labels[storage.phase]||'尚未连接'}</strong><span>{storage.message}</span>{storage.progress&&<span>{storage.progress}</span>}</div>
 <dl><dt>当前电脑</dt><dd>{storage.deviceName||'本机'}</dd><dt>上次同步</dt><dd>{storage.lastSync?new Date(storage.lastSync.time).toLocaleString():'尚未完成'}</dd><dt>最近提交电脑</dt><dd>{storage.lastSync?.name||'—'}</dd><dt>本机状态</dt><dd>{storage.pending?'有内容待同步':'无待同步修改'}</dd></dl>
 <div className="settings-actions"><button className="button secondary" disabled={blocked||storage.syncing||!config.url} onClick={()=>run(()=>api.checkBackup())}>重新检查同步状态</button><button className="button primary" disabled={blocked||!storage.writable||storage.syncing} onClick={()=>run(()=>api.syncBackup())}>立即同步 / 换电脑前同步</button>{storage.syncing&&<button className="button secondary" onClick={()=>run(()=>api.cancelBackup())}>暂停后台同步</button>}{storage.phase==='conflict'&&<button className="button secondary" onClick={onConflict}>处理双方更新</button>}</div>
 <p className="muted small">记录已同步与媒体已下载到本机是两件事。新电脑可以先更新记录，再从“NAS 备份”下载所需媒体。</p>
 <details className="backup-connection" open={showConnection} onToggle={e=>setShowConnection(e.currentTarget.open)}><summary>备份服务连接与自动同步</summary><div className="backup-form">
 <label>NAS 服务地址<input aria-label="NAS 服务地址" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://NAS 的 Tailscale 地址:18443"/></label>
 <label>访问密钥<input aria-label="备份访问密钥" type="password" autoComplete="new-password" value={token} onChange={e=>setToken(e.target.value)} placeholder={config.hasToken?'已加密保存，留空保持不变':'从 NAS 服务日志复制'}/></label>
 <label>证书 SHA256 指纹<input aria-label="服务证书指纹" value={fingerprint} onChange={e=>setFingerprint(e.target.value)} placeholder="从 NAS 服务日志复制 Certificate SHA256"/></label>
 <label>这台电脑的名称<input aria-label="备份电脑名称" value={deviceName} onChange={e=>setDeviceName(e.target.value)}/></label>
 <label>后台同步间隔（分钟）<input aria-label="后台同步间隔" type="number" min="1" max="1440" value={intervalMinutes} onChange={e=>setInterval(e.target.value)}/></label>
 <button className="button primary" disabled={blocked||storage.syncing} onClick={()=>run(()=>api.configureBackup({url,token,fingerprint,deviceName,intervalMinutes:Number(intervalMinutes)}))}>{working?'正在连接…':'保存并检查连接'}</button>
 </div></details>
 {error&&<p className="backup-error" role="alert">{error}</p>}
 <div className="info-box"><p>启动时先与 NAS 比对；无法连接时只读浏览本机资料。平时下载到本机，后台按间隔或一批下载完成后同步。程序关闭后自动同步停止。</p></div>
 <div className="settings-actions"><button className="button secondary" disabled={blocked||!storage.writable||storage.syncing} onClick={()=>onImport('local')}>导入旧本机版资料</button><button className="button secondary" disabled={blocked||!storage.writable||storage.syncing} onClick={()=>onImport('nas')}>导入旧 NAS 版资料</button>{storage.recovery&&<button className="text-button" onClick={()=>run(()=>api.openBackupRecovery())}>打开本机恢复副本</button>}</div>
 <p className="muted small">导入仅用于空的备份版本机库，原版资料保留。清理本机媒体不会删除 NAS 中已经备份的副本。</p>
 </section>;
}
