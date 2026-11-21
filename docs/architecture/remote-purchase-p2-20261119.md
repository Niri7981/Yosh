# P2：远端 Agent 用自己的 Grant 在共享模拟钱包购买

2026-11-19，隔离开发版。本阶段仅实现远程新增购买的**模拟**版本。实际可运行的测试商品为 `market-snapshot`（固定行情样本），价格为 **3.000000 模拟 USDC**。没有外部商家、RPC、交易签名或链上付款，不能据此宣称已接入真实支付渠道。本次不涉及离线购买、Rust 重写或订阅权益。

**用户实际授予两件不同的事。** 首先在 Mac 上确认这个 Agent 可以申请购买，得到独立购买凭据。然后在本机单独确认它的 Spend Grant：指定成员、商品、单笔上限、总额和到期时间。配对本身不能花钱，旧的 P1 只读凭据也不会升级。所有参与者共用该沙箱的一本钱包账本和日额度。撤销 Grant 后不能新买，但有效购买连接仍可查询自己的原单；撤销连接则连查询也失效。一次配对对应一个成员，不能指定其他成员或 Grant 来付款。

| 远端工具 | 行为 |
|---|---|
| `request_purchase({requestId, resourceId:"market-snapshot"})` | Mac 本地校验购买凭据和当前成员 Grant，在共享预算内原子预占，模拟成交并保存结果。请求中不接受金额、地址、URL、支付渠道或其他 Agent 身份。 |
| `get_purchase({requestId})` | 按原标识查询本成员购买，不发起购买。回执包含付款与交付状态，并标注模拟。请求超时先查原标识；需要重试时仍用同一标识。 |
| P1 两个只读工具 | 保持原有独立权限。同钱包内，经授权的账单读取者可以核对是谁用哪个金额买过；具备共享结果读取权限的成员可以复用交付。购买凭据本身不能读取其他成员的订单。 |

**运行方式（Mac 开发机，Node 24）。** 沿用 P1 的中继、Mac 主动建立的 SSH 连接及原生系统确认。新增的沙箱命令只在系统临时目录创建全新私有目录；每次 init 都是全新的模拟钱包，不会打开已安装 App 的数据。系统可能清理临时数据，这不是生产存储。

```sh
npm run build:remote-purchase-sandbox
node build.noindex/remote-purchase-sandbox/sandbox.cjs init --daily-limit 5000000
node build.noindex/remote-purchase-sandbox/sandbox.cjs serve --data-dir <init返回的目录> --port 17549
```

上述日额度是最小单位整数字符串，5000000 代表 5 模拟 USDC。重启时使用原目录和 `serve`，不要再次 `init`。按 [P1 运行手册](remote-read-p1-20261119.md) 建立连接，Mac 端的 `connect --backend-port` 在此处改为 **17549**。中继只转发固定 MCP 路径；配对和 Grant 管理仅可从 Mac 的签名管理通道发起。

```sh
# 输出目录需为用户拥有的 0700 私有目录。原生确认后凭据仅写到新的 0600 文件，不输出到终端。
node build.noindex/remote-read/remote-read-owner.cjs pair --backend-port 17549 --data-dir <沙箱目录> \
  --label 'Research agent' --scope purchase --token-out <绝对私有路径>/research.token

# 示例：单笔最多 3，累计最多 6，另受共享额度 5 限制。到期时间用 Unix 毫秒（从现在算大于 1 分钟、最多 7 天）。
node build.noindex/remote-read/remote-read-owner.cjs grant --backend-port 17549 --data-dir <沙箱目录> \
  --id <配对ID> --resource market-snapshot --single 3000000 --total 6000000 --expires-at <到期毫秒>

node build.noindex/remote-read/remote-read-owner.cjs revoke-grant --backend-port 17549 --data-dir <沙箱目录> \
  --id <配对ID> --grant-id <Grant-ID>
```

**验收范围。** [独立端到端测试](../../tests/integration/shared-account-remote-purchase.test.ts) 使用正式代码的 HTTP MCP 客户端路径、OpenSSH 和临时端口。两名成员各自有足够 Grant，同时各买 3、钱包限额 5 时仅一笔成交，按已付事件和获胜成员的 Grant ID 对账；无 Grant、越权、超额、暂停和撤销时不产生新模拟扣款。另测 Mac 已记账但购买者没收到响应的情况：重新连接并重启后查询原单，再用原请求 ID 重试，无第二笔扣款。此处“未知”是客户端没收到响应；不冒充外部支付提供商结算未知，也没有测试真实资金恢复。本地确认的通过/拒绝使用测试注入，原生确认另有编译和内容测试，没有代用户进行系统认证。

**2026-11-19 的 P2 验收记录。** 本轮隔离范围内无 BLOCKED。常规测试 1,525 项通过；远端购买、P1/P0 宿主、安装包入口和支付协议专项 19/19 通过。通过类型检查、lint 和构建；打包后的沙箱完成初始化、重启和本机签名管理查询。另有[执行状态回归](../../tests/unit/remote-purchase-execution.test.ts)：人为构造付款状态未知时只查询原单、保留预占；旧 Grant 或旧的确认不能使撤销的消费权限复活。

**发布边界。** 本次未启动、替换正式 App/插件，未部署公网服务，未开通 Devnet 或 Mainnet 远程支付。实际商家结算、真实宿主接入，以及线上资金恢复仍需要后续单独验证；Dot、Grok 真机验收按用户要求暂缓。
