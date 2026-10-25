import Foundation

/// Safe overview fixtures only. No backend, wallet, or payment is used.
@main
struct PurchaseDetailPresentationTest {
    static func purchase(_ changes: [String: Any] = [:]) throws -> AppOverview.Purchase {
        var fields: [String: Any] = [
            "purchaseId": "fixture-request-with-a-long-stable-identifier",
            "status": "PAID", "deliveryStatus": "COMPLETE", "amount": "200000",
            "createdAt": 1_790_694_299_718 as Int64, "resourceId": "market-snapshot",
            "reason": "  Live devnet acceptance test  ", "executionMode": "live_devnet", "monetaryEnvironment": "live_devnet",
            "currency": "USDC", "assetDecimals": 6, "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            "decisionReason": "AUTHORITY_BUDGET_AND_GRANT_PASSED", "transaction": String(repeating: "3", count: 88),
        ]
        fields.merge(changes) { _, value in value }
        return try JSONDecoder().decode(AppOverview.Purchase.self,
            from: JSONSerialization.data(withJSONObject: fields))
    }

    static func main() throws {
        func detail(_ changes: [String: Any] = [:]) throws -> PurchaseDetailPresentation {
            PurchaseDetailPresentation(try purchase(changes), agentName: "Codex")
        }
        let delivered = try detail()
        precondition(delivered.title == "Market Snapshot" && delivered.status == "Delivered")
        precondition(delivered.stages.map(\.id) == [.approved, .paid, .delivered])
        precondition(delivered.stages[1].detail == "0.20 Test USDC · Devnet · Solana")
        precondition(delivered.stages.filter { $0.detail.contains("0.20 Test USDC") }.count == 1)
        precondition(delivered.stages.allSatisfy { $0.time == nil }, "Request creation is not a stage timestamp")
        precondition(!delivered.stages.map(\.title).contains("Reserved"), "The summary exposes no reservation event")
        precondition(delivered.authorityTitle == "Allowed automatically")
        precondition(delivered.authorityReason.contains("when allowed"), "Historical approval must not assert a currently active grant")
        precondition(delivered.resourceID == "market-snapshot" && delivered.resourceContext == "Live devnet acceptance test")
        precondition(delivered.providerName == "Provider not provided")
        let openAIProvider = try detail(["providerId": "openai"])
        precondition(openAIProvider.providerName == "OpenAI")
        precondition(delivered.receipts.map(\.label) == ["Signature", "Request ID", "Network", "Request time"])
        precondition(delivered.receipts[0].copyValue == String(repeating: "3", count: 88))
        precondition(delivered.facts.map(\.value) == ["Codex", "Market Snapshot", "0.20 Test USDC", "Devnet · Developer", "Devnet · Solana", "Paid", "Delivered"])
        precondition(delivered.explorerURL?.absoluteString == "https://explorer.solana.com/tx/\(String(repeating: "3", count: 88))?cluster=devnet")
        precondition(delivered.receipts[1].copyValue == "fixture-request-with-a-long-stable-identifier")
        precondition(!delivered.receipts.contains { $0.label == "Channel" }, "Architecture does not prove a record's payment channel")

        let approved = try detail(["status": "APPROVED", "deliveryStatus": "NOT_PAID", "transaction": NSNull()])
        precondition(approved.stages.map(\.id) == [.approved])
        let denied = try detail(["status": "DENIED", "deliveryStatus": "NOT_PAID", "decisionReason": "DAILY_BUDGET_EXCEEDED"])
        precondition(denied.stages.map(\.id) == [.denied] && denied.authorityTitle == "Denied by policy")
        precondition(denied.authorityReason == "The shared Daily Authority was exceeded.")
        let expired = try detail(["status": "EXPIRED", "deliveryStatus": "NOT_PAID"])
        precondition(expired.stages.map(\.id) == [.approved, .expired])
        let failed = try detail(["status": "FAILED", "deliveryStatus": "NOT_PAID"])
        precondition(failed.stages.map(\.id) == [.approved, .failed])
        let unknown = try detail(["status": "PAYMENT_UNKNOWN", "deliveryStatus": "NOT_PAID"])
        precondition(unknown.stages.map(\.id) == [.approved, .paymentUnknown])
        precondition(unknown.stages.last?.tone == .pending)
        precondition(unknown.status == "Checking original payment" && unknown.facts.first { $0.label == "Payment" }?.value == "Checking original payment")
        precondition(unknown.stages.last?.detail.contains("original payment") == true
            && unknown.stages.last?.detail.contains("Reserved funds remain held") == true)
        precondition(approved.status == "Allowed" && approved.stages[0].detail == "No payment made.")
        let unsupported = try detail(["deliveryStatus": "UNSUPPORTED"])
        precondition(unsupported.status == "Payment confirmed · automatic recovery not supported"
            && unsupported.facts.first { $0.label == "Payment" }?.value == "Paid")
        let pendingDelivery = try detail(["deliveryStatus": "PENDING"])
        precondition(pendingDelivery.stages.map(\.id) == [.approved, .paid, .deliveryPending])
        precondition(pendingDelivery.status == "Payment confirmed · retrieving result" && pendingDelivery.facts.first { $0.label == "Payment" }?.value == "Paid")
        let exhausted = try detail(["deliveryStatus": "EXHAUSTED"])
        precondition(exhausted.stages.map(\.id) == [.approved, .paid, .deliveryExhausted])
        precondition(exhausted.status == "Payment confirmed · result not recovered")
        let mainnet = try detail(["executionMode": "live_mainnet", "monetaryEnvironment": "live_mainnet",
            "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"])
        precondition(mainnet.facts.first { $0.label == "Amount" }?.value == "0.20 USDC")
        precondition(mainnet.explorerURL?.absoluteString == "https://explorer.solana.com/tx/\(String(repeating: "3", count: 88))")
        let mismatched = try detail(["monetaryEnvironment": "live_mainnet"])
        precondition(mismatched.explorerURL == nil && mismatched.facts.first { $0.label == "Amount" }?.value == "0.20 Asset not verified")
        let requiresApproval = try detail(["status": "REQUIRES_APPROVAL", "deliveryStatus": "NOT_PAID", "decisionReason": "SINGLE_LIMIT_EXCEEDED"])
        precondition(requiresApproval.stages.map(\.id) == [.needsApproval])
        precondition(requiresApproval.authorityReason == "The per-transaction limit requires your approval.")

        let simulated = try detail(["executionMode": "simulated"])
        precondition(simulated.status == "Simulated" && simulated.tone == .neutral)
        precondition(simulated.stages.map(\.id) == [.approved, .simulatedPayment, .simulatedDelivery])
        precondition(simulated.stages[1].detail.contains("No funds transferred"))
        precondition(!simulated.receipts.contains { $0.label == "Transaction ID" })
        for deliveryState in ["PENDING", "EXHAUSTED", "UNSUPPORTED"] {
            let simulatedRecovery = try detail(["executionMode": "simulated", "deliveryStatus": deliveryState])
            let unknownRecovery = try detail(["executionMode": "UNKNOWN", "deliveryStatus": deliveryState])
            precondition(!simulatedRecovery.stages.contains { $0.title.contains("Payment confirmed") })
            precondition(!unknownRecovery.stages.contains { $0.title.contains("Payment confirmed") })
        }
        let unverified = try detail(["executionMode": "UNKNOWN"])
        precondition(unverified.status == "Payment unverified" && unverified.tone == .neutral)
        precondition(unverified.stages[1].id == .paymentUnverified && unverified.stages[1].tone == .neutral)
        precondition(unverified.stages.last?.tone == .neutral)
        let missing = try detail(["decisionReason": NSNull(), "network": NSNull(), "resourceId": NSNull(), "reason": " "])
        precondition(missing.authorityTitle == "Allowed by policy" && missing.authorityReason == "Policy reason not provided.")
        precondition(missing.resourceID == nil && missing.resourceContext == nil)
        precondition(!missing.receipts.contains { $0.label == "Network" })
        precondition(!missing.stages[1].detail.contains("Devnet"), "Execution mode is not network metadata")
        let future = try detail(["status": "NEW_STATE", "decisionReason": "NEW_REASON", "deliveryStatus": "NOT_PAID"])
        precondition(future.stages.map(\.id) == [.unavailable] && future.authorityTitle == "Decision unavailable")
        let newReason = try detail(["status": "DENIED", "decisionReason": "NEW_POLICY_REASON", "deliveryStatus": "NOT_PAID"])
        precondition(newReason.authorityReason == "The request was evaluated against the current spending rules.")
        let asset = try detail(["assetId": "fixture-asset-id"])
        precondition(asset.receipts.last?.label == "Asset ID" && asset.receipts.last?.copyValue == "fixture-asset-id")
        let offline = try detail(["offline": true, "monetaryEnvironment": "live_devnet",
            "transaction": String(repeating: "1", count: 88),
            "executionTrace": ["source": "pay_mcp", "traceId": "observed-attempt", "operationId": "observed-operation", "complete": true]])
        precondition(offline.explorerURL == nil, "Offline confirmations must never link to a real-chain explorer")
        precondition(offline.stages.allSatisfy { $0.tone != .success }, "Offline records cannot imply confirmed real payment")
        let expiredWithoutDecision = try detail(["status": "EXPIRED", "decisionReason": NSNull(), "deliveryStatus": "NOT_PAID"])
        precondition(expiredWithoutDecision.stages.map(\.id) == [.expired], "Expiry alone does not prove a prior allowed decision")
        let failedWithoutDecision = try detail(["status": "FAILED", "decisionReason": NSNull(), "deliveryStatus": "NOT_PAID"])
        precondition(failedWithoutDecision.stages.map(\.id) == [.failed], "Failure alone does not prove a prior allowed decision")
        precondition(pendingDelivery.tone == .pending && exhausted.tone == .negative,
            "The overall status must not look delivered when retrieval is pending or exhausted")
        precondition(offline.facts.contains { $0.value == "Offline · No real funds" })
        precondition(offline.facts.contains { $0.value == "Pay MCP · Traced" })
        precondition(offline.receipts.contains { $0.label == "Trace ID" && $0.copyValue == "observed-attempt" })
        let incomplete = try detail(["executionTrace": ["source": "pay_mcp", "traceId": "old-attempt", "operationId": "old-operation", "complete": false]])
        precondition(incomplete.facts.contains { $0.value == "Pay MCP · Trace incomplete" })
        print("Purchase detail: truthful lifecycle, Offline trace attribution, no simulated explorer, historical policy and full receipt IDs passed")
    }
}
