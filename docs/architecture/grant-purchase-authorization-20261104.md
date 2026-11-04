# Spend Grant 与购买授权修复（2026-11-04）

## 问题与当前行为

实际宿主读取到有效的新 Grant、足够的 Daily Authority 和可用钱包；只读报价成功，Pay MCP curl 却在执行前拒绝。安装版的 `/pay/authorize` 仍强制读取固定路径 `pay-mainnet-acceptance.json`。该历史 CLI 验收凭据绑定旧 operation，且已经过期。App 的 Create Grant 只更新 SQLite 中的 Spend Grant，不会、也不应把新 Grant 写成某个旧 operation 的验收凭据。readiness 不检查该额外门禁，MCP wrapper 又将拒绝替换为笼统的“缺少确认/授权”。

本次用户明确要求修复正常购买流程。新购买由共享购买服务选择当前 Agent、Resource 和 monetary scope 的有效 Grant，在原子预占中持久绑定 Grant ID/version；不再把历史 CLI 验收文件作为产品购买授权条件。过期、缺失或不匹配的旧验收文件既不能阻挡有效 Grant，也不能给无效 Grant 增加权限。历史 CLI 读写工具和旧凭据不删除、不迁移成新的消费权。

## 约束

- 不是给每笔旧购买自动换绑最新 Grant。旧购买仍绑定原 Grant ID/version、operation、不可变请求和报价；原 Grant 被替换、撤销或过期后，在签名前拒绝。新 Grant 不能复活旧购买。
- 生产执行显式开关、Mainnet admission、专用 signer 身份、注册资源、报价/交易绑定、Pause、共享日额度与 Grant 额度、原子预占、执行 permit、幂等及原付款恢复保持不变。
- 移除 adapter 的 authorize/prepare/recover/takeUnsigned 和 executor 的重复 CLI receipt 检查；共享 `requestPaidResourcePurchase`、`ledger.claim/assertCanSign` 与生产签名 guard 继续负责权威判断。不改官方 SDK 或 Pay 协议。
- 不新增数据迁移，不改现有钱包、Keychain、Grant、Ledger、Pause 或生产 BLOCKED 配置。

## 当前验证

- 先通过 AppRuntime Create Grant 入口建立新 Grant，分别在旧 CLI receipt 缺失和过期时复现 `RejectBeforeExecution`，然后验证修复使相同测试通过。
- Mainnet-profile 集成测试使用临时数据库、临时生成的测试 signer 与模拟 RPC/商家。覆盖新购买绑定最新 Grant ID/version、无 CLI receipt 到达一次模拟签名、未知付款继续保留预占、无效 Grant/Pause/不足额度拒绝、Keychain 加载期间替换 Grant 不签名且不换绑、并发额度竞争、重放和重启原付款恢复。20 项通过。
- 默认 Vitest：109 个文件 / 1190 项通过；typecheck、lint 通过。另有依赖准备的 Pay suites 不属于默认测试集，不将其计入以上数字。
- 去掉恢复用例中不再需要的旧 receipt 后，Mainnet 集成及旧凭据独立工具回归共 38 项通过；typecheck、lint 再核对通过。
- `npm run build`、现有 `scripts/build-yosh-pay-dev.sh` 的 native Release 构建、Dev 包 strict deep 签名校验通过。Dev 后端文件与构建 manifest 的 SHA-256 相同，后端产物不再包含旧 acceptance validator。前端 `.next/static` 的定向扫描未发现签名实现、Keychain identity 或旧验收文件引用。
- 首次 production build 因工作树外依赖软链接被 Turbopack 拒绝；改为本地 APFS 依赖副本后同一命令通过。构建保留既有 dynamic filesystem tracing warning，未关闭检查或扩大打包范围。
- 标准 `test-dev-environment-lifecycle.sh` 使用的 13449 端口被当前运行安装版占用，报告 portConflict。没有停止它或绕过端口保护。随后使用现有 `LiveDevnetPackagedLifecycle.swift`、临时测试端口与 disposable HOME，在禁止外网和真实 Keychain/资金配置访问的 sandbox 内验证同一 Dev 包的 Devnet → Simulation → Devnet：管理认证、旧凭据拒绝、隔离存储、三个后端世代安全退出均通过。测试没有 provision 钱包或请求购买；这不代表真实 Devnet 或 Mainnet 付款验收。
- 未安装/替换正式 Yosh.app，未切换现有桌面 MCP 指向，未重试真实主网购买、未签发新的逐笔验收凭据、未提交/推送。当前真实 Codex 宿主仍指向旧安装版，不能把隔离验证记为其修复已生效。Dev 包沿用构建脚本既有身份，实际用户数据曾被安装版使用；本次仅以 disposable HOME 启动测试，不直接打开它接触现有 Mainnet 状态。正式更新仍等待用户 Dev 验收。

## 后续明确授权的正式安装（2026-11-04）

用户随后明确要求“把正式版 APP 应用修复，然后重新启动”，本节记录该次授权后的实际交付，覆盖上一节当时的待安装状态；不新增付款授权。

- 为保留现有原生 UI 与通知补丁，从既有通知后端源码重建安装基线，除 esbuild 依赖路径标签外与安装版后端逐字一致。只在这个基线上应用 adapter 与 Mainnet executor 两个文件的同等修复；没有把整个 Live Devnet 功能后端替换进正式版。补丁与实际 source hashes 存在本机安装 staging 的来源记录中。
- 这份正式基线的授权/生产入口相关回归 61 项通过，typecheck、lint、production build 通过。默认回归首轮 1155 项通过、1 项因归档工程仍为 rc.5 build 6 而 package 已为 stable build 7 失败；把测试工程的 release metadata 和 release-contract 用例同步到现有 Stable 版本后，该文件 2 项通过。未关闭或忽略失败检查。
- 原安装校验器只允许 `paymentCoreUnchanged=true` 的冻结 promotion；本次没有伪称付款核心不变。为显式的 `product-spend-grant-v1` 修复增加受限来源校验：仅接受上述两个源文件、匹配冻结源 hash/通知后端基线 hash 和实际新后端 hash，完整 bundle tree 校验继续执行。先观察新来源记录被拒绝，再修复校验器；22 项 release packaging 回归通过。
- 保留安装版其余内容，更新后端和来源 manifest，重新签名。bundle 差异仅为后端、manifest、主可执行文件签名和 CodeResources；对主可执行文件的临时副本去签名后，安装前后字节完全相同。Pay binaries、图标、身份、数据位置和现有 UI 保留。
- 通过现有正常退出 helper 退出旧 App，确认监听停止，保留旧安装副本，再经 `scripts/install-macos-app.sh --stable-app` 安装到同一 `/Users/irin/Applications/Yosh.app`。安装产物与 staging tree 完全一致，strict deep 签名通过。
- 重新打开后 App PID 31913、backend PID 31924 均来自上述安装 bundle；管理通道认证响应确认 `ready=true`、`coreReady=true`。实际 Codex MCP 再查询：Grant v3 ACTIVE，余额 0.10 USDC，Payments 未暂停，日剩余 0.001 USDC，paid/reserved/unresolved 均为零，readiness 无阻挡、eligible=true。启动后的第一次余额查询暂时不可读，随后第二次恢复并确认上述结果；未改 RPC 配置或付款策略。
- 安装前后 purchases、spend_grants、original_payments、monetary_controls、monetary_scopes 的完整表指纹一致；没有创建/替换 Grant，没有改变钱包、Pause 或生产执行设置，没有新付款、提交、推送。新后端产物不再包含旧 acceptance validator；真实付费请求由用户后续自行验收。
- 项目 `AGENTS.md` 同步明确产品使用/Demo 快捷路径：状态、Grant、报价、发现和购买走 MCP，不读计划/源码/开发 Skill；源码排查或修改才读相关工程文档。该规则不扩大任何付款权限。
