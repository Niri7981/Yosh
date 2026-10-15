# Conditional Mainnet execution（P0 第七步）

后续状态：原生 App/MCP 产品入口已在另行授权的 [guarded Mainnet product entry](mainnet-product-entry.md) 阶段接通。本文保留第七步当时的边界与验证证据。

日期：2026-10-06。仅实现条件式后端执行门禁，未执行真实 Mainnet 付款、充值、钱包创建或付费商家调用，未改造 UI。

## 1. 本轮文件

- 配置：`.env.example`、`src/modules/app/yosh-configuration.ts`、`src/modules/payment/payment-environment.ts`、`src/modules/payment/payment-config.ts`。
- 门禁和签名：购买侧 `src/modules/purchases/production-execution-gate.ts`、`purchase-signing-authorization.ts`；付款侧 `src/modules/payment/payment-preflight.ts`、`wallet.ts`、`solana-payment.ts`、`resource-challenge.ts`、`original-payment-evidence.ts`、`read-payment-json.ts`（后五个也在 `src/modules/payment/`）。购买侧提供同步签名授权能力，付款适配器不再依赖具体 PurchaseLedger。
- 授权、执行和恢复：`src/modules/purchases/purchase-ledger.ts`、`monetary-scope.ts`、`mainnet-authority-migration.ts`、`approved-payment.ts`、`delivery-recovery.ts`、`request-registered-resource-purchase.ts`（全部在同目录）。
- 新测试：`tests/unit/mainnet-execution.test.ts`、`mainnet-signing.test.ts`、`mainnet-sdk.test.ts`。
- 更新前序断言：同目录的 `app-management.test.ts`、`durable-delivery.test.ts`、`monetary-ledger.test.ts`、`payment-environment.test.ts`、`production-x402.test.ts`、`purchase-mode-isolation.test.ts`、`spend-grant.test.ts`。
- 文档：本页、`plan.md`。
- 验证配置：`vitest.config.ts`、`eslint.config.mjs`，排除 `build.noindex` 中的旧源码快照和构建产物。

工作区原有前六步的未提交改动保留。本页只记录第七步的增量，没有提交或推送。

## 2. 被替换的 blanket blockers

- `assertPaymentExecutionEnabled` 的 Mainnet 一律拒绝改为显式生产开关检查。
- 配置加载不再将读取合法 Mainnet 身份等同于执行付款；Mainnet 配置独立要求专用钱包、登记资源和显式 facilitator。
- 账本的临时 Mainnet authority 禁令改为明确的 scope 校验、缺省暂停/无额度、强制 managed + SpendGrant enforcement。
- reserve、claim、实际签名守卫、原付款证据写入、链上确认/失败、PAID proof、启动恢复及交付恢复支持同一个 `live_mainnet` 流水线。
- 执行器不再硬编码 `live_devnet` claim；不再为 Mainnet 禁止买方 RPC 对账和已付款交付恢复。

现有原生 App runtime、Demo/测试资源请求入口仍是测试用途，其 Mainnet 限制保留。生产门禁由新的**内部后端登记资源请求服务**进入既有执行器；本阶段没有把测试资源或测试控制界面升级为生产入口。

## 3. 新的生产执行门禁

`YOSH_ENABLE_MAINNET_EXECUTION=1` 是唯一启用值；省略、空值、`0` 均不启用，其他值及冲突别名拒绝。单独开启开关而选择 simulated/Devnet 也拒绝。开关不代表用户同意某笔付款，不修改授权或额度。

Mainnet 后端配置必须独立提供 `YOSH_MAINNET_WALLET_PUBLIC_KEY`、`YOSH_MAINNET_RESOURCES` 和 `X402_FACILITATOR_URL`。资源注册是有运行时 schema 的后端 JSON 数组；Agent 请求只能选择 resource ID、提交稳定 request ID 和用途，不能提供配置、报价或同意标记。Mainnet 不读取 Demo buyer/recipient 默认值，不使用公共测试 facilitator 默认值。

执行前按以下顺序验证：

1. immutable `PaymentEnvironment` 是 `live_mainnet` / `mainnet-beta`，Mainnet genesis、官方原生 USDC mint、classic SPL token program 和六位精度一致，生产开关明确开启。
2. 登记资源匹配批准记录的 resource/provider、完整 HTTPS URL/method/headers/body、delivery capability、network/mint/recipient 和 exact amount；完整 challenge、quote fingerprint、buyer 执行绑定不能改变。生产请求不走 Demo operation/resource-scope 的兼容覆盖。
3. 事务式 reserve 与唯一 claim 成功；同一 Mainnet monetary scope 有有效每日额度、未暂停、活跃 SpendGrant、有效成员、精确 scope 和足够单笔/累计授权；没有冲突的 PAYING/PAYMENT_UNKNOWN。
4. 加载既有独立 Mainnet Keychain signer；真实地址匹配 `YOSH_MAINNET_WALLET_PUBLIC_KEY` 和批准 buyer，禁止旧 Demo 密钥来源或与 test wallet 同身份。
5. 只用选中 RPC 核对实际 genesis、mint/program/decimals、买方/收款方标准 ATA 的 owner/mint/initialized 状态、足额 USDC，以及 facilitator 在同网络对报价 sponsor 的支持和 SOL 余额。禁止 buyer-paid fees。
6. 官方 SDK 创建 unsigned transaction；Yosh 复用原付款证据已有的有界交易检查，在签名前核对 exact transfer、mint、双方 ATA、signers、sponsor、memo 与允许程序，并进行 simulation。simulation 后再同步核对暂停、退出、额度、grant 和不可变绑定，才进入实际 signer。每个 SDK 调用只允许一个生产签名边界；已经保存 payload 的批准不能再构造替代付款。
7. 同一个账本保存原 payload、买方签名/message identity、blockhash/lifetime 和 submission marker；首次提交前再次核对授权。未知提交保留预占和原凭据。

协议构造继续使用锁定的 `@x402/core` / `@x402/svm` 2.25.0：`x402Client` 的 asset/spend controls 与 policy、`ExactSvmScheme` 和选中 RPC。Yosh 的 signer wrapper 承载本地授权、simulation 和签名前检查；没有自建 wire format、transaction construction 或 settlement protocol。

RPC/preflight 的 Yosh HTTP 读取有超时、禁止重定向和 256 KiB streamed response 上限；错误不回显原始 RPC 或 simulation 内容。

## 4. 显式 Mainnet authority

- Mainnet daily control 写入必须明确指定 `live_mainnet` monetary scope；初始化 daily limit 不自动解除暂停，另需显式 resume。
- Mainnet SpendGrant 创建必须明确指定 Mainnet mode、network、原生 USDC 和 precision，并绑定具体 registered resource/provider/operation/recipient。没有自动默认 grant 或额度。
- Mainnet 默认单笔策略额度为零；只有当前明确创建的 SpendGrant 可以在有效日额度内覆盖单笔执行。
- `010_mainnet_authority_activation` 是一次性增量迁移：启用前任何 Mainnet control 保持暂停并清除旧额度，旧活跃 Mainnet grants 被撤销；保留购买、原付款证据与预占。Devnet/simulated controls/grants 不改写。迁移后新明确创建的 Mainnet authority 跨账本重启保留，不反复清空。
- Agent 无 grant 或 daily control 管理入口，普通 `approved: true` 不能建立授权。现有 App 仍不会借环境选择自动创建 Mainnet 钱包或主网 grant。

## 5. 测试状态不能授权主网的证据

monetary scope 包含 execution environment、固定 Keychain wallet identity、network、mint 和 precision。Mainnet 使用专用 Keychain identity；test/legacy scope 无法映射成 Mainnet scope。

自动化证明：Devnet 和 simulated grants 即使 grant ID/version/member 有效，也在 Mainnet reserve 时得到 `SPEND_GRANT_MONETARY_SCOPE_MISMATCH`，且没有 signer、SDK 或付款 HTTP 调用；Mainnet 自身错误 resource/provider/recipient 与不足授权也在签名前拒绝。只改 ambient 环境不会复制存储的测试额度、grant 或记录。

未知付款 fixture 保存原凭据后跨 SQLite 重启、暂停及关闭生产开关完成原交易对账和交付；原 SDK 构造和 signer 均只调用一次，恢复复用原 PAYMENT-SIGNATURE。恢复不需要新 grant 或执行开关，也不生成新付款。

## 6. 本轮验证

本轮实际验证：

- `npm test -- --reporter=dot`：53 个测试文件、665 个测试全部通过。含 41 个新增 Mainnet gate / signing / official SDK 用例。`vitest.config.ts` 排除 `build.noindex` 中的旧源码快照，全部项目测试正常执行。
- `npm run typecheck`、`npm run lint`：通过；lint 也排除生成的 `build.noindex`。
- 安装脚本中的 `npm run build`：Next.js production build 通过；现有 MCP 动态文件 tracing 有两条非阻断 warning，未在本阶段扩大重构范围。
- 原生 macOS Release：`** BUILD SUCCEEDED **`。Xcode 报告 CoreDevice/iOS simulator 工具版本 warning，但当前 macOS 编译成功，未使用 simulator。
- 旧 App 正常退出，后端 PID 56039 收到 graceful shutdown 后退出；没有强制终止付款服务。
- `scripts/install-macos-app.sh` 更新 `/Users/irin/Applications/Yosh.app`；安装版与本轮 Release 产物完整 diff 一致，`codesign --verify --strict` 通过。
- 重新打开后实际 App PID 58635 来自上述安装路径；当前后台 PID 58739 是该 App 子进程，监听 `127.0.0.1:3049`，本轮日志确认 `Backend ready`。当前原生界面显示 Connection / Not Connected / Test environment Solana Devnet，没有开启 Mainnet。
- 未认证 `/api/app/health` 请求得到 HTTP 401。前端 `.next/static` 未发现新签名实现、Mainnet Keychain 调用或敏感配置标识；`git diff --check` 通过。

所有 Mainnet 交易测试都只使用临时 fixture signer、mock RPC/facilitator/merchant 或官方 SDK 构造结果。未创建 Keychain Mainnet 钱包，未充值，未提交任何主网交易，未调用线上付费商家；没有真实 Mainnet 宿主购买验收证据。

## 7. 首次真实 Mainnet 付款前仍需完成

- 另外取得具体 API/收款方、用途、金额上限的真实付款授权。
- 确认真实第三方资源和 facilitator 的 Mainnet sponsorship/settlement、token account/balance 及原凭据恢复能力；本轮全部是 fixture，未验证其线上可用性。
- 明确配置既有独立 Mainnet 钱包、资源、daily authority、SpendGrant 和生产开关。当前安装配置未开启主网付款。
- 生产资源管理、原生 App/MCP 的生产入口与展示仍保持后续范围；当前原生 runtime/测试资源入口没有被开放为 Mainnet 产品界面。内部后端服务可在严格门禁下到达同一个执行边界，本轮不宣称已完成真实宿主 Mainnet 验收。

本阶段停止在条件式后端执行启用；不把这些配置说明或 fixture 当成付款授权，不进入 UI redesign。
