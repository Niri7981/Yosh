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
    @State private var showingDetails = false

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
                .accessibilityIdentifier("execution-back")

                Text("Execution")
                    .font(.system(size: 34, weight: .regular, design: .serif))
                    .tracking(-0.8)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, 10)
                    .padding(.bottom, 18)
                hairline
                Text("ENVIRONMENT")
                    .font(.system(size: 9, weight: .medium))
                    .tracking(1.8)
                    .foregroundStyle(secondaryInk)
                    .padding(.top, 18)
                    .padding(.bottom, 6)

                ForEach(AppOverview.Service.PurchaseMode.allCases, id: \.self) { mode in
                    Button {
                        guard environment?.mode != mode else { return }
                        if mode == .liveMainnet { showingMainnetSelection = true }
                        else { Task { await onSelect(mode) } }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(mode.title).font(.system(size: 15, weight: .medium))
                                Text(shortDescription(mode))
                                    .font(.system(size: 11))
                                    .foregroundStyle(secondaryInk)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "checkmark")
                                .font(.system(size: 12, weight: .medium))
                                .opacity(environment?.mode == mode ? 1 : 0)
                                .accessibilityHidden(true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isSaving || environment == nil)
                    .accessibilityAddTraits(environment?.mode == mode ? .isSelected : [])
                    .accessibilityLabel(mode.title)
                    .accessibilityValue(environment?.mode == mode ? "Selected" : "Not selected")
                    .accessibilityHint(description(mode))
                    .accessibilityIdentifier("execution-mode-\(mode.rawValue)")
                }
                hairline
                if let environment, environment.mode == .liveMainnet {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Mainnet execution")
                                .font(.system(size: 15, weight: .medium))
                            Text("Within Daily Authority and Spend Grants")
                                .font(.system(size: 11))
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
                        .toggleStyle(.switch)
                        .tint(YoshShellPalette.activeInk)
                        .disabled(isSaving)
                        .accessibilityIdentifier("execution-mainnet-toggle")
                        .accessibilityHint("Real payments require an active connection, Daily Authority and a matching Spend Grant.")
                    }
                    .padding(.top, 16)
                    if let status = environment.mainnetStatus {
                        Text(status)
                            .font(.system(size: 11))
                            .foregroundStyle(secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("execution-mainnet-status")
                            .padding(.top, 8)
                    }
                }
                if let environment {
                    DisclosureGroup(isExpanded: $showingDetails) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(environment.mode.title) · \(environment.network)")
                            Text("\(environment.assetLabel ?? "Asset not verified") · \(environment.asset.decimals) decimals")
                            Text(environment.asset.mint).textSelection(.enabled)
                        }
                        .font(.system(size: 10))
                        .foregroundStyle(secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 8)
                        .accessibilityIdentifier("execution-details-content")
                    } label: {
                        Text("Network details").font(.system(size: 11)).foregroundStyle(secondaryInk)
                    }
                    .tint(secondaryInk)
                    .accessibilityIdentifier("execution-details")
                    .padding(.top, 20)
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
                .accessibilityIdentifier("execution-enable-confirm")
            Button("Cancel", role: .cancel) { }
                .accessibilityIdentifier("execution-enable-cancel")
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

    private func shortDescription(_ mode: AppOverview.Service.PurchaseMode) -> String {
        switch mode {
        case .simulated: "No transactions"
        case .liveDevnet: "Test assets"
        case .liveMainnet: "Real payments"
        }
    }
}
