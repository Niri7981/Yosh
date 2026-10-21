import SwiftUI

struct SpendGrantWheelColumn: View {
    let label: String
    let values: [Int]
    @Binding var selection: Int
    let reduceMotion: Bool
    let isExpanded: Bool
    let text: (Int) -> String

    @State private var position: Int?
    @FocusState private var focused: Bool
    @Environment(\.isEnabled) private var isEnabled

    static let viewportHeight: CGFloat = 90
    private static let rowHeight: CGFloat = viewportHeight / 3

    init(label: String, values: [Int], selection: Binding<Int>, reduceMotion: Bool, isExpanded: Bool,
        text: @escaping (Int) -> String) {
        self.label = label
        self.values = values
        _selection = selection
        self.reduceMotion = reduceMotion
        self.isExpanded = isExpanded
        self.text = text
        _position = State(initialValue: nil)
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(spacing: 0) {
                Color.clear.frame(height: Self.rowHeight).accessibilityHidden(true)
                ForEach(values, id: \.self) { value in
                    Button { choose(value) } label: {
                        Text(text(value))
                            .font(.system(size: 17, weight: .regular, design: .serif))
                            .monospacedDigit()
                            .foregroundStyle(YoshShellPalette.ink
                                .opacity(value == selection ? 1 : 0.45))
                            .frame(maxWidth: .infinity)
                            .frame(height: Self.rowHeight)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .focusable(false)
                    .id(value)
                }
                Color.clear.frame(height: Self.rowHeight).accessibilityHidden(true)
            }
            .scrollTargetLayout()
        }
        .scrollIndicators(.hidden)
        .transaction { $0.scrollContentOffsetAdjustmentBehavior = .disabled }
        .scrollTargetBehavior(.viewAligned(limitBehavior: .always))
        .scrollPosition(id: $position, anchor: .center)
        .frame(height: Self.viewportHeight)
        .background(alignment: .center) {
            RoundedRectangle(cornerRadius: 9)
                .fill(YoshShellPalette.selection)
                .frame(height: Self.rowHeight)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 9)
                .strokeBorder(focused ? Color.accentColor.opacity(0.7) : .clear, lineWidth: 1)
        }
        .contentShape(Rectangle())
        .focusable(isExpanded && isEnabled)
        .focused($focused)
        .onKeyPress(.upArrow) { guard isExpanded && isEnabled else { return .ignored }; step(-1); return .handled }
        .onKeyPress(.downArrow) { guard isExpanded && isEnabled else { return .ignored }; step(1); return .handled }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Expiration \(label.lowercased())")
        .accessibilityValue(text(selection))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: step(1)
            case .decrement: step(-1)
            @unknown default: break
            }
        }
        .accessibilityIdentifier("grant-expiry-\(label.lowercased())")
        .onChange(of: position) { _, value in
            if isExpanded && isEnabled, let value, values.contains(value), value != selection { selection = value }
        }
        .onChange(of: selection) { _, value in
            if isExpanded && position != value { position = value }
        }
        .onChange(of: isExpanded) { _, expanded in
            if expanded { position = selection } else { focused = false; position = nil }
        }
        .onChange(of: isEnabled) { _, enabled in
            if enabled && isExpanded { position = selection } else { focused = false }
        }
    }

    private func choose(_ value: Int) {
        guard isExpanded && isEnabled else { return }
        focused = true
        withAnimation(reduceMotion ? nil : YoshTabMotion.Expiry.selection) { position = value }
        selection = value
    }

    private func step(_ delta: Int) {
        guard let index = values.firstIndex(of: selection) else { return }
        choose(values[min(values.count - 1, max(0, index + delta))])
    }
}
