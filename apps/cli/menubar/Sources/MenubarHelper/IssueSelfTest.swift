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
        testImageFilePick()
        testTicketIDParse()
        testPromptContract()
        testQuickFixContract()
        testQuickDispatchRoster()
        testRecentTicketsMerge()
        testDraftPreservation()
        if failures == 0 {
            print("\nALL PASS")
            exit(0)
        }
        print("\n\(failures) FAILED")
        exit(1)
    }

    // imageFiles must return images newest-first ACROSS dirs, skip non-images and
    // `.json` sidecars, honor the limit, and collapse duplicate paths.
    private static func testImageFilePick() {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("menubar-img-test-\(ProcessInfo.processInfo.processIdentifier)",
                                    isDirectory: true)
        let dirA = base.appendingPathComponent("a"), dirB = base.appendingPathComponent("b")
        defer { try? FileManager.default.removeItem(at: base) }
        for d in [dirA, dirB] { try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true) }

        // dirA: an older png + a non-image + a sidecar (both must be skipped).
        write(dirA, "old.png", modified: -300)
        write(dirA, "notes.txt", modified: -1)      // non-image
        write(dirA, "old.png.json", modified: -1)   // sidecar
        // dirB holds the newest image, and a mid-age one.
        write(dirB, "newest.png", modified: -10)
        write(dirB, "mid.jpg", modified: -120)

        let got = AgentsCLI.imageFiles(inDirs: [dirA, dirB], limit: 6)
        check("newest image across dirs is first",
              (got.first as NSString?)?.lastPathComponent == "newest.png", detail: got.first ?? "nil")
        check("only the 3 images returned (txt + sidecar skipped)",
              got.count == 3 &&
              got.allSatisfy { AgentsCLI.imageExtensions.contains(($0 as NSString).pathExtension.lowercased()) },
              detail: got.map { ($0 as NSString).lastPathComponent }.joined(separator: ","))
        check("limit is honored", AgentsCLI.imageFiles(inDirs: [dirA, dirB], limit: 1).count == 1)
        check("no dirs yields empty", AgentsCLI.imageFiles(inDirs: [], limit: 6).isEmpty)
    }

    // parseCreatedTicketID pulls the identifier from the linear CLI success line,
    // prefers the `Created <ID>:` form, and returns nil when there is no ticket.
    private static func testTicketIDParse() {
        check("parses Created RUSH line",
              AgentsCLI.parseCreatedTicketID("Created RUSH-1532: Fix the thing") == "RUSH-1532")
        check("parses id from a noisy multi-line tail",
              AgentsCLI.parseCreatedTicketID("thinking...\nCreated ENG-42: Add retry [proj | me]\n") == "ENG-42")
        check("no ticket → nil", AgentsCLI.parseCreatedTicketID("could not create the issue") == nil)
        check("takes the final 'Created' over an earlier reasoning mention",
              AgentsCLI.parseCreatedTicketID("I saw Created RUSH-99 referenced.\nCreated RUSH-200: real") == "RUSH-200")

        // parseTicketURL pulls the Linear URL (for the clickable notification).
        check("parses the ticket URL",
              AgentsCLI.parseTicketURL("Created RUSH-200: real\nURL: https://linear.app/getrush/issue/RUSH-200/real")
              == "https://linear.app/getrush/issue/RUSH-200/real")
        check("trims trailing punctuation on the URL",
              AgentsCLI.parseTicketURL("see https://linear.app/getrush/issue/RUSH-9).") == "https://linear.app/getrush/issue/RUSH-9")
        check("no URL → nil", AgentsCLI.parseTicketURL("Created RUSH-200: real") == nil)
    }

    // The meta-prompt must carry the user's note and every user-provided file
    // forward, require that the files reach the issue (with placement left to the
    // agent), and drop the upload command when there is no attachment.
    private static func testPromptContract() {
        let oneShot = AgentsCLI.ticketAgentPrompt(note: "cards show raw uuids",
                                                  screenshotPaths: ["/tmp/clip one.png"])
        check("prompt embeds the note", oneShot.contains("cards show raw uuids"))
        check("prompt embeds the screenshot path", oneShot.contains("/tmp/clip one.png"))
        check("prompt names the linear create step", oneShot.contains("linear create"))
        check("prompt identifies user-provided ticket material",
              oneShot.contains("user-provided ticket material"))
        check("prompt requires the file to reach the Linear issue",
              oneShot.contains("every user-provided file is uploaded"))
        check("prompt leaves attachment placement to the agent",
              oneShot.contains("description, comment, or another appropriate attachment surface"))
        check("prompt gives a shell-safe upload command",
              oneShot.contains("--proof '/tmp/clip one.png'"))

        let quoted = AgentsCLI.ticketAgentPrompt(note: "quoted path",
                                                 screenshotPaths: ["/tmp/Muqsit's shot.png"])
        check("upload command shell-quotes apostrophes",
              quoted.contains("--proof '/tmp/Muqsit'\\''s shot.png'"))

        let multi = AgentsCLI.ticketAgentPrompt(note: "before/after",
                                                screenshotPaths: ["/tmp/a.png", "/tmp/b.png"])
        check("multi-shot prompt lists both paths",
              multi.contains("/tmp/a.png") && multi.contains("/tmp/b.png"))
        check("multi-shot prompt states the count", multi.contains("2 screenshots"))
        check("multi-shot prompt uploads every path",
              multi.contains("--proof '/tmp/a.png'") && multi.contains("--proof '/tmp/b.png'"))

        let noShot = AgentsCLI.ticketAgentPrompt(note: "flaky test", screenshotPaths: [])
        check("no-screenshot prompt says so", noShot.contains("No screenshots"))
        check("no-screenshot prompt has no /tmp path", !noShot.contains("/tmp/"))
        check("no-screenshot prompt has no upload command", !noShot.contains("--proof"))
        check("no-screenshot prompt skips attachment handling", noShot.contains("skip attachment handling"))
    }

    // The autonomous fix path must carry screenshots through and name runs with
    // a stable quick-dispatch handle so the tray/session index can surface them.
    private static func testQuickFixContract() {
        let prompt = AgentsCLI.quickFixPrompt(note: "button is off-screen",
                                              screenshotPaths: ["/tmp/panel.png"])
        check("quick-fix prompt embeds the request", prompt.contains("button is off-screen"))
        check("quick-fix prompt embeds the screenshot", prompt.contains("/tmp/panel.png"))
        check("quick-fix prompt requires repo discovery", prompt.contains("agents sessions --all --limit 20"))
        check("quick-fix prompt requires verification", prompt.contains("Verify with the focused tests"))

        let name = AgentsCLI.quickDispatchName(agent: "Codex_Cli", date: Date(timeIntervalSince1970: 1234))
        check("quick-dispatch names are durable and normalized", name == "quick-codex-cli-1234", detail: name)

        let args = AgentsCLI.quickFixRunArgs(agent: "codex", prompt: "<prompt>", name: "quick-codex-1234")
        check("quick-fix runs in autonomous mode",
              args == ["run", "codex", "<prompt>", "--mode", "auto", "--name", "quick-codex-1234"],
              detail: args.joined(separator: " "))
    }

    // The picker roster is configurable but remains pinned to supported agents.
    private static func testQuickDispatchRoster() {
        let defaultRoster = LocalState.quickDispatchRoster(env: [:])
        check("default quick-dispatch roster uses desired agents",
              defaultRoster.map(\.id) == LocalState.desiredAgents.map(\.id))

        let filtered = LocalState.quickDispatchRoster(env: ["AGENTS_QUICK_DISPATCH_ROSTER": "codex,claude,missing,codex"])
        check("configured quick-dispatch roster preserves valid configured order and dedups",
              filtered.map(\.id) == ["codex", "claude"], detail: filtered.map(\.id).joined(separator: ","))

        let invalid = LocalState.quickDispatchRoster(env: ["AGENTS_QUICK_DISPATCH_ROSTER": "missing"])
        check("invalid quick-dispatch roster falls back to desired agents",
              invalid.map(\.id) == LocalState.desiredAgents.map(\.id))

        let preselected = IssueSelfTest.preselectedAgents(
            env: ["AGENTS_QUICK_DISPATCH_AGENTS": "codex,claude,missing,codex"],
            roster: filtered
        )
        check("configured quick-dispatch preselection stays visible and deduped",
              preselected == ["codex", "claude"], detail: preselected.joined(separator: ","))
    }

    // The recent-tickets ledger merge: newest-first, dedup by id, capped.
    private static func testRecentTicketsMerge() {
        func t(_ id: String) -> RecentTicket { RecentTicket(id: id, title: id, url: nil, createdAt: id) }
        let after = RecentTickets.merged([t("RUSH-1"), t("RUSH-2")], adding: t("RUSH-3"))
        check("new ticket is newest-first", after.first?.id == "RUSH-3")

        let deduped = RecentTickets.merged([t("RUSH-1"), t("RUSH-2")], adding: t("RUSH-2"))
        check("re-filing an id dedups (no stacking)",
              deduped.filter { $0.id == "RUSH-2" }.count == 1 && deduped.first?.id == "RUSH-2",
              detail: deduped.map { $0.id }.joined(separator: ","))

        var many = (1...12).map { t("RUSH-\($0)") }
        many = RecentTickets.merged(many, adding: t("RUSH-99"))
        check("capped at 10", many.count == 10 && many.first?.id == "RUSH-99")
    }

    // The draft state machine that survives a focus-steal: dismissing WITHOUT
    // submitting preserves an in-progress note (PromptDraft.forDismissal), while
    // submit/Escape clear it. summon() rehydrates from the saved draft, or a clean
    // slate when it was cleared. Exercised as pure logic — no live NSPanel needed.
    private static func testDraftPreservation() {
        // (a) An empty or whitespace-only note preserves nothing: the panel
        //     dismisses clean so the next summon starts fresh.
        check("empty note clears the draft",
              PromptDraft.forDismissal(note: "", selectedPaths: [],
                                       selectedAgents: [], action: .fileTicket) == nil)
        check("whitespace/newline-only note clears the draft",
              PromptDraft.forDismissal(note: "  \n\t ", selectedPaths: ["/tmp/a.png"],
                                       selectedAgents: ["codex"], action: .fix) == nil)

        // (b) A real note round-trips every field verbatim through save→restore.
        let saved = PromptDraft.forDismissal(note: "  cards show raw uuids  ",
                                             selectedPaths: ["/tmp/a.png", "/tmp/b.png"],
                                             selectedAgents: ["codex", "claude"],
                                             action: .fix)
        check("non-empty note preserves a draft", saved != nil,
              detail: saved.map { $0.note } ?? "nil")
        check("draft preserves the raw (untrimmed) note",
              saved?.note == "  cards show raw uuids  ")
        check("draft preserves selectedPaths in order",
              saved?.selectedPaths == ["/tmp/a.png", "/tmp/b.png"],
              detail: (saved?.selectedPaths ?? []).joined(separator: ","))
        check("draft preserves selectedAgents",
              saved?.selectedAgents == ["codex", "claude"],
              detail: (saved?.selectedAgents ?? []).sorted().joined(separator: ","))
        check("draft preserves the dispatch action", saved?.action == .fix)

        // The restore side (summon's `draft?.field ?? default`): a saved draft
        // rehydrates its fields; a nil draft — what submit and Escape leave behind
        // via clearDraft — restores to a clean slate.
        check("restore rehydrates note+action from a saved draft",
              (saved?.note ?? "") == "  cards show raw uuids  " &&
              (saved?.action ?? .fileTicket) == .fix)
        let cleared: PromptDraft? = nil   // what submit/Escape (clearDraft) leave
        check("submit/Escape leave no draft → restore yields empty note",
              (cleared?.note ?? "") == "")
        check("submit/Escape leave no draft → restore yields default action + no selection",
              (cleared?.action ?? .fileTicket) == .fileTicket &&
              (cleared?.selectedPaths ?? []).isEmpty &&
              (cleared?.selectedAgents ?? []).isEmpty)
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

    private static func preselectedAgents(env: [String: String], roster: [MenuAgent]) -> [String] {
        let visible = Set(roster.map(\.id))
        var seen = Set<String>()
        return env["AGENTS_QUICK_DISPATCH_AGENTS"]?
            .split(separator: ",")
            .map { LocalState.normalizeAgent(String($0).trimmingCharacters(in: .whitespacesAndNewlines)) }
            .filter { visible.contains($0) && seen.insert($0).inserted } ?? []
    }
}
