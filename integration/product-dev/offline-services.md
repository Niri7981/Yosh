# 持久离线商家与 RPC

实现：`src/modules/pay-dev/offline-services.ts`。独立于 Vitest，不依赖原 fixture。

```ts
await startOfflineServices({
  directory, // 预先创建的本用户 0700 独立目录
  buyer, // 只有离线开发钱包公钥
  merchantPort: 13050, // 可传 0，首次随机后持久复用
  rpcPort: 13051,
  publicOrigin: 'http://127.0.0.1:13049', // 可省略；实际 App 后端代转商家
});
// 返回 origin、merchantOrigin、rpcUrl、merchant、sponsor（均公钥/URL）及 close()
```

仅监听 `127.0.0.1`，没有任何出站网络调用或 Keychain 访问。买方私钥不传入服务。商家 sponsor 是服务首次启动生成、仅供离线链使用的密钥；不是用户钱包。宿主负责独立 App 后端目录锁，服务另有进程内重复启动拒绝及固定端口占用拒绝。此模块不提供生产模式。

`offline-network.json` 是模拟链与商家事实：离线 sponsor 身份、merchant 公钥、原端口、已签发 blockhash、已完成交易 wire/签名、原商家交付数据。没有 Agent、Grant、授权、预算、预占、claim 或购买状态，不代替唯一 PurchaseLedger。文件强制 0600，目录 0700，拒绝 symlink、钱包身份和 public origin 改变。保存采用独占临时文件、文件 fsync、原子 rename、目录 fsync；遗留临时文件不被当作已确认事实，重启不会因旧临时文件名冲突失败。

三个现有 Resource 的报价保持原价格：snapshot 为 200000、analysis 为 20000000、risk 为 50000 最小单位。源标签明确离线测试；所有交付经过现有 Resource schema。初始模拟余额为 10 测试 USDC；离线 sponsor 的模拟原生余额为 1 SOL（仅供预检，不连接真实链）。每笔成功原交易只扣一次模拟链余额。原交易 replay 及重启后交付返回第一次持久保存的响应。analysis 价格超过初始余额，适合观察超预算/余额拒绝。

同 Resource 的 accepted offer 和 memo 在重启前后稳定，保持原 operation 重放事实；每次 unsigned prepare 请求 `getLatestBlockhash` 均签发不同并先持久保存的 blockhash，因此不同 operation 即使目标和报价相同也得到不同交易。恢复继续使用原 wire，不生成替代付款。

商家使用现有 `createSignedPaymentIdentity` 验证真实买方 Ed25519 签名及完整 transfer/memo/program/fee-payer 绑定，之后才加离线 sponsor 签名，并再次核对完整签名。RPC 禁止 `sendTransaction` 等提交方法。模拟交易仅在商家收到经验证的原支付凭据后确认为成功；原 wire 可由 Yosh 独立读取并核对。

测试：`tests/unit/pay-dev-offline-services.test.ts` 共 5 项通过（本轮独立运行）。覆盖重启原端点/offer、blockhash 唯一；有效签名/篡改拒绝；原款一次扣除与原交付跨重启；三个 UI 报价 public origin；错误身份、权限、symlink、重复服务及非 loopback origin 拒绝；真实 `runPaymentPreflight` 对离线 sponsor 的 SOL 和 Token Account 检查。测试不证明真实链结算或生产安装，也不代替真实 Codex + AppRuntime 验收。

局部日志：`offline-services-tests.log` 为修复后 5/5；`offline-services-preflight-red.log` 是先构造故障用例时预期的 1 项失败历史，不代表最终回归失败。父任务另统一保存完整测试结果。该模块的局部 Vitest 和 ESLint 检查通过；父任务其它正在编辑文件的暂时类型错误未被本模块掩盖。

首次真实产品接线发现 sponsor 原生余额原为 0，导致现有预检在签名前拒绝；已先增加真实预检失败用例（RED：`FEE_PAYER_SOL_INSUFFICIENT`），再将离线 sponsor 的模拟余额设为 1 SOL，5 项局部测试全部通过。旧失败 operation 不被替代或自动重试；新验收 operation 由父任务明确指定。


独立真实接线检查（无 Vitest）：在全新私有临时 `Yosh Pay Dev` 目录和独立 HOME、NODE_ENV=production + YOSH_PAY_DEV=1 下，运行真实 `startPayDevelopmentBackend`、真实 AppRuntime、编译 Pay MCP 子进程、真实 Grant 与预算。明确的新测试 operation `offline-new-runtime-case-1` 返回 `isError=false`；Ledger 为 PAID / COMPLETE，原签名证据存在，模拟余额 10000000 → 9800000。使用临时 13949/13950/13951 端口，正常退出后清理了该独立测试目录；没有运行真实链付款。

同一 Pay 进程再次提交同 operation 会被现有 PR #514 `Operations::start` 的 `OPERATION_ALREADY_STARTED` 守卫直接拒绝，不到 Yosh Adapter。实测原交易仍仅 1 次、Ledger 保持 PAID / COMPLETE、余额仍 9800000。父任务决定保留该原有防重守卫；独立新宿主进程才能进入 Yosh 的同原款恢复/交付重放。该行为应在用户体验说明中明确，避免将同进程拒绝误认为付款失败而另建付款。此轮没有修改上游守卫。
