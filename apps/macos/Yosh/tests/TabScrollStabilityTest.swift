import AppKit
import SwiftUI

@MainActor @Observable
private final class ScrollProbe {
    var selection: BackSection = .members
    var visited: Set<BackSection> = [.members]
    var membersLoading = false

    func select(_ section: BackSection) {
        visited.insert(section)
        selection = section
    }
}

private struct ScrollFixture: View {
    let probe: ScrollProbe
    let roster: MembersRosterPresentation
    let memberID: UUID
    let reduceMotion: Bool

    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: 66)
            ZStack {
                ForEach(BackSection.allCases, id: \.self) { section in
                    Group {
                        if probe.visited.contains(section) {
                            switch section {
                            case .members:
                                MembersRoster(presentation: roster, selectedMemberID: memberID, isLoading: probe.membersLoading,
                                    interactionsDisabled: probe.membersLoading, error: nil, onSelect: { _ in }, onConnect: { _ in },
                                    onAdd: {}, onRetry: {})
                                    .padding(.horizontal, CardPageHeader.Layout.contentInset)
                                    .padding(.top, CardPageHeader.Layout.topSpacing).padding(.bottom, 12)
                            case .settings:
                                CardSettingsBody(information: nil, appVersion: "Fixture", isLoading: false, error: nil,
                                    onCopyWallet: { _ in }, onOpenDataFolder: { _ in }, onOpenRepository: {}, onReload: {}, showsAdvanced: true)
                            case .connection, .authority:
                                Text(section.title).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            }
                        }
                    }
                    .modifier(YoshTabSurface(section: section, selection: probe.selection, reduceMotion: reduceMotion))
                }
            }
            .frame(height: 526).clipped()
            BackNavigation(selection: Binding(get: { probe.selection }, set: probe.select))
                .padding(.horizontal, 20).padding(.bottom, 16)
        }
        .frame(width: 420, height: 684)
        .background(Color(red: 0.95, green: 0.97, blue: 0.985))
        .environment(\.colorScheme, .light)
    }
}

/// Real Members/Settings scroll views inside the production tab surface; no backend or Keychain.
@main
struct TabScrollStabilityTest {
    @MainActor static func main() throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let id = UUID()
        let payload: [String: Any] = [
            "member": ["id": id.uuidString, "label": "Codex", "status": "ACTIVE", "isDefault": true,
                "createdAt": 1, "updatedAt": 1],
            "connection": ["enabled": false, "lastSeen": NSNull(), "access": "read_only"],
        ]
        let member = try JSONDecoder().decode(CardMemberSummary.self, from: JSONSerialization.data(withJSONObject: payload))
        for reduceMotion in [false, true] {
            try validate(roster: MembersRosterPresentation([member]), memberID: id, reduceMotion: reduceMotion)
        }
        print("Tab scroll stability: Members/Settings stay at the top without scroll input, retain deliberate scrolling, and keep fixed viewport geometry under normal and reduced motion")
    }

    @MainActor private static func validate(roster: MembersRosterPresentation, memberID: UUID, reduceMotion: Bool) throws {
        let probe = ScrollProbe()
        let host = NSHostingView(rootView: ScrollFixture(probe: probe, roster: roster, memberID: memberID, reduceMotion: reduceMotion))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 684),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.alphaValue = 0
        window.orderFront(nil)
        defer { window.close() }
        pause(0.4)
        guard let members = scrollViews(in: host).first else { throw Failure("Missing Members scroll view") }
        let membersFrame = members.convert(members.bounds, to: host)
        let initialMembersY = members.contentView.bounds.origin.y
        try require(abs(initialMembersY) < 0.5, "Members must initially show SET UP from the top")

        press(.settings, probe: probe, window: window)
        // Let the first lazy surface finish its spring before recording canonical geometry.
        pause(0.8)
        guard let settings = scrollViews(in: host).first(where: { $0 !== members }) else { throw Failure("Missing Settings scroll view") }
        let settingsFrame = settings.convert(settings.bounds, to: host)
        let initialSettingsY = settings.contentView.bounds.origin.y
        try require(abs(initialSettingsY) < 0.5, "Settings Advanced must initially show its controls from the top, offset=\(initialSettingsY)")

        for destination in [BackSection.members, .connection, .authority, .settings, .members, .settings, .members] {
            press(destination, probe: probe, window: window)
            if destination == .members {
                // Returning Members performs an existing refresh: its loading label temporarily
                // changes the scroll viewport height, independently of the tab transform.
                probe.membersLoading = true
                pause(0.06)
                probe.membersLoading = false
            }
            pause(0.4)
            let membersY = members.contentView.bounds.origin.y
            let settingsY = settings.contentView.bounds.origin.y
            try require(abs(membersY - initialMembersY) < 0.5 && abs(settingsY - initialSettingsY) < 0.5,
                "Tab switching without scroll input must not move either scroll position: Members=\(membersY), Settings=\(settingsY)")
            if destination == .members {
                let frame = members.convert(members.bounds, to: host)
                try require(sameLayout(frame, membersFrame), "Members viewport must return to its exact layout: \(frame), initial \(membersFrame)")
            } else if destination == .settings {
                let frame = settings.convert(settings.bounds, to: host)
                try require(sameLayout(frame, settingsFrame), "Settings viewport must return to its exact layout: \(frame), initial \(settingsFrame)")
            }
        }

        // Fixing automatic drift must not reset a position that the user deliberately chose.
        scroll(members, by: 150)
        pause(0.1)
        let chosen = members.contentView.bounds.origin.y
        try require(chosen > 100, "The fixture must actually scroll before testing retention")
        press(.settings, probe: probe, window: window)
        pause(0.4)
        press(.members, probe: probe, window: window)
        pause(0.4)
        try require(abs(members.contentView.bounds.origin.y - chosen) < 0.5, "Switching tabs must retain deliberate Members scrolling")

        press(.settings, probe: probe, window: window)
        pause(0.4)
        scroll(settings, by: 170)
        pause(0.1)
        let chosenSettings = settings.contentView.bounds.origin.y
        try require(chosenSettings > 100, "The Settings fixture must actually scroll")
        for destination in [BackSection.connection, .members, .authority, .settings, .members, .settings] {
            press(destination, probe: probe, window: window)
            pause(0.025)
        }
        pause(0.4)
        try require(abs(settings.contentView.bounds.origin.y - chosenSettings) < 0.5,
            "Rapid tab switching must retain deliberate Settings scrolling")
        try require(abs(members.contentView.bounds.origin.y - chosen) < 0.5,
            "Rapid tab switching must not change the inactive Members scroll position")
    }

    @MainActor private static func press(_ section: BackSection, probe: ScrollProbe, window: NSWindow) {
        let point = NSPoint(x: 20 + CGFloat(section.rawValue) * 92.5 + 46.25, y: 54)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            window.sendEvent(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!)
        }
        precondition(probe.selection == section, "The real navigation must receive the tab press")
    }
    @MainActor private static func scrollViews(in view: NSView) -> [NSScrollView] {
        if let scroll = view as? NSScrollView { return [scroll] }
        return view.subviews.flatMap { scrollViews(in: $0) }
    }
    @MainActor private static func scroll(_ view: NSScrollView, by pixels: Int32) {
        // An invisible fixture has no reliable physical wheel target. Exercise retained
        // scroll state at the native boundary with a valid, deliberately chosen position.
        let origin = view.contentView.bounds.origin
        let maximum = max(0, (view.documentView?.bounds.height ?? 0) - view.contentView.bounds.height)
        view.contentView.scroll(to: NSPoint(x: origin.x, y: min(maximum, max(0, origin.y + CGFloat(pixels)))))
        view.reflectScrolledClipView(view.contentView)
    }
    @MainActor private static func pause(_ duration: TimeInterval) {
        RunLoop.current.run(until: .now.addingTimeInterval(duration))
    }
    private static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message) }
    }
    private static func sameLayout(_ actual: CGRect, _ expected: CGRect) -> Bool {
        // Native springs have a subpixel settling tail; the viewport must stay within 0.1 pt.
        abs(actual.minX - expected.minX) < 0.1 && abs(actual.minY - expected.minY) < 0.1
            && abs(actual.width - expected.width) < 0.1 && abs(actual.height - expected.height) < 0.1
    }
    private struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }
}
