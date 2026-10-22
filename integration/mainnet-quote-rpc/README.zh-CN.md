# 本轮完成：真实报价兼容与 RPC 无签名可达

只修改当前隔离 Yosh/Pay 工作树，范围仅为用户指定的两个阻塞。完成后停止；生产继续 BLOCKED。

## 实际完成

1. Pay 原始 `do_paid_fetch` 不再把所有 extensions / queryless resource 一概拒绝。`pay-core::client::x402::payment_required_value` 按锁定 SDK 相同的有效 PAYMENT-REQUIRED、legacy、body 顺序保存完整原 envelope；协议解析和报价选择仍由原 SDK 完成。`authority::controlled_envelope` 重新以 SDK 核对所选 accepted、resource、extensions、唯一性，并把原始 JSON 放进 controlled-only `SpendRequest.payment_required`。未接 controller 时不增加 Authority wire 字段。
2. route resource 必须同 origin、同精确 path，无凭据/fragment；若包含 query，必须与完整请求一致。queryless route 只表示资源身份，绝不替换实际 HTTP URL。原来的 method、完整 query、headers、body 继续属于不可变请求。
3. Yosh `pay-authority-adapter.ts` 使用完整 `payment_required`，不再重造仅含 request URL/单个 accepted 的 challenge。授权事实 digest 覆盖完整 envelope；已有 `resourcePaymentBinding` 把它与钱包/网络/请求绑定后存入唯一 Ledger。重放在任何原付款恢复前，额外比较已保存完整 challenge 的 hash；改变 resource metadata、extensions 或未选 alternative 也拒绝。无需新 Ledger、表或 migration。
4. `resource-challenge.ts::assertPayControlledExtensions` 与当前 SDK typed echo 语义保持一致：真实 Agent402 的 bazaar、builder-code 透传，payment-identifier.required=false 原样保留；required=true、非法字段类型及 SDK 会规范化/丢字段的形状仍拒绝。不生成新 ID，不删报价字段。原始付款 payload 对 resource/extensions 的严格相等和 unsigned transaction 的经济绑定检查保持。
5. 明确选用运营方公开节点 `https://solana-rpc.publicnode.com/` 完成三项只读 RPC。原 `safeResourceFetch` 的全 DNS 地址安全校验、地址 pin、TLS hostname verification、响应限制、超时和无重定向均未改变。没有改系统 DNS/代理，没有固定 IP、忽略 IPv6 或自动 fallback；仅给预检脚本增加显式 RPC/output 参数。

## 真实公开预检

`live-final-preflight.json` 是合并修复后的当前证据：取得 Agent402 真实 Mainnet V2 exact 原生 USDC 1000 atomic（0.001 USDC）报价，完整 route/三类扩展校验通过；分别记录 requestHash、quoteHash、challengeHash、组合 binding hash。它们是预检绑定证据，不是花费许可。

RPC 的 getGenesisHash 精确匹配 Mainnet；getLatestBlockhash 返回合法 blockhash/高度；getAccountInfo 验证原生 USDC mint 的 Tokenkeg owner、82 字节、已初始化和 6 位精度。原 Solana Labs 域名的本地 DNS 混合特殊 IPv6 仍被正确拒绝，不能把它归因于 RPC 服务本身或断言具体代理/DNS 组件。详细区分与官方来源见 `RPC.zh-CN.md`。

复现（只读，完全不签名付款）：

```sh
node --import tsx scripts/preflight-pay-mainnet.ts --live --rpc-url https://solana-rpc.publicnode.com/ --output integration/mainnet-quote-rpc/live-final-preflight.json
```

## 回归与证据范围

- `quote-ts-red.log`：修改前真实 route/ext 预检回归 3 项失败；`quote-ts-green.log` 修复后 16 项通过。
- `pay-route-red.log`：原 Pay blanket guard 无法通过真实 MCP route/ext 正例。
- `authority-envelope-red.log`：旧 Yosh adapter 无法接收完整 SDK envelope；该测试后已恢复修复代码。
- `pay-yosh-integration.log`：51 项真实 Pay MCP / Yosh Authority、Ledger、持久恢复边界定向测试通过。新用例保存完整 route/ext，核对原 payload，并覆盖同进程及重开后的 resource、extension、alternative 篡改拒绝，原签名/付款次数、预算和原款证据不变。全部使用临时库、离线测试密钥和假链，受现有 OS sandbox 限制。
- `preflight-tests.log`：55 项报价、RPC 和既有安全 HTTP 测试通过。
- `full-regression.log`：93 文件 1125 项、独立 Phase 2 的 15 项、Node native 的 3 项全部通过。
- `pay-regression-final.log`：169 项通过，原有 1 项 helper 忽略；`pay-core-x402.log`：41 项通过。Pay-only Replay fixture 只是原 SDK/MCP parser 合同证据，不能当真实 Yosh 授权或 Mainnet 购买成功。
- typecheck、lint、backend build、隔离 Pay host build、clippy、pay-connect check、fmt 均通过；最终 Pay 二进制的 source hash 与当前源码一致。
- `yosh-quote-rpc.patch` 与 `pay-quote-compatibility.patch` 为本轮独立增量，均通过 reverse apply-check。起始已有修改保留。文件清单见两个 changed-files JSON；SDK 行级语义见 `sdk-binding-notes.md` 与 `pay-quote-evidence.md`。

## 精确停止点

本轮两项目标已通过，但没有启用 Mainnet 付款。Mainnet 注册资源/Authority、受控 Keychain signer 与最终真实发送通道的接线，以及停旧启新和原款恢复的交付验收，仍需后续明确授权范围完成。随后还必须由用户具体确认商家、用途、金额、网络、钱包，才能真实签名付款。

没有调用生产 Keychain、真实钱包签名、Mainnet 付款、生产 Ledger 访问或迁移；没有更新正式或 Dev App、Codex 配置、系统网络配置；没有 Commit/Push。不新增付款协议，不研究旧版长期共存，不继续下一阶段。
