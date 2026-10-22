import SwiftUI

struct MembersRoster: View {
    let presentation: MembersRosterPresentation
    let selectedMemberID: UUID?
    let isLoading: Bool
    let interactionsDisabled: Bool
    let error: String?
    let onSelect: (UUID) -> Void
    let onConnect: (UUID) -> Void
    let onAdd: () -> Void
    let onRetry: (() -> Void)?

    private let secondaryInk = YoshShellPalette.secondaryInk
    private let rule = YoshShellPalette.rule

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CardPageHeader(title: "Agents", style: .collection(subtitle: "Agents share one Daily Authority."))
                .foregroundStyle(YoshShellPalette.ink)
                .overlay(alignment: .topTrailing) {
                    Button("Add custom agent", systemImage: "plus", action: onAdd)
                        .labelStyle(.iconOnly)
                        .font(.system(size: 14))
                        .frame(width: 28, height: 28)
                        .buttonStyle(.plain)
                        .foregroundStyle(secondaryInk)
                        .disabled(interactionsDisabled)
                        .help("Add custom agent")
                        .padding(.top, CardPageHeader.Layout.titleTopOffset + (CardPageHeader.Layout.titleHeight - 28) / 2)
                }

            if isLoading {
                Text("Loading agents…")
                    .font(.system(size: 11))
                    .foregroundStyle(secondaryInk)
                    .padding(.top, 8)
            }
            if let error {
                HStack(alignment: .top, spacing: 8) {
                    Text(error).fixedSize(horizontal: false, vertical: true)
                    if let onRetry {
                        Button("Retry", action: onRetry)
                            .buttonStyle(.link)
                            .disabled(interactionsDisabled)
                    }
                }
                .font(.system(size: 11))
                .foregroundStyle(YoshShellPalette.negative)
                .padding(.top, 8)
            }

            ScrollView(.vertical) {
                LazyVStack(spacing: 0) {
                    ForEach(presentation.sections) { section in
                        Text(section.group.rawValue)
                            .font(.system(size: 9, weight: .medium))
                            .tracking(1.8)
                            .foregroundStyle(secondaryInk)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, section.group == .setUp ? 0 : 24)
                            .padding(.bottom, 8)
                            .accessibilityAddTraits(.isHeader)
                        if section.rows.isEmpty {
                            Text(section.group == .custom ? "Add a custom agent with the + button." : "Connect an available agent to get started.")
                                .font(.system(size: 12))
                                .foregroundStyle(secondaryInk)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 8)
                        }
                        ForEach(section.rows) { row in
                            MembersRosterRow(row: row, isSelected: row.memberID == selectedMemberID,
                                interactionsDisabled: interactionsDisabled, onSelect: onSelect, onConnect: onConnect)
                            Rectangle().fill(rule).frame(height: 1)
                                .accessibilityHidden(true)
                        }
                    }
                }
                .padding(.bottom, 12)
            }
            .scrollIndicators(.automatic)
            .padding(.top, CardPageHeader.Layout.firstSectionSpacing)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
