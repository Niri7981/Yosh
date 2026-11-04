import AppKit
import SwiftUI

/// Exercise the actual titled hosting window without starting a backend or reading Keychain.
@main
struct CardWindowBoundsTest {
    @MainActor
    static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let host = NSHostingView(rootView: CardWindow(
            overviewClient: OverviewClient(runtime: NativeServiceRuntime(allowsLaunch: false)),
            appLock: YoshAppLock(developmentSession: true)))
        host.safeAreaRegions = []
        let rect = NSRect(origin: .zero, size: CardMetrics.windowSize)
        let window = AgentCardNSWindow(contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = host
        window.setFrame(rect, display: false)
        window.orderBack(nil)
        defer { window.close() }
        RunLoop.current.run(until: .now.addingTimeInterval(0.3))
        host.layoutSubtreeIfNeeded()
        precondition(window.frame.size == CardMetrics.cardSize,
            "Native window must fit the visible card: actual \(window.frame.size), host \(host.frame.size), fitting \(host.fittingSize)")
        precondition(host.frame.size == CardMetrics.cardSize,
            "Hosting content must keep the card dimensions")
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            fatalError("Cannot render card")
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        for point in [CGPoint(x: 2, y: 342), CGPoint(x: 418, y: 342),
                      CGPoint(x: 210, y: 2), CGPoint(x: 210, y: 682)] {
            let x = Int(point.x * CGFloat(bitmap.pixelsWide) / host.bounds.width)
            let y = Int(point.y * CGFloat(bitmap.pixelsHigh) / host.bounds.height)
            precondition((bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.9,
                "Card surface must reach each window edge; no titlebar or transparent gutter")
        }
        print("Card window bounds passed: 420 × 684, surface reaches all four edges")
    }
}
