# Wallet Onboarding — Stage 0 / Stage 1 交付记录

日期：2026-10-16（Asia/Shanghai）。本轮仅授权 Stage 0、Stage 1；后续阶段等待审阅。

结果：**Stage 1 的源码与隔离测试已完成；Stage 0 平台能力预检已完成，但生产 Native helper / 新 Keychain adapter / 用户在场验收受稳定签名条件阻塞，已暂停。** 本轮没有把 helper 的不可用转换为公共 `security` 读取 fallback。

## 已确认的产品合同

用户已接受[审计与实施方案](first-time-wallet-onboarding-audit-20261016.md)，并明确：

- 首期只有首次 Mainnet Create / Import 和同身份恢复，无 Replace / Delete / Switch；既有钱包、授权与历史保持。
- Create 为 24 词 BIP39、空额外 passphrase、固定路径 `m/44'/501'/0'/0'`；Import 支持 64-byte base58、JSON 和方案明确的 12/24 词路径子集。标准向量及恢复同地址必须验证。
- 新钱包使用受控 Native 安全边界；旧钱包 ACL 加固独立授权。
- 新钱包验证恢复材料后才能 READY；已持久化的 pending operation 必须恢复同一候选。
- 后续 UI 使用 Settings → Wallets 二级页面和现有 Yosh 规范。本轮没有增加或重做 UI。

## Stage 0：已验证什么，哪里暂停

### 本轮现场只读签名检查

- 安装路径 `/Users/irin/Applications/Yosh.app`，identifier `com.twentyfortynine.macos`。
- 签名为 `adhoc`，没有 TeamIdentifier。
- 系统代码签名身份查询返回 **0 valid identities found**；没有读取、导出或创建证书私钥。
- 安装脚本支持显式 `YOSH_CODESIGN_IDENTITY`，默认仍为 `-`；本轮没有运行安装脚本或修改签名设置。

ad hoc 指定要求依赖当前构建，无法用本机现有条件证明稳定发布身份及跨版本 helper 信任。Apple 的代码签名要求文档说明了这种身份约束：[TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)。因此暂停生产 helper、受保护 adapter、新 Keychain 项写入与真实系统认证测试；不签临时“可信”证书，不放宽 ACL，不变更旧项。

### 隔离能力探针

`bash tests/native/wallet-security-feasibility.sh` 编译并运行临时 Swift 探针，结果：

- `SecAccessControlCreateWithFlags` 的设备绑定 / userPresence 策略对象可以在内存构造。
- `LAContext.canEvaluatePolicy(.deviceOwnerAuthentication)` 非交互预检返回 true。
- Code Requirement 可解析；SDK 提供 `NSXPCConnection.setCodeSigningRequirement`（macOS 13+）。测试对象没有 resume，也没有启动/连接 XPC 服务。

这些仅证明 API 可用。**未验证**：受保护 Keychain item 的持久化/回读、userPresence 成功/取消/失效、真实调用者身份和 audit token、未授权客户端拒绝、后端实例配对、跨构建/跨升级访问控制。`canEvaluatePolicy` 不是认证；探针退出成功也不能作为真实授权验收。

未创建测试 Keychain 或测试 item：签名门槛发现后已按要求暂停相关实施。当前隔离测试使用内存 secret store 和临时 Ledger；没有访问真实钱包秘密、修改真实 Keychain 或 ACL。

### Stage 2 必须固定的安全设计

- XPC 采用官方接口，双向校验各自指定代码要求；还必须验证实际入站调用者和启动会话配对。只配置一个 outgoing requirement 不足以完成此边界。
- 验证 bundled Node 的签名不够：同一可执行文件能运行其它脚本。必须验证由 Yosh 启动、配对的后端实例，而不是接受任意使用相同解释器的进程。
- 新 signer access adapter 与 legacy access adapter 必须由持久 credentialRef 明确选择；访问失败不可降级。新 signer 文件 Keychain ACL 与 recovery 的 Data Protection Keychain 分别测试，不假定二者具有相同策略。
- Native 系统确认经可信通道交付 action-bound、短时、一次性许可，绑定 operation、candidate、网络、材料版本、旧状态与 backend session。HMAC、PIN、`approved:true` 均不可替代用户在场。
- 不向 Agent 暴露任何钱包管理、密钥导出或任意签名 RPC。秘密不进入公共 DTO、URL、日志、诊断 stdout/stderr 或持久临时文件。

API 和访问模型依据：[Apple TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)、[userPresence](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/userpresence)、[deviceOwnerAuthentication](https://developer.apple.com/documentation/localauthentication/lapolicy/deviceownerauthentication)。新保护组件仍未完成实现或真实环境验收。

## Stage 1：实际修改

### 永久公钥绑定与 legacy adoption

新增 `WalletAccounts`，由现有 `PurchaseLedger` 持有；显式迁移 `017_wallet_account_identity` 仅创建 `wallet_accounts` 元数据表、不可变更新/删除约束和迁移标记。

记录永久 account ID、公钥、网络用途、原 monetary wallet identity，以及原 Keychain domain/service/account/access backend。当前只接受 legacy 元数据，不提供创建/导入/删除/切换/READY promotion 或 pending-operation 写入口，不伪装已经完成 Stage 2。

采用前校验实际读取得到的公钥、既有 pin、可选配置公钥断言、另一环境身份和可验证的历史 payer。原付款 evidence 复用现有完整绑定校验；只有历史 payer 字段但证据损坏时拒绝采用，不能跳过验证。已经采用后，同一 Keychain 位置出现不同公钥，在后端重启后仍拒绝。

Mainnet/Test 继续引用原位置和 keypair；不更改旧 ACL、不读取或搬运私钥到新位置。legacy monetary scope ID 不改，原 Daily Authority / Grant / reservation / purchase / payload / evidence / retry 记录不改。读取已有钱包可增加上述元数据，但不创建钱包密钥。

### 钱包状态

公共库存保持旧 `status` 字段兼容，增加 `provisioningState` 和可选 account ID：

- `absent_fresh`：确证缺失，且无 pin、配置身份断言或具有资金/授权含义的历史关系。
- `restore_required`：项缺失，但已有身份、额度、Grant 或购买等关系；不能当首次缺失。
- `existing`：原地址校验通过，legacy pin 已采用；这不宣称已有恢复词或已完成新钱包备份。
- `corrupt`、`access_denied_or_locked`：格式/公私钥无效与系统访问失败分开；CLI 无法进一步区分拒绝和锁定时不编造原因。
- `identity_conflict`、`isolation_unverified`：公钥不一致，或 Mainnet/Test 隔离无法证明。兼容 `status` 投影为 unavailable，地址为空，避免旧客户端将冲突当可用。
- 类型包含后续所需 `checking` / `setup_pending`，本期没有新钱包 pending operation 或 READY 实现。

空 scope/default budget clock、Mainnet 的 null-limit + paused 控制本身不证明以前存在钱包；不会仅凭这些默认行阻止真正的新安装。历史 Grant 即使已撤销也构成需要保护的关系。

### 运行时接线与零钱包

运行时库存统一经过上述验证；`initializeWallet()` 的默认分支仅加载既有钱包，不再调用测试钱包自动生成函数。启动、Overview、Authority、Balance、Settings、quote、MCP status/connect、环境切换在空 fixture 下保持零账户、零 key 生成/写入；缺钱包的余额返回 unavailable，不发起 RPC。

实际付款仍使用原 expected buyer 加载 signer、再次校验密钥；没有修改官方 x402 交易构造、`prepareSolanaPayment`、付款签名执行、原子预占/claim 或原付款恢复核心。

成功公钥库存保留现有缓存行为；签名仍即时验证实际 key。后续 Stage 2 提交成功必须主动清除成功与失败缓存，本期没有提交入口。

### 测试隔离

Vitest setup 增加保护，阻断当前 legacy adapter 直接调用真实 `/usr/bin/security`，并将意外尝试变成测试失败。修正遗漏 `readWallets` 注入的两个旧夹具；其调用被阻断，未实际读取系统钥匙串。

该保护不是系统沙箱，不覆盖任意 shell 间接命令、fork 或原生 Security API。测试密钥均在内存 fixture，Ledger 位于临时目录；Native 探针不执行 Keychain API 读写。没有以这个 guard 证明生产 helper 的系统级隔离。

## 验证证据

先记录失败，再修复：

1. 空钱包余额读取原来进入自动生成函数，并尝试调用 create；隔离 mock 阻止写入，失败用例复现。改为 existing-only 后通过。
2. Mainnet 同槽换 key 后重启原来接受新地址；持久 pin 接线后拒绝，通过。
3. Mainnet missing 原来被投影成 unavailable，无法识别真正首次缺失；显式状态后通过。
4. adoption 测试在缺少 `walletAccounts` 时失败；增量实现后通过。损坏的历史 payer evidence 曾被跳过，追加失败用例后改为验证后采用。
5. Keychain 编码损坏原来与访问失败混为同一错误；新增固定脱敏错误码后通过。

本轮最终已通过：

- **`npm test`：83 文件 / 1019 项通过**，包括 12 项新增 adoption 与 5 项 runtime 身份/零钱包测试。
- `npm run typecheck`、`npm run lint`。
- `npm run build`：Next production build 成功，包含构建内 TypeScript 检查。
- `bash tests/native/backend-launch-configuration.sh`：原生 launch/config/隔离数据/认证 health 与现有 Grant transport 检查通过；无 App 启动或安装操作。
- Stage 0 临时 Native API 能力探针，边界如上。
- Adoption 的重复、独立数据库连接并发、重启、同槽换 key、缺失/损坏/拒绝/冲突与原付款 payer 关联。
- 双 legacy fixture 公钥与完整 secret 字符串保持一致；钱包创建调用为零。这里比较的是固定测试材料，不是本机真实私钥比较。
- 混合金融/恢复 fixture 的 monetary scopes、controls、grants、purchase payload、payment evidence、original payments/signatures、delivery/reconciliation retry 表快照前后相同。
- 原有 Mainnet 执行门禁、签名、额度、幂等、未知款与交付恢复回归均包含在全套测试中。

前端静态构建未包含新增钱包存储/签名标记；文档链接与 diff whitespace 检查通过。不把历史安装记录当成本轮结果。首次全套测试发现的夹具不一致和隔离保护兼容问题已修正，最终全套通过；没有忽略失败或关闭检查。保留现有 Vitest config 的未来 loader 兼容警告。

## 保留限制与 Stage 2 前置条件

1. **稳定签名未就绪，相关实现暂停。** 需要可用 Apple 签名身份，以及实际 App / helper / bundled backend 的受控签名与配对验证；不通过临时宽松信任绕过。公开发行还需完成相应 notarization 与冷启动/升级验收。
2. 只有平台 API 预检；真实安全通道、新 Keychain adapter、用户认证成功/取消/超时及未授权进程拒绝均未验收。先在隔离 macOS 用户或独立测试 Keychain / 测试身份中完成，不操作当前真实旧项。
3. 本期未增加 BIP39/SLIP-0010 依赖或 Create/Import。Stage 2 必须锁定最少、经过审查的标准库，验证 BIP39/SLIP-0010 向量、12/24 词/两路径族/passphrase/索引，以及 Yosh 24 词按固定路径恢复同一地址。不得以原始 seed 重新编码为词而改变原钱包身份。
4. 首次 adoption 可以用当前实际 Keychain signer 作为 legacy 事实，并交叉检查已有证据；若首次 pin 前仅有预算、Grant 或未签名 buyer-bound hash，无法倒推历史公钥。因此不能声称能检测发生在首次 pin 前且无可验证 payer 的换 key。冲突不覆盖、不猜测、不改历史。
5. Stage 2 才实现持久 operation、受保护 staging、备份验证和安全提交。staging 保存后必须恢复同候选；保存前不发布地址/词，内存丢失不能宣称可恢复；不得通过普通临时文件保存 entropy。
6. 本机真实数据库没有运行新迁移；本轮仅在临时 Ledger 验证。App 安装版保持原状，未重装、重启或验证新代码运行。以后安装验收须另按届时授权完成。

本轮没有创建、导入、替换或删除真实钱包，没有真实付款，没有修改旧 ACL，没有重建/迁移真实 Ledger，没有 Commit/Push。Stage 2 等待用户审阅与授权。
