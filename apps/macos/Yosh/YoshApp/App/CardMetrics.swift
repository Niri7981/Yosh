import CoreGraphics

enum CardMetrics {
    static let cardSize = CGSize(width: 420, height: 684)
    // The native window is the card; no transparent gutter outside its surface.
    static let windowSize = cardSize
}
