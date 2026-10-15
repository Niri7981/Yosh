# Authority Core（阶段一）

更新日期：2026-09-21。

2026-10-16 Buyer Reliability v1.1 更新：纯经济策略 `evaluateSpendAuthority()` 现在只读取 Authority 自己定义的 `SpendAuthorityFacts`（`amount`、`createdAt`、`expiresAt`），不再导入包含 HTTP/x402 证据的完整 `SpendIntentSchema`。`PurchaseLedger.reserve()` 仍在调用策略前校验完整不可变记录，并在同一事务内执行身份、Grant、预算与预占规则；经济策略的 `APPROVED` 本身不是付款许可。存储结构、历史记录和原付款证据没有改变。下方内容保留阶段一设计与当时范围。

## 目标与边界

Yosh 的 Authority Core 接收由服务端创建的消费意图，判断是否允许占用用户预算，并生成只能由后端使用的单笔授权 ID。它不发现 API、不解释行情请求、不解析 x402 协议，也不接触私钥。

本阶段保留现有 MCP、App 和 market snapshot 对外入口。变化发生在内部：market snapshot 从系统中心降为第一个 resource adapter，通用权限判断不再包含行情常量。

## 核心类型

`SpendIntent` 表示 Agent 发起、服务端验证并固定后的消费请求。它不是用户授权，也不能直接触发签名。

| 字段组 | 内容 |
|---|---|
| 请求身份 | `id`、`idempotencyKey`、`requestHash` |
| 资源范围 | `resourceId`、`providerId` |
| 支付条件 | `amount`、`currency`、`assetDecimals`、`assetId`、`network`、`payTo`、`paymentScheme` |
| 不可变绑定 | `quoteFingerprint`、`executionBinding` |
| 时间范围 | `createdAt`、`expiresAt` |

Resource adapter 必须先验证业务输入、资源身份和外部报价，再创建 `SpendIntent`。Agent 不能自行填写一组付款条件并要求 Authority Core 信任。

`AuthorityDecision` 只有三种结果：

- `APPROVED`：规则通过，账本已原子预占预算，可以领取一次执行权。
- `DENIED`：请求无效、暂停、额度不足或存在未解决付款等条件阻止消费。
- `REQUIRES_APPROVAL`：安全与预算条件通过，但超过自动批准的单笔上限。该状态不会执行付款。

`SpendReservation` 是账本保存的结果，包含不可变 `SpendIntent`、decision 和服务端生成的 `approvalId`。创建 reservation 不等于已经付款。

## 当前调用链

```text
purchaseMarketSnapshot()
  → market-spend-adapter
      验证 SOL 输入、demo resource/provider、价格与 x402 报价
      创建通用 SpendIntent
  → PurchaseLedger.reserve()
      BEGIN IMMEDIATE
      读取当日已消费与现有预占
      检查 unknown-payment freeze
      evaluateSpendAuthority()
      保存 decision、reservation 和 approvalId
      COMMIT
  → executeApprovedPayment(approvalId)
      原子 claim
      复核暂停、额度、过期时间和执行绑定
      签名、提交或保存未知付款状态
```

付款层仍只接受 `approvalId`。它不接受调用方重新提交 amount、asset、network 或 payee。重复的 idempotency key 返回原 reservation；改变请求或执行绑定会失败。

## 规则归属

Authority Core 当前负责：

- `SpendIntent` 结构与有效期。
- pause。
- daily budget。
- single limit。
- 原子预算预占。
- unknown-payment freeze。
- `APPROVED`、`DENIED`、`REQUIRES_APPROVAL` 决策。

Market resource adapter 当前负责：

- `asset = SOL` 输入校验。
- `premium-sol-market-snapshot` resource 身份。
- `demo-market-data-provider` provider 身份。
- demo resource 的 x402 `exact`、价格、asset、network 和 payee 一致性。
- 将验证后的行情请求与报价转换为 `SpendIntent`。

## 兼容与未泛化范围

本阶段没有重写账本或付款恢复。SQLite 仍沿用 `purchases`、`task_id`、`purchase` 等旧列名，运行时会把旧 Purchase JSON 转换为 `SpendIntent`，并把旧 decision 名称映射为新名称，避免破坏进行中付款。

以下部分仍是现有 market/x402 实现，留待后续经授权的阶段处理：

- `PurchaseLedger` 仍保存 x402 `PaymentRequirements`。
- `PurchaseRecord` 仍作为 `SpendReservation` 的兼容类型名存在。
- 交付数据仍使用 market snapshot 类型，恢复流程仍调用当前行情 endpoint。
- `purchaseMarketSnapshot()`、MCP 付款接口、App 测试购买入口没有改成新的公共产品接口。
- 金额和账本内部仍沿用现有安全整数；还没有迁移为通用的多资产整数表示。
- 只有一个 provider 和一条 x402 支付路径；没有 Jev、第二 provider 或 future rails。

这些限制不改变 Authority Core 的权限边界，也不表示下一阶段已经开始。
