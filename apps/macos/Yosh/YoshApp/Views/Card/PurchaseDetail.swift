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
    @State private var transactionExpanded = false
    @State private var merchantExpanded = false
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
                .accessibilityIdentifier("purchase.back")

                summary.padding(.top, 24).padding(.bottom, 24)
                hairline
                lifecycle.padding(.vertical, 22)
                hairline
                VStack(spacing: 10) {
                    DisclosureGroup(isExpanded: $transactionExpanded) {
                        transactionDetails
                    } label: {
                        Label("Transaction details", systemImage: "doc.text")
                            .font(.system(size: 13))
                            .accessibilityIdentifier("purchase.transaction-details")
                    }
                    DisclosureGroup(isExpanded: $merchantExpanded) {
                        merchantResource
                    } label: {
                        Label("Merchant & resource", systemImage: "shippingbox")
                            .font(.system(size: 13))
                            .accessibilityIdentifier("purchase.merchant-resource")
                    }
                }
                .disclosureGroupStyle(PurchaseDetailDisclosureStyle())
                .padding(.top, 16)
            }
            .padding(.horizontal, 26)
            .padding(.top, 24)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.automatic)
        .foregroundStyle(ink)
    }

    private var summary: some View {
        HStack(alignment: .top, spacing: 14) {
            HostNetworkIcon(hostName: agentName, network: purchase.network, size: 64)
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 8) {
                    Text(item.title)
                        .font(.system(size: 27, weight: .regular, design: .serif))
                        .tracking(-0.6)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityAddTraits(.isHeader)
                    compactStatus
                }
                Text(ActivityPurchasePresentation(purchase).amount)
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
                if purchase.createdAt > 0 {
                    Text(ActivityPurchasePresentation(purchase).timestamp)
                        .font(.system(size: 11))
                        .foregroundStyle(secondaryInk)
                }
            }
        }
    }

    private var compactStatus: some View {
        Text(ActivityPurchasePresentation(purchase).compactStatus)
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
            sectionLabel("ACTIVITY")
            VStack(spacing: 0) {
                ForEach(Array(item.stages.enumerated()), id: \.element.id) { index, stage in
                    lifecycleStage(stage, connects: index < item.stages.count - 1)
                }
            }
        }
    }

    private func lifecycleStage(_ stage: PurchaseDetailPresentation.Stage, connects: Bool) -> some View {
        let tone: PurchaseDetailPresentation.Tone = stage.id == .approved && item.tone != .success ? .neutral : stage.tone
        return HStack(alignment: .top, spacing: 16) {
            VStack(spacing: 0) {
                ZStack {
                    Circle()
                        .fill(tone == .success ? signal(.success) : signal(tone).opacity(0.12))
                    Image(systemName: marker(tone))
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(tone == .success ? .white : signal(tone))
                }
                .frame(width: 16, height: 16)
                Rectangle()
                    .fill(connects ? signal(tone).opacity(0.55) : .clear)
                    .frame(width: 1)
            }
            .padding(.top, 2)
            .accessibilityHidden(true)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(timelineTitle(stage))
                    .font(.system(size: 14, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if let time = stage.time {
                    Text(time).font(.system(size: 11)).monospacedDigit()
                        .foregroundStyle(secondaryInk)
                }
            }
            .padding(.bottom, connects ? 22 : 0)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    private func timelineTitle(_ stage: PurchaseDetailPresentation.Stage) -> String {
        switch stage.id {
        case .approved: "Request allowed"
        case .paid: purchase.offline == true ? "Offline payment" : "Payment confirmed"
        case .delivered: "Resource delivered"
        case .deliveryPending: "Resource delivery pending"
        case .deliveryExhausted: "Resource not recovered"
        case .deliveryUnavailable: "Automatic recovery unavailable"
        default: stage.title
        }
    }

    private var transactionDetails: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(spacing: 8) {
                ForEach(item.facts) { receiptRow($0) }
                ForEach(item.receipts.filter { receipt in !item.facts.contains { $0.label == receipt.label } }) {
                    receiptRow($0)
                }
            }
            Text(item.authorityTitle).font(.system(size: 12, weight: .medium))
            Text(item.authorityReason).font(.system(size: 11)).foregroundStyle(secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(item.stages.filter { ![.approved, .paid, .delivered].contains($0.id) }) { stage in
                Text(stage.detail).font(.system(size: 11)).foregroundStyle(secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let explorerURL = item.explorerURL {
                Link(destination: explorerURL) {
                    Label("View transaction on Solana Explorer", systemImage: "arrow.up.right.square")
                        .font(.system(size: 12))
                }
                .help("Opens the network recorded for this transaction")
                .accessibilityIdentifier("purchase.explorer")
            }
        }
    }

    private var merchantResource: some View {
        VStack(alignment: .leading, spacing: 14) {
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

    private func receiptRow(_ receipt: PurchaseDetailPresentation.Receipt) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text((receipt.label == "Request ID" ? "Purchase ID" : receipt.label).uppercased())
                .font(.system(size: 9, weight: .medium))
                .tracking(1.1)
                .foregroundStyle(secondaryInk)
                .frame(width: 98, alignment: .leading)
            // Keep the selectable text's native label; an override can recursively query the same platform element.
            Text(receipt.value)
                .font(.system(size: 11))
                .foregroundStyle(secondaryInk)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .textSelection(.enabled)
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
                .accessibilityIdentifier("purchase.copy.\(receipt.id)")
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
