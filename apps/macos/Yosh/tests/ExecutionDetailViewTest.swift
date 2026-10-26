import AppKit
import SwiftUI

/// Native callbacks only: selection stays on the last backend projection until a refreshed value arrives.
@main
struct ExecutionDetailViewTest {
    @MainActor
    static func main() throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        var selections: [AppOverview.Service.PurchaseMode] = [], backs = 0
        func environment(_ mode: String) throws -> ExecutionEnvironment {
            let json = """
            {"mode":"\(mode)","cluster":"devnet","network":"solana:fixture","asset":{"network":"solana:fixture","mint":"fixture-mint","decimals":6,"displayLabel":"test USDC"},"productionExecutionEnabled":false,"spendingAuthorized":false,"configurationReady":false}
            """
            return try JSONDecoder().decode(ExecutionEnvironment.self, from: Data(json.utf8))
        }
        let simulated = try environment("simulated"), mainnet = try environment("live_mainnet")
        precondition(mainnet.mainnetStatus == "Mainnet execution is disabled")
        let verifiedAsset = try JSONDecoder().decode(ExecutionEnvironment.self, from: Data("""
            {"mode":"live_mainnet","cluster":"mainnet-beta","network":"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp","asset":{"network":"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1","mint":"fixture","symbol":"USDC","decimals":6,"displayLabel":"USDC"},"productionExecutionEnabled":false,"spendingAuthorized":false,"configurationReady":false}
            """.utf8))
        precondition(verifiedAsset.assetLabel == nil, "Mismatched asset network must not identify production funds")
        let wire = ServiceEndpoint.setExecution(.liveMainnet)
        precondition(wire.path == "/api/app/execution" && wire.method == "PUT" && wire.isMutation)
        let body = try JSONSerialization.jsonObject(with: wire.body()!) as? [String: String]
        precondition(body == ["mode": "live_mainnet"], "Selection transport must not carry authority or wallet fields")
        func page(_ value: ExecutionEnvironment?, saving: Bool = false) -> some View {
            ExecutionDetail(environment: value, isSaving: saving, message: nil, messageFailed: false,
                onBack: { backs += 1 }, onSelect: { selections.append($0) }, onProductionExecution: { _ in })
                .frame(width: 420, height: 526)
                .background(Color(red: 0.95, green: 0.97, blue: 0.985))
                .environment(\.colorScheme, .light)
        }
        let host = NSHostingView(rootView: page(simulated))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 526), styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host; window.alphaValue = 0; window.orderFront(nil); settle(host)
        precondition(host.frame.size == NSSize(width: 420, height: 526))
        guard let scroll = scrollView(in: host), let document = scroll.documentView else { fatalError("Native scroll viewport required") }
        precondition(document.bounds.width <= scroll.contentView.bounds.width + 1)
        if CommandLine.arguments.count == 2 { try render(host, to: CommandLine.arguments[1] + ".png") }
        click(window, at: NSPoint(x: 110, y: 269)); settle(host)
        precondition(selections == [.liveDevnet], "Compact Devnet row must invoke typed intent")
        precondition(simulated.mode == .simulated, "A callback cannot optimistically change backend truth")
        host.rootView = page(simulated, saving: true); settle(host)
        click(window, at: NSPoint(x: 110, y: 269)); click(window, at: NSPoint(x: 80, y: 490)); settle(host)
        precondition(selections == [.liveDevnet] && backs == 0, "Pending writes disable duplicates and Back")
        host.rootView = page(mainnet); settle(host)
        if CommandLine.arguments.count == 2 { try render(host, to: CommandLine.arguments[1] + "-mainnet.png") }
        click(window, at: NSPoint(x: 80, y: 490)); settle(host); precondition(backs == 1)
        window.close()
        print("Execution native detail: compact rows, typed intent only, confirmed projection, write guards, neutral Mainnet status, fixed viewport passed")
    }
    @MainActor private static func settle(_ host: NSView) {
        host.layoutSubtreeIfNeeded(); RunLoop.current.run(until: .now.addingTimeInterval(0.1))
    }
    @MainActor private static func click(_ window: NSWindow, at point: NSPoint) {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
            window.sendEvent(event)
        }
    }
    @MainActor private static func scrollView(in view: NSView) -> NSScrollView? {
        if let scroll = view as? NSScrollView { return scroll }
        return view.subviews.compactMap { scrollView(in: $0) }.first
    }
    @MainActor private static func render(_ host: NSView, to path: String) throws {
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("Render unavailable") }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else { fatalError("Render unavailable") }
        try data.write(to: URL(fileURLWithPath: path))
    }
}
