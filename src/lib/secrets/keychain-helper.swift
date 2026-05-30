import Foundation
import Security
import LocalAuthentication

func writeStderr(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

func die(_ code: Int32, _ message: String) -> Never {
    writeStderr(message)
    exit(code)
}

// One LAContext per process. Setting the Touch ID reuse duration lets the
// OS cache the biometry assertion: the first protected read in this process
// pops Touch ID, every later read with this same context reuses the
// assertion (up to Apple's ~10s maximum) without prompting again. Passed to
// SecItemCopyMatching via kSecUseAuthenticationContext.
let authContext: LAContext = {
    let ctx = LAContext()
    ctx.touchIDAuthenticationAllowableReuseDuration = LATouchIDAuthenticationMaximumAllowableReuseDuration
    return ctx
}()

// Build the access control that gates every item we write: unlock requires a
// current-enrollment biometry match OR the device passcode, and the item is
// scoped to this device only. The OS itself enforces this on every
// SecItemCopyMatching that returns data, regardless of which signed binary
// makes the call — so rebuilding the helper never invalidates the gate the
// way the old trusted-app ACL did. Incompatible with iCloud Keychain sync,
// so items are always device-local (we never mark them synchronizable).
func buildBiometryAccessControl() -> SecAccessControl {
    var err: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.biometryCurrentSet, .or, .devicePasscode],
        &err
    ) else {
        let msg = err?.takeRetainedValue().localizedDescription ?? "unknown error"
        die(2, "Failed to build biometry access control: \(msg)")
    }
    return access
}

// Read one item's value, decrypting through the shared auth context.
//
// For modern biometry-protected items, the first read pops Touch ID and
// later reads reuse the assertion. For legacy items with a trusted-app
// ACL (kSecAttrAccess) that doesn't list this binary, macOS shows the
// "enter password" sheet — kSecUseAuthenticationUIAllow makes that
// fallback explicit and intentional. We use that one password sheet to
// drive the JIT upgrade: the caller (get / get-batch) re-writes the
// item with biometry ACL immediately afterward, so the next read is
// Touch ID forever.
//
// Returns the decoded value, the raw OSStatus (so callers can
// distinguish missing/cancelled), and a needsMigration flag — true if
// the item has no kSecAttrAccessControl (legacy item).
func readItem(service: String, account: String) -> (value: String?, status: OSStatus, needsMigration: Bool) {
    let query: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecReturnData: kCFBooleanTrue!,
        kSecReturnAttributes: kCFBooleanTrue!,
        kSecMatchLimit: kSecMatchLimitOne,
        kSecUseAuthenticationContext: authContext,
        kSecUseAuthenticationUI: kSecUseAuthenticationUIAllow,
        kSecUseOperationPrompt: "Unlock agents-cli secrets" as CFString,
    ]
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess,
          let dict = result as? [String: Any],
          let data = dict[kSecValueData as String] as? Data,
          let value = String(data: data, encoding: .utf8) else { return (nil, status, false) }
    // Legacy items (kSecAttrAccess, "any-app", or no ACL at all) lack the
    // kSecAttrAccessControl attribute. Items written by the new `set`
    // path have it. Use that as the migration signal.
    let needsMigration = dict[kSecAttrAccessControl as String] == nil
    return (value, status, needsMigration)
}

// Re-write a legacy item with the modern biometry access control. Called
// inline by get / get-batch right after the legacy password sheet has
// produced the plaintext — every future read of this item will then
// require Touch ID via the LAContext flow. Delete + re-add is required
// because SecItemUpdate cannot change an item's ACL. If anything goes
// wrong, log to stderr but don't fail the parent read: the caller
// already has the value and the user just typed their password for it.
func migrateInline(service: String, account: String, value: String) {
    guard let valueData = value.data(using: .utf8) else {
        writeStderr("migrate-inline: could not encode value for \(service)")
        return
    }
    let delStatus = SecItemDelete([
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
    ] as CFDictionary)
    if delStatus != errSecSuccess && delStatus != errSecItemNotFound {
        writeStderr("migrate-inline: delete failed for \(service) (OSStatus \(delStatus))")
        return
    }
    let addAttrs: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecAttrAccessControl: buildBiometryAccessControl(),
        kSecValueData: valueData,
    ]
    let addStatus = SecItemAdd(addAttrs as CFDictionary, nil)
    if addStatus != errSecSuccess {
        writeStderr("migrate-inline: re-add failed for \(service) (OSStatus \(addStatus))")
    }
}

// Translate a Touch ID cancellation into the contract's exit code (4). Any
// other failure to authenticate is also a cancellation from the caller's
// point of view — the value cannot be produced.
func dieIfCancelled(_ status: OSStatus) {
    if status == errSecUserCanceled || status == errSecAuthFailed {
        die(4, "Authentication cancelled")
    }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    die(2, "Usage: agents-keychain <get|get-batch|set|delete|has|list|migrate-acl> ...")
}

let cmd = args[1]

switch cmd {

case "list":
    // list <prefix> — enumerate generic-password items whose service starts
    // with <prefix> for the current user. Returns attributes only (never
    // data), so it never decrypts and never prompts.
    guard args.count == 3 else { die(2, "Usage: agents-keychain list <prefix>") }
    let prefix = args[2]
    guard !prefix.isEmpty else { die(2, "list requires non-empty prefix") }
    let user = ProcessInfo.processInfo.environment["USER"] ?? NSUserName()
    let query: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecMatchLimit: kSecMatchLimitAll,
        kSecReturnAttributes: kCFBooleanTrue!,
        kSecUseAuthenticationUI: kSecUseAuthenticationUIFail,
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

case "has":
    // has <service> <account> — existence check, exit 0 if present else 1.
    // Reads no data, so it never decrypts and never prompts. If the OS
    // reports that interaction would be required, the item still exists.
    guard args.count == 4 else { die(2, "Usage: agents-keychain has <service> <account>") }
    let (service, account) = (args[2], args[3])
    let query: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecMatchLimit: kSecMatchLimitOne,
        kSecUseAuthenticationUI: kSecUseAuthenticationUIFail,
    ]
    var ignored: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &ignored)
    exit((status == errSecSuccess || status == errSecInteractionNotAllowed) ? 0 : 1)

case "get":
    // get <service> <account> — single protected read. Pops Touch ID (or
    // reuses an assertion from earlier in this process). If the item is
    // a legacy kSecAttrAccess one, macOS pops the password sheet ONCE and
    // we then JIT-migrate the item to biometry ACL so the next read is
    // Touch ID. Exit 1 if missing, exit 4 if the user cancels.
    guard args.count == 4 else { die(2, "Usage: agents-keychain get <service> <account>") }
    let (service, account) = (args[2], args[3])
    let (value, status, needsMigration) = readItem(service: service, account: account)
    if status == errSecItemNotFound { exit(1) }
    dieIfCancelled(status)
    guard let value = value else {
        if status == errSecSuccess { exit(1) }
        die(2, "Failed to read keychain item (OSStatus \(status))")
    }
    // Only JIT-migrate items in our own namespace. Items from other apps
    // (e.g. Anthropic's Claude Code-credentials-*) have ACLs designed by
    // their writer; rewriting them with our biometry ACL would break the
    // writer's expected access path on the next write.
    if needsMigration && service.hasPrefix("agents-cli.") {
        migrateInline(service: service, account: account, value: value)
    }
    print(value, terminator: "")

case "get-batch":
    // get-batch <account> <service1> [service2...] — read every listed
    // service for one account behind a SINGLE Touch ID prompt. The first
    // present item triggers Touch ID; the rest reuse the assertion via the
    // shared auth context. Output, one record per service in input order:
    //   V <service>\n<value>\n   (present)
    //   M <service>\n            (missing)
    // Service names are validated newline/'='-free by the TS write path, so
    // these newline-delimited records are unambiguous. Exit 4 if cancelled.
    guard args.count >= 4 else {
        die(2, "Usage: agents-keychain get-batch <account> <service1> [service2...]")
    }
    let account = args[2]
    let services = Array(args[3...])
    for service in services {
        let (value, status, needsMigration) = readItem(service: service, account: account)
        dieIfCancelled(status)
        if let value = value {
            if needsMigration && service.hasPrefix("agents-cli.") {
                migrateInline(service: service, account: account, value: value)
            }
            print("V \(service)")
            print(value)
        } else {
            print("M \(service)")
        }
    }

case "set":
    // set <service> <account> — value on stdin. Always written device-local
    // with the biometry access control. SecItemUpdate cannot change an
    // item's ACL, so we delete any existing copy and re-add it; deleting a
    // protected item needs no authentication, so set never prompts.
    guard args.count == 4 else { die(2, "Usage: agents-keychain set <service> <account>") }
    let (service, account) = (args[2], args[3])
    let stdinData = FileHandle.standardInput.readDataToEndOfFile()
    guard !stdinData.isEmpty, var value = String(data: stdinData, encoding: .utf8) else {
        die(2, "Failed to read value from stdin")
    }
    while value.hasSuffix("\n") || value.hasSuffix("\r") { value = String(value.dropLast()) }
    guard let valueData = value.data(using: .utf8) else { die(2, "Failed to encode value") }

    SecItemDelete([
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
    ] as CFDictionary)

    let addAttrs: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecAttrAccessControl: buildBiometryAccessControl(),
        kSecValueData: valueData,
    ]
    let status = SecItemAdd(addAttrs as CFDictionary, nil)
    guard status == errSecSuccess else { die(2, "Failed to write keychain item (OSStatus \(status))") }

case "delete":
    // delete <service> <account> — remove the item. Deletion never decrypts,
    // so it never prompts. Exit 0 if something was removed, else 1.
    guard args.count == 4 else { die(2, "Usage: agents-keychain delete <service> <account>") }
    let (service, account) = (args[2], args[3])
    let status = SecItemDelete([
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
    ] as CFDictionary)
    exit(status == errSecSuccess ? 0 : 1)

case "migrate-acl":
    // migrate-acl <service> <account> — one-time upgrade for items written by
    // an older helper that used a trusted-app ACL. Reading such an item may
    // pop the legacy password sheet ONCE (the only place a password prompt is
    // acceptable); we allow that UI explicitly. We then delete and re-add the
    // item with the biometry access control so every future read is Touch ID.
    guard args.count == 4 else { die(2, "Usage: agents-keychain migrate-acl <service> <account>") }
    let (service, account) = (args[2], args[3])
    let readQuery: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecReturnData: kCFBooleanTrue!,
        kSecMatchLimit: kSecMatchLimitOne,
        kSecUseAuthenticationUI: kSecUseAuthenticationUIAllow,
    ]
    var result: AnyObject?
    let readStatus = SecItemCopyMatching(readQuery as CFDictionary, &result)
    if readStatus == errSecItemNotFound { exit(1) }
    guard readStatus == errSecSuccess, let valueData = result as? Data else {
        die(2, "Failed to read legacy keychain item (OSStatus \(readStatus))")
    }

    SecItemDelete([
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
    ] as CFDictionary)

    let addAttrs: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecAttrAccessControl: buildBiometryAccessControl(),
        kSecValueData: valueData,
    ]
    let addStatus = SecItemAdd(addAttrs as CFDictionary, nil)
    guard addStatus == errSecSuccess else { die(2, "Failed to rewrite item with biometry ACL (OSStatus \(addStatus))") }

default:
    die(2, "Unknown command: \(cmd)")
}
