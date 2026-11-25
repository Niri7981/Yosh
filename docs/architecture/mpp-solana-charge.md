# MPP Solana Charge：隔离实现与验收边界

初始记录：2026-11-16，隔离实现通过独立验收。2026-11-17 已补充插件 Mainnet 实付及新 Codex 宿主验收，详见[当前验收记录](../demo/mpp-mainnet-plugin-20261117.md)。下文保留各阶段当时的验证边界，不能把历史未完成项当作当前结论。

本阶段以 `main` 的 `a86b184` 为基线，在 `codex/mpp-solana-charge` 独立工作树开发。原工作树及 `codex/alipay-executor` 中的未提交工作完整保留，仅复用经过核对的 Payment Domain Routing 代码。完整源码快照、包含新增文件的 diff、测试日志及独立审查记录保存在本地交接材料中，不随源码公开。Git 归档不安装 App、不启用生产支付，也不运行产品数据库迁移。

## SDK 与执行归属

MPP parser、unsigned Charge builder、credential formatter、receipt parser 复用锁定的 Rust SDK。`scripts/build-mpp-protocol-engine.py` 从 Git 对象导出并核验来源，使用离线 vendor 与 `cargo --offline --locked`，不把上游当前分支或相同版本号当成锁定证据。

| 依赖 | 锁定来源 |
| --- | --- |
| Pay | `402f67c44dd8d41d7d1584fcb5d868006ce8c891` |
| pay-kit | `7f1369180ca4b047aadff1bea77aed4525e10039` |
| solana-keychain（vendor） | `44b479df245167ca3b3a4e04d6d907146306d342` |

pay-kit 的锁定提交来自 Niri7981 fork，不能称为未经修改的官方 release。独立审查将其与官方基线 `3b7e856` 比较：MPP 源码一致，代码差异位于 x402 exact client preparation。本阶段复用该基线的 MPP 实现，不升级到未经核验的上游状态。

构建产物的 `source-lock.json` 记录 wrapper、builder、源文件/vendor inventory 和实际 binary SHA256。旧 `build-pay-protocol-engine.py` 的历史 archive pin 与本阶段不同，不混作 MPP 构建证据。构建仍需可用的锁定 Git 对象和离线 vendor；不能由本文件推断任意机器均可直接构建。

协议子进程只执行 `mpp_parse`、`mpp_prepare`、`mpp_encode`、`mpp_receipt`。它没有钱包、消费授权、账本或付费 HTTP transport。unsigned builder 使用宿主已验证的 lifetime 和只回答该 blockhash 有效性的 SDK RPC transport；不签名、不广播。签名仍由 Yosh 后端既有 signer 负责，credential 仅由 Yosh 的受控 HTTP 请求发送。

## 数据与授权

`MppChargeQuote` 是显式 MPP 结构，不伪造 x402 `accepted` 或 `PaymentPayload`：

```text
protocol: mpp
method: solana
intent: charge
scheme: mpp_charge
network, asset, payTo, amount
challenge: SDK 返回的原始 echo 对象
challengeHeader: 原始有界 WWW-Authenticate 字符串
expiresAt: 绝对到期时间
```

新的 `SpendIntent.mpp` 保存这一经过校验的 quote，同时绑定原始 HTTP request、Resource/Provider、经济条件、quote hash、execution binding 和 Grant ID/version。MPP 要求 HTTP request，拒绝同时携带 x402 challenge/header、历史测试 offer/path/scope。旧 intent 不增加默认字段，不重写历史 JSON 或 hash。

持久付款载荷为 `{ protocol: 'mpp', quote, credential, transaction }`。`savedPayload()` 保持 x402 专用并拒绝 MPP，`savedMppPayment()` 只读取 MPP。保存 MPP 必须同步提供原付款 identity；quote、credential echo、签名交易、request、scope、payer/payee/mint/amount 均须一致。通用购买/交付查询不能返回 credential 或签名交易；交付内容仍拒绝完整 credential、其编码和签名 wire。MPP 单签名交易的 buyer signature 就是已公开的交易 ID，允许出现在交付正文或浏览器链接中；x402 部分签名材料的既有拦截不变。

所有付款仍进入同一 `PurchaseLedger`、原子 reserve、unique claim、execution fence、`original_payments`、账务和交付状态机。同一 environment/wallet/network/mint/decimals 使用原有 `monetaryScopeId`，不把 protocol 加入该 hash，因此 MPP 与 x402 共用既有 daily budget。MPP 的 external execution facts 进入现有 `external_pay` 来源，不冒充 `js_x402`。

只有 APPROVED reserve 才在同一 SQLite 事务中领取 `mpp_challenge_claims`：唯一键为 monetary scope、原始请求的 merchant origin、realm、challenge ID，并持久绑定 purchase ID 与原始 challenge header hash。不同 requestId 不能为同一单次 challenge 取得第二次执行权；重启或终态失败也不回收该 claim。新购买需要商家签发新的 challenge。该表是幂等证据，不计价、不拥有预算。

不同 challenge 也可能构造同一交易：当付款条件、blockhash 和 Memo 相同，签名结果相同。因此原付款证据另外按网络与已验证交易签名建立数据库唯一约束，在第二笔凭据发送前原子拒绝重复归属。该约束不包含商家、Grant、challenge 或预算 scope，失败后也不回收原交易归属。已有 MPP 证据在重启时接受同样检查；若历史数据已有碰撞，拒绝迁移并保留原记录，不自动选胜者或重付。x402 专用数据库不新增这项 MPP 迁移。

旧 `paymentScheme: exact` Grant 不覆盖 MPP。新 `mpp_charge` Grant 必须单独同意 `maximumNetworkFeeLamports`，金额是正整数字符串；USDC 额度不能被解释为 SOL 手续费授权。费用条款通过首次创建 MPP Grant 时的显式事务迁移保存在不可修改的 `mpp_grant_terms` 关联表。它不是第二套预算账本，不重建 `monetary_scopes` / `spend_grants`，仅使用 x402 的数据库不因此创建该表。签名前的 RPC fee estimate 必须在原 Grant 的费用上限内，并验证余额、交易形状与模拟结果。

隔离授权页面仅在已注册的 MPP Resource 上显示每笔 SOL 网络手续费上限，以整数字符串提交 lamports。`AppRuntime.freezeLocalGrant()` 将上限写入冻结的 `binding.scope`；网页复核、结果和授权历史读取后端冻结值，`commitLocalGrant()` 再将同一值交给 `createSpendGrant()`。修改费用、缺少费用或向 `exact` Grant 注入费用均被拒绝；确认单与 Grant 在同一事务中消费/创建，不能二次使用。原生确认的 NSAlert 明细和 LocalAuthentication 提示均显示精确 lamports 与 SOL 换算。原生 helper 拒绝无效费用；Mainnet MPP 必须同时绑定主网钱包、网络、资产和明确的 SOL 费用上限。现有 x402 授权字节及不含费用字段的展示路径保持兼容。

## Router 与恢复

Payment Domain Routing 只从保留工作树借用薄 descriptor/router/alias 结构及针对性测试；不引入任何 Alipay import、CNY schema 或其共享表迁移。默认 x402 executor 保持原 alias 调用。新 route 为 `onchain / solana / mpp_charge / pay_mpp_solana_charge`；两条 onchain route 按 executor 判别。

`routeStoredApprovedPayment` 依据 Ledger 中不可变的 intent/quote 选择回调。客户端不能选择 executor，也不存在跨协议失败 fallback。现有 Pay adapter 的 x402 execute 调用经过兼容 Router；`request-mpp-resource-purchase.ts` 也调用这一持久记录 Router，再进入专属 MPP 受控执行入口和相同 Ledger。

签名载荷先持久化，唯一 submission marker 在首次发送之前写入。提交后超时保留 UNKNOWN 和预占，查询原签名与原 message；不得重新签名、换 blockhash、换 request ID 或改用 x402 再付款。恢复继续复用原购买及原 Grant/version。

商户响应带有匹配原付款的成功回执时，Yosh 立即校验并保存资源正文。购买者可凭原购买编号读取已保存的结果，交付状态为 `COMPLETE`。独立的链上核对仍在进行时，原付款保留预占额度。核对确认后，账本记为 `PAID`。仅有回执时仍需取得有效正文才能完成交付。

插件的 `recover_purchase_delivery` 接收原购买编号，由本地后端核对 Agent、钱包环境和已确认交易。资源声明了 `payment_identifier` 时，后端优先向绑定的查询端点取回结果。其他受支持的 MPP Charge GET 使用已保存的原始请求和完整付款凭证，向同一 URL 重试。重新请求保留原 challenge、签名、交易和购买编号。商户决定能否补交。商户要求重新付款或明确拒绝原凭证时，订单保留已付款状态并记录交付拒绝。

待交付订单通过同一套数据库领取和退避逻辑执行自动或手动恢复，累计最多四次。升级前因为没有查询端点而标记 `DELIVERY_RECOVERY_UNSUPPORTED` 的 MPP 订单可以由原 Agent 主动恢复。后端不会在升级时批量打开这些历史订单。

## 隔离实现阶段的支持范围与未完成事项（2026-11-16）

- 仅 Solana Charge、native USDC、六位精度、legacy Token Program、GET、SDK V0 unsigned transaction、买方支付网络费。
- 支持有或无 `externalId`；有值时 Memo 必须精确匹配，无值时不编造 Memo。
- 拒绝 Session/channel、splits、confidential transfer、sponsored fee payer、ATA 创建、备用 credential header、digest binding 和其它未明确支持的条款。
- API 入口为认证 Agent 的 `POST /api/agent/mpp/purchases`；MCP 入口为 `request_mpp_purchase`。输入仅允许已注册 Resource、稳定 requestId、用途及授权请求参数；不能传入金额、网络、收款人、credential、批准标志或 executor。
- wrapper 的 MPP HTTP timeout 为 120 秒。中断只提示查询原 purchase ID，不声称“没有付款”，也不建议用新 ID 重试。
- 经用户后续授权，Mainnet MPP 仅在已验证并声明 `mppProtocol` 的 Standalone artifact 中可用。旧 App / 未声明能力的 runtime 仍拒绝 `MPP_MAINNET_ACCEPTANCE_REQUIRED`。Mainnet 不接受测试 prepare/fetch 注入；其它非隔离环境拒绝 `MPP_ISOLATED_RUNTIME_REQUIRED`。
- 隔离网页/原生费用字段、冻结复核与 Grant 提交已接线并经过脚本/纯函数/编译验证。真实浏览器视觉、原生弹窗/系统认证、Codex Desktop 宿主、安装版启停/退出生命周期及真实链上验收尚未完成。backend 的 Mainnet 绑定测试仅为自动化回归，不能当作真实付款验收。
- 仅使用后端明确注册为 MPP 的 Resource；资源注册与报价不是付款授权，也不证明第三方商家支持本阶段受限 Charge 形状。

## 隔离实现阶段的验证记录与下一步验收（2026-11-16）

独立 Codex Session 第一轮判定 FAIL，发现同一原交易可被不同购买重复归属，以及交付正文中的公开交易 ID 被误判为敏感凭据。增加失败回归后分别修复；第二轮独立重验判定 PASS。第二轮在额度中断后使用经宿主元数据确认的 `gpt-6-astra / high` 完成，期间源码保持冻结。以下为最终独立验证结果，不重复相加额外的针对性探测。

| 检查 | 本次观察 / 边界 |
| --- | --- |
| 默认回归套件 | `npm test`：138 文件、1471 测试通过；隔离 SQLite、生成测试密钥，仅允许 loopback 的测试环境 |
| 类型、lint、构建 | `npm run typecheck`、`npm run lint`、`npm run build` 均退出 0；既有 Vite/Next 构建警告保留在日志中 |
| 实际 Rust SDK 集成 | `mpp-protocol-engine.test.ts`、`mpp-charge-execution-sdk.test.ts`、`mpp-charge-purchase.test.ts`：3 文件、49 测试通过；核验来源的实际 binary、禁止网络的沙箱、`vitest.pay.config.ts` |
| x402 Router 完整 Pay fixture | `payment-router-pay.test.ts`：2 测试通过；真实 Pay 子进程、mock 商家/RPC、仅允许 loopback；不由普通 `npm test` 自动运行 |
| 费用确认展示 | Swift 生产 helper 编译和纯展示测试通过；未运行 GUI 或系统认证 |
| 独立缺陷重验 | 原交易跨购买/进程/重启归属、历史碰撞迁移回滚、公开交易 ID 的初次交付和恢复通过；完整 credential/wire 与 x402 部分签名拦截保持有效 |
| 真实 App / Codex Desktop / Mainnet | 未验收，未付款，未安装 |

后续改变执行链路时继续回归：错协议 Grant/手续费缺失与超限、多个 Agent/连接的共享预算、同 requestId 重放与冲突、同 merchant challenge 重用、Pause/退出与签名提交顺序、发送后断连、重启保留 UNKNOWN、原交易失败/确认、坏 receipt、已付款未交付、凭据反射、资源/网络/收款人变化、主网门禁，以及原 x402 链路。

完整 MCP 宿主验收需要另行准备隔离 runtime、真实 MCP client/子进程、合成商家与 RPC fixture，穿过 HTTP handler/auth/Runtime/Ledger/SDK 全链路。VM wrapper 单测不能代替该验收，更不能代替用户现有 Codex Desktop 的最终验收。真实付款仍需具体 API/收款方、用途和金额上限的另行授权。

### Mainnet delivery follow-up (2026-11-16, historical 0.2.8 scope)

Plugin 0.2.8 includes the MPP executable and provenance in the immutable Mainnet manifest. An explicit `mainnet.cjs upgrade` verifies old and new artifacts, drains the authenticated owner, and holds startup, standalone-service and App backend ownership locks before advancing the version fence. MCP startup never upgrades or downgrades automatically. The original App bundle, wallet, financial settings and existing payment evidence are not replaced.

The Mainnet Agent surface adds `quote_mpp_resource` (unpaid challenge only) and `request_mpp_purchase`. Grant creation stays in the native-confirmed management flow; no Agent management tool is added. Real Mainnet acceptance additionally requires a matching MPP Grant, explicit SOL fee consent and sufficient shared daily budget. Unit tests and build success are not payment evidence.


Independent review round 1 found missing automatic MPP delivery recovery wiring and a pre-MPP App reader incompatibility. Startup and scheduled recovery now receive the verified adapter directly, independently of environment variables and new-purchase compatibility checks. New Mainnet MPP registration/Grant/purchase is refused with `MPP_SHARED_APP_UPGRADE_REQUIRED` while the canonical installed Yosh.app reader does not match an independently reviewed compatible-reader digest in the immutable artifact. A standalone installation without Yosh.app remains App-independent. The current build deliberately includes no compatible-reader digest: the installed old App is preserved, so real MPP writes remain blocked pending a separately approved compatible App delivery. This protects old history; it does not make the old App capable of reading MPP. Do not bypass this gate by renaming/deleting the App or adding an unreviewed hash. Existing original-payment recovery remains available.

Round 2 also identified first-start resource imports and same-ID recovery as separate entry points. Configuration imports checked compatibility before inserting MPP resources; replay of an owned original request entered original-only recovery before the new-purchase gate. The 0.2.8 Mainnet sandbox permitted metadata for the canonical App path and reading only its backend `server.js` for the digest check. The launcher derived that path from the OS account, not Agent input or environment configuration. All App writes and App execution remained denied. Round 3 and a fresh read-only Codex host verified that scoped implementation and the installed 0.2.8 gate; no real MPP payment occurred.

### Plugin-first Mainnet setup (2026-11-17, before real-payment acceptance)

The user explicitly deferred native App MPP compatibility until after the plugin completes a real payment. Candidate 0.2.9 therefore removes the installed-App reader prerequisite and its manifest field. It does not rename, remove, launch or replace Yosh.app. The standalone sandbox now denies all App reads, writes and execution, verified against a disposable App fixture.

Verified artifact capability still gates MPP resource registration, first-start imports, Grant creation and purchase. Mainnet cannot inject a test prepare/fetch implementation. Original-payment recovery keeps the verified protocol adapter, even when new spending has no valid Grant. Wallet identity, Keychain signing, shared ledger/budgets, atomic execution ownership, fee consent, pause and the existing App/backend ownership locks are retained.

This stages the product delivery; it does not make the pre-MPP App reader compatible. Once MPP records exist in the shared ledger, the old App may reject those records until its later compatibility update. Keep that App out of this acceptance flow. All original data and the App bundle are preserved; no duplicate Mainnet ledger is created.

Acceptance order: install and verify the plugin; register and quote the selected API without payment; let the user create a native-confirmed MPP Grant with an explicit SOL fee limit; execute one purchase within that Grant and shared budget; then use a new Codex session to independently check the original transaction, persisted payment/delivery and remaining gaps. Automated fixture tests are engineering regression evidence only, not real-payment acceptance.

The installed 0.2.9 read-only readiness probe exposed two real merchant integration defects before spending: the quote caller passed the global fetch function as an explicit fixture injection (rejected in production), and the adapter accepted only a single authentication challenge while AgentFeed sends Solana and Tempo offers together. The 0.2.10 candidate leaves the production transport uninjected and uses the pinned SDK multi-challenge parser and formatter to select exactly one Solana Charge offer. Raw unsupported fields and ambiguous Solana offers remain rejected; only the selected challenge enters the immutable quote. Regression tests reproduce both failures; the protocol binary is rebuilt from the same pinned SDK source with updated adapter provenance.


### 2026-11-17: merchant blockhash interoperability and failure evidence

The live merchant's Solana Charge challenge may include an advisory `recentBlockhash` different from the RPC's newest hash. The first real purchase failed before submission; an independent unsigned reproduction returned `MPP_INVALID_LIFETIME`. The original exception was not recorded, so that reproduction is not an exact historical failure trace.

The Solana Charge specification defines that field as advisory (SHOULD, not MUST). Yosh deliberately uses one fresh `getLatestBlockhash` response for both the hash and its exact last-valid height because its existing signer requires a complete lifetime. The protocol wrapper changes only the SDK construction copy. The original challenge/request/ID remain unchanged in the credential. Token, recipient, amount, memo, network, fee cap, immutable purchase and fresh blockhash validity are still verified before signing. No height from a newer hash is assigned to a merchant hash. No already-signed payment is rebuilt or retried. Official reference: https://paymentauth.org/draft-solana-charge-00#section-7.2

Execution failures now have an additive `purchase_execution_failures` table containing only schema-allowlisted stage/codes and bounded RPC metadata. They are owner-bound through the existing purchase read, retained after restart, and separate from the original authorization decision. Existing records are not backfilled with guessed errors. MPP operation IDs resolve to their original request IDs; x402 retains its existing hashed mapping. Ambiguous cross-protocol IDs fail closed. Readiness checks the registered protocol and MPP fee consent instead of assuming x402 `exact`.

Acceptance requires actual installed runtime identity, one user-authorized Mainnet MPP purchase with independently verified original chain evidence and persisted delivery, no duplicate debit, and independent fresh Codex Session review. Mock/fixture regression results do not satisfy Mainnet payment acceptance.

### 2026-11-17: accepted Mainnet payment and Grant UI follow-up

Plugin 0.2.11 completed the authorized AgentFeed Solana Charge purchase for 0.001 USDC with a 5,001-lamport fee, below the approved 10,000-lamport cap. Original chain verification and persisted delivery established PAID / COMPLETE; a fresh independent Codex session verified spending status, purchase lookup by both identifiers, and stored delivery through native MCP tools. No App was opened or replaced. The [public acceptance record](../demo/mpp-mainnet-plugin-20261117.md) distinguishes all three review rounds and links the original transaction.

The installed local package subsequently advanced to 0.2.13 for Grant UI changes while retaining the accepted Mainnet backend. The page now selects network, then protocol, then an API filtered by the backend's protocol declaration. Changing protocol clears the API and fee selection; stale cross-protocol selections cannot proceed to review. MPP fee entry uses SOL presets or exact custom SOL input, converted to an integer lamport string without floating-point arithmetic. Backend frozen-scope validation remains authoritative.

Grant-page reload/session UX and native App MPP reader compatibility remain deferred. A page session expiring does not delete its persisted Grant. Card payments and MPP Session/channel support are not included.
