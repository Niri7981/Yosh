# 亲手体验 Yosh × Pay

以后先在 Dev 验收同一套功能代码，通过后再更新正式版。当前只启动桌面的 **Yosh Pay Dev/Yosh Pay Dev.app**；正式 Yosh 不用打开。两者数据、钱包、授权和账本保持隔离，不复制生产记录或密钥。

## 六步操作

1. 打开 **Yosh Pay Dev.app**。Settings 应显示 `Development · No real funds` 和 `Offline test key`。这个开发版使用假商家、假 RPC、独立离线测试密钥，没有真实资金。
2. 在 Connection 查看 Codex 连接，在 Authority 查看共享预算、该 Agent 的 Spend Grant 和 Pause。若 Grant 已过期，请在 App 中自行审阅并更新；旧记录不清除。
3. **完整退出并重启现有 Codex Desktop，再新建会话**。不使用独立 Codex 启动器。现有配置中正式 Yosh MCP 已按用户授权暂停启用，保留配置；`yosh_pay_dev` 提供 `curl` 和 `get_spending_status`。
4. 先发送：**使用 yosh_pay_dev 的 get_spending_status，只读取开发版付款状态，不购买。** 应返回 Offline 环境、余额、预算、已支付、预占、Grant 和暂停/就绪状态。购买测试时，再明确请求 `curl` 访问 `http://127.0.0.1:13049/api/paid/sol-market-snapshot?asset=SOL`，单价 0.20 测试 USDC；为新购买选定并保留稳定 operation_id。已有 user-demo-1 的重试必须继续用 user-demo-1，不换 ID 付款。
5. 返回 Yosh，在 Authority / Activity / 详情中查看同一购买、付款与交付状态、预算和余额。API 数据应明确标记 Offline。失败或 Unknown 不得换 operation 重付。
6. 在 Yosh 点击 Pause，再发起一笔明确的新拒绝测试请求，应显示拒绝且不增加消费。只读状态查询仍应可用。

正常退出开发 App 会等待后端停止，重开后恢复原记录。后端停止时工具只返回开发版不可用，不查询正式版、不自动启动正式 App、不替代付款。同 Pay 进程重放可能返回 OPERATION_ALREADY_STARTED；重新连接后继续使用原 operation_id。

开发版同步了正式源码中的最新界面和钱包列表；真实钱包创建/导入和 Mainnet 在本次离线环境中明确禁止。正式安装版尚未升级，等待你亲手验收；生产仍 BLOCKED。自动化宿主验证不代替你的人工验收。
