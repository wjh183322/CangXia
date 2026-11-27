# 旧资料彩排与外部还原核对

使用 0.4.1 Compose 时，管理员在独立的 CANGXIA_APPROVED 目录准备 sources、manifests、restores 和可选 rehearsal.json；服务以 /approved 只读挂载。正式库、服务身份以及可写 CANGXIA_REHEARSAL 输出目录必须各自独立。以下输入路径都相对管理员输入区，targets 和 reports 则相对输出区。历史开发命令使用的单个目录仍适用于隔离测试。


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

## 另行批准后将已导入的库交给正式服务

从导入完成报告独立保存旧源、`previewId`、抖音 `uid`、新库 `libraryId`、`manifestSha256`，以及配套数据库快照和完整媒体。用绿联在独立介质上实际备份并还原到新管理员输入区的 `restores/imported/snapshot` 与 `restores/imported/media`。核实报告与原件，保留正在运行的库、原配置、恢复介质及旧端。停止两端写入，并记录地址、镜像摘要和所需回退步骤。

使用**另一个停止的 Compose 项目**准备目标。指定全新的私有宿主挂载 `CANGXIA_LIBRARY`、`CANGXIA_CONFIG` 和 `CANGXIA_REHEARSAL`，三者及新管理员只读输入区 `CANGXIA_APPROVED` 须在物理目录上彼此独立，也须与旧运行库及原彩排区独立。在身份目录中只创建空文件夹 `PREPARE-IMPORTED-CANGXIA`。设置 `CANGXIA_LIBRARY_CHILD=formal`，为新客户端设置 HTTPS 地址。保留管理员输入区的 sources、manifests、restores。准备阶段使用新身份目录，后续彩排的 rehearsal.json 使用新 devices.json 中的服务账号。

在管理员输入区准备 `cutover.json`，以下标记值应逐一换成同一迁移报告中的原值。

```json
{"confirmed":true,"mode":"from-backup","target":"formal","restore":"imported","uid":"来源UID","libraryId":"导入库UUID","previewId":"导入预览的64位摘要","manifestSha256":"独立备份清单的64位摘要"}
```

`from-backup` 从独立备份建立全新的 formal 子目录。须预留足量空间，并保持该子目录名尚未使用。工具重新绑定文件身份并通过正式媒体接口逐件核验。如管理员已经把完整的具名彩排目标在同一文件系统内原子移到专用挂载的 formal 子目录，可改用 `existing-import`。该模式复核原导入回执、数据库、独立备份、媒体字节和原文件身份；跨卷复制或导入后曾有新增写入的目标应改用新恢复点单独核对。

在匹配的部署包目录用 `docker compose run --rm --no-deps server prepare-import` 单独准备。完成时打印核实的库 UUID 与清单摘要并退出。它为这个 UUID 单独签发证书及两份设备凭据。普通启动不接受准备标记，已有身份目录不能覆盖；中断时保留已有文件，使用另一组全新目录重做。取得本次正式开放批准后才运行 `docker compose up -d`，分机核对新指纹和设备凭据，登录新服务并验证正式列表与实际媒体播放。回退前先独立封存切换后新写入，再停止新项目并恢复原项目、原卷和原设备配置。

## 在 Windows 执行并查看报告

用拥有控制权的客户端打开「设置 → NAS 连接设置 → 查看迁移彩排与恢复点」。输入未使用的目标目录名并预览。核对账号、各来源库身份、作品、人工标签、来源归属及次序、原归档目录、任务和缺失文件。翻页查看明细。历史独有项、来源冲突、设备本地隐藏、显式删除及无法确定位置/次序的资料进入候选。报告保留来源和记录标识。取消或断开控制会在核验边界停止；重新连接后可刷新报告或重复原批准。

确认后只发布该名称的隔离卷。NAS 哈希对象经长度和 SHA-256 核验后按原归档位置写成普通文件；多个来源中同一作品的同一资源只登记一份。旧任务保留原状态和排序，须在正式下载入口重新选择后才会执行。设备凭据和浏览器会话不迁入。旧端独有的过程表和未识别字段留在源库，报告指出需人工核对的记录。候选需查看原库并独立解决，再封存和重新预览。

历史空归属可通过同库旧范围回执核对到原操作。压缩的完整回执保留范围信息；只有摘要时须用哈希匹配的原设备命令证明具体范围。不能证明的空归属继续列为候选。原版封面匹配失败时，保留已核实的视频、普通封面和作品信息。

作品状态、封面错误和读取历史中的普通诊断短句保留原文，包括 YUV/RGB、image/jpeg 等规格。诊断含设备绝对路径、认证头或常见令牌赋值，或超过 512 个 UTF-8 字节时，会隐去该条诊断。作品信息 JSON 需要改写时，报告列出原件和移交文件各自的 SHA-256，源文件保留原样。

报告提供版本化数据库快照目录、媒体目录及清单摘要。将它们作为同一恢复点交给绿联「同步与备份」，配置与原卷故障域独立的目标。由绿联执行文件备份和还原。把还原的文件置于上述独立目录后，在配置的 `restores` 加入 `"usb01": {"libraryId":"原库UUID","manifestSha256":"原始清单摘要"}`。选择对应还原名进行核对。结果核查实际数据库的库身份、版本、完整性、业务记录与媒体清单，以及文件字节的匹配、缺失、变动和清单外文件。 当前服务账号与来源 UID 必须匹配，核对通过后可选择新目标名，单独批准「验证独立恢复库可用性」。工具将核实的快照和媒体复制到该新卷，在独立数据库中重绑原归档与文件身份，通过正式播放接口读回资源并核对格式和 SHA-256，再在最终目录复查媒体请求。额外文件、旧版本、待处理移位、无法证明文件归属或目标名称冲突时停止。 已验证的旧配乐若与作品当前音乐身份不同，报告单列为非当前资源，保留原字节和登记证明。

正式切换后若需回退，打开「运行库回退前移交」，明确核对当前库标识、账号与新的目标名称。服务只读当前运行库，在独立目标生成带当期作品、归属、标签和任务的一致快照及清单；核对期间若又有业务写入，会报告须重新停写并封存。保留旧设备、原卷与新移交目录。用绿联复制快照及同一时点的归档，并还原到另一目录，使用上述正式播放验证操作。停止双端写入、匹配镜像和最终切换由操作员分别确认。原先的独立彩排库也可以从导入报告选择「封存此彩排库的后续增量与任务」。

也可从受信终端运行 `node server/rehearsal-cli.mjs request --config <设备连接配置文件> --input <请求文件>`。配置格式与客户端相同，使用 HTTPS 地址、固定证书指纹、设备号、独立访问令牌和库标识。请求动作有 `list`、`preview`、`import`、`status`、`cancel`、`preserve`、`verify`、`restore` 和 `handoff`，经同一独占会话和账号核验。预览请求例如 `{"action":"preview","sources":["desktop","nas","history"],"target":"rehearsal-01"}`。导入还须提交同一预览返回的 `previewId`、`uid` 和 `confirmed:true`。CLI 等待任务并打印报告第一页，后续可按报告编号和页码查询。
