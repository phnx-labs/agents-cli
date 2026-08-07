import Foundation

// Shape of `agents routines list --json` (added in src/commands/routines.ts).
// Routines are secondary in the menu bar — fetched only when the menu opens.
//
// RUSH-2290 (routine reliability): `ready`/`readiness`/`failureCode`/
// `project`/`requestedCwd`/`resolvedCwd`/`skipReason`/`activeRunId` are all
// optional additions from the runtime-core track. Every one of them must
// decode as nil against a payload from an older installed CLI that predates
// them — the menu bar and the CLI release independently, so version skew
// between this helper and the on-PATH `agents` binary is routine, not an
// edge case. Do NOT make any of them non-optional.
struct Routine: Decodable {
    let name: String
    let agent: String?
    let workflow: String?
    let repo: String?
    // project membership decoded from CLI JSON; absent keys decode as nil for both fields.
    let projects: [String]?    // repos this routine belongs to
    let projectGroup: String?  // menu display grouping label; nil = cross-project / ungrouped
    let schedule: String
    let scheduleHuman: String?
    let enabled: Bool
    let overdue: Bool
    let nextRun: String?
    let nextRunHuman: String?
    // completed | failed | timeout | running | missed | blocked | skipped | null.
    // `blocked` / `skipped` are new outcomes (a readiness gate refused the run, or
    // the daemon deliberately skipped a duplicate/overlapping fire) — every switch
    // over this field must have a default arm rather than an exhaustive one.
    let lastStatus: String?
    let exitCode: Int?
    let failureReason: String?
    let lastRunStartedAt: String?
    let lastRunCompletedAt: String?

    // Explicit readiness verdict for the NEXT run, independent of how the last
    // one went. `nil` (an older CLI, or a routine the readiness check never
    // covers) must behave exactly like `true` — only an explicit `false` gates
    // Run/Resume in the UI.
    let ready: Bool?
    let readiness: RoutineReadiness?
    // A short machine code alongside `failureReason`'s free text (e.g. "auth_failed").
    let failureCode: String?
    // Execution target, for naming WHERE a failure/block happened.
    let project: String?
    let requestedCwd: String?
    let resolvedCwd: String?
    // Present when lastStatus == "skipped": why the daemon skipped this fire
    // (duplicate_slot | active_run | wrong_owner).
    let skipReason: String?
    // The run this one was skipped in favor of, when skipReason == "active_run".
    let activeRunId: String?
}

// `readiness` on `Routine`: why the daemon would refuse to start the next run
// right now. `code` is a stable machine token (e.g. "project_path_missing"),
// `message` is the human-readable reason, `repair` is an optional suggested fix.
struct RoutineReadiness: Decodable {
    let code: String
    let message: String
    let repair: String?
}

struct MenuAgent {
    let id: String
    let label: String
}

// One entry of `linear projects --json` (the linear skill CLI). Only the fields
// the quick-dispatch panel needs to name and scope a project are decoded.
struct LinearProject: Codable, Equatable {
    let id: String
    let name: String
}

// Shape of `linear tasks --json`: a scope envelope around the issue list.
struct LinearTasksResponse: Decodable {
    let count: Int
    let issues: [LinearTicket]
}

// One open Linear issue as the quick-dispatch panel shows it. `priority` is
// Linear's own scale — 1 urgent, 2 high, 3 medium, 4 low, 0 none (0 sorts last,
// see LinearTickets.rank). Cached to disk, so Codable both ways.
struct LinearTicket: Codable, Equatable {
    let identifier: String
    let title: String
    let priority: Int
    let state: LinearTicketState?
    let url: String?
    let dueDate: String?
    let createdAt: String?

    // "started" is Linear's state type for in-progress workflow states.
    var isStarted: Bool { state?.type == "started" }
    var stateName: String { state?.name ?? "" }
}

struct LinearTicketState: Codable, Equatable {
    let name: String
    let type: String
}

struct RecentSession: Decodable {
    let id: String?
    let shortId: String?
    let agent: String
    let timestamp: String?
    let project: String?
    let cwd: String?
    let filePath: String?
    let gitBranch: String?
    let topic: String?
    let version: String?
}

struct BrowserTask {
    let name: String
    let profile: String
    let tabCount: Int
    let createdAt: Double
    let pid: Int
}

struct DoctorOverview: Decodable {
    let clis: [String: DoctorCli]?
    let sync: [DoctorSync]?
    let orphans: [DoctorOrphan]?
}

struct DoctorCli: Decodable {
    let installed: Bool
    let path: String?
    let error: String?
}

struct DoctorSync: Decodable {
    let agent: String
    let version: String?
    let status: String
}

// `agents watchdog --json` tick result (RUSH-1415). The menu-bar reads the
// convenience counts; `didNudge` reflects whether this tick was allowed to inject.
struct WatchdogTick: Decodable {
    let didNudge: Bool
    let counts: WatchdogCounts
}

struct WatchdogCounts: Decodable {
    let total: Int
    let stalled: Int
    let nudged: Int
    let unaddressable: Int
    let skipped: Int
}

// One registered fleet device from `agents menubar snapshot --json` (sourced
// from the local device registry — no network probe). Live load% is merged in
// at render time from the daemon-warmed .fleet-stats.json (LocalState.deviceLoads);
// online/offline is deliberately NOT carried (the registry's tailscale flag is
// stale in both directions), so the menu never claims a status it can't back.
struct Device: Decodable {
    let name: String
    let platform: String
    let interactive: Bool
    let isLocal: Bool
}

// `agents menubar snapshot --json` — the single repeating CLI read owned by
// AGI Menu. Doctor remains a separate 15-minute diagnostic refresh.
struct MenubarSnapshot: Decodable {
    let version: Int
    let capturedAt: String
    let routines: [Routine]
    let recentSessions: [RecentSession]
    let activeSessions: [ActiveSession]
    // Optional so a snapshot from an older installed `agents` CLI (no devices
    // field) still decodes — version skew between the helper and the on-PATH CLI
    // is real (see the multi-install notes in apps/cli/CLAUDE.md).
    let devices: [Device]?
    let watchdog: MenubarWatchdogSnapshot
}

struct MenubarWatchdogSnapshot: Decodable {
    let enabled: Bool
    let lastTick: WatchdogTick?
}

struct DoctorOrphan: Decodable {
    let agent: String
    let version: String?
    let commands: Int?
    let skills: Int?
    let hooks: Int?
}

// One row of `agents sessions --active --local --json` — the session engine's
// authoritative live view (terminals, tmux, IDE, headless). Richer coverage than
// the cheap live-terminals.json file, which only carries extension-registered
// terminals; used to feed the ACTIVE section from a warm cache.
//
// Field names match the engine JSON (camelCase). Optional fields are omitted by
// some kinds of session (cloud vs tmux); decode must not require them.
struct ActiveSession: Decodable {
    let kind: String?
    let sessionId: String?
    let cwd: String?
    let status: String       // running | idle | queued | …
    let context: String?
    /// Host that owns the process (e.g. zion, yosemite-m0). Always present on a
    /// bare-active row (RUSH-2336): a process row without a known machine never
    /// clears the CLI's canonical `isRunningLiveSession` selector.
    let machine: String?
    /// Surface on that machine: tmux, codium, terminal, …
    let host: String?
    /// OS process id (terminal/tmux/headless/team rows only — absent for cloud).
    let pid: Int?
    /// Whether `pid` was POSITIVELY verified alive at scan time — never merely
    /// "not known dead". Absent for cloud rows and older-peer payloads.
    let pidAlive: Bool?
    /// Cloud provider (e.g. "rush") for a `context == "cloud"` row — no local pid.
    let cloudProvider: String?
    /// Cloud provider's own task id for a `context == "cloud"` row.
    let cloudTaskId: String?
    /// First-prompt / assigned task — best "what is it doing" signal.
    let topic: String?
    /// Latest-turn snippet (can be long; UI trims).
    let preview: String?
    let ticketId: String?
    let prLink: String?
    let startedAtMs: Double?
    let lastActivityMs: Double?
    let owner: String?
    let label: String?
    let origin: String?
    let routineName: String?
}
