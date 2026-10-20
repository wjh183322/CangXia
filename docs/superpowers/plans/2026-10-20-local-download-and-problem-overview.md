# 本机下载确认、问题总览与详情入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复已保存文件反复确认失败，持久保留问题总览，提供手动检查、标题详情及本机大小排序。

**Architecture:** 保留现有下载队列、文件检查 worker 与轻量索引，新增单作品确认器和 SQLite 问题投影。问题总览与单轮任务独立，详情使用本地精确 ID，排序沿用索引过滤链；本阶段无需 NAS 升级。

**Tech Stack:** Electron 44、React 19、Node ESM、node:sqlite / sql.js、node:test、现有 DOM 与桌面验收脚本；不新增依赖。

**Spec:** [已确认方案](../../research/2026-10-20-download-repair-and-unfavorite.md)。状态：用户已批准按本会话执行；任务进度以执行记录及提交为准。

## Global Constraints

- 平台可访问只说明取得相应详情和资源，文件成功需要经过本机确认。
- 已下载字节和正确文件保留。检查、停止、重试不会把原有文件清空。
- 重开、重启、切标签和新建任务不会清空总览。
- 面板打开只读取保存的总览与最近任务摘要，不进行磁盘全量扫描或平台核验。
- 普通下载管理的活动任务以及检查面板的标题都按精确作品 ID 打开本地作品详情。
- 默认仍为收藏顺序，先筛选再排序再分页，相同大小按原顺序稳定排列，未知大小置后并标识。
- 取消抖音收藏仅研究；不实施账号写入。NAS 删除另计划实施，不阻塞本阶段交付。
- 实验只用隔离合成库；上传文件只读，不把真实标题、作者、路径、签名链接写入提交的测试样本。

## Review Focus

1. 文件已落地但资产未登记：不按同名认领、不覆盖旧文件、不假报成功（任务 1、2）。
2. 确认期间目录、清单或文件被改变：旧证据不能提交完成状态（任务 1）。
3. 只核验 74 条、补齐 9 条、停止或重启：其余 204 条问题仍能查询（任务 4、5）。
4. 查看活动任务详情再返回：下载继续，筛选、页码、滚动与选择不丢失（任务 6）。
5. 数万条数据排序与跨页全选：索引顺序不能被前端 Set 还原为原顺序，不能触发全库文件检查（任务 7、8）。

---

## 文件与接口边界

新增 `electron/download-confirmation.mjs` 负责单作品证据确认，`electron/work-diagnostic.mjs` 负责脱敏单作品导出，`electron/problem-registry.mjs` 负责持久问题投影，`src/stored-detail-navigation.mjs` 负责面板返回状态。现有队列、检查 worker、Store 主数据库结构和作者读取流程不做无关重构。

下文类型为接口约定，使用 JSDoc 定义，不引入 TypeScript：`WorkId=string`；`ConfirmResult={ok:boolean,code:string,issues:Array<{key:string,code:string}>,changed:boolean}`；`ProblemPatch={id:WorkId,file?:object,source?:object,task?:object,checkedAt:string}`。未提供的维度保持原值；显式确认正常才清除对应维度。错误摘要不保存完整响应或签名 URL。

### Task 1: 单作品确认，消除 partial 清单循环

**Files:** Create `electron/download-confirmation.mjs`; Modify `electron/downloads.mjs`, `electron/file-states.mjs`; Test `tests/download-confirmation.test.mjs`, `tests/file-states.test.mjs`。

**Interfaces:** 新增 `confirmDownload(store,id,{signal}={}):Promise<ConfirmResult>`；保留 `FileStates.confirmWritten(id):Promise<boolean>` 兼容现有调用。确认器核对必需 key、边界、文件类型及大小，并在提交前复核清单原始内容与文件身份；队列使用详细结果输出原因。

- [x] **Step 1: 写失败测试。** 创建隔离 fixture 工厂，返回 `{store,queue,files,networkCalls,changeDuringCheck}`；fixture 必须登记视频、封面、元数据。测试 `partial record with complete registered files is promoted without download` 断言 `result.ok===true`、`store.download(id).state==='complete'`、`networkCalls===0`、三文件哈希不变；测试 `missing required video never passes` 断言 `ok===false`、`issues` 含 video；测试 `changed record or symlink is not confirmed` 断言不提交 complete；测试 `zero-byte metadata part does not invalidate valid final files` 断言最终文件正常即通过。
- [x] **Step 2: 运行红灯。** `node --test tests/download-confirmation.test.mjs`；预期新模块缺失或 partial 状态断言失败，不接受环境错误作为功能红灯。
- [x] **Step 3: 实现确认器。** 复用检查规则，在后台对单作品检查；所有必需资产通过后，用原记录比较后原子提升状态并写文件缓存。确认时变化最多重试 1 次，仍变化返回 `RECORD_CHANGED`；停止返回 `CANCELLED`。目录未知、缺失、大小不符、链接、未登记分别返回不同 code，不能仅检查已列出的 assets。不得在 Electron 主线程同步遍历所有作品。
- [x] **Step 4: 运行绿灯。** `node --test tests/download-confirmation.test.mjs tests/file-states.test.mjs tests/download-source.test.mjs tests/download-concurrency.test.mjs`；预期全部通过，原文件保留，NAS 显式恢复及已失效任务退队逻辑保持正确。
- [x] **Step 5: 提交。** 仅暂存本任务上述 5 个文件，`git commit --quiet -m "fix: reconcile verified download records without redownloading"`。

### Task 2: 处理未登记文件并提供小范围诊断

**Files:** Create `electron/work-diagnostic.mjs`, `tests/work-diagnostic.test.mjs`; Modify `electron/downloads.mjs`, `electron/main.mjs`, `electron/preload.cjs`, `src/defect-repair-ui.jsx`, `tests/download-confirmation.test.mjs`。

**Interfaces:** `buildWorkDiagnostic(store,id):Promise<object>` 返回 schemaVersion、workId、下载 state、必需 key、登记资产的脱敏文件名/大小/当前状态、源状态与小量错误摘要，不包含绝对路径、Cookie、URL、整库内容；IPC `exportWorkDiagnostic(id):Promise<{cancelled:boolean}>` 用保存对话框落盘。它不修复或重扫其他作品。

- [x] **Step 1: 写失败测试。** `cover-only metadata does not prove existing video identity` 使用匿名同结构样本，视频存在但记录仅 cover；断言不能直接完成。`unregistered existing video survives repair` 断言现有视频哈希不变，缺项通过新临时文件下载验证后登记到不同安全 basename，第二次重试不再下载。`diagnostic exports only selected work` 断言仅所选 ID、无其他作品、无绝对路径/签名参数，输出不超过 128 KiB。
- [x] **Step 2: 运行红灯。** `node --test tests/work-diagnostic.test.mjs tests/download-confirmation.test.mjs`，预期导出接口或未登记文件保护失败。
- [x] **Step 3: 实现安全补缺与导出。** 优先已有可信下载记录/校验摘要；没有身份依据时不按文件名复用。刷新该作品合法详情，仅下载缺少资产到唯一临时位置，验证后登记新文件，保留未登记旧文件并说明。元数据以当前清单重新生成并原子替换；残留 `.part` 不作为丢失证据。导出按资产最多 256 条、每条摘要 256 字符截断，注明截断；未知/离线区别于文件缺失。导出属于只读 IPC，检查和下载期间可用。
- [x] **Step 4: 运行绿灯。** 同 Step 2，并用 fixture 视频＋旧 JSON＋0 KB part 重试两次，确认只有首次补缺请求；导出不修改 fixture。
- [x] **Step 5: 提交。** 显式暂存本任务文件，`git commit --quiet -m "fix: preserve unregistered media and export focused diagnostics"`。

### Task 3: 补充已知空文字过滤原因识别

**Files:** Modify `shared/source-state.mjs`, `tests/source-status.test.mjs`。

**Interfaces:** 沿用 `filteredSourceState(data,id)` 的原返回形状；只扩展已提供的 `status_audit_self_see`，不把 status_code 0 本身当失效。

- [x] **Step 1: 写失败测试。** `audit self-see with matching ID and empty explanation is unavailable` 使用用户提供的匿名化响应结构，断言 unavailable、原因等于“原作品当前不可访问，平台未提供具体原因”。分别测试 ID 不符、未知 reason、非 0 code、登录/验证/限流提示仍不能确认 unavailable；有效目标 detail 优先，不被空过滤信息覆盖。
- [x] **Step 2: 运行红灯。** `node --test tests/source-status.test.mjs`，预期已知审查原因案例失败。
- [x] **Step 3: 实现精确分支。** 成功响应、明确空 detail、匹配字符串 ID、精确已知 reason、无账号/验证/限流证据才判当前不可访问；不宣称作品已删除或具体审核原因，其他代码维持保守判断。
- [x] **Step 4: 运行绿灯。** 同 Step 2，保留现有 `status_self_see` 与普通空响应回归。
- [x] **Step 5: 提交。** `git add shared/source-state.mjs tests/source-status.test.mjs`；`git commit --quiet -m "fix: recognize the verified audit self-see response"`。

### Task 4: 持久问题总览，与单轮任务分开

**Files:** Create `electron/problem-registry.mjs`, `tests/problem-registry.test.mjs`; Modify `electron/defect-repair.mjs`, `tests/defect-repair.test.mjs`。

**Interfaces:** `ProblemRegistry(db)` 使用现有 defect-repair.sqlite，建立独立 problems 表；`patchMany(patches:ProblemPatch[]):void` 事务按维度合并；`page({page=1,limit=20,fileStatus='all',sourceStatus='all',kind='all'}):object`；`selection(options):{token:string,total:number}`。`DefectRepair.overview():object` 只读摘要；`page({view:'problems'|'results',...})` 继续支持现有分页。

- [x] **Step 1: 写失败测试。** `selected verification preserves unrelated unavailable works across restart` 建立 204 失效＋74 失败，核验 74 后断言 overview 仍含 204；`repair nine updates only nine` 断言其他问题不变；`unprocessed cancellation preserves old facts` 断言停止未处理项保持旧状态；`available and failed are independent filters` 断言同一 ID 能同时匹配两个维度、总数按 ID 去重；`log pruning keeps unresolved problems` 断言任务日志清理后总览不丢。
- [x] **Step 2: 运行红灯。** `node --test tests/problem-registry.test.mjs tests/defect-repair.test.mjs`，预期缺少持久投影或旧单轮覆盖断言失败。
- [x] **Step 3: 实现持久投影。** 迁移时只从已有下载任务/源状态/保存的检查结果建索引，不触发文件扫描；无证据的旧问题标注待检查。核验只 patch source，文件检查只 patch file，队列结束 patch task，且不受当前 job 归属限制；分别比较源核验时间、文件清单签名、任务 ID，旧事件不得覆盖对应维度的新事实。索引覆盖状态、问题类别、作品 ID；按收藏顺序从新到旧，其他来源用现有读取顺序。全选快照绑定筛选与版本，变化时拒绝扩大范围；resolved 可压缩，未解决项不受日志保留期影响。
- [x] **Step 4: 运行绿灯。** 同 Step 2，确认旧任务数据库能重开，分页默认 20、只序列化当页，取消未处理项不消失。
- [x] **Step 5: 提交。** 显式暂存上述文件，`git commit --quiet -m "feat: persist the problem overview independently of repair jobs"`。

### Task 5: 手动检查入口与独立筛选

**Files:** Modify `electron/main.mjs`, `electron/preload.cjs`, `src/main.jsx`, `src/defect-repair-ui.jsx`, `src/defect-repair.css`, `tests/workspace-ui.mjs`, `tests/source-status-ui-checks.mjs`。

**Interfaces:** IPC `defectOverview():Promise<object>` 读取 Task 4 总览；`inspectDefects({ids?:string[]}={}):Promise<object>` 是手动扫描；不传 ids 表示全部。旧 `defectPage` 增加 fileStatus/sourceStatus；UI 显示“问题总览”“本轮结果”。

- [x] **Step 1: 写失败 UI 用例。** 打开面板断言 overview 1 次、inspectDefects 0 次；点击“检查全部”才扫描。任务开始不切换标签、不重置筛选；核验 74 条后在总览仍能筛选 204 失效项，本轮结果明确只含 74。重开默认总览；首次无已保存结果说明需手动检查。后台监测只更新涉及项，不增加全扫描。
- [x] **Step 2: 运行红灯。** `npm run test:ui`，预期打开即扫描或任务强制跳标签断言失败。
- [x] **Step 3: 实现入口与 UI。** 用总览替换打开即 inspectDefects；保留已有周期文件监测。增加“检查全部”“检查选中”“核验原作品状态”，源状态与文件/处理状态各自筛选，说明分类数量可重叠。总览/分页只读 IPC 加入后台任务允许列表；手动写入操作仍按现有互斥规则。显示本轮 completed/total，不混入历史统计。
- [x] **Step 4: 运行绿灯。** `npm run test:ui` 与 `node --test tests/defect-repair.test.mjs tests/problem-registry.test.mjs`，预期全部通过。
- [x] **Step 5: 提交。** 显式暂存本任务文件，`git commit --quiet -m "feat: open saved problems without starting a full scan"`。

### Task 6: 活动下载及检查标题打开本地详情，返回原位置

**Files:** Create `src/stored-detail-navigation.mjs`; Modify `src/main.jsx`, `src/library-ui.jsx`, `src/defect-repair-ui.jsx`, `tests/workspace-ui.mjs`, `tests/source-status-desktop-checks.mjs`。

**Interfaces:** `capturePanelReturn({panel,tab,page,filters,selection,scrollTop}):object` 为纯快照；main 持有返回状态，`openStoredDetail(id,{returnTo}={})` 成功后打开本地详情，关闭后恢复原面板。不通过标题搜索，不恢复已经无效的选择。

- [x] **Step 1: 写失败用例。** downloading/waiting/failed/unavailable 标题均可键盘/点击打开精确 ID；详情失败仍停原面板。下载继续、collector 请求次数不增加；返回保持 tab、页码、筛选、滚动和仍有效选择。检查面板两标签同样可用，外链仍单独打开抖音。任务变化使所选项失效时提示且不选择替代项。
- [x] **Step 2: 运行红灯。** `npm run test:ui`，预期活动标题不可点击或返回状态丢失。
- [x] **Step 3: 实现导航。** 标题使用 button 并有可访问标签；提升需要跨 modal 保存的状态或保持组件挂载，使用精确 ID 调用 workDetail。它允许选中作品的本机文件检查，不新增源状态核验、暂停下载或作者刷新；返回只恢复界面状态。
- [x] **Step 4: 运行绿灯。** `npm run test:ui`、`npm run test:backup-desktop`，预期导航与队列并行验收通过。
- [x] **Step 5: 提交。** 显式暂存本任务文件，`git commit --quiet -m "feat: open local work details from download and repair titles"`。

### Task 7: 本地媒体库索引大小排序

**Files:** Modify `electron/search-index.mjs`, `electron/work-views.mjs`, `src/main.jsx`, `src/library-ui.jsx`, `tests/search-index.test.mjs`, `tests/workspace-ui.mjs`。

**Interfaces:** `SearchIndex.query(ids,options)` 新增 `sort:'original'|'size-desc'|'size-asc'`，返回有序 ID 数组；缓存 `localBytes` 与 `sizeKnown`。IPC filterWorks 保持 `{ids:string[]}`；前端保留数组顺序，不再仅用 Set 过滤 source。

- [x] **Step 1: 写失败测试。** 输入大小 `[10,未知,30,10]`，升序结果 `[第一10,第二10,30,未知]`，降序 `[30,第一10,第二10,未知]`；作者筛选先于排序，页码/详情位置/全选顺序一致；文件状态变化触发重排。断言排序没有文件系统访问，共享配乐不重复计入可释放空间，浏览缓存不计入正式大小。
- [x] **Step 2: 运行红灯。** `node --test tests/search-index.test.mjs` 与 `npm run test:ui`，预期新排序断言失败。
- [x] **Step 3: 实现索引排序。** 只在本地媒体库显示三种选项；默认 original，稳定 tie 使用输入 rank，未知放末尾。使用已有文件状态/资产字节缓存，索引变化使排序缓存失效；采用分批可让出事件循环的稳定排序，禁止比较器读文件。没有其他筛选但选了大小排序时也使用索引；过期请求不能覆盖新排序。
- [x] **Step 4: 运行绿灯。** 同 Step 2，确认普通收藏列表读取顺序没有改写。
- [x] **Step 5: 提交。** 显式暂存本任务文件，`git commit --quiet -m "feat: sort local media by indexed file size"`。

### Task 8: 大库、真实诊断边界与本机版本交付

**Files:** Create `tests/local-library-responsiveness.test.mjs` 及本次实际 tag 对应的 `docs/releases/backup-v<desktop-version>.md`; Modify `tests/backup-desktop.mjs`, `tests/backup-preview-desktop.mjs`, `package.json`, `package-lock.json`, `CHANGELOG.md`（使用当前已有发布记录格式）；打包沿用现有 scripts。

**Interfaces:** 隔离 30000 记录、1000 问题 fixture；交付沿用当前桌面版本后下一可用 patch，不修改 NAS 服务版本。

- [x] **Step 1: 写验收失败用例。** `overview and sort remain bounded for 30000 works` 断言单页≤20、IPC 无完整资产列表、零全盘扫描；计数器证明处理间有事件循环让出，停止后不启动后续批次。重启后总览与未完成任务保留；合成完整视频＋partial 状态重复重试无网络。未登记视频路径按 Task 2 验证保留旧文件。
- [x] **Step 2: 运行验收。** `node --test tests/local-library-responsiveness.test.mjs`；先确认新增断言确实覆盖遗漏，再完成仅必要修正。
- [x] **Step 3: 运行交付检查。** `node --test --test-concurrency=4 tests/*.test.mjs`、`npm run test:ui`、`npm run test:backup-desktop`、`npm run test:backup-preview`、`npm run build`。只在全部通过后运行现有打包流程，核对 ASAR 所含新模块及安装包 SHA256。合成验收与遵义实机验收分开报告，不能用前者宣布所有 9 条真实作品均已修复。
- [x] **Step 4: 更新版本与说明并提交。** 版本只在准备发布时分配；记录两种确认路径、手动检查、问题总览、详情返回、大小排序及审查原因识别。显式暂存本任务文件，`git commit --quiet -m "release: ship local download and problem overview improvements"`。发布用已验证渠道，不覆盖已有发布 tag；不要提交诊断导出或用户素材。

## 自审与交付顺序

任务 1→2 解决确认循环并补真实样本诊断；3 为独立已知状态修正；4→5 建立总览；6、7 可各自测试，最终由 8 整体验收。五项 Review Focus 均有明确用例，所有新接口在拥有任务定义。NAS、删除与取消收藏均不会被本阶段隐式执行。计划审阅及执行方式选择完成后才进入产品代码修改。
