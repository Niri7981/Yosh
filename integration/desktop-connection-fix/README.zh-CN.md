# 现有桌面会话的 Pay MCP 连接修复

## 原因与处理

桌面共用的 ~/.codex/config.toml 原先没有 yosh_pay_dev；该条目仅存在于上一轮独立 Codex 环境。开发版当时未运行，历史生命周期记录显示正常退出，未复现启动崩溃。正常打开桌面 Yosh Pay Dev.app 后，真实 AppRuntime 在 127.0.0.1:13049 就绪，无需修改业务或启动代码。

经用户明确授权，仅在现有配置追加 yosh_pay_dev，使用开发版内随包交付的 node/mcp.cjs。保留原文件字节前缀、现有 14 个 MCP 的解析结果以及登录信息。变更前受限权限备份位置见 config-change.json。未修改正式 Yosh App、钱包或生产 Ledger。

## 当前验证

verify-desktop.py 使用已安装桌面客户端随包交付的真实 Codex 二进制，读取用户实际 ~/.codex 配置。其他 MCP 仅在验证子进程内禁用，避免连接正式 Yosh；未改其持久配置。创建临时会话，发现 yosh_pay_dev 的 curl，并观察真实 Yosh AppRuntime 的认证身份握手及 coreReady。未启动模型回合、未调用购买工具；开发库购买、原付款、provenance 和 Grant 数据在验证前后一致。

验证进程退出只关闭自身，不关闭用户桌面客户端或开发版 App。工具可用证据见 verification.json；config-change.json 与 startup.json 分别记录配置保留及后端启动证据。验证脚本曾因覆盖参数含引号被宿主错误解释而启动失败，修正验证脚本参数后通过；没有因此更改用户配置或经济代码。

## 用户操作与范围

保持 Yosh Pay Dev 打开，完整退出再重新打开现有 Codex Desktop，然后创建新会话，明确使用 yosh_pay_dev 的 curl。无需独立 Codex 启动器。当前桌面 GUI 中工具是否已经热加载未经 UI 自动化验证，因此要求重启客户端加载配置。只连接 Offline 假商家、假 RPC、离线测试密钥，生产仍 BLOCKED。本次只验连接，没有购买验收。
