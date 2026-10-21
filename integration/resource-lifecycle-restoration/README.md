# Dev 资源生命周期接线恢复（2026-10-21）

## 实际完成
- `management-server.ts` 直接复用原管理资源的 GET/POST、discover、prepare、单项 GET/PUT，以及原 Agent discovery/resources/quote handler；认证、schema、SSRF、发现凭据与原 registry 均未另写。
- `pay-dev-mcp.ts` 在同一 Yosh 专用 Pay 宿主增加 Mainnet 的 `discover_x402_resource`、`register_x402_resource`、`quote_x402_resource`。使用原输入 schema、原 Agent capability、固定后端路径、有界响应/超时及脱敏错误码；不能获得管理 token、设置额度或创建 Grant。旧 `request_purchase` 未接入，Pay curl 仍是唯一付款入口。Pay 通用源码未修改。
- Settings → APIs → Add API、只读发现、POST 预览/确认、注册、查看、禁用/移除复用原 UI 与 handler。资源列表和 Spend Grant 使用原唯一 registry；没有新增 Ledger。
- Grant 页面把读刷新误当写操作，每三秒令输入与滚轮变为 disabled；滚轮的 enabled 变化又会重设 position。仅分开 `isRefreshing` 与 `isSaving`：输入/滚轮在读刷新期间保持可用，提交按钮等待读取结束，实际写入继续锁定控件和走原后端串行规则。未修改动画框架。

## 复现与自动化证据
`routes-red.log` 的两个新增集成用例在修复前失败：缺管理路由、缺同宿主工具；既有 8 项仍通过。`grant-refresh-red.log` 在真实 SwiftUI 离屏控件边界复现 READ_REFRESH_DISABLED_GRANT_EDITOR。新测试从红转绿，未操作用户界面或使用 Computer Use。

`targeted.log`：31 passed。`full-regression-final.log`：1142 主套件 + 15 原款恢复 + 3 安装配置 = 1160 passed，0 failed；默认跳过 1 个付费链路联网预检。这里的跳过不包括下方实际执行的无资金发现/注册验证。此前未完成的 full-regression 日志不计入最终结果。

新用例覆盖真实 AppRuntime HTTP/stdio 路径、管理认证、Agent 发现凭据所有权、重复注册、注册不创建 Grant 或付款、撤销连接后禁止新发现、Agent 不得使用管理通道、旧购买入口不可达。公共报价在自动化测试中用 fixture；实际公开报价的证据另列。

`native-installed-projection.log` 包含离屏 Grant 控件回归和原生模型对真实已安装管理响应的解码。原 App 从同一响应的 registeredResources 填充 Grant picker。临时完整响应只供原生解码，执行后已删除；未用虚假 UI 数据代替实际 AppRuntime。

类型、lint、Next build、native Release、代码签名与独立补丁检查均通过。`round.patch` 基于本轮开始的五个文件快照及新测试/验收脚本，保留此前所有未提交修改。`files.json` 是本轮前后哈希。

## 已安装软件与真实报价验收
正常退出旧 Dev，确认 native、后端及 13049 停止，更新同一个 `/Users/irin/Desktop/Yosh Pay Dev/Yosh Pay Dev.app` 后重新打开；构建/安装哈希与签名已核对。正式 Yosh、Codex 配置、Mainnet 环境选择与现有钱包未替换。

`installed-live-resources.json`：对实际安装的 Pay stdio 宿主执行 discovery → register → quote，商家为 Agent402 实际 HTTPS 402，Solana Mainnet 原生 USDC，报价 1000 atomic（0.001 USDC）。注册 `agent402-crypto-price` 成功且 spendingAuthorityCreated=false。原始 runtime 的注册表单独保存 Agent submission，因此底层旧 schema 的 source=user 经原投影显示为 Agent-submitted。

`dev-state-after.json`：签名管理响应确认 APIs 与 Grant 选项均有 Agent402；钱包仍为 <DEV_WALLET_PUBLIC_KEY>，Grant 记录 0、付款记录 0、productionExecutionEnabled=false，与本轮前一致。除恢复资源登记外未变更经济控制。未调用 paid curl、交易 signer、转账或付款；未迁移正式数据库。App 的正常钱包状态检查仅使用 Dev 专属钥匙串条目。

## 用户下一步与边界
1. 当前 Dev 已打开，Settings → APIs 查看 Agent402 Crypto Price。
2. 重连现有 yosh_pay_dev MCP；若工具仍缓存，重启 Codex Desktop，无需独立启动器或新配置。原会话在更新前启动的 stdio 包装器不会自动获得新工具。
3. 可让 Agent 通过同一 MCP 只读发现 Agent402 并获取报价；已登记资源复用 `agent402-crypto-price`，不要更换 ID 重复登记或购买。
4. Authority → Spend Grant 选择 Agent402、检查样例与经济范围，由用户亲自设置额度和确认创建。注册本身没有消费授权。

真实发现验证使用 SDK client 连接实际安装的同一宿主，不能冒称旧 Codex 会话已经刷新工具，也未代替用户完成视觉/滚动验收。付款仍显式关闭，生产验收未因此解除阻塞。本轮到此停止，不 Commit、Push 或开展下一阶段。
