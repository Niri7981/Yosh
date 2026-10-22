import CFNetwork
import Darwin
import Foundation
import Security

struct BackendLaunchConfiguration {
    let environment: [String: String]
    let bundleURL: URL
    var developmentHome: URL = FileManager.default.homeDirectoryForCurrentUser
    func developmentRoot() throws -> URL { try YoshPayDevelopment.dataDirectory(home: developmentHome) }

    /// Validate every alias before loading credentials or launching a child. Inherited
    /// management-token aliases are checked too, although production uses Keychain.
    func normalizedEnvironment() throws -> [String: String] {
        var resolved = environment
        let suffixes = Set(environment.keys.compactMap { key -> String? in
            if key.hasPrefix("YOSH_") { return String(key.dropFirst(5)) }
            if key.hasPrefix("APP2049_") { return String(key.dropFirst(8)) }
            return nil
        })
        for suffix in suffixes {
            let canonical = "YOSH_\(suffix)"
            let legacy = "APP2049_\(suffix)"
            if let current = environment[canonical], let previous = environment[legacy], current != previous {
                throw ServiceRuntimeError.configuration
            }
            if let value = environment[canonical] ?? environment[legacy] {
                resolved[canonical] = value
                resolved[legacy] = value
            }
        }
        return resolved
    }

    func configuredValue(_ suffix: String) throws -> String? {
        try normalizedEnvironment()["YOSH_\(suffix)"]
    }

    var isPayDevelopment: Bool { YoshPayDevelopment.isEnabled(bundleURL: bundleURL) }

    func servicePort() throws -> Int {
        if isPayDevelopment { return 13049 }
        let raw = try configuredValue("PORT") ?? "3049"
        guard let port = Int(raw), (1024...65535).contains(port), String(port) == raw else {
            throw ServiceRuntimeError.configuration
        }
        return port
    }

    func runtimeDirectory() throws -> URL {
        let directory = bundleURL.appending(path: "Contents/Resources/Runtime", directoryHint: .isDirectory)
        guard FileManager.default.fileExists(atPath: directory.appending(path: "backend/server.js").path),
              FileManager.default.fileExists(atPath: directory.appending(path: "mcp.cjs").path) else {
            throw ServiceRuntimeError.configuration
        }
        return directory
    }

    func nodeExecutable() throws -> URL {
        _ = try runtimeDirectory()
        let path = bundleURL.appending(path: "Contents/MacOS/YoshBackendNode").path
        guard FileManager.default.isExecutableFile(atPath: path) else {
            throw ServiceRuntimeError.configuration
        }
        return URL(fileURLWithPath: path)
    }

    func validToken(_ token: String) -> Bool {
        token.utf8.count >= 32 && !token.contains("\r") && !token.contains("\n")
    }

    private func safeFacilitatorSetting(_ raw: String) -> Bool {
        // The backend classifies malformed URLs in payment readiness while
        // remaining available. The native boundary only limits child-env data.
        raw.utf8.count <= 2048 && !raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    }

    func managementToken() throws -> String {
        _ = try normalizedEnvironment()
        if isPayDevelopment { return try YoshPayDevelopment.managementToken(directory: dataDirectory()) }
        return try BackendManagementIdentity.loadOrCreate()
    }

    func dataDirectory() throws -> URL {
        if isPayDevelopment {
            let root = try developmentRoot()
            let profile = try YoshPayDevelopment.selection(directory: root)
            let directory = profile.environment == .mainnet ? root.appending(path: "Mainnet", directoryHint: .isDirectory) : root
            try YoshPayDevelopment.ensurePrivateDirectory(directory)
            return directory
        }
        // Retain one ledger/wallet/config store; branding must never create a new store.
        let support = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Application Support")
        let legacy = support.appending(path: "2049")
        let selected = FileManager.default.fileExists(atPath: legacy.appending(path: "app-ledger.sqlite").path)
            ? legacy : support.appending(path: "Yosh")
        let path = try configuredValue("DATA_DIR") ?? selected.path
        guard path.hasPrefix("/"), !path.utf8.contains(0) else { throw ServiceRuntimeError.configuration }
        let standardized = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
        guard let resolved = Darwin.realpath(standardized.path, nil) else { return standardized }
        defer { Darwin.free(resolved) }
        return URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
    }

    func childEnvironment(token: String) throws -> [String: String] {
        var childEnvironment: [String: String] = ["HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "NODE_ENV": "production",
            "HOSTNAME": "127.0.0.1", "PORT": String(try servicePort())]
        guard validToken(token) else { throw ServiceRuntimeError.configuration }
        // Both spellings share the same Keychain identity for old/new backend consumers.
        childEnvironment["YOSH_MANAGEMENT_TOKEN"] = token
        childEnvironment["APP2049_MANAGEMENT_TOKEN"] = token
        let directory = try dataDirectory().path
        childEnvironment["YOSH_DATA_DIR"] = directory
        childEnvironment["APP2049_DATA_DIR"] = directory
        childEnvironment["YOSH_PACKAGED_RUNTIME_DIR"] = try runtimeDirectory().path
        if isPayDevelopment {
            let home = URL(fileURLWithPath: directory).appending(path: "home", directoryHint: .isDirectory)
            try YoshPayDevelopment.ensurePrivateDirectory(home)
            childEnvironment["HOME"] = home.path
            childEnvironment["YOSH_PAY_DEV"] = "1"
            let profile = try YoshPayDevelopment.selection(directory: developmentRoot())
            childEnvironment["YOSH_PAY_DEV_ENV"] = profile.environment.rawValue
            childEnvironment["YOSH_ENABLE_MAINNET_EXECUTION"] = "0"
            childEnvironment["APP2049_ENABLE_MAINNET_EXECUTION"] = "0"
            if profile.environment == .mainnet {
                childEnvironment["YOSH_PAY_MCP_MAINNET"] = "1"
                childEnvironment["YOSH_EXECUTION_MODE"] = "live_mainnet"
                childEnvironment["SOLANA_MAINNET_RPC_URL"] = profile.rpcUrl
                let settings = URL(fileURLWithPath: directory).appending(path: "product-configuration.json")
                if FileManager.default.fileExists(atPath: settings.path) {
                    let attributes = try FileManager.default.attributesOfItem(atPath: settings.path)
                    guard attributes[.type] as? FileAttributeType == .typeRegular,
                          (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
                          (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,
                          let values = try JSONSerialization.jsonObject(with: Data(contentsOf: settings)) as? [String: String],
                          Set(values.keys).isSubset(of: ["YOSH_ENABLE_MAINNET_EXECUTION", "YOSH_MAINNET_RESOURCES", "YOSH_MAINNET_WALLET_PUBLIC_KEY"]),
                          values["YOSH_ENABLE_MAINNET_EXECUTION"].map({ $0 == "0" || $0 == "1" }) ?? true else { throw ServiceRuntimeError.configuration }
                    childEnvironment.merge(values) { _, value in value }
                    childEnvironment["APP2049_ENABLE_MAINNET_EXECUTION"] = childEnvironment["YOSH_ENABLE_MAINNET_EXECUTION"]
                }
                childEnvironment["NODE_USE_ENV_PROXY"] = "1"
                addSystemProxyIfNeeded(to: &childEnvironment)
            }
            childEnvironment["NO_PROXY"] = "localhost,127.0.0.1,::1"
            return childEnvironment
        }
        let configuration = URL(fileURLWithPath: directory).appending(path: "product-configuration.json")
        let exists = FileManager.default.fileExists(atPath: configuration.path)
            || (try? FileManager.default.destinationOfSymbolicLink(atPath: configuration.path)) != nil
        if exists {
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: configuration.path) else {
                throw ServiceRuntimeError.configuration
            }
            guard (attributes[.type] as? FileAttributeType) == .typeRegular,
                  (((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077) == 0,
                  (attributes[.ownerAccountID] as? NSNumber)?.intValue == Int(getuid()),
                  let settings = try JSONSerialization.jsonObject(with: Data(contentsOf: configuration)) as? [String: String],
                  Set(settings.keys).isSubset(of: ["YOSH_MAINNET_RESOURCES", "YOSH_ENABLE_MAINNET_EXECUTION", "YOSH_PAY_MCP_MAINNET", "YOSH_MAINNET_WALLET_PUBLIC_KEY", "SOLANA_MAINNET_RPC_URL", "X402_FACILITATOR_URL"]),
                  settings["YOSH_PAY_MCP_MAINNET"].map({ $0 == "0" || $0 == "1" }) ?? true,
                  settings["YOSH_ENABLE_MAINNET_EXECUTION"].map({ $0 == "0" || $0 == "1" }) ?? true,
                  settings["X402_FACILITATOR_URL"].map(safeFacilitatorSetting) ?? true else {
                throw ServiceRuntimeError.configuration
            }
            childEnvironment.merge(settings) { _, product in product }
        }
        childEnvironment["NODE_USE_ENV_PROXY"] = "1"
        addSystemProxyIfNeeded(to: &childEnvironment)
        childEnvironment["NO_PROXY"] = [environment["NO_PROXY"] ?? environment["no_proxy"], "localhost", "127.0.0.1", "::1"]
            .compactMap { $0 }.joined(separator: ",")
        return childEnvironment
    }

    func sandboxProfile() throws -> URL? {
        guard isPayDevelopment else { return nil }
        let mode = try YoshPayDevelopment.selection(directory: developmentRoot()).environment
        let profile = try runtimeDirectory().appending(path: mode == .mainnet ? "pay-dev-mainnet.sb" : "pay-dev.sb")
        guard FileManager.default.fileExists(atPath: profile.path) else { throw ServiceRuntimeError.configuration }
        return profile
    }

    func addSystemProxyIfNeeded(to childEnvironment: inout [String: String]) {
        guard childEnvironment["HTTPS_PROXY"] == nil, childEnvironment["https_proxy"] == nil,
              let settings = CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? NSDictionary,
              (settings[kCFNetworkProxiesHTTPSEnable as NSString] as? NSNumber)?.intValue == 1,
              let host = settings[kCFNetworkProxiesHTTPSProxy as NSString] as? String,
              host.range(of: "^[a-zA-Z0-9.-]+$", options: .regularExpression) != nil,
              let port = (settings[kCFNetworkProxiesHTTPSPort as NSString] as? NSNumber)?.intValue,
              (1...65535).contains(port) else { return }
        let proxy = "http://\(host):\(port)"
        childEnvironment["HTTPS_PROXY"] = proxy
        childEnvironment["HTTP_PROXY"] = childEnvironment["HTTP_PROXY"] ?? proxy
    }

}

private enum BackendManagementIdentity {
    // This is an existing installation secret, not public branding.
    private static let service = "com.twentyfortynine.backend-management.v1"
    private static let account = "local-installation"

    static func loadOrCreate() throws -> String {
        if let existing = try read() { return existing }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw ServiceRuntimeError.configuration
        }
        let token = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let item: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData: Data(token.utf8),
        ]
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem,
              let saved = try read() else { throw ServiceRuntimeError.configuration }
        return saved
    }

    private static func read() throws -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8),
              token.utf8.count >= 32, !token.contains("\r"), !token.contains("\n") else {
            throw ServiceRuntimeError.configuration
        }
        return token
    }
}

struct ReadyResponse: Decodable {
    let ready: Bool
}

/// One separately identified development application. Environment variables cannot
/// turn the installed product into this development build or select its secrets.
enum YoshPayDevelopment {
    static let bundleIdentifier = "com.yosh.pay-development"

    static func isEnabled(bundleURL: URL = Bundle.main.bundleURL) -> Bool {
        let url = bundleURL.appending(path: "Contents/Info.plist")
        guard let data = try? Data(contentsOf: url),
              let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return false }
        return info["CFBundleIdentifier"] as? String == bundleIdentifier && info["YoshPayDevelopment"] as? Bool == true
    }

    static func dataDirectory(home: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> URL {
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard let resolvedHome = Darwin.realpath(home.path, nil) else { throw ServiceRuntimeError.configuration }
        defer { Darwin.free(resolvedHome) }
        let directory = URL(fileURLWithPath: String(cString: resolvedHome), isDirectory: true)
            .appending(path: "Library/Application Support/Yosh Pay Dev", directoryHint: .isDirectory)
        try ensurePrivateDirectory(directory)
        return directory
    }

    static func selection(directory: URL) throws -> PayDevelopmentSelection {
        try ensurePrivateDirectory(directory)
        let file = directory.appending(path: "development-environment.json")
        guard FileManager.default.fileExists(atPath: file.path)
            || (try? FileManager.default.destinationOfSymbolicLink(atPath: file.path)) != nil else { return .offline }
        let info = try FileManager.default.attributesOfItem(atPath: file.path)
        guard info[.type] as? FileAttributeType == .typeRegular,
              (info[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              (info[.posixPermissions] as? NSNumber)?.intValue == 0o600,
              ((info[.size] as? NSNumber)?.intValue ?? 4097) <= 4096 else { throw ServiceRuntimeError.configuration }
        let data = try Data(contentsOf: file)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["version", "environment", "mainnetRiskAccepted", "rpcUrl"] else { throw ServiceRuntimeError.configuration }
        let selection = try JSONDecoder().decode(PayDevelopmentSelection.self, from: data)
        try selection.validate()
        return selection
    }

    static func saveSelection(_ selection: PayDevelopmentSelection, directory: URL) throws {
        try selection.validate()
        try ensurePrivateDirectory(directory)
        _ = try self.selection(directory: directory) // Refuse unsafe existing configuration.
        let file = directory.appending(path: "development-environment.json")
        let temporary = directory.appending(path: ".environment-\(UUID().uuidString)")
        let bytes = try JSONEncoder().encode(selection)
        guard FileManager.default.createFile(atPath: temporary.path, contents: bytes, attributes: [.posixPermissions: 0o600]) else { throw ServiceRuntimeError.configuration }
        let handle = try FileHandle(forWritingTo: temporary)
        try handle.synchronize(); try handle.close()
        guard Darwin.rename(temporary.path, file.path) == 0 else { throw ServiceRuntimeError.configuration }
        let folder = Darwin.open(directory.path, O_RDONLY)
        guard folder >= 0 else { throw ServiceRuntimeError.configuration }
        defer { Darwin.close(folder) }
        guard fsync(folder) == 0 else { throw ServiceRuntimeError.configuration }
    }

    static func ensurePrivateDirectory(_ directory: URL) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let attributes = try manager.attributesOfItem(atPath: directory.path)
        guard let resolved = Darwin.realpath(directory.path, nil) else { throw ServiceRuntimeError.configuration }
        defer { Darwin.free(resolved) }
        // Match Node's realpath identity, including macOS /var → /private/var.
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              String(cString: resolved) == directory.path else {
            throw ServiceRuntimeError.configuration
        }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }

    static func managementToken(directory: URL) throws -> String {
        try ensurePrivateDirectory(directory)
        let file = directory.appending(path: "management-token")
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw ServiceRuntimeError.configuration
        }
        let candidate = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let created = Darwin.open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        if created >= 0 {
            defer { Darwin.close(created) }
            let contents = Array(candidate.utf8)
            let written = contents.withUnsafeBytes { Darwin.write(created, $0.baseAddress, contents.count) }
            guard written == contents.count, fsync(created) == 0 else { throw ServiceRuntimeError.configuration }
        } else if errno != EEXIST { throw ServiceRuntimeError.configuration }
        let descriptor = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw ServiceRuntimeError.configuration }
        defer { Darwin.close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_uid == getuid(),
              info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o077 == 0, (32...128).contains(info.st_size) else {
            throw ServiceRuntimeError.configuration
        }
        var contents = [UInt8](repeating: 0, count: Int(info.st_size))
        let expectedCount = contents.count
        let count = contents.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, expectedCount) }
        guard count == contents.count, let token = String(bytes: contents, encoding: .utf8),
              token.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else {
            throw ServiceRuntimeError.configuration
        }
        return token
    }
}

enum PayDevelopmentMode: String, Codable, Sendable {
    case offline, mainnet
    var title: String { self == .mainnet ? "Solana Mainnet" : "Offline" }
}

struct PayDevelopmentSelection: Codable, Equatable, Sendable {
    let version: Int
    let environment: PayDevelopmentMode
    let mainnetRiskAccepted: Bool
    let rpcUrl: String
    static let offline = PayDevelopmentSelection(version: 1, environment: .offline, mainnetRiskAccepted: false,
        rpcUrl: "https://solana-rpc.publicnode.com")

    func validate() throws {
        guard version == 1, environment != .mainnet || mainnetRiskAccepted,
              rpcUrl.utf8.count <= 2048, let url = URLComponents(string: rpcUrl),
              url.scheme == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.port == nil || url.port == 443 else { throw ServiceRuntimeError.configuration }
    }
}
