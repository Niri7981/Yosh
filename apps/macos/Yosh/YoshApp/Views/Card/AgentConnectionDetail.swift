import SwiftUI

struct AgentConnectionDetail: View {
    let presentation: ConnectionPresentation
    let isSaving: Bool
    let writeMessage: String?
    let writeFailed: Bool
    let onBack: (() -> Void)?
    let onSetEnabled: (Bool) async -> Void
    let onRetry: (() async -> Void)?
    let retryTitle: String
    let motionObservation: ConnectionMotionObservation?
    let isActive: Bool

    @State private var showingRevokeConfirmation = false
    @State private var requestActive = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let signal = YoshShellPalette.activeInk
    private let secondaryInk = YoshShellPalette.secondaryInk
    private let rule = YoshShellPalette.rule

    init(presentation: ConnectionPresentation, isSaving: Bool, writeMessage: String?, writeFailed: Bool,
         onBack: (() -> Void)?, onSetEnabled: @escaping (Bool) async -> Void,
         onRetry: (() async -> Void)? = nil, retryTitle: String = "Retry setup",
         motionObservation: ConnectionMotionObservation? = nil, isActive: Bool = true) {
        self.presentation = presentation
        self.isSaving = isSaving
        self.writeMessage = writeMessage
        self.writeFailed = writeFailed
        self.onBack = onBack
        self.onSetEnabled = onSetEnabled
        self.onRetry = onRetry
        self.retryTitle = retryTitle
        self.motionObservation = motionObservation
        self.isActive = isActive
    }

    private var updating: Bool { isSaving || requestActive }
    private var textAnimation: Animation? {
        presentation.state == .connectionIssue ? nil : YoshTabMotion.Connection.text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let onBack {
                Button("Authority", systemImage: "chevron.left", action: onBack)
                    .font(.system(size: 12))
                    .foregroundStyle(secondaryInk)
                    .buttonStyle(.plain)
                    .disabled(updating)
                    .padding(.bottom, 20)
            }

            CardPageHeader(title: presentation.title, style: .hero(eyebrow: "CONNECTION"))
                .contentTransition(.opacity)
                .animation(textAnimation, value: presentation.title)

            connectionBridge
                .padding(.top, CardPageHeader.Layout.firstSectionSpacing)

            Text(presentation.description)
                .font(.system(size: 15))
                .foregroundStyle(secondaryInk)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 20)
                .contentTransition(.opacity)
                .animation(textAnimation, value: presentation.description)

            if presentation.network != "—" {
                hairline.padding(.top, 24)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Payment environment")
                        .font(.system(size: 12))
                        .foregroundStyle(secondaryInk)
                    Text(presentation.network)
                        .font(.system(size: 15))
                }
                .padding(.top, 16)
            }

            Spacer(minLength: 24)
            hairline

            if presentation.state == .connectionIssue, let onRetry {
                Button(retryTitle) { request { await onRetry() } }
                    .buttonStyle(ConnectionRequestButtonStyle())
                    .font(.system(size: 16))
                    .foregroundStyle(signal)
                    .disabled(updating)
                    .padding(.top, 12)
            }
            if presentation.canDisconnect || presentation.state != .connectionIssue {
                Button(action: setConnection) {
                    HStack(spacing: 16) {
                        Text(presentation.canDisconnect ? "Disconnect" : "Connect")
                            .foregroundStyle(signal)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(secondaryInk)
                            .accessibilityHidden(true)
                    }
                    .font(.system(size: 16))
                    .frame(minHeight: 34, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(ConnectionRequestButtonStyle())
                .disabled(updating)
                .popover(isPresented: $showingRevokeConfirmation, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
                    disconnectConfirmation
                }
                .accessibilityHint(presentation.canDisconnect
                    ? "Disconnects this agent and revokes its current spending authorization after confirmation."
                    : "Sets up this agent's access to Yosh.")
                .padding(.top, 12)
            }

            if updating || (writeMessage != nil && !(writeFailed && presentation.state == .connectionIssue)) {
                Text(updating ? "Updating…" : (writeMessage ?? ""))
                    .font(.system(size: 12))
                    .foregroundStyle(writeFailed ? Color.red : secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.updatesFrequently)
                    .padding(.top, 4)
            }
        }
        .padding(.horizontal, CardPageHeader.Layout.contentInset)
        .padding(.top, onBack == nil ? CardPageHeader.Layout.topSpacing : 18)
        .padding(.bottom, 22)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .disabled(!isActive)
        .allowsHitTesting(isActive)
        .accessibilityHidden(!isActive)
        .onChange(of: isActive) { _, active in
            if !active { showingRevokeConfirmation = false }
        }
    }

    private var disconnectConfirmation: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Disconnect \(presentation.agentName)?")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            Text("Disconnecting \(presentation.agentName) will also revoke its current spending authorization.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Spacer(minLength: 0)
                Button("Cancel") { showingRevokeConfirmation = false }
                    .keyboardShortcut(.cancelAction)
                Button("Disconnect", role: .destructive, action: confirmDisconnect)
                    .disabled(updating || !presentation.canDisconnect)
            }
            .buttonStyle(.bordered)
            .padding(.top, 4)
        }
        .frame(width: 264, alignment: .leading)
        .padding(18)
    }

    private func confirmDisconnect() {
        showingRevokeConfirmation = false
        guard presentation.canDisconnect else { return }
        request { await onSetEnabled(false) }
    }

    private var connectionBridge: some View {
        ConnectionBridge(agentName: presentation.agentName, status: presentation.title,
            input: ConnectionBridge.Input(observation: motionObservation,
                isConnected: presentation.isConnected, isWaiting: presentation.state == .waitingForCodex, isActive: isActive,
                hasIssue: presentation.state == .connectionIssue, reduceMotion: reduceMotion))
    }

    private var hairline: some View {
        Rectangle().fill(rule).frame(height: 1)
            .accessibilityHidden(true)
    }

    private func setConnection() {
        guard isActive, !updating else { return }
        if presentation.canDisconnect {
            showingRevokeConfirmation = true
        } else {
            request { await onSetEnabled(true) }
        }
    }

    private func request(_ action: @escaping @MainActor () async -> Void) {
        guard isActive, !updating else { return }
        requestActive = true
        Task { @MainActor in
            await action()
            requestActive = false
        }
    }
}

#Preview("Connection · Connected (fixture)") {
    AgentConnectionDetail(
        presentation: ConnectionPresentation(agentName: "Codex", state: .connected,
            network: "Solana Devnet", canDisconnect: true),
        isSaving: false, writeMessage: nil, writeFailed: false, onBack: nil, onSetEnabled: { _ in }
    )
    .frame(width: 420, height: 526)
    .background(CardMaterial())
    .environment(\.colorScheme, .light)
}

#Preview("Connection · Not Connected (fixture)") {
    AgentConnectionDetail(
        presentation: ConnectionPresentation(agentName: "Codex", state: .notConnected,
            network: "Solana Devnet", canDisconnect: false),
        isSaving: false, writeMessage: nil, writeFailed: false, onBack: nil, onSetEnabled: { _ in }
    )
    .frame(width: 420, height: 526)
    .background(CardMaterial())
    .environment(\.colorScheme, .light)
}

#Preview("Connection · Waiting (fixture)") {
    AgentConnectionDetail(
        presentation: ConnectionPresentation(agentName: "Codex", state: .waitingForCodex,
            network: "Solana Devnet", canDisconnect: true),
        isSaving: false, writeMessage: nil, writeFailed: false, onBack: nil, onSetEnabled: { _ in }
    )
    .frame(width: 420, height: 526)
    .background(CardMaterial())
    .environment(\.colorScheme, .light)
}
