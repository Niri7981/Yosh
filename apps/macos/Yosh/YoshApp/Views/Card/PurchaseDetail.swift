import AppKit
import SwiftUI

struct PurchaseDetail: View {
    let purchase: AppOverview.Purchase
    let agentName: String
    let backTitle: String
    let onBack: () -> Void
    var onCopy: (String) -> Void = { value in
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }

    @State private var copiedReceipt: String?
    private let ink = YoshShellPalette.ink
    private let secondaryInk = YoshShellPalette.secondaryInk
    private let rule = YoshShellPalette.rule
    private var item: PurchaseDetailPresentation { PurchaseDetailPresentation(purchase, agentName: agentName) }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                Button(action: onBack) {
                    Label(backTitle, systemImage: "chevron.left")
                        .font(.system(size: 13))
                        .frame(minHeight: 24, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(YoshShellPalette.secondaryInk)
                .accessibilityLabel("Back to \(backTitle)")

                HStack(alignment: .center, spacing: 12) {
                    Text(item.title)
                        .font(.system(size: 34, weight: .regular, design: .serif))
                        .tracking(-0.9)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityAddTraits(.isHeader)
                    compactStatus
                }
                .padding(.top, 12)
                .padding(.bottom, 20)
                hairline

                lifecycle.padding(.vertical, 18)
                hairline
                authority.padding(.vertical, 18)
                hairline
                merchantResource.padding(.vertical, 18)
                hairline
                transactionContext.padding(.vertical, 18)
                hairline
                receiptDetails.padding(.top, 18)
            }
            .padding(.horizontal, 26)
            .padding(.top, 24)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.automatic)
        .foregroundStyle(ink)
    }

    private var compactStatus: some View {
        Text(item.status)
            .font(.system(size: 9, weight: .semibold))
            .tracking(0.7)
            .foregroundStyle(item.tone == .success ? YoshShellPalette.positive : signal(item.tone))
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(signal(item.tone).opacity(0.10), in: Capsule())
            .fixedSize(horizontal: true, vertical: false)
            .accessibilityLabel("Purchase status: \(item.status)")
    }

    private var lifecycle: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("PURCHASE LIFECYCLE")
            VStack(spacing: 0) {
                ForEach(Array(item.stages.enumerated()), id: \.element.id) { index, stage in
                    lifecycleStage(stage, connects: index < item.stages.count - 1)
                }
            }
        }
    }

    private func lifecycleStage(_ stage: PurchaseDetailPresentation.Stage, connects: Bool) -> some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(spacing: 0) {
                ZStack {
                    Circle()
                        .fill(stage.tone == .success ? signal(.success) : signal(stage.tone).opacity(0.12))
                    Image(systemName: marker(stage.tone))
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(stage.tone == .success ? .white : signal(stage.tone))
                }
                .frame(width: 16, height: 16)
                Rectangle()
                    .fill(connects ? signal(stage.tone).opacity(0.55) : .clear)
                    .frame(width: 1)
            }
            .padding(.top, 2)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(stage.title)
                        .font(.system(size: 14, weight: .medium))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Text(stage.time ?? "—")
                        .font(.system(size: 11))
                        .monospacedDigit()
                        .foregroundStyle(secondaryInk)
                        .help("Stage time not provided")
                        .accessibilityLabel(stage.time ?? "Stage time unavailable")
                }
                Text(stage.detail)
                    .font(.system(size: 12))
                    .foregroundStyle(secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.bottom, connects ? 18 : 0)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    private var authority: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionLabel("AUTHORITY DECISION")
            HStack(alignment: .top, spacing: 18) {
                Image(systemName: "shield")
                    .font(.system(size: 22, weight: .regular))
                    .frame(width: 30, height: 28)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(item.authorityTitle)
                        .font(.system(size: 14, weight: .medium))
                    Text(item.authorityReason)
                        .font(.system(size: 12))
                        .foregroundStyle(secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var merchantResource: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionLabel("MERCHANT & RESOURCE")
            HStack(alignment: .top, spacing: 18) {
                Image(systemName: "cube")
                    .font(.system(size: 25, weight: .regular))
                    .foregroundStyle(secondaryInk)
                    .frame(width: 44, height: 44)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(item.providerName)
                        .font(.system(size: 14, weight: .medium))
                    if let resourceID = item.resourceID {
                        Text(resourceID)
                            .font(.system(size: 12))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let context = item.resourceContext {
                        Text(context)
                            .font(.system(size: 12))
                            .foregroundStyle(secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var receiptDetails: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("RECEIPT DETAILS")
            if let explorerURL = item.explorerURL {
                Link(destination: explorerURL) {
                    Label("View transaction on Solana Explorer", systemImage: "arrow.up.right.square")
                        .font(.system(size: 12))
                }
                .help("Opens the network recorded for this transaction")
            }
            VStack(spacing: 7) {
                ForEach(item.receipts) { receipt in
                    receiptRow(receipt)
                }
            }
        }
    }

    private var transactionContext: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("TRANSACTION CONTEXT")
            VStack(spacing: 7) {
                ForEach(item.facts) { fact in receiptRow(fact) }
            }
        }
    }

    private func receiptRow(_ receipt: PurchaseDetailPresentation.Receipt) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(receipt.label.uppercased())
                .font(.system(size: 9, weight: .medium))
                .tracking(1.1)
                .foregroundStyle(secondaryInk)
                .frame(width: 98, alignment: .leading)
            Text(receipt.value)
                .font(.system(size: 11))
                .foregroundStyle(secondaryInk)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .textSelection(.enabled)
                .accessibilityLabel(receipt.value)
            if let value = receipt.copyValue {
                Button {
                    onCopy(value)
                    copiedReceipt = receipt.id
                } label: {
                    Image(systemName: "square.on.square")
                        .font(.system(size: 12))
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(secondaryInk)
                .help("Copy \(receipt.label)")
                .accessibilityLabel("Copy \(receipt.label)")
                .accessibilityValue(copiedReceipt == receipt.id ? "Copied" : "")
            } else {
                Color.clear.frame(width: 22, height: 1)
                    .accessibilityHidden(true)
            }
        }
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .medium))
            .tracking(2)
            .foregroundStyle(secondaryInk)
            .accessibilityAddTraits(.isHeader)
    }

    private var hairline: some View {
        Rectangle().fill(rule).frame(height: 1)
            .accessibilityHidden(true)
    }

    private func marker(_ tone: PurchaseDetailPresentation.Tone) -> String {
        switch tone {
        case .success: "checkmark"
        case .negative: "xmark"
        case .pending: "ellipsis"
        case .neutral: "minus"
        }
    }

    private func signal(_ tone: PurchaseDetailPresentation.Tone) -> Color {
        switch tone {
        case .success: Color(red: 0.16, green: 0.64, blue: 0.52)
        case .pending: YoshShellPalette.pending
        case .negative: YoshShellPalette.negative
        case .neutral: secondaryInk
        }
    }
}
