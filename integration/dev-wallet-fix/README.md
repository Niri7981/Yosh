# Mainnet Create Wallet 修复（2026-10-20）

## 实际故障与最小复现
用户切换同一 Yosh Pay Dev 至 Mainnet 后，Create Wallet 返回泛化的本地服务错误。真实签名管理查询确认 AppRuntime 正常、Mainnet 钱包为 `absent_fresh`，未成功创建钱包。

在实际打包的 Mainnet sandbox 内，只执行 `security default-keychain` 的只读元数据探测：Dev 私有 HOME 返回退出码 1 且无路径；OS 账户 HOME 返回 0 且有路径。仅记录退出码与是否有结果，未记录钥匙串路径或读取正式钱包条目。见 `read-only-diagnosis.json`、`sandbox-metadata-probe.json`。

现有测试未模拟 native launcher 的私有 HOME。补齐这个边界后，真实 AppRuntime 的认证 Create Wallet 测试在修复前返回 500 而非 201（`reproduction-red.log`）。另一个拒绝写入用例在错误映射修复前返回 500 而非 503（`error-mapping-red.log`）。

## 本轮最小改动
- `src/modules/payment/keychain.ts`：仅 Mainnet Dev 的 `/usr/bin/security` 子进程恢复 OS 账户 HOME，使用固定 PATH 和 NODE_ENV；不改变后端私有 HOME，不继承其他配置。原 Dev 专属 service/account 选择、目录验证和 Offline 禁止调用钥匙串保持生效。正式模式的子进程行为不变。
- `src/modules/app-wallet/product-wallet.ts`：创建或读回失败使用既有 `WalletKeychainError`；保留竞态复用、读回一致性、禁止覆盖等规则。
- `src/modules/app/management-auth.ts`：将钥匙串访问失败映射为稳定 503 错误码和可操作的脱敏提示，复用现有 UI 的错误展示。
- `tests/integration/pay-dev-environments.test.ts`：fixture 真实模拟私有 HOME；新增 HOME 边界和拒绝写入两个回归。继续覆盖并发创建、重启复用、正式条目 sentinel、无付款权限和真实 Pay stdio 工具发现。

本轮独立 diff 为 `round.patch`，比较的是本轮开始前快照；`files.json` 保存前后哈希。此前大量未提交工作完整保留。

## 当前验证与交付
完整隔离回归：1139 单元/集成 + 15 原款恢复 + 3 安装配置 = 1157 通过、0 失败；1 个显式联网 Mainnet 测试按默认范围跳过。新增用例先红后绿，针对性 27 项通过。typecheck、lint、Next build、同一个 Dev 的 native Release 构建及签名验证通过。

正常退出旧 Dev，核对 native/后端进程与 13049 均已停止；更新原路径 `/Users/irin/Desktop/Yosh Pay Dev/Yosh Pay Dev.app` 并重开。安装包与构建哈希一致；实际运行后端路径、Mainnet 数据目录、签名管理响应和恢复就绪已核对。详见 `shutdown.json`、`deployment.json`、`installed-after.json`。未改正式 App 或 Codex 配置。

## 证据范围和剩余人工动作
自动化测试使用真实 AppRuntime 与管理入口，但钥匙串存储为测试替身；真实系统探测只验证钥匙串定位元数据。安装后只进行 Dev 钱包只读查询，未代用户创建真实 Keychain 钱包、导出密钥、签交易、转账、购买或迁移正式 Ledger。钱包仍为 `absent_fresh`，付款开关为 false。

用户可在已重开的 Dev 中进入 Settings → Wallets → Create Wallet；如 macOS 询问，允许 Dev 的钥匙串访问。实际新钱包创建与显示仍待用户亲手验收。无需使用或迁移正式版旧钱包；生产付款未因此获得授权。
