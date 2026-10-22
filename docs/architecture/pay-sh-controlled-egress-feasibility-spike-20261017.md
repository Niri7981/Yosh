# Yosh — Phase 1.5 Controlled Egress Feasibility Spike

日期：2026-10-17（Asia/Shanghai）。范围：Solana x402 V2 `exact`、原版 USDC，真实锁定 SDK 接缝与隔离无资金实验。**没有修改 Yosh/pay 生产代码、现有测试、钱包或 Ledger/schema；没有真实钱包签名、付款、外网提交、Adapter、Commit 或 Push。** 离线密码学操作只使用本轮一次性测试密钥。

## 1. 结论与 Go 边界

**方案 B 的 SDK 层没有硬性阻断，受控出口候选已得到隔离运行证据；未修改的 pay MCP/CLI 路径仍然不能直接满足方案 B。** 可行候选是把真实协议 SDK 的构造、受控签名、payload/header 和最后 HTTP 留在 Yosh 可信 Gate，外部 Executor 仅持非消费计划/handle，接收必要的响应/协议观察。协议实现仍复用 SDK，不手写支付协议。

本轮分三类证据，不能混为“正式集成通过”：

- **真实 Rust pay-kit 链路 PASS：** 实际 parser→exact V2 builder→一次性 MemorySigner→header；v0、无 ALT、canonical USDC，赞助方离线补签保持原 message/buyer signature。
- **真实跨 SDK/原证据验证 11 PASS、0 FAIL：** Rust 产物通过 JS 公共接口及未修改的 Yosh 严格验证器；错误绑定、真实 unsigned wire 篡改、无效签名和错误交易 ID 被拒绝。
- **独立进程模型 14 个场景全部符合预期：** 13 个正向/安全场景，加 1 个故意不安全的对照场景。对照成功观察到强 Pause 性质的预期失败；不是第 15 个独立场景，也不是生产缺陷。

**能否按总体计划直接进入阶段 2 内部解耦：目前不具备无条件 Go。** 受控出口核心假设及交易身份兼容已证明到本报告的边界；但实际 pay 的受控接口/全部出口封闭尚未实现或运行验证，唯一 Gate 所有权、生产恢复/迁移及旧版兼容也未验证。下一步应先审阅“SDK 托管在 Yosh 可信边界”的具体接缝与剩余门槛，再另行授权最小实现；本轮不开始解耦。

这不是因为真实 SDK 不支持而触发的第一阶段硬停：第一阶段追到 SDK 实际构造/签名/发送分离边界后，才开展第二阶段。没有将原样 pay MCP 的 No-Go 隐藏成兼容，也没有改用方案 A 绕过停止保证。

## 2. 当前基线与范围

| 对象 | 实际核对 |
| --- | --- |
| Yosh | `/Users/irin/Desktop/yosh`，`main`，HEAD `f65c9bd30a2cad65493d2e70b15624be26e216ed`；原有未提交修改保留，以工作树为准 |
| pay | `/Users/irin/Desktop/open-source/pay`，`fix/journal-utf8-recovery`，HEAD `df57843e1f728fcc8ff8e42db78e0ad99372cd9d`，workspace 0.30.0 |
| Rust pay-kit | `solana-pay-kit` 0.10.0，锁定 rev `f8ef055b1d1c8ca8245f19bbca819faed9cfa058`；本地源码及已有 rlib；配套 keychain rev `44b479df245167ca3b3a4e04d6d907146306d342`，仅使用 memory signer |
| JS SDK | `@x402/core` / `@x402/svm` 2.25.0，`@solana/kit` 5.5.1；执行的是本地实际库 |
| 总体计划 | Downloads 中实际仅有 [Yosh-pay-integration-master-plan.md](/Users/irin/Downloads/Yosh-pay-integration-master-plan.md) 这一份相关计划；未假定 V2 存在，未修改计划 |
| 合同/已有基线 | [签名与提交合同](/Users/irin/Desktop/yosh/docs/architecture/pay-sh-signing-submission-contract.md)、[生命周期审计](/Users/irin/Desktop/yosh/docs/architecture/payment-pause-lifecycle-audit.md)、[既有本地测试](/Users/irin/Desktop/yosh/tests/unit/payment-pause-lifecycle.test.ts)；本轮没有重复运行它们来冒充新证据 |

总体计划的“主路径 B”是 pay 调用 Yosh External Authority；安全合同的“方案 B”是 Yosh 控制最终有效凭据出口。这是两套标签，不是同一项结论。SDK 托管候选保持 Yosh 持钥和下游协议复用，尚需审阅它如何接入计划主路径。

首轮不包含 V1、SOL、Token-2022、MPP、upto、batch、SIWX、订阅、会话、任意付款头或新支付协议。以下对额外路径的检查用于识别必须封闭的出口，未宣称这些路径已被实验支持。

## 3. 第一阶段：实际调用链与能力分类

分类：**已有支持**是当前实际公共原语；**局部适配**是已识别或实验验证的可信边界组合；**需改 pay**是当前原路径没有的接缝；**不足/BLOCKED**表示尚无实际证据，不能写已实现。

| 问题 | 实际调用链与返回内容 | 分类/本轮结果 |
| --- | --- | --- |
| 报价与协议计划 | Rust `parse_x402_accepts` 解析真实 challenge；JS 公共 HTTP adapter 解码 PAYMENT-REQUIRED。解析结果本身不含付款能力，也不是经济授权 | **已有支持；PASS**。仍需 Yosh 严格 allowlist/不可变请求绑定，不能信 parser fallback |
| unsigned transaction | Rust exact builder 内部 `core::tx::build_unsigned` 后直接调用 `TransactionSigner::sign_transaction(&mut tx)`；JS ExactSvmScheme 编译后进入 partial signer callback，能看到真实 message/签名槽 | **已有签名接缝；局部适配可行**。没有专用 exact `prepareUnsigned()` 成功返回 API；未用 dummy 成功签名伪造它 |
| 构造与签名分离 | SDK 全程在可信 Gate 内运行；真实 signer callback 先验证 unsigned 经济绑定，随后只在 Gate 中完成离线签名 | **局部适配；JS 运行 PASS**。Rust 使用真实 MemorySigner 的格式兼容 PASS，动态 Yosh↔Rust signer/IPC 托管未实现 |
| 签名与发送分离 | Rust exact builder 返回 payload/header，不做 merchant HTTP/broadcast；JS 裸 exact client 也不发送付款请求，仅有 mint/blockhash 读取 | **已有支持；PASS 到本轮运行边界**。可在 Gate 保存证据后单独发送，不需要重写 exact 指令 |
| 外部只拿非消费 handle | Gate 保存原 payload/identity；普通 Executor IPC 仅有 handle/state/digest/原结果摘要。真实 SDK 结果不返回自由 Executor | **局部适配；双进程模型 PASS**。不是 pay MCP 已有接口 |
| 最终出口附加有效凭据 | Gate 调真实 `encodePaymentSignatureHeader`，提交登记与 `node:http.request` 启动之间无 await；假商家验证真实签名并补签 | **局部适配；PASS**。实际传输是本机 HTTP，不是生产 HTTPS/DNS/主网验收 |
| 商家响应与协议错误回传 | JS `parsePaymentResult({status,getHeader,body})` 不需 paymentPayload；pay 底层有 RawResponse 和 public classify_402，MCP 最终结果却丢 headers/精确 status | **原语已有；JS PASS；需改 pay 的结构化结果接口**。不应把要求 payload 的 processPaymentResult 直接搬到自由 Executor |
| 不可绕过的 pay 出口 | 当前 pay 内部加载 signer，build 得到有效 header，再自行 fetch；CLI 外部 curl/wget/httpie、payer proxy 另有出口 | **需改 pay；当前直接接入 BLOCKED/No-Go**，本轮未修改或运行这些路径 |
| 严格原交易与恢复 | 实际 Rust partial/full wire 由原 Yosh validator 重解；实际 JS 模型调用原 reconcileStoredOriginalPayment，通过假 RPC 查询同一原交易 | **真实验证器兼容 PASS；模型恢复 PASS**。没有替换生产 Ledger/Grant、验证安装版或外部记录迁移 |

### 3.1 Rust 实际路径

`pay MCP curl → pay-core::x402::build_payment_with_override → 内部账户 signer → pay-kit::build_payment_header → build_payment → build_unsigned → TransactionSigner → encode → 有效 header 返回 MCP → fetch_request → FetchClient.send`。[P1][P2][K1][K2]

关键事实：

- kit 在签名前把完整 VersionedTransaction 交到 transaction-aware callback；该能力与会广播的 SendingSigner 分开。builder 自身不发商家 HTTP。
- kit 的 exact SPL 指令构造是私有函数。虽然 generic build_unsigned 是 public，本轮没有自行重造 TransferChecked 来假称复用 exact。
- Rust harness 提供固定 recentBlockhash，只为完全断网；不表示生产可以相信商家任意 blockhash/RPC hint。真实 Yosh 现有配置、独立 RPC/preflight/simulation/lifetime 约束仍须保留。
- 没有 memo 或 blockhash 时重复 build 可得到新材料；Unknown 恢复必须复用第一次原 message/payload，而非再 build。
- 当前 pay 的 AuthOverride 不是 Yosh 动态经济授权/受控出口；把它当成外部签名、最后发送或停止屏障接口都不成立。

### 3.2 JS 实际路径

`x402Client.createPaymentPayload → ExactSvmScheme → mint/ATA/blockhash/指令 → partiallySignTransactionMessageWithSigners → compileTransaction → partial signer callback → signed payload`。然后由调用方另行编码 header/选择 transport。[J1][J2][J3]

Gate 内真实回调使用未修改的 `assertUnsignedPaymentBindings`；生成后调用 `createSignedPaymentIdentity / validateSignedPaymentIdentity`，保存原字节和身份，再到受控 HTTP。恢复使用原 `reconcileStoredOriginalPayment`，HTTP 200 或 SDK receipt 不直接记 PAID。[Y1][Y2]

普通 SDK creation hooks、extension enrichment 如被注册，也必须在可信边界内；本实验不注册外部可执行 hook。裸 exact client 的 cache 是 mint metadata，不是有效付款凭据缓存。不是所有高层自动 fetch wrapper 都继承这一性质，实验没有使用它们。

### 3.3 pay 仍需封闭的路径

| 路径 | 真实现状 | 当前判断 |
| --- | --- | --- |
| MCP exact 三分支 | build 后完整付款头位于 MCP 进程，再直接 fetch | 无 controlled handle/transport 接缝，**BLOCKED** |
| CLI exact | 完整 header 交 retry_with_headers，可能走 curl/wget/httpie/internal fetch | 自由持有凭据，不能作为 B 出口，**BLOCKED** |
| payer proxy | 构造 exact Authorization 后自行附加并异步发送 | 未纳入 Yosh gate，**BLOCKED** |
| 初始 cached authenticate/session | 首次 fetch 前可能已有 Authorization，不等下一次 402 才进入签名分支 | 首期必须显式排除；不能只加 exact signer hook 就声称所有消费受控 |
| SIWX、upto、batch、协议重试/代理 | 独立分支与 debugger proxy 等路径存在 | 首期 deny-by-default，未逐一实接/封闭；不把静态 permissions 当 Pause |

这些是未来 C 类接缝要求，不是本轮发现 Yosh 独立运行的 A 类缺陷。没有执行真实 pay CLI/MCP，没有声称它们通过了反绕过验收。

## 4. 真实 SDK 隔离 harness

全部实验位于独立临时目录：

[/var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx](/var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx)

### 4.1 Rust pay-kit

[main.rs:5][H1] 直接调用锁定库的 parser、exact builder 和离线 MemorySigner。以只读现有 rlib 编译，输出仅写临时目录；没有 Cargo 下载、修改 checkout 或重建 pay 工程。

实际得到 v0 / 2 签名槽 / 无 ALT 的 canonical USDC payload，买方已签、fee payer 槽为空；真实 SDK `cosign_versioned_fee_payer` 离线补签后，message 和 buyer signature 不变。运行在 **全部网络禁止** 的 sandbox 内；若意外走 RPC 会失败，而不是连接某条链。

结果：**PASS**。[编译命令](/var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx/paykit-harness/compile-command.json)、[执行命令](/var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx/paykit-harness/run-command.json)、[日志][L1]。fixture 权限 0600，无私钥落盘；报告不复制签名载荷。

### 4.2 Rust → JS → Yosh 严格识别

[main.mts][H2] 使用实际 Rust fixture，未 mock SDK 或原 validator。**11 PASS、0 FAIL**，详见 [result.json][L2]：

1. JS 官方 header 解码/编码保留 accepted。
2. 将真实 Rust 交易签名槽清零后的 unsigned wire，通过原 unsigned 绑定检查。
3. 原 Rust buyer-partial wire 可生成并再验证严格 identity。
4. fee payer 补签后，原 message、buyer signature 和原交易识别一致。
5. 错误 recipient 被 unsigned/signed 两个边界拒绝。
6. 错误 amount 被拒绝。
7. 错误 mint 被拒绝。
8. 直接篡改真实 unsigned wire 的金额、mint 账户、目标账户，保持原授权不变，仍被拒绝。
9. 缺失或损坏 buyer signature 不能成为 signed identity。
10. full wire 损坏或无关 transaction ID 不能确认原付款。
11. 官方 response parser 无须 paymentPayload 即可解释 settlement 和 402 协议错误；该 fixture 的返回材料不含原付款 header/wire/buyer signature。

第 11 项验证 API 可分离，不保证任意恶意商家响应永不反射/重新编码凭据。真实响应的安全输出策略仍是接入门槛，不能把 fixture 的简洁 body 当成普遍脱敏证明。

## 5. 第二阶段：独立进程 Controlled Gate 实验

### 5.1 结构与隔离

- 两种独立业务进程：`Mock Authority/Controlled Gate` 与 `Mock Executor`，Node IPC 通信；由独立 driver 编排并托管假商家、假结算器及假 RPC。旧实例场景会暂时有两个 Executor，不把同线程对象冒称两个进程。
- Gate 持有一次性离线 buyer signer；运行实际 JS SDK 和原 Yosh 验证/核对函数。Executor 不获得私钥、buyer signature、signed payload 或 payment header；只取得 handle/state/digest 和所需响应摘要。
- **Authority、claim/epoch、预算、SQLite 财务转换是实验模型，不是生产 Ledger/Grant。** 每个场景独立 `MOCK-authority.sqlite`；没有打开现有用户数据库，没有更改生产 schema。
- Gate 和 Executor 分别由 macOS sandbox 启动，禁止真实 Keychain 命令/文件、钱包配置、产品数据、生产 `.data`/配置和仓库写入；网络仅允许测试 loopback。实际 HTTP 固定到本轮假商家 origin，SDK RPC 被路由到该本机假 RPC，不允许 sendTransaction。
- Executor 另被禁止读取**所有实验 run 私有目录**及其他 harness 凭据；运行中实际探测了本场和上一场离线密钥文件均被拒绝。仅 chmod(0600) 无法约束同 UID 进程，因此没有单靠文件权限宣称隔离。
- driver 本身未套嵌套 sandbox：macOS 拒绝嵌套 sandbox_apply，最终改为分别隔离业务进程。driver 只初始化本轮离线材料、监听 `127.0.0.1` 假服务和转发 IPC，不读取真实钱包/账本。此边界在执行命令记录中保留。
- 顺序全部由 IPC barrier / signer entry / 假商家收到真实 HTTP 的事件确定。定时器仅作失败 watchdog，不驱动竞态；没有随机 sleep。

mock 预算为 `100000` 原子单位，每单 `10000`。Gate 在同一 JS turn 内完成最后控制检查、提交登记及 `node:http.request` 启动，中间无 await；暂停先赢则请求不启动，先启动则原款继续核对。这不等于跨 SQLite 与物理网络 exactly-once。

普通 Executor 的身份由 driver 绑定到 OS child 的会话映射，不信请求自填 instance；这是 Mock 可信映射，不是已部署的 IPC 认证协议。Gate 重启只在旧 Gate 已退出后执行，当前实验以唯一 Gate owner 为前提。

### 5.2 逐项结果

每项结果及末态计数见 [results.json][L3]，进程 PID/屏障事件见 [events.json][L4]。下表的 PASS 都限定在该隔离模型，不代表生产 API 已实现。

| 用户要求 | 状态 | 精确证据 |
| --- | --- | --- |
| 1. Pause 与 Claim 竞争 | **PASS** | pause-before-claim：跨进程 claim 屏障后暂停，原 RESERVED 保留 `10000`，claim/新 reserve 被拒，签名/付款请求 0。claim-before-pause：两个领取仅一个成功，随后暂停使尚未签名操作安全失败，预占为 0 |
| 2. 签名在途 Pause | **PASS** | Mock signer 函数已进入，start=1/complete=0 时 Pause，quiescence=pending，预占仍 `10000`；放行后 complete=1，迟到结果不得保存/外发，HTTP=0、预占释放。挂起点在真实离线 crypto 调用前，不能据此声称密码库运算可被抢占 |
| 3. 已签但未释放凭据时 Pause | **PASS** | signed barrier 确认原有效 evidence 已保存；暂停后阻止继续执行，原 digest 保留、HTTP=0、预占安全释放；普通 Executor 从未得到有效凭据 |
| 4. 旧 Executor 只有 handle | **PASS** | 旧实例把 handle 直接交假商家得到 402，merchant accepted=0；新实例登记并 Resume 后，旧实例调用 Gate 仍因身份代次被拒；跨场临时密钥文件读取也被 sandbox 拒绝 |
| 5. Pause 与真正 HTTP 启动竞争 | **PASS** | pause-before-http-start：发送前 barrier 后 Pause，HTTP=0。http-before-pause-late-paid：等假商家实际收到/验过签名才 Pause，不仅依据计数器，随后放行原响应 |
| 6. 单方失联、重启、旧实例 | **PASS（限定）** | Executor 退出且无消费能力时，Gate 封住出口可确认停稳；替代 Executor 不重签。Gate 被终止后重开，同 SQLite 读回 Unknown/原 evidence；旧 Executor 仍活但被新 generation 拒绝。没有双 Gate 同时存活/抢占所有权实验 |
| 7. 提交登记后 ACK 丢失 | **PASS（精确切点）** | merchant 已收到、attempt=1 后终止 Gate，丢失原响应/IPC outcome ACK；重开先 Unknown、预占 `10000`、evidence digest 不变，再原交易核对为 PAID，sign=1/http=1。未单独覆盖 marker commit 后、HTTP 尚未启动就崩溃的窄窗口 |
| 8. 已提交款 Pause 后确认 | **PASS** | 首次 HTTP 先启动，Pause 时 paid=0/reserved=`10000`；原假交易确认后 paid=`10000`/reserved=0，一次 PAID、无第二 signer/首次请求 |
| 9. 重复结果一次记账 | **PASS** | RPC 未确认先 Unknown；改为原交易确认后并发重复 reconcile 三次，使用真实原核对器，paid event=1、paid=`10000`、预占=0、原证据不变、sign=1/http=1。不是实际下游 outcome outbox 验收 |
| 10. 关闭新入口后恢复旧 Unknown | **PASS** | 已提交 Unknown 后 closeIngress+Pause，重启 Executor；新购买被拒，原款仍可核对为 PAID；accepting=false/paused=true，sign=1/http=1 |

额外正向对照 `control-real-sdk` 证明真实 SDK→签名→受控 HTTP→假商家补签→原核对器→一次记账确实可完成。`protocol-error-returned` 将原 402/协议错误交回 Executor，但原付款没有确认时仍保留 Unknown/预占，不因错误字符串释放。

### 5.3 故意不安全的对照

`negative-free-credential-send` 只在专门的 UNSAFE 测试管理分支中把有效 header 交给 Executor，然后执行 Yosh 模拟端 Pause，再让 Executor 自由发送。

观察：**controlled httpStart=0，但假商家 accepted=1，返回 200。** 强 Pause 性质 **EXPECTED_FAIL**；对照场景本身按预期完成。凭据已交出后，模拟端只报告 quiescence=unknown、保留 `10000` 预占，没有谎称已撤销签名。

这证实 `authorize → sign → 自由发送` 不满足强 Pause；它不代表 Yosh 当前生产路径有同一缺陷，也没有把该路径用作方案 B 的实现。

## 6. 代码、证据与复现位置

| 产物 | 位置 |
| --- | --- |
| Rust 真 SDK harness | [paykit-harness/main.rs][H1]；同目录 compile-command.json / run-command.json / compile.log / run.log / isolation.sb；fixture.json 为离线凭据，未复制进报告或仓库 |
| JS 真兼容验证 | [js-sdk-harness/main.mts][H2]、[结果][L2]、同目录 command.json / run.log |
| Gate 与 Executor | [process-spike/actor.mjs][H3]；普通与 UNSAFE 对照入口明确分开 |
| 进程/假商家/场景编排 | [process-spike/run.mjs][H4]；每次运行生成独立私有 run 目录 |
| 最终复现入口 | [process-spike/run-isolated.py][H5]：清理产品/API/Node 启动配置，再启动 driver；业务进程各自应用 sandbox |
| 执行与断言 | [process-spike/command.json][L5]、[结果][L3]、[事件][L4]、同目录 run.log；结果含每场 sign start/complete、HTTP、预算、PAID 事件、商家计数及原 evidence digest |
| 指纹清单 | [manifest.json][L6]：源码/命令/结果及离线兼容 fixture 的白名单 SHA-256；不列私钥内容 |

在本机复现双进程模型：运行 `python3` 加上上述 `run-isolated.py` 的绝对路径。Rust harness 按 compile/run-command.json 使用本地既有 rlib；JS harness 按其 command.json 执行。不需下载依赖、真实钱包或启动已安装 App。

临时目录可能被系统清理，本文是持久结论；不将临时材料可长期存在当作恢复保证。本轮没有将测试密钥/SQLite/签名载荷加入 Git。

构建 harness 时曾遇到测试控制字段混用及 macOS 拒绝嵌套 sandbox，均只修正临时代码/运行方式。最终结果来自修正后的完整运行，不把这些调试失败算作生产缺陷或隐去最终未验证边界。

## 7. 尚未覆盖与明确 BLOCKED

| 项目 | 状态 | 原因/影响 |
| --- | --- | --- |
| 未修改的 pay MCP/CLI 与 Gate 正式互通 | **BLOCKED** | 当前没有受控 handle、最后 transport 与完整原结果回传接口；真实 pay 路由没有接上此实验 |
| Rust pay-kit 运行时动态受控签名/IPC、再由 Yosh Gate 发出 | **BLOCKED（未实施）** | Rust真实 builder/格式兼容已过，但完整双进程运行使用 JS SDK；不能将两份 harness 拼成一条已运行的 Rust Gate 集成 |
| 双 Gate 同时存活、生产 owner lock/迁移/外部 provenance | **BLOCKED（未验证）** | 当前仅验证旧 Gate 确实退出后的重开；单 turn 排序依赖唯一可信 Gate，不能外推多 Gate 并发 |
| 登记已持久但实际 HTTP 尚未开始的 crash 窄窗口 | **BLOCKED（未独立注入）** | 本轮 ACK 丢失发生在商家已接收后；未为制造该窗口在最后临界区插入 await |
| 真实生产 Ledger/Grant/认证与所有权隔离 | **BLOCKED（本轮不改/不接）** | 模型是专用临时数据库；真实 validator/reconciler 不等于真实财务状态机已迁移 |
| 不兼容旧 Yosh 的写入阻断、关闭集成后生产恢复、全量 fault matrix | **BLOCKED（未验证）** | 没有升级/降级已安装 App，不接触现有账本；合同的 P0 恢复门槛仍需实证 |
| 所有 pay 缓存、会话、CLI/proxy 出口运行级强制封闭 | **BLOCKED** | 源码已识别，未修改 pay；本轮仅 exact 候选，不证明其他协议或旧自由路径已被强制禁用 |
| 任意响应反射凭据、恶意外部进程/OS 任意攻击、网络重组/压力/真实 HTTPS | **BLOCKED（超出证据）** | 正常 IPC 摘要和私有文件拒绝有断言；没有通用响应净化、形式化信息流或主网安全证明 |

本轮没有发现要求修改生产 Yosh 的可复现 A 类反例。上表主要是 B/C 能力或验证边界，不能用 Mock 通过将其标记已完成。

## 8. 最小下游接口缺口与下一阶段条件

未来需要 pay 或其维护组件提供/接纳：

1. **稳定非消费操作接口：** 已选择 exact challenge、不可变 HTTP 请求及 operationId，以可信 Executor/member 绑定发送；不能只用一次 MCP request ID 或自填 owner。
2. **可信协议组件接缝：** SDK builder 在 Yosh 控制边界执行，或正式提供 unsigned/plan 与窄签名流程；不得将有效签名回传自由 Executor。不是任意 sign(bytes) RPC。
3. **唯一受控 transport：** pay 的所有授权内 exact 执行必须通过 handle 调用最后 Gate；其他付款、缓存、外部 curl/proxy、回退钱包路径明确拒绝，不能静默 fallback。
4. **结构化结果与恢复：** 必要 status/headers/receipt/body/协议错误、原 operation/attempt 身份和持久 outcome/query；保留数据同时约束凭据反射/缓存。MCP 当前简化结果不够。
5. **重启与停止合同：** 实例 generation、原任务查询/结果去重、无新签名恢复、独立停止进度；无有效凭据持有者不必虚等 ACK，有效凭据已外发则不能假装撤回。

这些均仅记录为未来 RFC #505 / 本地 PoC 需求；没有联系上游或假定维护者接受。

**已取得的有限 Go：** 可以向用户提交并讨论“可信 Gate 托管真实 SDK、非消费 handle、原证据不放宽”的候选；不需要退回方案 A，也不需要重写 exact 协议。

**尚未取得的 Go：** 当前不直接开始总体计划阶段 2–4 的生产解耦/Adapter。需先明确可信 SDK 组件的进程/发布边界与当前 pay 主路径接法，审阅最小接口缺口；补足相关 P0 的唯一 Gate、登记 crash、生产恢复/兼容阻断及实际 pay 受控路由证据。真实资金、安装版更新及对外集成继续 No-Go，并始终需要另行具体授权。

## 9. 主要源码引用

| 引用 | 函数/行号 |
| --- | --- |
| P1 | [pay build_payment_with_override:161][P1]：214 内部 signer、264–303 真实 kit header 返回；[MCP exact build→fetch:1218](/Users/irin/Desktop/open-source/pay/rust/crates/mcp/src/tools/curl.rs:1218)；另两分支 1172/1379 |
| P2 | [FetchClient send:832][P2]；[RawResponse:512](/Users/irin/Desktop/open-source/pay/rust/crates/core/src/client/fetch.rs:512)；[classify_402:869](/Users/irin/Desktop/open-source/pay/rust/crates/core/src/client/runner.rs:869)；[MCP interpret_retry:1599](/Users/irin/Desktop/open-source/pay/rust/crates/mcp/src/tools/curl.rs:1599) |
| P3 | [cached auth/session:1080][P3]；[CLI header/retry:1656](/Users/irin/Desktop/open-source/pay/rust/crates/cli/src/commands/mod.rs:1656)、[retry_with_headers:2018](/Users/irin/Desktop/open-source/pay/rust/crates/cli/src/commands/mod.rs:2018)；[payer proxy build:1616](/Users/irin/Desktop/open-source/pay/rust/crates/cli/src/commands/payer_proxy.rs:1616)、[send:1683](/Users/irin/Desktop/open-source/pay/rust/crates/cli/src/commands/payer_proxy.rs:1683) |
| K1 | [Rust exact build_payment:25][K1]：unsigned 89、sign 97、encode 99；build_payment_header 121、private SPL 430、memo 368；[core tx public build_unsigned:25](/Users/irin/.cargo/git/checkouts/pay-kit-faefdef5c8b4a8fb/f8ef055/rust/crates/kit/src/core/tx/mod.rs:25) |
| K2 | [sign_versioned_transaction_slot:16][K2]；[TransactionSigner:70](/Users/irin/.cargo/git/checkouts/solana-keychain-c5dad7cab7b9e431/44b479d/rust/src/traits.rs:70) 与 SendingSigner 122 分离 |
| J1 | [JS ExactSvmScheme:57][J1]：实际 build/sign 113–128；[真实 compile/partial signer:338](/Users/irin/Desktop/yosh/node_modules/@solana/signers/dist/index.node.mjs:338) |
| J2 | [JS x402Client.createPaymentPayload:218][J2]：调用 scheme、返回 accepted/resource/payload；hook/extension 仍由调用者控制 |
| J3 | [header 编码:2133][J3]；[parsePaymentResult:2246](/Users/irin/Desktop/yosh/node_modules/@x402/core/dist/esm/chunk-RAWLCYSQ.mjs:2246)；[需要 payload 的 processPaymentResult:2204](/Users/irin/Desktop/yosh/node_modules/@x402/core/dist/esm/chunk-RAWLCYSQ.mjs:2204) |
| Y1 | [createSignedPaymentIdentity:76][Y1]；unsigned 检查 159、重验 169、补签匹配 182 |
| Y2 | [reconcileStoredOriginalPayment:115][Y2]；inspect 95：原成功/最终失败区别；[生产执行原证据先存再发送:161](/Users/irin/Desktop/yosh/src/modules/purchases/approved-payment.ts:161) |

[P1]: /Users/irin/Desktop/open-source/pay/rust/crates/core/src/client/x402.rs:161
[P2]: /Users/irin/Desktop/open-source/pay/rust/crates/core/src/client/fetch.rs:832
[P3]: /Users/irin/Desktop/open-source/pay/rust/crates/mcp/src/tools/curl.rs:1080
[K1]: /Users/irin/.cargo/git/checkouts/pay-kit-faefdef5c8b4a8fb/f8ef055/rust/crates/kit/src/x402/client/exact/payment.rs:25
[K2]: /Users/irin/.cargo/git/checkouts/pay-kit-faefdef5c8b4a8fb/f8ef055/rust/crates/kit/src/core/signing.rs:16
[J1]: /Users/irin/Desktop/yosh/node_modules/@x402/svm/dist/esm/chunk-FKOM6YTW.mjs:57
[J2]: /Users/irin/Desktop/yosh/node_modules/@x402/core/dist/esm/client/index.mjs:218
[J3]: /Users/irin/Desktop/yosh/node_modules/@x402/core/dist/esm/chunk-RAWLCYSQ.mjs:2133
[Y1]: /Users/irin/Desktop/yosh/src/modules/payment/original-payment-evidence.ts:76
[Y2]: /Users/irin/Desktop/yosh/src/modules/payment/reconcile-transaction.ts:115
[H1]: /var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx/paykit-harness/main.rs:5
[H2]: /var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx/js-sdk-harness/main.mts
[H3]: /var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx/process-spike/actor.mjs
[H4]: /var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx/process-spike/run.mjs
[H5]: /var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx/process-spike/run-isolated.py
[L1]: /var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx/paykit-harness/run.log
[L2]: /var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx/js-sdk-harness/result.json
[L3]: /var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx/process-spike/results.json
[L4]: /var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx/process-spike/events.json
[L5]: /var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx/process-spike/command.json
[L6]: /var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-egress-spike-20uff_wx/manifest.json
