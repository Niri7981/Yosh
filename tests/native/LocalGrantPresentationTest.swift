import Foundation

@main
@MainActor
struct LocalGrantPresentationTest {
    static func main() throws {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let wallet = "11111111111111111111111111111111"
        var request: [String: Any] = [
            "version": 1, "id": UUID().uuidString, "challenge": String(repeating: "a", count: 64),
            "sessionHash": String(repeating: "b", count: 64), "resourceHash": String(repeating: "c", count: 64),
            "createdAt": now, "expiresAt": now + 300_000, "environment": "mainnet",
            "agentLabel": "Fixture Agent", "apiLabel": "Fixture API", "payerWallet": wallet,
            "binding": ["mode": "live_mainnet", "input": ["totalLimit": "1000", "singleLimit": "1000", "expiresAt": now + 3_600_000],
                "principal": ["cardMemberId": UUID().uuidString, "connectionId": UUID().uuidString, "connectionGeneration": 1],
                "scope": ["resourceId": "fixture", "providerId": "fixture", "operation": "paid.resource.purchase",
                    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "assetId": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    "assetDecimals": 6, "payTo": "4aU7aegXejAjF84J9eu2B6boC1Exa3i6cxP3diDULJbs", "paymentScheme": "exact"]]
        ]
        func render(_ value: [String: Any]) throws -> Presentation {
            try LocalGrantConfirmation.presentation(JSONSerialization.data(withJSONObject: value), digest: String(repeating: "d", count: 64))
        }
        let mainnet = try render(request)
        precondition(mainnet.title == "核对 Yosh 主网授权")
        precondition(mainnet.details.contains("付款钱包：" + wallet))
        precondition(mainnet.authenticationReason.contains("主网真实资金授权"))
        precondition(!mainnet.authenticationReason.contains("测试"))
        request.removeValue(forKey: "payerWallet")
        do { _ = try render(request); fatalError("Missing Mainnet wallet accepted") } catch { }
        request["payerWallet"] = "wrong\n钱包"
        do { _ = try render(request); fatalError("Invalid wallet accepted") } catch { }
        request["payerWallet"] = wallet
        request["environment"] = "devnet"
        guard var binding = request["binding"] as? [String: Any] else { fatalError("Missing fixture binding") }
        binding["mode"] = "live_devnet"
        guard var scope = binding["scope"] as? [String: Any] else { fatalError("Missing fixture scope") }
        scope["network"] = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
        scope["assetId"] = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
        binding["scope"] = scope; request["binding"] = binding
        let devnet = try render(request)
        precondition(devnet.authenticationReason.contains("测试网授权"))
        precondition(!devnet.authenticationReason.contains("主网真实资金"))
        scope["paymentScheme"] = "mpp_charge"
        binding["scope"] = scope; request["binding"] = binding
        do { _ = try render(request); fatalError("Missing MPP fee consent accepted") } catch { }
        for invalid in ["0", "01", "1.5", "1e4", "-1", "9223372036854775808"] {
            scope["maximumNetworkFeeLamports"] = invalid
            binding["scope"] = scope; request["binding"] = binding
            do { _ = try render(request); fatalError("Invalid MPP fee accepted") } catch { }
        }
        scope["maximumNetworkFeeLamports"] = "10001"
        binding["scope"] = scope; request["binding"] = binding
        let mpp = try render(request)
        precondition(mpp.details.contains("每笔 SOL 网络手续费上限：0.000010001 SOL（10001 lamports）"))
        precondition(mpp.authenticationReason.contains("0.000010001 SOL（10001 lamports）"))
        scope["maximumNetworkFeeLamports"] = "10002"
        binding["scope"] = scope; request["binding"] = binding
        let changedMpp = try render(request)
        precondition(changedMpp.details.contains("0.000010002 SOL（10002 lamports）"))
        precondition(!changedMpp.details.contains("10001 lamports"))
        request["environment"] = "mainnet"; binding["mode"] = "live_mainnet"
        scope["network"] = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
        scope["assetId"] = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        binding["scope"] = scope; request["binding"] = binding
        let mainnetMpp = try render(request)
        precondition(mainnetMpp.authenticationReason.contains("主网真实资金授权"))
        precondition(mainnetMpp.details.contains("付款钱包：" + wallet))
        precondition(mainnetMpp.details.contains("10002 lamports"))
        scope.removeValue(forKey: "maximumNetworkFeeLamports")
        binding["scope"] = scope; request["binding"] = binding
        do { _ = try render(request); fatalError("Mainnet MPP without fee consent accepted") } catch { }
        let control: [String: Any] = ["version": 1, "kind": "control", "id": UUID().uuidString,
            "challenge": String(repeating: "a", count: 64), "sessionHash": String(repeating: "b", count: 64),
            "basis": String(repeating: "c", count: 64), "createdAt": now, "expiresAt": now + 300_000,
            "environment": "devnet", "mode": "live_devnet", "memberId": UUID().uuidString,
            "agentLabel": "Fixture", "action": ["type": "pause", "paused": true]]
        let controlPresentation = try render(control)
        precondition(controlPresentation.authenticationReason.contains("测试设置"))
        print("Native presentation: Mainnet/Devnet wallet and MPP fee consent passed. No UI or authentication invoked.")
    }
}
