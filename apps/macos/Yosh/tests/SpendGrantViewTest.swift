import AppKit
import SwiftUI

@MainActor @Observable
private final class ExpiryProbe {
    var selection: Date
    init(_ selection: Date) { self.selection = selection }
}

@MainActor
private final class ResourceMenuSelection: NSObject {
    let title: String
    init(_ title: String) { self.title = title }
    @objc func select(_ notification: Notification) {
        guard let menu = notification.object as? NSMenu,
              let index = menu.items.firstIndex(where: { $0.title == title }) else { return }
        DispatchQueue.main.async { menu.performActionForItem(at: index); menu.cancelTracking() }
    }
}

/// Native, callback-only fixtures. No backend, real grant, credentials or payments.
@main
struct SpendGrantViewTest {
    @MainActor static func main() throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        NSApp.accessibilitySetValue(true, forAttribute: .init(rawValue: "AXEnhancedUserInterface"))
        if CommandLine.arguments.contains("--per-transaction-only") {
            try perTransactionFixture()
            return
        }
        for (input, expected) in [("0.20", "200000"), ("1.000001", "1000001"), (" 2.123456 ", "2123456"), ("0", "0")] {
            precondition(SpendGrantDraft.minorUnits(input) == expected)
        }
        for input in ["-1", "1e3", "0.0000001", "01.2", "NaN", "1000000000"] {
            precondition(SpendGrantDraft.minorUnits(input) == nil, "Malformed or inexact amounts must not be rounded")
        }
        precondition(SpendGrantDraft.decimal(200000, decimals: 6) == "0.20")
        precondition(SpendGrantDraft.decimal(200001, decimals: 6) == "0.200001")
        precondition(SpendGrantDraft.decimal(0, decimals: 6) == "0.00")
        precondition(SpendGrantDraft.decimal(1, decimals: 18) == "0.000000000000000001")
        let expired = try overview(enabled: false)
        let draft = SpendGrantDraft(grant: expired.grant)
        precondition(draft.expiration > .now && draft.total == "0.20", "Expired grants seed a future draft without losing the current summary")
        var backs = 0, connections = 0, submissions: [(String, String, Int64)] = []
        func page(_ overview: AppOverview, saving: Bool = false, id: Int = 0) -> some View {
            SpendGrantDetail(overview: overview, isSaving: saving, writeMessage: nil, writeFailed: false,
                onBack: { backs += 1 }, onConnection: { connections += 1 },
                onCreate: { total, single, expiresAt, _, _, _ in submissions.append((total, single, expiresAt)) }, onRevoke: { _ in })
                .id(id).frame(width: 420, height: 526)
                .background(Color(red: 0.95, green: 0.97, blue: 0.985))
                .environment(\.colorScheme, .light)
        }
        let host = NSHostingView(rootView: page(expired))
        let window = makeWindow(host, size: NSSize(width: 420, height: 526))
        defer { window.close() }
        settle(host)
        guard let scroll = scrollViews(host).first, let document = scroll.documentView else { fatalError("Missing native page scroll view") }
        precondition(document.bounds.width <= scroll.contentView.bounds.width + 1)
        precondition(abs(scroll.contentView.bounds.origin.y) < 0.5)
        precondition(element("grant-total", in: host) != nil && element("grant-per-transaction", in: host) == nil,
            "Spend Grant must show only the total authorized input")
        precondition(element("grant-current-details", in: host) != nil,
            "Existing grants must retain a compact details disclosure")
        precondition(!accessibleText(host).contains("Remaining"),
            "The previous grant summary must be collapsed while editing a new grant")
        if let prefix = CommandLine.arguments.dropFirst().first { try render(host, to: prefix + "-collapsed.png") }
        clickElement("grant-current-details", host: host, window: window)
        if let prefix = CommandLine.arguments.dropFirst().first { try render(host, to: prefix + "-details.png") }
        precondition(accessibleText(host).contains("Remaining") && accessibleText(host).contains("Expired"),
            "The existing grant summary must remain available on expansion")
        clickElement("grant-current-details", host: host, window: window)
        precondition(!accessibleText(host).contains("Remaining"),
            "Collapsing details must restore the compact form")
        clickElement("grant-back", host: host, window: window)
        precondition(backs == 1 && submissions.isEmpty)
        clickElement("grant-connection", host: host, window: window)
        precondition(connections == 1, "Connection required must retain its navigation action")
        clickElement("grant-create", host: host, window: window)
        settle(host)
        precondition(submissions.isEmpty, "Disabled connection must prevent grant writes")
        edit("grant-total", text: "2.123456", host: host, window: window)
        let connected = try overview(enabled: true)
        host.rootView = page(connected)
        settle(host)
        clickElement("grant-create", host: host, window: window)
        settle(host)
        precondition(submissions.count == 1 && submissions[0].0 == "2123456" && submissions[0].1 == "200000",
            "Connection refresh must preserve the draft and submit exact amounts")
        precondition(submissions[0].2 > Int64(Date.now.timeIntervalSince1970 * 1000))
        host.rootView = page(connected, saving: true)
        settle(host)
        clickElement("grant-back", host: host, window: window)
        clickElement("grant-create", host: host, window: window)
        settle(host)
        precondition(backs == 1 && submissions.count == 1, "Saving must block Back and duplicate writes")
        host.rootView = page(connected)
        settle(host)
        clickElement("grant-expiry-trigger", host: host, window: window)
        settle(host)
        precondition(scrollViews(host).count == 4 && host.frame.size == NSSize(width: 420, height: 526)
            && document.bounds.width <= scroll.contentView.bounds.width + 1,
            "Expanded picker must retain three native wheels inside the fixed narrow card")
        if let prefix = CommandLine.arguments.dropFirst().first { try render(host, to: prefix + "-page-expanded.png") }
        try expiryFixture(reduceMotion: false)
        try expiryFixture(reduceMotion: true)
        try postConfirmation()
        try resourceFormFixture()
        try perTransactionFixture()
        print("Spend Grant: exact submission, connection/saving guards, retained draft, narrow layout, inline wheel selection, keyboard adjustment, collapse/reopen and Reduce Motion passed")
    }

    @MainActor private static func resourceFormFixture() throws {
        // Enable SwiftUI's in-process accessibility tree for this fixture only.
        // AppKit exposes this switch through its legacy attribute entry point.
        NSApp.accessibilitySetValue(true, forAttribute: .init(rawValue: "AXEnhancedUserInterface"))
        let overview = try overview(enabled: true, mainnet: true)
        var submissions: [(String, String, Int64, String?, ResourceRequestSample?)] = []
        var preparations: [(String, ResourceRequestSample?)] = []
        var otherLimitOpens = 0
        let form = SpendGrantForm(overview: overview)
        func page(saving: Bool = false, entry: SpendGrantDetail.Entry = .spendGrant) -> some View {
            SpendGrantDetail(overview: overview, isSaving: saving, writeMessage: nil, writeFailed: false,
                onBack: {}, onConnection: {},
                onCreate: { total, single, expiry, resource, sample, _ in submissions.append((total, single, expiry, resource, sample)) },
                onRevoke: { _ in }, onPreparePost: { resource, sample in
                    preparations.append((resource, sample))
                    throw URLError(.cannotConnectToHost)
                }, entry: entry, form: form, onOtherLimit: { otherLimitOpens += 1 })
                .id(entry == .spendGrant ? "total" : "single")
                .frame(width: 420, height: 526).environment(\.colorScheme, .light)
        }
        let host = NSHostingView(rootView: page())
        let window = makeWindow(host, size: NSSize(width: 420, height: 526))
        defer { window.close() }
        settle(host)
        guard let scroll = scrollViews(host).first, let document = scroll.documentView else { fatalError("Missing Resource form scroll view") }
        precondition(CardMetrics.cardSize == CGSize(width: 420, height: 684) && CardMetrics.windowSize == CardMetrics.cardSize)
        precondition(element("grant-api-details", in: host) == nil, "API details require a selected Resource")
        chooseResource(overview.service.registeredResources![0], host: host, window: window)
        precondition(element("grant-api-details", in: host) != nil)
        precondition(!textValues(host).contains("Endpoint") && !textValues(host).contains("Input policy"), "Technical information must be collapsed by default")
        precondition(element("grant-sample-query", in: host) != nil && element("grant-sample-body", in: host) == nil)
        precondition((element("grant-sample-query", in: host)?.value(forKey: "accessibilityValue") as? String)?.contains("seed") == true)
        let collapsedHeight = document.bounds.height
        precondition(document.bounds.width <= scroll.contentView.bounds.width + 1, "Long API names must fit the narrow form")
        edit("grant-sample-query", text: #"{"prompt":"edited query"}"#, host: host, window: window)
        clickElement("grant-api-details", host: host, window: window)
        precondition(textValues(host).contains("Endpoint") && textValues(host).contains("Input policy") && textValues(host).contains("Unconfirmed"),
            "Native disclosure must expose the existing technical information")
        precondition(document.bounds.height > collapsedHeight && document.bounds.width <= scroll.contentView.bounds.width + 1,
            "Details must expand vertically and wrap long URLs and policy JSON")
        clickElement("grant-api-details", host: host, window: window)
        precondition(!textValues(host).contains("Endpoint") && abs(document.bounds.height - collapsedHeight) < 1)
        precondition((element("grant-sample-query", in: host)?.value(forKey: "accessibilityValue") as? String)?.contains("edited query") == true,
            "Disclosure must preserve the edited sample request")
        precondition(element("grant-total", in: host) != nil && element("grant-per-transaction", in: host) == nil,
            "The main grant page must not expose a second amount input")
        edit("grant-total", text: "0.20", host: host, window: window)
        precondition(!isEnabled("grant-create", in: host) && element("grant-other-limit", in: host) != nil,
            "A new grant cannot submit an invented hidden per-transaction limit")
        clickElement("grant-other-limit", host: host, window: window)
        precondition(otherLimitOpens == 1 && submissions.isEmpty, "The missing-limit action must only navigate")
        host.rootView = page(entry: .perTransaction); settle(host)
        precondition(element("grant-total", in: host) == nil && element("grant-per-transaction", in: host) != nil
            && form.draft.total == "0.20"
            && (element("grant-sample-query", in: host)?.value(forKey: "accessibilityValue") as? String)?.contains("edited query") == true,
            "The other entry must retain the total, selected API and sample in the shared local form")
        edit("grant-per-transaction", text: "0.30", host: host, window: window)
        clickElement("grant-create", host: host, window: window)
        precondition(submissions.isEmpty && textValues(host).contains("Per transaction must fit within total authorized."))
        edit("grant-per-transaction", text: "0.10", host: host, window: window)
        edit("grant-sample-query", text: "invalid JSON", host: host, window: window)
        clickElement("grant-create", host: host, window: window)
        precondition(submissions.isEmpty && textValues(host).contains("Enter valid JSON objects for the sample request."))
        edit("grant-sample-query", text: #"{"prompt":"edited query"}"#, host: host, window: window)
        clickElement("grant-create", host: host, window: window)
        precondition(submissions.count == 1 && submissions[0].0 == "200000" && submissions[0].1 == "100000"
            && submissions[0].3 == "fixture-get" && submissions[0].4?.query?["prompt"] == "edited query")
        let expiry = submissions[0].2
        host.rootView = page(saving: true, entry: .perTransaction); settle(host)
        clickElement("grant-create", host: host, window: window)
        precondition(submissions.count == 1, "Saving must prevent duplicate fixture submissions")
        host.rootView = page(entry: .perTransaction); settle(host)
        clickElement("grant-api-details", host: host, window: window)
        chooseResource(overview.service.registeredResources![1], host: host, window: window)
        precondition(!textValues(host).contains("Endpoint"), "Changing API must collapse its details")
        precondition(element("grant-sample-query", in: host) != nil && element("grant-sample-body", in: host) != nil)
        edit("grant-sample-query", text: #"{"region":"global"}"#, host: host, window: window)
        edit("grant-sample-body", text: #"{"prompt":"edited body","count":2}"#, host: host, window: window)
        clickElement("grant-create", host: host, window: window)
        precondition(preparations.count == 1 && preparations[0].0 == "fixture-post"
            && preparations[0].1?.query?["region"] == "global" && preparations[0].1?.bodyText.contains("edited body") == true)
        precondition(submissions.count == 1 && textValues(host).contains("The POST request could not be prepared safely."),
            "POST preparation failure must preserve explicit approval and error behavior")
        chooseResource(overview.service.registeredResources![0], host: host, window: window)
        clickElement("grant-create", host: host, window: window)
        precondition(submissions.count == 2 && submissions[1].2 == expiry && submissions[1].4?.query?["prompt"] == "seed",
            "API switching must retain amounts/expiry and restore each registered sample")
        precondition(host.frame.size == NSSize(width: 420, height: 526) && document.bounds.width <= scroll.contentView.bounds.width + 1)
        print("Create Spend Grant native fixture: API selection, default collapse, details/reflow, long names/URLs, GET/POST samples, validation, saving guards and exact callback inputs passed")
    }

    @MainActor private static func perTransactionFixture() throws {
        let overview = try overview(enabled: true, status: "ACTIVE", mainnet: true, boundGrant: true)
        let resource = overview.service.registeredResources!.first { $0.resourceId == "fixture-get" }!
        precondition(overview.service.registeredResources!.first?.resourceId != resource.resourceId,
            "The fixture must distinguish the bound resource from an arbitrary first API")
        var submissions: [(String, String, Int64, String?, ResourceRequestSample?)] = []
        var otherLimitOpens = 0
        let form = SpendGrantForm(overview: overview)
        func page(saving: Bool = false, entry: SpendGrantDetail.Entry = .perTransaction) -> some View {
            SpendGrantDetail(overview: overview, isSaving: saving, writeMessage: nil, writeFailed: false,
                onBack: {}, onConnection: {},
                onCreate: { total, single, expiry, resource, sample, _ in submissions.append((total, single, expiry, resource, sample)) },
                onRevoke: { _ in }, entry: entry, form: form, onOtherLimit: { otherLimitOpens += 1 })
                .id(entry == .spendGrant ? "total" : "single")
                .frame(width: 420, height: 526).environment(\.colorScheme, .light)
        }
        let host = NSHostingView(rootView: page())
        let window = makeWindow(host, size: NSSize(width: 420, height: 526))
        defer { window.close() }
        settle(host)
        precondition(accessibleText(host).contains("Per Transaction") && !accessibleText(host).contains("Spend Grant"),
            "The single-limit entry must have its own secondary page title")
        precondition(accessibleText(host).contains("Replace Grant") && submissions.isEmpty,
            "Opening this entry must not create a cap or silently replace the existing API-bound grant")
        let expectedResourceTitle = (resource.name ?? resource.resourceId) + " · Agent-submitted"
        precondition(element("grant-resource", in: host)?.value(forKey: "accessibilityValue") as? String == expectedResourceTitle,
            "Only the registered resource bound to the current grant may be preselected")
        precondition((element("grant-sample-query", in: host)?.value(forKey: "accessibilityValue") as? String)?.contains("seed") == true,
            "Preselection must retain the registered sample request")
        precondition(element("grant-per-transaction", in: host)?.value(forKey: "accessibilityValue") as? String == "0.20"
            && element("grant-total", in: host) == nil && form.draft.total == "0.20",
            "Only the single-limit input is visible, while the existing grant total stays intact")
        if let prefix = CommandLine.arguments.dropFirst().first { try render(host, to: prefix + "-per-transaction-initial.png") }
        edit("grant-per-transaction", text: "0.30", host: host, window: window)
        clickElement("grant-create", host: host, window: window)
        precondition(submissions.isEmpty && textValues(host).contains("Per transaction must fit within total authorized."),
            "The independent entry must preserve the existing total-bound validation")
        edit("grant-per-transaction", text: "0.10", host: host, window: window)
        clickElement("grant-create", host: host, window: window)
        precondition(submissions.count == 1 && submissions[0].0 == "200000" && submissions[0].1 == "100000"
            && submissions[0].3 == resource.resourceId && submissions[0].4?.query?["prompt"] == "seed"
            && abs(submissions[0].2 - overview.scopedGrant!.expiresAt) <= 1,
            "Editing the single limit must use the same grant callback with total, expiry, resource and sample intact")
        if let prefix = CommandLine.arguments.dropFirst().first { try render(host, to: prefix + "-per-transaction.png") }
        host.rootView = page(entry: .spendGrant); settle(host)
        precondition(element("grant-per-transaction", in: host) == nil
            && element("grant-total", in: host)?.value(forKey: "accessibilityValue") as? String == "0.20"
            && form.draft.perTransaction == "0.10",
            "Switching to Spend Grant must show only total and preserve the edited single limit")
        edit("grant-total", text: "0.30", host: host, window: window)
        clickElement("grant-create", host: host, window: window)
        precondition(submissions.count == 2 && submissions[1].0 == "300000" && submissions[1].1 == "100000"
            && submissions[1].3 == resource.resourceId && abs(submissions[1].2 - overview.scopedGrant!.expiresAt) <= 1,
            "Saving either editor must preserve the counterpart, resource and expiry in the same grant callback")
        host.rootView = page(saving: true); settle(host)
        clickElement("grant-create", host: host, window: window)
        precondition(submissions.count == 2, "The independent entry must retain duplicate-submit protection")
        host.rootView = page(); settle(host)
        form.draft.total = ""; settle(host)
        precondition(!isEnabled("grant-create", in: host) && element("grant-other-limit", in: host) != nil,
            "A missing hidden total must not silently become a default grant allowance")
        clickElement("grant-other-limit", host: host, window: window)
        precondition(otherLimitOpens == 1 && submissions.count == 2,
            "Setting the missing total must navigate without authorizing a grant")
        print("Separate grant editors: one amount input per page, shared draft/API/sample/expiry, exact callback values and missing-counterpart/save guards passed")
    }

    @MainActor private static func accessibilityNodes(_ object: NSObject) -> [NSObject] {
        guard object.responds(to: NSSelectorFromString("accessibilityChildren")) else { return [object] }
        let children = object.value(forKey: "accessibilityChildren") as? [NSObject] ?? []
        return [object] + children.flatMap(accessibilityNodes)
    }
    @MainActor private static func element(_ identifier: String, in host: NSView) -> NSObject? {
        let matches = accessibilityNodes(host).filter { $0.responds(to: NSSelectorFromString("accessibilityIdentifier"))
            && $0.value(forKey: "accessibilityIdentifier") as? String == identifier }
        if identifier == "grant-api-details" || identifier == "grant-current-details" {
            return matches.first { $0.value(forKey: "accessibilityRole") as? String == "AXDisclosureTriangle" }
        }
        return matches.first
    }
    @MainActor private static func isEnabled(_ identifier: String, in host: NSView) -> Bool {
        guard let node = element(identifier, in: host), let value = node.value(forKey: "accessibilityEnabled") as? Bool else {
            fatalError("Missing native enabled state: \(identifier)")
        }
        return value
    }
    @MainActor private static func accessibleText(_ host: NSView) -> String {
        accessibilityNodes(host).flatMap { node in
            ["accessibilityLabel", "accessibilityValue"].compactMap { attribute in
                node.responds(to: NSSelectorFromString(attribute)) ? node.value(forKey: attribute) as? String : nil
            }
        }.joined(separator: " ")
    }
    @MainActor private static func textValues(_ host: NSView) -> [String] {
        accessibilityNodes(host).compactMap { node in
            guard node.responds(to: NSSelectorFromString("accessibilityValue")) else { return nil }
            return node.value(forKey: "accessibilityValue") as? String
        }
    }
    @MainActor private static func clickElement(_ identifier: String, host: NSView, window: NSWindow) {
        guard let node = element(identifier, in: host), let value = node.value(forKey: "accessibilityFrame") as? NSValue else {
            fatalError("Missing native control: \(identifier)")
        }
        if identifier == "grant-api-details" || identifier == "grant-current-details" {
            let control: AnyObject = node
            precondition(control.accessibilityPerformPress?() == true, "Native disclosure action must remain accessible")
            settle(host)
            return
        }
        if let scroll = scrollViews(host).first, let document = scroll.documentView {
            document.scrollToVisible(document.convert(window.convertFromScreen(value.rectValue), from: nil))
            settle(host)
        }
        guard let currentFrame = node.value(forKey: "accessibilityFrame") as? NSValue else { fatalError("Control frame unavailable") }
        let frame = currentFrame.rectValue
        click(window, at: window.convertPoint(fromScreen: NSPoint(x: frame.midX, y: frame.midY)))
        settle(host)
    }
    @MainActor private static func edit(_ identifier: String, text: String, host: NSView, window: NSWindow) {
        clickElement(identifier, host: host, window: window)
        guard let editor = window.firstResponder as? NSTextView else { fatalError("Missing native editor: \(identifier)") }
        editor.selectAll(nil); editor.insertText(text, replacementRange: editor.selectedRange()); settle(host)
    }
    @MainActor private static func chooseResource(_ resource: AppOverview.Service.RegisteredResource, host: NSView, window: NSWindow) {
        let title = (resource.name ?? resource.resourceId) + (resource.source == "agent" ? " · Agent-submitted" : "")
        let selection = ResourceMenuSelection(title)
        NotificationCenter.default.addObserver(selection, selector: #selector(ResourceMenuSelection.select(_:)), name: NSMenu.didBeginTrackingNotification, object: nil)
        defer { NotificationCenter.default.removeObserver(selection) }
        clickElement("grant-resource", host: host, window: window)
        precondition(element("grant-resource", in: host)?.value(forKey: "accessibilityValue") as? String == title)
    }

    @MainActor private static func expiryFixture(reduceMotion: Bool) throws {
        var calendar = Calendar.current
        calendar.timeZone = .current
        let day = calendar.date(byAdding: .day, value: 1, to: .now)!
        let initial = calendar.date(bySettingHour: 6, minute: 59, second: 0, of: day)!
        let probe = ExpiryProbe(initial)
        let binding = Binding(get: { probe.selection }, set: { probe.selection = $0 })
        let host = NSHostingView(rootView: VStack(spacing: 0) {
            SpendGrantExpiryPicker(selection: binding, reduceMotion: reduceMotion)
            Spacer(minLength: 0)
        }.frame(width: 368, height: 190).background(Color(red: 0.95, green: 0.97, blue: 0.985))
            .environment(\.colorScheme, .light))
        let window = makeWindow(host, size: NSSize(width: 368, height: 190))
        defer { window.close() }
        settle(host)
        click(window, at: NSPoint(x: 180, y: 169))
        settle(host)
        precondition(scrollViews(host).count == 3, "Expires must expand three native inline wheels")
        precondition(probe.selection == initial, "Opening the wheel must not change the selected date/time")
        if let prefix = CommandLine.arguments.dropFirst().first, !reduceMotion { try render(host, to: prefix + "-wheel.png") }
        click(window, at: NSPoint(x: 231, y: 87))
        key(window, code: 125, characters: "\u{F701}")
        settle(host)
        precondition(calendar.component(.hour, from: probe.selection) == 7 && calendar.component(.minute, from: probe.selection) == 59,
            "Hour keyboard input must preserve day/minute")
        click(window, at: NSPoint(x: 316, y: 87))
        key(window, code: 126, characters: "\u{F700}")
        settle(host)
        precondition(calendar.component(.hour, from: probe.selection) == 7 && calendar.component(.minute, from: probe.selection) == 58,
            "Minute keyboard input must preserve day/hour: \(probe.selection.formatted(date: .complete, time: .complete))")
        let edited = probe.selection
        if let prefix = CommandLine.arguments.dropFirst().first, !reduceMotion { try render(host, to: prefix + "-edited-wheel.png") }
        click(window, at: NSPoint(x: 180, y: 169))
        settle(host)
        if let prefix = CommandLine.arguments.dropFirst().first, !reduceMotion { try render(host, to: prefix + "-after-collapse.png") }
        click(window, at: NSPoint(x: 231, y: 87))
        key(window, code: 125, characters: "\u{F701}")
        settle(host)
        precondition(probe.selection == edited, "Collapsed wheels must stop receiving pointer and keyboard input")
        click(window, at: NSPoint(x: 180, y: 169))
        settle(host)
        precondition(probe.selection == edited, "Collapse/reopen must retain the edited expiry")
        for wheel in scrollViews(host) {
            precondition(abs(wheel.bounds.height - 90) < 1 && wheel.documentView!.bounds.width <= wheel.bounds.width + 1)
        }
    }

    @MainActor private static func postConfirmation() throws {
        let review = try JSONDecoder().decode(PostRequestReview.self, from: Data(#"{"request":{"url":"https://unknown.example/analyze?fixed=yes","method":"POST","access":"https","headers":{"content-type":"application/json"},"body":"{\"prompt\":\"sample\"}"},"requestHash":"fixture-concrete-request","requestInputs":{"jsonBody":{"prompt":{"type":"string","required":true,"maxLength":300}}},"paymentSent":false}"#.utf8))
        for grant in [false, true] {
            var approvals = 0, cancellations = 0
            let host = NSHostingView(rootView: PostRequestApprovalView(review: review,
                grantSummary: grant ? "Resource: fixture · Total: 0.002 USDC" : nil,
                onApprove: { approvals += 1 }, onCancel: { cancellations += 1 }))
            let window = makeWindow(host, size: NSSize(width: 360, height: 480))
            settle(host)
            precondition(approvals == 0 && cancellations == 0, "Showing a review must not authorize a POST")
            click(window, at: NSPoint(x: 52, y: 34)); settle(host)
            precondition(cancellations == 1 && approvals == 0, "Cancel must not authorize any request")
            click(window, at: NSPoint(x: 274, y: 34)); settle(host)
            precondition(approvals == 1, "Only the explicit native approval button authorizes a POST")
            window.close()
        }
        print("Native POST confirmation: no implicit approval, cancel and explicit discovery/Grant buttons passed")
    }

    private static func overview(enabled: Bool, status: String = "EXPIRED", mainnet: Bool = false, boundGrant: Bool = false) throws -> AppOverview {
        var payload: [String: Any] = [
            "service": ["status": "running", "purchaseMode": "simulated", "network": "Solana Devnet"],
            "wallet": ["address": "FixturePublicAddress"],
            "budget": ["dailyLimit": "1000000", "dailyLimitDisplay": "Fixture limit", "paid": "0", "reserved": "0",
                "remaining": "1000000", "remainingDisplay": "Fixture remaining", "paused": false],
            "grant": ["id": "fixture-grant", "status": status, "totalLimit": "200000", "singleLimit": "200000",
                "remaining": "170000", "assetDecimals": 6, "expiresAt": Int64(Date.now.addingTimeInterval(status == "EXPIRED" ? -3600 : 3600).timeIntervalSince1970 * 1000)],
            "connection": ["enabled": enabled, "lastSeen": NSNull(), "access": "purchase_intent"], "purchases": [],
        ]
        if mainnet {
            let resources: [[String: Any]] = ["GET", "POST"].map { method in
                let isPost = method == "POST"
                return ["resourceId": isPost ? "fixture-post" : "fixture-get", "providerId": "fixture.example",
                    "name": isPost ? "Fixture analysis" : String(repeating: "Research search ", count: 6),
                    "url": "https://fixture.example/" + String(repeating: "endpoint", count: 100), "method": method,
                    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "assetId": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "assetDecimals": 6,
                    "maximumPriceDisplay": "0.003 USDC", "source": "agent",
                    "requestInputs": isPost ? ["query": ["region"], "jsonBody": ["prompt", "count"]] : ["query": ["prompt"]],
                    "submission": ["cardMemberId": "fixture-agent", "discoveryId": "fixture-discovery", "discoveredAt": 1,
                        "sample": isPost ? ["query": ["region": "seed"], "jsonBody": ["prompt": "seed", "count": 1]] : ["query": ["prompt": "seed"]],
                        "documentation": ["urls": ["https://fixture.example/" + String(repeating: "documentation", count: 50)],
                            "uncertainties": [String(repeating: "Fixture unconfirmed merchant note. ", count: 8)]]]]
            }
            payload["service"] = ["status": "running", "purchaseMode": "live_mainnet", "network": "Solana Mainnet",
                "registeredResources": boundGrant ? Array(resources.reversed()) : resources]
            if boundGrant {
                let network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
                let asset = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                guard var grant = payload["grant"] as? [String: Any] else { fatalError("Missing fixture grant") }
                grant["resourceId"] = "fixture-get"
                grant["network"] = network
                grant["assetId"] = asset
                payload["grant"] = grant
                payload["grants"] = [grant]
                payload["authority"] = [
                    "mode": "live_mainnet", "network": network, "assetId": asset, "assetDecimals": 6, "assetLabel": "USDC",
                    "dailyLimit": "1000000", "available": "1000000", "reserved": "0", "paid": "0",
                    "availableDisplay": "1.00", "reservedDisplay": "0.00", "paidDisplay": "0.00",
                    "dailyLimitDisplay": "of 1.00 USDC daily", "dailyState": "active", "blockers": [],
                    "wallet": ["address": "FixturePublicAddress", "network": "Solana Mainnet", "status": "available"],
                    "grant": ["id": "fixture-grant", "resourceId": "fixture-get", "api": resources[0]["url"]!,
                        "network": network, "assetLabel": "USDC", "totalDisplay": "0.20", "remainingDisplay": "0.17",
                        "committedDisplay": "0.03", "singleDisplay": "0.20", "status": status,
                        "expiresAt": grant["expiresAt"]!, "usable": status == "ACTIVE"],
                ]
            }
        }
        return try JSONDecoder().decode(AppOverview.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    @MainActor private static func makeWindow(_ host: NSView, size: NSSize) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.alphaValue = 0
        window.orderFront(nil)
        return window
    }
    @MainActor private static func settle(_ host: NSView) {
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: .now.addingTimeInterval(0.35))
    }
    @MainActor private static func scrollViews(_ view: NSView) -> [NSScrollView] {
        (view as? NSScrollView).map { [$0] + view.subviews.flatMap(scrollViews) } ?? view.subviews.flatMap(scrollViews)
    }
    @MainActor private static func click(_ window: NSWindow, at point: NSPoint) {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            window.sendEvent(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!)
        }
    }
    @MainActor private static func key(_ window: NSWindow, code: UInt16, characters: String) {
        window.sendEvent(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!)
    }
    @MainActor private static func render(_ host: NSView, to path: String) throws {
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("Fixture rendering unavailable") }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try bitmap.representation(using: .png, properties: [:])?.write(to: URL(filePath: path))
    }
}
