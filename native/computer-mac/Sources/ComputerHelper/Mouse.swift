import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

// Private SPI: the only bridge from an AXUIElement window to its CGWindowID
// (the id `screenshot --list` reports). Stable across macOS releases for
// years but unsupported — callers must treat a non-.success return as "no id"
// and fall back to title matching, never as a hard error.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ windowID: inout CGWindowID) -> AXError

// Mouse-based interactions: drag and right-click. Prefers native AX actions
// when the element supports them; falls back to synthesized CGEvents posted
// to the target pid.
enum Mouse {

    // MARK: - drag

    static func drag(params: [String: Any], cache: ElementCache) throws -> [String: Any] {
        try AX.ensureTrusted()
        let pid = try Params.int(params, "pid")

        // Hard floor + user allow list. Throws permission_denied / target_excluded
        // before any CGEvent is synthesized.
        try ensurePidAllowed(pid)

        let button = Params.stringOpt(params, "button") ?? "left"
        guard button == "left" || button == "right" else {
            throw RPCError.invalid("button must be 'left' or 'right'")
        }

        let fromPt = try resolveSource(params: params, pid: pid, cache: cache)
        let toPt = try resolveDest(params: params, pid: pid, cache: cache)

        // Try native AX move if both endpoints came from elements and the
        // source supports AXMove. Rarely honored but cheapest when it is.
        if let srcId = Params.stringOpt(params, "element_id"),
           let srcEl = cache.get(pid: pid, id: srcId) {
            let actions = copyActionNames(srcEl)
            if actions.contains("AXMove") {
                let err = AXUIElementPerformAction(srcEl, "AXMove" as CFString)
                if err == .success {
                    return ["ok": true, "method": "AXMove"]
                }
            }
        }

        // Fallback: synthesize the full move->down->drag->up sequence through
        // the centralized synthesizer (HID tap, fully-stamped events) so it
        // lands on Chromium/UXP/canvas surfaces, not just plain AppKit views.
        let background = Params.bool(params, "background")
        CursorSprite.shared.showFor(drag: fromPt)
        let method = try EventSynth.drag(from: fromPt, to: toPt, pid: pid, button: button, background: background)
        // Brief lingering flash at destination, then hide.
        CursorSprite.shared.flash(at: toPt)

        return ["ok": true, "method": method]
    }

    // MARK: - right click

    static func rightClick(params: [String: Any], cache: ElementCache) throws -> [String: Any] {
        try AX.ensureTrusted()
        let pid = try Params.int(params, "pid")

        // Gate BEFORE the coords-fallback branch to close the bypass path.
        try ensurePidAllowed(pid)

        // Coords fallback for canvas/games/inaccessible elements.
        if Params.stringOpt(params, "element_id") == nil {
            if let x = Params.intOpt(params, "x"), let y = Params.intOpt(params, "y") {
                let pt = CGPoint(x: x, y: y)
                CursorSprite.shared.flash(at: pt)
                let method = try EventSynth.click(at: pt, pid: pid, button: "right", clickCount: 1, background: Params.bool(params, "background"))
                return ["ok": true, "method": method, "at": [x, y]]
            }
            throw RPCError.invalid("pass either element_id or x,y")
        }

        let elementId = try Params.string(params, "element_id")

        guard let el = cache.get(pid: pid, id: elementId) else {
            throw RPCError.stale()
        }

        // AXShowMenu is the AX-native contextual menu trigger. When supported,
        // it's focus-free. Fall back to a synthesized right-click at element center.
        let actions = copyActionNames(el)
        if actions.contains("AXShowMenu") {
            if let center = elementCenter(el) {
                CursorSprite.shared.flash(at: center)
            }
            let err = AXUIElementPerformAction(el, "AXShowMenu" as CFString)
            if err == .success {
                return ["ok": true, "method": "AXShowMenu"]
            }
        }

        guard let center = elementCenter(el) else {
            throw RPCError(code: "action_failed", message: "element has no frame")
        }
        CursorSprite.shared.flash(at: center)
        let method = try EventSynth.click(at: center, pid: pid, button: "right", clickCount: 1, background: Params.bool(params, "background"))
        return ["ok": true, "method": method]
    }

    // MARK: - focus window

    // After NSRunningApplication.activate returns true the window-raise is
    // still propagating through WindowServer. Callers that immediately
    // screenshot or describe will race the raise and read the previous
    // foreground app. Poll frontmostApplication so the helper only reports ok
    // once the app is actually frontmost. 600 ms total: fullscreen-Space
    // switches (Parallels VMs, fullscreen editors) animate longer than the
    // same-Space raise the original 200 ms budget assumed.
    private static let focusPollTotalMs: Int = 600
    private static let focusPollIntervalMs: Int = 20

    static func focusWindow(params: [String: Any]) throws -> [String: Any] {
        let pid = try Params.int(params, "pid")

        try ensurePidAllowed(pid)

        guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else {
            throw RPCError.appMissing(pid)
        }

        let wasHidden = app.isHidden
        if wasHidden { app.unhide() }

        let ok = app.activate(options: [.activateIgnoringOtherApps])
        if !ok {
            throw RPCError(code: "action_failed", message: "activate returned false")
        }

        // Optional window-level raise. App-level activate only brings forward
        // the app's most-recently-used window/Space; when one app has windows
        // across several Spaces (e.g. two fullscreen VMs) the caller selects
        // one by window_id (from `screenshot --list`) or title substring.
        // Two strategies, in order:
        //   1. kAXWindowsAttribute match -> AXRaise. Works for same-Space and
        //      minimized windows.
        //   2. The app's "Window" menu -> AXPress the item whose title
        //      matches. Fullscreen-Space windows on inactive Spaces are
        //      absent from kAXWindowsAttribute entirely, but document-based
        //      apps list every window in the Window menu, and pressing the
        //      item switches Spaces (this is what works for Parallels VMs).
        var raisedWindow = false
        var windowInfo: [String: Any] = [:]
        let windowId = Params.intOpt(params, "window_id")
        let title = Params.stringOpt(params, "title")
        if windowId != nil || title != nil {
            try AX.ensureTrusted()
            // A bare window_id still needs a title for the menu fallback —
            // resolve it from the window server (needs Screen Recording,
            // which the helper already holds for screenshots).
            let titleQuery = title ?? windowId.flatMap { windowTitleForId($0, pid: pid) }
            if let (win, info) = matchWindow(pid: pid, windowId: windowId, title: titleQuery) {
                // Mark main first so the raise targets this window, then
                // AXRaise pulls it (and its Space) forward.
                AXUIElementSetAttributeValue(win, kAXMainAttribute as CFString, kCFBooleanTrue)
                let raiseErr = AXUIElementPerformAction(win, kAXRaiseAction as CFString)
                if raiseErr != .success {
                    throw RPCError(code: "action_failed", message: "AXRaise failed (AXError \(raiseErr.rawValue)) for window_id=\(windowId.map(String.init) ?? "-") title=\(titleQuery ?? "-")")
                }
                raisedWindow = true
                windowInfo = info
                windowInfo["method"] = "ax_raise"
            } else if let q = titleQuery, let pressed = pressWindowMenuItem(pid: pid, titleQuery: q) {
                raisedWindow = true
                windowInfo = ["title": pressed, "method": "window_menu"]
            } else {
                throw RPCError(code: "element_not_found", message: "no window matching window_id=\(windowId.map(String.init) ?? "-") title=\(titleQuery ?? title ?? "-") for pid \(pid) — run `agents computer screenshot --list` to enumerate windows")
            }
        }

        let ticks = focusPollTotalMs / focusPollIntervalMs
        var elapsedMs = 0
        for _ in 0..<ticks {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(pid) {
                var result: [String: Any] = [
                    "ok": true,
                    "was_minimized": wasHidden,
                    "focus_elapsed_ms": elapsedMs,
                    "raised_window": raisedWindow,
                ]
                for (k, v) in windowInfo { result[k] = v }
                return result
            }
            Thread.sleep(forTimeInterval: Double(focusPollIntervalMs) / 1000.0)
            elapsedMs += focusPollIntervalMs
        }
        throw RPCError(code: "focus_timeout", message: "app pid=\(pid) did not become frontmost within \(focusPollTotalMs)ms (modal-blocked or invisible?)")
    }

    // Match an AXWindow by CGWindowID (via the _AXUIElementGetWindow SPI) or
    // title substring. Polls up to 300 ms: right after activate, a window can
    // take a beat to appear in kAXWindowsAttribute. Returns nil (instead of
    // throwing) so focusWindow can fall through to the Window-menu strategy.
    private static func matchWindow(pid: Int, windowId: Int?, title: String?) -> (AXUIElement, [String: Any])? {
        let deadline = Date().addingTimeInterval(0.3)
        repeat {
            let wins = axWindows(pid: pid)
            if let target = windowId {
                for w in wins {
                    var wid: CGWindowID = 0
                    if _AXUIElementGetWindow(w, &wid) == .success, Int(wid) == target {
                        return (w, ["window_id": target, "title": axTitle(w)])
                    }
                }
            }
            if let q = title?.lowercased(), !q.isEmpty {
                for w in wins where axTitle(w).lowercased().contains(q) {
                    var info: [String: Any] = ["title": axTitle(w)]
                    var wid: CGWindowID = 0
                    if _AXUIElementGetWindow(w, &wid) == .success {
                        info["window_id"] = Int(wid)
                    }
                    return (w, info)
                }
            }
            Thread.sleep(forTimeInterval: 0.05)
        } while Date() < deadline
        return nil
    }

    // Resolve a CGWindowID to its title via the window server. Window names
    // require Screen Recording permission, which the helper already holds.
    private static func windowTitleForId(_ windowId: Int, pid: Int) -> String? {
        guard let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else { return nil }
        for info in list {
            guard let num = info[kCGWindowNumber as String] as? Int, num == windowId,
                  let owner = info[kCGWindowOwnerPID as String] as? Int, owner == pid else { continue }
            if let name = info[kCGWindowName as String] as? String, !name.isEmpty {
                return name
            }
        }
        return nil
    }

    // Press the item in the app's "Window" menu whose title contains the
    // query. Menu items are enumerable regardless of which Space their window
    // lives on — unlike kAXWindowsAttribute — and pressing one performs the
    // app's own raise + Space switch. Matches the English "Window" menu only;
    // localized menu bars fall through to nil (caller reports
    // element_not_found with the --list hint).
    private static func pressWindowMenuItem(pid: Int, titleQuery: String) -> String? {
        let axApp = AXUIElementCreateApplication(pid_t(pid))
        var mbRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp, kAXMenuBarAttribute as CFString, &mbRaw) == .success,
              let mb = mbRaw, CFGetTypeID(mb) == AXUIElementGetTypeID() else { return nil }
        let menuBar = mb as! AXUIElement
        let q = titleQuery.lowercased()
        for barItem in axChildren(menuBar) where axTitle(barItem) == "Window" {
            for menu in axChildren(barItem) {
                for item in axChildren(menu) {
                    let t = axTitle(item)
                    if !t.isEmpty, t.lowercased().contains(q),
                       AXUIElementPerformAction(item, kAXPressAction as CFString) == .success {
                        return t
                    }
                }
            }
        }
        return nil
    }

    private static func axWindows(pid: Int) -> [AXUIElement] {
        let axApp = AXUIElementCreateApplication(pid_t(pid))
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &raw) == .success else { return [] }
        return raw as? [AXUIElement] ?? []
    }

    private static func axChildren(_ el: AXUIElement) -> [AXUIElement] {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &raw) == .success else { return [] }
        return raw as? [AXUIElement] ?? []
    }

    private static func axTitle(_ win: AXUIElement) -> String {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &raw) == .success,
              let s = raw as? String else { return "" }
        return s
    }

    // MARK: - helpers

    private static func resolveSource(params: [String: Any], pid: Int, cache: ElementCache) throws -> CGPoint {
        if let eid = Params.stringOpt(params, "element_id") {
            guard let el = cache.get(pid: pid, id: eid) else { throw RPCError.stale() }
            guard let c = elementCenter(el) else { throw RPCError(code: "action_failed", message: "source element has no frame") }
            return c
        }
        if let from = params["from"] as? [Any], from.count == 2,
           let x = numeric(from[0]), let y = numeric(from[1]) {
            return CGPoint(x: x, y: y)
        }
        throw RPCError.invalid("pass either element_id or from=[x, y]")
    }

    private static func resolveDest(params: [String: Any], pid: Int, cache: ElementCache) throws -> CGPoint {
        if let eid = Params.stringOpt(params, "to_element_id") {
            guard let el = cache.get(pid: pid, id: eid) else { throw RPCError.stale() }
            guard let c = elementCenter(el) else { throw RPCError(code: "action_failed", message: "destination element has no frame") }
            return c
        }
        if let to = params["to"] as? [Any], to.count == 2,
           let x = numeric(to[0]), let y = numeric(to[1]) {
            return CGPoint(x: x, y: y)
        }
        throw RPCError.invalid("pass either to_element_id or to=[x, y]")
    }

    static func elementCenter(_ el: AXUIElement) -> CGPoint? {
        var posRaw: CFTypeRef?
        var sizeRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRaw) == .success,
              AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRaw) == .success,
              let posVal = posRaw, let sizeVal = sizeRaw,
              CFGetTypeID(posVal) == AXValueGetTypeID(),
              CFGetTypeID(sizeVal) == AXValueGetTypeID() else {
            return nil
        }
        var pos = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(posVal as! AXValue, .cgPoint, &pos)
        AXValueGetValue(sizeVal as! AXValue, .cgSize, &size)
        return CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
    }

    private static func copyActionNames(_ el: AXUIElement) -> [String] {
        var arr: CFArray?
        guard AXUIElementCopyActionNames(el, &arr) == .success, let arr = arr else { return [] }
        return (arr as NSArray).compactMap { $0 as? String }
    }

    private static func numeric(_ v: Any) -> CGFloat? {
        if let d = v as? Double { return CGFloat(d) }
        if let i = v as? Int { return CGFloat(i) }
        if let s = v as? String, let d = Double(s) { return CGFloat(d) }
        return nil
    }
}
