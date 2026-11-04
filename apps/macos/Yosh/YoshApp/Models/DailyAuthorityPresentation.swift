import Foundation

struct DailyAuthorityPresentation {
    let currency: String?
    private var network: String? = nil
    private var assetId: String? = nil
    private var decimals: Int? = nil

    init(network: String) {
        currency = switch network.lowercased() {
        case "solana devnet", "devnet": "Test USDC"
        case "solana mainnet", "solana mainnet-beta", "mainnet", "mainnet-beta": "USDC"
        default: nil
        }
    }

    init(overview: AppOverview) {
        self.init(network: overview.service.network)
        if let scope = overview.selectedAuthority {
            self = DailyAuthorityPresentation(currency: PurchasePresentation.scopedAssetLabel(symbol: scope.assetLabel, environment: scope.mode.rawValue, network: scope.network), network: scope.network, assetId: scope.assetId, decimals: scope.assetDecimals)
        } else if let environment = overview.service.execution {
            self = DailyAuthorityPresentation(currency: environment.assetLabel,
                network: environment.network, assetId: environment.asset.mint, decimals: environment.asset.decimals)
        }
    }

    private init(currency: String?, network: String, assetId: String, decimals: Int) {
        self.currency = currency; self.network = network; self.assetId = assetId; self.decimals = decimals
    }

    /// Never relabel a test or stale-network balance as Mainnet money.
    func balanceDisplay(_ balance: AppBalance) -> String? {
        guard balance.available, let currency else { return nil }
        if let network {
            guard balance.network == network, balance.assetId == assetId, balance.assetDecimals == decimals else { return nil }
        }
        let components = balance.display.split(separator: " ", maxSplits: 1)
        guard components.count == 2, String(components[1]).caseInsensitiveCompare(currency) == .orderedSame else { return nil }
        return "\(components[0]) \(currency)"
    }

    // Editor conversion only. The existing management API independently validates the shared limit.
    static func configuredLimit(in overview: AppOverview) -> Int64? {
        overview.selectedAuthority?.dailyLimit?.value
            ?? (overview.service.purchaseMode == .liveMainnet ? nil : overview.budget.dailyLimit?.value)
    }

    static func minorUnits(_ input: String) -> String? {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: #"^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$"#, options: .regularExpression) != nil else { return nil }
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        let fraction = parts.count == 2 ? String(parts[1]) : ""
        let raw = String(parts[0]) + fraction.padding(toLength: 6, withPad: "0", startingAt: 0)
        let normalized = String(raw.drop(while: { $0 == "0" }))
        let amount = normalized.isEmpty ? "0" : normalized
        return amount.count <= 15 ? amount : nil
    }

    static func editableLimit(_ amount: Int64?) -> String {
        guard let amount else { return "" }
        let padded = String(repeating: "0", count: max(0, 7 - String(amount).count)) + String(amount)
        let whole = String(padded.dropLast(6))
        let fraction = String(padded.suffix(6)).replacingOccurrences(of: "0+$", with: "", options: .regularExpression)
        return "\(whole).\(fraction.padding(toLength: max(2, fraction.count), withPad: "0", startingAt: 0))"
    }
}
