# Agent402 无签名预检与逐笔确认边界（2026-10-21）

> 历史阶段记录：下文“逐笔 App 确认 BLOCKED”的产品前提随后已被用户澄清取代。App 仅作配置，购买在 Codex 中完成；已有严格绑定的一次性 CLI 确认可用于本次 Dev 验收。2026-10-21 首笔真实购买已完成，但本文件描述的新版 v2 receipt 与独立 unsigned 工具仍须和实际付款使用的安装版本区分。当前归档与已付款源码映射见 [归档说明](../archive-20261021/README.md)。本文件不构成新的付款、启用或安装授权。

本轮仅修改隔离工作树。没有读取真实私钥、调用真实签名器、付款、设置生产开关、解除 Pause、创建真实 operation/预占、修改正式 Yosh.app/正式 Ledger、Commit 或 Push。测试中的付款、Keychain、未知交易均为既有隔离设施；真实外部调用仅未付款 GET 和只读 RPC/无签名模拟。

## unsigned 缺口的原因及最小修复

旧独立 `pay-protocol-engine` 的 wrapper 在 `integration/pay-protocol-engine/main.rs` 强制 `decimals == Some(6)`，报价省略该可选字段时返回 `UNSUPPORTED_EXACT_USDC_REQUIREMENT`；它还拒绝当前商家的 extensions。旧工具 provenance 指向旧 kit `f8ef055`。这不是当前正式 Pay MCP/锁定 pay-kit `bd3ad25` 缺少 unsigned 能力。正式 `controlled.rs` 已允许原生 USDC 缺省精度，并用原 pay-kit builder 构造交易。

新增真实 Pay MCP 二进制的 `--unsigned-preflight` 模式，直接调用正式 `classify_402` 和同一个 `prepare_with_lifetime → prepare_unsigned_payment`。入口不构造 Bridge、Authority、account store 或 signer，不访问宿主配置，不请求授权、不发送携款 HTTP。Node 侧只用公开钱包身份和固定 resource 策略，通过现有 DNS pinning/SSRF 策略读取完整真实报价及 RPC，比较 Pay 所选 accepted 与 Yosh 所验 quote 的 hash，验证网络、mint、收款方、原子金额、fee payer、blockhash、零签名和完整交易指令。未去掉 resource、outputSchema 或 extensions 来取得通过；新预检不再调用旧独立工具。

`runPayUnsignedPreflight` 不依赖 execution enablement 或 Pause，不导入 AppRuntime、钱包或 Ledger。生产不允许注入测试 transport/builder；子进程不继承密钥或运行时环境。双方 ATA 和 Token Program/mint/状态均验证；严格指令集不允许创建账户或转 SOL。`getFeeForMessage` 返回 null、余额不足、账户缺失/冻结或 `simulateTransaction(sigVerify=false)` 非成功时保留 BLOCKED，不猜测费用或创建账户。

构建后的可重复入口（不启用执行）：

```sh
node build.noindex/mainnet-preflight-fix/preflight-pay-unsigned.cjs --live-read-only \
  --wallet <DEV_WALLET_PUBLIC_KEY> \
  --rpc-url https://solana-rpc.publicnode.com/ \
  --resource-file integration/mainnet-preflight-fix/agent402-public-policy.json \
  --pay-binary build.noindex/mainnet-preflight-fix/pay-mcp \
  --output /tmp/yosh-agent402-fresh-readonly.json
```

输出路径必须不存在；输出仅为私有权限的预检证据，不是付款凭据或授权。报价与 blockhash 会过期；本次快照不代替实际执行前的新鲜校验。

## 逐笔人工确认仍 BLOCKED

本轮只收紧现有运维 receipt 为 v2：显式增加 resourceId、providerId、完整 resource URL，保持可信 caller ID、稳定 operation ID、钱包公钥、网络、原生 mint、原子金额、收款方、完整请求/所选报价/完整 challenge hashes 和期限绑定。在 Authority、新 unsigned 领取、签名前/提交前均复核。已有 v1 receipt 不自动升级或扩权，需要重新确认。新收据从未写入实际 Dev 数据目录；CLI 只在临时目录测试。

**CLI 不是 App 确认体验。没有新增或交付原生确认按钮。** 当前产品缺少“真实 Agent 提案（保留同一稳定 operation 和完整报价）→ 原生展示 → 管理通道批准 → 同 operation 后续执行”的完整交互；仅把运维命令放到按钮后面无法证明用户审阅的是实际将执行的那份提案。根据本轮允许保留 App 阻塞的要求，不把这部分包装为已完成，不提供可执行的真实付款确认文件。

本轮工具及后端只在 `build.noindex/mainnet-preflight-fix` 构建暂存，没有替换或重启真实 Dev App，也没有安装正式 App。现有安装版仍不含本轮修复；待原生确认闭环完成后，须按 Dev 安装和用户验收流程交付。由于 App 确认仍未完成，目前不能进入首次人工付款验收。

## 验证边界

当前运行的针对性 Yosh 测试 7 文件 / 125 项通过；Pay lib/External Authority/HTTP 回归 171 项通过、1 项既有 worker 忽略，新增完整商家报价→SDK unsigned 用例包含其中。typecheck、lint、Next production build、Rust clippy 通过。Next build 保留两条既有动态文件 tracing warning；未为此扩大修改。没有 SwiftUI 代码变更或原生交付成功主张。

真实无签名结果、费用及源码/二进制指纹见相邻证据文件和 validation.json。安装版只读状态：Execution Disabled；Pause 实测为 false（本轮前已如此），本轮未修改它；paid/reserved/unresolved 均为 0。不把预期 Paused 写成实际观测值。
