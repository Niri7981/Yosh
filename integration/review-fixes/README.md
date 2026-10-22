# 本轮 Review 定向修复

工作树：`/Users/irin/.codex/worktrees/pay-mcp-first-integration/yosh`。仅修复 Operation Replay、Request Hash、Epoch Transaction；生产仍为 **BLOCKED**。没有进入 staging，没有安装或启动 App、真实付款、Commit、Push 或上游改动。未修改 schema，未新增外部接口或 Ledger。

## 修改清单

`changes.patch` 是相对本轮开始时**实际未提交状态**的独立补丁，不是相对 HEAD 的混合历史 diff。已在起始源码副本上通过 `git apply --check`。`start-state.json` 保存开始时 HEAD 与已有文件指纹；结束核对只有下面六个已有文件变化，其余既有文件保留。

| 文件 | 修改 |
| --- | --- |
| `src/modules/payment/pay-authority-adapter.ts` | `authorize()` 重放在任何 recovery 前比较持久 request_hash 与完整 quote_hash；attempt_id 可以变化，原请求和 accepted offer 不可以变化。 |
| `src/modules/purchases/execution-safety.ts` | `reserve()`、`assert()` 将持久 requestHash 与实际不可变 HTTP request 核对；`invalidate()`、`snapshot()` 以数据库 epoch 为唯一数值来源，移除内存副本。 |
| `src/modules/purchases/request-paid-resource-purchase.ts` | 仅 externalExecution 分支保存当前受限 Pay GET profile 的 `Accept: application/json`，用于既有 executionBinding、最终 HTTP 和原款恢复；默认 JS 分支不变。 |
| `tests/helpers/pay-production-fixture.ts` | 观察真实携款 HTTP 的 Accept；重放场景明确向 Pay 重新提供原 offer，另以 freshOffer 模式产生变更 offer。只改测试商家。 |
| `tests/integration/pay-mcp-first.test.ts` | 新增四项针对性集成测试，包括 PAID/Unknown 的真实 Pay MCP 变更 offer 拒绝。 |
| `tests/integration/execution-persistence.test.ts` | 新增三种真实外层事务故障注入：invalidate 后异常、后续 SQL 触发器拒绝、COMMIT 前异常。 |

## 复现与结论

### Operation Replay

修复前：已有记录分支只比较 URL，新的 attempt 在金额和 accepted.amount 同步改变后仍得到 `{allow:true}`，继而可以读取旧购买数据。完整 Facts 的 digest 只绑定当前 attempt，不能替代跨 attempt 的 operation 比较。

修复后：可信 caller、operation、external provenance 的原有检查保留；额外在 recovery 前比较 `hash(facts.request)` 和 `hash(facts.accepted)` 与持久指纹。报价解析已经核对 amount/asset/network/recipient 与 accepted 一致，因此完整 accepted hash 覆盖这些经济事实和 memo、超时、fee payer 等所有 accepted 字段。资产和网络的非支持值原本就被 schema 拒绝，无需重复添加保护。HTTP method/body 原有 GET/null 限制也保持。

测试覆盖金额、收款方、超时、memo、请求头变化；资产/网络、method/body 的现有拒绝；同进程与 reopen 后原条款的新 attempt 仍可只读重放。真实 Pay MCP 新报价在 PAID 和 PAYMENT_UNKNOWN 两种状态都被拒绝，且不领取 reconciliation claim、不改变原款证据/payload、状态、预占或记账，也不新增签名/HTTP。

兼容影响是有意且可见的：旧 fixture 每次探测都产生新 memo，过去这些变更被错误放行。现在恢复场景必须提供原 accepted offer，freshOffer 场景必须拒绝；不能将不同 offer 解释为原 operation。测试商家的原 offer 来自该 operation 既有报价；这不是产品端新增报价缓存、协议 runner 或身份接口。

### Request Hash

修复前：外部 requestHash 被写入 permit，也受到完整 permit 比较保护，但没有和实际保存的 HTTP request 比较。真实 Pay 请求有 `accept: application/json`，通用 Devnet 购买服务构造的 request.headers 却是 `{}`。真实 tools/call 成功后，持久 HTTP request 的 wire-shape hash 与 provenance.request_hash 不同，是实际可达的问题，并非仅靠直接篡改数据库构造。

修复后：外部 profile 的请求头进入同一不可变 request；reserve 在同一经济事务中核对 canonical wire request hash（method、url、有序 header pairs、body/null），assert 在 claim/签名保存/marker 的既有调用点重新核对，operation replay 使用持久 request_hash。漏掉 Accept 的外部新请求在 reserve 内失败并回滚，不留下购买行。已有按 attempt digest 防篡改和 payment executionBinding 检查继续保留，没有另写协议验证器。

测试证据：真实 Pay MCP 的最终携款 HTTP 观察到 `application/json`；保存请求 hash 等于 permit.requestHash；伪造 permit hash 和保留旧 executionBinding 的变更 request 都被拒绝；省略 header 的新 operation 不预占、不签名、不发送 HTTP。

不重写旧记录的 request_hash 或原付款证据。修复前持久记录可能保留旧请求不一致事实；旧 epoch 不获得新 claim/签名权，恢复仍仅处理原证据，不声称此补丁追溯修正历史。当前 profile 仍只支持既有 Solana Devnet fixture + x402 V2 exact + USDC GET，不扩展任意 headers/body。

### Epoch Transaction

修复前：`setPaused()` 的真实 `BEGIN IMMEDIATE` 内，invalidate 更新数据库后立即增加内存 epoch；随后异常触发 ROLLBACK，持久 epoch 恢复而内存保留新值，snapshot 抛出 `EXECUTION_OWNER_FENCED`。属于失败后错误拒绝服务，本次没有观察到资金提交越权。

修复后：不再缓存 epoch 数值。snapshot 验证 live owner 和合法持久 epoch；invalidate 校验上限并以 owner+epoch 条件递增。成功 COMMIT 或 ROLLBACK 自然决定唯一 epoch，不需要另一个事务或补偿写入。owner identity 与原 lifetime writer lock 保留。

三种故障注入均在真实 ledger.setPaused()/atomic() 路径执行，回滚后数据库与 snapshot 一致、Pause 未确认且 controls 仍未暂停、原 permit 仍有效。随后正常 Pause→Resume 提升 epoch，原 permit 被拒；reopen 后仍不能复活。COMMIT 注入代表提交前抛错，不宣称覆盖所有操作系统存储故障或提交完成后响应丢失。

## 测试证据

- `red.log`：最初最小复现，4 失败、35 通过。
- `red-complete.log`：完整七项新回归使用本轮开始时三个生产源码文件运行，**7 失败、35 通过**；运行后恢复修复源码。证明新用例会捕获原问题。
- `first-fix.log`：首次修复后 8 个原恢复测试因 fixture 每次产生不同 memo 失败；通过区分原 offer 和新 offer 修正测试语义，未放宽产品检查。
- `targeted.log`：**42 通过、0 失败**，包含原 35 项与新增 7 项。
- `full-regression.log`：主套件 87 文件/1077 项；独立 Phase 2 15 项；Node native 3 项。合计 **1095 项通过、0 失败**。原真实 Pay MCP 无资金购买、Unknown、原款恢复、Pause/重启和默认 JS SDK 兼容用例仍通过。
- `typecheck.log`、`lint.log`、`build.log`：全部成功。build 使用临时 HOME/数据目录、loopback-only OS sandbox，拒绝生产 Keychain 与用户数据访问。初次 typecheck 误扫描了 build.noindex 中的六份起始源码副本（`typecheck-initial.log`）；副本已移至相邻 `../review-fixes-baseline`，未改 tsconfig/关闭检查，重新运行通过。
- `validation.json`：机器可读结果。Pay/Rust 源码本轮未修改，未重复跑 Rust 套件；不引用上轮 Rust 通过作为本轮执行结果。

复跑：`python3 scripts/test-pay-integration.py tests/integration/pay-mcp-first.test.ts tests/integration/execution-persistence.test.ts`；全套：`python3 scripts/test-pay-integration.py --all`。既有脚本继续强制临时环境与 loopback 网络，不使用真实资金或 Authority mock。

## 剩余限制与停止点

生产状态维持上一轮 BLOCKED；本轮没有研究或修复旧执行器长期共存问题，也没有进入 staging、产品宿主或安装验收。完整回归包含既有 blocker characterization 测试，但它通过表示既有阻塞仍被准确观察，绝不代表阻塞解除。测试仅证明隔离商家、假 RPC、离线密钥和临时数据库中的指定行为，不是 Mainnet、真实 Codex 宿主或安装版验收。

本轮完成后停止，等待人工 Review。
