import ApplicationServices
import AppKit
import Foundation

// Roles we return to the agent as interactable. Containers not in this set
// are flattened out (we recurse into their children but don't emit a node).
private let INTERACTABLE_ROLES: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
    "AXComboBox", "AXTextField", "AXTextArea", "AXSearchField",
    "AXLink", "AXMenuItem", "AXMenuBarItem", "AXTab", "AXSlider",
    "AXStepper", "AXDisclosureTriangle", "AXScrollBar", "AXOutline",
    "AXRow", "AXCell", "AXList", "AXTable", "AXTabGroup",
    "AXToolbar", "AXGroup", // groups kept only if labeled — filtered below
]

// Roles that carry content we surface (text/images) when labeled.
private let CONTENT_ROLES: Set<String> = [
    "AXStaticText", "AXImage", "AXHeading",
]

private let MAX_ELEMENTS = 500
private let MAX_DEPTH_DEFAULT = 25

enum AX {

    // MARK: - Trust / permissions

    static func ensureTrusted() throws {
        if !isTrusted() {
            throw RPCError.denied("Accessibility not granted — enable in System Settings > Privacy & Security > Accessibility")
        }
    }

    static func isTrusted() -> Bool {
        // AXIsProcessTrusted() is the non-prompting variant and doesn't have
        // the CFBoolean-bridging quirks of AXIsProcessTrustedWithOptions.
        return AXIsProcessTrusted()
    }

    // MARK: - describe

    static func describe(params: [String: Any], cache: ElementCache) throws -> [String: Any] {
        try ensureTrusted()
        let pid = try Params.int(params, "pid")
        let maxDepth = Params.intOpt(params, "max_depth") ?? MAX_DEPTH_DEFAULT

        // Gate: hard floor + user allow list. Throws before any AX call.
        try ensurePidAllowed(pid)

        guard runningPids().contains(pid) else {
            throw RPCError.appMissing(pid)
        }

        _ = cache.beginDescribe(pid: pid)
        let app = AXUIElementCreateApplication(pid_t(pid))

        var counter = 0
        var truncated = false
        let tree = walk(element: app, pid: pid, depth: 0, maxDepth: maxDepth, counter: &counter, truncated: &truncated, cache: cache)

        return [
            "pid": pid,
            "tree": tree as Any,
            "element_count": counter,
            "truncated": truncated,
        ]
    }

    // MARK: - click

    static func click(params: [String: Any], cache: ElementCache) throws -> [String: Any] {
        try ensureTrusted()
        let pid = try Params.int(params, "pid")

        // Gate BEFORE the coords-fallback branch so the bypass we previously
        // shipped (drive a denied app by passing x/y) is closed.
        try ensurePidAllowed(pid)

        // Coords fallback: if the caller passes x/y (and no element_id), synthesize
        // a click at those screen coords. Used for canvas apps, games, and any
        // element the AX tree doesn't expose — the accessibility equivalent of
        // browser_click's coordinate mode.
        let clickCount = Params.intOpt(params, "count") ?? 1
        let background = Params.bool(params, "background")
        if Params.stringOpt(params, "element_id") == nil {
            if let x = Params.intOpt(params, "x"), let y = Params.intOpt(params, "y") {
                let pt = CGPoint(x: x, y: y)
                CursorSprite.shared.flash(at: pt)
                let method = try EventSynth.click(at: pt, pid: pid, button: "left", clickCount: clickCount, background: background)
                return ["ok": true, "action": method, "at": [x, y]]
            }
            throw RPCError.invalid("pass either element_id or x,y")
        }

        let elementId = try Params.string(params, "element_id")

        guard let el = cache.get(pid: pid, id: elementId) else {
            throw RPCError.stale()
        }

        // Focus-safe order, picked by role + capability:
        //   1. AXMenuBarItem — try AXShowMenu (documented action for opening
        //      a menu, focus-safe), then AXPress. We deliberately do NOT
        //      synthesize a CGEvent here even though Qt's AXPress doesn't
        //      render a visible popup — synthesizing a mouse click would
        //      bring the target app to the foreground and steal focus from
        //      the user. For Qt apps the AX tree already exposes the full
        //      menu structure even when the menu isn't visible, so callers
        //      should locate the menu *item* directly via describe and
        //      AXPress it — no need to "open" the menu first.
        //   2. AXPress — buttons, menu items, links. Focus-safe.
        //   3. Synthesized left-click at the element's center — last resort
        //      for elements without AXPress. Posted to pid to minimize
        //      focus disruption, but Quartz still activates the target.
        let actions = copyActionNames(el)
        let role = stringAttr(el, kAXRoleAttribute as CFString) ?? ""

        if role == "AXMenuBarItem" {
            if let center = Mouse.elementCenter(el) {
                CursorSprite.shared.flash(at: center)
            }
            if actions.contains("AXShowMenu") {
                let err = AXUIElementPerformAction(el, "AXShowMenu" as CFString)
                if err == .success {
                    return ["ok": true, "action": "AXShowMenu"]
                }
            }
            if actions.contains(kAXPressAction as String) {
                let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
                if err == .success {
                    return ["ok": true, "action": "AXPress"]
                }
            }
            throw RPCError(code: "action_failed", message: "menu bar item supports neither AXShowMenu nor AXPress focus-safely; locate its child menu item directly and AXPress that")
        }

        if actions.contains(kAXPressAction as String) {
            // Flash at the element's center for visual feedback even though
            // AXPress doesn't move the cursor or hit-test by coords.
            if let center = Mouse.elementCenter(el) {
                CursorSprite.shared.flash(at: center)
            }
            let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
            if err != .success {
                throw RPCError(code: "action_failed", message: "AXPerformAction(AXPress)=\(err.rawValue)")
            }
            return ["ok": true, "action": "AXPress"]
        }

        guard let center = Mouse.elementCenter(el) else {
            throw RPCError(code: "action_failed", message: "element has no frame and no AXPress action")
        }
        CursorSprite.shared.flash(at: center)
        let method = try EventSynth.click(at: center, pid: pid, button: "left", clickCount: clickCount, background: background)
        return ["ok": true, "action": method, "at": [Int(center.x), Int(center.y)]]
    }

    // MARK: - type / setValue

    static func setValue(params: [String: Any], cache: ElementCache) throws -> [String: Any] {
        try ensureTrusted()
        let pid = try Params.int(params, "pid")
        let text = try Params.string(params, "text")

        // Gate BEFORE the coords-fallback branch — same reason as click().
        try ensurePidAllowed(pid)

        // Coords fallback: click at (x,y) to focus the input, then paste the
        // text via clipboard + cmd+V. Works on canvas apps and any element
        // the AX tree doesn't expose as a text input. Note: this touches the
        // user's clipboard. For predictability we don't attempt to save/restore.
        if Params.stringOpt(params, "element_id") == nil {
            if let x = Params.intOpt(params, "x"), let y = Params.intOpt(params, "y") {
                return try setValueByCoords(pid: pid, x: x, y: y, text: text)
            }
            throw RPCError.invalid("pass either element_id or x,y")
        }

        let elementId = try Params.string(params, "element_id")

        guard let el = cache.get(pid: pid, id: elementId) else {
            throw RPCError.stale()
        }

        // Refuse to inject text into secure (password) fields unless the caller
        // explicitly opts in. Prevents accidental password autofill by the agent.
        if isSecureField(el) && !Params.bool(params, "allow_secure_field") {
            throw RPCError.denied("secure text field — set allow_secure_field=true to override")
        }

        var settable = DarwinBoolean(false)
        AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable)
        if !settable.boolValue {
            throw RPCError.unsupported("AXValue not settable on element \(elementId)")
        }

        let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFTypeRef)
        if err != .success {
            throw RPCError(code: "action_failed", message: "AXSetAttributeValue=\(err.rawValue)")
        }
        // Many fields (Photoshop's transform W/H, form inputs) only push the
        // written value into the document model on Return/blur — AXValue alone
        // updates the display but is never committed. Opt-in commit closes that
        // gap: prefer the AX-native AXConfirm action, else synthesize Return.
        var committed = false
        if Params.bool(params, "commit") {
            committed = commitField(el: el, pid: pid)
        }
        return ["ok": true, "committed": committed]
    }

    // Push a just-written field value into the app's model. AXConfirm is the
    // documented AX commit; when unsupported, a Return keystroke to the pid is
    // the universal fallback (the field is focused after setValue).
    private static func commitField(el: AXUIElement, pid: Int) -> Bool {
        let actions = copyActionNames(el)
        if actions.contains("AXConfirm") {
            if AXUIElementPerformAction(el, "AXConfirm" as CFString) == .success {
                return true
            }
        }
        if let down = CGEvent(keyboardEventSource: EventSynth.source, virtualKey: 0x24, keyDown: true),
           let up = CGEvent(keyboardEventSource: EventSynth.source, virtualKey: 0x24, keyDown: false) {
            down.postToPid(pid_t(pid))
            up.postToPid(pid_t(pid))
            return true
        }
        return false
    }

    // MARK: - arbitrary AX action

    // Perform any AX action the element advertises (AXPress, AXConfirm,
    // AXCancel, AXRaise, AXIncrement, AXShowMenu, ...). The previous surface
    // hardcoded a fixed set; this lets callers drive actions the tree exposes
    // without us enumerating every one.
    static func axAction(params: [String: Any], cache: ElementCache) throws -> [String: Any] {
        try ensureTrusted()
        let pid = try Params.int(params, "pid")
        try ensurePidAllowed(pid)
        let elementId = try Params.string(params, "element_id")
        let action = try Params.string(params, "action")

        guard let el = cache.get(pid: pid, id: elementId) else {
            throw RPCError.stale()
        }
        let available = copyActionNames(el)
        guard available.contains(action) else {
            throw RPCError.unsupported("element does not support \(action); available: \(available.joined(separator: ", "))")
        }
        let err = AXUIElementPerformAction(el, action as CFString)
        if err != .success {
            throw RPCError(code: "action_failed", message: "AXPerformAction(\(action))=\(err.rawValue)")
        }
        return ["ok": true, "action": action]
    }

    // MARK: - focus

    // Set keyboard focus to an element (kAXFocusedAttribute = true) so a
    // subsequent key/type lands in the right field without a synthesized click.
    static func setFocus(params: [String: Any], cache: ElementCache) throws -> [String: Any] {
        try ensureTrusted()
        let pid = try Params.int(params, "pid")
        try ensurePidAllowed(pid)
        let elementId = try Params.string(params, "element_id")
        guard let el = cache.get(pid: pid, id: elementId) else {
            throw RPCError.stale()
        }
        var settable = DarwinBoolean(false)
        AXUIElementIsAttributeSettable(el, kAXFocusedAttribute as CFString, &settable)
        if !settable.boolValue {
            throw RPCError.unsupported("AXFocused not settable on element \(elementId)")
        }
        let err = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        if err != .success {
            throw RPCError(code: "action_failed", message: "AXSetFocused=\(err.rawValue)")
        }
        return ["ok": true]
    }

    // MARK: - setValue coord fallback

    private static func setValueByCoords(pid: Int, x: Int, y: Int, text: String) throws -> [String: Any] {
        // Focus the input by clicking at (x,y) first.
        let pt = CGPoint(x: x, y: y)
        CursorSprite.shared.flash(at: pt)
        _ = try EventSynth.click(at: pt, pid: pid, button: "left", clickCount: 1, background: false)
        Thread.sleep(forTimeInterval: 0.05)

        // Put text on the pasteboard and paste. NSPasteboard.general is
        // available without entitlements for text content.
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        Thread.sleep(forTimeInterval: 0.02)

        // Post cmd+V to the target pid. Keycode 0x09 = V.
        guard let kdown = CGEvent(keyboardEventSource: nil, virtualKey: 0x09, keyDown: true),
              let kup = CGEvent(keyboardEventSource: nil, virtualKey: 0x09, keyDown: false) else {
            throw RPCError(code: "action_failed", message: "could not create paste event")
        }
        kdown.flags = .maskCommand
        kup.flags = .maskCommand
        kdown.postToPid(pid_t(pid))
        kup.postToPid(pid_t(pid))

        return ["ok": true, "method": "ClipboardPaste", "at": [x, y]]
    }

    // MARK: - get_text

    static func getText(params: [String: Any], cache: ElementCache) throws -> [String: Any] {
        try ensureTrusted()
        let pid = try Params.int(params, "pid")
        let maxChars = min(Params.intOpt(params, "max_chars") ?? 50_000, 200_000)

        try ensurePidAllowed(pid)

        // Pick a root: either the element the caller named, or the whole app.
        let root: AXUIElement
        if let elementId = Params.stringOpt(params, "element_id") {
            guard let el = cache.get(pid: pid, id: elementId) else {
                throw RPCError.stale()
            }
            root = el
        } else {
            guard runningPids().contains(pid) else {
                throw RPCError.appMissing(pid)
            }
            root = AXUIElementCreateApplication(pid_t(pid))
        }

        var pieces: [String] = []
        var charCount: Int = 0
        collectText(element: root, depth: 0, into: &pieces, charCount: &charCount, charBudget: maxChars)
        var text = pieces.joined(separator: "\n")
        if text.count > maxChars {
            text = String(text.prefix(maxChars)) + "\n\n... (content truncated)"
        }
        return [
            "text": text,
            "char_count": text.count,
        ]
    }

    // collectText tracks a running character count incremented O(1) per
    // append, instead of re-joining the pieces array on every node visit
    // (which made the walk O(n^2) in piece count — visible on documents
    // with 200+ text fragments).
    private static func collectText(element: AXUIElement, depth: Int, into pieces: inout [String], charCount: inout Int, charBudget: Int) {
        if charCount >= charBudget { return }
        if depth > 40 { return }

        let role = stringAttr(element, kAXRoleAttribute as CFString) ?? ""

        // AXValue on text elements is the text itself.
        if role == "AXStaticText" || role == "AXTextField" || role == "AXTextArea" || role == "AXSearchField" {
            if let v = stringAttr(element, kAXValueAttribute as CFString), !v.isEmpty {
                pieces.append(v)
                charCount += v.count + 1
                return // text leaves don't recurse
            }
        }
        // Headings get a markdown prefix.
        if role == "AXHeading" {
            if let v = bestLabel(element), !v.isEmpty {
                let piece = "## " + v
                pieces.append(piece)
                charCount += piece.count + 1
                return
            }
        }
        // Static label (title) only worth emitting if no child text will cover it.
        if let label = bestLabel(element), role == "AXButton" || role == "AXMenuItem" || role == "AXMenuBarItem" || role == "AXCheckBox" || role == "AXRadioButton" {
            // These are interactive controls — capture their label as text too.
            if !label.isEmpty {
                let piece = "[\(label)]"
                pieces.append(piece)
                charCount += piece.count + 1
            }
        }

        // Recurse.
        for child in childrenOf(element) {
            collectText(element: child, depth: depth + 1, into: &pieces, charCount: &charCount, charBudget: charBudget)
        }
    }

    // MARK: - scroll

    static func scroll(params: [String: Any], cache: ElementCache) throws -> [String: Any] {
        try ensureTrusted()
        let pid = try Params.int(params, "pid")
        try ensurePidAllowed(pid)
        let elementId = Params.stringOpt(params, "element_id")

        // If an element id is given, try AXShowMenu / AXScrollToVisible first.
        if let eid = elementId, let el = cache.get(pid: pid, id: eid) {
            let actions = copyActionNames(el)
            if actions.contains("AXScrollToVisible") {
                let err = AXUIElementPerformAction(el, "AXScrollToVisible" as CFString)
                if err == .success {
                    return ["ok": true, "method": "AXScrollToVisible"]
                }
            }
        }

        // Fallback: synthesize a scroll wheel event routed to the pid.
        let dx = Params.intOpt(params, "dx") ?? 0
        let dy = Params.intOpt(params, "dy") ?? 0
        guard dx != 0 || dy != 0 else {
            throw RPCError.invalid("either element_id or dx/dy required")
        }

        // macOS routes synthesized scroll events to whichever view is under
        // the cursor, not to the focused view. When the caller passed
        // explicit screen coords, warp the cursor first so the scroll lands
        // on the intended target rather than wherever the user left the
        // mouse. The schema in harness/tools/computer/scroll.go has always
        // declared x/y for this; the implementation previously ignored them.
        var warpedTo: [Int]? = nil
        if let x = Params.intOpt(params, "x"), let y = Params.intOpt(params, "y") {
            CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
            warpedTo = [x, y]
        }

        guard let ev = CGEvent(scrollWheelEvent2Source: EventSynth.source, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else {
            throw RPCError(code: "action_failed", message: "could not create scroll event")
        }
        // When the caller warped the cursor to a target, deliver through the HID
        // tap so the event lands on the view under that point (matching click
        // semantics); otherwise keep the focus-safe pid route.
        if warpedTo != nil {
            ev.post(tap: .cghidEventTap)
        } else {
            ev.postToPid(pid_t(pid))
        }
        var result: [String: Any] = ["ok": true, "method": "CGEvent"]
        if let at = warpedTo { result["at"] = at }
        return result
    }

    // MARK: - tree walk

    private static func walk(element: AXUIElement, pid: Int, depth: Int, maxDepth: Int, counter: inout Int, truncated: inout Bool, cache: ElementCache) -> [String: Any]? {
        if counter >= MAX_ELEMENTS {
            truncated = true
            return nil
        }
        if depth > maxDepth { return nil }

        let role = stringAttr(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
        let label = bestLabel(element)
        let value = stringAttr(element, kAXValueAttribute as CFString)
        let enabled = boolAttr(element, kAXEnabledAttribute as CFString) ?? true
        let bounds = frameAttr(element)

        let children = childrenOf(element)
        var childNodes: [[String: Any]] = []
        for child in children {
            if let node = walk(element: child, pid: pid, depth: depth + 1, maxDepth: maxDepth, counter: &counter, truncated: &truncated, cache: cache) {
                childNodes.append(node)
            }
        }

        // Decide whether to emit this element.
        let isInteractable = INTERACTABLE_ROLES.contains(role)
        let isContent = CONTENT_ROLES.contains(role) && (label != nil || (value?.isEmpty == false))
        let isRoot = depth == 0
        let hasChildren = !childNodes.isEmpty

        // Flatten empty/unlabeled groups: if we wouldn't emit, return a synthetic
        // node that just carries the children up. Caller handles.
        let shouldEmit = isRoot || isContent || (isInteractable && (label != nil || role == "AXTextField" || role == "AXTextArea" || role == "AXSearchField" || hasChildren))

        if !shouldEmit {
            if childNodes.count == 1 { return childNodes[0] }
            if childNodes.isEmpty { return nil }
            return ["role": "AXGroup", "children": childNodes]
        }

        counter += 1
        let id = cache.nextRefId(pid: pid)
        cache.put(pid: pid, id: id, element: element)

        var node: [String: Any] = [
            "id": id,
            "role": role,
            "enabled": enabled,
        ]
        if let label = label { node["label"] = label }
        if let value = value, !value.isEmpty, value != label { node["value"] = truncateForDisplay(value) }
        if let b = bounds { node["bounds"] = b }
        if !childNodes.isEmpty { node["children"] = childNodes }
        return node
    }

    // MARK: - AX attribute helpers

    private static func stringAttr(_ el: AXUIElement, _ attr: CFString) -> String? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr, &raw) == .success else { return nil }
        if let s = raw as? String { return s }
        return nil
    }

    private static func boolAttr(_ el: AXUIElement, _ attr: CFString) -> Bool? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr, &raw) == .success else { return nil }
        if let b = raw as? Bool { return b }
        return nil
    }

    private static func frameAttr(_ el: AXUIElement) -> [Int]? {
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
        return [Int(pos.x), Int(pos.y), Int(size.width), Int(size.height)]
    }

    private static func childrenOf(_ el: AXUIElement) -> [AXUIElement] {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &raw) == .success else { return [] }
        return raw as? [AXUIElement] ?? []
    }

    private static func copyActionNames(_ el: AXUIElement) -> [String] {
        var arr: CFArray?
        guard AXUIElementCopyActionNames(el, &arr) == .success, let arr = arr else { return [] }
        return (arr as NSArray).compactMap { $0 as? String }
    }

    private static func isSecureField(_ el: AXUIElement) -> Bool {
        guard let role = stringAttr(el, kAXRoleAttribute as CFString) else { return false }
        if role == "AXSecureTextField" { return true }
        if let subrole = stringAttr(el, kAXSubroleAttribute as CFString), subrole == "AXSecureTextField" {
            return true
        }
        return false
    }

    private static func bestLabel(_ el: AXUIElement) -> String? {
        for attr in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
            if let s = stringAttr(el, attr as CFString), !s.isEmpty {
                return truncateForDisplay(s)
            }
        }
        // AXStaticText often stores its text in AXValue.
        if let role = stringAttr(el, kAXRoleAttribute as CFString), role == "AXStaticText" {
            if let s = stringAttr(el, kAXValueAttribute as CFString), !s.isEmpty {
                return truncateForDisplay(s)
            }
        }
        return nil
    }

    private static func truncateForDisplay(_ s: String) -> String {
        if s.count <= 200 { return s }
        return String(s.prefix(200)) + "…"
    }

    private static func runningPids() -> Set<Int> {
        Set(NSWorkspace.shared.runningApplications.map { Int($0.processIdentifier) })
    }
}
