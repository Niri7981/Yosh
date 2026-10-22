import SwiftUI

struct YoshPINChangeEditor: View {
    let appLock: YoshAppLock
    let onDismiss: () -> Void

    @State private var digitCount: Int
    @State private var pin = ""
    @State private var confirmation = ""
    @FocusState private var pinFocused: Bool
    @FocusState private var confirmationFocused: Bool

    init(appLock: YoshAppLock, onDismiss: @escaping () -> Void) {
        self.appLock = appLock
        self.onDismiss = onDismiss
        _digitCount = State(initialValue: appLock.digitCount)
    }

    private var canSave: Bool {
        pin.count == digitCount && confirmation.count == digitCount && !appLock.isBusy
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("PIN length")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Picker("PIN length", selection: $digitCount) {
                    Text("4 digits").tag(4)
                    Text("6 digits").tag(6)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .controlSize(.small)
                .frame(width: 150)
                .disabled(appLock.isBusy)
                .accessibilityIdentifier("yosh.lock.change.length")
            }

            YoshPINEntry(pin: $pin, isFocused: $pinFocused, digitCount: digitCount, prompt: "New PIN", style: .compact)
                .disabled(appLock.isBusy)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("yosh.lock.change.pin")

            YoshPINEntry(pin: $confirmation, isFocused: $confirmationFocused, digitCount: digitCount,
                prompt: "Confirm PIN", style: .compact)
                .disabled(appLock.isBusy)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("yosh.lock.change.confirmation")

            if let error = appLock.error {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(YoshShellPalette.negative)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("yosh.lock.change.error")
            }

            HStack {
                Button("Cancel", action: cancel)
                    .keyboardShortcut(.cancelAction)
                    .disabled(appLock.isBusy)
                    .accessibilityIdentifier("yosh.lock.change.cancel")
                Spacer()
                Button("Change PIN", action: save)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSave)
                    .accessibilityIdentifier("yosh.lock.change.save")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .frame(maxWidth: .infinity)
        .task { pinFocused = true }
        .onChange(of: digitCount) {
            clearEntries()
            appLock.clearError()
            pinFocused = true
        }
        .onDisappear { clearEntries() }
    }

    private func clearEntries() {
        pin = ""
        confirmation = ""
        pinFocused = false
        confirmationFocused = false
    }

    private func cancel() {
        clearEntries()
        appLock.clearError()
        onDismiss()
    }

    private func save() {
        Task {
            if await appLock.changePIN(pin, confirmation: confirmation, digitCount: digitCount) {
                clearEntries()
                onDismiss()
            }
        }
    }
}
