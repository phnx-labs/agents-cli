import Foundation

// Exactly one status item, ever.
//
// Nothing stopped a second helper from installing its own NSStatusItem, so the
// menu bar showed the agents mark twice: launchd's KeepAlive copy plus anything
// that started the bundle again (a Finder/`open` launch, a LaunchServices
// re-open after a crash, a second `agents menubar enable` racing the first).
// Both ran the SAME installed executable, so the process classifier saw no
// "foreign" copy and status reported a healthy single instance while the user
// looked at two icons — and the duplicate silently owned Cmd-Shift-V/O, since
// RegisterEventHotKey is first-come.
//
// The lock is an flock(2) on a file the incumbent holds open for its whole life.
// A pid file alone can't do this: a helper SIGKILLed by the code-signing monitor
// leaves its pid behind and every later launch reads a stale "already running".
// An flock is released by the kernel when the holder dies, however it dies, so
// the state can never go stale.
//
// The loser does not just exit — it surfaces the incumbent (posts a distributed
// notification that pops the running helper's menu open), which is what a user
// who re-launched a menu-bar app actually wanted: show me the one that is
// already there.
enum SingleInstance {
    /// Distributed notification that asks a running helper to open its menu.
    /// Distributed (not local) because the sender is a different process.
    static let surfaceNotification = Notification.Name("com.phnx-labs.agents-menubar.surface")

    /// ~/.agents/.cache/state/menubar.lock — the same runtime state dir the CLI
    /// uses (`getRuntimeStateDir()` in src/lib/state.ts).
    static func lockPath(home: String = NSHomeDirectory()) -> String {
        "\(home)/.agents/.cache/state/menubar.lock"
    }

    /// Held for the process lifetime. Never closed: closing the descriptor drops
    /// the flock, which would let a second helper in while this one still owns a
    /// status item.
    private static var lockDescriptor: Int32 = -1

    /// Outcome of the launch-time contention check, split out so the decision is
    /// testable without actually taking a lock.
    enum Outcome: Equatable {
        /// This process owns the status item.
        case acquired
        /// Another helper already owns it; surface that one and exit.
        case alreadyRunning(pid: Int32)
    }

    /// Try to take the lock. Returns `.acquired` with the descriptor left open,
    /// or `.alreadyRunning` carrying the incumbent's pid (0 when the pid file is
    /// unreadable — the lock, not the pid, is what proves liveness).
    static func acquire(path: String = lockPath()) -> Outcome {
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

        let fd = open(path, O_RDWR | O_CREAT, 0o644)
        if fd < 0 {
            // Can't create the lock file (read-only home, exotic sandbox). Fail
            // OPEN: a helper that cannot lock is better than no menu bar at all.
            return .acquired
        }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            let incumbent = readPid(path: path)
            close(fd)
            return .alreadyRunning(pid: incumbent)
        }
        lockDescriptor = fd
        ftruncate(fd, 0)
        let pid = "\(ProcessInfo.processInfo.processIdentifier)\n"
        _ = pid.withCString { write(fd, $0, strlen($0)) }
        return .acquired
    }

    private static func readPid(path: String) -> Int32 {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return 0 }
        return Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    }

    /// `MENUBAR_DUMP=1` installs a status item, prints the menu, and exits
    /// without running the app loop or registering the global chords — a
    /// transient probe, not a second menu bar. It is the ONE mode that reaches
    /// the interactive path (every other env-gated mode exits before Guards), so
    /// without this exemption a diagnostic dump would surrender and print
    /// nothing whenever the real helper is running: a silent no-op exactly where
    /// someone is trying to diagnose.
    static func isTransientProbe(
        _ environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Bool {
        environment["MENUBAR_DUMP"] == "1"
    }

    /// Launch-time gate for the interactive mode. Returns only when this process
    /// is the single owner; otherwise asks the incumbent to show itself and
    /// exits 0 (a duplicate launch is a user asking to see the menu, not an
    /// error, so launchd's KeepAlive must not treat it as a crash).
    static func enforceOrSurface(path: String = lockPath()) {
        if isTransientProbe() { return }
        switch acquire(path: path) {
        case .acquired:
            return
        case .alreadyRunning(let pid):
            DistributedNotificationCenter.default().postNotificationName(
                surfaceNotification, object: nil, userInfo: nil, deliverImmediately: true
            )
            let who = pid > 0 ? " (pid \(pid))" : ""
            FileHandle.standardError.write(Data(
                "MenubarHelper: already running\(who) — surfaced it instead of adding a second status item.\n".utf8
            ))
            exit(0)
        }
    }
}
