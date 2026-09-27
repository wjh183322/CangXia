# 藏匣作者下载试验版 0.1.1

2026-09-28。

## 问题与修复

用户粘贴作者主页分享短链接后，0.1.0 提示 `Redirect was cancelled`，作者列表仍为空。失败发生在解析短链接阶段，尚未进入作者资料和作品列表读取。

原因已用实际 Electron 运行时和本机 HTTP 302 响应复现：`session.fetch({redirect:'manual'})` 不把跳转响应交给原解析代码，而是直接拒绝请求。

新增 `electron/redirect-headers.mjs`，使用 `net.request` 的 `redirect` 事件取得这一跳的状态与地址，随后终止请求；上层 `resolveAuthorLink` 校验地址后才决定是否请求下一跳。保留 HTTPS、主机白名单、跳转次数、超时和停止限制。无需下载网页正文或发送登录凭据。

实际运行时还观察到 Writable 流的 `close` 可能早于 Chromium 的 `redirect` 到达；不能将这个提前到达的 `close` 当作失败。仍通过错误事件和有时限的信号终止无响应请求。补充了相应回归用例。

官方接口语义参考：[Electron ClientRequest](https://www.electronjs.org/docs/latest/api/client-request)。

## 真实链接验证

用户提供：`https://v.douyin.com/AvKUt7Noih4/`

修复后已使用实际 Electron 网络请求解析到：

```text
https://www.douyin.com/user/MS4wLjABAAAA7jD34DuP_UptkFDY3juaQq92nVtWaLzAkH5-_nc4Y6A
```

该结果证明此链接是作者主页分享链接、修复后的短链接解析有效。此次没有自动读取其全部作品、下载媒体或操作用户登录会话，不能把短链接成功等同于真实作者列表读取/跨网络验收通过。

## 验证

- 作者数据流程与短链接相关单元测试共 16 项通过。
- Electron 原生 302 测试复现旧错误，验证新代码能取得目标地址、不自动访问目标地址、不发送测试 Cookie。
- 实际用户分享链接解析通过；结果在 `.test-output/redirect-desktop-result.json`。
- 打包程序的 43 项桌面回归通过；ASAR 内 32 个 Electron/前端文件与当前构建产物逐项校验一致。

复现测试（默认只访问本机测试服务器）：

```powershell
node --test tests/redirect-headers.test.mjs tests/author-source.test.mjs
node node_modules/electron/cli.js tests/redirect-headers-desktop.mjs
```

如需额外验证指定公开主页分享链接，可给测试进程设置 `CANGXIA_AUTHOR_LINK`。不要在其中放入密钥或登录凭据。

## 使用

退出旧的作者下载试验版，打开 `release/author/CangXia-Author-0.1.1-Windows-x64.exe`，重新添加原短链接即可。用户目录沿用 0.1.0，无需清缓存或删除数据库。

0.1.0 暂时也可以直接使用上面的完整主页链接，绕过短链接解析。

本次只修改作者下载实验分支，未改动其他三个版本和图片修复版，也没有将其他使用 `redirect:'manual'` 的功能一并重写。

## 安装包校验

大小：105365128 字节。

SHA256：`e0f73928facc400391572acc0400ab6b39bf8874edf7666f539051f806671c53`。
