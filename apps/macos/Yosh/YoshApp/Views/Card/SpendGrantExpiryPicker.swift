import SwiftUI

/// macOS has no WheelPickerStyle. Native scroll views own inertia, snapping and input;
/// this component adds only the inline date/time arrangement and selection semantics.
struct SpendGrantExpiryPicker: View {
    @Binding var selection: Date
    let reduceMotion: Bool
    @Environment(\.isEnabled) private var isEnabled
    @State private var expanded = false
    @State private var referenceDate = Date.now

    private let calendar = Calendar.current
    private let secondaryInk = YoshShellPalette.secondaryInk
    private let rule = YoshShellPalette.rule

    var body: some View {
        VStack(spacing: 8) {
            Button {
                referenceDate = .now
                withAnimation(reduceMotion ? .easeOut(duration: YoshTabMotion.Expiry.reducedDuration)
                    : YoshTabMotion.Expiry.expansion) { expanded.toggle() }
            } label: {
                HStack(spacing: 12) {
                    Text("Expires").font(.system(size: 12)).foregroundStyle(secondaryInk)
                    Spacer(minLength: 0)
                    Text(selection.formatted(.dateTime.month(.abbreviated).day()) + " · "
                        + selection.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)))
                        .font(.system(size: 15)).monospacedDigit()
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .medium))
                        .rotationEffect(.degrees(expanded && !reduceMotion ? 180 : 0))
                        .foregroundStyle(secondaryInk)
                }
                .padding(.horizontal, 15)
                .frame(height: 42)
                .contentShape(Capsule())
                .background(YoshShellPalette.selection, in: .capsule)
                .overlay { Capsule().strokeBorder(rule, lineWidth: 1) }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Expires")
            .accessibilityValue(selection.formatted(date: .complete, time: .shortened))
            .accessibilityHint(expanded ? "Collapse date and time picker" : "Expand date and time picker")
            .accessibilityIdentifier("grant-expiry-trigger")

            HStack(spacing: 8) {
                SpendGrantWheelColumn(label: "Day", values: dayValues, selection: daySelection,
                    reduceMotion: reduceMotion, isExpanded: expanded,
                    text: { Date(timeIntervalSince1970: TimeInterval($0)).formatted(.dateTime.month(.abbreviated).day()) })
                    .frame(maxWidth: .infinity)
                separator
                SpendGrantWheelColumn(label: "Hour", values: Array(0...23), selection: hourSelection,
                    reduceMotion: reduceMotion, isExpanded: expanded,
                    text: { String(format: "%02d", $0) })
                    .frame(width: 72)
                separator
                SpendGrantWheelColumn(label: "Minute", values: Array(0...59), selection: minuteSelection,
                    reduceMotion: reduceMotion, isExpanded: expanded,
                    text: { String(format: "%02d", $0) })
                    .frame(width: 72)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(secondaryInk.opacity(0.025), in: .rect(cornerRadius: 14))
            .frame(height: expanded ? SpendGrantWheelColumn.viewportHeight + 16 : 0)
            .transaction { if reduceMotion { $0.animation = nil } }
            .opacity(expanded ? 1 : 0)
            .clipped()
            .disabled(!expanded)
            .allowsHitTesting(expanded)
            .accessibilityHidden(!expanded)
            .onKeyPress(.escape) {
                guard expanded && isEnabled else { return .ignored }
                expanded = false
                return .handled
            }
            if expanded {
                Text("Local time · up to 7 days")
                    .font(.system(size: 10))
                    .foregroundStyle(secondaryInk)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .transition(.opacity)
            }
        }
    }

    private var separator: some View {
        Rectangle().fill(rule).frame(width: 1, height: 58).accessibilityHidden(true)
    }

    private var dayValues: [Int] {
        let start = calendar.startOfDay(for: referenceDate)
        return (0...7).compactMap { calendar.date(byAdding: .day, value: $0, to: start) }
            .map { Int($0.timeIntervalSince1970) }
    }

    private var daySelection: Binding<Int> {
        Binding(get: { Int(calendar.startOfDay(for: selection).timeIntervalSince1970) }, set: { value in
            setTime(on: Date(timeIntervalSince1970: TimeInterval(value)),
                hour: calendar.component(.hour, from: selection), minute: calendar.component(.minute, from: selection))
        })
    }

    private var hourSelection: Binding<Int> {
        Binding(get: { calendar.component(.hour, from: selection) }, set: { hour in
            setTime(on: selection, hour: hour, minute: calendar.component(.minute, from: selection))
        })
    }

    private var minuteSelection: Binding<Int> {
        Binding(get: { calendar.component(.minute, from: selection) }, set: { minute in
            setTime(on: selection, hour: calendar.component(.hour, from: selection), minute: minute)
        })
    }

    private func setTime(on date: Date, hour: Int, minute: Int) {
        // Calendar resolves skipped/repeated local times; never add fixed 24-hour days.
        if let date = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: date) {
            selection = date
        }
    }
}
