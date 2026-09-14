import React from 'react';

const bytes=n=>n===null?'未取得':(n/1073741824).toFixed(2)+' GB';
export function NasSettings({storage={},busy,onPick,onReconnect,onLeave,onTrash,onRecovery}){
 const active=storage.mode==='nas';
 return <section className="nas-settings"><h3>NAS 媒体库</h3><p>媒体、收藏顺序、标签和下载记录保存在 NAS。每台电脑单独登录抖音。</p>
  <div className={`nas-status ${active&&!storage.writable?'warning':''}`} role="status"><strong>{active?(storage.connected?(storage.writable?'当前电脑可写':'当前只读'):'NAS 离线'):'当前使用本机库'}</strong><span>{storage.message||'切换电脑时，打开同一个 NAS 媒体库。'}</span>{storage.root&&<small>{storage.root}</small>}{storage.pending&&<small>本机还有待确认保存的修改；重新连接时保留恢复副本。</small>}{storage.lastSaved&&<small>最近保存：{new Date(storage.lastSaved).toLocaleString()}</small>}</div>
  <div className="settings-actions">{active?<><button className="button secondary" disabled={busy} onClick={onReconnect}>重新连接 / 取得写入权</button><button className="button secondary" disabled={busy} onClick={onLeave}>返回本机库</button><button className="button secondary" disabled={busy||!storage.connected} onClick={onTrash}>恢复已删除作品</button></>:<><button className="button primary" disabled={busy} onClick={()=>onPick('migrate')}>迁移本机库到 NAS</button><button className="button secondary" disabled={busy} onClick={()=>onPick('open')}>打开已有 NAS 库</button></>}</div>
  {(storage.recovery||storage.staging)&&<div className="info-box"><p>上次未完成的工作副本已留在本机。它不会自动覆盖 NAS 的新版本。<button className="text-button" onClick={onRecovery}>打开恢复文件目录</button></p></div>}
  <p className="muted small">同一时刻仅一台电脑可修改，其余电脑只读。NAS 离线时可查看缓存的列表，播放媒体需要重新连接。迁移会复制并校验文件，原本机库保留。</p>
  <p className="muted small">后续事项：新增硬盘后配置独立备份及定期恢复检查。</p>
 </section>;
}
export function MigrationReview({plan,progress,busy,onCancel,onConfirm}){
 return <><div className="modal-content"><p>将当前本机库复制到下面的共享文件夹。完成后切换到 NAS 库，原本机库和媒体保留。</p><div className="path-box">{plan.root}</div><dl className="nas-review"><dt>作品记录</dt><dd>{plan.works} 个</dd><dt>待复制文件</dt><dd>{plan.files} 个 · {bytes(plan.bytes)}</dd><dt>目标可用空间</dt><dd>{bytes(plan.free)}</dd></dl>{plan.missing>0&&<div className="info-box"><p>{plan.missing} 个原文件缺失或大小异常。作品记录会保留，已有的有效文件会复制；之后可重新检查并补齐。</p></div>}<p>目标已有媒体库时会拒绝合并。另一台电脑请使用“打开已有 NAS 库”。</p>{progress&&<p role="status">{progress}</p>}</div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={onCancel}>取消</button><button className="button primary" disabled={busy} onClick={onConfirm}>{busy?'正在复制并校验…':'复制并切换到 NAS'}</button></footer></>;
}
export function NasTrash({entries,busy,readOnly,onRestore,onOpen}){
 return <div className="modal-content"><p>恢复会生成新的媒体文件，归档原件继续保留；不会覆盖现有作品。</p><div className="nas-trash">{entries.map(e=><div key={e.batch+e.id}><span><strong>{e.name}</strong><small>{new Date(e.time).toLocaleString()}</small></span><button className="button secondary" disabled={busy||readOnly} onClick={()=>onRestore(e)}>恢复</button></div>)}{!entries.length&&<p className="muted">暂无可恢复的删除记录。</p>}</div><button className="text-button" onClick={onOpen}>在资源管理器中查看 NAS 归档目录</button></div>;
}
