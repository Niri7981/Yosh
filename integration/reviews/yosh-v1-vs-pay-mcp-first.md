# Yosh v1 与 Yosh × Pay MCP-first 功能对比

核对日期：2026-10-20。本轮只读源码、Git、构建包及既有验证材料；唯一写入为本文。没有启动/退出 App、改配置、迁移数据、运行购买或提交代码。未重新运行测试；下文测试结果均标明为既有证据。

**结论：此次主要成果是把真实 Pay MCP 的协议执行接入 Yosh 原有经济控制与账本，并交付独立的离线开发 App；不是从零增加预算、授权、钱包或购买恢复。开发体验已经接通，但新版真实 Mainnet 购买和正式升级仍未完成，且最新工作树比桌面包多出执行轨迹功能。**

## 对比口径与证据

- 原仓库 `/Users/irin/Desktop/yosh`，HEAD 为 `f65c9bd30a2cad65493d2e70b15624be26e216ed`。这是提交基准，不是完整旧版快照。
- MCP-first 起点指纹在新版 `integration/pay-mcp-first/source-baselines.json`：`yosh` 项记录了当时原仓库已有的 37 个未提交文件；`phase2` 是另一条已经开展 Pay 的工作，不能混入旧版。
- 本次重新计算：37 项中 34 项仍与原仓库一致；`app-runtime.ts`、`keychain.ts`、`purchase-ledger.ts` 已继续变化。因此不能把今天原仓库直接称为当时的完整旧版，也不能把所有 HEAD diff 算成 Pay 新增。
- 后两份文件的历史指纹可在 `round2-baseline/yosh` 和相邻 `pay-production-integration/yosh` 核对；本次检查的候选目录未找回与旧原仓库指纹完全一致的 AppRuntime。其旧能力以 Git 提交代码、指纹清单和阶段增量交叉确认，不宣称已重建完整可运行的旧工作树。
- 钱包列表及大量 UI 修改还来自原仓库后续的独立未提交工作。新版 `integration/status-connection-fix/parity-plan.json`、`source-and-parity.patch` 明确记录了同步来源；这些算“既有 Yosh 工作同步”，不算 Pay 创造的产品能力。
- 新版审阅对象：`/Users/irin/.codex/worktrees/pay-mcp-first-integration/yosh`，相邻 `pay`、`pay-kit-current`。Pay 原仓库起点 `df57843`；集成树基于 External Authority 分支 `9f9c342`；实际 unsigned 补丁目标为 pay-kit `bd3ad25`。相邻旧 `pay-kit` PoC 不能代替实际 pin。

本文源码证据中的相对路径，除明确说明“原版”外，均相对新版 Yosh 根目录；`../pay`、`../pay-kit-current` 指上述相邻仓库。原版可用 `git show f65c9bd:<路径>` 检查，不能用新版同名文件替代历史证据。

## A. 最初 Yosh v1 的真实能力

旧版已经是有本地后端的原生 macOS 消费控制产品，不是只有卡片 UI：

1. **连接与身份**：原生 Connection、Agent/CardMember、每成员 capability、MCP stdio 与已认证 Agent API；连接状态与 Grant 分开管理。Agent 不能自行创建消费授权。
2. **资源生命周期**：Agent 可发现候选 x402 API、以发现凭据注册资源、查询报价、请求购买和分块读取交付；支持声明式 GET/JSON POST 的代码与约束。注册不等于授权，POST 有用户确认边界。
3. **经济授权**：Spend Grant 已含资源、成员、期限、总额度和单笔约束；Daily Authority 是所有 Agent 共享的每日预算。二者不是 Pay 新概念。
4. **付款与账本**：SQLite PurchaseLedger、原子预算预占、幂等购买、独立付款/交付状态、原签名证据、链上核对、Unknown 保留预占、原付款恢复与有界交付重试均已存在。
5. **本机产品**：Authority、Connection、Agents、Settings、Activity/详情、Pause、App Lock、关闭窗口后后台继续与正常退出等待等已有实现；专用 Keychain 支付钱包及 Mainnet 门禁也已有。
6. **真实资金证据**：`docs/demo/first-mainnet-purchase-20261008.md` 记录一笔 Agent402 GET、0.001 USDC、PAID/CONFIRMED/COMPLETE。这是旧链路特定购买的历史验收，不能外推到任意商家、真实 POST 或商家交付恢复；本轮未重新查询链。

原版核心入口证据：`src/modules/mcp/server.ts::request_purchase` → Agent API → `AppRuntime.requestPurchase` → `requestPaidResourcePurchase`/登记资源分支 → `executeApprovedPayment` → `prepareSolanaPayment`。其中 `solana-payment.ts` 使用官方 `@x402/core/client`、`@x402/svm/exact/client`，并通过 Yosh 的 signer、模拟与提交门禁执行。称它“Yosh JS x402”不意味着 Yosh 自研了完整协议。

## B. 新版 Yosh × Pay 的真实能力

新版有两个层次，必须分开：

- **通用接入与持久化代码**：真实 Rust Pay MCP 的 curl、原 HTTP/402 编排与 exact selector，经 External Authority/ControlledExecution 调用真实 Yosh 授权、预占、签名、核对和交付。真实模块集成覆盖并发、失联、Pause、重放、进程退出与重新打开账本，商家/RPC/密钥为隔离设施。
- **开发产品**：桌面 `/Users/irin/Desktop/Yosh Pay Dev/Yosh Pay Dev.app` 已运行真实原生壳、独立后端和真实 Pay MCP。业务 Runtime/Grant/Budget/Ledger 不是 Mock，但其商家、链和钱包是 Offline，不发生真实 Devnet 或 Mainnet 资金转移。

### 实际执行链与责任归属

| 环节 | 原版 | 新版受控开发链 |
|---|---|---|
| Agent 入口 | Yosh MCP `request_purchase(requestId, resourceId, …)` | Yosh 专属 wrapper → 真正 PayMcp `curl(operation_id, url, …)`；额外提供 Yosh 的 `get_spending_status` |
| HTTP/402/offer | Yosh 服务 + 官方 JS x402 | Pay 原 `curl::run → do_paid_fetch → fetch_request_with_body_for_policy → raw_to_outcome/classify_402` 与 SDK selector |
| 是否允许消费 | Yosh Grant/共享预算 | 仍是 Yosh；Pay `SpendingAuthority` 只把实际选中 offer 交给 Yosh |
| 未签名交易 | JS `ExactSvmScheme` | Pay `controlled::prepare → pay_kit::…::prepare_unsigned_payment`，复用 SDK 原构造逻辑 |
| 验证、签名、提交 | Yosh | 仍是 Yosh：严格 unsigned 检查、模拟、beforeSign、原证据保存、marker、最终携款 HTTP |
| 原款核对、金额记账、交付 | Yosh | 仍是 Yosh；Pay 不另建经济账本 |
| MCP 返回 | Yosh 结果 | Yosh 返回经过验证并持久保存的数据，Pay 原 `interpret_retry/PaidFetchResult::into_tool_result` 返回 Agent |

可核查函数：

- `../pay/rust/crates/mcp/src/server.rs::PayMcp::curl`、`tools/curl.rs::do_paid_fetch`（约 1069 行）、受控 exact 分支（约 1301 行）。该分支在普通 Pay account/signer/paid retry 前返回，失败不降级。
- `../pay/rust/crates/mcp/src/controlled.rs::run/prepare`；`../pay-kit-current/src/x402/client/exact/payment.rs::prepare_unsigned_payment`。
- `../pay/rust/crates/mcp/src/bin/yosh-controlled-mcp.rs::Bridge` 实现 SpendingAuthority 和 ControlledExecution，分别调用 `/pay/authorize`、`/pay/plan`、`/pay/execute`。这是 Yosh 的专用开发宿主；普通上游 Pay CLI 并未自动具备 Yosh 产品接线。
- `src/modules/pay-dev/runtime.ts::startPayDevelopmentBackend` 实际构造 AppRuntime、Adapter 与 isolated executor，逐请求认证。该文件已把此前只在测试 fixture 的 bridge 接到独立运行后端，因此不能再说整条链“只存在测试”。
- `src/modules/payment/pay-authority-adapter.ts::authorize/plan/execute`，复用 `requestPaidResourcePurchase({deferExecution:true})` 与 `executeApprovedPayment`；`isolated-pay-execution.ts` 验证并使用 Yosh signer。
- `src/modules/purchases/approved-payment.ts::executeApprovedPayment` 在 Yosh 保存 marker 后发最终 HTTP，独立核对原交易并保存交付。**不是 Pay 自己持签名凭据直接向商家付款。**

## C. 新增功能对比表

状态含义：“App 可用”仅指已交付的 Offline 开发版；“模块集成”不代表真实链；“未交付”明确不计入当前桌面包。

| 功能 | 旧版 | 新版变化 | 当前状态 |
|---|---|---|---|
| Agent 连接 | Yosh MCP 与成员 capability | Pay MCP 专属 wrapper 读取同一后端发行凭据，使用开发版会话心跳 | App 可用；真实宿主已有历史验证，人工验收待完成 |
| 购买工具 | request_purchase | curl + 稳定 operation_id | App 可用，仅受限 Offline GET |
| 状态查询 | 原来已有 Yosh status | 开发 wrapper 新增 get_spending_status，读 Dev AppRuntime | App 可用；不是新增预算系统 |
| Spend Grant | 已有 | 继续由同一 Yosh Grant 判断 | 原版已有；开发链复用 |
| Daily Authority/Budget | 已有全局共享日预算 | 继续同一原子预占与记账 | 原版已有；开发链复用 |
| PurchaseLedger/购买状态 | 已有持久化、Unknown、交付分离 | 加 external_pay/js_x402 来源及 operation/attempt/request/quote 绑定 | App 包含；真实模块集成覆盖 |
| 执行权持久化 | 已有购买 claim/签名门禁与目录 owner | 增加 owner/epoch、permit、writer guards、018 迁移 | App 包含；生产升级准入未完成 |
| Pause | 已有 | 外部 Pay 与默认 JS 关键节点核对持久 epoch，Pause→Resume 不复活旧 permit | App 包含；暖旧版凭据出网问题仍阻塞生产 |
| 交易构造 | JS SDK | 可选 Pay/pay-kit unsigned seam | App 可用，仅离线 profile |
| 签名/链上验证 | Yosh/Keychain 与原交易核对 | 仍由 Yosh；开发版改用离线 signer/模拟 RPC | 开发 Offline 可用；新版正式 Keychain/真实链尚未接通验收 |
| 重放与崩溃恢复 | 原 requestId 与原付款恢复 | caller+operation 跨 Pay 进程绑定；严格原报价/请求比较 | App 历史重启验收；故障矩阵为模块集成测试 |
| 通用发现/注册/POST/分块交付 | 原版工具已有 | Dev 工具仅交付 curl/status，未迁移完整资源生命周期 | Pay 产品入口尚未完成；旧代码保留 |
| Mainnet 购买 | 旧 JS 链有单笔历史真实证据 | Pay Adapter 明确拒绝 production，仅允许 Devnet 标识及本机资源 | 新版尚未开发完成/未验收，不是继承已通过 |
| 钱包库/界面同步 | 来自独立 Yosh 工作 | 合入 Dev；真实创建/导入被开发隔离层拒绝 | 界面已同步，非 Pay 新支付功能 |
| Pay 执行轨迹/详情 Route | 原来没有该 Pay 来源展示 | wrapper 采集 trace、Runtime 投影、原生详情显示 operation/trace | 当前源码存在，桌面包未包含；相关单测存在，本轮未运行 |
| 任意商家/任意协议 | v1 本来有支持边界 | Pay 受控 profile 更窄，不继承 Pay 所有协议/钱包能力 | 尚未完成；不承诺全量支持 |

## D. 替换或删除的原有能力

1. **开发入口替换**：Dev 不再以 Yosh request_purchase 执行购买，旧入口返回 PAY_MCP_REQUIRED；生产原版代码和正式 App 没有被删除或替换。默认 JS SDK 分支仍保留并有兼容测试。
2. **协议构造替换**：受控链用 Rust pay-kit 准备 unsigned，替换该链的 JS 构造步骤；Yosh 授权、签名、最终出网、核对与恢复没有整体交给 Pay。
3. **入口暂缺**：旧 discovery/register/quote/get_purchase_delivery 仍有源码，但不在当前 Dev 的两个工具中。UI 保留这些控件或源码，不证明 Pay MCP 已完整迁移该生命周期。
4. **退役体验**：独立 Codex 启动器已从当前交付流程撤下，改用现有 Desktop。历史 README 中启动器、旧工具清单应服从后来的 USER-STEPS 和 status-connection-fix 记录。
5. **配置与数据**：此前按用户授权暂时停用正式 Yosh MCP，保留其配置；不是卸载旧 Yosh。正式安装版不变，Dev 使用独立钱包、成员、Grant 和数据库，不继承生产授权或记录。

## E. 三个项目的重要模块变化

| 项目/源码 | 实际意义 |
|---|---|
| Yosh `src/modules/payment/pay-authority-adapter.ts` | Pay selected offer → Yosh 权威决策；绑定 principal、operation、attempt，恢复前比较请求/报价 |
| Yosh `payment-execution-contract.ts`、`isolated-pay-execution.ts` | 可替换构造步骤的执行 seam；严格验证 unsigned 后由 Yosh 签名，明确隔离环境限制 |
| Yosh `src/modules/purchases/execution-safety.ts`、`purchase-ledger.ts` | 在同一经济事务保存来源和执行代次；旧 permit 失效与单 writer，不另造预算账本 |
| Yosh `approved-payment.ts`、`request-paid-resource-purchase.ts`、`request-registered-resource-purchase.ts` | 分离批准/执行、接入外部 permit，保留原付款与默认 JS 路径；review fixes 修正重放和 Accept/request hash 绑定 |
| Yosh `src/modules/pay-dev/{runtime,offline-services,isolation}.ts` | 独立 AppRuntime 服务、持久模拟商家/RPC、开发数据与网络隔离；不是生产商家/链 |
| Yosh `scripts/pay-dev-{backend,mcp}.ts`、`build-yosh-pay-dev.sh`、原生 Services | 包内 Node/Pay 启动、管理通信、正常退出与独立 bundle |
| Yosh `pay-execution-trace.ts`、AppOverview/PurchaseDetailPresentation | 最新来源证据与详情投影；当前未打包 |
| Pay `rust/crates/mcp/src/authority.rs`、`context.rs`、`server.rs` 相关入口 | External Authority、caller/operation/attempt、不可变请求与 host 注入；基础来自 #514，非全部为 MCP-first 本轮新增 |
| Pay `controlled.rs`、`tools/curl.rs`、core `client/fetch.rs` | Build/Replay/execute seam，原 exact 分支受控执行及 fetch 策略；保留原 runner/selector/结果解释 |
| Pay `src/bin/yosh-controlled-mcp.rs` | 专用无 signer 的 bridge 宿主；已用于 Dev 产品，仍不是通用上游 CLI 激活开关 |
| pay-kit-current `src/x402/client/exact/payment.rs` | 新增 prepare_unsigned_payment；原 build_payment 共用构造后再签名，避免另写协议构造器 |

可复用的是 External Authority、ControlledExecution 和 unsigned preparation seam；Yosh 的私有认证、Grant、预算与账本不是 pay-kit 的新增能力。`integration/pay-persistence/upstream/manifest.json` 明确 mergeReady=false；本地可运行补丁不等于上游发布接口，vendor/Cargo 适配也不属于对外产品 API。

## F. UI 与用户体验到底改变了多少

**主体 UI 延续原产品，变化远小于底层。** 卡片窗口、顶端 Agent selector、Connection/Authority/Agents/Settings、Grant、日额度、Pause、Activity 与购买详情均不是 Pay 新建。原仓库与新版原生文件对比，仅八个同名 Swift 文件有内容差异，集中于开发启动、锁、数据模型、Settings 和详情；多数卡片视图与原仓库最新 UI 完全一致。该比较是“今天两目录”，不是精确历史视觉快照。

开发版可见变化主要为独立名称、Development/Offline/No real funds 标记、开发连接及离线钱包语义。钱包库和视觉调整来自既有 Yosh 工作同步；不应把它们归功于换支付引擎。最新 trace 源码增加 Route/Operation/Trace ID，尚不能算桌面已可见。

用户仍需打开 App、连接 Agent、审阅/设置 Grant 与共享额度，再让 Agent 购买；改变的是 Agent 调用 curl 并保留 operation_id。当前演示固定为本机测试资源，比旧版通用发现→登记→授权→购买流程更窄。同一 Pay 进程可能拒绝重复 operation；新宿主恢复也必须保持原请求与原 offer，不能承诺任意商家刷新报价后的透明重试。

## G. 用户暂时看不到的底层重构

- Rust 协议准备与 Yosh 签名/提交职责分开；官方 JS 作为默认兼容路径保留。
- 持久 provenance、owner/epoch、permit 与 SQL writer guards 将跨进程执行权纳入原购买事务。
- review-fixes 加强跨 attempt 重放的 request/accepted offer 一致性、实际 Accept 请求绑定与 epoch 事务回滚一致性。这些是修正新链约束，不能包装为新预算产品。
- SIGKILL、旧源码兼容与原款恢复测试提高证据覆盖；测试增加本身不是新用户功能。

## H. 未完成与交付核验

### 现有 App 与当前源码是否一致

本轮通过只读进程清单确认原生 PID 17298、后端 PID 17308 从桌面 Dev bundle 运行，多个 MCP 也使用该包路径；这是路径/存活证据，不是本轮付款或 coreReady 验收。

桌面包 15 个普通文件与 `build.noindex/pay-dev-delivery/Yosh Pay Dev.app` 逐文件 hash 一致。桌面 `build-provenance.json` 的 backend/wrapper hash 分别为 `fb8c48a8…`、`aec41199…`，与实际包相符；较早 `integration/product-dev/native-build-provenance.json` 是另一版，不能拿来证明当前包。

本轮仅在内存重新 bundle 当前入口、write=false，未写构建产物：backend hash `50d85514…`、wrapper `a3afaa55…`，与包不一致。进一步核查发现包内不存在 `recordPayTrace`、`readPayTrace`，当前源码则实际引入它们，差异不只来自生成变量名。因此**不能宣称当前整个工作树已打包**。包内确有 get_spending_status、PAY_OPERATION_CONFLICT、execution provenance 和 PAY_MCP_REQUIRED。

Pay 构建 provenance 中列出的生产 Rust 文件和当前源码指纹匹配，唯一个测试文件 external_authority.rs 已变化；pay-kit payment.rs 指纹匹配。该 provenance 对应的当前未签名 binary 自洽，但桌面 manifest 记录的 sourcePay hash 已不同；加上签名后二进制 hash 会改变，不能据此证明桌面 Pay 等于当前最新 Rust 产物。也未重建原生二进制证明最新 trace 模型已编入。此次未重包、未重签或替换 App。

### 正式发布缺口

- **真实 Mainnet/Keychain/RPC/商家**：新 Pay 路径没有端到端生产接线验收。Adapter 的 schema 限定 Devnet、GET、三个既有测试 resource；unsigned prepare 仅允许 loopback RPC。Mainnet preflight 工具存在不表示生产支付已通。
- **持久化与升级**：新代码有迁移、writer guards、持久 epoch 和崩溃恢复证据，但正式升级仍 BLOCKED。既有测试明确观察旧暖进程可在数据库写被拒前发送已取得的原付款凭据；不能将“拒绝旧 DML”说成“撤销旧签名”。这只是复述已知发布限制，不展开新安全审计。
- **产品范围**：通用真实商家发现/登记、GET/POST、报价/交付工具在 Pay 入口的完整迁移尚未完成；通用生产宿主和上游接口合入/发布也未完成。
- **验收与版本**：最新源码尚未全部入包；用户亲手 GUI 验收未完成。正式 Yosh.app 没有升级为 Pay 版。

证据分层：`integration/review-fixes/validation.json` 为历史 1095 项通过；`integration/product-dev` 为真实 AppRuntime + 独立服务 + 真实 Codex app-server 的离线购买/重启证据；`integration/status-connection-fix/validation.json` 为历史 1090+15+3 项通过和真实宿主状态读取，明确该次未调用购买。均不是本轮重跑，也不是实链付款。

## I. 第一版真正具备的能力与限制

现在可准确称为：**一个复用 Yosh 既有 UI、授权与账本，使用真实 Pay MCP/协议构造并由 Yosh 控制签名和最终出网的独立 Offline 开发版。** 已有真实宿主调用、购买结果入账、暂停/预算拒绝及跨进程原结果重放的历史运行证据；模拟器不等于 Mock Authority，也不等于真实链。

距离可正式发布的第一版，还需要在现有范围内完成可信升级切换、生产 Keychain/真实 RPC 与商家准入、具体授权下的真实购买及恢复验收、承诺资源生命周期的 Pay 产品接线，以及源码—构建—安装一致性和人工验收。旧版的那笔真实 Mainnet GET 证明原产品曾付款成功，不能替代新 Pay 路径的这些证据。
