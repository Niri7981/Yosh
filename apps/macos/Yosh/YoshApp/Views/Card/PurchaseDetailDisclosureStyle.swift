import SwiftUI

/// Keep native disclosure state and keyboard activation, with Yosh's trailing indicator and flat boundary.
struct PurchaseDetailDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                configuration.isExpanded.toggle()
            } label: {
                HStack(spacing: 12) {
                    configuration.label
                    Spacer(minLength: 8)
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(YoshShellPalette.secondaryInk)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(configuration.isExpanded ? "Expanded" : "Collapsed")
            if configuration.isExpanded {
                configuration.content.padding(.top, 8).padding(.bottom, 14)
            }
        }
        .padding(.horizontal, 14)
        .background(YoshShellPalette.secondaryInk.opacity(0.018), in: .rect(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18).strokeBorder(YoshShellPalette.rule, lineWidth: 0.65)
                .allowsHitTesting(false)
        }
    }
}
