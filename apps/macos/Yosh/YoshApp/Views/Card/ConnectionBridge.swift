import SwiftUI

/// Connect prepares a half bridge; only a verified host completes it.
struct ConnectionBridge: View {
    struct Input: Equatable {
        let observation: ConnectionMotionObservation?
        let isConnected: Bool
        var isWaiting = false
        let isActive: Bool
        let hasIssue: Bool
        let reduceMotion: Bool

        var connected: Bool { !hasIssue && (observation?.fact?.isConnected ?? isConnected) }
        var available: Bool {
            !hasIssue && (observation.map { $0.isPreparing || $0.fact?.isPrepared == true }
                ?? (isWaiting || isConnected))
        }
        var endpoint: CGFloat { connected ? 1 : available ? YoshTabMotion.Connection.waitingEndpoint : 0 }
    }

    let agentName: String
    let status: String
    let input: Input
    @State private var availability: CGFloat
    @State private var source: CGFloat
    @State private var travel: CGFloat
    @State private var destination: CGFloat
    @State private var connectedTint: CGFloat
    @State private var motionTask: Task<Void, Never>?

    private let signal = YoshShellPalette.activeInk
    private let secondaryInk = YoshShellPalette.secondaryInk
    private let rule = YoshShellPalette.rule

    init(agentName: String, status: String, input: Input) {
        self.agentName = agentName
        self.status = status
        self.input = input
        let connected: CGFloat = input.connected ? 1 : 0
        _availability = State(initialValue: input.available ? 1 : 0)
        _source = State(initialValue: connected)
        _travel = State(initialValue: input.endpoint)
        _destination = State(initialValue: connected)
        _connectedTint = State(initialValue: connected)
    }

    var body: some View {
        VStack(spacing: 10) {
            GeometryReader { geometry in
                if input.isActive && !input.hasIssue {
                    diagram(width: geometry.size.width, availability: availability, source: source,
                        travel: travel, destination: destination, tint: connectedTint)
                } else {
                    // A parked/error surface cannot retain or resume native interpolation.
                    let connected: CGFloat = input.connected ? 1 : 0
                    diagram(width: geometry.size.width, availability: input.available ? 1 : 0,
                        source: connected, travel: input.endpoint, destination: connected, tint: connected)
                }
            }
            .frame(height: 10)
            HStack {
                Text(agentName).lineLimit(1)
                Spacer(minLength: 12)
                Text("Yosh")
            }
            .font(.system(size: 12))
            .foregroundStyle(secondaryInk)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(agentName) to Yosh")
        .accessibilityValue(status)
        .onAppear { withAnimation(nil) { rest(input) } }
        .onChange(of: input) { old, new in update(from: old, to: new) }
        .onDisappear {
            motionTask?.cancel()
            withAnimation(nil) { rest(input) }
        }
    }

    private func diagram(width: CGFloat, availability: CGFloat, source: CGFloat,
        travel: CGFloat, destination: CGFloat, tint: CGFloat) -> some View {
        let endpoint = input.reduceMotion ? input.endpoint : travel
        return ZStack(alignment: .topLeading) {
            bridgePath(width: width)
                .stroke(rule, style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                .opacity(1 - tint)
            bridgePath(width: width).trim(from: 0, to: endpoint)
                .stroke(signal.opacity(0.45), style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                .transaction { if input.reduceMotion { $0.animation = nil } }
                .opacity(availability * (1 - tint))
            bridgePath(width: width).trim(from: 0, to: endpoint)
                .stroke(signal.opacity(0.45), lineWidth: 1.5)
                .transaction { if input.reduceMotion { $0.animation = nil } }
                .opacity(tint)
            node(emphasis: source, availability: availability)
            node(emphasis: destination, availability: availability).offset(x: width - 10)
            Circle().fill(signal).frame(width: 6, height: 6)
                .opacity(tint).offset(x: width / 2 - 3, y: 2)
        }
    }

    private func bridgePath(width: CGFloat) -> Path {
        Path { path in
            path.move(to: CGPoint(x: 5, y: 5))
            path.addLine(to: CGPoint(x: width - 5, y: 5))
        }
    }

    private func node(emphasis: CGFloat, availability: CGFloat) -> some View {
        Circle().strokeBorder(secondaryInk, lineWidth: 1.5)
            .opacity(YoshTabMotion.Connection.idleNodeOpacity
                + availability * (1 - YoshTabMotion.Connection.idleNodeOpacity))
            .overlay {
                Circle().strokeBorder(signal.opacity(YoshTabMotion.Connection.waitingNodeTint), lineWidth: 1.5)
                    .opacity(availability)
            }
            .overlay { Circle().fill(signal).opacity(emphasis) }
            .frame(width: 10, height: 10)
    }

    private func rest(_ input: Input) {
        availability = input.available ? 1 : 0
        travel = input.endpoint
        source = input.connected ? 1 : 0
        destination = source
        connectedTint = source
    }

    private func update(from old: Input, to new: Input) {
        let sameMember = old.observation?.fact?.memberID == new.observation?.fact?.memberID
        let visible = new.isActive && old.isActive && !new.hasIssue && !old.hasIssue && sameMember
        let newEvent = old.observation?.transition != new.observation?.transition
        // Confirming Waiting or ending the request must leave preparation already in flight alone.
        if visible, old.reduceMotion == new.reduceMotion, !newEvent,
           old.endpoint == new.endpoint, old.available == new.available, old.connected == new.connected { return }
        motionTask?.cancel()
        guard visible else {
            withAnimation(nil) { rest(new) }
            return
        }
        if new.reduceMotion {
            withAnimation(YoshTabMotion.Connection.reduced) { rest(new) }
            return
        }
        guard newEvent, let event = new.observation?.transition else {
            withAnimation(nil) { rest(new) }
            return
        }
        switch event.direction {
        case .connect, .waiting:
            // Codex's actual arrival/loss gets only a short completion/tint settle.
            withAnimation(YoshTabMotion.Connection.connected) { rest(new) }
        case .prepare:
            guard new.observation?.isPreparing == true, !new.connected else {
                withAnimation(nil) { rest(new) }
                return
            }
            motionTask = Task { @MainActor in
                withAnimation(YoshTabMotion.Connection.physical(YoshTabMotion.Connection.acknowledgementDuration)) {
                    availability = 1
                }
                do { try await Task.sleep(for: .seconds(YoshTabMotion.Connection.entryLead)) } catch { return }
                guard !Task.isCancelled else { return }
                withAnimation(YoshTabMotion.Connection.physical(YoshTabMotion.Connection.entryTravel)) {
                    travel = YoshTabMotion.Connection.waitingEndpoint
                }
            }
        case .disconnect:
            motionTask = Task { @MainActor in
                withAnimation(YoshTabMotion.Connection.physical(YoshTabMotion.Connection.acknowledgementDuration)) {
                    destination = 0
                }
                do { try await Task.sleep(for: .seconds(YoshTabMotion.Connection.exitLead)) } catch { return }
                guard !Task.isCancelled else { return }
                withAnimation(YoshTabMotion.Connection.physical(YoshTabMotion.Connection.exitTravel)) { travel = 0 }
                do { try await Task.sleep(for: .seconds(YoshTabMotion.Connection.exitTravel)) } catch { return }
                guard !Task.isCancelled else { return }
                withAnimation(YoshTabMotion.Connection.physical(YoshTabMotion.Connection.exitSettle)) { rest(new) }
            }
        }
    }
}

/// Native ButtonStyle preserves keyboard activation/focus and adds local contact feedback.
struct ConnectionRequestButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? YoshTabMotion.Connection.pressOpacity : 1)
            .scaleEffect(reduceMotion || !configuration.isPressed ? 1 : YoshTabMotion.Connection.pressScale,
                anchor: .leading)
            .animation(YoshTabMotion.Connection.physical(YoshTabMotion.Connection.acknowledgementDuration),
                value: configuration.isPressed)
    }
}
