import Foundation
import LocalAuthentication
import Security

func writeStderr(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

func die(_ code: Int32, _ message: String) -> Never {
    writeStderr(message)
    exit(code)
}

func makeAuthenticationContext(reason: String) -> LAContext {
    let context = LAContext()
    context.localizedReason = reason
    return context
}

func copyItem(service: String, account: String, synchronizable: CFTypeRef, context: LAContext?) -> (status: OSStatus, value: String?) {
    var query: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecAttrSynchronizable: synchronizable,
        kSecReturnData: kCFBooleanTrue!,
        kSecMatchLimit: kSecMatchLimitOne,
    ]
    if let context = context {
        query[kSecUseAuthenticationContext] = context
    }
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess,
          let data = result as? Data,
          let value = String(data: data, encoding: .utf8) else { return (status, nil) }
    return (status, value)
}

func findItem(service: String, account: String, synchronizable: CFTypeRef, reason: String?) -> String? {
    let context = reason.map { makeAuthenticationContext(reason: $0) }
    return copyItem(service: service, account: account, synchronizable: synchronizable, context: context).value
}

func requiresUserPresence(service: String) -> Bool {
    return service.hasPrefix("agents-cli.secrets.") || service.hasPrefix("agents-cli.bundles.")
}

func buildUserPresenceAccess(syncFlag: CFBoolean) -> SecAccessControl {
    var error: Unmanaged<CFError>?
    let accessibility: CFTypeRef = syncFlag == kCFBooleanTrue!
        ? kSecAttrAccessibleWhenUnlocked
        : kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    guard let access = SecAccessControlCreateWithFlags(
        nil,
        accessibility,
        [.biometryCurrentSet, .or, .devicePasscode],
        &error
    ) else {
        let message = error?.takeRetainedValue().localizedDescription ?? "unknown error"
        die(2, "Failed to create keychain access control: \(message)")
    }
    return access
}

func buildSelfTrustedAccess() -> SecAccess? {
    var selfApp: SecTrustedApplication?
    guard SecTrustedApplicationCreateFromPath(nil, &selfApp) == errSecSuccess,
          let app = selfApp else { return nil }
    var access: SecAccess?
    let label = "agents-cli secrets" as CFString
    guard SecAccessCreate(label, [app] as CFArray, &access) == errSecSuccess else {
        return nil
    }
    return access
}

func parseOptionalReason(startIndex: Int, defaultReason: String) -> (reason: String, nextIndex: Int) {
    if args.count > startIndex + 1 && args[startIndex] == "--reason" {
        return (args[startIndex + 1], startIndex + 2)
    }
    return (defaultReason, startIndex)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    die(2, "Usage: agents-keychain <get|set|delete|has|list> ...")
}

let cmd = args[1]

switch cmd {

case "list":
    // list <prefix> — enumerate generic-password items whose service starts with <prefix>.
    guard args.count == 3 else { die(2, "Usage: agents-keychain list <prefix>") }
    let prefix = args[2]
    guard !prefix.isEmpty else { die(2, "list requires non-empty prefix") }
    let user = ProcessInfo.processInfo.environment["USER"] ?? NSUserName()
    let query: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecMatchLimit: kSecMatchLimitAll,
        kSecReturnAttributes: kCFBooleanTrue!,
        kSecAttrSynchronizable: kSecAttrSynchronizableAny,
    ]
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { exit(0) }
    if status != errSecSuccess { die(2, "Failed to enumerate keychain (OSStatus \(status))") }
    guard let items = result as? [[String: Any]] else { exit(0) }
    var seen = Set<String>()
    for item in items {
        guard let svce = item[kSecAttrService as String] as? String, svce.hasPrefix(prefix) else { continue }
        guard let acct = item[kSecAttrAccount as String] as? String, acct == user else { continue }
        if seen.insert(svce).inserted {
            print(svce)
        }
    }

case "get":
    guard args.count == 4 else { die(2, "Usage: agents-keychain get <service> <account>") }
    let (service, account) = (args[2], args[3])
    guard let value = findItem(service: service, account: account, synchronizable: kSecAttrSynchronizableAny, reason: nil) else { exit(1) }
    print(value, terminator: "")

case "get-auth":
    guard args.count == 4 || args.count == 6 else { die(2, "Usage: agents-keychain get-auth <service> <account> [--reason \"text\"]") }
    let (service, account) = (args[2], args[3])
    let parsed = parseOptionalReason(startIndex: 4, defaultReason: "read agents-cli secrets")
    guard parsed.nextIndex == args.count else { die(2, "Usage: agents-keychain get-auth <service> <account> [--reason \"text\"]") }
    guard let value = findItem(service: service, account: account, synchronizable: kSecAttrSynchronizableAny, reason: parsed.reason) else { exit(1) }
    print(value, terminator: "")

case "get-batch":
    guard args.count >= 4 else { die(2, "Usage: agents-keychain get-batch <account> [--reason \"text\"] <service1> [service2...]") }
    let account = args[2]
    let parsed = parseOptionalReason(startIndex: 3, defaultReason: "read agents-cli secrets")
    let reason = parsed.reason
    guard parsed.nextIndex < args.count else { die(2, "Usage: agents-keychain get-batch <account> [--reason \"text\"] <service1> [service2...]") }
    let context = makeAuthenticationContext(reason: reason)
    for service in args.dropFirst(parsed.nextIndex) {
        let item = copyItem(service: service, account: account, synchronizable: kSecAttrSynchronizableAny, context: context)
        if item.status == errSecSuccess, let value = item.value {
            print("\(service)\t\(Data(value.utf8).base64EncodedString())")
        }
    }

case "has":
    guard args.count == 4 else { die(2, "Usage: agents-keychain has <service> <account>") }
    let (service, account) = (args[2], args[3])
    let reason = requiresUserPresence(service: service) ? "check agents-cli secrets" : nil
    exit(findItem(service: service, account: account, synchronizable: kSecAttrSynchronizableAny, reason: reason) != nil ? 0 : 1)

case "set":
    guard args.count == 4 || args.count == 5 else { die(2, "Usage: agents-keychain set <service> <account> [nosync]") }
    let (service, account) = (args[2], args[3])
    // Device-local items used to go through `security` and retain their ACL.
    // Default to iCloud-synced (kSecAttrSynchronizable=true). Pass `nosync` as the 4th arg
    // for device-local writes — used by bundles without --icloud-sync.
    let syncFlag: CFBoolean = (args.count == 5 && args[4] == "nosync") ? kCFBooleanFalse! : kCFBooleanTrue!
    let stdinData = FileHandle.standardInput.readDataToEndOfFile()
    guard !stdinData.isEmpty, var password = String(data: stdinData, encoding: .utf8) else {
        die(2, "Failed to read password from stdin")
    }
    while password.hasSuffix("\n") || password.hasSuffix("\r") { password = String(password.dropLast()) }
    guard let valueData = password.data(using: .utf8) else { die(2, "Failed to encode password") }

    let userPresenceAccess = requiresUserPresence(service: service) ? buildUserPresenceAccess(syncFlag: syncFlag) : nil
    let trustedAccess = userPresenceAccess == nil ? buildSelfTrustedAccess() : nil

    let matchAttrs: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecAttrSynchronizable: syncFlag,
    ]
    var updateAttrs: [CFString: Any] = [kSecValueData: valueData]
    if let access = userPresenceAccess {
        updateAttrs[kSecAttrAccessControl] = access
    }
    var status = SecItemUpdate(matchAttrs as CFDictionary, updateAttrs as CFDictionary)
    if status == errSecItemNotFound {
        var addAttrs: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service as CFString,
            kSecAttrAccount: account as CFString,
            kSecAttrSynchronizable: syncFlag,
            kSecValueData: valueData,
        ]
        if let access = userPresenceAccess {
            addAttrs[kSecAttrAccessControl] = access
        } else if let access = trustedAccess, syncFlag == kCFBooleanFalse! {
            addAttrs[kSecAttrAccess] = access
        }
        status = SecItemAdd(addAttrs as CFDictionary, nil)
    }
    if status == errSecNotAvailable {
        die(2, "iCloud Keychain is not enabled. Turn it on in System Settings > [Apple ID] > iCloud > Passwords & Keychain.")
    }
    guard status == errSecSuccess else { die(2, "Failed to write keychain item (OSStatus \(status))") }

    // When writing as synchronizable, remove any non-sync duplicate left from a previous write.
    // When writing as nosync, leave the synchronizable copy alone (caller manages explicit sync state).
    if syncFlag == kCFBooleanTrue! {
        SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service as CFString,
            kSecAttrAccount: account as CFString,
            kSecAttrSynchronizable: kCFBooleanFalse!,
        ] as CFDictionary)
    }

case "delete":
    guard args.count == 4 else { die(2, "Usage: agents-keychain delete <service> <account>") }
    let (service, account) = (args[2], args[3])
    var found = false
    for sync in [kCFBooleanTrue!, kCFBooleanFalse!] as [CFBoolean] {
        if SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service as CFString,
            kSecAttrAccount: account as CFString,
            kSecAttrSynchronizable: sync,
        ] as CFDictionary) == errSecSuccess { found = true }
    }
    exit(found ? 0 : 1)

default:
    die(2, "Unknown command: \(cmd)")
}
