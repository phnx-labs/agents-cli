import Foundation

// RUSH-2336 self-test: the menubar decodes the CLI's `pid`/`pidAlive`/
// `cloudProvider`/`cloudTaskId` fields off the `agents sessions --active
// --local --json` payload and renders the same machine:pid / provider ·
// taskId locator the CLI's own `--active` row shows. Exercises real JSON
// decoding + the pure ActiveDisplay.locator formatter, print PASS/FAIL, exit.
// No GUI, no hotkey. Mirrors LoadedDeviceSelfTest / IssueSelfTest.
enum ActiveSessionSelfTest {
    static func run() -> Never {
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL") — \(name)")
            if !cond { pass = false }
        }

        let decoder = JSONDecoder()

        // A process row (terminal/tmux/headless/team): the CLI's canonical
        // isRunningLiveSession selector guarantees machine + a positive pid +
        // pidAlive === true on every bare-active row it emits.
        let processJSON = """
        {"kind":"claude","sessionId":"s1","status":"running","context":"terminal",
         "machine":"yosemite-s0","host":"tmux","pid":48213,"pidAlive":true}
        """
        guard let proc = try? decoder.decode(ActiveSession.self, from: Data(processJSON.utf8)) else {
            print("FAIL — process row failed to decode")
            exit(1)
        }
        check("process row decodes pid", proc.pid == 48213)
        check("process row decodes pidAlive", proc.pidAlive == true)
        check("process row decodes machine", proc.machine == "yosemite-s0")
        check("process row carries no cloud fields", proc.cloudProvider == nil && proc.cloudTaskId == nil)

        // A cloud row: no local pid at all, active on the provider's own word.
        let cloudJSON = """
        {"kind":"rush","sessionId":"s2","status":"running","context":"cloud",
         "cloudProvider":"rush","cloudTaskId":"task-abcdef1234567890"}
        """
        guard let cloud = try? decoder.decode(ActiveSession.self, from: Data(cloudJSON.utf8)) else {
            print("FAIL — cloud row failed to decode")
            exit(1)
        }
        check("cloud row decodes provider", cloud.cloudProvider == "rush")
        check("cloud row decodes task id", cloud.cloudTaskId == "task-abcdef1234567890")
        check("cloud row carries no pid", cloud.pid == nil)

        // An older-peer payload omitting the new fields entirely must still
        // decode — every new field is optional, never a hard decode failure.
        let legacyJSON = """
        {"kind":"claude","sessionId":"s3","status":"running","context":"terminal","machine":"zion"}
        """
        check("a payload predating this fix still decodes",
              (try? decoder.decode(ActiveSession.self, from: Data(legacyJSON.utf8))) != nil)

        // sessions(fromActive:) must carry pid/pidAlive/cloud fields through to
        // the Session the menu actually renders from — not just decode them.
        let mapped = LocalState.sessions(fromActive: [proc, cloud])
        let mappedProc = mapped.first { $0.sessionId == "s1" }
        let mappedCloud = mapped.first { $0.sessionId == "s2" }
        check("mapped process Session carries pid", mappedProc?.pid == 48213)
        check("mapped process Session carries pidAlive", mappedProc?.pidAlive == true)
        check("mapped cloud Session carries provider/taskId",
              mappedCloud?.cloudProvider == "rush" && mappedCloud?.cloudTaskId == "task-abcdef1234567890")

        // ActiveDisplay.locator: machine:pid for a process row, provider ·
        // 12-char taskId for cloud (matching the CLI's own truncation), "" when
        // neither is knowable — never a fabricated pid on a cloud row.
        check("process locator is machine:pid",
              ActiveDisplay.locator(machine: "yosemite-s0", pid: 48213, cloudProvider: nil, cloudTaskId: nil)
                == "yosemite-s0:pid 48213")
        check("cloud locator truncates the task id to 12 chars",
              ActiveDisplay.locator(machine: nil, pid: nil, cloudProvider: "rush", cloudTaskId: "task-abcdef1234567890")
                == "rush · task-abcdef1")
        check("a pid-less, machine-less, cloud-less row locates to nothing",
              ActiveDisplay.locator(machine: nil, pid: nil, cloudProvider: nil, cloudTaskId: nil).isEmpty)
        check("a positive pid with no known machine still shows the pid",
              ActiveDisplay.locator(machine: nil, pid: 999, cloudProvider: nil, cloudTaskId: nil) == "pid 999")

        print(pass ? "ALL PASS" : "SOME FAILED")
        exit(pass ? 0 : 1)
    }
}
