import ApplicationServices
import AppKit
import Foundation

// Per-PID map of opaque handle -> AXUIElement. Each call to describe(pid)
// rebuilds that PID's slice of the cache. Handles from a stale describe
// return element_stale so the agent re-describes instead of acting blindly.
//
// The cache subscribes to NSWorkspace.didTerminateApplicationNotification
// so that when an app exits its AXUIElement handles (which hold references
// to deallocated CF objects) are released promptly. Without this the cache
// would grow unbounded across long-running daemon lifetimes.
final class ElementCache {
    private let queue = DispatchQueue(label: "computer-helper.cache")
    private var byPid: [Int: [String: AXUIElement]] = [:]
    private var generationByPid: [Int: Int] = [:]
    // Sequential ref counter per pid, reset at the start of each describe pass.
    // Matches the browser snapshot tool's `@e1`, `@e2`, ... format so LLMs see
    // the same ref shape across mac and web automation.
    private var refCounterByPid: [Int: Int] = [:]
    private var terminationObserver: NSObjectProtocol?

    init() {
        terminationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification,
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.clearForPid(pid: Int(app.processIdentifier))
        }
    }

    deinit {
        if let token = terminationObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(token)
        }
    }

    func beginDescribe(pid: Int) -> Int {
        queue.sync {
            byPid[pid] = [:]
            refCounterByPid[pid] = 0
            let next = (generationByPid[pid] ?? 0) + 1
            generationByPid[pid] = next
            return next
        }
    }

    func nextRefId(pid: Int) -> String {
        queue.sync {
            let next = (refCounterByPid[pid] ?? 0) + 1
            refCounterByPid[pid] = next
            return "@e\(next)"
        }
    }

    func put(pid: Int, id: String, element: AXUIElement) {
        queue.sync {
            byPid[pid, default: [:]][id] = element
        }
    }

    func get(pid: Int, id: String) -> AXUIElement? {
        queue.sync {
            byPid[pid]?[id]
        }
    }

    func clearForPid(pid: Int) {
        queue.sync {
            byPid.removeValue(forKey: pid)
            refCounterByPid.removeValue(forKey: pid)
            generationByPid.removeValue(forKey: pid)
        }
    }

    func clearAll() {
        queue.sync {
            byPid.removeAll()
            refCounterByPid.removeAll()
            generationByPid.removeAll()
        }
    }
}
