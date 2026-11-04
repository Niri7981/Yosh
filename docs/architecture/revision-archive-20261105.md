# 授权与原生修复归档（2026-11-05）

用户明确要求将本次及之前积累的相关修复拆成多个 commit，推送 `origin/main`。本轮只整理源码、定向验证与 Git 归档，不重新安装 App，不发起付款，不改钱包、Grant、额度、Pause 或生产执行设置。

## 归档范围

1. 产品购买由共享购买服务绑定当前 Agent/Resource 的有效 Spend Grant，不再依赖历史 CLI 单笔验收凭据；进行中购买不换绑原 Grant。
2. 安装器验证受限的 Grant 授权修复来源，保留冻结版本校验、完整 bundle tree 和签名校验。
3. Demo/产品使用直接走 MCP，只有工程排查或实现才读取相关计划与源码。
4. 原生窗口尺寸贴合卡片，去掉透明外沿和隐藏 titlebar 带来的尺寸偏移，补充实际渲染边界验证。
5. Execution 页面简化模式说明、展开式网络详情、原生 Mainnet switch 与确认入口。
6. 日额度编辑区分后端 Available 与 configured limit，保留六位最小单位转换、当前 monetary scope、输入焦点、错误重试与轮询隔离；Spend Grant 与 per-transaction 编辑共用草稿，避免导航时丢失输入，并保留资源/POST 确认与后端授权边界。
7. Settings Advanced 的滚动回归与当前入口保持一致。
8. 计划和安装/验收证据随本次修复单独归档。

无关的申请草稿、访谈学习材料、未发布的架构图，以及已提交 Devnet 文档的旧内容回退保留在本地，不混入本次修复提交。没有删除或覆盖这些工作。

## 本轮验证

- 默认后端回归首轮：109 个文件中 108 个通过；1190 项中 1189 项通过。唯一失败是 `codex-provider.test.ts` 中真实 Codex CLI 慢启动下的配置重命名用例，返回 `CODEX_CONFIG_FAILED`。该文件单独重跑 3 项全部通过（包含真实宿主 handshake 与成员隔离）；没有修改用例、放宽超时或忽略失败。首次运行与原生并发编译同时进行，不据此断言失败根因，也不把一次重跑当作永无波动的保证。
- `npm run typecheck`、`npm run lint` 通过。根目录 Turbopack 构建长时间停留在编译阶段，主动停止后，采用现有正式构建流程使用的 `npm run build -- --webpack` 完整通过；此前隔离修复工作树的默认 production build 也已通过。没有关闭类型检查或 lint。
- macOS Release `xcodebuild` 通过，本轮未把编译产物覆盖安装版。
- 7 个 callback-only 原生回归全部通过：CardWindowBounds、DailyLimitInlineEditing、ExecutionDetail、SpendGrant、BackControls、AuthorityDetail、TabScrollStability。均无真实后端写入或付款。
- DailyAuthorityPresentation 原生模型回归通过：主网/测试网标签、configured/available 区别、scope 与 legacy 选择、精确最小单位转换、零/未设置额度和非法输入拒绝。
- 22 项 release packaging 回归通过；`git diff --check` 通过。提交逐组限定文件、核对源文件指纹及敏感模式，使用既有 SSH 签名配置，不关闭签名或修改 Git 配置。
- 本机日志与测试产物在忽略目录 `build.noindex/pre-push-20261104/`，不进入 Git。

## 当前运行状态与限制

2026-11-05 00:00（Asia/Shanghai）通过当前 Codex 的 Yosh MCP 只读查询：当前 Mainnet Grant v4 为 ACTIVE，日剩余 0.001 USDC，paid/reserved/unresolved 均为零，blockers 为空、transaction execution eligible。最近购买的本地账本状态为 PAID / CONFIRMED / COMPLETE；本轮没有独立重查链上交易，也没有发起购买。00:00 前旧一天额度曾耗尽，属于日额度策略而非旧 Grant 绑定回归；没有自动调高额度。

当前没有观察到阻挡新购买的条件。每次购买仍需新鲜报价，并受余额、Grant 有效期、日额度、Pause、商家和 RPC 状态约束。本轮不宣称所有潜在 bug 已清零，不把历史 Devnet/Desktop 验收缺口或第三方恢复能力扩大为已验证。

正式安装版的授权修复、正常退出/重启、签名与来源记录、经济表指纹一致性证据见 [Grant purchase authorization](grant-purchase-authorization-20261104.md)。本轮 Git 归档不改变该安装状态。
