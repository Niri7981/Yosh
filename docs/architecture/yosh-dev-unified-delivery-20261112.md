# 单一 Yosh Dev 插件交付（2026-11-12）

> 历史实现与验收快照；文内“当前”、版本、进程和未完成项均指各段记录时点。最新插件 0.2.3 主网成功购买及本次归档验证见 [插件版里程碑](plugin-milestone-20261112.md)。
## 用户确定的版本策略

日常写代码、修改、测试和验收均更新同一个 Dev 插件。Mainnet 与 Devnet 是插件内明确选择的环境，不是不同开发插件。Dev 验收满意之后再单独发布正式版本；本次没有正式发布、提交或推送。

固定 ID 为 `yosh-local-dev@yosh-standalone-testing`，显示名称 **Yosh Dev — 开发验收版**，当前版本 **0.2.3**。沿用既有本地 marketplace，不按日期新建安装入口。独立的 `yosh-mainnet@yosh-mainnet-local` 已移除。旧原生 Dev App 和历史源文件不删除。

## 实际安装

- 插件缓存：`~/.codex/plugins/cache/yosh-standalone-testing/yosh-local-dev/0.2.0`。
- 源 marketplace：`~/.codex/plugins/yosh-local-marketplace-c12`，保留上一个包供回退。
- Dev 数据继续使用 `~/Library/Application Support/Yosh Local Authorization Dev`；显式 `yosh-dev upgrade` 校验原运行包、正常停止旧服务、持有启动和服务锁后原子切换同契约版本。升级收据与旧运行包保留；不删除数据库、不重新配对、不重建钱包。
- Mainnet 继续使用 `~/Applications/Yosh.app`、13449 和原 Mainnet 数据。用户正常退出主 App 后，已通过 `scripts/install-macos-app.sh --stable-app` 安装共享后台的 5 文件最小补丁并重新打开；核对实际进程路径与端口。原生执行代码、Node、MCP 包装器和 Pay 二进制保持一致（App 重签名会改变签名字节）。
- 原安装 App 完整保存在 `build.noindex/mainnet-web-delivery-20261112/previous-install/Yosh.app`。

## 防止覆盖已有付款链路

当前 HEAD 比实际安装后台包含更多 Devnet 开发代码，不能直接打包覆盖。使用安装清单记录的 canonicalBase、通知补丁和上一版 Grant 修复重建安装基线。只有构建结果在归一化 esbuild 模块路径标签后与原已安装后台相同，才加入网页 Grant 的 5 文件改动。可复现基线和交付候选位于 `build.noindex/mainnet-grant-installed-20261112-v2`。

安装验证额外校验 `localGrantWebUpdate` 的父 backend 哈希、5 文件范围、新 backend 哈希，以及保留的原生代码/Pay 二进制。旧 Grant 修复的验证仍生效。安装脚本按实际 App 路径检测运行进程，独立 Dev App 同名可执行文件不会误挡；原 App 存活或原端口占用仍拒绝安装。

## 实际验证

- 当前代码 typecheck、lint、build 通过；Next 保留两条已知动态文件 tracing 警告。
- 58 项网页/授权/网络路由单元测试、1 项本地授权集成测试、20 项当前 Pay 主网受控测试通过。
- 实际安装候选的 typecheck、31 项原 App/网页 Grant 回归、20 项 Pay 主网受控测试通过。候选初次使用历史旧测试曾因其仍要求旧 operator receipt 失败；替换为现有 Grant 热修复对应测试后通过，没有放宽当前付款要求。
- 7 项 standalone 包装验证、7 项安装验证通过。运行包升级测试覆盖原包损坏拒绝、停止后原子切换、数据与控制文件不变、并发重复升级幂等。
- 已用真实 Codex app-server 加载同一个安装源的插件，主网/测试网 get_spending_status 均成功；缺少 environment 被拒绝。所有 wallet/API/payment 调用显式传环境，不依赖网页当前选择，不在错误时切换网络重试。
- 已安装网页实际提供 Mainnet/Devnet 选择，两种环境的认证 /state 均成功。Mainnet 返回原钱包和两个注册 API，Devnet 返回隔离钱包。Mainnet 不开放网页日额度/暂停修改。
- 升级前后两套数据库的 purchases、spend_grants、original_payments、resource_registry、wallet_accounts、monetary_controls 内容指纹一致。没有实际创建 Grant，没有付款，也未改变原暂停/额度状态。

## 后续迭代

每次构建使用新内容哈希运行目录、提升插件版本，但保留上述插件 ID 和 marketplace。执行显式兼容升级，再将通过验证的插件包更新到同一个源目录，使用 `codex plugin add yosh-local-dev@yosh-standalone-testing --json` 更新安装。若运行数据契约改变，必须另做迁移验证；不能绕过版本保护或重建数据。主网共享接口有变化时继续以原安装产物为基线作最小更新，不把 Dev 工作树整体覆盖进原 App。

用户仍需在真实页面检查视觉呈现并亲自确认新 Grant；自动化中的确认使用 fixture，不代表实际主网授权或付款验收。旧聊天若仍保留已移除插件的工具集合，请重新选择新版 Yosh Dev 或在新聊天中使用它。

## 0.2.1 Mainnet 验收修正

用户现场核对发现 0.2.0 首次页面默认读取 Devnet、原生确认未展示付款钱包、LA 身份验证理由仍称“测试设置”。本次先在真实网页脚本边界和冻结申请边界增加失败测试，确认复现后修正。

- `open_local_settings({environment: "mainnet"})` 返回 Mainnet 直达链接；Devnet 也有显式参数。未指定环境时先显示网络选择，不读取任一 `/state`。首次加载不自动选择测试网，金额输入不预填测试默认值。
- 后台把 `payerWallet` 加入冻结申请的规范化内容和确认摘要，主网提交前检查其与当前钱包一致。旧申请缺少该可选字段仍可读；缺少付款钱包的旧主网申请不能作为新确认提交，需要重新发起。原 Grant 和付款记录不迁移、不改写。
- 原生确认显示完整付款钱包地址。主网身份验证理由为“主网真实资金授权”；测试网授权和测试设置保留各自语义。主网确认缺少/无效钱包地址时拒绝。
- 本次 55 项网页/授权单元测试、1 项本地授权集成测试通过；最小安装候选 typecheck、31 项原 App/Grant 回归及 20 项 Pay 主网受控测试通过。当前工作树 typecheck/lint/build 通过，保留原有两条 Next tracing 警告。
- Swift 同源展示测试覆盖付款钱包、主网身份验证理由、缺少/非法钱包拒绝和 Devnet/control 文案；没有打开 GUI 或调用认证成功路径。实际安装的确认组件与构建/源清单哈希一致，`--check` 返回系统认证可用且 confirmationPerformed=false。
- 已通过实际 Codex app-server 调用安装源中的 0.2.1 工具，并执行 HTTP 实际提供的 `/app.js`：Mainnet 链接仅 `/session(mainnet)`、`/state(mainnet)`；普通入口仅 `/session`。该检查使用最小 DOM 边界，不宣称真人窗口验收完成。

0.2.1 插件已原位安装。主网后台候选为 `build.noindex/mainnet-web-delivery-021-20261112/Yosh.app`，运行包为 `build.noindex/yosh-dev-021-20261112`。用户回复正常退出后，已通过现有安装脚本更新原 App 并重新打开，原生和 backend 进程路径均为安装位置。实际主网后台与 0.2.1 最小候选逐字节一致；实际提供的网页脚本再次通过 Mainnet 直达/未选网络不读状态验证，运行目录和确认组件哈希已核对。升级前后原钱包、授权、额度、API 和历史购买内容指纹一致。上一个安装包保存在本次交付目录的 previous-install/Yosh.app。没有创建实际 Grant 或付款；真人界面验收尚未完成。


## 0.2.2 交易版本协商修复与主网尝试

商家最新报价允许 Solana transactionVersions `[0,1]`，安装的 Pay SDK 默认选择最高版本，Yosh 当前交易解析/校验链路仅支持 v0。普通 controlled 购买和恢复所用 unsigned-preflight 入口现均把 `Some(TxVersion::V0)` 传给官方 SDK；原商家报价、金额、收款方和授权内容不改写。商家允许 v0 时选择 v0，仅允许 v1 时在执行前拒绝。这是声明当前 custody 能力上限，未新增 Agent 手动指定交易版本的 MCP 参数，也未实现 Yosh 的 v1 付款链路。

- 先用原实现复现两处真实 SDK 构造回归失败，再修复；Rust 10 项、构建与安装 Python 23 项、主网授权/签名 TypeScript 42 项通过。版本用例覆盖 `[0,1]`、`[0]`、`[1]`，验证全零签名及拒绝时不进入 execute。typecheck、lint、build 通过，Next 保留原有两条 tracing 警告。
- 首次依赖构建因并行测试 fixture 修改导致源快照变化，被构建校验拒绝，没有安装。最终从冻结源码在全新目录重建：`build.noindex/standalone-dependencies-v0-final-20261112`。
- 新 Dev 运行包为 `build.noindex/yosh-dev-022-20261112`，运行目录摘要 `fcbe88c4ea795dfffe967694e339ae9c69a452c0e28c30ed9f2c638945efd6a4`。同一 marketplace、同一插件 ID 已原位更新至 0.2.2。
- Mainnet 候选 `build.noindex/mainnet-pay-v0-022-20261112/Yosh.app` 只替换 `pay-mcp`，新增链式 `payVersionCompatibilityUpdate`。原 backend、Node、MCP 包装器、protocol-engine及原生代码保持；旧 provenance 不重写。用户正常退出后，经现有安装脚本更新同一 App 并重新打开。安装与候选整树一致，新 Pay SHA256 为 `ef04a20cbe6ecbd63280bcbcf2ab9e98502f47699006cbc0af14bf53fda17823`。安装前后旧购买、Grant、原付款、API、钱包及额度表内容指纹一致。
- 新安装候选对实际商家报价的未签名 v0 构造及原后端绑定校验通过；未用该探针签名/付款。独立只读 review 无阻塞发现。

用户随后授权以 v0 尝试同一 Agent402 API、上限 0.001 USDC。当前聊天旧插件进程未自动重载（setup 返回 LOCAL_TOOL_UNAVAILABLE），因此使用真实 Codex app-server 新加载已安装 0.2.2 插件，核对新运行包与新 App Pay 进程后调用插件 curl。没有绕过 Grant/额度/后端，也没有通过探针付款。

操作 `yosh-dev-mainnet-v0-20261112-01`，公开购买 ID `pay_062cad64271b3abd7e7de0796549a0b282f9776601070c0ba9eefc109cd4`。工具返回 `CONTROLLED_BACKEND_REJECTED`，账本为 FAILED / NOT_PAID，phase CLAIMED、原付款为空、无交易或保存的签名 payload，支付和预占均为 0。事件从 PAYING 到 FAILED_BEFORE_SUBMISSION 相隔约 9.27 秒。此后没有恢复执行或新建第二笔购买。

RPC 读取仍不稳定：本轮报价预检先返回 RPC_PAYMENT_ASSET_UNVERIFIED，随后一次 ready；购买后余额读取连续返回 USDC_BALANCE_UNVERIFIED。最后一次成功读取余额为 99000 原子单位（0.099 USDC），末次状态无法实时核验余额。执行异常仍被后端归并为 CONTROLLER_INTERNAL_ERROR，因此不能把后续 RPC 失败断言为这一笔 execute 的唯一原因。完整主网付款验收尚未通过。证据保存在本机 build.noindex 的交付与插件验收目录；没有提交、推送或正式发布。
