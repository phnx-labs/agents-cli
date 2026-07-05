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

// Base attributes for a DATA-PROTECTION query that does NOT pin the access
// group. Identical to dpBase() minus kSecAttrAccessGroup, so it spans EVERY
// group the entitlement covers (2HTP252L87.*).
//
// Why this exists (issue: orphaned access groups): helpers before the group
// pin (#279, v1.20.27) wrote without kSecAttrAccessGroup, and macOS filed those
// items under the implicit default group — the literal wildcard string
// "2HTP252L87.*", NOT the concrete kAccessGroup. dpBase() queries only the
// concrete group, so those pre-pin items are invisible ("missing") even though
// they are intact and the wildcard entitlement authorizes reading them. This
// un-pinned base is used only for READS (a group-agnostic fallback + the orphan
// re-home sweep); WRITES always use dpBase() so new items land deterministically
// in the concrete group.
func dpBaseUnpinned(service: String, account: String) -> [CFString: Any] {
    return [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecUseDataProtectionKeychain: kCFBooleanTrue!,
        kSecAttrSynchronizable: kCFBooleanFalse!,
    ]
}

// Outcome of a protected read. `needsMigration` is set when the value came only
// from the legacy file-based keychain (caller re-writes via migrateInline).
// `orphanRef` is set when the value came from a data-protection item under a
// NON-pinned access group (a pre-#279 orphan) — the caller re-homes it into the
// concrete group and deletes that exact persistent ref via rehomeOrphan.
struct ReadOutcome {
    let value: String?
    let status: OSStatus
    let needsMigration: Bool
    let orphanRef: Data?
}

// Read one item's value, decrypting through the shared auth context.
//
// Lookup order:
//   1. The DATA-PROTECTION keychain, pinned to the concrete access group, where
//      `set` now writes. For modern biometry-protected items the first read pops
//      Touch ID and later reads reuse the assertion via the shared LAContext.
//   2. On a clean miss, the DATA-PROTECTION keychain UN-pinned (spans every
//      2HTP252L87.* group). This surfaces pre-#279 "orphaned" items filed under
//      the implicit default group. A hit here is necessarily an orphan (step 1
//      already proved no concrete-group copy exists), so we return its
//      persistent ref for the caller to re-home.
//   3. On a further miss, the LEGACY file-based login keychain ONCE. Items
//      written by a pre-migration helper still live there; reading one may pop
//      the legacy "enter password" sheet for a trusted-app ACL, which
//      kSecUseAuthenticationUIAllow makes explicit and intentional.
func readItem(service: String, account: String) -> ReadOutcome {
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
        return ReadOutcome(value: value, status: dpStatus, needsMigration: false, orphanRef: nil)
    }
    // Only a clean "not found" justifies the fallbacks. errSecAuthFailed,
    // user-cancel, interaction-not-allowed, etc. are surfaced to the caller as-is.
    guard dpStatus == errSecItemNotFound else {
        return ReadOutcome(value: nil, status: dpStatus, needsMigration: false, orphanRef: nil)
    }

    // Step 2 — un-pinned DP pass. Request the persistent ref alongside the data
    // so the caller can delete this exact orphan (never the re-homed copy). With
    // two kSecReturn* keys the result is a dictionary.
    var orphanQuery = dpBaseUnpinned(service: service, account: account)
    orphanQuery[kSecReturnData] = kCFBooleanTrue!
    orphanQuery[kSecReturnPersistentRef] = kCFBooleanTrue!
    orphanQuery[kSecMatchLimit] = kSecMatchLimitOne
    orphanQuery[kSecUseAuthenticationContext] = authContext
    orphanQuery[kSecUseAuthenticationUI] = kSecUseAuthenticationUIAllow
    orphanQuery[kSecUseOperationPrompt] = "Unlock agents-cli secrets" as CFString
    var orphanResult: AnyObject?
    let orphanStatus = SecItemCopyMatching(orphanQuery as CFDictionary, &orphanResult)
    if orphanStatus == errSecSuccess,
       let dict = orphanResult as? [CFString: Any],
       let data = dict[kSecValueData] as? Data,
       let value = String(data: data, encoding: .utf8) {
        let ref = dict[kSecValuePersistentRef] as? Data
        return ReadOutcome(value: value, status: orphanStatus, needsMigration: false, orphanRef: ref)
    }
    guard orphanStatus == errSecItemNotFound else {
        return ReadOutcome(value: nil, status: orphanStatus, needsMigration: false, orphanRef: nil)
    }

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
        // Nothing in any keychain — report the data-protection miss so the
        // caller treats it as "not found" rather than a legacy read error.
        return ReadOutcome(value: nil, status: dpStatus, needsMigration: false, orphanRef: nil)
    }
    return ReadOutcome(value: value, status: fileStatus, needsMigration: true, orphanRef: nil)
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

// Re-home a data-protection item that lives under a NON-pinned access group (a
// pre-#279 orphan) into the concrete kAccessGroup. Add-before-delete: the pinned
// copy is written first, so a failed add leaves the orphan intact and the value
// is never lost. The orphan is then deleted by its exact persistent ref, so the
// delete can never match the freshly-added pinned copy (same service+account,
// different group). Best-effort — logs to stderr, never fails the parent read.
func rehomeOrphan(service: String, account: String, value: String, orphanRef: Data) {
    guard let valueData = value.data(using: .utf8) else {
        writeStderr("rehome: could not encode value for \(service)")
        return
    }
    // Clear any stale pinned copy (scoped to the concrete group) so the add can't
    // hit errSecDuplicateItem, then add the pinned copy with the biometry ACL.
    SecItemDelete(dpBase(service: service, account: account) as CFDictionary)
    var addAttrs = dpBase(service: service, account: account)
    addAttrs[kSecAttrAccessControl] = buildBiometryAccessControl()
    addAttrs[kSecValueData] = valueData
    let addStatus = SecItemAdd(addAttrs as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
        writeStderr("rehome: DP add failed for \(service) (OSStatus \(addStatus)); orphan left intact")
        return
    }
    // Delete the orphan by persistent ref — exact item, group-agnostic.
    let delStatus = SecItemDelete([kSecValuePersistentRef: orphanRef] as CFDictionary)
    if delStatus != errSecSuccess && delStatus != errSecItemNotFound {
        writeStderr("rehome: orphan delete failed for \(service) (OSStatus \(delStatus)); pinned copy is in place")
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
    die(2, "Usage: agents-keychain <get|get-batch|set|delete|has|list|list-legacy|list-orphans|migrate-acl|migrate-orphans> ...")
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
    // DP pass is UN-pinned (no kSecAttrAccessGroup): it spans the concrete group
    // AND any pre-#279 orphan group, so bundles whose metadata is orphaned still
    // appear in `secrets list` instead of vanishing. Attributes-only, so it never
    // decrypts or prompts regardless of group.
    let dpQuery: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecMatchLimit: kSecMatchLimitAll,
        kSecReturnAttributes: kCFBooleanTrue!,
        kSecUseDataProtectionKeychain: kCFBooleanTrue!,
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
    // Third pass: un-pinned DP query so a pre-#279 orphan (filed under a
    // non-concrete access group) still reports as present instead of "missing".
    var orphanQuery = dpBaseUnpinned(service: service, account: account)
    orphanQuery[kSecMatchLimit] = kSecMatchLimitOne
    orphanQuery[kSecUseAuthenticationUI] = kSecUseAuthenticationUIFail
    for query in [fileQuery, dpQuery, orphanQuery] {
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
    let outcome = readItem(service: service, account: account)
    if outcome.status == errSecItemNotFound { exit(1) }
    dieIfCancelled(outcome.status)
    guard let value = outcome.value else {
        if outcome.status == errSecSuccess { exit(1) }
        die(2, "Failed to read keychain item (OSStatus \(outcome.status))")
    }
    // Only JIT-migrate items in our own namespace. Items from other apps
    // (e.g. Anthropic's Claude Code-credentials-*) have ACLs designed by
    // their writer; rewriting them with our biometry ACL would break the
    // writer's expected access path on the next write.
    if service.hasPrefix("agents-cli.") {
        if outcome.needsMigration {
            migrateInline(service: service, account: account, value: value)
        } else if let ref = outcome.orphanRef {
            rehomeOrphan(service: service, account: account, value: value, orphanRef: ref)
        }
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
        let outcome = readItem(service: service, account: account)
        dieIfCancelled(outcome.status)
        if let value = outcome.value {
            if service.hasPrefix("agents-cli.") {
                if outcome.needsMigration {
                    migrateInline(service: service, account: account, value: value)
                } else if let ref = outcome.orphanRef {
                    rehomeOrphan(service: service, account: account, value: value, orphanRef: ref)
                }
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

    // Delete across ALL access groups (un-pinned), not just the concrete one, so
    // a rotate can't leave a pre-#279 orphan shadowing the freshly-written copy.
    SecItemDelete(dpBaseUnpinned(service: service, account: account) as CFDictionary)
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
    // Un-pinned DP delete removes the concrete-group copy AND any pre-#279 orphan
    // under a non-concrete group, so a deleted secret leaves nothing behind.
    let dpStatus = SecItemDelete(dpBaseUnpinned(service: service, account: account) as CFDictionary)
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

case "list-orphans":
    // list-orphans <prefix> <account> — enumerate data-protection items whose
    // service starts with <prefix> for <account> that live under a NON-concrete
    // access group (pre-#279 orphans filed under the implicit default group).
    // Attributes only — never decrypts, never prompts. Prints one orphaned
    // service per line; used by `migrate-acl` for its prompt-free dry-run report.
    guard args.count == 4 else { die(2, "Usage: agents-keychain list-orphans <prefix> <account>") }
    let (prefix, account) = (args[2], args[3])
    guard !prefix.isEmpty else { die(2, "list-orphans requires non-empty prefix") }
    let enumQuery: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecMatchLimit: kSecMatchLimitAll,
        kSecReturnAttributes: kCFBooleanTrue!,
        kSecUseDataProtectionKeychain: kCFBooleanTrue!,
        kSecAttrSynchronizable: kCFBooleanFalse!,
    ]
    var enumResult: AnyObject?
    let enumStatus = SecItemCopyMatching(enumQuery as CFDictionary, &enumResult)
    // A locked keybag reports errSecInteractionNotAllowed wholesale — treat as
    // "cannot enumerate right now", not an error (the sweep runs interactively).
    if enumStatus == errSecItemNotFound || enumStatus == errSecInteractionNotAllowed { exit(0) }
    guard enumStatus == errSecSuccess else { die(2, "Failed to enumerate keychain (OSStatus \(enumStatus))") }
    var listSeen = Set<String>()
    for item in (enumResult as? [[String: Any]]) ?? [] {
        guard let svce = item[kSecAttrService as String] as? String, svce.hasPrefix(prefix) else { continue }
        guard let acct = item[kSecAttrAccount as String] as? String, acct == account else { continue }
        let group = item[kSecAttrAccessGroup as String] as? String ?? ""
        guard group != kAccessGroup else { continue }
        if listSeen.insert(svce).inserted { print(svce) }
    }

case "migrate-orphans":
    // migrate-orphans <prefix> <account> — re-home every pre-#279 orphan (a
    // data-protection item under a non-concrete access group) matching
    // <prefix>+<account> into the concrete kAccessGroup. Reads each value by its
    // exact persistent ref behind the shared LAContext (one Touch ID for the
    // whole batch), adds the pinned copy (add-before-delete: a failed add leaves
    // the orphan intact), then deletes the orphan by persistent ref. Prints one
    // line per item:
    //   OK <service>               re-homed
    //   WARN <service> <detail>    pinned copy written but orphan not removed
    //   FAIL <service> <detail>    could not re-home (orphan left intact)
    // Exit 4 if the user cancels Touch ID; items processed before the cancel are
    // already committed, and re-running continues where it left off (idempotent).
    guard args.count == 4 else { die(2, "Usage: agents-keychain migrate-orphans <prefix> <account>") }
    let (prefix, account) = (args[2], args[3])
    guard !prefix.isEmpty else { die(2, "migrate-orphans requires non-empty prefix") }
    let enumQuery: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecMatchLimit: kSecMatchLimitAll,
        kSecReturnAttributes: kCFBooleanTrue!,
        kSecReturnPersistentRef: kCFBooleanTrue!,
        kSecUseDataProtectionKeychain: kCFBooleanTrue!,
        kSecAttrSynchronizable: kCFBooleanFalse!,
    ]
    var enumResult: AnyObject?
    let enumStatus = SecItemCopyMatching(enumQuery as CFDictionary, &enumResult)
    if enumStatus == errSecItemNotFound { exit(0) }
    guard enumStatus == errSecSuccess else { die(2, "Failed to enumerate keychain (OSStatus \(enumStatus))") }
    struct Orphan { let service: String; let ref: Data; let group: String }
    var orphans: [Orphan] = []
    var seenRefs = Set<Data>()
    for item in (enumResult as? [[String: Any]]) ?? [] {
        guard let svce = item[kSecAttrService as String] as? String, svce.hasPrefix(prefix) else { continue }
        guard let acct = item[kSecAttrAccount as String] as? String, acct == account else { continue }
        let group = item[kSecAttrAccessGroup as String] as? String ?? ""
        guard group != kAccessGroup else { continue }
        guard let ref = item[kSecValuePersistentRef as String] as? Data else { continue }
        if seenRefs.insert(ref).inserted { orphans.append(Orphan(service: svce, ref: ref, group: group)) }
    }
    if orphans.isEmpty { exit(0) }
    for o in orphans {
        // Read the orphan by its exact persistent ref — group-agnostic, and it
        // pops Touch ID (reused across the batch via the shared auth context).
        let readQuery: [CFString: Any] = [
            kSecValuePersistentRef: o.ref,
            kSecReturnData: kCFBooleanTrue!,
            kSecUseAuthenticationContext: authContext,
            kSecUseAuthenticationUI: kSecUseAuthenticationUIAllow,
            kSecUseOperationPrompt: "Migrate agents-cli secrets to the current keychain group" as CFString,
        ]
        var readResult: AnyObject?
        let rStatus = SecItemCopyMatching(readQuery as CFDictionary, &readResult)
        dieIfCancelled(rStatus)
        guard rStatus == errSecSuccess, let data = readResult as? Data else {
            print("FAIL \(o.service) read=\(rStatus)")
            continue
        }
        // Add the pinned copy (clear any stale concrete-group copy first so the
        // add can't hit errSecDuplicateItem).
        SecItemDelete(dpBase(service: o.service, account: account) as CFDictionary)
        var addAttrs = dpBase(service: o.service, account: account)
        addAttrs[kSecAttrAccessControl] = buildBiometryAccessControl()
        addAttrs[kSecValueData] = data
        let addStatus = SecItemAdd(addAttrs as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            print("FAIL \(o.service) add=\(addStatus)")
            continue
        }
        // Delete the orphan by persistent ref — exact, never the pinned copy.
        let delStatus = SecItemDelete([kSecValuePersistentRef: o.ref] as CFDictionary)
        if delStatus == errSecSuccess || delStatus == errSecItemNotFound {
            print("OK \(o.service)")
        } else {
            print("WARN \(o.service) orphan-delete=\(delStatus) (pinned copy in place)")
        }
    }

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
