import Foundation

// High-load warning self-test: exercise the classifier + the remote-cache
// filtering (reachable / freshness / high-load cutoff / self-row skip) against
// real code, then print the LIVE loadedDevices() for this machine so a run on a
// loaded box is its own end-to-end proof. Gated by MENUBAR_LOAD_TEST=1 (main.swift);
// no GUI, no Accessibility grant. Mirrors IssueSelfTest / GuardsSelfTest.
enum LoadedDeviceSelfTest {
    static func run() -> Never {
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL") — \(name)")
            if !cond { pass = false }
        }

        // classifyLoad thresholds (worst of load%/mem%; loaded ≥75, critical at
        // load ≥150 or mem ≥90) — mirrors src/lib/devices/health.ts headroom().
        check("busy 40% is not a warning",
              LocalState.classifyLoad(name: "x", isLocal: false, loadPercent: 40, memPercent: 10) == nil)
        check("loaded 80% warns",
              LocalState.classifyLoad(name: "x", isLocal: false, loadPercent: 80, memPercent: 10)?.severity == .warning)
        check("extreme load 160% is critical",
              LocalState.classifyLoad(name: "x", isLocal: false, loadPercent: 160, memPercent: 10)?.severity == .critical)
        check("high mem 95% is critical",
              LocalState.classifyLoad(name: "x", isLocal: false, loadPercent: 20, memPercent: 95)?.severity == .critical)
        check("worst-signal: mem 80% with low load warns",
              LocalState.classifyLoad(name: "x", isLocal: false, loadPercent: 10, memPercent: 80)?.severity == .warning)
        check("nil mem falls back to load% (85% warns)",
              LocalState.classifyLoad(name: "x", isLocal: false, loadPercent: 85, memPercent: nil)?.severity == .warning)

        // Remote-cache filtering: reachable + fresh + loaded, self-row skipped.
        let now = 1_000_000_000_000.0
        let fresh = now - 60_000            // 1 min old
        let stale = now - 40 * 60_000       // 40 min old (> 10 min window)
        let entries: [String: Any] = [
            "peer-hot":   ["reachable": true,  "loadPercent": 90,  "memPercent": 30, "fetchedAt": fresh],
            "peer-stale": ["reachable": true,  "loadPercent": 300, "memPercent": 30, "fetchedAt": stale],
            "peer-down":  ["reachable": false, "fetchedAt": fresh],
            "peer-calm":  ["reachable": true,  "loadPercent": 20,  "memPercent": 10, "fetchedAt": fresh],
            "myself":     ["reachable": true,  "loadPercent": 500, "memPercent": 90, "fetchedAt": fresh],
        ]
        let remotes = LocalState.remoteLoadedDevices(entries: entries, selfAliases: ["myself"], now: now)
        let names = Set(remotes.map { $0.name })
        check("fresh loaded peer warns", names.contains("peer-hot"))
        check("31h-style stale row is dropped", !names.contains("peer-stale"))
        check("unreachable row is dropped", !names.contains("peer-down"))
        check("calm peer is dropped", !names.contains("peer-calm"))
        check("self row is dropped (local handled natively)", !names.contains("myself"))

        // Dedupe when the fleet id and the ProcessInfo id disagree (zion vs mac):
        // a cache row under EITHER alias must not double the local machine.
        let dupEntries: [String: Any] = [
            "zion": ["reachable": true, "loadPercent": 200, "memPercent": 40, "fetchedAt": fresh],
        ]
        let deduped = LocalState.remoteLoadedDevices(entries: dupEntries, selfAliases: ["zion", "mac"], now: now)
        check("self alias 'zion' cache row is deduped", deduped.isEmpty)

        // Live end-to-end: real getloadavg() + the real .fleet-stats.json on THIS box.
        print("--- live loadedDevices() on this machine ---")
        let live = LocalState.loadedDevices()
        if live.isEmpty {
            print("  (no device currently above the high-load threshold)")
        }
        for d in live {
            let mem = d.memPercent.map { " · mem \(Int($0.rounded()))%" } ?? ""
            print("  [\(d.severity)] \(d.name)\(d.isLocal ? " (this Mac)" : "") — load \(Int(d.loadPercent.rounded()))%\(mem)")
        }

        print(pass ? "ALL PASS" : "SOME FAILED")
        exit(pass ? 0 : 1)
    }
}
