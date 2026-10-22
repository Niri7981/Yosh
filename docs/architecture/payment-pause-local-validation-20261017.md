# Yosh 本地 Payment Lifecycle / Pause 测试报告

日期：2026-10-17（Asia/Shanghai）。依据：[审计第 10.1 节](/Users/irin/Desktop/yosh/docs/architecture/payment-pause-lifecycle-audit.md:389)。仅检查和运行已有测试，不修改生产代码、不新增测试、不解耦、不修改 pay.sh、不 Commit/Push。

## 结果

**235 个不同用例 PASS，0 FAIL，涉及 15 个测试文件。** 共执行 236 次测试，其中未签名重启用例重复运行一次，全部通过。最初过滤跳过的 58 项中，6 项已在补跑中通过，其余 52 项未运行。这不是完整生命周期通过：前四项要求的精确时序仍缺少完整测试。

- **PASS**：本轮实际执行且断言通过，仅证明断言涉及的边界。
- **FAIL**：本轮执行失败。本轮为 0，未取得疑似 A 类缺陷的最小反例；不据此宣称没有任何缺陷。
- **NOT COVERED（缺少精确用例）**：相邻测试通过也不能替代。
- **NOT COVERED（本轮未运行）**：已有相关定义，但未在本轮取得运行证据；与“代码库没有测试”不同。

## 隔离范围

使用现有内存/临时 SQLite、Mock Signer、假 RPC/商家；无真实钱包或 Keychain。未运行真实 Mainnet E2E，没有真实付款或链上提交。带 Mainnet 名称的已运行测试只是本地配置/策略 fixture，不是主网验收。

运行前清除进程中的 Yosh/APP2049/Demo/Solana/x402/pay/API 相关配置和自定义 Node 启动参数，使用专用临时目录；macOS sandbox 禁止网络、执行 `/usr/bin/security`、读写真实 Keychain/产品数据目录和钱包配置，并禁止写生产源码、测试、App、计划及 pay.sh。现有 `keychain-isolation.mjs` 也会将系统 Keychain 调用尝试判为测试失败。本轮未出现隔离阻断导致的失败。

Node v25.9.0；Vitest v4.1.11。测试以单 worker、threads、关闭文件并行方式运行，不添加随机 sleep。并发含义来自已有用例自身的 Promise/SQLite 断言，不能用 runner 的文件调度方式冒充生产并发。

**签名范围：** 用户已明确允许离线 fixture 签名，仍禁止真实钱包和链上签名。首批 119 次通过用例没有生成密码学签名；随后补跑的 117 项允许 `signed-payment-fixture.ts` 的 `crypto.subtle.sign` 和测试交易的 `tx.sign`，仅用内存中一次性测试密钥生成离线数据。网络和 Keychain 隔离保持不变，未接入生产签名器。

## 实际运行清单

共同参数：`vitest run --maxWorkers=1 --no-file-parallelism --pool=threads`，在上述 sandbox 与隔离环境中执行。没有使用可能自动放行空测试的 `--passWithNoTests`。

| 文件 | PASS | 过滤跳过 | 实际边界 |
| --- | ---: | ---: | --- |
| [mainnet-signing.test.ts](/Users/irin/Desktop/yosh/tests/unit/mainnet-signing.test.ts) | 22 | 0 | 假 SDK、假 RPC、`vi.fn` 底层 signer；simulation 后 Pause/撤销/退出可阻止进入 signer。unsigned binding 检查被 mock，不证明真实交易解析 |
| [purchase-request.test.ts](/Users/irin/Desktop/yosh/tests/unit/purchase-request.test.ts) | 14 | 0 | 报价/Grant/预占、并发同 ID 只调用一次注入的假付款、并发额度不足拒绝；未验证真实执行器签名/HTTP |
| [spend-grant.test.ts](/Users/irin/Desktop/yosh/tests/unit/spend-grant.test.ts) | 13 | 0 | Grant 范围/累计、两 SQLite 客户端的顺序预占、过期及重启历史；不是 Pause 并发屏障 |
| [monetary-ledger.test.ts](/Users/irin/Desktop/yosh/tests/unit/monetary-ledger.test.ts) | 24 | 0 | 整数金额、scope 隔离、人工 fixture 的 PAID/UNKNOWN/预占和迁移/重启保持；不是原签名链上核对 |
| [safe-resource-fetch.test.ts](/Users/irin/Desktop/yosh/tests/unit/safe-resource-fetch.test.ts) | 23 | 0 | DNS 分类/pinning、响应边界、AbortSignal 在解析中取消不建 socket；没有调用 Yosh Pause |
| [purchase-state.test.ts](/Users/irin/Desktop/yosh/tests/unit/purchase-state.test.ts) | 16 | 0 | 状态枚举、PAID 不回退、UNKNOWN 不重新 claim/expire；不替代 ledger 层证据验证 |
| [payment-reconciliation.test.ts](/Users/irin/Desktop/yosh/tests/unit/payment-reconciliation.test.ts) | 3 | 0 | UNKNOWN 调度、持久退避、已完成购买不再调度；不执行链上事实核对 |
| [app-management.test.ts:410](/Users/irin/Desktop/yosh/tests/unit/app-management.test.ts:410) | 1 | 20 | 只选 `rechecks pause and a lowered limit before signing and before submission` |
| [mainnet-execution.test.ts:98](/Users/irin/Desktop/yosh/tests/unit/mainnet-execution.test.ts:98) | 2 | 32 | 只选 fresh Mainnet paused/unauthorized 与 claim 串行化两项；没有执行其假付款构造回调 |
| [purchase-state-transitions.test.ts](/Users/irin/Desktop/yosh/tests/unit/purchase-state-transitions.test.ts) | 7 | 0（补跑后） | 首轮仅选 `signed=false`，补跑全文件；PAID 不回退，UNKNOWN 证据/预占经重启保留，未提交工作可重复安全恢复，损坏状态拒绝读取并保留原行 |
| [approved-payment.test.ts](/Users/irin/Desktop/yosh/tests/unit/approved-payment.test.ts) | 17 | 0 | 钱包加载挂起时 Pause 阻止 preparation/HTTP；mock preparation 内签名前 guard；超时不重签、原证据恢复、原日记账、最终失败释放。未覆盖 signer 已进入后的 Pause |
| [original-payment-recovery.test.ts](/Users/irin/Desktop/yosh/tests/unit/original-payment-recovery.test.ts) | 27 | 0 | 真实原证据解析/核对配假 RPC；丢失响应、null/断网/非 finalized 失败保留预算；匹配 finalized 失败才释放；原证据不可改，重复/重启恢复一次 PAID、无新签名或商家重试 |
| [durable-delivery.test.ts](/Users/irin/Desktop/yosh/tests/unit/durable-delivery.test.ts) | 46 | 0 | 交付 claim 并发唯一、重启/旧 owner 拒绝、四次重试持久上限、退避；UNKNOWN 不进入交付重放，Pause/撤销后的 PAID 交付不改变消费；暂停时后台继续历史核对与已付交付，退出停止后续工作。该文件核对器被 mock |
| [reconcile-transaction.test.ts](/Users/irin/Desktop/yosh/tests/unit/reconcile-transaction.test.ts) | 4 | 0 | 原消息/签名精确匹配、finalized 失败、memo 查回丢失回执；历史查无结果仍 UNKNOWN，不写交易 |
| [approved-offer-payment.test.ts](/Users/irin/Desktop/yosh/tests/unit/approved-offer-payment.test.ts) | 16 | 0 | 原报价受控执行、签前与提交前撤销检查、Pause/过期/降额拒绝；超时/SQLite 重启复用原凭据，无再次签名 |

表中按不同用例计数，合计 235。四次运行退出码均为 0；第四次补跑 6 个文件、117 项，包含重复验证的 `signed=false` 一项。参数化用例即使名称相同也分别计数，避免仅按名称去重漏计。剩余 52 项为两个文件的过滤跳过项，不计 PASS，也不是整个代码库全部未运行测试的数量。存在 Vite 对未来 native config loader 的兼容警告，不影响当前测试，不在本轮修改配置。

## 对照五项要求

| 要求 | 精确场景结论 | 已验证事实 / 与审计合同的关系 |
| --- | --- | --- |
| 1. Pause 与 reserve/claim 并发顺序 | **NOT COVERED（缺少完整屏障用例）** | **PASS 相邻边界：** reserve→Pause→claim 拒绝；claim→Pause→savePayload 拒绝；并发同 ID 只执行一次假付款；并发报价不超 Grant。现有 Pause 检查是顺序调用，未用 barrier 分别验证 Pause/claim 两种抢先顺序，不宣称完整竞态已覆盖 |
| 2. signer 已开始但未返回时 Pause | **NOT COVERED（缺少精确用例）** | **PASS 相邻边界：** 钱包加载 Promise 挂起后 Pause，放行后 preparation/HTTP 均不启动；simulation 响应前 Pause 时底层 signer 为 0；mock preparation 内 beforeSign guard 被调用。没有进入底层 signer 后挂起它，再 Pause/放行结果的测试；不能从“签名前拒绝”推断这个窗口通过。mock preparation 测试只断言通用拒绝及无提交，不能单独证明拒绝原因 |
| 3. DNS 未完成时 Pause | **NOT COVERED（缺少跨模块用例）** | **PASS 相邻边界：** DNS Promise 不结束时 AbortSignal 取消，HTTPS request 为 0。它未调用 `AppRuntime/PurchaseLedger.setPaused`，不验证最后 submission guard、财务释放或原单状态 |
| 4. HTTP 已启动后 Pause，原交易确认并记账 | **NOT COVERED（缺少精确用例）** | 未发现已有用例同时挂起首次付款 HTTP、执行 Pause、放行原响应/原交易确认并核对一次 PAID。资源 disable 后确认、Pause 后历史恢复等相邻场景不能代替 |
| 5a. 未签名崩溃工作重启 | **PASS** | 未提交且未签的 claim 在重启后变 FAILED，预占/未决为 0；重复启动恢复不重复写记录，符合审计的本地独占未提交规则 |
| 5b. UNKNOWN/终态/调度及迁移基础 | **PASS（已有断言范围）** | UNKNOWN 保留预占；PAID/UNKNOWN 不错误重开；持久退避、领取权及历史金额/证据经重启/迁移保留。暂停时后台仍可将原 UNKNOWN 确认为 PAID，paid/reserved 正确转换，不调用第二次 preparation 或付款 HTTP |
| 5c. 原签名证据核对、最终失败、Unknown 重启、交付恢复不重复付款 | **PASS（已有断言范围）** | 已补跑上述恢复文件。假 RPC null/离线/仅 confirmed 失败不能释放；核对同一原证据的 finalized 失败才释放。丢失响应与重启可确认同一原交易，重复核对只产生一个 PAID，不重签。交付恢复复用原凭据或已声明查询能力，UNKNOWN 不重放；Pause/撤销后已付交付不改变 paid/reserved/remaining/Grant，重试次数经崩溃与重启保持上限 |

覆盖判断还检索了现有测试中的 `setPaused`、底层 signer、DNS 和提交控制位置。没有把修改资源状态、取消 AbortSignal 或测试名称中的“signing boundary”自动当成对应 Pause 竞态。

## 建议新增的测试：只列设计，本轮未编写

### `tests/unit/payment-pause-lifecycle.test.ts`（建议新文件）

- **reserve/claim 两种顺序：** barrier 明确挡住领取点，分别让 Pause 先提交、claim 先提交。前者 claim 拒绝且既有预占保留；后者后续新签名/首次付款启动被拒。两个竞争同 operation 的 claim 最多一个成功；不能仅用普通顺序调用或 `Promise.all` 名称证明完整顺序。
- **底层 signer 在途：** 确认 Mock Signer 已进入一次，挂起返回，再执行 Pause，最后放行。断言不启动首次付款请求，原记录按可证明未提交终结/释放且不再执行同 ID。记录 signer 开始/完成分别计数，不能要求已开始的签名工作必然被撤销。使用可被现有证据校验接受的预先保存测试凭据，避免凭据格式错误导致假阳性；不要屏蔽原证据验证来掩盖错误原因。
- **首次付款 HTTP 已启动：** 假商家记录一次启动后挡住响应，Pause，再放行同一原交易确认。断言恰好一个 PAID 事件、该金额 reserved→paid、无第二 signer/首次付款请求，重复查询与重启仍返回同一购买/交易。

### `tests/unit/payment-pause-safe-transport.test.ts`（建议新文件）

- 保留真实 `executeApprovedPayment → prepareSafeResourceFetch` 调用链；只在 `node:dns/promises` 和 `node:https` 边界替换 DNS/socket。DNS lookup 已进入后挂起，执行 Pause，再放行公网 DNS 结果。
- 断言 `https.request` 未启动、没有首次 submission marker、原未提交购买安全终结/释放，重复原 ID 不重新付款；同时给出相反顺序下“请求已启动后仍可确认”的独立用例。
- 不把全局 fetch fixture 注入当成真实 DNS 路径；现有 `prepareSafeResourceFetch` 在特定测试注入条件下会直接返回 fetch 闭包，测试须确认实际经过 DNS，防止绕开待验证边界。

已有原付款和交付恢复用例已补跑通过，保留其失败/重启/重复确认断言。上述建议只补精确 Pause 时序的缺口，本轮没有编写测试。当前结果没有提供 A 类缺陷反例；B 类外部执行者能力、C 类 RFC #505 接口需求均未在本轮实现，也不能从本地测试通过推断跨系统合同成立。

## 可复查证据

原始执行结果与过滤情况保留在本轮专用临时目录，未写入生产数据目录：

- [第一组 JSON](/var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-pause-validation-y6ap9qhb/pure-mock-results.json)、[日志](/var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-pause-validation-y6ap9qhb/pure-mock-run.log)。
- [Pause/claim 过滤组 JSON](/var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-pause-validation-y6ap9qhb/pause-claim-results.json)、[日志](/var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-pause-validation-y6ap9qhb/pause-claim-run.log)。
- [未签重启组 JSON](/var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-pause-validation-y6ap9qhb/unsigned-restart-results.json)、[日志](/var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-pause-validation-y6ap9qhb/unsigned-restart-run.log)。
- [离线 fixture 恢复补跑 JSON](/var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-pause-validation-y6ap9qhb/fixture-recovery-results.json)、[日志](/var/folders/l7/7_2w6sp51p57k00hbxp2k5c40000gn/T/yosh-pause-validation-y6ap9qhb/fixture-recovery-run.log)。

这些临时日志可能被系统清理；本报告保留测试范围与计数。当前结果符合已验证的本地控制合同；未覆盖项仍不能判定通过，尚未取得 A 类实际缺陷证据。完成后停止，等待审阅，不进入修复、补测编写或解耦。

交付指纹核对：Yosh 原有 494 个文件内容不变，本轮只新增本文；pay.sh 原有 739 个文件内容不变且无新增，两个 HEAD 均未变化。文档本地链接/行号检查通过。没有因测试通过而重装、重启已安装 App。
