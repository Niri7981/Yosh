import SwiftUI

/// Transfers input to App Lock while keeping credential derivation outside the front view.
struct YoshLockEntry: View {
    let appLock: YoshAppLock?
    var isFocused: FocusState<Bool>.Binding
    var pinLength = 4

    @State private var pin = ""

    private var digitCount: Int { appLock?.digitCount ?? pinLength }

    private var prompt: String {
        guard let appLock else { return "Enter your password" }
        guard appLock.loadSucceeded else {
            return appLock.isBusy ? "Loading App Lock…" : "App Lock unavailable"
        }
        if appLock.isUnlocked { return "App unlocked" }
        switch appLock.entryStep {
        case .create: return "Create your Yosh PIN"
        case .confirm: return "Confirm your Yosh PIN"
        case .unlock: return "Enter your password"
        }
    }

    var body: some View {
        YoshPINEntry(pin: $pin, isFocused: isFocused, digitCount: digitCount, prompt: prompt)
            .disabled(appLock != nil && appLock?.canEnterPIN != true)
            .overlay(alignment: .bottom) {
                if let appLock {
                    YoshLockEntryFooter(appLock: appLock)
                        .offset(y: 28)
                }
            }
            .onChange(of: pin) { _, _ in submitCompletePIN() }
            .onChange(of: digitCount) { _, _ in pin = "" }
            .onChange(of: appLock?.entryStep) { _, _ in pin = "" }
            .onChange(of: appLock?.state) { _, state in
                pin = ""
                if state == .unlocked { isFocused.wrappedValue = false }
            }
            .onDisappear { pin = "" }
    }

    private func submitCompletePIN() {
        guard let appLock, appLock.canEnterPIN, pin.count == digitCount,
              pin == YoshPINEntry.normalizedPIN(pin, digitCount: digitCount) else { return }
        let submitted = pin
        let restoreFocus = isFocused.wrappedValue
        pin = ""
        Task {
            _ = await appLock.submitPIN(submitted)
            if restoreFocus && appLock.state == .locked { isFocused.wrappedValue = true }
        }
    }
}

private struct YoshLockEntryFooter: View {
    let appLock: YoshAppLock

    var body: some View {
        Group {
            if !appLock.loadSucceeded {
                Button("Retry") { Task { await appLock.load() } }
                    .disabled(appLock.isBusy)
                    .help(appLock.error ?? "Read App Lock from macOS Keychain")
            } else if let error = appLock.error {
                HStack(spacing: 8) {
                    Text(error)
                        .foregroundStyle(YoshShellPalette.negative)
                        .accessibilityIdentifier("yosh.lock.error")
                    if !appLock.pinConfigured && appLock.entryStep == .confirm {
                        Button("Start over") { appLock.restartSetup(pinLength: appLock.digitCount) }
                            .disabled(appLock.isBusy)
                    }
                }
            } else if !appLock.pinConfigured && appLock.entryStep == .create {
                Picker("PIN length", selection: Binding(
                    get: { appLock.digitCount }, set: { appLock.restartSetup(pinLength: $0) })) {
                    Text("4 digits").tag(4)
                    Text("6 digits").tag(6)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .controlSize(.mini)
                .frame(width: 150)
                .disabled(appLock.isBusy)
                .accessibilityIdentifier("yosh.lock.pin-length")
            } else if !appLock.pinConfigured && appLock.entryStep == .confirm {
                Button("Start over") { appLock.restartSetup(pinLength: appLock.digitCount) }
                    .disabled(appLock.isBusy)
            }
        }
        .font(.system(size: 11))
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .frame(width: 276, height: 20)
    }
}
