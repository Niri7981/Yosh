# Yosh × pay Phase 2：隔离生产模块集成

2026-10-18。本轮隔离端到端路径已通过；生产启用 **BLOCKED**。

## 实际代码

- `src/modules/payment/payment-execution-contract.ts`：最小 preparation / submission guard / response observation 合同。
- `src/modules/purchases/approved-payment.ts`：保留原 JS x402 默认实现；可注入执行器，但签名凭据持久化、submission marker、唯一首次携款 HTTP、独立核对与 Delivery 仍在 Yosh。
- `src/modules/payment/isolated-pay-execution.ts`：真实 Rust 子进程适配、严格 unsigned validator、离线测试 signer、唯一临时目录 owner 和内存执行代次。仅 `NODE_ENV=test`、Vitest、当前用户拥有的 0700 临时目录、Devnet fixture 与 loopback 网络可准入。
- `src/modules/app/app-runtime.ts`：内部依赖接线，Pause/退出使未完成代次失效。没有新增 Agent/UI 选择执行器或提供 signer 的 API，没有生产开关。
- `integration/pay-protocol-engine/main.rs`：在隔离 pay-mcp crate 中编译，实际调用 `pay_core::client::runner::classify_402`、`pay_kit::x402::client::exact::prepare_unsigned_payment`、`pay_core::client::receipt::decode_response_receipt`。

Yosh 原目录未修改；独立工作树继承了开始时的全部未提交基线。
本轮没有修改 `PurchaseLedger`、`purchase-contract.ts`、严格交易验证器、付款环境校验、npm 依赖及锁文件；没有新增数据库迁移或第二套经济账本。

## 重复运行

在本工作树执行：

```sh
python3 scripts/build-pay-protocol-engine.py --archive /Users/irin/Desktop/open-source/yosh-pay-integration-poc --test
python3 integration/pay-protocol-engine/check-hostile-challenges.py
python3 scripts/test-pay-integration.py
python3 scripts/test-pay-integration.py --all
npm run typecheck
npm run lint
npm run build
```

Rust 使用显式归档依赖及 vendor，离线、锁定构建；默认产品构建不包含 Rust 二进制，也不修改原 pay 工作树或归档。新环境需先准备 Yosh 已锁定的 Node 依赖与本机 Rust 工具链；当前工作树已包含独立 Node 依赖副本及构建产物。执行集成测试前必须显式构建 Rust helper，不自动下载或回退到旧 PoC。

基线：Yosh `f65c9bd30a2cad65493d2e70b15624be26e216ed` 加开始时未提交改动；pay `df57843e1f728fcc8ff8e42db78e0ad99372cd9d`；pay-kit `f8ef055b1d1c8ca8245f19bbca819faed9cfa058` 加归档 unsigned prepare 补丁。归档 manifest SHA256：`e6d2f2b0f4959df2acad3252852beb1f143caf856b97c76f8b1fd4d668827086`。实际源与二进制哈希在 `build.noindex/pay-protocol-engine/provenance.json`；这证明依赖来源，不代表已实现账本中的执行来源保护。

## 本轮独立验证

- 新生产模块集成：**12/12 PASS**。真实 Yosh stdio MCP、Connection 认证、AppRuntime、Spend Grant、Daily Authority、原子 reserve/claim、严格交易校验、原证据保存、marker、原付款核对与 Delivery 均参与；这些模块未 mock。
- 覆盖 Pause 先于 claim、claim 后 Pause/Resume、signer 执行中 Pause、签名后落盘前 Pause、落盘后首次 HTTP 前 Pause、首次 HTTP 后 Pause、重复 operation、Agent ACK 丢失、商家响应丢失、旧代次拒绝、关闭 Rust executor 后原 Unknown 恢复。
- marker 后 HTTP 前既有可控中断测试，也有真实 **SIGKILL 子进程**测试。后者绕过 catch/finally；重启后保留 Unknown、同一原证据与 200000 atomic 的原预占，不发送替代付款。
- 边界单元测试：**8/8 PASS**，含失败不回退 JS、无效准入、唯一 owner/过期 owner、凭据反射过滤与解释器失败后原交易核对。这组单元测试仅在外部钱包/JS builder/RPC 边界使用替身，与上述无业务模块 mock 的集成测试区分。
- 完整回归：**85 个 TypeScript 文件 / 1045 项 PASS**，另有 **3 项 Node 原生测试 PASS**；包括原生产 JS x402、Mainnet 策略 fixture、恢复、授权与真实 Codex 宿主的既有回归。pay 专属端到端入口使用真实 MCP SDK stdio client，本轮没有安装版/真实 Codex 对话中的 pay 购买验收。
- Rust：**3/3 单元测试 PASS**；**7/7 子进程运行检查 PASS**，拒绝非支持 flow、转移方法及 token program。typecheck、lint、build、diff 检查通过；前端静态产物未包含本轮 signer/executor 或敏感配置标识。

RPC、商家和 facilitator 是 loopback 假网络；买方与 sponsor 密钥是离线生成的测试密钥。测试在 macOS OS sandbox 中运行，只允许 loopback，禁止生产 Keychain/账本访问与原工程写入，临时 runtime 在结束后删除。没有真实链上提交或资金转移。

首次构建因跨工作树 node_modules 链接被 Turbopack 拒绝；改为本地依赖副本后构建通过。首次通配 Vitest 扫描误收既有 `node:test` 文件并报告无 Vitest suite；`--all` 用各自正确 runner 执行，最终全部通过。原 Vitest 配置未修改，直接通配 `npm test` 的既有 runner 混用问题仍保留；本轮完整回归使用上述明确命令。

## Controlled Gate 与尚未解除的阻碍

Rust 只接收未付款报价/unsigned prepare 参数与安全 receipt 字段；不接触买方私钥、签名 wire、PAYMENT-SIGNATURE 或可自由消费的 buyer signature。原始商家响应可能反射凭据，因此 Yosh 在交给 Rust 之前移除 transaction/error/extra 等未验证字符串。Rust 的解释结果不记账；Yosh 自行核对原 message 与完整原交易。

在当前 owner 内，Pause 与首次 HTTP 通过同步 gate → marker → submit 排序；签名中的迟到结果不能越过已失效代次。已启动 HTTP 的原交易仍允许核对。原凭据不交给 pay 发送，也不允许失败后签替代付款。

**尚未实现持久 external provenance、持久执行代次、旧 writer/回滚版本的拒绝写入保护。** 旧 `recoverUnsubmittedOnStartup` 可直接改写没有 payload 或 `SIGNED_NOT_SUBMITTED` 的记录，不读取新增 JSON 元数据；仅增加字段/side table 不能证明旧版安全。可靠保护会跨越用户本轮要求停止的数据库迁移边界，因此该部分没有实施。临时 owner 与内存代次不能外推为跨版本生产保证。

可进入代码审阅及另行授权的迁移设计；不能开启生产 pay 执行或 Mainnet。未访问生产钱包/Keychain、真实用户 Ledger，未安装/重建/启动已安装 Yosh.app，未修改 PR #514，未 Commit/Push。完成本轮后停止，等待审阅。
