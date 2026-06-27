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
