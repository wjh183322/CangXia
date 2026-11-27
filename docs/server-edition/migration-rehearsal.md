# 旧资料彩排与外部还原核对

在旧电脑和旧 NAS 停止采集、下载、删除与后台同步，待事务完成。在操作员控制的源设备上封存同一时点的数据库、提交 WAL、设备范围数据库与归档文件。先封存再传输。若接手时只有一个来源不明的 SQLite 文件，缺失的 WAL 无法从主文件反推，应重新取得原端的一致导出。保留旧卷、旧账号和旧客户端的独立恢复条件。

## 准备独立目录

为 NAS 服务设置 `CANGXIA_REHEARSAL_ROOT`，采用与运行资料库独立的目录。只允许管理员写入配置、来源和清单，服务账号只读这些输入，可写 `targets` 和 `reports`。不要给其他程序写入彩排暂存、目标或正在核对的外部还原目录的权限。

- `sources/<来源名>/` 放一组冻结的输入。Windows 0.3.46 放实际数据库、同名的 `-wal`（若存在）、同账号的 `device-scope-state.sqlite` 及其 WAL。把原下载根内的文件按原相对路径放入 `archive/`。如原下载目录另有名称，封存时传 `--media`。旧 NAS 采用备份服务实际的 `library.sqlite` 与 `objects/<sha256>`。历史 `recovery/<时间>.sqlite` 可以使用原文件名。不要放浏览器配置、登录密文或设备访问配置。
- `manifests/<来源名>.json` 放在源端生成的封存清单，单独保留其 SHA-256 及来源身份。清单绑定数据库、WAL、设备范围和媒体文件的相对路径、长度及内容。SQLite 在私有临时副本中重建 SHM。若存在未处理的回滚日志，应先在原端用匹配客户端取得一致导出。
- `targets/` 放具名彩排目标与按批准编号隔离的暂存工作。使用新目录名，例如 `rehearsal-01`。中断后用相同批准可继续核验已落盘媒体；新增数据、来源变化或命名冲突均需重新核对。
- `reports/` 保留每次报告及分页明细。独立存储的大小要覆盖数据库、普通媒体、暂存及回退空间。
- `restores/<还原名>/snapshot/` 放从绿联备份实际还原的 `manifest.json` 和 `library.sqlite`，同级 `media/` 放同一恢复点的完整归档目录。单独保存生成快照时报告的清单摘要。

在源端使用包含本工具及其依赖的项目目录运行，`--out` 指向源目录之外的新文件。例如：

```powershell
node server/rehearsal-cli.mjs seal --kind windows --directory D:\frozen\desktop --database library.sqlite --out D:\manifests\desktop.json
node server/rehearsal-cli.mjs seal --kind nas --directory D:\frozen\nas --database library.sqlite --out D:\manifests\nas.json
node server/rehearsal-cli.mjs seal --kind recovery --directory D:\frozen\history --database 1760000000000.sqlite --out D:\manifests\history.json
```

在彩排根创建 `rehearsal.json`，账号、UID、镜像摘要及清单摘要均取自实际核对记录。每组配置必须包含所有当前来源及相关删除证据，不能通过在界面取消某个来源来绕过保护。

```json
{
  "accountId": "访问设备所属的服务账号",
  "uid": "已核实的抖音数字UID",
  "imageDigest": "sha256:实际运行镜像的64位十六进制摘要",
  "sources": {
    "desktop": "封存工具输出的desktop清单SHA256",
    "nas": "封存工具输出的nas清单SHA256",
    "history": "封存工具输出的history清单SHA256"
  },
  "restores": {}
}
```

## 在 Windows 执行并查看报告

用拥有控制权的客户端打开「设置 → NAS 连接设置 → 查看迁移彩排与恢复点」。输入未使用的目标目录名并预览。核对账号、各来源库身份、作品、人工标签、来源归属及次序、原归档目录、任务和缺失文件。翻页查看明细。历史独有项、来源冲突、设备本地隐藏、显式删除及无法确定位置/次序的资料进入候选。报告保留来源和记录标识。取消或断开控制会在核验边界停止；重新连接后可刷新报告或重复原批准。

确认后只发布该名称的隔离卷。NAS 哈希对象经长度和 SHA-256 核验后按原归档位置写成普通文件；多个来源中同一作品的同一资源只登记一份。旧任务保留原状态和排序，须在正式下载入口重新选择后才会执行。设备凭据和浏览器会话不迁入。旧端独有的过程表和未识别字段留在源库，报告指出需人工核对的记录。候选需查看原库并独立解决，再封存和重新预览。

报告提供版本化数据库快照目录、媒体目录及清单摘要。将它们作为同一恢复点交给绿联「同步与备份」，配置与原卷故障域独立的目标。由绿联执行文件备份和还原。把还原的文件置于上述独立目录后，在配置的 `restores` 加入 `"usb01": {"manifestSha256":"原始清单摘要"}`。选择对应还原名进行核对。结果核查实际数据库的库身份、版本、完整性、业务记录与媒体清单，以及文件字节的匹配、缺失、变动和清单外文件。

回退前先从这次彩排的报告选择「封存此彩排库的后续增量与任务」，产生新的数据库快照及当时的完整媒体清单。用绿联将新的快照和归档复制至独立存储并还原核实；任何缺失、变动或清单外的暂存文件都须单独保全。停写、独立挂载、匹配版本的实际开库和正式切换由操作员分别验证。启动哪个卷由服务部署决定。

也可从受信终端运行 `node server/rehearsal-cli.mjs request --config <设备连接配置文件> --input <请求文件>`。配置格式与客户端相同，使用 HTTPS 地址、固定证书指纹、设备号、独立访问令牌和库标识。请求动作有 `list`、`preview`、`import`、`status`、`cancel`、`preserve` 和 `verify`，经同一独占会话和账号核验。预览请求例如 `{"action":"preview","sources":["desktop","nas","history"],"target":"rehearsal-01"}`。导入还须提交同一预览返回的 `previewId`、`uid` 和 `confirmed:true`。CLI 等待任务并打印报告第一页，后续可按报告编号和页码查询。
