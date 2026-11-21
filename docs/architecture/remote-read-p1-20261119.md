# P1：Mac 在线，远端 Agent 读取 Yosh
2026-11-19 · 隔离开发版。账本、钱包和授权仍由用户的 Mac 持有；没有发布公网服务。Dot 和 Grok 真机验收依用户要求暂缓。

一个远端 MCP 客户端只需工具地址和它自己的只读凭据。配对时人在 Mac 上选择“查账”“读已购结果”或两者；同一账号可为不同 Agent 分别配对和撤销。凭据绑定这次安装、钱包环境和专属成员，不继承本地 Codex 的连接、Spend Grant 或付款能力。Agent 标签用于人识别，凭据是持有者凭证，并非平台对该 Agent 身份的证明。

| 在远端做什么 | Mac 上的结果 |
| --- | --- |
| 查账 | 复用 P0 的 `list_account_purchases`；可按 Agent、时间过滤并分页。 |
| 读已购结果 | `read_account_result` 按账单上的购买 ID 读取原已保存的可共享结果，可分块；不会向商家请求新数据。 |
| Mac 离线、连接中断 | 通道不可用时返回 `503 MAC_OFFLINE`，网络长时间无响应会超时；中继不返回缓存。Mac 重新连接后可继续读取原购买。 |
| 撤销某个 Agent | 下一次请求重新鉴权；同一会话、后续分块及重启后都不能继续读取。其他配对不受影响，已交付的数据无法远程删除。 |

**连接路径：** 远端 Agent → HTTPS 入口（`POST /mcp`）→ 中继 loopback → Mac 主动建立的 OpenSSH 反向连接 → Mac 私有 Unix socket → 本机固定的只读 MCP 入口 → P0 账本。中继不持久化账单或凭据；它和 TLS 终止端能看到传输中的 bearer 和返回数据，是信任边界。公网不可直接转发整个 Yosh 后端，也不提供管理、签名、购买、恢复或创建 Grant 的远程操作。使用仓库锁定版本的 [MCP SDK 与标准 Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)，此版本为无状态 JSON 响应，面向支持自定义 bearer 的服务端客户端，不提供 OAuth 注册流程。

**隔离开发版如何接线。** 下面是运维命令，示例地址均为占位符；终端用户或云端 Agent 不需要安装 Yosh。当前配对的原生确认组件装配在 Local Authorization Dev 运行包中，未装配的进程不会签发凭据。

1. 在开发机执行 `npm run build:remote-read`，产出 `build.noindex/remote-read/remote-read-owner.cjs` 和 `remote-read-transport.cjs`。它们可在 Node 24 独立运行，无需将仓库的 npm 依赖复制到运行主机。Mac 可以使用其 Yosh Dev 运行包已有的 Node。构建 Mac 运行包沿用 `python3 scripts/build-standalone-dev.py --local-authorization --dependencies <本工作树/build.noindex 下的已验证依赖目录> --output build.noindex/p1-mac-dev`。本轮只构建了隔离包，没有升级已安装的服务。
2. 在**受信的单账户中继**上运行下面的 relay 命令；仅将 HTTPS 的精确路径 `/mcp` 转给 `127.0.0.1:7430`，禁用缓存以及请求头、请求体和响应体日志。SSH 后端的反向监听端口不能与其他租户或不受信任进程共用。为 Mac 配置专用 SSH 公钥和经独立核验的服务端主机密钥；使用仅允许反向转发、限制监听 `127.0.0.1:7431`、禁用 shell/session、TTY 和其他转发的 SSH 账号。见 [OpenSSH 服务端选项](https://man.openbsd.org/sshd_config)。没有任何 SSH 或 HTTPS 配置由这些命令自动发布。
3. 在 Mac 上运行下面的 connect 命令。只要连接器进程存活，它会自动重连；本阶段未注册登录项。仅用已经更新到 P1 的隔离后端和它的端口，示例 17449 是 Local Authorization Dev 默认值。不得直接将正式 App 或管理端口暴露到网络。

```sh
# 中继主机
node remote-read-transport.cjs relay --listen-port 7430 --tunnel-port 7431

# Mac
node remote-read-transport.cjs connect --backend-port 17449 --tunnel-port 7431 \
  --ssh-host relay.example.org --ssh-user yoshread \
  --known-hosts /absolute/private/known_hosts --identity /absolute/private/relay_key
```

4. 在 Mac 上，请本机用户为一个 Agent 配对。下面的 data dir 是该隔离后端持有 `standalone-control.json` 的目录；凭据输出目录需要归本机用户所有、权限 0700。配对须核对账号、环境、Agent、读取范围，再完成系统身份验证；没有“自动批准”选项。签发的凭据只写入新建的 0600 文件，不输出到终端或管理列表。若签发过程中命令中断，先列出配对，撤销未使用的一项再重试。

```sh
node remote-read-owner.cjs pair --data-dir /absolute/private/dev-control \
  --label 'Travel agent' --scope statement,result --token-out /absolute/private/travel.token
node remote-read-owner.cjs list --data-dir /absolute/private/dev-control
node remote-read-owner.cjs revoke --data-dir /absolute/private/dev-control --id <配对ID>
```

5. 在支持该方式的宿主**私密连接配置**添加 URL `https://relay.example.org/mcp` 和该 Agent 独有的 bearer；不要贴进聊天、日志或查询串。只发起读取。只需要账单的 Agent 可单独授予 `--scope statement`，只需要提取已知结果的可选 `--scope result`。换钱包环境需重新配对；轮换凭据则新建配对并撤销旧配对。

**验收证据。** [独立端到端测试](../../tests/integration/shared-account-remote.test.ts) 从官方 HTTP MCP 客户端经真实 OpenSSH、产品连接器和专用 socket 调用本机后端；使用隔离数据及模拟商家/链。A 付一次，远端 B 读回原结果，商家、签名及模拟交易计数没有增加。不同范围的配对、拒绝确认、越权调用、断线/自动重连、撤销/重启均有覆盖。账单与结果不会在中继生成第二份。另见[授权存储测试](../../tests/unit/remote-read-pairings.test.ts)、[传输边界测试](../../tests/unit/remote-read-forwarder.test.ts)、[原生确认内容测试](../../tests/native/LocalGrantPresentationTest.swift)。端到端测试注入用户同意/拒绝；原生助手另行编译并校验展示内容，测试没有代用户进行系统身份验证。

**2026-11-19 的 P1 验收记录。** 独立会话验收通过。常规测试 1,518 项通过；P0/P1 宿主、插件入口及支付协议 4 个专项文件共 18/18 通过。类型检查、lint、Next 构建、已校验依赖的隔离 Mac 运行包以及两份独立命令行产物均构建成功；没有提交、推送、安装或对外部署。

**尚未验收：** 公网 HTTPS 部署、跨两台物理设备的网络、真实宿主是否允许配置这一传输和凭据、用户在实际对话中的完整体验。生产发布门槛保留。Mac 离线时无法读取。远程模拟购买的后续实现和验收见 [P2](remote-purchase-p2-20261119.md)。
