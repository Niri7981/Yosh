import Foundation

/// A transaction story from the safe overview, not an invented event log.
struct PurchaseDetailPresentation {
    enum Tone { case success, pending, negative, neutral }

    struct Stage: Identifiable {
        enum Kind {
            case approved, denied, needsApproval, expired, paid, paying, paymentUnknown, failed
            case simulatedPayment, paymentUnverified, delivered, deliveryPending, deliveryExhausted, deliveryUnavailable, simulatedDelivery, unavailable
        }
        let id: Kind
        let title: String
        let detail: String
        let tone: Tone
        // The overview supplies creation time only. It cannot timestamp approval, payment, or delivery.
        let time: String? = nil
    }

    struct Receipt: Identifiable {
        var id: String { label }
        let label: String
        let value: String
        let copyValue: String?
    }

    let title: String
    let status: String
    let tone: Tone
    let stages: [Stage]
    let authorityTitle: String
    let authorityReason: String
    let resourceID: String?
    let providerName: String
    let resourceContext: String?
    let facts: [Receipt]
    let receipts: [Receipt]
    let explorerURL: URL?

    init(_ purchase: AppOverview.Purchase, agentName: String = "Agent unavailable") {
        let item = ActivityPurchasePresentation(purchase)
        title = item.title == "agent402-crypto-price" ? "Crypto price data" : item.title
        status = item.status
        tone = switch purchase.status {
        case "PAID" where purchase.offline != true
            && (purchase.executionMode == .liveDevnet || purchase.executionMode == .liveMainnet):
            purchase.deliveryStatus == "COMPLETE" ? .success : purchase.deliveryStatus == "EXHAUSTED" ? .negative : .pending
        case "PAYING", "PAYMENT_UNKNOWN", "REQUIRES_APPROVAL": .pending
        case "DENIED", "FAILED": .negative
        default: .neutral
        }

        let reason = Self.nonempty(purchase.decisionReason)
        let approvedStates = ["APPROVED", "PAYING", "PAYMENT_UNKNOWN", "PAID"]
        let approved = approvedStates.contains(purchase.status) || (["EXPIRED", "FAILED"].contains(purchase.status)
            && ["AUTHORITY_AND_BUDGET_PASSED", "AUTHORITY_BUDGET_AND_GRANT_PASSED"].contains(reason ?? ""))
        authorityTitle = switch purchase.status {
        case "DENIED": "Denied by policy"
        case "REQUIRES_APPROVAL": "Approval required"
        default: if approved {
            ["AUTHORITY_AND_BUDGET_PASSED", "AUTHORITY_BUDGET_AND_GRANT_PASSED"].contains(reason ?? "")
                ? "Allowed automatically" : "Allowed by policy"
        } else { "Decision unavailable" }
        }
        authorityReason = Self.policyReason(reason, approved: approved)

        let confirmedPayment = purchase.offline != true && (purchase.executionMode == .liveMainnet || purchase.executionMode == .liveDevnet)
        let network = Self.nonempty(purchase.network)
        let paymentContext = purchase.offline == true ? "\(item.amount) · Offline · No real funds"
            : [item.amount, network.map(Self.shortNetwork)].compactMap { $0 }.joined(separator: " · ")
        var observed: [Stage] = []
        if approved {
            observed.append(Stage(id: .approved, title: "Allowed",
                detail: purchase.status == "APPROVED" ? "No payment made." : "Request allowed by policy.", tone: purchase.offline == true ? .neutral : .success))
        }
        switch purchase.status {
        case "APPROVED": break
        case "DENIED":
            observed.append(Stage(id: .denied, title: "Denied", detail: "No payment made.", tone: .negative))
        case "REQUIRES_APPROVAL":
            observed.append(Stage(id: .needsApproval, title: "Needs approval", detail: "Payment has not started.", tone: .pending))
        case "EXPIRED":
            observed.append(Stage(id: .expired, title: "Expired", detail: "Expired before payment started.", tone: .neutral))
        case "FAILED":
            observed.append(Stage(id: .failed, title: "Payment failed", detail: "No confirmed payment.", tone: .negative))
        case "PAYING":
            observed.append(Stage(id: .paying, title: "Payment in progress", detail: paymentContext, tone: .pending))
        case "PAYMENT_UNKNOWN":
            observed.append(Stage(id: .paymentUnknown, title: "Checking original payment", detail: "Yosh is verifying whether the original payment was submitted. Reserved funds remain held until this is resolved.", tone: .pending))
        case "PAID":
            switch purchase.executionMode {
            case .simulated:
                observed.append(Stage(id: .simulatedPayment, title: "Simulated payment",
                    detail: "\(item.amount) · No funds transferred", tone: .neutral))
            case .unknown:
                observed.append(Stage(id: .paymentUnverified, title: "Payment unverified",
                    detail: "\(item.amount) · Execution mode unavailable", tone: .neutral))
            case .liveDevnet, .liveMainnet:
                observed.append(Stage(id: .paid, title: "Paid", detail: paymentContext, tone: confirmedPayment ? .success : .neutral))
            }
            if purchase.deliveryStatus == "COMPLETE" {
                if purchase.executionMode == .simulated {
                    observed.append(Stage(id: .simulatedDelivery, title: "Simulated delivery",
                        detail: "Resource returned in simulation.", tone: .neutral))
                } else {
                    observed.append(Stage(id: .delivered,
                        title: purchase.executionMode == .unknown ? "Resource returned" : "Delivered",
                        detail: "Resource returned successfully.",
                        tone: confirmedPayment ? .success : .neutral))
                }
            } else if purchase.deliveryStatus == "PENDING" || purchase.deliveryStatus == "DELIVERING" {
                observed.append(Stage(id: .deliveryPending, title: confirmedPayment ? "Payment confirmed · retrieving result" : "Retrieving result",
                    detail: confirmedPayment ? "Retrieving the result using the original payment. No second payment is made." : "Result not yet returned. No confirmed payment is shown.", tone: .pending))
            } else if purchase.deliveryStatus == "EXHAUSTED" {
                observed.append(Stage(id: .deliveryExhausted, title: confirmedPayment ? "Payment confirmed · result not recovered" : "Result not recovered",
                    detail: confirmedPayment ? "Automatic recovery attempts ended. The original payment remains confirmed." : "Automatic recovery attempts ended. No confirmed payment is shown.", tone: .negative))
            } else if purchase.deliveryStatus == "UNSUPPORTED" {
                observed.append(Stage(id: .deliveryUnavailable, title: confirmedPayment ? "Payment confirmed · automatic recovery not supported" : "Automatic recovery not supported",
                    detail: confirmedPayment ? "Payment confirmed; this resource cannot be recovered automatically." : "This resource cannot be recovered automatically. No confirmed payment is shown.", tone: .pending))
            }
        default:
            observed.append(Stage(id: .unavailable, title: "Status unavailable",
                detail: "No lifecycle details provided.", tone: .neutral))
        }
        stages = observed

        // Merchant, URL, pay-to address, and payment channel are not exposed by this summary.
        resourceID = Self.nonempty(purchase.resourceId) ?? Self.nonempty(purchase.offerId)
        providerName = switch Self.nonempty(purchase.providerId)?.lowercased() {
        case "openai", "openai-api": "OpenAI"
        case "vercel": "Vercel"
        case "notion": "Notion"
        case "demo-market-data-provider", "market-data": "Market Data"
        case .some(let provider): provider
        case .none: "Provider not provided"
        }
        resourceContext = Self.nonempty(purchase.reason)
        var contextFacts = [
            Receipt(label: "Agent", value: agentName, copyValue: nil),
            Receipt(label: "Resource", value: title, copyValue: nil),
            Receipt(label: "Amount", value: item.amount, copyValue: nil),
            Receipt(label: "Environment", value: purchase.offline == true ? "Offline · No real funds" : item.mode, copyValue: nil),
            Receipt(label: "Network", value: network.map(Self.receiptNetwork) ?? "Unavailable", copyValue: nil),
            Receipt(label: "Payment", value: item.payment, copyValue: nil),
            Receipt(label: "Delivery", value: item.delivery, copyValue: nil),
        ]
        if let trace = purchase.executionTrace, trace.source == "pay_mcp" {
            contextFacts.append(Receipt(label: "Route", value: trace.complete ? "Pay MCP · Traced" : "Pay MCP · Trace incomplete", copyValue: nil))
        }
        facts = contextFacts
        explorerURL = purchase.offline == true ? nil : Self.explorerURL(transaction: purchase.transaction, network: network,
            environment: purchase.monetaryEnvironment)
        var fields: [Receipt] = []
        if let trace = purchase.executionTrace, trace.source == "pay_mcp" {
            fields.append(Receipt(label: "Operation", value: trace.operationId, copyValue: trace.operationId))
            fields.append(Receipt(label: "Trace ID", value: trace.traceId, copyValue: trace.traceId))
        }
        // A simulated transaction string is not a chain receipt.
        if purchase.executionMode != .simulated, let transaction = Self.nonempty(purchase.transaction) {
            fields.append(Receipt(label: "Signature", value: transaction, copyValue: transaction))
        }
        fields.append(Receipt(label: "Request ID", value: purchase.purchaseId, copyValue: purchase.purchaseId))
        if let network {
            fields.append(Receipt(label: "Network", value: Self.receiptNetwork(network), copyValue: nil))
        }
        if purchase.createdAt > 0 {
            fields.append(Receipt(label: "Request time", value: item.timestamp, copyValue: nil))
        }
        if let assetID = Self.nonempty(purchase.assetId) {
            fields.append(Receipt(label: "Asset ID", value: assetID, copyValue: assetID))
        }
        receipts = fields
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    private static func shortNetwork(_ value: String) -> String {
        switch value {
        case "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "solana:devnet", "Solana Devnet": "Devnet · Solana"
        case "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "Solana Mainnet": "Mainnet · Solana"
        default: value
        }
    }

    private static func receiptNetwork(_ value: String) -> String {
        shortNetwork(value)
    }

    private static func explorerURL(transaction: String?, network: String?, environment: String?) -> URL? {
        guard let transaction = nonempty(transaction), (64...100).contains(transaction.count),
              transaction.utf8.allSatisfy({ (49...57).contains($0) || (65...72).contains($0)
                  || (74...78).contains($0) || (80...90).contains($0)
                  || (97...107).contains($0) || (109...122).contains($0) }) else { return nil }
        switch (environment, network) {
        case ("live_mainnet", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"):
            return URL(string: "https://explorer.solana.com/tx/\(transaction)")
        case ("live_devnet", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"):
            return URL(string: "https://explorer.solana.com/tx/\(transaction)?cluster=devnet")
        default: return nil
        }
    }

    private static func policyReason(_ code: String?, approved: Bool) -> String {
        guard let code else { return approved ? "Policy reason not provided." : "Decision reason not provided." }
        return switch code {
        case "AUTHORITY_BUDGET_AND_GRANT_PASSED":
            "Matched the Spend Grant when allowed.\nWithin Daily Authority, Spend Grant, and per-transaction limits."
        case "AUTHORITY_AND_BUDGET_PASSED": "Within daily and per-transaction limits."
        case "SINGLE_LIMIT_EXCEEDED": "The per-transaction limit requires your approval."
        case "DAILY_BUDGET_EXCEEDED": "The shared Daily Authority was exceeded."
        case "DAILY_LIMIT_NOT_SET": "The shared Daily Authority is not set."
        case "DAILY_LIMIT_ZERO": "The shared Daily Authority is zero."
        case "INVALID_DAILY_LIMIT": "The Daily Authority is invalid."
        case "INVALID_SINGLE_LIMIT": "The per-transaction limit is invalid."
        case "PAYMENTS_PAUSED": "Payments are paused."
        case "SPEND_GRANT_REQUIRED": "A Spend Grant is required."
        case "SPEND_GRANT_REVOKED": "The Spend Grant was revoked."
        case "SPEND_GRANT_EXPIRED": "The Spend Grant expired."
        case "SPEND_GRANT_INACTIVE": "The Spend Grant is inactive."
        case "SPEND_GRANT_PRINCIPAL_MISMATCH": "The Spend Grant no longer matches this Agent."
        case "SPEND_GRANT_SCOPE_MISMATCH": "The request is outside the Spend Grant's scope."
        case "SPEND_GRANT_SINGLE_LIMIT_EXCEEDED": "The Spend Grant's per-transaction limit was exceeded."
        case "SPEND_GRANT_TOTAL_LIMIT_EXCEEDED": "The Spend Grant's total limit was exceeded."
        case "SPEND_GRANT_ACCOUNTING_INVALID": "The Spend Grant's spending could not be verified."
        case "CARD_MEMBER_REVOKED": "This Agent's access was revoked."
        case "INVALID_SPEND_INTENT": "The purchase request is invalid."
        case "SPEND_INTENT_EXPIRED_OR_INVALID": "The purchase request expired or is invalid."
        case "LEDGER_UNRESOLVED": "An unresolved payment prevents a new purchase."
        default: "The request was evaluated against the current spending rules."
        }
    }
}
