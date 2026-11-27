# 藏匣服务版 0.4.1 完整实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付保持藏匣备份版操作习惯的完整 Windows 客户端，以及可直接拉取、持有唯一资料库并执行采集和下载的 NAS 服务。

**Architecture:** 沿用 Electron、React 和现有 preload 边界。NAS 将权限、完整页事务、队列、文件和回执落在独立持久卷；Windows 负责交互、本机导出和可清理缓存。以下任务是同一交付的实施顺序，任何一项完成均不单独标为完整版。

**Tech Stack:** 项目现有 Electron 44.3.0、React 19.3.0、Vite 8.3.0；NAS 沿用已验证的 Linux amd64、Node/SQLite、Playwright Chromium、FFmpeg、OpenCV 4.11.0.86 和 NumPy 2.2.6。锁定服务依赖，复用现有构建镜像及黄金样本。

**Spec:** [已确认的完整版设计](../specs/2026-11-26-full-server-edition-design.md)


开发实绩：任务 01–04 已通过逐项独立审查。Windows 安装并存与连接门验证见[运行 45920990422](https://github.com/wjh183322/CangXia/actions/runs/45920990422)，SQLite 与会话验证见[运行 45920990514](https://github.com/wjh183322/CangXia/actions/runs/45920990514)，来源导航及解析回归见[运行 45924550123](https://github.com/wjh183322/CangXia/actions/runs/45924550123)。正式来源链路目前使用隔离的 Chromium、Electron 和合成响应验证；真实账号和实机适配仍属发布验收。

任务 05–07 已通过独立审查。按来源恢复和排序、指定断点的读取交接、可逐件查看的恢复日志、正式客户端分页目录和跨页选择已有隔离回归。仅涉及界面的选择确认不代表对应下载或删除执行器已经交付。

## Global Constraints

- 在 `codex/server-edition-full` 开发，业务和界面对照提交 `08e6436522a3828211e9c32b51f90d7d830b4fa8`。保留 main、备份版、既有 NAS 版、试验分支及试验镜像。
- 正式版本从 `0.4.1` 起；部署目标 `ghcr.io/wjh183322/cangxia-server:latest`，保留编号及镜像摘要。镜像更新不能授权改动已有资料。
- Windows 独占访问，失联锁屏；控制端退出后采集在安全页边界暂停，已确认入队的 NAS 下载继续。客户端不会上传上一会话的未确认修改。
- 正式库保留媒体正文一份及各来源的独立归属与次序；普通下载落在 NAS，平铺导出和临时缓存仍在 Windows。
- 绿联承担完整媒体备份与还原。藏匣负责数据库快照、迁移前确认与校验、删除回执、恢复结果核对。研发只用合成数据或隔离副本；生产切换、凭据、仓库可见性及正式发布按设计另行核对。

## Review Focus

1. 租期或账号已变但旧异步响应才到，屏幕、媒体流、作业写入和选择都要失效（03、05、07、10）。
2. 同一作品在两个来源的不同位置恢复，跨页、批次交接与晚到响应不能改变另一来源；历史明细与提交一致（05、06）。
3. 复制或移动媒体、登记数据库和回执分步失败，恢复后避免误认坏文件和覆盖未知目标（08、09、11）。
4. 升级时 WAL 仍有已提交记录、空间不足或快照不可打开，校验失败必须发生在迁移之前（02、13）。
5. 外部修改文件、回收站失效或绿联备份中缺少正文，按实际可恢复范围报告；旧库、快照及切换后增量均可核对（11、13、14）。

---

## 文件边界和测试方式

- 根 `package.json`、`electron/`、`src/` 构建 Windows 正式客户端；`server/` 是新正式服务包；`shared/` 放两端实际共享的数据与纯业务规则。保留备份版入口对照表和原型独立测试。文中同一行省略的目录前缀沿用前一个同类文件路径。
- 各任务的“接线”包括正常 UI、IPC、正式 HTTP 路由及存储中属于该任务的部分。优先提取并复用已经过测试的纯逻辑；试验身份、请求上限、调试路由、密钥操作、手工 ID 控台不随复用进入正式镜像。
- 代码块列出每个新测试的关键断言，变量来自同任务安排的隔离库、两端会话、作业或 DOM 夹具。测试通过正常入口制造输入，并查询真实返回值、SQLite 行、文件内容或可见 UI；只在来源响应、时间或故障点注入替身。
- 项目根目录执行命令。先用 `npm ci` 安装根锁定依赖；任务 02 创建正式服务锁文件后用 `npm ci --prefix server`。兼容基线在独立的只读代码对照和临时用户目录运行。为新测试使用 `tests/server-edition/`，正式 CI 显式执行该目录，根项目原来的顶层测试通配不包含它。
- 依赖顺序：01–03 建立身份、库与传输契约；04–06 登记并读取来源；07–12 接入全部用户操作；13 验证迁移；14 在正式候选上联合验收。窗口和协议可在接口稳定后联调，不能用模拟页面替代整链验收。

### 01．正式产品身份与兼容清单

**文件与接口**　package.json、package-lock.json、electron/main.mjs、electron/preload.cjs；新增 shared/server-identity.mjs、docs/server-edition/compatibility.md。测试文件 `tests/server-edition/product-identity.test.mjs`。从 0.3.46 的 preload、页面及动态注册的主进程处理器生成逐入口清单；输出 serverIdentity（productName、version、appId、protocolVersion）及独立 userData 根。

- [x] 在测试文件加入 `product-identity` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.equal(info.version,'0.4.1');
assert.notEqual(serverProfile,backupProfile);
assert.deepEqual(unmappedBaselineEntries,[]);
```

- [x] 运行 `node --test tests/server-edition/product-identity.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [x] 接入正式入口。每个入口写明原动作、正式版 Windows 或 NAS 的落点、已批准变化、验收用例；含事件、批选、取消、旧同步入口和平台原生操作。冻结旧版对照环境与截图；以新 appId、安装名、快捷方式和目录启动，验证旧版与新版可并存。
- [x] 重跑同一命令，全部断言通过。
- [x] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: product-identity`）。

### 02．首次建库、已有库与安全更新

**文件与接口**　新增 server/package.json、server/package-lock.json、server/start.mjs、server/library.mjs、server/upgrade.mjs；参考 feasibility/nas-b/src/config.mjs、store.mjs。测试文件 `tests/server-edition/library-upgrade.test.mjs`。openLibrary({root,expectedId,mode})；inspectUpgrade(root) → {state,from,to,spaceRequired}；applyUpgrade({approval,expectedId,from,to}) → receipt。

- [x] 在测试文件加入 `library-upgrade` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.equal(unapproved.state,'migration-required');
assert.deepEqual(afterHash,beforeHash);
assert.equal(failedSnapshot.schemaVersion,oldVersion);
```

- [x] 运行 `node --test tests/server-edition/library-upgrade.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [x] 接入正式入口。正式 schema 加专用应用标识、库 UUID 和版本。空目录须显式初始化，拒绝误挂旧库、试验卷、缺失 WAL 或陌生文件；同版本更新只做兼容性检查。需迁移时阻止作业写入，绑定确认到库及目标版本，使用 SQLite 一致性快照，独立打开并核对完整性、关键计数及清单后执行事务。快照失败保留原状；迁移若动媒体则需另有可校验文件副本。
- [x] 重跑同一命令，全部断言通过。
- [x] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: library-upgrade`）。

### 03．HTTPS、独占、操作回执与失联锁屏

**文件与接口**　新增 server/http.mjs、server/session.mjs、electron/server-client.mjs；修改 electron/main.mjs、src/session-ui.jsx；复用 feasibility/nas-b/src/lease.mjs 的互斥规则。测试文件 `tests/server-edition/session.test.mjs`。connect({url,fingerprint,deviceId})；acquire()/renew()/release()；command({operationId,kind,payload,entityVersion}) 与 receipt(operationId)。服务端校验库、账号、持有者及代际。

- [x] 在测试文件加入 `session` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.equal(winners.length,1);
assert.equal(oldClientRead.status,403);
assert.equal(replayed.jobId,original.jobId);
assert.equal(staleResponseVisible,false);
```

- [x] 运行 `node --test tests/server-edition/session.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [x] 接入正式入口。以原型已验证的 20 秒 NAS 端租期为起点。证书钉扎、Windows 系统凭据存储、非持有者最小占用状态。失去租期或唤醒先锁内容并停止媒体请求，旧异步响应不可解锁。丢确认先查回执，同 ID 不同命令拒绝；收集旧同步入口在退出/交接下的对应行为。
- [x] 重跑同一命令，全部断言通过。
- [x] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: session`）。

### 04．NAS 登录、来源适配与账号身份

**文件与接口**　新增 server/source-browser.mjs；修改 electron/main.mjs、src/inline-login.jsx；对照 feasibility/nas-b/src/browser.mjs、page-parser.mjs 和 electron/account-identity.mjs。测试文件 `tests/server-edition/source-browser.test.mjs`。openLogin(session)、verifyAccount(session) → {uid,nickname}、readSourcePage({source,cursor,authEpoch,signal})；外部仅暴露受控的登录与作业动作。

- [x] 在测试文件加入 `source-browser` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.equal(afterRestart.uid,first.uid);
assert.equal(wrongAccount.writes,0);
assert.equal(lateQr.clicks,1);
assert.equal(reportContainsSecrets,false);
```

- [x] 运行 `node --test tests/server-edition/source-browser.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [x] 接入正式入口。移植并回归 4.0.8 组件、慢二维码、失效及人工处理提示；仅当前持有者可查看。账号资料保存在 NAS。对照列表/详情字段、19 位 ID 和游标、共同作者与角色、配乐、音频提示和来源状态。复查试验目录的未提交解析器修复，同输入证明有必要后移植。
- [x] 重跑同一命令，全部断言通过。
- [x] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: source-browser`）。

### 05．来源页事务与独立归属顺序

**文件与接口**　新增 server/read-store.mjs、server/memberships.mjs；复用经核查的 work-merge；对照 electron/collection-reads.mjs、store.mjs。测试文件 `tests/server-edition/memberships.test.mjs`。commitSourcePage({jobId,jobEpoch,authEpoch,source,inputCursor,items,nextCursor,operationId,removalRevision}) → {savedCursor,restoredIds}；removeMembership({source,workId,expectedVersion})。

- [x] 在测试文件加入 `memberships` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.deepEqual(afterFolder.total,['T1','T2']);
assert.deepEqual(afterFolder.F,['F1','A','F2']);
assert.deepEqual(afterBoth.total,['T1','A','T2']);
assert.equal(mediaCopies,1);
```

- [x] 运行 `node --test tests/server-edition/memberships.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [x] 接入正式入口。作品、来源成员、该来源次序、删除版本、恢复明细、页断点和回执在同一事务内。按目标来源自动恢复；本页定位依据该来源返回顺序，快速读取合并已读前缀，保留未访问尾部，完整读取保持平台返回项相对顺序。覆盖正反读取、两个自建夹、重复页、提交前崩溃、提交后丢确认，以及在途页之后用户再次移除。
- [x] 重跑同一命令，全部断言通过。
- [x] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: memberships`）。

### 06．采集作业、必要收尾与历史明细

**文件与接口**　新增 server/read-jobs.mjs、server/read-history.mjs；修改 src/collection-read-ui.jsx、collection-batch-ui.jsx、read-history-ui.jsx、read-history-counts.jsx、author-ui.jsx；对照 electron/collection-batch.mjs、author-reader.mjs。测试文件 `tests/server-edition/read-history.test.mjs`。startRead({source,mode,followFolders,operationId})、controlRead({jobId,action,operationId})、historyItems({runId,kind,page}) → {items,total,page}；restored 项含 workId、name、source、position。

- [x] 在测试文件加入 `read-history` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.equal(batch.restoredRelations,2);
assert.equal(batch.distinctRestoredWorks,1);
assert.equal(retry.detailCount,1);
assert.equal(foldersStartedAfterFailedTotal,0);
```

- [x] 运行 `node --test tests/server-edition/read-history.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [x] 接入正式入口。连接任务 05 的事务。实现普通新增、完整核对、作者、链接导入、续读和原有确认条件。总收藏必要 JSON/目录整理完成才跟进勾选的夹；普通单夹失败与全局故障分别处理。收回旧读者后再交接，区分第 2 页已发和未发。旧日志缺详情只显示实际保存的信息。正式端覆盖超过原型页数与行数上限的样本。
- [x] 重跑同一命令，全部断言通过。
- [x] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: read-history`）。

### 07．资料库查询、搜索和原界面接入

**文件与接口**　新增 server/catalogue.mjs、electron/server-ipc.mjs；修改 electron/preload.cjs、electron/main.mjs、src/main.jsx、library-ui.jsx、workspace-ui.jsx、nas-catalogue-ui.jsx、creator-ui.jsx。测试文件 `tests/server-edition/catalogue.test.mjs`。listWorks({source,filter,sort,page,revision})、workDetail(id)、setTags(command)、resolveSelection({filter,revision})；保留 preload 的原返回结构或在主进程明确转换。

- [x] 在测试文件加入 `catalogue` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.deepEqual(page.ids,baseline.ids);
assert.equal(canFindUnlinkedWork,true);
assert.equal(expiredSelection.applied,0);
assert.equal(openedUrl,expectedDouyinUrl);
```

- [x] 运行 `node --test tests/server-edition/catalogue.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [x] 接入正式入口。原列表、搜索、筛选、排序、分页、消息、标签、作者归属、详情往返和跨页选择与备份版逐项对照。连接状态替代备份同步状态。每条恢复明细可用数字 ID 打开经校验的抖音 HTTPS 原页，使用 Windows 默认浏览器，包括库中已无作品但历史保留 ID。
- [x] 重跑同一命令，全部断言通过。
- [x] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: catalogue`）。

### 08．NAS 下载、补齐与崩溃恢复

**文件与接口**　新增 server/downloads.mjs、server/files.mjs；对照 feasibility/nas-b/src/downloads.mjs、files.mjs、electron/download-selection.mjs、resumable-transfer.mjs；修改 src/main.jsx 的队列操作。测试文件 `tests/server-edition/downloads.test.mjs`。enqueue({workIds,selection,operationId})、controlDownload({jobId,action,operationId})、getDownloadPage(query)；文件提交记录关联作品、资源、临时文件身份、大小及摘要。

- [ ] 在测试文件加入 `downloads` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.equal(reconnect.jobId,first.jobId);
assert.equal(badHash.state,'failed');
assert.equal(duplicateAssetFetches,0);
assert.equal(foreignFileTouched,false);
```

- [ ] 运行 `node --test tests/server-edition/downloads.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [ ] 接入正式入口。入队后 Windows 退出仍继续，完成前按选择清单逐一校验与登记；同资源可证实时 Range 续传，改变身份只重传受影响项。持久化下载并发、进度、补齐及取消状态。模拟文件已就位未登记、磁盘满、晚到回调、取消清理失败及重新打开；复查图集每一张、配乐、普通封面与视频。
- [ ] 重跑同一命令，全部断言通过。
- [ ] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: downloads`）。

### 09．归档整理、普通封面和高清匹配

**文件与接口**　新增 server/archive.mjs、server/covers.mjs；对照 electron/local-reconcile.mjs、hd-cover.mjs、scripts/cover-frame.py、feasibility/nas-b/src/cover-adapter.mjs。测试文件 `tests/server-edition/archive.test.mjs`。reconcileArchive({workId,expectedRevision,guard}) → {home,pending,errors}；assessCover({video,cover,signal}) → 原算法结果。

- [ ] 在测试文件加入 `archive` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.equal(secondHome,firstHome);
assert.equal(unrelatedFrame.accepted,false);
assert.deepEqual(nas.crop,windows.crop);
assert.equal(staleExportOverwrote,false);
```

- [ ] 运行 `node --test tests/server-edition/archive.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [ ] 接入正式入口。按既有归档 home、作者/收藏目录规则和实际对照样本处理重名、改名、移夹，跨作业互斥并记录可恢复动作；共享媒体只保留一套。作品信息 JSON 原子发布，失败保留必要收尾；使用原算法与固定依赖，覆盖媒体已换版本、无法可靠匹配和外部变动。
- [ ] 重跑同一命令，全部断言通过。
- [ ] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: archive`）。

### 10．媒体流、临时缓存、配乐与独立导出

**文件与接口**　新增 server/media.mjs、electron/server-media.mjs；修改 src/work-audio-ui.jsx、flat-download-ui.jsx、electron/flat-downloads.mjs、media-cache.mjs、file-browser.mjs；使用 media-http.mjs 的 Range 语义。测试文件 `tests/server-edition/media-export.test.mjs`。getMedia({resourceId,version,range,session})；exportSelection({ids,directory,includeCover})；Windows 主进程管理缓存键 {libraryId,resourceId,version}。

- [ ] 在测试文件加入 `media-export` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.equal(seek.status,206);
assert.equal(oldStream.closed,true);
assert.equal(cacheAfterSwitch.matches,false);
assert.deepEqual(nasDownloadsAfterExport,nasDownloadsBefore);
```

- [ ] 运行 `node --test tests/server-edition/media-export.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [ ] 接入正式入口。查看大图/视频、配乐预览保存和播放、拖动时局部读取；版本变化和断线时中断旧流。平铺导出到用户选定本机目录，维持顺序、防覆盖、图集和可选封面；可打开导出和缓存目录。移除普通下载的本地作品目录快捷方式。清缓存与退出仅处理对应本机任务。
- [ ] 重跑同一命令，全部断言通过。
- [ ] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: media-export`）。

### 11．删除范围、绿联回收站与恢复

**文件与接口**　新增 server/removal.mjs、server/trash.mjs；修改 src/deletion-ui.jsx；对照 electron/deletion-coordinator.mjs、deletion-history.mjs、local-removal.mjs。测试文件 `tests/server-edition/removal.test.mjs`。previewRemoval({scope,selection,revision}) → {token,files,relations}；confirmRemoval(token,operationId)、restoreRemoval(token,operationId)；trashAdapter.trash(file)、restore(receipt)。

- [ ] 在测试文件加入 `removal` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.equal(otherFolderHasA,true);
assert.equal(sharedFileExists,true);
assert.equal(unverifiedTrash.removed,0);
assert.equal(conflictingFileOverwritten,false);
```

- [ ] 运行 `node --test tests/server-edition/removal.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [ ] 接入正式入口。关系、作品元数据、正式媒体、缓存分别处理。绑定确认范围和版本；文件操作前验证目录与身份。用正式运行身份在实际挂载上删除专用样本、从绿联回收站还原并验摘要。找不到受支持且经验证的回收路径则停止可恢复文件删除并保留原件，列为发布阻断；不能用直接 unlink 通过验收。
- [ ] 重跑同一命令，全部断言通过。
- [ ] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: removal`）。

### 12．辅助业务与完整入口对照

**文件与接口**　新增 server/maintenance.mjs；修改 src/defect-repair-ui.jsx、storage-size-ui.jsx、backup-ui.jsx；对照 electron/repair-checks.mjs、defect-repair.mjs、directory-size.mjs、work-diagnostic.mjs。测试文件 `tests/server-edition/maintenance.test.mjs`。startCheck({selection,kind,operationId})、getCheckPage(query)、retryRepair(command)、exportDiagnostic({workId})；沿用任务 01 清单补齐所有剩余入口。

- [ ] 在测试文件加入 `maintenance` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.equal(missingFile.workDeleted,false);
assert.equal(unavailable.sourceMarkedOnly,true);
assert.equal(diagnosticLeaksSecret,false);
assert.deepEqual(unverifiedMappedEntries,[]);
```

- [ ] 运行 `node --test tests/server-edition/maintenance.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [ ] 接入正式入口。覆盖来源核对、文件状态和大小、下载失败重试、补齐选择、诊断、历史清理及启动退出。逐入口连接真实 handler 并覆盖取消、重复请求、旧结果返回、旧版对照差异；占位响应或按钮仅能点击不算完成。
- [ ] 重跑同一命令，全部断言通过。
- [ ] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: maintenance`）。

### 13．迁移彩排、快照移交与恢复核对

**文件与接口**　新增 server/migration.mjs、server/recovery.mjs；修改 src/backup-ui.jsx；对照 electron/backup-analysis.mjs、deleted-downloads.mjs、device-scope-state.mjs。测试文件 `tests/server-edition/migration.test.mjs`。previewImport({sources,target}) → {counts,conflicts,requiredBytes}；importApproved({previewId,target,approval})；verifyRestore({snapshot,mediaRoot}) → {matched,missing,changed}。

- [ ] 在测试文件加入 `migration` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.equal(unexplainedMissingRelations,0);
assert.equal(explicitlyDeletedRestored,0);
assert.deepEqual(sourceHashesAfter,sourceHashesBefore);
assert.equal(badOrMissingMediaReported,true);
```

- [ ] 运行 `node --test tests/server-edition/migration.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [ ] 接入正式入口。从只读一致副本读取旧 Windows、旧 NAS、恢复副本、设备删除范围与任务。报告独有归属/作品/媒体、冲突和空间，导入隔离目标，重复执行幂等；正式切换单独确认。给绿联工具提供已校验快照位置、同恢复点文件清单和归档目录。由绿联备份/还原文件，藏匣独立核对并出报告；回退前另存切换后新数据。
- [ ] 重跑同一命令，全部断言通过。
- [ ] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: migration`）。

### 14．安装包、完整镜像及发布验收

**文件与接口**　新增 server/Dockerfile、server/Dockerfile.dockerignore、server/compose.yaml、.github/workflows/server-edition-full.yml、docs/server-edition/release-acceptance.md；修改 package.json 的 dist、scripts 中对应打包入口。测试文件 `tests/server-edition/release.test.mjs`。Windows x64 客户端 0.4.1；linux/amd64 NAS 服务；构建输出 sourceRevision、version、digest 与兼容协议。使用项目内现有固定 Chromium/媒体依赖、镜像层审查和封面黄金样本。

- [ ] 在测试文件加入 `release` 场景，按本节业务输入构建夹具，断言如下。

```js
assert.equal(build.version,'0.4.1');
assert.equal(composeImage,'ghcr.io/wjh183322/cangxia-server:latest');
assert.equal(approvedRelease.latestDigest,approvedRelease.numberedDigest);
```

- [ ] 运行 `node --test tests/server-edition/release.test.mjs`，核对失败点落在缺失行为或缺失正式入口。
- [ ] 接入正式入口。在新分支运行构建及隔离测试，先形成编号候选。逐页同尺寸/缩放对照，安装、拉取、更新、保卷重启、证书变化、两台 Windows 睡眠与异地链路均实测；代表性 5 万作品，记录 LAN 冷暖列表、封面、视频与混合负载。完整备份/恢复彩排包括实际媒体；确认镜像可见性和发布许可，验收通过才指向 latest。留下装机、备份、恢复与版本回退指引，分别记录未测与失败。
- [ ] 重跑同一命令，全部断言通过；同时执行下面的候选交付检查，保留真实设备结果。
- [ ] 检查差异，仅提交该任务的功能、测试和对应验收记录（提交主题 `server-edition: release`）。

## 完整交付核对

| 对照范围 | 负责任务 | 核验输出 |
| --- | --- | --- |
| 产品身份、单一正式库、连接/锁定、错误分类 | 01–04 | 新旧版共存，旧客户端和错误账号拒绝，受保护内容不泄露 |
| 来源、字段、作者、手工标签、分页、归属与历史 | 04–07 | 同输入逐字段、逐来源顺序和逐件恢复清单；同作品多归属单份媒体 |
| 下载、配乐、封面、目录、播放、导出、修复 | 08–12 | 任务回执、资源清单、文件校验、跨平台黄金对照及真实 UI 操作 |
| 删除、回收、备份与数据切换 | 02、11、13 | 启用且实测的可恢复路径、独立快照校验、输入未改、增量与回退报告 |
| 可直接拉取的镜像与完整 Windows 安装包 | 01、14 | 版本/摘要/协议、受限容器启动、Windows 安装及保卷升级 |
| 实机验收 | 14 | 双机睡眠交接、真实异地直连或中继条件、迁移与回退、同窗口和缩放的完整 UI 对照 |

候选交付验证命令：`npm test`、`node --test tests/server-edition/*.test.mjs`、`npm run test:ui`、`npm run test:layout`、`npm run dist`、`npm test --prefix server`。任务 02 为正式包建立测试入口；任务 14 将 Electron 真机用例接入正式客户端启动器，保留可单独运行的备份版回归。Linux CI 构建 `server/Dockerfile`，检查镜像文件及每层新增内容，并用非 root 用户、独立挂载跑完整启动和重启核验。

提交前逐项复核设计及任务 01 的入口清单。归属错写、丢页、越权读写、假报完成、误删或缺少关键业务操作均阻断发布。用户真实库的导入和正式切换只在隔离彩排成功且取得该次授权后执行。
