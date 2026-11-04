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
        VStack(spacing: 9) {
            HStack(spacing: 18) {
                Image(systemName: "power")
                    .font(.system(size: 24, weight: .light))
                    .frame(width: 28)
                    .accessibilityHidden(true)

                Text("Payments")
                    .font(.system(size: 16, weight: .regular))

                Spacer(minLength: 8)

                Text(paymentsUpdating ? "Saving…" : payments)
                    .font(.system(size: 14))

                Toggle("Payments", isOn: paymentsBinding)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .tint(YoshShellPalette.activeInk)
                    .disabled(paymentsEnabled == nil || paymentsUpdating)
                    .accessibilityLabel("Allow purchases within Authority")
                    .accessibilityIdentifier("authority.payments.toggle")
                    .accessibilityValue(paymentsUpdating ? "Saving" : payments)
                    .accessibilityHint("Purchases require a connected Agent, Daily Authority, a Spend Grant, sufficient funds, and a configured resource.")
            }
            .frame(minHeight: 54)
            .padding(.horizontal, 14)
            .background(rowBoundary)
            .help("On allows purchases only when Connection, Daily Authority, Spend Grant, funds, and resource checks pass.")

            Button(action: onExecution) {
                HStack(spacing: 18) {
                    Image(systemName: "globe")
                        .font(.system(size: 24, weight: .light))
                        .frame(width: 28)
                        .accessibilityHidden(true)

                    Text("Execution")
                        .font(.system(size: 16, weight: .regular))

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
                .frame(minHeight: 54)
                .padding(.horizontal, 14)
                .background(rowBoundary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(paymentsUpdating)
            .accessibilityLabel("Execution")
            .accessibilityIdentifier("authority.execution.open")
            .accessibilityValue(execution)
            .accessibilityHint("Choose the purchase execution environment")
        }
    }

    private var rowBoundary: some View {
        RoundedRectangle(cornerRadius: 22)
            .fill(YoshShellPalette.secondaryInk.opacity(0.018))
            .overlay {
                RoundedRectangle(cornerRadius: 22)
                    .strokeBorder(YoshShellPalette.rule, lineWidth: 0.65)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}
