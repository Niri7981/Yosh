import AppKit
import SwiftUI

/// Native presentation fixtures only. No backend, Keychain or persisted product state.
@main
struct SettingsBodyViewTest {
    @MainActor static func main() throws {
        let review = CommandLine.arguments.contains("--review")
        NSApplication.shared.setActivationPolicy(review ? .regular : .prohibited)
        // Match the existing native fixtures: enable SwiftUI’s in-process AX tree.
        NSApp.accessibilitySetValue(true, forAttribute: .init(rawValue: "AXEnhancedUserInterface"))
        let address = "MainnetFixturePublicAddress1234567890"
        let directory = URL(fileURLWithPath: "/tmp/yosh-settings-fixture", isDirectory: true)
        let information = CardSettingsPresentation(wallets: [
            .init(id: "mainnet", label: "Mainnet", address: address, status: .available),
            .init(id: "devnet", label: "Devnet · Test", address: "DevnetFixturePublicAddress", status: .available)
        ], dataDirectory: directory)
        let network = PayDevelopmentSelection(version: 1, environment: .mainnet,
            mainnetRiskAccepted: true, rpcUrl: "https://fixture.invalid")
        var copied: [String] = [], opened: [URL] = []
        var advanced = 0, wallets = 0, hosts = 0, repositories = 0, reloads = 0
        func body(_ detail: Bool, _ info: CardSettingsPresentation?) -> some View {
            CardSettingsBody(information: info, appVersion: "Fixture 0.1.1", isLoading: false, error: nil,
                onCopyWallet: { copied.append($0) }, onOpenDataFolder: { opened.append($0) },
                onOpenRepository: { repositories += 1 }, onReload: { reloads += 1 },
                onOpenWallets: { wallets += 1 }, development: network,
                showsAdvanced: detail, onOpenAdvanced: { advanced += 1 }, hostStatus: "Connected",
                onOpenConnection: { hosts += 1 })
                .frame(width: 420, height: 526)
                .background(YoshShellPalette.surface).environment(\.colorScheme, .dark)
        }
        if review {
            let shell = NSHostingView(rootView: VStack(spacing: 0) {
                Color.clear.frame(height: 66)
                body(false, information)
                BackNavigation(selection: .constant(.settings)).padding(.bottom, 16)
            }.frame(width: 420, height: 684).background(YoshShellPalette.surface).environment(\.colorScheme, .dark))
            let window = fixtureWindow(shell, visible: true)
            window.title = "Yosh Settings · Fixture review (no backend)"
            try render(shell, suffix: "card")
            NSApplication.shared.activate(ignoringOtherApps: true)
            NSApplication.shared.run()
            return
        }
        // Exercise the actual card shell: body-only fixtures cannot detect missing top navigation.
        let client = OverviewClient(runtime: NativeServiceRuntime(allowsLaunch: false))
        let session = CardMemberSession(client: client)
        for section in BackSection.allCases {
            let card = NSHostingView(rootView: AgentCardBack(onFlip: {}, overviewClient: client,
                memberSession: session, initialSection: section)
                .background(YoshShellPalette.surface))
            let cardWindow = fixtureWindow(card)
            guard let selector = element("agents.selector", card),
                  let frame = selector.value(forKey: "accessibilityFrame") as? NSValue else {
                fatalError("The top agent selector must remain visible on \(section.title)")
            }
            let bounds = cardWindow.convertFromScreen(frame.rectValue)
            precondition(bounds.width > 0 && bounds.height > 0 && bounds.maxY <= card.bounds.height + 1,
                "The agent selector must fit inside the card on \(section.title)")
            if section == .settings { try render(card, suffix: "with-selector") }
            cardWindow.close()
        }
        let host = NSHostingView(rootView: body(false, information))
        let window = fixtureWindow(host)
        guard let scroll = scrollView(in: host), let document = scroll.documentView else { fatalError("Missing native scrolling") }
        precondition(document.bounds.width <= scroll.contentView.bounds.width + 1)
        try render(host, suffix: "home")
        for identifier in ["settings.network.open", "settings.wallets.open", "settings.host.open", "settings.advanced.open"] {
            guard let node = element(identifier, host) else { fatalError("Missing home entry: \(identifier)") }
            let frame = (node.value(forKey: "accessibilityFrame") as! NSValue).rectValue
            if identifier != "settings.advanced.open" {
                precondition(window.convertFromScreen(frame).minY >= 0, "Primary home entries must fit the first viewport")
            }
        }
        precondition(element("settings.mainnet-rpc", host) == nil)
        precondition(element("settings.wallet.devnet.copy", host) == nil)
        try render(host, suffix: "home")
        press("settings.wallet.mainnet.copy", host, window)
        press("settings.wallets.open", host, window)
        press("settings.host.open", host, window)
        press("settings.advanced.open", host, window)
        precondition(copied == [address] && wallets == 1 && hosts == 1 && advanced == 1)
        precondition(opened.isEmpty && repositories == 0 && reloads == 0)
        window.close()

        let detail = NSHostingView(rootView: body(true, information))
        let detailWindow = fixtureWindow(detail)
        guard let advancedScroll = scrollView(in: detail), let advancedDocument = advancedScroll.documentView else { fatalError("Missing advanced scroll") }
        precondition(advancedDocument.bounds.height > advancedScroll.contentView.bounds.height)
        press("settings.wallet.devnet.copy", detail, detailWindow)
        precondition(copied == [address, "DevnetFixturePublicAddress"], "Advanced retains separate wallet copy actions")
        press("settings.data-folder", detail, detailWindow)
        press("settings.github", detail, detailWindow)
        precondition(opened == [directory] && repositories == 1 && reloads == 0)
        try render(detail, suffix: "advanced")
        detailWindow.close()

        let missing = CardSettingsPresentation(wallets: [.init(id: "mainnet", label: "Mainnet", address: nil, status: .missing)])
        let unavailable = NSHostingView(rootView: body(false, missing))
        let missingWindow = fixtureWindow(unavailable)
        precondition(element("settings.wallet.mainnet.copy", unavailable) == nil, "Missing wallets cannot be copied")
        missingWindow.close()
        print("Settings native UI passed: top agent selector on every tab, primary home entries visible, Advanced reachable by scrolling, current wallet only, exact public-address copy, host/Advanced routing, retained Advanced actions and missing-wallet state")
    }

    @MainActor private static func fixtureWindow(_ host: NSView, visible: Bool = false) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 160, y: 160, width: host.fittingSize.width, height: host.fittingSize.height),
            styleMask: visible ? [.titled, .closable] : .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = host
        window.alphaValue = visible ? 1 : 0
        window.makeKeyAndOrderFront(nil)
        settle(host)
        return window
    }
    @MainActor private static func nodes(_ object: NSObject) -> [NSObject] {
        guard object.responds(to: NSSelectorFromString("accessibilityChildren")) else { return [object] }
        return [object] + (object.value(forKey: "accessibilityChildren") as? [NSObject] ?? []).flatMap(nodes)
    }
    @MainActor private static func element(_ id: String, _ host: NSView) -> NSObject? {
        nodes(host).first { $0.responds(to: NSSelectorFromString("accessibilityIdentifier")) && $0.value(forKey: "accessibilityIdentifier") as? String == id }
    }
    @MainActor private static func press(_ id: String, _ host: NSView, _ window: NSWindow) {
        guard let node = element(id, host), let frame = node.value(forKey: "accessibilityFrame") as? NSValue else { fatalError("Missing control: \(id)") }
        if let scroll = scrollView(in: host), let document = scroll.documentView {
            document.scrollToVisible(document.convert(window.convertFromScreen(frame.rectValue), from: nil))
            settle(host)
        }
        let current = (node.value(forKey: "accessibilityFrame") as! NSValue).rectValue
        let point = window.convertPoint(fromScreen: NSPoint(x: current.midX, y: current.midY))
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            window.sendEvent(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!)
        }
        settle(host)
    }
    @MainActor private static func settle(_ host: NSView) {
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: .now.addingTimeInterval(0.15))
    }
    @MainActor private static func scrollView(in view: NSView) -> NSScrollView? {
        if let scroll = view as? NSScrollView { return scroll }
        return view.subviews.compactMap { scrollView(in: $0) }.first
    }
    @MainActor private static func render(_ host: NSView, suffix: String) throws {
        guard let output = ProcessInfo.processInfo.environment["YOSH_SETTINGS_REVIEW_OUTPUT"] else { return }
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("No bitmap") }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try bitmap.representation(using: .png, properties: [:])?.write(to: URL(filePath: output + "/settings-" + suffix + ".png"))
    }
}
