import Foundation

struct WalletLibraryPresentation: Decodable {
    let wallets: [CardSettingsPresentation.ExistingWallet]
    let library: [SavedWallet]
    let executionMode: String

    struct SavedWallet: Decodable, Identifiable {
        let id: String
        let label: String
        let address: String?
        let kind: String
        let status: String

        var description: String {
            if status == "setup_pending" { return "Setup unfinished" }
            return kind == "watch" ? "Watch only" : "Saved on this Mac"
        }
    }
}

struct AddWalletRequest: Encodable {
    let requestId: String
    let label: String
    let kind: String
    var privateKey: String? = nil
    var address: String? = nil
}
