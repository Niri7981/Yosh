import SwiftUI

struct ActivityLedgerRow: View {
    let row: ActivityLedgerPresentation.Row
    let onSelect: (String) -> Void

    @State private var isHovered = false

    private let secondaryInk = YoshShellPalette.secondaryInk

    private var statusInk: Color {
        switch row.tone {
        case .positive: YoshShellPalette.positive
        case .pending: YoshShellPalette.pending
        case .negative: YoshShellPalette.negative
        case .neutral: secondaryInk
        }
    }

    private var statusTint: Color {
        switch row.tone {
        case .positive: YoshShellPalette.positiveWash.opacity(0.4)
        case .pending: YoshShellPalette.pendingWash.opacity(0.24)
        case .negative: YoshShellPalette.negativeWash.opacity(0.24)
        case .neutral: secondaryInk.opacity(0.1)
        }
    }

    var body: some View {
        Button(action: selectPurchase) {
            HStack(alignment: .center, spacing: 10) {
                resourceIcon

                VStack(alignment: .leading, spacing: 5) {
                    Text(row.item.title)
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    Text(row.context)
                        .font(.system(size: 11))
                        .foregroundStyle(secondaryInk)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .trailing, spacing: 8) {
                    Text(row.item.amount)
                        .font(.system(size: 15, weight: .medium))
                        .monospacedDigit()
                        .lineLimit(2)
                        .multilineTextAlignment(.trailing)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity, alignment: .trailing)

                    HStack(spacing: 6) {
                        Text(row.item.time)
                            .font(.system(size: 10))
                            .monospacedDigit()
                            .foregroundStyle(secondaryInk)
                            .lineLimit(1)
                        Text(row.item.compactStatus)
                            .font(.system(size: 9, weight: .semibold))
                            .tracking(0.3)
                            .foregroundStyle(statusInk)
                            .lineLimit(2)
                            .multilineTextAlignment(.center)
                            .help(row.item.status)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 4)
                            .background(statusTint, in: Capsule())
                            .frame(maxWidth: 80, alignment: .trailing)
                    }
                }
                .frame(width: 112)
            }
            .frame(minHeight: 44)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .foregroundStyle(YoshShellPalette.ink)
            .background(isHovered ? secondaryInk.opacity(0.07) : secondaryInk.opacity(0.018),
                in: .rect(cornerRadius: 22))
            .overlay {
                RoundedRectangle(cornerRadius: 22)
                    .strokeBorder(YoshShellPalette.rule, lineWidth: 0.65)
                    .allowsHitTesting(false)
            }
            .contentShape(.rect(cornerRadius: 22))
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(row.purpose ?? row.item.status)
        .accessibilityLabel("\(row.item.title), \(row.context), \(row.purpose ?? ""), requested amount \(row.item.amount), \(row.item.status), \(row.item.timestamp)")
        .accessibilityHint("Opens purchase details, including the separate payment and delivery states.")
    }

    private var resourceIcon: some View {
        HostNetworkIcon(hostName: row.hostName, network: row.network, size: 48)
            .frame(width: 36, height: 36)
            .offset(x: -3)
            .accessibilityHidden(true)
    }

    private func selectPurchase() {
        onSelect(row.id)
    }
}
