import SwiftUI

struct YoshAppLockSettings: View {
    let appLock: YoshAppLock

    @State private var showsPINChange = false

    private var canManageLock: Bool {
        appLock.state == .unlocked && appLock.pinConfigured && !appLock.isBusy
    }

    // The model remains authoritative while the Keychain update is in progress.
    private var enabledBinding: Binding<Bool> {
        Binding(
            get: { appLock.enabled },
            set: { enabled in Task { await appLock.setEnabled(enabled) } }
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text("App Lock")
                    .foregroundStyle(YoshShellPalette.ink)
                Spacer(minLength: 4)
                Text(appLock.enabled ? "On" : "Off")
                    .font(.system(size: 11))
                    .foregroundStyle(YoshShellPalette.secondaryInk)
                Toggle("App Lock", isOn: enabledBinding)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .disabled(!canManageLock)
                    .accessibilityIdentifier("yosh.lock.enabled")
                    .accessibilityHint("Require your Yosh PIN when the app opens.")
            }
            .font(.system(size: 13))
            .frame(minHeight: 38)

            Rectangle()
                .fill(YoshShellPalette.rule)
                .frame(height: 1)
                .accessibilityHidden(true)

            // Stay inside the card: a system sheet adds a separate appearance,
            // window shadow and dimming layer to this narrow settings surface.
            DisclosureGroup(isExpanded: $showsPINChange) {
                if showsPINChange {
                    YoshPINChangeEditor(appLock: appLock, onDismiss: { showsPINChange = false })
                        .padding(.vertical, 12)
                }
            } label: {
                Button { showsPINChange.toggle() } label: {
                    Text("Change PIN")
                        .font(.system(size: 13))
                        .foregroundStyle(YoshShellPalette.ink)
                        .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .disabled(!canManageLock)
            .tint(YoshShellPalette.activeInk)
            .accessibilityIdentifier("yosh.lock.change")
            .onChange(of: showsPINChange) { _, expanded in
                if expanded { appLock.clearError() }
            }

            if let error = appLock.error, !showsPINChange {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(YoshShellPalette.negative)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
                    .accessibilityIdentifier("yosh.lock.settings.error")
            }
        }
    }
}
