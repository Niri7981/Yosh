import Foundation

/// Calendar grouping and row context for the selected member's backend-owned records.
struct ActivityLedgerPresentation {
    enum Tone: Equatable {
        case positive, pending, negative, neutral
    }

    struct Row: Identifiable {
        let id: String
        let item: ActivityPurchasePresentation
        let context: String
        let solanaBadge: Bool
        let purpose: String?
        let tone: Tone
        let hostName: String
        let network: String?

        init(_ purchase: AppOverview.Purchase, agentName: String) {
            id = purchase.purchaseId
            hostName = agentName
            network = purchase.network
            item = ActivityPurchasePresentation(purchase)
            let solana = purchase.network?.hasPrefix("solana:") == true
                || purchase.network == "Solana Devnet" || purchase.network == "Solana Mainnet"
            context = "\(agentName) · \(item.mode)\(solana ? " · Solana" : "")"
            solanaBadge = solana && purchase.executionMode != .simulated
            let reason = purchase.reason?.trimmingCharacters(in: .whitespacesAndNewlines)
            purpose = reason?.isEmpty == false ? reason : item.denialReason
            tone = switch purchase.status {
            case "PAID": (purchase.executionMode == .liveDevnet || purchase.executionMode == .liveMainnet) ? .positive : .neutral
            case "APPROVED": .positive
            case "PAYING", "PAYMENT_UNKNOWN", "REQUIRES_APPROVAL": .pending
            case "DENIED", "FAILED": .negative
            default: .neutral
            }
        }
    }

    struct Day: Identifiable {
        let id: Date
        let title: String
        let rows: [Row]
    }

    let days: [Day]

    init(_ purchases: [AppOverview.Purchase], agentName: String,
         now: Date = .now, calendar: Calendar = .current) {
        let grouped = Dictionary(grouping: purchases) { purchase in
            calendar.startOfDay(for: Date(timeIntervalSince1970: TimeInterval(purchase.createdAt) / 1_000))
        }
        let today = calendar.startOfDay(for: now)
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today)
        days = grouped.keys.sorted(by: >).map { day in
            let title: String
            if day == today {
                title = "Today"
            } else if day == yesterday {
                title = "Yesterday"
            } else {
                title = day.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted,
                    calendar: calendar, timeZone: calendar.timeZone))
            }
            let ordered = (grouped[day] ?? []).sorted {
                $0.createdAt == $1.createdAt ? $0.purchaseId < $1.purchaseId : $0.createdAt > $1.createdAt
            }
            return Day(id: day, title: title, rows: ordered.map { Row($0, agentName: agentName) })
        }
    }
}
