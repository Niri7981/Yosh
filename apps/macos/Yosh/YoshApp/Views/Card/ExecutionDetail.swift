import SwiftUI

struct ExecutionDetail: View {
    let environment: ExecutionEnvironment?
    let isSaving: Bool
    let message: String?
    let messageFailed: Bool
    let onBack: () -> Void
    let onSelect: (AppOverview.Service.PurchaseMode) async -> Void
    let onProductionExecution: (Bool) async -> Void

    @State private var showingEnableConfirmation = false
    @State private var showingMainnetSelection = false

    private let ink = YoshShellPalette.ink
    private let secondaryInk = YoshShellPalette.secondaryInk
    private let rule = YoshShellPalette.rule

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                Button(action: onBack) {
                    Label("Authority", systemImage: "chevron.left")
                        .font(.system(size: 13))
                        .frame(minHeight: 24, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(secondaryInk)
                .disabled(isSaving)
                .accessibilityLabel("Back to Authority")

                Text("Execution")
                    .font(.system(size: 44, weight: .regular, design: .serif))
                    .tracking(-1.2)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, 12)
                Text("Choose the environment for purchases allowed by policy.")
                    .font(.system(size: 13))
                    .foregroundStyle(secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
                    .padding(.bottom, 24)

                ForEach(AppOverview.Service.PurchaseMode.allCases, id: \.self) { mode in
                    hairline
                    Button {
                        guard environment?.mode != mode else { return }
                        if mode == .liveMainnet { showingMainnetSelection = true }
                        else { Task { await onSelect(mode) } }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(mode.title).font(.system(size: 15, weight: .medium))
                                Text(description(mode))
                                    .font(.system(size: 12))
                                    .foregroundStyle(secondaryInk)
                                if mode == .liveMainnet, let status = environment?.mainnetStatus {
                                    Text(status)
                                        .font(.system(size: 11))
                                        .foregroundStyle(secondaryInk)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .padding(.top, 3)
                                }
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "checkmark")
                                .font(.system(size: 12, weight: .medium))
                                .opacity(environment?.mode == mode ? 1 : 0)
                                .accessibilityHidden(true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 17)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isSaving || environment == nil)
                    .accessibilityAddTraits(environment?.mode == mode ? .isSelected : [])
                    .accessibilityLabel(mode.title)
                    .accessibilityValue(environment?.mode == mode ? "Selected" : "Not selected")
                    .accessibilityHint(description(mode))
                }
                hairline
                if let environment, environment.mode == .liveMainnet {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Mainnet execution")
                                .font(.system(size: 15, weight: .medium))
                            Text("Allow eligible Agents to make real payments within your Daily Authority and Spend Grants.")
                                .font(.system(size: 12))
                                .foregroundStyle(secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                        Toggle("Mainnet execution", isOn: Binding(
                            get: { environment.productionExecutionEnabled },
                            set: { enabled in
                                if enabled { showingEnableConfirmation = true }
                                else { Task { await onProductionExecution(false) } }
                            }
                        ))
                        .labelsHidden()
                        .disabled(isSaving)
                    }
                    .padding(.vertical, 17)
                    hairline
                }
                if let environment {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(environment.mode.title) · \(environment.network)")
                        Text("\(environment.assetLabel ?? "Asset not verified") · \(environment.asset.decimals) decimals")
                        Text(environment.asset.mint).textSelection(.enabled)
                    }
                    .font(.system(size: 10))
                    .foregroundStyle(secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 18)
                }
                if isSaving {
                    Text("Saving…").font(.system(size: 12)).foregroundStyle(secondaryInk).padding(.top, 14)
                } else if let message {
                    Text(message).font(.system(size: 12))
                        .foregroundStyle(messageFailed ? .red : secondaryInk)
                        .padding(.top, 14)
                } else if environment == nil {
                    Text("Execution environment unavailable")
                        .font(.system(size: 12)).foregroundStyle(secondaryInk).padding(.top, 14)
                }
            }
            .padding(.horizontal, 26)
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(ink)
        .confirmationDialog("Use Solana Mainnet?", isPresented: $showingMainnetSelection, titleVisibility: .visible) {
            Button("Use Mainnet") { Task { await onSelect(.liveMainnet) } }
                .accessibilityIdentifier("execution-select-mainnet-confirm")
            Button("Cancel", role: .cancel) { }
                .accessibilityIdentifier("execution-select-mainnet-cancel")
        } message: {
            Text("Mainnet uses real SOL and USDC. Its existing wallet, authority and payment settings stay separate from Devnet and Simulation.")
        }
        .confirmationDialog("Enable real Mainnet payments?", isPresented: $showingEnableConfirmation,
            titleVisibility: .visible) {
            Button("Enable Mainnet execution") { Task { await onProductionExecution(true) } }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Agents still need an active connection, Daily Authority, a registered API and a matching Spend Grant. Each purchase is checked before signing.")
        }
    }

    private var hairline: some View {
        Rectangle().fill(rule).frame(height: 1).accessibilityHidden(true)
    }

    private func description(_ mode: AppOverview.Service.PurchaseMode) -> String {
        switch mode {
        case .simulated: "No transaction is submitted."
        case .liveDevnet: "Developer testing with Test assets on Solana Devnet."
        case .liveMainnet: "Production purchases on Solana Mainnet."
        }
    }
}
