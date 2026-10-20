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

完整测试、Windows 包运行文件/隔离启动、NAS 镜像健康检查和独立审查见下。未部署真实容器，未替用户执行删除。

## 最终验证

测试运行源码：26f30836ecf6ff05f06e4efb3b0b4b611467e407。其后只更新验收与发布文档，不修改运行文件。

- 完整 Node 回归 **598/598**，并发 2，284295 ms；零失败、跳过、取消。旧并发 4 在本机曾遇原生 Node 异常，发布与 CI 统一为 2。
- UI **165/165**；源码/打包程序桌面 **76/76**；真实图片、视频与配乐预览 **31/31**；NAS、配乐、读取日志、检查与补齐、媒体跳转五套布局全部通过。
- Windows Setup 和便携包已构建；ASAR **92 个运行文件**与源码一致。两个分发包均实际解出自带程序，以独立空 profile 启动，确认 0.3.36、packaged、preload；未执行注册表安装/卸载。
- NAS 镜像在 [Linux CI](https://github.com/wjh183322/CangXia/actions/runs/39511419516) 构建并通过镜像内关联回归、协议 3 健康检查。下载 tar SHA256 核对一致、镜像标签 cangxia-backup-server:0.2.4，**23 个服务运行文件**逐字节与源码核对一致。
- 同一 CI 的 Windows 全流程尚在运行；本机 Windows 完整测试、五布局、构建和实际载荷启动均已完成。不能把 Linux 作业通过说成整个 CI 已通过。
- 唯一独立审查发现三项 Important；父执行器分别复现 RED 后完成单轮修复：更换后的配乐不被旧重试删除，发起端逐项核对远端新版本，旧隐藏账号记录显式恢复后可见。另验证合法配乐重试、作者恢复不解除账号移除；四项专项与全套 598 均通过。[审查报告](2026-10-21-nas-final-review.md)。没有遗留 Critical/Important/Minor。

| 文件 | SHA256 |
|---|---|
| CangXia-Backup-0.3.36-Setup-x64.exe | 44300ef6d7e2c8d02d6f34d62721a5247501500ba4e7d6943c5d68aa42bc100a |
| CangXia-Backup-0.3.36-Windows-x64.exe | 34b9133af7b90b1d435238dd48a069c1b6dd78bb92443a18a406c1086dae6982 |
| CangXia-Backup-Server-0.2.4.tar | 7cc880ad49a0bd02b7e4f12ff91cd406cca352c676406f2fa8bbe2a022b13572 |
| Windows app.asar | 2cf0d32db27c105ed594650927b8a238fa1e48a1f9483dee8ef6b62f4397c945 |

真实遵义/重庆双电脑、真实 NAS 升级和用户回收站仍属安装后实机验收；以上均使用隔离数据库、独立 profile 和自有临时文件。不自动清缓存、不重置资料库、不部署真实容器。
