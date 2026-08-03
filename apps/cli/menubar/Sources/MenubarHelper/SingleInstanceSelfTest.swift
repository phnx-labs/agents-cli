import Foundation

// Self-test for the single-instance lock. Follows the repo's env-gated
// self-test idiom (GuardsSelfTest.swift / IssueSelfTest.swift): no XCTest
// target exists for the menu-bar helper. Takes REAL flocks on a real temp file
// — the contention this guards against is a kernel behavior, so a fake would
// prove nothing.
//
//   MENUBAR_SINGLE_TEST=1 MenubarHelper
enum SingleInstanceSelfTest {
    private static var failures = 0

    static func run() -> Never {
        print("menubar single-instance self-test")
        testFirstAcquireWins()
        testSecondAcquireSurrenders()
        testLockReleasedWhenHolderDies()
        testLockPathIsRuntimeStateDir()
        testDumpProbeIsExempt()
        testTriggerClassification()
        if failures == 0 {
            print("\nALL PASS")
            exit(0)
        }
        print("\n\(failures) FAILED")
        exit(1)
    }

    private static func tempLock(_ label: String) -> String {
        let dir = NSTemporaryDirectory() + "menubar-single-test-\(label)-\(getpid())"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir + "/menubar.lock"
    }

    // The launchd-started helper is the first in: it must own the status item.
    private static func testFirstAcquireWins() {
        let path = tempLock("first")
        check(SingleInstance.acquire(path: path) == .acquired, "first acquire -> acquired")
        let pid = (try? String(contentsOfFile: path, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        check(pid == "\(getpid())", "lock file records the holder pid (got \(pid ?? "nil"))")
    }

    // The duplicate launch — the bug: it used to install a second status item,
    // so the mark appeared twice in the menu bar.
    private static func testSecondAcquireSurrenders() {
        let path = tempLock("second")
        let fd = open(path, O_RDWR | O_CREAT, 0o644)
        defer { close(fd) }
        check(flock(fd, LOCK_EX | LOCK_NB) == 0, "incumbent holds the lock")
        let holder = "4242\n"
        _ = holder.withCString { write(fd, $0, strlen($0)) }

        let outcome = SingleInstance.acquire(path: path)
        check(outcome == .alreadyRunning(pid: 4242),
              "second acquire -> alreadyRunning(4242) (got \(outcome))")
    }

    // Why an flock and not a pid file: a helper SIGKILLed by the code-signing
    // monitor leaves its pid behind. The kernel drops the flock regardless, so
    // the next launch must get in rather than read a stale "already running".
    private static func testLockReleasedWhenHolderDies() {
        let path = tempLock("stale")
        let fd = open(path, O_RDWR | O_CREAT, 0o644)
        _ = flock(fd, LOCK_EX | LOCK_NB)
        let dead = "999999\n"
        _ = dead.withCString { write(fd, $0, strlen($0)) }
        close(fd)   // stands in for the holder dying: descriptor gone, pid still on disk

        check(SingleInstance.acquire(path: path) == .acquired,
              "stale pid file, no live holder -> acquired")
    }

    // Must match getRuntimeStateDir() in src/lib/state.ts — the CLI's
    // `agents menubar setup` reports on the same file.
    private static func testLockPathIsRuntimeStateDir() {
        check(SingleInstance.lockPath(home: "/Users/x") == "/Users/x/.agents/.cache/state/menubar.lock",
              "lock path -> ~/.agents/.cache/state/menubar.lock")
    }

    // MENUBAR_DUMP is the one mode that reaches the interactive path, and it
    // exits without an app loop or chords. Gating it would turn a diagnostic
    // dump into a silent surrender whenever the real helper is running.
    private static func testDumpProbeIsExempt() {
        check(SingleInstance.isTransientProbe(["MENUBAR_DUMP": "1"]),
              "MENUBAR_DUMP=1 -> exempt from the singleton gate")
        check(!SingleInstance.isTransientProbe([:]),
              "ordinary launch -> gated")
        check(!SingleInstance.isTransientProbe(["MENUBAR_DUMP": "0"]),
              "MENUBAR_DUMP=0 -> gated")
    }

    // An agent-spawned relaunch (buildExecEnv stamps AGENTS_AGENT_NAME /
    // AGENTS_SESSION_ID) must be classified automated, so the incumbent re-homes
    // without stealing focus; a bare user relaunch must surface.
    private static func testTriggerClassification() {
        let agentRun = SingleInstance.classifyTrigger(["AGENTS_AGENT_NAME": "claude"])
        check(agentRun.automated, "AGENTS_AGENT_NAME set -> automated")
        check(agentRun.agent == "claude", "automated trigger carries the agent name")

        let sessionRun = SingleInstance.classifyTrigger(["AGENTS_SESSION_ID": "sess-123"])
        check(sessionRun.automated, "AGENTS_SESSION_ID set -> automated")
        check(sessionRun.sessionId == "sess-123", "automated trigger carries the session id")

        let userRun = SingleInstance.classifyTrigger([:])
        check(!userRun.automated, "no agent/session env -> user relaunch (surfaces)")
        check(userRun.userInfo["automated"] == "0", "user trigger userInfo marks automated=0")

        // The userInfo dict must be string-only so it survives distributed delivery.
        check(agentRun.userInfo["automated"] == "1" && agentRun.userInfo["agent"] == "claude",
              "automated userInfo is plist-safe strings")
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
