import Foundation

@MainActor final class FixtureNotificationDelivery: PurchaseNotificationDelivery {
    var allowed = true
    var fail = false
    var sent: [String: String] = [:]
    func isAllowed() async -> Bool { allowed }
    func requestPermission() async throws -> Bool { allowed }
    func send(identifier: String, body: String) async throws {
        if fail { throw OverviewLoadError.unavailable }
        sent[identifier] = body
    }
}

@main struct PurchaseNotificationsTest {
    @MainActor static func main() async throws {
        if CommandLine.arguments.count == 2 {
            let url = URL(string: CommandLine.arguments[1])!
            let config = ServiceConfiguration(baseURL: url, managementToken: "notification-transport-fixture-token-12345")
            let (data, response) = try await config.request(.purchaseNotifications(17))
            precondition(response.statusCode == 200)
            let feed = try JSONDecoder().decode(PurchaseNotificationFeed.self, from: data)
            try feed.validate(after: 17)
            print("Notification transport passed: signed query and verified response")
            return
        }
        let suite = "yosh-notifications-fixture-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let delivery = FixtureNotificationDelivery()
        let model = PurchaseNotifications(defaults: defaults, delivery: delivery)
        let store = String(repeating: "a", count: 64)
        let other = String(repeating: "b", count: 64)
        let event = PurchaseNotificationFeed.Event(sequence: 11, purchaseId: "fixture", agent: "Codex\nAgent",
            apiName: "API", priceDisplay: "0.01 Test USDC", quantity: "1", outcome: .paid)
        precondition(event.body == "Codex Agent · API · 0.01 Test USDC × 1 · Paid")
        var currentStore = store
        var cursor: Int64 = 10
        var events: [PurchaseNotificationFeed.Event] = []
        var calls = 0
        func load(_ after: Int64?) async throws -> PurchaseNotificationFeed {
            calls += 1
            return .init(storeId: currentStore, cursor: cursor,
                events: after == nil ? [] : events.filter { $0.sequence > after! })
        }
        try await model.poll(load: load)
        precondition(calls == 0, "Disabled notifications must not read purchases")
        delivery.allowed = false
        await model.setEnabled(true)
        precondition(!model.enabled && model.message != nil, "Denied permission keeps notifications off")
        delivery.allowed = true
        await model.setEnabled(true)
        try await model.poll(load: load)
        precondition(delivery.sent.isEmpty, "Enabling must baseline history")
        events = [event]; cursor = 11
        delivery.fail = true
        do { try await model.poll(load: load); fatalError("Expected OS scheduling failure") } catch {}
        delivery.fail = false
        try await model.poll(load: load)
        precondition(delivery.sent.count == 1)
        try await model.poll(load: load)
        precondition(delivery.sent.count == 1, "Refreshing must not repeat a purchase")
        let restarted = PurchaseNotifications(defaults: defaults, delivery: delivery)
        await restarted.refreshPermission()
        try await restarted.poll(load: load)
        precondition(delivery.sent.count == 1, "Restart resumes persisted progress")
        await restarted.setEnabled(false)
        cursor = 12
        events.append(.init(sequence: 12, purchaseId: "off", agent: "Other Agent", apiName: "API",
            priceDisplay: "1 USDC", quantity: "1", outcome: .unpaid))
        await restarted.setEnabled(true)
        try await restarted.poll(load: load)
        precondition(delivery.sent.count == 1, "Re-enabling must skip purchases made while off")
        currentStore = other; cursor = 0; events = []
        restarted.serviceChanged()
        try await restarted.poll(load: load)
        precondition(delivery.sent.count == 1, "New environments have separate baselines")
        var rejected = false
        do { try PurchaseNotificationFeed(storeId: other, cursor: 1, events: [event]).validate(after: 0) }
        catch { rejected = true }
        precondition(rejected, "Out-of-order or forged cursor responses are rejected")
        print("Purchase notifications passed: permission denial, baseline, format, OS failure retry, persistence, re-enable and environment isolation")
    }
}
