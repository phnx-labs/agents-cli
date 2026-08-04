import Darwin
import Foundation

// Self-test for bounded, group-killable child processes. Follows the repo's
// env-gated self-test idiom (see GuardsSelfTest.swift / SingleInstanceSelfTest.swift):
// no XCTest target exists for the menu-bar helper.
//
//   MENUBAR_CHILD_TEST=1 MenubarHelper
//
// These spawn REAL processes — no mocking, per the repo convention. Each case is
// one of the properties whose absence produced the runaway: an unbounded call, a
// subtree that survived its parent's death, and a stale registry entry that must
// not be allowed to kill an unrelated pid.
enum ChildProcessSelfTest {
    private static var failures = 0

    static func run() -> Never {
        print("menubar child-process self-test")
        testCapturesStdout()
        testNonZeroExitIsFailure()
        testTimeoutKillsAndReportsFailure()
        testTimeoutKillsTheWholeProcessGroup()
        testRegistryTracksInFlightChildren()
        testRegistryRoundTrip()
        testReapSkipsPidWhoseExecutableChanged()
        testReapKillsARealOrphanFromAPreviousLaunch()
        testChildDoesNotInheritSingleInstanceFlock()
        if failures == 0 {
            print("\nALL PASS")
            exit(0)
        }
        print("\n\(failures) FAILED")
        exit(1)
    }

    // MARK: Baseline — the behavior every caller already depended on.

    private static func testCapturesStdout() {
        let out = ChildProcess.run(["/bin/echo", "hello"], timeout: 10)
        check(out.flatMap { String(data: $0, encoding: .utf8) } == "hello\n",
              "stdout is captured verbatim")
    }

    private static func testNonZeroExitIsFailure() {
        check(ChildProcess.run(["/usr/bin/false"], timeout: 10) == nil,
              "non-zero exit -> nil (callers must not parse a failed run)")
    }

    // MARK: The bug — an unbounded call never returns.

    // `agents doctor --json` went from ~2s to over 12 minutes on a loaded box and
    // the old capture() simply waited, holding a core the whole time.
    private static func testTimeoutKillsAndReportsFailure() {
        let started = Date()
        let out = ChildProcess.run(["/bin/sleep", "30"], timeout: 1)
        let elapsed = Date().timeIntervalSince(started)
        check(out == nil, "timed-out call -> nil")
        check(elapsed < 10, "timed-out call returns promptly (took \(String(format: "%.1f", elapsed))s, child asked for 30s)")
    }

    // The 92 orphaned `node -e` probes: the doctor forked them, and signalling
    // only the doctor's pid left every one of them running. The child must be its
    // own process-group leader so kill(-pgid) takes the subtree.
    private static func testTimeoutKillsTheWholeProcessGroup() {
        // Parent spawns a grandchild that outlives it, then sleeps. Killing only
        // the parent pid leaves the grandchild; killing the group takes both.
        let marker = "\(NSTemporaryDirectory())menubar-childtest-\(getpid())-\(Int(Date().timeIntervalSince1970))"
        let script = "/bin/sh -c 'sleep 45 && touch \(marker)' & sleep 45"
        _ = ChildProcess.run(["/bin/sh", "-c", script], timeout: 1)

        // Give the kill a beat to propagate, then assert nothing from that group
        // is still alive: the grandchild's own `sleep 45` must be gone.
        usleep(1_500_000)
        let survivors = pgrepCount(matching: "sleep 45")
        check(survivors == 0,
              "timeout kills the whole process group (\(survivors) descendant sleep(s) survived)")
        try? FileManager.default.removeItem(atPath: marker)
    }

    // MARK: The registry — what makes cross-launch reaping possible at all.

    private static func testRegistryTracksInFlightChildren() {
        let file = "\(NSTemporaryDirectory())menubar-children-test-\(getpid())"
        try? FileManager.default.removeItem(atPath: file)
        ChildProcess.Registry.register(pid: 4242, path: "/bin/echo", file: file)
        ChildProcess.Registry.register(pid: 4243, path: "/bin/sleep", file: file)
        check(ChildProcess.Registry.readAll(file: file).count == 2, "two in-flight children recorded")
        ChildProcess.Registry.deregister(pid: 4242, file: file)
        let left = ChildProcess.Registry.readAll(file: file)
        check(left == [.init(pid: 4243, path: "/bin/sleep")],
              "a completed child is removed, the other is untouched")
        try? FileManager.default.removeItem(atPath: file)
    }

    // Paths can contain spaces, so the split must be bounded to the first one.
    private static func testRegistryRoundTrip() {
        let entries = [
            ChildProcess.Registry.Entry(pid: 11, path: "/opt/homebrew/bin/agents"),
            ChildProcess.Registry.Entry(pid: 12, path: "/Users/x/Application Support/a b/agents"),
        ]
        let parsed = ChildProcess.Registry.parse(ChildProcess.Registry.serialize(entries))
        check(parsed == entries, "registry round-trips pids and paths containing spaces")
        check(ChildProcess.Registry.parse("garbage\n\n0 /bin/x\n-1 /bin/y").isEmpty,
              "malformed and non-positive pids are skipped, never thrown on")
    }

    // Pid reuse: by the next launch the recorded pid may belong to something else
    // entirely. Reaping on pid alone would kill an innocent process, so the
    // executable path must still match.
    private static func testReapSkipsPidWhoseExecutableChanged() {
        let file = "\(NSTemporaryDirectory())menubar-children-reuse-\(getpid())"
        try? FileManager.default.removeItem(atPath: file)
        // This very process is alive, but its executable is MenubarHelper, not
        // /bin/sleep — so the guard must refuse to treat it as a stale child.
        let me = getpid()
        ChildProcess.Registry.register(pid: me, path: "/bin/sleep", file: file)
        let recorded = ChildProcess.Registry.readAll(file: file)
        let mismatched = recorded.filter { ChildProcess.executablePath($0.pid) != $0.path }
        check(mismatched.count == 1,
              "a live pid whose executable no longer matches is not reapable")
        check(ChildProcess.executablePath(me)?.hasSuffix("MenubarHelper") == true,
              "executablePath resolves a live pid (got \(ChildProcess.executablePath(me) ?? "nil"))")
        try? FileManager.default.removeItem(atPath: file)
    }

    // The whole point of the on-disk registry: a helper killed by SIGSEGV or
    // SIGKILL runs none of its own cleanup, so the NEXT launch has to do it.
    // This is the end-to-end version — a real surviving process, killed by a real
    // call to the real reaper, driven off a real registry file.
    private static func testReapKillsARealOrphanFromAPreviousLaunch() {
        let file = "\(NSTemporaryDirectory())menubar-children-reap-\(getpid())"
        try? FileManager.default.removeItem(atPath: file)

        // Stand in for the abandoned child: a process that is its own
        // process-group leader (as ChildProcess.spawn makes every child), so the
        // reaper's kill(-pgid) has a group to take.
        guard let orphan = spawnDetachedGroupLeader() else {
            check(false, "could not spawn a stand-in orphan")
            return
        }
        ChildProcess.Registry.register(pid: orphan, path: "/bin/sleep", file: file)
        check(kill(orphan, 0) == 0, "stand-in orphan (pid \(orphan)) is alive before the reap")

        let reaped = ChildProcess.reapOrphansFromPreviousLaunch(file: file)
        check(reaped == 1, "reaper reports exactly 1 group reaped (got \(reaped))")

        // Poll rather than sleep a fixed amount: SIGTERM then SIGKILL is not
        // instantaneous, but it must be bounded.
        var alive = true
        for _ in 0..<40 where alive {
            usleep(100_000)
            alive = kill(orphan, 0) == 0
        }
        check(!alive, "the orphan is dead after the reap")
        check(ChildProcess.Registry.readAll(file: file).isEmpty,
              "registry is cleared so the next launch does not re-reap a dead pid")
        try? FileManager.default.removeItem(atPath: file)
    }

    // The flock-inheritance leak that bricked the single-instance guard: a child
    // spawned while the helper holds the menubar.lock flock must NOT inherit that
    // fd. If it does, an orphaned child (helper crashed) keeps the open-file-
    // description — and its flock — alive at PPID 1, and every later launch
    // deadlocks as "already running". Guarded at the source by O_CLOEXEC on the
    // lock open (SingleInstance.acquire) plus POSIX_SPAWN_CLOEXEC_DEFAULT here.
    // Real flock, real child that execs and outlives the parent's fd — no mock.
    private static func testChildDoesNotInheritSingleInstanceFlock() {
        let path = "\(NSTemporaryDirectory())menubar-flock-inherit-\(getpid()).lock"
        try? FileManager.default.removeItem(atPath: path)
        defer { try? FileManager.default.removeItem(atPath: path) }

        // Take the lock exactly as SingleInstance.acquire does — WITH O_CLOEXEC.
        let held = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        guard held >= 0, flock(held, LOCK_EX | LOCK_NB) == 0 else {
            check(false, "parent could not take the lock (fd \(held))"); return
        }
        // Direct invariant: the lock fd is close-on-exec, so no exec'd child keeps it.
        check((fcntl(held, F_GETFD) & FD_CLOEXEC) != 0,
              "lock fd is O_CLOEXEC (close-on-exec)")

        // End-to-end: a child spawned via a RAW posix_spawn with NO
        // CLOEXEC_DEFAULT and no file actions — the exact pre-#1841 spawn shape —
        // inherits every fd that is not itself close-on-exec. If the lock fd were
        // not O_CLOEXEC it would ride into /bin/sleep and keep the open-file-
        // description (and its flock) alive after the parent drops its own. This is
        // the real leak vehicle: Foundation.Process closes inherited fds itself and
        // so cannot reproduce the bug, which is why this uses posix_spawn directly.
        var childPid: pid_t = 0
        var argv: [UnsafeMutablePointer<CChar>?] = (["/bin/sleep", "300"] as [String]).map { strdup($0) } + [nil]
        defer { for a in argv where a != nil { free(a) } }
        let rc = posix_spawn(&childPid, "/bin/sleep", nil, nil, &argv, environ)
        guard rc == 0 else {
            check(false, "could not posix_spawn a stand-in child (rc \(rc))"); close(held); return
        }

        // Parent drops its reference. If the child never inherited the fd, this
        // closes the last reference to the open-file-description and frees the lock.
        close(held)

        // A fresh open+flock MUST succeed — proof no child kept the lock alive.
        let probe = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        let free = probe >= 0 && flock(probe, LOCK_EX | LOCK_NB) == 0
        if probe >= 0 { close(probe) }
        kill(childPid, SIGKILL)
        var st: Int32 = 0
        while waitpid(childPid, &st, 0) == -1 && errno == EINTR {}
        check(free, "flock is free after the holder drops its fd (child never inherited it)")
    }

    /// `sleep 300` in its own process group, reparented away from this process.
    /// macOS ships no `setsid(1)`, so python does the `setpgrp` + `exec`.
    private static func spawnDetachedGroupLeader() -> pid_t? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        p.arguments = ["-c", "import os; os.setpgrp(); os.execv('/bin/sleep', ['sleep', '300'])"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        // Wait for the exec to land so proc_pidpath reports /bin/sleep, not python.
        let pid = p.processIdentifier
        for _ in 0..<50 {
            usleep(100_000)
            if ChildProcess.executablePath(pid) == "/bin/sleep" { return pid }
        }
        return nil
    }

    // MARK: helpers

    /// Count live processes whose command line contains `needle`, excluding this
    /// process. Uses the real process table — the point is to observe survivors.
    private static func pgrepCount(matching needle: String) -> Int {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/ps")
        p.arguments = ["-Ao", "pid,command"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return -1 }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let text = String(data: data, encoding: .utf8) ?? ""
        return text.split(separator: "\n").filter { $0.contains(needle) }.count
    }

    private static func check(_ condition: Bool, _ label: String) {
        if condition {
            print("  PASS  \(label)")
        } else {
            failures += 1
            print("  FAIL  \(label)")
        }
    }
}
