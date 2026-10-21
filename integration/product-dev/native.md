# 独立 Yosh Pay 开发版原生交付

本轮仅复用现有 SwiftUI/AppKit 窗口、管理 API 客户端和生命周期，不改正式安装。

- App bundle：`build.noindex/pay-dev-delivery/Yosh Pay Dev.app`，独立 `com.yosh.pay-development` 和必须同时为真的 `YoshPayDevelopment` plist。
- 原生独立锁、日志、管理凭据、后端 Ledger 目录：`~/Library/Application Support/Yosh Pay Dev`。拒绝符号链接和非当前用户目录；目录 0700、随机 management-token 0600。绝不加载正式管理 Keychain 凭据。
- 开发会话免 App PIN：仅 AppDelegate 明确检测独立 bundle 后注入，Settings 标为开发无资金和 Offline test key。正式 App 的 PIN/Keychain 逻辑不变。
- 后端固定 loopback 13049；忽略继承的端口/数据目录，HOME 指向独立 home。原生仍验证 HMAC、PID、dataDirectory、service/core readiness，端口冲突失败，退出等待真实后端安全停止。
- 后端由包内 `sandbox-exec` profile 启动，只许 loopback 网络，禁系统 security 工具、securityd、真实 Keychain、正式数据目录和 Solana/Pay 配置。该 OS 限制覆盖其后代；后端自身另有开发准入检查。
- 包内 Node 24.21.0 官方 archive 固定 SHA-256；两个 esbuild 入口、Rust Pay MCP 和协议解释 helper 随包交付。运行不需要源码、node_modules、Homebrew、归档 vendor 路径或开发机绝对路径。
- 构建入口 `scripts/build-yosh-pay-dev.sh`，不安装、不注册 Codex、不创建钱包或访问正式 Ledger。

## 已验证

- 原生 Release build 当前通过。
- `tests/native/backend-launch-configuration.sh` 原有配置/管理传输边界通过，并新增独立身份双 gate、固定端口、私有凭据重启复用、权限拒绝、symlink 拒绝、sandbox 必需性。
- App Lock 全部原测试和新增显式开发会话不读取失败凭据 store 的测试通过。

- 完整独立 bundle 已构建，`codesign --verify --strict` 通过。包内官方 Node 仅依赖 macOS 系统库；没有 Homebrew runtime 依赖。
- 包内 sandbox profile 实测：到文档保留外部 IP `192.0.2.1:443` 的连接得到 `EPERM`；执行 `/usr/bin/security help` 得到 `EPERM`，不触及真实 Keychain。
- 独立 App 实际启动（2026-10-19），精确开发 App 进程 PID 95232、其直属后端 PID 95239；仅 loopback 13049/13050/13051 监听；独立私有生命周期日志依次确认 `spawning → httpAvailable → managementAuthenticated → coreReady`。未安装到 Applications，正式 App 未被退出或替换。
- 按用户后续指示不再使用 Computer Use；用户六步交互验收留待人工完成，CLI/API 验收不能冒充人工 UI 验收。

- 重新构建最新后端与新版离线 gate 前，使用仓库既有 `NativeApplicationQuit.swift` 对精确开发 App PID 发正常退出请求。原 backend `EXIT_0`、三端口全部停止后才重新打包；新 backend PID 96506 再次认证 `coreReady`，同一开发数据目录保留。不存在强杀/丢弃在途付款。

## 界限

该包是明确无真实资金的独立开发产品；生产 BLOCKED 不变。构建通过不代表用户完成六步验收。真实 Codex 配置保持原样，独立启动方式由宿主交付说明提供。

最终追加：离线 RPC sponsor 预检修复后，再次正常退出开发 App（旧后端 `EXIT_0`），保留原 Ledger 和历史 FAILED 记录，重包最新源码后新 backend PID 98193 于 `2026-10-19T14:05:38Z` 认证 coreReady。包内 wrapper 已含最终 close-cleanup；JavaScript bundle 不含开发者 `/Users/irin/` 绝对路径。构建器曾在 App 尚未完全退出时正确拒绝覆盖，等待正常退出后成功；未强杀。
