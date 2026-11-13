# C：本地授权与官网视觉 — 当前开发证据

> 历史实现与验收快照；文内“当前”、版本、进程和未完成项均指各段记录时点。最新插件 0.2.3 主网成功购买及本次归档验证见 [插件版里程碑](plugin-milestone-20261112.md)。
日期：2026-11-10。分支 `codex/yosh-codex-plugin`。**C 的独立 Dev 实现已补齐主要入口；真人 Grant 与钱包开通已核对，连接/额度等最新管理操作及最终宿主流程仍待验收。不能标为 C 全部通过。** 既有 App、日常插件、正式钱包及正式 MCP 没有修改。本轮未提交、推送或付款。

## 本轮 C 继续实施：当前结论

用户要求继续 C、复用现有钱包、保留原付款通路，并亲自完成两类系统确认：

- C6：两份独立 Offline Grant 申请已 `CONSUMED`，后一份替换并撤销前一份。有效总额 1.00 / 单笔 0.20 / 24 小时；当前环境暂停，购买数 0。用户报告原生系统认证成功，数据库回执可关联。证据 `build.noindex/local-authorization-c6/human-confirmation-evidence.json`。没有用自动点击或模拟回调冒充真人。
- C7：用户亲自确认开通 Devnet 钱包。持久钱包公钥为 `CN6F6n9oTh7XrHijTwBAcnNKPtCxMnzyCjv4aQEMfKFW`，Keychain service 是固定的 `com.yosh.local-authorization-dev.wallet.devnet.v1`。C8 使用新程序版本、原数据目录重启后通过现有模块读回同一公钥，付款暂停、连接关闭、购买数 0。分别见 C7 `human-wallet-evidence.json` / C8 `wallet-restart-evidence.json`。未读取/迁移正式或日常 Dev 的秘密。

### 新增入口及复用边界

1. 页面保留已认可的暖黑胶囊视觉。授权/钱包/记录三个简短入口；确认后留在明确结果页，显示实际 Grant、额度/有效期或钱包地址、网络和付款状态。修复原先成功后返回表单导致再次授权的问题，并为此增加实际页面脚本的回归测试。网络回包不明可查原申请，不创建替代请求。
2. 钱包开通调用原 `AppRuntime.createDevelopmentPaymentWallet()` → `initializeEnvironmentWallet()` → 原 Keychain 存储和 `WalletAccounts` 公钥绑定。不重写签名、Solana Pay、Pay 协议引擎或购买管线。只增加编译期 C 身份，开放它自己的 Devnet 配置；原插件、B Offline、原 App 配置限制不变，所有插件 Mainnet 仍拒绝。
3. 共享日额度、暂停/恢复、精确 Grant 撤销、单个 Agent 连接启停都生成冻结申请，由同一原生确认流程校验内容。日额度/暂停/撤销在原账本事务内同时消费回执；撤销绑定精确 Grant ID，不撤销后来替换的 Grant。连接启停复用原业务方法，不改正式宿主接线。
4. Keychain 写入/连接文件不能与 SQLite 同事务，因此先持久领取原申请，再执行既有幂等业务。异常时保留 `CLAIMED`，不自动重建钱包/重放连接操作；重启只读核对原钱包或目标连接状态后消费原回执。未能核对的领取阻止新的管理变更，需排查原结果。锁定、身份冲突、损坏等仍拒绝换钱包。
5. 状态/购买记录使用既有后台数据与购买只读合同，付款与交付分开；本地页不自动恢复付款。
6. 插件内新增两个设置工具，未配对也可加载：`open_local_settings`、`local_setup_status`。配对后转发原 Pay wrapper 工具；无钱包/授权规则进入 Skills 或模型。状态工具发工具清单变更通知；宿主是否实时刷新仍需 D 验证，Skill 明确可重连该 Dev 插件，不动日常插件。
7. 独立包沿用 B 的单进程所有权、版本摘要、数据目录分离、校验安装和失败保留。C 使用单独 `com.yosh.local-authorization-dev` / 17449、17452 / `Yosh Local Authorization Dev`，程序版本目录 `Yosh Local Authorization Runtime Dev`。C 服务使用现有 Devnet 后端的正常 macOS 进程权限以访问系统 Keychain/原生确认；B Offline 的禁止 Keychain/外网 sandbox 保持原样。C 不是 B Offline sandbox 已覆盖的安全证明，Mainnet/可信分发仍不开放。

### 当前可交付构建

最新源码构建：`build.noindex/local-plugin-c12`。
可安装包：`build.noindex/local-plugin-package-c12/yosh-local-dev.zip`。
这是独立 **Devnet 设置/授权测试插件**，未安装到用户日常 Codex，也未覆盖已有 `yosh-dev`。C10 测试后台已安全停止（无页面会话/新申请），数据保留。C12 已在私有 Codex home 安装并由真实 app-server 启动，使用自己的默认持久目录；未改 C10 owner 或绕过版本检查。C12 还修复并回归验证了状态查询与正在执行的钱包创建之间的回执竞争。

```sh
python3 -B scripts/build-standalone-dev.py \
  --dependencies build.noindex/standalone-dependencies-b5 \
  --output build.noindex/local-plugin-next --local-authorization
python3 -B scripts/package-standalone-plugin.py \
  --runtime-package build.noindex/local-plugin-next \
  --output build.noindex/local-plugin-package-next
build.noindex/local-plugin-next/yosh-dev start
build.noindex/local-plugin-next/yosh-dev settings
# settings 输出新的一次性本地链接；无需重启服务来换链接。
build.noindex/local-plugin-next/yosh-dev status
build.noindex/local-plugin-next/yosh-dev stop
```

第一次安装程序和持久数据分开；版本不匹配拒绝接管，尚无自动升级。不要把不同构建直接指向已有 owner 的数据目录来跳过版本检查。参数 `--data-dir` 可指定明确的隔离测试目录，必须以本构建的固定目录名结尾。

### 本轮实际检查

- 9 文件 / 69 项单元检查通过；随后增加钱包创建/只读核对并发回归，与最终页面脚本合计 2 项通过。覆盖钱包、身份绑定、授权、控制回执、成功页、编译期隔离。
- 3 文件 / 4 项插件集成：网页授权与控制的跨会话拒绝、拒绝/取消/重放/过期状态，冻结后状态变化拒绝，原发现注册购买、Offline 故障与原付款恢复。系统确认成功在自动化中仍是明确注入，不能替代真人。
- 原 B Offline 新源码重新构建，11 项生命周期回归通过：重复/并发启动、7 工具、MCP 退出后台存活、安全重启、无效凭据/不兼容版本/损坏输入/不可信端口拒绝等，0 付款。
- C10 实际 MCP SDK 客户端加载两个设置工具，配对关闭、付款暂停。证据 `build.noindex/local-plugin-c10/setup-mcp-evidence.json`。
- C12 最终 ZIP 在私有 Codex home 安装；真实 app-server 连续两次加载 `open_local_settings` / `local_setup_status`，同一后台身份、未配对、暂停、无 Grant/购买，随后安全停止。用户日常 Codex 配置摘要不变。证据 `build.noindex/local-plugin-host-c12/evidence.json`；没有模型购买 turn 或 Desktop GUI 验收。
- 构建/打包白名单与身份测试 7 项通过，ZIP 中无 state、账本、钱包数据或一次性链接；声明/启动器/Skill 无个人硬编码路径。原生 Swift 构建与 ad-hoc 签名通过。
- typecheck、lint 通过；production build 通过，保留原有两条动态 filesystem tracing 警告。未提交、推送、发布或付款；不使用 Computer Use。

### 尚未通过的门槛

- 连接启用、每日额度 0.50 与原生取消仍未收到完成结果，不预先算通过。C10 链接已过期并安全停机，后续使用 C12 新链接。其后的完整 Pay 工具加载/重启保留还需核对。
- 新包在实际 Codex Desktop 的安装、工具动态刷新、免 App 首次购买及交付/恢复是 D 的真实宿主验收，未完成。私有 app-server 的安装和未配对设置工具已实际通过，不能扩展为购买/动态工具刷新已经通过。
- C 当前只开放独立 Devnet。新通路的 Mainnet 与原正式钱包接入仍需明确授权与独立验收；原 App 的两个钱包槽和原付款通路保留。
- 钱包 `backup_state=legacy_unverified`。已证明同机、Keychain 和原数据仍在时的识别；没有私钥导出、iCloud 备份或换机/抹盘恢复承诺。正式首版备份方案、可信签名分发、同用户篡改运行时/数据库的完整威胁模型仍待解决，不能将本轮 Dev 开通等同于完整生产钱包上线。

以下保留此前 C6 与早期探针的历史记录，当前状态以上节为准。

## 最新视觉调整：已认可的暖黑胶囊界面（C6）

用户认可最新设计图后明确要求实现。C6 保留官网暖黑 `#141412`、内容面 `#191917`、米白 `#f2eee6`、小幽灵与 Instrument Serif 品牌字；单个 650px 面板、21px 标题、正常字号金额输入，输入框/选择器/按钮采用两端圆弧。无大标语、侧栏游标、纹理、铜线或蓝色按钮。C5 白底方向已被用户否定并由此版替代；下方较早视觉基准仅是历史记录。

本机未找到名为 Motivation 的 Skill；实现使用项目 `yosh-motion` + `yosh-ui`，最新用户视觉要求优先于原生 App Skill 的旧配色。按压只缩至 0.985，编辑/复核切换为 180ms / 3px 淡入；无金额动画、循环闪烁或人为等待。减少动态效果时关闭过渡，键盘焦点进入复核标题，取消后回到 API 选择器。原生确认组件和授权规则未改。

当前构建 `build.noindex/local-authorization-c6`。本轮通过 typecheck、lint、production build（原有两条 tracing 警告保留）、网页授权集成 1 项、Swift 编译和打包。HTTP smoke 核验页面、脚本语法/控件 ID、字体和幽灵摘要、匿名状态拒绝。CSS 的减少动态效果规则已检查，实际浏览器视觉、键盘与动效仍待人工验收；没有使用 Computer Use。

## 本轮预览运行状态

C6 后台已启动在隔离端口 16449–16452，留供用户预览；一次性链接写入 `build.noindex/local-authorization-c6/open-local-page.txt`。链接五分钟有效，页面会话十五分钟有效；过期后需要安全重启这个验证实例取得新链接。未调用原生授权确认、未创建 Grant、未付款；不影响原 App、日常 Dev 或已安装插件。

## 当前产物

`build.noindex/local-authorization-c6` 是独立 Offline 验证包，**不是已安装插件的更新**。使用 16449/16450/16451 后台/测试商家/RPC，16452 本地授权页；数据在该输出的 `state/Yosh Standalone Plugin Dev`。原 B6 和日常 Dev 数据保持不变。

构建与启动：

```sh
python3 -B scripts/build-local-authorization-probe.py \
  --runtime-package build.noindex/standalone-dev-b6 \
  --output build.noindex/local-authorization-next
build.noindex/local-authorization-next/node \
  build.noindex/local-authorization-next/local-authorization.cjs
```

构建校验 B6 输入的摘要/签名，重新打包本轮源码、编译带 hardened runtime 的 ad-hoc 原生确认组件；输出 manifest/source hashes 可核对来源。启动输出仅含状态及 `open-local-page.txt` 的位置。该文件里的 fragment 链接五分钟内一次有效，仅建立网页会话，不证明用户批准。刷新或重启须新会话；原申请/Grant 记录继续保留。程序没有自动打开网页、弹出授权或进行付款。

历史 C4/C5 smoke 已安全停止。当前 C6 运行情况见上节；不能使用过期的历史链接。

## 已实现的确认边界

- 网页只有短时独立会话，不获得原管理 HMAC。Host/loopback/Origin、JSON 类型、请求长度、CSP、会话归属均检查；匿名与跨站请求拒绝。
- 后端使用已注册 Offline GET Resource 和只读报价构造申请；登记 API 本身不授权。申请包括 Agent/连接、API 定义摘要、网络、资产、收款方、额度、有效期、会话摘要、一次性 challenge 和五分钟申请有效期。
- 已冻结申请持久不可修改；改字段必须新申请。标签禁止控制字符/双向文本控制符，避免在确认窗口伪造字段。网页展示与原生组件处理同一份 UTF-8 内容和摘要。
- 原生组件只从后台建立的 stdin 管道读取冻结内容。先展示完整范围，再调用 LocalAuthentication；只有成功且未过期才向同一 stdout 管道返回绑定摘要/challenge 的证明。
- 每次确认的 HMAC 密钥仅保留在两个进程内存与继承管道，未写文件、argv、环境变量、网页或 HTTP 响应。启动另一份 helper、传 `approved:true` 或 `--approve` 不能伪造正在等待的证明。没有生产可开启的测试批准开关。
- 后端核对 Resource/Agent/连接未变化；复用既有 `AppRuntime.createSpendGrant`，在既有 SQLite 事务里核对申请并同时插入 Grant、消费申请、保存 Grant ID。失败整体回滚；重试读取原结果，不第二次创建 Grant。
- 仅 C 验证实例启用 `localAuthorizationOnly`，即使掌握旧 HMAC，也不能经通用管理写接口创建 Grant、解除暂停、改额度、钱包或连接。生命周期安全退出仍保留。原 App 与 B6 默认行为不变。
- 确认后不自动解除暂停，不设置日额度，不触发购买。

### 可信边界仍需验证

自动化的网页集成使用显式测试依赖模拟确认结果，验证服务合同；不能据此宣称系统认证已完成。实际原生 helper 已编译、签名校验、系统认证能力检测通过，并拒绝伪造布尔值、额外 approve 参数和错误摘要；本轮未弹出/自动操作系统授权窗口。

当前方案依赖可信的运行中后端、原生程序和系统进程隔离。源文件、运行时或 SQLite 被同用户恶意直接篡改，不在这些 HTTP/进程管道测试已证明的防护范围内；开发态摘要校验不是可信公开签名或受保护安装。**在资金签名器、持久授权与同用户 Agent 的完整边界验证前，不接入真实钱包或开启真实网络。** 本轮没有改 Keychain ACL，没有把正式秘密搬入测试包。

## 实际测试

- 新冻结授权单元测试 17 项，覆盖字段修改、会话/标签摘要、控制字符、过期、取消、交换申请、重复消费、双连接/重开账本、持久化失败回滚；与既有 Grant 测试合计 30 项通过。
- 相关钱包、身份、HMAC、付款执行边界合计 6 文件 / 56 项在加入最后一项标签用例前通过；标签修改后重跑授权/Grant 30 项通过。
- 3 个插件集成文件 / 4 项通过：网页确认合同、既有发现/注册/购买，以及 Offline 故障恢复。网页最终版本另重跑通过。这里的正常系统确认结果是测试注入，不是真人证据。
- typecheck、lint 通过；Next production build 通过，已有两条 `pay-mainnet-control.ts` tracing 警告保留。最终网页脚本独立语法解析通过；原生 Swift 编译和 hardened ad-hoc 签名通过。
- C4 `smoke-evidence.json`：后台就绪、页面和官网字体/幽灵/纹理按原字节返回、匿名拒绝、原生非法输入拒绝、系统认证可用、测试后台安全停止。`nativeConfirmationPerformed=false`、`paymentExecuted=false`、`desktopAcceptance=false`。

## 较早视觉基准（当前布局以 C6 为准）

用户否定前三组通用风格，明确要求采用 https://2049-web.vercel.app/ 的官网风格。通过只读 HTTP 获取实时 CSS，并与 `/Users/irin/Desktop/yosh-web` 的现有源码/素材核对：

- 背景 `#141412`、内容面 `#191917`、正文 `#f2eee6`、铜色信号 `#d89a68`。
- Instrument Serif / 中文宋体标题、克制的无衬线操作字段、极轻纸张纹理、方形编辑版面、细边界线和原 Yosh 小幽灵。
- 本地页素材已复制至 `src/modules/authority/web-assets`；字体 OFL 保留，构建不依赖网站在线可用或外部工作树。
- 已生成官网风格图片供用户看方向；它是设计图，不是实际浏览器截图。实际页面视觉/可访问性仍待人工验收。没有使用 Computer Use，没有修改官网。

## 钱包澄清与剩余 C 项

现有 App 已有主网/测试钱包、Keychain 读写、创建、身份 pin、钱包账户与恢复状态模块；新通路复用这些能力，不重写付款核心，不删除其中一个钱包槽。

开发中的隔离测试钱包与现有用户的钱包复用是不同事项。本轮只验证 Offline 授权，没有创建真实钱包；也未获授权把正式钱包、Grant 或账本接入新 Dev。当前先保留两槽的既有业务能力。新用户最小开通、明确网络/资产/费用、备份策略和同机重装识别仍需完成，不能把 Keychain 已有 CRUD 写成 P0 开通完成。

接下来的门槛是 C 小验证的真人确认：由用户核对冻结金额/Agent/API/收款方，在系统窗口批准一次无资金测试 Grant，再拒绝/取消另一份，核对原记录。原计划要求这个可信确认验证成立后再扩展完整 C；因此不会用模拟批准替代它并声称 C 已完成。用户希望最后统一验收，当前保留可验收构建，不强行弹窗。

完整 C 仍包括最终页面交互、钱包开通/识别、连接管理、撤销/日额度/暂停的同等级可信确认、购买历史、本地页接入可安装插件，以及实际宿主验收。还没有升级 B6 的日常插件或打开真实支付。
