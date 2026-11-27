# 服务版正式入口核对

对应 [0.3.46 基线及逐项验收场景](compatibility.md)。此表记录 0.4.1 任务 13 时的正式落点。Windows 集成测试在实际启动的进程中捕获 IPC 注册，逐项检查下列目标、preload 可调用项、保留的事件和退役动作。该项验证覆盖接线；具体业务结果由来源、资料库、下载、媒体、删除及维护专项分别验证。

标为「迁移彩排」的入口通过 NAS 连接设置中的迁移与还原报告操作。任务 14 负责打包复核、两台真实电脑、远程链路及绿联实际挂载。详见[彩排与外部还原操作](migration-rehearsal.md)。

| 基线入口 | 状态 | 正式处理器 | 对应动作及边界 |
| --- | --- | --- | --- |
| `ui:workspace` | 页面 | `listWorks` `cataloguePosition` | NAS 分页。导航、页码与返回位置由 Windows 维护。 |
| `ui:selection` | 页面 | `resolveSelection` `catalogueAction` | 服务校验来源、筛选、页外选择及版本。 |
| `ui:media` | 页面 | `workDetail` `audioPrepare` `audioRelease` | 原浏览器与音量控件使用会话媒体协议。 |
| `ui:cover-activation` | 页面 | `listWorks` `cataloguePosition` `workDetail` | 原封面、键盘浏览和跨页定位。 |
| `ui:viewer-keys` | 页面 | `listWorks` `cataloguePosition` `workDetail` | 原封面、键盘浏览和跨页定位。 |
| `ui:volume` | 页面 | `workDetail` `audioPrepare` `audioRelease` | 原浏览器与音量控件使用会话媒体协议。 |
| `ui:exclusive-playback` | 页面 | `workDetail` `audioPrepare` `audioRelease` | 原浏览器与音量控件使用会话媒体协议。 |
| `ui:page-jump` | 页面 | `listWorks` `cataloguePosition` | NAS 分页。导航、页码与返回位置由 Windows 维护。 |
| `ui:settings` | 页面 | `serverSession` `storageUsage` `openDiagnostics` | 连接、版本、NAS 占用与 Windows 缓存。 |
| `ui:close` | 替换 | `serverRelease` | 窗口关闭和交接均提示未完成的平铺导出，核对操作回执后释放。NAS 普通队列继续。 |
| `state` | 直连 | `state` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `stateChunk` | 替换 | `state` `listWorks` | 首屏只传会话与摘要，筛选、排序及分页由 NAS 完成。 |
| `startupReady` | 直连 | `startupReady` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `onChange` | 事件 | `state` | 正式主进程发送更新或错误，窗口订阅并在卸载时注销。 |
| `onExitRequested` | 替换 | `serverRelease` | 窗口关闭和交接均提示未完成的平铺导出，核对操作回执后释放。NAS 普通队列继续。 |
| `onNotice` | 事件 | `state` | 正式主进程发送更新或错误，窗口订阅并在卸载时注销。 |
| `filterWorks` | 替换 | `state` `listWorks` | 首屏只传会话与摘要，筛选、排序及分页由 NAS 完成。 |
| `workDetail` | 直连 | `workDetail` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `setTags` | 直连 | `setTags` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `nasCataloguePage` | 替换 | `listWorks` | NAS 媒体库查询 media 来源，刷新重新取页及版本。 |
| `nasCatalogueGroups` | 替换 | `state` `listWorks` | 收藏夹、作者导航列出各自的归属；媒体库按归档过滤。 |
| `refreshNASCatalogue` | 替换 | `listWorks` | NAS 媒体库查询 media 来源，刷新重新取页及版本。 |
| `nasCatalogueWork` | 替换 | `workDetail` | 同一作品的详情直接来自正式库。 |
| `nasCataloguePreview` | 替换 | `workDetail` `audioPrepare` | Windows 自定义协议代理当前会话的 NAS 资源，覆盖图像、视频 Range 和配乐。 |
| `prepareNASRestore` | 迁移彩排 |`flatPrepare` `serverRehearsal` | 预览隔离目标与保护范围。 |
| `confirmNASRestore` | 迁移彩排 |`flatStart` `serverRehearsal` | 批准已核验来源与新目标。 |
| `stopNASCatalogue` | 迁移彩排 |`flatCancel` `listWorks` `serverRehearsal` | 取消在途彩排，已发布目标保留。 |
| `openAccount` | 替换 | `startQrLogin` `finishLogin` | 从设置或账号按钮进入 NAS 官方扫码并核验 UID。第三方工具的私密会话不复制到 NAS。 |
| `startQrLogin` | 直连 | `startQrLogin` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `refreshQrLogin` | 直连 | `refreshQrLogin` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `cancelQrLogin` | 直连 | `cancelQrLogin` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `showQrLoginPage` | 替换 | `sourceLoginView` `sourceManualLogin` `finishLogin` | 沿用当前 NAS 流程的二维码、人工验证和核验账号。 |
| `setQrPageBounds` | 页面 | `sourceLoginView` | 二维码和人工表单在应用文档内布局；独立窗口显示同一次流程。 |
| `showQrExternalPage` | 直连 | `showQrExternalPage` `verificationView` `verificationManual` | 同次 NAS 验证流程的独立 Windows 窗口，限于该验证任务。 |
| `checkQrLogin` | 替换 | `sourceLoginView` `sourceManualLogin` `finishLogin` | 沿用当前 NAS 流程的二维码、人工验证和核验账号。 |
| `finishLogin` | 直连 | `finishLogin` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `logout` | 直连 | `logout` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `confirmLegacyAccount` | 迁移彩排 |`finishLogin` `serverRehearsal` | 对照当前会话、旧库、管理员配置及批准中的账号。 |
| `importLoginConfig` | 替换 | `startQrLogin` `finishLogin` | 从设置或账号按钮进入 NAS 官方扫码并核验 UID。第三方工具的私密会话不复制到 NAS。 |
| `sync` | 直连 | `sync` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `stopSync` | 直连 | `stopSync` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `confirmCollectionRead` | 直连 | `confirmCollectionRead` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `resumeReconcile` | 直连 | `resumeReconcile` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `addCollections` | 直连 | `addCollections` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `importLink` | 直连 | `importLink` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `addAuthor` | 直连 | `addAuthor` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `readAuthor` | 直连 | `readAuthor` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `archiveAuthor` | 直连 | `archiveAuthor` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `refreshWorkCreators` | 直连 | `refreshWorkCreators` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `stopWorkCreators` | 直连 | `stopWorkCreators` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `readHistoryRuns` | 直连 | `readHistoryRuns` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `readHistoryItems` | 直连 | `readHistoryItems` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `clearReadHistory` | 直连 | `clearReadHistory` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `openOriginal` | 直连 | `openOriginal` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `downloadPage` | 直连 | `downloadPage` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `previewDownloads` | 直连 | `previewDownloads` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `validateDownloadSelection` | 直连 | `validateDownloadSelection` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `download` | 直连 | `download` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `pause` | 直连 | `pause` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `resume` | 直连 | `resume` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `cancelDownloads` | 直连 | `cancelDownloads` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `retryDownloads` | 直连 | `retryDownloads` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `setDownloadConcurrency` | 直连 | `setDownloadConcurrency` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `clearCompleted` | 直连 | `clearCompleted` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `repairVideoCover` | 直连 | `repairVideoCover` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `reportCoverStatus` | 直连 | `reportCoverStatus` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `flatPrepare` | 直连 | `flatPrepare` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `flatStart` | 直连 | `flatStart` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `flatPause` | 直连 | `flatPause` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `flatResume` | 直连 | `flatResume` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `flatRetry` | 直连 | `flatRetry` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `flatCancel` | 直连 | `flatCancel` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `flatClear` | 直连 | `flatClear` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `flatOpen` | 直连 | `flatOpen` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `audioPage` | 直连 | `audioPage` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `audioStatus` | 直连 | `audioStatus` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `audioPrepare` | 直连 | `audioPrepare` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `audioRelease` | 直连 | `audioRelease` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `audioRenew` | 直连 | `audioRenew` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `audioRefresh` | 直连 | `audioRefresh` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `audioSave` | 直连 | `audioSave` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `audioPause` | 直连 | `audioPause` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `audioResume` | 直连 | `audioResume` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `audioCancel` | 直连 | `audioCancel` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `audioRemove` | 替换 | `previewRemoval` `confirmRemoval` | 从作品配乐预览仅 audio 资源，沿用已验证回收站、批准及恢复回执。 |
| `app-media` | 替换 | `workDetail` `audioPrepare` | Windows 自定义协议代理当前会话的 NAS 资源，覆盖图像、视频 Range 和配乐。 |
| `cacheSettings` | 直连 | `cacheSettings` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `cacheClear` | 直连 | `cacheClear` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `cacheStop` | 直连 | `cacheStop` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `pickerLocations` | 直连 | `pickerLocations` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `listDirectory` | 直连 | `listDirectory` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `makeDirectory` | 直连 | `makeDirectory` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `chooseRoot` | 移除 | `flatPrepare` `flatOpen` `openCache` `openDiagnostics` | 普通下载落 NAS，已移除普通本机归档根设置和打开动作。本机保留平铺导出、缓存和诊断目录。 |
| `openRoot` | 移除 | `flatPrepare` `flatOpen` `openCache` `openDiagnostics` | 普通下载落 NAS，已移除普通本机归档根设置和打开动作。本机保留平铺导出、缓存和诊断目录。 |
| `openFolder` | 移除 | `flatPrepare` `flatOpen` `openCache` `openDiagnostics` | 普通下载落 NAS，已移除普通本机归档根设置和打开动作。本机保留平铺导出、缓存和诊断目录。 |
| `refreshFiles` | 同类入口 | `inspectDefects` `stopDefectRepair` `defectPage` `startDefectRepair` | 同一个版本化检查、分页及确认作业。停止扫描只停止未处理项。 |
| `cancelFileCheck` | 同类入口 | `inspectDefects` `stopDefectRepair` `defectPage` `startDefectRepair` | 同一个版本化检查、分页及确认作业。停止扫描只停止未处理项。 |
| `refreshStorageSize` | 直连 | `refreshStorageSize` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `cancelStorageSize` | 直连 | `cancelStorageSize` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `checkRepairs` | 同类入口 | `inspectDefects` `stopDefectRepair` `defectPage` `startDefectRepair` | 同一个版本化检查、分页及确认作业。停止扫描只停止未处理项。 |
| `cancelRepairs` | 同类入口 | `inspectDefects` `stopDefectRepair` `defectPage` `startDefectRepair` | 同一个版本化检查、分页及确认作业。停止扫描只停止未处理项。 |
| `repairPage` | 同类入口 | `inspectDefects` `stopDefectRepair` `defectPage` `startDefectRepair` | 同一个版本化检查、分页及确认作业。停止扫描只停止未处理项。 |
| `startRepairs` | 同类入口 | `inspectDefects` `stopDefectRepair` `defectPage` `startDefectRepair` | 同一个版本化检查、分页及确认作业。停止扫描只停止未处理项。 |
| `defectOverview` | 直连 | `defectOverview` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `inspectDefects` | 直连 | `inspectDefects` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `defectPage` | 直连 | `defectPage` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `validateDefectSelection` | 直连 | `validateDefectSelection` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `startDefectRepair` | 直连 | `startDefectRepair` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `resumeDefectRepair` | 直连 | `resumeDefectRepair` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `stopDefectRepair` | 直连 | `stopDefectRepair` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `checkSource` | 直连 | `checkSource` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `verifySources` | 直连 | `verifySources` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `markSourceUnavailable` | 直连 | `markSourceUnavailable` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `openDiagnostics` | 直连 | `openDiagnostics` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `exportWorkDiagnostic` | 直连 | `exportWorkDiagnostic` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `prepareScopedDeletion` | 替换 | `previewRemoval` | 预览正式库的选区与版本。记录、文件与单个来源归属分别确认。 |
| `prepareCatalogueDeletion` | 替换 | `previewRemoval` | 预览正式库的选区与版本。记录、文件与单个来源归属分别确认。 |
| `confirmScopedDeletion` | 替换 | `confirmRemoval` | 用对应预览令牌确认。 |
| `cancelPreparedDeletion` | 替换 | `controlRemoval` | 预览关闭时作废令牌，再次提交遭拒。 |
| `stopScopedDeletion` | 替换 | `controlRemoval` | 按同一回执停止或重试，在当前文件边界结算。 |
| `retryScopedDeletion` | 替换 | `controlRemoval` | 按同一回执停止或重试，在当前文件边界结算。 |
| `deletionPendingPage` | 替换 | `removalHistory` `removalStatus` | 从两台设备查询同一正式库的分页记录与冲突。 |
| `validateDeletionSelection` | 替换 | `previewRemoval` | 预览正式库的选区与版本。记录、文件与单个来源归属分别确认。 |
| `refreshDeletionPending` | 替换 | `removalHistory` `removalStatus` | 从两台设备查询同一正式库的分页记录与冲突。 |
| `resolveDeletionPending` | 替换 | `previewRestore` `restoreRemoval` `controlRemoval` | 预览并核对恢复。无法确认移位、原位置冲突或回收保护的项目保留供处理。 |
| `stopDeletionResolution` | 替换 | `controlRemoval` | 按同一回执停止或重试，在当前文件边界结算。 |
| `cancelLocalRemoval` | 移除 | `cacheStop` | 取消作品级仅本机移除，设置里的清理可按缓存对象停止。 |
| `prepareNASRemoval` | 移除 | `previewRemoval` `confirmRemoval` `controlRemoval` | 旧直删 IPC 不提供；正式预览、范围确认及回执入口独立。 |
| `confirmNASRemoval` | 移除 | `previewRemoval` `confirmRemoval` `controlRemoval` | 旧直删 IPC 不提供；正式预览、范围确认及回执入口独立。 |
| `cancelNASRemoval` | 移除 | `previewRemoval` `confirmRemoval` `controlRemoval` | 旧直删 IPC 不提供；正式预览、范围确认及回执入口独立。 |
| `resumeNASRemoval` | 移除 | `previewRemoval` `confirmRemoval` `controlRemoval` | 旧直删 IPC 不提供；正式预览、范围确认及回执入口独立。 |
| `prepareDelete` | 移除 | `previewRemoval` `confirmRemoval` `controlRemoval` | 旧直删 IPC 不提供；正式预览、范围确认及回执入口独立。 |
| `confirmDelete` | 移除 | `previewRemoval` `confirmRemoval` `controlRemoval` | 旧直删 IPC 不提供；正式预览、范围确认及回执入口独立。 |
| `configureBackup` | 替换 | `serverConnect` | 连接页保存证书指纹、NAS 地址与设备凭据。 |
| `checkBackup` | 替换 | `serverSession` `serverReceipt` | 连接页检查所连库与使用权，设置可查询指定操作回执。 |
| `syncBackup` | 替换 | `serverRelease` `serverReceipt` | 换机先核对已发送操作并释放，接手端访问同一 NAS 库。 |
| `cancelBackup` | 直连 | `cancelBackup` | 经正式 Windows 主进程注册，原动作及验证场景见基线表。 |
| `finishBackupExit` | 替换 | `serverRelease` | 窗口关闭和交接均提示未完成的平铺导出，核对操作回执后释放。NAS 普通队列继续。 |
| `acceptRemoteBackup` | 迁移彩排 |`serverConnect` `serverRehearsal` | 日常重连读取正式库，历史资料独立预演。 |
| `openBackupRecovery` | 迁移彩排 | `serverRehearsal` | 查看历史副本候选、独立恢复点与校验结果。 |
| `previewExistingLibrary` | 迁移彩排 | `serverRehearsal` | 查看旧来源差异及所需空间。 |
| `importExistingLibrary` | 迁移彩排 | `serverRehearsal` | 明确确认后发布独立目标与快照。 |
