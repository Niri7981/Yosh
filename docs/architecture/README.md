# 架构文档索引

当前产品范围、实施状态和验收结果以根目录 [`plan.md`](../../plan.md) 为准。架构文档按当前产品、主网准备阶段和历史 V0 设计分类；阶段记录保留各自的实施边界，不单独代表最新运行状态。

## 当前产品架构

- [Buyer Reliability v1.1 Backlog](buyer-reliability-backlog.md)：当前 HEAD 的可靠性问题核查、分类、逐项修复与验收记录。
- [macOS App 壳与本地服务生命周期](macos-app-shell.md)：窗口、进程和本地服务。
- [钥匙串读取与签名审计](keychain-access.md)：本机访问授权和签名身份。
- [Authority Core（阶段一）](authority-core.md)：消费意图、授权决策和预算预占。
- [MCP 接入](mcp-integration.md)：Codex 连接、工具边界和验证限制。
- [Yosh 更名兼容边界](yosh-rename-compatibility.md) · [按职责命名与历史数据兼容](naming.md)：产品名称、持久身份和兼容规则。

## 主网准备与执行入口

按实施顺序整理在 [Mainnet readiness 索引](mainnet-readiness/README.md)：环境隔离、钱包与授权、账本金额、原付款恢复、生产 x402、持久交付恢复、条件执行和产品入口。Execution 环境选择记录也归入此分类。

## V0 测试网 Demo 历史设计

旧固定行情 Demo 的设计文档集中在 [`v0/`](v0/)，包括产品范围、总体结构、角色与状态、资源合同、策略、钱包和 x402 流程。这些材料用于追溯旧设计，不覆盖当前产品约束。

- [Product Definition](v0/product-definition.md) · [V0 Scope](v0/v0-scope.md) · [Architecture Overview](v0/overview.md)
- [System Actors](v0/system-actors.md) · [Happy Path](v0/happy-path.md) · [State Machine](v0/state-machine.md) · [Execution Trace](v0/execution-trace.md)
- [Resource Schema](v0/resource-schema.md) · [PurchaseRequest Schema](v0/purchase-request-schema.md) · [Paid Market Data](v0/paid-market-data.md)
- [Spending Policy](v0/spending-policy.md) · [Wallet Architecture](v0/wallet-architecture.md) · [x402 Payment Flow](v0/x402-flow.md) · [Risks and Fallbacks](v0/risks-and-fallbacks.md)
