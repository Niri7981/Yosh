import AppKit
import SwiftUI

@MainActor final class PendingNotificationPermission: PurchaseNotificationDelivery {
    var allowed = false
    var requests = 0
    var pending: CheckedContinuation<Bool, Error>?
    func isAllowed() async -> Bool { allowed }
    func requestPermission() async throws -> Bool {
        requests += 1
        return try await withCheckedThrowingContinuation { pending = $0 }
    }
    func send(identifier: String, body: String) async throws {}
    func resolve(_ value: Bool) { allowed = value; pending?.resume(returning: value); pending = nil }
}

@main struct PurchaseNotificationsRowTest {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        NSApp.accessibilitySetValue(true, forAttribute: .init(rawValue: "AXEnhancedUserInterface"))
        let suite = "yosh-notification-row-fixture-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let permission = PendingNotificationPermission()
        let model = PurchaseNotifications(defaults: defaults, delivery: permission)
        let host = NSHostingView(rootView: PurchaseNotificationsRow(notifications: model).padding(20).frame(width: 420, height: 160))
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 420, height: 160),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host; window.alphaValue = 0; window.makeKeyAndOrderFront(nil)
        settle(host)
        func toggle() -> NSObject {
            guard let node = nodes(host).first(where: {
                $0.responds(to: NSSelectorFromString("accessibilityRole"))
                    && $0.value(forKey: "accessibilityRole") as? String == "AXCheckBox"
            }) else { fatalError("Missing native Notifications switch") }
            return node
        }
        func value() -> Bool { (toggle().value(forKey: "accessibilityValue") as? NSNumber)?.boolValue == true }
        precondition(!value())
        click(toggle(), window)
        settle(host)
        precondition(permission.requests == 1 && model.isChanging, "The real switch must request permission once")
        precondition(value(), "Opening Notifications must keep the switch visibly on while permission is pending")
        permission.resolve(true); settle(host)
        precondition(value() && model.enabled && model.allowed)
        precondition(defaults.bool(forKey: "yosh.purchaseNotifications.enabled"))
        click(toggle(), window); settle(host)
        precondition(!value() && !model.enabled)
        click(toggle(), window); settle(host)
        precondition(value() && model.enabled && model.allowed)
        precondition(permission.requests == 1, "Existing OS permission must enable without asking again")
        window.close()
        print("Notifications native switch passed: pending permission stays visibly on, grant persists On, Off remains actionable")
    }
    @MainActor static func click(_ node: NSObject, _ window: NSWindow) {
        let frame = (node.value(forKey: "accessibilityFrame") as! NSValue).rectValue
        let point = window.convertPoint(fromScreen: NSPoint(x: frame.maxX - 12, y: frame.midY))
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            window.sendEvent(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!)
        }
    }
    @MainActor static func settle(_ host: NSView) {
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: .now.addingTimeInterval(0.25))
    }
    @MainActor static func nodes(_ object: NSObject) -> [NSObject] {
        guard object.responds(to: NSSelectorFromString("accessibilityChildren")) else { return [object] }
        return [object] + (object.value(forKey: "accessibilityChildren") as? [NSObject] ?? []).flatMap(nodes)
    }
}
