# 本轮结果与停止点

用户要求停止扩大范围；当前验证均已完成，不继续修复、审计、重构或付款。

实际完成：Pay 原 do_paid_fetch、x402 选项、Authority、ControlledExecution、unsigned prepare 和原响应解释的固定字段追踪；Yosh 将其与 caller/operation/attempt/provenance 关联。UI 只加 Route、Operation、Trace ID；旧记录无日志则明确不完整。Offline 隐藏链上浏览器链接，不改变财务状态。追踪存储失败不覆盖 PAID 或丢弃数据。

原生 USDC 报价可省略可选 decimals，SDK 默认6；错误显式精度和资产仍拒绝。先以两项失败用例复现，再修复；unsigned SDK wire 测试不含签名，使用假 blockhash，不是主网付款。

真实公开 Agent402 402 报价已读取：Mainnet 原生 USDC、1000 atomic，收款方和 fee payer 见 live-preflight.json。该报告没有钱包或 Ledger 访问。真实报价的路由级 resource 与扩展在现有 ControlledExecution 中仍不兼容；Rust MCP 测试验证签名前拒绝。RPC DNS 含被现有策略排除的特殊IPv6，未绕过保护。

三个阻塞按 validation.json 区分：主网资金及单执行器切换接线（代码）、真实报价上下文（代码）、RPC DNS（本地网络）。当前只可人工审阅追踪/Offline UI，不具备真实付款验收条件。没有真实签名、付款、正式数据库迁移或正式App升级。

证据：yosh-round.patch/pay-round.patch 为本轮独立增量；pay-generic-tracing.patch 不新增公开API，主机与Yosh业务仍分开；pay-native-usdc-decimals.patch 是独立的可选精度修复。原有未提交修改保留。start-state.json、original-source-baselines.json 与 ../mainnet-preparation-baseline 保存起始状态；旧历史基线未覆盖。

验证：full-regression-final.log（1098+15+3通过）、pay-final-classifier.log/pay-tests-details.log（168通过，原有1项忽略）、targeted-final.log（51通过）、codex-binary-trace-final.log（真实Codex宿主、实际二进制hash、原款状态与完整阶段关联）、native-trace-passed.log、typecheck-passed.log、lint-passed.log、build-final.log、dev-build-final.log。早期失败日志保留：decimals-red-details.log 为真实兼容缺陷；首次完整回归的4个status测试缺少新返回字段所需的已有purchases mock，已补齐并全量重跑。原生独立编译首次少列RegisteredAPI依赖，补齐后通过。

Dev 已正常退出旧后端、更新签名产物并重开；installed-verification.json 与 installed-verification-ready.log 证明真实宿主只读状态、新投影、历史追踪不伪造及购买/原款/provenance/Grant/控制保持不变。首次重启验证过早读取WAL失败，验证器增加认证coreReady等待后通过，未改账本。

本地追踪不是独立远程证明；Deny-only SDK classifier测试不是Yosh授权成功；原版JS主网历史成功不是新版验收。生产继续BLOCKED。等待用户决定下一步。
