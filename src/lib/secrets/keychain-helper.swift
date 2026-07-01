import Foundation
import Security
import LocalAuthentication
import AppKit

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

// The data-protection keychain access group. This is the
// com.apple.application-identifier granted by the embedded provisioning
// profile (2HTP252L87.com.phnx-labs.agents-keychain) and is covered by the
// keychain-access-groups entitlement (2HTP252L87.*). Pinning it explicitly
// makes every item land in one deterministic group no matter how the helper is
// spawned, instead of relying on the implicit "first entitled group" default.
let kAccessGroup = "2HTP252L87.com.phnx-labs.agents-keychain"

// Base attributes for every DATA-PROTECTION keychain operation (issue #279).
//
// Three properties, each made explicit on purpose:
//
//  - kSecUseDataProtectionKeychain: routes the SecItem call to the
//    data-protection keychain. The biometry SecAccessControl already forced our
//    items onto this keychain implicitly (the file-based keychain cannot store
//    biometry-gated items); stating it removes any ambiguity and is Apple's
//    documented direction — the file-based keychain is on the road to
//    deprecation. See TN3137 "On Mac keychain APIs and implementations".
//
//  - kSecAttrAccessGroup: pins items to ONE concrete access group. The embedded
//    provisioning profile grants the entitlement as a wildcard (2HTP252L87.*)
//    with no concrete default group, so an add that omits the access group
//    relies on the system's implicit default-group resolution. Pinning the
//    application-identifier group removes that dependency and makes every item
//    deterministic regardless of how the helper is spawned.
//
//  - kSecAttrSynchronizable false: keeps items device-local (matching the
//    kSecAttrAccessibleWhenUnlockedThisDeviceOnly intent of the biometry ACL and
//    never letting them reach iCloud Keychain).
func dpBase(service: String, account: String) -> [CFString: Any] {
    return [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecUseDataProtectionKeychain: kCFBooleanTrue!,
        kSecAttrAccessGroup: kAccessGroup as CFString,
        kSecAttrSynchronizable: kCFBooleanFalse!,
    ]
}

// Base attributes for the LEGACY file-based login keychain. Used ONLY to read
// or remove items written by helper versions before the data-protection
// migration. The file-based keychain has no access-group concept, so we add
// neither kSecAttrAccessGroup nor kSecUseDataProtectionKeychain here.
func fileBase(service: String, account: String) -> [CFString: Any] {
    return [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
    ]
}

// Read one item's value, decrypting through the shared auth context.
//
// Lookup order:
//   1. The DATA-PROTECTION keychain, where `set` now writes. For modern
//      biometry-protected items the first read pops Touch ID and later reads
//      reuse the assertion via the shared LAContext.
//   2. On a clean miss, the LEGACY file-based login keychain ONCE. Items written
//      by a pre-migration helper still live there; reading one may pop the
//      legacy "enter password" sheet for a trusted-app ACL, which
//      kSecUseAuthenticationUIAllow makes explicit and intentional. The caller
//      (get / get-batch) then re-writes the value into the data-protection
//      keychain via migrateInline, so the next read resolves at step 1 and this
//      fallback never fires again for that item.
//
// Returns the decoded value, the raw OSStatus (so callers can distinguish
// missing/cancelled), and a needsMigration flag — true when the value was found
// only in the legacy file-based keychain and must be migrated forward.
func readItem(service: String, account: String) -> (value: String?, status: OSStatus, needsMigration: Bool) {
    var dpQuery = dpBase(service: service, account: account)
    dpQuery[kSecReturnData] = kCFBooleanTrue!
    dpQuery[kSecMatchLimit] = kSecMatchLimitOne
    dpQuery[kSecUseAuthenticationContext] = authContext
    dpQuery[kSecUseAuthenticationUI] = kSecUseAuthenticationUIAllow
    dpQuery[kSecUseOperationPrompt] = "Unlock agents-cli secrets" as CFString
    var dpResult: AnyObject?
    let dpStatus = SecItemCopyMatching(dpQuery as CFDictionary, &dpResult)
    if dpStatus == errSecSuccess,
       let data = dpResult as? Data,
       let value = String(data: data, encoding: .utf8) {
        return (value, dpStatus, false)
    }
    // Only a clean "not found" justifies the legacy fallback. errSecAuthFailed,
    // user-cancel, interaction-not-allowed, etc. are surfaced to the caller as-is.
    guard dpStatus == errSecItemNotFound else { return (nil, dpStatus, false) }

    var fileQuery = fileBase(service: service, account: account)
    fileQuery[kSecReturnData] = kCFBooleanTrue!
    fileQuery[kSecMatchLimit] = kSecMatchLimitOne
    fileQuery[kSecUseAuthenticationContext] = authContext
    fileQuery[kSecUseAuthenticationUI] = kSecUseAuthenticationUIAllow
    fileQuery[kSecUseOperationPrompt] = "Unlock agents-cli secrets" as CFString
    var fileResult: AnyObject?
    let fileStatus = SecItemCopyMatching(fileQuery as CFDictionary, &fileResult)
    guard fileStatus == errSecSuccess,
          let data = fileResult as? Data,
          let value = String(data: data, encoding: .utf8) else {
        // Nothing in either keychain — report the data-protection miss so the
        // caller treats it as "not found" rather than a legacy read error.
        return (nil, dpStatus, false)
    }
    return (value, fileStatus, true)
}

// Migrate a value found in the legacy file-based keychain forward into the
// data-protection keychain with the modern biometry access control. Called
// inline by get / get-batch right after the legacy read produced the plaintext
// — every future read then resolves from the data-protection keychain and
// requires Touch ID via the LAContext flow. If anything goes wrong, log to
// stderr but don't fail the parent read: the caller already has the value.
func migrateInline(service: String, account: String, value: String) {
    guard let valueData = value.data(using: .utf8) else {
        writeStderr("migrate-inline: could not encode value for \(service)")
        return
    }
    // We ONLY add the data-protection copy here; we never delete the legacy copy
    // inline. Two hard-won reasons:
    //
    //  1. Deleting the legacy item AFTER adding the DP copy destroys the DP copy.
    //     SecItemDelete(fileBase) is not reliably scoped to the file-based
    //     keychain on macOS 26 — with a DP item of the same service+account
    //     present, the unscoped delete matches and removes it too, so the DP add
    //     never survives (and the delete returns errSecSuccess, so it's silent).
    //  2. Deleting the legacy item BEFORE the add risks data loss: a failing
    //     SecItemAdd would leave the value in neither keychain.
    //
    // Adding only is safe and sufficient: readItem queries the DP keychain first,
    // so once the DP copy exists every future read resolves there and the second
    // auth sheet stops — the lingering legacy copy is never read. Purging that
    // harmless legacy copy is the job of `agents secrets migrate-acl`, which
    // clears both keychains BEFORE its add (the safe order) after an encrypted
    // backup. Clear any stale DP copy first so the add can't hit
    // errSecDuplicateItem; that delete IS scoped (dpBase carries the DP flag).
    SecItemDelete(dpBase(service: service, account: account) as CFDictionary)
    var addAttrs = dpBase(service: service, account: account)
    addAttrs[kSecAttrAccessControl] = buildBiometryAccessControl()
    addAttrs[kSecValueData] = valueData
    let addStatus = SecItemAdd(addAttrs as CFDictionary, nil)
    if addStatus != errSecSuccess {
        // Legacy copy is untouched, so the value is never lost; the next read
        // falls back to the legacy sheet again and retries the migration.
        writeStderr("migrate-inline: DP add failed for \(service) (OSStatus \(addStatus)); legacy copy left intact")
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
    die(2, "Usage: agents-keychain <get|get-batch|set|delete|has|list|list-legacy|migrate-acl> ...")
}

let cmd = args[1]

switch cmd {

case "list":
    // list <prefix> — enumerate generic-password items whose service starts
    // with <prefix> for the current user. Returns attributes only (never
    // data), so it never decrypts and never prompts.
    //
    // Two passes, because no single query covers both keychains: items written
    // by `set` carry a biometry ACL, which forces them into the data-protection
    // keychain, and a query with kSecUseAuthenticationUIFail skips the DP
    // keychain entirely (it errors with errSecInteractionNotAllowed before
    // returning anything). The DP pass therefore omits the UI key — safe only
    // because kSecReturnAttributes without kSecReturnData never evaluates the
    // ACL. Do NOT drop the explicit return key: with no kSecReturn* at all,
    // SecItemCopyMatching evaluates the ACL anyway and blocks on Touch ID.
    guard args.count == 3 else { die(2, "Usage: agents-keychain list <prefix>") }
    let prefix = args[2]
    guard !prefix.isEmpty else { die(2, "list requires non-empty prefix") }
    let user = ProcessInfo.processInfo.environment["USER"] ?? NSUserName()
    let fileQuery: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecMatchLimit: kSecMatchLimitAll,
        kSecReturnAttributes: kCFBooleanTrue!,
        kSecUseAuthenticationUI: kSecUseAuthenticationUIFail,
    ]
    let dpQuery: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecMatchLimit: kSecMatchLimitAll,
        kSecReturnAttributes: kCFBooleanTrue!,
        kSecUseDataProtectionKeychain: kCFBooleanTrue!,
        kSecAttrAccessGroup: kAccessGroup as CFString,
        kSecAttrSynchronizable: kCFBooleanFalse!,
    ]
    var items: [[String: Any]] = []
    for query in [fileQuery, dpQuery] {
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { continue }
        // The DP keybag locks with the screen; enumeration then reports
        // errSecInteractionNotAllowed wholesale. Skip the pass instead of
        // failing — the file-based results are still valid, and DP items
        // are unreadable until unlock anyway.
        if status == errSecInteractionNotAllowed { continue }
        if status != errSecSuccess { die(2, "Failed to enumerate keychain (OSStatus \(status))") }
        items.append(contentsOf: (result as? [[String: Any]]) ?? [])
    }
    var seen = Set<String>()
    for item in items {
        guard let svce = item[kSecAttrService as String] as? String, svce.hasPrefix(prefix) else { continue }
        guard let acct = item[kSecAttrAccount as String] as? String, acct == user else { continue }
        if seen.insert(svce).inserted {
            print(svce)
        }
    }

case "list-legacy":
    // list-legacy <prefix> — enumerate ONLY the legacy file-based-keychain items
    // whose service starts with <prefix> (the migration candidates), never the
    // data-protection keychain. Attributes only, UIFail — never decrypts, never
    // prompts. Items written by the modern `set` live in the DP keychain and are
    // intentionally excluded: they carry the biometry ACL already and need no
    // migration. `agents secrets migrate-acl` uses this to rewrite only the
    // stragglers instead of every item (which would be a Touch ID storm).
    guard args.count == 3 else { die(2, "Usage: agents-keychain list-legacy <prefix>") }
    let legacyPrefix = args[2]
    guard !legacyPrefix.isEmpty else { die(2, "list-legacy requires non-empty prefix") }
    let legacyUser = ProcessInfo.processInfo.environment["USER"] ?? NSUserName()
    // No kSecUseDataProtectionKeychain → this queries the file-based keychain
    // only, which is exactly where pre-migration (trusted-app-ACL) items live.
    let legacyFileQuery: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecMatchLimit: kSecMatchLimitAll,
        kSecReturnAttributes: kCFBooleanTrue!,
        kSecUseAuthenticationUI: kSecUseAuthenticationUIFail,
    ]
    var legacyResult: AnyObject?
    let legacyStatus = SecItemCopyMatching(legacyFileQuery as CFDictionary, &legacyResult)
    var legacyItems: [[String: Any]] = []
    if legacyStatus == errSecSuccess {
        legacyItems = (legacyResult as? [[String: Any]]) ?? []
    } else if legacyStatus != errSecItemNotFound {
        die(2, "Failed to enumerate legacy keychain (OSStatus \(legacyStatus))")
    }
    var legacySeen = Set<String>()
    for item in legacyItems {
        guard let svce = item[kSecAttrService as String] as? String, svce.hasPrefix(legacyPrefix) else { continue }
        guard let acct = item[kSecAttrAccount as String] as? String, acct == legacyUser else { continue }
        if legacySeen.insert(svce).inserted {
            print(svce)
        }
    }

case "has":
    // has <service> <account> — existence check, exit 0 if present else 1.
    // Reads no data, so it never decrypts and never prompts. If the OS
    // reports that interaction would be required, the item still exists.
    //
    // Two passes, because no single prompt-free query covers both keychains:
    // new items live in the data-protection keychain (DP pass) while items
    // written by a pre-migration helper still live in the file-based one (file
    // pass). Both passes use UIFail to guarantee no prompt; a present DP item
    // then surfaces as errSecInteractionNotAllowed, which already counts as
    // "exists".
    guard args.count == 4 else { die(2, "Usage: agents-keychain has <service> <account>") }
    let (service, account) = (args[2], args[3])
    var fileQuery = fileBase(service: service, account: account)
    fileQuery[kSecMatchLimit] = kSecMatchLimitOne
    fileQuery[kSecUseAuthenticationUI] = kSecUseAuthenticationUIFail
    var dpQuery = dpBase(service: service, account: account)
    dpQuery[kSecMatchLimit] = kSecMatchLimitOne
    dpQuery[kSecUseAuthenticationUI] = kSecUseAuthenticationUIFail
    for query in [fileQuery, dpQuery] {
        var ignored: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &ignored)
        if status == errSecSuccess || status == errSecInteractionNotAllowed { exit(0) }
    }
    exit(1)

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
    // set <service> <account> — value on stdin. Always written to the
    // data-protection keychain, device-local, with the biometry access control.
    // SecItemUpdate cannot change an item's ACL, so we delete any existing copy
    // (in both keychains, so no stale legacy item shadows the new one) and
    // re-add it; deleting a protected item needs no authentication, so set never
    // prompts.
    guard args.count == 4 else { die(2, "Usage: agents-keychain set <service> <account>") }
    let (service, account) = (args[2], args[3])
    let stdinData = FileHandle.standardInput.readDataToEndOfFile()
    guard !stdinData.isEmpty, var value = String(data: stdinData, encoding: .utf8) else {
        die(2, "Failed to read value from stdin")
    }
    while value.hasSuffix("\n") || value.hasSuffix("\r") { value = String(value.dropLast()) }
    guard let valueData = value.data(using: .utf8) else { die(2, "Failed to encode value") }

    SecItemDelete(dpBase(service: service, account: account) as CFDictionary)
    SecItemDelete(fileBase(service: service, account: account) as CFDictionary)

    var addAttrs = dpBase(service: service, account: account)
    addAttrs[kSecAttrAccessControl] = buildBiometryAccessControl()
    addAttrs[kSecValueData] = valueData
    let status = SecItemAdd(addAttrs as CFDictionary, nil)
    guard status == errSecSuccess else { die(2, "Failed to write keychain item (OSStatus \(status))") }

case "delete":
    // delete <service> <account> — remove the item from BOTH keychains. New
    // items live in the data-protection keychain; an un-migrated legacy copy may
    // still sit in the file-based one, so we delete from both to avoid orphans.
    // Deletion never decrypts, so it never prompts. Exit 0 if either keychain
    // held a copy, else 1.
    guard args.count == 4 else { die(2, "Usage: agents-keychain delete <service> <account>") }
    let (service, account) = (args[2], args[3])
    let dpStatus = SecItemDelete(dpBase(service: service, account: account) as CFDictionary)
    let fileStatus = SecItemDelete(fileBase(service: service, account: account) as CFDictionary)
    exit((dpStatus == errSecSuccess || fileStatus == errSecSuccess) ? 0 : 1)

case "migrate-acl":
    // migrate-acl <service> <account> — one-time upgrade for items written by an
    // older helper into the legacy file-based keychain (trusted-app ACL or
    // pre-migration layout). Reading such an item may pop the legacy password
    // sheet ONCE (the only place a password prompt is acceptable); we allow that
    // UI explicitly. We then delete the legacy copy and re-add the item into the
    // data-protection keychain with the biometry access control and pinned access
    // group so every future read is Touch ID and resolves deterministically.
    guard args.count == 4 else { die(2, "Usage: agents-keychain migrate-acl <service> <account>") }
    let (service, account) = (args[2], args[3])
    var readQuery = fileBase(service: service, account: account)
    readQuery[kSecReturnData] = kCFBooleanTrue!
    readQuery[kSecMatchLimit] = kSecMatchLimitOne
    readQuery[kSecUseAuthenticationUI] = kSecUseAuthenticationUIAllow
    var result: AnyObject?
    let readStatus = SecItemCopyMatching(readQuery as CFDictionary, &result)
    if readStatus == errSecItemNotFound { exit(1) }
    guard readStatus == errSecSuccess, let valueData = result as? Data else {
        die(2, "Failed to read legacy keychain item (OSStatus \(readStatus))")
    }

    SecItemDelete(fileBase(service: service, account: account) as CFDictionary)
    SecItemDelete(dpBase(service: service, account: account) as CFDictionary)

    var addAttrs = dpBase(service: service, account: account)
    addAttrs[kSecAttrAccessControl] = buildBiometryAccessControl()
    addAttrs[kSecValueData] = valueData
    let addStatus = SecItemAdd(addAttrs as CFDictionary, nil)
    guard addStatus == errSecSuccess else { die(2, "Failed to rewrite item with biometry ACL (OSStatus \(addStatus))") }

case "watch-lock":
    // watch-lock — long-running. Emit a line to stdout whenever the screen
    // locks or the machine sleeps, so the secrets-agent broker can wipe its
    // in-memory store. Lines: "LOCK" (screen locked / screensaver) and "SLEEP"
    // (system about to sleep). Never decrypts anything, never prompts.
    //
    // The broker spawns this as a child and kills it on shutdown. As a
    // belt-and-suspenders against an orphaned watcher (broker SIGKILL'd), we
    // exit once reparented to launchd (getppid() == 1).
    func emitEvent(_ name: String) {
        FileHandle.standardOutput.write(Data((name + "\n").utf8))
    }
    let center = DistributedNotificationCenter.default()
    center.addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: nil) { _ in
        emitEvent("LOCK")
    }
    center.addObserver(forName: NSNotification.Name("com.apple.screensaver.didstart"), object: nil, queue: nil) { _ in
        emitEvent("LOCK")
    }
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil) { _ in
        emitEvent("SLEEP")
    }
    Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
        if getppid() == 1 { exit(0) }
    }
    RunLoop.current.run()

default:
    die(2, "Unknown command: \(cmd)")
}
