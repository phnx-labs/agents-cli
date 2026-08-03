import Darwin
import Foundation

// Bounded, reapable child processes for the menu-bar helper.
//
// The helper shells the `agents` CLI on a 10s timer. Every one of those calls
// used to run through a bare `Process` + `readDataToEndOfFile()`, which has two
// properties that compose into a machine-killing runaway:
//
//   1. No deadline. `agents doctor --json` probes every installed version of
//      every harness with a `node -e` subprocess each. On a busy box that goes
//      from ~2s to over 12 MINUTES, and the call simply waits.
//   2. No ownership after the parent dies. A helper killed mid-call leaves the
//      child reparented to launchd (PPID 1) with nothing to reap it, and the
//      child's own `node -e` probes leak the same way.
//
// Both fire together because the helper crashes under exactly the conditions
// that make the CLI slow. `NSApplication.sharedApplication` segfaults in
// `SLSNewConnection` when WindowServer is too starved to hand out a connection
// (EXC_BAD_ACCESS at 0x10 — AppKit dereferencing the null connection it just
// failed to get), launchd's `KeepAlive` restarts the helper, and the restart
// spawns a fresh doctor while the previous one keeps burning a core forever.
// Measured on a real machine: 38 orphaned doctors plus 92 orphaned `node -e`
// probes, ~13 of 18 cores consumed, load average 490. The slower the box got,
// the more it crashed, and every crash added another permanent orphan.
//
// So a child of this helper must satisfy three invariants:
//
//   * **It is bounded.** Every spawn carries a deadline; past it the child is
//     terminated. A doctor that takes minutes is broken, and a stale menu is
//     strictly better than an unresponsive machine.
//   * **It dies as a group.** The child is spawned as its own process-group
//     leader (`POSIX_SPAWN_SETPGROUP`), so `kill(-pgid)` takes its whole
//     subtree — the CLI *and* the `node -e` probes it forked. Signalling just
//     the pid is what let the 92 probes survive their own parent.
//   * **It cannot outlive the helper.** No exit handler can be trusted here:
//     the observed death is SIGSEGV, where nothing of ours runs. Instead each
//     live child is recorded on disk and the NEXT launch reaps whatever the
//     previous one left behind. Self-healing beats cleanup that a crash skips.
enum ChildProcess {
    /// Deadline for a routine CLI call. Every menu-bar refresher is a cache
    /// warmer — missing one poll costs a stale menu for 10s, while an unbounded
    /// one costs a core until reboot.
    static let defaultTimeout: TimeInterval = 30

    /// `doctor --json` probes every installed version of every harness, and it is
    /// genuinely expensive: measured at **136s** on an idle machine (load ~11,
    /// 169 KB of JSON), not the couple of seconds one might assume.
    ///
    /// The ceiling has to clear that real cost, or the deadline fires on every
    /// single poll and the menu's System row reads "unavailable" forever while
    /// still paying full CPU for a result that is always discarded — a timeout
    /// tuned low enough to look tidy would just hide the command's true cost.
    /// 180s clears the measurement with headroom and is still decisive about
    /// wedged. See also `StatusItemController.doctorRefreshInterval`, which must
    /// stay well above this number.
    static let doctorTimeout: TimeInterval = 180

    // MARK: - Spawn

    /// Run `argv` to completion and return its stdout, or nil if it failed,
    /// could not start, or blew the deadline.
    ///
    /// stderr goes to /dev/null: callers here parse JSON and must never get
    /// diagnostics interleaved into the payload.
    static func run(_ argv: [String], timeout: TimeInterval = defaultTimeout) -> Data? {
        guard !argv.isEmpty else { return nil }

        var fds: [Int32] = [-1, -1]
        guard pipe(&fds) == 0 else { return nil }
        let readFD = fds[0]
        let writeFD = fds[1]

        guard let pid = spawn(argv, stdout: writeFD, closeInChild: readFD) else {
            close(readFD)
            close(writeFD)
            return nil
        }

        // The parent MUST drop its copy of the write end, or the read below
        // never sees EOF even after the child exits — the classic pipe hang.
        close(writeFD)

        Registry.register(pid: pid, path: argv[0])
        defer {
            Registry.deregister(pid: pid)
        }

        // Drain on a background thread so the deadline is enforceable. Draining
        // WHILE the child runs also keeps a child that outputs more than the
        // ~64 KiB pipe buffer from blocking on write forever.
        //
        // The reader OWNS readFD and closes it itself. That ownership is what
        // lets the abandon path below be safe: closing a descriptor out from
        // under a thread blocked in read(2) races that fd's reuse by any other
        // thread, so the only correct way to walk away from a stuck reader is to
        // leave the descriptor with it.
        var output = Data()
        let drained = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .utility).async {
            output = readToEnd(readFD)
            close(readFD)
            drained.signal()
        }

        var timedOut = false
        if drained.wait(timeout: .now() + timeout) == .timedOut {
            timedOut = true
            // Kill the GROUP: the CLI plus every probe it forked. Every write end
            // of the pipe closes as those processes die, which is what releases
            // the reader.
            terminateGroup(pid)
            // Bounded, because this whole type exists to abolish unbounded waits
            // — including its own. SIGKILL cannot be caught, so EOF must follow;
            // if it somehow does not, abandon the reader (it owns its fd) and
            // reap off-thread rather than hanging the caller's queue forever.
            if drained.wait(timeout: .now() + 5) == .timedOut {
                reapDetached(pid)
                return nil
            }
        }

        // Always reap, even on timeout, so a killed child never lingers as a
        // zombie occupying a pid slot.
        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1 && errno == EINTR {}

        if timedOut { return nil }
        let exited = (status & 0x7F) == 0
        let code = (status >> 8) & 0xFF
        guard exited, code == 0 else { return nil }
        return output
    }

    /// Reap a child we have stopped waiting on, without blocking the caller.
    /// Skipping the reap entirely would leave a zombie holding its pid slot.
    private static func reapDetached(_ pid: pid_t) {
        DispatchQueue.global(qos: .utility).async {
            var status: Int32 = 0
            while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
        }
    }

    /// posix_spawn with the child as its own process-group leader.
    ///
    /// Foundation's `Process` exposes no way to set the child's process group,
    /// and without that a `kill` reaches only the CLI while its `node -e` probes
    /// survive as orphans — the exact leak this type exists to stop.
    private static func spawn(_ argv: [String], stdout writeFD: Int32, closeInChild readFD: Int32) -> pid_t? {
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // pgroup 0 == "use the child's own pid as the group id".
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attr, 0)

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_adddup2(&actions, writeFD, STDOUT_FILENO)
        posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0)
        posix_spawn_file_actions_addclose(&actions, readFD)
        posix_spawn_file_actions_addclose(&actions, writeFD)

        var cArgs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) }
        cArgs.append(nil)
        defer { for a in cArgs where a != nil { free(a) } }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, argv[0], &actions, &attr, &cArgs, environ)
        return rc == 0 ? pid : nil
    }

    private static func readToEnd(_ fd: Int32) -> Data {
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n > 0 {
                data.append(contentsOf: buf[0..<n])
            } else if n == 0 {
                break
            } else if errno == EINTR {
                continue
            } else {
                break
            }
        }
        return data
    }

    /// SIGTERM the group, then SIGKILL anything that ignored it. The negative
    /// pid is the whole process group — `kill(pid)` alone leaves the subtree.
    private static func terminateGroup(_ pid: pid_t) {
        kill(-pid, SIGTERM)
        // A wedged node process under memory pressure does not always service
        // SIGTERM promptly; escalate rather than wait on it indefinitely.
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            if kill(-pid, 0) != 0 { return }
            usleep(50_000)
        }
        kill(-pid, SIGKILL)
    }

    // MARK: - Cross-launch reaping

    /// Kill anything a previous helper left running.
    ///
    /// Called at launch, before the status item exists. This is the only cleanup
    /// that survives the failure mode that actually happens: a SIGSEGV runs no
    /// handler of ours, so the *next* process has to do it.
    @discardableResult
    static func reapOrphansFromPreviousLaunch(file: String = Registry.path()) -> Int {
        let stale = Registry.readAll(file: file)
        // Kill FIRST, clear after. Clearing first means a helper that dies part
        // way through this sweep (entirely possible — the crash it is recovering
        // from happens moments later, in the first AppKit call) has already
        // erased the only record of the survivors, stranding them forever. In
        // this order a death mid-sweep just leaves the record for the next launch
        // to retry, and re-killing is harmless: the pid+path guard below refuses
        // anything that is not still the process we spawned.
        var reaped = 0
        for entry in stale where entry.pid != getpid() {
            // Guard against pid reuse: the slot may now hold something else
            // entirely. Only a live process still running the same executable
            // is treated as ours.
            guard kill(entry.pid, 0) == 0, executablePath(entry.pid) == entry.path else { continue }
            terminateGroup(entry.pid)
            reaped += 1
        }
        Registry.clear(file: file)
        return reaped
    }

    /// Absolute path of a running pid's executable, or nil if it is gone or
    /// unreadable. Used only as a pid-reuse guard, never to identify work.
    static func executablePath(_ pid: pid_t) -> String? {
        var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
        let n = proc_pidpath(pid, &buf, UInt32(buf.count))
        guard n > 0 else { return nil }
        return String(cString: buf)
    }

    // MARK: - Live-child registry

    /// The on-disk record of children this helper currently has in flight.
    ///
    /// Lives beside the single-instance lock in the CLI's runtime state dir
    /// (`getRuntimeStateDir()`, src/lib/state.ts). Line format: `<pid> <path>`.
    enum Registry {
        struct Entry: Equatable {
            let pid: pid_t
            let path: String
        }

        static func path(home: String = NSHomeDirectory()) -> String {
            "\(home)/.agents/.cache/state/menubar-children"
        }

        /// Serializes the read-modify-write across the helper's refresher
        /// threads. Cross-process contention is not a concern: SingleInstance
        /// guarantees one helper owns this file.
        private static let queue = DispatchQueue(label: "com.phnx-labs.agents-menubar.children")

        static func register(pid: pid_t, path executable: String, file: String = path()) {
            queue.sync {
                var entries = parse(read(file))
                entries.append(Entry(pid: pid, path: executable))
                write(entries, to: file)
            }
        }

        static func deregister(pid: pid_t, file: String = path()) {
            queue.sync {
                let entries = parse(read(file)).filter { $0.pid != pid }
                write(entries, to: file)
            }
        }

        static func readAll(file: String = path()) -> [Entry] {
            queue.sync { parse(read(file)) }
        }

        static func clear(file: String = path()) {
            queue.sync { write([], to: file) }
        }

        /// Pure — the parse half is what the self-test pins.
        static func parse(_ text: String) -> [Entry] {
            text.split(separator: "\n").compactMap { line in
                let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
                guard parts.count == 2, let pid = pid_t(parts[0]), pid > 0 else { return nil }
                return Entry(pid: pid, path: parts[1])
            }
        }

        static func serialize(_ entries: [Entry]) -> String {
            entries.map { "\($0.pid) \($0.path)" }.joined(separator: "\n")
        }

        private static func read(_ file: String) -> String {
            (try? String(contentsOfFile: file, encoding: .utf8)) ?? ""
        }

        private static func write(_ entries: [Entry], to file: String) {
            let dir = (file as NSString).deletingLastPathComponent
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? serialize(entries).write(toFile: file, atomically: true, encoding: .utf8)
        }
    }
}
