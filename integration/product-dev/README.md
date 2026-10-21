# Yosh × Pay 独立开发产品交付

> 2026-10-20 更新：当前使用现有 Codex Desktop，正式 Yosh MCP 已经用户授权暂时停用，保留配置。Dev 提供 curl 与 get_spending_status；不再交付独立 Codex 启动器。下文为此前阶段的历史记录，当前操作以 USER-STEPS.zh-CN.md 为准。

可运行产物：`/Users/irin/Desktop/Yosh Pay Dev/Yosh Pay Dev.app`；旁边有 `Open Isolated Codex.command` 和 `开始体验.md`。[六步用户说明](USER-STEPS.zh-CN.md) 是本轮验收入口。

## 已实现

- 独立 bundle `com.yosh.pay-development`、数据/锁/管理凭据/日志；原生界面复用现有 Connection、Authority、Grant、预算和购买记录。仅必要的开发标记，没有重做界面。
- 包内 Node、真实 Pay MCP、unsigned SDK 准备和协议解释器；运行不依赖源码、Vitest、归档 vendor 或开发机 Node 路径。实际 Codex 是用户已安装的 CLI/TUI，独立配置由专用启动器建立，不改现有配置。
- `scripts/pay-dev-backend.ts` → `startPayDevelopmentBackend()`：真正 AppRuntime，现有经过 HMAC 认证的管理 routes，现有成员 capability 认证、Authority Adapter、唯一 PurchaseLedger 和执行器。开发版旧购买入口拒绝 `PAY_MCP_REQUIRED`，Mainnet 切换拒绝。
- Pay 工具请求 → 原 do_paid_fetch / 402 选项 → 原 External Authority → `/pay/authorize` → 原 Yosh reserve/provenance → `/pay/plan` → Pay unsigned prepare → `/pay/execute` → Yosh 验证、签名、保存原证据/marker、最终 HTTP → 独立原款核对/交付持久化 → Pay 解释并返回数据。后台与测试商家各为独立运行服务，未使用 Mock AppRuntime。
- 本机模拟商家/链有持久原签名与交付事实，不是经济账本。不同购买使用新 blockhash，原款只扣一次；同 operation 必须保留原报价。新模拟器预检缺陷（赞助者零 SOL）已经先复现再修复；原失败记录未重置。
- 同进程重复请求的原 Pay `OPERATION_ALREADY_STARTED` 守卫保持；重开真实宿主后由 Yosh 对原 operation 严格恢复，不扩大 #514 或 ControlledExecution 的接口。重复 Connect 不轮换现有 capability 或撤销 Grant。
- 正常退出等待真实后端 drain；重启保留同一成员、Grant、Ledger、签名证据和原结果。原进程不可通过新 epoch 获得新提交权。

## 安全边界

开发开关还要求专用私有目录、私有 marker、固定离线身份；拒绝已有未标记 Ledger、SQLite/锁文件 symlink、非私有文件。只允许既有测试网络/资产与 literal loopback RPC。原生以 OS sandbox 启动后端并限制后代：拒绝外部网络、security/securityd、真实 Keychain、正式 Yosh/2049 数据与 Solana/Pay 配置。管理 secret 不交给 Pay，Agent caller 来自私有成员配置而非模型输入。Pay 不持有有效买方消费凭据。

真实生产仍 BLOCKED。本轮没有研究旧版本长期共存，没有安装或替换正式 App，也没有访问生产资金/数据、修改 #514、Commit 或 Push。这里只交付明确隔离的开发体验，不声称已解决生产升级准入。

## 实际软件验收

- 原生 Release 构建、包签名和真实启动 PASS；桌面 App PID/后端路径及认证 coreReady 见 `desktop-launch.json`。旧开发 App 正常退出且端口全停后才重包，无强杀。
- 真实 Codex app-server 发现并调用真实 Pay curl，独立新用例 `product-fixed-preflight-acceptance-1` 返回 API 数据，Yosh PAID/COMPLETE，金额 200000、只有一条已付款记录。
- 同 ID 跨 Codex 进程、跨原生 App 正常重启均返回完全相同的数据时间戳；最终账本仍一条已付，预占0、离线钱包9800000。证据 `codex-host-validation.json`、`desktop-restart-replay.json`、`final-app-state.json`。
- 真实 Codex Pause 拒绝 `PAYMENTS_PAUSED`、超预算拒绝 `DAILY_BUDGET_EXCEEDED` 均在真实 Ledger 留 DENIED，已付金额不增加。已恢复日预算1000000并取消 Pause，供用户体验。跨日后今日消费可为0，历史与 Grant 累计保持。
- 当前仅证明真实宿主工具调用；没有启动模型 turn、没有复制用户登录、没有把 GUI/API 自动化当作用户亲手验收。按用户最新要求不再使用 Computer Use。六步手验及独立登录仍由用户完成。

## 自动化与构建

- `full-regression.log`：主套件89文件/1083项、原 Phase 2 独立15项、Node native3项，共1101项通过、0失败。
- `pay-regression.log`：真实 Pay 163项通过、既有1项helper忽略；clippy/check/fmt通过。单项结果保存在 `build.noindex/pay-mcp-target/verification-*.log`。
- 原生配置/App Lock 回归见 `native-configuration.log`、`native-app-lock.log`；独立 Codex 配置与真实 Pay binary gate各3项通过，见 `codex-host-validation.json`。
- `typecheck.log`、`lint.log`、`build.log`通过。产品 bundle 由 `scripts/build-yosh-pay-dev.sh`构建并复制到桌面，源码/产物版本见桌面 `build-provenance.json`。
- 新增 `pay-dev-runtime.test.ts`实际启动独立后台，通过真实管理 routes、真实 Rust Pay、真实 Grant/Ledger，验证购入/拒绝/重放/重启。`pay-dev-offline-services.test.ts`五项验证独立模拟器及真实预检。
- 初次 full 失败是模拟赞助者余额缺陷，随后另一次失败是测试误要求原 Pay 同进程守卫允许重放。保留 `full-regression-initial.log` 与 `full-regression-before-guard-assertion.log`，最终测试既验证明确拒绝无重复消费，也验证新宿主取原款，没有关闭或放宽守卫。

## 修改与复跑

`files.json`列出本轮10个修改文件、11个新增文件与指纹；`yosh-product-dev.patch`是相对上轮实际 dirty 状态的独立增量，并已 apply-check。`native.patch`和`pay-dev-host-gate.patch`可分别审阅；后者只改专用 host 开发准入，不更新 PR #514。不将此前底层实现重新计作本轮新增。

完整测试：`python3 scripts/test-pay-integration.py --all`。Rust：`python3 scripts/build-pay-mcp-first.py --test`。开发包：正常退出开发 App 后执行 `scripts/build-yosh-pay-dev.sh`。不运行正式 App 安装脚本。

交付到此停止，等待用户亲手验收。
