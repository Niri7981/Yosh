# Yosh macOS 第一版实施计划

更新日期：2026-10-08。

本文是 Yosh v1 的现行产品与架构合同，并保留历史实施证据。产品要求以“Yosh v1 产品合同”为准；历史阶段、旧规则和验收记录只说明当时的决策与证据，不自动代表当前能力或授权。任何开发进度都不代表实际付款、部署或推送授权。

## Yosh v1 产品合同（2026-10-08）

### 产品定位与支持范围

Yosh 是自主 Agent 的经济权威与消费控制面：**x402 让 Agent 能付款，Yosh 决定它是否应该付款。** Yosh 不是 API 市场、新支付协议或商家专属集成集合。架构必须保持：**一个 Resource Model、一个 Authorization Model、一条 x402 Payment Pipeline。** 新商家通过经过校验的声明式 Resource 配置接入，不应要求按商家名称修改 Yosh 源码。

v1 的目标产品是原生 macOS App、本地随 App 提供的后端，以及面向兼容 Agent（首先是 Codex）的 MCP 接入。付款目标限定为官方 x402 V2 JavaScript SDK、Solana Mainnet、原生 USDC 和受支持的 `exact` 流程，配合专用 Keychain 钱包、Spend Grant、Daily Authority、原子预占、账本与恢复。HTTP Resource 目标支持静态 GET、参数化 GET、固定 JSON POST、参数化 JSON POST、声明式请求头/参数约束/交付策略，以及有明确大小限制的 JSON 与文本响应。**这段描述目标范围，不表示这些能力都已实现或通过安装版验收。** v1 不承诺支持所有网络、资产、x402 scheme 或任意 HTTP 响应格式。

能力状态必须逐项按证据标为：已实现并测试、部分实现、缺失、等待安装版验证、v1 有意不支持。单元测试通过不等于完整生命周期、真实 Agent 宿主或安装版验收完成。历史 Devnet 购买仅是 Devnet 证据；首笔真实 Mainnet GET 购买的实际证据见 [2026-10-08 验收记录](docs/demo/first-mainnet-purchase-20261008.md)，不外推到其它资源或恢复场景。

### 端到端用户生命周期

```text
Agent 发现候选 x402 API → MCP 注册已验证 Resource → Yosh 自动展示供用户审阅
→ 用户创建 Spend Grant → Agent 请求购买 → Yosh 授权并通过 x402 付款
→ Agent 收到购买结果 → Yosh 记账并在需要时恢复原交易/交付
```

各阶段共享同一份经过校验的 Resource Definition 和同一个不可变 Authorized Request Instance；禁止在发现、Grant、预检、预占、签名或付费重试时重新解释请求。

| 阶段 | 输入与输出 | 权限边界及状态 |
|---|---|---|
| Discovery | Agent 提交候选 origin/endpoint、HTTP 方法及必要输入；Yosh 以安全的未付款请求取得响应或 402 payment requirements，并返回兼容性分析 | 支持 GET 与 JSON POST 的目标能力。POST 必须受显式字段约束并满足副作用安全策略；不得对不可信端点盲目提交任意数据。Discovery 永不签名或付款。它是 Agent 驱动的候选端点发现，不是全网搜索引擎 |
| Resource Registration / Review | 成功发现生成绑定当前认证 Agent 的后端发现凭据；Agent 通过受限 MCP 创建入口注册该凭据中的不可变 Resource Definition。App 自动展示端点、方法、固定/动态输入、约束、样例、交付配置及 Agent 提交来源和未确认事项 | 本轮用户指示允许 Agent 创建已验证资源，替代此前仅提议/用户登记流程。Agent 无通用管理权限；注册不创建 Grant 或消费权。用户在 Yosh 审阅后独立创建 Spend Grant |
| Quote / Grant | 用户选择动态 Resource 的有效样例请求；Yosh 进行只读报价，不付款；用户创建 Grant | Grant 绑定 Agent 身份、Resource 身份、经济范围、允许的收款方约束、网络/资产、总额度、单笔上限和到期时间。同一 Agent 可对不同 Resource 持有独立有效 Grant，但共享 Daily Authority。注册和 Grant 是不同授权 |
| Purchase / Authorization | Agent 提交已注册 Resource ID、允许的请求输入、用途和稳定 request ID；Yosh 返回购买状态与可安全交付的结果 | Yosh 构造唯一不可变 Authorized Request Instance。每笔新购买取新鲜 x402 quote，并在签名前检查授权和经济约束；复用同一实例进行 Grant 检查、preflight、reserve、sign、paid-request retry。官方 SDK 处理所支持的协议语义与付款构造；Yosh 管经济授权、签名边界、请求身份、账务、幂等和恢复 |
| Delivery / Ledger / Recovery | 成功 HTTP 响应、付款/结算证据、持久购买与交付状态 | 付款成功不等于资源交付成功。接受 Resource 声明的成功响应（目标含 200/201），并确保 Agent 可检索交付内容；HTTP 响应上限、持久结果存储和 MCP 输出上限必须一致。未知付款只能核对/恢复原交易；交付失败绝不自动创建第二笔付款 |

### 必须保持的架构不变量

- 不按商家名称分支执行付款；不接受 Agent 提供的任意钱包交易，不让 Agent 控制私钥。
- MCP 注册是 Agent 显式调用的受限资源创建操作，必须消费后端保存的成功发现凭据；不得隐式登记或授予消费权。用户创建 Grant 是独立的明确授权操作。
- 已安装产品不要求开发者 `.env.local` 才能运行。
- Discovery、注册、Grant 样例请求、购买与恢复必须遵循同一 Resource / Authorized Request 合同。
- 资源 readiness、预算 reservation、执行权 claim 和签名提交必须采用一致且原子的规则。
- 不削弱 SSRF、DNS rebinding、redirect、认证、客户端身份或 signer 身份校验。
- 保持 Mainnet/Devnet 隔离，不改写历史金融记录；保留原付款证据、未知付款与交付恢复保证。
- Agent 身份、用户授权证明和客户端认证是不同事实；模型字段、重复令牌或 MCP 请求本身不能证明用户同意。

### 当前能力状态快照

此快照按仓库历史和截至 2026-10-07 的记录填写；“已实现”只代表表中明确的边界，不外推到完整生命周期。

| 状态 | 能力及证据边界 |
|---|---|
| 已实现并测试 | 持久运行时 Registered API registry 的管理 list/add/inspect/disable/remove；旧资源一次性导入与 tombstone；非付款 x402 discovery；单一后端 registry 被管理界面及 Authority selector 共用。2026-10-07 记录含安装版非付款 You.com discovery、注册持久读取和未授权请求 401 证据 |
| 已实现并测试（历史/局部） | Devnet 测试 USDC 的官方 x402 exact 购买、有限 Codex CardMember/Grant 路径、原子 reservation、幂等、未知付款和原付款恢复；证据见下方带日期记录。历史 Devnet 付款不能作为 Mainnet 证据 |
| 部分实现 | Mainnet 隔离、授权/账本隔离、条件执行入口、已登记资源的后端购买管线、声明式外部 HTTPS 请求和持久交付恢复已有阶段性实现；旧绑定对部分 600 秒 challenge 有已知兼容限制。用户可用的通用资源生命周期仍未完成 |
| 缺失或未证明 | Agent 驱动的安全 GET/JSON POST discovery 与注册提议闭环；完整可变 query/body Resource contract；未知 JSON POST 商家的无源码变更全生命周期；跨阶段同一 Authorized Request Instance；Agent-bound、多 Resource 独立 Grants 的完整产品验收；200/201 与 HTTP/MCP/存储大小一致性回归；三类合成商家的端到端生命周期验收 |
| 等待安装版/宿主验证 | 截至 2026-10-07，安装版 desktop MCP 记录为 Transport closed、连接 disabled/disconnected；不可将 fixture 或 MCP mock 视为 Codex 实际宿主验收。任何新接线完成后仍需按该功能的实际验收记录更新状态 |
| v1 有意不支持 | 全网 API 搜索/市场、任意 x402 网络/资产/scheme、任意 HTTP 媒体格式、商家专属付款适配、Agent 管理权限、任意签名和退款 |

### 通用资源生命周期验收合同

必须先用合成商家验证通用架构，之后才把 Agent402、You.com 作为外部兼容性验证，不为它们增加特例。以下三种此前未知的 Resource 形状均须在不改 Yosh 源码的条件下通过同一完整路径：

1. 带多个 x402 payment options 的参数化 GET。
2. 有必需动态输入参数、quote 有效期较长的动态 GET。
3. 未知商家的 JSON POST，分别覆盖固定 body 与动态 body。

每种都必须覆盖 Discovery → Registration Proposal → User Approval → Quote → Grant → Authorized Request → Preflight → Payment Pipeline → Delivery to Agent → Ledger/Recovery。还须覆盖：价格、收款方、mint、network 错误或变化；缺失/无效参数；同一 Agent 多个有效 Resource Grant；不支持的付款 flow；DNS rebinding 与不安全网络目标；HTTP 200/201；超大 MCP 响应；重复 request ID；重启与未知付款恢复；已付款但交付不可用。任何 fixture 结果均与真实安装版/真实链路证据分开标记。

### 尚待确定并验收的产品细节

这些事项不阻止本合同定义目标，但在对应实现阶段必须先确定并记录，不能由商家特例或客户端默认值隐式决定：

- 用户批准 Resource 与消费授权的可信确认通道，以及宿主无法证明用户操作时的产品行为。
- JSON POST discovery 的副作用安全声明、允许的媒体类型/字段约束，以及是否允许对特定 endpoint 执行未付款 POST。
- Resource ID/endpoint 规范化、动态参数 schema、允许请求头集合、敏感输入存放/展示和 Resource 版本变化规则。
- x402 多 payment option 的选择策略，以及 v1 `exact` 支持下对 quote 有效期、recipient 约束和价格变化的精确定义。
- HTTP、持久结果与 MCP 各自的响应大小上限，以及 JSON/text 解码失败时给 Agent 的稳定错误契约。
- 各 Resource 可声明的交付恢复能力、凭据保留期限和第三方不支持恢复时的终态展示。
- 完整 Mainnet 安装版验收的具体 Resource、收款方、用途与金额上限；实际付款仍须另行取得具体授权。

## 历史授权、阶段与证据的解释

本文后续带日期的阶段记录是不可覆盖的历史证据。旧版“固定 API/GET-only”“跨 Agent 共用 API 长期批准”“全网 API 自动发现”以及旧 M0–M7 排期中的假设已被上面的 v1 合同取代：Resource 可声明 GET/JSON POST 和动态输入；Resource 注册需用户批准；Spend Grant 绑定 Agent 与 Resource；Agent 驱动的候选 API discovery 属于目标，全球搜索引擎仍不属于目标。不得将旧阶段表中的“已完成”解释为当前产品生命周期完成。

## 代码提交与本地同步（用户明确授权）

- 每次完成用户要求的修改并通过对应验证后，自动提交本次相关文件并推送到 GitHub 的 `origin/main`；默认不创建 PR，不再重复询问是否提交或推送。
- 正常顺序：本地修改 → 按风险验证 → 提交 → 推送 `main` → 确认桌面项目与远端同步；文档修改检查内容和 diff，无需重跑代码全套测试。
- 用户日常查看的本地项目是 `/Users/irin/Desktop/2049`。若在 Codex 独立工作目录修改，推送后必须将桌面项目的 `main` 安全快进到相同提交，不能只更新 GitHub 就宣称本地已同步。
- 推送前检查远端更新，同步前检查桌面项目分支和未提交修改。不得覆盖用户改动、强制推送、清除工作区或提交密钥、配置及付款数据；若有冲突或无法安全快进，报告具体阻碍，保留现有内容。
- 完成时核对工作目录、GitHub `main` 和桌面项目的提交编号，并报告提交结果；推送或同步失败时不得声称已完成。
- 本节是用户对提交、推送与桌面同步的持续授权，取代旧文档中“不自动提交、推送”的约定；不包含实际付款、部署或发布授权。

## 本机 App 交付与验收（2026-10-01 用户持续授权）

2026-10-05：用户要求将已安装 App 更名为 **Yosh**，使用用户提供的图标。安装脚本更新 `/Users/irin/Applications/Yosh.app`，验证后移除旧名称的安装副本；bundle ID、钥匙串身份、数据目录和 MCP 配置身份继续沿用，保留原钱包、账本和设置。

本轮证据（2026-10-05 12:58）：修正首版将截图外围带入图标的问题；以用户第二张图右下角 ICON (APP) 为参考，通过 imagegen 提取为无边框、深灰满底方形素材，由 macOS 提供最终圆角。typecheck、lint、后端 production build、原生 Release build 通过；安装版与构建产物一致，签名校验通过。Finder 实际显示已核对，重复厚黑边已去除。旧 App 与后端正常退出；新版实际进程为 `/Users/irin/Applications/Yosh.app/Contents/MacOS/Yosh`，本次生命周期日志确认后端 PID 17848 已就绪，App 显示原有 PIN 解锁入口。Connection/Members 检查在名称修改时已通过，本次纯图标修正不重复执行；没有执行付款。

- 用户直接点击 `/Users/irin/Applications/Yosh.app` 图标启动并验收，不使用终端启动指令。桌面项目源码或临时目录中的构建成功，不代表这个已安装 App 已更新。
- 每次完成影响原生 App、其运行后端或依赖的已授权改动并通过对应验证后，由 Agent 完成：正常退出旧 App → 等待后端安全停止 → 运行现有 `scripts/install-macos-app.sh` 构建并更新同一安装位置 → 重新打开已安装 App → 核对安装产物与本次构建一致、实际运行路径正确、后端已就绪。正常退出不能用关闭窗口代替，也不强制终止进行中的付款服务。
- 此流程是持续授权，无需每轮再询问是否本机安装或重新打开；它优先于 Skills 中“不自动启动 App”的默认建议。仅修改文档时不重装。Computer Use、提交、推送和对外发布仍遵循用户当前指示，此流程不增加实际付款或功能开发授权。
- 沿用原钱包、账本、暂停状态和本地配置。若安全退出失败、安装失败或 macOS 等待用户确认钥匙串访问，报告具体阻碍；系统确认由用户完成，未验证后端就绪前不能宣称启动成功。
- 完成时说明已更新用户点击的安装版及当前启动结果；需要进入 Authority 等具体页面时给出最短的界面操作提示，不要求用户自行寻找构建产物或执行启动命令。

## 历史实施状态（2026-09-18）

以下记录保留当时的 2049 / BOUND 名称、阶段及实际付款证据，不表示当前运行验收。现行产品名称为 Yosh；安全与持久标识规则见 [更名兼容边界](docs/architecture/yosh-rename-compatibility.md)。

- [x] M0：完成只读盘点。原专用 Devnet 钱包及钥匙串签名器一致，原账本可读；桌面项目当前买方公钥与该签名器不一致，因此未用于付款。
- [x] M1：完成开发态 Electron 壳、本机认证管理 API、单实例、窗口关闭后后台存活、菜单栏入口与退出停服。安装包仍属于 M7。
- [x] M2：完成产品专用钥匙串钱包、后端余额读取、无默认值的持久额度、暂停、电脑本地时区预算窗口和并发事务测试。
- [ ] M3（真实付款已验证，验收待补齐）：App 共用后端已完成 0.01 测试 USDC 购买；链上余额、同一购买号重放、关闭并重建 AppRuntime 后复用原交易及界面展示已验证。此前没有完整验证按钮重复点击和整个 App 退出重启，不能用运行时重建代替这些场景。默认启动仍为模拟模式。
- [ ] M4（部分完成）：已接入官方 MCP SDK 的 stdio 桥接，开放额度、报价查询和 `request_purchase`。App 持久维护一个默认 Codex CardMember；有限消费授权和购买所有权绑定 CardMember，连接 ID/代次仅作为凭据与审计事实。Agent 只能选择后端定义的 basic 0.20 / premium 20 test USDC offer，并提交稳定 requestId 与用途。后端取得真实 x402 402 报价，原子写入 `APPROVED` / `DENIED`；在显式启用 Devnet 付款时，basic 的持久报价会进入原有 claim、官方 x402 client、签名、结算与恢复流水线，premium 仍在付款边界前拒绝。自动化已覆盖跨连接重放、同键异参、并发同 ID、授权竞态、篡改、未知付款和重启恢复。实际 Codex 宿主付款验收和原对话确认仍待完成。详见 [MCP 接入](docs/architecture/mcp-integration.md)。
- [ ] M5–M7：未开始。

2026-09-15 修复：补齐实际签名前暂停检查、退出等待进行中操作、启动时原订单恢复；已付款与交付状态分开，交付失败不再改写付款结果。未提交崩溃记录的预占可安全释放，未知付款保留原凭据。当时尚未执行真实 Devnet 购买；有次数上限的自动交付重试仍属于 M5。

2026-09-18 收缩：报价与回执头、付款凭据和测试 Paid API 的协议编解码改用官方 x402 客户端；App 和旧任务入口改为复用同一个市场快照购买服务，App 真实测试入口不再经过模型规划与资源发现。钱包、授权、共享额度、持久状态和原付款恢复仍由 2049 维护。

2026-09-21 Authority Core 阶段一：新增通用 `SpendIntent`、`AuthorityDecision` 和 `SpendReservation`，决策统一为 `APPROVED`、`DENIED`、`REQUIRES_APPROVAL`。行情 resource/provider/SOL 与报价一致性校验移入 market resource adapter；market snapshot Demo 继续经原子预算预占和 `approvalId` 付款边界执行。MCP、Jev、第二 provider、UI 和新支付轨道不在本阶段范围。详见 [Authority Core（阶段一）](docs/architecture/authority-core.md)。

2026-09-21 有限消费授权：新增持久 `SpendGrant` 和管理界面。授权固定到市场快照 operation、Provider、资源、Devnet、测试 USDC、收款方、支付方式及连接代次；总额按授权生命周期累计，不随每日额度重置。本阶段只验证授权成功、策略边界和旧凭据失效；MCP 仍只有查询工具，不代表 Agent 购买、0.20/20 报价、真实 Codex 宿主或新 Devnet 交易已验收。

2026-09-22 购买请求阶段：新增 MCP `request_purchase` 和认证 Agent POST 入口。basic/premium 报价由测试 Paid API 经官方 x402 server 生成 402；请求层校验完整报价后绑定 SpendGrant 并调用同一账本 reserve。返回安全报价摘要、grant/version 和决策；`paymentStatus` 固定为 `NOT_STARTED`。本阶段没有 claim、签名、付款载荷、settle 或链上交易。

2026-09-22 BOUND STEP 1：将持久 `APPROVED` 请求桥接到原有付款流水线。执行只使用账本保存的不可变报价和内部 `approvalId`；0.20 offer 的金额、完整资源端点、买方、网络、资产、收款方、memo、fee payer 和报价指纹纳入执行绑定。claim、加载 signer 前、SDK 实际签名前、保存 payload 及首次提交前均重新核对授权和绑定。`DENIED` 仍保持 `NOT_STARTED` 且不进入 preflight、claim 或 signer。自动化使用模拟依赖验证，没有发生真实 Devnet 付款；STEP 2–7 未开始。

2026-09-23 稳定 Agent 身份：新增持久默认 Codex CardMember，MCP 凭据由后端绑定该成员；重新启用、重连和凭据轮换可产生新的 `connectionId` / generation，但不会改变购买所有权。SpendGrant 按 CardMember 约束，购买行保存标准化 `owner_card_member_id`，同时保留原连接事实供审计。相同 CardMember 重放已完成请求会直接返回原交易与资源，不重新报价、签名、付款或结算；不同 CardMember 和已撤销 CardMember 均被拒绝。当前仍只有一个真实成员，全局 `requestId` 唯一约束保持不变；启用第二个真实成员前必须改为成员范围唯一。历史不同 `connectionId` 分别导入，不自动合并，付款证据不改写。本阶段没有执行真实 Devnet 付款。

2026-09-18 M3 验收：产品钱包 `Hr937hUNE1yHzjDLhZngWn8rHUWGTuTRLMJoTzi9BUeH` 在真实 Devnet 模式完成购买 `m3-20260918-final-1`。付款交易为 `42qEJgZfZbWbf8FRwuKvJ2mfMwyi5evrZr2r9cNfriocGxN4gt5jfAAjKiDBjKn2Tpx9ihbdMHu2zbKKK5GfAVkr`；RPC 确认买方 `10000 → 0`、商家 `130000 → 140000` 最小单位。当前进程重放和重新打开账本后的重放均返回同一交易，购买记录始终只有一条；App 界面显示付款已确认、结果已交付、当日已消费 0.01 测试 USDC。

新 App 开发以本文和 [AGENTS.md](AGENTS.md) 为依据；`docs/architecture/v0/` 中原 V0 文档保留为测试网 Demo 的历史设计。旧文档中的固定资源、固定预算、不使用 MCP 等限定不自动延续到新 App；钱包隔离、报价校验、幂等和恢复要求继续保留。

## 历史计划：产品与范围（旧假设由上方 Yosh v1 产品合同取代）

本节保留 2026-10-06 及更早的范围讨论，不能覆盖上方 2026-10-08 合同。现行 v1 产品定位、支持范围和能力状态以“Yosh v1 产品合同”为准。

### x402 复用边界（2026-09-18 确认）

产品工作主要投入 x402 上层的使用体验与消费管理。协议已有能力优先使用官方 SDK、扩展和接入示例；不另建同等功能的支付协议、通用 SDK 或结算基础设施。

| 范围 | 实现原则 |
|---|---|
| 协议报价解析、支付头编解码、付款载荷构造、验证与结算接入 | 优先复用 x402 官方实现，本地仅保留必要适配与业务约束 |
| 单笔限制、资产筛选、付款前检查 | 优先使用官方配置、策略和 hooks 接入 Yosh 规则；跨 Agent 的每日额度与原子预占仍由持久账本维护 |
| MCP 接入 | 复用官方适用的接入方式，Yosh 只连接自己的购买服务；区分 MCP 调用 HTTP API 与原生付费 MCP 工具，不因包名相同就直接替换 |
| 钱包、用户授权、每日额度、暂停、记录与恢复进度 | Yosh 的核心产品职责；官方扩展提供基础能力时，在其上组合实现 |
| 自建 Paid API、旧模型执行器和行情 fixture | 保留为测试设施，满足验收即可，不继续扩展为产品主线 |

后续每个阶段先核对锁定 SDK 版本的现成功能，再决定需要补充的上层逻辑。新增自研适配须记录具体缺口；可被官方能力覆盖的旧实现按阶段逐步替换，不为整理代码扩大当前范围。

复用仍须满足现有资金与授权约束：官方确认回调是接入点，不能直接证明宿主用户同意；付款标识需要对端支持和持久去重；未知付款不能因 SDK 重试而生成替代付款。保留必要的业务校验和恢复状态不属于重复实现协议。

实际替换与验收范围以上方实施状态和对应证据为准；本节原则本身不放宽 M0–M7 的验收要求。

### 第一版范围（历史草案）

- App 负责展示、管理设置和提交用户操作，不内置聊天或任务执行界面。
- 本地后端负责钱包、报价、授权、额度、付款、账本和交付恢复。
- MCP 负责把 Codex 的请求接入同一个后端，不另建付款逻辑。
- 用户在 Codex 原对话中提出需求、确认购买、接收结果。
- 历史验证链路曾使用自建 Paid API 和 Solana Devnet；现行 v1 目标与未完成验收边界见上方产品合同及下方阶段证据。
- 原生 SOL 可以作为后续同链资产扩展；不把“Solana 支持”等同于支持该链所有币种。资产按实际 API 报价和已实现适配范围校验。

旧草案中的“不做全网 API 自动发现”现明确为“不做全球 API 搜索引擎”；Agent 针对已知候选端点执行未付款 discovery 是 v1 目标。其他旧排除项仅在与上方合同一致时继续有效。

界面先使用简单文字、表单和按钮。保留用户喜欢 Phantom 丝滑交互的设计偏好，但不作为当前开发任务或验收条件。

## 2. 历史基础与当前限制（状态以产品合同快照及最新证据为准）

根据历史仓库验收记录，曾完成：自建 x402 V2 `exact` Paid API、Devnet 测试 USDC 付款、规则审批、钥匙串签名、SQLite 账本、并发预占、幂等和原付款恢复。历史能力不等于当前所有资源类型或 Mainnet 产品闭环已验收。

这些能力有测试网历史证据。固定测试币、价格和历史行情快照属于旧阶段边界，不应被误认为通用 Resource Model。

截至 2026-10-07 的记录，已存在安装版原生 macOS App 和运行时 Registered API registry；但安装版 Codex MCP 仍为 disabled/disconnected，Agent 实际宿主与完整 Mainnet 购买/交付验收未完成。旧网页模型规划与任务分析属于演示入口，不搬入产品 App。更新这些状态必须附本轮实际证据。

本机状态备注：旧 CLI 配置中的买方公钥仍与旧钥匙串签名器不一致，不能直接用于新付款。M3 使用独立的产品钥匙串钱包，不依赖该 CLI 公钥，并已完成真实付款。后续若恢复旧 CLI 测试，应核对并复用原专用钥匙串钱包；不能只改公钥、覆盖旧钱包或删除原付款记录。交易浏览器曾返回 429；是否可查看交易网页与 RPC 能否验证交易分别报告。

## 3. 架构与职责（现行职责须符合 Yosh v1 产品合同）

```text
原生 macOS App ── 管理 API ──┐
                             ├── Yosh 本地后端 ── 登记的外部 x402 Resource
兼容 Agent ── MCP 接口 ───────┘          │
                               Keychain / SQLite / Solana RPC
```

采用本机模块化服务，不拆成云端微服务。上方“原生 macOS App”是 v1 产品要求；具体壳与后端打包方式须以当前实现和 [macOS App 壳与本地服务生命周期](docs/architecture/macos-app-shell.md) 为证，不可把旧计划中 Electron 的选择写成目标平台限制。MCP 的可用传输和实际宿主状态按最新验证记录更新。

| 模块 | 负责 | 不负责 |
|---|---|---|
| App 展示层 | 展示后端返回的地址、余额、额度、记录、状态；提交设置和管理操作 | 保存密钥、构造交易、计算权威预算、批准或执行付款 |
| App 壳与进程管理 | 窗口、菜单栏、本地服务生命周期 | 复制资金业务规则 |
| 管理 API | 认证本地管理客户端、校验输入、调用业务服务、返回安全数据 | 信任前端传来的金额或布尔授权字段 |
| MCP 适配层 | 认证 Agent 连接、提交购买请求、返回待确认状态及结果 | 持有签名密钥、修改管理设置、绕过策略 |
| 购买与授权服务 | 创建不可变报价记录、保存有效授权、评估策略和额度 | 依赖模型判断付款是否合法 |
| 付款模块 | 签名前复核、调用钥匙串、付款和原交易对账 | 签署任意客户端提供的交易 |
| 账本与交付模块 | 原子预占、持久状态、幂等、结果验证、交付恢复 | 用超时推断未扣款并重新支付 |

本地接口仅绑定本机，管理与 Agent 权限分开。仅来自 localhost 不等于可信；连接认证、跨站请求限制和签名隔离必须覆盖实际采用的传输方式。

## 4. 已确认的产品规则

### 钱包与首次使用

2026-10-16 Wallet Onboarding：用户已接受首次 Mainnet Create / Import 与同身份恢复、24 词 BIP39 Create、限定格式/路径 Import、受控 Native 新钱包访问边界和备份验证后 READY；无 Replace / Delete / Switch。仅授权 Stage 0 / Stage 1；本轮不操作真实钱包/ACL/Ledger、不付款、不重装、不 Commit/Push。新增能力及当前验证边界见 [Stage 0 / Stage 1 记录](docs/architecture/wallet-onboarding-stage0-1.md)。本机无可用稳定签名身份，生产 helper / 新 adapter / 真实用户在场验收暂停；Stage 1 仅增加 legacy 公钥 pin / 账户元数据、显式状态和 existing-only 加载，不修改旧身份、资金记录或官方支付执行核心。Stage 2 仍待另行审阅授权。

2026-10-06 用户澄清：以下为后续 WalletAccount 实施的强制约束，取代旧的首次启动自动创建规则；本次仅更新文档，尚未实现或验收迁移。

- 当前 Mac 已有真实 Devnet/Test 与 Mainnet 两个 Yosh 钱包，均为现有用户钱包；Mainnet 即将用于真实付款验收与录屏，但此说明不构成付款授权。
- 迁移仅创建或采用引用原身份的 WalletAccount 元数据，沿用原 Keychain service/account 与同一 keypair。不得生成替代钱包、轮换密钥、删除或覆盖旧项、改变公钥地址；默认不移动私钥字节，确有必要时须先说明原因及保留方案。
- 所有旧 Yosh Keychain 位置中的现有钱包均按用户钱包处理，不因旧名称或存储位置将其丢弃。现有产品项为 Devnet/Test 的 `com.2049.wallet.v1` / `consumer-wallet-v1`，以及 Mainnet 的 `com.yosh.wallet.mainnet.v1` / `consumer-wallet-mainnet-v1`；实施前还须核对其他旧位置，不读取或输出真实私钥作诊断。
- WalletAccount 采用必须确定且幂等；重复执行、并发执行、部分完成后的重启均不能生成重复账户或钱包。已有账户应复用；身份冲突、损坏或 Keychain 无法访问时报错，不把访问失败当成不存在，不创建替代身份。
- 保留既有付款历史、账本、预占、未知付款与原凭据恢复关联。历史行的原钱包身份和 monetary scope 不改写为新的钱包身份；新增账户映射必须关联正确的原钱包，不能依据当前选择的网络猜测或合并两个钱包。
- 真正全新安装（不存在任何 legacy 或 WalletAccount 钱包）从零钱包开始。启动及打开 Overview、Authority、Balance、Settings、MCP status，或切换环境、连接 MCP，均不得自动生成钱包。
- 用户必须显式选择 `Create New Wallet` 或 `Import Wallet`；只有明确的 Create Wallet 操作生成新 keypair，Import Wallet 采用用户提供的身份而不额外生成钱包。这是后续钱包范围要求，不是本轮实现授权。
- App 展示地址、余额和充值入口，用户可从 Phantom 等外部钱包充值。
- 不要求用户向 Agent 提交私钥或助记词；后续 Import Wallet 的具体安全流程另行设计和授权，取代旧的永久排除导入约定。
- 全新安装首次流程：显式创建或导入钱包 → 充值 → 自行填写每日额度 → 连接 Codex → 首页；未操作前保持零钱包，不自动补齐。
- 充值、连接和额度设置可稍后完成；后端阻止条件不齐的付款，并返回具体原因。

**迁移前测试门禁：** 修改任何钱包迁移代码前，先添加以下边界回归测试；使用固定测试 keypair、内存 Keychain 和临时账本，不访问本机真实密钥、不付款。新增迁移/零钱包行为在旧实现上的失败必须先记录，之后才实现对应修复。

- 预置两个不同的 legacy keypair，采用为普通 WalletAccount 后 Mainnet 与 Devnet 公钥和完整私钥字节逐一完全不变，旧项内容及位置不变；生成、创建、覆盖、删除、搬运密钥的调用次数均为零。
- 重复、并发及中断后重启采用均得到同一账户映射；两钱包场景恰好两个账户，无重复账户或新钱包。已有 WalletAccount 与 legacy 并存时复用原身份；冲突和读取拒绝不得触发替代生成。
- 混合 Mainnet/Devnet 历史中的已付款、未提交、未知付款及预占继续映射各自原钱包；迁移及重启前后金额、交易、凭据与恢复归属保持不变，不再次签名或扣款。
- 空 legacy/WalletAccount 状态下，启动、全部上述只读页面、MCP 状态/连接及环境切换后仍为零账户、零 Keychain 写入、零 keypair 生成；重复读取和重启结果不变。
- 只有显式 Create Wallet 才生成并保存新 keypair；重复提交同一创建操作不产生第二钱包。显式 Import Wallet 保留所导入身份，且不调用新 keypair 生成。

升级本机的最终验收必须分别确认两个原钱包的公钥与私钥身份不变、账本关联正确且没有额外钱包。自动化 fixture 通过不等于本机已验证；私钥一致性仅在后端受控边界核对，不导出、截图、写入日志或提交真实密钥。

2026-10-06 Settings 钱包只读入口：用户另行授权先展示现有 Mainnet／Devnet 钱包。Settings 顶部新增 WALLETS，两项分别通过认证管理 `GET /api/app/wallets` 读取原产品 Keychain 并派生公钥，支持复制完整地址；不依赖当前 Execution 或配置公钥猜测。缺失显示 No wallet，读取失败或损坏显示 Keychain unavailable，失败项不妨碍另一项显示。Settings 不再为读取信息调用可能初始化钱包的 overview；新读取入口只具备 read 能力，不写 Keychain、不迁移账本、不创建 WalletAccount。固定测试 keypair 的原密钥保留、重复/并发读取、零钱包、访问拒绝及损坏测试先失败再通过；认证/重放与原钱包回归共 7 个文件 / 78 项通过，原生投影、两地址复制、不可用状态、滚动和 Debug build 通过，typecheck、lint 通过。本步不宣称完整 WalletAccount 迁移或所有页面的全新安装零钱包规则已实现；现有非 Settings 初始化路径留待该阶段修改。本机安装与启动证据以本次实际交付为准；没有付款。

本步当前交付：旧 App 与后端正常退出；安装脚本 production build 与 macOS Release build 通过，更新 `/Users/irin/Applications/Yosh.app`。strict 签名校验及安装／构建逐文件一致检查通过，前端 `.next/static` 无新增钱包读取／签名实现或 Keychain 身份匹配。新版 App PID 93974 的运行路径为安装位置；23:44:15 本次生命周期日志确认后端 PID 93995 ready，仅监听 `127.0.0.1:3049`，未认证钱包查询实际返回 401。本机两个钱包的列表、公钥对照及钥匙串确认仍由用户在 Settings 验收，不把 fixture 测试当作真实私钥比对证据；未导出密钥、创建钱包或付款。

### 每日额度

- 用户自己填写，没有自动启用的默认消费额度；可以随时修改。
- 所有已连接 Agent 共用同一额度；前端展示后端计算的已消费、预占与剩余值。
- 未设置额度时不开启付款；额度为 0 时阻止普通新付款。暂停状态不能被超额批准绕过。
- 修改即时影响后续付款，不清零当天消费。调低至已消费加预占金额以下时，阻止普通新付款。
- 以电脑本地时区的自然日为消费窗口，午夜开始新日统计；历史记录保留。
- 未完成或未知付款的预占不会因跨天而消失，也不能在结算时重复计入已消费和预占。
- 超过每日额度时，可仅额外批准当前一笔，不提高日额度、不扩大长期授权，仍记录实际消费。
- 时区切换、时钟回拨、夏令时与跨日结算的详细归属规则须在额度阶段明确并测试，不能通过重复“重置”获得额外额度。

### API 授权与确认（旧授权草案；Resource/Grant 语义由 v1 合同取代）

- 选项固定为“不允许、仅限一次、以后都允许”。
- “仅限一次”绑定当前购买和报价，只能消费一次。
- 旧草案曾允许当前 API 的长期授权跨 Agent 共用；现行 Spend Grant 必须绑定 Agent 身份和 Resource 身份。不得把 Agent A 的 Grant 自动视为 Agent B 的授权。用户授权证明仍须绑定具体范围，并与 MCP 客户端认证区分。
- 不能把当前 API 授权扩大到整个域名或供应商；API 身份至少区分来源、HTTP 方法与规范化接口标识，具体粒度在实现前记录。
- 涨价重新确认；收款方、网络、资产等关键条件变化不能静默沿用旧授权。
- 用户在 Codex 原对话确认。MCP 发来的 `approved: true`、模型复述或普通可回显令牌本身都不是用户授权证明。
- 必须验证宿主提供的确认机制是否能让后端可靠识别用户操作，并绑定购买、报价、连接和有效期。尚未验证前，不宣称原对话确认已实现。
- 若宿主不能提供必要保证，该阶段列为未完成，反馈具体限制；不自动改成 App 弹窗，也不让模型代替用户批准。
- “不允许”的拒绝记忆期限和可撤销行为在授权阶段细化，不将一次拒绝误写成永久规则。

### 运行、暂停与退出

- 用户手动启动 App；关闭窗口后本地服务继续运行，菜单栏可重新打开窗口。
- 暂停只阻止新付款；允许查询已提交交易和恢复已付款交付。
- 退出前停止接受新付款、保存进行中状态，然后结束服务；已经提交的链上交易不能撤回。
- 下次启动恢复检查原交易，不生成替代付款；保留用户此前的暂停状态。
- 启动、重复启动和 MCP 连接不应创建第二个独立钱包或付款服务。退出 App 后 MCP 不应自行重启付款服务。
- 首版不提供开机自动启动选项。

### 失败与交付

- 确定付款失败立即通知用户；付款未知与确定失败分开处理。
- 已付款但未交付时，使用原付款凭据自动重试 3–5 次，绝不为重取结果再次扣款。
- 重试次数、进度和原付款关联持久保存，进程重启不能重新获得无限重试次数。
- 外部 API 是否支持原凭据恢复需实际验证；不支持时明确记录交付异常，不承诺客户端单方面保证交付。
- 付款状态与交付状态分别展示；付款成功不等于购买完成。
- Codex 收到明确异常与缺失结果，继续完成不依赖该结果的部分；实际行为在 Codex 中验证。
- 首版不实现退款，交付失败也保留账本和原交易记录。

## 5. 接口约定方向（历史草案，接口实现需落实 v1 生命周期合同）

以下是职责草案，不是已经存在的接口路径或最终 SDK：

| 能力 | 使用方 | 后端行为 |
|---|---|---|
| 读取概览、钱包、记录、设置 | App | 返回安全且完整的展示数据，不暴露签名载荷 |
| 修改额度、暂停、连接和授权管理 | App | 认证管理权限并持久保存；资金相关判断在后端完成 |
| Discovery / 提议 Resource | Agent / App | 使用声明的方法和约束输入进行未付款 discovery；Agent 提议、用户审阅批准并持久注册 Resource |
| Quote / Spend Grant | App / 用户 | 用动态 Resource 的有效样例请求获取只读 quote；Grant 绑定 Agent、Resource、经济范围及期限 |
| 请求购买 | Agent | 提交 Resource ID、允许的请求输入、用途和稳定 request ID；后端创建不可变 Authorized Request Instance |
| 执行已授权购买 | 后端购买服务 | 原子预占并领取执行权，复核策略后签名付款 |
| 查询购买与结果 | App / Codex | 返回付款、交付和恢复状态；重复读取不付款 |

不要暴露通用 `signTransaction`、任意转账或允许调用方修改账本的工具。授权凭据不等于 HTTP 身份认证；两层都需要验证。

## 6. 历史实施顺序与验收（旧 M0–M7 排期，不是现行能力清单）

本表保留旧 M0–M7 排期和当时验收口径；与上方 Yosh v1 产品合同不一致之处以上方为准。它不能证明通用 Resource 生命周期、安装版 Agent 宿主或 Mainnet 购买已完成。新的 Resource Lifecycle Integration 必须按本页“通用资源生命周期验收合同”逐项实现与验收，并仅凭最新证据更新状态。

2026-10-05 Mainnet readiness P0：完整范围与首步边界见 [Payment Environment isolation](docs/architecture/mainnet-readiness/payment-environment-isolation.md)。确认最终依次覆盖环境、钱包/授权、账本/整数金额、通用 x402 资源、商家无关原交易恢复、付款/回执/交付分离、安全展示与完整验收；扩展现有流水线，核心不得按商家名称分支。本轮仅授权环境模型、配置一致性校验与相关回归；`live_mainnet` 结构合法仍禁止实际执行，其他步骤未开始，最终主网购买仍需具体授权。

2026-10-05 P0 第二步：用户另行授权仅实现 [Mainnet wallet and authority isolation](docs/architecture/mainnet-readiness/mainnet-wallet-authority-isolation.md)。保留 test Keychain，新增显式 Mainnet Keychain 身份并核对真实 signer；拒绝 Demo 来源、旧钱包身份和 test 授权/recipient defaults。现有授权存储尚未分区，因此 Mainnet 的 authority 为暂停、无额度、无 grant，暂不开放 App 或付款执行。账本 scope/bigint、商家、恢复和 UI 改造仍未开始。

2026-10-05 P0 第三步：用户另行授权仅实现 [ledger monetary scope + integer money](docs/architecture/mainnet-readiness/ledger-monetary-scope.md)。购买、每日预算窗口与 SpendGrant 承诺按环境、钱包身份、网络、mint/精度隔离；权威金额使用有界 bigint 和十进制 TEXT/JSON 字符串。006 迁移保留历史购买、预占、PAID、未知付款与原始证据；缺失来源的历史测试记录隔离并保守阻止绕过旧预占。Mainnet 仍暂停、无可用授权且禁止执行。商家、恢复重设计与 UI 改造仍未开始。

2026-10-06 P0 第四步：用户另行授权仅实现 [merchant-independent original-payment recovery](docs/architecture/mainnet-readiness/original-payment-recovery.md)。原签名 payload、买方签名/message identity、monetary scope、实际 memo、blockhash/lifetime 与首次发送状态持久绑定；商家不可用时由买方 RPC 核对精确原交易，confirmed/finalized 成功可记为 PAID，只有确定未提交或 finalized 失败才释放预占，查询缺失与异常继续保留未知付款。007 增量迁移不改写历史购买或证据，旧 signed payload 的发送状态保守未知；`recordedAt` 不伪装历史签名时间。缺失响应不触发第二次签名或替代付款，V3 buyer_rpc 证明与商家回执/交付保持独立。Mainnet 执行仍禁用；通用商家接入、交付重试重设计和 UI 改造未开始，验证与本机安装结果以本轮实际验收为准。

2026-10-06 P0 第五步：用户另行授权仅实现 [production x402 compatibility hardening](docs/architecture/mainnet-readiness/production-x402-compatibility.md)。在既有官方 SDK 和购买执行器中支持声明式外部 HTTPS 请求，绑定完整 URL、HTTP method、headers/body、生产 network/USDC/recipient 与完整 challenge；保留 extensions，取消客户端 `day4:` memo 要求，持久使用实际已签 memo，严格校验 settlement receipt。008 只新增新 HTTP-bound intents 的不可变约束，不改写历史记录。Mainnet 执行、可用授权及生产资源管理入口仍未开放；不新增商家适配器、付款栈、交付重试设计或 UI 改造，验证与本机安装结果以本轮实际验收为准。

2026-10-06 P0 第六步：用户另行授权仅实现 [durable delivery recovery](docs/architecture/mainnet-readiness/durable-delivery-recovery.md)。付款结果、回执结果和交付状态分开保存；仅在原付款确定 PAID 后原子领取交付执行权，最多四次恢复，次数/等待/claim 与终态跨重启保留。能力来自批准资源的声明，支持幂等原凭据重放、显式缓存重放和 payment identifier 查询；未声明能力则保留 PAID 并记录 UNSUPPORTED，不再购买。009 仅新增 side table 与约束，旧行和资金证据保留。后端自动检查到期交付，暂停不退回已消费额度，退出停止新重试并等待在途操作。Mainnet 执行及可用授权仍禁用；无 UI 改造或商家名称分支，验收以本轮实际结果为准。

2026-10-06 P0 第七步：用户另行授权仅实现 [conditional Mainnet execution](docs/architecture/mainnet-readiness/conditional-mainnet-execution.md)。共享后端执行器以显式生产开关、独立 Mainnet daily authority/SpendGrant、登记 HTTPS 资源、精确不可变绑定、原子 reserve/claim、专用 Keychain signer、Mainnet preflight 和 simulation 替换 blanket execution/authority 禁令。010 激活迁移隔离启用前的 Mainnet authority，不移动测试授权或资金记录。原交易对账及已付款交付恢复在关闭生产开关后仍可运行，不再次签名。内部登记资源服务在 fixture 中到达既有官方 SDK/签名边界；原生 App runtime 和测试资源入口仍是测试用途，生产管理入口/UI 未开放。本轮无真实主网付款、充值、Mainnet 钱包创建、商家付费调用或 UI 改造；最终验证与本机安装证据见本阶段文档。

2026-10-06 P0 第八步：用户另行授权仅实现 [guarded Mainnet product entry](docs/architecture/mainnet-readiness/mainnet-product-entry.md)。既有 Codex MCP purchase intent 经认证 Agent API/AppRuntime 到达同一登记资源、授权、原子预占与主网门禁执行器；原生 App 最小接线读取生产状态、配置主网日额度/暂停和具体登记 API 的 SpendGrant，保留原有 UI。主网默认禁用，测试入口拒绝主网，测试授权不能跨 scope；重放与重启恢复复用原付款及原端点。无真实主网付款、钱包创建、充值或 UI 改造；最终当前验证与本机安装证据见该文档。

| 阶段 | 优先级 | 任务 | 依赖 | 验收标准 |
|---|---|---|---|---|
| M0 | P0 | 盘点现有模块、账本及签名配置；确定 App 壳与本地服务启动方式 | 无 | 列出复用模块和差距；确认专用钱包公钥与签名器一致；历史记录可读取；不发起付款 |
| M1 | P0 | 建立简单 macOS 窗口、菜单栏与本地后端管理 API | M0 | 打开、关闭窗口、重新打开和退出可用；关闭窗口服务存活，退出停止服务；重复启动不产生第二个付款进程；未认证访问被拒绝 |
| M2 | P0 | 专用钱包、余额、额度设置、暂停与后台状态 | M1 | 钱包重启后不变；余额来自后端；用户自填额度并持久保存；未设置、零额度、暂停时阻止普通新付款；午夜与并发额度测试通过 |
| M3 | P0 | App 内临时测试购买入口，复用自建 Paid API 与 Devnet | M2 | 报价 → 后端策略 → 付款 → 结果 → 记录完整；签名匹配；原交易和余额变化有证据；重复点击、查询、重启不重复扣款 |
| M4 | P0 | Codex 桌面版 MCP 连接及原对话确认可行性验证 | M3 | App 展示真实连接状态；Codex 取得报价；后端能区分真实用户确认与 Agent 自行声明；撤销连接后请求失效。确认机制未通过时，不进入自动付款验收 |
| M5 | P0 | 三种 API 授权、涨价确认、单笔超额批准、异常交付恢复 | M4 | 正常、拒绝、一次性、长期授权、涨价、超额、暂停等路径在 Codex 实测；第二个认证连接验证授权共用及首次提醒；恢复 3–5 次不重复付款 |
| M6 | P0 | Solana 主网 USDC 与真实第三方 API 小额购买验证 | M5 | 网络、mint、收款方和报价严格校验；主网与测试网记录隔离；获得真实交易和交付证据；选定 API 原凭据恢复行为已核对 |
| M7 | P1 | 首版打包及整体验收 | M6 | 可安装启动；无需保留开发终端；管理、后台、退出恢复与 Codex 购买可用；文档明确限制，不伪装主网或交付成功 |

M3 的临时测试入口仅在测试环境启用，只调用同一购买服务，不绕过额度、暂停或签名校验，不内置任务执行界面。M4 的宿主能力文档可提前阅读，但不为赶进度跳过确认验证。

M6 前必须再次取得具体主网交易授权（API/收款方、用途、金额上限）；本计划不是主网付款或发布授权。代码按上方“代码提交与本地同步”约定自动提交、推送并同步，开发完成不自动部署或发布。

目前不冻结剩余工期：服务打包方式和 Codex 确认能力尚未验证，分别在 M7 和 M4 按实际宿主能力估算。

## 7. 关键验收场景

- 钱包：首次创建、重复启动、钥匙串拒绝访问、公钥与签名器不匹配。
- 接口：无认证、已撤销连接、跨站请求、App 与 MCP 的管理权限隔离。
- 报价：金额/资产/网络/收款方错误、过期、涨价、接口身份混淆。
- 额度：同时购买、实时调低、零额度、单笔额外批准、跨午夜、时区变化、未知付款预占。
- 授权：伪造批准、旧确认重放、批准另一份报价、一次性授权并发消费、跨 Agent 提醒。
- 生命周期：关闭窗口仍服务、暂停阻止新付款、退出与提交竞态、重启恢复且不重付。
- 交付：付款失败、提交后超时、已扣款响应丢失、交付格式错误、重试耗尽、API 不支持原凭据恢复。
- 展示：原凭据和密钥不进入前端；失败原因足够定位且脱敏；测试快照明确标记。

测试和代码要求见 [AGENTS.md](AGENTS.md)。

2026-10-06 Execution Details：本轮仅实现 Authority 的 Execution 详情导航、后端持久环境选择和准确模式标签。原生选择通过认证管理接口进入现有 PaymentEnvironment 配置；Mainnet 可选择但不创建钱包、额度或 SpendGrant、不恢复暂停、不授予生产标志。进行中或待恢复付款/预占阻止切换；付款内核不变，没有执行主网付款。当前实现与验证见 [Execution selection](docs/architecture/mainnet-readiness/execution-selection.md)。

2026-10-06 Mainnet Authority Surface：本轮仅更新现有 Authority 的 Available／Reserved／Paid、资产语义、独立 Daily Authority 状态、专用主网钱包只读详情、当前 Agent 的注册 API Grant 与具体阻止原因。展示金额由后端选定 monetary scope 的整数／bigint 账本生成；主网缺少钱包时不创建或回退测试钱包，不创建额度或解除暂停。付款内核、Latest Activity、交易与恢复页面不变；没有主网付款。修改和当前验证记录见 [Mainnet Authority Surface](docs/architecture/mainnet-readiness/mainnet-authority-surface.md)。

2026-10-06 UI semantics tightening：本轮仅调整原生文案与展示投影，统一 Mainnet／Devnet · Developer／Simulation，按保存的 environment + network 显示生产与 Test 资产；缺失或冲突来源不冒充生产资产。保留 Authority、Daily Authority、Spend Grant、Available、Reserved、Paid、Connection、Activity；Members 显示改为 Agents，内部标识不变。Allowed 与付款、交付分别表述；未知付款显示 Checking original payment 并解释 Reserved 继续保留，已付款交付恢复显示 Payment confirmed · retrieving result／result not recovered。Activity 命名、Spend Grant 操作文案、已知阻止原因、加载与未实现状态保持一致；保留原布局与资源图标，缩短 Activity 标题后维持完整原生按钮点击范围。未修改后端、付款行为或保存的模式，没有真实付款或 Computer Use。

本轮当前验证：原生展示、资产隔离、付款/交付状态、恢复边界、窄窗口、按钮、滚动、导航、连接与 Spend Grant 定向测试，以及成员/Mainnet 管理请求与认证管理接口 mock 冒烟均通过；一次批量页签滚动测试在并发构建时捕捉未完成动画，单独重跑通过，未改动画。typecheck、lint、Next production build、macOS Debug 与 Release build、diff 检查通过。更新 `/Users/irin/Applications/Yosh.app`，严格签名校验、安装与 Release 构建逐文件一致、图标 hash 保持一致。启动 App PID 84784 路径为安装位置；用户正常解锁后，本次生命周期日志确认后端 PID 84844 ready，并监听 `127.0.0.1:3049`。本轮未提交/推送：工作区存在大量前序 Mainnet 阶段未提交改动，且与本轮文件重叠、构成编译依赖；保留既有暂存和工作区，未将其混入语义修改提交。

2026-10-06 Activity 环境隔离修复：仅在原生展示层新增当前模式的 Activity 记录投影，按购买保存的 monetaryEnvironment + network 匹配 Mainnet／Devnet／Simulation；来源缺失或网络冲突不归入当前环境。Authority 下方摘要、Activity 列表与购买详情查找共用这一投影；所选 Agent 的原有所有权范围保留，账本历史不删除或改写，后台恢复与付款行为不变。先用混合环境记录复现 Mainnet 摘要误显示 Devnet 的失败，再验证模式隔离、无记录空状态、legacy test、所有付款状态及完整原账本保留；相关原生展示与点击测试、typecheck、lint、Debug、production build 和安装脚本 Release 构建通过。旧 App 正常退出并确认后端停止；已更新 `/Users/irin/Applications/Yosh.app`，签名与安装/构建逐文件一致。本次运行 App PID 86183，后端 PID 86190 ready，监听 `127.0.0.1:3049`。没有 Computer Use 或真实付款；既有重叠改动的提交/推送限制仍保留。

2026-10-06 统一提交与推送：用户明确要求把当前累计改动统一提交到 main，并拆成多个 Commit。此前“重叠”指同一工作区文件同时含前序 Mainnet 接入与后续 UI/Activity 修改，并非已提交 Commit 冲突；该范围现已获统一提交授权。按文档整理、后端 Mainnet 与恢复能力、原生 Mainnet 接入、UI 语义、Activity 环境隔离及验证记录拆为六个签名提交。通过已加载的系统 SSH agent 使用原配置签名密钥，未关闭签名或改写 Git 配置；按阶段快照组织暂存区并核对工作文件指纹，源码内容完整保留。提交前最新 backend 回归为 56 个文件 / 694 项通过，typecheck、lint、diff 和待提交文件敏感信息扫描通过；本轮原生 Activity 隔离与点击回归、Debug/Release 构建及安装就绪证据见上两条记录。此次仅整理提交与文档，不改变已安装代码，不发起付款或部署。远端 main 在提交前已 fetch 并与原基准一致；最终推送与本地/远端提交编号以本次交付回复为准。

2026-10-07 Mainnet wallet identity/readiness 定向修复：专用 Mainnet Keychain keypair 派生的公钥成为 AppRuntime 身份来源，环境公钥仅作可选匹配断言。Settings、overview、成员 Authority、MCP 和余额查询复用运行时身份；MCP 余额结果同步 readiness，RPC 失败不改变钱包可用性，零余额单独分类。付款配置使用已验证运行时买方，实际 signer 加载重新核对专用 Keychain 身份和 Devnet 隔离，不创建／替换钱包。新增 fixture 回归覆盖断言缺失／匹配／不匹配、余额失败／零／有资金、损坏／缺失／复制测试 signer、身份替换及首次成员读取；原全套 59 文件／708 项通过，最终成员入口补齐后相关 42 项及成员管理／快照 12 项通过，typecheck、lint、backend production build、原生 Debug／Release build 和安装签名／产物比对通过。更新同一安装版并正常重启；安装后实际 MCP／余额结果以本轮验收回复为准。本轮无 UI 改造、实际交易或 Computer Use。

## 2026-10-07：持久运行时 Registered API registry

- 按用户本轮明确授权实施：内置只读目录 + SQLite 用户注册数据，管理 API 的 list/add/inspect/disable/remove，以及非付款 x402 discovery。旧安装资源只导入一次，资源 ID 和历史记录保留，移除使用 tombstone；不把实时 payTo/fee payer 固化到新增资源策略。
- Settings 新增最小 Registered APIs 管理入口；Authority selector 读取同一后端 registry，管理写入立即通知刷新，外部运行时注册最多三秒内自动进入列表。
- 管理认证、Spend Grant 和 Mainnet 授权保持严格。Agent 无注册工具/管理权限；签名 guard 额外检查当前资源状态，覆盖准备期间禁用的竞态。付款内核文件与本轮开始时逐文件哈希一致。
- 最终全套 62 文件 / 744 测试通过；typecheck、lint、backend build、native Debug/Release 与 native 模型/transport CLI 测试通过。已通过现有脚本更新同一安装位置一次；14 条历史购买和原付款证据指纹在安装后保持一致。安装后通过已认证管理 API 实际注册 runtime-verification-20261007，立即进入同一后端 Registered API selector 数据源，期间无第二次构建/安装，二进制哈希不变；SQLite 重新打开仍可读取相同记录。完整 AppRuntime 重启持久性已由自动化测试覆盖，演示后未额外重启安装版。
- 范围、迁移、接口、实际验证与限制见 [runtime registry](docs/architecture/resources/runtime-registry.md)。已识别旧付款绑定对部分 600 秒 challenge 的兼容限制；本轮按“不改付款内核”要求保留，不宣称 Mainnet 付款已验收。
- 未付款、未自动创建 Grant、未启用 Mainnet 执行、未解除 Payments 暂停；未使用 Computer Use、未提交或推送。

- 安装版实际只读查询：Mainnet 钱包可用、余额 0.01 USDC；Payments paused、执行 disabled、Daily Authority/remaining 0.01 USDC、Grant null、paid/reserved 0。真实非付款 You.com discovery 返回 5000 atomic USDC，paymentSent=false。运行时注册后全安装 14 条历史购买指纹和零原付款记录不变；未授权注册请求实际返回 401。真实 desktop MCP 仍 Transport closed，连接 disabled/disconnected；未自动启用连接，未将 fixture 验收记作实际宿主通过。

## 2026-10-08：Agent → Purchase Resource Lifecycle

按 [生命周期实现与验证](docs/architecture/resources/agent-purchase-lifecycle.md) 完成通用资源定义、MCP 只读 GET/JSON POST 发现、样例报价、原生注册与 Spend Grant 输入、同 Agent 多资源 Grant、统一外部目标保护和分块交付读取。合成未知 JSON POST 商家无需修改或重建 Yosh，即从发现进入经授权的 `APPROVED` 购买资格；未签名、未提交交易。完整自动化 67 文件 / 772 项、typecheck、lint、后端 build、原生 Release build 通过。安装版只读验收以本轮最终回复为准；Mainnet 实际购买仍需单独授权。


2026-10-08 四项 RC blocker 定向修复：后端注册、外部报价及生产执行分别拒绝不支持的 HTTP 方法；新增资源字段 descriptor 约束并复用同一请求构造/重验合同，历史数组策略保持原语义。探索性 POST 在发送前通过现有原生管理通道确认具体 URL、方法、headers/body；Agent 不能提供批准证据。POST Grant 单独确认样例及资源委托范围，增量迁移 `014_post_grant_consent` 仅增加 nullable 策略指纹，不给旧 Grant 自动补授权。统一 HTTPS 访问采用保守 IANA 地址表，保留 DNS pinning、禁止重定向及大小/超时限制。资源 HTTP body 为 16 KiB UTF-8，相关本地 JSON envelope 为 128 KiB，其它管理接口仍 8 KiB。定向 150 项、全套 74 文件 / 930 项、typecheck、lint、production/native Release build 及原生确认/transport 测试通过；当前安装验收另行记录。具体约束见 [生命周期修复记录](docs/architecture/resources/agent-purchase-lifecycle.md#four-blocker-remediation-2026-10-08)。本轮不执行真实主网签名、提交、付款，不自动登记资源/创建 Grant；冻结决定留给下一次独立只读审计。

本轮安装证据：已正常退出旧版并确认 loopback listener 停止；现有脚本更新同一安装位置，strict deep 签名及安装/Release 逐文件比对通过。新版 App PID 70730 从安装路径运行；14 条购买、10 个 Grant、3 个资源、原配置/连接及其它账本表的旧列摘要保持一致。当前 macOS 钥匙串 App Lock 确认与原 PIN 解锁等待用户完成，后端尚未监听；不把原生进程存活当作后台 ready。安装版新门禁/MCP、重启后钱包身份及增量迁移实际就绪验收待解锁后补核对，当前测试证据与实际运行限制分开报告。

2026-10-08 解锁后安装版补验收：用户完成系统确认及解锁后，App PID 71143、后端 PID 71151 均从安装 bundle 运行，后端 cwd 为 bundle 内 Runtime/backend，仅监听 `127.0.0.1:3049`；生命周期记录管理认证、coreReady 和 walletAvailable。签名和安装/Release 比对仍通过；原生 Authority 加载完成，显示 Connected、Mainnet 和 Grant expired。当前桌面 MCP 及使用安装版 MCP 的新真实 Codex app-server 宿主均读取到原主网钱包身份和就绪服务，过期 Grant 保持拒绝付款资格。新宿主未确认 POST 返回 `RESOURCE_POST_APPROVAL_REQUIRED`，伪造批准字段被 schema 拒绝；无认证管理请求返回 401。实际数据库已应用 `014_post_grant_consent`，旧 10 个 Grant 无自动 POST 授权；购买、Grant、事件、资源、成员、monetary 旧列及配置/连接摘要与安装前一致。上条解锁等待现已解除。未创建资源/Grant，未签名、提交或付款；安装版正向 POST 确认发送及实际商家购买未执行，不将隔离测试作为该项运行证据。冻结决定仍留给独立只读审计。

## 2026-10-08：Agent-driven MCP Resource Registration

用户明确授权替代此前“仅返回提案、由用户手工登记”的流程。新增 `register_x402_resource`：只接受当前 Agent 成功发现后端保存的 `discoveryId` 和资源身份标签；不接受端点、付款或权限覆盖。共享 Registry 原子消费凭据并持久保存不可变定义、Agent 来源、样例及文档/未确认事项。原生 Registered APIs / Authority selector 自动刷新，Grant 样例自动填入；注册不创建任何消费授权。新增 `015_agent_resource_registration` 仅追加发现/来源元数据表，保留原注册、Grant、账本与原付款证据。现有 POST 副作用确认、SSRF、SDK、签名和付款/恢复架构不变。

当前验证：77 文件 / 940 测试、typecheck、lint、production build、原生 Debug/Release 及 Grant/确认/样例模型测试通过。已正常退出旧版并通过现有脚本更新 `/Users/irin/Applications/Yosh.app`；strict deep 签名与安装/Release 逐文件一致。用户解锁后，App PID 77413、后端 PID 77426 从安装 bundle 运行，2026-10-08 21:43:30 后端 ready，仅监听 loopback。新真实 Codex app-server 宿主通过已安装 MCP 成功发现并注册 `agent402-crypto-price`，原生列表与 Authority selector 已显示 Agent-submitted、正确端点、0.001 USDC 和预填样例。该资源 Grant 缺失；实际 MCP 购买返回 `DENIED / SPEND_GRANT_REQUIRED / NOT_STARTED`，没有交易、签名 payload 或付款证据。旧 14 条购买、10 个 Grant、原付款、钱包 scope、配置及旧资源指纹保持；新增一条拒绝验收记录（非付款），Grant 数量仍为 10。无真实签名/付款、创建 Grant、设置修改、提交或推送。当前已连接宿主可能需要重连刷新工具列表；新工具已经由新的真实宿主验收。详细范围、证据及未验证的付费交付/恢复限制见 [MCP registration](docs/architecture/resources/agent-mcp-registration.md)。


## 2026-10-08：首笔真实 Mainnet 购买与冻结后归档

用户在真实 Codex 对话中明确授权一次 Agent402 BTC、ETH、SOL USD 数据购买，上限 0.001 USDC，使用既有 Spend Grant，并要求任何阻碍或未知付款即停止。实际 MCP 返回 PAID / CONFIRMED / COMPLETE；只读账本确认相同交易签名、原付款 CONFIRMED 和交付重试次数 0。交易签名、购买 ID、状态字段的准确区别和结果见 [首笔主网验收](docs/demo/first-mainnet-purchase-20261008.md)。这只是该笔 GET 的验收，不证明商家恢复、真实 POST 购买或其它资源能力。

冻结提交 `e7ef99e8029509355f105edd8013606a05934aaf` 之后的已完成工作按通用 Agent MCP 注册、Spend Grant/连接生命周期修正、原生接线及回归、真实 Mainnet 验收文档拆分签名提交。Grant 创建、替换和撤销不再轮换 MCP 连接凭据；显式断开/轮换仍使旧凭据失效，购买仍逐笔检查 Grant。归档验证为 77 文件 / 941 项测试、typecheck、lint、production build、原生资源模型测试、安装签名及已有 Release 产物比对通过。公共 RPC 独立查询网络失败，未新增链上确认主张。此归档任务不改产品代码，不重装/重启，不登记资源、不创建 Grant、不付款；付款、Authority 与购买/恢复核心目录和冻结提交一致。Git 推送及桌面同步结果以本次完成回复为准；到同步为止，不进入 UI polish。
