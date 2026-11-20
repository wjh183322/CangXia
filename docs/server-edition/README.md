# 藏匣服务版 CangXia Server

当前分支：`codex/server-edition`。

开发期版本约定：`0.4.0-alpha.1`。这是开发目标，不代表已发布或已完成的程序。

## 基线与定位

从藏匣备份版 `0.3.46` 的提交 `08e6436522a3828211e9c32b51f90d7d830b4fa8` 创建。本版本区别于既有 `codex/nas` 上的藏匣NAS版 `0.2.1`，也不以更早的默认 main 作为业务基线。

目标是 NAS 负责采集、唯一正式资料库、媒体和持久下载，Windows 负责原有操作界面与可清理缓存。任意电脑建立会话后只采用 NAS 当前状态与进度；存在其他有效使用会话时禁止进入，不跨会话补交旧电脑的数据。

## 成品兼容原则

除已确认的架构差异和缺陷修复外，正式成品的界面、操作习惯与业务逻辑按当前备份版对齐，保留读取顺序、筛选排序、字段、归属、目录整理、下载补齐、单图与可靠高清匹配、图文视频和配乐等能力。测试控台可以简化，不作为正式界面交付，不以重构为由取消原有功能。

## 验证和交付

先准备独立可行性验证原型，在隔离数据与指定样本上验证真实 NAS 的登录、来源字段、完整页事务、独占、异常恢复、下载和性能。验证结果决定是否进入正式产品实施；未测项目不记为通过，不直接迁移正式资料。

NAS 部署采用完整预构建镜像，从镜像库拉取并通过一个应用项目启动，不要求用户复制源码、安装依赖或构建镜像。

GitHub Actions 在 `codex/server-edition` 上构建并检查 Linux amd64 试验镜像，预留 GHCR 包名 `ghcr.io/wjh183322/cangxia-server-probe`。标签绑定版本和提交，部署绑定经核对的镜像 digest。构建工作流只在临时 runner 加载镜像、运行合成测试并记录脱敏结果。镜像发布、包可见性和拉取权限单独确认。正式镜像名预留为 `ghcr.io/wjh183322/cangxia-server`。

## 当前状态

独立的验证原型、容器定义和构建检查已进入开发分支。正式版本仍以备份版为业务对照，实际 NAS 卷、浏览器沙箱和交付结果以现场验收为准。

开发和后续相关工作流只在本分支推进，保护现有 main、备份版及旧 NAS 分支。不得提交用户资料库、媒体、恢复副本、登录会话、令牌、真实采集响应或个人调查附件。

## 本地验证记录

原型位于 feasibility/nas-b，包与依赖锁独立。真实现场表和验证附件放入已忽略的 .evidence/，公开说明只记录脱敏结论。

配置检查要求显式试验模式、专用根目录及匹配的试验标识。NAS 的实际宿主挂载、端口可用性、运行身份和资源余量由部署前的现场核对确认。缺少现场输入时暂停部署。

业务和后续正式界面对照沿用备份版 0.3.46 的源码、现有测试及相同窗口尺寸、显示缩放。验证控台、试验样本上限及测试网络配置仅用于可行性验证。

## 容器检查和现场配置

构建使用固定的 Playwright Noble amd64 镜像清单。容器内含匹配的 Playwright Core、Chromium、Xvfb、OpenSSL、FFmpeg/ffprobe、Node/SQLite 和 CPython 3.12 的 OpenCV/NumPy wheels。Ubuntu 工具由安装包分发，Python 依赖锁校验固定 wheel 的 SHA256。Node、Python 和系统包的许可证保留在发行包目录中。

CI 的完整应用使用非 root、只读容器文件系统和独立试验挂载，以临时 HTTPS 证书自检。独立夹具挂载运行文件原子操作测试。Linux runner 上的结果和 NAS ext4 上的现场结果分别记录。

在 `feasibility/nas-b` 可运行 `npm run test:delivery` 检查构建和交付边界。 `render-deployment.mjs` 从标准输入读取审核过的现场参数及发布证明。现场尚未确认或镜像尚未验证可拉取时只报告受阻项。生成的包包含一个 Compose 项目和 Chromium 沙箱的 seccomp 文件。使用 Moby 固定版本的默认拒绝配置，并增加 Playwright 建议的用户命名空间调用。需要 NAS 的运行时支持该配置与用户命名空间。 [Moby seccomp 配置](https://github.com/moby/profiles/blob/9ee3204f0d0cfa19ca2c6a7b0fcf5a2b353954ae/seccomp/default.json) [Playwright Docker 文档](https://github.com/microsoft/playwright/blob/v1.65.1/docs/src/docker.md)
