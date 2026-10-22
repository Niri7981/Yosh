# 同一个 Yosh Pay Dev 的环境选择

本轮产品入口仍是现有桌面路径 `Yosh Pay Dev/Yosh Pay Dev.app`，Bundle ID 仍是 `com.yosh.pay-development`。不使用此前独立 Mainnet 候选包作为开发产品，不创建第二个安装版、不更新正式 Yosh，不改 Codex 配置。

## 用户操作

1. 打开原位置的 Yosh Pay Dev → Settings → Environment。
2. 选择 Solana Mainnet，阅读并确认真实资金提示。RPC 默认 PublicNode，可在此修改 HTTPS RPC 并保存；请求仍经过原有安全网络策略。
3. Settings → Wallets → PAYMENT WALLETS 下的 **Create Wallet**。确认后走原 `initializeEnvironmentWallet` 的创建、create-only Keychain 写入、读回验证和公钥固定流程。首次创建为空钱包；本轮不自动创建实际钱包，不转账、不签交易、不购买。
4. 环境改变后在 Codex 重新连接 Pay MCP（必要时重启 Codex），仍用同一 `yosh_pay_dev` 配置条目。旧进程捕获的 capability 不跨环境重绑定；新进程从同一个 Dev 根目录读取当前选择。

## 隔离与默认拒绝

- Offline 保留原数据目录、离线私钥、模拟器、原购买记录和 Pay 执行路径。
- Mainnet 使用其下独立 `Mainnet/`，同一 PurchaseLedger 实现，但数据库、owner/epoch、Connection token、Grant、operation、付款证据与恢复状态均不跨目录共享。新建 Mainnet store 不导入正式 Ledger；已存在而未标记的 DB、危险 symlink 直接拒绝。
- 钱包在 macOS Keychain 中使用独立 **Dev 条目命名空间**：`com.yosh.pay-development.wallet.mainnet.v1`；辅助钱包也使用 Dev namespace。不会访问正式 `com.yosh.wallet.mainnet.v1`、旧测试钱包或正式钱包库项。不声称创建了第二个 macOS login Keychain 文件；隔离由固定服务名、可信 Dev 启动配置与私有目录校验共同实现。Offline 仍禁止 Keychain。
- WalletAccounts 保存实际 Dev credential reference，不把 Dev 身份写成正式 Keychain 来源。缺失已有固定身份只允许恢复，不会用 Create Wallet 替代旧款钱包。并发或重放创建复用同一固定槽，未创建第二个 signer。
- Mainnet 初始 `YOSH_ENABLE_MAINNET_EXECUTION=0`，预算未设、Pause 开启、没有 Grant。选环境或创建钱包均不改变这些事实。原 Mainnet 逐笔 operator receipt、quote/request/full-challenge 绑定、unsigned 验证、真实 signer loader、原证据/marker、最后 HTTP、原款恢复均保留。

## 真实生命周期

Settings 调用 `NativeServiceRuntime.switchDevelopmentEnvironment`，先请求原 authenticated management lifecycle 的 `prepareEnvironmentSwitch`。真实 AppRuntime 同步检查 active、Unknown 与预占，无 await 间隙地 fence，然后执行原 prepareQuit。native 等待旧进程正常退出，才原子保存选择，清除缓存凭据并启动同一个包中的后端。根目录 native instance lock 不随环境变化。

Unknown/预占会拒绝切换；不会为切换释放预算、删除原证据或替代付款。返回原环境复用原钱包/预算和数据库，旧 epoch 不复活。MCP 始终通过原 Pay curl → do_paid_fetch → Authority → ControlledExecution；共用 Dev 管理服务器只转接原管理 handler，没有另写支付 runner。

真实原生测试暴露并修复两个启动边界：macOS 临时 HOME 的 Foundation 路径规范化与 Node realpath 不一致；Native `PORT` 与 Authority `YOSH_PORT` 描述信息不一致。现按 POSIX canonical path 和同一 validated listener 绑定，保留 symlink 拒绝。端口问题的失败和通过记录为 `native-port-red.log` / `native-port-green.log`。

## 验证与限制

- 新 `pay-dev-environments.test.ts` 六项：真实 AppRuntime 的未授权创建拒绝、显式创建/并发/重启复用、正式项不变、缺失原钥拒绝替换、已存在 DB/symlink 拒绝、风险/配置篡改拒绝；真实 Pay stdio 在同一 MCP 条目下发现 Mainnet curl；Unknown 及预占重启后仍阻止切换。Keychain 命令由内存测试替身接收，OS sandbox 同时禁止访问真实 Keychain。
- `PayDevelopmentEnvironmentLifecycle.swift` 使用真实 NativeServiceRuntime、实际打包 backend、临时 HOME，在同一固定开发端口完成 Offline → Mainnet → Offline，验证三次进程代次、凭据隔离和原预算恢复。使用更严格的单层测试 sandbox 禁止 Keychain/生产数据/外部网络；实际两种产品 sandbox 的选择另由 native 配置测试覆盖。未创建实际 Mainnet 钱包。
- 留存测试失败日志：初始 runner 选择错误、测试 HTTP keepalive 在刻意重启后的连接复用、测试 fixture 的 registry 格式修正、嵌套 sandbox 被 macOS 拒绝，以及上述 canonical path/端口回归。未降低资金检查、超时或断言来伪造通过。
- 当前真实 Keychain 的系统确认、用户亲手点击 Create Wallet 和视觉验收仍由用户执行；自动化测试不代替这些事实。真实 Mainnet 支付继续等待明确的商家、网络、钱包、金额与逐笔批准。

最终检查、构建与原位置更新事实见 `validation.json`；本轮独立 diff、源码哈希及范围见 `dev-environments.patch` / `changed-files.json`。无 Commit、Push、App 正式升级、真实付款或生产 Ledger 迁移。

## 本轮最终交付事实

- `full-regression-delivery.log`：1137 主测试 + 15 原款恢复 + 3 安装配置测试，共 1155 passed、0 failed；1 项显式 opt-in 的真实公开 Mainnet 预检未重复运行。
- typecheck、lint、Next build、Native Release、native 配置测试及最终打包后的真实 native/backend 环境往返均通过。
- 原 Dev App 正常退出、后端与 13049 停止后，原子更新同一桌面位置，原包保留在工作树的 ignored build 目录以备回退；没有另装一个 App。重新打开后核对真实 native/backend 路径、签名、源码产物指纹及 authenticated health/coreReady，当前仍是 Offline。
- 原生往返测试未运行 App GUI。真实窗口已经打开，但视觉检查与实际 Keychain 系统确认留给用户。没有创建实际 Mainnet 钱包，没有签交易、付款或转账。
- RPC 修改与环境选择使用同一 idle gate；存在 Unknown 时不能通过此控件切换 RPC，原款和预占继续保留，不自动替代。
