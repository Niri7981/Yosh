import AppKit
import SwiftUI

@MainActor @Observable
private final class DailyLimitProbe {
    struct Request: Equatable {
        let minorUnits: String
        let scopeID: String
    }

    var overview: AppOverview
    var isBusy = false
    var isActive = true
    var scopeID: String? = "fixture-scope"
    var cardSize = CGSize.zero
    var requests: [Request] = []
    var detailsOpens = 0
    private(set) var pending: CheckedContinuation<String?, Never>?

    init() throws {
        overview = try Self.overview()
    }

    func save(_ minorUnits: String, _ scopeID: String) async -> String? {
        precondition(pending == nil, "An inline save must not overlap another save")
        requests.append(Request(minorUnits: minorUnits, scopeID: scopeID))
        return await withCheckedContinuation { pending = $0 }
    }

    func finish(error: String? = nil, refreshed: AppOverview? = nil) {
        guard let continuation = pending else { fatalError("Missing fixture save") }
        // A successful production callback includes the authoritative overview refresh.
        // Available is supplied separately: the editor must never assign its draft to it.
        if let refreshed { overview = refreshed }
        pending = nil
        continuation.resume(returning: error)
    }

    static func overview(limit: String = "2000000", limitDisplay: String = "2.00",
        available: String = "1500000", availableDisplay: String = "1.50") throws -> AppOverview {
        let network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
        let payload: [String: Any] = [
            "service": ["status": "running", "purchaseMode": "live_mainnet", "network": "Solana Mainnet",
                "execution": ["mode": "live_mainnet", "cluster": "mainnet-beta", "network": network,
                    "asset": ["network": network, "mint": "fixture-mainnet-mint", "symbol": "USDC", "decimals": 6, "displayLabel": "USDC"],
                    "productionExecutionEnabled": false, "spendingAuthorized": false, "configurationReady": false]],
            "wallet": ["address": "FixturePublicAddress"],
            // Deliberately different legacy figures catch accidental fallback across scopes.
            "budget": ["dailyLimit": "9000000", "dailyLimitDisplay": "9.00 Test USDC", "paid": "0", "reserved": "0",
                "remaining": "9000000", "remainingDisplay": "9.00 Test USDC", "paused": false],
            "grant": NSNull(),
            "connection": ["enabled": false, "lastSeen": NSNull(), "access": "purchase_intent"],
            "purchases": [],
            "authority": ["mode": "live_mainnet", "network": network, "assetId": "fixture-mainnet-mint", "assetDecimals": 6,
                "assetLabel": "USDC", "dailyLimit": limit, "available": available, "reserved": "300000", "paid": "200000",
                "availableDisplay": availableDisplay, "reservedDisplay": "0.30", "paidDisplay": "0.20",
                "dailyLimitDisplay": "of \(limitDisplay) USDC daily", "dailyState": "active", "blockers": [],
                "wallet": ["address": "FixturePublicAddress", "network": "Solana Mainnet", "status": "available"], "grant": NSNull()],
        ]
        return try JSONDecoder().decode(AppOverview.self, from: JSONSerialization.data(withJSONObject: payload))
    }
}

private struct DailyLimitFixture: View {
    let probe: DailyLimitProbe
    let colorScheme: ColorScheme

    var body: some View {
        VStack(spacing: 0) {
            DailyAuthorityCard(overview: probe.overview, isBusy: probe.isBusy,
                isActive: probe.isActive, scopeID: probe.scopeID,
                onSave: { amount, scope in await probe.save(amount, scope) },
                onOpenDetails: { probe.detailsOpens += 1 })
                .onGeometryChange(for: CGSize.self) { $0.size } action: { probe.cardSize = $0 }
            Spacer(minLength: 0)
        }
        .frame(width: 368, height: 210, alignment: .top)
        .background(YoshShellPalette.surface)
        .environment(\.colorScheme, colorScheme)
        .transaction { $0.disablesAnimations = true }
    }
}

private final class DailyLimitFixtureWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// Exercises the real card and native field editor using a held, callback-only save.
/// It never contacts the backend, changes a real limit, or submits a payment.
@main
struct DailyLimitInlineEditingTest {
    @MainActor static func main() throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        NSApp.accessibilitySetValue(true, forAttribute: .init(rawValue: "AXEnhancedUserInterface"))
        for colorScheme in [ColorScheme.dark, .light] {
            try validate(colorScheme)
        }
        print("Daily Limit inline editing: scoped limit/Available separation, native editing and Enter/Escape, validation, no-op and duplicate guards, failure/retry, refreshed success, fixed geometry and scope/tab cancellation passed")
    }

    @MainActor private static func validate(_ colorScheme: ColorScheme) throws {
        let probe = try DailyLimitProbe()
        let host = NSHostingView(rootView: DailyLimitFixture(probe: probe, colorScheme: colorScheme))
        let window = DailyLimitFixtureWindow(contentRect: NSRect(x: 160, y: 160, width: 368, height: 210),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.alphaValue = 0
        window.makeKeyAndOrderFront(nil)
        settle(host)
        defer { window.close() }

        let defaultSize = probe.cardSize
        precondition(defaultSize.width == 368 && defaultSize.height > 0 && defaultSize.height <= 210,
            "The card must retain the existing narrow Authority viewport")
        try snapshot(host, name: "viewing", scheme: colorScheme)
        precondition(label("daily.inline.open", in: host).contains("1.50"),
            "The viewing state must display backend Available, independently of the configured 2.00 limit")
        precondition(probe.overview.selectedAuthority?.dailyLimit?.value == 2_000_000)
        precondition(probe.overview.selectedAuthority?.available?.value == 1_500_000)

        press("daily.inline.open", in: host, window: window)
        precondition(fieldValue(in: host) == "2.00", "The initial draft must read the configured limit, not Available or the legacy test budget")
        if window.isKeyWindow {
            let focusDeadline = Date.now.addingTimeInterval(0.8)
            while !(window.firstResponder is NSTextView), Date.now < focusDeadline { settle(host) }
            guard let editor = window.firstResponder as? NSTextView else {
                fatalError("Opening inline editing must focus the native macOS amount field automatically")
            }
            precondition(editor.string == "2.00", "Automatic focus must belong to the Daily Limit field")
        } else {
            // Prohibited invisible fixtures cannot become key, even with native makeKey.
            // Do not activate the desktop or pretend first-responder setup proves autofocus.
            print("Daily Limit autofocus unproven: nonactivating native fixture has no key window (\(colorScheme))")
        }
        sameSize(probe.cardSize, defaultSize)
        try snapshot(host, name: "editing", scheme: colorScheme)

        edit("7.123456", in: host, window: window)
        press("daily.inline.cancel", in: host, window: window)
        viewing(host)
        precondition(probe.requests.isEmpty && probe.detailsOpens == 0,
            "Cancel must discard the draft without a write or page navigation")

        press("daily.inline.open", in: host, window: window)
        precondition(fieldValue(in: host) == "2.00", "Cancel must restore the original configured value")
        edit("2.5", in: host, window: window)
        key(window, code: 53, characters: "\u{1b}", host: host)
        viewing(host)
        precondition(probe.requests.isEmpty, "Escape must cancel without updating the backend")

        press("daily.inline.open", in: host, window: window)
        edit("2.000000", in: host, window: window)
        key(window, code: 36, characters: "\r", host: host)
        viewing(host)
        precondition(probe.requests.isEmpty, "Numerically unchanged input must finish without a redundant update")

        press("daily.inline.open", in: host, window: window)
        for invalid in ["", "-1", "0.0000001", "1000000000", "1e2", "1."] {
            edit(invalid, in: host, window: window)
            precondition(!isEnabled("daily.inline.save", in: host), "Invalid amount must disable Save: \(invalid)")
            key(window, code: 36, characters: "\r", host: host)
            precondition(probe.requests.isEmpty && element("daily.inline.input", in: host) != nil,
                "Enter cannot bypass amount validation")
        }
        edit("0", in: host, window: window)
        precondition(isEnabled("daily.inline.save", in: host), "Zero must keep the existing accepted parser semantics")
        edit("999999999.999999", in: host, window: window)
        precondition(isEnabled("daily.inline.save", in: host), "The existing maximum six-decimal amount remains editable")

        edit("3.123456", in: host, window: window)
        key(window, code: 36, characters: "\r", host: host)
        precondition(probe.requests == [.init(minorUnits: "3123456", scopeID: "fixture-scope")] && probe.pending != nil,
            "Enter must pass exact minor units and the original scope to the existing update callback")
        precondition(!isEnabled("daily.inline.save", in: host) && !isEnabled("daily.inline.cancel", in: host),
            "An outstanding save must disable duplicate submission and cancellation")
        press("daily.inline.save", in: host, window: window)
        key(window, code: 36, characters: "\r", host: host)
        key(window, code: 53, characters: "\u{1b}", host: host)
        precondition(probe.requests.count == 1 && element("daily.inline.input", in: host) != nil,
            "Pending save cannot close optimistically or issue another update")
        precondition(probe.overview.selectedAuthority?.dailyLimit?.value == 2_000_000,
            "The backend fixture must remain unchanged until its response")

        probe.finish(error: "Fixture save failed. Try again.")
        settle(host)
        precondition(fieldValue(in: host) == "3.123456", "Failure must preserve the exact entered draft")
        precondition(element("daily.inline.error", in: host) != nil && isEnabled("daily.inline.save", in: host),
            "Failed saves must expose an error and allow retry")
        sameSize(probe.cardSize, defaultSize)
        try snapshot(host, name: "retry", scheme: colorScheme)

        press("daily.inline.save", in: host, window: window)
        precondition(probe.requests.count == 2 && probe.requests[1] == probe.requests[0], "Retry must keep the same amount and scope")
        let refreshed = try DailyLimitProbe.overview(limit: "3123456", limitDisplay: "3.123456",
            available: "2623456", availableDisplay: "2.623456")
        probe.finish(refreshed: refreshed)
        settle(host)
        viewing(host)
        precondition(label("daily.inline.open", in: host).contains("2.623456"),
            "Confirmed save must show the refreshed backend Available, including existing Paid and Reserved")
        precondition(probe.overview.selectedAuthority?.dailyLimit?.value == 3_123_456
            && probe.overview.selectedAuthority?.available?.value == 2_623_456
            && probe.overview.selectedAuthority?.reserved.value == 300_000
            && probe.overview.selectedAuthority?.paid.value == 200_000,
            "Changing a limit must preserve the distinct backend accounting facts")
        sameSize(probe.cardSize, defaultSize)

        press("daily.inline.open", in: host, window: window)
        precondition(fieldValue(in: host) == "3.123456", "Reopening must read the refreshed configured limit")
        edit("4.00", in: host, window: window)
        probe.scopeID = nil
        settle(host)
        precondition(fieldValue(in: host) == "4.00", "A transient overview read failure must preserve the draft")
        precondition(!isEnabled("daily.inline.save", in: host), "A missing scope must block saving until the authoritative read recovers")
        key(window, code: 36, characters: "\r", host: host)
        if probe.requests.count != 2 {
            FileHandle.standardError.write(Data("Unscoped Enter: currentScope=\(String(describing: probe.scopeID)), requests=\(probe.requests), pending=\(probe.pending != nil)\n".utf8))
        }
        precondition(probe.requests.count == 2, "Enter cannot submit an unscoped update during a read failure")
        probe.scopeID = "fixture-scope"
        settle(host)
        probe.isActive = false
        settle(host)
        precondition(element("daily.inline.input", in: host) == nil && probe.requests.count == 2,
            "Leaving Authority must cancel an unsaved edit without a write")
        probe.isActive = true
        settle(host)

        press("daily.inline.open", in: host, window: window)
        precondition(fieldValue(in: host) == "3.123456", "Returning to Authority must discard the previous unsaved draft")
        edit("6.00", in: host, window: window)
        probe.scopeID = "different-scope"
        probe.overview = try DailyLimitProbe.overview(limit: "5000000", limitDisplay: "5.00", available: "4500000", availableDisplay: "4.50")
        settle(host)
        viewing(host)
        precondition(probe.requests.count == 2, "Changing the selected scope must never save an old draft into the new scope")
        press("daily.inline.open", in: host, window: window)
        precondition(fieldValue(in: host) == "5.00", "A new scope must start from its own configured limit")
        press("daily.inline.cancel", in: host, window: window)

        probe.isBusy = true
        settle(host)
        precondition(!isEnabled("daily.inline.open", in: host), "An existing settings write must prevent starting another editor")
        press("daily.inline.open", in: host, window: window)
        precondition(element("daily.inline.input", in: host) == nil && probe.requests.count == 2 && probe.detailsOpens == 0)
        sameSize(probe.cardSize, defaultSize)

        probe.isBusy = false
        settle(host)
        press("daily.inline.open", in: host, window: window)
        edit("6.00", in: host, window: window)
        press("daily.inline.save", in: host, window: window)
        precondition(probe.requests.count == 3 && probe.pending != nil)
        probe.isActive = false
        settle(host)
        probe.finish(error: "Fixture save failed after leaving Authority.")
        settle(host)
        precondition(element("daily.inline.input", in: host) == nil,
            "A late save failure after leaving Authority must not reopen the old editor or steal focus")
        probe.isActive = true
        settle(host)
        press("daily.inline.open", in: host, window: window)
        precondition(fieldValue(in: host) == "5.00", "Returning after a failed background save must use the current confirmed limit")

        edit("6.00", in: host, window: window)
        press("daily.inline.save", in: host, window: window)
        precondition(probe.requests.count == 4 && probe.pending != nil)
        probe.scopeID = "third-scope"
        probe.overview = try DailyLimitProbe.overview(limit: "7000000", limitDisplay: "7.00", available: "6500000", availableDisplay: "6.50")
        settle(host)
        probe.finish(error: "Fixture save failed after switching scope.")
        settle(host)
        viewing(host)
        press("daily.inline.open", in: host, window: window)
        precondition(fieldValue(in: host) == "7.00", "A late error from the previous scope must not preserve its draft in a new scope")
        press("daily.inline.cancel", in: host, window: window)
        precondition(probe.detailsOpens == 0 && probe.requests.count == 4)
        sameSize(probe.cardSize, defaultSize)

        press("daily.inline.open", in: host, window: window)
        edit("8.00", in: host, window: window)
        probe.isBusy = true
        settle(host)
        precondition(!isEnabled("daily.inline.save", in: host))
        key(window, code: 36, characters: "\r", host: host)
        precondition(probe.requests.count == 4, "Native Enter must respect a settings write that started after the field was created")
        probe.isBusy = false
        probe.overview = try DailyLimitProbe.overview(limit: "8000000", limitDisplay: "8.00", available: "7500000", availableDisplay: "7.50")
        settle(host)
        precondition(fieldValue(in: host) == "8.00", "Polling a new overview must preserve the user's active draft")
        key(window, code: 36, characters: "\r", host: host)
        viewing(host)
        precondition(probe.requests.count == 4, "Native Enter must compare against the latest confirmed limit instead of its original view snapshot")
        sameSize(probe.cardSize, defaultSize)
    }

    @MainActor private static func settle(_ host: NSView) {
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: .now.addingTimeInterval(0.12))
        host.layoutSubtreeIfNeeded()
    }

    @MainActor private static func nodes(_ object: NSObject) -> [NSObject] {
        guard object.responds(to: NSSelectorFromString("accessibilityChildren")) else { return [object] }
        return [object] + (object.value(forKey: "accessibilityChildren") as? [NSObject] ?? []).flatMap(nodes)
    }

    @MainActor private static func element(_ id: String, in host: NSView) -> NSObject? {
        nodes(host).first {
            $0.responds(to: NSSelectorFromString("accessibilityIdentifier"))
                && $0.value(forKey: "accessibilityIdentifier") as? String == id
        }
    }

    @MainActor private static func label(_ id: String, in host: NSView) -> String {
        guard let node = element(id, in: host), node.responds(to: NSSelectorFromString("accessibilityLabel")),
              let label = node.value(forKey: "accessibilityLabel") as? String else {
            let identifiers = nodes(host).compactMap { node -> String? in
                guard node.responds(to: NSSelectorFromString("accessibilityIdentifier")) else { return nil }
                return node.value(forKey: "accessibilityIdentifier") as? String
            }
            FileHandle.standardError.write(Data("Available native identifiers: \(identifiers)\n".utf8))
            fatalError("Missing native label: \(id)")
        }
        return label
    }

    @MainActor private static func fieldValue(in host: NSView) -> String {
        guard let node = element("daily.inline.input", in: host), node.responds(to: NSSelectorFromString("accessibilityValue")),
              let value = node.value(forKey: "accessibilityValue") as? String else { fatalError("Missing native amount field") }
        return value
    }

    @MainActor private static func isEnabled(_ id: String, in host: NSView) -> Bool {
        guard let node = element(id, in: host),
              node.responds(to: NSSelectorFromString("isAccessibilityEnabled")) || node.responds(to: NSSelectorFromString("accessibilityEnabled")),
              let enabled = node.value(forKey: "accessibilityEnabled") as? Bool else { fatalError("Missing enabled state: \(id)") }
        return enabled
    }

    @MainActor private static func press(_ id: String, in host: NSView, window: NSWindow) {
        guard let node = element(id, in: host), let value = node.value(forKey: "accessibilityFrame") as? NSValue else {
            fatalError("Missing native hit frame: \(id)")
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

    @MainActor private static func edit(_ value: String, in host: NSView, window: NSWindow) {
        press("daily.inline.input", in: host, window: window)
        guard let editor = window.firstResponder as? NSTextView else { fatalError("Limit must retain a native macOS field editor") }
        editor.selectAll(nil)
        editor.insertText(value, replacementRange: editor.selectedRange())
        settle(host)
        precondition(fieldValue(in: host) == value, "The native field must preserve the user's exact draft")
    }

    @MainActor private static func key(_ window: NSWindow, code: UInt16, characters: String, host: NSView) {
        window.sendEvent(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
            characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!)
        settle(host)
    }

    @MainActor private static func viewing(_ host: NSView) {
        precondition(element("daily.inline.open", in: host) != nil && element("daily.inline.input", in: host) == nil,
            "The card must return to its original viewing state in place")
    }

    private static func sameSize(_ actual: CGSize, _ expected: CGSize) {
        precondition(abs(actual.width - expected.width) < 0.1 && abs(actual.height - expected.height) < 0.1,
            "Inline editing must preserve the original card size: \(actual) instead of \(expected)")
    }

    @MainActor private static func snapshot(_ host: NSView, name: String, scheme: ColorScheme) throws {
        guard let prefix = CommandLine.arguments.dropFirst().first else { return }
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("Fixture rendering unavailable") }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let suffix = scheme == .dark ? "dark" : "light"
        try bitmap.representation(using: .png, properties: [:])?.write(to: URL(filePath: "\(prefix)-\(name)-\(suffix).png"))
    }
}
