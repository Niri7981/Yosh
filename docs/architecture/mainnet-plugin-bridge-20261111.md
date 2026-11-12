# 原主网插件接入：2026-11-11

> 历史实现与验收快照；文内“当前”、版本、进程和未完成项均指各段记录时点。最新插件 0.2.3 主网成功购买及本次归档验证见 [插件版里程碑](plugin-milestone-20261112.md)。
用户明确要求新版接入原主网钱包、保留旧 App。本轮交付是 **App 后台桥接插件**，不是 C 的独立 Devnet 后台切换主网，也不是免 App 主网迁移完成。

## 共享方式

- 新插件 `yosh-mainnet@yosh-mainnet-local`，显示“Yosh — 原主网钱包”。
- 通过当前系统用户目录定位 `Applications/Yosh.app`；非默认安装位置可显式设置 `YOSH_MAINNET_APP`。校验 App 身份、签名和实际 Node 路径。
- 调用该安装版原有 `Runtime/mcp.cjs`，不编译或替换其付款代码。
- 使用原来的 `Yosh Pay Dev v0.1.1-rc.5/Mainnet` 数据、Keychain 引用、Agent 身份及共享后台 `127.0.0.1:13449`。没有复制钱包、Grant、API 或账本。
- 这是同一个 Codex Agent 的另一个入口，不具有独立可撤销的第二份 Agent 授权。旧 MCP 条目和旧 App 保留。两个入口共用权限，不能把它们当作两个不同账户。
- 桥接插件不拥有后台进程：需要原 App 后台运行；关闭插件不会退出 App。未启动时失败并提示打开原 App，不在后台另起钱包服务。
- 启动校验真实后台的 Mainnet 网络、USDC mint 和精度，拒绝 Devnet/未知配置；不改用户选择的网络、暂停、额度或授权。

## 验证

本轮启动原安装 App，未替换安装产物。读取到原注册资源 You.com Web Search 与 Agent402 Crypto Price；原账本有 4 条购买记录。主网实际暂停状态为 false，Grant 已过期，余额当前报告 `USDC_BALANCE_UNVERIFIED`，`spendingAuthorized=false`。未解除限制、未充值或付款。

- launcher 6 项自动测试：网络/资产、环境选择、凭据隐私、Agent 归属、错误成员文件不回退、工具清单与调用白名单。
- 原插件打包器 4 项回归通过。
- typecheck、lint、Next build 通过；保留原有 pay-mainnet-control 动态文件 tracing 两条警告。
- ZIP 解包后安装至私有 CODEX_HOME，真实 Codex app-server 连续两次启动并调用 `get_spending_status` 成功。
- 实际暴露 10 个工具：`get_spending_status`, `get_balance`, `list_catalog`, `search_catalog`, `get_catalog_entry`, `discover_x402_resource`, `register_x402_resource`, `quote_x402_resource`, `curl`, `recover_payment`。
- 过滤且拒绝直接调用 `topup`、`sell_inference`、`create_skill` 及未知工具。原包装器没有新版 `get_purchase` / `get_purchase_delivery`，本轮不声称已有这些接口。
- 两次宿主验收前后，对 purchases、spend_grants、original_payments、resource_registry、wallet_accounts、monetary_controls 全行指纹比较一致。
- 安装到日常 Codex，原 MCP 配置段保持逐字不变；没有重启 Codex。

证据位于 `build.noindex/mainnet-plugin/host-final/evidence.json`、`daily-install.json`。真实 app-server 验收不是 Desktop 对话端到端购买验收。主网购买仍需具体 API、用途、金额授权与有效 Grant；`recover_payment` 可能继续原付款，不能作为普通查询。

## 构建与复核

```sh
node --test tests/plugin/mainnet-launcher.test.mjs
python3 -m unittest discover -s tests/release -p test_codex_plugin_package.py
python3 scripts/package-codex-plugin.py --mainnet --output build.noindex/mainnet-plugin/yosh-mainnet.zip
bash plugins/yosh-mainnet/scripts/launch.sh --check
```

将 ZIP 解压到本地 marketplace，并在 `.agents/plugins/marketplace.json` 登记 `yosh-mainnet`，source 为 `{"source":"local","path":"./yosh-mainnet"}`。本机保留的 marketplace 为 `~/.codex/plugins/yosh-mainnet-marketplace-v1`；安装命令为：

```sh
codex plugin marketplace add "$HOME/.codex/plugins/yosh-mainnet-marketplace-v1" --json
codex plugin add yosh-mainnet@yosh-mainnet-local --json
```

`scripts/test-mainnet-plugin-host.py` 在 `build.noindex/mainnet-plugin/marketplace` 已准备好后，仅进行真实宿主只读检查。它不更改日常 Codex 配置。

## 仍未完成

C 的本地网页仍是隔离 Devnet 页面；主网授权继续在原 App 完成。主网免 App 服务接管、网页原生可信授权、独立新 Agent 配对，需要同一权威服务的生命周期/版本兼容改造，不能靠修改 Devnet 标识完成。原 App 退出会使这个主网桥接不可用。未做本轮真实付款、主网恢复、双入口并发购买或 Desktop UI 验收；不把旧付款记录算作本轮通过。
