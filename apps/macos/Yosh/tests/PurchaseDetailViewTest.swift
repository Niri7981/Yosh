import AppKit
import SwiftUI

/// Native fixture hosting only; never connects to the installed app or payment backend.
@main
struct PurchaseDetailViewTest {
    @MainActor
    static func main() throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        NSApp.accessibilitySetValue(true, forAttribute: .init(rawValue: "AXEnhancedUserInterface"))
        let transaction = String(repeating: "3", count: 88)
        let request = String(repeating: "fixture-stable-request-", count: 12)
        var fields: [String: Any] = [
            "purchaseId": request, "status": "PAID", "deliveryStatus": "COMPLETE",
            "amount": "1000", "createdAt": 1_792_771_200_000 as Int64,
            "resourceId": "agent402-crypto-price", "reason": "Fixture inspection",
            "executionMode": "live_mainnet", "monetaryEnvironment": "live_mainnet",
            "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            "currency": "USDC", "assetDecimals": 6,
            "decisionReason": "AUTHORITY_BUDGET_AND_GRANT_PASSED", "transaction": transaction,
            "executionTrace": ["source": "pay_mcp", "traceId": "fixture-trace", "operationId": "fixture-operation", "complete": true]
        ]
        var backs = 0
        var copies: [String] = []
        var links: [URL] = []
        let purchase = try JSONDecoder().decode(AppOverview.Purchase.self,
            from: JSONSerialization.data(withJSONObject: fields))
        let view = PurchaseDetail(purchase: purchase, agentName: "Codex", backTitle: "Activity",
            onBack: { backs += 1 }, onCopy: { copies.append($0) })
            .frame(width: 420, height: 526)
            .background(YoshShellPalette.surface)
            .environment(\.colorScheme, .light)
            .environment(\.openURL, OpenURLAction { url in links.append(url); return .handled })
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(x: 160, y: 160, width: 420, height: 526),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.alphaValue = 0
        window.orderFront(nil)
        settle(host)
        guard let scroll = findScroll(in: host), let document = scroll.documentView else {
            fatalError("Detail must use a native vertical scroll view")
        }
        precondition(document.bounds.width <= scroll.contentView.bounds.width + 1)
        precondition(element("purchase.copy.Signature", host) == nil, "Audit fields start collapsed")
        if CommandLine.arguments.count == 2 { try render(host, to: CommandLine.arguments[1] + "-delivered.png") }
        press("purchase.transaction-details", host, window)
        press("purchase.copy.Signature", host, window)
        press("purchase.copy.Request ID", host, window)
        press("purchase.copy.Operation", host, window)
        precondition(copies == [transaction, request, "fixture-operation"], "Copy retains the original complete identifiers")
        press("purchase.explorer", host, window)
        precondition(links == [PurchaseDetailPresentation(purchase).explorerURL!], "Explorer link keeps the actual network and signature")
        scroll.contentView.scroll(to: .zero); scroll.reflectScrolledClipView(scroll.contentView); settle(host)
        press("purchase.transaction-details", host, window)
        precondition(element("purchase.copy.Signature", host) == nil, "Collapse hides technical fields")
        press("purchase.merchant-resource", host, window)
        if CommandLine.arguments.count == 2 { try render(host, to: CommandLine.arguments[1] + "-merchant.png") }
        precondition(document.bounds.width <= scroll.contentView.bounds.width + 1)
        scroll.contentView.scroll(to: .zero); scroll.reflectScrolledClipView(scroll.contentView); settle(host)
        press("purchase.back", host, window)
        precondition(backs == 1)
        window.close()

        for status in ["EXPIRED", "DENIED", "PAYING", "PAYMENT_UNKNOWN"] {
            fields["status"] = status
            fields["deliveryStatus"] = "NOT_PAID"
            fields.removeValue(forKey: "transaction")
            fields.removeValue(forKey: "decisionReason")
            let record = try JSONDecoder().decode(AppOverview.Purchase.self, from: JSONSerialization.data(withJSONObject: fields))
            let presentation = PurchaseDetailPresentation(record, agentName: "Codex")
            precondition(!presentation.stages.contains { $0.id == .paid || $0.id == .delivered })
            let fixture = NSHostingView(rootView: PurchaseDetail(purchase: record, agentName: "Codex", backTitle: "Activity", onBack: {})
                .frame(width: 420, height: 526).background(YoshShellPalette.surface).environment(\.colorScheme, .light))
            let statusWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 526), styleMask: .borderless, backing: .buffered, defer: false)
            statusWindow.isReleasedWhenClosed = false; statusWindow.contentView = fixture; statusWindow.alphaValue = 0; statusWindow.orderFront(nil); settle(fixture)
            if CommandLine.arguments.count == 2 { try render(fixture, to: CommandLine.arguments[1] + "-" + status.lowercased() + ".png") }
            statusWindow.close()
        }
        precondition(HostNetworkIcon.hostAsset(for: "Codex") == "ProviderOpenAI")
        precondition(HostNetworkIcon.hostAsset(for: "Claude Code") == "ProviderClaude")
        precondition(HostNetworkIcon.hostAsset(for: "Gemini CLI") == "ProviderGemini")
        precondition(HostNetworkIcon.hostAsset(for: "Custom researcher") == nil)
        precondition(HostNetworkIcon.networkAsset(for: nil) == nil)
        precondition(HostNetworkIcon.networkAsset(for: "eip155:1") == nil)
        precondition(HostNetworkIcon.networkAsset(for: purchase.network) == "NetworkSolana")
        print("Purchase detail: collapsed audit, expand/collapse, exact copies, intercepted Explorer URL, back, constrained width, and Delivered/Expired/Denied/Pending/Unknown passed")
    }

    @MainActor private static func settle(_ host: NSView) {
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: .now.addingTimeInterval(0.2))
    }
    @MainActor private static func nodes(_ object: NSObject) -> [NSObject] {
        guard object.responds(to: NSSelectorFromString("accessibilityChildren")) else { return [object] }
        return [object] + (object.value(forKey: "accessibilityChildren") as? [NSObject] ?? []).flatMap(nodes)
    }
    @MainActor private static func element(_ id: String, _ host: NSView) -> NSObject? {
        nodes(host).first { $0.responds(to: NSSelectorFromString("accessibilityIdentifier")) && $0.value(forKey: "accessibilityIdentifier") as? String == id }
    }
    @MainActor private static func press(_ id: String, _ host: NSView, _ window: NSWindow) {
        guard let node = element(id, host), let value = node.value(forKey: "accessibilityFrame") as? NSValue else { fatalError("Missing control: \(id)") }
        if let scroll = findScroll(in: host), let document = scroll.documentView {
            document.scrollToVisible(document.convert(window.convertFromScreen(value.rectValue), from: nil)); settle(host)
        }
        let frame = (node.value(forKey: "accessibilityFrame") as! NSValue).rectValue
        click(window, at: window.convertPoint(fromScreen: NSPoint(x: frame.midX, y: frame.midY)))
        settle(host)
    }

    @MainActor
    private static func findScroll(in view: NSView) -> NSScrollView? {
        if let scroll = view as? NSScrollView { return scroll }
        return view.subviews.compactMap { findScroll(in: $0) }.first
    }

    @MainActor
    private static func click(_ window: NSWindow, at point: NSPoint) {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
            window.sendEvent(event)
        }
    }

    @MainActor
    private static func render(_ host: NSView, to path: String) throws {
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("Fixture image unavailable") }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try bitmap.representation(using: .png, properties: [:])?.write(to: URL(filePath: path))
    }
}
