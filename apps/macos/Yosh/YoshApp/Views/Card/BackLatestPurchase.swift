import SwiftUI

struct BackLatestPurchase: View {
    let latest: AuthorityOverviewPresentation.Latest?
    let agentName: String
    let isLoading: Bool
    let activityAvailable: Bool
    let onActivity: () -> Void
    let onPurchase: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button(action: onActivity) {
                HStack(spacing: 7) {
                    Text("ACTIVITY")
                        .font(.system(size: 10, weight: .medium))
                        .tracking(2.6)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .medium))
                        .accessibilityHidden(true)
                }
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 20, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!activityAvailable)
            .accessibilityLabel("Activity")
            .accessibilityIdentifier("authority.activity.open")
            .accessibilityHint("Opens Activity for \(agentName).")

            if let latest {
                ActivityLedgerRow(row: ActivityLedgerPresentation.Row(latest.purchase, agentName: agentName),
                    onSelect: onPurchase)
                    .disabled(!activityAvailable)
                    .accessibilityIdentifier("authority.activity.purchase")
            } else {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "clock")
                        .font(.system(size: 23, weight: .regular))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 32)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(isLoading ? "—" : "No activity yet")
                            .font(.system(size: 15, weight: .medium))
                        Text(isLoading ? "Loading Activity…" : "Activity for \(agentName)")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 68, alignment: .topLeading)
            }
        }
    }

}
