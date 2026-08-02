import Foundation

// Self-test for the interactive-launch guards. Follows the repo's env-gated
// self-test idiom (see IssueSelfTest.swift / Bench.swift): no XCTest target
// exists for the menu-bar helper. Exercises the real predicates Guards uses,
// then exits nonzero on any failure so a caller can gate on it.
//
//   MENUBAR_GUARD_TEST=1 MenubarHelper
enum GuardsSelfTest {
    private static var failures = 0

    static func run() -> Never {
        print("menubar launch-guard self-test")
        testRemoteShellDetection()
        testLaunchdEnvironmentIsNotRemote()
        testArgumentRejection()
        if failures == 0 {
            print("\nALL PASS")
            exit(0)
        }
        print("\n\(failures) FAILED")
        exit(1)
    }

    // Each variable sshd sets in a remote shell must trip the guard. These are
    // the environments the orphaned helper actually ran with.
    private static func testRemoteShellDetection() {
        for variable in ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] {
            let env = ["PATH": "/usr/bin", variable: "100.93.177.123 52134 100.64.0.1 22"]
            check(Guards.remoteShellVariable(env) == variable,
                  "\(variable) set -> refused (got \(Guards.remoteShellVariable(env) ?? "nil"))")
        }
        // An empty value is not a remote shell — sshd never sets one, but an
        // exported-but-blank variable must not brick the launchd instance.
        check(Guards.remoteShellVariable(["SSH_CONNECTION": ""]) == nil,
              "empty SSH_CONNECTION -> allowed")
    }

    // The regression this guard must never cause: launchd's GUI session exports
    // SSH_AUTH_SOCK, and matching on it would refuse the supported launch path.
    private static func testLaunchdEnvironmentIsNotRemote() {
        let launchd = [
            "SSH_AUTH_SOCK": "/var/run/com.apple.launchd.CdWuf1YvYE/Listeners",
            "XPC_SERVICE_NAME": "com.phnx-labs.agents-menubar",
            "AGENTS_BIN": "/Users/muqsit/.local/bin/agents",
        ]
        check(Guards.remoteShellVariable(launchd) == nil,
              "launchd GUI environment -> allowed")
    }

    // `--self-test` is the flag that actually leaked a second status-bar app:
    // unrecognized, so it fell through to app.run() and held Cmd-Shift-V.
    private static func testArgumentRejection() {
        check(Guards.unrecognizedArguments(["MenubarHelper"]).isEmpty,
              "no arguments -> accepted")
        check(Guards.unrecognizedArguments(["MenubarHelper", "--self-test"]) == ["--self-test"],
              "--self-test -> rejected")
        check(Guards.unrecognizedArguments(["MenubarHelper", "-x", "y"]) == ["-x", "y"],
              "unknown flag + value -> both reported")
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
