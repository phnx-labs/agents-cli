import Foundation

// Thin bridge to the `agents` CLI. The helper never owns state or reimplements
// scheduling — it shells the CLI for data and actions. TS stays the source of
// truth (see CLAUDE.md: "Swift reads, TS owns truth").
enum AgentsCLI {
    static let home = NSHomeDirectory()

    private static let env = ProcessInfo.processInfo.environment

    // Resolve the `agents` binary. A GUI/launchd process inherits no user PATH,
    // so probe explicit locations. Env override wins for dev builds.
    static let binary: String = {
        if let b = env["AGENTS_BIN"], !b.isEmpty,
           FileManager.default.isExecutableFile(atPath: b) {
            return b
        }
        let candidates = [
            "\(home)/.local/bin/agents",
            "/opt/homebrew/bin/agents",
            "/usr/local/bin/agents",
            "\(home)/.npm-global/bin/agents",
        ]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            return c
        }
        return "agents" // last resort; relies on PATH if somehow set
    }()

    // The `agents` bin is a `#!/usr/bin/env -S node` script, but a launchd/GUI
    // process has a minimal PATH so `env` can't find node. The daemon (a node
    // process) passes its own interpreter + entry point so we exec node
    // directly and never depend on PATH. Falls back to the shebang bin.
    private static func argv(_ args: [String]) -> [String] {
        if let node = env["AGENTS_NODE"], let entry = env["AGENTS_ENTRY"],
           FileManager.default.isExecutableFile(atPath: node),
           FileManager.default.fileExists(atPath: entry) {
            return [node, entry] + args
        }
        return [binary] + args
    }

    // MARK: Daemon liveness — read the scheduler PID file + signal 0.
    // Path from src/lib/daemon.ts:24 + src/lib/state.ts (helpers/daemon).
    static func daemonPid() -> Int? {
        let path = "\(home)/.agents/.cache/helpers/daemon/daemon.pid"
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        guard let pid = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return kill(pid_t(pid), 0) == 0 ? pid : nil
    }

    // Routines are secondary and fetched only when the menu opens. This shells
    // the CLI, but `routines list` does NOT trigger the sessions re-index — it
    // only computes cron next-run, which is cheap. Session data never comes from
    // here; it's read directly from disk by LocalState.
    static func routines() -> [Routine] {
        guard let data = capture(argv(["routines", "list", "--json"])) else { return [] }
        return (try? JSONDecoder().decode([Routine].self, from: data)) ?? []
    }

    static func recentSessions(limit: Int = 3) -> [RecentSession] {
        guard let data = capture(argv(["sessions", "--all", "--limit", "\(limit)", "--json"])) else { return [] }
        return (try? JSONDecoder().decode([RecentSession].self, from: data)) ?? []
    }

    static func doctorOverview() -> DoctorOverview? {
        guard let data = capture(argv(["doctor", "--json"])) else { return nil }
        return try? JSONDecoder().decode(DoctorOverview.self, from: data)
    }

    // MARK: Actions
    // New interactive session: open a Terminal window running `agents run <agent>`.
    // A status-bar click can't host a TUI, so hand off to the user's terminal.
    static func newSession(agent: String) {
        let cmd = "\(shellQuote(binary)) run \(shellQuote(agent))"
        let script = "tell application \"Terminal\"\nactivate\ndo script \"\(cmd)\"\nend tell"
        runDetached(["/usr/bin/osascript", "-e", script])
    }

    static func routineRun(_ name: String) { runDetached(argv(["routines", "run", name])) }
    static func routinePause(_ name: String) { runDetached(argv(["routines", "pause", name])) }
    static func routineResume(_ name: String) { runDetached(argv(["routines", "resume", name])) }
    static func routineLogs(_ name: String) {
        let cmd = "\(shellQuote(binary)) routines logs \(shellQuote(name))"
        let script = "tell application \"Terminal\"\nactivate\ndo script \"\(cmd)\"\nend tell"
        runDetached(["/usr/bin/osascript", "-e", script])
    }

    static func openPath(_ path: String) { runDetached(["/usr/bin/open", path]) }

    static func stopDaemon() { runDetached(argv(["routines", "stop"])) }

    // "Quit menu bar" disables the launchd agent so it doesn't relaunch on the
    // KeepAlive policy, then the app terminates.
    static func menubarDisable() { runDetached(argv(["menubar", "disable"])) }

    // MARK: Process helpers
    private static func capture(_ argv: [String]) -> Data? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: argv[0])
        p.arguments = Array(argv.dropFirst())
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
        } catch {
            return nil
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0 ? data : nil
    }

    private static func runDetached(_ argv: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: argv[0])
        p.arguments = Array(argv.dropFirst())
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    private static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
