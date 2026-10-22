# Mainnet 执行接线交付（2026-10-20）

本轮在现有隔离工作树续接实现，没有更换协议 runner、增加 Ledger 或访问正式 App、钱包、Keychain、Codex 配置和生产数据库。生产仍未启用。候选包只构建、签名校验，未安装或运行；不能把本轮称作 Mainnet 购买成功。

## 实际完成

- `pay-authority-adapter.ts` 使用真实 AppRuntime 的 Connection、Grant、Daily Authority 和唯一 PurchaseLedger；原子 reserve 携带持久 external provenance，claim/sign 检查传递同一 permit。Mainnet 仅允许现有注册资源、GET、原网络/USDC/收款方/金额，并校验真实请求；不重排查询、不另行获取替代报价。
- `mainnet-pay-execution.ts` 接入原 `loadBuyerSigner`，复用原 unsigned 绑定验证与原款执行、证据、提交、核对、交付/恢复。Pay 仅构造 unsigned。Yosh 核验真实 RPC genesis、blockhash、余额/账户、模拟和签名身份，严格检查签名前后及发送前 Pause/epoch。
- Mainnet 需 `YOSH_PAY_MCP_MAINNET=1`、原 Mainnet execution 开关和逐笔私有 operator receipt。receipt 绑定 caller、operation、wallet、network、mint、recipient、原子金额和 request/quote/full-challenge hash、期限；在授权和签名前/提交前复核。不是 Agent 的 approved 参数；管理命令没有 MCP/API 暴露。此文件依赖同一 OS 用户的管理权限边界，不声称抵御该用户本身恶意改配置。
- `src/app/pay/[action]/route.ts` 是薄认证 handler，调用真实 `AppRuntime.payMcpOperation`。共享 MCP wrapper 使用可信宿主 Connection 身份、真实后端、退出租约与已存在的追踪。Rust 使用 Yosh 提供的 lifetime，不拥有钱包或另行向 Mainnet RPC 构造新付款。
- 真实报价发现 SDK Rust 保留 offer `outputSchema`、JS 校验投影会丢弃该信息。现在只显式接纳此声明字段，仍由官方 SDK 验证；完整 challenge 进入授权 hash。历史 JS 记录继续原投影规则，不改写旧证据。

## 停旧启新与恢复

`preparePayMainnetCutover` 要求原 native/backend PID 已退出、CLI 验证端口关闭，并取得既有目录 owner lock。对原 SQLite 创建一致归档，保留源 DB/WAL/journal，校验所有权和 symlink；不删库、不替换、不重新签名。prepared receipt 保存源 DB+WAL/journal 摘要。新 Runtime 持有 owner 后，先验证并持久 admission，再开原 Ledger/执行既有 migration。已切换目录缺 Pay 启用标志则拒绝启动，避免回落原 JS 付款入口。正常未切换目录保持原路径。

本轮真实 SIGKILL 子进程留下 WAL 的测试证明已提交的历史额度进入归档。付款测试证明保存原签名后 Unknown 不释放预算，重启只核对原款，确认与交付只记一次，未新增签名；Pause 在 signer 等待期间发生则阻止签名，Resume 不恢复旧提交权。既有 marker 后 SIGKILL、已开始 HTTP、丢 ACK、解释失败等测试也在全回归中通过。停旧启新是运维约束；本轮没有开展或宣称支持任意旧版本重新启动后长期共存。

## 真 Mainnet 无资金证据

`live-mcp-preflight.json` 与 `live-mcp-diagnostic.json`：真实 Pay MCP stdio `tools/call(curl)` → 原 `do_paid_fetch` → 真实 Agent402 402 报价 → External Authority → 真 AppRuntime/Grant/Budget/Ledger reserve → ControlledExecution → SDK unsigned → Yosh unsigned 校验 → PublicNode RPC。

身份为随机生成的公钥字节，没有对应私钥或资金。RPC 检查因无 token account 返回 `BUYER_TOKEN_ACCOUNT_UNAVAILABLE`，购买停在 `FAILED_BEFORE_SIGNING`。signer/真实 Keychain 调用均为 0，无签名证据、无携款 HTTP。测试使用临时数据，禁止系统 Keychain 的 OS sandbox；没有 Mock Authority。live 测试只注入公开钱包身份和余额清单以进入真实业务入口，不能证明正式钱包就绪或真实签名器权限。

原始控制链：

1. Pay `tools/curl.rs` → `do_paid_fetch`（core client/fetch）完成 HTTP、报价选择、authority hook。
2. Yosh `/pay/authorize` → `AppRuntime.payMcpOperation` → adapter `authorize` → `requestPaidResourcePurchase` / `requestRegisteredResourcePurchase` → `PurchaseLedger.reserve`。返回同一购买和执行 permit；重放比较完整事实后只恢复原操作。
3. `/pay/plan` → adapter `plan` → `readPayMainnetLifetime`；Pay `controlled.rs` 用原 pay-kit unsigned prepare，不签名。
4. `/pay/execute` → adapter `execute` → `executeApprovedPayment` 取得唯一 claim → `createMainnetPayExecution.prepare` 校验、预检、调用原 `loadBuyerSigner`。真实 Keychain 分支只完成代码接线，本轮未执行。
5. 同一个 `executeApprovedPayment` 保存原证据及 lifetime，执行最终 gate、持久 marker，再由 Yosh 原 transport 发出携款 HTTP。Pay 继续解释响应。
6. `reconcileApprovedPayment` / `recoverApprovedPayment` 查询原交易、独立记账和恢复交付。未知保留证据和预占，不替代、不重新签名。

## 验证结果与范围

- `full-regression-serial.log`：1131 passed、1 opt-in live skipped；另 15 项原款恢复和 3 项 node 安装配置测试通过，合计 1149 passed。本轮新 Mainnet controlled 5 项包含其中。
- `live-mcp-preflight-verified.log`：单独显式运行的真实公开 Mainnet 无签名预检 1 passed。
- Pay `pay-regression.log`：170 passed、1 原有 ignored；clippy/connect check/fmt 通过。
- `typecheck-delivery.log`、`lint-delivery.log`、`build-delivery.log`、`native-launch.log` 全通过。
- `staging-final.log`：最终源码候选构建及 codesign strict 校验通过；manifest 标记 installed=false、launched=false、productionEnabled=false。
- 留存真实失败过程：outputSchema/WAL 的 red 测试；开发中类型/测试修正日志。`full-regression-delivery.log` 曾在并发 Next 构建期间出现两项未修改测试的启动/超时失败；随后无并发构建的完整 serial 回归全部通过，未放宽断言或超时。此前另一全回归也通过。

## 后续人工验收（本轮未执行）

先由用户明确商家/API、原子金额上限、Solana Mainnet 与钱包公钥；核对真实 Connection、Grant、预算和当前报价事实。获得升级授权后，正常退出旧 App，等待后端安全停止；运行已打包的 cutover 工具保留原账本，按既有安装流程更新同一路径并配置显式 Pay Mainnet profile，核对运行产物与恢复状态，再写入精确逐笔确认并发起首笔。

候选位置：`build.noindex/mainnet-execution-delivery/Yosh.app`，内置 Node、Next 后端、Pay、MCP wrapper 和两个 operator 工具，无源码目录运行回退。当前已安装 Dev 仍不等于该候选。实际 Keychain 系统确认、正式数据 migration/恢复以及商家链上结算必须在获准的正式验收中核实；本轮临时数据库/离线密钥测试不能替代这些事实。任何 Unknown 保持原 operation，不能为再次尝试更换 ID。

本轮改动清单及哈希见 `changed-files.json`；`yosh-mainnet-execution.patch` 和 `pay-mainnet-execution.patch` 是相对本轮开始源码快照的独立 diff，保留之前未提交成果，不是相对历史 HEAD 的全量补丁。未 Commit、Push 或修改 PR #514。
