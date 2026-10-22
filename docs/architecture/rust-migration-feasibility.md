# Yosh 核心后端 Rust 迁移与 SDK 提取可行性评估

评估日期：2026-10-14（Asia/Shanghai）。源码基线：Yosh HEAD `1003aedc1f0dd664bd1a04696024d53a169420cf`。

本轮仅分析并新增本文档；未修改业务代码、依赖、配置、钱包或实际账本，未实施迁移实验、访问真实签名器、执行真实付款、重装 App、提交或推送。先阅读了 [已有源码对比报告][prior]，随后重新核查当前 Yosh 实现、锁文件、安装启动接线与相关测试。该报告的行号和判断只作为调查线索。

## 1. 结论与推荐范围

**现在不建议开始核心后端的 Rust 迁移，更不建议全量重写。值得先形成的是 Yosh 的 SDK 契约，而不是一份 Rust 版 PurchaseLedger。** 当前 TypeScript 已经实现持久成员归属、版本化 Grant、共享每日预算、原子预占和 claim、原付款证据与提交标记、买方对账、独立交付恢复。没有本轮性能数据说明语言运行时是产品瓶颈；目前能直接确认的问题主要是职责耦合、UNKNOWN 的恢复可用性和扩展契约。

推荐范围按价值排序：

1. **优先保留 TS，明确可信核心服务与 Agent 客户端的两种 SDK 边界。** Agent 客户端 SDK 可以先形成，可信核心 SDK 可以先以 TS 的受控服务/SQLite 实现提取；两者都不以 Rust 为前提。
2. **若后续只批准一个 Rust 实验：做只读 Solana 交易解析、授权绑定校验和 original-payment identity 的差分验证。** 复用官方 Solana 类型、编解码与签名验证原语，只移植 Yosh 的购买约束；不构造第二套 x402 协议，不加载真实密钥、不签名、不联网、不提交、不拥有业务数据库。
3. **只有实验显示具体收益，再考虑将该模块接入现有 TS executor。** 交易验证与签名器迁移是两个决定。验证器改用 Rust 不会自动让密钥离开 Node；签名器若迁移，必须同时解决 Keychain 身份、跨进程授权顺序、持久化及崩溃契约。
4. **Rust Authority/购买核心及完整服务替换属于更晚的选项。** 前提是存在实际 Rust 嵌入宿主、减少 Node 交付依赖的明确需求，或可测量的资源/性能收益，而且 SDK、数据兼容与执行 ownership 门禁全部满足。

理由来自真实链路：`reserve → claim → 实际签名前复核 → savePayload+原证据 → markSubmissionAttempt → HTTP 发送 → 原交易对账 → 交付`，安全性主要由这些时序及持久化约束产生。[预占][Y-reserve]、[执行][Y-exec]、[原付款验证][Y-identity]。Rust 可以改善类型约束、内存管理及原生部署，但不会自行提供用户授权、数据库事务、链上结果或商户恢复合同。

### 1.1 三种迁移范围的实际收益与代价

| 范围 | 可能获得的收益（推断，待测量） | 实际成本/限制 | 当前判断 |
|---|---|---|---|
| 保留 TypeScript，收紧模块边界 | 保留官方 x402 2.25.0 接线、现有 SQLite 数据/fixture 和 App/MCP；直接处理大类职责、状态类型、错误契约与恢复调度 | 仍依赖 Node/Next 和同步 DB；软件签名密钥仍在可信进程；模块提取仍须保护事务 | 当前收益/风险比最好；可先形成 SDK |
| 仅迁移交易验证；另行考虑签名 | Rust 的有界解析、显式状态/整数类型、复用 Solana 原语；若签名真正独立，可减少 JS secret 副本和签名攻击面 | N-API/IPC、macOS 架构/签名/打包、两种工具链；秘密若先由 TS 读出再传 Rust则密钥隔离收益很小；解析不替代政策复核 | 验证器适合最小实验；签名器暂不与之捆绑 |
| 迁移整个核心后端 | 对真正 Rust 宿主提供嵌入；若最终移除 Node 可减少该运行依赖；显式 actor/状态类型有助组织执行 | x402 SDK 行为对齐、全部迁移/哈希/时钟规则、网络安全、生命周期、Keychain 与 MCP 接线均需重验；资源收益未测量；过渡期通常更复杂 | 当前缺少足够收益证据，不启动 |

**Rust 能改善的具体点：** newtype 限制金额/标识混用，enum 收口状态，checked arithmetic 明确溢出，有界交易解析和签名原语复用，拥有权及可清零缓冲区减少不必要的 secret 拷贝，原生可执行文件供嵌入/打包。均需通过实际设计落实；Rust 的 `u64` 并不自动符合 Yosh 的金额上限，release 算术也不能替代 checked 操作。

**换语言仍存在的问题：** 共享预算与 Grant 并发，撤销后仍持有旧 APPROVED，DB 提交与 HTTP 发送之间的空隙，sponsor 最终签名未知、RPC 历史不可得、商户不支持已付恢复、资源禁用影响旧订单、管理信任根、本地同用户攻击与应用生命周期。迁移若只是翻译当前类，耦合和恢复限制仍在。

## 2. 证据等级与本轮验证

- **已实现**：当前入口能追到实际校验与状态写入。
- **接口存在**：有类型/注入点，不等于产品入口、持久化能力或实际部署可用。
- **fixture 验证**：本轮运行现有自动化；网络、钱包和数据库明确与真实环境隔离。
- **历史真实环境证据**：只引用带日期的仓库记录，不作为本轮运行成功证据。
- **推断/未验证**：收益估计、Rust 替换兼容性、尚未运行的外部依赖、未知商户行为分别标注。

本轮执行现有测试，**15 文件 / 226 测试通过**：

```sh
./node_modules/.bin/vitest run \
  tests/unit/policy-ledger.test.ts \
  tests/unit/spend-grant.test.ts \
  tests/unit/monetary-ledger.test.ts \
  tests/unit/card-member-migration.test.ts \
  tests/unit/original-payment-evidence.test.ts \
  tests/unit/original-payment-recovery.test.ts \
  tests/unit/durable-delivery.test.ts \
  tests/unit/mainnet-sdk.test.ts \
  tests/unit/mainnet-signing.test.ts \
  tests/unit/production-x402.test.ts \
  tests/unit/x402-compatibility-boundary.test.ts \
  tests/unit/management-hmac.test.ts \
  tests/unit/mcp-connection.test.ts \
  tests/unit/agent-delivery-retrieval.test.ts \
  tests/integration/backend-ownership.test.ts
```

证据强度须分开：

- [mainnet-sdk.test.ts:17][T-sdk] 使用**真正锁定的官方 x402 SDK**、临时生成的 fixture signer、内存账本和允许列表 RPC mock；验证 v0 sponsored 部分签名及未签交易篡改拒绝。没有商户发送或链上提交。
- [mainnet-signing.test.ts:13][T-signing] mock 了 ExactSvmScheme、wire 编码和 unsigned 校验；它验证外围执行门禁，不能替代真实 SDK 编解码证据。
- [original-payment-evidence.test.ts:64][T-identity] 用真实本地密码学/交易编解码处理合成部分签名和 sponsor 补签；RPC 仍为 fixture。[original-payment-recovery.test.ts:23][T-recovery-mocks] mock 签名构造与钱包，测试实际恢复/状态逻辑。
- [backend-ownership.test.ts:12][T-owner] 实际启动临时目录中的 Node 子进程，验证跨进程 owner、路径别名与进程死亡后的锁释放；不是实际 App 的完整付款崩溃演练。双 Ledger handle 的 Grant 用例是顺序竞争，不等于多进程预算压力测试。[spend-grant.test.ts:97][T-grant-two]
- 本轮未运行外部 Rust 编译/测试、Keychain ACL、已安装 App、Codex 宿主或真实 RPC/付款。未跑 typecheck/lint/build：仅新增文档，按 plan.md 文档交付规则检查内容与 diff；不声称业务代码全套重新验收。
- 测试命令有现存 Vite configLoader 兼容警告，退出码为 0，不影响上述通过结果。

仓库 [2026-10-08 Mainnet 验收][historical-mainnet] 记录了实际桌面 Codex 的一笔 Agent402 GET、0.001 USDC、初始交付成功；记录同时说明付款证明采用 `confirmed`、独立公共 RPC 查询失败、商户 recovery 为 `none`。这是历史局部证据，不证明 Rust、真实 POST、丢响应恢复或本轮安装状态。

## 3. 当前入口、依赖与状态变化

### 3.1 购买入口

Agent 路径：

```text
官方 MCP SDK createAgentServer(request_purchase)
 → scripts/mcp.ts callApp('/api/agent/purchases')
 → Agent HTTP POST: authenticateAgent('request_purchase')，得到后端 principal
 → AppRuntime.requestPurchase / performPurchaseRequest（track + 等待启动恢复）
 → requestPaidResourcePurchase
 → Mainnet: requestRegisteredResourcePurchase
 → fresh challenge → createX402SpendIntent → PurchaseLedger.reserve
 → 仅 APPROVED: executeApprovedPayment → claim → signer wrapper → persist → submit
 → reconcileApprovedPayment → PAID/FAILED/UNKNOWN → receiveOriginalDelivery
```

这些是实际调用，不是目标架构：[MCP tools][Y-mcp]、[stdio bridge][Y-bridge]、[Agent route][Y-agent-route]、[runtime service][Y-runtime-purchase]、[环境分流][Y-router]、[registered service][Y-request]。Devnet/模拟路径仍使用历史 paid resources 和测试 offer；App 的测试购买入口也复用现有 executor，不应移入通用产品 SDK。

管理路径是 `managementRoute → 校验精确请求 bytes/HMAC → AppRuntime.createSpendGrant / setDailyLimit / setPaused`；创建 Grant 的 resource/payTo 来自后端登记事实与新鲜报价。Agent JSON 无法传入自身 principal、批准事实、grantId、金额或交易 bytes。[管理认证][Y-management]、[Grant route][Y-grant-route]、[Grant service][Y-create-grant]

### 3.2 核心状态含义

- `reserve` 在 `BEGIN IMMEDIATE` 内处理重放、过期预占、scope paid/reserved、未决付款、Daily Authority 和 Grant，写购买与初始 delivery；不是“先查余额后扣款”。[Y-reserve]
- `claim` 在同一事务体系内重查 current controls/Grant/registry，拒绝同 scope 的 PAYING/UNKNOWN，随后 APPROVED → PAYING。[Y-claim]
- `savePayload` 将原签名载荷与 original evidence 同事务保存；`markSubmissionAttempt` 再重查授权并只从 SIGNED_NOT_SUBMITTED 写一次提交标记。[Y-save]、[Y-marker]
- HTTP 响应只产生 receipt/signature observation；买方 RPC 验证原交易后，original state 与 purchase PAID 在同事务更新。未知结果保持 PAYMENT_UNKNOWN，预占保留。[Y-confirm]、[Y-unknown]、[Y-reconcile]
- PAID、receipt CONFIRMED、delivery COMPLETE 是不同事实。delivery claim/token/retryCount/nextAttemptAt 在 DB，初始响应不计入四次 retry。[Y-delivery]、[Y-delivery-claim]、[Y-delivery-state]

当前 `SpendReservation.status` 仍为 `string`，转换散布于 SQL；Rust enum 可帮助收口，但旧 DB/JSON 仍需运行时校验和兼容解析。[Y-record]。审计 events 是附带记录，不是完整 event sourcing，也不能靠重放事件重建全部付款事实。

## 4. 模块可迁移性矩阵

“适合提取”指职责边界；不等于现在值得换语言。

| 对象/模块 | 当前实现、依赖与证据 | 合理目标边界 | Rust 可迁移性与先决条件 |
|---|---|---|---|
| CardMember | UUID、ACTIVE/REVOKED、default；Ledger 持久化及旧 connection 归属导入；撤销成员同时撤销其 active Grants。[Y-member]、[Y-member-ledger]、[T-member-migration] | 可信核心的稳定购买归属；label/display 留宿主 | 高；保留 UUID/历史 owner，不按连接或模型名称重新分配 |
| AgentConnection | 文件 capability、token 恒定时间比较、成员 active、MCP session；重启恢复 descriptor，在线状态清空。[Y-connection] | 凭据存取和认证属于服务/transport；核心只接受经认证 principal 及有效性事实 | 不值得优先改 Rust；不要搬 token 文件与宿主安装进经济内核 |
| SpendPrincipal | `cardMemberId/connectionId/connectionGeneration` 的 runtime schema；由认证返回，不由工具字段建立。[Y-principal]、[Y-agent-route] | 可信调用上下文；连接事实作审计 | 类型易迁移；跨 FFI/IPC 不能因 JSON 满足 schema 就视为已认证 |
| SpendGrant | resource/provider/operation/资产/payTo/scheme、POST policy hash、总/单笔额、期限、version；成员+scope+resource 的 active 唯一。[Y-grant]、[Y-grant-create]、[Y-grant-eval] | 授权与其事务性生命周期是核心；用户确认由可信宿主提供 | 高但非纯策略函数；必须保留累计消费、替换/撤销版本和签名前复核 |
| Daily Authority | 所有成员共享同 MonetaryScope；paid 当日计数、所有未决预占；持久时区边界、回拨保护。[Y-day]、[Y-summary] | 核心预算规则+事务；显示/输入为 App projection | 高；需要明确 wall-clock/time-zone 合同，不能改成 UTC 自动重置 |
| MonetaryScope/AtomicMoney | environment+固定逻辑 wallet item+network+mint+decimals；十进制 strings/bigint，最大 2^63−1；aggregate 检查。[Y-scope]、[Y-money] | 小而明确的核心值类型 | 高；Rust checked 金额并保持旧上限/哈希；不能仅依赖 ticker/u64 |
| PurchaseLedger/schema/migrations | 一个 DatabaseSync 聚合身份、Grant、预算、付款证据、交付、answers、RuntimeResourceRegistry；WAL/FULL/唯一索引/trigger。[Y-ledger]、[Y-migrations] | 单一事务服务，可按用例拆职责，共享同一 DB transaction owner | 机械迁移容易，正确迁移成本高；不能按表拆成独立写 API |
| 幂等/预占/claim | 成员范围 requestId；输入/request/execution hash 重放验证；atomic reserve/claim，scope 执行串行。[Y-request]、[Y-reserve]、[Y-claim] | 事务性的核心购买 use case | 高价值提取，但先定义 owner、状态和全部原子写单元；不能返回可随意消费的布尔批准 |
| 报价/x402 编排 | 官方 HTTP decoder+V2 schema；真实 HTTP instance/完整 alternatives/extensions/原 header 保存；unique matching exact；guard 复核。[Y-x402]、[Y-challenge]、[Y-production] | x402/Solana 支付 adapter；核心消费明确的已校验经济事实及不可变绑定 | 中；SDK 兼容性门禁尚未跑，宜先留 TS 官方栈 |
| Keychain/signer | `/usr/bin/security` 固定两组 item；expected address 验证；JS string→bytes→SDK signer，bytes finally 清零。[Y-keychain]、[Y-wallet] | macOS 签名后端；不向 Agent 提供原始 sign API | 可行但有 OS ACL、安装签名、secret 生命周期与 IPC 成本；不是纯语言替换 |
| 交易字节验证 | web3.js VersionedTransaction+Node Ed25519；roundtrip、1232-byte/no ALT、exact transfer、memo、compute、签名/消息身份。[Y-wire]、[Y-identity] | 无副作用的 Solana exact 验证模块 | 最适合小实验；复用官方原语，保留 Yosh 约束；不自研 decoder/crypto |
| original-payment reconciliation | buyer RPC/genesis；receipt 只作 hint；原 message+buyer signature+完整签名；confirmed success/finalized failure。[Y-reconcile]、[Y-match] | 恢复 reducer 可入核心；Solana read/evidence adapter 独立 | 中高；迁移类型不提升 RPC 历史可得性，必须保留未知规则 |
| durable delivery recovery | PAID 后基于 none/replay/cache/payment identifier；不加载 signer；claim token/4 retries/backoff，JSON/text 有界交付。[Y-delivery]、[Y-delivery-claim]、[Y-read-delivery] | 通用 retry/claim 状态可提取；HTTP 请求、receipt、资源解码留 adapter | 中；当前仍解码 Solana payload，与 registry active 耦合，需先界定责任 |
| AppRuntime/管理认证/启动退出 | 单 data directory owner、环境配置、wallet readiness、Codex、active promises、startup recovery、delivery scheduler；管理 HMAC request/response。[Y-runtime]、[Y-owner]、[Y-quit]、[Y-management] | 生命周期/管理认证/配置由可信服务宿主；启动恢复和付款 stop/drain 合同为核心要求 | AppRuntime 整体不适合嵌入 SDK；拆组合根，不能失去唯一 executor |
| MCP/Codex 宿主 | 官方 TS MCP stdio→HTTP；Codex CLI 管 UUID-scoped entry、精确 launch/config ownership；ping 证明宿主存活。[Y-mcp]、[Y-codex]、[Y-bridge] | transport 和 host integration adapter；可复用 Agent 客户端 | 当前不值得迁移；保留实际宿主兼容，SDK 不代管 Codex 配置 |
| 旧 Demo/模型/自建 Paid API/answer | 测试 offer、LLM runner 和服务端 facilitator fixtures，非 v1 产品的结算依赖。[Y-router]、[Y-exec] | 继续作回归测试设施，与产品核心分开 | 不值得为迁移而重写；官方 SDK 的卖方/facilitator 能力不变成 Yosh 新产品 |

### 4.1 已清晰与需先调整的边界

已有边界：官方协议 SDK；MCP 不持钥；HMAC 管理与 Agent capability 分权；`evaluateSpendAuthority` 基于输入快照；delivery-only 模块不加载 signer；临时 clock/network/wallet 注入便于 fixture；AppRuntime 先 owner 后 recovery。[Y-policy]、[Y-delivery]、[Y-runtime]

但不能直接作为协议中立 SDK：`SpendIntent` 内嵌 `httpRequest/x402Challenge/paymentRequiredHeader`；Ledger import Solana address、固定测试资源并持有 registry；`prepareSolanaPayment` 接收整个 Ledger/approvalId；生产 guard 又回查资源与 Grant。[Y-intent]、[Y-ledger]、[Y-sign]、[Y-production]。这部分耦合有安全目的，提取时应以“同一购买的受控执行/持久化操作”替代宽对象依赖，而不是删除检查。

建议先明确三类契约：经济事实与授权；必须同事务的状态变更；协议构造/证据/交付。先由 TS 内部接口体现，再讨论 Rust。无需新 DI 框架、仓储 CRUD 层或万能插件系统。公开 SDK 构造不能沿用 Ledger 当前 `managed/requireSpendGrant` 默认 false；生产构造必须验证持久存储、资源/Grant Enforcement 和 scope，测试兼容入口单独限定。[Y-ledger]

### 4.2 connection generation 的真实作用

1. descriptor 保存 generation；`rotateCredential` 轮换 token、generation+1、清 live session。重新 enable 创建新 connectionId，generation 重新从 1 开始；正常重启恢复原 descriptor。[Y-connection]
2. 认证校验的是当前 token、capability 和 active CardMember，**没有从请求字段比较一个 generation**；返回 principal 携带当前 generation。
3. Grant 和 intent 存连接 ID/generation 作为当时事实。`evaluateGrant`/`assertGrantCovers` 强制的是 active member、active/未到期 Grant、scope、version、operation、金额，**不比较 Grant 与 binding 的 connectionId/generation**。[Y-grant-eval]、[Y-grant-sign]
4. 测试明确以 `connectionGeneration: 99` 获得 APPROVED；同 CardMember 跨 connection 重放保持购买归属。[T-generation]、[T-cross-connection]
5. App 显式切换连接会撤销该成员 Grants；Grant 创建/替换/撤销不再轮换 MCP credential。动态 payTo 的 Grant 创建在异步报价前后比较完整 principal hash，能发现创建期间连接变化；这是一处创建竞态检查，不能外推为每笔 Grant 的 generation gate。[Y-connection-change]、[Y-create-grant]

迁移须保持上述语义并写入契约。不得将字段存在宣传为独立授权防线；若以后要改为每代次授权，那是产品语义与旧在途订单兼容变更，需要另行设计和授权。

## 5. Rust 依赖与协议兼容性

### 5.1 当前真正锁定并使用的 TS 能力

`package.json` 的 caret 不是实际版本；本轮核对 `package-lock.json` 与已安装 package：`@x402/core` **2.25.0**、`@x402/svm` **2.25.0**、`@solana/kit` **5.5.1**、`@solana/web3.js` **1.98.4**、`@solana-program/token` **0.9.0**、MCP SDK **1.27.1**。

| 使用位置 | 已使用的 SDK 能力 | Yosh 自己保留的职责 |
|---|---|---|
| x402-client.ts | `x402HTTPClient` 读 PAYMENT-REQUIRED、编码 PAYMENT-SIGNATURE、读 PAYMENT-RESPONSE；V2 schemas | 有界 header、exact scope、receipt binding、hint 不等于 proof。[Y-x402] |
| solana-payment.ts | `ExactSvmScheme(checkedSigner,{rpcUrl})`、`x402Client.register/setSpendControls/registerPolicy/createPaymentPayload` | 精确选择已预占 requirement，金额 asset cap；删商户 RPC/blockhash hints；符合买方公钥、模拟及签名门禁。[Y-sign] |
| 锁定 SVM scheme source | mint metadata、ATA、transfer_checked、20,000 CU/1 microLamport、报价 memo 或随机 16-byte hex memo、v0 message、partial signing | 只放行 classic SPL USDC/6 decimals、sponsored Mainnet；SDK 的 Token-2022 能力未被 Yosh 全面采用。[TS-scheme] |
| @solana/kit | signer/地址、base58、PDA、wire serialization 与 SDK lifetime | Keychain item、公钥来源和环境一致性，original evidence 永久绑定。[Y-wallet]、[Y-sign] |
| @solana/web3.js | VersionedTransaction/public key/PDA | 有界 canonical roundtrip、指令允许列表、buyer signature、message identity。[Y-wire] |
| 官方 server/facilitator | 自建 Paid API 的 decode/encode、ResourceServer、Exact server；localnet test harness | 测试设施，不能算作产品需迁移的结算服务 |

锁定 core 还有 `onBeforePaymentCreation/onAfterPaymentCreation/onPaymentCreationFailure/onPaymentResponse/registerExtension` 等 hooks，见安装包 [client implementation][TS-core]。**当前 Yosh 没有注册这些 lifecycle hooks，也没有使用自动付款 fetch wrapper；实际签名门禁放在 checkedSigner 中。** 因为支付创建 hook 比真正签名早，普通回调和自动 HTTP retry 不提供原子预算、用户批准或 original-only recovery。未来先核对可用扩展点，禁止为迁移另建同等协议库。

### 5.2 外部源码快照与来源身份

本轮通过 web 检索及 GitHub 官方/项目仓库读取固定提交源码，未安装 Rust 依赖；分析下载仅在 `/tmp/yosh-rust-feasibility`。

- **x402 官方参考实现**：`x402-foundation/x402` HEAD `e95b06661e1a2a8a9a21fce34cc28b9934834650`。[固定 README][R-x402-official] 和该提交完整 tree 未见 Rust SDK 目录；可用参考语言与生态 Rust 实现须区分。不能称 x402-rs 为官方 TS SDK 的 Rust 移植。
- **Solana Foundation pay-kit**：核查 pay.sh 本地 Cargo 锁定的 `solana-pay-kit` **0.10.0**、提交 `f8ef055b1d1c8ca8245f19bbca819faed9cfa058`。[Cargo][R-kit-cargo]、[pay 的锁定声明][P-kit-pin]。本轮上游 HEAD 为 `cd72920136d0eda8cb940e91e0902d9e20f18687`；下文能力判断固定在 f8ef055，未把新 HEAD 的全部行为当成已核查。
- **solana-keychain**：pay-kit 指定 git commit `44b479df245167ca3b3a4e04d6d907146306d342`，依赖声明版本 `2.0.0-beta.1`，该提交自身 manifest 为 **2.0.0**；签名 traits 有 TransactionSigner、ModifyingSigner、SendingSigner。[R-kit-cargo]、[R-keychain-cargo]、[R-keychain-traits]。此 keychain 是签名抽象，不等于 Yosh 固定 macOS password item 的无缝替换；仍需按完整锁图验证实际依赖解析。
- **社区 x402-rs**：HEAD `e75adda8a0e3cf23db446883ba91b88bbab2fe28`，workspace **2.0.2**、Rust minimum **1.93.0**；核查 `x402-chain-solana`、`x402-reqwest` 及 protocol types。[R-rs-cargo]。不用搜索结果中的旧 0.12.x 版本作判断。

Solana 官方 Rust 原子 crates 能提供消息/交易/地址/签名/RPC 原语；pay-kit 的依赖声明具体采用 `solana-message ~4.4`、`solana-transaction ~4.1`、`solana-rpc-client 4.1` 等及 wincode。[R-kit-cargo]。**未在本轮解析 Cargo.lock、构建或验证全部 transitive dependency 的最终版本、license/feature/发布兼容；crate 声明不等于实际完整锁图。** 若实验需要这些依赖，应先选可固定、最小功能集，不照搬 pay.sh 的 confidential/server/testkit 全部 features。

本轮优先调查协议官方参考实现、Solana Foundation SDK 与一个具有实际 Solana client 的社区实现，属于有界候选核查，不是所有 Rust x402 项目的全面审计。下表的缺口限定于固定版本及已读调用路径。

### 5.3 能力/缺口矩阵

标签：**直接复用**＝可采用底层实现，仍需应用边界；**需适配**＝源码有能力但 Yosh 契约未接上；**缺口**＝本核查路径缺少等同行为；**未验证**＝未运行 Rust/跨 SDK conformance 或实际环境。以下“支持”均为源码证据，不是编译/生产验收。

| 行为 | pay-kit f8ef055 源码 | x402-rs e75adda 源码 | 与 Yosh 的关系/状态 |
|---|---|---|---|
| x402 V2 envelope/selected accepted/resource | exact header builder 保留 accepted/resource，支持 V1/V2；`PaymentRequirements.accepted` 保留原 JSON。[R-kit-types]、[R-kit-payment] | V2 client 保存 OriginalJson requirements/resource/extensions。[R-rs-v2] | 协议 DTO/编解码可复用；必须外层 strict schema、保留原 header、完整 alternatives 和精确选择。需适配/未验证 |
| sponsored partial signing | fee payer 独立；调用 buyer required slot，helper 检查 index/signature count；内置 fixture 期待 slot 0 空。[R-kit-signing] | 构造 fee payer v0，`TransactionInt.sign_with_keypair` 插入自己 slot。[R-rs-build]、[R-rs-int] | 底层能力存在；adapter 禁止 fallback self-funded，签前/后均核对 buyer/message/slots。需适配/未验证 |
| 最终交易身份 | builder 返回 base64 transaction，不产生 Yosh 的 messageHash/buyerSignature/original evidence；signer Complete/Partial tuple也不是完整恢复证明。[R-kit-payment]、[R-keychain-traits] | sign_payment 返回编码 envelope；没有 Yosh durable identity。[R-rs-v2] | 缺口在购买系统；复用官方解析、签名验证原语实现 Yosh 绑定。不能把 buyer signature 或非零 slot 当最终 txid |
| memo | quote `extra.memo` 或随机 hex；最多 256 bytes，允许空字符串/错误类型的行为与 Yosh 外层校验不同。[R-kit-memo] | 构造函数每次随机 memo，V2 调用未传报价 memo；代码注释说 hex，实际使用 base64 nonce。[R-rs-memo]、[R-rs-v2] | pay-kit 更接近；x402-rs 有报价 memo 兼容缺口，不能为迁移放松 Yosh memo 绑定 |
| 交易版本/compute | 支持 V0/V1，negotiate 取最高可签；未给 max 时可升 V1；V0 budget 为 20,000/1。[R-kit-version]、[R-kit-policy]、[R-kit-payment] | v0，无 ALT；动态 priority fee 与 simulation 得到 CU limit。[R-rs-build] | Yosh 官方 builder 固定 v0，当前 RPC maxSupported=0、wire limit=1232、20,000/1。pay-kit 显式 cap V0；x402-rs 默认字节规则不兼容。需适配/缺口 |
| blockhash/lifetime | builder 可优先使用 requirements.recent_blockhash；否则取最新 hash，没有在该返回值暴露 Yosh 的 lastValidBlockHeight。[R-kit-payment] | 从 RPC 获取 latest hash；未在 envelope 暴露等同 lifetime capture。[R-rs-build] | Yosh 删除商户 hints、记录本地 RPC lifetime。需适配；expiry/未知绝不能成为重签依据 |
| quote extensions | 底层 build_payment_header 接受 PaymentExtensions；通用 PayKitClient 调用传 **None**。[R-kit-header]、[R-kit-http] | V2 envelope echo extensions，并保留原 requirements。[R-rs-v2] | 选用低层接入。echo ≠ 实现/验证每个 extension；Yosh 对 payload.extensions 的不可变 binding 必须保留，不能自动注册 payment-identifier 扩大协议范围 |
| receipt | 本次 exact builder/main HTTP client 未见 Yosh 等同 receipt 校验/购买状态；商户 settlement 方法不等于买方读取回执 | V2 SettleResponse 复用 v1 success/error 类型；已读类型未保留 Yosh 的 amount/extra/extensionResponses 等字段，reqwest 返回原 response。[R-rs-receipt]、[R-rs-http] | 协议头/DTO 可复用的部分须另验；完整严格 binding与“hint不是proof”是需适配/缺口，pay-kit 买方 receipt 路径未验证 |
| unsigned 校验/模拟 | exact build_payment 内直接 build→sign，未调用 simulation；TransactionSigner wrapper 可在签名前介入。[R-kit-payment]、[R-kit-signing] | 为估算 CU 先模拟，再构造最终 CU message；不是对最终字节完成 Yosh 的 whole binding+err 检查。[R-rs-sim]、[R-rs-build] | 保留独立交易绑定与最终待签字节模拟；simulation 成功不等于用户同意/无额外指令。需适配 |
| original reconciliation | exact client 不提供 Yosh durable original-only buyer reconciliation | reqwest middleware 402→构造签名→HTTP retry，没有购买持久化。[R-rs-http] | 两者均不能替代 Ledger/reconcile；商户/channel/批量 journal 不是同等购买恢复 |
| 已付 durable delivery | 通用 HTTP retry 一次，不是 PAID 后 4 次持久 delivery claim | middleware 返回 paid HTTP response；未见独立 durable delivery ledger | 核心缺口需保留 Yosh 实现，商户恢复能力另验；不能用新 request/sign_payment 恢复 |

**pay.sh 使用 Rust 不构成替换证据。** 它锁定 pay-kit、在 MCP exact 中先 build payment header 再 fetch；这条路径没有 Yosh 的持久 requestId、shared Grant reservation、signed evidence/提交标记与原付款对账。其通道、卖方 settlement、fanout journal 是不同用例。[P-kit-pin]、[P-exact-flow]。推荐复用的是 Solana Foundation 的合适低层 SDK 和官方 x402 TS 栈，Yosh 不应成为新 facilitator 或自建协议兼容库。

## 6. SDK 产品边界

### 6.1 A：供可信应用嵌入的核心 SDK

合理的最小产品是 **持久消费授权与购买恢复核心**，范围先限定“稳定成员、单 scope 资产支出、有限 resource Grant、单次购买”，配合一个 x402 V2/Solana exact adapter。可先为 TS，Rust 是独立的实现选择。

最小能力应包括：

- 成员归属、整数金额/MonetaryScope、版本化 Grant 的创建/替换/撤销与查询，以及明确的共享 Daily Authority。
- 原子 `reservePurchase`/`claimExecution`，同成员 requestId 的重放/异参冲突；临近签名及提交时根据 current controls/Grant/注册事实重新验证。
- 只针对已保存购买的 `persistSignedOriginal`、一次 `beginSubmission`、验证结果后的 confirm/fail/unknown；交易证明核验与状态更新必须有明确调用信任，不开放随意 `setPaid`。
- 原付款只读恢复的 reducer/用例，独立的 delivery claim/result/failure/backoff；有界安全查询 DTO，隐藏 payload 和秘密。
- SQLite 默认实现及恢复/数据版本合同，稳定错误码和 purchase correlation；公开边界不导出 entire DB/SDK error/request。

这不是把所有方法全数公开。SDK 不应带入 NativeServiceRuntime、Codex TOML 编辑、UI projection、旧模型 runner、自建 Paid API、默认网络和现有 App env 全局变更。[Y-runtime]。纯 `evaluateSpendAuthority` 可以作为预览/测试 API，但调用者传来的 `committed` 快照不能作为付款许可；权威批准必须在同一事务中读取事实和写 reservation。[Y-policy]、[Y-reserve]

**可信宿主必须负责的权限：** 认证调用者/绑定 member、证明真实用户管理操作、建立/保管管理 capability、资源注册/POST 确认的可信入口、选择合法网络/钱包、控制 single owner 和生命周期、安装 Keychain/签名后端以及安全配置。可信 SDK 可以有 Grant 管理入口，但只能从该可信宿主调用；Agent 客户端无权持有此 handle。

SDK 能检查授权范围与原子性，无法防御一个已控制其进程、可替换所有依赖/存储/批准来源的“可信宿主”。Rust private type/typestate 可减少编程错误，不能把普通 FFI JSON `approved:true` 变为用户授权证明。

### 6.2 B：供不可信 Agent 使用的后端客户端 SDK

应是现有 `/api/agent/*` 的窄客户端：read status、受限 discovery、消费后端发现凭据进行资源注册、quote、requestPurchase、成员内购买状态与分块 delivery 读取。**它是消费 Yosh 服务的客户端，不嵌入预算/钱包/付款核心。** 当前没有单独通用的购买状态 GET 入口；原 requestPurchase 重放会调用恢复/可能继续执行 APPROVED，不能把它包装成“纯读取”。SDK 可先提供现有可证明操作，新状态接口需未来单独实现。[Y-request]、[Y-agent-delivery]

防伪边界：

- 客户端不接受 self-reported member/principal；后端从已认证 capability 生成 principal。仅设置 JSON 中 cardMemberId 不获得该成员权限。[Y-agent-route]、[Y-connection]
- 请求仅提交 requestId/resourceId/允许输入/reason；不接收金额/payTo/buyer/grantId/approved/transaction/signature。Client schema 只改善体验，后端必须独立校验。[Y-router]
- discoveryId 是后端保存并绑定认证成员的发现事实；注册只创建资源，不能创建 Grant。批准由独立管理通道及用户操作建立，不能从 MCP annotations、模型回复或客户端 callback 推断。[Y-mcp]、[Y-registry]
- 管理 HMAC secret、原付款载荷、Keychain 和任意消息/交易签名永不进入 Agent package；不暴露管理 SDK 的 convenience 方法。[Y-management]
- 同一 capability 的多个进程属同一 CardMember 信任域；当前没有同 token 下 task/process 独立经济身份。timeout 后保持同 requestId，不自动生成新 ID；credential 撤销后要求建立新会话，不自动读取新凭据重试购买。[Y-bridge]

TS/Python Agent SDK 优先通过 versioned JSON API，十进制金额字符串与 network/mint/decimals、status/payment/receipt/delivery 分离，未知 enum fail closed；使用后端错误码，不复制政策实现。MCP adapter 可消费同一 client。**不需要给 Python/TS Agent 分发 Rust 库。** 后续 Rust 服务保持 wire contract，客户端可继续使用；若可信 TS/Python 宿主要嵌入 Rust，则再评估 N-API/PyO3 或同机 service，维护成本见第 8 节。

### 6.3 必要依赖接口与存储 ownership

以下是建议契约，当前只部分存在，不是本轮新增代码：

| 依赖 | 最小必要接口语义 | 不可误用为 |
|---|---|---|
| Storage / transactional purchase service | 在一个强一致事务中读取成员/Grant/控制/clock/committed/幂等并写 reservation/claim；保留唯一索引、immutable 约束、CAS/token；迁移能力与 durable commit 失败反馈 | 分散 `getBudget/setBudget/createPurchase` 回调，或宿主声称 durable 的 Map |
| Clock | 可注入 wall-clock epoch ms、本地 IANA zone/下一边界；持久 lastSeen/nextBoundary；monotonic time 只用于请求 deadline/drain。[Y-day]、[Y-clock] | 每次取系统时间重新算一天，时区变化/回拨直接重置 |
| Network / protocol adapter | 经过验证的 unpaid challenge；有界且 DNS pinned 的 approved request；明确 timeout/redirect/proxy；同一原 payload 的一次提交；RPC read 与 delivery-only transport 分开。[Y-safe-fetch]、[Y-preflight] | 任意 fetch(url,body) 或 SDK 自动付款 retry |
| Signing backend | 核验 public identity、支持的 tx version/partial signing/不修改 message/不自动 broadcast；对内部已核验的购买字节签自己 slot，返回可验证 bytes | Agent 任意 signMessage/signTransaction，返回 secret 的通用接口，或 sign-and-send 隐藏提交时点 |
| Execution/lifecycle | 单 owner、当前 stop/pause/revoke 检查、签名/提交开始与确认的明确顺序、active drain、startup-only recovery 权限 | lease 超时释放 UNKNOWN，或者由 Agent/MCP 启动付款 worker |

SDK **不必须内置唯一数据库产品**，但必须拥有“事务语义”的接口及验证套件。现实起点建议一个 SQLite 实现，先不公开任意 host-store 支持。可信宿主未来可实现事务服务，只要相同 durability/isolation/uniqueness 能被证明；不能仅给 `Store.get/put` 就声称兼容。

不得拆散的原子单元至少为：

1. 幂等命中/冲突 + member/Grant/registry/预算/clock 判断 + intent/quote/reservation/delivery 初始化。
2. 再验证 current controls/Grant/scope + 唯一执行权领取。
3. payload/original evidence 保存和绑定检查；submission marker 再复核并持久一次。
4. 可信原交易 outcome 更新 original state + PAID/FAILED + payment proof/confirmed day/event；UNKNOWN 不释放资金。
5. delivery claim/token+递增次数+到期检查；结果完成/错误/回退需检查原 token，不让旧 owner 完成新 claim。
6. Grant 替换/撤销/版本及审计；成员撤销与其 active Grants 撤销。

DB 事务不包含整个网络 roundtrip；网络与 DB 无分布式原子提交。因此 marker 已持久但请求是否发出未知时，必须保守 UNKNOWN。事务内回调不能 await 网络或反向 FFI，否则产生长锁/重入及 TOCTOU；host adapter 需证明全部数据属于同一事务视图。

## 7. 数据、资金安全与恢复不变量

### 7.1 必须保持及如何验证

| 不变量 | 当前实现证据 | 迁移合同与验证要求 |
|---|---|---|
| 金额精度、环境/钱包/资产隔离 | bigint/strings，单值与合计上限 9223372036854775807；scope 五元组；test/Mainnet 独立 wallet item。[Y-money]、[Y-scope]、[T-money] | Rust 保留既有金额域与 checked sum，JSON decimal string；旧 scopeId 不重算成另一个 ID；边界值/超 safe integer/overflow/跨资产环境及 signer mismatch 差分。钱包身份不得按当前 network 猜测 |
| 成员归属和幂等 | `(owner_card_member_id,task_id)` unique，null owner legacy 另 unique；request/input/execution 一致才复用。[Y-member-index]、[Y-request] | owner 明确必填的新 API；同成员多连接同请求同订单，异参冲突、跨成员同 requestId 独立；恢复内用 approvalId/purchase UUID 或明确 member；不要复用有歧义的 `get(key)` 默认选择 |
| Grant 生命周期/共享预算原子检查 | active/expire/revoke/version/scope/单笔与累计；Daily 所有成员共享，lifetime 不跨日重置；reserve/claim immediate transaction。[Y-grant-eval]、[Y-grant-sign]、[Y-reserve] | 真正同时多线程/进程竞争最后额度、重复 request/claim、撤销/换 Grant/降额度；检查 DB 结果与事件，不能只测纯 policy；generation 维持第 4.2 节语义 |
| 撤销、暂停、退出与签名/提交的竞态顺序 | checkedSigner 在模拟后复核，savePayload/marker 再复核；mark→submit 同步相邻；prepareQuit stop then drain。[Y-sign]、[Y-exec]、[Y-quit] | Rust 并发任务/IPC 必须由单 executor actor 或等效 gate 串行化“开始 sign/submit”与管理确认；暂停确认后无新开始，已开始/提交操作保守记账；不能拿旧 FFI grant snapshot 继续执行；精确 barrier 测试各 await/ack 边界 |
| 原签名载荷与提交标记先持久化 | payload+original 同事务、不可变 trigger，mark 一次后才 submit。[Y-save]、[Y-original-migration]、[Y-marker] | DB write/commit/fsync 失败绝不发送；新 host crash 点：claim 后、sign 后未保存、保存后未 marker、marker 后未 HTTP、HTTP 中、receipt hint 后；不得把返回 signer bytes 当成持久化成功 |
| 提交后超时保留 UNKNOWN | catch 不确证未提交则 unknown；同 scope 新付款拒绝；expiry/history absence不算失败。[Y-exec]、[Y-unknown]、[Y-reconcile] | 无新 payload/重签/替代交易/预算 release；只有确证未提交或匹配原交易 finalized failure 才释放；重复恢复跨重启不重复 PAID/event；子进程 timeout 不意味操作没开始 |
| 恢复核实原 message 与签名 | buyerSignature、signer index、messageHash、memo、ATA、blockhash；sponsor 补签 full wire 可变但 message 不变，完整签名有效且 slot0=最终 signature。[Y-identity]、[Y-match]、[T-identity] | equal amount/payTo/receipt/HTTP200 不足；wrong genesis、同 memo/金额不同 message、损坏 buyer/sponsor sig、额外 instruction、非 canonical bytes均拒绝；wireHash 用于已存原 payload，不能要求补签 wireHash 相同 |
| 付款与交付分别建模 | buyer proof PAID；receipt 独立；200/201+有界合法结果完成 delivery。[Y-delivery]、[Y-delivery-state] | PAID+UNAVAILABLE/INVALID receipt、PAID+PENDING/EXHAUSTED、UNKNOWN+HTTP200 等组合；无 receipt 不抹去有效链证据，错误 receipt 不可满足交付 |
| 已付恢复不再次扣款/重试跨重启 | only PAID delivery claim；原 payload replay/声明 identifier；4 retries、token、monotonic SQL trigger。[Y-delivery]、[Y-delivery-claim]、[Y-delivery-migration]、[T-delivery] | signer/constructor/new submit 次数为零；既有凭据 replay 只在商户声明合同下允许；initial 与 retry 分开；重启/旧 owner/第4次中断/重复早调用不重置计数；第三方能力必须实际验证 |
| 旧 DB 和在途购买继续恢复 | additive evidence/HTTP/delivery migration，amount rebuild逐字保留 payload/JSON/proof，legacy UNKNOWN quarantine。[Y-migrations]、[Y-original-migration]、[T-money-migration]、[T-member-migration] | schema/migrations/trigger/index/FK 和原 JSON/raw header/bytes 兼容；未知标记不被误解释未提交；旧 unclassifiable 保持冻结，不能删库/合并钱包/强制改 status；先复制临时数据库验证，再做未来受控切换 |

### 7.2 Rust 不会自动消除的当前恢复风险

- **一个 PAYING/UNKNOWN 阻塞整个 MonetaryScope。** reserve 和 claim 明确实现，所有成员受影响；属于保守安全策略/可用性取舍，不是语言 bug。[Y-reserve]、[Y-claim]
- **原交易搜索有界但不完整。** 最多最近 100 条 payer history、最多 3 条 memo candidates，无分页；partial buyer 无 slot0 签名且 receipt 丢失时，可能长期无法找到。时间长或 blockhash 过期不证明未付款。[Y-reconcile]
- **UNKNOWN 没有与 paid-delivery 同等的持续定时扫描。** 当前在 startup、同 requestId 重放等入口恢复；每秒 scheduler 只扫 due PAID delivery。[Y-runtime-recovery]、[Y-runtime-scheduler]
- **已付交付仍受 registry active 条件限制。** `claimDelivery` 561 行检查当前 Mainnet resource active；禁用/移除资源可能阻止旧订单恢复。不能因为 request service 注释说复用 immutable endpoint 就宣称任意 registry 改动无影响。[Y-delivery-claim]
- **成功采用 confirmed，失败要求 finalized。** 没看到 PAID 后持续升级 finalized 或分叉重审循环；依赖所选 RPC/网络正确报告。需要明确原有 finality 信任，不因迁移改变或夸大保证。[Y-reconcile]
- **Keychain 是软件密钥存储。** 当前 secret 会经 security stdout 成为 JS string，然后 signer；bytes 清零不等于所有副本擦除。Rust 仅当密钥读取/签名真的移出 TS 才减少这部分暴露；OS 用户/后端进程受控依旧属于边界。[Y-keychain]、[Y-wallet]
- **WalletAccount/全新安装零自动生成不是当前已完成事实。** plan.md 有后续目标；当前 AppRuntime 的非 Mainnet initializeWallet 仍调用 initializeProductWallet，后者可生成不存在的 test key。SDK 不应把它做成隐式默认，也不能为迁移静默修复或替换旧身份。[Y-runtime]、[Y-wallet]

### 7.3 数据兼容的隐蔽成本

SQLite 格式本身可跨语言读取，难点是语义：两套 migrations 标记表、member/resource registry 历史、nullable legacy owner/mode、旧 decision 名称、旧 SpendIntent、proof version 1/2/3、original state、delivery triggers和 scope clock。应对复制的临时 DB 比较 `sqlite_schema`、table rows、约束与恢复结果；仅成功执行 SELECT 不够。

`hash` 当前递归按 JS `localeCompare` 排 key 后 `JSON.stringify` 再 SHA256；scope 是有顺序的 array。[Y-policy]。Rust `serde_json` 常规输出不能直接替代：key collation、数字格式、null/absent、Unicode/URL/headers/body 及精确 raw header均可能不同。JSON.parse/stringify 与 Rust object equality/field order也不同；`validateSignedPaymentIdentity` 还用 JSON stringify 比较派生对象。[Y-identity]

迁移应保留旧绑定/原证据版本，不重签旧记录、不重新序列化已有 payload；为新记录设计显式版本时，恢复按原版本核对。出现 unknown schema/hash version 必须拒绝新付款，保留数据供原版本恢复。回滚不能恢复旧快照覆盖新交易；应停新执行并让兼容 reader 接管当前账本。

## 8. 可选迁移路径与推荐顺序

四条路径都是未来选择，本文不实施任何一条。

### 路径一：保持 TS 并收紧边界（推荐）

适用：当前个人 macOS+Codex 目标、官方 TS x402 主线、尚无可测语言瓶颈或 Rust 嵌入客户。明确领域值、事务用例、协议 adapter、宿主组合根；把状态/错误、owner 必填、只读预览与执行许可、资源禁用后的恢复语义写清。可以形成 TS 核心 SDK和 B 类客户端，成本低于跨语言。

无跨语言调用，无额外权威数据库/执行者；单 AppRuntime/PurchaseLedger 继续拥有服务。旧 schema 可以不变，拆内部接口也不拆事务。验证现有原子性与恢复回归；若提取使测试模式默认进入产品路径、破坏旧 hash/raw evidence，停止提取。当前不存在可发布的完整独立 SDK，不能以文件移动即宣称发布就绪。

### 路径二：先迁移一个有明确收益的模块（只读验证器）

适用：Rust 差分证明有界解析/原付款证据兼容、维护或性能上有具体价值。边界仅 `untrusted wire + trusted expected facts → validated facts/error`，无 DB/secret/HTTP。TS 仍唯一 state owner、SDK transaction constructor 和 payment executor。

实验时命令行/stdin JSON即可比较；进入产品后比较两种方式：

- N-API：低每次调用成本、同进程，无新 daemon；需要 Node ABI/CPU prebuild、buffer ownership、panic/error 映射及签名/打包维护；Rust crash 可能终止宿主，不提供独立密钥边界。
- 一次性/常驻子进程：可隔离解析进程，代价是 framing、大小上限、timeout、stderr 脱敏、子进程生命周期和版本握手。只读进程可安全重新调用；不授予 DB/Keychain/payment capability。

WASM 可用于无副作用纯验证，但 wasm crypto/codec/host 支持需另验；不适合把 macOS Keychain/SQLite owner 也塞进去。数据无迁移；进程失败则拒绝新付款，已提交仍按旧 ledger恢复。无副作用影子比较只计算 parse/identity/拒绝原因，TS 唯一作最终决定；有差异就停止切换，不能双执行付款。

若继而考虑 signer：优先同一受控 executor 内签名 gate；独立签名服务需不可伪造内部调用身份、购买/message binding、不会 broadcast 的 signer、stop/drain/ack 契约。不得发送真实 secret 给 Agent/普通 IPC。签名线程或进程必须已停止且不能再提交，父进程才能按“payload 缺失证明未提交”释放启动记录；子进程存活/隐式发送会破坏现有证明。没有可信停止证明时保留 UNKNOWN，不能基于父进程重启擅自释放。

### 路径三：提取 Rust 核心，由现有 TS 后端调用

适用：A 类 SDK 确有 Rust 嵌入客户，经济状态合同已稳定，且语言/部署收益足以支付桥接成本。最小边界应是完整的事务性购买/授权状态服务，而非逐个 translate Ledger method。

有两种可行 ownership，必须只选一种：

1. **Rust crate 经 N-API 嵌入 Node**：Rust 成为唯一 ledger connection/transaction owner，TS registry/购买写入逐步通过同一核心接口；禁止 TS 再维护第二份预算/Grant cache作为权威。单进程 stop/drain 由共同 gate管理。回调 Promise/数据库重入与 native panic 是主要复杂度。
2. **Rust 子服务拥有 DB**：TS 变成 adapter，所有 authority writes/claim/persist/marker/outcome 走有身份的 IPC；Rust 拿 data-directory owner。若 TS 仍执行 HTTP，`beginSubmission` RPC 返回后等待 TS send 就产生跨进程 pause 竞态，不能直接沿用当前同步相邻保证。需将提交开始放入同一受控 executor，或有经验证的互斥/ack 协议；不要以 RPC 返回一个 permit 就假定问题解决。

宿主 storage callbacks 也可能可行，但只接受第 6.3 节完整事务操作，不拆 CRUD；更多语言绑定和错误路径通常比一个 SQLite实现复杂。C ABI/UniFFI/PyO3 等可以服务可信原生/Python嵌入，但需要版本、内存、async cancellation及数据ownership维护，不建议同时开发所有绑定。

切换前独占停止旧 executor，确认没有存活 signer/submit worker；释放 owner 后新核心接管同一数据目录、原钱包、原 purchases/bytes，先恢复后开放新付款。旧二进制若不认识新 schema/record version禁止作为付款执行者回滚。自动化需真并发、故障注入与旧 DB corpus；未来还需安装版/实际 Codex宿主验收。未能证明单 owner或资金状态兼容就停止，不能边上线边补恢复契约。

### 路径四：逐步替换整个服务

适用：已完成路径三或有等价证明，且明确要移除 Node/Next delivery runtime，macOS原生服务、Rust x402 adapter和真实宿主兼容都已成立。将配置、认证、safe HTTPS、Keychain、scheduler和HTTP adapters按阶段替换；不照搬旧Demo模型执行器。

App 管理 wire contract和B类client仍保持，MCP暂可继续TS bridge；所以“Rust后端”未必立刻移除所有Node依赖。未来要移除stdio桥接时另外验证官方MCP Rust SDK/transport与真实Codex，不把它当经济内核迁移的附赠动作。

服务 ownership必须覆盖新老二进制、不同端口和路径别名。当前App启动的是bundle内Node/server.js、校验HMAC response与PID/dataDirectory身份、正常shutdown后等待停服。[Y-native-launch]、[Y-native-stop]。Rust替换需改真实打包/launch/identity/shutdown接线并保留安全退出；按AGENTS持续授权通过验证后更新同一 `/Users/irin/Applications/Yosh.app`。本轮仅文档，不做安装操作。

验证门禁包括管理认证/response proof、nonce replay、Origin/Host限制、SSRF/DNS pinning、config isolation、启动恢复/暂停/关窗后台存活/退出重启、实际Codex读取/拒绝、旧钱包与在途记录；付款须有新的具体授权。新服务崩溃不得由MCP另起付款服务，旧服务不自动复活抢DB；回退同样遵循唯一owner及兼容恢复。

### 8.1 所有路径共同禁止的状态

- 旧 TS 和 Rust 同时执行真实付款，或各持一份预算/Grant/订单权威。
- 为“比较结果”分别签名、提交、结算，或让影子SDK自动处理402。
- 从影子执行的超时/lease expiry推断原付款未发生并释放额度。
- 双写不同DB再异步同步财务事实；复制DB只用于离线验证，不能成为第二个实时付款后端。

推荐顺序：**先定义两类SDK和TS事务边界 → 经另行授权做只读Rust差分实验 → 依据结果选择接入验证器或停止 → 有实际客户/交付收益再评估Rust核心 → 最后才考虑服务替换。** 这不是一次性迁移任务列表授权。

## 9. 最小实验、待验证事项与停止条件

### 9.1 唯一推荐的最小 Rust 实验（未实施）

**验证官方Solana Rust原语能否在Yosh现有安全域内，忠实解析并识别TS官方SDK产生的交易与补签原付款。** 此实验不替换SDK构造/签名，更不进入真实资金链路。

输入：现有`mainnet-sdk`的离线fixture输出、`original-payment-evidence`的合成交易/expected facts和额外恶意字节语料。只使用测试身份；新fixtures需避免真实payload/DB/密钥。Rust不读生产DB、不联网、不加载Keychain、不签名或提交。

验收内容：

1. 对合法v0买方partial交易导出与TS相同的messageHash、buyerSignature/index、feePayer、实际memo、ATA、金额/精度、blockhash；sponsor补签后保持原message身份并得到正确最终slot0signature。
2. 对金额相同但消息不同、memo被替换、买方/赞助者签名损坏、额外program、重复transfer/compute、ALT、V1、非canonical/截断/超长base64、异常signature/account索引等输入，严格拒绝且无panic。legacy消息的既有解析接受域需明确比较，不能凭“锁定builder为v0”就假设历史只存在v0。
3. 固定expected facts验证，拒绝把对端JSON/receipt当授权；unsigned检查与signed proof输出分开，不能给未签字节生成付款证明。
4. 用相同随机seed/有界恶意语料做差分；合法输入没有未解释的拒绝，恶意输入没有比TS更宽的接受，尤其不能让wire不同但买方消息已变的交易匹配原订单。
5. 记录每次调用成本、进程启动、解析吞吐/尾延迟、内存、编译/二进制大小和依赖维护量；同时测桥接成本和TS基线。无本轮基准，不预设一个加速倍数或承诺时间表。

即使全部通过，也只证明该验证边界。下一阶段需分别评估TS集成、安装和旧数据读取；pay-kit x402构造互通实验是另外一项，不与这次无副作用验证绑定。

### 9.2 可能推翻当前结论的证据

- 一个具体可信Rust宿主/产品客户需要嵌入持久Yosh核心，而不是调用现有服务，且愿意接受相同经济语义。
- 实际剖析证明JS解析/同步DB/Node内存或打包成本是可见瓶颈；Rust含桥接后的改善足以覆盖部署维护成本。
- 固定官方/基金会RustSDK在Yosh的memo/V0/extensions/simulation/partial signing/原消息一致性及真实商户协议conformance全数满足，且必要适配足够小。
- 一套跨语言schema/哈希/时钟和崩溃状态语料通过；实际安装/宿主生命周期证明没有第二owner/付款executor。

这些出现时可以重新评估Rust核心；在此之前“Rust更安全/快”“pay.sh已经用Rust”“文件数量少了”不足以证明迁移值得。

### 9.3 未知项与明确停止条件

| 未知/待验证 | 所需证据 | 停止或推迟条件 |
|---|---|---|
| Rust crates构建、完整锁图/feature/license与可发布稳定性 | 固定commit/Cargo.lock、最小features、支持的macOS架构离线构建 | 无法固定/维护依赖；只靠未发布git变化才能勉强兼容 |
| TS↔Rust交易/报价/receipt互通 | 官方锁定SDKfixture差分；pay-kit低层builder、extensions、V0 cap、final待签bytes模拟门禁；未来真实商户需具体授权 | 必须自建协议库、放松指令/receipt绑定或接受隐式重签才能跑通 |
| 性能/部署收益 | 含IPC/nativeaddon的实测；Node仍在时的总内存、启动/安装/维护量 | 收益很小、成本更高，或瓶颈实际在RPC/商户/架构 |
| 旧数据库与绑定兼容 | 临时复制fixture DB，旧proof/legacy rows/trigger/哈希/clock一致，迁移失败完整rollback | 丢记录、重序列化原payload破坏hash、重新分配owner/wallet，旧UNKNOWN被释放 |
| 撤销/暂停/退出并发 | barrier测试sign开始、marker/send开始、管理ack、signer子进程死亡、startup owner | 两个owner/executor；pause ack后新sign/submit；父崩溃后仍有可提交worker |
| 原付款与已付交付恢复 | 原消息/完整sig差分、missing receipt/meta/genesis/wrong tx、四次持久retry；第三方恢复合同 | 只靠金额/HTTP/receipt判PAID；timeout/expiry释放；delivery再次扣款；无法恢复旧在途购买 |
| 可发布SDK需求和接口稳定性 | 至少具体可信宿主/Agent client使用合同、错误/版本/测试文档 | 只服务Yosh内部却引入多链/多store/远程plugin，或Agent得到管理/任意sign权限 |
| 长历史规模、真实RPC/Keychain/安装版 | 单独测量和实际宿主验证，不用fixture外推 | 问题来自恢复可用性/权限配置且Rust无法带来明确改善，先处理原问题 |

## 10. 长期扩展边界

其他支付协议可以复用稳定成员、可信principal、版本化委托、整数金额与scope、预占/执行ownership、原行为证据和审计。但报价、提交、证明、恢复和履约仍按协议定义；不得假设新的scheme也有Solana一个transfer_checked+memo，或最终交易身份一定来自slot0。

签名后端应在出现第二种实际需求时明确：public identity、可签交易版本、partial签名、是否修改message、是否自行broadcast、是否要求用户在设备确认、是否支持原始消息。`WalletSecretStore`只抽象read/create secret，不能表达不导出密钥的远程/硬件签名器。[Y-wallet-store]。Solana-keychain的capability区分是可用参考；Yosh当前应仅接受保持message且不自动广播的transaction signer。Modifying/SendingSigner需要新的授权和持久提交语义，不能直接挂到当前adapter。[R-keychain-traits]

RWA行为可能是持仓交换、锁定资产、赎回、持续义务或异步履约；daily spend不能自动表示exposure，PAID不等于所有权/赎回完成，Grant撤销不撤回已经成立的义务。可复用身份/授权/预算基础，但当前SpendIntent/Grant范围、Solana exact证据、HTTP200/201、JSON或text封装交付并非通用RWA模型。先定义具体行为的不变量与证据，再讨论适配；本轮不建议立即实现RWA、万能经济引擎或插件框架。

## 11. 四个决策问题

**现在是否应该开始迁移？** 不开始核心后端迁移。先保持TS，明确SDK契约、事务边界与恢复限制；若以后有授权，才做第9.1节的只读验证实验。

**只允许一个最小实验，验证什么，为什么？** Rust对现有官方SDK交易的授权字节校验与原付款identity差分。它边界小、无资金副作用，能检验Rust复用Solana原语的真实价值以及最难被普通HTTP成功测试发现的sponsored身份兼容。

**什么结果建议放弃或推迟？** 无可测收益/无可信Rust嵌入需求；SDK缺口迫使自建协议或弱化安全；旧数据/哈希/在途恢复不兼容；跨语言引入第二权威或付款执行者；pause/quit顺序无法证明。此时选择TS SDK和边界整理，不以完成“Rust化”为目标。

**SDK能否先于完整Rust迁移形成？** 可以。B类Agent客户端最先可行；A类可信核心也可先以TS+SQLite和当前官方x402 adapter形成。公开范围限定于已证明的单次消费治理与恢复，不宣称任意协议、多钱包或RWA；完整Rust服务不是SDK成立的前置条件。

<!-- 本地引用为本轮核查快照的文件与起始行；外部实现引用固定提交。 -->
[prior]: /Users/irin/Desktop/open-source/pay/docs/architecture/yosh-vs-pay-deep-dive.md
[historical-mainnet]: /Users/irin/Desktop/yosh/docs/demo/first-mainnet-purchase-20261008.md:1
[Y-member]: /Users/irin/Desktop/yosh/src/modules/authority/card-member.ts:3
[Y-principal]: /Users/irin/Desktop/yosh/src/modules/authority/spend-grant.ts:10
[Y-grant]: /Users/irin/Desktop/yosh/src/modules/authority/spend-grant.ts:28
[Y-intent]: /Users/irin/Desktop/yosh/src/modules/authority/spend-intent.ts:12
[Y-policy]: /Users/irin/Desktop/yosh/src/modules/authority/authority-policy.ts:34
[Y-money]: /Users/irin/Desktop/yosh/src/modules/authority/atomic-money.ts:3
[Y-scope]: /Users/irin/Desktop/yosh/src/modules/purchases/monetary-scope.ts:5
[Y-clock]: /Users/irin/Desktop/yosh/src/modules/purchases/spending-policy.ts:2
[Y-ledger]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:89
[Y-record]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:49
[Y-member-ledger]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:177
[Y-member-index]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:222
[Y-grant-create]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:345
[Y-day]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:447
[Y-reserve]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:654
[Y-claim]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:711
[Y-save]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:738
[Y-marker]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:788
[Y-confirm]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:817
[Y-unknown]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:923
[Y-summary]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:937
[Y-grant-eval]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:981
[Y-grant-sign]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:1007
[Y-delivery-claim]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:555
[Y-migrations]: /Users/irin/Desktop/yosh/src/modules/purchases/monetary-migration.ts:14
[Y-original-migration]: /Users/irin/Desktop/yosh/src/modules/purchases/original-payment-migration.ts:4
[Y-delivery-migration]: /Users/irin/Desktop/yosh/src/modules/purchases/delivery-migration.ts:15
[Y-request]: /Users/irin/Desktop/yosh/src/modules/purchases/request-registered-resource-purchase.ts:26
[Y-router]: /Users/irin/Desktop/yosh/src/modules/purchases/request-paid-resource-purchase.ts:59
[Y-exec]: /Users/irin/Desktop/yosh/src/modules/purchases/approved-payment.ts:122
[Y-delivery]: /Users/irin/Desktop/yosh/src/modules/purchases/delivery-recovery.ts:12
[Y-delivery-state]: /Users/irin/Desktop/yosh/src/modules/purchases/delivery-state.ts:8
[Y-read-delivery]: /Users/irin/Desktop/yosh/src/modules/resources/read-market-snapshot.ts:7
[Y-x402]: /Users/irin/Desktop/yosh/src/modules/payment/x402-client.ts:18
[Y-challenge]: /Users/irin/Desktop/yosh/src/modules/payment/resource-challenge.ts:38
[Y-safe-fetch]: /Users/irin/Desktop/yosh/src/modules/resources/safe-resource-fetch.ts:7
[Y-preflight]: /Users/irin/Desktop/yosh/src/modules/payment/payment-preflight.ts:77
[Y-sign]: /Users/irin/Desktop/yosh/src/modules/payment/solana-payment.ts:51
[Y-wire]: /Users/irin/Desktop/yosh/src/modules/payment/original-payment-evidence.ts:39
[Y-identity]: /Users/irin/Desktop/yosh/src/modules/payment/original-payment-evidence.ts:90
[Y-match]: /Users/irin/Desktop/yosh/src/modules/payment/original-payment-evidence.ts:181
[Y-reconcile]: /Users/irin/Desktop/yosh/src/modules/payment/reconcile-transaction.ts:45
[Y-production]: /Users/irin/Desktop/yosh/src/modules/payment/production-execution-gate.ts:12
[Y-keychain]: /Users/irin/Desktop/yosh/src/modules/payment/keychain.ts:34
[Y-wallet]: /Users/irin/Desktop/yosh/src/modules/app-wallet/product-wallet.ts:32
[Y-wallet-store]: /Users/irin/Desktop/yosh/src/modules/app-wallet/product-wallet.ts:6
[Y-runtime]: /Users/irin/Desktop/yosh/src/modules/app/app-runtime.ts:84
[Y-runtime-recovery]: /Users/irin/Desktop/yosh/src/modules/app/app-runtime.ts:280
[Y-runtime-scheduler]: /Users/irin/Desktop/yosh/src/modules/app/app-runtime.ts:313
[Y-quit]: /Users/irin/Desktop/yosh/src/modules/app/app-runtime.ts:338
[Y-connection-change]: /Users/irin/Desktop/yosh/src/modules/app/app-runtime.ts:579
[Y-create-grant]: /Users/irin/Desktop/yosh/src/modules/app/app-runtime.ts:614
[Y-runtime-purchase]: /Users/irin/Desktop/yosh/src/modules/app/app-runtime.ts:679
[Y-owner]: /Users/irin/Desktop/yosh/src/modules/app/data-directory-owner.ts:9
[Y-management]: /Users/irin/Desktop/yosh/src/modules/app/management-auth.ts:20
[Y-connection]: /Users/irin/Desktop/yosh/src/modules/mcp/connection.ts:33
[Y-mcp]: /Users/irin/Desktop/yosh/src/modules/mcp/server.ts:32
[Y-codex]: /Users/irin/Desktop/yosh/src/modules/mcp/codex-integration.ts:33
[Y-bridge]: /Users/irin/Desktop/yosh/scripts/mcp.ts:15
[Y-agent-route]: /Users/irin/Desktop/yosh/src/app/api/agent/purchases/route.ts:9
[Y-grant-route]: /Users/irin/Desktop/yosh/src/app/api/app/grant/route.ts:17
[Y-agent-delivery]: /Users/irin/Desktop/yosh/src/app/api/agent/purchases/[purchaseId]/delivery/route.ts:7
[Y-registry]: /Users/irin/Desktop/yosh/src/modules/resources/runtime-resource-registry.ts:48
[Y-native-launch]: /Users/irin/Desktop/yosh/apps/macos/Yosh/YoshApp/Services/NativeServiceRuntime.swift:150
[Y-native-stop]: /Users/irin/Desktop/yosh/apps/macos/Yosh/YoshApp/Services/NativeServiceRuntime.swift:283
[T-sdk]: /Users/irin/Desktop/yosh/tests/unit/mainnet-sdk.test.ts:17
[T-signing]: /Users/irin/Desktop/yosh/tests/unit/mainnet-signing.test.ts:13
[T-identity]: /Users/irin/Desktop/yosh/tests/unit/original-payment-evidence.test.ts:64
[T-recovery-mocks]: /Users/irin/Desktop/yosh/tests/unit/original-payment-recovery.test.ts:23
[T-owner]: /Users/irin/Desktop/yosh/tests/integration/backend-ownership.test.ts:12
[T-grant-two]: /Users/irin/Desktop/yosh/tests/unit/spend-grant.test.ts:97
[T-generation]: /Users/irin/Desktop/yosh/tests/unit/spend-grant.test.ts:85
[T-cross-connection]: /Users/irin/Desktop/yosh/tests/unit/spend-grant.test.ts:109
[T-member-migration]: /Users/irin/Desktop/yosh/tests/unit/card-member-migration.test.ts:12
[T-money]: /Users/irin/Desktop/yosh/tests/unit/monetary-ledger.test.ts:48
[T-money-migration]: /Users/irin/Desktop/yosh/tests/unit/monetary-ledger.test.ts:148
[T-delivery]: /Users/irin/Desktop/yosh/tests/unit/durable-delivery.test.ts:100
[TS-scheme]: /Users/irin/Desktop/yosh/node_modules/@x402/svm/dist/esm/chunk-FKOM6YTW.mjs.map
[TS-core]: /Users/irin/Desktop/yosh/node_modules/@x402/core/dist/esm/client/index.mjs:118
[P-kit-pin]: /Users/irin/Desktop/open-source/pay/rust/Cargo.toml:122
[P-exact-flow]: /Users/irin/Desktop/open-source/pay/rust/crates/mcp/src/tools/curl.rs:1194
[R-x402-official]: https://github.com/x402-foundation/x402/blob/e95b06661e1a2a8a9a21fce34cc28b9934834650/README.md
[R-kit-cargo]: https://github.com/solana-foundation/pay-kit/blob/f8ef055b1d1c8ca8245f19bbca819faed9cfa058/rust/crates/kit/Cargo.toml#L83
[R-kit-types]: https://github.com/solana-foundation/pay-kit/blob/f8ef055b1d1c8ca8245f19bbca819faed9cfa058/rust/crates/kit/src/x402/protocol/schemes/exact/types.rs#L206
[R-kit-payment]: https://github.com/solana-foundation/pay-kit/blob/f8ef055b1d1c8ca8245f19bbca819faed9cfa058/rust/crates/kit/src/x402/client/exact/payment.rs#L25
[R-kit-header]: https://github.com/solana-foundation/pay-kit/blob/f8ef055b1d1c8ca8245f19bbca819faed9cfa058/rust/crates/kit/src/x402/client/exact/payment.rs#L109
[R-kit-memo]: https://github.com/solana-foundation/pay-kit/blob/f8ef055b1d1c8ca8245f19bbca819faed9cfa058/rust/crates/kit/src/x402/client/exact/payment.rs#L368
[R-kit-signing]: https://github.com/solana-foundation/pay-kit/blob/f8ef055b1d1c8ca8245f19bbca819faed9cfa058/rust/crates/kit/src/core/signing.rs#L15
[R-kit-version]: https://github.com/solana-foundation/pay-kit/blob/f8ef055b1d1c8ca8245f19bbca819faed9cfa058/rust/crates/kit/src/core/tx/version.rs#L8
[R-kit-policy]: https://github.com/solana-foundation/pay-kit/blob/f8ef055b1d1c8ca8245f19bbca819faed9cfa058/rust/crates/kit/src/core/tx/policy.rs#L70
[R-kit-http]: https://github.com/solana-foundation/pay-kit/blob/f8ef055b1d1c8ca8245f19bbca819faed9cfa058/rust/crates/kit/src/client/mod.rs#L263
[R-keychain-traits]: https://github.com/solana-foundation/solana-keychain/blob/44b479df245167ca3b3a4e04d6d907146306d342/rust/src/traits.rs#L8
[R-keychain-cargo]: https://github.com/solana-foundation/solana-keychain/blob/44b479df245167ca3b3a4e04d6d907146306d342/rust/Cargo.toml#L1
[R-rs-cargo]: https://github.com/x402-rs/x402-rs/blob/e75adda8a0e3cf23db446883ba91b88bbab2fe28/Cargo.toml#L18
[R-rs-v2]: https://github.com/x402-rs/x402-rs/blob/e75adda8a0e3cf23db446883ba91b88bbab2fe28/crates/chains/x402-chain-solana/src/v2_solana_exact/client.rs#L124
[R-rs-build]: https://github.com/x402-rs/x402-rs/blob/e75adda8a0e3cf23db446883ba91b88bbab2fe28/crates/chains/x402-chain-solana/src/v1_solana_exact/client.rs#L272
[R-rs-memo]: https://github.com/x402-rs/x402-rs/blob/e75adda8a0e3cf23db446883ba91b88bbab2fe28/crates/chains/x402-chain-solana/src/v1_solana_exact/client.rs#L194
[R-rs-sim]: https://github.com/x402-rs/x402-rs/blob/e75adda8a0e3cf23db446883ba91b88bbab2fe28/crates/chains/x402-chain-solana/src/v1_solana_exact/client.rs#L127
[R-rs-int]: https://github.com/x402-rs/x402-rs/blob/e75adda8a0e3cf23db446883ba91b88bbab2fe28/crates/chains/x402-chain-solana/src/v1_solana_exact/types.rs#L124
[R-rs-http]: https://github.com/x402-rs/x402-rs/blob/e75adda8a0e3cf23db446883ba91b88bbab2fe28/crates/x402-reqwest/src/client.rs#L229
[R-rs-receipt]: https://github.com/x402-rs/x402-rs/blob/e75adda8a0e3cf23db446883ba91b88bbab2fe28/crates/x402-types/src/proto/v1.rs#L78
