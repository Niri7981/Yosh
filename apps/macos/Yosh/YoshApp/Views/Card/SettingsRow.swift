import SwiftUI

struct SettingsRow: View {
    let title: String
    var value: String? = nil
    var symbol: String? = nil
    var showsChevron = false
    var actionLabel: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        Group {
            if let action {
                Button(action: action) { content }
                    .buttonStyle(.plain)
                    .accessibilityLabel(actionLabel ?? title)
            } else {
                content
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var content: some View {
        HStack(alignment: .center, spacing: 12) {
            Text(title)
                .foregroundStyle(YoshShellPalette.ink)
                .fixedSize(horizontal: true, vertical: false)
            Spacer(minLength: 4)
            if let value {
                Text(value)
                    .foregroundStyle(YoshShellPalette.secondaryInk)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let symbol {
                Image(systemName: symbol)
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(YoshShellPalette.secondaryInk)
                    .accessibilityHidden(true)
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .regular))
                    .foregroundStyle(YoshShellPalette.secondaryInk)
                    .accessibilityHidden(true)
            }
        }
        .font(.system(size: 13))
        .frame(maxWidth: .infinity, minHeight: 38)
        .contentShape(Rectangle())
    }
}
