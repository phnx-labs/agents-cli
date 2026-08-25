import Foundation

// A small local ledger of tickets filed via the quick-issue bar (Cmd-Shift-O).
// The transient "Created RUSH-####" notification is easy to miss, so the menu
// bar also surfaces the recent ones (clickable → opens the ticket). Written by
// AgentsCLI.dispatchTicketAgent on a successful create; read by the RECENT
// TICKETS menu section.
struct RecentTicket: Codable {
    let id: String        // e.g. RUSH-1546
    let title: String     // the note the user typed
    let url: String?      // linear.app URL, when the agent emitted one
    let createdAt: String // ISO8601
}

enum RecentTickets {
    private static let maxKept = 10

    // ~/.agents/.history/menubar/recent-tickets.json — .history is durable and
    // gitignored (the same home the clip attachments use).
    private static var ledgerURL: URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".agents/.history/menubar/recent-tickets.json")
    }

    private static func readAll() -> [RecentTicket] {
        guard let data = try? Data(contentsOf: ledgerURL),
              let all = try? JSONDecoder().decode([RecentTicket].self, from: data) else { return [] }
        return all
    }

    /// Newest-first, capped at `limit`.
    static func load(limit: Int = 5) -> [RecentTicket] {
        Array(readAll().prefix(limit))
    }

    /// Pure merge: prepend the new ticket newest-first, drop any earlier entry
    /// with the same id (a re-file shouldn't stack), cap at `maxKept`. Split out
    /// so the dedup/cap/order is unit-testable without touching the ledger file.
    static func merged(_ existing: [RecentTicket], adding ticket: RecentTicket) -> [RecentTicket] {
        var all = existing.filter { $0.id != ticket.id }
        all.insert(ticket, at: 0)
        return Array(all.prefix(maxKept))
    }

    /// Prepend a freshly-created ticket and persist.
    static func record(id: String, title: String, url: String?, createdAt: String) {
        let all = merged(readAll(), adding: RecentTicket(id: id, title: title, url: url, createdAt: createdAt))
        try? FileManager.default.createDirectory(
            at: ledgerURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let out = try? JSONEncoder().encode(all) { try? out.write(to: ledgerURL) }
    }
}
