# 0.3.36 / NAS 0.2.4 验收记录

这是自动化隔离验收，不代替遵义/重庆实机。原 0.3.35 与 NAS 0.2.3 保持不变，新版本完成审查与构建后单独发布。

## 十三项验收映射

| 项 | 行为 | 主要证据 |
|---|---|---|
| 1 | 本机作者移除不影响账号/NAS，不自动补回 | cross-device acceptance 1，device-scope-state |
| 2 | 本机删文件后 NAS 可预览及单项恢复 | cross-device acceptance 2，nas-catalogue |
| 3 | 仅记录查回不报有原媒体 | cross-device acceptance 3，native NAS 目录 |
| 4 | A 删当前来源，B 持有，另一来源可用 | cross-device acceptance 4 |
| 5 | NAS 删文件，B 未选择不删/不回传 | cross-device acceptance 5 and 8 |
| 6 | B 恢复对应范围，A 私有移除不清 | cross-device acceptance 6 |
| 7 | 回收失败保留、共享对象保留 | cross-device acceptance 7/shared audio，work-audio |
| 8 | 稍后、实际 profile 重启、91 天保留 | cross-device acceptance 5 and 8，deletion-retention |
| 9 | 竞态、旧回执/选择、再次删除 | cross-device acceptance 9，scope-barrier / retention |
| 10 | 旧客户端、封面/音频/记录不能绕过 | cross-device acceptance 10，scope-barrier/work-audio |
| 11 | 离线、换库、破损分页不删本机 | cross-device acceptance 11，catalogue 原目录保留 |
| 12 | 三万/三百候选、100 feed/20 页、可停止 | deletion-candidate-performance、nas-catalogue-performance、native停止 |
| 13 | 迁移失败保留原库/ID、无自动破坏性重试 | backup-scopes、deletion-coordinator |

主要文件均位于 tests，文件名后缀 .test.mjs；跨端主文件是 cross-device-deletion.test.mjs。A、B 独立 profile 与临时媒体，重启项实际关闭并重开 B 数据库。真实回收站验收只用自建样本，没有清理用户回收站或真实 NAS。

## 资源、恢复和证据

- 三万条目录单页约 12 KiB、最多 20 项，feed 最多 100 项，未变化不重建；删除只检查候选文件。
- 42 分钟由受控时钟推进，执行真实范围校验、续期、分块上下文与提交，不让实机空转 42 分钟。
- 90 天/50 MiB 正文清理保留最新屏障、未解决项与最小幂等凭据。原命令/内容改变会拒绝，旧操作不重复执行。
- 过期片段核对引用、活动上传/读取和有效授权，删除前再次检查；闲置回收不解析所有作品 JSON。
- 图片/音频实际解码与布局几何不跳过。宿主偶发 UnknownVizError 时单独记录截图失败，不把旧截图当新视觉证据。

最终完整测试、Windows 包运行文件/隔离启动、NAS 镜像健康检查和独立审查在完成后补记。当前不自动部署真实容器，不替用户执行删除。

## 当前候选验证

- 当前完整单元/集成回归：594/594，测试并发为 2。此前并发 4 曾出现 Windows 原生 Node 异常，CI 和发布门槛统一为 2。
- 双电脑主场景 12 项通过；真实改动冲突继续保护，修复的是旧 dirty 缓存导致的零差异误报。
- 界面 165 项、桌面 76 项、实际预览/音乐 31 项，以及 NAS/配乐浏览/读取日志/问题检查/媒体跳转五套布局检查通过。
- Windows 安装包和便携包已本机构建；ASAR 的 92 个运行文件与被测源码一致，真实可执行文件以独立空 profile 启动，版本/packaged/preload 均正确。
- NAS 0.2.4 镜像将在 Linux CI 构建并检查协议 3 健康状态；本机无 Docker，不用未验证的 tar 代替。
- 最终独立审查、镜像、发布和 SHA256 结果尚待补记。测试与构建过程没有更新真实 NAS 或删除真实资料。
