import Foundation
#if canImport(Security)
import Security
#endif

/// Where the cockpit keeps its anchor bearer token. Protocol so the app uses the
/// Keychain while tests use an in-memory double.
public protocol TokenStore: Sendable {
    func load() -> String?
    func save(_ token: String) throws
    func clear() throws
}

/// In-memory token store for tests and previews.
public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    public init(_ initial: String? = nil) { value = initial }
    public func load() -> String? { lock.lock(); defer { lock.unlock() }; return value }
    public func save(_ token: String) throws { lock.lock(); value = token; lock.unlock() }
    public func clear() throws { lock.lock(); value = nil; lock.unlock() }
}

#if canImport(Security)
/// Keychain-backed token store for the shipping app — the token never touches
/// `UserDefaults` or disk in the clear.
public final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    private let service: String
    private let account: String

    public init(service: String = "ai.phoenix.cockpit.anchor", account: String = "control-token") {
        self.service = service
        self.account = account
    }

    private func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func load() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func save(_ token: String) throws {
        let data = Data(token.utf8)
        // Delete-then-add keeps it idempotent across re-pairing.
        SecItemDelete(baseQuery() as CFDictionary)
        var add = baseQuery()
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw AnchorError.badRequest("keychain save failed (OSStatus \(status))")
        }
    }

    public func clear() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw AnchorError.badRequest("keychain clear failed (OSStatus \(status))")
        }
    }
}
#endif
