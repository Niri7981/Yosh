import Foundation
import CryptoKit

struct PurchaseNotificationFeed: Decodable, Sendable {
    let storeId: String
    let cursor: Int64
    let events: [Event]

    struct Event: Decodable, Sendable {
        let sequence: Int64
        let purchaseId: String
        let agent: String
        let apiName: String
        let priceDisplay: String
        let quantity: String
        let outcome: Outcome

        enum Outcome: String, Decodable, Sendable { case paid = "Paid", unpaid = "Unpaid" }

        var body: String {
            func label(_ value: String) -> String {
                String(value.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ").prefix(160))
            }
            return "\(label(agent)) · \(label(apiName)) · \(label(priceDisplay)) × \(quantity) · \(outcome.rawValue)"
        }
        func identifier(storeId: String) -> String {
            let digest = SHA256.hash(data: Data(purchaseId.utf8)).map { String(format: "%02x", $0) }.joined()
            return "purchase.\(storeId).\(digest).\(outcome.rawValue)"
        }
    }

    func validate(after: Int64?) throws {
        guard storeId.count == 64, storeId.allSatisfy({ $0.isHexDigit }), cursor >= 0, events.count <= 50 else {
            throw OverviewLoadError.invalidResponse
        }
        var previous = after ?? 0
        for event in events {
            guard event.sequence > previous, event.sequence <= cursor, event.quantity == "1",
                  !event.purchaseId.isEmpty, event.purchaseId.count <= 256,
                  !event.agent.isEmpty, !event.apiName.isEmpty, !event.priceDisplay.isEmpty else {
                throw OverviewLoadError.invalidResponse
            }
            previous = event.sequence
        }
        if let after, cursor < after { throw OverviewLoadError.invalidResponse }
    }
}
