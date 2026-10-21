# Dev 状态查询与版本对齐

已复现：真实开发 MCP wrapper 的 tools/list 缺少 get_spending_status，旧 Codex 配置只允许 curl；正式 MCP 仍暴露同名状态查询。开发后端正常运行在 13049，正式 3049 没有监听。旧状态工具因此会返回 APP_UNAVAILABLE，不能据此推断开发后端或账本丢失。

修复：开发后端复用既有 /api/agent?operation=status 的成员认证及真实 AppRuntime 读取；Yosh 专属 stdio wrapper 增加只读工具，Pay curl 的原编排不变。不新增付款入口或经济账本。固定开发地址/捕获的原成员 capability，不接受客户端切换 origin 或身份。错误只报告开发版，不回退正式版。

先以真实 wrapper + Pay + AppRuntime 增加失败回归，证明工具缺失；随后验证状态查询、只读账务不变、非法参数、未认证请求、Pause、后端失联/重启、连接撤销，以及原购买/幂等/恢复。测试全部使用临时隔离库、假商家/假 RPC/离线密钥。

用户后续要求对齐版本：两个目录 HEAD 同为 f65c9bd30a2cad65493d2e70b15624be26e216ed，但各自有不同的未提交功能。将正式目录现有界面、钱包列表及相关测试合入当前集成树，保留 Pay/持久化/原款恢复实现。手动合并 Ledger 只增加已有钱包库初始化，保留 ExecutionSafety 和失败清理；Settings 保留离线标记与 Keychain 禁止。原始正式源码指纹检查保持一致，没有写入该目录。

Dev 钱包列表与正式源码同源；离线环境的真实钱包创建/导入被后端明确拒绝，Mainnet 与真实 Keychain 仍不可访问。没有复制正式钱包、授权、记录。钱包库是现有正式功能的元数据，不是新增经济账本。原开发购买、原款证据、provenance 和 Grant 在更新前后逐行摘要不变。

按用户明确追加授权：暂时停用正式 Yosh MCP，保留全部配置；yosh_pay_dev 允许 curl/get_spending_status，其他 MCP 与登录信息不变。现有桌面配置与已安装客户端随包 Codex 宿主已实际发现并调用新状态工具，认证握手和后台 coreReady 通过，未开启模型回合或购买。验证子进程为避免访问无关服务单独禁用其他 MCP，并未改其持久设置。

已正常退出旧开发 App、等待后台停止，更新桌面同一路径的签名 bundle 并重开，实际部署文件与本次构建一致。废弃独立启动器归档到 build.noindex，桌面用户说明已更新。正式安装版不替换，等待用户 Dev 人工验收后再发布；生产 BLOCKED 保持。没有 Computer Use、真实付款、Commit 或 Push。

证据：before.log 为缺失状态的失败；related.log 为10项定向通过；regression.log 为1090+15+3项通过；typecheck/lint/build/dev-build 日志通过。原生独立编译脚本最初未列新钱包模型依赖，补齐模型后 native-configuration-passed.log 通过，未跳过检查。verification.json 记录真实宿主状态读取，deployment.json 记录桌面部署。source-and-parity.patch、delivery-build.patch 与 changed-files.json 可供审阅，原未提交修改与 baseline 快照均保留。

用户下一步：保持 Dev 打开，完整重启现有 Codex，新会话请求“使用 yosh_pay_dev 的 get_spending_status，只查看开发版付款状态，不购买”。用户亲手界面验收仍待完成；不能把后台工具验证说成完整产品验收。
