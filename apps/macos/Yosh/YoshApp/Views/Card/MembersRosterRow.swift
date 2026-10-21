import SwiftUI

struct MembersRosterRow: View {
    let row: MembersRosterPresentation.Row
    let isSelected: Bool
    let interactionsDisabled: Bool
    let onSelect: (UUID) -> Void
    let onConnect: (UUID) -> Void

    private let ink = YoshShellPalette.ink
    private let secondaryInk = YoshShellPalette.secondaryInk
    private let signal = YoshShellPalette.activeInk

    var body: some View {
        HStack(spacing: 14) {
            if row.canSelect, let id = row.memberID {
                Button(action: { onSelect(id) }) { identity }
                    .buttonStyle(.plain)
                    .disabled(interactionsDisabled)
                    .accessibilityLabel("\(row.name), \(row.provider)")
                    .accessibilityHint("Selects this Agent and opens its details.")
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
            } else {
                identity
            }
            VStack(alignment: .trailing, spacing: 4) {
                if row.status == .connectionIssue {
                    status
                }
                if let action = row.action {
                    Button(action.title, action: connect)
                        .font(.system(size: 11))
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .tint(signal)
                        .disabled(interactionsDisabled || row.memberID == nil)
                        .help(row.explanation)
                        .accessibilityLabel("\(action.title) · \(row.name)")
                        .accessibilityHint(row.explanation)
                } else if row.status != .connectionIssue {
                    status
                }
            }
        }
        .frame(minHeight: row.isCustom ? 56 : 74)
    }

    private var identity: some View {
        HStack(spacing: row.isCustom ? 12 : 16) {
            providerIcon
            VStack(alignment: .leading, spacing: 4) {
                Text(row.name)
                    .font(.system(size: row.isCustom ? 14 : 15, weight: row.isCustom ? .regular : .medium))
                    .foregroundStyle(ink)
                    .lineLimit(1)
                Text(row.provider)
                    .font(.system(size: row.isCustom ? 11 : 12))
                    .foregroundStyle(secondaryInk)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, minHeight: row.isCustom ? 56 : 74, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var providerIcon: some View {
        Group {
            switch row.icon {
            case .brand(let brand):
                Image(brand.rawValue)
                    // Cursor's official grayscale faces must remain distinct.
                    .renderingMode(brand == .cursor ? .original : .template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: brand.opticalSize, height: brand.opticalSize)
            case .monogram(let text):
                Text(text).font(.system(size: text.count > 2 ? 18 : 23, weight: .semibold))
            case .symbol(let name):
                Image(systemName: name).font(.system(size: row.isCustom ? 16 : 25, weight: .regular))
            }
        }
        .foregroundStyle(row.isCustom ? secondaryInk : ink)
        .frame(width: row.isCustom ? 26 : 44, height: row.isCustom ? 26 : 44)
        .background(row.isCustom ? .clear : secondaryInk.opacity(0.06), in: .rect(cornerRadius: 12))
        .accessibilityHidden(true)
    }

    private var status: some View {
        HStack(spacing: 6) {
            if row.status == .connected || row.status == .waiting || row.status == .accessAllowed {
                Circle()
                    .fill(row.status == .connected ? signal : secondaryInk.opacity(0.65))
                    .frame(width: 5, height: 5)
                    .accessibilityHidden(true)
            }
            Text(row.status.title)
        }
        .font(.system(size: 11))
        .foregroundStyle(row.status == .connected ? signal : secondaryInk)
        .fixedSize(horizontal: true, vertical: false)
        .help(row.explanation)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.status.title) · \(row.name)")
    }

    private func connect() {
        guard !interactionsDisabled, row.action != nil, let id = row.memberID else { return }
        onConnect(id)
    }
}
