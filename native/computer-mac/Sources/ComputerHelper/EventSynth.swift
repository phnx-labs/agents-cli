import AppKit
import CoreGraphics
import Foundation

// Centralized mouse-event synthesis. This is the single source of truth for
// turning a (point, button, clickCount) into CGEvents that real apps accept.
//
// Why this exists: the previous implementation built events with
// `CGEvent(mouseEventSource: nil, ...)` and delivered them with
// `postToPid`, setting no auxiliary fields. That works for plain AppKit
// controls but is *silently dropped* by Chromium/CEF/UXP renderers
// (Photoshop's contextual taskbar, Electron apps, embedded web views) and by
// OpenGL canvas surfaces. Those surfaces validate that an event looks like it
// came from the real HID pipeline:
//
//   - a non-nil event source tied to HID state (.hidSystemState)
//   - kCGMouseEventClickState (the click counter) set to >= 1
//   - kCGMouseEventSubtype = NSEventSubtypeMouseEvent (3)
//   - kCGMouseEventButtonNumber set explicitly
//   - a preceding .mouseMoved so the surface has cursor-hover state
//   - a measurable down -> up dwell (a 0ms click is filtered as noise)
//   - delivery through the HID event tap with the cursor actually warped to
//     the target, so the app's internal cursor cache agrees with the event
//     location
//
// Trade-off: routing through .cghidEventTap warps the real cursor and the
// target must be frontmost. That is the correct trade-off for the helper's
// job (drive the app the caller pointed at). Callers that specifically want
// the old focus-safe behaviour for plain AppKit targets can pass
// background=true to fall back to postToPid.
enum EventSynth {

    // One HID-tied source reused for every synthesized event. nil sources are
    // what the renderer filters reject; a process-wide .hidSystemState source
    // carries the implicit-trust state those surfaces look for.
    static let source: CGEventSource? = CGEventSource(stateID: .hidSystemState)

    // NSEventSubtypeMouseEvent. Part of the telemetry Chromium's synthetic-
    // event filter checks; absent it, clicks into web/UXP content drop.
    private static let subtypeMouseEvent: Int64 = 3

    // Timing. mouseMoved must land a frame before the press so the surface's
    // cursor-tracking cache updates; the down->up dwell must be non-zero so
    // the click isn't coalesced away. Values are conservative but still well
    // under human perception.
    private static let postMoveDwell: TimeInterval = 0.012
    private static let pressDwell: TimeInterval = 0.020

    struct Buttons {
        let down: CGEventType
        let up: CGEventType
        let dragged: CGEventType
        let mouseButton: CGMouseButton
    }

    static func buttons(for name: String) -> Buttons {
        if name == "right" {
            return Buttons(down: .rightMouseDown, up: .rightMouseUp, dragged: .rightMouseDragged, mouseButton: .right)
        }
        return Buttons(down: .leftMouseDown, up: .leftMouseUp, dragged: .leftMouseDragged, mouseButton: .left)
    }

    // Stamp the auxiliary fields every synthesized mouse event needs. Applied
    // to move/down/up/dragged alike.
    private static func stamp(_ ev: CGEvent, button: CGMouseButton, clickState: Int) {
        ev.setIntegerValueField(.mouseEventClickState, value: Int64(max(clickState, 1)))
        ev.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button.rawValue))
        ev.setIntegerValueField(.mouseEventSubtype, value: subtypeMouseEvent)
    }

    private static func make(_ type: CGEventType, at pt: CGPoint, button: CGMouseButton, clickState: Int) -> CGEvent? {
        guard let ev = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: pt, mouseButton: button) else {
            return nil
        }
        stamp(ev, button: button, clickState: clickState)
        return ev
    }

    // Deliver one event. Primary path is the HID tap (real pipeline, accepted
    // by every surface). background=true keeps the legacy focus-safe postToPid
    // route for plain AppKit targets that don't need HID-level trust.
    private static func post(_ ev: CGEvent, pid: Int, background: Bool) {
        if background {
            ev.postToPid(pid_t(pid))
        } else {
            ev.post(tap: .cghidEventTap)
        }
    }

    // A full click: warp -> move -> dwell -> down -> dwell -> up. Returns the
    // delivery method used for the RPC result.
    @discardableResult
    static func click(at pt: CGPoint, pid: Int, button name: String = "left", clickCount: Int = 1, background: Bool = false) throws -> String {
        let b = buttons(for: name)

        if !background {
            // Align the OS cursor with the event location so the surface's
            // internal cursor cache agrees with where the press lands.
            CGWarpMouseCursorPosition(pt)
        }

        guard let move = make(.mouseMoved, at: pt, button: b.mouseButton, clickState: 0),
              let down = make(b.down, at: pt, button: b.mouseButton, clickState: clickCount),
              let up = make(b.up, at: pt, button: b.mouseButton, clickState: clickCount) else {
            throw RPCError(code: "action_failed", message: "could not create mouse events")
        }

        post(move, pid: pid, background: background)
        Thread.sleep(forTimeInterval: postMoveDwell)
        post(down, pid: pid, background: background)
        Thread.sleep(forTimeInterval: pressDwell)
        post(up, pid: pid, background: background)

        return background ? "postToPid" : "hidTap"
    }

    // A drag: warp -> move -> down -> dwell -> N dragged steps -> up.
    @discardableResult
    static func drag(from: CGPoint, to: CGPoint, pid: Int, button name: String = "left", steps: Int = 16, background: Bool = false) throws -> String {
        let b = buttons(for: name)

        if !background {
            CGWarpMouseCursorPosition(from)
        }

        guard let move = make(.mouseMoved, at: from, button: b.mouseButton, clickState: 0),
              let down = make(b.down, at: from, button: b.mouseButton, clickState: 1) else {
            throw RPCError(code: "action_failed", message: "could not create drag start events")
        }
        post(move, pid: pid, background: background)
        Thread.sleep(forTimeInterval: postMoveDwell)
        post(down, pid: pid, background: background)
        // Drop-target recognizers need a hold after press before the first move.
        Thread.sleep(forTimeInterval: 0.05)

        let n = max(steps, 1)
        for i in 1...n {
            let t = Double(i) / Double(n)
            let pt = CGPoint(x: from.x + (to.x - from.x) * CGFloat(t),
                             y: from.y + (to.y - from.y) * CGFloat(t))
            if !background { CGWarpMouseCursorPosition(pt) }
            if let dragEv = make(b.dragged, at: pt, button: b.mouseButton, clickState: 1) {
                post(dragEv, pid: pid, background: background)
            }
            Thread.sleep(forTimeInterval: 0.01)
        }

        guard let up = make(b.up, at: to, button: b.mouseButton, clickState: 1) else {
            throw RPCError(code: "action_failed", message: "could not create drag end event")
        }
        post(up, pid: pid, background: background)
        return background ? "postToPid" : "hidTap"
    }
}
