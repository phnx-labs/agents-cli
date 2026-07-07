import AppKit
import Foundation

struct RPCError: Error {
    let code: String
    let message: String

    static func notFound(_ what: String) -> RPCError {
        RPCError(code: "element_not_found", message: what)
    }
    static func stale() -> RPCError {
        RPCError(code: "element_stale", message: "element handle expired, re-describe")
    }
    static func unsupported(_ action: String) -> RPCError {
        RPCError(code: "action_unsupported", message: action)
    }
    static func denied(_ reason: String) -> RPCError {
        RPCError(code: "permission_denied", message: reason)
    }
    static func excluded(_ bundleId: String) -> RPCError {
        RPCError(code: "target_excluded", message: bundleId)
    }
    static func appMissing(_ pid: Int) -> RPCError {
        RPCError(code: "app_not_found", message: "pid \(pid)")
    }
    static func invalid(_ msg: String) -> RPCError {
        RPCError(code: "invalid_params", message: msg)
    }
}

// HARD floor — the helper refuses to operate on these bundle ids regardless
// of what the user lists in `~/.agents/permissions/groups/`. These are TCC
// escalation paths: driving them would let an attacker silently re-grant
// other TCC permissions (Accessibility, Screen Recording) without the
// user's knowledge. Everything else is user-controlled via Computer(...)
// permission patterns — Terminal, iTerm, Keychain, the Rush app, etc. are
// all USER-opinion now, not our opinion.
let HARD_FLOOR_DENY: Set<String> = [
    "com.apple.tccd",
    "com.apple.SecurityAgent",
    "com.apple.systempreferences",
]

// Look up the bundle id for a pid, or "" if we can't see the process. Used
// by both the hard-floor check and the allow-list check.
func bundleIdForPid(_ pid: Int) -> String {
    NSWorkspace.shared.runningApplications.first { Int($0.processIdentifier) == pid }?.bundleIdentifier ?? ""
}

// Centralized gate called by every action method that targets a pid. Two
// stages:
//   1. HARD_FLOOR_DENY — overrides any user allow rule, returns
//      target_excluded so the caller knows this is a fixed policy.
//   2. policy.allow — must contain the bundle id, else permission_denied.
//
// Fail-safe default: when the policy file is missing or unparseable the
// helper boots with an empty allow set, so this check rejects everything.
func ensurePidAllowed(_ pid: Int) throws {
    let bundleId = bundleIdForPid(pid)
    if HARD_FLOOR_DENY.contains(bundleId) {
        throw RPCError.excluded(bundleId)
    }
    if !policy.allow.contains(bundleId) {
        throw RPCError(code: "permission_denied",
                       message: "pid \(pid) (\(bundleId.isEmpty ? "unknown bundle" : bundleId)) not in allow list — add Computer(\(bundleId.isEmpty ? "<bundle-id>" : bundleId)) to a permissions group, then `agents computer reload`")
    }
}

final class Dispatcher {
    let cache: ElementCache

    init(cache: ElementCache) {
        self.cache = cache
    }

    func dispatch(method: String, params: [String: Any]) throws -> [String: Any] {
        switch method {
        case "ping":
            return ["pong": true]
        case "trust_status":
            // Diagnostic: report AX trust + identity without throwing. Useful
            // when TCC grants look right in the UI but AX calls still 403.
            let pid = Int(ProcessInfo.processInfo.processIdentifier)
            let path = Bundle.main.executablePath ?? CommandLine.arguments.first ?? ""
            return [
                "trusted": AX.isTrusted(),
                "pid": pid,
                "path": path,
            ]
        case "list_apps":
            return try Apps.listApps()
        case "describe":
            return try AX.describe(params: params, cache: cache)
        case "click":
            return try AX.click(params: params, cache: cache)
        case "type":
            return try AX.setValue(params: params, cache: cache)
        case "key":
            return try Events.sendKey(params: params)
        case "type_text":
            return try Events.typeText(params: params)
        case "ax_action":
            return try AX.axAction(params: params, cache: cache)
        case "set_focus":
            return try AX.setFocus(params: params, cache: cache)
        case "scroll":
            return try AX.scroll(params: params, cache: cache)
        case "screenshot":
            return try Screenshot.capture(params: params)
        case "wait":
            return try Wait.run(params: params, cache: cache)
        case "drag":
            return try Mouse.drag(params: params, cache: cache)
        case "focus_window":
            return try Mouse.focusWindow(params: params)
        case "right_click":
            return try Mouse.rightClick(params: params, cache: cache)
        case "get_text":
            return try AX.getText(params: params, cache: cache)
        case "notify":
            return try Notify.post(params: params)
        case "launch_app":
            return try Apps.launchApp(params: params)
        default:
            throw RPCError(code: "method_not_found", message: method)
        }
    }
}

// Small helpers for poking at untyped RPC param dicts.
enum Params {
    static func int(_ p: [String: Any], _ key: String) throws -> Int {
        if let v = p[key] as? Int { return v }
        if let v = p[key] as? Double { return Int(v) }
        if let v = p[key] as? String, let i = Int(v) { return i }
        throw RPCError.invalid("missing int param: \(key)")
    }
    static func intOpt(_ p: [String: Any], _ key: String) -> Int? {
        if let v = p[key] as? Int { return v }
        if let v = p[key] as? Double { return Int(v) }
        return nil
    }
    static func string(_ p: [String: Any], _ key: String) throws -> String {
        if let v = p[key] as? String { return v }
        throw RPCError.invalid("missing string param: \(key)")
    }
    static func stringOpt(_ p: [String: Any], _ key: String) -> String? {
        return p[key] as? String
    }
    static func bool(_ p: [String: Any], _ key: String, default def: Bool = false) -> Bool {
        if let v = p[key] as? Bool { return v }
        return def
    }
}
