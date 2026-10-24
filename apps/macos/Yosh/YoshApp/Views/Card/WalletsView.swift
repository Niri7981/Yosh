import AppKit
import SwiftUI

struct WalletsView: View {
    let client: OverviewClient
    let isActive: Bool
    let onBack: () -> Void
    let onChanged: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var navigation = YoshDetailNavigation<String>()
    @State private var snapshot: WalletLibraryPresentation?
    @State private var error: String?
    @State private var saving = false
    @State private var name = ""
    @State private var privateKey = ""
    @State private var publicAddress = ""
    @State private var confirmPaymentWallet = false
    @AppStorage("yosh.walletSetup.requestID") private var requestID = ""
    @AppStorage("yosh.walletSetup.kind") private var draftKind = ""
    @AppStorage("yosh.walletSetup.name") private var draftName = ""

    var body: some View {
        YoshDetailStack(navigation: navigation, reduceMotion: reduceMotion) {
            page("Wallets", back: "Settings", action: onBack) {
                if let snapshot {
                    SettingsSection(title: "PAYMENT WALLETS", symbol: "wallet.bifold") {
                        ForEach(snapshot.wallets) { wallet in
                            VStack(alignment: .leading, spacing: 6) {
                                SettingsRow(title: wallet.label, value: wallet.display,
                                    symbol: wallet.address == nil ? nil : "square.on.square",
                                    action: wallet.address.map { address in { copy(address) } })
                                if wallet.status == .available {
                                    Text(isSelected(wallet.id, mode: snapshot.executionMode)
                                        ? "Current payment wallet" : "Available in its execution mode")
                                        .font(.system(size: 11)).foregroundStyle(YoshShellPalette.secondaryInk)
                                }
                            }.padding(.bottom, 10)
                            Divider()
                        }
                        if YoshPayDevelopment.isEnabled(), snapshot.executionMode == "live_mainnet",
                           snapshot.wallets.contains(where: { $0.id == "mainnet" && $0.status == .missing }) {
                            Button("Create Wallet", systemImage: "plus") { confirmPaymentWallet = true }
                                .disabled(saving).accessibilityIdentifier("wallets.create-payment-wallet")
                            note("Create your Mainnet payment wallet in macOS Keychain. It starts empty; payments remain disabled.")
                        }
                    }
                    if !snapshot.library.isEmpty {
                        SettingsSection(title: "SAVED WALLETS", symbol: "tray") {
                            ForEach(snapshot.library) { wallet in
                                VStack(alignment: .leading, spacing: 6) {
                                    SettingsRow(title: wallet.label, value: wallet.description,
                                        showsChevron: true, action: { navigation.show(wallet.id) })
                                    if let address = wallet.address {
                                        Text(short(address)).font(.system(size: 12, design: .monospaced))
                                            .foregroundStyle(YoshShellPalette.secondaryInk)
                                    }
                                }.padding(.bottom, 12)
                                Divider()
                            }
                        }
                    }
                } else if error == nil {
                    ProgressView("Loading wallets…").controlSize(.small)
                }
                if !(YoshPayDevelopment.isEnabled() && snapshot?.executionMode == "live_mainnet"
                     && snapshot?.wallets.contains(where: { $0.id == "mainnet" && $0.status == .missing }) == true) {
                SettingsSection(title: "ADD WALLET", symbol: "plus") {
                    SettingsRow(title: "Create new wallet", symbol: "plus", showsChevron: true,
                        action: { start("create") }).accessibilityIdentifier("wallets.create")
                    Divider()
                    SettingsRow(title: "Import private key", symbol: "key", showsChevron: true,
                        action: { start("import") }).accessibilityIdentifier("wallets.import")
                    Divider()
                    SettingsRow(title: "Add watch address", symbol: "eye", showsChevron: true,
                        action: { start("watch") }).accessibilityIdentifier("wallets.watch")
                }
                note("Adding a wallet does not change the payment wallet or its spending permissions.")
                }
                Button("Refresh") { Task { await reload() } }.buttonStyle(.plain)
                    .foregroundStyle(YoshShellPalette.activeInk)
            }
        } destination: { route in
            if ["create", "import", "watch"].contains(route) {
                editor(route)
            } else if let wallet = snapshot?.library.first(where: { $0.id == route }) {
                page(wallet.label, back: "Wallets", action: back) {
                    Text(wallet.description).font(.system(size: 13)).foregroundStyle(YoshShellPalette.secondaryInk)
                    if let address = wallet.address {
                        Text(address).font(.system(size: 13, design: .monospaced)).textSelection(.enabled)
                        Button("Copy address", systemImage: "square.on.square") { copy(address) }
                        SettingsRow(title: "Network", value: "Solana")
                        note(wallet.kind == "watch" ? "This is a public address only. Yosh cannot sign or pay with it."
                            : "The key is stored in macOS Keychain on this Mac. This wallet is not selected for payments.")
                        note("Payment wallet switching is not available yet. Existing grants and purchases remain with their original wallet.")
                    } else {
                        note("The setup was interrupted. Resume with the same name and private key if importing.")
                        Button("Resume setup") {
                            requestID = wallet.id; draftKind = wallet.kind; draftName = wallet.label
                            name = wallet.label; navigation.show(wallet.kind)
                        }
                    }
                }
            }
        }
        .task(id: isActive) { if isActive { await reload() } }
        .alert("Create Mainnet wallet?", isPresented: $confirmPaymentWallet) {
            Button("Cancel", role: .cancel) {}
            Button("Create Wallet") { Task { await createPaymentWallet() } }
        } message: {
            Text("Creates an empty wallet for this Mainnet profile. Existing wallets are unchanged. No transfer, signing or purchase will occur.")
        }
        .onDisappear { privateKey = "" }
    }

    private func editor(_ kind: String) -> some View {
        page(kind == "create" ? "New wallet" : kind == "import" ? "Import wallet" : "Watch address", back: "Wallets", action: back) {
            TextField("Wallet name", text: $name).textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("wallets.name")
                .onChange(of: name) { _, value in if !saving { draftName = value } }
            if kind == "import" {
                SecureField("Base58 private key", text: $privateKey).textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("wallets.private-key")
                note("Enter a Solana Base58 private key, such as one exported from Phantom. Seed phrases are not supported.")
            } else if kind == "watch" {
                TextField("Solana public address", text: $publicAddress).textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("wallets.address")
                note("View and copy this address. A public address does not grant payment access.")
            } else {
                note("Create an independent Solana wallet. Its private key stays in macOS Keychain on this Mac.")
                note("This version has no key export or recovery phrase. Do not fund this saved wallet until you have a backup method.")
            }
            note("Your current payment wallet and spending permissions stay the same.")
            Button(saving ? "Saving…" : kind == "create" ? "Create wallet" : "Save wallet") {
                Task { await save(kind) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || (kind == "import" && privateKey.isEmpty) || (kind == "watch" && publicAddress.isEmpty))
            .accessibilityIdentifier("wallets.save")
        }
        .disabled(saving)
    }

    private func page<Content: View>(_ title: String, back: String, action: @escaping () -> Void,
                                     @ViewBuilder content: () -> Content) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Button(back, systemImage: "chevron.left", action: action).buttonStyle(.plain)
                    .foregroundStyle(YoshShellPalette.secondaryInk).disabled(saving)
                Text(title).font(.system(size: 38, weight: .regular, design: .serif))
                content()
                if let error { Text(error).font(.system(size: 12)).foregroundStyle(YoshShellPalette.negative) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 26).padding(.top, 24).padding(.bottom, 20)
        }
    }
    private func note(_ text: String) -> some View {
        Text(text).font(.system(size: 12)).foregroundStyle(YoshShellPalette.secondaryInk)
            .fixedSize(horizontal: false, vertical: true)
    }
    private func start(_ kind: String) {
        if requestID.isEmpty || draftKind != kind { requestID = UUID().uuidString.lowercased(); draftKind = kind; draftName = "" }
        name = draftName; privateKey = ""; publicAddress = ""; error = nil; navigation.show(kind)
    }
    private func back() { privateKey = ""; error = nil; navigation.show(nil) }
    private func isSelected(_ id: String, mode: String) -> Bool { id == (mode == "live_mainnet" ? "mainnet" : "devnet") }
    private func short(_ address: String) -> String { "\(address.prefix(8))…\(address.suffix(4))" }
    private func copy(_ address: String) {
        NSPasteboard.general.clearContents()
        if !NSPasteboard.general.setString(address, forType: .string) { error = "The address could not be copied." }
    }
    @MainActor private func reload() async {
        do {
            let configuration = try await client.runtime.ready()
            let (data, response) = try await configuration.request(.wallets)
            guard response.statusCode == 200 else { throw ServiceRuntimeError.unavailable }
            snapshot = try JSONDecoder().decode(WalletLibraryPresentation.self, from: data)
            error = nil
        } catch { self.error = "Wallets could not be loaded. Try refreshing." }
    }
    @MainActor private func save(_ kind: String) async {
        guard !saving else { return }
        saving = true; error = nil
        defer { saving = false; privateKey = "" }
        let input = AddWalletRequest(requestId: requestID, label: name.trimmingCharacters(in: .whitespacesAndNewlines), kind: kind,
            privateKey: kind == "import" ? privateKey.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
            address: kind == "watch" ? publicAddress.trimmingCharacters(in: .whitespacesAndNewlines) : nil)
        do {
            let configuration = try await client.runtime.ready()
            let (data, response) = try await configuration.request(.addWallet(input), timeout: 70)
            guard response.statusCode == 201 else {
                error = (try? JSONDecoder().decode(WalletFailure.self, from: data))?.error ?? "Wallet setup could not finish. Retry the same request."
                return
            }
            requestID = ""; draftKind = ""; draftName = ""
            await reload(); onChanged(); navigation.show(nil)
        } catch { self.error = "Wallet setup could not finish. Retry to check the same request." }
    }
    @MainActor private func createPaymentWallet() async {
        guard !saving else { return }
        saving = true; error = nil
        defer { saving = false }
        do {
            let configuration = try await client.runtime.ready()
            let (data, response) = try await configuration.request(.createDevelopmentPaymentWallet, timeout: 70)
            guard response.statusCode == 201 else {
                error = (try? JSONDecoder().decode(WalletFailure.self, from: data))?.error ?? "Wallet setup was not completed. Retry to check the same wallet."
                return
            }
            await reload(); onChanged()
        } catch { self.error = "Wallet setup was not completed. Allow Keychain access and retry." }
    }
    private struct WalletFailure: Decodable { let error: String }
}
