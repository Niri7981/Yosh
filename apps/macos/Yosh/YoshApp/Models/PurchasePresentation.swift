import Foundation

/// Displays the backend's safe purchase summary without treating a simulation as a chain payment.
struct PurchasePresentation {
    let title: String
    let status: String
    let delivery: String
    let mode: String
    let amount: String
    let date: String

    init(_ purchase: AppOverview.Purchase) {
        title = purchase.offerId.map { ["basic", "premium"].contains($0) } == true ? "SOL price snapshot" : (purchase.offerId ?? "Purchase")
        mode = Self.environmentLabel(purchase)
        status = switch purchase.status {
        case "PAID": switch purchase.executionMode {
            case .simulated: "Simulated payment"
            case .liveDevnet, .liveMainnet: switch purchase.deliveryStatus {
                case "PENDING", "DELIVERING": "Payment confirmed · retrieving result"
                case "EXHAUSTED": "Payment confirmed · result not recovered"
                case "UNSUPPORTED": "Payment confirmed · automatic recovery not supported"
                default: "Paid"
            }
            case .unknown: "Recorded as paid"
        }
        case "APPROVED": "Allowed"
        case "DENIED": "Denied"
        case "REQUIRES_APPROVAL": "Needs approval"
        case "PAYING": "Payment in progress"
        case "PAYMENT_UNKNOWN": "Checking original payment"
        case "FAILED": "Failed"
        case "EXPIRED": "Expired"
        default: "Status unavailable"
        }
        delivery = switch purchase.deliveryStatus {
        case "COMPLETE": "Delivered"
        case "PENDING", "DELIVERING": "Retrieving result"
        case "EXHAUSTED": "Result not recovered"
        case "UNSUPPORTED": "Automatic recovery not supported"
        default: "Not delivered"
        }
        date = Date(timeIntervalSince1970: TimeInterval(purchase.createdAt) / 1_000)
            .formatted(date: .abbreviated, time: .shortened)
        amount = Self.amount(purchase)
    }

    static func amount(_ purchase: AppOverview.Purchase, minimumFractionDigits: Int = 0) -> String {
        guard let decimals = purchase.assetDecimals, (0...18).contains(decimals) else {
            return "\(purchase.amount.value) base units"
        }
        let digits = String(purchase.amount.value)
        let value: String
        if decimals == 0 {
            value = digits
        } else {
            let padded = String(repeating: "0", count: max(0, decimals + 1 - digits.count)) + digits
            let whole = String(padded.dropLast(decimals))
            let trimmed = String(padded.suffix(decimals)).replacingOccurrences(of: "0+$", with: "", options: .regularExpression)
            let fractional = trimmed.padding(toLength: max(trimmed.count, min(decimals, minimumFractionDigits)), withPad: "0", startingAt: 0)
            value = fractional.isEmpty ? whole : "\(whole).\(fractional)"
        }
        return "\(value) \(assetLabel(purchase))"
    }

    static func assetLabel(_ purchase: AppOverview.Purchase) -> String {
        guard let symbol = purchase.currency?.trimmingCharacters(in: .whitespacesAndNewlines),
              (2...10).contains(symbol.count),
              symbol.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) }) else {
            return "asset units"
        }
        return scopedAssetLabel(symbol: symbol, environment: purchase.monetaryEnvironment, network: purchase.network) ?? "Asset not verified"
    }

    static func scopedAssetLabel(symbol: String, environment: String?, network: String?) -> String? {
        let ticker = symbol.replacingOccurrences(of: "test ", with: "", options: [.caseInsensitive, .anchored])
            .trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard (2...10).contains(ticker.count), ticker.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) }) else { return nil }
        // Only persisted, matching monetary scope may identify production or test funds.
        switch (environment, network) {
        case ("live_mainnet", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"): return ticker
        case ("live_devnet", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"),
             ("legacy_test", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"),
             ("simulated", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"): return "Test \(ticker)"
        default: return nil
        }
    }

    static func environmentLabel(_ purchase: AppOverview.Purchase) -> String {
        if purchase.offline == true { return "Offline · No real funds" }
        return switch (purchase.monetaryEnvironment, purchase.network) {
        case ("live_mainnet", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"): "Mainnet"
        case ("live_devnet", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"),
             ("legacy_test", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"): "Devnet · Developer"
        case ("simulated", _): "Simulation"
        default: purchase.executionMode == .simulated ? "Simulation" : "Environment not verified"
        }

    }
}

/// Separates policy, payment, and delivery facts in Activity.
struct ActivityPurchasePresentation {
    enum Icon: Equatable { case asset(String), symbol(String) }
    enum Section: String, CaseIterable {
        case paid = "Paid"
        case notPaid = "Not Paid"
        case needsAttention = "Needs Attention"
        case simulated = "Simulation"
    }

    let section: Section
    let title: String
    let symbol: String
    let icon: Icon
    let status: String
    var compactStatus: String {
        switch status {
        case "Payment confirmed · retrieving result": "Paid · retrieving"
        case "Payment confirmed · result not recovered": "Paid · not recovered"
        case "Payment confirmed · automatic recovery not supported": "Paid · no recovery"
        default: status
        }
    }
    let supportingStatus: String?
    let policy: String
    let denialReason: String?
    let payment: String
    let delivery: String
    let mode: String
    let amount: String
    let time: String
    let timestamp: String

    init(_ purchase: AppOverview.Purchase) {
        section = switch purchase.status {
        case "PAID": switch purchase.executionMode {
            case .liveDevnet, .liveMainnet: .paid
            case .simulated: .simulated
            case .unknown: .needsAttention
        }
        case "DENIED", "EXPIRED", "FAILED", "APPROVED", "REQUIRES_APPROVAL": .notPaid
        case "PAYING", "PAYMENT_UNKNOWN": .needsAttention
        default: .needsAttention
        }

        switch purchase.resourceId ?? purchase.offerId {
        case "market-analysis":
            title = "Market Analysis"
            symbol = "chart.bar.xaxis"
        case "market-snapshot", "sol-market-snapshot", "premium-sol-market-snapshot", "basic", "premium":
            title = "Market Snapshot"
            symbol = "chart.line.uptrend.xyaxis"
        case "token-risk-report":
            title = "Token Risk Report"
            symbol = "doc.text"
        default:
            title = purchase.resourceId ?? purchase.offerId ?? "Purchase"
            symbol = "chevron.left.forwardslash.chevron.right"
        }
        icon = Self.resourceIcon(resourceId: purchase.resourceId ?? purchase.offerId, providerId: purchase.providerId)

        let simulated = purchase.executionMode == .simulated
        // A legacy simulated PAID record is not evidence that money changed hands.
        switch purchase.status {
        case "PAID" where simulated:
            status = "Simulated"
        case "PAID" where purchase.executionMode == .unknown:
            status = "Payment unverified"
        case "PAID" where purchase.deliveryStatus == "COMPLETE":
            status = "Delivered"
        case "PAID" where purchase.deliveryStatus == "EXHAUSTED":
            status = "Payment confirmed · result not recovered"
        case "PAID" where purchase.deliveryStatus == "PENDING" || purchase.deliveryStatus == "DELIVERING":
            status = "Payment confirmed · retrieving result"
        case "PAID" where purchase.deliveryStatus == "UNSUPPORTED":
            status = "Payment confirmed · automatic recovery not supported"
        case "PAID":
            status = "Paid"
        case "PAYING":
            status = "Paying"
        case "PAYMENT_UNKNOWN":
            status = "Checking original payment"
        case "DENIED":
            status = "Denied"
        case "EXPIRED":
            status = "Expired"
        case "APPROVED":
            status = "Allowed"
        case "FAILED":
            status = "Failed"
        case "REQUIRES_APPROVAL":
            status = "Needs approval"
        default:
            status = "Status unavailable"
        }

        supportingStatus = purchase.status == "APPROVED" ? "No payment made" : purchase.status == "PAID" && !simulated && purchase.executionMode != .unknown ? "Paid" : nil
        policy = switch purchase.status {
        case "DENIED": "Denied"
        case "REQUIRES_APPROVAL": "Needs approval"
        case "APPROVED", "PAYING", "PAYMENT_UNKNOWN", "PAID", "FAILED", "EXPIRED": "Allowed"
        default: "Unavailable"
        }
        denialReason = purchase.status == "DENIED" ? Self.reason(purchase.decisionReason) : nil
        payment = if simulated {
            "No payment made · Simulated"
        } else {
            switch purchase.status {
            case "PAID" where purchase.executionMode == .unknown: "Unverified"
            case "PAID": "Paid"
            case "PAYING": "In progress"
            case "PAYMENT_UNKNOWN": "Checking original payment"
            case "FAILED": "Failed"
            default: "Not started"
            }
        }
        delivery = switch purchase.deliveryStatus {
        case "COMPLETE": simulated ? "Simulated delivery" : "Delivered"
        case "PENDING", "DELIVERING": "Retrieving result"
        case "EXHAUSTED": "Result not recovered"
        case "UNSUPPORTED": "Automatic recovery not supported"
        default: "Not delivered"
        }
        mode = PurchasePresentation.environmentLabel(purchase)
        amount = PurchasePresentation.amount(purchase, minimumFractionDigits: 2)
        let date = Date(timeIntervalSince1970: TimeInterval(purchase.createdAt) / 1_000)
        time = date.formatted(date: .omitted, time: .shortened)
        timestamp = date.formatted(date: .abbreviated, time: .shortened)
    }

    private static func resourceIcon(resourceId: String?, providerId: String?) -> Icon {
        switch providerId?.lowercased() {
        case "openai", "openai-api": return .asset("ProviderOpenAI")
        case "vercel": return .symbol("server.rack")
        case "notion": return .symbol("note.text")
        case "demo-market-data-provider", "market-data": return .symbol("waveform.path")
        default: break
        }
        let key = resourceId?.lowercased() ?? ""
        if key.contains("market") || key.contains("price") || key.contains("snapshot") {
            return .symbol("waveform.path")
        }
        if key.contains("risk") || key.contains("report") { return .symbol("doc.text.magnifyingglass") }
        if key.contains("host") || key.contains("deploy") || key.contains("build") { return .symbol("server.rack") }
        if key.contains("note") || key.contains("document") { return .symbol("note.text") }
        return .symbol("chevron.left.forwardslash.chevron.right")
    }

    private static func reason(_ code: String?) -> String? {
        guard let code, !code.isEmpty else { return nil }
        return switch code {
        case "PAYMENTS_PAUSED": "Payments are paused"
        case "SPEND_GRANT_REVOKED": "Spend Grant revoked"
        case "SPEND_GRANT_EXPIRED": "Spend Grant expired"
        case "SPEND_GRANT_REQUIRED": "Spend Grant required"
        case "SPEND_GRANT_SINGLE_LIMIT_EXCEEDED": "Per-transaction limit exceeded"
        case "SPEND_GRANT_TOTAL_LIMIT_EXCEEDED": "Spend Grant limit exceeded"
        case "DAILY_BUDGET_EXCEEDED": "Daily Authority exceeded"
        default: "Request did not meet current spending rules"
        }
    }
}
