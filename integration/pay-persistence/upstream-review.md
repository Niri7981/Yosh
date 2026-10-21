# 上游 Review 准备

三个通用能力保持为独立审阅单位，Yosh 代码不进入 Pay/SDK。

| 能力 | 当前真实依赖与边界 | 简短提交说明 |
| --- | --- | --- |
| A — External Spending Authority | 已有 PR #514，HEAD `9f9c342`；`SpendingAuthority`/`SpendRequest`/`AuthorityBinding`；policy-only，独立于 unsigned API，不提供签名或最终发送控制。本轮不修改该 PR | `feat(mcp): consult an optional trusted spending authority before payment` |
| C — pay-kit unsigned preparation | 在 #514 实际锁定的 kit `bd3ad25baeb65c1c293239e1b4990f14d26a22ad` 上分离原 exact builder；旧 `build_payment` 调用同一构造函数后签名。不是归档旧 kit `f8ef055` 的原样补丁。无 Yosh、Grant、Ledger 依赖 | `feat(x402): expose unsigned exact transaction preparation` |
| B — ControlledExecution | 当前具体复用 A 的 `SpendRequest`、`AuthorityBinding`，且要求 C 的 `prepare_unsigned_payment`。只有启用 controller 的原 `do_paid_fetch` exact 分支走此路径；缺省账户/批准/签名/重试保持原行为 | `feat(mcp): delegate exact payment custody and final HTTP to a host controller` |

建议先独立 Review C，并继续 A 的现有 Review；B 在 A 接口稳定及 C 可引用后再单独 Review。B 需要显式更新依赖 pin 指向包含 C 的真实提交；不能把当前本机 Cargo path/vendor overlay 当上游依赖，也不能虚构未来 SDK 版本号。本轮没有创建提交、推送或 PR。

候选补丁仍位于 `integration/pay-mcp-first/pay-controlled-execution.patch`、`pay-kit-unsigned.patch`；已重新执行 Pay 默认行为回归、fmt、clippy 与 pay-connect 兼容检查。`pay-isolated-host.patch` 是真实 PayMcp 的测试宿主，负责向接口注入 loopback Bridge；它不是第三个通用 API，不应与 A/B/C 混为产品特性。

Review 需要明确：B 的 trait/受控分支是通用扩展点，但当前 `controlled.rs` 的 prepare transport 仍包含第一轮 loopback-only、bounded RPC、exact USDC 测试准入规则。不能把整个当前实验 profile 宣称为可直接用于任意生产 RPC 的完整上游实现；提交 B 前应把宿主网络准入策略与通用构造能力的边界整理清楚。签名与经济账本不是 Pay patch 的职责。此项与 Yosh 暖旧进程凭据切换阻塞分别审阅。

Yosh 专属：`pay-authority-adapter.ts`、PurchaseLedger migration/provenance/epoch、Connection/Grant/Budget 绑定、签名/最终 HTTP 及对账恢复。测试专属：`yosh-controlled-mcp.rs`、loopback Bridge、生产模块 fixture、旧版本 worker、离线 signer、历史源码归档。常规安装脚本目前只打包原后端与 Yosh `mcp.cjs`，尚未加入 Pay 产品二进制/宿主 bootstrap；因安全门禁未过，本轮未开始该交付改造。
