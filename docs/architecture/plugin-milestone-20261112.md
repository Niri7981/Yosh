# 插件版 0.2.3：Mainnet 购买里程碑

真实购买发生于 2026-11-12；本次代码归档验证跨至 2026-11-13（Asia/Shanghai）。本文件记录已完成能力、当次运行证据和归档边界。此前 B/C、App bridge、统一 Grant 与 RPC 文档是历史快照，不能用其中旧版本、进程或“尚未完成”描述代替这里的核对结果。

## 已完成范围

- 单一插件入口按每次调用显式选择 Mainnet / Devnet，拒绝缺失或不支持的网络，不在失败后切换网络执行。
- Mainnet 桥接原 Yosh.app 后台，复用原钱包、Keychain、Grant、共享额度、账本和付款恢复入口。MCP 是薄适配层，不持有管理授权或任意签名能力。
- 统一 Grant 网页先选择网络，再读取对应状态；冻结 API、付款钱包、网络、资产、收款方、金额和有效期，由原生系统确认后提交。Mainnet 不开放网页额度或暂停修改。
- 本地确认记录与 Grant / 控制操作原子消费，支持重放拒绝、并发和钱包开通结果核对；原 App 不传新确认参数的既有入口保持兼容。
- 只读购买查询按 Agent 身份及原购买标识查找，付款、交付和策略原因分别返回；交付分块读取不触发恢复或新付款。
- 官方 Pay SDK 的受控准备明确限定当前 custody 支持的 Solana v0；报价只支持 v1 时在执行前拒绝。没有改写报价、签名或结算协议。
- 后端诊断保存失败阶段及白名单 RPC / transport 错误码；不记录凭据、交易载荷或完整 SDK 请求。
- 现有 Offline / Dev 本地运行时具备独立身份、单 owner、版本目录、退出恢复和升级保护；构建及打包校验来源与内容哈希，不打包运行数据。

本次没有实现 **Mainnet Standalone Runtime**。Mainnet 仍依赖原 Yosh.app 启动后台；已存在的 Dev standalone 是当前插件依赖，不代表主网独立后台已完成。

## 磁盘安装与实际运行

| 层 | 本次核对结果 |
| --- | --- |
| 已安装插件及 MCP 入口 | `yosh-local-dev@yosh-standalone-testing`，0.2.3；缓存目录 `~/.codex/plugins/cache/yosh-standalone-testing/yosh-local-dev/0.2.3` |
| 插件运行目录 | `~/Library/Application Support/Yosh Local Authorization Runtime Dev/7fe7f03e5f54b9762c312f179b705f2dcce2d88a6494b102909d7ab4b2992cf5/` |
| 原生 App | `~/Applications/Yosh.app`，磁盘版本 0.1.1 / build 7；原生进程与后台均来自该安装位置 |
| Mainnet 后台 | App 内 `Contents/Resources/Runtime/backend/server.js`，loopback 13449；SHA256 `0abe092ac0d4c2a03d03a4f900a272327223b0c215c79ba4df355e245bfc165a` |
| 实际 Pay 二进制 | App 内 `Contents/Resources/Runtime/pay-mcp`；SHA256 `ef04a20cbe6ecbd63280bcbcf2ab9e98502f47699006cbc0af14bf53fda17823`，与插件运行包一致 |
| 源码中的旧 bridge 模板 | `plugins/yosh-dev` / `plugins/yosh-mainnet` 仍为 0.1.0，是保留的 App bridge 构建输入；统一 0.2.3 manifest 由 `scripts/package-standalone-plugin.py` 生成 |

0.2.3 是插件版本，不是 Pay 二进制版本。Pay 的 `--version` 在该隔离构建被 `ISOLATED_TEST_ONLY` 拒绝，因此以实际文件路径、源码来源和哈希识别，未声称取得 Pay 数字版本。运行包内部 `0.1.0-dev` 是另一层 manifest 标识。

## 已成功的真实购买

本节是本次聊天此前获逐笔授权的真实交易证据；归档测试没有再次购买，也没有恢复付款。

| 字段 | 值 |
| --- | --- |
| API | `agent402-crypto-price`，`https://agent402.tools/api/crypto-price?coins=BTC%2CETH%2CSOL&currency=usd` |
| 开始时间 | 2026-11-12 23:18:34.829 +08:00 |
| operationId | `yosh-plugin-023-mainnet-20261112-01a1cffd-03` |
| purchaseId | `pay_a59edaecf4cb08a6dbc45e8d4c73ce69bcad03a82bbf1b9b01307a7ffc00` |
| 金额 | `1000` 原子单位，6 位精度，即 0.001 USDC |
| 网络 | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| 收款方 | `J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg` |
| 原付款交易 | `2LmysSFNwG55apvtdLLE2gEeAZiaZuotmG5FUXDmM5tuezbdnghy7G6Z7aVwdSw3Te4JamQfphBTBvjivdf7P2DZ` |
| 持久状态 | `PAID`，delivery `COMPLETE`，receipt / original payment `CONFIRMED` |
| 交付 | 收到 BTC / ETH / SOL 的 USD JSON 数据，原交付保留在账本 |

插件及原 App MCP 的只读状态都返回同一个钱包、Grant v5、CardMember 和上述购买。成功后当日 paid 为 `1000`、reserved 为 `0`；不会把同一交易当作另一笔重新执行。

原始证据保持在忽略目录 `build.noindex/mainnet-retry-logs-20261112-01a1cffd-03/`，文件权限 0600；不把数据库、凭据、付款载荷或原始运行日志提交 Git：

| 本地证据 | SHA256 |
| --- | --- |
| `before-and-call.json` | `e84d412358ad386b76db2e11ee1729db96ccc4673143eeeca87e18db45157c4c` |
| `result-and-after.json` | `b98aea9fdd2ad9fe40566e1468370aa054e2567fd73f8f405fa1b51b4a11c64d` |
| `controller-diagnostics.json` | `1ad12a584710ea0d751d91818f93fd07529ff88ebfa82c70d3bc9110101ae7c0` |

本次成功有持久账本、确认回执和交付证据，但 trace 的 events 为空、binarySha256 为空、complete 为 false，不能声称每一步 telemetry 完整。此前两次尝试分别遇到 `UNSIGNED_PREPARE_FAILED` 和经 6074 代理的 `getGenesisHash` / `ECONNRESET`，最终未付款且没有遗留预占；不能据此判定 reset 来自代理还是上游。SDK unsigned prepare 仍丢弃原始原因，网络不稳定没有被本次提交宣称修复。

## 本次归档验证

精确命令、退出码和日志保留在 `build.noindex/plugin-milestone-archive-20261112/verification/`，没有访问真实私钥或执行新付款。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck`、`npm run lint`、`npm run build` | 全通过；Next 保留已有两条动态文件 tracing 警告 |
| 付款控制、RPC 诊断、购买只读查询 | 8 文件 / 110 测试通过，模拟网络及签名器 |
| 原 App 与 Mainnet Grant / client 兼容 | 2 文件 / 35 测试通过 |
| 启停、MCP 连接、暂停竞态、预算并发、原付款与交付恢复 | 8 文件 / 161 测试通过，临时数据库 |
| 插件环境、资源、授权页、确认记录及测试选择 | 10 文件 / 55 测试通过 |
| Offline 注册、故障与本地授权集成 | 3 文件 / 4 测试通过 |
| Python 构建、打包和最小 overlay 验证 | 31 测试通过 |
| Node App bridge launcher | 15 测试通过 |
| 当前源码 Rust `custody_version_tests` | 2 测试通过；`[0,1]` / `[0]` 构造全零签名 v0，`[1]` 拒绝执行 |
| 新构建 Offline runtime | 11 生命周期检查、6 安装/缓存检查、2 崩溃恢复场景通过；真实付款 0 |
| 原生验证 | backend launch、fake App Lock、Grant presentation CLI 全通过；macOS Debug 无签名构建成功，未启动或安装产品 |

上述测试共 413 个测试用例，另有表中运行时检查与原生 CLI / 构建。标准 `scripts/test-pay-integration.py` 因缺少默认位置的 prepared engine 在测试前拒绝运行；对应 110 项模拟测试改用等效 private HOME、loopback-only、拒绝 Keychain / 真实用户数据的 sandbox 执行。Rust 验证另外从与当前 overlay 哈希一致的 prepared source 重编译，未借用已安装二进制冒充源码验证。权限 fixture 的首次测试曾受测试执行器 umask 077 影响；以 fixture 预期的 022 重跑通过，未修改产品代码绕过检查。

macOS 构建有宿主 CoreDevice / CoreSimulator 版本警告，未阻止 macOS target；没有运行 Simulator。归档期间没有重做真人窗口、系统身份确认或已安装 App 的退出/重启验收，也没有重新运行付费 host acceptance。当前宿主实际只读调用了插件与原 App 的 MCP，两个入口均成功。

## 原 App 保护与保留工作

- 安装 App 的 22 个文件/符号链接归档前后保持一致；没有安装、替换、退出或启动正式 App。
- 主网账本只由原 `YoshBackendNode` 持有；插件 Mainnet launcher 仅启动 MCP 桥接子进程，关闭桥接不停止后台。
- `purchases`、`spend_grants`、`original_payments`、`resource_registry`、`wallet_accounts`、`monetary_controls` 六表的行数与内容 SHA256 前后一致。未复制生产状态至 Dev，没有更改钱包、授权、额度或账本。
- 原 App MCP 入口保持可用，原 Grant 入口、SDK、签名路径及恢复不变量通过上述回归；本次没有对安装 App 的 Keychain 条目读写或迁移。
- 只按审查后的显式文件列表暂存。工作树原始内容另有本地快照；桌面 main 的其他文档和提案未触碰。
- 两份未来规划文档、两个可行性构建/探针脚本、三个 probe 源文件和 `StandaloneKeychainProbe.swift` 留在本地未提交。旧 B/C 文档中引用这些探针的命令仅为历史记录，不是本 PR 的复现入口。

后续 Mainnet Standalone Runtime 应单独立项、实现和验收，不属于这次“插件版”PR；本次仅推送功能分支以建立 PR，不合并 main、不发布新版本。
