import AppKit
import SwiftUI

enum YoshShellPalette {
    static let shape = RoundedRectangle(cornerRadius: 30, style: .continuous)
    // Named dynamic colors follow the native appearance, including menus and fields.
    static func adaptive(_ name: String, light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        Color(nsColor: NSColor(name: NSColor.Name(name)) { appearance in
            let rgb = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: rgb.0, green: rgb.1, blue: rgb.2, alpha: 1)
        })
    }
    static let surface = adaptive("Yosh.surface", light: (0.961, 0.973, 0.980), dark: (0.098, 0.098, 0.090))
    static let ink = adaptive("Yosh.ink", light: (0.07, 0.10, 0.15), dark: (0.937, 0.925, 0.894))
    static let secondaryInk = adaptive("Yosh.secondary", light: (0.37, 0.45, 0.54), dark: (0.690, 0.675, 0.639))
    static let activeInk = adaptive("Yosh.active", light: (0.30, 0.44, 0.65), dark: (0.773, 0.592, 0.400))
    static let boundary = adaptive("Yosh.boundary", light: (0.53, 0.63, 0.73), dark: (0.580, 0.545, 0.486)).opacity(0.22)
    static let rule = adaptive("Yosh.rule", light: (0.73, 0.79, 0.87), dark: (0.329, 0.314, 0.282)).opacity(0.5)
    static let negative = adaptive("Yosh.negative", light: (0.58, 0.28, 0.31), dark: (0.88, 0.59, 0.61))
    static let positive = adaptive("Yosh.positive", light: (0.18, 0.38, 0.38), dark: (0.54, 0.78, 0.73))
    static let pending = adaptive("Yosh.pending", light: (0.47, 0.39, 0.23), dark: (0.80, 0.72, 0.51))
    static let frontSurface = adaptive("Yosh.front", light: (0.925, 0.925, 0.925), dark: (0.118, 0.118, 0.110)).opacity(0.9)
    static let positiveWash = adaptive("Yosh.positiveWash", light: (0.67, 0.87, 0.85), dark: (0.18, 0.32, 0.30))
    static let negativeWash = adaptive("Yosh.negativeWash", light: (0.85, 0.71, 0.73), dark: (0.38, 0.23, 0.25))
    static let pendingWash = adaptive("Yosh.pendingWash", light: (0.85, 0.80, 0.62), dark: (0.34, 0.30, 0.20))
    static let selection = adaptive("Yosh.selection", light: (0.76, 0.82, 0.92), dark: (0.388, 0.294, 0.196)).opacity(0.55)

}

struct CardMaterial: View {

    var body: some View {
        YoshShellPalette.shape
            .fill(YoshShellPalette.surface)
            .overlay {
                YoshShellPalette.shape.strokeBorder(YoshShellPalette.boundary, lineWidth: 0.75)
            }
    }
}
