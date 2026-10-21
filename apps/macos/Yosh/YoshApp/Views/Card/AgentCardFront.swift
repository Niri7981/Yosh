import SwiftUI

struct AgentCardFront: View {
    let identity: AgentIdentity?
    let onFlip: () -> Void
    var pinLength = 4
    var appLock: YoshAppLock? = nil

    @FocusState private var passwordFocused: Bool

    var body: some View {
        Color.clear
            .frame(width: CardMetrics.cardSize.width, height: CardMetrics.cardSize.height)
            .allowsHitTesting(false)
            .background {
                RoundedRectangle(cornerRadius: 30, style: .continuous)
                    .fill(YoshShellPalette.frontSurface)
                    .padding(1)
                    .allowsHitTesting(false)
            }
            .overlay(alignment: .topLeading) {
                Text("Yosh")
                    .font(.system(size: 46, weight: .regular, design: .serif))
                    .tracking(-0.8)
                    .foregroundStyle(Color(nsColor: .labelColor).opacity(0.96))
                    .padding(.leading, 36)
                    .padding(.top, 48)
            }
            .overlay(alignment: .topTrailing) {
                CardFlipButton(action: flipCard)
                    .disabled(appLock != nil && appLock?.isUnlocked != true)
                    .padding(.trailing, 36)
                    .padding(.top, 50)
            }
            .overlay {
                YoshSpiritView(posture: passwordFocused ? .protective : .idle)
                    .frame(width: 260, height: 374)
                    .offset(y: 17)
                    .allowsHitTesting(false)
            }
            .overlay(alignment: .bottom) {
                YoshLockEntry(appLock: appLock, isFocused: $passwordFocused, pinLength: pinLength)
                    .padding(.bottom, 36)
            }
            .foregroundStyle(Color(nsColor: .labelColor).opacity(0.88))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("YoshFront")
    }

    private func flipCard() {
        guard appLock == nil || appLock?.isUnlocked == true else { return }
        passwordFocused = false
        onFlip()
    }
}

#Preview("Yosh front") {
    AgentCardFront(identity: nil, onFlip: {})
        .background(CardMaterial())
        .environment(\.colorScheme, .light)
}

struct CardFlipButton: View {
    let action: () -> Void

    var body: some View {
        Button("Flip Agent Card", systemImage: "arrow.triangle.2.circlepath", action: action)
            .labelStyle(.iconOnly)
            .font(.system(size: 25, weight: .light))
            .frame(width: 34, height: 34)
            .contentShape(Rectangle())
            .buttonStyle(CardIconButtonStyle())
    }
}

struct CardIconButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Color(nsColor: configuration.isPressed ? .labelColor : .secondaryLabelColor))
            .scaleEffect(reduceMotion ? 1 : (configuration.isPressed ? 0.98 : 1))
            .animation(
                reduceMotion
                    ? nil
                    : (configuration.isPressed
                        ? .easeOut(duration: 0.075)
                        : .interactiveSpring(response: 0.25, dampingFraction: 0.85)),
                value: configuration.isPressed
            )
    }
}
