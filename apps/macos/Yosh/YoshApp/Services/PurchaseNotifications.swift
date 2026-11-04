import AppKit
import Foundation
import Observation
import UserNotifications

@MainActor
protocol PurchaseNotificationDelivery {
    func isAllowed() async -> Bool
    func requestPermission() async throws -> Bool
    func send(identifier: String, body: String) async throws
}

/// Apple's notification center owns presentation and the user's delivery preferences.
@MainActor
final class MacPurchaseNotificationDelivery: NSObject, PurchaseNotificationDelivery, UNUserNotificationCenterDelegate {
    func isAllowed() async -> Bool {
        guard Bundle.main.bundleIdentifier != nil else { return false }
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        return status == .authorized || status == .provisional
    }
    func requestPermission() async throws -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        return try await center.requestAuthorization(options: [.alert])
    }
    func send(identifier: String, body: String) async throws {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // A crash after OS acceptance but before cursor persistence must not re-alert an existing item.
        let delivered = await center.deliveredNotifications()
        if delivered.contains(where: { $0.request.identifier == identifier }) { return }
        let content = UNMutableNotificationContent()
        content.title = "Yosh"
        content.body = body
        try await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }
}

/// App-owned polling survives closing the card window; no page or selected Agent owns delivery.
@MainActor @Observable
final class PurchaseNotifications {
    static let shared = PurchaseNotifications()
    private(set) var enabled: Bool
    private(set) var allowed = false
    private(set) var isChanging = false
    private(set) var message: String?

    private let defaults: UserDefaults
    private let delivery: any PurchaseNotificationDelivery
    private var task: Task<Void, Never>?
    private var revision = 0
    private var activeStore: String?
    private var baselineOnEnable = false
    private let enabledKey = "yosh.purchaseNotifications.enabled"
    private let cursorKey = "yosh.purchaseNotifications.cursors"

    init(defaults: UserDefaults = .standard, delivery: (any PurchaseNotificationDelivery)? = nil) {
        self.defaults = defaults
        self.delivery = delivery ?? MacPurchaseNotificationDelivery()
        enabled = defaults.bool(forKey: enabledKey)
    }

    func refreshPermission() async { allowed = await delivery.isAllowed() }

    /// SwiftUI bindings require their new value synchronously. Keep the switch On while
    /// macOS is asking, but do not poll purchases until permission is actually granted.
    @discardableResult
    func setEnabled(_ value: Bool) -> Task<Void, Never>? {
        guard !isChanging else { return nil }
        revision += 1
        if !value {
            enabled = false; defaults.set(false, forKey: enabledKey); message = nil
            return nil
        }
        isChanging = true
        message = nil
        return Task {
            defer { isChanging = false }
            do {
                if await delivery.isAllowed() {
                    allowed = true
                } else {
                    allowed = try await delivery.requestPermission()
                    if !allowed { allowed = await delivery.isAllowed() }
                }
                enabled = allowed
                defaults.set(enabled, forKey: enabledKey)
                baselineOnEnable = enabled
                activeStore = nil
                message = allowed ? nil : "Allow Yosh in System Settings → Notifications."
            } catch {
                enabled = false; defaults.set(false, forKey: enabledKey)
                message = "Notifications couldn't be enabled. Try again."
            }
        }
    }

    func sendPreview() async {
        guard Bundle.main.object(forInfoDictionaryKey: "YoshNotificationPreview") as? Bool == true,
              enabled, allowed else { return }
        do {
            try await delivery.send(identifier: "preview." + UUID().uuidString,
                body: "Demo Agent · Example API (Test) · 0.001 Test USDC × 1 · Paid")
            message = nil
        } catch { message = "The test notification couldn't be sent. Try again." }
    }

    func start(client: OverviewClient) {
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if self.enabled {
                    do {
                        await self.refreshPermission()
                        if self.allowed {
                            try await self.poll { after in try await client.loadPurchaseNotifications(after: after) }
                            self.message = nil
                        }
                    } catch is CancellationError { return }
                    catch { self.message = "Purchase notifications are waiting for Yosh to reconnect." }
                }
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }
    func stop() { revision += 1; task?.cancel(); task = nil }
    func serviceChanged() { revision += 1; activeStore = nil }

    /// Persist a cursor only after every eligible event was accepted by macOS.
    /// The notification ID is stable across retries and the stores have independent cursors.
    func poll(load: (Int64?) async throws -> PurchaseNotificationFeed) async throws {
        guard enabled, allowed else { return }
        let currentRevision = revision
        var cursors = defaults.dictionary(forKey: cursorKey) as? [String: String] ?? [:]
        if activeStore == nil {
            let baseline = try await load(nil)
            try baseline.validate(after: nil)
            guard enabled, revision == currentRevision, !Task.isCancelled else { return }
            activeStore = baseline.storeId
            if baselineOnEnable || cursors[baseline.storeId].flatMap(Int64.init).map({ $0 >= 0 }) != true {
                cursors[baseline.storeId] = String(baseline.cursor)
                defaults.set(cursors, forKey: cursorKey)
            }
            baselineOnEnable = false
        }
        guard let store = activeStore, let after = cursors[store].flatMap(Int64.init) else { return }
        let feed = try await load(after)
        try feed.validate(after: nil)
        guard enabled, revision == currentRevision, !Task.isCancelled else { return }
        guard feed.storeId == store else { activeStore = nil; return }
        try feed.validate(after: after)
        for event in feed.events {
            guard enabled, revision == currentRevision, !Task.isCancelled else { return }
            try await delivery.send(identifier: event.identifier(storeId: store), body: event.body)
            guard enabled, revision == currentRevision, !Task.isCancelled else { return }
            cursors[store] = String(event.sequence)
            defaults.set(cursors, forKey: cursorKey)
        }
        cursors[store] = String(feed.cursor)
        defaults.set(cursors, forKey: cursorKey)
    }
}

// The notification feed has its own bounded DTO; normal overview clients do not depend on it.
extension OverviewClient {
    func loadPurchaseNotifications(after: Int64?) async throws -> PurchaseNotificationFeed {
        let configuration = try await runtime.ready()
        let (data, response) = try await configuration.request(.purchaseNotifications(after))
        guard response.statusCode == 200, data.count <= 65_536 else { throw OverviewLoadError.unavailable }
        let feed = try JSONDecoder().decode(PurchaseNotificationFeed.self, from: data)
        try feed.validate(after: nil)
        return feed
    }
}
