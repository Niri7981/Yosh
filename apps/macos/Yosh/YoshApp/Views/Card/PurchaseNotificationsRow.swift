import SwiftUI
import AppKit

struct PurchaseNotificationsRow: View {
    @State private var notifications = PurchaseNotifications.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle("Notifications", isOn: Binding(get: { notifications.enabled },
                set: { value in Task { await notifications.setEnabled(value) } }))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .font(.system(size: 13))
                .foregroundStyle(YoshShellPalette.ink)
                .frame(minHeight: 38)
                .disabled(notifications.isChanging)
                .accessibilityIdentifier("settings.notifications")
            if Bundle.main.object(forInfoDictionaryKey: "YoshNotificationPreview") as? Bool == true {
                Button("Send test notification") { Task { await notifications.sendPreview() } }
                    .buttonStyle(.plain)
                    .font(.system(size: 11))
                    .foregroundStyle(YoshShellPalette.secondaryInk)
                    .disabled(!notifications.enabled || !notifications.allowed)
                    .accessibilityIdentifier("settings.notifications.test")
            }
            if notifications.enabled && !notifications.allowed || notifications.message != nil {
                Text(notifications.message ?? "Allow Yosh in System Settings → Notifications.")
                    .font(.system(size: 11))
                    .foregroundStyle(YoshShellPalette.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task { await notifications.refreshPermission() }
    }
}
