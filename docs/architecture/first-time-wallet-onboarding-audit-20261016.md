# First-Time Wallet Onboarding：只读审计与实施方案

日期：2026-10-16（Asia/Shanghai）

代码基线：`f65c9bd30a2cad65493d2e70b15624be26e216ed`

状态：供用户审阅；所有新增能力、接口与阶段均为提案，不是实现或操作授权。

后续决定：用户已接受四项产品决策，仅授权 Stage 0 / Stage 1。审计时点事实保留如下；本轮实现、签名阻碍、隔离测试及未实施范围见 [Stage 0 / Stage 1 交付记录](wallet-onboarding-stage0-1.md)。Stage 2 尚未授权。

结论：可以在现有支付系统外侧增加首次钱包配置，不需要重写已验证的 Solana Mainnet / x402 执行核心。必须先补齐零钱包状态、永久身份绑定、用户确认、备份和中断恢复。建议本期只开放**首次 Mainnet Create / Import 与同身份恢复**，不开放已有钱包替换、删除或切换。

最需要防止的错误是：把 Keychain 访问失败当成缺钱包、把固定 Keychain 槽位当成实际公钥、用户备份 A 却采用竞争者 B、以及把客户端认证当成用户同意。

## 1. 审计范围与证据等级

本轮阅读根 `plan.md`、项目 UI 规范、原生 App 规范、钱包/Keychain、运行时、授权/账本、管理认证、原生 Settings 与相关测试；交叉审阅三个边界：密钥生命周期、资金身份、Native/API 权限。

本轮实际执行：

- 读取当前安装产物的签名元数据：`/Users/irin/Applications/Yosh.app`，bundle ID 为 `com.twentyfortynine.macos`，`Signature=adhoc`，无 TeamIdentifier。
- 对两个已知钱包项进行只读 ACL 元数据查询：一次性诊断进程禁用 Keychain UI，只请求 item reference，读取 ACL、authorization tags 与 trusted application metadata。**没有请求 password data，没有导出、签名或修改 ACL。** 两项均得到 5 条 ACL；decrypt/export/sign 等授权项的 trusted application 为 `/usr/bin/security`，partition 项包含 `apple-tool:`。这说明访问路径受信任的是公共工具，不能解释为 Yosh App 独占访问。没有测试其它进程实际能否读出密钥。
- 运行现有 9 个定向测试文件，148 项通过，见第 10 节。全部是测试密钥、模拟依赖、内存或临时账本。

没有读取真实钱包私钥、助记词、`.env`、私有产品配置内容或真实 Ledger 数据；没有创建、替换钱包，没有付款，没有启动/退出/重装 App，没有 Commit/Push。既有未跟踪架构文档与图片保持原样。

源码事实、上述现场元数据与本轮测试结果分别标明；历史 Mainnet 付款和历史安装验收不作为本轮运行证据。未逐项盘点用户所有旧 Keychain 项，本期实施前仍须按 `plan.md` 的既有身份保护要求完成受控识别。

## 2. 当前架构与调用链

### 2.1 创建和加载

产品钱包持久化为 Keychain **generic-password**，值是 base58 编码的 64 字节 Solana keypair：前 32 字节是 Ed25519 seed，后 32 字节是对应公钥。

- Devnet/Test：service `com.2049.wallet.v1`，account `consumer-wallet-v1`。
- Mainnet：service `com.yosh.wallet.mainnet.v1`，account `consumer-wallet-mainnet-v1`。
- Simulation 与 Devnet 共用 test 钱包；Mainnet 使用独立项，并拒绝与 test 钱包相同的地址。Solana 密钥本身没有网络标记，这种隔离是 Yosh 的产品策略。

现有创建逻辑：

```text
initializeEnvironmentWallet(explicit environment)
  → 检查原项与 Mainnet/Test 隔离
  → randomBytes(32)
  → @solana/kit createKeyPairSignerFromPrivateKeyBytes
  → seed || publicKey → base58
  → security -i，经 stdin create-only 写入
  → 回读、SDK 校验、公钥比对
```

安全随机源与 SDK 可以复用。`initializeEnvironmentWallet()` 只有定义及测试调用，尚无产品 Create API。已有项复用，只有 item-not-found（CLI exit 44）表示不存在；拒绝、损坏、超时不应生成替代项。依据：[product-wallet.ts:45](../../src/modules/app-wallet/product-wallet.ts#L45)、[product-wallet.ts:106](../../src/modules/app-wallet/product-wallet.ts#L106)、[keychain.ts:34](../../src/modules/payment/keychain.ts#L34)。

当前 Mainnet 状态读取：

```text
Settings / Authority / status
  → AppRuntime 公共钱包库存
  → readExistingProductWallets
  → 读取原 Keychain 项 → SDK 验证 → 仅保留公钥/状态
```

真正签名独立读取，不信任 UI/状态缓存：

```text
Agent purchase request
  → 后端 Resource / Quote / Spend Grant / Daily Authority
  → Ledger 原子 reserve 与 claim
  → executeApprovedPayment：不可变购买绑定、生产门禁、暂停检查
  → loadBuyerSigner(expected buyer, immutable environment)
  → loadEnvironmentWalletSigner：读取原 Keychain、重验实际地址及网络
  → prepareSolanaPayment / 官方 @x402/svm：交易绑定、simulation、guarded signer
  → 保存原 payload / evidence → submission marker → 原付款请求
  → 原交易对账与交付恢复
```

依据：[wallet.ts:7](../../src/modules/payment/wallet.ts#L7)、[approved-payment.ts:135](../../src/modules/purchases/approved-payment.ts#L135)、[solana-payment.ts:54](../../src/modules/payment/solana-payment.ts#L54)。恢复使用原付款证据，不为取回交付重新签名扣款。

### 2.2 Keychain 的真实保护边界

钱包由 Node 后端启动 `/usr/bin/security find-generic-password … -w`，明文经 stdout 管道进入 Node，再构造 SDK signer。它不是 Secure Enclave 钱包，也不是在 Keychain 内部完成 Ed25519 签名。

已具备：秘密经 stdin 写入，不进入 argv；不使用 `-A`、`-U` 或主动放宽 ACL；丢弃原始 stderr；30 秒访问超时；通用响应不含密钥；导入 SDK 的 private CryptoKey 默认不可导出。依据：[keychain.ts:15](../../src/modules/payment/keychain.ts#L15)、[product-wallet.ts:32](../../src/modules/app-wallet/product-wallet.ts#L32)。

限制：

- 钱包创建代码没有设置 App 专属 ACL、`SecAccessControl.userPresence`、钱包项的 ThisDeviceOnly 或明确 accessibility class。不能把原生**管理 token** 的 `AfterFirstUnlockThisDeviceOnly` 属性套用给钱包。
- 本轮当前 ACL 元数据也确认两钱包项信任公共 `security` 工具；不能声称只能 Yosh 读取。是否弹系统提示还受锁定状态及系统授权决定，本轮不尝试读取秘密来验证。
- `Uint8Array.fill(0)` 只清理可变数组；base58 字符串、JSON、stdout 累积字符串及 SDK 内部复制不能保证确定性擦除。
- SDK key 不可导出，不改变原 generic-password 仍保存完整可恢复材料这一事实。
- 安装脚本支持 `YOSH_CODESIGN_IDENTITY`，默认仍为 `-`；本轮安装版也确为 ad hoc。稳定 Developer ID 签名与受控授权仍是普通用户分发的门槛，不能为消除提示放宽旧 ACL。依据：[install-macos-app.sh:115](../../scripts/install-macos-app.sh#L115)、[product-startup-runtime.md:77](product-startup-runtime.md#L77)。

Apple 明确区分文件 Keychain 的 `SecAccess` ACL 与 Data Protection Keychain 的 access groups / `SecAccessControl`；`security` 主要面向前者。新保护方案必须明确选择实现，不能直接搬用 iOS 属性并假定生效。[Apple TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)

### 2.3 环境、Ledger、Daily Authority 和 Spend Grant

`PaymentEnvironment` 校验 mode、cluster、genesis hash、RPC、CAIP network、原生 USDC mint、精度及生产开关；Mainnet 不接纳 DEMO 私钥、文件或旧买方配置 fallback。依据：[payment-environment.ts:54](../../src/modules/payment/payment-environment.ts#L54)、[wallet.ts:20](../../src/modules/payment/wallet.ts#L20)。

`MonetaryScope` 由 environment、walletIdentity、network、assetId、assetDecimals 构成。预算、预占、支出与 Grant 按 scope 隔离；Grant 另绑定 Agent/CardMember、Resource、provider、recipient、scheme、期限与额度。金额使用整数字符串/bigint；交易与 scope 受不可变约束保护。

**关键缺口：当前 walletIdentity 是固定 Keychain service/account，不是实际公钥。** Mainnet `scope()` 与 `paymentScope()` 都使用固定 `PRODUCT_MAINNET_WALLET_ID`。运行时只在当前进程 pin 公钥；重启后重新建立 pin。因此“往同一项写入另一把 key”将复用旧 scope，存在将旧 Daily Authority / Grant 应用于新钱包的设计风险。目前没有产品替换入口，本轮没有进行或验证这种替换。

依据：[monetary-scope.ts:5](../../src/modules/purchases/monetary-scope.ts#L5)、[purchase-ledger.ts:153](../../src/modules/purchases/purchase-ledger.ts#L153)、[purchase-ledger.ts:345](../../src/modules/purchases/purchase-ledger.ts#L345)、[app-runtime.ts:252](../../src/modules/app/app-runtime.ts#L252)。

已有购买的执行绑定包含 buyer，原付款 evidence 保存 payer；新买方不匹配会被拒绝或使恢复冻结。这不能代替新购买授权的永久钱包绑定，也不能以切换钱包解决未知付款。

### 2.4 Native UI、管理 API 与 MCP

```text
CardSettingsBody → CardSettingsView → OverviewClient → ManagementTransport
  → HMAC GET /api/app/wallets → AppRuntime.existingWallets → 公钥库存

Codex MCP → Agent Bearer capability → Agent API
  → 受限查询 / Resource / request_purchase → 同一后端服务
```

Settings → WALLETS 现只展示 Mainnet / Devnet 和复制公钥，没有 Create / Import / Backup。依据：[CardSettingsBody.swift:24](../../apps/macos/Yosh/YoshApp/Views/Card/CardSettingsBody.swift#L24)、[wallets route:6](../../src/app/api/app/wallets/route.ts#L6)。

管理请求验证 method/path、30 秒时间窗、随机 nonce、body hash 与 HMAC；响应也有 HMAC，禁缓存；loopback / Host / 跨站限制是额外边界。Agent 只有受限 capability，不持有管理凭据。依据：[management-auth.ts:20](../../src/modules/app/management-auth.ts#L20)、[connection.ts:9](../../src/modules/mcp/connection.ts#L9)、[server.ts:38](../../src/modules/mcp/server.ts#L38)。

App PIN 只控制原生页面；后端不以 PIN 解锁作为付款或钱包操作授权。HMAC 证明客户端身份与消息完整性，也不是用户刚刚确认的证明。依据：[YoshAppLock.swift:4](../../apps/macos/Yosh/YoshApp/Models/YoshAppLock.swift#L4)。

### 2.5 为什么仍需开发者协助

缺少的是产品级 provisioning、备份、确认及错误恢复入口，不是 Solana SDK 不能生成 key。

- 既有 Mainnet 钱包已可以从 Keychain 派生地址。`YOSH_MAINNET_WALLET_PUBLIC_KEY` 当前只是**可选一致性断言**，不必由普通用户设置。
- 主网 explicit initializer 未接 App；旧 `wallet-setup.ts` 只用于测试环境，明确拒绝 Mainnet，不能改成产品导入脚本复用。
- 安装版已带 Node/后端，私有产品配置默认仅关闭生产执行，无须依赖开发者 `.env`。
- Overview 已避免自动创建；但 test balance / quote 等路径仍可进入自动生成 initializer。全部只读入口零钱包规则尚未完整落实。
- 底层库存能区分 missing/unavailable，Mainnet 的 `readWallets()` 投影又将两者合并为 unavailable；onboarding 不能根据目前 UI 的失败文字决定可新建。

依据：[README.md:60](../../README.md#L60)、[mainnet-wallet-snapshot.test.ts:50](../../tests/unit/mainnet-wallet-snapshot.test.ts#L50)、[app-runtime.ts:234](../../src/modules/app/app-runtime.ts#L234)、[app-runtime.ts:548](../../src/modules/app/app-runtime.ts#L548)。

## 3. 复用、修改与新增范围

### 直接复用

- `@solana/kit` 的 Ed25519 keypair、签名器、公钥及 base58 编解码；锁定版本 5.5.1。64 字节 keypair 的 SDK 验证还会检查私钥与附带公钥是否匹配，不只接受长度正确。
- 现有 `WalletSecretStore` 边界、Mainnet/Test 隔离、create-only、回读比对与只缓存公钥的做法。
- `PaymentEnvironment`、readiness、余额、Daily Authority、Spend Grant 和 Resource 注册流程。
- 管理 HMAC、跨站限制、稳定错误映射、原生 transport 的响应验证、超时/大小限制。
- Settings 窄窗口、详情导航、系统输入/选择/确认控件、现有 App 生命周期及后台恢复。
- 官方 x402 `@x402/core` / `@x402/svm` 2.25.0、预算事务、幂等、reserve/claim、签名前门禁、提交标记、原交易与交付恢复。

### 局部修改

- `src/modules/app-wallet/product-wallet.ts`：分离纯校验、existing-only 查询与显式 provisioning，增加持久公钥 pin；禁止沿用“创建失败后接受任意有效竞争者”的 onboarding 行为。
- `src/modules/app/app-runtime.ts`：明确 provisioning 状态、零钱包只读路径、成功后缓存失效、pending setup 付款门禁、与 quit / execution change / recovery 的顺序。
- `payment/keychain.ts` 与 `payment/wallet.ts` 的**密钥读取适配边界**：保留 legacy 项及路径；如采用下述 native 安全边界，只为新账户选择明确的新 access adapter，不因失败自动 fallback。
- Ledger 仅增加钱包元数据及操作状态的显式迁移与读取接口；不改历史 scope、购买、金额、Grant 归属和原付款凭据。无需拆分或重写 `PurchaseLedger`。
- `/api/app/wallets`、原生 Settings presentation/client：保留公钥列表，增加安全状态和显式导航。
- Native runtime / child launch：增加受控钱包操作通道，安全敏感数据不得混入现有 stdout/stderr 诊断。

### 新增小型模块

- 后端 `wallet-onboarding` service：意图、解析、验证、确认、幂等、提交与中断恢复。
- `wallet-accounts` 元数据存储和迁移：永久公钥、Keychain 引用、legacy scope 映射及来源；不是多链/多钱包插件框架。旧 `scripts/wallet-accounts.ts` 实际是 Devnet token account setup，不是此能力。
- `wallet-import` 纯 codec；若选择助记词，再加入独立 mnemonic codec，精确锁定并审查最少依赖，不自行实现 BIP39/SLIP-0010。
- 原生 onboarding、受保护输入、备份展示/验证页面，以及下述 NativeWalletSecurity 边界。

明确不修改：`prepareSolanaPayment` 的协议/交易构造、官方 x402 scheme、原子预算算法、既有原付款对账与交付恢复语义。新增状态通过现有上游门禁接入，不在付款核心添加商家或 onboarding 分支。

## 4. 首期推荐产品范围与格式

### 推荐决策

针对普通用户，建议 **Create 默认生成新的 24 个英文恢复词；Import 支持 64-byte base58、Solana JSON keypair，以及明确范围的英文恢复词**。这比只提供长私钥更容易可靠地纸面备份，但需要新增经过审查的 mnemonic 派生能力；它不属于现有代码已完成的功能。

若优先减少首期范围，可先交付 base58 / JSON 导入与显式私钥备份，把助记词延期；该替代方案仍须完成备份验证和受控展示，不能仅把随机 key 写进 Keychain 就宣称用户具备恢复能力。此范围由用户审阅后决定。

### 精确格式合同

- **Base58 secret key**：解码恰为 64 字节 `seed || publicKey`；重算前 32 字节对应地址，并验证尾部公钥，不能只显示输入携带的地址。
- **Solana JSON keypair**：恰为 64 个 `0…255` 整数；接受粘贴或用户通过原生 Open Panel 选定的原文件。限制文件大小（建议 8 KiB），拒绝目录、特殊文件及不受控链接读取，不将内容复制到临时文件。
- **助记词（推荐范围，待确认）**：BIP39 英文 12/24 词，checksum 与 NFKD 校验；BIP39 seed → SLIP-0010 Ed25519 hardened derivation → Solana keypair。Create 固定 `m/44'/501'/0'/0'`、空 BIP39 passphrase、256-bit CSPRNG entropy；不能用用户自编句子。首期 Create 不提供额外 passphrase，避免词已备份但缺另一恢复条件。
- Import 默认路径族 `m/44'/501'/i'/0'`，可选兼容 `m/44'/501'/i'`，首期 `i=0…19`；派生在本地完成，不发送词、seed 或私钥到 RPC。允许零余额候选，不用余额推断“正确地址”。用户选择并确认完整地址；不匹配可返回重选格式/索引，不能静默选第一项。
- **仅 Import** 支持 BIP39 passphrase 作为独立高级安全输入，默认空；明确它不是 Yosh PIN 或 macOS 密码。不得 trim、替换或忽略非空 passphrase。每个 passphrase 都可能派生有效但不同地址，不能仅凭 checksum 判断其正确性。
- 首期不支持其它词数/语言、SLIP39、非 hardened legacy 路径、Solana CLI 的其它 seed 恢复约定、32-byte raw seed、hex/base64/PEM、硬件钱包或公钥 watch-only 导入。识别不了时明确提示，不猜格式。

标准依据：[BIP39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki)、[SLIP-0010](https://github.com/satoshilabs/slips/blob/master/slip-0010.md)。Phantom 文档列有多种 Solana 路径；上述是 Yosh 明示支持的子集，不承诺所有 Phantom/CLI 钱包通用恢复。[Phantom 路径](https://help.phantom.com/articles/12988493966227)

无论来源，最终交给现有签名器的仍是经过验证的同一种 Solana keypair。官方提供 byte/base58 恢复能力，可继续复用。[Solana 恢复文档](https://solana.com/developers/cookbook/wallets/restore-keypair)

## 5. 完整用户流程

### 5.1 首次入口与既有用户

App 正常完成 PIN 流程后，仅在后端确认 `absent_fresh` 时，展示“Set up your Mainnet wallet”与 `Create New Wallet` / `Import Existing Wallet`。可以稍后设置；Settings、Connection、帮助仍可用，付款由 readiness 拒绝。正常管理入口始终是 **Settings → WALLETS → Mainnet**。

既有用户自动采用原身份元数据并跳过首次引导，不因缺少新 metadata 重新生成。访问失败显示重试系统授权；旧钱包丢失显示 Restore Existing Wallet。Devnet 保持独立、明确标记 Test，本功能不顺便创建 Devnet 钱包。

后端 provisioning 状态至少区分：`checking`、`absent_fresh`、`existing`、`access_denied_or_locked`、`corrupt`、`identity_conflict`、`isolation_unverified`、`restore_required`、`setup_pending`。CLI 无法细分拒绝/锁定时诚实合并，不编造更精细原因。

`absent_fresh` 要同时满足原项确证不存在、没有既有账户身份，也没有需要归属原钱包的 Mainnet 配置/Grant/购买/预占/原付款记录。空的 schema/scope 初始化行本身不证明钱包曾存在；有疑义即阻断自动新建并明确原因。

### 5.2 Create New Wallet

1. 显示 Solana Mainnet、这是 Yosh 的独立钱包、谁持有恢复材料谁能控制资金；按钮明确为 Create，进入前不生成任何 key。
2. 用户发起后，通过原生安全操作确认建立一次性意图；后端生成唯一 operation ID。重复点击只返回同一操作。
3. 后端用 CSPRNG 生成 entropy，按选定标准得到候选地址。先持久记录不含秘密的操作，再在受保护 Keychain staging 中保存恢复材料；此时不启用消费、不向用户展示充值入口。
4. 用户明确选择 **Reveal Recovery Phrase**，完成系统认证后才显示。敏感页面默认隐藏，不自动复制、不生成 QR、不自动写文件。导航离开、失焦、锁屏、超时即隐藏；回到页面需要重新确认。
5. 推荐纸面/离线备份。隐藏原词后要求完整重新输入恢复词，后端按同一路径派生并核对同一地址；不能只勾选“已保存”。任何验证结果仅关联本 operation 和候选公钥。
6. 最终页显示完整地址、Solana Mainnet 与备份已验证事实，用户选择 **Use This Wallet**。只有此操作将候选提交为产品钱包。
7. 后端在独占协调区重查权限、永久身份、原项仍未配置及备份状态，以 create-only 写入固定 signer 项，回读 SDK 验证地址完全一致，再提交 WalletAccount/ready 元数据。竞争冲突明确返回 `WALLET_ALREADY_CONFIGURED`，绝不采用 B 并沿用 A 的备份确认。
8. 清理临时输入/候选引用、失效一次性票据与旧缓存。展示地址和充值说明，返回原有 Mainnet readiness 与 Authority 流程。

创建成功不自动充值、创建 ATA、付款、设置每日额度、创建 Grant、解除暂停、启用 Mainnet execution 或连接 Agent。用户在现有界面逐项完成；钱包就绪不等于消费已获授权。

### 5.3 Import Existing Wallet

1. 用户从同一入口选择 Import；明示格式，专用安全输入或原生文件选择。导入不调用生成新钱包函数。
2. 后端限长、严格解析并验证真实 keypair；如为词，明确 passphrase、路径与索引，得到有限候选列表。所有密码学处理在本地后端安全边界完成。
3. 检查与现有 Mainnet 身份、既有 test 身份及历史 pin 的关系。拒绝将现有 Devnet/Test 的同一 key 导入 Mainnet；test 项不可访问时隔离未证明，也不继续。
4. 展示实际派生的完整地址与 Mainnet，让用户与原钱包核对。可输入已知公钥用于精确匹配，但该输入不能替代真实派生；地址不一致时禁止继续。更改任何材料、passphrase、路径或候选，旧确认失效。
5. 用户通过系统认证并明确 **Import This Wallet**。后端消费绑定本地址、材料候选和旧状态的单次确认，create-only 保存，回读验证，提交账户元数据；不覆盖既有项。
6. 导入只持久化所选地址的 keypair，**不保留外部钱包整组助记词或 passphrase**，避免保管其它账户的根控制权。页面明确请保留原备份；需要时可单独备份所选地址的私钥。
7. 清理输入，刷新 readiness，回到余额/Authority。导入不自动恢复任何来自其它钱包或安装的 Grant。

若当前已有钱包，首次 Create/Import 不可作为替换入口。若是原项丢失，进入同身份恢复：导入结果必须与持久 pin / 可信原付款 payer 等依据完全一致，保留原授权与历史绑定；仍保持暂停，是否恢复执行由用户单独操作。没有可信原公钥时不能猜测或自动把任意新钱包接到旧 scope。

### 5.4 UI 与隐私

保留单一窄卡片、顶部 Agent selector 和底部导航；沿用 Settings 详情返回关系，不新增钱包 dashboard。状态与地址保持平面展示；使用原生 secure text input、文件选择、系统认证、键盘焦点及可访问性控件。

私钥/词不放入 AppOverview、普通 observable 全局状态、状态恢复、UserDefaults、analytics、剪贴板自动读取或通用错误。不默认把整组词暴露为 VoiceOver value；为需要辅助技术的用户提供经确认的安全阅读方式。禁止拼写检查、自动纠正、自动完成及输入学习；控制撤销历史。可以降低意外捕获，但不承诺绝对防截图、摄像、恶意软件或系统内存取证。

## 6. 密钥、备份和用户确认的安全方案

### 6.1 保留旧项；新项建立明确访问边界

旧 Mainnet/Test service/account、公钥及 keypair 保持原样；只增加元数据引用，不重命名、搬运、重签、轮换或改旧 ACL。不能为显示新备份词重新生成旧钱包；旧随机 seed 不能直接“转换成常规 BIP39 钱包”而同时承诺原地址不变。

推荐新建一个小型 **NativeWalletSecurity 后端组件**，使用 Apple Security API，负责新项 create-only、受控读取及备份认证。它是后端安全边界，SwiftUI 只做输入、展示及调用。引入原因是现有 CLI 无法表达应用专属的新钱包访问控制、受保护恢复材料及可靠的用户在场语义。

- 新 signer 项仍沿用既定 Mainnet service/account（仅在真正不存在时创建）；明确 ACL 仅信任稳定签名的受控 helper，禁止信任公共 `security` 工具及任意客户端。
- 签名器只在明确的账户 access adapter 中读取新项；legacy 项仍走原适配。helper 仅接受已配对的 Yosh 后端实例，校验调用身份及启动期私有通道；不能仅凭“同一用户”或“签名为 bundled Node”放行任意 Node 脚本。
- 不增加通用 export/sign-anything RPC。付款仍由原后端批准与原 SDK 执行；helper 不决定预算或 Grant。
- 新建恢复材料单独存为受保护 Keychain 项，由账户/operation 引用；采用 `SecItem` + 明确的 Data Protection Keychain、非同步、设备绑定及 `userPresence` 策略。此项不参与后台日常签名，因此不会把每笔 Agent 付款都变成用户认证弹窗。
- 文件 Keychain signer ACL 与 Data Protection recovery 项必须分别测试；跨域状态不能仅靠 service/account 推断。access backend 是持久账户属性，失败不自动降级为 legacy 读取。

实施第一阶段先用测试身份验证签名、entitlements、helper pairing 与系统认证可行性。若稳定签名/系统能力未就绪，允许完成自动化和受限开发验证，但不能将 ad hoc 或宽松 fallback 宣称为普通用户安全发行版。不得自动迁移现有钱包以掩盖此门槛。

### 6.2 确认与敏感传输

沿用 HMAC 管理 API 处理公共状态与 prepare/status；创建确认、导入确认、恢复材料展示由受信任 Native 边界执行系统认证，并经 Native↔后端私有 IPC 交付一次性批准。首选启动时配对的私有通道；是否采用 XPC 或受控继承通道在阶段 0 的小型验证后固定，不做通用 IPC 框架。

一次性批准至少绑定 operation ID、action、网络、候选公钥/材料版本、预期旧状态版本、backend session、nonce 与短有效期；后端原子消费。导入材料或路径变化需新确认；退出、后端重启、失焦取消等使未完成的 presence 票据失效。持久 operation ID 用于恢复同一操作，不能当作可重放的用户在场票据。

不能新增普通 JSON `approved:true`、`userPresent:true`；也不能把 HMAC、App PIN 或持有 operation ID 视为用户同意。helper/私有 IPC 拒绝 Agent Bearer、伪造父进程、未配对客户端和旧会话。

敏感材料只走专用、有限长、无缓存的本机通道，不经过 URL、普通 `/wallets` JSON、MCP、stdout/stderr 诊断或持久临时文件。HMAC 不加密内容，不能以“已有 HMAC”为由扩大通用响应范围。通道启动失败时停止本操作，不改走不受保护的端点。

### 6.3 备份与恢复材料生命周期

Create 的 recovery 项保存新 entropy 及所需版本信息，wordlist/path 等公开元数据可持久化；不得保存恢复词明文到 SQLite。选用的标准与恢复路径要随离线备份一起告知用户。重新显示仍需明确动作、系统认证及单次权限，默认不允许复制整词或私钥。

本期不默认提供自研加密文件格式、云端备份、邮件备份、QR、剪贴板导出。若决定以原始私钥替代词方案，可通过专用显示/验证完成离线备份；文件导出须另定成熟容器、加密与恢复合同，不能把明文 JSON 自动存入 Downloads 当安全备份。

Legacy 钱包与 raw-key 导入没有可恢复的原助记词；如开放备份，只能显示/导出真实对应私钥，并明确为该地址的完整控制权。不得声称能够恢复原外部钱包的词。导入根词默认仅在本次会话派生所选 key，随后丢弃。

Keychain 本身不是跨设备用户恢复承诺；清除系统、丢失 Mac 或设备绑定项不可用时，需要用户离线材料。新设备恢复资金身份不会恢复 Yosh 的历史 Ledger、Daily Authority、Spend Grant；新安装保持未设置额度、暂停、无 Grant。历史数据恢复是独立合同。

### 6.4 Agent 权限与威胁模型

产品 API 层：Agent 始终没有 create/import/replace/reveal/export/任意签名能力；不新增 MCP 钱包工具。对本机拥有任意 shell 权限的同用户进程，现有 legacy `security` ACL **不提供 Yosh 独占隔离的证据**。

推荐新钱包使用上述受控 helper，避免继续扩大公共工具读取面；不得声称这顺便修复了现有 legacy 项。是否另行授权对原钱包做**保持 service/account/keypair 不变的 ACL 加固**，必须单独决策与验证，不与 onboarding 自动捆绑。root、被攻陷的后端/系统及用户主动泄露材料不在本功能可保证的隔离范围内。

## 7. WalletAccount 与崩溃一致性

最小元数据：永久 `accountId`、`publicKey`、网络用途、`credentialRef`（含 Keychain domain/service/account/access backend）、`origin`、legacy monetary wallet identity 映射、可选 recovery reference、backup 状态与时间。网络/资产政策继续由 PaymentEnvironment 管，账户不是多链框架。主网与测试各只允许一个既有或已配置账户。

legacy adoption 只增加映射，依据原 Keychain 派生地址、已有 pin、可选配置断言、可验证原付款 payer 交叉检查。历史金额、scope ID、Grant、交易、payload、evidence 和 retry 进度一律不改。未签名历史可能只有 buyer-bound hash，无法反推出公钥；冲突或证据不足进入待处理状态。

操作状态建议：

```text
PREPARED（已记录操作，无秘密）
  → MATERIAL_STORED（受保护 staging 已存，尚不可消费）
  → REVIEWED / BACKUP_VERIFIED
  → COMMITTING（新的用户确认已消费）
  → READY（signer 回读与元数据匹配）
```

Import 同样使用操作标识，但省略随机生成；raw import 的 staging 仅保存所选 key，词导入不保存外部根词。错误/取消保留明确原因及待恢复状态。

SQLite 与 Keychain 无跨系统事务，必须通过 create-only、唯一约束与可恢复操作实现收敛：

- 先记录 operation；只有受保护 staging create-only 保存成功后才向 UI 发布候选地址或备份材料。同一已发布候选的 operation 重放只能恢复该候选。
- 在随机材料已生成但 staging 尚未保存时崩溃，内存材料不可恢复；标记为安全中断，需新的显式 Create。没有发布过的内存候选不能承诺跨崩溃仍然相同，也不能为了满足生成次数而把 entropy 落入普通文件。不得在已经显示/备份过候选后悄悄换 key。
- staging 保存后崩溃：重新认证并恢复同一材料，不生成第二把 key。
- 最终 signer 已保存但数据库提交失败：读回并与候选/pin 比对，再完成元数据；不删除该项或重新生成。
- 在写最终 signer 前，operation 必须已持久保存候选公钥、credentialRef（含 Keychain domain 与 access backend）。启动先解析未完成操作并选择相应 helper，再读取密钥；不能先用 legacy `security` 库存扫描去猜新项类型。对“新 adapter 已写入、WalletAccount 尚未提交”增加专门的重启用例。
- `COMMITTING` 结果不明：查询同一操作，不把超时当失败重做。
- pin 存在而 Keychain missing：`restore_required`，拒绝 Create；只允许相同公钥的恢复。
- 读取 denied/corrupt 或同 ref 出现另一公钥：冻结，不接受竞争赢家、不抹除原记录。
- 取消/退出不自动删除任何持久 key。未提交但已存的材料保持 `setup_pending` 并可继续；公开充值入口与新付款仍禁用。未入持久状态的内存材料尽量清理。

采用与创建均受 data-directory 单实例所有权、数据库唯一约束及运行时互斥保护；最终 activation 与新付款、recovery、execution change、正常退出有明确顺序。不要在等待系统认证时长期持有 SQLite 写事务。

## 8. 为什么本期不开放钱包切换

已有 scope 绑定固定槽，不能实现成“覆盖 key + 清缓存”。未来切换至少需要：

- 新钱包新 credentialRef 与永久 account identity；旧 key、旧 scope 和历史持续可访问。
- 新账户独立 Daily Authority（未设置、暂停）、空 Grant；任何旧批准不得跨账户，所有 Agent 仍共享当前账户的 Daily Authority。
- 买方身份贯穿 readiness、reserve、claim、sign 与恢复；切回旧账户不自动恢复生产执行或旧授权，需要明确规则。
- 进行中、已签名未定、PAYMENT_UNKNOWN、原交易/交付恢复及 reservation 阻止切换；未知款不释放、不改 payer。
- Activity/详情显示原钱包归属；目前摘要没有公开 walletIdentity，需要补投影，不能只按网络筛选。
- 相同 request ID 跨切换不能触发第二次扣款；现有 Agent request 幂等及历史查询规则要保持兼容。
- 多账户 recovery 按原 identity 路由，而不是从当前活动钱包推测。

这些会扩大 signer routing、授权 scope 与恢复上下文的范围，应作为单独功能审阅。本次通过“一个 Mainnet 身份 + 永久公钥 pin + 禁止替换”避免触碰已验证支付核心。

## 9. 分阶段实施与验收门槛

以下每阶段须单独实施、验证和审阅后再进入下一阶段；本文件不授权开始。

### 阶段 0：锁定合同与安全边界

确定第 11 节决策、支持格式、默认路径、备份合同、威胁模型。只用 fixture 验证 Native 安全通道、稳定签名/helper 身份、Keychain domain 和用户认证策略；确认新材料可恢复、旧项无需搬运。核对锁定 Kit/x402 版本与所需扩展，不升级或替换支付 SDK。

验收：有明确的 secret 数据流、操作许可绑定、无宽松 fallback；缺稳定签名时标记分发阻碍，不以改旧 ACL 或放宽信任解决。

### 阶段 1：先保护旧身份与零钱包

按 `plan.md` 先增加失败用例，再实现 WalletAccount adoption、永久 pin、显式 provisioning 状态、所有只读入口零生成。只改元数据和加载协调，不暴露 Create/Import。

验收：双 legacy fixture 的地址、完整私钥字节、service/account 全不变，generate/create/delete/overwrite/move 调用均为零；重复/并发/中断后映射确定且无重复；拒绝与损坏不代替生成；原 scope/记录/预占/recovery 逐项保持；真正空安装始终零账户零写入；lost wallet 不进入 Create。

### 阶段 2：创建/导入服务与安全提交

纯格式 codec、候选、operation 状态、受保护 staging、native access adapter、create-only commit、恢复与缓存失效；管理 handlers 保持薄层，Agent 无入口。助记词依赖与标准向量在此独立验证。

验收：畸形/过长/错地址/伪造公钥尾部/错误词 checksum/路径/passphrase、Mainnet-Test 同 key、无权 IPC、重放/换材料/过期确认、竞态、写失败和所有 crash 点均有确定行为；Import 的 generate 次数为零；重复 Create operation 仅一个候选；A 备份不可确认 B。

### 阶段 3：原生 Create / Import / Backup

Settings 正常入口和首次引导，完整地址确认、系统认证、受保护展示与恢复验证；保留现有窄卡片与导航。成功后进入既有 readiness / Authority，不捆绑自动支付配置。

验收：键盘/VoiceOver、取消、返回、锁屏、失焦、超时、重启继续；秘密不入日志、普通状态、剪贴板、URL、持久临时文件；缺钱包不影响 core health；成功后不受旧 30 秒失败缓存误导。主网钱包配好后额度/Grant/执行门禁仍独立。

### 阶段 4：回归与安装版交付

运行相关自动化、`npm run typecheck`、`npm run lint`、`npm run build`、macOS 构建与原生检查；检查前端 bundle 不含钱包/签名实现和敏感配置。

使用隔离 macOS 测试用户/测试 Keychain 验证全新安装与恢复，不占用或替换本机现有两钱包。升级验收先建立受控保存证据，正常退出旧版、等待安全停服，使用现有安装脚本更新 `/Users/irin/Applications/Yosh.app`，重开核对产物、实际路径、后端就绪。既有钱包一致性在受控后端比较，不输出私钥。系统确认由用户操作，不绕过、不强杀。

实际 Codex 宿主验证仅只读 status 与未授权管理操作拒绝；窗口关闭后台存活、暂停、退出、重启与 pending setup/recovery 顺序均需验收。钱包 onboarding 本身无需真实付款。若另做 Mainnet 付款回归，须另有具体 API、收款方、用途和金额上限授权。

## 10. 测试清单与本轮结果

未来新增重点清单：

- [ ] 两原钱包 adoption 的完整 identity 不变；空 legacy 与 metadata 混合、冲突、并发、重启。
- [ ] 启动、Overview、Authority、Balance、Settings、MCP status/connect、环境切换均零生成、零 Keychain 写入。
- [ ] 没有 Keychain 项但有旧 pin/Grant/history 的恢复保护；同 slot 换 key 跨重启仍拒绝。
- [ ] CSPRNG 失败即终止；标准测试向量；词/路径/passphrase → 地址的独立交叉验证；base58/JSON 同身份 round trip。
- [ ] 64 字节的前后公私钥不匹配拒绝；所有未知格式/词数/路径清晰拒绝；不泄露 parser/SDK 原错误。
- [ ] Create 双击/重放/并发不同意图；Import 不生成；同候选恢复；Keychain 保存/回读/SQLite 各 crash 点。
- [ ] 用户取消/过期/重放/材料变化/旧 backend session；伪造 HMAC 或仅 Agent token 全部拒绝；任意 Node 脚本/未配对 helper 客户端拒绝。
- [ ] 没有 Touch ID 时采用选定系统 fallback；系统锁定/访问拒绝不进入新建；不得自动放宽 ACL。
- [ ] fixture secret 不出现在请求 URL、通用 DTO、MCP、日志、异常、缓存、分析事件、临时文件与构建产物中。
- [ ] 备份隐藏/重验、退出重启、原文件导入不产生临时副本；不能只靠 checkbox 标记完成。
- [ ] 新账户默认未设置额度/暂停/无 Grant；旧 Daily Authority、Grant、购买及未知款不串用、不释放、不重签。
- [ ] 原有 signing/production gate、并发 reservation、幂等、原交易与交付恢复回归；fixture 与真实链证据分开。
- [ ] 原生窄窗口、键盘/可访问性、关闭窗口后台、正常退出重启、安装产物与真实宿主只读验收。

本轮已执行的 9 文件：`product-keychain`、`product-wallet`、`wallet`、`existing-wallets`、`wallets-management`、`mainnet-wallet-snapshot`、`mainnet-signing`、`payment-environment`、`monetary-ledger`，均为 `tests/unit/*.test.ts`。结果：**9 文件 / 148 项通过**。测试运行提示现有 Vitest config 的未来 loader 兼容警告；无失败，没有关闭检查来掩盖错误。

本轮没有新增实现，因此不运行安装构建、完整代码检查或真实支付验收；上述结果只证明现有测试边界，不证明本提案已实现。文档完成后检查引用与 diff。

## 11. 需要用户决策的架构问题

1. **本期范围**：建议仅首次 Mainnet Create / Import + 同身份恢复；保留现有两钱包，暂不开放 Replace / Delete / Switch。若要求本期切换，须另行扩大账户 scope 与恢复设计并重新审阅。
2. **备份/导入合同**：建议 Create 用 24 个英文 BIP39 词，Import 支持 64-byte base58/JSON 和明确的 12/24 词路径子集。是否接受新增经过审查的 mnemonic 依赖与兼容性测试，还是首期只支持私钥？两种方案都需可靠备份验证。
3. **安全边界与旧项权限**：建议新钱包使用稳定签名的受控 native helper，保留旧项访问方式。本期是否还要加固现有钱包 ACL？若要求对有终端权限的同用户 Agent 也保护现有私钥，需要单独授权保持原 key/service/account 的 ACL/读取边界改造；当前实现不能承诺这个级别。
4. **备份完成门槛**：建议新钱包完成完整恢复材料验证后才成为 READY 并出现充值入口；中途离开保留 pending setup，下次继续同一身份。是否接受这个产品门槛，以及默认不提供私钥/词复制、QR、云端或文件备份？

保留旧钱包、旧 Keychain 身份、原 Ledger、原付款恢复，以及 Agent 无钱包管理 API，是既定约束，不作为可取消的选项。本轮到此停留在审阅方案，等待用户指定获准实施的阶段。
