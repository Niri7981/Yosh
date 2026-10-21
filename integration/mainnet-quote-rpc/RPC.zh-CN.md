# RPC 无签名预检

2026-10-20：已通过。此次只访问公开 Mainnet 网络/区块及 USDC mint 信息；没有访问钱包、Keychain 或账本，没有签名、模拟交易或提交交易，也未安装/修改 App。

## 原因区分

- **DNS 返回值 / 本地网络问题：** 原 `api.mainnet-beta.solana.com` 与官方当前文档中的 `api.mainnet.solana.com`，本机系统解析均返回普通公网 IPv4 与 `2001::/23` 特殊用途 IPv6 的混合结果。`dns.lookup(all:true)` 与 `dns.resolve6` 都观察到该类地址。不能由此断言 RPC 运营方返回了错误 DNS，也不能定位到具体本地代理/DNS 组件。
- **安全策略行为正确：** 现有 `safeResourceFetch` 要求所有 DNS 地址均为普通公网地址，故原端点在创建 HTTPS 请求前即以 `RESOURCE_DESTINATION_UNSAFE` 拒绝。不是 HTTP/RPC 服务错误；本轮未更改此策略，未忽略 IPv6、固定 IP 或另选 DNS 解析器。
- **代理：** 系统设置有 loopback HTTP/HTTPS/SOCKS 代理；进程没有 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 等环境配置。现有 `node:https` 传输没有代理实现，未改代理配置或新增代理路径。不能证明系统代理与异常 DNS 的因果关系。
- **替代公开服务：** PublicNode 官方运营方页面及 Allnodes 文档列出 `https://solana-rpc.publicnode.com/`。本机所有解析结果都是普通公网 IPv4/IPv6，原传输可以使用原始域名、完整 DNS 检查、地址 pin、系统 TLS hostname verification 连接。原有响应体/头部大小限制、超时与不跟随重定向全部保留。

## 最小修改与复现

`scripts/preflight-pay-mainnet.ts` 新增显式 `--rpc-url` 和 `--output`。默认端点未变，没有自动 fallback，没有修改 App/付款配置。URL 必须是规范 HTTPS，无用户名密码、query 或 fragment；输出仅记录 RPC origin，不记录可能含凭据的路径。仅发送编译期限定的三个只读 RPC 方法。

```sh
node --import tsx scripts/preflight-pay-mainnet.ts --live \
  --rpc-url https://solana-rpc.publicnode.com/ \
  --output integration/mainnet-quote-rpc/rpc-publicnode-preflight.json
```

实际验证：`getGenesisHash` 严格匹配已锁定 Mainnet genesis；`getLatestBlockhash` 返回合法 32 字节公钥形态 blockhash 及安全整数高度；对原生 USDC mint 的 `getAccountInfo` 验证 Tokenkeg owner、规范 base64、82 字节 Mint、initialized=1、decimals=6。三个调用均成功。报告始终 `readyForRealPayment:false`。

`rpc-publicnode-preflight.json` 同时包含当时真实公开报价的检查结果。此文件产生时，报价兼容修复尚未合入，故其中报价仍是上一阶段的阻塞判断；最终合并预检以本轮统一 final evidence 为准。该历史报告不应被覆盖为事后成功。

## 证据与限制

- `dns-diagnostics.json`、`publicnode-initial.json`：修改脚本前的真实诊断和原安全传输成功证据。
- `rpc-publicnode-preflight.json`：三项只读 RPC 完整成功。
- `rpc-labs-preflight.json`：原端点仍拒绝，验证未绕过保护。
- `rpc-unit-tests.log`：新增 16 项 RPC 检查及现有 safe-fetch 23 项，共 39 项通过；`rpc-lint.log` 无错误。
- `rpc-preflight.patch`：本子任务独立 diff；`rpc-source-notes.json`：主要来源。

公开共享 RPC 的这次可达不保证之后可达、生产 SLA 或正式资金执行安全。它不启用主网 Authority、Keychain、ControlledExecution 或生产升级流程。

主要出处：[Solana 公开 RPC 文档](https://solana.com/docs/references/clusters)、[PublicNode 运营方](https://solana.publicnode.com/)、[Allnodes RPC 文档](https://help.allnodes.com/en/articles/17001591-solana-gun-rpc)。
