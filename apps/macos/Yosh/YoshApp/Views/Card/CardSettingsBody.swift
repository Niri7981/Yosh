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
    var development: PayDevelopmentSelection? = nil
    var isSwitchingEnvironment = false
    var onSelectEnvironment: (PayDevelopmentMode) -> Void = { _ in }
    var onSaveRPC: (String) -> Void = { _ in }
    var showsAdvanced = false
    var showsEnvironment = YoshPayDevelopment.isEnabled()
    var onBack: () -> Void = {}
    var onOpenAdvanced: () -> Void = {}
    var hostName = "Codex"
    var hostStatus = "Checking…"
    var onOpenConnection: () -> Void = {}
    private var unavailableValue: String { isLoading ? "Checking…" : "Unavailable" }
    private let rule = YoshShellPalette.rule

    var body: some View {
        VStack(alignment: .leading, spacing: CardPageHeader.Layout.firstSectionSpacing) {
            if showsAdvanced {
                Button("Settings", systemImage: "chevron.left", action: onBack)
                    .buttonStyle(.plain)
                    .foregroundStyle(YoshShellPalette.secondaryInk)
                    .accessibilityIdentifier("settings.advanced.back")
                Text("Advanced")
                    .font(.system(size: 38, weight: .regular, design: .serif))
                    .tracking(-1)
                    .foregroundStyle(YoshShellPalette.ink)
                    .accessibilityAddTraits(.isHeader)
            } else {
                CardPageHeader(title: "Settings", style: .hero(eyebrow: "PREFERENCES"))
                    .foregroundStyle(YoshShellPalette.ink)
            }
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 28) {
                    if !showsAdvanced {
                        home
                    } else {
                        advancedContent
                    }
                }
                .padding(.bottom, 12)
            }
            .scrollIndicators(.automatic)
        }
        .padding(.horizontal, CardPageHeader.Layout.contentInset)
        .padding(.top, showsAdvanced ? 16 : CardPageHeader.Layout.topSpacing)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private var advancedContent: some View {
        if showsEnvironment {
            SettingsEnvironmentSection(development: development, isSwitching: isSwitchingEnvironment,
                onSelect: onSelectEnvironment, onSaveRPC: onSaveRPC)
        }
        SettingsSection(title: "APPEARANCE", symbol: "sun.max", symbolSize: 22) {
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
        SettingsSection(title: "SECURITY", symbol: "lock", symbolSize: 22) {
            if let appLock, !YoshPayDevelopment.isEnabled() {
                YoshAppLockSettings(appLock: appLock)
                separator
            }
            SettingsRow(title: "Key storage", value: YoshPayDevelopment.isEnabled()
                ? development?.environment == .offline ? "Offline test key"
                    : development?.environment == .simulated ? "No signing" : "macOS Keychain" : "macOS Keychain")
            separator
            SettingsRow(title: "Local management", value: information == nil ? unavailableValue : "Protected")
        }
        SettingsSection(title: "DATA", symbol: "internaldrive", symbolSize: 22) {
            SettingsRow(title: "Storage", value: "Local on this Mac")
            separator
            dataFolderRow
        }
        SettingsSection(title: "ABOUT", symbol: "info.circle", symbolSize: 22) {
            SettingsRow(title: "Version", value: appVersion)
            separator
            SettingsRow(title: "GitHub", symbol: "arrow.up.right.square", showsChevron: true,
                action: onOpenRepository, symbolSize: 18)
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

    private var currentWallet: CardSettingsPresentation.ExistingWallet? {
        guard development?.environment != .simulated else { return nil }
        let id = development?.environment == .mainnet ? "mainnet" : "devnet"
        return information?.wallets.first { $0.id == id }
    }

    private var walletTitle: String {
        switch development?.environment {
        case .mainnet: "Mainnet wallet"
        case .devnet: "Devnet wallet"
        case .simulated: "Simulation"
        case .offline: "Offline wallet"
        case nil: "Wallet"
        }
    }

    private var fundsDescription: String {
        switch development?.environment {
        case .mainnet: "Real funds"
        case .devnet: "Test assets"
        case .simulated, .offline: "No real funds"
        case nil: unavailableValue
        }
    }

    private var home: some View {
        VStack(alignment: .leading, spacing: 12) {
            homeSection("Network") {
                homeLink(title: development?.environment.title ?? unavailableValue,
                    subtitle: fundsDescription,
                    symbol: "globe", action: onOpenAdvanced)
                    .accessibilityIdentifier("settings.network.open")
            }
            separator
            homeSection("Wallet") {
                HStack(spacing: 12) {
                    homeLink(title: walletTitle,
                        subtitle: development?.environment == .simulated ? "No signing" : currentWallet?.display ?? unavailableValue,
                        symbol: "wallet.bifold", action: onOpenWallets)
                        .accessibilityIdentifier("settings.wallets.open")
                    if let wallet = currentWallet, wallet.status == .available, let address = wallet.address, !address.isEmpty {
                        Button("Copy wallet address", systemImage: "square.on.square") { onCopyWallet(address) }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.plain)
                            .font(.system(size: 18))
                            .foregroundStyle(YoshShellPalette.secondaryInk)
                            .frame(width: 32, height: 44)
                            .accessibilityIdentifier("settings.wallet.\(wallet.id).copy")
                            .accessibilityValue(address)
                    }
                }
            }
            separator
            homeSection("Connected host") {
                homeLink(title: hostName, subtitle: hostStatus, symbol: "desktopcomputer", action: onOpenConnection)
                    .accessibilityIdentifier("settings.host.open")
            }
            separator
            homeSection("APIs") {
                homeLink(title: "Registered APIs", subtitle: nil, symbol: "network", action: onOpenResources)
                    .accessibilityIdentifier("settings.resources")
            }
            separator
            homeSection("General") {
                VStack(spacing: 0) {
                    SettingsRow(title: "Language", value: "English")
                        .help("English is the only language currently implemented.")
                    separator
                    unavailableToggle("Launch at login")
                    separator
                    unavailableToggle("Notifications")
                }
                .accessibilityIdentifier("settings.general")
            }
            separator
            homeLink(title: "Advanced", subtitle: nil, symbol: "slider.horizontal.3", action: onOpenAdvanced)
                .accessibilityIdentifier("settings.advanced.open")
            if let error {
                Text(error).font(.system(size: 11)).foregroundStyle(YoshShellPalette.negative)
                Button("Retry", action: onReload).buttonStyle(.plain).disabled(isLoading)
            }
        }
    }

    private func homeSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased()).font(.system(size: 10, weight: .medium))
                .tracking(2.2)
                .foregroundStyle(YoshShellPalette.secondaryInk)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func homeLink(title: String, subtitle: String?, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: symbol).font(.system(size: 22)).frame(width: 28)
                    .foregroundStyle(YoshShellPalette.activeInk).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(.system(size: 17, weight: .medium)).foregroundStyle(YoshShellPalette.ink)
                    if let subtitle {
                        Text(subtitle).font(.system(size: 14)).foregroundStyle(YoshShellPalette.secondaryInk)
                    }
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.system(size: 12))
                    .foregroundStyle(YoshShellPalette.secondaryInk).accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
    private var dataFolderRow: some View {
        if let directory = information?.dataDirectory {
            SettingsRow(title: "Open data folder", symbol: "folder", showsChevron: true,
                action: { onOpenDataFolder(directory) }, symbolSize: 18)
                .accessibilityIdentifier("settings.data-folder")
        } else {
            SettingsRow(title: "Open data folder", value: unavailableValue)
        }
    }
}
