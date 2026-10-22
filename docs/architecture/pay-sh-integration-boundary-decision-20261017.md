# Yosh × pay.sh — Integration Boundary Decision（Phase 1.5b）

日期：2026-10-17。状态：**待审阅的边界决策建议；本轮只读源码并新增本文，不实施解耦、Adapter 或新实验。** 首期仅 Solana x402 V2 exact、原版 USDC，保留当前 Yosh 独立实付路径。

## 1. 决策摘要与两套 B

**两套 B 可以同时成立，但当前尚未接通。建议以路线 2 为下一次隔离真实 pay 实验的目标；路线 1 保留为已有 SDK 可行性证据和部署备选。原样 pay MCP 接入仍 BLOCKED。**

- 总体计划的**主路径 B**决定业务调用方向：pay MCP 发现/选择报价，调用 Yosh External Authority，再推进支付协议。
- 安全合同的**方案 B**决定付款能力归属：有效凭据只在 Yosh Trusted Gate，最后携款 HTTP 也由 Gate 启动。pay 调用“提交原 operation”的服务，不取得签名再自行发送。
- 因此“pay 执行协议”不要求 pay 自己持有签名或 socket；它必须实际负责 challenge、协议构造、结果解释与流程推进。若 pay 只转发 Yosh 已完成的整个购买调用，就没有实现总体计划希望复用的协议能力。

基线是 [Phase 1.5 报告][spike]、[签名提交合同][contract]、[生命周期审计][audit]及 Downloads 中实际唯一相关的[总体计划][master]。Yosh HEAD `f65c9bd30a2cad65493d2e70b15624be26e216ed`；pay HEAD `df57843e1f728fcc8ff8e42db78e0ad99372cd9d`，pay-kit rev `f8ef055b1d1c8ca8245f19bbca819faed9cfa058`；以当前工作树为准。总体计划 SHA-256 仍为 `286dcf6726f4b0645763d0324184be5d0203e85dddb8b1eeeae8dd52dd48cc02`，没有版本冲突或路线图修改。

**已证实的范围：** Phase 1.5 的真实 Rust builder 产物兼容 Yosh 严格识别器；JS SDK 在 Gate 内构造/签名/发送的隔离模型成立。**尚未证实：** 真实 pay MCP 编排、Rust unsigned prepare、Yosh Gate 三者连成一条运行链。本轮未重跑历史实验，不把模型结果外推为 pay 已兼容。

## 2. 两条部署路线的具体职责

这里的 Gate 是 Yosh 可信执行边界，原则上归属现有唯一后端 owner；不能把任意代理或自由 Executor 改名为 Gate。

| 职责 | 路线 1：Gate 托管协议 SDK | 路线 2：pay 编排协议，调用 Gate 完成与发送 |
| --- | --- | --- |
| challenge 解析/选择 | Gate 中 SDK 解析；pay 可做发现/候选选择，Yosh 校验原报价与不可变请求 | pay 用真实 parser/classifier 解析、选择；Yosh 独立校验原 challenge、请求、Grant 和经济绑定，不信任 pay 的结论 |
| 付款构造 | Gate 内协议 SDK 构造 | pay 中真实 Rust pay-kit 构造 unsigned，输出非消费计划与确切 wire；不在 Gate 再造一笔交易 |
| Rust pay-kit 位置 | 若采用 Rust，则作为 Yosh 可信组件运行，签名结果不得返回自由 pay；此部署未完成验证 | pay 进程内仅做解析/unsigned 构造；需要从现有 exact builder 分离 prepare 接口 |
| JS x402 SDK 位置 | 现有实验在 Gate 内 build/sign/encode；Rust 格式兼容实验是另一条证据 | 最小 PoC 在 Gate 只复用已验证的官方 header encoder，不调用 JS builder 重建 Rust message；现有独立路径照常使用其 JS SDK |
| unsigned 验证 | Yosh 用原严格验证器，绑定权威原单 | 同左；额外把 pay 的 unsigned digest 固定到该 operation，拒绝换 message/报价/请求 |
| 有效凭据持有者 | 仅 Yosh/Gate；商家收到后已越过不可撤回边界 | 同左；正常 IPC 只返回 handle、状态及安全观察，不返回 buyer signature、signed wire 或付款头 |
| 真正 HTTP 启动 | Gate 最后检查、存证、登记后启动 | pay 发起提交请求，Gate 完成最后检查、存证、登记并启动真实 HTTP；不返回一个让 pay 自由发送的 permit |
| 商家响应 | Gate 先接收，SDK 解析；pay 接收必要结果 | Gate 先接收并保留原事实；pay 接收有界、安全的 status/协议头/receipt/body 观察并用真实协议代码解释，消费凭据不回传 |
| 协议重试 | 可信 SDK/协调器提出动作，Yosh 决定经济作用 | pay 提出后续协议动作；Unknown 查询原 operation，不重新 build/sign 或盲目重发首次付款；已付交付仅按原声明恢复 |
| 权威恢复 | Yosh 保存原证据、预占、核对及一次记账；SDK 只提供协议能力 | 同左；pay 恢复协议进度/原结果查询，不拥有第二份经济 Ledger，也不把报告直接当作 PAID |
| Pause 强制点 | 与实际 signer/最后 HTTP 同一 owner 和控制顺序 | 同左；旧 pay 只有非消费 handle，Gate 拒绝旧代次的新经济请求。pay 失联不自动阻止已封闭 Gate 的 quiescence |
| 是否真正复用 pay | 直接采用 JS SDK 只证明 SDK 复用。必须另外落实 pay 的编排或受托管 pay-kit 组件，不能以转发桥声称主路径完成 | pay 实际解析、构造 unsigned、解释响应、推进协议，Yosh 保留经济裁决与最终出口，职责明确 |
| 上游接口改动 | pay MCP 仍需非消费调用/响应/恢复接口；若托管 Rust 还需可信组件接缝，原 MCP 不能原样搬入 Gate | pay-kit unsigned prepare；pay-core/MCP controlled branch、Gate 调用与结构化响应/原操作恢复；不要求先重构全部 CLI/proxy |

**有条件可行：路线 2。** 它最直接保留主路径 B 的 pay 协议职责，但比已运行的 JS Gate 模型多一个真实接口缺口。路线 1 并非技术失败；只是不能未经审阅就以“Yosh 直接使用 JS SDK、pay 转发”代替既定集成目标。

## 3. 当前真实缺口与最小接口

当前实际链路是 `pay MCP exact → pay-core 内部加载 signer → pay-kit build unsigned → sign → encode → 有效 headers 返回 MCP → 自行 fetch`，不是 controlled prepare。[P1][P2][K1]

Rust exact builder 的 `build_unsigned` 在第 89 行，97 行必经 signer，99 行编码；公共 `build_payment_header` 包含整个流程。其 exact SPL/memo 构造及 `encode_payment_envelope` 仍为私有函数（430、368、163 行）。**没有现成的 exact prepare/finish API。** `TransactionSigner` 成功返回后原调用者持有已签交易；仅插入远程 signer 会把消费能力交回 pay，不满足 B。dummy signer 假装成功或捕获 unsigned 后报错，也不算正式 prepare 接口。[K1][K2]

建议最小语义接缝如下，名称仅用于设计，均非当前已有 API：

1. **Authenticated operation / claim：** 专用受控 pay 实例绑定 Yosh 成员及稳定 operationId，携原始 challenge、选定 offer 和不可变 HTTP 请求；Yosh 唯一 reserve/claim。重试同一 ID，不用 MCP 临时 request ID 代替经济身份。
2. **Unsigned prepare：** 从真实 Rust exact builder 抽出原构造代码，使用买方公钥，输出 unsigned wire、envelope metadata 与 digest；不加载钱包、不签名。不得另写 TransferChecked/memo 来冒充 pay-kit 复用。
3. **Controlled complete / submit：** Gate 独立验证原单与 unsigned、受控签名、严格原身份及证据先落盘，最后重查 Pause/owner/代次并登记、启动请求。签名完成和提交可分内部 job，但只能返回非消费 handle；不能把签名返回值跨回 pay。
4. **Structured observation / original query：** Gate 保存原响应事实并提供安全的协议观察，pay 实际分类/解释。当前底层 `RawResponse` 和 `classify_402` 可复用，MCP 的最终文本不足；响应不能顺带导出有效凭据。重连先查原 operation/attempt。[P3]
5. **Controlled-mode fail-closed：** 受控入口拒绝非 V2 exact USDC、cached auth/session、SIWX/upto/batch、自填付款头、自主钱包 fallback 和自由发送路径。`AuthOverride` 只是审批提示替换，不能承担上述合同。[P4]

Gate 可在最小 PoC 使用已验证的 JS 官方 encoder 包装同一 Rust message；若最终采用 Rust finish/encoder，也应暴露原库逻辑并留在可信边界。两者都不能让 pay 收到 signed payload 后再包装发送。

## 4. 剩余五个 P0：决定什么、阻塞到哪里

以下属于未来 B/C 能力或验证缺口；本轮未据此发现 Yosh 独立运行的 A 类缺陷。

| P0 | 已有事实与最小决定 | BLOCKED 的对象/解除证据 |
| --- | --- | --- |
| 唯一 Trusted Gate | 现有 owner 对规范化数据目录持 SQLite 写锁，在 Ledger 打开前取得。未来 Gate 归属该唯一后端；同钱包/经济 scope 不能另开独立出口。旧 owner 未退出不得凭超时/lease 启动替代 Gate。[Y1] | 外部生产签名/发送。需验证旧 Gate 存活时第二 owner 被拒、所有 Pause/sign/send 均经唯一控制序列；该锁不会自动约束其他目录/helper |
| marker 后、HTTP 前崩溃 | 当前 marker 与 HTTP 同步相邻，但 DB 与网络不可能原子。决定保持 **Unknown、原证据和预占，不重签、不自动重发**；商家计数 0 也不是生产恢复端可自动知道的事实。[Y2] | 尚缺这个精确故障切点的运行证据；阻塞外部真实路径验收，不要求改写现有正确合同。隔离副本可在 marker commit 后直接终止测试 Gate，无需给生产临界区加 await |
| 外部记录/本地恢复隔离 | 当前原证据严格 v1、无 executor provenance；启动释放依赖本地独占前提。未来创建时固定 local/external 来源、custody、owner 和唯一恢复器，预算仍在同一权威事务。[Y3] | 首笔生产 external record。不可直接混入旧分支。B 若能证明仅唯一 Gate 持有、无 marker 且旧 job 已封死，可认定未提交；不能只因“无本地 payload/marker”释放。未知不 fallback 本地重付 |
| 旧 Yosh 误处理 | 当前 constructor 打开后即有迁移/写入，未见阻断不兼容 writer 的门。新字段、side table、feature flag 不会约束不认识它们的旧二进制。[Y3] | 首笔生产 external record 前必须选择并实测兼容写入保护/强制阻断不兼容回滚，保留恢复兼容版本；覆盖旧二进制直接打开，不只检查安装器提示。隔离新库和纯类型整理无需先造完整版本框架 |
| 原样 pay MCP 缺口 | 当前无 Authority/非消费 prepare/最终 Gate transport/完整响应合同，仍自行持付款头并发送；还有账户初始化和缓存分支。[P1][P2][P4] | 原样 pay 接入 **No-Go**。需真实 MCP handler→Rust prepare→Gate→原响应解释的隔离证据；只证明 SDK/Mock Executor 不解除此项 |

**不扩大当前阻塞：** 首期只需封闭专用 controlled MCP 可达路径。未暴露的 CLI、payer proxy 及其他协议可保持不支持，无需先全量改造；真实 HTTPS/Mainnet、性能、UI、完整故障矩阵和发布运维在对应 Adapter/验收阶段完成。最小身份绑定、原单去重、无凭据泄露、唯一 Gate 和 Unknown 不重付不能延后到 Mainnet 才考虑。

Pause 仍分别报告 **Pause Requested、New Payments Blocked、In-flight Quiesced、Historical Reconciliation**。L_P 必须与最终 HTTP 启动排序；已启动原款可在 Pause 后确认。L_Q 不等待历史款全部终结；有 signer 尚在途则待其结束/安全隔离，只有非消费 handle 的失联 pay 不必无限等待 ACK。

## 5. 最小下一步：先真实 pay 接缝，再按授权缩小内部改动

**现在可单独评估一个不改变资金行为的抽出：** 将 `purchase-ledger.ts` 现有 `SpendReservation` / `PurchaseRecord` 类型原样放入候选 `src/modules/purchases/purchase-contract.ts`，旧路径保留 type re-export。保持全部字段与类型语义，不新增 runtime/schema/API。`PaymentEvidence`、`StoredPurchaseExecutionMode` 可暂时 type-only 引用原定义，不顺手搬动运行时校验。[Y4]

这只是降低类型导入耦合的**有条件 Go 建议**，需另行授权和常规回归；不解除总体计划阶段 2 的前置门，也不值得替代真实 pay 接缝验证。现有 authority-policy 已有纯规则，直接复用，不再抽第二个 authority engine。

**不得提前改动：** `reserve/claim` 与 Grant/共享额度事务、`approved-payment` 的 claim→sign→save→marker→HTTP 顺序、底层 signer 守卫、严格 unsigned/原证据验证、`reconcile-transaction`、Ledger schema/启动释放/迁移、Pause/owner 生命周期及含凭据的交付恢复。不能先替换成自由 `Executor.execute()` 再补安全边界。

**推荐下一次另行授权的最小实验：** 在独立临时 pay/pay-kit Fork 和隔离 Gate harness 中，仅接一条真实 MCP exact 分支（`curl.rs` 当前 1221 附近），由实际 stdio MCP `tools/call` 驱动，调用真实 pay-core parser/classifier 和改造自原库的 unsigned prepare。两业务进程、一个假商家/假 RPC、临时 SQLite、Yosh 侧一次性离线密钥；不接生产 Adapter、Keychain 或现有 Ledger。

最低验收点：

- 正向链路由真实 pay 选 challenge、构造 unsigned、解析 Gate 回来的真实协议观察；Gate 核验同一 message/经济绑定，pay 无 signed wire/header，商家首次付款请求为 1。
- barrier 控制 Pause 在 signer 在途、签名已成但未发送，以及 HTTP 启动两侧的顺序；旧 pay 仅持 handle 无法自行付款，旧代次不能重新取得执行权。
- 单独在 marker 持久化后、HTTP 前终止 disposable Gate；假商家请求 0，重启保留原证据/预占并进入 Unknown，签名累计 1，不因“看似没发”自动重建。
- 提交 ACK 丢失/重连只查询原 operation；原付款在 Pause 后确认并仅记账一次。新购买关闭后原核对仍可运行。

本地 Fork 不需上游先同意，可以完整记录临时 patch 和调用证据；不能称官方兼容或 upstream。本次不编写、不执行上述实验。其余 exact 分支及完整生产 fault matrix 留给后续验证，不以这一分支通过宣称全入口通过。

## 6. Issue #505 与 Go / No-Go

未来 #505 应讨论的**必要接口**：可选 External Authority/可信 caller、稳定 operation、unsigned prepare、非消费 handle/最终 transport、结构化响应和原操作恢复；说明 remote signer 不足，以及受控模式禁止钱包/发送 fallback。它们必须在本地真实 PoC 成立后再主张接口可用。

可延后讨论公共命名、通用 hooks/capability 协商、其他链/协议/资产、CLI/proxy 支持、跨平台部署、完整 outbox/运维与发布方式。生产级持久恢复需在生产外部入口前落实，但无需为最小隔离 PoC 先开发通用框架。本轮不联系维护者、不更新 Issue。

| 对象 | 决策 |
| --- | --- |
| 两套 B 的职责同时成立 | **有条件可行**；以路线 2 的真实 pay 协议编排 + Yosh 最终出口验证，不改变持钥方向 |
| 下一轮独立本地 Fork/harness | **Go 建议，待另行授权**；不接生产数据，可先于生产恢复/兼容门的实现 |
| 仅原样类型契约抽出 | **有限、有条件 Go 建议**；本轮不实施，不代表整体阶段 2 获准 |
| 原样 pay MCP、核心签名/提交/Ledger 生产解耦 | **BLOCKED / No-Go 提前实施**；真实接缝及相应 P0 尚未验证 |
| 外部实付 | **No-Go**；本轮没有任何资金授权 |

本轮仅源码复核和文档检查；没有新增/运行测试、实验、构建或 App 安装，没有修改既有代码/测试/路线图/pay、钱包或 Ledger，没有 Commit/Push。完成后停止，等待审阅。

[spike]: /Users/irin/Desktop/yosh/docs/architecture/pay-sh-controlled-egress-feasibility-spike-20261017.md
[contract]: /Users/irin/Desktop/yosh/docs/architecture/pay-sh-signing-submission-contract.md
[audit]: /Users/irin/Desktop/yosh/docs/architecture/payment-pause-lifecycle-audit.md
[master]: /Users/irin/Downloads/Yosh-pay-integration-master-plan.md
[P1]: /Users/irin/Desktop/open-source/pay/rust/crates/core/src/client/x402.rs:161
[P2]: /Users/irin/Desktop/open-source/pay/rust/crates/mcp/src/tools/curl.rs:1221
[P3]: /Users/irin/Desktop/open-source/pay/rust/crates/core/src/client/fetch.rs:512
[P4]: /Users/irin/Desktop/open-source/pay/rust/crates/mcp/src/context.rs:24
[K1]: /Users/irin/.cargo/git/checkouts/pay-kit-faefdef5c8b4a8fb/f8ef055/rust/crates/kit/src/x402/client/exact/payment.rs:25
[K2]: /Users/irin/.cargo/git/checkouts/solana-keychain-c5dad7cab7b9e431/44b479d/rust/src/traits.rs:70
[Y1]: /Users/irin/Desktop/yosh/src/modules/app/data-directory-owner.ts:12
[Y2]: /Users/irin/Desktop/yosh/src/modules/purchases/approved-payment.ts:169
[Y3]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:538
[Y4]: /Users/irin/Desktop/yosh/src/modules/purchases/purchase-ledger.ts:53
