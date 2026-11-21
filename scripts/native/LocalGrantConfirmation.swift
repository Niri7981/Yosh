import AppKit
import CryptoKit
import Foundation
import LocalAuthentication

// Narrow confirmation component. There is deliberately no approve flag,
// arbitrary signing command, exported key, HTTP listener or test bypass.
private struct Envelope: Decodable { let body: String; let digest: String; let key: String }
private struct StatementPairing: Decodable {
    let version: Int; let environment: String; let scope: String; let agentLabel: String
    let registrationHash: String; let createdAt: Int64; let expiresAt: Int64; let challenge: String
}
private struct RemoteReadRequest: Decodable {
    let version: Int; let challenge: String; let createdAt: Int64; let expiresAt: Int64
    let label: String; let account: String; let environment: String; let scopes: [String]
}
private struct SimulatedPurchaseConsent: Decodable {
    let version: Int; let action: String; let challenge: String; let createdAt: Int64; let expiresAt: Int64
    let label: String; let account: String; let environment: String
    let pairingId: String?; let resourceId: String?; let totalLimit: String?; let singleLimit: String?; let grantExpiresAt: Int64?
}
private struct GrantInput: Decodable { let totalLimit: String; let singleLimit: String; let expiresAt: Int64 }
private struct Principal: Decodable { let cardMemberId: String; let connectionId: String; let connectionGeneration: Int }
private struct Scope: Decodable {
    let resourceId: String; let providerId: String; let operation: String
    let network: String; let assetId: String; let assetDecimals: Int
    let payTo: String; let paymentScheme: String
    let maximumNetworkFeeLamports: String?
}
private struct Binding: Decodable { let input: GrantInput; let principal: Principal; let scope: Scope; let mode: String }
private struct Purchase: Decodable { let requestId: String; let url: String; let reason: String; let quoteExpiresAt: Int64 }
private struct GrantRequest: Decodable {
    let purchase: Purchase?
    let version: Int; let id: String; let challenge: String; let sessionHash: String
    let createdAt: Int64; let expiresAt: Int64; let environment: String
    let agentLabel: String; let apiLabel: String; let payerWallet: String?; let resourceHash: String; let binding: Binding
}
private struct ControlAction: Decodable { let type: String; let paused: Bool?; let enabled: Bool?; let amount: String?; let grantId: String?; let resourceId: String?; let slot: String?; let network: String?; let assetId: String? }
private struct ControlRequest: Decodable {
    let version: Int; let kind: String; let id: String; let challenge: String; let sessionHash: String
    let createdAt: Int64; let expiresAt: Int64; let environment: String; let mode: String
    let memberId: String; let agentLabel: String; let basis: String; let action: ControlAction
}
struct Presentation { let authenticationReason: String; let title: String; let details: String; let challenge: String; let expiresAt: Int64; let agentLabel: String }
private enum Failure: Error { case rejected }
private func hex(_ data: some Sequence<UInt8>) -> String { data.map { String(format: "%02x", $0) }.joined() }
private func hexData(_ string: String) throws -> Data {
    guard string.count == 64, string.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { throw Failure.rejected }
    var result = Data()
    var index = string.startIndex
    while index < string.endIndex {
        let end = string.index(index, offsetBy: 2)
        guard let byte = UInt8(string[index..<end], radix: 16) else { throw Failure.rejected }
        result.append(byte); index = end
    }
    return result
}
private func amount(_ value: String, mainnet: Bool = false) throws -> String {
    guard !value.isEmpty, value.allSatisfy({ $0 >= "0" && $0 <= "9" }), let integer = UInt64(value), integer > 0 else { throw Failure.rejected }
    return "\(integer / 1_000_000).\(String(format: "%06llu", integer % 1_000_000)) \(mainnet ? "USDC" : "Test USDC")"
}

#if !LOCAL_CONFIRMATION_TEST
@main
#endif
@MainActor
struct LocalGrantConfirmation {
    private static func executablePath(_ pid: pid_t) -> String? {
        var path = [CChar](repeating: 0, count: 4096)
        guard pid > 1, proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return nil }
        return String(cString: path)
    }

    private static func executableIdentity(_ path: String) -> (dev_t, ino_t)? {
        var info = stat()
        guard stat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { return nil }
        return (info.st_dev, info.st_ino)
    }

    static func main() {
        if CommandLine.arguments == [CommandLine.arguments[0], "--calling-host"] {
            // Stdio, the legacy proxy and the owner client run the same bundled
            // executable. Only traverse that executable, stopping at the first
            // external program. No process arguments or environment are read.
            guard let helper = executablePath(getpid()) else { exit(1) }
            let nodePath = URL(fileURLWithPath: helper).deletingLastPathComponent().appendingPathComponent("node").path
            guard let node = executableIdentity(nodePath) else { exit(1) }
            var pid = getppid()
            for _ in 0..<6 {
                guard let executable = executablePath(pid), let identity = executableIdentity(executable) else { exit(1) }
                // The kernel and Foundation can spell the same volume path as /private/var or /var.
                if identity != node {
                    print(executable)
                    return
                }
                var info = proc_bsdinfo()
                let size = Int32(MemoryLayout<proc_bsdinfo>.size)
                guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { exit(1) }
                pid = Int32(info.pbi_ppid)
            }
            exit(1)
        }
        if CommandLine.arguments == [CommandLine.arguments[0], "--check"] {
            let context = LAContext(); var error: NSError?
            let available = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
            print("{\"systemAuthenticationAvailable\":\(available),\"confirmationPerformed\":false}")
            return
        }
        do { try confirm() }
        catch { print("{\"code\":\"LOCAL_CONFIRMATION_DECLINED\"}"); exit(1) }
    }
    static func presentation(_ bytes: Data, digest: String) throws -> Presentation {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
        if object?["kind"] as? String == "statement_pairing" {
            let r = try JSONDecoder().decode(StatementPairing.self, from: bytes)
            guard r.version == 1, r.environment == "mainnet", r.scope == "read_statement",
                  r.createdAt <= now, now < r.expiresAt, r.expiresAt - r.createdAt <= 120_000,
                  !r.agentLabel.isEmpty, r.agentLabel.utf16.count <= 80,
                  !r.agentLabel.unicodeScalars.contains(where: { [.control, .format, .lineSeparator, .paragraphSeparator].contains($0.properties.generalCategory) })
            else { throw Failure.rejected }
            _ = try hexData(r.registrationHash); _ = try hexData(r.challenge)
            return Presentation(authenticationReason: "允许 \(r.agentLabel) 查看 Yosh 共享主网账单",
                title: "允许 \(r.agentLabel) 查看账单？",
                details: "范围：此账户所有 Agent 的主网消费记录、已付和预占金额。\n此连接仅可查询账单，不授予消费额度。\n\n连接标识：\(r.registrationHash.prefix(12))",
                challenge: r.challenge, expiresAt: r.expiresAt, agentLabel: r.agentLabel)
        }
        if object?["kind"] as? String == "remote-simulated-purchase" {
            let r = try JSONDecoder().decode(SimulatedPurchaseConsent.self, from: bytes)
            guard r.version == 1, r.environment == "simulated", r.createdAt > 0, r.createdAt <= now, now < r.expiresAt,
                  r.expiresAt - r.createdAt <= 120_000, !r.label.isEmpty, r.label.count <= 80,
                  !r.account.isEmpty, r.account.count <= 256,
                  [r.label, r.account].allSatisfy({ $0.rangeOfCharacter(from: .controlCharacters.union(.newlines)) == nil }) else { throw Failure.rejected }
            _ = try hexData(r.challenge)
            let title: String, details: String
            switch r.action {
            case "pair":
                guard r.pairingId == nil, r.resourceId == nil, r.totalLimit == nil, r.singleLimit == nil, r.grantExpiresAt == nil else { throw Failure.rejected }
                title = "配对模拟购买 Agent？"
                details = "允许此 Agent 申请购买和查自己的订单。配对不分配消费额度，还需要另行确认 Grant。"
            case "grant":
                guard let id = r.pairingId, UUID(uuidString: id) != nil, r.resourceId == "market-snapshot",
                      let total = r.totalLimit, let single = r.singleLimit, let t = UInt64(total), let v = UInt64(single),
                      v > 0, v <= t, let expiry = r.grantExpiresAt, expiry > now else { throw Failure.rejected }
                title = "确认模拟消费授权？"
                let expiration = Date(timeIntervalSince1970: Double(expiry) / 1000).formatted(date: .abbreviated, time: .standard)
                details = "商品：SOL Market Snapshot (market-snapshot)\n单笔上限：\(try amount(single))\n总额上限：\(try amount(total))\n到期：\(expiration)\n配对 ID：\(id)\n同一模拟钱包的共享日额度仍然生效。"
            default: throw Failure.rejected
            }
            return Presentation(authenticationReason: "确认 Yosh 对 \(r.label) 的模拟购买设置（\(digest.prefix(8))）", title: title,
                details: "Agent：\(r.label)\n账号：\(r.account)\n环境：隔离模拟钱包，无真实资金\n\n\(details)",
                challenge: r.challenge, expiresAt: r.expiresAt, agentLabel: r.label)
        }
        if object?["kind"] as? String == "remote-read" {
            let r = try JSONDecoder().decode(RemoteReadRequest.self, from: bytes)
            let fields = [r.label, r.account, r.environment]
            guard r.version == 1, r.createdAt > 0, r.createdAt <= now, now < r.expiresAt,
                  r.expiresAt - r.createdAt <= 120_000, r.label.count <= 120,
                  fields.allSatisfy({ !$0.isEmpty && $0.count <= 256 && $0.rangeOfCharacter(from: .controlCharacters.union(.newlines)) == nil }),
                  !r.scopes.isEmpty, r.scopes.count == Set(r.scopes).count,
                  Set(r.scopes).isSubset(of: ["statement", "result"]) else { throw Failure.rejected }
            _ = try hexData(r.challenge)
            let access = r.scopes.map { $0 == "statement" ? "查看账号内所有 Agent 的消费账单" : "读取账号内允许共享的已购结果" }.joined(separator: "；")
            return Presentation(authenticationReason: "允许 \(r.label) 远程读取 Yosh（\(digest.prefix(8))）",
                title: "允许这个 Agent 远程读取？",
                details: "Agent：\(r.label)\n账号：\(r.account)\n环境：\(r.environment)\n\n允许：\(access)。\n\n这份连接不能付款。你可以单独撤销它；已送达的数据无法收回。",
                challenge: r.challenge, expiresAt: r.expiresAt, agentLabel: r.label)
        }
        if object?["kind"] as? String == "control" {
            let r = try JSONDecoder().decode(ControlRequest.self, from: bytes)
            guard r.version == 1, ["offline", "devnet"].contains(r.environment), r.mode == "live_devnet", r.createdAt <= now,
                  now < r.expiresAt, r.expiresAt - r.createdAt <= 300_000, UUID(uuidString: r.id) != nil,
                  UUID(uuidString: r.memberId) != nil, r.agentLabel.count <= 120 else { throw Failure.rejected }
            _ = try hexData(r.challenge); _ = try hexData(r.sessionHash); _ = try hexData(r.basis)
            let change: String
            switch r.action.type {
            case "create_wallet":
                guard r.environment == "devnet", r.action.slot == "devnet", let network = r.action.network, let asset = r.action.assetId else { throw Failure.rejected }
                change = "开通隔离 Devnet 测试钱包（如已存在则识别原钱包）\n网络：\(network)\n付款资产：Test USDC · \(asset)\n链上手续费由用户准备测试 SOL；不承诺第三方代付。\n私钥保存在本机 Keychain，尚无经过验证的换机/抹盘恢复方案。\n不导出密钥、不充值、不创建 Grant、不解除暂停。"
            case "connection":
                guard let enabled = r.action.enabled else { throw Failure.rejected }
                change = enabled ? "启用此 Agent 的连接权限。付款仍需有效 Grant 和共享额度。不会修改正式 Codex 接线。" : "停用此 Agent 的连接，并撤销其有效授权。已提交的付款仍保留原记录。"
            case "pause":
                guard let paused = r.action.paused else { throw Failure.rejected }
                change = paused ? "暂停付款：禁止新的签名提交；已提交付款继续核对。" : "恢复付款：仅在有效 Grant 与共享额度内允许 Agent 请求付款。"
            case "daily_limit":
                let limit = try r.action.amount.map { value in value == "0" ? "0.00 Test USDC" : try amount(value) } ?? "未设置（禁止新付款）"
                change = "所有 Agent 共享的每日额度：\(limit)\n此操作不创建 Grant，也不解除暂停。"
            case "revoke_grant":
                guard let id = r.action.grantId, UUID(uuidString: id) != nil, let resource = r.action.resourceId else { throw Failure.rejected }
                change = "撤销 Grant：\(id)\nAPI：\(resource)\n禁止此授权发起新付款；不撤销已提交交易，不退款。"
            default: throw Failure.rejected
            }
            return Presentation(authenticationReason: "确认 Yosh 对 \(r.agentLabel) 的测试设置（\(digest.prefix(8))）", title: "核对 Yosh 测试设置", details: "Agent：\(r.agentLabel)\n环境：\(r.environment) · 无真实资金\n\n\(change)\n\nAgent ID：\(r.memberId)\n申请：\(r.id)\n摘要：\(digest)", challenge: r.challenge, expiresAt: r.expiresAt, agentLabel: r.agentLabel)
        }
        let request = try JSONDecoder().decode(GrantRequest.self, from: bytes)
        let mainnet = request.environment == "mainnet"
        guard (mainnet && request.binding.mode == "live_mainnet"
               && request.binding.scope.network == "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
               && request.binding.scope.assetId == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
            || (["offline", "devnet"].contains(request.environment) && request.binding.mode == "live_devnet") else { throw Failure.rejected }
        guard request.version == 1,
              request.binding.scope.assetDecimals == 6, request.createdAt <= now, now < request.expiresAt,
              request.expiresAt - request.createdAt <= 300_000,
              request.binding.input.expiresAt > now, UUID(uuidString: request.id) != nil,
              request.agentLabel.count <= 120, request.apiLabel.count <= 200 else { throw Failure.rejected }
        _ = try hexData(request.challenge); _ = try hexData(request.sessionHash); _ = try hexData(request.resourceHash)
        if mainnet {
            guard let wallet = request.payerWallet, (32...44).contains(wallet.count),
                  wallet.allSatisfy({ "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains($0) }) else { throw Failure.rejected }
        }
        let total = try amount(request.binding.input.totalLimit, mainnet: mainnet), single = try amount(request.binding.input.singleLimit, mainnet: mainnet)
        let fee: String
        if request.binding.scope.paymentScheme == "mpp_charge" {
            guard let raw = request.binding.scope.maximumNetworkFeeLamports,
                  raw.first != "0", raw.allSatisfy({ $0 >= "0" && $0 <= "9" }),
                  let integer = UInt64(raw), integer > 0, integer <= UInt64(Int64.max) else { throw Failure.rejected }
            fee = "\(integer / 1_000_000_000).\(String(format: "%09llu", integer % 1_000_000_000)) SOL（\(raw) lamports）"
        } else {
            guard request.binding.scope.paymentScheme == "exact", request.binding.scope.maximumNetworkFeeLamports == nil else { throw Failure.rejected }
            fee = ""
        }
        let feeDetails = fee.isEmpty ? "" : "\n每笔 SOL 网络手续费上限：\(fee)\n由付款钱包承担，独立于 USDC 消费额度。"
        let expiry = Date(timeIntervalSince1970: Double(request.binding.input.expiresAt) / 1000)
            .formatted(date: .abbreviated, time: .standard)
        let details = "Agent：\(request.agentLabel)\nAPI：\(request.apiLabel)\n环境：\(request.environment) · \(mainnet ? "真实资金授权" : "隔离测试")\n付款钱包：\(request.payerWallet ?? "离线测试身份")\n总额度：\(total)\n单笔上限：\(single)\(feeDetails)\n授权到期：\(expiry)\n\n网络：\(request.binding.scope.network)\n资产：\(request.binding.scope.assetId)\n收款方：\(request.binding.scope.payTo)\n付款方式：\(request.binding.scope.paymentScheme)\n\nAgent ID：\(request.binding.principal.cardMemberId)\n连接：\(request.binding.principal.connectionId) / \(request.binding.principal.connectionGeneration)\nAPI ID：\(request.binding.scope.resourceId)\n用途：\(request.binding.scope.operation)\n申请：\(request.id)\n摘要：\(digest)"
        let feeReason = fee.isEmpty ? "" : "；每笔 SOL 网络手续费上限 \(fee)"
        if let purchase = request.purchase {
            guard mainnet, now < purchase.quoteExpiresAt, request.binding.input.totalLimit == request.binding.input.singleLimit,
                  let url = URL(string: purchase.url), url.scheme == "https", url.host != nil,
                  !purchase.reason.isEmpty, purchase.reason.utf16.count <= 240,
                  !purchase.reason.unicodeScalars.contains(where: { [.control, .format, .lineSeparator, .paragraphSeparator].contains($0.properties.generalCategory) })
            else { throw Failure.rejected }
            let purchaseExpiry = Date(timeIntervalSince1970: Double(min(purchase.quoteExpiresAt, request.binding.input.expiresAt)) / 1000)
                .formatted(date: .abbreviated, time: .standard)
            let summary = "Agent：\(request.agentLabel)\n金额：\(single)\(feeDetails)\n购买项目：\(request.apiLabel)\n服务地址：\(purchase.url)\n购买原因（Agent 提供）：\(purchase.reason)\n商家：\(request.binding.scope.providerId)\n收款方：\(request.binding.scope.payTo)\n方式：\(request.binding.scope.paymentScheme)\n付款钱包：\(request.payerWallet ?? "")\n网络：\(request.binding.scope.network)\n资产：\(request.binding.scope.assetId)\n本次购买编号：\(purchase.requestId)\n到期：\(purchaseExpiry)"
            return Presentation(authenticationReason: "允许 \(request.agentLabel) 购买 \(request.apiLabel)，支付 \(single)\(feeReason)",
                title: "允许 \(request.agentLabel) 支付 \(single)？", details: summary,
                challenge: request.challenge, expiresAt: request.expiresAt, agentLabel: request.agentLabel)
        }
        return Presentation(authenticationReason: "确认 Yosh 对 \(request.agentLabel) 的\(mainnet ? "主网真实资金授权" : "测试网授权")\(feeReason)（\(digest.prefix(8))）", title: mainnet ? "核对 Yosh 主网授权" : "核对 Yosh 测试授权", details: details, challenge: request.challenge,
            expiresAt: request.expiresAt, agentLabel: request.agentLabel)
    }
    private static func confirm() throws {
        guard CommandLine.arguments.count == 1 else { throw Failure.rejected }
        var input = Data()
        while let part = try FileHandle.standardInput.read(upToCount: 4096), !part.isEmpty {
            input.append(part)
            guard input.count <= 131072 else { throw Failure.rejected }
        }
        let envelope = try JSONDecoder().decode(Envelope.self, from: input)
        let bytes = Data(envelope.body.utf8)
        guard hex(SHA256.hash(data: bytes)) == envelope.digest else { throw Failure.rejected }
        var key = try hexData(envelope.key)
        defer { key.resetBytes(in: 0..<key.count) }
        let presentation = try presentation(bytes, digest: envelope.digest)
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let alert = NSAlert()
        alert.messageText = presentation.title
        let isStatement = (try JSONSerialization.jsonObject(with: bytes) as? [String: Any])?["kind"] as? String == "statement_pairing"
        let isPurchase = (try JSONSerialization.jsonObject(with: bytes) as? [String: Any])?["purchase"] != nil
        alert.informativeText = isStatement ? presentation.details : isPurchase ? "确认后，Yosh 将按以下金额发起这一次付款。" : "只有以下这份授权会被确认。不会立即付款。"
        alert.addButton(withTitle: "确认并进行系统验证")
        alert.addButton(withTitle: "取消")
        if !isStatement {
            let view = NSTextView(frame: NSRect(x: 0, y: 0, width: 460, height: 420))
            view.isEditable = false; view.isSelectable = true
            view.font = NSFont.systemFont(ofSize: 13); view.string = presentation.details
            view.textContainer?.widthTracksTextView = true
            let scroll = NSScrollView(frame: view.frame)
            scroll.hasVerticalScroller = true; scroll.documentView = view
            alert.accessoryView = scroll
        }
        application.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { throw Failure.rejected }
        let context = LAContext(); context.localizedCancelTitle = "取消授权"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { throw Failure.rejected }
        // The immutable bytes above stay in this process through OS validation.
        // A success boolean supplied by a caller is never accepted.
        let keyCopy = key
        context.evaluatePolicy(.deviceOwnerAuthentication,
            localizedReason: presentation.authenticationReason) { success, _ in
            guard success, Int64(Date().timeIntervalSince1970 * 1000) < presentation.expiresAt else { exit(1) }
            let message = "yosh-local-grant-confirmation-v1\n\(envelope.digest)\n\(presentation.challenge)"
            let proof = hex(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: SymmetricKey(data: keyCopy)))
            print("{\"digest\":\"\(envelope.digest)\",\"proof\":\"\(proof)\"}")
            exit(0)
        }
        application.run()
        throw Failure.rejected
    }
}
