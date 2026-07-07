import AppKit
import Foundation

enum Apps {
    static func listApps() throws -> [String: Any] {
        let running = NSWorkspace.shared.runningApplications
        var out: [[String: Any]] = []
        for app in running {
            // Filter to GUI apps the agent can meaningfully drive. Background-only
            // processes (activationPolicy == .prohibited) have no UI to describe.
            guard app.activationPolicy == .regular else { continue }
            let pid = Int(app.processIdentifier)
            let bundleId = app.bundleIdentifier ?? ""

            // Drop apps the user has not authorized — the agent should not
            // even see them in the listing. Hard-floor entries are dropped
            // unconditionally. Suggest `agents computer status` so the user
            // knows where to look if the list seems empty.
            if HARD_FLOOR_DENY.contains(bundleId) { continue }
            if !policy.allow.contains(bundleId) { continue }

            out.append([
                "pid": pid,
                "name": app.localizedName ?? "",
                "bundle_id": bundleId,
                "active": app.isActive,
                "hidden": app.isHidden,
                "excluded": false,
            ])
        }
        return ["apps": out]
    }

    // Launch an app by bundle_id, path (to .app bundle or executable), or
    // human name ("Notepad", "Safari"). Returns {pid, name, bundle_id}.
    static func launchApp(params: [String: Any]) throws -> [String: Any] {
        let bundleId = Params.stringOpt(params, "bundle_id")
        let path = Params.stringOpt(params, "path")
        let name = Params.stringOpt(params, "name")

        if bundleId == nil && path == nil && name == nil {
            throw RPCError.invalid("pass one of: bundle_id, path, name")
        }

        // Reject path-traversal-shaped names. The candidatePaths interpolation
        // below would otherwise let an attacker escape /Applications/ via
        // "../../../usr/bin/whatever" or "../Library/Application Support/...".
        if let n = name, n.contains("/") || n.contains("..") {
            throw RPCError.invalid("name must not contain '/' or '..' — use bundle_id or path instead")
        }

        var url: URL?
        if let bid = bundleId {
            url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid)
            if url == nil {
                throw RPCError.invalid("bundle_id not found: \(bid)")
            }
        } else if let p = path {
            url = URL(fileURLWithPath: p)
        } else if let n = name {
            // Resolve human name by scanning /Applications first, falling back
            // to `NSWorkspace.urlForApplication(withName:)` which handles the
            // common case where the app exists somewhere registered with
            // LaunchServices.
            let candidatePaths = [
                "/Applications/\(n).app",
                "/System/Applications/\(n).app",
                "/Applications/Utilities/\(n).app",
                "/System/Applications/Utilities/\(n).app",
            ]
            for cp in candidatePaths {
                if FileManager.default.fileExists(atPath: cp) {
                    url = URL(fileURLWithPath: cp)
                    break
                }
            }
            if url == nil {
                if let resolved = NSWorkspace.shared.fullPath(forApplication: n) {
                    url = URL(fileURLWithPath: resolved)
                }
            }
            if url == nil {
                throw RPCError.invalid("app not found by name: \(n)")
            }
        }

        guard let appURL = url else {
            throw RPCError.invalid("could not resolve app")
        }

        // Resolve the bundle id of the target BEFORE launching, then gate
        // against the hard floor + user allow list. Different from the other
        // methods because the pid doesn't exist yet — we look up the bundle
        // id from the resolved Info.plist instead.
        let resolvedBundleId = resolveBundleId(forAppURL: appURL) ?? bundleId ?? ""
        if HARD_FLOOR_DENY.contains(resolvedBundleId) {
            throw RPCError.excluded(resolvedBundleId)
        }
        if !policy.allow.contains(resolvedBundleId) {
            throw RPCError(code: "permission_denied",
                           message: "\(resolvedBundleId.isEmpty ? "<unknown bundle>" : resolvedBundleId) not in allow list — add Computer(\(resolvedBundleId.isEmpty ? "<bundle-id>" : resolvedBundleId)) to a permissions group, then `agents computer reload`")
        }

        // Synchronously launch and wait for the pid. NSWorkspace.openApplication
        // is async; use a semaphore so we return the pid to the caller.
        let semaphore = DispatchSemaphore(value: 0)
        var launchedApp: NSRunningApplication?
        var launchErr: Error?

        let config = NSWorkspace.OpenConfiguration()
        config.activates = false // don't steal focus
        NSWorkspace.shared.openApplication(at: appURL, configuration: config) { app, err in
            launchedApp = app
            launchErr = err
            semaphore.signal()
        }

        // 10s timeout — large apps (Xcode) can take a while to cold-start.
        let timedOut = semaphore.wait(timeout: .now() + 10) == .timedOut
        if timedOut {
            throw RPCError(code: "action_failed", message: "launch timed out after 10s for \(appURL.path)")
        }
        if let err = launchErr {
            throw RPCError(code: "action_failed", message: "launch failed: \(err.localizedDescription)")
        }
        guard let app = launchedApp else {
            throw RPCError(code: "action_failed", message: "launch returned no NSRunningApplication")
        }

        return [
            "pid": Int(app.processIdentifier),
            "name": app.localizedName ?? "",
            "bundle_id": app.bundleIdentifier ?? "",
        ]
    }

    // Resolve the bundle id of an .app at appURL without launching it. Reads
    // CFBundleIdentifier from the Info.plist. Returns nil for non-.app URLs
    // (raw executables) where the caller must rely on the explicit bundle_id
    // input.
    private static func resolveBundleId(forAppURL appURL: URL) -> String? {
        if let bundle = Bundle(url: appURL), let bid = bundle.bundleIdentifier {
            return bid
        }
        return nil
    }
}
