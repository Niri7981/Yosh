import SwiftUI

struct AgentsMenu: View {
    let session: CardMemberSession

    var body: some View {
        Menu {
            if session.activeMembers.isEmpty {
                Text("No active agents")
            }
            ForEach(session.activeMembers, id: \.member.id) { entry in
                Button {
                    session.select(entry.member.id)
                } label: {
                    if entry.member.id == session.selectedMemberID {
                        Label(entry.member.label, systemImage: "checkmark")
                    } else {
                        Text(entry.member.label)
                    }
                }
            }
        } label: {
            capsuleLabel
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .accessibilityIdentifier("agents.selector")
        .accessibilityHint("Current agent: \(session.selectedMember?.label ?? "none")")
    }

    @ViewBuilder
    private var capsuleLabel: some View {
        if #available(macOS 26, *) {
            label
                .glassEffect(.regular.interactive(), in: .capsule)
        } else {
            label
                .background(.regularMaterial, in: Capsule())
        }
    }

    private var label: some View {
        HStack(spacing: 8) {
            Text(session.selectedMember?.label ?? "Agents")
                .font(.system(size: 16, weight: .medium))
                .lineLimit(1)
                .frame(maxWidth: 200, alignment: .leading)
            Image(systemName: "chevron.down")
                .font(.system(size: 11, weight: .semibold))
                .accessibilityHidden(true)
        }
        .foregroundStyle(Color(nsColor: .labelColor))
        .padding(.horizontal, 22)
        .frame(height: 48)
        .contentShape(Capsule())
    }
}
