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
            HStack(alignment: .top, spacing: 10) {
                resourceIcon

                VStack(alignment: .leading, spacing: 5) {
                    Text(row.item.title)
                        .font(.system(size: 15, weight: .medium))
                        .lineLimit(1)
                    Text(row.context)
                        .font(.system(size: 11))
                        .foregroundStyle(secondaryInk)
                        .lineLimit(1)
                    if let purpose = row.purpose {
                        Text(purpose)
                            .font(.system(size: 11))
                            .foregroundStyle(secondaryInk)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .trailing, spacing: 8) {
                    Text(row.item.amount)
                        .font(.system(size: 15, weight: .medium))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity, alignment: .trailing)

                    HStack(spacing: 6) {
                        Text(row.item.time)
                            .font(.system(size: 11))
                            .monospacedDigit()
                            .foregroundStyle(secondaryInk)
                            .lineLimit(1)
                            .frame(width: 54, alignment: .trailing)
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
                            .frame(width: 94, alignment: .trailing)
                    }
                }
                .frame(width: 154)
            }
            .frame(minHeight: 56, alignment: .top)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
            .background(isHovered ? Color.blue.opacity(0.055) : .clear, in: .rect(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .accessibilityLabel("\(row.item.title), \(row.context), \(row.purpose ?? ""), requested amount \(row.item.amount), \(row.item.status), \(row.item.timestamp)")
        .accessibilityHint("Opens purchase details, including the separate payment and delivery states.")
    }

    private var resourceIcon: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                switch row.item.icon {
                case .asset(let name):
                    Image(name).resizable().scaledToFit().frame(width: 22, height: 22)
                case .symbol(let name):
                    Image(systemName: name).font(.system(size: 19, weight: .regular))
                }
            }
            .foregroundStyle(secondaryInk)
            .frame(width: 25, height: 25)
            if row.solanaBadge {
                Text("S")
                    .font(.system(size: 7, weight: .semibold))
                    .foregroundStyle(secondaryInk)
                    .frame(width: 11, height: 11)
                    .background(YoshShellPalette.surface, in: Circle())
                    .overlay(Circle().stroke(secondaryInk.opacity(0.55), lineWidth: 0.6))
                    .offset(x: 4, y: 4)
            }
        }
        .frame(width: 29, height: 29)
        .accessibilityHidden(true)
    }

    private func selectPurchase() {
        onSelect(row.id)
    }
}
