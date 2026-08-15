import Foundation
import SQLite3

// Reads live agent state DIRECTLY from disk — never shells the `agents` CLI for
// data. This is the whole point: `agents sessions` (without --active) triggers a
// full transcript re-index into sessions.db, which is costly. Every source here
// is a cheap file read, so the dropdown populates instantly on click.
//
// Sources (all grounded in src/lib/session/active.ts + src/lib/state.ts):
//   terminals : ~/.agents/.cache/terminals/live-terminals.json
//   teams     : ~/.agents/.history/teams/agents/<id>/meta.json
//   cloud     : ~/.agents/.cache/cloud/tasks.db  (SQLite)
//   browser   : ~/.agents/.cache/browser/<profile>/tasks.json
//   attention : ~/.agents/.cache/state/attention/<sessionId>  (written by the Notification hook)
//   roster    : fixed product-supported order
enum SessionStatus: String {
    case running
    case idle
    case inputRequired = "input_required"
    case queued
    case closed
    case abandoned
    case orphaned
    case crashed
    case unknown
}

struct Session {
    let agent: String
    let repo: String      // grouping key: git repo / working-dir name
    let cwd: String?
    let status: SessionStatus
    let context: String   // terminal | teams | cloud
    let title: String     // what it's doing: topic / terminal label / preview
    let question: String  // what it's waiting on — attention-sentinel content ("" when empty)
    let attentionSinceMs: Double?  // sentinel mtime — when it started waiting
    /// Process host (zion, yosemite-m0). Nil when unknown.
    let machine: String?
    /// Surface on the host (tmux, codium, …).
    let surface: String?
    let sessionId: String?
    // `var`, not `let`: a default-valued `let` is excluded from Swift's
    // synthesized memberwise init entirely (immutable once defaulted), so the
    // cheap local sources (teams meta.json, cloud tasks.db, live terminals)
    // that build a `Session` directly can keep omitting these four while
    // `sessions(fromActive:)` still passes them explicitly.
    /// OS process id for a real process row (terminal/tmux/headless/team). Nil
    /// for a cloud row — see `cloudProvider`/`cloudTaskId` instead.
    var pid: Int? = nil
    /// Positively-verified liveness of `pid` at scan time (RUSH-2336). Nil for
    /// a cloud row or an older-peer payload — never treated as "alive".
    var pidAlive: Bool? = nil
    var cloudProvider: String? = nil
    var cloudTaskId: String? = nil
    let ticketId: String?
    let prLink: String?
    let startedAtMs: Double?
    let lastActivityMs: Double?
    let preview: String?
    let owner: String?
    let origin: String?
    let routineName: String?

    /// Prefer topic/label/preview for "what" — never leave a bare agent name alone
    /// when the engine already carried a better signal.
    var workTitle: String {
        let candidates = [title, preview ?? "", question]
        for c in candidates {
            let t = c.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { return t }
        }
        return ""
    }
}

// Pure formatting helpers for the ACTIVE accordion (unit-tested).
enum ActiveDisplay {
    /// Exact lifecycle word used by the CLI active-session model.
    static func statusLabel(_ status: SessionStatus) -> String {
        switch status {
        case .running: return "working"
        case .inputRequired: return "waiting"
        case .orphaned: return "orphan"
        default: return status.rawValue
        }
    }

    static func statusGlyph(_ status: SessionStatus) -> String {
        switch status {
        case .running: return "●"
        case .inputRequired: return "◐"
        case .idle, .queued: return "○"
        case .abandoned: return "⊘"
        case .closed: return "×"
        case .crashed: return "✗"
        case .orphaned: return "◍"
        case .unknown: return "◌"
        }
    }

    /// Prefer engine topic, then terminal label, then a short preview line.
    static func workTitle(topic: String?, label: String?, preview: String?,
                          terminalTitle: String?) -> String {
        for raw in [topic, label, terminalTitle, preview] {
            guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty
            else { continue }
            // Previews can be multi-paragraph agent dumps — first line only.
            let first = s.split(whereSeparator: \.isNewline).first.map(String.init) ?? s
            return first
        }
        return ""
    }

    /// Human duration from an epoch-ms timestamp to now (e.g. "3m", "2h", "1d").
    static func ageLabel(fromMs: Double?, nowMs: Double = Date().timeIntervalSince1970 * 1000) -> String {
        guard let fromMs, fromMs > 0, nowMs >= fromMs else { return "" }
        let sec = Int((nowMs - fromMs) / 1000)
        if sec < 60 { return "\(max(sec, 0))s" }
        let min = sec / 60
        if min < 60 { return "\(min)m" }
        let hr = min / 60
        if hr < 48 { return "\(hr)h" }
        return "\(hr / 24)d"
    }

    /// Match CLI `normalizeHost` / `machineId()` so engine-tagged rows (`zion`)
    /// compare equal to this box. First DNS label, lowercased, non [a-z0-9_-] → `-`.
    static func normalizeHost(_ raw: String) -> String {
        let first = raw.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: true)
            .first.map(String.init) ?? raw
        let lowered = first.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let mapped = lowered.map { ch -> Character in
            if ch.isLetter || ch.isNumber || ch == "-" || ch == "_" { return ch }
            return "-"
        }
        let out = String(mapped)
        return out.isEmpty ? "unknown" : out
    }

    /// This machine's id — same sources as CLI `machineId()` (env override, else hostname).
    static func thisMachineId(
        env: [String: String] = ProcessInfo.processInfo.environment,
        hostname: String = ProcessInfo.processInfo.hostName
    ) -> String {
        if let override = env["AGENTS_SYNC_MACHINE_ID"], !override.isEmpty {
            return normalizeHost(override)
        }
        return normalizeHost(hostname)
    }

    /// local vs remote for display. `thisMachine` must already be normalizeHost'd
    /// (same form as engine `machine` tags). Nil machine on a local-only listing
    /// is treated as local — the engine usually stamps machineId, but cold paths
    /// (terminals.json) may omit it.
    static func locality(machine: String?, thisMachine: String) -> String {
        guard let machine, !machine.isEmpty else { return "local" }
        let m = normalizeHost(machine)
        if m == thisMachine || m == "localhost" || m == "unknown" { return "local" }
        return "remote · \(m)"
    }

    /// RUSH-2336: the exact process/provider handle behind a session, mirroring
    /// the CLI's `--active` row locator — `machine:pid` for a real OS process
    /// (never fabricated: nil unless a positive pid is present), or
    /// `provider · taskId` (first 12 chars, matching the CLI's truncation) for
    /// a cloud row with no local pid at all. Returns "" when neither is known.
    static func locator(machine: String?, pid: Int?,
                        cloudProvider: String?, cloudTaskId: String?) -> String {
        if let provider = cloudProvider, !provider.isEmpty {
            let taskBit = cloudTaskId.map { String($0.prefix(12)) } ?? ""
            return taskBit.isEmpty ? provider : "\(provider) · \(taskBit)"
        }
        guard let pid, pid > 0 else { return "" }
        let host = machine.flatMap { $0.isEmpty ? nil : $0 }
        return host.map { "\($0):pid \(pid)" } ?? "pid \(pid)"
    }

    /// Collapsed project row includes every lifecycle state reported by the CLI.
    static func projectSummary(repo: String, statuses: [SessionStatus: Int],
                               machines: [String]) -> String {
        var parts: [String] = [repo]
        let order: [SessionStatus] = [
            .running, .inputRequired, .idle, .queued, .orphaned,
            .crashed, .closed, .abandoned, .unknown,
        ]
        let counts = order.compactMap { status -> String? in
            guard let count = statuses[status], count > 0 else { return nil }
            return "\(statusGlyph(status))\(count) \(statusLabel(status))"
        }
        if !counts.isEmpty { parts.append(counts.joined(separator: " ")) }
        let hosts = Array(Set(machines.filter { !$0.isEmpty })).sorted()
        if hosts.count == 1 {
            parts.append(hosts[0])
        } else if hosts.count > 1 {
            parts.append("\(hosts.count) hosts")
        }
        return parts.joined(separator: "  ·  ")
    }

    /// Pull `123` from `…/pull/123` or `…/pulls/123`; nil if not a PR URL.
    static func prNumber(from url: String?) -> String? {
        guard let url, !url.isEmpty else { return nil }
        let parts = url.split(separator: "/").map(String.init)
        guard let i = parts.firstIndex(where: { $0 == "pull" || $0 == "pulls" }),
              i + 1 < parts.count else { return nil }
        let n = parts[i + 1].split(separator: "#").first.map(String.init) ?? parts[i + 1]
        return n.allSatisfy(\.isNumber) ? n : nil
    }
}

// One attention sentinel: mtime = when the session flagged, content = the
// notification message (the question), empty for hooks that only touch the file.
// sinceMs is nil when the stat fails (sentinel raced away, permissions) — the
// row then renders without an elapsed suffix instead of an epoch-0 "20000d".
struct AttentionMark {
    let sinceMs: Double?
    let text: String
}

// A newly-discovered tailnet node awaiting the user's Register / Ignore.
struct PendingDevice {
    let name: String
    let platform: String
}

// A device (this Mac or a fleet peer) currently under high load, surfaced as a
// NEEDS YOU warning. `loadPercent` is the normalized load average
// (loadAvg1/ncpu*100), matching the CLI's src/lib/devices/health.ts. `severity`
// drives the glyph/color: `.critical` when load or memory is extreme.
struct LoadedDevice {
    enum Severity { case warning, critical }
    let name: String
    let isLocal: Bool
    let loadPercent: Double
    let memPercent: Double?
    let severity: Severity
}

enum LocalState {
    private static let home = NSHomeDirectory()
    private static let fm = FileManager.default
    private static let activeWindowMs: Double = 2 * 60_000  // matches ACTIVE_MTIME_WINDOW_MS
    static let desiredAgents: [MenuAgent] = [
        MenuAgent(id: "claude", label: "Claude"),
        MenuAgent(id: "codex", label: "Codex"),
        MenuAgent(id: "grok", label: "Grok-Cli"),
        MenuAgent(id: "kimi", label: "Kimi-Cli"),
        MenuAgent(id: "antigravity", label: "Antigravity"),
        MenuAgent(id: "droid", label: "Droid"),
        MenuAgent(id: "opencode", label: "OpenCode"),
    ]

    static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

    // MARK: Product-supported roster
    static func installedAgents() -> [String] {
        desiredAgents.map(\.id)
    }

    static func quickDispatchRoster(env: [String: String] = ProcessInfo.processInfo.environment) -> [MenuAgent] {
        let configured = env["AGENTS_QUICK_DISPATCH_ROSTER"]?
            .split(separator: ",")
            .map { normalizeAgent(String($0).trimmingCharacters(in: .whitespacesAndNewlines)) } ?? []
        if configured.isEmpty { return desiredAgents }

        var seen = Set<String>()
        let filtered = configured.compactMap { id -> MenuAgent? in
            guard seen.insert(id).inserted else { return nil }
            return desiredAgents.first { $0.id == id }
        }
        return filtered.isEmpty ? desiredAgents : filtered
    }

    static func agentLabel(_ id: String) -> String {
        desiredAgents.first { $0.id == normalizeAgent(id) }?.label ?? id
    }

    static func normalizeAgent(_ raw: String) -> String {
        let v = raw.lowercased().replacingOccurrences(of: "_", with: "-")
        switch v {
        case "grok-cli": return "grok"
        case "kimi-cli": return "kimi"
        case "open-code": return "opencode"
        default: return v
        }
    }

    // MARK: Browser sessions
    static func browserTasks(limit: Int = 3) -> [BrowserTask] {
        let base = "\(home)/.agents/.cache/browser"
        let profiles = (try? fm.contentsOfDirectory(atPath: base)) ?? []
        var out: [BrowserTask] = []

        for profile in profiles where !profile.hasPrefix(".") {
            let path = "\(base)/\(profile)/tasks.json"
            guard let data = fm.contents(atPath: path),
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            for (key, raw) in root {
                guard let task = raw as? [String: Any] else { continue }
                guard let pid = int(task["pid"]), pid > 0, pidAlive(pid) else { continue }
                let tabs = task["tabs"] as? [String: Any]
                let name = string(task["name"]) ?? key
                let createdAt = double(task["createdAt"]) ?? 0
                out.append(BrowserTask(name: name, profile: profile, tabCount: tabs?.count ?? 0,
                                       createdAt: createdAt, pid: pid))
            }
        }

        return Array(out.sorted { $0.createdAt > $1.createdAt }.prefix(limit))
    }

    // MARK: Attention sentinels (written by the Notification hook)
    // name = sessionId, mtime = when flagged, content = the notification message
    // (newer hooks write it; empty for the touch-only contract). One stat + one
    // tiny read per blocked session — stays cheap on the badge poll path.
    //
    // liveSessionIds prunes orphans on read: a sentinel whose sessionId is not
    // in the caller's live set (pid alive) gets unlinked. The write-side hook
    // already clears on Stop/UserPromptSubmit, but it leaks when the terminal
    // is killed hard, a Claude version has no hook installed, or the sessionId
    // doesn't round-trip. When nil, keep sentinels intact — pruning against a
    // partial live set (e.g. IDE-extension terminals only) would wipe live
    // headless/tmux/SSH sentinels within one poll. Only the engine's full
    // active-list (sessions(fromActive:)) is broad enough to safely prune.
    static func attentionMarks(liveSessionIds: Set<String>? = nil) -> [String: AttentionMark] {
        let dir = "\(home)/.agents/.cache/state/attention"
        let names = (try? fm.contentsOfDirectory(atPath: dir)) ?? []
        var out: [String: AttentionMark] = [:]
        for name in names where !name.hasPrefix(".") {
            let path = "\(dir)/\(name)"
            if let live = liveSessionIds, !live.contains(name) {
                try? fm.removeItem(atPath: path)
                continue
            }
            let attrs = try? fm.attributesOfItem(atPath: path)
            let since = (attrs?[.modificationDate] as? Date).map { $0.timeIntervalSince1970 * 1000 }
            let raw = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
            out[name] = AttentionMark(sinceMs: since,
                                      text: raw.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return out
    }

    // MARK: Pending devices (written by the daemon device probe)
    // Each sentinel file's NAME is the tailscale node name; its CONTENT is the
    // platform. Cheap dir read, safe on the badge poll path. Mirrors the
    // attention sentinel contract (src/lib/devices/pending.ts).
    static func pendingDevices() -> [PendingDevice] {
        let dir = "\(home)/.agents/.cache/state/devices-pending"
        let names = (try? fm.contentsOfDirectory(atPath: dir)) ?? []
        return names.filter { !$0.hasPrefix(".") }.sorted().map { name in
            let raw = (try? String(contentsOfFile: "\(dir)/\(name)", encoding: .utf8)) ?? ""
            let platform = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            return PendingDevice(name: name, platform: platform.isEmpty ? "unknown" : platform)
        }
    }

    // MARK: Device load warnings (this Mac natively + fleet peers from the warm cache)
    // Mirrors the CLI classifier src/lib/devices/health.ts:194-205 — worst of
    // load%/mem%: <15 idle · <40 light · <75 busy · ≥75 loaded. We warn only on
    // `loaded` (≥75%). The local machine is probed NATIVELY (getloadavg, a libc
    // call — zero subprocess, and this is what would have caught zion at load 95)
    // and is deliberately NOT read from .fleet-stats.json, whose local self-row can
    // be a stale `reachable:false`. Remote peers come from the daemon-warmed cache
    // with a freshness guard so stale rows never warn.
    static let highLoadThreshold: Double = 75      // headroom() 'loaded' cutoff
    private static let criticalLoadPercent: Double = 150
    private static let criticalMemPercent: Double = 90
    private static let fleetStatFreshMs: Double = 10 * 60_000  // ignore rows older than this

    static func loadedDevices(now: Double = LocalState.nowMs()) -> [LoadedDevice] {
        var out: [LoadedDevice] = []
        let aliases = selfAliases()

        // Local machine — native probe, always current. Named by the fleet id
        // (`localMachineName()`), so it reads "zion" (what `agents devices` shows),
        // not the ProcessInfo mDNS name ("mac.local").
        let ncpu = max(1, ProcessInfo.processInfo.activeProcessorCount)
        let localLoadPct = localLoadAvg1() / Double(ncpu) * 100
        if let d = classifyLoad(name: localMachineName(), isLocal: true,
                                loadPercent: localLoadPct, memPercent: localMemPercent()) {
            out.append(d)
        }

        // Remote peers — daemon-warmed cache, reachable + fresh + loaded only.
        let path = "\(home)/.agents/.cache/.fleet-stats.json"
        if let data = fm.contents(atPath: path),
           let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let entries = root["entries"] as? [String: Any] {
            out += remoteLoadedDevices(entries: entries, selfAliases: aliases, now: now)
        }

        // Local first, then remote worst-load first.
        return out.sorted { a, b in
            if a.isLocal != b.isLocal { return a.isLocal }
            return a.loadPercent > b.loadPercent
        }
    }

    // Per-host load for the collapsible DEVICES section — EVERY reachable + fresh
    // peer from the warm .fleet-stats.json (not just the ≥75% ones loadedDevices
    // keeps), plus this Mac probed natively. Keyed by normalized fleet id so it
    // merges onto the device roster by name. A device absent here simply renders
    // with no load number — we never claim an online/offline it can't back.
    static func deviceLoads(now: Double = LocalState.nowMs()) -> [String: (load: Double, mem: Double?)] {
        var out: [String: (load: Double, mem: Double?)] = [:]
        let ncpu = max(1, ProcessInfo.processInfo.activeProcessorCount)
        out[ActiveDisplay.normalizeHost(localMachineName())] = (localLoadAvg1() / Double(ncpu) * 100, localMemPercent())

        let path = "\(home)/.agents/.cache/.fleet-stats.json"
        if let data = fm.contents(atPath: path),
           let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let entries = root["entries"] as? [String: Any] {
            let aliases = selfAliases()
            for (host, raw) in entries {
                let key = ActiveDisplay.normalizeHost(host)
                guard !aliases.contains(key),
                      let row = raw as? [String: Any],
                      (row["reachable"] as? Bool) == true,
                      let fetchedAt = double(row["fetchedAt"]), now - fetchedAt <= fleetStatFreshMs,
                      let loadPct = double(row["loadPercent"]) else { continue }
                out[key] = (loadPct, double(row["memPercent"]))
            }
        }
        return out
    }

    // The fleet id for THIS box, matching how `agents devices` labels it (env
    // override, else POSIX gethostname() == `hostname`/os.hostname(), e.g. "zion").
    // Swift's ProcessInfo.hostName returns the mDNS name ("mac.local") which does
    // NOT match the fleet id, so it can't be the source here.
    static func localMachineName() -> String {
        if let ov = ProcessInfo.processInfo.environment["AGENTS_SYNC_MACHINE_ID"], !ov.isEmpty {
            return ActiveDisplay.normalizeHost(ov)
        }
        var buf = [CChar](repeating: 0, count: 256)
        if gethostname(&buf, buf.count) == 0 {
            let h = String(cString: buf)
            if !h.isEmpty { return ActiveDisplay.normalizeHost(h) }
        }
        return ActiveDisplay.thisMachineId()
    }

    // Every name this box can appear under in the fleet cache — the fleet id AND
    // the ProcessInfo-derived id — so a remote cache row for self is deduped even
    // when the two disagree (observed: gethostname "zion" vs ProcessInfo "mac").
    static func selfAliases() -> Set<String> {
        [localMachineName(), ActiveDisplay.thisMachineId()]
    }

    // Classify fleet peers from a parsed `.fleet-stats.json` entries dict. Skips
    // any self-alias (local is probed natively), unreachable rows, rows staler than
    // the freshness window, and anything below the high-load cutoff. Internal so
    // the self-test can drive it with synthetic entries.
    static func remoteLoadedDevices(entries: [String: Any], selfAliases: Set<String>, now: Double) -> [LoadedDevice] {
        var out: [LoadedDevice] = []
        for (host, raw) in entries {
            guard !selfAliases.contains(ActiveDisplay.normalizeHost(host)),  // local handled natively
                  let row = raw as? [String: Any],
                  (row["reachable"] as? Bool) == true,
                  let fetchedAt = double(row["fetchedAt"]), now - fetchedAt <= fleetStatFreshMs,
                  let loadPct = double(row["loadPercent"]) else { continue }
            if let d = classifyLoad(name: host, isLocal: false,
                                    loadPercent: loadPct, memPercent: double(row["memPercent"])) {
                out.append(d)
            }
        }
        return out
    }

    // Returns a LoadedDevice only when the device is `loaded` (worst signal ≥75%).
    static func classifyLoad(name: String, isLocal: Bool,
                             loadPercent: Double, memPercent: Double?) -> LoadedDevice? {
        let worst = max(loadPercent, memPercent ?? 0)
        guard worst >= highLoadThreshold else { return nil }
        let critical = loadPercent >= criticalLoadPercent || (memPercent ?? 0) >= criticalMemPercent
        return LoadedDevice(name: name, isLocal: isLocal, loadPercent: loadPercent,
                            memPercent: memPercent, severity: critical ? .critical : .warning)
    }

    // 1-minute load average via libc — no subprocess.
    private static func localLoadAvg1() -> Double {
        var loads = [Double](repeating: 0, count: 3)
        return getloadavg(&loads, 3) > 0 ? loads[0] : 0
    }

    // macOS memory-in-use %, Activity-Monitor semantics (active+wired+compressed
    // used; free+inactive+speculative available) — mirrors health.ts parseVmStat.
    // Returns nil on any failure; the classifier then falls back to load% alone.
    private static func localMemPercent() -> Double? {
        var stats = vm_statistics64_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.stride / MemoryLayout<integer_t>.stride)
        let kr = withUnsafeMutablePointer(to: &stats) { ptr -> kern_return_t in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return nil }
        let used = Double(stats.active_count) + Double(stats.wire_count) + Double(stats.compressor_page_count)
        let avail = Double(stats.free_count) + Double(stats.inactive_count) + Double(stats.speculative_count)
        let total = used + avail
        guard total > 0 else { return nil }
        return used / total * 100
    }

    // MARK: Sessions from the engine's active list (warm cache)
    // Convert `agents sessions --active --local --json` rows into menu Sessions.
    // The engine list is authoritative for coverage + running/idle; the cheap
    // local files still contribute what the engine payload lacks: the terminal
    // label (title) and the attention sentinel (question + wait-start).
    static func sessions(fromActive active: [ActiveSession]) -> [Session] {
        let liveIds = Set(active.compactMap { $0.sessionId }.filter { !$0.isEmpty })
        let attention = attentionMarks(liveSessionIds: liveIds)
        let titles = terminalTitles()
        var out: [Session] = []
        for a in active {
            let sid = a.sessionId ?? ""
            let mark = sid.isEmpty ? nil : attention[sid]
            // Prefer real git repo name over worktree slug; a cloud row with no
            // local cwd groups under the explicit `cloud` bucket, never its
            // harness/machine (RUSH-2688).
            let repo = Self.groupKey(cwd: a.cwd, isCloud: a.context == "cloud")
            let status = SessionStatus(rawValue: a.status) ?? .unknown
            let work = ActiveDisplay.workTitle(topic: a.topic, label: a.label,
                                               preview: a.preview,
                                               terminalTitle: sid.isEmpty ? nil : titles[sid])
            out.append(Session(agent: a.kind ?? "agent", repo: repo, cwd: a.cwd, status: status,
                               context: a.context ?? "terminal",
                               title: work,
                               question: mark?.text ?? "",
                               attentionSinceMs: status == .inputRequired ? mark?.sinceMs : nil,
                               machine: a.machine, surface: a.host, sessionId: a.sessionId,
                               pid: a.pid, pidAlive: a.pidAlive,
                               cloudProvider: a.cloudProvider, cloudTaskId: a.cloudTaskId,
                               ticketId: a.ticketId, prLink: a.prLink,
                               startedAtMs: a.startedAtMs, lastActivityMs: a.lastActivityMs,
                               preview: a.preview, owner: a.owner,
                               origin: a.origin, routineName: a.routineName))
        }
        return out
    }

    // sessionId -> label from live-terminals.json (the engine's active payload
    // carries no label; the extension-registered terminals do).
    private static func terminalTitles() -> [String: String] {
        let path = "\(home)/.agents/.cache/terminals/live-terminals.json"
        guard let data = fm.contents(atPath: path),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        for (_, window) in root {
            guard let w = window as? [String: Any],
                  let entries = w["entries"] as? [[String: Any]] else { continue }
            for e in entries {
                if let sid = e["sessionId"] as? String, !sid.isEmpty,
                   let label = e["label"] as? String, !label.isEmpty {
                    out[sid] = label
                }
            }
        }
        return out
    }

    // MARK: All active sessions
    // includeTeams is false for the periodic badge poll — the teams/agents dir
    // accumulates ALL historical agents (can be thousands of meta.json files), so
    // scanning it every few seconds is too costly. Terminals + cloud + attention
    // are cheap. The full scan (with teams) runs only when the menu opens.
    static func sessions(includeTeams: Bool = true) -> [Session] {
        // Cheap path: read attention sentinels WITHOUT pruning. live-terminals.json
        // only carries IDE-extension terminals (VS Code / Cursor / Codium via the
        // agents-cli extension) — a strict subset of live sessions. A pid-alive
        // Claude in a plain Terminal / tmux / SSH shell isn't in it, so pruning
        // against this narrow set would delete live, genuinely-waiting sentinels
        // within one badge tick (10s). Pruning only happens on the warm-cache
        // path (sessions(fromActive:)) where the engine active-list gives full
        // coverage across tmux / IDE / headless.
        let attention = attentionMarks()
        var all = terminals(attention: attention) + cloud()
        if includeTeams { all += teams() }
        return all
    }


    /// Grouping key for the menu: prefer the real git repo name over a worktree
    /// directory slug. Paths under `.../.agents/worktrees/<slug>` group as the
    /// enclosing repository (the path component before `.agents`), not `<slug>`.
    static func repoName(from cwd: String?) -> String? {
        guard let cwd, !cwd.isEmpty else { return nil }
        let ns = cwd as NSString
        let parts = (cwd as NSString).pathComponents
        // Match .../.agents/worktrees/<slug>[/...]
        if let agentsIdx = parts.firstIndex(of: ".agents"),
           agentsIdx + 2 < parts.count,
           parts[agentsIdx + 1] == "worktrees" {
            // Enclosing repo root is the component before `.agents`
            if agentsIdx > 0 {
                return parts[agentsIdx - 1]
            }
        }
        return ns.lastPathComponent
    }

    /// The one group key for an ACTIVE row (RUSH-2688). A real working dir → its
    /// repo (worktree-aware, via `repoName`). A row with NO local cwd — a cloud
    /// task — groups under its own repo when the provider names one (reduced to
    /// the bare name so a cloud task for `phnx-labs/agents-cli` lands with local
    /// `agents-cli` work), else the explicit `cloud` bucket. It NEVER borrows the
    /// harness/provider name ('codex') or a machine name — neither is a project,
    /// and letting a provider stand in is exactly what grouped a Codex cloud task
    /// under 'codex'. No fallback chain: a single explicit bucket. Empty string
    /// means "unknown" and is folded into the `other` bucket at grouping time.
    static func groupKey(cwd: String?, isCloud: Bool, cloudRepo: String? = nil) -> String {
        if let repo = repoName(from: cwd) { return repo }
        if isCloud { return shortRepo(cloudRepo) ?? "cloud" }
        return ""
    }

    /// `org/name` (or any path-shaped repo) → its bare last segment, so a cloud
    /// row for `phnx-labs/agents-cli` groups under `agents-cli`. Blank → nil.
    private static func shortRepo(_ repo: String?) -> String? {
        guard let repo = repo?.trimmingCharacters(in: .whitespacesAndNewlines), !repo.isEmpty
        else { return nil }
        let last = repo.split(separator: "/").last.map(String.init) ?? repo
        return last.isEmpty ? nil : last
    }

    // MARK: Terminals
    private static func terminals(attention: [String: AttentionMark]) -> [Session] {
        let path = "\(home)/.agents/.cache/terminals/live-terminals.json"
        guard let data = fm.contents(atPath: path),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }

        var out: [Session] = []
        let attentionIds = Set(attention.keys)
        for (_, window) in root {
            guard let w = window as? [String: Any],
                  let entries = w["entries"] as? [[String: Any]] else { continue }
            for e in entries {
                guard let pid = e["pid"] as? Int, pidAlive(pid) else { continue }
                let kind = (e["kind"] as? String) ?? "session"
                let cwd = e["cwd"] as? String
                let label = (e["label"] as? String) ?? ""
                let sid = (e["sessionId"] as? String) ?? ""
                // repo is the grouping key — always the working-dir name; the
                // label is the session's own title, carried separately.
                let repo = Self.repoName(from: cwd) ?? label
                let mark = sid.isEmpty ? nil : attention[sid]
                let status = sessionStatus(sessionId: sid, kind: kind, cwd: cwd,
                                           attention: attentionIds)
                out.append(Session(agent: kind, repo: repo, cwd: cwd, status: status,
                                   context: "terminal", title: label,
                                   question: mark?.text ?? "",
                                   attentionSinceMs: status == .inputRequired ? mark?.sinceMs : nil,
                                   machine: nil, surface: nil, sessionId: sid.isEmpty ? nil : sid,
                                   ticketId: nil, prLink: nil,
                                   startedAtMs: nil, lastActivityMs: nil,
                                   preview: nil, owner: nil, origin: nil, routineName: nil))
            }
        }
        return out
    }

    // MARK: Teams (filter to running + pid alive; the dir holds all history)
    private static func teams() -> [Session] {
        let base = "\(home)/.agents/.history/teams/agents"
        let ids = (try? fm.contentsOfDirectory(atPath: base)) ?? []
        var out: [Session] = []
        for id in ids where !id.hasPrefix(".") {
            let metaPath = "\(base)/\(id)/meta.json"
            guard let data = fm.contents(atPath: metaPath),
                  let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            guard (m["status"] as? String) == "running" else { continue }
            guard let pid = m["pid"] as? Int, pidAlive(pid) else { continue }
            let agent = (m["agentType"] as? String) ?? "agent"
            let cwd = m["cwd"] as? String
            let task = (m["taskName"] as? String) ?? (m["name"] as? String) ?? ""
            let repo = Self.repoName(from: cwd) ?? ""
            out.append(Session(agent: agent, repo: repo, cwd: cwd,
                               status: .running, context: "teams", title: task,
                               question: "", attentionSinceMs: nil,
                               machine: nil, surface: nil, sessionId: id,
                               ticketId: nil, prLink: nil,
                               startedAtMs: nil, lastActivityMs: nil,
                               preview: nil, owner: nil, origin: nil, routineName: nil))
        }
        return out
    }

    // MARK: Cloud (SQLite read of tasks.db)
    private static func cloud() -> [Session] {
        let path = "\(home)/.agents/.cache/cloud/tasks.db"
        guard fm.fileExists(atPath: path) else { return [] }
        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            sqlite3_close(db); return []
        }
        defer { sqlite3_close(db) }
        let sql = "SELECT agent, status, prompt, repo, provider FROM tasks " +
                  "WHERE status NOT IN ('completed','failed','cancelled') ORDER BY created_at DESC"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }

        var out: [Session] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let agent = col(stmt, 0) ?? "cloud"
            let raw = col(stmt, 1) ?? ""
            let prompt = col(stmt, 2) ?? ""
            let provider = col(stmt, 4)
            // Group under the task's own repo when the provider named one, else
            // the explicit `cloud` bucket — NEVER the provider/harness name
            // ('codex'), which is not a project (RUSH-2688). The old
            // `repo ?? provider ?? "cloud"` chain grouped a repo-less Codex cloud
            // task under 'codex'.
            let repo = Self.groupKey(cwd: nil, isCloud: true, cloudRepo: col(stmt, 3))
            let status: SessionStatus = raw == "running" ? .running
                : (raw == "input_required" || raw == "needs_review") ? .inputRequired : .queued
            out.append(Session(agent: agent, repo: repo, cwd: nil,
                               status: status, context: "cloud",
                               title: String(prompt.prefix(60)),
                               question: status == .inputRequired ? "needs review" : "",
                               attentionSinceMs: nil,
                               machine: nil, surface: "cloud", sessionId: nil,
                               cloudProvider: provider,
                               ticketId: nil, prLink: nil,
                               startedAtMs: nil, lastActivityMs: nil,
                               preview: nil, owner: nil, origin: nil, routineName: nil))
        }
        return out
    }

    // MARK: Status for a local session
    // attention sentinel wins; else claude transcript mtime (cheap single stat);
    // else default running when alive (mirrors active.ts classifyActivity fallback).
    private static func sessionStatus(sessionId: String, kind: String, cwd: String?, attention: Set<String>) -> SessionStatus {
        if !sessionId.isEmpty, attention.contains(sessionId) { return .inputRequired }
        if kind == "claude", let cwd, let mtime = claudeTranscriptMtimeMs(sessionId: sessionId, cwd: cwd) {
            return (nowMs() - mtime) < activeWindowMs ? .running : .idle
        }
        return .running
    }

    // Claude transcript lives at ~/.claude/projects/<enc>/<sid>.jsonl (and per-version
    // homes). enc = cwd with `/` and `.` replaced by `-` (active.ts:139). One stat each.
    private static func claudeTranscriptMtimeMs(sessionId: String, cwd: String) -> Double? {
        let enc = String(cwd.map { ($0 == "/" || $0 == ".") ? "-" : $0 })
        var roots = ["\(home)/.claude/projects/\(enc)/\(sessionId).jsonl"]
        let versionsBase = "\(home)/.agents/.history/versions/claude"
        if let versions = try? fm.contentsOfDirectory(atPath: versionsBase) {
            for v in versions where !v.hasPrefix(".") {
                roots.append("\(versionsBase)/\(v)/home/.claude/projects/\(enc)/\(sessionId).jsonl")
            }
        }
        var newest: Double?
        for p in roots {
            if let attrs = try? fm.attributesOfItem(atPath: p),
               let m = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 {
                let ms = m * 1000
                if newest == nil || ms > newest! { newest = ms }
            }
        }
        return newest
    }

    // MARK: helpers
    static func pidAlive(_ pid: Int) -> Bool { kill(pid_t(pid), 0) == 0 || errno == EPERM }

    private static func col(_ stmt: OpaquePointer?, _ i: Int32) -> String? {
        guard let c = sqlite3_column_text(stmt, i) else { return nil }
        return String(cString: c)
    }

    private static func int(_ value: Any?) -> Int? {
        if let i = value as? Int { return i }
        if let n = value as? NSNumber { return n.intValue }
        if let s = value as? String { return Int(s) }
        return nil
    }

    private static func double(_ value: Any?) -> Double? {
        if let d = value as? Double { return d }
        if let n = value as? NSNumber { return n.doubleValue }
        if let s = value as? String { return Double(s) }
        return nil
    }

    private static func string(_ value: Any?) -> String? {
        value as? String
    }
}
