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
    case attention   // blocked waiting for the user (Notification hook) or cloud needs_review
    case queued
}

struct Session {
    let agent: String
    let repo: String
    let cwd: String?
    let status: SessionStatus
    let context: String   // terminal | teams | cloud
    let detail: String
}

// A newly-discovered tailnet node awaiting the user's Register / Ignore.
struct PendingDevice {
    let name: String
    let platform: String
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
    private static func attentionSessionIds() -> Set<String> {
        let dir = "\(home)/.agents/.cache/state/attention"
        let names = (try? fm.contentsOfDirectory(atPath: dir)) ?? []
        return Set(names.filter { !$0.hasPrefix(".") })
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

    // MARK: All active sessions
    // includeTeams is false for the periodic badge poll — the teams/agents dir
    // accumulates ALL historical agents (can be thousands of meta.json files), so
    // scanning it every few seconds is too costly. Terminals + cloud + attention
    // are cheap. The full scan (with teams) runs only when the menu opens.
    static func sessions(includeTeams: Bool = true) -> [Session] {
        let attention = attentionSessionIds()
        var all = terminals(attention: attention) + cloud()
        if includeTeams { all += teams(attention: attention) }
        return all
    }

    // MARK: Terminals
    private static func terminals(attention: Set<String>) -> [Session] {
        let path = "\(home)/.agents/.cache/terminals/live-terminals.json"
        guard let data = fm.contents(atPath: path),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }

        var out: [Session] = []
        for (_, window) in root {
            guard let w = window as? [String: Any],
                  let entries = w["entries"] as? [[String: Any]] else { continue }
            for e in entries {
                guard let pid = e["pid"] as? Int, pidAlive(pid) else { continue }
                let kind = (e["kind"] as? String) ?? "session"
                let cwd = e["cwd"] as? String
                let label = e["label"] as? String
                let sid = (e["sessionId"] as? String) ?? ""
                let repo = label?.isEmpty == false ? label! : (cwd.map { ($0 as NSString).lastPathComponent } ?? "")
                let status = sessionStatus(sessionId: sid, kind: kind, cwd: cwd, attention: attention)
                out.append(Session(agent: kind, repo: repo, cwd: cwd, status: status, context: "terminal", detail: ""))
            }
        }
        return out
    }

    // MARK: Teams (filter to running + pid alive; the dir holds all history)
    private static func teams(attention: Set<String>) -> [Session] {
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
            let repo = cwd.map { ($0 as NSString).lastPathComponent } ?? ""
            out.append(Session(agent: agent, repo: repo, cwd: cwd,
                               status: .running, context: "teams", detail: task))
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
            let repo = col(stmt, 3) ?? (col(stmt, 4) ?? "cloud")
            let status: SessionStatus = raw == "running" ? .running
                : (raw == "input_required" || raw == "needs_review") ? .attention : .queued
            out.append(Session(agent: agent, repo: repo, cwd: nil,
                               status: status, context: "cloud", detail: String(prompt.prefix(40))))
        }
        return out
    }

    // MARK: Status for a local session
    // attention sentinel wins; else claude transcript mtime (cheap single stat);
    // else default running when alive (mirrors active.ts classifyActivity fallback).
    private static func sessionStatus(sessionId: String, kind: String, cwd: String?, attention: Set<String>) -> SessionStatus {
        if !sessionId.isEmpty, attention.contains(sessionId) { return .attention }
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
