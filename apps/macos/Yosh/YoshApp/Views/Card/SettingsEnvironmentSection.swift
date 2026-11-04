import SwiftUI

struct SettingsEnvironmentSection: View {
    let development: PayDevelopmentSelection?
    let isSwitching: Bool
    let onSelect: (PayDevelopmentMode) -> Void
    let onSaveRPC: (String) -> Void

    @State private var showsRPCDetails = false
    @State private var rpcDraft = ""

    private var selectedRPC: String {
        development?.environment == .devnet ? development?.devnetRPC ?? "https://api.devnet.solana.com"
            : development?.rpcUrl ?? PayDevelopmentSelection.offline.rpcUrl
    }

    private var supportsRPC: Bool {
        development?.environment == .mainnet || development?.environment == .devnet
    }

    private var description: String {
        switch development?.environment {
        case .mainnet: "Real funds. Each payment needs authorization."
        case .devnet: "Test assets only."
        case .simulated: "Simulation. No signing or transactions."
        case .offline: "Local testing. No real funds."
        case nil: "Checking environment…"
        }
    }

    var body: some View {
        SettingsSection(title: "ENVIRONMENT", symbol: "globe", symbolSize: 22) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Network").foregroundStyle(YoshShellPalette.ink)
                    Spacer(minLength: 8)
                    Menu(development?.environment.title ?? "Checking…") {
                        Button("Simulation") { onSelect(.simulated) }
                        Button("Solana Devnet") { onSelect(.devnet) }
                        if development?.environment == .offline {
                            Button("Offline") { onSelect(.offline) }
                        }
                        Button("Solana Mainnet…") { onSelect(.mainnet) }
                    }
                    .disabled(isSwitching || development == nil)
                    .accessibilityIdentifier("settings.environment")
                }
                .font(.system(size: 15))

                Text(isSwitching ? "Safely reconnecting…" : description)
                    .font(.system(size: 12))
                    .foregroundStyle(YoshShellPalette.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)

                if supportsRPC {
                    Rectangle().fill(YoshShellPalette.rule).frame(height: 1).accessibilityHidden(true)
                    DisclosureGroup("RPC connection", isExpanded: $showsRPCDetails) {
                        VStack(alignment: .leading, spacing: 12) {
                            TextField("RPC URL", text: $rpcDraft)
                                .textFieldStyle(.roundedBorder)
                                .accessibilityIdentifier("settings.mainnet-rpc")
                            Button("Save and reconnect") { onSaveRPC(rpcDraft) }
                                .buttonStyle(.bordered)
                                .disabled(isSwitching || rpcDraft == selectedRPC)
                                .accessibilityIdentifier("settings.rpc.save")
                            Text("Reconnect Pay MCP in Codex after saving. Wallets and records stay separate between environments.")
                                .font(.system(size: 12))
                                .foregroundStyle(YoshShellPalette.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 12)
                    }
                    .font(.system(size: 13))
                    .foregroundStyle(YoshShellPalette.ink)
                }
            }
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear { rpcDraft = selectedRPC }
        .onChange(of: development) { _, _ in
            rpcDraft = selectedRPC
            showsRPCDetails = false
        }
    }
}
