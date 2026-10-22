import SwiftUI

struct BackLatestPurchase: View {
    let latest: AuthorityOverviewPresentation.Latest?
    let agentName: String
    let isLoading: Bool
    let activityAvailable: Bool
    let onActivity: () -> Void
    let onPurchase: (String) -> Void

    private var context: String {
        if let purpose = latest?.purpose { return "\(agentName) · \(purpose)" }
        return agentName
    }

    private var decisionColor: Color {
        switch latest?.decisionTone {
        case .approved: YoshShellPalette.positive
        case .denied: YoshShellPalette.negative
        case .neutral, nil: .secondary
        }
    }

    private var decisionTint: Color {
        switch latest?.decisionTone {
        case .approved: YoshShellPalette.positiveWash.opacity(0.5)
        case .denied: YoshShellPalette.negativeWash.opacity(0.25)
        case .neutral, nil: Color.secondary.opacity(0.1)
        }
    }

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
            .accessibilityHint("Opens Activity for \(agentName).")

            Button(action: openPurchase) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: latest?.symbol ?? "clock")
                        .font(.system(size: 23, weight: .regular))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 32)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 5) {
                        Text(latest?.title ?? (isLoading ? "—" : "No activity yet"))
                            .font(.system(size: 15, weight: .medium))
                            .lineLimit(1)
                        Text(latest == nil ? (isLoading ? "Loading Activity…" : "Activity for \(agentName)") : context)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)

                        if let latest {
                            HStack(alignment: .firstTextBaseline, spacing: 5) {
                                Circle()
                                    .fill(latest.paymentConfirmed ? YoshShellPalette.activeInk : Color.secondary)
                                    .frame(width: 6, height: 6)
                                    .accessibilityHidden(true)
                                Text("\(latest.payment) · \(latest.recency)")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    VStack(alignment: .trailing, spacing: 8) {
                        HStack(spacing: 8) {
                            if let latest {
                                Text(latest.amount)
                                    .font(.system(size: 15, weight: .medium))
                                    .monospacedDigit()
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.6)
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(.secondary)
                                    .accessibilityHidden(true)
                            }
                        }

                        if let latest {
                            Text(latest.decision)
                                .font(.system(size: 9, weight: .semibold))
                                .tracking(0.5)
                                .foregroundStyle(decisionColor)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(decisionTint, in: Capsule())
                                .accessibilityLabel("Policy decision: \(latest.decision)")
                        }
                    }
                    .frame(maxWidth: latest == nil ? nil : 122, alignment: .trailing)
                }
                .frame(minHeight: 68, alignment: .top)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!activityAvailable || latest == nil)
            .accessibilityLabel(latest.map { "Activity: \($0.title), \(context), \($0.payment), \($0.recency), \($0.amount). Policy decision: \($0.decision)" } ?? "Activity. \(isLoading ? "Loading" : "No purchases yet")")
            .accessibilityHint("Opens this purchase's details. Recency is when the request was created.")
        }
    }

    private func openPurchase() {
        guard let latest else { return }
        onPurchase(latest.purchaseId)
    }
}
