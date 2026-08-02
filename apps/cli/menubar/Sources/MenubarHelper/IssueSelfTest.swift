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
        testTicketCreateArgsAndParsing()
        testQuickFixContract()
        testQuickDispatchRoster()
        testRecentTicketsMerge()
        testDraftPreservation()
        testRoutineFailureReason()
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
    // forward for investigation, but must NOT tell the agent to run `linear create`
    // or to embed screenshot paths in the description — the helper owns both.
    private static func testPromptContract() {
        let oneShot = AgentsCLI.ticketAgentPrompt(note: "cards show raw uuids",
                                                  screenshotPaths: ["/tmp/clip one.png"])
        check("prompt embeds the note", oneShot.contains("cards show raw uuids"))
        check("prompt embeds the screenshot path", oneShot.contains("/tmp/clip one.png"))
        check("prompt asks for JSON output", oneShot.contains("JSON object"))
        check("prompt identifies user-provided ticket material",
              oneShot.contains("user-provided ticket material"))
        check("prompt forbids agent from running linear create",
              oneShot.contains("Do NOT run `linear create`"))
        check("prompt forbids screenshot paths in description",
              oneShot.contains("do NOT mention the screenshot paths here"))
        check("prompt does not make the agent run a proof upload",
              !oneShot.contains("--proof"))

        let multi = AgentsCLI.ticketAgentPrompt(note: "before/after",
                                                screenshotPaths: ["/tmp/a.png", "/tmp/b.png"])
        check("multi-shot prompt lists both paths",
              multi.contains("/tmp/a.png") && multi.contains("/tmp/b.png"))
        check("multi-shot prompt states the count", multi.contains("2 screenshots"))

        let noShot = AgentsCLI.ticketAgentPrompt(note: "flaky test", screenshotPaths: [])
        check("no-screenshot prompt says so", noShot.contains("No screenshots"))
        check("no-screenshot prompt has no /tmp path", !noShot.contains("/tmp/"))
        check("no-screenshot prompt has no upload command", !noShot.contains("--proof"))

        // RUSH-1636: the ticket agent must resolve a delegate and return it in JSON.
        let delegate = AgentsCLI.ticketAgentPrompt(note: "assign a delegate", screenshotPaths: ["/tmp/a.png"])
        check("prompt instructs delegate resolution", delegate.contains("agents sessions --active"))
        check("prompt lists the workspace delegate roster",
              delegate.contains("Antigravity") && delegate.contains("OpenClaw"))
        check("prompt returns delegate as JSON key", delegate.contains("\"delegate\""))
        check("prompt defaults to claude when inconclusive", delegate.contains("default to `claude`"))
    }

    // The helper parses the agent's JSON draft, builds `linear create` argv with
    // every selected screenshot as its own `--image` arg, and parses the created
    // ticket back from `linear create` stdout.
    private static func testTicketCreateArgsAndParsing() {
        let draft = TicketDraft(title: "Cards show raw uuids",
                                description: "The cards render raw uuids.",
                                priority: "high",
                                project: "Agents CLI",
                                label: "repo:agents-cli",
                                delegate: "claude")
        let args = AgentsCLI.ticketCreateArgs(
            draft: draft,
            screenshotPaths: ["/tmp/clip one.png", "/tmp/Muqsit's shot.png"]
        )
        let linear = AgentsCLI.linearSkillBinary()
        let expected = [
            linear, "create", "Cards show raw uuids",
            "--priority", "high",
            "--project", "Agents CLI",
            "--label", "repo:agents-cli",
            "--description-file", "-",
            "--delegate", "claude",
            "--image", "/tmp/clip one.png",
            "--image", "/tmp/Muqsit's shot.png",
        ]
        check("create argv includes every selected screenshot as --image",
              args == expected,
              detail: args.joined(separator: " "))

        let noDelegate = TicketDraft(title: "T", description: "D", priority: "low",
                                     project: "P", label: "repo:x", delegate: nil)
        let noDelegateArgs = AgentsCLI.ticketCreateArgs(draft: noDelegate, screenshotPaths: [])
        check("nil delegate omits --delegate",
              !noDelegateArgs.contains("--delegate"),
              detail: noDelegateArgs.joined(separator: " "))

        let json = """
        Some reasoning here.
        {"title": "Fix it", "description": "Broken", "priority": "medium", "project": "P", "label": "repo:x", "delegate": null}
        """
        let parsed = AgentsCLI.parseTicketDraft(json)
        check("parseTicketDraft extracts JSON from surrounding text", parsed?.title == "Fix it")
        check("parseTicketDraft preserves null delegate", parsed?.delegate == nil)

        let createOutput = """
        Created RUSH-200: Cards show raw uuids
        URL: https://linear.app/getrush/issue/RUSH-200/cards-show-raw-uuids
        """
        let completion = AgentsCLI.ticketCompletion(output: createOutput)
        check("ticket completion parses the created id", completion?.id == "RUSH-200")
        check("ticket completion preserves the Linear URL",
              completion?.url == "https://linear.app/getrush/issue/RUSH-200/cards-show-raw-uuids")
        check("no created id yields no completion",
              AgentsCLI.ticketCompletion(output: "ticket create failed") == nil)
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

        let name = AgentsCLI.quickDispatchName(note: "Fix the broken login button", date: Date(timeIntervalSince1970: 1234))
        check("dispatch name is a slug of the user's task", name == "fix-the-broken-login-button", detail: name)
        let emptyName = AgentsCLI.quickDispatchName(note: "   ", date: Date(timeIntervalSince1970: 1234))
        check("empty note falls back to a timestamped task name", emptyName == "task-1234", detail: emptyName)

        let args = AgentsCLI.quickFixRunArgs(agent: "codex", prompt: "<prompt>", name: "my-task")
        check("run is balanced + autonomous",
              args == ["run", "codex", "<prompt>", "--mode", "auto", "--balanced", "--name", "my-task"],
              detail: args.joined(separator: " "))
        let scoped = AgentsCLI.quickFixRunArgs(agent: "codex", prompt: "<p>", name: "n", cwd: "/repo", device: "zion")
        check("run scopes to cwd + device when given",
              scoped == ["run", "codex", "<p>", "--mode", "auto", "--balanced", "--name", "n", "--cwd", "/repo", "--device", "zion"],
              detail: scoped.joined(separator: " "))
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

    // Overdue is a current scheduler condition, not proof that the previous run
    // failed. A last-successful routine with exitCode 0 must render as overdue,
    // not "exit 0", across summary, submenu header, and all-routines rows.
    private static func testRoutineFailureReason() {
        let succeededButOverdue = routine(
            lastStatus: "completed",
            exitCode: 0,
            failureReason: nil,
            overdue: true
        )
        check("overdue successful routine summary says overdue",
              routineFailureSummary(succeededButOverdue, max: 48) == "overdue",
              detail: routineFailureSummary(succeededButOverdue, max: 48))
        check("overdue successful routine detail says overdue",
              routineFailureDetail(succeededButOverdue, max: 72) == "overdue",
              detail: routineFailureDetail(succeededButOverdue, max: 72) ?? "nil")
        check("overdue successful routine all-row detail says overdue",
              routineFailureDetail(succeededButOverdue, max: 52) == "overdue",
              detail: routineFailureDetail(succeededButOverdue, max: 52) ?? "nil")

        let failed = routine(
            lastStatus: "failed",
            exitCode: 2,
            failureReason: nil,
            overdue: false
        )
        check("failed routine still falls back to exit code",
              routineFailureDetail(failed, max: 72) == "exit 2",
              detail: routineFailureDetail(failed, max: 72) ?? "nil")
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

    private static func routine(
        lastStatus: String?,
        exitCode: Int?,
        failureReason: String?,
        overdue: Bool
    ) -> Routine {
        Routine(
            name: "nightly",
            agent: "claude",
            workflow: nil,
            repo: nil,
            schedule: "0 3 * * *",
            scheduleHuman: nil,
            enabled: true,
            overdue: overdue,
            nextRun: nil,
            nextRunHuman: "tomorrow",
            lastStatus: lastStatus,
            exitCode: exitCode,
            failureReason: failureReason,
            lastRunStartedAt: "2026-07-20T03:00:00.000Z",
            lastRunCompletedAt: "2026-07-20T03:00:05.000Z"
        )
    }
}
