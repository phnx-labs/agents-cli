import Foundation

// Self-test for the quick-issue capture logic (Cmd-Shift-O). Follows the repo's
// env-gated self-test idiom (see Bench.swift / MENUBAR_CLIP_TEST): no XCTest
// target exists for the menu-bar helper. Exercises the real code paths — newest
// clip selection over a fixture dir, ticket-id parsing, and the prompt contract
// — then exits nonzero on any failure so CI/a caller can gate on it.
//
//   MENUBAR_ISSUE_TEST=1 MenubarHelper
enum IssueSelfTest {
    private static var failures = 0

    static func run() -> Never {
        print("menubar issue-capture self-test")
        testNewestFilePick()
        testTicketIDParse()
        testPromptContract()
        if failures == 0 {
            print("\nALL PASS")
            exit(0)
        }
        print("\n\(failures) FAILED")
        exit(1)
    }

    // newestRegularFile must return the most-recently-modified regular file and
    // skip `.json` sidecars (a screenshot's own path must win over its sidecar).
    private static func testNewestFilePick() {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("menubar-issue-test-\(ProcessInfo.processInfo.processIdentifier)",
                                    isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // older.png (t-100), newest.png (t-10), newest.png.json (t-1 — must be ignored).
        write(dir, "older.png", modified: -100)
        write(dir, "newest.png", modified: -10)
        write(dir, "newest.png.json", modified: -1)

        let got = AgentsCLI.newestRegularFile(in: dir)
        check("newest regular file is newest.png",
              (got as NSString?)?.lastPathComponent == "newest.png",
              detail: got ?? "nil")

        // Empty dir → nil, no crash.
        let empty = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("menubar-issue-empty-\(ProcessInfo.processInfo.processIdentifier)",
                                    isDirectory: true)
        try? FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: empty) }
        check("empty dir yields nil", AgentsCLI.newestRegularFile(in: empty) == nil)
    }

    // parseCreatedTicketID pulls the identifier from the linear CLI success line,
    // prefers the `Created <ID>:` form, and returns nil when there is no ticket.
    private static func testTicketIDParse() {
        check("parses Created RUSH line",
              AgentsCLI.parseCreatedTicketID("Created RUSH-1532: Fix the thing") == "RUSH-1532")
        check("parses id from a noisy multi-line tail",
              AgentsCLI.parseCreatedTicketID("thinking...\nCreated ENG-42: Add retry [proj | me]\n") == "ENG-42")
        check("no ticket → nil", AgentsCLI.parseCreatedTicketID("could not create the issue") == nil)
    }

    // The meta-prompt must carry the user's note and the screenshot path forward
    // to the agent, and drop the screenshot line when there is none.
    private static func testPromptContract() {
        let oneShot = AgentsCLI.ticketAgentPrompt(note: "cards show raw uuids",
                                                  screenshotPaths: ["/tmp/clip-1.png"])
        check("prompt embeds the note", oneShot.contains("cards show raw uuids"))
        check("prompt embeds the screenshot path", oneShot.contains("/tmp/clip-1.png"))
        check("prompt names the linear create step", oneShot.contains("linear create"))

        let multi = AgentsCLI.ticketAgentPrompt(note: "before/after",
                                                screenshotPaths: ["/tmp/a.png", "/tmp/b.png"])
        check("multi-shot prompt lists both paths",
              multi.contains("/tmp/a.png") && multi.contains("/tmp/b.png"))
        check("multi-shot prompt states the count", multi.contains("2 screenshots"))

        let noShot = AgentsCLI.ticketAgentPrompt(note: "flaky test", screenshotPaths: [])
        check("no-screenshot prompt says so", noShot.contains("No screenshots"))
        check("no-screenshot prompt has no /tmp path", !noShot.contains("/tmp/"))
    }

    // MARK: helpers

    private static func write(_ dir: URL, _ name: String, modified offset: TimeInterval) {
        let url = dir.appendingPathComponent(name)
        try? Data("x".utf8).write(to: url)
        try? FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(offset)], ofItemAtPath: url.path)
    }

    private static func check(_ name: String, _ ok: Bool, detail: String? = nil) {
        if ok {
            print("  PASS  \(name)")
        } else {
            failures += 1
            print("  FAIL  \(name)" + (detail.map { "  (got: \($0))" } ?? ""))
        }
    }
}
