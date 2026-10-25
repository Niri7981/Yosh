import SwiftUI

/// Independent brand circles share proportions at every size. Unknown identities never borrow a merchant's brand.
struct HostNetworkIcon: View {
    let hostName: String
    let network: String?
    var size: CGFloat = 36

    static func hostAsset(for identity: String) -> String? {
        switch identity.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "codex", "openai", "openai codex": "ProviderOpenAI"
        case "claude", "claude code": "ProviderClaude"
        case "gemini", "gemini cli": "ProviderGemini"
        case "cursor", "cursor agent": "ProviderCursor"
        case "grok": "ProviderGrok"
        case "github copilot": "ProviderGitHub"
        default: nil
        }
    }

    static func networkAsset(for network: String?) -> String? {
        switch network {
        case "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
             "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "solana:devnet", "Solana Mainnet", "Solana Devnet": "NetworkSolana"
        default: nil
        }
    }

    var body: some View {
        let hostDiameter = size / 1.2
        let networkDiameter = hostDiameter * 0.65
        ZStack(alignment: .topLeading) {
            Circle().fill(.black)
                .overlay {
                    if let asset = Self.hostAsset(for: hostName) {
                        Image(asset).resizable().renderingMode(.template).scaledToFit()
                            .foregroundStyle(.white)
                            .padding(hostDiameter * (asset == "ProviderOpenAI" ? 0.02 : 0.22))
                    } else {
                        Image(systemName: "person.crop.circle").resizable().scaledToFit()
                            .foregroundStyle(.white.opacity(0.85)).padding(hostDiameter * 0.23)
                    }
                }
                .frame(width: hostDiameter, height: hostDiameter)
            Circle().fill(.black)
                .overlay {
                    if let asset = Self.networkAsset(for: network) {
                        Image(asset).resizable().scaledToFit().padding(networkDiameter * 0.22)
                    } else {
                        Image(systemName: "network").resizable().scaledToFit()
                            .foregroundStyle(.white.opacity(0.85)).padding(networkDiameter * 0.22)
                    }
                }
                .overlay(Circle().strokeBorder(YoshShellPalette.surface, lineWidth: max(1, size / 36)))
                .frame(width: networkDiameter, height: networkDiameter)
                .offset(x: hostDiameter * 0.55, y: hostDiameter * 0.55)
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(hostName), \(network ?? "Network unavailable")")
    }
}
