import AppKit
import SwiftUI

/// Offscreen native controls only. No product runtime, wallet, service or user UI.
@main
@MainActor
struct SpendGrantRefreshTest {
    private struct RegistryProjection: Decodable { let resource: RegisteredAPI }
    static func main() throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let payload = #"""
        {"service":{"status":"running","purchaseMode":"live_mainnet","network":"Solana Mainnet"},
         "wallet":{"address":"FixturePublicAddress"},
         "budget":{"dailyLimit":"1000000","dailyLimitDisplay":"1 USDC","paid":"0","reserved":"0","remaining":"1000000","remainingDisplay":"1 USDC","paused":true},
         "connection":{"enabled":true,"lastSeen":null,"access":"purchase_intent"},"purchases":[]}
        """#
        let overview = try JSONDecoder().decode(AppOverview.self, from: Data(payload.utf8))
        func editor(refreshing: Bool, saving: Bool = false) -> SpendGrantDetail {
            SpendGrantDetail(overview: overview, isSaving: saving, isRefreshing: refreshing,
                writeMessage: nil, writeFailed: false, onBack: {}, onConnection: {},
                onCreate: { _, _, _, _, _, _ in }, onRevoke: { _ in })
        }
        let host = NSHostingView(rootView: editor(refreshing: false))
        host.frame = NSRect(x: 0, y: 0, width: 420, height: 1000)
        func fields(_ view: NSView) -> [NSTextField] {
            (view as? NSTextField).map { [$0] } ?? view.subviews.flatMap(fields)
        }
        func settle() {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }
        settle()
        let initial = fields(host).filter { $0.isEditable }
        precondition(initial.count >= 2 && initial.allSatisfy(\.isEnabled), "Grant inputs must start editable")
        for _ in 0..<3 {
            host.rootView = editor(refreshing: true); settle()
            let editing = fields(host).filter { $0.isEditable }
            precondition(editing.count >= 2 && editing.allSatisfy(\.isEnabled), "READ_REFRESH_DISABLED_GRANT_EDITOR: polling must not reset focus or wheel interaction")
            host.rootView = editor(refreshing: false); settle()
        }
        host.rootView = editor(refreshing: false, saving: true); settle()
        let savingFields = fields(host).filter { $0.isEditable }
        precondition(savingFields.count >= 2 && savingFields.allSatisfy { !$0.isEnabled }, "Actual Grant writes must still lock the editor")
        print("Native Grant controls remain enabled across read refreshes and disabled during actual writes.")
        if CommandLine.arguments.count == 2 {
            let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
            let api = try JSONDecoder().decode(RegistryProjection.self, from: data).resource
            let actual = try JSONDecoder().decode(AppOverview.self, from: data)
            precondition(api.resourceId == "agent402-crypto-price" && api.sourceLabel == "Agent-submitted")
            let choice = actual.service.registeredResources?.first { $0.resourceId == api.resourceId }
            precondition(choice?.source == "agent" && choice?.requestInputs?.query?.names == ["coins", "currency"])
            precondition(choice?.submission?.sample.queryText == api.submission?.sample.queryText)
            print("Installed API list and Grant picker decode the same Agent402 definition and sample.")
        }
    }
}
