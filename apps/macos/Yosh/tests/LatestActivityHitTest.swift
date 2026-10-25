import AppKit
import SwiftUI

/// Actual Authority summary controls and backend-shaped status fixtures; no live runtime or payment.
@main
struct LatestActivityHitTest {
    @MainActor
    static func main() throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        NSApp.accessibilitySetValue(true, forAttribute: .init(rawValue: "AXEnhancedUserInterface"))
        var listOpens = 0
        var detailOpens: [String] = []
        func latest(status: String, delivery: String) throws -> AuthorityOverviewPresentation.Latest {
            let fields: [String: Any] = [
                "service": ["status": "running", "purchaseMode": "live_devnet", "network": "Solana Devnet"],
                "wallet": ["address": "FixtureAddress"],
                "budget": ["dailyLimit": "1000000", "dailyLimitDisplay": "Fixture limit", "paid": "200000",
                    "reserved": "0", "remaining": "800000", "remainingDisplay": "Fixture remaining", "paused": false],
                "grant": NSNull(), "connection": ["enabled": true, "lastSeen": NSNull(), "access": "purchase_intent"],
                "purchases": [["purchaseId": "visible-latest", "status": status, "deliveryStatus": delivery,
                    "amount": "200000", "createdAt": 1_800_000_000_000 as Int64, "resourceId": "market-snapshot",
                    "reason": "Fixture context", "executionMode": "live_devnet", "monetaryEnvironment": "live_devnet",
                    "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "currency": "USDC", "assetDecimals": 6]],
            ]
            let overview = try JSONDecoder().decode(AppOverview.self, from: JSONSerialization.data(withJSONObject: fields))
            guard let latest = AuthorityOverviewPresentation(overview).latest else { fatalError("Missing latest fixture") }
            return latest
        }
        let delivered = try latest(status: "PAID", delivery: "COMPLETE")
        let pending = try latest(status: "PAID", delivery: "PENDING")
        let expired = try latest(status: "EXPIRED", delivery: "NOT_PAID")
        precondition(delivered.purchaseId == "visible-latest" && delivered.purchase.purchaseId == delivered.purchaseId)
        let expiredRow = ActivityLedgerPresentation.Row(expired.purchase, agentName: "Codex")
        precondition(expiredRow.item.payment == "Not started" && expiredRow.item.delivery == "Not delivered",
            "Expiry cannot inherit payment or delivery success")
        precondition(HostNetworkIcon.hostAsset(for: "Codex") == "ProviderOpenAI"
            && HostNetworkIcon.networkAsset(for: delivered.purchase.network) == "NetworkSolana")

        func page(_ latest: AuthorityOverviewPresentation.Latest?, available: Bool = true) -> some View {
            BackLatestPurchase(latest: latest, agentName: "Codex", isLoading: !available,
                activityAvailable: available, onActivity: { listOpens += 1 },
                onPurchase: { detailOpens.append($0) })
                .frame(width: 368, height: 140, alignment: .topLeading)
        }
        let host = NSHostingView(rootView: page(delivered))
        let window = NSWindow(contentRect: NSRect(x: 160, y: 160, width: 368, height: 140),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.alphaValue = 0
        window.orderFront(nil)
        settle(host)
        precondition(label("authority.activity.purchase", in: host).contains("Delivered"),
            "The actual Authority summary must show the shared row's delivery outcome")
        press("authority.activity.open", in: host, window: window)
        precondition(listOpens == 1 && detailOpens.isEmpty, "Activity heading independently opens the list")
        press("authority.activity.purchase", in: host, window: window)
        precondition(detailOpens == ["visible-latest"] && listOpens == 1,
            "The record opens the exact purchase without triggering the Activity list")

        for (record, expected) in [(pending, "Payment confirmed · retrieving result"), (expired, "Expired")] {
            host.rootView = page(record)
            settle(host)
            let text = label("authority.activity.purchase", in: host)
            precondition(text.contains(expected) && !text.contains("Delivered"),
                "The rendered summary must preserve pending and expired outcomes")
        }

        host.rootView = page(nil)
        settle(host)
        precondition(element("authority.activity.purchase", in: host) == nil,
            "Empty history cannot fabricate a selectable purchase")
        press("authority.activity.open", in: host, window: window)
        precondition(listOpens == 2 && detailOpens == ["visible-latest"],
            "Empty history still permits opening the Activity list")

        host.rootView = page(delivered, available: false)
        settle(host)
        press("authority.activity.open", in: host, window: window)
        press("authority.activity.purchase", in: host, window: window)
        precondition(listOpens == 2 && detailOpens == ["visible-latest"],
            "Unavailable or loading state disables both routes")
        window.close()
        print("Authority Activity: shared Host/Network row, Delivered/Pending/Expired labels, exact list/detail routes, empty and disabled states passed")
    }

    @MainActor private static func settle(_ host: NSView) {
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: .now.addingTimeInterval(0.2))
    }

    @MainActor private static func nodes(_ object: NSObject) -> [NSObject] {
        guard object.responds(to: NSSelectorFromString("accessibilityChildren")) else { return [object] }
        return [object] + (object.value(forKey: "accessibilityChildren") as? [NSObject] ?? []).flatMap(nodes)
    }

    @MainActor private static func element(_ id: String, in host: NSView) -> NSObject? {
        nodes(host).first { $0.responds(to: NSSelectorFromString("accessibilityIdentifier"))
            && $0.value(forKey: "accessibilityIdentifier") as? String == id }
    }

    @MainActor private static func label(_ id: String, in host: NSView) -> String {
        guard let node = element(id, in: host), node.responds(to: NSSelectorFromString("accessibilityLabel")),
              let label = node.value(forKey: "accessibilityLabel") as? String else { fatalError("Missing labeled control: \(id)") }
        return label
    }

    @MainActor private static func press(_ id: String, in host: NSView, window: NSWindow) {
        guard let node = element(id, in: host), let value = node.value(forKey: "accessibilityFrame") as? NSValue else {
            fatalError("Missing control: \(id)")
        }
        let frame = value.rectValue
        let point = window.convertPoint(fromScreen: NSPoint(x: frame.midX, y: frame.midY))
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            window.sendEvent(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!)
        }
        settle(host)
    }
}
