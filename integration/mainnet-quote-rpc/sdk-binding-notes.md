# SDK / Yosh binding 核对（只读源码审查）

本记录只核对本轮 route-level resource / extensions 兼容；未调用钱包、Keychain、签名器、付款、生产 Ledger。源码审查不代表 Mainnet 执行链已接通。

## 实际依赖

- Pay 隔离树 `../pay/rust/Cargo.toml:122` 把 `pay-kit` 指向 `../../pay-kit-current`，包名 `solana-pay-kit`，该目录 `Cargo.toml:3` 和 `../pay/rust/Cargo.lock:8807` 均为 **0.10.0**。
- 该 SDK 是无 `.git` 的已展开源码，不能把 package version 当作不可变上游 commit。历史基线记录其源自 #514 锁定的 `bd3ad25` 并含 unsigned-prepare 本地补丁；本次实际语义以本地源码与文件哈希为准。
- SDK 自身 `Cargo.toml:93` 固定 `solana-keychain` git revision `44b479df245167ca3b3a4e04d6d907146306d342`；这里只读依赖声明，没有实例化签名器。

## SDK 真实语义

- `pay-kit-current/src/x402/client/exact/payment.rs::payment_required_envelope`（266）：先读 base64 PAYMENT-REQUIRED，再 legacy header，再 body，解析后 `with_resource_on_accepts()`。
- `.../protocol/schemes/exact/types.rs::PaymentRequiredEnvelope::with_resource_on_accepts`（509）：将 top-level resource 复制到 requirement.resource_info；requirement.resource 为空时填 resource.url。此字段是报价元数据，不是付费请求目的地。
- `.../client/exact/payment.rs::select_requirement`（307）：按 preferred network 选择；默认 Solana Mainnet，再按 amount；`PaymentRequirements::to_accepted_value`（types.rs:268）优先返回原 canonical accepted 对象，保留其 extra。
- `.../client/exact/payment.rs::prepare_unsigned_payment`（45）：只消费 payer、PaymentRequirements、blockhash、transaction version；构造 transfer、compute budget、memo。resource 和 extensions 不进入转账经济指令。`memo_instruction`（379）只使用 accepted.extra.memo，否则随机 memo。
- `.../client/exact/payment.rs::build_payment_header`（132）：将 accepted、resource_info 和传入的 extensions 包装进 PAYMENT-SIGNATURE；resource_info 的 SDK 类型仅 url / description / mimeType（types.rs:198）。
- Pay `../pay/rust/crates/core/src/client/x402.rs::parse`（101）单独捕获原 extensions；`build_outbound_extensions`（1081）调用 SDK `PaymentExtensions::echoing`，只在 payment-identifier.info.required=true 时生成 id。
- SDK `types.rs::PaymentExtensions`（560）：payment-identifier 有 typed info(required/id)、schema；其他扩展 BTreeMap 透传。bazaar / builder-code 没有交易构造逻辑；源码搜索没有 builder-code 付款指令。不能把 builder-code.info.a 当成 token recipient、memo 或额外费用。
- `PaymentExtensions::echoing`（605）会通过 typed serde；payment-identifier 新增未知字段可能丢失。最终受控补丁既用 SDK 解析判断 requires(true)，也要求 typed serialization 与原 extensions JSON 相等；会被 SDK 丢字段/补默认/规范化的形状明确拒绝。真实 Agent402 当前形状相等。实际授权、持久绑定、outbound echo 始终保留 raw JSON。

## 真实报价与最小绑定修复点

已保存的公开 Agent402 envelope 位于 ignored `build.noindex/mainnet-preparation/merchant-quote.json`，resource 为无 query 的同 origin / 同 pathname 路由；真实请求带 coins/currency。扩展包含 bazaar、builder-code、payment-identifier(required=false)。本轮实时抓取结果优先于该历史文件。

1. `SpendRequest.payment_required` 仅在 ControlledExecution 提供完整原 envelope；普通 #514 Hook 的序列化与行为保持原样。
2. Yosh `pay-authority-adapter.ts::parse` 当前重造 resource=request.url 并丢掉 extensions，不能用于主网兼容证据。须严格 parse 原 envelope、核对单独 accepted 与真实选择，传原 challenge 到现有请求/预占路径。
3. 精确请求身份始终是 facts.request（method、完整 query URL、approved headers、body）；声明路由只能 exact URL 或同 origin / 同 pathname 的无 query、无 fragment、无 userinfo URL。不能允许 prefix、跨 origin、不同 pathname、相冲突 query。
4. `resourcePaymentBinding` 已包含 immutable HTTP request + 完整 X402Challenge，`ExecutionSafety` 已绑定 request hash、quote hash、record binding。无需第二账本或新 money state。
5. 重放当前只核对 request_hash / quote_hash，还须核对原保存 `intent.x402Challenge` 与本次 payment_required 全量 hash；否则相同经济 accepted、改变 resource 描述/扩展/alternatives 可能错误返回旧结果。
6. `PurchaseLedger.assertOriginalBindings`（purchase-ledger.ts:774）已有精确 resource / extensions 比较；保持此边界。原 envelope 保存完整 serviceName/tags/iconUrl。当前最小实现直接保存/echo完整原 resource，SDK typed投影只用于重解析一致性核对；不改 Ledger 的精确比较。若未来 outbound 采用 SDK resource projection，必须明确持久绑定 projection 与原 envelope，不能顺手改为宽松子集比较。
7. 本轮真实 payment-identifier.required=false，可完整 echo；required=true 需一次生成并持久化 stable client id 才能支持。未实现前应明确拒绝，不能签名后临时补 id 或恢复时再生成。

## 必须回归

- 真实公开报价经 SDK 解析：多链 alternatives 保留、选中 Solana exact native-USDC、route-level resource + 三种扩展被绑定；全过程不签名、不付款。
- 同 operation 对完整 request query / accepted 金额、mint、network、recipient / 原 resource 元数据 / extensions / alternatives 的变更都拒绝，重启后同样拒绝；相同事实只复用原状态与数据。
- changed envelope 在 reserve 前拒绝；同一 attempt 在 plan/execute 前篡改拒绝；没有因为兼容变化放宽 Pause/epoch/owner/original evidence。
- 跨 origin/path、userinfo、fragment、conflicting resource query、bazaar method mismatch、malformed extensions、required client-id 未持久化均拒绝。
- 现有 unsigned transaction 严格校验继续覆盖 payer、fee payer、USDC mint、收款 ATA、amount、decimals、compute settings、memo 与 signatures=zero；仅 envelope 兼容不得扩大交易指令集合。
- Pay 默认没有 Authority / 没有 Controller 时行为不变；真实 Offline MCP 仍经过真实 Yosh Grant/Ledger，既有 replay/Unknown/ACK loss/Pause 回归保留。

本文件是只读建议；实际本轮修改和测试结论由主任务 validation 记录，不将这些检查建议视为已执行测试。

## Payment identifier 精确类型语义与当前补丁审阅

`types.rs:529-539` required 为 `Option<bool>`，id 为 `Option<String>`；`:546-548` info 仅在缺失时 default；`:584-588` requires 只有 bool true 返回 true，其余 None/false 返回 false。扩展缺失/null→None；info缺失→默认空info，info:null/非object→反序列化失败；required缺失/null→None，非boolean→失败；id非string/non-null→失败。root 的 Yosh helper 以相同 SDK projection 核对 raw：identifier外层只info/schema，info只required/id，None/null字段skip，缺失info补{}；形状会被SDK规范化则failclosed。info:null直接拒绝。required=true仍明确拒绝，包括同时存在id的情况。

已只读核对本轮当前改动：Facts.payment_required 全量入 factsHash；parse 保存原 challenge，核对 accepted 唯一性及经济字段；replay 增加原 challenge hash 比较。现有 resourcePaymentBinding、ExecutionSafety record binding、Ledger 原证据精确比较继续生效。未发现这些改动引入可达的绑定绕过；这不是测试通过声明。

最终只读复查：Yosh assertPayControlledExtensions 的 sdkEcho/hash 与 Pay controlled_envelope 的 serde_json::to_value/raw 相等性检查一致。无钱包或网络访问。
