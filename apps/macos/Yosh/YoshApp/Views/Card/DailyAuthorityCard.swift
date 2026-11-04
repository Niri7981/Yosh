import SwiftUI

/// Edits the configured limit; all displayed accounting facts still come from the overview.
struct DailyAuthorityCard: View {
    let overview: AppOverview?
    let isBusy: Bool
    let isActive: Bool
    let scopeID: String?
    let onSave: @MainActor (String, String) async -> String?
    let onOpenDetails: () -> Void
    var onEditingChanged: (Bool) -> Void = { _ in }

    @State private var phase: Phase = .viewing
    @State private var draft = ""
    @State private var editingScope: String?
    @State private var discardAfterSave = false
    @State private var commandContext: CommandContext?
    @FocusState private var amountFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct CommandContext: Equatable {
        let scopeID: String?
        let isBusy: Bool
        let isActive: Bool
        let configuredLimit: Int64?
        let currency: String?
    }

    private enum Phase {
        case viewing
        case editing(error: String?)
        case saving

        var isEditing: Bool {
            if case .viewing = self { return false }
            return true
        }

        var isSaving: Bool {
            if case .saving = self { return true }
            return false
        }

        var error: String? {
            if case .editing(let error) = self { return error }
            return nil
        }
    }

    private var presentation: AuthorityOverviewPresentation? {
        overview.map { AuthorityOverviewPresentation($0) }
    }

    private var configuredLimit: Int64? {
        overview.flatMap { DailyAuthorityPresentation.configuredLimit(in: $0) }
    }

    private var currency: String? {
        overview.flatMap { DailyAuthorityPresentation(overview: $0).currency }
    }

    private var parsedDraft: String? { DailyAuthorityPresentation.minorUnits(draft) }

    private var context: CommandContext {
        CommandContext(scopeID: scopeID, isBusy: isBusy, isActive: isActive,
            configuredLimit: configuredLimit, currency: currency)
    }

    private var canSave: Bool {
        !phase.isSaving && !isBusy && isActive && editingScope == scopeID && scopeID != nil
            && currency != nil && parsedDraft != nil
            && (parsedDraft != configuredLimit.map(String.init) || phase.error != nil)
    }

    var body: some View {
        Group {
            if phase.isEditing {
                content
                    .onExitCommand(perform: cancel)
            } else {
                Button(action: beginEditing) { content }
                    .buttonStyle(.plain)
                    .disabled(overview == nil || isBusy || !isActive || scopeID == nil || currency == nil)
                    .accessibilityIdentifier("daily.inline.open")
                    .accessibilityLabel("Shared daily Authority, \(presentation?.remaining ?? "unavailable") available. Reserved \(presentation?.reserved ?? "unavailable"). Paid \(presentation?.paid ?? "unavailable"). \(presentation?.asset ?? ""). \(presentation?.dailyLimit ?? "Daily limit unavailable"). Change daily limit")
                    .accessibilityHint("Available is funds still available to spend today, shared by all Agents. Reserved holds funds for purchases in progress. Paid is payments confirmed today.")
                    .contextMenu {
                        Button("Wallet & Authority details…", action: onOpenDetails)
                            .accessibilityIdentifier("daily.inline.details")
                    }
            }
        }
        .help("Available: funds still available to spend today. Shared by all Agents. Reserved: funds held for purchases in progress. Paid: payments confirmed today.")
        .onChange(of: context, initial: true) { _, current in
            // Native submit handlers can outlive the view value that created the field.
            commandContext = current
            if phase.isEditing && (!current.isActive || (current.scopeID != nil && current.scopeID != editingScope)) {
                leaveEditor()
            }
        }
        .onChange(of: phase.isEditing) { _, editing in onEditingChanged(editing) }
        .onDisappear { onEditingChanged(false) }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                Text(phase.isEditing ? "DAILY LIMIT" : "AVAILABLE")
                    .font(.system(size: 10, weight: .medium))
                    .tracking(2.6)
                    .foregroundStyle(YoshShellPalette.secondaryInk)
                    .frame(height: CardPageHeader.Layout.titleTopOffset, alignment: .topLeading)
                if phase.isEditing {
                    editor
                } else {
                    Text(availableAmountTitle)
                        .font(.system(size: 74, weight: .regular, design: .serif))
                        .tracking(-2)
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .frame(maxWidth: .infinity, minHeight: 80, maxHeight: 80, alignment: .center)
                        .accessibilityAddTraits(.isHeader)
                }
            }

            authorityLine.padding(.top, 10)

            HStack(spacing: 8) {
                Text("Reserved \(presentation?.reserved ?? "—")").font(.system(size: 10))
                    .help("Funds held for purchases in progress")
                Text("Paid \(presentation?.paid ?? "—")").font(.system(size: 10))
                    .help("Payments confirmed today")
                Spacer(minLength: 0)
                Text(presentation?.dailyLimit ?? "of — daily").font(.system(size: 11)).lineLimit(1).minimumScaleFactor(0.7)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .medium))
                    .accessibilityHidden(true)
            }
            .font(.system(size: 13))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background {
            RoundedRectangle(cornerRadius: 22)
                .fill(YoshShellPalette.secondaryInk.opacity(0.018))
                .overlay {
                    RoundedRectangle(cornerRadius: 22)
                        .strokeBorder(YoshShellPalette.rule, lineWidth: 0.65)
                }
                .allowsHitTesting(false)
        }
        .contentShape(Rectangle())
    }

    private var editor: some View {
        VStack(spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                TextField("Daily limit", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 36, weight: .regular, design: .serif))
                    .monospacedDigit()
                    .focused($amountFocused)
                    .disabled(phase.isSaving)
                    .accessibilityIdentifier("daily.inline.input")
                    .accessibilityLabel("Daily limit")
                    .onSubmit(save)
                Text(currency ?? "USDC")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }
            .frame(height: 44)
            HStack(spacing: 8) {
                if let error = phase.error {
                    Text(error)
                        .font(.system(size: 10))
                        .foregroundStyle(.red)
                        .lineLimit(2)
                        .help(error)
                        .accessibilityIdentifier("daily.inline.error")
                }
                Spacer(minLength: 0)
                Button("Cancel", action: cancel)
                    .disabled(phase.isSaving)
                    .accessibilityIdentifier("daily.inline.cancel")
                Button(phase.isSaving ? "Saving…" : "Save", action: save)
                    .disabled(!canSave)
                    .accessibilityIdentifier("daily.inline.save")
            }
            .controlSize(.small)
            .frame(height: 28)
        }
        .frame(maxWidth: .infinity, minHeight: 80, maxHeight: 80)
        .task { if commandContext?.isActive == true && !phase.isSaving { amountFocused = true } }
    }

    private var authorityLine: some View {
        // This is a budget boundary, not a slider or payment-progress control.
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(YoshShellPalette.rule.opacity(0.35))
                    .frame(height: 1.5)
                if let presentation, overview?.budget.remaining != nil {
                    let endpoint = max(0, geometry.size.width - 6) * presentation.progress
                    Rectangle()
                        .fill(YoshShellPalette.activeInk.opacity(0.7))
                        .frame(width: endpoint + 3, height: 1.5)
                    Circle()
                        .fill(YoshShellPalette.activeInk)
                        .frame(width: 6, height: 6)
                        .offset(x: endpoint)
                }
            }
            .frame(height: 6)
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }

    private var availableAmountTitle: String {
        let amount = presentation?.remaining ?? "—"
        return amount.first?.isNumber == true ? "$\(amount)" : amount
    }

    private func beginEditing() {
        guard !isBusy, isActive, let scopeID, currency != nil else { return }
        draft = DailyAuthorityPresentation.editableLimit(configuredLimit)
        editingScope = scopeID
        discardAfterSave = false
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.12)) { phase = .editing(error: nil) }
    }

    private func cancel() {
        guard !phase.isSaving else { return }
        amountFocused = false
        draft = ""
        editingScope = nil
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.12)) { phase = .viewing }
    }

    private func leaveEditor() {
        if phase.isSaving { discardAfterSave = true }
        else { cancel() }
    }

    private func save() {
        guard phase.isEditing, !phase.isSaving, let current = commandContext, !current.isBusy, current.isActive,
              let editingScope, editingScope == current.scopeID, current.currency != nil, let amount = parsedDraft else { return }
        if amount == current.configuredLimit.map(String.init) {
            cancel()
            return
        }
        phase = .saving
        Task {
            let error = await onSave(amount, editingScope)
            // The callback confirms both the write and the authoritative refresh.
            if let error {
                phase = .editing(error: error)
                if discardAfterSave { cancel() }
                else { amountFocused = true }
            } else {
                phase = .editing(error: nil)
                cancel()
            }
        }
    }
}
