import SwiftUI

struct DailyAuthorityContent: View {
    let currency: String?
    @Binding var dailyLimitInput: String
    let isSaving: Bool
    let message: String?
    let messageFailed: Bool
    let balanceDisplay: String?
    let balanceIsLoading: Bool
    let balanceMessage: String?
    let canRetryBalance: Bool
    let onBack: () -> Void
    let onSave: () -> Void
    let onRetryBalance: () -> Void
    var wallet: AuthoritySurface.Wallet? = nil
    var dailyState: String? = nil
    var blockers: [String] = []

    @FocusState private var limitIsFocused: Bool
    private let ink = YoshShellPalette.ink
    private let secondaryInk = YoshShellPalette.secondaryInk
    private let rule = YoshShellPalette.rule

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                Button(action: onBack) {
                    Label("Authority", systemImage: "chevron.left")
                        .font(.system(size: 13))
                        .frame(minHeight: 24, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(secondaryInk)
                .disabled(isSaving)
                .accessibilityLabel("Back to Authority")

                Text("Daily Authority")
                    .font(.system(size: 44, weight: .regular, design: .serif))
                    .tracking(-1.2)
                    .foregroundStyle(ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, 12)
                    .padding(.bottom, 20)
                hairline

                VStack(alignment: .leading, spacing: 0) {
                    sectionLabel("DAILY LIMIT")
                    if let dailyState {
                        Text(dailyState).font(.system(size: 12)).foregroundStyle(secondaryInk).padding(.top, 10)
                    }
                    if !blockers.isEmpty {
                        Text(blockers.joined(separator: "\n"))
                            .font(.system(size: 11)).foregroundStyle(secondaryInk)
                            .fixedSize(horizontal: false, vertical: true).padding(.top, 8)
                    }
                    Text("Limit")
                        .font(.system(size: 14))
                        .padding(.top, 14)
                    HStack(spacing: 16) {
                        TextField("Amount", text: $dailyLimitInput)
                            .textFieldStyle(.plain)
                            .font(.system(size: 17))
                            .monospacedDigit()
                            .focused($limitIsFocused)
                            .disabled(isSaving || currency == nil)
                            .accessibilityLabel("Daily limit in \(currency ?? "unavailable asset")")
                            .accessibilityHint("This daily limit is shared across all agents.")
                        Rectangle().fill(rule).frame(width: 1, height: 24)
                            .accessibilityHidden(true)
                        Text(currency ?? "Unavailable")
                            .font(.system(size: 13))
                            .foregroundStyle(secondaryInk)
                            .fixedSize()
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 40)
                    .background(secondaryInk.opacity(0.025), in: .rect(cornerRadius: 8))
                    .overlay {
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(limitIsFocused ? secondaryInk.opacity(0.7) : rule, lineWidth: 1)
                    }
                    .padding(.top, 8)
                    Text("Enter 0 to stop new purchases. Changes apply to future purchases.")
                        .font(.system(size: 12))
                        .foregroundStyle(secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 8)
                    Button(action: onSave) {
                        Text(isSaving ? "Saving…" : "Save")
                            .font(.system(size: 14))
                            .frame(width: 82, height: 34)
                            .background(YoshShellPalette.selection, in: .rect(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .disabled(isSaving || currency == nil)
                    .accessibilityLabel("Save shared daily limit")
                    .padding(.top, 14)
                    if let message {
                        Text(message)
                            .font(.system(size: 12))
                            .foregroundStyle(messageFailed ? YoshShellPalette.negative : secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.updatesFrequently)
                            .padding(.top, 10)
                    }
                }
                .padding(.top, 22)
                .padding(.bottom, 24)
                hairline

                VStack(alignment: .leading, spacing: 0) {
                    sectionLabel("WALLET")
                    if let wallet {
                        Text(wallet.network).font(.system(size: 12)).foregroundStyle(secondaryInk).padding(.top, 12)
                        if wallet.address.isEmpty {
                            Text(wallet.network == "Solana Mainnet" ? "Mainnet wallet unavailable" : "Wallet unavailable")
                                .font(.system(size: 13)).foregroundStyle(secondaryInk).padding(.top, 8)
                        } else {
                            // Selectable Text supplies its native accessibility label; overriding it re-enters the platform label bridge.
                            Text(wallet.address).font(.system(size: 11)).textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true).padding(.top, 8)
                        }
                    }
                    if let balanceDisplay {
                        Text(balanceDisplay)
                            .font(.system(size: 26))
                            .monospacedDigit()
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 14)
                    } else {
                        Text(balanceIsLoading ? "Reading balance…" : (balanceMessage ?? "Balance not available"))
                            .font(.system(size: 14))
                            .foregroundStyle(secondaryInk)
                            .padding(.top, 14)
                    }
                    Text("\(currency ?? "Wallet") balance is separate from Daily Authority.")
                        .font(.system(size: 12))
                        .foregroundStyle(secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 8)
                    if let balanceMessage {
                        Text(balanceMessage)
                            .font(.system(size: 12))
                            .foregroundStyle(secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 8)
                    }
                    if canRetryBalance {
                        Button("Retry balance", action: onRetryBalance)
                            .buttonStyle(.link)
                            .font(.system(size: 12))
                            .padding(.top, 8)
                    }
                }
                .padding(.top, 24)
            }
            .padding(.horizontal, 26)
            .padding(.top, 24)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.automatic)
        .foregroundStyle(ink)
    }

    private var hairline: some View {
        Rectangle().fill(rule).frame(height: 1).accessibilityHidden(true)
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 10, weight: .semibold))
            .tracking(1.8)
            .foregroundStyle(secondaryInk)
            .accessibilityAddTraits(.isHeader)
    }
}
