# Yosh Buyer Reliability v1.1 Backlog

初次核查日期：2026-10-14；P1 后续实施日期：2026-10-16（Asia/Shanghai）。源码基线：`1003aedc1f0dd664bd1a04696024d53a169420cf`；以下实现均在未提交工作区。
审计输入为本机 [yosh-vs-pay-deep-dive.md](../../../open-source/pay/docs/architecture/yosh-vs-pay-deep-dive.md)（2026-10-13，同一 Yosh HEAD）。报告是待核查证据，不是开发、付款或推送指令。

第一批完成 BR-03，第二批完成 BR-01 / BR-02。用户随后选择 BR-04 的交付模块抽取方案，并授权继续完成剩余 BR-04 至 BR-07。架构债的 Fixed 以本文件明确的局部修复目标为限，不表示 Ledger 已完全拆分或产品变成多协议引擎。`Confirmed` 表示相关行为/结构已由当前源码确认，不等于已证实生产事故；`Needs Verification` 表示影响尚无充分证据；`Fixed` 要有本轮修复与回归证据。真实第三方行为不能由 fixture 推断。

| ID | 优先级 | 问题 | 状态 | 性质 / 进度 |
|---|---|---|---|---|
| BR-01 | P0 | UNKNOWN 阻塞整个 MonetaryScope | Fixed | 收紧为有证据约束的局部阻塞；原预占保留 |
| BR-02 | P0 | UNKNOWN 缺少持续对账，历史搜索受限 | Fixed | 持久持续对账、有界分页和游标续扫已实现 |
| BR-03 | P0 | inactive Resource 阻挡已付交付 | Fixed | 业务语义 Bug；最小修复、回归及安装版验证完成 |
| BR-04 | P1 | PurchaseLedger 职责集中 | Fixed | 本轮约定的交付模块抽取完成；其余协调职责保留 |
| BR-05 | P1 | Authority / Payment / Purchase 依赖具体协议 | Fixed | 经济事实与签名授权 seam 完成；协议证据仍为具体类型 |
| BR-06 | P1 | 状态转换分散及 string 状态 | Fixed | purchase 状态类型、操作转换和读取校验已集中 |
| BR-07 | P1 | 读取接口 owner 可省略 | Fixed | 歧义接口删除，生产调用迁移；未将未来风险称作既有越权 |

## BR-01 — PAYMENT_UNKNOWN 可能阻塞整个 MonetaryScope

- 当前状态：**Fixed**（当前未提交工作区；按下述安全边界收紧，非无条件放开 UNKNOWN）。
- 源码：[PurchaseLedger.hasBlockingPayment / reserve / claim](../../src/modules/purchases/purchase-ledger.ts)、[evaluateSpendAuthority](../../src/modules/authority/authority-policy.ts)、[原证据校验](../../src/modules/payment/original-payment-evidence.ts)。
- 成因与影响：基线 reserve / claim 对同 scope 中任意 PAYING / PAYMENT_UNKNOWN 都阻塞全部成员和资源。这是保守设计的可用性成本，不是授权漏洞。实际必须保留的是未知转账全额预占与禁止替代付款，不能只删除全局 SQL 条件。
- 修复目标与当前语义：同一 scope 的 PAYING 仍串行阻挡；UNKNOWN 只有在原 payload / 原签名 identity / quote / purchase / MonetaryScope 绑定均校验通过、网络 genesis 已固定、fee payer 为 sponsor、原 HTTP 请求及 x402 challenge 齐全，且 original 状态为 SUBMISSION_ATTEMPTED / OUTCOME_UNKNOWN 时，才不阻挡无关资源。相同 Resource ID 或同 origin + pathname 的 endpoint 别名仍拒绝，跨成员也不能绕过；query、body、header 或方法差异不被用作同端点替代付款的放行理由。旧模式、无证据、坏证据、无固定 genesis、self-funded 或缺请求绑定均继续保守阻塞。
- 安全不变量：UNKNOWN 始终留在原 scope 与原 Grant 的 committed / reserved 中，不因时间、调度 claim、重试次数或查询未命中释放。新订单仍需要自身有效 Grant、原子预算预占、fresh quote、active Resource、签名及提交复核；同一原 requestId 只能恢复，不能重新 claim / 签名。整个 reserve / claim 判定仍在 BEGIN IMMEDIATE 中，PAYING 继续串行。
- 验收测试：[durable-delivery](../../tests/unit/durable-delivery.test.ts) 覆盖有原证据的 UNKNOWN 下另一成员、另一资源获准，并在重启后 claim；原证据和原 UNKNOWN 不变，预占同时计入两笔；已有批准在预算降低后仍拒绝、恢复足额后可领取；PAYING 仍阻挡下一笔；同资源、同请求别名以及变更 query/body 的别名拒绝；无证据 UNKNOWN 全 scope 拒绝。原有 scope 隔离、Grant、暂停/撤销、签名和幂等回归保留。
- 修复进度：实现和自动化验证完成；本批构建/安装证据见下文。不修改金额、原付款表结构或原签名事实，不重新划分用户钱包/预算 scope。

## BR-02 — UNKNOWN 持续自动对账与历史搜索不足

- 当前状态：**Fixed**（本地调度/搜索缺口）；真实 RPC 历史裁剪及第三方索引可用性仍为 **Needs Verification**，不承诺必定找回。
- 源码：[PaymentReconciliation 与 016 增量迁移](../../src/modules/purchases/payment-reconciliation.ts)、[AppRuntime 启动 / reconcileDuePayments / prepareQuit](../../src/modules/app/app-runtime.ts)、[reconcileApprovedPayment](../../src/modules/purchases/approved-payment.ts)、[reconcileStoredOriginalPayment / searchHistory](../../src/modules/payment/reconcile-transaction.ts)。
- 成因与影响：基线只在启动、原 requestId 重放及显式恢复时对账；定时器只扫描 PAID 交付。原搜索只有一页 100 条和 3 个 memo 候选，无最终 sponsor signature 的旧交易易失去可查窗口。直接已知 signature 查询原本存在，继续优先执行。
- 修复目标与当前行为：现有服务循环同时扫描当前 MonetaryScope 的 UNKNOWN，与已付交付分别执行；每批最多 4 笔，上一批结束后再调度。自动启动检查也限制为 4 笔并尊重持久退避；独占启动把可能已提交的 PAYING 交给 UNKNOWN 队列，绝不当作未付款释放。simulated 停止测试执行时仍可只读恢复原 Devnet；Mainnet / Devnet 不跨 scope 扫描。
- 持久状态：新增 `016_payment_reconciliation`，只增加 attempts、next/last attempt、last code、history cursor、work claim；原 purchases、SpendGrants、原 payload / evidence / transaction 不被该迁移改写。领取工作与 attempt/backoff 写入同一 SQLite 事务；1 秒起指数退避，最多 5 分钟，UNKNOWN 不设终止次数。单 owner 启动仅释放中断的工作 token，不重置 attempts、cursor、next time 或资金预占；其它 handle 不得偷取 claim。显式原订单重放可提前只读检查，但不能越过正在持有的 claim。
- 有界查询：单次最多 5 页 × 每页 100 条，最多检查 20 个 memo 候选；保留分页游标，在候选外部查询前及页/候选预算边界保存进度，后续从该位置续扫。RPC 异常时当前候选不被跳过；抵达历史末尾后下一轮从头重扫，以容纳晚到索引。先查已有/观察到的 signature，再查历史。单 RPC 最多 15 秒、256 KiB、禁止 redirect；整个 buyer 对账最多 30 秒；退出取消后台读取并等待 claim 收尾。RPC 的 `before` 游标和 newest-first 顺序按 [Solana 官方 getSignaturesForAddress 合同](https://solana.com/docs/rpc/http/getsignaturesforaddress) 使用；交易缺失/未达到 commitment 时可能返回 null，不能据此断言失败，见 [getTransaction 合同](https://solana.com/docs/rpc/http/gettransaction)。
- 安全不变量：只读取当前配置 RPC，不加载 signer、不调用 merchant、不创建/广播交易；原签名消息、全部转账事实、genesis 和付款归属照旧校验。只有原交易成功转 PAID，或匹配的 finalized failure 才释放；超时、限流、搜索耗尽、数据格式错误、meta 缺失全部保持 UNKNOWN。支付和交付独立，自动链上确认后另由既有 delivery-only 流程处理交付。
- 验收测试：[原证据/搜索](../../tests/unit/original-payment-evidence.test.ts) 覆盖第 101 条、第 5 个 memo 候选、500 条单轮上限、20 候选上限、下一轮续扫、错误交易、RPC 失败不推进当前候选、取消和 30 秒总 deadline；[原付款恢复](../../tests/unit/original-payment-recovery.test.ts) 覆盖第 25 个候选跨 SQLite 重启恢复、原证据不变、跨 handle claim、失效 token、退避不重置及旧账本增量迁移；[调度状态](../../tests/unit/payment-reconciliation.test.ts) 覆盖 4 笔公平批次、owner/scope 隔离、5 分钟退避上限、无限 UNKNOWN 检查不改金融状态；[App 生命周期](../../tests/unit/durable-delivery.test.ts) 覆盖 RPC 恢复后无重启/无新请求自动确认、暂停/执行关闭时继续恢复、启动不绕过 backoff、退出中断读取且预占不变。
- 修复进度：实现和自动化验证完成。本地仍锁定 @x402/core / @x402/svm 2.25.0；已核对 registerPolicy、spend controls、creation/response hooks 和 server 的 pending-settlement retry。服务端 settle retry 不提供 Yosh 买方跨重启的调度、归属或历史搜索；本批补的是本地只读恢复，不另建付款协议或替换 SDK 构造/签名能力。

### BR-01 / BR-02 本批交付记录（2026-10-14）

- 原始复现：5 个失败点分别为无关资源 reserve / claim 被 UNKNOWN 阻挡、超过首 100 条历史、超过 3 个 memo 候选、RPC 恢复后定时器不再检查 UNKNOWN。已由对应回归锁定。
- 自动化：全量 **78 files / 967 tests passed**；最后收紧 endpoint 别名规则后，App management + durable delivery **64/64** 再次通过。原证据/恢复/交付/调度四组 **107/107** 通过；typecheck、lint、diff whitespace 检查通过。全量首次运行的一个旧断言期待独占启动仍停留 PAYING，已改为验证 UNKNOWN、原 payload 不变、10000 原预占保留，重跑全量通过。
- 文件：`src/modules/purchases/payment-reconciliation.ts`（新增）、`purchase-ledger.ts`、`approved-payment.ts`、`src/modules/payment/reconcile-transaction.ts`、`src/modules/app/app-runtime.ts`；对应 `tests/unit/payment-reconciliation.test.ts`（新增）、`original-payment-evidence.test.ts`、`original-payment-recovery.test.ts`、`durable-delivery.test.ts`、`app-management.test.ts`；本 Backlog。BR-03 的前批修改保留，未修改无关工作区文档/图片。
- 构建与安装：现有 `scripts/install-macos-app.sh` 的 backend `npm run build` 与 macOS Release build 均通过，已更新 `/Users/irin/Applications/Yosh.app`；`diff -qr` 核对本次 Release 产物与安装包完全一致，`codesign --verify --strict` 通过。Xcode 输出 CoreSimulator 版本不匹配、无法加载 iOS simulator 及 AppIntents metadata 跳过提示；本机 macOS target 构建成功，未为此更改系统或无关代码。前端静态产物对指定签名/敏感配置/调度实现标识符扫描零命中，此为有限扫描。
- 实际运行：通过 Quit Yosh 菜单正常退出前批 App / backend（PID 84684 / 84715），确认端口释放后安装。新版 App PID 86991 实际路径是 `/Users/irin/Applications/Yosh.app/Contents/MacOS/Yosh`，backend PID 87003 为其子进程，仅监听 `127.0.0.1:3049`。本批日志确认 managementAuthenticated、coreReady、walletAvailable；真实产品账本只读检查确认 016 migration 已应用、integrity_check=ok、foreign_key_check 无错误。未复制/删除/重建真实 Ledger。
- 宿主与 UI：真实 Codex `get_spending_status` 成功；当前 Mainnet configuration ready，钱包身份可读。首次只读时余额尚未核验而拒绝执行，后续状态的执行 blocker 为既有 `SPEND_GRANT_EXPIRED`；没有补建或续期 Grant。管理 overview 与 Agent 状态端点无认证均为 401。执行窗口 Close 后同一 App / backend PID 存活，实际宿主只读继续成功，窗口已 Raise 恢复在正常 PIN 解锁页；未读取/输入 PIN，未修改 App Lock。暂停/退出竞态和未知付款的自动确认由 fixture 回归验证，不将安装版只读检查当作真实链上故障恢复验收。
- 限制：RPC 缺失/裁剪历史或 memo、提供错误/不完整索引、长历史仍可能无法确认原交易。5 页/20 候选是每次工作预算，已保存进度可在后续检查继续，非永久历史截断。PAYING、同 Resource / 同 endpoint、遗留或缺失/不可信证据仍会阻挡；这是保留的安全语义，不宣称 UNKNOWN 下任意新购买都可放行。没有新增 Ledger 修复/强制释放或手工标记已付入口。
- 无真实付款、无删库/重建、无 Commit / Push；BR-04 至 BR-07 未实施。后续建议先定义 P1 的接口职责与状态不变量，再逐项实施，不以本批改动为重写 Ledger 或多协议框架授权。

## BR-03 — Resource inactive 阻挡已付款订单交付

- 当前状态：**Fixed**（基线 HEAD 已复现，当前未提交工作区已修复；第三方真实服务场景未运行）。
- 源码：[PurchaseLedger.claimDelivery](../../src/modules/purchases/purchase-ledger.ts)、[recoverApprovedPayment / checkPaymentBinding](../../src/modules/purchases/approved-payment.ts)、[recoverPaidDelivery](../../src/modules/purchases/delivery-recovery.ts)、[注册购买入口](../../src/modules/purchases/request-registered-resource-purchase.ts)、[资源状态](../../src/modules/resources/runtime-resource-registry.ts)。
- 成因与影响：claimDelivery 已检查 PAID 和 verified payment evidence，随后却再次要求当前主网资源 active，把停止未来消费与既有订单履约混合。DISABLED / REMOVED 会阻挡初始交付 claim 和后续 retry（仅当 requireRegisteredResource 开启）。
- 修复目标：禁用资源继续阻止新购买、claim、签名与提交；已付订单按保存的 immutable request、quote、delivery capability/policy 交付，不依赖当前 registry active。
- 安全不变量：归属和 requestId 冲突校验保留；必须有原 PAID 证据与一致 MonetaryScope；不变更原 payload / original payment / transaction；不签名、不重付、不取新报价；只访问原请求或原订单声明且同 origin 的恢复端点；SSRF/DNS/redirect/响应大小限制、claim CAS、4 次重试与 backoff 不变。
- 验收测试：禁用后的 fresh purchase 无网络/签名；禁用前 APPROVED/PAYING 的执行与签名/提交仍拒绝；DISABLED / REMOVED 后已付订单跨重启安全恢复；错误 owner、错误 endpoint 不发送；成功重放/并发不重复交付；初始交付竞态；原证据、预算/Grant 承诺不变。
- 修复进度：已完成，停止于本项。生产代码只移除 claimDelivery 的 registry active 门槛，并补充已付履约语义注释；claim / assertCanSign / markSubmissionAttempt 的新消费门槛保留。未修改表结构或新增迁移。

### 本轮调用链

新购买：Agent route 认证 → AppRuntime.requestPurchase → requestPaidResourcePurchase → requestRegisteredResourcePurchase → config.registeredResources（AppRuntime.activeResourceDefinitions 仅返回 ACTIVE）→ 新鲜 quote / Grant → reserve → executeApprovedPayment → claim → checkPaymentBinding + production gate → assertCanSign → savePayload → markSubmissionAttempt（再次 assertCanSign）。

原订单：同一已认证 owner/requestId → reuse（先校验请求冲突与 scope）→ recoverApprovedPayment；或独占启动/定时扫描按账本 owner 读取 → recoverApprovedPayment。UNKNOWN 先独立对账；只有 PAID/PENDING → recoverPaidDelivery → 保存的 capability + checkPaymentBinding + 原凭据 identity → claimDelivery（当前错误的 active gate）→ 安全 HTTP → receipt / body 校验 → token 约束 finish。数据读取接口另按认证 owner 取 COMPLETE 记录。

上面括号注明的是基线缺陷；修复后 claimDelivery 以 PAID 证据及保存的订单绑定为依据，不再查询当前资源 active 状态。资源禁用不提供清除历史恢复请求的语义；若未来需要因端点泄露等原因单独停止旧订单恢复，应另行设计显式恢复策略，不能把新消费开关隐式当作该能力。本次不增加此功能。

### BR-03 第一批验证记录（2026-10-14，后续 BR-01/02 另见上文）

- 修改文件：`src/modules/purchases/purchase-ledger.ts`、`tests/unit/durable-delivery.test.ts`、本 Backlog、`docs/architecture/README.md`。
- 先复现：修复前 durable-delivery 的 36 项中 33 通过、3 失败；DISABLED / REMOVED 后重启恢复均报 `MAINNET_REGISTERED_RESOURCE_REQUIRED`，提交后禁用资源的初始交付也失败。移除交付门槛后 36/36 通过；补充购买服务的原 requestId 重放/资源冲突用例后，最终 **37/37** 通过。
- 7 项新增回归：DISABLED / REMOVED 各一项（重启、并发恢复、完成后重放、原 payload/证据/交易和预算/Grant 不变）；新购买及 APPROVED 执行拒绝；PAYING 签名/提交拒绝；购买服务重放和 Resource ID 冲突；提交后禁用仍可接收初始交付；错误 owner/endpoint 无请求。既有用例继续覆盖 UNKNOWN 不交付、缺失/unsupported capability、4 次持久重试、backoff、暂停/撤销、失效 claim、SQL 不可变约束与错误 receipt。
- `npm test`：**77 files / 949 tests passed**。最终测试夹具改用不可变配置对象后，再次执行 durable-delivery：**37/37 passed**；`npm run typecheck`、`npm run lint` 均通过。Vitest 有现存 configLoader ESM 提示，无失败；未修改无关测试配置。
- `scripts/install-macos-app.sh` 内的 `npm run build` 与 macOS Release build 均通过。Xcode 提示旧 `/Users/irin/Desktop/2049/build.noindex` 产物路径超出当前允许根目录，未导致构建失败；未清理无关历史目录。前端 `.next/static` 对指定签名实现/敏感配置标识符扫描为零命中；不将此有限扫描说成完整安全审计。
- 安装版：旧 App PID 75199 / backend PID 75202 正常退出且端口释放后更新 `/Users/irin/Applications/Yosh.app`。`diff -qr` 确认安装包与本次 Release 产物一致，`codesign --verify --strict` 通过。重新打开后实际 App PID 84684 位于该安装路径，backend PID 84715 是其子进程，仅监听 `127.0.0.1:3049`；本轮日志出现 `managementAuthenticated`、`coreReady`、`walletAvailable`。窗口 Close 操作后 App/backend PID 保持，实际宿主只读调用继续成功，已恢复窗口供用户验收。
- 实际 Codex 宿主：调用已安装 Yosh 的 `get_spending_status` 成功；Mainnet configuration/service/wallet ready，当前消费执行被已有 `SPEND_GRANT_EXPIRED` 拒绝。未创建/续期 Grant 或调用购买工具。启动早期第一次只读调用曾返回 APP_UNAVAILABLE，后端 ready 后重试成功，不能把该暂态记录为首次即就绪。
- 无认证 overview 和真实 Agent 状态端点均返回 **401**。本轮未改变真实暂停/Grant 设置；暂停、撤销及退出竞态由自动化回归覆盖，未宣称安装版逐项交互验收。
- 证据边界：新增 Mainnet 模式用例使用临时 SQLite、临时 signer、模拟 `prepareSolanaPayment` / buyer reconciler / HTTP；原凭据 identity 走既有校验。它们证明本地调用链和不变量，不证明真实商家的 replay/idempotency 或链上结算。未触发真实 Devnet/Mainnet 付款，未删除/重建真实 Ledger，沿用原产品数据路径；未 Commit / Push。
- 剩余风险：第三方不支持原付款恢复、结果缓存失效/保留期结束或安全网络校验拒绝时，仍可能已付但未交付；`none` 和 4 次上限仍如实保留。截至该批次 BR-01/02 未修复；UNKNOWN 的原预占和 scope 阻塞行为当时未变。后续用户授权的本批修复见上文。
- 下一项建议：经用户确认后先推进 BR-02 的持续只读对账与证据搜索，保持 UNKNOWN 的付款/预算安全约束；不要直接放开 BR-01 的 scope 阻塞。

## BR-04 — PurchaseLedger 职责过于集中

- 当前状态：**Fixed**（本轮约定的交付模块抽取范围）。性质为架构技术债，不能凭文件长度推断性能或金融漏洞。
- 源码：[PurchaseLedger](../../src/modules/purchases/purchase-ledger.ts)、[PurchaseDeliveryStore](../../src/modules/purchases/purchase-delivery-store.ts)、[现有交付迁移与付款触发器](../../src/modules/purchases/delivery-migration.ts)。
- 成因与影响：构造/迁移、成员、Grant、预算、付款、交付共用一个类和 SQLite 事务；更改交付重试需理解金融代码。只换文件而另开事务会破坏正确性。
- 本轮修复目标：按用户已审阅方案，先抽取内部交付持久化模块。Store 负责 delivery state/capability、receipt 存储、claim CAS、次数/退避、终态和中断 claim 查询。Ledger 负责已付证据、订单绑定检查及组合事务，不持有反向 Store→Ledger 引用，不重写 Ledger、不换存储。
- 安全不变量：共享原 DatabaseSync；Store 的修改方法要求调用者已持有事务，绝不开第二个事务。付款证据校验、交付完成、结果保存、审计事件仍整体提交或回滚。原子预占/执行 claim、单 owner 启动恢复、bigint 金额及付款→PENDING 触发器保持；没有新迁移。
- 验收测试：[durable-delivery](../../tests/unit/durable-delivery.test.ts) 保留跨 handle/重启、失效 token、重试上限、资源禁用及 UNKNOWN 用例；新增结果、交付状态、审计三处 SQLite 失败注入，断言全部状态/原证据与事件回滚，原 claim 可完成且不重付。
- 修复进度：抽取与针对性验证完成。成员/Grant 和初始化迁移仍由 Ledger 协调，这是保留的后续架构债；本项不扩张为全类拆分。

## BR-05 — Authority / Payment / Purchase 具体协议依赖

- 当前状态：**Fixed**（经济事实输入与支付反向依赖的局部解耦范围）。性质为架构债，非缺少付款授权。
- 源码：[经济授权策略](../../src/modules/authority/authority-policy.ts)、[SpendIntentSchema](../../src/modules/authority/spend-intent.ts)、[prepareSolanaPayment](../../src/modules/payment/solana-payment.ts)、[purchaseSigningAuthorization](../../src/modules/purchases/purchase-signing-authorization.ts)、[购买层生产门禁](../../src/modules/purchases/production-execution-gate.ts)。
- 成因与影响：payment adapter 原来直接持有 PurchaseLedger，反向调用购买策略；纯经济策略也验证完整 HTTP/x402 envelope。具体协议适配与授权策略难以独立理解，当前耦合同时承担真实安全防线。
- 本轮修复目标：支付适配器只要求同步签名授权能力，由购买层组合真实 Ledger 和生产门禁。生产门禁移回 purchases。纯经济策略仅消费金额/创建时间/有效期；完整 SpendIntent 仍在 Ledger 边界独立验证，不削弱持久证据。继续复用官方 SDK，不建立多链/RWA 插件框架。
- 安全不变量：Mainnet 缺授权能力仍拒绝；预检前、预检后、SDK 实际签名前同步重新核对原批准/暂停/撤销/退出/原 quote、resource、challenge、付款配置。重复签名、原始字节/消息绑定、单次 SDK 签名和原付款恢复约束保留；前端/MCP 不取得签名能力。锁定 @x402/core / svm 2.25.0 的 registerPolicy、spend controls、checked signer 未替换。
- 验收测试：[Mainnet signing](../../tests/unit/mainnet-signing.test.ts)、[锁定 SDK](../../tests/unit/mainnet-sdk.test.ts)、[策略](../../tests/unit/policy-ledger.test.ts) 覆盖缺授权/错批准/资源/完整 challenge、模拟结束后的暂停/撤销/停服/禁用、错误 quote/recipient/mint/network、真实 SDK fixture 构造及完整 Ledger 输入校验。
- 修复进度：经济事实输入与签名 seam 已完成并通过本批验证。存储的协议 envelope、Solana 原证据与当前产品资源模型仍保持具体类型；这是现有单一 x402/Solana exact 产品合同，不宣称支持其它协议，也不为此迁移历史行。

## BR-06 — 状态转换分散与普通 string

- 当前状态：**Fixed**（purchase 状态类型与操作级转换范围）。原报告是类型/状态约束债，未证明非法转换已发生。
- 源码：[purchase-state](../../src/modules/purchases/purchase-state.ts)、[Ledger 的所有 purchase status 写入](../../src/modules/purchases/purchase-ledger.ts)、[OriginalPaymentStateSchema](../../src/modules/purchases/original-payment-record.ts)、[DeliveryRecoveryStateSchema](../../src/modules/purchases/delivery-state.ts)。
- 成因与影响：purchase status 原为 string，历史别名在本地函数转换；SQL 写入的状态顺序隐含在各方法。原付款/交付已有枚举和 SQL 约束，不能说所有状态都无约束。
- 本轮修复目标：PurchaseStatus 运行时枚举与类型覆盖记录/列表/购买响应；统一操作级转换表覆盖开始、过期、UNKNOWN、确认、未提交失败、finalized 失败及模拟完成。每个 Ledger status UPDATE 使用统一守卫；批量过期/启动恢复在原写锁中选择符合原证据条件的记录并转换。兼容 REJECTED / NEEDS_CONFIRMATION，只在读取时规范化，不改历史行；非法未知状态拒绝读取。
- 安全不变量：转换表只验证顺序，不能证明付款事实；原来的 evidence、submitted marker、原交易、模式、归属及 SQL 条件仍必须满足。UNKNOWN 只有可证明未提交或原交易 finalized failure 才失败释放；PAID 不回退；receipt/delivery 独立。没有新增 schema 迁移。
- 验收测试：[转换表](../../tests/unit/purchase-state.test.ts) 与 [Ledger 边界回归](../../tests/unit/purchase-state-transitions.test.ts) 覆盖合法/非法转换、PAID 不回退或重领、已提交 UNKNOWN 跨重启不释放、未提交释放幂等、历史别名不改原行、非法状态拒绝且保留坏行供诊断。
- 修复进度：实现与针对性验证完成；旧金融/交付回归纳入本批全量验证。未引入全新状态机框架。

## BR-07 — 读取接口允许省略 owner

- 当前状态：**Fixed**（可省略 owner 的读取歧义）。基线 Agent route 已传认证 member，未证实既有越权事故；未来误用风险不等于已有安全漏洞。
- 源码：[Ledger 显式读取 API](../../src/modules/purchases/purchase-ledger.ts)、[Agent delivery route](../../src/app/api/agent/purchases/[purchaseId]/delivery/route.ts)、[AppRuntime](../../src/modules/app/app-runtime.ts)、[requestRegisteredResourcePurchase](../../src/modules/purchases/request-registered-resource-purchase.ts)、[旧 task runtime](../../src/modules/agent/task-runtime.ts)。
- 成因与影响：基线 managed get 省略 member 时按 default member / rowid 选记录，list/events 可以跨成员；同名 requestId 未来可能选错单。
- 本轮修复目标：删除宽泛 get/list/events。成员使用 getOwned / listForOwner / eventsForOwner，owner 必填且运行时拒绝空值。getLegacy / eventsForLegacy 只查询 owner IS NULL。显式管理读取 getForAdministration 在同名跨 owner 时拒绝猜选；listForAdministration / eventsForAdministration 聚合保留 owner，管理事件同时包含内部 purchaseId/requestId。内部金融操作直接按唯一 approval_id 读取。后台恢复按保存的 owner 精确选择，不把无归属旧记录改成当前默认成员。
- 安全不变量：owner 来自后端认证或持久行；Agent 不能选择管理/legacy 入口。已撤销连接仍由认证层拒绝；读取不修改原 owner。成员范围幂等、原证据不泄漏、旧记录兼容保持；App 测试入口显式传入可信默认成员，重放不再依赖旧的隐式 lookup。
- 验收测试：两个成员及 ownerless 历史共用 requestId 时，各自购买/事件/交付隔离；空/未知/错误 owner 拒绝或无结果；管理聚合与有歧义单条查找拒绝；原有 Agent 认证/交付、相同 requestId 幂等、启动恢复和 App 管理回归。
- 修复进度：所有生产读取调用点与相关测试已迁移，全量与安装验证通过。没有为 Agent 新增管理员读取 endpoint。

## BR-04 至 BR-07 交付记录（2026-10-16）

- 范围：按用户选择先抽取交付，再完成剩余 P1。保留此前 BR-01/02/03 未提交修复，不重写 PurchaseLedger，不增加新的协议/数据库/依赖或迁移。
- 核心文件：`src/modules/purchases/purchase-ledger.ts`、新增 `purchase-delivery-store.ts`、`purchase-state.ts`、`purchase-signing-authorization.ts`，以及从 payment 移至 purchases 的 `production-execution-gate.ts`；`src/modules/payment/solana-payment.ts`、`src/modules/authority/authority-policy.ts`、`src/modules/purchases/approved-payment.ts`。
- owner 调用迁移：`src/modules/app/app-runtime.ts`、`authority-overview.ts`、`src/modules/agent/task-runtime.ts`、`src/app/api/agent/purchases/[purchaseId]/delivery/route.ts`、购买层的 `purchase-market-snapshot.ts` / `request-market-purchase.ts` / `request-paid-resource-purchase.ts` / `request-registered-resource-purchase.ts` 及旧 `scripts/task-acceptance.ts`。测试调用按真实归属改为 owned/legacy，管理聚合显式命名；相关接口迁移不是无关重构。
- 文档：本 Backlog、`authority-core.md`、`mainnet-readiness/conditional-mainnet-execution.md` 更新当前接口与门禁位置；README 的前批入口保留。用户已有的其它未跟踪架构文档/图片未修改。
- 自动化结果：最终 **81 files / 1001 tests passed**，`npm run typecheck`、`npm run lint`、`git diff --check` 均通过。第一次全量有 5 处旧测试调用失败（4 处恢复未传 fixture owner、1 处 delivery route mock 仍暴露 get）；均已修正为明确 owner 接口，重跑全量通过，没有恢复隐式默认 owner 选择。Vitest 的既有 configLoader ESM 提示仍存在，无测试失败。
- 新回归：delivery 的 3 个跨表失败回滚；purchase-state 的 16 个规则与 7 个 Ledger 边界用例；owner reads 的 2 个隔离/缺 owner 用例及缺 owner 不恢复默认成员订单；4 个签名 capability 绑定/临签策略用例；2 个纯经济事实与完整协议输入门禁用例。保留既有 payer/recipient/mint/network、pause/revoke/quit、预算、重放、并发、重启、原证据、持续 UNKNOWN 和 inactive Resource 回归。所有测试使用临时数据/fixture/模拟网络，不是实际付款证据。
- 独立复查：检查交付组合事务、全部 purchase status UPDATE、授权 capability 的 3 个复核点、纯经济策略的唯一生产调用点、owner/legacy/管理调用隔离，未发现本批新增问题。复查不是对所有历史代码的完整安全审计。
- 构建与安装：通过 Yosh 菜单正常退出旧 App / backend（86991 / 87003），进程退出、3049 端口释放后运行现有 `scripts/install-macos-app.sh`。backend production build、macOS Release build 成功，更新 `/Users/irin/Applications/Yosh.app`；安装包与本次 Release 产物 `diff -qr` 完全一致，`codesign --verify --strict` 通过。日志为 `/tmp/yosh-buyer-reliability-p1-install.log`。Xcode 仍报告本机 CoreDevice/CoreSimulator 插件与版本问题、AppIntents metadata 跳过；macOS target 明确 BUILD SUCCEEDED，未改系统或其它功能以隐藏提示。
- 安装版运行：App 3755 路径 `/Users/irin/Applications/Yosh.app/Contents/MacOS/Yosh`，backend 3776 是其子进程，仅监听 `127.0.0.1:3049`。本次 lifecycle 日志有 managementAuthenticated / coreReady / walletAvailable。实际 Codex `get_spending_status` 成功，Mainnet configuration / service / wallet ready；既有 `SPEND_GRANT_EXPIRED` 继续拒绝消费，没有创建或续期 Grant。未认证 management overview 与 Agent status 均 401。执行 Window→Close 后同一 App/backend 存活，实际宿主只读调用继续成功，已 Raise 恢复正常 PIN 页；未读取/输入 PIN 或修改 App Lock。
- 数据与前端检查：只读打开真实产品 Ledger，integrity_check=ok、foreign_key_check=0；现存 status 均在本次支持枚举中。未删除/重建或手工修改用户账本。前端 `.next/static` 对指定签名、敏感配置及新模块标识符有限扫描零命中；不将其称为完整打包安全审计。
- 保留限制：Ledger 继续协调成员、Grant、预算、原证据和迁移；进一步拆分不是本批验收条件。原付款与存储的 HTTP/x402/Solana 证据仍具体化，没有预建多协议能力。purchase 转换表不替代证据校验或 SQL 约束；直接修改数据库仍属于受信操作。第三方恢复能力、缓存保留期和 RPC 历史完整性尚不能由本地测试证明，交付的既有 4 次重试上限保留。
- 无真实 Mainnet/Devnet 付款、无密钥导出、无 Commit / Push。Backlog 本轮约定的七项均已处理；建议下一步人工审阅当前 diff 和安装版，另行授权真实商家恢复验收，或再按明确需求选择下一处架构抽取，不自动扩大功能范围。
