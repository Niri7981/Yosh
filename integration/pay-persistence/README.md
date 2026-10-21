# 第二轮：持久化安全代码与准入结果

**生产及 staging 门禁：BLOCKED。** 本轮完成真实迁移、持久 permit/epoch、writer 拒写和旧源码兼容验证；没有开始产品 staging、安装或宿主注册。不能把拒绝旧版数据库写入外推为撤回旧进程已经取得的付款凭据。

新增 `src/modules/purchases/execution-safety.ts`。显式 `018_execution_safety` 迁移在原 PurchaseLedger 中增加执行元数据；没有第二个经济账本。`purchase_execution_provenance` 和 reserve 同事务写入 caller、operation、attempt、完整事实 hash、请求 hash、quote hash、原执行绑定、owner、epoch。状态为 AUTHORIZED → CLAIMED → SIGNED → SUBMISSION_ATTEMPTED；金额、预占、结算与交付仍以 purchases/original_payments 为准。新默认 JS 来源也记录元数据；来源标签不是付款证明。所有历史行保持“未归属”，不猜测、不补写 Pay/JS 来源。

`execution_owner` 存储单调 epoch 与进程 owner。内核自动释放的 SQLite 写锁保证同一路径的新 writer 只有一个；锁文件没有经济表。Pause、退出及新进程接管使原 permit 失效。claim、签名检查、payload 落盘及提交 marker 验证 owner/epoch。并发相同经济条件的不同 attempt 不能借用获胜者 permit。历史原证据、Unknown 和预算不会因来源升级被释放或重写。

数据库持久触发器要求连接本地 `yosh_execution_writer` / `yosh_execution_lease` 函数；实际旧版缺少这些函数，冷启动和升级前已打开连接的 DML 都被拒绝。这不是仅检查 schema_version。三个真实源码版本参与：Git `f65c9bd`、引入数据目录 owner 之前的 `b544227`、本轮开始时包含全部未提交修复的 Round 1 源码。测试用各版本自身构造函数创建历史 schema、写入或执行 startup recovery；未重写旧实现。

**未解除的具体阻塞：** `b544227` 的 `approved-payment.ts::recoverApprovedPayment → receivePayment` 在任何记账写入之前读取原 payload 并直接 `fetch`。测试先启动该真实旧进程，准备一份未发送的离线签名，再由新版升级并确认 Pause；旧恢复仍向假商家发送一次原凭据。后续账本写入被触发器拒绝，原 Unknown 及预占保留，但 final HTTP 已越过新版控制。`build.noindex/pay-round2-blocker-observation.json` 保存的是脱敏反例观察，不是资金安全 PASS。

数据库触发器不能撤销进程已读取/缓存的签名，也不是防同一用户任意 DDL、替换数据库文件的访问控制。解除门禁至少需要可信升级切换：确认旧执行/恢复进程已停止并隔离其已取得凭据，或由旧进程不能绕过的签名/最终出网边界强制执行。当前部署没有这项保证；本轮不操作用户 App/Keychain 来冒充完成。因此停止第二目标，未制作可部署 staging、未修改 Codex 配置、未安装 App、未启动用户 App、未迁移生产数据。

测试范围（`tests/integration/execution-persistence.test.ts`）：

| 用例 | 证明范围 |
| --- | --- |
| 三组真实旧源码建库、升级、拒写、失败降级后再升级 | 已测试源码的普通 DML/启动恢复；不代表撤销旧凭据 |
| 升级前已打开的旧连接＋第二个新 writer | 同一数据库路径下旧 DML 拒绝、新 owner 互斥 |
| 真实 Pay MCP 完成后的 provenance / reopen | caller、operation、attempt、quote 与阶段持久化；原证据不变 |
| Pause → Resume → reopen / JS 误用 Pay claim | 原外部 permit 永久失效；默认执行入口不能借用它 |
| 历史已付款＋Unknown 的升级 | 原财务行及证据逐表 hash 不变，Unknown 预占保留，无来源补写 |
| 旧暖进程 final HTTP 反例 | 证明门禁失败；断言反例存在的测试通过，不是安全验收通过 |
| 升级后的默认 JS x402 购买 | 原 JS SDK 构造和内存测试 signer 成功，未走 Rust prepare |
| SIGKILL：签名落盘、marker 前 | 新代码证明未提交；原签名保留，旧 permit 不复活，无替代付款 |
| SIGKILL：HTTP 已到商家 | 新 owner 核对原付款并恢复原交付，原凭据、一次记账保持 |
| 同一 operation 两个并发 attempt | 只有获胜 attempt Allow，失者不能借用其 permit |
| 升级后的 JS signer 中 Pause/Resume | 新 JS 执行同样受持久 epoch 约束 |

原 22 项真实 Pay MCP 测试继续覆盖 marker 后 HTTP 前 SIGKILL、Unknown、授权故障、身份隔离、篡改、Pause 各边界、原款恢复、丢失 ACK 和解释失败。它们在新版迁移启用后运行。商家、RPC、facilitator 均为 loopback；签名器只使用临时测试密钥；业务 Grant/Budget/Ledger 没有 mock。

复现：`python3 scripts/test-pay-integration.py` 运行集成组，`--all` 运行完整回归。runner 自动调用 `scripts/prepare-pay-compatibility.py`，从固定 Git 提交和带 SHA256 的源代码归档重建旧源码；快照放在编译输入之外，所用依赖明确链接当前锁定 node_modules。`round1-source.tar.gz` 仅含当时 src 文件，不含环境配置、钱包、账本或密钥；不是产品运行依赖。

`yosh-round2.patch` 是相对本轮开始时所有未提交工作的独立代码差异。Pay/SDK 本轮没有业务改动；通用补丁与依赖、提交说明见 `upstream-review.md`。真实进程与逐函数链见 `call-chain.zh-CN.md`。最终命令与数量见 `validation.json`。常规后端 build 只作工程验证，不是 staging 或安装验收。
