import AppKit
import SwiftUI

final class CardApplicationDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var cardWindow: AgentCardNSWindow?
    private var instanceLock: AppInstanceLock?
    private var serviceRuntime: NativeServiceRuntime?
    private var terminationRequested = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let isDevelopment = YoshPayDevelopment.isEnabled()
        do {
            let lockURL = try isDevelopment ? YoshPayDevelopment.dataDirectory().appending(path: "native-app.lock")
                : FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                    .appending(path: "2049/native-app.lock") // Production retains the legacy singleton lock.
            guard let lock = try AppInstanceLock.acquire(at: lockURL) else {
                if let pid = AppInstanceLock.ownerPID(at: lockURL),
                   let owner = NSRunningApplication(processIdentifier: pid),
                   owner.bundleIdentifier == Bundle.main.bundleIdentifier {
                    owner.activate(options: [.activateAllWindows])
                }
                NSApp.terminate(nil)
                return
            }
            instanceLock = lock
        } catch {
            NSLog("Yosh could not claim the native app instance lock: %@", String(describing: error))
            NSApp.terminate(nil)
            return
        }
        let serviceRuntime = NativeServiceRuntime()
        self.serviceRuntime = serviceRuntime
        let windowRect = NSRect(origin: .zero, size: CardMetrics.windowSize)
        let window = AgentCardNSWindow(
            contentRect: windowRect,
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = isDevelopment ? "Yosh Pay Dev" : "Yosh"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.contentView = NSHostingView(rootView: CardWindow(overviewClient: OverviewClient(runtime: serviceRuntime), appLock: YoshAppLock(developmentSession: isDevelopment)))
        window.setFrame(windowRect, display: false)
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            window.standardWindowButton(button)?.isHidden = true
        }
        window.isOpaque = false
        // Give the transparent window a mouse target even where SwiftUI draws material.
        window.backgroundColor = NSColor(white: 1, alpha: 0.01)
        window.ignoresMouseEvents = false
        window.isMovableByWindowBackground = false
        window.hasShadow = false
        window.level = .normal
        window.collectionBehavior = [.fullScreenPrimary]
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        cardWindow = window
        Task { _ = try? await serviceRuntime.ready() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if cardWindow?.isMiniaturized == true { cardWindow?.deminiaturize(nil) }
        cardWindow?.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let serviceRuntime else { return .terminateNow }
        if terminationRequested { return .terminateLater }
        terminationRequested = true
        Task {
            let stopped = await serviceRuntime.shutdown()
            if !stopped { terminationRequested = false }
            sender.reply(toApplicationShouldTerminate: stopped)
        }
        return .terminateLater
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NSApp.hide(nil)
        return false
    }
}
