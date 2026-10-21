import SwiftUI

struct CardSettingsBody: View {
    let information: CardSettingsPresentation?
    let appVersion: String
    let isLoading: Bool
    let error: String?
    let onCopyWallet: (String) -> Void
    let onOpenDataFolder: (URL) -> Void
    let onOpenRepository: () -> Void
    let onReload: () -> Void
    var appLock: YoshAppLock? = nil
    @AppStorage("yosh.appearance") private var appearance = "system"
    var onOpenWallets: () -> Void = {}
    var onOpenResources: () -> Void = {}

    private var unavailableValue: String { isLoading ? "Checking…" : "Unavailable" }
    private let rule = YoshShellPalette.rule

    var body: some View {
        VStack(alignment: .leading, spacing: CardPageHeader.Layout.firstSectionSpacing) {
            CardPageHeader(title: "Settings", style: .collection(subtitle: "Manage Yosh on this Mac."))
                .foregroundStyle(YoshShellPalette.ink)
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 28) {
                    SettingsSection(title: "WALLETS", symbol: "wallet.bifold", action: onOpenWallets) {
                        if let information {
                            ForEach(information.wallets) { wallet in
                                existingWalletRow(wallet)
                                if wallet.id != information.wallets.last?.id { separator }
                            }
                            if information.wallets.isEmpty { walletRow }
                        } else {
                            SettingsRow(title: "Mainnet", value: unavailableValue)
                            separator
                            SettingsRow(title: "Devnet · Test", value: unavailableValue)
                        }
                        Text("Manage wallets on this Mac.")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    SettingsSection(title: "APIS", symbol: "network") {
                        SettingsRow(title: "Registered APIs", showsChevron: true, action: onOpenResources)
                            .accessibilityIdentifier("settings.resources")
                    }
                    SettingsSection(title: "GENERAL", symbol: "gearshape") {
                        SettingsRow(title: "Language", value: "English")
                            .help("English is the only language currently implemented.")
                        separator
                        unavailableToggle("Launch at login")
                        separator
                        unavailableToggle("Notifications")
                    }
                    SettingsSection(title: "APPEARANCE", symbol: "sun.max") {
                        Picker("Appearance", selection: $appearance) {
                            Text("System").tag("system")
                            Text("Light").tag("light")
                            Text("Dark").tag("dark")
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("settings.appearance")
                        .padding(.vertical, 10)
                        separator
                        SettingsRow(title: "Reduce motion", value: "Follow System")
                            .help("Yosh follows the macOS Reduce Motion accessibility setting.")
                    }
                    SettingsSection(title: "SECURITY", symbol: "lock") {
                        if let appLock {
                            YoshAppLockSettings(appLock: appLock)
                            separator
                        }
                        SettingsRow(title: "Key storage", value: "macOS Keychain")
                        separator
                        SettingsRow(title: "Local management", value: information == nil ? unavailableValue : "Protected")
                    }
                    SettingsSection(title: "DATA", symbol: "internaldrive") {
                        SettingsRow(title: "Storage", value: "Local on this Mac")
                        separator
                        dataFolderRow
                    }
                    SettingsSection(title: "ABOUT", symbol: "info.circle") {
                        SettingsRow(title: "Version", value: appVersion)
                        separator
                        SettingsRow(title: "GitHub", symbol: "arrow.up.right.square", showsChevron: true,
                            action: onOpenRepository)
                            .accessibilityIdentifier("settings.github")
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        if let error {
                            Text(error)
                                .font(.system(size: 11))
                                .foregroundStyle(YoshShellPalette.negative)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Button(error == nil ? "Refresh status" : "Retry", action: onReload)
                            .buttonStyle(.plain)
                            .font(.system(size: 11))
                            .foregroundStyle(YoshShellPalette.secondaryInk)
                            .disabled(isLoading)
                    }
                }
                .padding(.bottom, 12)
            }
            .scrollIndicators(.automatic)
        }
        .padding(.horizontal, CardPageHeader.Layout.contentInset)
        .padding(.top, CardPageHeader.Layout.topSpacing)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var separator: some View {
        Rectangle().fill(rule).frame(height: 1).accessibilityHidden(true)
    }

    private func unavailableToggle(_ title: String) -> some View {
        HStack(spacing: 12) {
            Text(title).foregroundStyle(YoshShellPalette.ink)
            Spacer(minLength: 4)
            Text("Not available yet")
                .font(.system(size: 11))
                .foregroundStyle(YoshShellPalette.secondaryInk)
            Toggle(title, isOn: .constant(false))
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.mini)
                .disabled(true)
                .accessibilityHint("This feature is not implemented.")
        }
        .font(.system(size: 13))
        .frame(minHeight: 38)
        .help("This feature is not available in Yosh yet.")
    }

    @ViewBuilder
    private func existingWalletRow(_ wallet: CardSettingsPresentation.ExistingWallet) -> some View {
        if wallet.status == .available, let address = wallet.address, !address.isEmpty {
            SettingsRow(title: wallet.label, value: wallet.display, symbol: "square.on.square",
                actionLabel: "Copy \(wallet.label) wallet address", action: { onCopyWallet(address) })
                .accessibilityValue(address)
                .accessibilityIdentifier("settings.wallet.\(wallet.id).copy")
                .help("Copy the full public wallet address")
        } else {
            SettingsRow(title: wallet.label, value: wallet.display)
        }
    }

    @ViewBuilder
    private var walletRow: some View {
        if let information, !information.walletAddress.isEmpty {
            SettingsRow(title: "Wallet address", value: information.shortWalletAddress, symbol: "square.on.square",
                actionLabel: "Copy wallet address", action: { onCopyWallet(information.walletAddress) })
                .accessibilityValue(information.walletAddress)
                .accessibilityIdentifier("settings.wallet.copy")
                .help("Copy the full public wallet address")
        } else {
            SettingsRow(title: "Wallet address", value: isLoading ? "Checking…" : "Wallet unavailable")
        }
    }

    @ViewBuilder
    private var dataFolderRow: some View {
        if let directory = information?.dataDirectory {
            SettingsRow(title: "Open data folder", symbol: "folder", showsChevron: true,
                action: { onOpenDataFolder(directory) })
                .accessibilityIdentifier("settings.data-folder")
        } else {
            SettingsRow(title: "Open data folder", value: unavailableValue)
        }
    }
}
