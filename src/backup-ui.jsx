import React,{useState} from 'react';
const labels={stateError:'本机状态保存失败',upgrade:'NAS 服务需要升级',mediaConflict:'媒体内容有差异',unconfigured:'尚未连接',checking:'正在比对',synced:'已同步',coversPending:'封面待备份',pending:'本机资料待同步',waitingIdle:'等待空闲备份',syncing:'正在同步',readonly:'只读使用',offline:'无法检查',conflict:'双方都有更新',remoteChanges:'NAS 有更新'};
export function BackupStatus({storage={},onOpen}){const warning=!storage.writable&&storage.phase!=='checking';return <button className={`backup-status-pill ${warning?'warning':''}`} onClick={onOpen}><span className="status-dot"/>{labels[storage.phase]||'同步状态'}{storage.pending&&['offline','stateError'].includes(storage.phase)?' · 有待同步内容':''}</button>;}
export function BackupPanel({storage={},busy,api,onUpdated,onImport,onConflict}){
 const config=storage.config||{};const [url,setUrl]=useState(config.url||''),[token,setToken]=useState(''),[fingerprint,setFingerprint]=useState(config.fingerprint||''),[deviceName,setDeviceName]=useState(config.deviceName||''),[intervalMinutes,setInterval]=useState(String(config.intervalMinutes||5)),[working,setWorking]=useState(false),[error,setError]=useState('');
 const run=async fn=>{setWorking(true);setError('');try{await fn();await onUpdated();}catch(e){setError(e.message);}finally{setWorking(false);}};
 const [showConnection,setShowConnection]=useState(!config.url);const blocked=busy||working;
 return <section className="backup-panel"><div className={`backup-status-box ${!storage.writable?'warning':''}`} role="status"><strong>{labels[storage.phase]||'尚未连接'}</strong><span>{storage.message}</span>{storage.progress&&<span>{storage.progress}</span>}</div>
 <dl><dt>当前电脑</dt><dd>{storage.deviceName||'本机'}</dd><dt>上次同步</dt><dd>{storage.lastSync?new Date(storage.lastSync.time).toLocaleString():'尚未完成'}</dd><dt>最近提交电脑</dt><dd>{storage.lastSync?.name||'—'}</dd><dt>待备份封面</dt><dd>{storage.pendingCovers||0} 张</dd><dt>本机状态</dt><dd>{storage.pending?'有内容待同步':'无待同步修改'}</dd></dl>
 <div className="settings-actions"><button className="button secondary" disabled={blocked||storage.syncing||!config.url} onClick={()=>run(()=>api.checkBackup())}>重新检查同步状态</button><button className="button primary" disabled={blocked||!storage.writable||storage.syncing} onClick={()=>run(()=>api.syncBackup())}>立即同步 / 换电脑前同步</button>{storage.syncing&&<button className="button secondary" onClick={()=>run(()=>api.cancelBackup())}>暂停后台同步</button>}{storage.phase==='conflict'&&<button className="button secondary" onClick={onConflict}>处理双方更新</button>}</div>
 <p className="muted small">记录已同步与媒体已下载到本机是两件事。新电脑可以先更新记录，再从“NAS 备份”下载所需媒体。</p>
 {!!storage.reconcile?.pending&&<div className="info-box"><p>已读取内容保留，还有 {storage.reconcile.pending} 个本地作品待整理。</p><button className="button secondary" disabled={blocked||!storage.writable||storage.syncing} onClick={()=>run(()=>api.resumeReconcile())}>继续整理本地作品</button></div>}
 {storage.fileCheck?.running&&<div className="info-box"><p>后台检查本地文件：{storage.fileCheck.checked} / {storage.fileCheck.total} 个作品。目录暂不可用时保留记录。</p><button className="button secondary" onClick={()=>run(()=>api.cancelFileCheck())}>停止文件检查</button></div>}
 <details className="backup-connection" open={showConnection} onToggle={e=>setShowConnection(e.currentTarget.open)}><summary>备份服务连接与自动同步</summary><div className="backup-form">
 <label>NAS 服务地址<input aria-label="NAS 服务地址" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://NAS 的 Tailscale 地址:18443"/></label>
 <label>访问密钥<input aria-label="备份访问密钥" type="password" autoComplete="new-password" value={token} onChange={e=>setToken(e.target.value)} placeholder={config.hasToken?'已加密保存，留空保持不变':'从 NAS 服务日志复制'}/></label>
 <label>证书 SHA256 指纹<input aria-label="服务证书指纹" value={fingerprint} onChange={e=>setFingerprint(e.target.value)} placeholder="从 NAS 服务日志复制 Certificate SHA256"/></label>
 <label>这台电脑的名称<input aria-label="备份电脑名称" value={deviceName} onChange={e=>setDeviceName(e.target.value)}/></label>
 <label>后台同步间隔（分钟）<input aria-label="后台同步间隔" type="number" min="1" max="1440" value={intervalMinutes} onChange={e=>setInterval(e.target.value)}/></label>
 <button className="button primary" disabled={blocked||storage.syncing} onClick={()=>run(()=>api.configureBackup({url,token,fingerprint,deviceName,intervalMinutes:Number(intervalMinutes)}))}>{working?'正在连接…':'保存并检查连接'}</button>
 </div></details>
 {error&&<p className="backup-error" role="alert">{error}</p>}
 <div className="info-box"><p>启动时先与 NAS 比对；无法连接时只读浏览本机资料。读取开始前暂停已有备份，读取和下载期间不启动备份，空闲后自动同步。已开始的读取遇到 NAS 断联仍保存到本机，结束后重新比对；双方有修改时不会自动覆盖。程序关闭后自动同步停止。</p></div>
 <div className="settings-actions"><button className="button secondary" disabled={blocked||!storage.writable||storage.syncing} onClick={()=>onImport('local')}>导入旧本机版资料</button><button className="button secondary" disabled={blocked||!storage.writable||storage.syncing} onClick={()=>onImport('nas')}>导入旧 NAS 版资料</button><button className="button secondary" disabled={blocked||!storage.writable||storage.syncing} onClick={()=>onImport('author')}>导入作者试验版资料</button>{storage.recovery&&<button className="text-button" onClick={()=>run(()=>api.openBackupRecovery())}>打开本机恢复副本</button>}</div>
 <p className="muted small">导入仅用于空的备份版本机库，原版资料保留。清理本机媒体不会删除 NAS 中已经备份的副本。</p>
 </section>;
}

export function ServerBackupResponsibility({ api }) {
  const [config, setConfig] = useState(null),
    [target, setTarget] = useState(''),
    [restore, setRestore] = useState('');
  const [job, setJob] = useState(''),
    [page, setPage] = useState(1),
    [report, setReport] = useState(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const call = (input) => api.serverRehearsal(input);
  const handle = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    const c = await call({ action: 'list' });
    setConfig(c);
    setRestore((x) => (c.restores.includes(x) ? x : c.restores[0] || ''));
  };
  const select = async (id, p = 1) => {
    const r = await call({ action: 'status', id, page: p });
    setJob(id);
    setPage(p);
    setReport(r);
    setConfirmed(false);
  };
  const launch = async (input) => {
    const r = await call(input);
    await refresh();
    await select(r.id);
  };
  const summary = report?.summary,
    approval = summary?.previewId && summary?.identities && summary.target?.split(/[\\/]/).pop() === target;
  const totalPages = Math.max(1, Math.ceil((summary?.total || 0) / 50));
  const verifiedRestore = summary?.restore === restore && summary?.verified && summary?.manifestSha256;
  const [handoff, setHandoff] = useState(false);
  return (
    <section>
      <h3>备份与还原</h3>
      <p>
        用绿联「同步与备份」备份已核验的数据库快照和同一恢复点的媒体目录。还原到独立目录后，可在此核对文件。
      </p>
      <button className="button secondary" disabled={busy} onClick={() => handle(refresh)}>
        查看迁移彩排与恢复点
      </button>
      {config && (
        <div className="backup-form">
          <p>
            来源账号 {config.uid} · 已封存来源 {config.sources.join('、')}
          </p>
          <label>
            独立彩排目录名
            <input
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setHandoff(false);
                setConfirmed(false);
              }}
              placeholder="例如 rehearsal-01"
            />
          </label>
          <button
            className="button secondary"
            disabled={busy || !target}
            onClick={() => handle(() => launch({ action: 'preview', target, sources: config.sources }))}
          >
            预览迁移差异与空间
          </button>
          <details>
            <summary>运行库回退前移交</summary>
            <p>
              为当前运行库 {config.libraryId} 在新目标 {target || '（请输入名称）'}{' '}
              生成独立快照并核对媒体。请保留切换后新增资料及任务，并由绿联复制归档。
            </p>
            <label>
              <input type="checkbox" checked={handoff} onChange={(e) => setHandoff(e.target.checked)} />
              确认封存当前库，不切换运行卷
            </label>
            <button
              disabled={busy || !handoff || !target}
              onClick={() =>
                handle(async () => {
                  setHandoff(false);
                  await launch({
                    action: 'handoff',
                    target,
                    uid: config.uid,
                    libraryId: config.libraryId,
                    confirmed: true
                  });
                })
              }
            >
              创建独立回退恢复点
            </button>
          </details>
          {!!config.restores.length && (
            <div>
              <label>
                外部还原目录
                <select value={restore} onChange={(e) => setRestore(e.target.value)}>
                  {config.restores.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
              <button disabled={busy} onClick={() => handle(() => launch({ action: 'verify', restore }))}>
                核对还原的数据库和媒体
              </button>
              {verifiedRestore && target && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    确认在新目标 {target} 重建文件身份并通过正式播放接口核验
                  </label>
                  <button
                    disabled={busy || !confirmed}
                    onClick={() =>
                      handle(() =>
                        launch({
                          action: 'restore',
                          restore,
                          target,
                          uid: config.uid,
                          libraryId: summary.libraryId,
                          manifestSha256: summary.manifestSha256,
                          confirmed: true
                        })
                      )
                    }
                  >
                    验证独立恢复库可用性
                  </button>
                </>
              )}
            </div>
          )}
          {!!config.jobs.length && (
            <label>
              彩排记录
              <select value={job} onChange={(e) => handle(() => select(e.target.value))}>
                <option value="" disabled>
                  选择报告
                </option>
                {config.jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.started} ·{' '}
                    {
                      {
                        preview: '预览',
                        import: '导入',
                        verify: '恢复核对',
                        preserve: '回退前封存',
                        restore: '独立开库验证',
                        handoff: '运行库回退移交'
                      }[j.action]
                    }{' '}
                    {j.target}
                  </option>
                ))}
              </select>
            </label>
          )}
          {report && (
            <>
              <button disabled={busy} onClick={() => handle(() => select(job, page))}>
                刷新结果
              </button>
              {report.state === 'running' && (
                <button
                  disabled={busy}
                  onClick={() =>
                    handle(async () => {
                      await call({ action: 'cancel', id: job });
                      await select(job);
                    })
                  }
                >
                  取消彩排
                </button>
              )}
              <p role="status">
                {
                  {
                    running: '正在核验',
                    interrupted: '服务已中断，请重新预览或重试本次批准',
                    failed: report.message,
                    done: '报告已生成'
                  }[report.state]
                }
              </p>
            </>
          )}
          {summary && (
            <>
              <p>
                {summary.target && '目标 ' + summary.target}{' '}
                {summary.libraryId && '库标识 ' + summary.libraryId}{' '}
                {summary.requiredBytes !== undefined &&
                  '所需空间 ' + (summary.requiredBytes / 1048576).toFixed(1) + ' MiB'}
              </p>
              {summary.counts && (
                <p>
                  {Object.entries(summary.counts)
                    .map(
                      ([k, v]) =>
                        (({
                          work: '作品',
                          source: '来源',
                          member: '归属',
                          tags: '标签组',
                          task: '任务',
                          home: '归档目录',
                          profile: '作者资料',
                          audioHint: '配乐线索',
                          run: '读取日志',
                          logItem: '日志明细',
                          media: '媒体'
                        })[k] ?? k) +
                        ' ' +
                        v
                    )
                    .join(' · ')}
                </p>
              )}
              {summary.identities?.map((s) => (
                <div key={s.source}>
                  <p>
                    {s.source} · {s.sourceId} · 账号 {s.uid}
                  </p>
                  <p>
                    独有作品 {s.inventory?.work?.unique ?? 0} · 独有归属 {s.inventory?.member?.unique ?? 0} ·
                    媒体引用 {s.mediaClaims} · 待核对 {s.held}
                  </p>
                </div>
              ))}
              {summary.snapshot && (
                <p>
                  数据库快照 {summary.snapshot}
                  <br />
                  归档目录 {summary.mediaRoot}
                  <br />
                  清单 SHA-256 {summary.manifestSha256}
                </p>
              )}
              {summary.updatedAfterSnapshot && (
                <p role="alert">封存期间运行库新增或变更了资料，请保留刚生成的快照并在停写后再建恢复点。</p>
              )}
              {summary.verifiedPlayback !== undefined && (
                <p>
                  已在独立目标登记 {summary.registeredFiles} 个文件，正式播放接口已读回{' '}
                  {summary.verifiedPlayback} 个资源。
                </p>
              )}
              {(summary.matched !== undefined || summary.verification) && (
                <p>
                  数据库已核验 · 匹配 {(summary.verification ?? summary).matched} · 缺失{' '}
                  {(summary.verification ?? summary).missing} · 变动{' '}
                  {(summary.verification ?? summary).changed} · 清单外{' '}
                  {(summary.verification ?? summary).extra}
                </p>
              )}
              {!!summary.total && (
                <>
                  <p>
                    核对明细 {summary.total} 条 · {page}/{totalPages} 页
                  </p>
                  <ul>
                    {report.items.map((r, i) => (
                      <li key={i}>{[r.source, r.type, r.key, r.reason].filter(Boolean).join(' · ')}</li>
                    ))}
                  </ul>
                  <button disabled={busy || page <= 1} onClick={() => handle(() => select(job, page - 1))}>
                    上一页
                  </button>
                  <button
                    disabled={busy || page >= totalPages}
                    onClick={() => handle(() => select(job, page + 1))}
                  >
                    下一页
                  </button>
                </>
              )}
              {approval && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    我已核对来源、删除保护与候选，确认写入独立目录 {target}
                  </label>
                  <button
                    className="button primary"
                    disabled={busy || !confirmed}
                    onClick={() =>
                      handle(() =>
                        launch({
                          action: 'import',
                          sources: config.sources,
                          target,
                          previewId: summary.previewId,
                          uid: config.uid,
                          confirmed: true
                        })
                      )
                    }
                  >
                    批准本次彩排
                  </button>
                </>
              )}
              {summary.snapshot &&
                summary.libraryId &&
                config.jobs.find((j) => j.id === job)?.target === target && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      handle(() =>
                        launch({ action: 'preserve', target, libraryId: summary.libraryId, confirmed: true })
                      )
                    }
                  >
                    封存此彩排库的后续增量与任务
                  </button>
                )}
            </>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
