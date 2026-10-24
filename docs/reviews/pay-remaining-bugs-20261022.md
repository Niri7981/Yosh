# Yosh × Pay MCP：剩余问题与修复记录

日期：2026-10-22（Asia/Shanghai）。独立 worktree：`pay-remaining-bugs/yosh`，基于 `afeb2dd` 加已有 correctness 未提交补丁。不修改原工作区或两个 correctness worktree，不提交、不安装、不启停现有 App、不真实付款。遵循用户补充范围，不改 `Niri7981/pay-kit` 的 `codex/x402-exact-unsigned-builder` 分支、#393 API 或提交历史，不 Push；本轮三项修复均不需要 pay-kit 变更。

## 修复前的问题分类

| 项目 | 分类 | 本轮处理 |
|---|---|---|
| Allow 后未执行的外部授权占用预算 | 已有核心 Bug 修复 | 沿用 permit lease / startup recovery，回归，不重复开发 |
| 合法大交付被 64 KiB 限制拒绝 | 已有核心 Bug 修复 | 沿用 Yosh + Pay 修复，回归，不重复开发 |
| F04：raw transaction 漏检、通用 delivery 绕过反射过滤 | 真实 Bug | 当前基线重新红测后最小修复 |
| F05：Pay 已选报价，Yosh 再要求同链同币候选唯一 | 真实 Bug | 当前基线重新红测后修复选中项验证 |
| R03（新发现）：HTTP delivery 与 MCP cursor 仍限制 1 MiB | 真实 Bug | 当前基线红测；统一序列化边界 |
| F06：重发原 operation 需要新 challenge 完全一致 | 窄恢复合同 / 未完成恢复入口 | 保留经济绑定；独立查询与商家离线透明恢复未完成 |
| F01：kit 无 blockhash、Tokio current-thread panic | 通用 SDK Bug / 上游发布项 | 当前 Yosh 提供 lifetime；不重复开发 SDK |
| F03：Rust 新公开字段影响旧 struct literal | 上游源码兼容 / 发布限制 | 不改公共 SDK API |
| F07：归档与后续 upstream 安全基线、隐藏 RPC 假设不同 | 上游整合 / 发布限制 | 不升级或 rebase；按锁定版本验证 |
| F02：旧进程持已有签名仍可出网 | 生产切换限制 | DB fencing 不撤销签名；必须 stopped cutover，不能宣称安全热升级 |
| F08：旧文档、bootstrap 依赖历史本机布局 | 文档/复现限制 | 记录实际验证输入与边界 |
| 受控 profile 的 POST、required payment identifier、其它网络/币种/flow | 未完成或有意不支持的功能 | 不扩展本轮范围 |
| 正式 App 安装、完整 Mainnet/恢复及 GUI 验收 | 生产交付限制 | 用户禁止本轮安装；历史单笔付款不替代当前验收 |

来源：`docs/reviews/phase2-yosh-pay-pay-kit-20261021.md` 及当前源码。新增发现、复现与验证结果在下文补充。

## 本轮已修复的实际 Bug

### F04：交付凭据反射遗漏及查询旁路（P2）

- 修复前复现：真实 Pay MCP + Yosh fixture 的商家反射 buyer signature 后，Pay 拒绝响应，但 Ledger 已为 `PAID / COMPLETE`；同一 Agent 的通用 delivery 返回 200。历史交付注入 raw transaction/完整付款头，也能通过通用查询或 Pay replay 读取。两条新增回归先失败，日志为 `build.noindex/reflection-before.log`。
- 最小修复：将直接已知凭据检查集中到 Ledger 的交付完成及结果读取边界；检查完整结果后才允许 chunk。覆盖 raw transaction、付款头、payload 及 buyer signature 的既有编码。Pay 出口复用同一结果检查。
- 结果：新反射内容不能变为 COMPLETE，也不落入交付 data；付款事实仍为 PAID，使用既有有限交付重试，不重签或重新付款。历史已保存的反射内容留在原账本，查询时隐藏，跨重启仍拒绝交付；没有删库或改写原付款证据。
- 验证：拒绝完成、通用 GET、跨 chunk、重启及 Pay replay 均通过，每个完整购买 fixture 只签名/携款请求一次。旧测试把反射内容标记 COMPLETE 的断言已同步改为 PAID/PENDING。
- 限定：这是直接已知凭据的检查；不能证明恶意商家以任意编码、拆分或其它隐蔽方式传递的信息被绝对隔离。付款证明也不等同私钥。

### F05：重复选择报价拒绝合法 alternatives（P2）

- 修复前复现：真实 Pay 已选 offer；同链同 mint 的第二个 offer 仅价格或 extra/memo 不同，就在 Yosh 授权前触发 `INVALID_X402_QUOTE`。两条真实 MCP 回归先失败，完全重复 selected offer 的拒绝对照通过；见 `build.noindex/selected-offer-before.log`。
- 最小修复：将 Pay 已选的 immutable requirement 传入授权及后续绑定检查；选中项必须在完整原 envelope 中精确匹配且仅出现一次。继续校验价格、recipient、network、mint、flow、Grant、原请求及原付款绑定；保存全部 alternatives。
- 验证：价格/metadata alternatives、选择第二个 offer 的验证器用例、重启后 replay 均通过。选中项缺失、完全重复、不支持 network，以及修改后的原 operation 继续拒绝。真实 MCP fixture 只签名和付款请求一次。
- 限定：没有为没有显式选择的旧调用方新增报价策略；原有歧义继续拒绝，也没有扩展受控 profile。

### R03：合法转义文本无法通过通用 delivery 完整读取（P2，新发现）

- 修复前复现：已有大交付修复允许 262144 字节文本，但 262144 个 NUL 经 `JSON.stringify` 后为 1572866 字节；通用 HTTP delivery 首块即返回 404。单独检查官方 MCP 握手/工具调用还发现 cursor 超过 1048576 被 schema 拒绝。两处分别先红测，见 `build.noindex/generic-delivery-before.log`、`build.noindex/mcp-cursor-before.log`。
- 最小修复：把已有 Pay 上限提取为共享的 `MAX_SERIALIZED_RESOURCE_DELIVERY_BYTES`（1572866），供 Pay response、HTTP delivery 大小/游标和 MCP input schema 共用；每块仍为 16384 字节。
- 验证：重启后首块、1 MiB 位置、末尾及 EOF 逐字节匹配；MCP 接受 1 MiB 以后的合法游标，拒绝负数及超出上限的游标；未认证请求仍为 401；签名及携款请求各一次。
- 限定：最大文本用例在正常购买后写入隔离库的历史交付 fixture，用于验证持久读取边界；不声称本轮真实外部商家发送了该文本。本项补齐既有大交付修复遗漏的出口，不重做之前的核心修复。

## 仍未完成或仍有发布限制的项目

| 项目 | 当前结论 / 剩余工作 |
|---|---|
| F06：原 operation 查询依赖新 challenge | 当前窄 replay 合同的可用性限制仍存在。商家旋转 metadata、memo/alternatives 或 probe 离线时，普通 Pay curl 不能透明取回原结果。需另行设计独立、认证且只读/仅恢复原付款的入口；不能通过接受新价格或放松绑定修复。本轮 changed-terms 拒绝、原证据不变、无第二次签名的回归继续通过 |
| 未接入的协议能力 | 受控 profile 仍为 GET + `Accept: application/json` + 原生 USDC + supported exact flow；JSON POST/required client-generated identifier/SIWX 等未接入，其它网络、资产、flow 不受支持。Pay 一般能力不能自动算成 Yosh 已支持 |
| F01：通用 SDK 的 current-thread panic | 已知的真实 SDK Bug 仍未修，触发于无 blockhash 的路径。当前 Yosh Mainnet 提供固定 lifetime；本轮没有扩展到未调用的 SDK 分支，也未重新运行旧审查的 panic 探针。修通用 SDK/上游发布时必须处理 |
| F02：持旧签名的 legacy warm process | 新 DB 拒写不能撤销旧签名。现有反例测试本轮通过，含义是仍能观察到 legacy 携款 HTTP；不能解释为漏洞已修。生产切换必须先安全停止全部旧 credential holders，不支持以 fencing 宣称热切换安全 |
| F03 / F07：上游兼容与安全基线 | 10/21 固定审查指出公开 Rust struct literal 兼容破坏、归档与后续 upstream 安全基线差异，以及升级后 omitted decimals 的 RPC 假设。属于上游重拆/发布门槛。本轮不 rebase/升级，不声称重新核实了远端最新状态 |
| F08：可复现环境和旧文档 | 当前完整 Pay 回归依赖预备 Rust binary、匹配 sibling Pay、历史兼容源码及本机缓存；不是任意机器 clean bootstrap。历史文档的 receipt 解释、BLOCKED/已安装状态需按日期理解，不能外推到当前版本 |
| 正式安装与资金验收 | 本轮依用户指示不安装、不启停 App、不真实付款。尚不能证明这些修复已出现在用户点击的 Yosh.app，或通过完整 Mainnet/Pause/退出/GUI/资金恢复验收。历史成功不作为本次证据 |

在本轮检查与已运行回归覆盖的受控路径中，确认的三个剩余本地 Bug 已修；不把未接入功能或上述发布门槛写成已经完成，也不据此宣称不存在其它 Bug。

## 本次验证与成果保留

- 工作基线：Yosh `afeb2ddcea1da6b334bd8fc7183d5d3fa8fb1434`，叠加 `/Users/irin/.codex/worktrees/pay-correctness/yosh` 原有未提交补丁。Pay 使用 `/Users/irin/.codex/worktrees/pay-correctness/pay` 已准备的受控 MCP binary，未重写其源码或重新开发两项核心修复。
- 两项已有核心修复继续回归：Allow 后真实 SIGKILL/租约到期释放未签名预占、保持 Unknown 原凭据，以及 64 KiB 邻界至 policy max/最坏 JSON 转义的大交付。原补丁保存在新 worktree 父目录 `prior-correctness.patch`。
- 所有付款测试只使用隔离 fixture 和 loopback 假 RPC/商家，OS sandbox 禁止外网、真实 Keychain、生产配置/数据访问和正式 App 写入；没有测试付款被当成实际链上证据。
- 官方 MCP 真实 stdio Pay 路径、原交易/Unknown 恢复、Pause 竞态、并发幂等及实际 SIGKILL 均在 `test:pay` 中运行。真实 Codex CLI 的 3 项配置/握手/身份隔离测试通过；它们不证明完整 Codex → Pay → Mainnet 付款验收。
- 最终 `npm run test:pay`：99 个测试文件通过，1199 项通过、1 项 live Mainnet preflight 按默认 opt-in 条件跳过；随后原生安装器 Node 测试 3 项通过（测试临时安装配置，不安装正式 App）。见 `build.noindex/test-pay.log`。
- 最终 `npm run typecheck`、`npm run lint`、`npm run build`、`git diff --check` 均通过。初次 build 因依赖符号链接指向项目外被 Turbopack 拒绝；仅在新 worktree 克隆依赖为独立目录后重跑通过，没有修改原依赖目录。
- build 保留一项既有动态文件路径 tracing warning（`pay-mainnet-control.ts:64`，本轮未改此文件），不写成零警告。当前 standalone 1614 个文件的路径检查未包含 `.env*`、数据库、`.data`、`build.noindex`、`.git` 或被排除的项目源码目录；10 个前端 JavaScript 文件未匹配检查的 signer/私钥配置/Keychain 标识。此有限检查不替代正式打包验收。
- 实际增量 diff 已以 `HEAD + prior-correctness.patch` 为基线逐文件核对：18 个文件（13 个 Yosh 源码、4 个测试/fixture、1 份报告），无 Pay Rust、pay-kit、依赖锁、App、UI 或其它功能修改。`../remaining-bugs-only.patch` 仅包含本轮增量，在该基线上 `git apply --check` 通过；不是已提交或已应用到其它工作区的变更。
- 原工作区与两个 correctness worktree 的 1844 个 tracked/非忽略 untracked 文件（507 + 598 + 739）内容 SHA-256、文件集合及各自 HEAD 最终均与开工快照一致。结果见 `../preservation-verification.json`；本轮未提交、推送、覆盖这些成果，未改正式 App。
