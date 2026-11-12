import AppKit
import CryptoKit
import Foundation
import LocalAuthentication

// Narrow confirmation component. There is deliberately no approve flag,
// arbitrary signing command, exported key, HTTP listener or test bypass.
private struct Envelope: Decodable { let body: String; let digest: String; let key: String }
private struct GrantInput: Decodable { let totalLimit: String; let singleLimit: String; let expiresAt: Int64 }
private struct Principal: Decodable { let cardMemberId: String; let connectionId: String; let connectionGeneration: Int }
private struct Scope: Decodable {
    let resourceId: String; let providerId: String; let operation: String
    let network: String; let assetId: String; let assetDecimals: Int
    let payTo: String; let paymentScheme: String
}
private struct Binding: Decodable { let input: GrantInput; let principal: Principal; let scope: Scope; let mode: String }
private struct GrantRequest: Decodable {
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
    static func main() {
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
        let expiry = Date(timeIntervalSince1970: Double(request.binding.input.expiresAt) / 1000)
            .formatted(date: .abbreviated, time: .standard)
        let details = "Agent：\(request.agentLabel)\nAPI：\(request.apiLabel)\n环境：\(request.environment) · \(mainnet ? "真实资金授权" : "隔离测试")\n付款钱包：\(request.payerWallet ?? "离线测试身份")\n总额度：\(total)\n单笔上限：\(single)\n授权到期：\(expiry)\n\n网络：\(request.binding.scope.network)\n资产：\(request.binding.scope.assetId)\n收款方：\(request.binding.scope.payTo)\n付款方式：\(request.binding.scope.paymentScheme)\n\nAgent ID：\(request.binding.principal.cardMemberId)\n连接：\(request.binding.principal.connectionId) / \(request.binding.principal.connectionGeneration)\nAPI ID：\(request.binding.scope.resourceId)\n用途：\(request.binding.scope.operation)\n申请：\(request.id)\n摘要：\(digest)"
        return Presentation(authenticationReason: "确认 Yosh 对 \(request.agentLabel) 的\(mainnet ? "主网真实资金授权" : "测试网授权")（\(digest.prefix(8))）", title: mainnet ? "核对 Yosh 主网授权" : "核对 Yosh 测试授权", details: details, challenge: request.challenge,
            expiresAt: request.expiresAt, agentLabel: request.agentLabel)
    }
    private static func confirm() throws {
        guard CommandLine.arguments.count == 1 else { throw Failure.rejected }
        var input = Data()
        while let part = try FileHandle.standardInput.read(upToCount: 4096), !part.isEmpty {
            input.append(part)
            guard input.count <= 32768 else { throw Failure.rejected }
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
        alert.informativeText = "只有以下这份授权会被确认。不会立即付款。"
        alert.addButton(withTitle: "确认并进行系统验证")
        alert.addButton(withTitle: "取消")
        let view = NSTextView(frame: NSRect(x: 0, y: 0, width: 460, height: 420))
        view.isEditable = false; view.isSelectable = true
        view.font = NSFont.systemFont(ofSize: 13); view.string = presentation.details
        view.textContainer?.widthTracksTextView = true
        let scroll = NSScrollView(frame: view.frame)
        scroll.hasVerticalScroller = true; scroll.documentView = view
        alert.accessoryView = scroll
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
