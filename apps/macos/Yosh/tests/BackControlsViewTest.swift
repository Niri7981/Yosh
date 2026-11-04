import AppKit
import SwiftUI

/// Native callback-only fixture; never changes a real payment policy or contacts the backend.
@main
struct BackControlsViewTest {
    @MainActor
    static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        NSApp.accessibilitySetValue(true, forAttribute: .init(rawValue: "AXEnhancedUserInterface"))
        var paymentChanges: [Bool] = []
        var executionOpens = 0
        func page(enabled: Bool? = true, updating: Bool = false) -> some View {
            BackControls(payments: enabled == true ? "On" : "Paused", paymentsEnabled: enabled,
                paymentsUpdating: updating, onPaymentsChange: { paymentChanges.append($0) },
                execution: "Mainnet", onExecution: { executionOpens += 1 })
                .frame(width: 368, height: 117, alignment: .topLeading)
                .background(YoshShellPalette.surface)
                .environment(\.colorScheme, .light)
        }
        let host = NSHostingView(rootView: page())
        let window = NSWindow(contentRect: NSRect(x: 160, y: 160, width: 368, height: 117),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.alphaValue = 0
        window.makeKeyAndOrderFront(nil)
        settle(host)
        defer { window.close() }

        precondition(host.frame.size == NSSize(width: 368, height: 117),
            "Separate control frames must retain the original Authority controls viewport")
        precondition(isEnabled("authority.payments.toggle", in: host)
            && isEnabled("authority.execution.open", in: host))
        press("authority.payments.toggle", in: host, window: window)
        precondition(paymentChanges == [false] && executionOpens == 0,
            "The native Payments switch must emit false from On without opening Execution")
        press("authority.execution.open", in: host, window: window)
        precondition(executionOpens == 1 && paymentChanges == [false],
            "Execution must open independently without changing Payments")

        host.rootView = page(enabled: false)
        settle(host)
        press("authority.payments.toggle", in: host, window: window)
        precondition(paymentChanges == [false, true] && executionOpens == 1,
            "The native Payments switch must emit true from Paused")

        host.rootView = page(updating: true)
        settle(host)
        precondition(!isEnabled("authority.payments.toggle", in: host)
            && !isEnabled("authority.execution.open", in: host),
            "An in-flight settings write must disable both native controls")
        press("authority.payments.toggle", in: host, window: window)
        press("authority.execution.open", in: host, window: window)
        precondition(paymentChanges == [false, true] && executionOpens == 1,
            "Decorative frames cannot bypass disabled controls")

        host.rootView = page(enabled: nil)
        settle(host)
        precondition(!isEnabled("authority.payments.toggle", in: host),
            "Unavailable payment state must disable the switch")
        press("authority.payments.toggle", in: host, window: window)
        precondition(paymentChanges == [false, true], "Unavailable state cannot emit a policy change")
        press("authority.execution.open", in: host, window: window)
        precondition(executionOpens == 2 && paymentChanges == [false, true],
            "Payment availability alone must not change the Execution control's callback")
        print("Authority controls: native switch exact values, independent Execution route, updating/unavailable disablement and fixed 368×117 viewport passed")
    }

    @MainActor private static func settle(_ host: NSView) {
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: .now.addingTimeInterval(0.2))
    }

    @MainActor private static func nodes(_ object: NSObject) -> [NSObject] {
        guard object.responds(to: NSSelectorFromString("accessibilityChildren")) else { return [object] }
        return [object] + (object.value(forKey: "accessibilityChildren") as? [NSObject] ?? []).flatMap(nodes)
    }

    @MainActor private static func element(_ id: String, in host: NSView) -> NSObject {
        guard let node = nodes(host).first(where: {
            $0.responds(to: NSSelectorFromString("accessibilityIdentifier"))
                && $0.value(forKey: "accessibilityIdentifier") as? String == id
        }) else { fatalError("Missing native control: \(id)") }
        return node
    }

    @MainActor private static func isEnabled(_ id: String, in host: NSView) -> Bool {
        let node = element(id, in: host)
        guard node.responds(to: NSSelectorFromString("isAccessibilityEnabled"))
            || node.responds(to: NSSelectorFromString("accessibilityEnabled")),
              let enabled = node.value(forKey: "accessibilityEnabled") as? Bool else {
            fatalError("Native control must expose its enabled state: \(id)")
        }
        return enabled
    }

    @MainActor private static func press(_ id: String, in host: NSView, window: NSWindow) {
        let node = element(id, in: host)
        guard let value = node.value(forKey: "accessibilityFrame") as? NSValue else {
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
}
