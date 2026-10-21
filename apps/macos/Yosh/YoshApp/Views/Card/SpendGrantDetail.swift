import SwiftUI

struct SpendGrantDetail: View {
    let overview: AppOverview
    let isSaving: Bool
    let isRefreshing: Bool
    let writeMessage: String?
    let writeFailed: Bool
    let onBack: () -> Void
    let onConnection: () -> Void
    let onCreate: (String, String, Int64, String?, ResourceRequestSample?, String?) async -> Void
    let onRevoke: (String?) async -> Void
    let onPreparePost: (String, ResourceRequestSample?) async throws -> PostRequestReview

    @State private var preparingPost = false
    @State private var postReview: PostRequestReview?
    @State private var pendingPostGrant: PendingPostGrant?
    private struct PendingPostGrant {
        let total: String, single: String
        let expiresAt: Int64
        let resourceID: String
        let sample: ResourceRequestSample?
    }
    @State private var draft: SpendGrantDraft
    @State private var selectedResourceID = ""
    @State private var sampleQuery = ""
    @State private var sampleBody = ""
    @State private var showingAPIDetails = false
    @State private var inputError: String?
    @State private var showingRevokeConfirmation = false
    @FocusState private var focusedAmount: AmountField?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum AmountField { case total, perTransaction }
    private let ink = YoshShellPalette.ink
    private let secondaryInk = YoshShellPalette.secondaryInk
    private let rule = YoshShellPalette.rule

    init(overview: AppOverview, isSaving: Bool, isRefreshing: Bool = false, writeMessage: String?, writeFailed: Bool,
        onBack: @escaping () -> Void, onConnection: @escaping () -> Void,
        onCreate: @escaping (String, String, Int64, String?, ResourceRequestSample?, String?) async -> Void, onRevoke: @escaping (String?) async -> Void,
        onPreparePost: @escaping (String, ResourceRequestSample?) async throws -> PostRequestReview = { _, _ in throw URLError(.badURL) }) {
        self.overview = overview
        self.isSaving = isSaving
        self.isRefreshing = isRefreshing
        self.writeMessage = writeMessage
        self.writeFailed = writeFailed
        self.onBack = onBack
        self.onConnection = onConnection
        self.onCreate = onCreate
        self.onRevoke = onRevoke
        self.onPreparePost = onPreparePost
        _draft = State(initialValue: SpendGrantDraft(grant: overview.scopedGrant))
    }

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

                titleArea.padding(.top, 10).padding(.bottom, 18)
                currentGrant.padding(.bottom, 18)
                hairline
                createGrant.padding(.top, 16)
            }
            .padding(.horizontal, 26)
            .padding(.top, 24)
            .padding(.bottom, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .disabled(preparingPost)
        .sheet(item: $postReview) { review in
            PostRequestApprovalView(review: review,
                grantSummary: pendingPostGrant.map { "Resource: \($0.resourceID)\nTotal: \(SpendGrantDraft.decimal(Int64($0.total) ?? 0, decimals: 6)) USDC · Per transaction: \(SpendGrantDraft.decimal(Int64($0.single) ?? 0, decimals: 6)) USDC" },
                onApprove: {
                    guard let pending = pendingPostGrant else { return }
                    pendingPostGrant = nil; postReview = nil
                    Task { await onCreate(pending.total, pending.single, pending.expiresAt, pending.resourceID, pending.sample, review.requestHash) }
                }, onCancel: { pendingPostGrant = nil; postReview = nil })
        }
        .foregroundStyle(ink)
        .onChange(of: selectedResourceID) { _, id in
            let sample = overview.service.registeredResources?.first(where: { $0.resourceId == id })?.submission?.sample
            sampleQuery = sample?.queryText ?? ""
            sampleBody = sample?.bodyText ?? ""
            showingAPIDetails = false
            inputError = nil
        }
        .onChange(of: overview.scopedGrant?.id) { _, _ in
            draft = SpendGrantDraft(grant: overview.scopedGrant)
            inputError = nil
        }
        .confirmationDialog("Revoke this Spend Grant?", isPresented: $showingRevokeConfirmation) {
            Button("Revoke Spend Grant", role: .destructive) { Task { await onRevoke(isMainnet ? selectedResourceID : nil) } }
        } message: {
            Text("New purchase requests will be denied until you create another Spend Grant. The Agent connection stays active.")
        }
    }

    private var titleArea: some View {
        HStack(alignment: .center, spacing: 12) {
            Text("Spend Grant")
                .font(.system(size: 34, weight: .regular, design: .serif))
                .tracking(-0.8)
                .fixedSize(horizontal: true, vertical: false)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 5) {
                Text(status)
                    .foregroundStyle(overview.scopedGrant?.status == .expired
                        ? YoshShellPalette.negative : secondaryInk)
                Text("\(overview.service.purchaseMode.title) · \(currency ?? "Asset unavailable")")
                    .foregroundStyle(secondaryInk)
            }
            .font(.system(size: 10))
            .fixedSize()
        }
    }

    private var currentGrant: some View {
        VStack(alignment: .leading, spacing: 0) {
            eyebrow("SPEND GRANTS")
            if let grant = displayedGrant {
                let scopedGrant = overview.selectedAuthority?.grant?.id == grant.id ? overview.selectedAuthority?.grant : nil
                if isMainnet, let resourceID = grant.resourceId {
                    Text(resourceID).font(.system(size: 11)).padding(.top, 6)
                    if let api = scopedGrant?.api {
                        Text(api).font(.system(size: 10)).foregroundStyle(secondaryInk)
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(scopedGrant?.totalDisplay ?? SpendGrantDraft.decimal(grant.totalLimit.value, decimals: grant.assetDecimals))
                        .font(.system(size: 27, weight: .regular, design: .serif))
                        .monospacedDigit()
                    Text(currency ?? "Unknown asset")
                        .font(.system(size: 12)).foregroundStyle(secondaryInk)
                }
                .padding(.top, 8)
                .accessibilityElement(children: .combine)
                HStack(alignment: .top, spacing: 16) {
                    summary("Per transaction", value: SpendGrantDraft.decimal(grant.singleLimit.value, decimals: grant.assetDecimals))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    summary("Remaining", value: scopedGrant?.remainingDisplay ?? (grant.status == .active
                        ? SpendGrantDraft.decimal(grant.remaining.value, decimals: grant.assetDecimals) : "—"))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityHint(grant.status == .active ? "Within this Spend Grant" : "Unavailable for an inactive grant")
                    let expiry = Date(timeIntervalSince1970: TimeInterval(grant.expiresAt) / 1_000)
                    summary("Expires", value: expiry.formatted(.dateTime.month(.abbreviated).day()),
                        detail: expiry.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityValue(expiry.formatted(date: .complete, time: .shortened))
                }
                .padding(.top, 13)
                if let scoped = scopedGrant {
                    Text("Committed \(scoped.committedDisplay) \(scoped.assetLabel)")
                        .font(.system(size: 10)).foregroundStyle(secondaryInk).padding(.top, 9)
                }
            } else {
                Text("Choose a resource to inspect its Spend Grant")
                    .font(.system(size: 14)).foregroundStyle(secondaryInk)
                    .padding(.top, 12)
            }
            ForEach((overview.grants ?? []).filter { $0.id != displayedGrant?.id && $0.status == .active }, id: \.id) { other in
                HStack {
                    Text(other.resourceId ?? "Resource").lineLimit(1)
                    Spacer()
                    Text(SpendGrantDraft.decimal(other.remaining.value, decimals: other.assetDecimals)).monospacedDigit()
                }
                .font(.system(size: 11)).foregroundStyle(secondaryInk).padding(.top, 9)
            }
        }
    }

    private var createGrant: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Create Spend Grant")
                .font(.system(size: 29, weight: .regular, design: .serif))
                .tracking(-0.5)
                .accessibilityAddTraits(.isHeader)
            if isMainnet {
                Picker("Registered API", selection: $selectedResourceID) {
                    Text("Choose an API").tag("")
                    ForEach(overview.service.registeredResources ?? []) { resource in
                        Text((resource.name ?? resource.resourceId) + (resource.source == "agent" ? " · Agent-submitted" : ""))
                            .lineLimit(1).truncationMode(.tail).tag(resource.resourceId)
                    }
                }
                .frame(maxWidth: .infinity)
                .disabled(isSaving)
                .accessibilityIdentifier("grant-resource")
                .padding(.top, 12)
                if let resource = overview.service.registeredResources?.first(where: { $0.resourceId == selectedResourceID }) {
                    resourceSummary(resource).padding(.top, 10)
                    DisclosureGroup(isExpanded: $showingAPIDetails) {
                        apiDetails(resource).padding(.top, 8)
                    } label: {
                        Text("View API Details").font(.system(size: 11)).foregroundStyle(secondaryInk)
                    }
                    .tint(secondaryInk)
                    .disabled(isSaving)
                    .accessibilityIdentifier("grant-api-details")
                    .transaction { if reduceMotion { $0.animation = nil } }
                    .padding(.top, 10)
                    if let keys = resource.requestInputs?.query?.names, !keys.isEmpty {
                        sampleInput("Sample query", keys: keys, text: $sampleQuery, identifier: "grant-sample-query")
                            .padding(.top, 12)
                    }
                    if let keys = resource.requestInputs?.jsonBody?.names, !keys.isEmpty {
                        sampleInput("Sample JSON body", keys: keys, text: $sampleBody, identifier: "grant-sample-body")
                            .padding(.top, 12)
                    }
                }
            }
            HStack(alignment: .top, spacing: 24) {
                amountField("Total authorized", text: $draft.total, field: .total)
                amountField("Per transaction", text: $draft.perTransaction, field: .perTransaction)
            }
            .padding(.top, 16)
            SpendGrantExpiryPicker(selection: $draft.expiration, reduceMotion: reduceMotion)
                .disabled(isSaving)
                .padding(.top, 16)

            if !overview.connection.enabled {
                Button(action: onConnection) {
                    HStack(spacing: 6) {
                        Circle().fill(secondaryInk).frame(width: 4, height: 4)
                        Text("Connection required")
                        Image(systemName: "arrow.up.right").font(.system(size: 9))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .font(.system(size: 11)).foregroundStyle(secondaryInk)
                .disabled(isSaving)
                .accessibilityHint("Open Connection to enable this agent")
                .padding(.top, 12)
            }
            Button(action: saveGrant) {
                Text(isSaving ? "Saving…" : isReplacing ? "Replace Spend Grant" : "Create Spend Grant")
                    .font(.system(size: 13))
                    .frame(maxWidth: .infinity)
                    .frame(height: 35)
                    .contentShape(Capsule())
                    .overlay { Capsule().strokeBorder(secondaryInk.opacity(0.45), lineWidth: 1) }
            }
            .buttonStyle(.plain)
            // Reads must not disable native text/wheel controls and reset their
            // focus/scroll state. Only submission waits for the in-flight read.
            .disabled(isSaving || isRefreshing || !overview.connection.enabled || currency == nil || (isMainnet && selectedResourceID.isEmpty))
            .accessibilityIdentifier("grant-create")
            .padding(.top, 12)

            if overview.connection.enabled {
                Text(isReplacing ? "Replaces the active Spend Grant · connection stays active" : "Connection stays active · purchases require this Spend Grant")
                    .font(.system(size: 10)).foregroundStyle(secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 9)
            }
            if isReplacing {
                Button("Revoke Spend Grant", role: .destructive) { showingRevokeConfirmation = true }
                    .buttonStyle(.plain)
                    .font(.system(size: 11))
                    .foregroundStyle(YoshShellPalette.negative)
                    .disabled(isSaving || isRefreshing)
                    .padding(.top, 14)
            }
            if let message = inputError ?? writeMessage {
                Text(message)
                    .font(.system(size: 12))
                    .foregroundStyle(inputError != nil || writeFailed
                        ? YoshShellPalette.negative : secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.updatesFrequently)
                    .padding(.top, 12)
            }
        }
    }

    private func resourceSummary(_ resource: AppOverview.Service.RegisteredResource) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(resource.name ?? resource.resourceId)
                .font(.system(size: 13, weight: .medium))
                .fixedSize(horizontal: false, vertical: true)
            Text("\(resource.method ?? "GET") · Solana Mainnet · USDC")
                .font(.system(size: 10)).foregroundStyle(secondaryInk)
            if let maximum = resource.maximumPriceDisplay {
                Text("Maximum · \(maximum)").font(.system(size: 11)).foregroundStyle(secondaryInk)
            } else if let base = resource.basePriceDisplay {
                Text("Base price · \(base)").font(.system(size: 11)).foregroundStyle(secondaryInk)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("grant-resource-summary")
    }

    private func apiDetails(_ resource: AppOverview.Service.RegisteredResource) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            hairline
            apiFact("Endpoint", value: resource.url)
            apiFact("Resource ID", value: resource.resourceId)
            apiFact("Provider", value: resource.providerId)
            apiFact("Network", value: resource.network)
            apiFact("Asset", value: "\(resource.assetId)\n\(resource.assetDecimals) decimals")
            if let base = resource.basePriceDisplay { apiFact("Base price", value: base) }
            apiFact("Recipient", value: resource.recipient ?? "Verified when you create the Grant")
            if resource.source == "agent" {
                apiFact("Source", value: "Agent-submitted · review before authorizing spending")
            }
            if let submission = resource.submission {
                if !submission.documentation.urls.isEmpty {
                    apiFact("Documentation", value: submission.documentation.urls.joined(separator: "\n"))
                }
                if !submission.documentation.uncertainties.isEmpty {
                    apiFact("Unconfirmed", value: submission.documentation.uncertainties.joined(separator: "\n"))
                }
            }
            if let policy = resource.requestInputs, let text = inputPolicyText(policy) {
                apiFact("Input policy", value: text, monospaced: true)
            }
            hairline
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("grant-api-details-content")
    }

    private func inputPolicyText(_ policy: RegisterAPIRequest.Inputs) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(policy) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func apiFact(_ label: String, value: String, monospaced: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 10)).foregroundStyle(secondaryInk)
            Text(value)
                .font(.system(size: 11, design: monospaced ? .monospaced : .default))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sampleInput(_ label: String, keys: [String], text: Binding<String>, identifier: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.system(size: 11)).foregroundStyle(secondaryInk)
            Text(keys.joined(separator: ", "))
                .font(.system(size: 10)).foregroundStyle(secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
            TextField("{\"\(keys[0])\":\"sample\"}", text: text, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12))
                .lineLimit(1...3)
                .accessibilityLabel(label)
                .accessibilityHint("JSON object · Fields: \(keys.joined(separator: ", "))")
                .accessibilityIdentifier(identifier)
        }
    }

    private var isReplacing: Bool {
        if !isMainnet { return overview.scopedGrant?.status == .active }
        return (overview.grants ?? []).contains { $0.resourceId == selectedResourceID && $0.status == .active }
    }
    private var displayedGrant: AppOverview.Grant? {
        if isMainnet && !selectedResourceID.isEmpty { return overview.grants?.first { $0.resourceId == selectedResourceID } }
        return overview.scopedGrant
    }
    private var isMainnet: Bool { overview.service.purchaseMode == .liveMainnet }
    private var currency: String? { DailyAuthorityPresentation(overview: overview).currency }
    private var status: String {
        switch overview.scopedGrant?.status {
        case .active: "Active"
        case .revoked: "Revoked"
        case .expired: "Expired"
        case nil: "Not set"
        }
    }

    private var hairline: some View {
        Rectangle().fill(rule).frame(height: 1).accessibilityHidden(true)
    }

    private func eyebrow(_ title: String) -> some View {
        Text(title).font(.system(size: 9, weight: .medium)).tracking(1.8)
            .foregroundStyle(secondaryInk)
    }

    private func summary(_ label: String, value: String, detail: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.system(size: 10)).foregroundStyle(secondaryInk)
            Text(value).font(.system(size: 13)).monospacedDigit()
            if let detail { Text(detail).font(.system(size: 10)).foregroundStyle(secondaryInk) }
        }
        .accessibilityElement(children: .combine)
    }

    private func amountField(_ label: String, text: Binding<String>, field: AmountField) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.system(size: 11)).foregroundStyle(secondaryInk)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                TextField("0.00", text: text)
                    .textFieldStyle(.plain)
                    .font(.system(size: 23, weight: .regular, design: .serif))
                    .monospacedDigit()
                    .focused($focusedAmount, equals: field)
                    .disabled(isSaving || currency == nil)
                    .accessibilityLabel("\(label) in \(currency ?? "units")")
                    .accessibilityIdentifier(field == .total ? "grant-total" : "grant-per-transaction")
                Text(currency ?? "—").font(.system(size: 10)).foregroundStyle(secondaryInk)
            }
            Rectangle().fill(focusedAmount == field ? secondaryInk : rule).frame(height: 1)
                .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func saveGrant() {
        guard !isSaving, !isRefreshing, overview.connection.enabled, currency != nil, !isMainnet || !selectedResourceID.isEmpty else { return }
        guard let total = SpendGrantDraft.minorUnits(draft.total), total != "0",
              let single = SpendGrantDraft.minorUnits(draft.perTransaction), single != "0" else {
            inputError = "Enter positive amounts with up to 6 decimal places."
            return
        }
        guard let totalValue = Int64(total), let singleValue = Int64(single), singleValue <= totalValue else {
            inputError = "Per transaction must fit within total authorized."
            return
        }
        let now = Date.now
        guard draft.expiration > now.addingTimeInterval(60), draft.expiration <= now.addingTimeInterval(7 * 24 * 60 * 60) else {
            inputError = "Choose an expiry more than 1 minute and up to 7 days away."
            return
        }
        inputError = nil
        let expiresAt = Int64(draft.expiration.timeIntervalSince1970 * 1_000)
        let sample: ResourceRequestSample?
        do { sample = isMainnet ? try ResourceRequestSample.parse(queryText: sampleQuery, bodyText: sampleBody) : nil }
        catch { inputError = "Enter valid JSON objects for the sample request."; return }
        let resourceID = selectedResourceID
        if isMainnet, overview.service.registeredResources?.first(where: { $0.resourceId == resourceID })?.method == "POST" {
            preparingPost = true
            Task {
                defer { preparingPost = false }
                do {
                    let review = try await onPreparePost(resourceID, sample)
                    pendingPostGrant = .init(total: total, single: single, expiresAt: expiresAt, resourceID: resourceID, sample: sample)
                    postReview = review
                } catch { inputError = (error as? OverviewLoadError)?.message ?? "The POST request could not be prepared safely." }
            }
        } else { Task { await onCreate(total, single, expiresAt, isMainnet ? resourceID : nil, sample, nil) } }
    }
}
