import Foundation

// Shape of `agents routines list --json` (added in src/commands/routines.ts).
// Routines are secondary in the menu bar — fetched only when the menu opens.
struct Routine: Decodable {
    let name: String
    let agent: String?
    let workflow: String?
    let repo: String?
    let schedule: String
    let scheduleHuman: String?
    let enabled: Bool
    let overdue: Bool
    let nextRun: String?
    let nextRunHuman: String?
    let lastStatus: String?            // completed | failed | timeout | running | null
    let lastRunStartedAt: String?
    let lastRunCompletedAt: String?
}

struct MenuAgent {
    let id: String
    let label: String
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

struct DoctorOrphan: Decodable {
    let agent: String
    let version: String?
    let commands: Int?
    let skills: Int?
    let hooks: Int?
}
