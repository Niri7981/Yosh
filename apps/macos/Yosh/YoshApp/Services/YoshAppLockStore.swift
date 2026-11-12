import Foundation
import Security

protocol YoshAppLockStoring: Sendable {
    func load() async throws -> YoshAppLockCredential?
    func save(_ credential: YoshAppLockCredential) async throws
}

enum YoshAppLockStoreError: Error, Sendable, Equatable {
    case invalidRecord
    case keychainFailure(OSStatus)
}

/// Its own generic-password item, with the normal system access policy.
/// Actor isolation keeps blocking Security calls away from the main actor.
actor YoshKeychainAppLockStore: YoshAppLockStoring {
    // Preserve existing PIN records under their original Keychain lookup identity.
    static let service = "com.twentyfortynine.yosh-app-lock.v1"
    static let account = "local-app-lock"
    static let maximumEncodedBytes = 2_048
    private let bundleURL: URL

    init(bundleURL: URL = Bundle.main.bundleURL) { self.bundleURL = bundleURL }

    static func scopedService(bundleURL: URL) throws -> String {
        let url = bundleURL.appending(path: "Contents/Info.plist")
        guard let data = try? Data(contentsOf: url),
              let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return service }
        let plugin = "com.yosh.codex-plugin-dev"
        if info["CFBundleIdentifier"] as? String == plugin || info["YoshCodexPluginDevelopment"] as? Bool == true {
            guard info["CFBundleIdentifier"] as? String == plugin,
                  info["YoshCodexPluginDevelopment"] as? Bool == true,
                  info["YoshPayDevelopment"] as? Bool == true else { throw YoshAppLockStoreError.invalidRecord }
            return "\(plugin).app-lock.v1"
        }
        return service
    }

    func load() async throws -> YoshAppLockCredential? {
        var query = try itemQuery()
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw YoshAppLockStoreError.keychainFailure(status)
        }
        guard let data = result as? Data else { throw YoshAppLockStoreError.invalidRecord }
        return try Self.decode(data)
    }

    func save(_ credential: YoshAppLockCredential) async throws {
        let data = try Self.encode(credential)
        let query = try itemQuery()
        let changes: [CFString: Any] = [kSecValueData: data]
        let status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else {
            throw YoshAppLockStoreError.keychainFailure(status)
        }

        var item = query
        item[kSecValueData] = data
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            // A competing creation or denied access must not silently replace a record.
            throw YoshAppLockStoreError.keychainFailure(addStatus)
        }
    }

    static func encode(_ credential: YoshAppLockCredential) throws -> Data {
        try credential.validate()
        let data = try JSONEncoder().encode(credential)
        guard data.count <= maximumEncodedBytes else { throw YoshAppLockStoreError.invalidRecord }
        return data
    }

    static func decode(_ data: Data) throws -> YoshAppLockCredential {
        guard !data.isEmpty, data.count <= maximumEncodedBytes else {
            throw YoshAppLockStoreError.invalidRecord
        }
        do {
            let credential = try JSONDecoder().decode(YoshAppLockCredential.self, from: data)
            try credential.validate()
            return credential
        } catch {
            throw YoshAppLockStoreError.invalidRecord
        }
    }

    private func itemQuery() throws -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword,
         kSecAttrService: try Self.scopedService(bundleURL: bundleURL),
         kSecAttrAccount: Self.account]
    }
}
