import SwiftUI

struct ActivityDetail: View {
    let purchases: [AppOverview.Purchase]
    let agentName: String
    let isRefreshing: Bool
    let refreshError: String?
    let onBack: () -> Void
    let onRefresh: () async -> Void
    let onSelect: (String) -> Void

    private let secondaryInk = YoshShellPalette.secondaryInk

    private var ledger: ActivityLedgerPresentation {
        ActivityLedgerPresentation(purchases, agentName: agentName)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Activity")
                .font(.system(size: 56, weight: .regular, design: .serif))
                .tracking(-1.8)
                .foregroundStyle(YoshShellPalette.ink)
                .frame(height: CardPageHeader.Layout.titleHeight, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
                .overlay(alignment: .topTrailing) {
                    HStack(spacing: 12) {
                        Button("Back to Authority", systemImage: "chevron.left", action: onBack)
                            .help("Back to Authority")
                        Button("Refresh activity", systemImage: "arrow.clockwise", action: refresh)
                            .disabled(isRefreshing)
                            .help("Refresh activity")
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                    .font(.system(size: 12))
                    .foregroundStyle(secondaryInk)
                }
                .padding(.horizontal, 8)

            Text("Purchases, decisions, and outcomes for \(agentName).")
                .font(.system(size: 13))
                .foregroundStyle(secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
                .padding(.horizontal, 8)

            if isRefreshing {
                Text("Refreshing activity…")
                    .font(.system(size: 11))
                    .foregroundStyle(secondaryInk)
                    .accessibilityAddTraits(.updatesFrequently)
                    .padding(.top, 8)
            }
            if let refreshError {
                Text(refreshError)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
            }

            if purchases.isEmpty {
                ContentUnavailableView(isRefreshing ? "Loading Activity…" : refreshError == nil ? "No activity yet" : "Activity could not be loaded", systemImage: "clock",
                    description: Text(isRefreshing ? "Reading Activity for \(agentName)." : refreshError == nil ? "Requests made by \(agentName) will appear here." : "Refresh Activity to try again."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 24) {
                        ForEach(ledger.days) { day in
                            VStack(alignment: .leading, spacing: 10) {
                                Text(day.title.uppercased())
                                    .font(.system(size: 10, weight: .semibold))
                                    .tracking(1.8)
                                    .foregroundStyle(secondaryInk)
                                    .accessibilityAddTraits(.isHeader)
                                    .padding(.horizontal, 8)
                                LazyVStack(spacing: 8) {
                                    ForEach(day.rows) { row in
                                        ActivityLedgerRow(row: row, onSelect: onSelect)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.bottom, 12)
                }
                .scrollIndicators(.automatic)
                .padding(.top, 32)
            }
        }
        .padding(.horizontal, CardPageHeader.Layout.contentInset - 8)
        .padding(.top, CardPageHeader.Layout.topSpacing)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func refresh() {
        Task { await onRefresh() }
    }
}
