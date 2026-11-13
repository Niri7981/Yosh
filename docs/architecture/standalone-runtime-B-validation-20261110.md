# B：独立运行时本机验证与实现记录

> 历史实现与验收快照；文内“当前”、版本、进程和未完成项均指各段记录时点。最新插件 0.2.3 主网成功购买及本次归档验证见 [插件版里程碑](plugin-milestone-20261112.md)。
日期：2026-11-10。分支：`codex/yosh-codex-plugin`。

**A 基线核对完成；B 在本机可执行的开发与 Offline 验证已完成。干净 macOS、整机重启、可信分发签名及跨版本 Keychain 信任仍待验收；C 网页可信授权和新用户钱包开通尚未实现。**

## 当前交付：B6（本轮续做）

本节取代下方 B4 记录中的“当前”“尚未”状态；下方保留为历史证据，不代表最终产物。

### 已完成与实际证据

| 项目 | 本轮结果与证据（均在 `build.noindex/` 下） |
| --- | --- |
| 不构建 App 的依赖入口 | `build-standalone-dependencies.py` 从固定 Pay/pay-kit、overlay、Node archive 和离线 vendor 全新编译 Rust，记录输入/工具链/产物；产物 `standalone-dependencies-b5`。不依赖历史缓存二进制或 App bundle |
| 独立运行时 | `standalone-dev-b6`，继续复用原后台、Pay MCP 与协议引擎；未重写 Solana/Pay 付款核心 |
| 生命周期与版本 | `standalone-dev-b6/integration-evidence.json`：11 项通过，包括直接 serve 也不能绕过版本限制 |
| 版本目录安装 | `standalone-dev-b6/install-evidence.json`：6 项通过；并发原子安装、残缺安装不启用、删除测试插件缓存和关闭 MCP 后后台存活、重装复用原身份、损坏安装拒绝 |
| 崩溃中的原付款恢复 | `standalone-dev-b6/recovery-evidence.json`：PAYMENT_UNKNOWN 与已付款/交付失败两个 Offline 场景，在持久化后强制终止测试自己创建的子进程；重启后沿用原购买 ID，每场景仅 1 笔模拟转账，最终 PAID/COMPLETE，交付再次读取一致，真实付款 0 |
| 真实 Codex 宿主 | `standalone-host-b6b/evidence.json`：ZIP 解压为本地 marketplace，安装到私有 CODEX_HOME；真实 Codex app-server 两次启动均加载 7 个工具并调用状态工具。不是伪造 MCP，也不是 Desktop GUI 或模型回合验收 |
| 原生 Keychain | `standalone-probe-20261110-201437-991c27/evidence.json`：从独立依赖打包，不读取 App/工作树；原生 helper 创建/读取临时测试项，用测试种子签固定消息并验证 Ed25519 签名；重启、换路径、锁定拒绝、不同签名身份拒绝均通过。测试 Keychain 已删除，用户 search list 不变 |
| 常规检查 | 相关 TypeScript 4 文件 / 26 测试、Python 构建/打包边界 6 测试、typecheck、lint、Next build 通过。现有动态文件 tracing 与原生弃用警告保留，未放宽检查 |

恢复测试遵守账本中持久化的交付重试时间；提前重试拒绝属于正确行为。测试等待原 nextAttemptAt 后恢复，没有改付款规则、绕过暂停或新建替代付款。原生 Keychain probe 只签固定测试消息；该 helper 不进入插件包，也没有接入真实付款签名器。

### 安装与运行合同

- 新包名 `yosh-standalone-dev`，与日常已安装的 `yosh-dev` 分开；只在隔离 Codex 配置中安装验证，没有替换日常插件或原 MCP。
- 插件启动时执行 `install-mcp`，先校验包，再将运行时原子安装至 `~/Library/Application Support/Yosh Standalone Runtime Dev/<manifest-sha256>`。插件缓存不是后台的运行位置。
- 数据固定在 `~/Library/Application Support/Yosh Standalone Plugin Dev`，身份 `com.yosh.standalone-plugin-dev`，loopback 端口 `15449–15451`。后台按需启动并独立存活；没有 launchd 或登录自启动。
- 精确产物摘要/API/数据合同不一致即拒绝；首版没有自动升级。保留旧程序和原数据，不能清库或换钱包来通过检查。
- Codex 会过滤任意继承环境变量，宿主测试实际使用上述独立默认数据目录。B5 测试产生的空目录经确认无 Grant、购买、转账且进程已退出后，完整归档至 `standalone-host-b5e/retired-empty-test-data`，收据 `empty-fixture-archive.json`；未丢弃用户数据。
- B6 默认数据为暂停、无 Grant、无购买的 Offline 测试环境。宿主测试结束后已认证停止；最终 `15449` 无监听，原 App 插件 Dev 的 `14449` 仍监听，用户 Codex 配置摘要不变。
- 管理凭据的同用户文件权限不构成抵抗同用户 Agent 的可信确认边界。在 C 解决用户确认与凭据保护之前，仍禁止真实钱包、真实网络与真实资金。

### 可交付包

`build.noindex/standalone-plugin-b6/yosh-standalone-dev.zip`，65,662,199 bytes（约 62.6 MiB）。

- ZIP SHA-256：`7f13d41a6707d6651ab25a838893425780e6da421001b74323d49af87e46bb5d`
- 运行时 manifest SHA-256：`fb0e6c4f6925ee1abee0bc92a5c149802274cd2b6f6ecbe6bf9ba6f68c5caf48`
- 清单：`build.noindex/standalone-plugin-b6/package-evidence.json`。仅程序、声明、图标和许可证；不含工作站构建来源私有路径、测试数据或凭据。
- portable 根 `plugin.json` / `mcp.json` 含 `$schema`，并保留 legacy 声明。格式依据 [官方插件规范](https://developers.openai.com/plugins/build/plugins)，实际以本轮宿主安装结果验证。
- 本机插件安装不要求 Apple Developer 会员。本轮未使用 Developer ID，已完成隔离宿主安装。Developer ID / 公证是后续原生运行时面向其他 Mac 可信分发的验证事项，不是安装 Codex 本地插件的前置条件；当前包未做公开分发验收。

### 从源码重建

以下输入为本机已核验路径，可替换为内容相同、通过来源校验的 checkout/archive/vendor。Pay 固定 `402f67c44dd8d41d7d1584fcb5d868006ce8c891`；pay-kit 固定 `7f1369180ca4b047aadff1bea77aed4525e10039`；Node `24.21.0`，archive SHA-256 `6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe`。输出目录必须尚不存在。历史冻结清单与校验规则不变。

```sh
python3 -B scripts/build-standalone-dependencies.py build \
  --output build.noindex/standalone-dependencies-next \
  --pay /Users/irin/Desktop/yosh/build.noindex/stable-inputs/pay \
  --pay-kit /Users/irin/.cargo/git/checkouts/pay-kit-cd9b946eb084db0f/7f13691 \
  --cargo-home /Users/irin/Desktop/yosh/build.noindex/stable-inputs/cargo-home \
  --node-archive /Users/irin/Desktop/yosh/build.noindex/stable-inputs/node-v24.21.0-darwin-arm64.tar.xz
python3 -B scripts/build-standalone-dev.py \
  --dependencies build.noindex/standalone-dependencies-next \
  --output build.noindex/standalone-dev-next
python3 -B scripts/package-standalone-plugin.py \
  --runtime-package build.noindex/standalone-dev-next \
  --output build.noindex/standalone-plugin-next
python3 -B scripts/test-standalone-dev.py build.noindex/standalone-dev-next
python3 -B scripts/test-standalone-install.py build.noindex/standalone-dev-next \
  --evidence build.noindex/standalone-dev-next/install-evidence.json
python3 -B scripts/test-standalone-recovery.py build.noindex/standalone-dev-next \
  --evidence build.noindex/standalone-dev-next/recovery-evidence.json
python3 -B scripts/probe-standalone-runtime.py \
  --dependencies build.noindex/standalone-dependencies-next
```

以上端口测试顺序运行。真实宿主测试命令：

```sh
python3 -B scripts/test-standalone-plugin-host.py \
  build.noindex/standalone-plugin-next/yosh-standalone-dev.zip \
  --state build.noindex/standalone-host-next
```

宿主测试仅接受无人使用的同版本、无模拟转账的 standalone Dev 环境；遇到现有版本不同或端口占用会拒绝，不自动停止别人的后台或迁移数据。

当前 B6 包手动管理入口：

```sh
build.noindex/standalone-dev-b6/yosh-dev start
build.noindex/standalone-dev-b6/yosh-dev status
build.noindex/standalone-dev-b6/yosh-dev stop
```

插件首次连接自动走 `install-mcp`；这些命令无需打开 Yosh App。开发机重建需要源码构建工具，最终包使用者无需安装 Node/Rust/Xcode。

### 剩余验收与下一阶段

B 本地代码与 Offline 验证已完成；尚不能标记 B 的所有外部分发条件通过：没有干净 Mac/VM、没有整机重启验收、没有 Developer ID/公证及跨版本 Keychain 信任验收。用户当前没有会员和额外机器，不要求现在购买。

C 仍需冻结授权申请、可信组件读取和展示、系统认证绑定申请摘要、原子消费确认，以及 P0 钱包开通/备份/重装识别。新包尚无可用网页授权或真实钱包开通；现有日常 App 插件继续使用。真实 Desktop 安装可见、网页授权与购买全流程尚未验收，不以 app-server 或 Offline 测试代替。

---

## 历史记录：B4 首批验证（由上方 B6 状态取代）

## 1. 实际验证了什么

`scripts/probe-standalone-runtime.py` 验证已有 Dev 构建的产物清单、来源清单和代码签名后，复制 Node/Pay 产物，并从当前源码完整打包后台。执行时通过 macOS sandbox 禁止读取 App bundle、真实用户目录内容及工作树源码；程序从新输出目录启动，数据、端口和管理凭据均独立。

本轮证据：`build.noindex/standalone-probe-20261110-173451-a9a984/evidence.json`。同目录 `manifest.json` 记录实际打包输入、原产物摘要、Node/Rust 字节摘要和原生测试程序摘要。

| 验证 | 结果 |
| --- | --- |
| 实际拒绝读取已安装 App 与工作树 package.json | 通过；后台运行不依赖这些路径 |
| 后台就绪、带 Member 凭据读取状态 | 通过 |
| 匿名、错误 Agent 凭据、无认证管理请求 | 均拒绝 |
| 第二进程占用同一数据目录 | 拒绝 |
| 退出后以新进程重启 | 原 Member、连接凭据、Offline 钱包身份保持一致 |
| 后台调用独立原生 helper 创建、读取测试 Keychain 项 | 通过；只有临时随机测试内容 |
| Keychain 锁定，禁用交互后的读取 | 拒绝；解锁后原项内容不变，没有创建替代项 |
| 原生程序重启、相同程序换路径 | 原测试项仍可读取 |
| 改为不同 ad-hoc 签名标识的程序读取 | 拒绝；原程序随后仍读到原内容 |
| 清理 | 专属测试 Keychain 已删除，用户 Keychain search list 前后一致 |
| 付款 | 0；无 Grant，保持暂停 |

测试 Keychain 使用显式路径的 **file-based Keychain**，通过 Security framework 访问；不搜索或读取 login Keychain 的钱包。相关 API 在 macOS SDK 中已弃用，编译日志保留警告，不屏蔽。它验证的是现有 `security` 类存储实现的本机可行性，不是 Data Protection Keychain、Secure Enclave 或用户在场授权的验证。

### 证据边界

- 本机仍安装了 Yosh App。sandbox 禁止读取 App 的测试不是“另一台从未安装 App 的干净机器”验收。
- 本机没有有效的代码签名身份；helper 使用一次性 ad-hoc 测试签名。跨版本升级的 Keychain 信任、Developer ID、公证与分发尚未通过。
- 后台购买签名器仍是原有 **Offline fixture**；测试 Keychain helper 没有接入实际付款签名器。没有迁移正式私钥，没有验证新形态的真实链上付款。
- Keychain API 可用不等于网页或 Agent 已获得可信用户授权。C 的冻结申请、可信展示、系统确认和摘要绑定仍待实现及验证。

## 2. 验证后新增的实现

新增 `scripts/build-standalone-dev.py` 与 `scripts/standalone-dev.ts`，构建不含 App 壳的运行时包。初版只允许 Offline 测试，不安装、不接替现有插件。

当前可运行产物：`build.noindex/standalone-dev-0.1.0-b4/`。

| 合同 | 当前实现 |
| --- | --- |
| 身份 | 编译时 `com.yosh.standalone-plugin-dev`，旧 App / Dev profile 不变 |
| 端口 | 固定 loopback `15449 / 15450 / 15451`，与既有 Dev 的 `14449–14451` 分离 |
| 默认数据 | `~/Library/Application Support/Yosh Standalone Plugin Dev`；本轮测试只使用临时目录，没有创建这个默认目录 |
| 程序目录 | 独立版本输出目录，禁止把数据放进运行时目录；不依赖用户的 Node 或开发工具链 |
| 进程 | launcher 按需启动 detached 后台；后台持有服务锁和原有数据目录所有权。MCP 退出不会停止后台；没有设置开机启动 |
| 启停竞争 | 独立 startup SQLite 锁串行化连接/启停；服务锁防止重复服务覆盖所有权记录 |
| 身份核验 | 管理 HMAC 请求与响应；检查实际 PID、数据目录、API 版本、数据合同与精确运行时摘要，不能只凭端口开放连接 |
| 版本 | 首版只接受相同运行时摘要。不同版本、不兼容合同、损坏包拒绝新操作，保留账本及既有后台；不自动迁移或回退 |
| 停止 | 通过认证 lifecycle 请求，复用 `prepareQuit` 和 SIGTERM 安全停止。不会按任意 PID 强杀进程 |
| 网络 / Keychain | 子进程只允许 loopback，禁止 App 访问和 `security` 调用；正式 Keychain/生产钱包不参与 Offline 包 |
| MCP | 直接复用 `scripts/pay-dev-mcp.ts` 与 Rust Pay MCP；Offline 暴露 7 个工具，不扩展为任意签名或授权接口 |
| 新数据默认 | 暂停、无 Grant；仅自动准备 Offline fixture 的测试连接。产品的可信配对交给 C，不能用于真实钱包 |

程序 SHA 校验是完整性检查，不代替可信发布签名。当前管理凭据存于同用户私有目录，不能据此承诺抵抗拥有相同系统用户文件权限的 Agent；在 C 解决可信确认前，这个包不得启用真实钱包或真实网络。

后台不使用 launchd。异常退出后由下一次 launcher 调用重新启动；尚未完成系统重启、崩溃中的原付款恢复、升级监督或卸载体验验收。不得把这次“空账本安全重启”写成“付款未知恢复通过”。

## 3. 本轮完整包集成验证

命令：`python3 scripts/test-standalone-dev.py build.noindex/standalone-dev-0.1.0-b4 --evidence build.noindex/standalone-dev-0.1.0-b4/integration-evidence.json`

10 项通过：

1. 三个并发启动与重复启动保持一个后台所有者。
2. 通过实际打包的 MCP/Pay 子进程加载 7 个工具，读取暂停、无 Grant、无购买状态。
3. MCP 关闭后后台存活。
4. 错误管理凭据拒绝接入，不接替原后台。
5. 不同运行时版本拒绝接入，原健康后台不变。
6. 认证停止与新进程重启保留原身份。
7. 不兼容 API/数据合同拒绝，账本摘要不变。
8. 运行时文件损坏拒绝，账本摘要不变。
9. 未知服务占用端口，即使返回 `ready: true` 也拒绝，不接替它。
10. 直接重复启动服务被所有权锁拒绝，不能覆盖现有 owner 记录。

测试完成后通过认证通道停止测试后台并删除该测试的临时状态。结束时 `15449` 没有监听；既有插件 Dev 的 `14449` 仍在监听。没有退出、启动、安装或替换正式 App，没有改 Codex 配置。

相关 4 文件 / 26 项单元测试通过：profile、执行边界、管理 HMAC、管理错误合同。`npm run typecheck`、`npm run lint`、`npm run build` 通过。Next 构建仍报告 `pay-mainnet-control.ts` 动态文件访问的两条 tracing 警告；未通过忽略检查修复。原生 Swift probe 编译和运行通过，弃用警告见其独立日志。

这些是本轮命令行集成证据，**不是 Codex Desktop 新形态验收**，没有购买或交付测试。

## 4. 重建与启动

在插件工作树中运行：

```sh
# 输入必须是原 Dev builder 产生且可验证的完整产物目录。
python3 scripts/probe-standalone-runtime.py --artifact build.noindex/codex-plugin-dev-resource

# 输出目录必须尚不存在，避免覆盖旧程序版本。
python3 scripts/build-standalone-dev.py \
  --artifact build.noindex/codex-plugin-dev-resource \
  --output build.noindex/standalone-dev-next

python3 scripts/test-standalone-dev.py build.noindex/standalone-dev-next

# 显式开发使用，默认创建独立 Offline 数据；不用于真实钱包。
build.noindex/standalone-dev-next/yosh-dev start
build.noindex/standalone-dev-next/yosh-dev status
build.noindex/standalone-dev-next/yosh-dev mcp
build.noindex/standalone-dev-next/yosh-dev stop
```

`--data-dir` 可指定绝对、私有、无符号链接目录，末级目录必须为 `Yosh Standalone Plugin Dev`。复制相同包到新程序路径不要求改源码。暂时不支持用不同包版本接管已有数据；保留旧包处理旧数据，不能删账本或新建钱包来绕过版本检查。

Node/Rust 的输入仍由 `build-codex-plugin-dev.py` 的可复现构建提供；本打包步骤核验并记录其来源，不能传入不明缓存。当前已去除**运行时对 App 的依赖**，尚未把原输入 builder 的 Rust/Node 准备阶段完全拆成不构建 App 的共享构建步骤。

## 5. 下一步

继续 B：拆分共享依赖构建步骤、核验拟分发签名身份、在干净环境安装、补异常退出及在途状态验证。随后完成 C 小验证：后端冻结申请，可信组件直接读取并展示，系统确认凭据绑定摘要，后端验证并原子消费。两个小验证达到各自完整门槛后，再推进完整 B/C/D。

网页可信授权、免 App 的 P0 钱包开通、备份/重装恢复、真实 Codex Desktop 全流程均未标记完成。旧 App 通路和已安装插件保持原样。
