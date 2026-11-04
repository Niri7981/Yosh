import AppKit
import SwiftUI

/// Callback-only native view fixture. No real budget changes, backend, or payments.
@main
struct AuthorityDetailViewTest {
    @MainActor
    static func main() throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        var input = "1.00", saves: [String] = []
        var backs = 0, retries = 0
        let binding = Binding(get: { input }, set: { input = $0 })
        func page(saving: Bool = false, currency: String? = "test USDC", error: String? = nil) -> some View {
            DailyAuthorityContent(currency: currency, dailyLimitInput: binding, isSaving: saving,
                message: error, messageFailed: error != nil, balanceDisplay: error == nil ? "19.00 test USDC" : nil,
                balanceIsLoading: false, balanceMessage: error == nil ? nil : "Fixture balance unavailable",
                canRetryBalance: error != nil, onBack: { backs += 1 },
                onSave: { if let amount = DailyAuthorityPresentation.minorUnits(input) { saves.append(amount) } },
                onRetryBalance: { retries += 1 })
                .frame(width: 420, height: 526)
                .background(Color(red: 0.95, green: 0.97, blue: 0.985))
                .environment(\.colorScheme, .light)
        }
        let host = NSHostingView(rootView: page())
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 526),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        window.alphaValue = 0
        window.orderFront(nil)
        settle(host)
        precondition(CardMetrics.cardSize == CGSize(width: 420, height: 684))
        precondition(CardMetrics.windowSize == CardMetrics.cardSize)
        precondition(host.frame.size == NSSize(width: 420, height: 526))
        guard let scroll = scrollView(in: host), let document = scroll.documentView else {
            fatalError("Authority detail must retain a native vertical scroll viewport")
        }
        precondition(document.bounds.width <= scroll.contentView.bounds.width + 1)
        if CommandLine.arguments.count == 2 { try render(host, to: CommandLine.arguments[1] + ".png") }
        click(window, at: NSPoint(x: 80, y: 490))
        precondition(backs == 1 && saves.isEmpty)
        click(window, at: NSPoint(x: 110, y: 298))
        guard let editor = window.firstResponder as? NSTextView else { fatalError("Limit must use a native editable text field") }
        editor.selectAll(nil)
        editor.insertText("2.123456", replacementRange: editor.selectedRange())
        RunLoop.current.run(until: .now.addingTimeInterval(0.1))
        precondition(input == "2.123456")
        click(window, at: NSPoint(x: 65, y: 209))
        precondition(saves == ["2123456"] && backs == 1, "Save must remain independent from Back and submit exact minor units")

        host.rootView = page(saving: true)
        settle(host)
        click(window, at: NSPoint(x: 80, y: 490))
        click(window, at: NSPoint(x: 65, y: 209))
        precondition(backs == 1 && saves == ["2123456"], "Saving disables Back and duplicate Save")
        host.rootView = page(currency: nil)
        settle(host)
        click(window, at: NSPoint(x: 65, y: 209))
        precondition(saves == ["2123456"], "Unknown network cannot masquerade as an editable USDC budget")

        host.rootView = page(error: String(repeating: "Fixture error. ", count: 20))
        settle(host)
        guard let failedScroll = scrollView(in: host), let failedDocument = failedScroll.documentView else { fatalError("Missing scroll") }
        precondition(failedDocument.bounds.height > failedScroll.contentView.bounds.height,
            "Long error states must scroll rather than grow the window")
        failedScroll.contentView.scroll(to: NSPoint(x: 0, y: failedDocument.bounds.height - failedScroll.contentView.bounds.height))
        failedScroll.reflectScrolledClipView(failedScroll.contentView)
        settle(host)
        if CommandLine.arguments.count == 2 { try render(host, to: CommandLine.arguments[1] + "-error.png") }
        click(window, at: NSPoint(x: 75, y: 31))
        window.close()
        precondition(retries == 1, "Balance retry must invoke only the read action")
        print("Daily Authority native detail: fixed geometry, native field editing, Save/Back independence, saving/unknown guards, and overflow scrolling passed")
    }

    @MainActor
    private static func settle(_ host: NSView) {
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: .now.addingTimeInterval(0.1))
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
    private static func scrollView(in view: NSView) -> NSScrollView? {
        if let scroll = view as? NSScrollView { return scroll }
        return view.subviews.compactMap { scrollView(in: $0) }.first
    }

    @MainActor
    private static func render(_ host: NSView, to path: String) throws {
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("Fixture rendering unavailable") }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try bitmap.representation(using: .png, properties: [:])?.write(to: URL(filePath: path))
    }
}
