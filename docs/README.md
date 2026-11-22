# 文档索引

产品范围、阶段状态和验收证据以根目录的 [`plan.md`](../plan.md) 为准；开发与资金安全约束以 [`AGENTS.md`](../AGENTS.md) 为准。本文提供导航，不覆盖这两份文件。

## 安装和使用

- [Local installation](guides/local-install.md)
- [Host plugins](guides/host-plugins.md)
- [macOS App](guides/native-app-getting-started.md)

## 产品与架构

- [架构文档索引](architecture/README.md)：当前 App、授权与 MCP 资料，以及历史 V0 设计和主网准备记录的分类导航。
- [macOS App 壳与本地服务生命周期](architecture/macos-app-shell.md)
- [Authority Core（阶段一）](architecture/authority-core.md)
- [MCP 接入](architecture/mcp-integration.md)
- [Yosh 更名兼容边界](architecture/yosh-rename-compatibility.md)
- [按职责命名与历史数据兼容](architecture/naming.md)

## Demo 与验收手册

这些手册记录旧网页 Demo、CLI 购买和独立支付流程，属于测试设施资料，不代表新 App 的默认运行方式。涉及真实模型或 Devnet 付款的步骤，执行前须核对当前环境和授权范围。

- [Yosh Devnet E2E validation](demo/yosh-e2e-validation.md)
- [网页 Demo 运行与验收](demo/demo-runbook.md)
- [完整任务运行与验收](demo/task-acceptance-runbook.md)
- [受规则约束的自动购买](demo/purchase-runbook.md)
- [独立支付运行与验收](demo/payment-runbook.md)
- [标准 Demo 输入](demo/demo-input.md) · [标准 Demo 输出](demo/demo-output.md)
- [资源发现开发计划（历史设计）](demo/discovery-plan.md)

## 设计参考

- [Yosh UI 设计参考](design/README.md)：卡片图片与 Phantom 录屏的使用边界和素材目录；产品 UI 约束以 [yosh-ui Skill](../.codex/skills/yosh-ui/SKILL.md) 为准。

## 审计与退役资料

- 旧 Yosh Pay 发布分支的最后一次提交分别归档在 [archive/yosh-pay-v0](https://github.com/Niri7981/Yosh/tree/archive/yosh-pay-v0) 和 [archive/yosh-pay-v1](https://github.com/Niri7981/Yosh/tree/archive/yosh-pay-v1)。
- [历史审计](audits/hackathon-audit-2026-09-21.md)：截至文中注明日期和提交的审计快照；当前状态请查阅 `plan.md`。
- [旧前端保留边界](legacy/legacy-frontend.md)：说明旧网页前端的保留范围与当前原生 App 的职责。

本机可能另有被 Git 忽略的 `docs/daily-summary.md` 和 `.DS_Store`；它们不是共享项目文档或当前状态来源。
