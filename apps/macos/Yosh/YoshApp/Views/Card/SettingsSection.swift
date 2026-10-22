import SwiftUI

struct SettingsSection<Content: View>: View {
    let title: String
    let symbol: String
    var action: (() -> Void)? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Group {
                if let action {
                    Button(action: action) { heading }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Manage \(title.lowercased())")
                        .accessibilityIdentifier("settings.\(title.lowercased()).open")
                } else { heading }
            }
            .foregroundStyle(YoshShellPalette.secondaryInk)
            VStack(spacing: 0) { content }
                .frame(maxWidth: .infinity)
        }
    }

    private var heading: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 15)).frame(width: 20, height: 20)
                .accessibilityHidden(true)
            Text(title).font(.system(size: 10, weight: .semibold)).tracking(1.8)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            if action != nil {
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .medium))
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 24)
        .contentShape(Rectangle())
    }
}
