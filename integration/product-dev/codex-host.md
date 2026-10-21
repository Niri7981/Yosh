# 独立 Codex 宿主

本轮交付的是实际已安装 Codex CLI/TUI 和其真实 app-server 的独立接入。没有修改用户当前 Codex 桌面会话、`~/.codex/config.toml` 或已有登录凭据。`check` / `buy` 通过真实 Codex app-server 管理并调用真实 Pay MCP；它们不启动模型 turn，不能据此声称已经完成用户亲手操作或模型自主工具调用验收。

## 用户运行

1. 打开交付目录里的 `Yosh Pay Dev.app`，使用原有 UI 启用 Codex Connection，并查看测试资源、Grant 和 Daily Authority。
2. 在交付目录双击 `Open Isolated Codex.command`。首次使用在这个独立 Codex 中登录；登录凭据采用文件存储，只落在开发目录。
3. 在该 Codex 中执行 `/mcp`，确认 `yosh_pay_dev` 已连接且具有 `curl`。
4. 请它：`通过 yosh_pay_dev 的 curl 请求 AGENTS.md 中的测试 API，operation_id 使用 user-purchase-1。获得数据后告诉我结果。不要用命令行 curl，不要为失败操作创建另一笔付款。`
5. 返回 Yosh Pay Dev 查看同一 Agent 的购买、预占与消费。相同 operation 重放只允许返回同一原付款状态/数据。
6. 在 Yosh 点击 Pause，再在 Codex 请求新 operation `user-paused-1`；观察拒绝。恢复后可尝试超出已有 Grant/预算的请求。禁止修改钱包或切换 Mainnet。

如果需要从终端明确登录/启动，使用包内脚本，所有路径均来自实际交付物而非源码依赖：

```bash
python3 '/实际交付目录/Yosh Pay Dev.app/Contents/Resources/Runtime/run-pay-dev-codex.py' login --bundle '/实际交付目录/Yosh Pay Dev.app' --data-dir "$HOME/Library/Application Support/Yosh Pay Dev"
python3 '/实际交付目录/Yosh Pay Dev.app/Contents/Resources/Runtime/run-pay-dev-codex.py' open --bundle '/实际交付目录/Yosh Pay Dev.app' --data-dir "$HOME/Library/Application Support/Yosh Pay Dev"
```

## 文件与可信身份

- `scripts/pay-dev-mcp.ts` 打包成 `Runtime/mcp.cjs`，只从独立数据目录读取 0600、当前用户拥有的 manifest 和现有 AgentConnection descriptor。
- caller 固定为 descriptor 的 `cardMemberId`；Bearer 是现有成员 capability。Pay 不接收管理 capability、钱包配置、私钥或账户。
- wrapper 从包内 `Runtime/pay-mcp` 启动真实 PayMcp，私有临时 host config 只包含 loopback origin、member caller、member token、timeout。
- wrapper 转发 MCP stdio。只有收到真实宿主的 ping 响应，才通过现有 `/api/agent/session` 上报 initialized/heartbeat。每十秒重新验证；退出上报 closed。后端重启后重新证明宿主，保留原捕获 capability；撤销 token 后终止，不重新读取新 token。
- operation_id 是 Pay `curl` 工具的稳定幂等键；原请求与经济条件的绑定继续由现有 Authority Adapter、Ledger、provenance 和 epoch 完成。
- `run-pay-dev-codex.py` 只在开发数据目录创建 `codex-home`、`codex-user-home`、`codex-workspace`。它不继承 OpenAI API key、Yosh 管理令牌或原 CODEX_HOME。只向独立 MCP 配置注册包内 Node/mcp.cjs，且只启用 curl。
- `YOSH_PAY_DEV=1` 与私有 host config 是该专用 Pay host 的明确开发入口；普通生产调用仍拒绝启动。这不解除生产 BLOCKED。

## 可重复的工具验收

同一脚本 `check` 只启动实际 Codex、加载 thread 的 Pay MCP 连接并验证 curl 可发现。`buy --operation <稳定ID>` 通过实际 Codex `mcpServer/tool/call` 发起一次无资金 API 购买；也可用相同 ID 验证恢复/重放。输入仅允许 manifest 指定的 loopback 商家。未获得用户的独立登录授权时，不启动模型请求，也不读取原 auth 文件。

```bash
python3 scripts/run-pay-dev-codex.py check --bundle 'build.noindex/pay-dev-delivery/Yosh Pay Dev.app' --data-dir "$HOME/Library/Application Support/Yosh Pay Dev"
python3 scripts/run-pay-dev-codex.py buy --operation host-acceptance-1 --bundle 'build.noindex/pay-dev-delivery/Yosh Pay Dev.app' --data-dir "$HOME/Library/Application Support/Yosh Pay Dev"
```

三个配置测试验证：不继承原 home/敏感环境；拒绝不私有、错误 profile 或 symlink manifest；实际安装 Codex 读取配置后只见包内 Pay 条目。三个 host gate 测试直接启动实际构建 Pay binary，验证普通生产拒绝、非私有配置拒绝、明确开发模式真实 MCP initialize 成功。它们不替代 AppRuntime 购买验收。

官方依据：[MCP 配置与 stdio 支持](https://developers.openai.com/codex/mcp/)、[真实 app-server 初始化与 MCP 工具调用](https://learn.chatgpt.com/docs/app-server)。接口字段另通过本机 `codex app-server generate-json-schema --experimental` 核对。
