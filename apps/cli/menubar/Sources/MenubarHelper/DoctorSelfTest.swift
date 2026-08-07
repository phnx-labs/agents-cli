import Foundation

// RUSH-2382: doctor findings are an additive JSON field emitted by newer CLI
// versions. Verify an older payload retains the legacy path and that the menu's
// fleet health policy remains bounded and in canonical doctor order.
enum DoctorSelfTest {
    static func run() -> Never {
        var pass = true
        func check(_ name: String, _ condition: Bool) {
            print("\(condition ? "PASS" : "FAIL") — \(name)")
            if !condition { pass = false }
        }

        let decoder = JSONDecoder()
        let legacyJSON = """
        {"clis":{"claude":{"installed":true}},"sync":[],"orphans":[]}
        """
        guard let legacy = try? decoder.decode(DoctorOverview.self, from: Data(legacyJSON.utf8)) else {
            print("FAIL — legacy doctor overview did not decode")
            exit(1)
        }
        check("legacy doctor payload leaves findings absent", legacy.findings == nil)
        check("legacy payload selects install/sync fallback", DoctorHealth.summary(legacy.findings) == nil)

        let findingsJSON = """
        {"findings":[
          {"severity":"critical","kind":"hook-runtime-broken","device":"yosemite-m4","agent":"claude","version":"1.2.3","message":"Missing hook runtime: main-branch-guard","remediation":"agents doctor --fix"},
          {"severity":"warning","kind":"stale","device":"zion","agent":"codex","version":"0.1.0","message":"resources stale","remediation":"agents sync codex"},
          {"severity":"warning","kind":"stale-cli","device":"pinnacles","message":"older agents-cli","remediation":"upgrade"},
          {"severity":"critical","kind":"unwired-hook","device":"mac-mini","agent":"grok","versions":["a","b"],"message":"hook unwired","remediation":"agents doctor --fix"},
          {"severity":"warning","kind":"orphan","device":"win-mini","message":"orphan resource","remediation":"agents doctor --fix"},
          {"severity":"warning","kind":"stale","device":"yosemite-m0","message":"stale resources","remediation":"agents doctor --fix"}
        ]}
        """
        guard let overview = try? decoder.decode(DoctorOverview.self, from: Data(findingsJSON.utf8)) else {
            print("FAIL — findings doctor overview did not decode")
            exit(1)
        }
        check("findings summary counts critical and warning", DoctorHealth.summary(overview.findings) == "2 critical · 4 warnings")
        check("visible findings cap is five", DoctorHealth.visible(overview.findings).count == DoctorHealth.maxVisibleFindings)
        check("remainder names the sixth finding", DoctorHealth.remainderCount(overview.findings) == 1)
        check("visible findings preserve doctor order", DoctorHealth.visible(overview.findings).map(\.device) == ["yosemite-m4", "zion", "pinnacles", "mac-mini", "win-mini"])
        check("context includes device and agent version", DoctorHealth.context(DoctorHealth.visible(overview.findings)[0]) == "critical · yosemite-m4 · claude @1.2.3")
        check("context marks a collapsed row with its version count", DoctorHealth.context(DoctorHealth.visible(overview.findings)[3]) == "critical · mac-mini · grok (2 versions)")

        // MARK: actionable detail — the row carries doctor's exact fix so the
        // finding is actionable from the menu (display-only; never run).
        check("detail appends the remediation",
              DoctorHealth.detail(DoctorHealth.visible(overview.findings)[0])
                == "Missing hook runtime: main-branch-guard → agents doctor --fix")
        let noFixJSON = """
        {"severity":"warning","kind":"stale-cli","device":"pinnacles","message":"older agents-cli"}
        """
        guard let noFix = try? decoder.decode(DoctorFinding.self, from: Data(noFixJSON.utf8)) else {
            print("FAIL — a finding without remediation did not decode")
            exit(1)
        }
        check("a finding without remediation decodes it as nil", noFix.remediation == nil)
        check("detail without remediation is the bare message",
              DoctorHealth.detail(noFix) == "older agents-cli")
        let longMessage = String(repeating: "x", count: 200)
        let longJSON = """
        {"severity":"critical","kind":"unwired-hook","device":"mac-mini","message":"\(longMessage)","remediation":"agents doctor --fix"}
        """
        let longFinding = try! decoder.decode(DoctorFinding.self, from: Data(longJSON.utf8))
        check("detail stays bounded for a long message",
              DoctorHealth.detail(longFinding).count == 96
                && DoctorHealth.detail(longFinding).hasSuffix("…"))

        // MARK: severity filter — only critical/warning are actionable; an
        // unknown future severity is hidden rather than mis-bucketed.
        let futureJSON = """
        {"findings":[
          {"severity":"info","kind":"some-future-kind","device":"zion","message":"FYI"},
          {"severity":"critical","kind":"cli-missing","device":"zion","agent":"grok","message":"binary gone"}
        ]}
        """
        let future = try! decoder.decode(DoctorOverview.self, from: Data(futureJSON.utf8))
        check("unknown severities are not actionable",
              DoctorHealth.visible(future.findings).count == 1)
        check("summary ignores unknown severities",
              DoctorHealth.summary(future.findings) == "1 critical")
        check("an empty findings array reads healthy, not legacy",
              DoctorHealth.summary([]) == "all set")

        // MARK: exact poll argv — the 15-minute refresh must keep requesting
        // the fleet-aware doctor JSON; a silent flag drift breaks the contract.
        // NOT `--devices`: measured 265s warm on mac-mini (2026-08-07) against
        // the poll's 180s deadline — the refresh would never complete.
        check("doctor poll requests the bounded fleet-aware JSON",
              AgentsCLI.doctorOverviewArgs() == ["doctor", "--json"])

        print(pass ? "ALL PASS" : "SOME FAILED")
        exit(pass ? 0 : 1)
    }
}
