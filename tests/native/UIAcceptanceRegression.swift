import AppKit
import SwiftUI

/// Product views with fixture data and callbacks only. Full cross-process AX
/// hierarchy acceptance belongs to the installed App run; this fixture exercises
/// native controls and reads the actual hosted selectable text elements.
@main
struct UIAcceptanceRegression {
    @MainActor
    static func main() throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        app.accessibilitySetValue(true, forAttribute: .init(rawValue: "AXEnhancedUserInterface"))
        let page = CommandLine.arguments.dropFirst().first ?? "budget"
        precondition(["budget", "purchase"].contains(page))
        DispatchQueue.main.async {
            do {
                if page == "budget" { budget() } else { try purchase() }
                print("PASS \(page): native presentation, callbacks and hosted text accessibility")
                exit(0)
            } catch { fatalError("Fixture failed: \(error)") }
        }
        app.run()
    }

    @MainActor
    private static func budget() {
        var input = DailyAuthorityPresentation.editableLimit(400_000)
        var saves: [String] = [], backs = 0
        precondition(input == "0.40")
        let binding = Binding(get: { input }, set: { input = $0 })
        let wallet = AuthoritySurface.Wallet(address: "fixture-offline-wallet-1111111111111111111111", network: "Solana Devnet", status: .available)
        func page(saving: Bool = false, message: String? = nil) -> AnyView {
            AnyView(DailyAuthorityContent(currency: "Test USDC", dailyLimitInput: binding,
                isSaving: saving, message: message, messageFailed: false, balanceDisplay: "10.00 Test USDC",
                balanceIsLoading: false, balanceMessage: nil, canRetryBalance: false,
                onBack: { backs += 1 }, onSave: { saves.append(input) }, onRetryBalance: {}, wallet: wallet)
                .frame(width: 420, height: 526))
        }
        let host = NSHostingView(rootView: page())
        let window = window(host)
        for _ in 0..<3 { readHostedText(host) }
        precondition(input == "0.40" && saves.isEmpty && backs == 0)
        click(window, at: NSPoint(x: 110, y: 298))
        guard let editor = window.firstResponder as? NSTextView else { fatalError("Limit must remain a native editable field") }
        precondition(editor.string == "0.40", "Initial backend value must appear in the native editor")
        editor.selectAll(nil)
        editor.insertText("0.55", replacementRange: editor.selectedRange())
        settle(host)
        precondition(input == "0.55")
        click(window, at: NSPoint(x: 80, y: 490))
        precondition(backs == 1 && saves.isEmpty, "Cancel must not save")

        input = "0.40"
        host.rootView = page()
        settle(host)
        readHostedText(host)
        click(window, at: NSPoint(x: 65, y: 209))
        precondition(saves == ["0.40"] && backs == 1, "Save and cancel remain independent")
        host.rootView = page(saving: true)
        settle(host)
        readHostedText(host)
        click(window, at: NSPoint(x: 65, y: 209))
        precondition(saves == ["0.40"], "Saving must disable duplicate submission")
        host.rootView = page(message: "Saved")
        settle(host)
        for _ in 0..<3 { readHostedText(host) }
        precondition(input == "0.40" && saves == ["0.40"])
        window.close()
    }

    @MainActor
    private static func purchase() throws {
        let fields: [String: Any] = [
            "purchaseId": "fixture-complete-purchase", "status": "PAID", "deliveryStatus": "COMPLETE",
            "amount": "200000", "createdAt": Int64(1_790_694_299_718), "resourceId": "market-snapshot",
            "reason": "Fixture inspection", "executionMode": "live_devnet", "network": "solana:devnet",
            "currency": "USDC", "assetDecimals": 6, "offline": true,
            "decisionReason": "AUTHORITY_BUDGET_AND_GRANT_PASSED", "transaction": "fixture-offline-receipt",
            "executionTrace": ["source": "pay_mcp", "traceId": "fixture-pay-trace", "operationId": "fixture-pay-operation", "complete": true]
        ]
        let purchase = try JSONDecoder().decode(AppOverview.Purchase.self, from: JSONSerialization.data(withJSONObject: fields))
        let presentation = PurchaseDetailPresentation(purchase, agentName: "Codex")
        precondition(presentation.stages.contains { $0.id == .delivered })
        precondition(presentation.receipts.contains { $0.label == "Trace ID" && $0.value == "fixture-pay-trace" })
        precondition(presentation.receipts.contains { $0.label == "Operation" && $0.value == "fixture-pay-operation" })
        var selected: [String] = [], backs = 0
        let row = ActivityLedgerPresentation.Row(purchase, agentName: "Codex")
        let rowHost = NSHostingView(rootView: ActivityLedgerRow(row: row, onSelect: { selected.append($0) }).frame(width: 368, height: 80))
        let rowWindow = window(rowHost, size: NSSize(width: 368, height: 80))
        click(rowWindow, at: NSPoint(x: 360, y: 40))
        precondition(selected == [purchase.purchaseId], "Activity must select the exact existing purchase")
        rowWindow.close()

        let host = NSHostingView(rootView: AnyView(PurchaseDetail(purchase: purchase, agentName: "Codex", backTitle: "Activity",
            onBack: { backs += 1 }, onCopy: { _ in }).frame(width: 420, height: 526)))
        let detailWindow = window(host)
        for _ in 0..<3 { readHostedText(host) }
        precondition(backs == 0 && selected == [purchase.purchaseId])
        click(detailWindow, at: NSPoint(x: 60, y: 490))
        precondition(backs == 1, "Purchase detail must retain the Activity return action")
        host.rootView = AnyView(ActivityDetail(purchases: [purchase], agentName: "Codex", isRefreshing: false,
            refreshError: nil, onBack: {}, onRefresh: {}, onSelect: { selected.append($0) }).frame(width: 420, height: 526))
        settle(host)
        precondition(host.frame.size == NSSize(width: 420, height: 526))
        detailWindow.close()
    }

    @MainActor
    private static func window(_ host: NSView, size: NSSize = NSSize(width: 420, height: 526)) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.alphaValue = 0
        window.orderFront(nil)
        settle(host)
        return window
    }

    @MainActor
    private static func settle(_ host: NSView) {
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: .now.addingTimeInterval(0.15))
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
    private static func readHostedText(_ host: NSView) {
        var textCount = 0
        // Collapsed SwiftUI disclosures expose virtual AX text rather than NSView text children.
        func visit(_ object: NSObject) {
            if object.responds(to: NSSelectorFromString("accessibilityRole")),
               object.value(forKey: "accessibilityRole") as? String == "AXStaticText" {
                textCount += 1
                if object.responds(to: NSSelectorFromString("accessibilityLabel")) { _ = object.value(forKey: "accessibilityLabel") }
                if object.responds(to: NSSelectorFromString("accessibilityValue")) { _ = object.value(forKey: "accessibilityValue") }
            }
            if object.responds(to: NSSelectorFromString("accessibilityChildren")) {
                for child in object.value(forKey: "accessibilityChildren") as? [NSObject] ?? [] { visit(child) }
            }
        }
        visit(host)
        precondition(textCount > 0, "The fixture must reach actual native text elements, not an empty hosting tree")
    }
}
