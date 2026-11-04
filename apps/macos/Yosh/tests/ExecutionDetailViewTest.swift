import AppKit
import SwiftUI

/// Native callbacks only. No real environment, authorization, or payment is changed.
@main
struct ExecutionDetailViewTest {
    @MainActor static func main() throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        NSApp.accessibilitySetValue(true, forAttribute: .init(rawValue: "AXEnhancedUserInterface"))
        var selections: [AppOverview.Service.PurchaseMode] = [], productions: [Bool] = [], backs = 0
        func environment(_ mode: String, enabled: Bool = false) throws -> ExecutionEnvironment {
            let json = """
            {"mode":"\(mode)","cluster":"devnet","network":"solana:fixture","asset":{"network":"solana:fixture","mint":"fixture-mint","decimals":6,"displayLabel":"test USDC"},"productionExecutionEnabled":\(enabled),"spendingAuthorized":false,"configurationReady":false}
            """
            return try JSONDecoder().decode(ExecutionEnvironment.self, from: Data(json.utf8))
        }
        let simulated = try environment("simulated"), mainnet = try environment("live_mainnet")
        let enabledMainnet = try environment("live_mainnet", enabled: true)
        precondition(mainnet.mainnetStatus == "Mainnet execution is disabled")
        let verifiedAsset = try JSONDecoder().decode(ExecutionEnvironment.self, from: Data("""
            {"mode":"live_mainnet","cluster":"mainnet-beta","network":"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp","asset":{"network":"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1","mint":"fixture","symbol":"USDC","decimals":6,"displayLabel":"USDC"},"productionExecutionEnabled":false,"spendingAuthorized":false,"configurationReady":false}
            """.utf8))
        precondition(verifiedAsset.assetLabel == nil, "Mismatched networks cannot identify production funds")
        let wire = ServiceEndpoint.setExecution(.liveMainnet)
        precondition(wire.path == "/api/app/execution" && wire.method == "PUT" && wire.isMutation)
        let body = try JSONSerialization.jsonObject(with: wire.body()!) as? [String: String]
        precondition(body == ["mode": "live_mainnet"], "Selection transport cannot carry authority or wallet fields")
        func page(_ value: ExecutionEnvironment?, saving: Bool = false, id: Int = 0, dark: Bool = false) -> some View {
            ExecutionDetail(environment: value, isSaving: saving, message: nil, messageFailed: false,
                onBack: { backs += 1 }, onSelect: { selections.append($0) }, onProductionExecution: { productions.append($0) })
                .id(id).frame(width: 420, height: 526).background(YoshShellPalette.surface)
                .environment(\.colorScheme, dark ? .dark : .light)
        }
        let host = NSHostingView(rootView: page(simulated))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 526), styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host; window.alphaValue = 0; window.orderFront(nil); settle(host)
        defer { window.close() }
        precondition(host.frame.size == NSSize(width: 420, height: 526))
        guard let scroll = scrollView(in: host), let document = scroll.documentView else { fatalError("Native scroll viewport required") }
        precondition(document.bounds.width <= scroll.contentView.bounds.width + 1)
        precondition(!texts(host).contains(where: { $0.contains("fixture-mint") }), "Technical details must be collapsed initially")
        precondition(element("execution-mainnet-toggle", in: host) == nil)
        try snapshot(host, suffix: "-light")
        press("execution-details", in: host, window: window)
        precondition(texts(host).contains(where: { $0.contains("fixture-mint") }) && texts(host).contains(where: { $0.contains("decimals") }),
            "Disclosure must retain network, asset, precision and mint")
        try snapshot(host, suffix: "-details")
        press("execution-details", in: host, window: window)
        precondition(!texts(host).contains(where: { $0.contains("fixture-mint") }))
        press("execution-mode-simulated", in: host, window: window)
        precondition(selections.isEmpty, "The confirmed mode must be a no-op")
        press("execution-mode-live_devnet", in: host, window: window)
        precondition(selections == [.liveDevnet] && value("execution-mode-simulated", in: host) == "Selected",
            "Typed selection keeps backend truth until a refreshed projection arrives")
        host.rootView = page(simulated, saving: true); settle(host)
        precondition(!isEnabled("execution-mode-live_devnet", in: host) && !isEnabled("execution-back", in: host))
        press("execution-mode-live_devnet", in: host, window: window); press("execution-back", in: host, window: window)
        precondition(selections == [.liveDevnet] && backs == 0)
        host.rootView = page(nil, id: 1); settle(host)
        for mode in AppOverview.Service.PurchaseMode.allCases { precondition(!isEnabled("execution-mode-\(mode.rawValue)", in: host)) }
        precondition(texts(host).contains("Execution environment unavailable") && element("execution-details", in: host) == nil)
        host.rootView = page(mainnet, id: 2, dark: true); window.appearance = NSAppearance(named: .darkAqua); settle(host)
        precondition(value("execution-mode-live_mainnet", in: host) == "Selected" && productions.isEmpty)
        precondition(texts(host).contains("Mainnet execution is disabled"))
        precondition(!texts(host).contains(where: { $0.contains("fixture-mint") }))
        try snapshot(host, suffix: "-mainnet-dark")
        press("execution-mainnet-toggle", in: host, window: window)
        precondition(productions.isEmpty && !mainnet.productionExecutionEnabled,
            "Requesting enablement cannot authorize real payments before explicit confirmation")
        pressDialog("execution-enable-cancel", label: "Cancel", host: host)
        precondition(productions.isEmpty)
        press("execution-mainnet-toggle", in: host, window: window)
        precondition(productions.isEmpty)
        pressDialog("execution-enable-confirm", label: "Enable Mainnet execution", host: host)
        precondition(productions == [true], "Only explicit confirmation requests Mainnet enablement")
        host.rootView = page(enabledMainnet, id: 3, dark: true); settle(host)
        press("execution-mainnet-toggle", in: host, window: window)
        precondition(productions == [true, false], "Disabling uses the same existing callback")
        host.rootView = page(enabledMainnet, saving: true, id: 4); settle(host)
        precondition(!isEnabled("execution-mainnet-toggle", in: host))
        press("execution-mainnet-toggle", in: host, window: window)
        precondition(productions == [true, false], "Saving prevents duplicate Mainnet changes")
        host.rootView = page(mainnet, id: 5); window.appearance = NSAppearance(named: .aqua); settle(host)
        try snapshot(host, suffix: "-mainnet-light")
        press("execution-back", in: host, window: window)
        precondition(backs == 1 && host.frame.size == NSSize(width: 420, height: 526))
        print("Execution native detail: compact rows, collapsed technical details, typed backend projection, saving/unavailable guards, explicit Mainnet confirmation/cancel/disable and fixed viewport passed")
    }

    @MainActor private static func settle(_ host: NSView) {
        host.layoutSubtreeIfNeeded(); RunLoop.current.run(until: .now.addingTimeInterval(0.12)); host.layoutSubtreeIfNeeded()
    }
    @MainActor private static func nodes(_ object: NSObject) -> [NSObject] {
        guard object.responds(to: NSSelectorFromString("accessibilityChildren")) else { return [object] }
        return [object] + (object.value(forKey: "accessibilityChildren") as? [NSObject] ?? []).flatMap(nodes)
    }
    @MainActor private static func element(_ id: String, in host: NSView) -> NSObject? {
        let matches = nodes(host).filter { $0.responds(to: NSSelectorFromString("accessibilityIdentifier")) && $0.value(forKey: "accessibilityIdentifier") as? String == id }
        if id == "execution-details" { return matches.first { $0.value(forKey: "accessibilityRole") as? String == "AXDisclosureTriangle" } }
        return matches.first
    }
    @MainActor private static func texts(_ host: NSView) -> [String] {
        nodes(host).flatMap { node in
            ["accessibilityValue", "accessibilityLabel"].compactMap { key in
                node.responds(to: NSSelectorFromString(key)) ? node.value(forKey: key) as? String : nil
            }
        }
    }
    @MainActor private static func value(_ id: String, in host: NSView) -> String? { element(id, in: host)?.value(forKey: "accessibilityValue") as? String }
    @MainActor private static func isEnabled(_ id: String, in host: NSView) -> Bool {
        guard let node = element(id, in: host), let enabled = node.value(forKey: "accessibilityEnabled") as? Bool else { fatalError("Missing native control: \(id)") }
        return enabled
    }
    @MainActor private static func press(_ id: String, in host: NSView, window: NSWindow) {
        guard let node = element(id, in: host), let frame = node.value(forKey: "accessibilityFrame") as? NSValue else { fatalError("Missing native hit target: \(id)") }
        if id == "execution-details" {
            let control: AnyObject = node
            precondition(control.accessibilityPerformPress?() == true)
        } else {
            if let scroll = scrollView(in: host), let document = scroll.documentView {
                document.scrollToVisible(document.convert(window.convertFromScreen(frame.rectValue), from: nil)); settle(host)
            }
            let r = (node.value(forKey: "accessibilityFrame") as? NSValue)?.rectValue ?? frame.rectValue
            click(window, at: window.convertPoint(fromScreen: NSPoint(x: r.midX, y: r.midY)))
        }
        settle(host)
    }
    @MainActor private static func pressDialog(_ id: String, label: String, host: NSView) {
        let candidates = NSApp.windows.flatMap { window in nodes(window).map { (window, $0) } }
        guard let (window, button) = candidates.first(where: { _, node in
            guard node.responds(to: NSSelectorFromString("accessibilityRole")),
                  node.value(forKey: "accessibilityRole") as? String == "AXButton" else { return false }
            return (node.responds(to: NSSelectorFromString("accessibilityIdentifier")) && node.value(forKey: "accessibilityIdentifier") as? String == id)
                || ["accessibilityLabel", "accessibilityTitle"].contains { key in
                    node.responds(to: NSSelectorFromString(key)) && node.value(forKey: key) as? String == label
                }
        }) else { fatalError("Missing native Mainnet confirmation button: \(label)") }
        if let native = button as? NSButton {
            native.performClick(nil)
        } else {
            let control: AnyObject = button
            if control.accessibilityPerformPress?() != true {
                guard let frame = button.value(forKey: "accessibilityFrame") as? NSValue else { fatalError("Missing confirmation frame") }
                click(window, at: window.convertPoint(fromScreen: NSPoint(x: frame.rectValue.midX, y: frame.rectValue.midY)))
            }
        }
        settle(host)
    }
    @MainActor private static func click(_ window: NSWindow, at point: NSPoint) {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            window.sendEvent(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!)
        }
    }
    @MainActor private static func scrollView(in view: NSView) -> NSScrollView? {
        if let scroll = view as? NSScrollView { return scroll }
        return view.subviews.compactMap { scrollView(in: $0) }.first
    }
    @MainActor private static func snapshot(_ host: NSView, suffix: String) throws {
        guard let prefix = CommandLine.arguments.dropFirst().first else { return }
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("Render unavailable") }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let rendered = bitmap.representation(using: .png, properties: [:]) else { fatalError("Render unavailable") }
        try rendered.write(to: URL(filePath: prefix + suffix + ".png"))
    }
}
