import SwiftUI

struct BackControls: View {
    let payments: String
    let paymentsEnabled: Bool?
    let paymentsUpdating: Bool
    let onPaymentsChange: (Bool) -> Void
    let execution: String
    var onExecution: () -> Void = {}

    private var paymentsBinding: Binding<Bool> {
        Binding(get: { paymentsEnabled ?? false }, set: { enabled in onPaymentsChange(enabled) })
    }

    var body: some View {
        VStack(spacing: 0) {
            hairline

            HStack(spacing: 13) {
                Image(systemName: "creditcard")
                    .font(.system(size: 22, weight: .regular))
                    .frame(width: 28)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Payments")
                        .font(.system(size: 15, weight: .medium))
                    Text("Allow purchases within Authority")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                Text(paymentsUpdating ? "Saving…" : payments)
                    .font(.system(size: 14))

                Toggle("Payments", isOn: paymentsBinding)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .tint(YoshShellPalette.activeInk)
                    .disabled(paymentsEnabled == nil || paymentsUpdating)
                    .accessibilityLabel("Allow purchases within Authority")
                    .accessibilityValue(paymentsUpdating ? "Saving" : payments)
                    .accessibilityHint("Purchases require a connected Agent, Daily Authority, a Spend Grant, sufficient funds, and a configured resource.")
            }
            .frame(minHeight: 57)
            .help("On allows purchases only when Connection, Daily Authority, Spend Grant, funds, and resource checks pass.")

            hairline

            Button(action: onExecution) {
                HStack(spacing: 13) {
                    Image(systemName: "square.stack.3d.up")
                        .font(.system(size: 22, weight: .regular))
                        .frame(width: 28)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Execution")
                            .font(.system(size: 15, weight: .medium))
                        Text("Purchase environment")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }

                    Spacer(minLength: 8)

                    Text(execution)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)

                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 57)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(paymentsUpdating)
            .accessibilityLabel("Execution")
            .accessibilityValue(execution)
            .accessibilityHint("Choose the purchase execution environment")

            hairline
        }
    }

    private var hairline: some View {
        Rectangle()
            .fill(YoshShellPalette.rule.opacity(0.4))
            .frame(height: 1)
            .accessibilityHidden(true)
    }
}
