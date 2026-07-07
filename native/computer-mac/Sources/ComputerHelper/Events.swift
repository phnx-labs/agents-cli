import AppKit
import CoreGraphics
import Foundation

// Keyboard chord routing. Uses CGEventPostToPid so the target process
// receives the events without the user's focused app losing focus.
// "cmd+shift+s", "enter", "esc", "tab", "a", "z", "space".
enum Events {
    static func sendKey(params: [String: Any]) throws -> [String: Any] {
        let pid = try Params.int(params, "pid")
        let keys = try Params.string(params, "keys")

        // Validate pid resolves to a running app. CGEventPostToPid silently
        // no-ops for dead pids and returns no error, so without this check
        // the agent gets {"ok": true} for a pid that does not exist.
        guard NSRunningApplication(processIdentifier: pid_t(pid)) != nil else {
            throw RPCError.appMissing(pid)
        }
        try ensurePidAllowed(pid)
        let front = try checkFrontmost(pid: pid, params: params)

        let chord = try parseChord(keys)

        let down = CGEvent(keyboardEventSource: nil, virtualKey: chord.keyCode, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: chord.keyCode, keyDown: false)
        guard let down = down, let up = up else {
            throw RPCError(code: "action_failed", message: "could not create keyboard event")
        }
        down.flags = chord.flags
        up.flags = chord.flags

        down.postToPid(pid_t(pid))
        up.postToPid(pid_t(pid))
        return ["ok": true, "frontmost": front]
    }

    // Type an arbitrary unicode string into the focused field. Unlike sendKey
    // (one chord, US-ANSI keycodes only), this emits the literal characters via
    // CGEventKeyboardSetUnicodeString — punctuation, digits, mixed case, and
    // non-ASCII all work without a keycode table. Posts to the pid; the caller
    // is responsible for focusing the target first (click / set_focus).
    static func typeText(params: [String: Any]) throws -> [String: Any] {
        let pid = try Params.int(params, "pid")
        let text = try Params.string(params, "text")
        guard NSRunningApplication(processIdentifier: pid_t(pid)) != nil else {
            throw RPCError.appMissing(pid)
        }
        try ensurePidAllowed(pid)
        let front = try checkFrontmost(pid: pid, params: params)

        // Inter-character delay. Default 4ms (backward compatible); lossy
        // keyboard relays (Parallels/VM guests) can drop chars mid-stream at
        // that rate, so callers may raise it. Clamp to [1, 250]ms.
        let charDelayMs = min(250, max(1, Params.intOpt(params, "char_delay_ms") ?? 4))
        let charDelay = Double(charDelayMs) / 1000.0

        for scalar in text.unicodeScalars {
            var utf16 = Array(String(scalar).utf16)
            guard let down = CGEvent(keyboardEventSource: EventSynth.source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: EventSynth.source, virtualKey: 0, keyDown: false) else {
                throw RPCError(code: "action_failed", message: "could not create key event")
            }
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            down.postToPid(pid_t(pid))
            up.postToPid(pid_t(pid))
            Thread.sleep(forTimeInterval: charDelay)
        }

        if Params.bool(params, "commit") {
            if let down = CGEvent(keyboardEventSource: EventSynth.source, virtualKey: 0x24, keyDown: true),
               let up = CGEvent(keyboardEventSource: EventSynth.source, virtualKey: 0x24, keyDown: false) {
                down.postToPid(pid_t(pid))
                up.postToPid(pid_t(pid))
            }
        }
        return ["ok": true, "chars": text.count, "frontmost": front]
    }

    // postToPid keyboard events are silently dropped by apps that gate input
    // on key-window status (Parallels guest VMs, some Catalyst apps) — the
    // caller would see ok:true while nothing landed. Always report whether
    // the target was frontmost at post time; with require_frontmost the
    // mismatch becomes a hard error instead of a warning.
    private static func checkFrontmost(pid: Int, params: [String: Any]) throws -> Bool {
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(pid)
        if !front && Params.bool(params, "require_frontmost") {
            throw RPCError(code: "not_frontmost", message: "pid \(pid) is not the frontmost app — keystrokes would be dropped by key-window-gated targets. Run `agents computer raise` first, then retry")
        }
        return front
    }

    private struct Chord {
        let keyCode: CGKeyCode
        let flags: CGEventFlags
    }

    private static func parseChord(_ s: String) throws -> Chord {
        let parts = s.lowercased().split(separator: "+").map(String.init)
        guard let last = parts.last else { throw RPCError.invalid("empty key chord") }

        var flags: CGEventFlags = []
        for mod in parts.dropLast() {
            switch mod {
            case "cmd", "meta", "super": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "opt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            case "fn": flags.insert(.maskSecondaryFn)
            default: throw RPCError.invalid("unknown modifier: \(mod)")
            }
        }

        guard let code = keyCodeFor(last) else {
            throw RPCError.invalid("unknown key: \(last)")
        }
        return Chord(keyCode: code, flags: flags)
    }

    // A small, pragmatic subset of US-ANSI keycodes. Extended on demand.
    // Reference: HIToolbox/Events.h kVK_* constants.
    private static func keyCodeFor(_ key: String) -> CGKeyCode? {
        switch key {
        case "a": return 0x00; case "s": return 0x01; case "d": return 0x02; case "f": return 0x03
        case "h": return 0x04; case "g": return 0x05; case "z": return 0x06; case "x": return 0x07
        case "c": return 0x08; case "v": return 0x09; case "b": return 0x0B; case "q": return 0x0C
        case "w": return 0x0D; case "e": return 0x0E; case "r": return 0x0F; case "y": return 0x10
        case "t": return 0x11; case "1": return 0x12; case "2": return 0x13; case "3": return 0x14
        case "4": return 0x15; case "6": return 0x16; case "5": return 0x17; case "9": return 0x19
        case "7": return 0x1A; case "8": return 0x1C; case "0": return 0x1D; case "o": return 0x1F
        case "u": return 0x20; case "i": return 0x22; case "p": return 0x23; case "l": return 0x25
        case "j": return 0x26; case "k": return 0x28; case "n": return 0x2D; case "m": return 0x2E
        case "return", "enter": return 0x24
        case "tab": return 0x30
        case "space": return 0x31
        case "delete", "backspace": return 0x33
        case "escape", "esc": return 0x35
        case "left": return 0x7B
        case "right": return 0x7C
        case "down": return 0x7D
        case "up": return 0x7E
        default: return nil
        }
    }
}
