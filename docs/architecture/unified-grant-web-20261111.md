# 统一 Grant 网页（2026-11-11）

> 历史实现与验收快照；文内“当前”、版本、进程和未完成项均指各段记录时点。最新插件 0.2.3 主网成功购买及本次归档验证见 [插件版里程碑](plugin-milestone-20261112.md)。
> 2026-11-12 已更新用户安装的单一 Yosh Dev 插件及原 App 的共享授权接口。以下为 11 月 11 日候选阶段记录；安装事实与当前限制以 [最新交付记录](yosh-dev-unified-delivery-20261112.md) 为准。旧 HEAD 候选不得用于覆盖安装，当前交付使用已复现安装版的基线。

## 本次实现

现有本地网页新增 Mainnet / Devnet 选择。切换清除旧网络的金额、API 与确认内容；正在冻结或确认时禁止切换。主网展示真实 USDC，测试网展示 Test USDC。主网未接入时拒绝操作，不降级到 Devnet。

Devnet 保留原本地授权流程。Mainnet 通过固定 loopback 地址 13449 的新增 `/api/app/local-grants` 管理入口，复用原 AppRuntime 与原账本。连接从原 Mainnet 目录读取既有身份，校验私有文件权限、选择环境和运行时描述；请求及响应沿用原 HMAC 协议。浏览器和 MCP 不获得管理凭据。桥接不启动第二个主网后台，不切换 App 的执行环境，不复制钱包或账本。

Grant 先冻结网络、资产、API、收款方、Agent 连接、金额和有效期；主网还绑定当前钱包身份。网页通过独立的系统确认组件取得用户确认后提交。后台在同一账本事务内重新检查绑定、创建 Grant 并消费申请。重复确认返回原结果；请求结果未知时只读原申请，不自动重发创建。旧 App 的管理接口保留，未使用网页确认参数的旧调用行为保持兼容。主网网页仅增加创建 Grant；不开放暂停、日额度、钱包创建等管理能力。

## 验证结果

- 55 项单元测试通过：原 App 入口与网页 Grant 共存、付款签名边界（模拟）、身份/环境不匹配拒绝、拒绝确认、重复确认、重启后原授权和新申请可读、私有连接与响应认证等。
- 1 项本地授权集成测试通过：Devnet/Offline 旧流程、跨会话、错误环境请求与确认边界。
- 20 项 Pay 主网受控路径集成测试通过：当前 Grant 绑定、原付款绑定、恢复等。使用隔离 fixture，没有真实付款。
- `npm run typecheck`、`npm run lint`、`npm run build` 通过。Next 保留两条原有 pay-mainnet-control 动态文件 tracing 警告。
- 独立 Swift 系统确认组件编译通过；本地插件运行包、插件 ZIP 与 rc.5 身份的主网后台候选 bundle 构建通过。
- 正式主网工具只读检查：原钱包、余额、日额度、暂停状态、原过期 Grant 和四条历史购买仍可读取；不代表已验证真实付款。

## 交付与尚未完成项

当前源码在插件工作树；该工作树已有其他未提交的插件开发改动，不能把整个工作树直接当作本次最小正式升级。

候选产物：

- `build.noindex/unified-grant-web-20261111/`：本地授权运行包。
- `build.noindex/unified-grant-plugin-20261111/yosh-local-dev.zip`：插件候选包。
- `build.noindex/unified-grant-mainnet-20261111/server.js`：主网后台候选 bundle。
- 同目录 `inputs.json`、`validation.json` 与 `installed-baseline.json`：依赖输入、验证摘要和当前安装版文件指纹。

**尚未安装候选包、替换正式 App 或重启用户后台；当前用户页面仍由旧运行包提供。** 未在真实 Codex Desktop 中完成新版本端到端验收，未创建实际主网 Grant，未付款。

AGENTS.md 的交付规则要求 Dev 验收通过后再更新正式版。下一步应在隔离验收中确认网页双网络呈现与确认流程，并筛选本次主网后台所需的最小源代码差异。正式应用前保留原安装产物，正常停止原后台后再更新，核对新运行路径和钱包/授权/额度/账本读回；出现身份或数据不一致则停止交付，保留原产物供回退。不得用重建数据库或修改 owner 文件强行绕过现有 standalone 版本兼容保护。

## 最小主网候选补充

为排除插件工作树里的其他未提交改动，`scripts/build-mainnet-grant-overlay.py` 从 HEAD 提取了仅涉及 5 个源码文件的最小主网后台候选。原生界面、MCP 包装器、支付执行器与其余业务代码沿用 HEAD。此最小候选的 typecheck、5 个文件的 lint、31 项原 App / Grant 回归和 20 项 Pay 主网受控路径回归全部通过。

后续正式交付优先复核 `build.noindex/mainnet-grant-minimal-20261111-v2/candidate/server.js`，同目录 `provenance.json` 记录基线提交与 5 个源码文件哈希。前述完整工作树后台 bundle 仅作构建验证，不作为正式替换候选。
