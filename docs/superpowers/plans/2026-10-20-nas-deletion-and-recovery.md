# NAS 跨电脑删除、独立浏览与恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持选择删除本机或本机＋NAS 的当前来源记录/正式文件，并让其他电脑明确选择保留上传、跟随删除或稍后处理，且能从 NAS 找回本机移除的内容。

**Architecture:** NAS 保存按作品和内容范围的最新删除版本并在服务端拦截过期回传；客户端保存设备私有移除和待处理状态，不同步设备文件树。独立 NAS 目录服务用于搜索、按需预览与选择性恢复，删除和恢复采用幂等回执及版本比较。

**Tech Stack:** Electron、React、Node ESM、SQLite、现有 HTTPS 备份协议和媒体对象库、node:test 与双客户端隔离集成测试；不新增运行时依赖。

**Spec:** [已确认设计](../specs/2026-10-20-cross-device-deletion-and-recovery-design.md)。状态：用户已批准按本会话执行；在本机改进计划交付后继续，不再重复询问设计确认。

## Global Constraints

- 读取记录按当前来源删除，不连带删除同一作品在其他来源的读取记录。
- 账号收藏来源包含该作品的总收藏和自建收藏夹关联；作者来源按具体作者区分。
- NAS 被电脑 A 删除的内容，如果电脑 B 仍保留，B 连接后集中提示，列出作品、删除电脑、时间和内容类型。
- B 可选择“保留并上传 NAS”“同时从本机删除”或“稍后处理”；不替用户自动选择。
- 暂未处理的项目不自动回传 NAS、不自动从 B 删除；其他内容继续正常使用。
- 删除变化按游标分页获取，每页最多 100 项；界面每页 20 项，全选使用筛选快照与排除列表。
- 操作摘要默认保留 90 天、合计上限 50 MiB。最新删除状态、未解决项和防止旧副本回传所需版本不因日志清理而丢失。
- 重启不自动继续文件删除；仅本机操作可离线执行。“本机＋NAS”失败不退化为仅本机删除。
- 不执行抖音取消收藏，不测试真实用户库，不清理研究目录；媒体删除只能操作已经验证归属的选中范围。

## Review Focus

1. 离线 B 或旧客户端、封面/配乐后台任务绕过删除：服务端必须拒绝未获授权的恢复（任务 1、3、6）。
2. B 尚未选择时同步套用远端删除：本机仍保留并可用，对应范围暂停回传（任务 4、6）。
3. 新删除覆盖旧确认、超时回执重复、分页期间更新：版本比较及幂等回执防止错误删除或复活（任务 2、5、6、8）。
4. 共享媒体、路径变化、回收站失败或重启：不能误删其他内容或自动续删（任务 3、5、7）。
5. 只备份记录、本机已移除、换库/离线或大库：仍能查找恢复，不误判删除，不全库扫描（任务 4、6、8、10）。

---

## 文件结构与共同契约

新增模块：`shared/backup-scopes.mjs`（范围及校验）、`backup-server/scope-state.mjs`（版本和回执）、`backup-server/catalogue.mjs`（远端目录）、`electron/device-scope-state.mjs`（设备私有表）、`electron/deletion-coordinator.mjs`（A 操作）、`electron/deletion-conflicts.mjs`（B 决策）、`electron/nas-catalogue.mjs`（目录与恢复）、`src/deletion-ui.jsx`（范围选择/待处理）。在既有 Store、BackupClient、备份动作与页面接线；不重写现有上传传输、对象校验、缓存和播放器。

接口以 JSDoc 固定：

- `Scope={workId:string,kind:'account'|'author'|'files',sourceId:string}`；account.sourceId=`__all__`（库现有账号收藏），author.sourceId 为现有作者 secUid，files.sourceId=`''`。scopeKey 使用规范 JSON 元组编码，不能用可能碰撞的字符串拼接。
- `ScopeVersion={scope:Scope,generation:number,deleted:boolean,revision:number,operationId:string,deviceId:string,deviceName:string,at:string}`。初始无标记为 generation 0；只有明确删除/恢复递增 generation。`deleted:false` 不等于有完整媒体，存在性另查目录。
- `ScopeCommand={libraryId:string,operationId:string,items:Array<{scope:Scope,expectedGeneration:number}>}`，每批≤100，合法 ID/来源沿用现有校验；没有明确记录也允许显式删除建立屏障。
- `ScopeReceipt={operationId:string,revision:number,items:ScopeVersion[]}`。原子批次、同操作同请求返回同回执；同操作不同内容拒绝。所有写入须 current generation proof；恢复另需服务器签发的范围 grant。
- 协议升至 3、服务端 schema 至 4；服务端下个可用版本预期 0.2.4，桌面版本在发布时分配。未完成全部接线前不开启删除 capability。客户端不能把网络缺失推断成删除。

### Task 1: 范围契约、迁移与新写入协议门槛

**Files:** Create `shared/backup-scopes.mjs`, `tests/backup-scopes.test.mjs`; Modify `shared/backup-protocol.mjs`, `backup-server/database.mjs`, `backup-server/server.mjs`, `tests/backup.test.mjs`。

**Interfaces:** `normalizeScope(input):Scope`、`scopeKey(scope):string`、`validateScopeCommand(input):ScopeCommand`；服务端 scope_state 最新状态表、scope_receipts 幂等回执表、restore_grants 临时授权表。主键 (workId,kind,sourceId)，revision 索引；继续使用库 meta.libraryId。所有有副作用路由统一校验协议 3，能力声明 `scopedDeletion:1`。

- [x] **Step 1: 写失败测试。** `scopes reject cross-author and malformed ranges` 断言 author ID 校验及 files 空 source；`schema migration preserves library and records` 断言旧库 ID、数量、对象哈希不变且生成一致性备份；`old writer cannot commit or upload` 覆盖 lease、commit、upload、audio 写入，断言统一升级错误；协议 3 正常写入。`failed migration leaves old database usable` 断言未开始新协议写入、未清对象。
- [x] **Step 2: 运行红灯。** `node --test tests/backup-scopes.test.mjs tests/backup.test.mjs`；预期新契约/门槛断言失败。
- [x] **Step 3: 实现契约及迁移。** 迁移前沿用 VACUUM INTO＋quick_check，一次事务建表；历史缺失记录不产生 tombstone。旧自动补传禁止标记迁移为相应 files 屏障，来源未知则标旧状态，不编造操作者。认证设备信息用于新事件，不接受请求任意姓名。capability 仅在本计划集成完成后开启。
- [x] **Step 4: 运行绿灯。** 同 Step 2；已存在高版本库拒绝降级打开，数据与对象均保留。
- [x] **Step 5: 提交。** 显式暂存本任务文件，`git commit --quiet -m "feat: add scoped deletion protocol and migration barrier"`。

### Task 2: NAS 范围状态、删除及恢复授权端点

**Files:** Create `backup-server/scope-state.mjs`, `tests/backup-scope-state.test.mjs`; Modify `backup-server/backup-actions.mjs`, `backup-server/server.mjs`。

**Interfaces:** `ScopeState(db)`；`statePage({after=0,limit=100}):{items:ScopeVersion[],next:number,head:number,hasMore:boolean}`；`delete(command,device):ScopeReceipt`；`prepareRestore(command,device):{grantId:string,expiresAt:string}`；`finishRestore(grantId,records,device):ScopeReceipt`。HTTP `/v1/scopes/state` GET、`/v1/scopes/delete` POST、`/v1/scopes/restore/prepare` POST、`/v1/scopes/restore/commit` POST、`/v1/scopes/receipt?operationId=...` GET。

- [x] **Step 1: 写失败测试。** `delete is explicit scoped and idempotent` 断言账号删除不动作者，文件不动来源；相同 operation 回执一致、内容不同拒绝。`restore CAS rejects stale generation` 断言新删除后旧 grant 不能恢复。`state paging survives repeated updates of the same scope` 在分页中更新同 scope，断言最终游标追上 head 且最新状态不遗漏。`missing records do not imply deletion` 断言普通空列表不创建事件。
- [x] **Step 2: 运行红灯。** `node --test tests/backup-scope-state.test.mjs`；预期模块或接口缺失。
- [x] **Step 3: 实现状态事务。** 每批校验全部 expectedGeneration 后同事务写状态、对应来源/文件引用、commit revision 和回执；不逐项半提交。多批可停，已有回执不回滚。恢复 grant 绑定库、认证设备、范围与 expectedGeneration，30 分钟过期；提交再 CAS，过期可重新准备。状态 feed 按最新 revision 扫描，客户端追到 head 后，写入仍由 CAS 防竞态；删除/恢复均向旧 changes 路径发出必要索引变化。
- [x] **Step 4: 运行绿灯。** 同 Step 2，并模拟提交成功响应丢失后按 operationId 查询，无第二次删除。
- [x] **Step 5: 提交。** 显式暂存本任务文件，`git commit --quiet -m "feat: persist versioned deletion receipts and restore grants"`。

### Task 3: 所有上传通路执行范围屏障和共享对象保护

**Files:** Modify `backup-server/server.mjs`, `backup-server/scope-state.mjs`, `backup-server/backup-actions.mjs`, `shared/backup-protocol.mjs`; Create `tests/backup-scope-barrier.test.mjs`。

**Interfaces:** `ScopeState.assertWrite({deviceId,proofs,grantId,changes}):void` 推导每个变化实际触及范围，proof 不能替代明确恢复 grant。普通协议提交增加 `scopeProofs:Array<{scope,generation}>`；媒体上传会话绑定同样 proof，提交时再次检查。下载对象只在最终有效引用提交后进入目录。

- [x] **Step 1: 写失败测试。** 删除后分别以普通作品更新、members、author_members、downloads、backupCover、共享配乐上传尝试复活，断言均拒绝被删范围，未删范围可继续写。`restore records never restores files`、反向同样测试。`delete racing an in-flight upload stays deleted` 断言旧上传无法 commit。`shared object remains while another work or active restore references it` 断言仅释放目标引用、未删物理共享对象。
- [x] **Step 2: 运行红灯。** `node --test tests/backup-scope-barrier.test.mjs tests/backup-scope-state.test.mjs`，预期旧上传绕过屏障。
- [x] **Step 3: 实现中央校验。** 不信任客户端声明 touched scopes，按实际 changed rows/媒体关联推导。普通元信息更新不能创建被删 membership/文件引用；files 删除包括永久配乐引用，记录预览可独立保留但不能保留已选删的原媒体。旧上传和 grant 临时对象带保护引用，过期且无其他引用/读取使用才回收；回执事务不得先物理删除对象再写状态。
- [x] **Step 4: 运行绿灯。** 同 Step 2，另跑 `node --test tests/backup.test.mjs tests/backup-author.test.mjs`；正常上传、预览与作者备份不回归。
- [x] **Step 5: 提交。** 显式暂存本任务文件，`git commit --quiet -m "fix: enforce scoped barriers across every backup write path"`。

### Task 4: 设备私有移除与本机有效记录投影

**Files:** Create `electron/device-scope-state.mjs`, `tests/device-scope-state.test.mjs`; Modify `electron/store.mjs`, `electron/backup-model.mjs`, `electron/backup-analysis-worker.mjs`, `electron/work-views.mjs`, `electron/local-removal.mjs`, `tests/local-removal.test.mjs`。

**Interfaces:** `DeviceScopeState(profile,libraryId)` 私有 SQLite，持有 local_masks、pending_deletions、held_records、local_operations；`hide(scopes):void`、`unhide(scopes):void`、`isHidden(scope):boolean`、`hold(version,localSnapshot):void`、`heldRecords(scope):object[]`。快照只存受影响来源关联及必要作品元信息，不存媒体正文/密钥。

- [x] **Step 1: 写失败测试。** `local hide leaves NAS export unchanged` 断言本机不可见但 exportRecords/hashes 不生成 NAS 删除；账户/具体作者隔离。`ordinary sync does not unhide` 断言重启同步后 mask 留存；明确恢复/重新读取该来源才清除。`held remote deletion preserves B local records` 断言本机仍可查详情、普通 NAS 导出不回传 held 范围。旧 readHidden 迁移不凭空恢复历史隐藏。
- [x] **Step 2: 运行红灯。** `node --test tests/device-scope-state.test.mjs tests/local-removal.test.mjs`，预期旧共享隐藏行为失败。
- [x] **Step 3: 实现两层投影。** NAS 基准记录与设备有效列表分开；私有 mask 不进入 TABLES/备份日志。B pending 范围在应用 NAS 删除前捕获必要关联，既能本机展示又从导出中排除；同作品其他来源不受影响。显式重读只清当前来源 mask，不解除 NAS deletion hold。新库 ID 使用独立状态，不沿用旧库游标；没有完整旧语义的项保守保留，不生成新 NAS 删除。
- [x] **Step 4: 运行绿灯。** 同 Step 2，加 `node --test tests/backup-analysis.test.mjs tests/backup-author.test.mjs`，证明增量导出未携带设备私有字段。
- [x] **Step 5: 提交。** 显式暂存本任务文件，`git commit --quiet -m "feat: separate device-only removal from shared backup records"`。

### Task 5: A 端删除协调、回执与可恢复本机步骤

**Files:** Create `electron/deletion-coordinator.mjs`, `tests/deletion-coordinator.test.mjs`; Modify `electron/nas-removal.mjs`, `electron/local-removal.mjs`, `electron/backup-client.mjs`。

**Interfaces:** `DeletionCoordinator({store,backup,deviceScopes,trash})`；`prepare({ids,source,records,files,target:'local'|'local-nas'}):Promise<{token,summary}>`；`confirm(token):Promise<operation>`、`stop():void`、`retry(operationId):Promise<operation>`。summary 明确实际来源、共用文件影响、NAS/本机各步骤及失败数；token 固定 ID 和目录归属快照。

- [x] **Step 1: 写失败测试。** `NAS failure never degrades to local deletion`、`lost receipt resumes by query without duplicate delete`、`restart never resumes trash automatically`。`path or ownership change aborts local step` 断言越界/链接/新路径保留。`trash failure remains retryable` 断言不报本机成功、不重复 NAS 删除。离线 local 模式仍可完成，local-nas 明确要求联网。
- [x] **Step 2: 运行红灯。** `node --test tests/deletion-coordinator.test.mjs tests/nas-removal.test.mjs`，预期双端操作与自动重传规则不符。
- [x] **Step 3: 实现持久状态机。** confirmedIntent→NAS receipt→local step→done；本机模式跳过 NAS。确认前暂停目标下载/整理/上传并等待在途任务退出，再复核原绝对路径及所有权。记录移除使用 Task 4，文件使用既有回收站流程；路径变化时重新准备，不自动跟随新路径。批次 100，支持停止；已提交 NAS 批次保持屏障，本机未执行部分需用户重试。
- [x] **Step 4: 运行绿灯。** 同 Step 2，加 `node --test tests/local-removal.test.mjs`；真实 Windows 回收站只用测试自有文件，验证目标消失及回收站结果，不只看命令退出码。
- [x] **Step 5: 提交。** 显式暂存本任务文件，`git commit --quiet -m "feat: coordinate explicit local and NAS deletion receipts"`。

### Task 6: B 端同步前核对、待处理与三种决策

**Files:** Create `electron/deletion-conflicts.mjs`, `tests/deletion-conflicts.test.mjs`; Modify `electron/backup-client.mjs`, `electron/backup-transport.mjs`, `electron/backup-analysis-worker.mjs`, `electron/backup-covers.mjs`, `electron/backup-previews.mjs`, `electron/work-audio.mjs`, `electron/device-scope-state.mjs`。共享配乐提交与普通/预览上传接入同一 BackupClient 范围检查，不另建旁路。

**Interfaces:** `DeletionConflicts({store,backup,deviceScopes})`；`refresh():Promise<{pending:number,cursor:number}>`、`page(options):object`、`resolve({selection,action:'restore'|'remove-local'|'later'}):Promise<object>`。先处理范围 feed，再 applyChanges/分析上传；`BackupClient.scopeProofs(scopes):Promise<object[]>` 是所有上传唯一取证入口。

- [x] **Step 1: 写失败测试。** A 删账号来源，B 仍有账号＋作者：refresh 后只 hold 账号，本机两来源仍可用；稍后处理/重启不上传、不删除。B restore 只恢复所选且实际拥有的范围；remove-local 不再向 NAS 删除，回收失败不清 pending。`offline or changed library is never a deletion`、`latest restored state supersedes stale delete`、`new delete invalidates an old pending decision`。候选 300 个＋库 30000 条时只检查候选，不扫其他文件。
- [x] **Step 2: 运行红灯。** `node --test tests/deletion-conflicts.test.mjs tests/backup-analysis.test.mjs`。
- [x] **Step 3: 实现核对与恢复。** feed 每页≤100，持久 cursor 与已处理状态；应用远端变更前保存持有快照。索引先筛候选，仅候选状态未知时调用后台文件检查。pending 只阻止涉及范围；其他资料继续。恢复联网取最新 generation/grant，并保护所选现有资产，不从抖音补齐本次恢复；丢失本机文件不得假报上传成功。NAS 已重新恢复的过期事件直接刷新，不跟随旧删；A 的私有 mask 不因此解除。
- [x] **Step 4: 运行绿灯。** 同 Step 2，加 `node --test tests/backup-scope-barrier.test.mjs tests/deletion-coordinator.test.mjs`，覆盖客户端与服务端双重限制。
- [x] **Step 5: 提交。** 显式暂存本任务文件，`git commit --quiet -m "feat: hold remote deletions for explicit cross-device decisions"`。

### Task 7: 删除确认和跨电脑待处理界面

**Files:** Create `src/deletion-ui.jsx`; Modify `electron/main.mjs`, `electron/preload.cjs`, `src/main.jsx`, `src/backup-ui.jsx`, `src/library-ui.jsx`, `tests/workspace-ui.mjs`, `tests/backup-desktop.mjs`。

**Interfaces:** IPC `prepareScopedDeletion(input)`、`confirmScopedDeletion(token)`、`stopScopedDeletion()` 连接 Task 5；`deletionPendingPage(options)`、`resolveDeletionPending(input)` 连接 Task 6。分页20；选择 `{token,all,ids,exclude}` 绑定库/筛选/版本，过期拒绝执行并保留未变项选择。

- [x] **Step 1: 写失败 UI 测试。** 记录入口默认当前来源、文件入口默认文件；确认显示账号收藏含自建关联且其他来源不删、文件共用影响清楚。B 启动集中提示一次，随后顶部与 NAS 页保留入口，能看电脑/时间/内容范围、单选/跨页全选。三种按钮不预选执行，分别显示两端结果；离线 NAS 删除不可操作但本机删除可用。
- [x] **Step 2: 运行红灯。** `npm run test:ui`，预期入口缺失或旧删除范围不能表达。
- [x] **Step 3: 实现界面和 IPC。** 后端重新验证 token 与实际范围，不信任 UI 数量；已有删除入口统一接线，不保留旧危险捷径。进行中的选中范围互斥，详情/分页/停止允许；重启只提示未完成操作，不自动点击重试。不逐条弹窗、不把“稍后”当同意删除。
- [x] **Step 4: 运行绿灯。** `npm run test:ui`、`npm run test:backup-desktop`；用自有 fixture 验证两端部分失败与停止后的结果。
- [x] **Step 5: 提交。** 显式暂存本任务文件，`git commit --quiet -m "feat: expose scoped deletion and cross-device decisions"`。

### Task 8: 独立 NAS 目录、记录/文件分开恢复

**Files:** Create `backup-server/catalogue.mjs`, `electron/nas-catalogue.mjs`, `tests/nas-catalogue.test.mjs`; Modify `backup-server/server.mjs`, `electron/backup-client.mjs`, `src/nas-library.mjs`, `src/nas-ui.jsx`, `src/main.jsx`, `electron/main.mjs`, `electron/preload.cjs`, `tests/nas-library.test.mjs`。

**Interfaces:** GET `/v1/catalogue` 参数 `{tab:'all'|'collection'|'author',query,page,limit:20,content:'all'|'records'|'files'|'incomplete'}`，返回 `{libraryId,revision,total,items}`，每项含真实来源与文件存在性摘要，不依赖本机可见集合。GET `/v1/catalogue/index` 参数 `{after:number,limit:100}` 返回 `{revision,next,hasMore,items}`，为本机目录索引提供首次分批快照及后续增量，包含明确移除的索引项。`NasCatalogue.page(options)` 查询持久目录摘要；`prepareRestore({ids,records,files,sources})`/`restore(token)` 校验最新目录后分范围执行。本机状态过滤从同 revision 的目录摘要与设备索引计算，不能先远端分页再过滤当页。

- [x] **Step 1: 写失败测试。** `records-only backup remains browsable after local hide` 断言总览纳入、显示仅记录、能恢复来源关联且不下载视频。`file restore does not unhide records` 反向独立；`missing remote source is not reconstructed from file home`。关键词/来源/本机移除过滤先于分页，支持全选。无写入租约可浏览/预览；过期目录点击恢复重新验证，不能恢复新删范围。
- [x] **Step 2: 运行红灯。** `node --test tests/nas-catalogue.test.mjs tests/nas-library.test.mjs`，预期现有 assets-only 列表漏记录。
- [x] **Step 3: 实现目录与恢复。** 服务端建 catalogue/source 的事务投影和索引；精确 ID 使用 B-tree，标题/作者建立 SQLite FTS5 trigram 查询与短词 LIKE 回退，避免逐次解析全部 JSON。首次摘要分批≤100 获取到设备专属 SQLite，此后增量更新；索引同步异步且显示进度，不把数万条全部放入内存或 renderer。筛选先于分页，revision 切换原子更新，页 IPC 仍≤20；快照过期重取时保留旧页并提示，不混合库 ID。保留现有三个标签，加入本机已移除/无文件/内容类型筛选。记录恢复来源/收藏夹，已删除来源作为本地历史来源；文件恢复校验 NAS 摘要，不重建缺失记录。预览使用已有受限缓存与按需流读取，不要求全库恢复；只有记录显示没有原媒体。
- [x] **Step 4: 运行绿灯。** 同 Step 2，加 `npm run test:ui`、`npm run test:backup-preview`，验证本机隐藏不影响远端查询、恢复不清其他来源 mask。
- [x] **Step 5: 提交。** 显式暂存本任务文件，`git commit --quiet -m "feat: browse and restore NAS records independently of local visibility"`。

### Task 9: 有界日志、未解决状态保留及故障恢复

**Files:** Modify `backup-server/scope-state.mjs`, `electron/device-scope-state.mjs`, `electron/deletion-coordinator.mjs`, `electron/deletion-conflicts.mjs`; Create `tests/deletion-retention.test.mjs`。

**Interfaces:** `pruneSummaries({now,maxAgeDays=90,maxBytes=50*1024*1024}):object` 只清已完成摘要/过期授权；最新 scope state、未解决 pending、恢复所需最小幂等键不在此预算内。保留幂等键及请求摘要，旧回执正文可压缩；旧 operation 重试返回已完成状态，不能再次删除。

- [x] **Step 1: 写失败测试。** `old unresolved deletion survives summary pruning` 断言 91 天后 pending 与屏障仍在；摘要超 50 MiB 清最旧已完成记录，仍可判断旧 operation 已执行。`interrupted local step never becomes successful by log cleanup`，断言回收失败仍待处理。诊断扫描日志断言无 Cookie、签名 URL、绝对用户路径和原始响应。
- [x] **Step 2: 运行红灯。** `node --test tests/deletion-retention.test.mjs`。
- [x] **Step 3: 实现日志回收。** 日志仅安全字段、每条摘要有长度上限；按时间及已完成摘要总字节限制清理，不碰当前范围状态。客户端重启核对回执只恢复显示与上传屏障，不自动删除；服务端过期未提交上传只在无引用/活动读取时回收。
- [x] **Step 4: 运行绿灯。** 同 Step 2，加 `node --test tests/deletion-conflicts.test.mjs tests/deletion-coordinator.test.mjs`。
- [x] **Step 5: 提交。** 显式暂存本任务文件，`git commit --quiet -m "feat: bound deletion history while retaining unresolved barriers"`。

### Task 10: 双电脑、大库与成对升级验收

**Files:** Create `tests/cross-device-deletion.test.mjs`; Modify `tests/backup-desktop.mjs`, `tests/backup-preview-desktop.mjs`, `backup-server/README.md`, `backup-server/package.json`, `backup-server/compose.yaml`, `package.json`, `package-lock.json`, `CHANGELOG.md`; Create 本次实际 tag 对应的 `docs/releases/backup-v<desktop-version>.md`。

**Interfaces:** 集成 fixture `{server,A,B,objects,requests}` 使用两个独立 profile 和同一隔离 NAS，绝不指向真实服务。已发布协议版本不原地覆写，配套版本在发布前核对下一可用号。

- [x] **Step 1: 写端到端验收。** 逐条覆盖设计第 10 节 13 项，含 A local-only→NAS 查回、A remote delete→B later→重启→B restore、B remove-local、新删除使旧选择失效、账号/作者交叉、共享音频、只有记录、换库/分页失败、旧客户端写入。30000 记录＋300 删除项断言只查询候选文件、界面每页≤20、feed 每页≤100，有事件循环让出且可停止。
- [x] **Step 2: 运行红灯并完成遗漏。** `node --test tests/cross-device-deletion.test.mjs`；必须对真正缺失行为出现失败，修正只落在相应拥有任务，不能通过跳过场景通过。
- [ ] **Step 3: 整体验证。** `node --test --test-concurrency=4 tests/*.test.mjs`、`npm run test:ui`、`npm run test:backup-desktop`、`npm run test:backup-preview`、`npm run build`。构建 NAS 镜像与 Windows 包，执行现有包检查及独立 profile 安装启动；核对打包包含新增 shared/electron 模块及 SHA256。测试数据库升级失败恢复，不把重装/清库当迁移步骤。
- [ ] **Step 4: 完成配套版本说明。** 新 NAS 保留卷/库 ID，旧桌面只能本地用，需配套升级才能写；新桌面连旧 NAS 不展示可执行的新删除功能。上线前 capability 才开启。记录回滚必须使用升级前一致性库副本，不直接让旧服务打开 schema 4。
- [ ] **Step 5: 提交和交付。** 显式暂存本任务文件，`git commit --quiet -m "release: ship paired scoped deletion and recovery support"`。发布 NAS 镜像/桌面安装包及说明；只发布构建产物，不自动部署真实 NAS，不替用户执行删除。实机两电脑验收与隔离集成测试结果分开报告。

## 自审与实施顺序

1→2→3 固定服务端正确性，4→5 建立 A 本机语义，6→7 完成 B 决策与入口，8 提供可找回的 NAS 目录，9→10 验证长期、跨端和发布。各任务的输入输出与范围名称一致；五项 Review Focus 在拥有任务均有断言。与本机计划共享 UI 文件的改动按先本机后 NAS 顺序执行，不同时改同一文件。只有完成全部接线与成对验收才公布新删除功能可用。
