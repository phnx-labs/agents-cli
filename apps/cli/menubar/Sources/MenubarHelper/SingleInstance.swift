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

    /// Who triggered a duplicate launch, resolved from the loser's env and carried
    /// in the notification so the incumbent can decide whether to steal focus.
    struct SurfaceTrigger: Equatable {
        /// True when a coding agent (not the human) relaunched the helper — its env
        /// carries the provenance `buildExecEnv` stamps on every spawn. The human
        /// didn't ask to see the menu, so the incumbent re-homes silently instead
        /// of popping the dropdown and stealing keyboard focus mid-task.
        let automated: Bool
        let agent: String?
        let sessionId: String?

        /// String-only so it survives distributed-notification delivery (plist).
        var userInfo: [String: String] {
            var info = ["automated": automated ? "1" : "0"]
            if let agent { info["agent"] = agent }
            if let sessionId { info["sessionId"] = sessionId }
            return info
        }
    }

    /// Classify a duplicate launch from its environment. An agent-spawned relaunch
    /// (e.g. `agents menubar enable` run by a coding agent) carries AGENTS_AGENT_NAME
    /// / AGENTS_SESSION_ID from `buildExecEnv`; a genuine user relaunch from an
    /// interactive shell or Finder does not. Pure so the decision is unit-testable.
    static func classifyTrigger(
        _ environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> SurfaceTrigger {
        let agent = environment["AGENTS_AGENT_NAME"]
        let sessionId = environment["AGENTS_SESSION_ID"] ?? environment["AGENT_SESSION_ID"]
        return SurfaceTrigger(automated: agent != nil || sessionId != nil, agent: agent, sessionId: sessionId)
    }

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
    static func acquire(
        path: String = lockPath(),
        registryFile: String = ChildProcess.Registry.path()
    ) -> Outcome {
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

        // O_CLOEXEC so the flock fd is close-on-exec across EVERY spawn path, not
        // just ChildProcess's POSIX_SPAWN_CLOEXEC_DEFAULT (ChildProcess.swift). A
        // child that reaches exec() without it — a future bare Process(), or one
        // spawned before that fix — inherits this fd and holds the flock at PPID 1
        // forever, deadlocking every later launch as "already running". This holder
        // never execs itself (main.swift runs straight to app.run()), so
        // close-on-exec never drops the lock we mean to keep for the process life.
        let fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        if fd < 0 {
            // Can't create the lock file (read-only home, exotic sandbox). Fail
            // OPEN: a helper that cannot lock is better than no menu bar at all.
            return .acquired
        }
        if flock(fd, LOCK_EX | LOCK_NB) == 0 {
            return claim(fd)
        }

        // The lock is held. A LIVE MenubarHelper owner is a genuine incumbent —
        // surface it and leave its in-flight children untouched (main.swift's
        // "only the flock winner reaps" invariant).
        if liveHelperOwnsLock(path: path) {
            let incumbent = readPid(path: path)
            close(fd)
            return .alreadyRunning(pid: incumbent)
        }

        // No live helper owns it: the holder is a leaked orphan or a dead pid — a
        // pre-fix `doctor` child at PPID 1 that inherited the lock fd and never let
        // go. Reaping that orphan (kill(-pgid)) is what releases the flock, so reap
        // the previous launch's children and RETRY the lock once. We only reach
        // here when the owner is provably NOT a live helper, so no live incumbent's
        // children can be in the reap set — the invariant above is preserved.
        _ = ChildProcess.reapOrphansFromPreviousLaunch(file: registryFile)
        // The reaper confirms a SIGTERM death but returns as soon as it escalates
        // to SIGKILL (ChildProcess.terminateGroup), so the kernel's release of the
        // orphan's flock can lag the reap by a few ms. Poll the lock briefly —
        // bounded, never a spin — rather than trying exactly once.
        for _ in 0..<15 {
            if flock(fd, LOCK_EX | LOCK_NB) == 0 { return claim(fd) }
            usleep(100_000)
        }

        // Still held after reap+retry (a holder the registry never recorded, or a
        // racing sibling that re-grabbed it). Fall back to surfacing — never spin.
        let incumbent = readPid(path: path)
        close(fd)
        return .alreadyRunning(pid: incumbent)
    }

    /// Commit ownership: keep the descriptor for the process lifetime, truncate,
    /// and stamp our pid. Shared by the first-try and the reap-and-retry paths.
    private static func claim(_ fd: Int32) -> Outcome {
        lockDescriptor = fd
        ftruncate(fd, 0)
        let pid = "\(ProcessInfo.processInfo.processIdentifier)\n"
        _ = pid.withCString { write(fd, $0, strlen($0)) }
        return .acquired
    }

    /// True only when the pid recorded in the lock file is a LIVE process running
    /// a MenubarHelper. Everything else — pid 0/unreadable, a dead pid, a live pid
    /// reused by some other program, or a non-helper orphan holding an inherited fd
    /// — is a stale holder we may self-heal past. Mirrors the pid+path reuse guard
    /// the reaper uses (ChildProcess.executablePath): a pid alone can be reused, so
    /// the running executable must still be ours.
    static func liveHelperOwnsLock(path: String = lockPath()) -> Bool {
        let pid = readPid(path: path)
        guard pid > 0, kill(pid, 0) == 0,
              let exe = ChildProcess.executablePath(pid) else { return false }
        return (exe as NSString).lastPathComponent == "MenubarHelper"
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
            let trigger = classifyTrigger()
            DistributedNotificationCenter.default().postNotificationName(
                surfaceNotification, object: nil, userInfo: trigger.userInfo, deliverImmediately: true
            )
            let who = pid > 0 ? " (pid \(pid))" : ""
            let how = trigger.automated
                ? " — automated relaunch (\(trigger.agent ?? trigger.sessionId ?? "agent")), re-homed without stealing focus"
                : " — surfaced it instead of adding a second status item"
            FileHandle.standardError.write(Data(
                "MenubarHelper: already running\(who)\(how).\n".utf8
            ))
            exit(0)
        }
    }
}
