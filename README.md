# 藏匣备份版 CangXia Backup

**备份版 0.1.2 预览 · Windows 10/11 64 位 · `codex/backup`**

日常在本机读取收藏、浏览和保存媒体；配套 NAS 服务负责后台同步、断点续传与 NAS 本机校验。启动先比对 NAS，无法连接时只读浏览本机已有资料。

本版修复 NAS 恢复后的待确认收藏顺序，并核验稳定账号身份，避免会话变化造成账号误判。已有用户只更新电脑端，NAS 服务继续使用 0.1.0；见[升级说明](docs/releases/backup-v0.1.2.md)。

## 三个开发方向

| 版本 | 分支 | 基点与定位 |
| --- | --- | --- |
| 本地版 | [`codex/local`](https://github.com/wjh183322/CangXia/tree/codex/local) | v0.1.7，NAS 加入前的最后一个本地版本 |
| NAS 版 | [`codex/nas`](https://github.com/wjh183322/CangXia/tree/codex/nas) | v0.1.12，保留原 SMB/NAS 保存方式 |
| 备份版 | [`codex/backup`](https://github.com/wjh183322/CangXia/tree/codex/backup) | 严格基于 v0.1.7，加入配套 NAS 备份服务 |

三个方向分开开发，历史版本不改写。备份版版本号从 0.1.0 独立计算，详见[分支说明](docs/版本分支.md)。

## 下载与部署

[备份版 0.1.2 Release](https://github.com/wjh183322/CangXia/releases/tag/backup-v0.1.2) 提供：

- `CangXia-Backup-0.1.2-Windows-x64.exe`：免安装电脑端。
- `CangXia-Backup-Server-0.1.0.tar.gz`：NAS Docker 镜像。
- `CangXia-Backup-Deploy-0.1.2.zip`：Compose 配置和部署说明。

先按[服务部署说明](backup-server/README.md)部署 NAS 服务，再打开电脑端设置，填写 HTTPS 地址、服务访问密钥和证书指纹。密钥与指纹从自己的 NAS 容器日志复制，直接填入程序。

服务只通过 NAS 的 Tailscale 地址开放 TCP 18443，不需要路由器公网端口映射。如果原 Tailscale 规则仅允许 TCP 445，需要额外允许指定电脑访问 TCP 18443。

## 使用方式

1. 启动时先检查同步状态。比对完成并取得写入权后才能修改或下载；另一台电脑占用时只读。
2. 首次可在设置中预览并复制导入旧本机版或旧 NAS 版资料。原资料保留，登录信息不导入，备份版单独登录抖音。
3. 日常文件保存在本机。默认每 5 分钟后台同步，一批下载完成也会发起同步；间隔可设置，随时可点“立即同步 / 换电脑前同步”。
4. 状态显示已同步、本机有更新、正在同步、只读或无法检查，以及最后同步时间和提交电脑，不要求用户比较内部版本号。
5. “NAS 备份”中可以看到已备份作品，按需下载到当前电脑。清理本机文件会保留 NAS 副本。
6. 退出时如有待同步内容，可以等待同步完成，或保留本机待同步内容后退出。程序关闭后不会继续后台同步。

如果双方都有未同步修改，程序保留双方并停止覆盖。可继续只读，或明确选择把本机记录另存为恢复副本后采用 NAS 记录；不会自动整库覆盖。

## 数据隔离

- 电脑端记录、配置、加密凭据：`%APPDATA%/藏匣备份版`。
- 默认本机媒体：Windows 下载目录下的 `藏匣备份版`；应选择本机磁盘，不使用 NAS 映射盘。
- 服务端数据：Compose 专用目录下的 `data/`，与原 NAS 版的 `.cangxia` 分开。
- 本机浏览器登录凭据不上传 NAS。服务 API 密钥在 Windows 使用系统加密保存；连接自签证书时核对保存的 SHA256 指纹。

这份同步副本不能替代独立硬盘备份；独立备份仍在[后续事项](docs/后续事项.md)中。

## 开发与检查

```powershell
npm ci
npm test
npm run test:ui
npm run test:layout
npm run test:backup-desktop
npm run dist
```

桌面验证使用隔离的本机资料与 HTTPS 测试服务，不读取或修改用户正式库。服务使用 Node.js 24 的 SQLite 模块；Docker 镜像在 GitHub Actions 构建，并进行实际容器启动检查。

[版本说明与验证边界](docs/releases/backup-v0.1.0.md) · [本地优先方案](docs/本地优先同步方案.md)
