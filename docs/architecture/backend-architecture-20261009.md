# Yosh 后端技术架构

日期：2026-10-09。依据 `plan.md` 的 v1 产品合同及当前后端模块整理；本文是架构说明与目标约束，不是新功能实施或付款授权。图示中的模块责任不代表全部场景已完成产品验收。

图片：[Yosh 官网风格后端技术架构 PNG](yosh-backend-architecture-official-20261009.png)。使用内置 imagegen，根据用户提供的官网参考制作：炭黑底、暖灰白文字、衬线标题、铜色 Authority Line 和小幽灵标识。提示词保存在 [生成记录](backend-architecture-official-style-prompt-20261009.txt)。图片用于概览，具体约束以本文和 v1 产品合同为准；初版图片保留供比较。

## 1. 定位与部署

Yosh 是 Agent 的经济权威与消费控制面。采用随 macOS App 分发的本地模块化单体：原生 App 监管打包 Node.js 与 Next.js standalone 后端；官方 MCP SDK 的 stdio 桥接复用后端业务入口。模块是进程内职责边界，不是独立微服务。现阶段无需远端控制服务器、分布式消息队列或自建结算设施。

后端只监听 loopback；App 的管理通道与 Agent 通道独立认证、分权。loopback 本身不是身份认证。运行时配置、SQLite 账本与诊断日志保存在私有 Application Support 目录；钱包密钥保存在 macOS Keychain。安装版不依赖源码目录或开发者 `.env.local`。

v1 的付款范围是官方 x402 V2 JavaScript SDK、Solana Mainnet、原生 USDC、受支持的 exact 流程；Mainnet 与 Devnet 的钱包、授权、账本和配置按资金作用域隔离。

## 2. 接入与权限

| 入口 | 允许的操作 | 权威边界 |
| --- | --- | --- |
| 原生 App → 管理 API | 资源审阅和管理、Spend Grant、Daily Authority、暂停、连接及生命周期管理 | 用户确认必须走可信管理通道；后端重新校验全部输入与状态 |
| Codex / Agent → MCP stdio → Agent API | 状态、发现、注册已验证资源、报价、购买意图、本人购买结果读取 | 不管理额度、不创建 Grant、不导出密钥、不接受任意交易或签名请求 |
| HTTP/MCP handler | 认证、运行时 schema、输入大小限制、服务调用、稳定错误映射 | 不独立实现预算、付款和恢复规则 |

客户端认证、Agent 身份和用户授权是三个独立事实。模型提供的 `approved: true`、普通令牌或工具调用成功均不能替代用户同意。认证请求要抵御重放；连接代次、撤销和结果所有权在后端检查。

## 3. 三个统一合同

1. **Resource Definition**：资源身份与版本、HTTPS 端点、GET/JSON POST、固定请求头、动态 query/body 的类型与限制、样例、交付格式/大小/恢复声明。未知商家使用声明式配置接入，不按商家名字分支执行付款。
2. **Authorization Model**：Spend Grant 绑定 Agent 成员、Resource、网络、mint、收款方约束、总额度、单笔上限、到期时间和必要的 POST 同意。多个资源 Grant 独立，共享 Daily Authority。
3. **Authorized Request Instance**：将资源定义和允许输入构造为一个不可变具体请求。保存 URL、方法、头/body、请求指纹和授权绑定，在报价、预检、预占、签名、付费请求及恢复中复用；不能在中途重新解释输入。

## 4. 后端模块

| 模块 | 责任 | 当前代码入口 |
| --- | --- | --- |
| 资源与发现 | 公网目标校验、只读 challenge、参数 schema、发现凭据、注册、来源元数据与交付声明 | `src/modules/resources/` |
| 授权与策略 | 成员/连接身份、Resource Grant、每日共享额度、整数金额、暂停与到期规则 | `src/modules/authority/` |
| 购买编排 | 稳定 request ID、同键异参拒绝、新鲜报价、预检、原子预占、执行权 claim、重放与持久状态 | `src/modules/purchases/` |
| 付款适配与签名 | 官方 SDK 报价/载荷/HTTP 头、Solana exact、执行安全门、Keychain signer 身份复核 | `src/modules/payment/`、`src/modules/app-wallet/` |
| 交付与恢复 | 有界 JSON/text、持久结果、所有权校验、分块读取、原交易对账和有限交付重试 | `src/modules/purchases/delivery-*`、`original-payment-*` |
| 本地运行与 MCP | 配置与数据目录所有权、健康状态、安全退出、认证、MCP 协议与宿主会话 | `src/modules/app/`、`src/modules/mcp/` |

## 5. 生命周期与执行顺序

**发现 → MCP 注册 → 用户审阅 → 用户创建 Grant → Agent 购买 → 交付 → 账本/恢复。**

发现请求永不签名或付款。未知 JSON POST 的未付款探索仍可能产生副作用，必须先由用户确认确切请求。成功发现生成后端保存、绑定成员/连接/代次、带有效期的凭据；受限 MCP 注册原子消费该凭据，不接受 Agent 改写执行配置。注册只创建资源，不产生消费权。

每笔新购买依次进行：认证及请求校验 → 按 `(cardMemberId, requestId)` 查重 → 构造不可变请求 → 获取新鲜 402 quote → 校验网络/mint/收款方/金额/有效期 → Grant 与预检 → 在 SQLite 事务内判断额度并预占 → 原子领取执行权 → 签名前再次检查授权、暂停、报价绑定与 signer → 官方 SDK 构造付款 → 持久保存原付款凭据 → 首次提交前再核对 → 发送带原凭据的请求 → 付款对账与交付持久化。

幂等复用原购买；同键异参返回冲突，不重新报价或付款。报价、资源、Grant、余额、fee payer 和 RPC 网络预检只决定本地可执行性，不承诺商家结算或资源交付。

## 6. 资金状态与恢复

付款和交付分别建模。付款状态包含 `DENIED / APPROVED / PAYING / PAYMENT_UNKNOWN / PAID` 等；交付状态使用 `NOT_PAID / PENDING / DELIVERING / COMPLETE / EXHAUSTED / UNSUPPORTED`，收据事实另存。`PAID` 不自动意味着 `COMPLETE`。

提交后超时或连接中断归为结果未知，保留预算预占、原付款载荷及交易线索，查询并恢复原交易。不能释放未知付款预算、重新签名或创建替代交易。只有可靠证据能确认付款状态。

已付款但交付失败时，仅使用资源确实声明并校验的恢复能力和原付款凭据。当前实现交付重试上限为 4 次，进度、执行权和下次尝试时间持久化；重启不重置次数。没有第三方恢复支持则明确标记 `UNSUPPORTED`，不承诺可恢复，也不再次扣款。

暂停和退出与签名/提交采用明确顺序。暂停确认后不得启动新的签名提交；退出先 drain，等待正在执行的工作安全停止。失败时保持 App/后端可观察，不强制结束正在签名的进程。已提交或未知付款保留账务并继续或在下次启动恢复。

## 7. 数据与安全约束

- 金额使用 bigint 或校验后的十进制整数字符串；API 同时标明网络、mint 和精度。权威比较与累计不用浮点数。
- SQLite 原子事务负责预算判断、预占、执行权与幂等。预算可用额度考虑已付和预占；Grant 和 Daily Authority 必须同时满足。schema 只通过显式迁移演进，保留历史与进行中付款。
- 外部 HTTPS 使用公网 DNS 检查与地址绑定，防 SSRF/DNS rebinding，禁重定向，并限制时间、请求/响应大小和媒体类型。POST 同意绑定不可变策略。
- Keychain 私钥只在后端 signer 内短暂使用，核对受保护密钥与预期公钥；App 和 Agent 不能获取签名载荷或密钥。
- 交付结果按购买所有者隔离，大结果用有界分块读取；HTTP、存储与 MCP 的上限与错误语义保持一致。
- 日志使用字段白名单，保留脱敏错误码、阶段和关联购买 ID；不记录环境、完整配置、密钥、认证材料、原付款载荷或 SDK 原始异常。
- 商家及其 facilitator 负责商家侧验证/结算；Yosh 通过官方协议适配付款并按原凭据对账，不自建 facilitator。

## 8. 运行与验收边界

原生监管器分别观察 HTTP 可用、管理认证、核心就绪、钱包就绪与原付款恢复；单一“启动成功”不能替代独立状态。数据目录保持单一所有者，异常退出采用有界退避，正常退出验证子进程退出与端口释放。

依据 2026-10-08 仓库记录，Agent 发现/注册/共享展示和无 Grant 拒绝已通过实际宿主验收；一笔 Agent402 Mainnet GET 购买及首次交付有单笔证据。真实 POST 购买、真实丢响应恢复、商家付费交付恢复及零系统提示分发仍未完成全面验收。本次仅整理文档与图片，没有重新运行测试或 App，也没有新建资源、Grant、付款、安装、提交或推送。

参考：[v1 产品合同](../../plan.md)、[资源生命周期](resources/agent-purchase-lifecycle.md)、[Agent MCP 注册](resources/agent-mcp-registration.md)、[安装运行时](product-startup-runtime.md)、[付款配置](payment-product-configuration.md)、[首笔 Mainnet 购买证据](../demo/first-mainnet-purchase-20261008.md)。
