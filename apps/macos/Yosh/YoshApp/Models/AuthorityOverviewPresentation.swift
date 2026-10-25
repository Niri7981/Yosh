import Foundation

/// Formats backend facts for the approved Authority card without making spending decisions.
struct AuthorityOverviewPresentation {
    let remaining: String
    let reserved: String
    let paid: String
    let asset: String
    let dailyState: String?
    let blockedReason: String?
    let dailyLimit: String
    let progress: Double
    let grantRemaining: String
    let grantDetail: String
    let perTransaction: String
    let payments: String
    let execution: String
    let latest: Latest?

    struct Latest {
        let purchase: AppOverview.Purchase
        let purchaseId: String
        let title: String
        let purpose: String?
        let symbol: String
        let payment: String
        let recency: String
        let amount: String
        let decision: String
        let decisionTone: DecisionTone
        let paymentConfirmed: Bool

        enum DecisionTone {
            case approved, denied, neutral
        }
    }

    init(_ overview: AppOverview, now: Date = .now) {
        let budget = overview.budget
        let scope = overview.selectedAuthority
        let legacyTest = overview.service.purchaseMode != .liveMainnet
        remaining = scope?.availableDisplay ?? (legacyTest ? budget.remaining.map { Self.money($0, decimals: 6) } ?? "—" : "—")
        reserved = scope?.reservedDisplay ?? (legacyTest ? Self.money(budget.reserved, decimals: 6) : "—")
        paid = scope?.paidDisplay ?? (legacyTest ? Self.money(budget.paid, decimals: 6) : "—")
        asset = DailyAuthorityPresentation(overview: overview).currency ?? "Asset unavailable"
        dailyState = scope?.dailyState.label
        blockedReason = scope?.blockers.first
        dailyLimit = scope?.dailyLimitDisplay ?? (legacyTest ? budget.dailyLimit.map { "of \(Self.money($0, decimals: 6)) daily" } ?? "Daily Authority required" : "Mainnet Daily Authority required")
        if let limit = (scope?.dailyLimit ?? (legacyTest ? budget.dailyLimit : nil))?.value, let available = (scope?.available ?? (legacyTest ? budget.remaining : nil))?.value, limit > 0 {
            progress = min(1, Double(available) / Double(limit))
        } else {
            progress = 0
        }

        if let grant = overview.scopedGrant, grant.status == .active, scope?.grant?.usable ?? legacyTest {
            grantRemaining = scope?.grant?.remainingDisplay ?? Self.money(grant.remaining, decimals: grant.assetDecimals)
            grantDetail = "remaining"
            perTransaction = scope?.grant?.singleDisplay ?? Self.money(grant.singleLimit, decimals: grant.assetDecimals)
        } else {
            grantRemaining = "—"
            switch overview.scopedGrant?.status {
            case .revoked: grantDetail = "revoked"
            case .expired: grantDetail = "expired"
            case .active: grantDetail = scope?.blockers.first(where: { $0.hasPrefix("Spend Grant") }) ?? "not usable"
            case nil: grantDetail = "not set"
            }
            perTransaction = "—"
        }

        payments = overview.service.status == .stopping ? "Stopping" : (budget.paused ? "Paused" : "On")
        execution = overview.service.purchaseMode.title

        if let purchase = overview.activityPurchases.first {
            let formatted = PurchasePresentation(purchase)
            let date = Date(timeIntervalSince1970: TimeInterval(purchase.createdAt) / 1_000)
            let elapsed = RelativeDateTimeFormatter().localizedString(for: date, relativeTo: now)
            let title: String
            let symbol: String
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
                title = purchase.resourceId ?? formatted.title
                symbol = "doc.text"
            }

            let payment = switch purchase.status {
            case "APPROVED", "DENIED": "Not paid"
            case "REQUIRES_APPROVAL": "Awaiting approval"
            default: formatted.status
            }
            let decision = switch purchase.status {
            case "APPROVED", "PAYING", "PAYMENT_UNKNOWN", "PAID", "FAILED", "EXPIRED": "Allowed"
            case "DENIED": "Denied"
            case "REQUIRES_APPROVAL": "Needs approval"
            default: "Decision not provided"
            }
            // Policy approval survives payment failure, but unresolved and simulated
            // payments must never inherit a paid/success appearance.
            let paymentConfirmed = purchase.status == "PAID" && (purchase.executionMode == .liveDevnet || purchase.executionMode == .liveMainnet)
            let tone: Latest.DecisionTone = switch purchase.status {
            case "DENIED": .denied
            case "APPROVED": .approved
            case "PAID" where paymentConfirmed: .approved
            default: .neutral
            }
            let purpose = purchase.reason?.trimmingCharacters(in: .whitespacesAndNewlines)
            latest = Latest(purchase: purchase, purchaseId: purchase.purchaseId, title: title, purpose: purpose?.isEmpty == false ? purpose : nil,
                symbol: symbol, payment: payment, recency: elapsed, amount: formatted.amount,
                decision: decision, decisionTone: tone, paymentConfirmed: paymentConfirmed)
        } else {
            latest = nil
        }
    }

    private static func money(_ amount: MinorUnits, decimals: Int) -> String {
        guard (0...18).contains(decimals) else { return "—" }
        let divisor = Decimal(string: "1" + String(repeating: "0", count: decimals)) ?? 1
        let value = Decimal(amount.value) / divisor
        return value.formatted(.currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
    }
}
