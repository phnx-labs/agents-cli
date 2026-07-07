import Foundation

// notify() is intentionally a pass-through at the helper level: the helper
// returns a structured payload and the Rush app (computer-manager.service.js)
// intercepts it to post through the app's own notification store. This keeps
// the helper free of macOS notification entitlement requirements and makes
// the notification clickable through the Rush session UI.
//
// If the helper is invoked standalone (no app intercept, e.g. via tests),
// the return value still describes what a notification would have said so
// callers can log it.
enum Notify {
    static func post(params: [String: Any]) throws -> [String: Any] {
        let message = try Params.string(params, "message")
        let pid = Params.intOpt(params, "pid") ?? 0

        var result: [String: Any] = [
            "notified": true,
            "message": message,
        ]
        if pid > 0 {
            result["pid"] = pid
        }
        return result
    }
}
