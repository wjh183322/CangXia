# 客户端批量下载与响应性优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复数万条历史记录下批量下载准备阻塞窗口的问题，同时减少浏览及状态更新的重复计算。

**Architecture:** 主进程继续协调正式写入和下载任务。通过一次目录归属索引、事务性任务受理和分段执行消除重复工作；大库只读分析由一个按需启动的 Electron utility process 完成。文件保护基线在首次受理时建立，未放行任务通过持久化批次标记限制调度。

**Tech Stack:** 现有 Electron 44.3.0、Node `node:sqlite`、ES modules、React、`node:test`、现有 Windows 桌面及 ASAR 验证工具；不新增第三方运行时依赖。

**Spec:** `docs/superpowers/specs/2026-10-28-client-responsiveness-design.md`（用户于 2026-10-28 确认）。代码基线 `08e6436522a3828211e9c32b51f90d7d830b4fa8`，设计提交 `b8bfcf71b0389c7176a7b3fcc00848710394fdbb`。

## Global Constraints

- 执行方式已由用户选定：本会话逐项实现，最后独立审查；使用 `superpowers:executing-plans`。本计划审阅前不实施。
- 不修改读取新增计数、收藏顺序、来源、原作品状态分类、NAS 删除版本或恢复授权规则；不要求 NAS 升级。
- B 仅为只读目录分析；现有文件检查和备份分析线程继续复用。辅助进程不写正式库、不操作作品文件、不接收凭据。
- 大库初始阈值 10,000；默认通信块最多 200 项或 256 KiB；最多一个分析请求；辅助进程空闲 30 秒回收。
- 主进程受理循环每片最多 50 项或约 8 ms；异步 I/O 设并发上限；不把 SQLite 写事务跨 `await` 保持。
- 首次受理前采集保护快照并随任务持久化；重试沿用原 epoch；取消清理规则不得弱化。未放行标记也适用于重试的失败任务。
- 单项失败可继续准备其他项并放行成功项；主动停止、整批中断及异常退出后，已受理项暂停，未受理项不自动创建。
- 指标目标：状态约 200 ms 内可见、主进程计算片段目标 ≤50 ms、事件循环延迟 p95 ≤100 ms、停止反馈约 500 ms；>250 ms 停顿查明阶段。原问题规模准备耗时目标下降至少 80%，不能拿外推代替实测。
- 所有测试隔离临时数据，不使用用户账号或真实作品目录。Windows 清理仅限已验证的测试根目录；不清空回收站、不改 ACL。
- 每次提交只显式 `git add -- <本任务已核对文件>`；不提交 .test-output、用户统计文件或其他已有改动。
- 不自动安装到用户现用客户端，不自动部署 NAS；不覆盖或强推既有发布标签。发布时必须核对对应提交云端 CI 最终结果。

## Review Focus

1. 同名目录、外部新建/替换文件、已有备份 `home` 与链接：快速路径仍保留正确归属与原文件；由 Task 1、3 测试。
2. 只读快照期间其他任务提交路径变化、本批自己登记、消息迟到/重复：只重新核对受影响候选，不反复重建或使用过期结果；由 Task 2、4 测试。
3. 重试原失败任务后停止准备或重启：epoch 不变、未放行项不偷跑、明确继续只影响该批；由 Task 3、4、5 测试。
4. 删除准备、退出、取消与受理同时发生：先安全停止当前片段，已完整文件不因移除旧任务被清理；由 Task 4、5 测试。
5. 连续输入搜索及大量进度通知：不累计过期查询，不丢准备状态，不改变顺序/分页/跨页选择；由 Task 6、7 测试。

---

## 文件结构与共用契约

新模块各司其职，不拆分不相关功能：

| 文件 | 责任 |
|---|---|
| `electron/download-directory-index.mjs` | 路径规范化、紧凑索引、候选冲突与批次预留 |
| `electron/download-path-journal.mjs` | 事务一致的路径变更代次与有界覆盖层 |
| `electron/download-analysis-process.mjs` | 辅助进程管理、分块/ACK、超时与回收 |
| `electron/download-analysis-entry.mjs` | utility process 入口；只读快照提取与候选查询 |
| `electron/download-ownership-async.mjs` | 异步采集与现有格式兼容的首次任务保护快照 |
| `electron/download-preparation-repository.mjs` | 本机批次摘要、结果分页、未放行持久化与恢复 |
| `electron/download-preparation.mjs` | 下载准备状态机，协调规划、分析、受理、停止和继续 |
| `src/download-preparation-ui.jsx` | 可关闭重开的进度、停止/继续和结果提示 |
| `tests/download-preparation-fixture.mjs` | 隔离 SQLite/目录夹具与可控分析服务、慢 I/O、时钟 |
| `scripts/benchmark-download-preparation.mjs` | 同机同夹具基线/优化性能报告，不访问用户库 |

共用数据命名固定：`PreparationRequest={ids:string[], source:'douyin'|'nas', scope:'unsaved'|'missing', coverOnly:boolean, catalogueLibrary?:string, kind:'selection'|'exact'}`。`selection` 应用普通下载范围；`exact` 供已核对的补齐/NAS/封面调用，仍检查作品有效性和任务类型冲突。

`PreparationState={operationId,phase,total,processed,accepted,existing,skipped,failed,remaining,held,errorCode?,message}`；阶段为 `idle|analysing|capturing|admitting|stopping|complete|partial|stopped|failed`。结果列表单独分页，每页 50，公开状态不含路径、原始清单或快照字节。

`AdmissionResult={operationId,queued,existing,skipped,unavailable,removed,failed,remaining,held}`；`queued` 只表示本批实际受理数量，不等于下载完成。单个任务持久化 `admission:{operationId,held:boolean}`，与 `cancelOwnership` 独立。

## Task 1：一次目录索引与可复现基线

**Files:** Create `electron/download-directory-index.mjs`, `electron/download-path-journal.mjs`, `tests/download-directory-index.test.mjs`, `tests/download-preparation-fixture.mjs`, `scripts/benchmark-download-preparation.mjs`; Modify `electron/store.mjs`、`electron/local-reconcile.mjs` 的目录上下文入口；不提前接新下载流程。

**Interfaces:** `directoryKey(file):string`; `buildDirectoryIndex(rows:Iterable<{id,path}>):Map<string,Set<string>>`; `DirectoryReservations.reserve(path,id)`, `.owners(path)`, `.release(id)`。`DownloadPathJournal.init()`, `.head():number`, `.changes(after,{limit:200}):{head,floor,items,hasMore}`, `.prune()`。`createPreparationFixture(t,{savedCount,unsavedCount,unavailableCount})` 返回 `{store,queue,ids,root,operations,close}`，可注入受控媒体请求，默认不启动真实下载。

- [ ] **Step 1 — 写失败测试。** 用真实临时 SQLite 核对索引路径，不仅伪造 Map；保存可运行的现有 `enqueue` 基线测量。benchmark 的 baseline 代码固定取自设计基线 `08e6436522a3828211e9c32b51f90d7d830b4fa8`，提取到自建临时源树后运行同一夹具；optimized 使用当前源码，不能修改实现后仍把当前 enqueue 当旧基线，也不能只硬编码旧耗时。测试断言：
  ```js
  assert.equal(scanCount, 1); // 31,542 条历史记录＋775 次候选查询只构建一次
  assert.deepEqual([...index.get(directoryKey(shared))].sort(), ['1','2']);
  assert.equal(reservations.owners(shared).has('new'), true);
  assert.equal(journal.head(), beforeRollback); // 路径事务回滚不发布变更
  ```
  覆盖 Windows 大小写、同名、作者目录、可靠 `home`、批次自身预留、原文件不被更改；基线计时不作为未优化测试的脆弱毫秒断言。
- [ ] **Step 2 — 运行红灯。** `node --test tests/download-directory-index.test.mjs`；应因新接口不存在或重复扫描断言失败。
- [ ] **Step 3 — 实现索引与事务日志。** 仅通过 `SELECT id,json_extract(body,'$.path') path FROM downloads` 读取归属；新增本机 `download_path_changes`、日志地板元数据及路径 INSERT/UPDATE/DELETE 触发器，在同一 SQLite 事务记录旧/新路径。直接 SQL、遗忘文件及回滚都必须捕获；只改资源进度不生成路径事件。无活动快照时保留最近 10,000 个事件，低于地板的请求报 `PATH_JOURNAL_GAP`，不继续用旧索引。根/资料库及来源变化另以上下文标识和逐项签名验证，不与字节进度混用。
- [ ] **Step 4 — 绿灯与基线。** `node --test tests/download-directory-index.test.mjs tests/collection-sync-isolation.test.mjs`；全通过。运行 `node scripts/benchmark-download-preparation.mjs --variant baseline --saved 31542 --new 775 --output .test-output/responsiveness-baseline.json`，保留实际完成或可解释的超时报告；必须另有 1/5/20 项样本，不能只给外推结果。
- [ ] **Step 5 — 提交。** 只提交本任务指定源码/测试/脚本：`git commit -m "perf: index download directory ownership once per batch"`。

## Task 2：受控的独立只读分析进程

**Files:** Create `electron/download-analysis-process.mjs`, `electron/download-analysis-entry.mjs`, `tests/download-analysis-process.test.mjs`, `tests/download-analysis-desktop-checks.mjs`; Modify `tests/backup-desktop.mjs` 注册真实 Electron 检查；复用 Task 1 模块。

**Interfaces:** `DownloadAnalysis({file,root,libraryId,spawn,idleMs=30000,timeoutMs=30000})` 提供 `open({operationId,signal}):Promise<{snapshotId,baseSeq,context}>`, `lookup(snapshotId,candidates,{signal}):Promise<Array<{path,owners:string[]}>>`, `release(snapshotId)`, `close()`。`candidates` 是候选目录，不是完整作品对象。生产 `spawn` 使用 `utilityProcess.fork`；测试注入消息适配器，Node 测试不把 worker thread 当作生产独立进程。

- [ ] **Step 1 — 写失败测试。** 消息限额、ACK、取消、崩溃、空闲回收及一致性：
  ```js
  assert.ok(packets.every(p=>p.items.length<=200 && p.bytes<=256*1024));
  assert.equal(maxUnacknowledged, 1);
  assert.equal(snapshotBuilds, 1);
  assert.equal(readTransactionOpenWhenWaitingForAck, false);
  assert.notEqual(await helperPid(), mainPid); // 在真实 Electron 桌面检查中断言
  ```
  正式桌面测试使用 `assert.notEqual(helperPid, mainPid)`；验证 readonly SQL 拒绝写入，主进程回复无全库清单，取消后迟到消息无效；第 30 秒可回收，活动请求不误回收。
- [ ] **Step 2 — 红灯。** `node --test tests/download-analysis-process.test.mjs`；应因新服务缺失失败。
- [ ] **Step 3 — 实现协议。** 启动后在一个 read-only SQLite 快照读取 `baseSeq` 和紧凑路径索引；事务结束再回 ready/候选块，不跨 ACK 保持读事务。请求/响应校验 operation/session/context，候选、响应均严格分块；单项超限可见失败。最多一个请求和一个等待槽，再多请求报忙；退出结清等待者；崩溃不回退同步扫描。环境使用必要变量白名单，不传入会话或 NAS 密钥。将 utility 入口纳入既有 `electron/**/*` 打包路径并检查实际包内启动。
- [ ] **Step 4 — 绿灯。** `node --test tests/download-analysis-process.test.mjs tests/download-directory-index.test.mjs`；通过。`node scripts/backup-desktop-test.mjs` 中真实辅助进程 PID、只读查询、崩溃后的错误反馈检查通过。
- [ ] **Step 5 — 提交。** `git commit -m "feat: isolate download directory analysis in a utility process"`。

## Task 3：异步采集原文件保护快照

**Files:** Create `electron/download-ownership-async.mjs`, `tests/download-ownership-async.test.mjs`; Modify `electron/download-cancel-cleanup.mjs` 提取可复用的纯校验/格式约束，保留已有写入身份跟踪；沿用 `tests/download-cancel-cleanup.test.mjs`。

**Interfaces:** `captureCancellationOwnership(store,id,{target,signal,legacyUnknown=false,epoch,ioConcurrency=4}):Promise<Ownership>` 返回与现有 `version:1` 相同的 `cancelOwnership` 格式。已有未完成任务由协调器直接沿用快照，不调用此函数重置。`target:{dir,collectionId,home}` 来自 Task 1/2 分析并由主进程复核。

- [ ] **Step 1 — 写失败测试。** 注入慢 `lstat/readdir/readFile`，证明等待期间事件循环可响应；验证首次受理后、真正下载前已有文件仍保留：
  ```js
  assert.equal(retry.cancelOwnership.epoch, originalEpoch);
  assert.equal(maxIoConcurrency<=4, true);
  assert.ok(heartbeats>0);
  assert.deepEqual(await readOriginalFiles(), originals);
  ```
  覆盖符号链接/越界拒绝、同名目录、metadata 原始字节、外部替换、异步采集期间根目录变化；中断不创建作品文件。
- [ ] **Step 2 — 红灯。** `node --test tests/download-ownership-async.test.mjs`；新接口不存在或同步阻塞检查失败。
- [ ] **Step 3 — 实现异步采集。** 使用异步 fs、并发 4、读前后身份确认；不截断 metadata，不放宽边界。采集结果仅为建议，最终受理前核对任务/根目录/路径签名；对原有 legacyUnknown 保留保守清理规则。已有单任务写入身份检查继续由原模块负责，不迁移文件写入到辅助进程。
- [ ] **Step 4 — 绿灯。** `node --test tests/download-ownership-async.test.mjs tests/download-cancel-cleanup.test.mjs`；全部通过，外部新文件/替换文件、共享内容和元数据恢复回归成立。
- [ ] **Step 5 — 提交。** `git commit -m "perf: capture download ownership without blocking the main loop"`。

## Task 4：持久化分段受理、停止和恢复

**Files:** Create `electron/download-preparation-repository.mjs`, `electron/download-preparation.mjs`, `tests/download-preparation.test.mjs`; Modify `electron/download-tasks.mjs`, `electron/downloads.mjs` 的增量登记、调度门控和安全移除；必要时扩展 `electron/download-selection.mjs` 的分段规划，共用原分类语义。

**Interfaces:** `DownloadTasks.upsertMany(jobs)`, `.removeMany(ids)` 增量维护 Map/桶/脏集，不整队替换。`DownloadQueue.admitPrepared(jobs,{operationId,held:true}):number`, `.releaseAdmission(operationId,ids)`, `.discardUnneeded(ids):Promise<{removed}>`。`DownloadPreparation({store,queue,analysis,onChange,diagnostics})` 提供 `.start(request):{operationId}`, `.submit(request):Promise<AdmissionResult>`, `.state()`, `.results({operationId,page:1})`, `.stop(operationId)`, `.continue(operationId):Promise<AdmissionResult>`, `.drain({ids?,signal?})`, `.close()`。

- [ ] **Step 1 — 写失败测试。** 真实临时库完整准备 32,585 个选择，775 入队；成功、单项失败、主动停止、整批错误、崩溃重启分开测试：
  ```js
  assert.equal(result.queued, 775);
  assert.equal(fullOwnershipBuilds, 1);
  assert.equal(queue.jobs.filter(j=>j.admission?.held).length, acceptedBeforeStop);
  assert.equal(reopenedQueue.startedHeldJobs, 0);
  assert.equal(retried.cancelOwnership.epoch, oldEpoch);
  assert.equal(unrelatedRunning.state, 'running');
  ```
  自身登记不使整批失效；其他任务路径变化只重核受影响项；日志缺口/根改变终止；明确继续只放行本批；duplicate start 返回现有批次或可见忙错误，不重复登记。移除完整作品旧失败任务后，逐字节验证文件仍在。
- [ ] **Step 2 — 红灯。** `node --test tests/download-preparation.test.mjs`；新协调器/门控缺失失败。
- [ ] **Step 3 — 实现状态机。** 本机表 `download_preparations(id,body)` 保存摘要、`download_preparation_results(operation_id,work_id,position,state,reason)` 仅保存实际受理/失败项，不为 31,542 个跳过项存完整对象；任务 `admission` 与快照同事务登记。每片 ≤50 项/约8 ms，无写事务跨 await。路径覆盖层合并 Task 1 日志及本批预留；根/身份/代次缺口中断。先完整快照再登记 held，正常完成解除限制；单项错误放行其他成功项，整批中断保持 held。停止/失败受理中重试任务与新任务同规则，保留原 epoch。结果页50项，摘要最近20个已终结且无held批次，未解决批次不清除；分析覆盖层最多10,000事件，溢出明确中断。
  调度器、resume、retry、重启恢复均跳过 held；只有 `.continue` 复核后解除本批。`discardUnneeded` 必须先停止并等待相关旧写入者，再移除任务而不调用产物删除；显式取消仍用原 cleanup，成功后释放预留。
- [ ] **Step 4 — 绿灯。** `node --test tests/download-preparation.test.mjs tests/download-selection.test.mjs tests/download-cancel-cleanup.test.mjs tests/download-ownership-async.test.mjs`；全部通过。常规 `queue.enqueue` 尚可保持旧入口以保证本任务独立，下一任务统一迁移后不允许生产调用绕过准备器。
- [ ] **Step 5 — 提交。** `git commit -m "feat: persist responsive download preparation and held admissions"`。

## Task 5：接通全部入口、冲突协调与退出

**Files:** Modify `electron/main.mjs`, `electron/preload.cjs`, `electron/downloads.mjs`, `electron/defect-repair.mjs`, `electron/nas-catalogue.mjs` 及引用 `enqueue` 的测试；Create `tests/download-preparation-integration.test.mjs`。精确生产调用点：主程序 NAS catalogue restoreFiles、checkRepairs 后补齐、download、repairVideoCover、协议链接入队，以及 DefectRepair 完成后分组入队。

**Interfaces:** 新 preload：`startDownloadPreparation(request):Promise<{operationId}>`, `stopDownloadPreparation(operationId)`, `continueDownloadPreparation(operationId)`, `downloadPreparationResults(options)`。`runtimeState.downloadPreparation` 为公开摘要。保留 `api.download(ids,options):Promise<AdmissionResult>` 兼容等待式调用；生产 `DownloadQueue.enqueue(ids,options):Promise<number>` 委托准备器 `kind:'exact'`，全部调用者显式 await，不把 Promise 当数量。只在协调器内部调用 `admitPrepared`。

- [ ] **Step 1 — 写失败测试。** 所有入口准确保留类型与结果：
  ```js
  assert.equal(typeof legacyDownloadResult.queued, 'number');
  assert.equal(defectQueued.source, 'douyin');
  assert.equal(nasQueued.catalogueLibrary, libraryId);
  assert.equal(coverQueued.coverOnly, true);
  assert.equal(shutdownClosedDbWhileAdmitting, false);
  ```
  准备中 scoped delete/root change/重试冲突被明确拒绝或先安全 drain；安全读取仍可用；删除等待包含整个准备操作，不只等待已返回的 start IPC。正常退出和 renderer 崩溃都暂停受理，不放行 held。
- [ ] **Step 2 — 红灯。** `node --test tests/download-preparation-integration.test.mjs`；未接线的入口失败。
- [ ] **Step 3 — 统一接线。** 注入 manager 与 analysis，设置 guarded/read-only IPC 白名单与当前写入权限复核；新 start 必须立即返回 ID，工作下个事件循环启动。`backup.beforeScopedDeletion`、`finishBackupExit`、`before-quit`、render-process-gone、NAS 应用记录和根目录修改协调准备器；先停止新受理，等待当前片段持久化，再 close helper/DB。保留 NAS 音频恢复与媒体恢复各自数量；失败也报告已受理数，不产生 false success toast。
  迁移并更新所有 sync `enqueue` 数值断言和 caller，测试使用注入分析服务/隔离准备器，不留下只为过旧测试保留的同步全库 fallback。
- [ ] **Step 4 — 绿灯。** `node --test tests/download-preparation-integration.test.mjs tests/download-preparation.test.mjs tests/download-selection.test.mjs tests/source-status.test.mjs tests/download-cancel-cleanup.test.mjs`；通过。`rg -n 'queue\.enqueue\(' electron` 每个生产调用均已 await/return Promise；`node scripts/backup-desktop-test.mjs` 验证源程序真实入口。
- [ ] **Step 5 — 提交。** `git commit -m "refactor: route download admission through responsive preparation"`。

## Task 6：准备状态可见与浏览派生数据去重

**Files:** Create `src/download-preparation-ui.jsx`, `tests/download-preparation-ui-checks.mjs`; Modify `src/main.jsx`, `src/library-ui.jsx`, `electron/main.mjs`, `electron/preload.cjs`, `electron/state-patch.mjs`, `electron/snapshot-feed.mjs`, `electron/work-views.mjs`, `electron/search-index.mjs`, `tests/workspace-ui.mjs`, `tests/local-performance.test.mjs`；只修改测得有重复工作的部分。

**Interfaces:** `DownloadPreparationStatus({state,onOpen})`, `DownloadPreparationPanel({api,state,onClose,onResult})`；关闭提示不停止任务，入口可重开；继续/停止由 Task 5 API 操作。`SearchIndex.query(ids,options,{signal,requestKey}={})` 对同 requestKey 的旧查询取消，保留不同来源的独立查询；搜索索引增量准备共享，不因取消一个查询取消其他调用的初始化。preload 兼容扩展 `filterWorks(ids,{...options,requestKey})`，新增 `cancelFilterWorks(requestKey)`；主进程按有效 renderer 来源和键拥有 AbortController，renderer 的同一列表保持稳定键，切换/卸载时取消，不能只在界面丢回复。

- [ ] **Step 1 — 写失败测试。** UI start确认只发送一次，200ms目标内可见准备状态；停止/重开/继续/部分失败显示实际计数。运行更新与过期回复：
  ```js
  assert.strictEqual(runtimeOnlyUpdate.works, before.works);
  assert.strictEqual(runtimeOnlyUpdate.members, before.members);
  assert.equal(recomputedSelectionOnByteProgress, 0);
  assert.equal(staleSearchApplied, false);
  assert.ok(maxQueuedSearchesPerKey<=1);
  assert.equal(mergeState(staleFrame, delta).downloadPreparation.operationId, operationId);
  ```
  翻页/收藏顺序/跨页选择/详情返回位置不变，原任务列表仍分页50项；失败不能显示新增0掩盖错误。
- [ ] **Step 2 — 红灯。** `npm run test:ui` 运行新增检查；`node --test tests/local-performance.test.mjs` 检查 runtime 引用及过期帧；新状态未接入时应失败。
- [ ] **Step 3 — 实现窄更新。** 下载批量确认使用 start API，避免全局 pending 覆盖整个准备期；状态提示关闭后保留入口。资料与运行版本分开，原数据未变则复用 works/membership/标签/作者引用；selection派生用memo。搜索合并间隔150ms，具备独立 requestKey 的后端取消；每次新输入取消同键旧查询，结果不反向覆盖。对全文排序等重计算仍分段；不为正常浏览再建进程。
- [ ] **Step 4 — 绿灯。** `npm run test:ui`、`node --test tests/local-performance.test.mjs tests/download-preparation-integration.test.mjs` 全通过；四个现有 NAS/音频/日志/补齐布局脚本通过，新增提示不挤坏小窗口。
- [ ] **Step 5 — 提交。** `git commit -m "perf: keep browsing responsive during download preparation"`。

## Task 7：同规模性能、故障恢复与实际包验收

**Files:** Create `tests/download-preparation-performance.test.mjs`, `tests/download-preparation-desktop-checks.mjs`, `docs/research/2026-10-28-client-responsiveness-verification.md`; Modify Task 1 benchmark、`tests/backup-desktop.mjs`、`scripts/check-backup-package.mjs` 的辅助进程覆盖；实施后把本计划已完成项勾选并记录实际证据。

**Interfaces:** benchmark `--variant baseline|optimized --saved 31542 --new 775 --runs 3 --output <path>` 产生计数、冷/热耗时、主进程事件循环 p95/max、首个状态时间、停止反馈、主/辅助进程峰值资源；真实临时库与纯分析分别出报告。结果中不记录标题/路径/凭据。

- [ ] **Step 1 — 写回归验收。** 先在基线确定结构性检查失败、窗口状态不能在长同步段及时返回；再在新实现运行相同条件。核心断言：
  ```js
  assert.equal(report.admitted, 775);
  assert.equal(report.fullOwnershipBuilds, 1);
  assert.equal(report.perTaskFullManifestParses, 0);
  assert.ok(report.optimizedMs<=report.baselineMs*0.2); // 同机同夹具的目标报告
  assert.equal(report.heldStartedAfterRestart, 0);
  assert.equal(report.originalFilesChanged, 0);
  ```
  上述耗时比例在独立同机 benchmark 中验收；普通 CI 单元测试固定断言结构、正确性与能让出事件循环，CI另存多轮性能报告，不把同机80%目标降格为口头估计。单独记录 ≤50ms片段、p95≤100ms、>250ms阶段、约200ms首状态/500ms停止、峰值内存；硬件噪声不能吞掉错误。增加慢盘、消息乱序/超限、整批崩溃、事务失败、任意受理点退出、同名/替换文件及在准备时真实翻页/搜索的桌面检查。
- [ ] **Step 2 — 完成失败/通过闭环。** `node --test tests/download-preparation-performance.test.mjs`；先看到原行为失败，再看到优化结果通过；重新运行 baseline/optimized 三轮，不能只复用前一次模拟1.9秒。
- [ ] **Step 3 — 回归及打包。** 顺序运行 `npm test`、`npm run test:ui`、`npm run build`、`node scripts/backup-desktop-test.mjs`、`node scripts/backup-preview-desktop-test.mjs`；运行 NAS、audio-viewer、read-log、repair 四个 Electron 布局脚本。随后构建 Windows 包，运行 `node scripts/check-backup-package.mjs`、`node scripts/backup-desktop-test.mjs --packaged`、`node scripts/backup-package-smoke.mjs`，确认真实 ASAR 内 utility process 能启动、停止和回收。检查两种 Windows 产物的启动与源码一致性，若系统已有安装包验证辅助脚本可复用，不下载/执行不明工具。
- [ ] **Step 4 — 独立整分支审查。** 按 `superpowers:requesting-code-review` 对设计、计划、最终差异、性能报告及取消恢复证据做一次独立审查；按反馈复现并修复重要问题。记录通过项、风险和真实遵义/NAS未验收部分。若发布，先确定精确提交并验证云端CI最终状态；不可用旧提交绿灯替代本轮，失败必须处理或明确报告。
- [ ] **Step 5 — 提交及交付。** `git commit -m "test: verify bulk download responsiveness and recovery"`。只在所有必需检查与重要审查问题完成后按 `superpowers:finishing-a-development-branch` 处理整合/发布；本计划不授权真实作品清理或 NAS 迁移。

## 自审覆盖与执行交接

| 设计范围 | 计划任务 |
|---|---|
| 一次索引、路径代次、命名及本批预留 | 1、2、4 |
| 独立只读进程、快照/ACK、一致性、回收及打包 | 2、7 |
| 首次受理保护基线、重试不重置、异步文件检查 | 3、4 |
| 分段受理、部分失败、停止/重启、明确继续 | 4、5 |
| 所有下载来源/补齐入口、删除冲突及退出 | 5 |
| 状态可见、浏览/搜索/选择及增量通知 | 6 |
| 同规模/慢盘/并发/原文件保护/源程序和实际包验证 | 7 |

已自审：任务间接口统一使用 operationId、admission.held、baseSeq；Task 2 的只读快照不会跨 ACK；Task 4 不因本批登记反复全库构建；Task 5 不遗留 Promise 当数字的生产 caller；五项 Review Focus 均有拥有者及明确测试。没有实施代码，也没有本轮通过/性能改善的宣称。

执行前在隔离工作区按 `using-git-worktrees` 核对当前改动并保留无关文件。用户此前已指定本会话执行，因此交接只请审阅本计划，不重新要求选择执行方式；确认计划后使用 `executing-plans` 按任务推进，最终独立审查。
