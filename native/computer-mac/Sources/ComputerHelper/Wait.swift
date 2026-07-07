import ApplicationServices
import Foundation

// Wait primitives. Three modes:
//   1. Unconditional sleep — duration_ms in [50, 30000].
//   2. Cached-element polling — pid + element_id + until. Cheap but only
//      works for elements that already appeared in a prior describe call.
//   3. Locator polling — pid + locator (role and/or label) + until="exists".
//      Re-walks the app's live AX tree on every tick so the caller can
//      wait for newly-appearing UI (an alert, a confirmation button) that
//      did not exist at the last describe.
//
// Removes the "element_stale churn" where agents waste turns re-describing
// because the UI hasn't settled after an action.
enum Wait {
    private static let pollIntervalMs: Int = 100
    private static let minDurationMs: Int = 50
    private static let maxDurationMs: Int = 30000
    private static let defaultTimeoutMs: Int = 5000
    private static let locatorMaxDepth: Int = 40

    static func run(params: [String: Any], cache: ElementCache) throws -> [String: Any] {
        if let durationMs = Params.intOpt(params, "duration_ms") {
            guard durationMs >= minDurationMs && durationMs <= maxDurationMs else {
                throw RPCError.invalid("duration_ms must be in [\(minDurationMs), \(maxDurationMs)]")
            }
            Thread.sleep(forTimeInterval: Double(durationMs) / 1000.0)
            return ["ok": true, "waited_ms": durationMs, "satisfied": true]
        }

        let pid = Params.intOpt(params, "pid")
        let until = Params.stringOpt(params, "until") ?? "exists"
        guard ["exists", "enabled", "disappears"].contains(until) else {
            throw RPCError.invalid("until must be 'exists', 'enabled', or 'disappears'")
        }
        guard let pid = pid else {
            throw RPCError.invalid("pass either duration_ms, or pid + (element_id or locator) + until")
        }

        // Hard floor + user allow list. Goes here (after the duration_ms
        // early-return that doesn't need a pid) but BEFORE any element_id /
        // locator branch — the locator branch walks the live AX tree, which
        // is exactly the bypass we need to close.
        try ensurePidAllowed(pid)

        let elementId = Params.stringOpt(params, "element_id")
        let locator = params["locator"] as? [String: Any]
        guard elementId != nil || locator != nil else {
            throw RPCError.invalid("pass either element_id or locator")
        }
        if locator != nil && until == "disappears" {
            // disappears requires a stable identity to track; the live re-walk
            // path matches anything that fits the locator, so a different
            // element with the same role/label would mask the disappearance.
            throw RPCError.invalid("locator mode supports until='exists' or 'enabled' only")
        }

        let timeoutMs = Params.intOpt(params, "timeout_ms") ?? defaultTimeoutMs
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        let start = Date()
        var satisfied = false
        var foundId: String? = nil

        while Date() < deadline {
            if let locator = locator {
                if let id = matchLocator(pid: pid, locator: locator, until: until, cache: cache) {
                    foundId = id
                    satisfied = true
                    break
                }
            } else if let eid = elementId {
                if isSatisfied(pid: pid, elementId: eid, until: until, cache: cache) {
                    satisfied = true
                    break
                }
            }
            Thread.sleep(forTimeInterval: Double(pollIntervalMs) / 1000.0)
        }

        let elapsed = Int(Date().timeIntervalSince(start) * 1000)
        var result: [String: Any] = ["ok": true, "waited_ms": elapsed, "satisfied": satisfied]
        if let id = foundId { result["element_id"] = id }
        return result
    }

    private static func isSatisfied(pid: Int, elementId: String, until: String, cache: ElementCache) -> Bool {
        let el = cache.get(pid: pid, id: elementId)
        switch until {
        case "disappears":
            guard let el = el else { return true }
            // Probe an attribute; if it fails, the element is gone.
            var raw: CFTypeRef?
            let err = AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &raw)
            return err != .success
        case "exists":
            guard let el = el else { return false }
            var raw: CFTypeRef?
            return AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &raw) == .success
        case "enabled":
            guard let el = el else { return false }
            var raw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(el, kAXEnabledAttribute as CFString, &raw) == .success else {
                return false
            }
            return (raw as? Bool) ?? false
        default:
            return false
        }
    }

    // Walks the app's live AX tree from the application root looking for an
    // element that matches the locator. On first match, caches the element
    // with a fresh ref and returns it. Called every poll tick — the cost is
    // bounded by locatorMaxDepth and stops on first match.
    //
    // Locator shape: { role?: String, label?: String, identifier?: String }
    // At least one of role/label/identifier must be non-empty.
    private static func matchLocator(pid: Int, locator: [String: Any], until: String, cache: ElementCache) -> String? {
        let wantRole = (locator["role"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let wantLabel = (locator["label"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let wantIdentifier = (locator["identifier"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        guard wantRole != nil || wantLabel != nil || wantIdentifier != nil else { return nil }

        let root = AXUIElementCreateApplication(pid_t(pid))
        return search(element: root, depth: 0,
                       wantRole: wantRole, wantLabel: wantLabel, wantIdentifier: wantIdentifier,
                       until: until, pid: pid, cache: cache)
    }

    private static func search(element: AXUIElement, depth: Int,
                                wantRole: String?, wantLabel: String?, wantIdentifier: String?,
                                until: String, pid: Int, cache: ElementCache) -> String? {
        if depth > locatorMaxDepth { return nil }

        if matches(element: element, wantRole: wantRole, wantLabel: wantLabel, wantIdentifier: wantIdentifier) {
            if until == "enabled" {
                var raw: CFTypeRef?
                guard AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &raw) == .success,
                      (raw as? Bool) == true else {
                    // Found but not yet enabled — keep searching siblings then return.
                    return descend(element: element, depth: depth,
                                    wantRole: wantRole, wantLabel: wantLabel, wantIdentifier: wantIdentifier,
                                    until: until, pid: pid, cache: cache)
                }
            }
            let id = cache.nextRefId(pid: pid)
            cache.put(pid: pid, id: id, element: element)
            return id
        }

        return descend(element: element, depth: depth,
                        wantRole: wantRole, wantLabel: wantLabel, wantIdentifier: wantIdentifier,
                        until: until, pid: pid, cache: cache)
    }

    private static func descend(element: AXUIElement, depth: Int,
                                 wantRole: String?, wantLabel: String?, wantIdentifier: String?,
                                 until: String, pid: Int, cache: ElementCache) -> String? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
              let kids = raw as? [AXUIElement] else { return nil }
        for child in kids {
            if let found = search(element: child, depth: depth + 1,
                                    wantRole: wantRole, wantLabel: wantLabel, wantIdentifier: wantIdentifier,
                                    until: until, pid: pid, cache: cache) {
                return found
            }
        }
        return nil
    }

    private static func matches(element: AXUIElement, wantRole: String?, wantLabel: String?, wantIdentifier: String?) -> Bool {
        if let want = wantRole {
            var raw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &raw) == .success,
                  let role = raw as? String, role == want else {
                return false
            }
        }
        if let want = wantIdentifier {
            var raw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXIdentifierAttribute as CFString, &raw) == .success,
                  let id = raw as? String, id == want else {
                return false
            }
        }
        if let want = wantLabel {
            // Try title, description, label-value, then static value.
            let candidates: [CFString] = [
                kAXTitleAttribute as CFString,
                kAXDescriptionAttribute as CFString,
                kAXValueAttribute as CFString,
            ]
            var hit = false
            for attr in candidates {
                var raw: CFTypeRef?
                if AXUIElementCopyAttributeValue(element, attr, &raw) == .success,
                   let s = raw as? String, s == want {
                    hit = true
                    break
                }
            }
            if !hit { return false }
        }
        return true
    }
}
