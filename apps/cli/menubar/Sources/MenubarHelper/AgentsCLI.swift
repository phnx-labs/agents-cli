import Foundation

struct TicketDraft: Codable {
    let title: String
    let description: String
    let priority: String
    let project: String
    let label: String
    let delegate: String?
}

struct TicketCompletion {
    let id: String
    let url: String?
}

// Thin bridge to the `agents` CLI. The helper never owns state or reimplements
// scheduling — it shells the CLI for data and actions. TS stays the source of
// truth (see CLAUDE.md: "Swift reads, TS owns truth").
enum AgentsCLI {
    static let home = NSHomeDirectory()

    private static let env = ProcessInfo.processInfo.environment

    // Resolve the `agents` binary. A GUI/launchd process inherits no user PATH,
    // so probe explicit locations. Env override wins for dev builds.
    static let binary: String = {
        if let b = env["AGENTS_BIN"], !b.isEmpty,
           FileManager.default.isExecutableFile(atPath: b) {
            return b
        }
        let candidates = [
            "\(home)/.local/bin/agents",
            "/opt/homebrew/bin/agents",
            "/usr/local/bin/agents",
            "\(home)/.npm-global/bin/agents",
        ]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            return c
        }
        return "agents" // last resort; relies on PATH if somehow set
    }()

    // The `agents` bin is a `#!/usr/bin/env -S node` script, but a launchd/GUI
    // process has a minimal PATH so `env` can't find node. The daemon (a node
    // process) passes its own interpreter + entry point so we exec node
    // directly and never depend on PATH. Falls back to the shebang bin.
    private static func argv(_ args: [String]) -> [String] {
        if let node = env["AGENTS_NODE"], let entry = env["AGENTS_ENTRY"],
           FileManager.default.isExecutableFile(atPath: node),
           FileManager.default.fileExists(atPath: entry) {
            return [node, entry] + args
        }
        return [binary] + args
    }

    // MARK: Daemon liveness — read the scheduler PID file + signal 0.
    // Path from src/lib/daemon.ts:24 + src/lib/state.ts (helpers/daemon).
    static func daemonPid() -> Int? {
        let path = "\(home)/.agents/.cache/helpers/daemon/daemon.pid"
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        guard let pid = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return kill(pid_t(pid), 0) == 0 ? pid : nil
    }

    static func daemonLiveness() -> DaemonLiveness {
        let pid = daemonPid()
        let path = "\(home)/.agents/.cache/helpers/daemon/heartbeat.json"
        let heartbeat = FileManager.default.contents(atPath: path)
        return DaemonLiveness.classify(pid: pid, heartbeatData: heartbeat)
    }

    // Routines are secondary and fetched only when the menu opens. This shells
    // the CLI, but `routines list` does NOT trigger the sessions re-index — it
    // only computes cron next-run, which is cheap. Session data never comes from
    // here; it's read directly from disk by LocalState.
    static func routines() -> [Routine] {
        guard let data = capture(argv(["routines", "list", "--json"])) else { return [] }
        return (try? JSONDecoder().decode([Routine].self, from: data)) ?? []
    }

    static func menubarSnapshot() -> MenubarSnapshot? {
        guard let data = capture(argv(["menubar", "snapshot", "--json"])) else { return nil }
        return try? JSONDecoder().decode(MenubarSnapshot.self, from: data)
    }

    // The heaviest call the helper makes: `doctor --json` probes every installed
    // version of every harness with its own subprocess. Seconds on a healthy box,
    // so it gets the longest deadline — but it does get one. An unbounded doctor
    // is what consumed 13 of 18 cores on a real machine.
    //
    // Deliberately NOT `--devices`: the fleet fan-out measured 265s on mac-mini
    // (2026-08-07, warm cache) against this poll's 180s deadline — every refresh
    // would be group-killed mid-flight and the System row would read
    // "unavailable" forever. The bare overview is already the fleet-aware
    // payload (RUSH-2027 `fleet` inventory) and carries the prioritized
    // `findings` (RUSH-2069) this helper renders, at 83s warm on the same box —
    // inside the bound. It is also singleflight-gated CLI-side (RUSH-2153): the
    // 90s freshness TTL means this 15-minute poll nearly always computes fresh,
    // but a helper relaunch or a second poller can never stack a concurrent
    // compute. The fleet-wide readout stays one click away via "Run agents
    // doctor".
    //
    // The argv is a pure builder (mirrors routineHistoryArgs) so the headless
    // self-test can pin the exact request — this poll is the only reader of the
    // findings contract, and a silent flag drift would break it.
    static func doctorOverviewArgs() -> [String] { ["doctor", "--json"] }

    static func doctorOverview() -> DoctorOverview? {
        guard let data = capture(argv(doctorOverviewArgs()), timeout: ChildProcess.doctorTimeout) else { return nil }
        return try? JSONDecoder().decode(DoctorOverview.self, from: data)
    }

    static func watchdogSetEnabled(_ on: Bool) {
        runDetached(argv(["watchdog", on ? "enable" : "disable"]))
    }

    // MARK: Actions
    // New interactive session: hand `agents run <agent>` to a real terminal.
    // A status-bar click can't host a TUI, so the run has to open elsewhere —
    // but WHICH terminal is the CLI's call, not ours. `--terminal` resolves it
    // from the user's own live sessions (lib/terminal/preferred.ts), so a
    // Ghostty user gets Ghostty and an iTerm user gets iTerm. This used to
    // hardcode AppleScript at Terminal.app and dumped everyone there.
    //
    // `--cwd home` is explicit on purpose: launchd starts this helper with no
    // WorkingDirectory (so cwd is `/`), and a child would inherit it. The old
    // AppleScript path opened a login shell in the home directory, so passing it
    // keeps New Session landing exactly where it always did instead of `/`.
    //
    // MONITORED, not detached: the CLI exits non-zero when it could not open a
    // terminal, and a detached spawn throws that away — so a failed click and a
    // slow one look identical (detection takes a couple of seconds), and the user
    // clicks again. On failure we surface the CLI's own stderr line; success stays
    // silent, because the new terminal window IS the feedback.
    static func newSession(agent: String) {
        runMonitored(argv(["run", agent, "--terminal", "--cwd", home]), captureStderr: true) { output, ok in
            guard !ok else { return }
            let detail = output
                .split(separator: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .last { !$0.isEmpty }
            Notifier.post(title: "Could not open \(agent)",
                          body: detail ?? "The terminal launch failed. Try `agents run \(agent) --terminal` in a shell.",
                          agent: agent)
        }
    }

    static func routineRun(_ name: String) { runDetached(argv(["routines", "run", name])) }
    static func routinePause(_ name: String) { runDetached(argv(["routines", "pause", name])) }
    static func routineResume(_ name: String) { runDetached(argv(["routines", "resume", name])) }
    static func routineLogs(_ name: String) {
        runMonitored(argv(["routines", "logs", name])) { text, ok in
            let safeName = name.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "-", options: .regularExpression)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("agents-routine-\(safeName)-logs.txt")
            let body = ok ? text : (text.isEmpty ? "Unable to load logs for routine '\(name)'.\n" : text)
            try? body.write(to: url, atomically: true, encoding: .utf8)
            runDetached(["/usr/bin/open", url.path])
        }
    }

    // The CLI verb behind the routine submenu's "History…" (`agents routines
    // runs <name>`): run ids, outcomes, and start times for the last runs of
    // one routine — read-only, distinct from `logs` (raw process output of the
    // most recent fire). A pure argv builder so it's testable without spawning.
    static func routineHistoryArgs(_ name: String) -> [String] { ["routines", "runs", name] }

    static func routineHistory(_ name: String) {
        runMonitored(argv(routineHistoryArgs(name))) { text, ok in
            let safeName = name.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "-", options: .regularExpression)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("agents-routine-\(safeName)-history.txt")
            let body = ok ? text : (text.isEmpty ? "Unable to load history for routine '\(name)'.\n" : text)
            try? body.write(to: url, atomically: true, encoding: .utf8)
            runDetached(["/usr/bin/open", url.path])
        }
    }

    static func openPath(_ path: String) { runDetached(["/usr/bin/open", path]) }

    static func startScheduler() { runDetached(argv(["routines", "start"])) }
    static func stopDaemon() { runDetached(argv(["routines", "stop"])) }
    static func restartDaemon() { runDetached(argv(["daemon", "restart"])) }

    // NEW DEVICES actions. `register` adds the pending node to the registry;
    // `ignore` dismisses it for good. Both clear the pending sentinel CLI-side,
    // so the badge/section updates on the next 10s poll. TS owns the truth.
    static func deviceRegister(_ name: String) { runDetached(argv(["devices", "register", name])) }
    static func deviceIgnore(_ name: String) { runDetached(argv(["devices", "ignore", name])) }

    /// Take the operator to a blocked session: attach its terminal, or open a new
    /// tab and resume it (`agents focus` decides, and handles a remote host).
    ///
    /// Detached on purpose. `focus` opens a Terminal/tmux surface and can block on
    /// an attach; the menu bar must never wait on that, and there is nothing to
    /// report back — the operator sees the session appear.
    static func focusSession(_ sessionId: String) {
        runDetached(argv(["focus", sessionId]))
    }

    // Surface CLI health in a terminal — `agents doctor` is interactive output.
    // Plain `doctor`, matching the poll's scope (see doctorOverviewArgs): the
    // `--devices` fan-out costs minutes and belongs to an explicit terminal run,
    // which the operator can widen themselves.
    static func runDoctor() {
        let cmd = "\(shellQuote(binary)) doctor"
        let script = "tell application \"Terminal\"\nactivate\ndo script \"\(cmd)\"\nend tell"
        runDetached(["/usr/bin/osascript", "-e", script])
    }

    // "Quit menu bar" disables the launchd agent so it doesn't relaunch on the
    // KeepAlive policy, then the app terminates.
    static func menubarDisable() { runDetached(argv(["menubar", "disable"])) }

    // MARK: Quick dispatch capture (Cmd-Shift-O)

    // Image extensions the clip hotkey / screenshot tools produce.
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "heic", "tiff", "webp", "bmp"]

    // Where the user's recent screenshots ACTUALLY live. A shot taken with the
    // system tool or CleanShot does not land in the clip attachments dir (that
    // only fills on Cmd-Shift-V), so the panel must look where screenshots are
    // really saved or a shot the user just took won't appear:
    //   • the system screencapture location (`com.apple.screencapture location`,
    //     unset => ~/Desktop),
    //   • CleanShot X's export path (`pl.maketheweb.cleanshotx exportPath`),
    //   • the clip attachments dir (Cmd-Shift-V history).
    // Deduped, existing directories only.
    static func screenshotSourceDirs() -> [URL] {
        var raw: [String] = []
        let sys = UserDefaults(suiteName: "com.apple.screencapture")?.string(forKey: "location")
        raw.append((sys?.isEmpty == false) ? sys! : "~/Desktop")
        if let cs = UserDefaults(suiteName: "pl.maketheweb.cleanshotx")?.string(forKey: "exportPath"),
           !cs.isEmpty {
            raw.append(cs)
        }
        var urls = raw.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
        urls.append(Clip.attachmentsDir)
        var seen = Set<String>()
        return urls.filter { url in
            let p = url.standardizedFileURL.path
            guard seen.insert(p).inserted else { return false }
            var isDir: ObjCBool = false
            return FileManager.default.fileExists(atPath: p, isDirectory: &isDir) && isDir.boolValue
        }
    }

    // The most-recent screenshots (newest first) for the panel's thumbnail strip
    // — the "recent screenshots" the user attaches from, across every source dir.
    static func recentImageAttachments(limit: Int = 6) -> [String] {
        imageFiles(inDirs: screenshotSourceDirs(), limit: limit)
    }

    // Pure newest-first image selection across directories; non-images and JSON
    // sidecars are excluded, duplicate paths collapsed. Split out so it can be
    // driven over fixture dirs in the MENUBAR_ISSUE_TEST self-test.
    static func imageFiles(inDirs dirs: [URL], limit: Int) -> [String] {
        let keys: [URLResourceKey] = [.contentModificationDateKey, .isRegularFileKey]
        var found: [(path: String, mtime: Date)] = []
        var seen = Set<String>()
        for dir in dirs {
            guard let entries = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { continue }
            for url in entries {
                guard imageExtensions.contains(url.pathExtension.lowercased()),
                      (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile ?? false,
                      let d = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                          .contentModificationDate else { continue }
                let p = url.standardizedFileURL.path
                if seen.insert(p).inserted { found.append((p, d)) }
            }
        }
        return found.sorted { $0.mtime > $1.mtime }.prefix(limit).map { $0.path }
    }

    static let linearNotFoundMessage = "Linear CLI not found. Install it at ~/.local/bin/linear."

    static func executable(named name: String, in directories: [String]) -> String? {
        for directory in directories {
            let candidate = (directory as NSString).appendingPathComponent(name)
            var isDirectory: ObjCBool = false
            let exists = FileManager.default.fileExists(atPath: candidate, isDirectory: &isDirectory)
            if exists, !isDirectory.boolValue,
               FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    static func linearSearchDirectories(home: String = home, path: String? = env["PATH"]) -> [String] {
        var directories = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        if let path { directories += path.split(separator: ":").map(String.init) }
        var seen = Set<String>()
        return directories.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    static func linearBinary(home: String = home, path: String? = env["PATH"]) -> String? {
        executable(named: "linear", in: linearSearchDirectories(home: home, path: path))
    }

    // MARK: Linear tickets in the quick-dispatch panel

    // `linear projects --json`, so the panel can scope its ticket list to the
    // project behind the picked repo (LinearTickets.resolveProject).
    static func linearProjectsAsync(completion: @escaping ([LinearProject]?) -> Void) {
        guard let binary = linearBinary() else { completion(nil); return }
        runMonitored([binary, "projects", "--json"]) { text, ok in
            guard ok, let data = text.data(using: .utf8),
                  let projects = try? JSONDecoder().decode([LinearProject].self, from: data) else {
                completion(nil)
                return
            }
            completion(projects)
        }
    }

    // Every OPEN ticket of one project, across cycles and the backlog — the panel
    // ranks and trims the list itself (LinearTickets.rank), because "what should I
    // pick up next" is not the cycle order Linear returns. `--all` drops the CLI's
    // default per-agent filter so a ticket delegated to another agent is still
    // offered.
    static func linearTicketArgs(project: String, binary: String) -> [String] {
        [binary, "tasks", "--all",
         "--project", project,
         "--status", "open",
         "--cycle", "all",
         "--json"]
    }

    static func linearTicketsAsync(project: String,
                                   completion: @escaping ([LinearTicket]?) -> Void) {
        guard let binary = linearBinary() else { completion(nil); return }
        runMonitored(linearTicketArgs(project: project, binary: binary)) { text, ok in
            guard ok, let data = text.data(using: .utf8),
                  let decoded = try? JSONDecoder().decode(LinearTasksResponse.self, from: data) else {
                completion(nil)
                return
            }
            completion(decoded.issues)
        }
    }

    // The repo name behind a working directory — the identity the panel maps to a
    // Linear project. A worktree under `<repo>/.agents/worktrees/<slug>` must
    // resolve to `<repo>`, not to the slug, so ask git for the COMMON dir (shared
    // by every worktree) rather than trusting the path's last component. A
    // directory that is not a git repo has no repo name but is still a real place
    // to run in, so it identifies as itself.
    static func repoName(forDir dir: String) -> String {
        let common = capture(["/usr/bin/git", "-C", dir, "rev-parse",
                              "--path-format=absolute", "--git-common-dir"])
            .flatMap { String(data: $0, encoding: .utf8) }?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let common, !common.isEmpty {
            return ((common as NSString).deletingLastPathComponent as NSString).lastPathComponent
        }
        return (dir as NSString).lastPathComponent
    }

    // The brief for working a ticket that already exists. Plan asks for a plan
    // posted back on the ticket; Run asks for the change, shipped. Both run in
    // `auto` mode — even the plan has to read the repo and comment on the ticket,
    // which a read-only run cannot do.
    static func ticketWorkPrompt(ticket: LinearTicket, action: QuickDispatchAction) -> String {
        let head = """
        You are picking up an existing Linear ticket, dispatched from the agents \
        menu-bar quick-dispatch panel. Do not ask questions — make your best call and act.

        Ticket: \(ticket.identifier) — \(ticket.title)
        Priority: \(LinearTickets.priorityLabel(ticket.priority))\
        \(ticket.stateName.isEmpty ? "" : " · state: \(ticket.stateName)")\
        \(ticket.url.map { "\nURL: \($0)" } ?? "")

        Read the full ticket first: `linear tasks \(ticket.identifier)`.
        """
        switch action {
        case .plan:
            return """
            \(head)

            Steps:
            1. Read the ticket, then investigate the repo you were launched in for real \
            context — name the files and the concrete change the ticket needs.
            2. Write an implementation plan: the approach, the files to touch, the tests \
            that will prove it, and anything genuinely ambiguous.
            3. Post the plan on the ticket as a comment: \
            `linear update \(ticket.identifier) --comment <plan>`.
            4. Do NOT change code and do NOT open a PR — this dispatch is the plan only. \
            Print the plan as your final output.
            """
        case .run:
            return """
            \(head)

            Steps:
            1. Read the ticket, claim it, and investigate the repo you were launched in. \
            To claim it, move it to this workspace's in-progress state: `linear states` \
            lists the states with their types — pick the one typed `started` and run \
            `linear update \(ticket.identifier) --status <that state>`. Do not guess a \
            state name; workspaces name them differently.
            2. Implement the change following that repo's AGENTS.md (worktree + PR when the \
            repo requires it; never commit on the default branch).
            3. Verify with the focused tests or the real flow that proves the user-visible \
            outcome, and quote the real output.
            4. Comment the result on the ticket with the PR link \
            (`linear update \(ticket.identifier) --comment <result>`), and print the PR URL \
            or the local verification evidence as your final output.
            """
        }
    }

    // `agents run` argv for a ticket dispatch. Same shape as a quick Run — headless,
    // balanced across signed-in versions, self-notifying, scoped to the picked repo
    // — but named after the ticket so the session reads as `rush-2098` in
    // `agents sessions` instead of a slug of a note nobody typed.
    static func ticketWorkRunArgs(agent: String, prompt: String, ticket: LinearTicket,
                                  action: QuickDispatchAction, cwd: String? = nil) -> [String] {
        let suffix = action == .plan ? "-plan" : ""
        return quickFixRunArgs(agent: agent, prompt: prompt,
                               name: "\(ticket.identifier.lowercased())\(suffix)", cwd: cwd)
    }

    // Fan the selected agents out onto one existing ticket. Detached + `--notify`
    // for the same reason as dispatchQuickFix: the run must outlive this helper.
    static func dispatchTicketWork(ticket: LinearTicket, agents: [String],
                                  action: QuickDispatchAction, cwd: String? = nil) {
        let selected = agents.isEmpty ? ["claude"] : agents
        let prompt = ticketWorkPrompt(ticket: ticket, action: action)
        Notifier.post(title: action == .plan
                        ? "Planning \(ticket.identifier)…"
                        : "Dispatching \(ticket.identifier)…",
                      body: shortenForNotice(ticket.title),
                      url: ticket.url,
                      agent: selected.count == 1 ? selected[0] : nil)
        for agent in selected {
            runDetached(argv(ticketWorkRunArgs(agent: agent, prompt: prompt, ticket: ticket,
                                               action: action, cwd: cwd)))
        }
    }

    // The standing brief handed to the ticket agent. It embeds the user's note
    // and every selected screenshot path as user-provided ticket material so the
    // agent can inspect them. The menu-bar helper owns the actual `linear create`
    // invocation and appends `--image <path>` argv deterministically, so the agent
    // must NOT run `linear create` itself and must NOT put screenshot paths in the
    // description. Project detection + investigation remain agent-owned (Swift
    // pre-computes nothing).
    static func ticketAgentPrompt(note: String, screenshotPaths: [String]) -> String {
        let shots: String
        if screenshotPaths.isEmpty {
            shots = "No screenshots were attached; work from the note alone."
        } else if screenshotPaths.count == 1 {
            shots = "The user attached this screenshot for the ticket: \(screenshotPaths[0]) — read it first with your image tools."
        } else {
            let list = screenshotPaths.map { "  - \($0)" }.joined(separator: "\n")
            shots = "The user attached \(screenshotPaths.count) screenshots for the ticket — read each with your image tools:\n\(list)"
        }
        return """
        You are filing exactly ONE Linear ticket from a quick capture bar. Do not ask \
        questions — make your best call and act.

        User note: \(note)
        \(shots)

        Steps:
        1. If files are attached, inspect every one to understand what the user is pointing at. \
        They are user-provided ticket material, not analysis-only references.
        2. Run `agents sessions --all --limit 20` and skim the recent local sessions to \
        identify which repository / project this concerns (match the note + screenshot to a \
        repo you have been working in). Derive the repo name (e.g. `agents-cli`).
        3. Do a brief investigation for real context — name the likely file/area, a \
        reproduction path, or at minimum a crisp problem statement. Do NOT over-investigate; \
        a couple of focused reads is enough.
        4. Determine the best delegate agent for this ticket:
           - The workspace agent roster is: Antigravity, Claude, Codex, Droid, Grok, Kimi, OpenClaw.
           - Run `agents sessions --active` and cross-check the roster against actually active local sessions.
           - Pick the agent whose recent work and strengths best fit the ticket content. Use your own judgment; do not ask the user.
           - If no agent clearly fits better than the others, default to `claude`.
           - If delegate resolution fails or produces no available candidate, set delegate to null.
        5. Return ONLY a JSON object with exactly these keys:

           {
             "title": "<crisp imperative title>",
             "description": "<your markdown description; do NOT mention the screenshot paths here>",
             "priority": "<urgent|high|medium|low>",
             "project": "<Linear project name matching the repo>",
             "label": "repo:<repo-name>",
             "delegate": "<agent>" | null
           }

           Pick an HONEST priority. Keep the title short and specific.
           Do NOT run `linear create` and do NOT run any upload command. The menu-bar helper \
           creates the ticket and uploads every selected screenshot deterministically via `--image`.

        Print nothing before or after the JSON object.
        """
    }

    static func quickFixPrompt(note: String, screenshotPaths: [String]) -> String {
        let shots: String
        if screenshotPaths.isEmpty {
            shots = "No screenshots were attached; work from the note alone."
        } else if screenshotPaths.count == 1 {
            shots = "A screenshot is attached at: \(screenshotPaths[0]) — read it first with your image tools."
        } else {
            let list = screenshotPaths.map { "  - \($0)" }.joined(separator: "\n")
            shots = "\(screenshotPaths.count) screenshots are attached — read each with your image tools:\n\(list)"
        }
        return """
        You are an autonomous quick-dispatch agent launched from the agents menu-bar \
        screenshot panel. Do not ask questions — make your best call and act.

        User request: \(note)
        \(shots)

        Steps:
        1. If screenshots are attached, inspect them to understand the visible problem.
        2. Run `agents sessions --all --limit 20` and skim the recent local sessions to \
        identify the most likely repository / project for this request.
        3. Work in the correct repo, follow its AGENTS.md instructions, and implement the \
        smallest fix that satisfies the request.
        4. Verify with the focused tests or real flow that proves the user-visible outcome.
        5. Commit, open a PR when the repo workflow requires it, and print the final proof \
        URL or local verification evidence.
        """
    }

    // Build the deterministic `linear create` argv for a parsed ticket draft,
    // appending every selected screenshot as `--image <path>` so paths pass
    // through Swift argv (safe for spaces/`@` in CleanShot filenames).
    static func ticketCreateArgs(draft: TicketDraft, screenshotPaths: [String], binary: String) -> [String] {
        var args = [binary, "create", draft.title,
                    "--priority", draft.priority,
                    "--project", draft.project,
                    "--label", draft.label,
                    "--description-file", "-"]
        if let delegate = draft.delegate, !delegate.isEmpty {
            args.append("--delegate")
            args.append(delegate)
        }
        for path in screenshotPaths {
            args.append("--image")
            args.append(path)
        }
        return args
    }

    // Dispatch the ticket agent for a captured note (+ optional screenshot). This
    // is the SINGLE isolation point: swapping to a cloud pod later (uploading the
    // screenshot, serializing session context) changes only this function. The
    // agent runs headless in `auto` mode to investigate and return ticket fields
    // as JSON; the helper itself runs `linear create --image ...` so screenshot
    // paths never pass through an LLM shell string. It runs as a MONITORED async
    // process (not fully detached) so completion drives a real notification
    // without blocking the panel/UI.
    // Distinct recent working directories from local session history, most-recent
    // first, with the home dir dropped — running an agent straight in $HOME is too
    // broad a permission surface, so the panel offers real repos to scope into.
    static func recentRepoDirs(from sessions: [RecentSession], limit: Int = 8) -> [String] {
        let home = (NSHomeDirectory() as NSString).standardizingPath
        var seen = Set<String>()
        var dirs: [String] = []
        for s in sessions {
            guard let cwd = s.cwd, !cwd.isEmpty else { continue }
            let norm = (cwd as NSString).standardizingPath
            if norm == home { continue }
            if seen.insert(norm).inserted { dirs.append(norm) }
            if dirs.count >= limit { break }
        }
        return dirs
    }

    static func dispatchTicketAgent(note: String, screenshotPaths: [String], agent: String? = nil, cwd: String? = nil) {
        guard let linear = linearBinary() else {
            Notifier.post(title: "Cannot create ticket", body: linearNotFoundMessage)
            return
        }
        let prompt = ticketAgentPrompt(note: note, screenshotPaths: screenshotPaths)
        let agent = agent ?? env["AGENTS_ISSUE_AGENT"] ?? "claude"
        Notifier.post(title: "Filing ticket…", body: shortenForNotice(note), agent: agent)
        var planArgs = ["run", agent, prompt, "--mode", "auto"]
        if let cwd, !cwd.isEmpty { planArgs += ["--cwd", cwd] }
        runMonitored(argv(planArgs)) { output, ok in
            guard ok, let draft = parseTicketDraft(output) else {
                Notifier.post(title: "Ticket agent finished",
                              body: ok ? "Could not parse ticket draft from agent output."
                                       : "The ticket agent exited with an error.",
                              agent: agent)
                return
            }
            let args = ticketCreateArgs(draft: draft, screenshotPaths: screenshotPaths, binary: linear)
            guard let descriptionData = draft.description.data(using: .utf8) else {
                Notifier.post(title: "Ticket agent finished", body: "Could not encode description.", agent: agent)
                return
            }
            Notifier.post(title: "Creating ticket…", body: shortenForNotice(note), agent: agent)
            runMonitoredWithInput(args, input: descriptionData) { createOutput, createOk in
                guard createOk, let completion = ticketCompletion(output: createOutput) else {
                    Notifier.post(title: "Ticket creation failed",
                                  body: createOk ? "Could not confirm a ticket was created."
                                               : ticketCreateFailureMessage(createOutput),
                                  agent: agent)
                    return
                }
                // Persist to the ledger so the menu bar's RECENT TICKETS section can
                // surface it beyond the transient notification.
                RecentTickets.record(id: completion.id, title: note, url: completion.url,
                                     createdAt: ISO8601DateFormatter().string(from: Date()))
                // Attach the ticket URL so the notification is clickable → opens it.
                Notifier.post(title: "Created \(completion.id)", body: shortenForNotice(note), url: completion.url,
                              agent: agent)
            }
        }
    }

    // Fire-and-forget: the run is launched detached and posts its OWN completion
    // notification via `agents run --notify`. It used to be monitored here, with
    // the finish notice in the process-termination callback — but that callback
    // lives in THIS process, so a helper that restarted (an upgrade replacing the
    // bundle, a crash) took it with it while the run carried on reparented to
    // launchd. A dispatch could then never report back. The run process owns the
    // notice now, so nothing that happens to the menu bar can lose it.
    static func dispatchQuickFix(note: String, screenshotPaths: [String], agents: [String],
                                 cwd: String? = nil, device: String? = nil) {
        let selected = agents.isEmpty ? ["claude"] : agents
        let prompt = quickFixPrompt(note: note, screenshotPaths: screenshotPaths)
        let name = quickDispatchName(note: note)
        // The avatar depicts one harness, so it rides only a single-agent dispatch;
        // a fan-out across several agents has no one agent to show.
        Notifier.post(title: "Dispatching \(selected.count) agent\(selected.count == 1 ? "" : "s")…",
                      body: shortenForNotice(note),
                      agent: selected.count == 1 ? selected[0] : nil)
        for agent in selected {
            runDetached(argv(quickFixRunArgs(agent: agent, prompt: prompt, name: name,
                                             cwd: cwd, device: device)))
        }
    }

    // The Linear ticket URL the agent printed (so the notification can deep-link).
    static func parseTicketURL(_ output: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: "https://linear\\.app/\\S+"),
              let m = re.matches(in: output, range: NSRange(output.startIndex..., in: output)).last,
              let r = Range(m.range, in: output) else { return nil }
        // Trim trailing punctuation the model may append.
        return String(output[r]).trimmingCharacters(in: CharacterSet(charactersIn: ").,]"))
    }

    // Pull the `RUSH-123` / `ENG-45` identifier out of the agent's final line.
    static func parseCreatedTicketID(_ output: String) -> String? {
        // Match "Created ABC-123:" (the linear CLI's create success line), else
        // any bare TEAM-123 token as a fallback for a paraphrased final line.
        // Take the LAST match: if the agent mentioned an existing ticket id in its
        // reasoning, the real "Created …" result line still comes after it.
        let patterns = ["Created ([A-Z][A-Z0-9]+-[0-9]+)", "\\b([A-Z][A-Z0-9]+-[0-9]+)\\b"]
        for pat in patterns {
            guard let re = try? NSRegularExpression(pattern: pat) else { continue }
            let matches = re.matches(in: output, range: NSRange(output.startIndex..., in: output))
            if let last = matches.last, let r = Range(last.range(at: 1), in: output) {
                return String(output[r])
            }
        }
        return nil
    }

    // Extract the ticket draft JSON the agent was asked to emit. Tolerates
    // surrounding chatter by taking the outermost JSON object.
    static func parseTicketDraft(_ output: String) -> TicketDraft? {
        guard let start = output.firstIndex(of: "{"),
              let end = output.lastIndex(of: "}") else { return nil }
        let json = String(output[start...end])
        guard let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(TicketDraft.self, from: data)
    }

    static func ticketCompletion(output: String) -> TicketCompletion? {
        guard let id = parseCreatedTicketID(output) else { return nil }
        return TicketCompletion(id: id, url: parseTicketURL(output))
    }

    private static func shortenForNotice(_ s: String) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count > 80 ? String(t.prefix(79)) + "…" : t
    }

    static func ticketCreateFailureMessage(_ output: String) -> String {
        let detail = output
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last { !$0.isEmpty }
        return detail.map { shortenForNotice($0) } ?? "linear create exited with an error."
    }

    // Seed `agents run --name` from the user's own task text — the first few words,
    // slugified — so the run reads as THEIR task in `agents sessions` instead of an
    // opaque `quick-<timestamp>`. The agent's generated title refines it later.
    static func quickDispatchName(note: String, date: Date = Date()) -> String {
        let words = note
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9 ]", with: " ", options: .regularExpression)
            .split(separator: " ")
            .prefix(5)
        let slug = words.joined(separator: "-")
        if slug.isEmpty {
            return "task-\(Int(date.timeIntervalSince1970))"
        }
        return String(slug.prefix(48))
    }

    // Build the `agents run` argv for a headless Run. Strategy is ALWAYS balanced
    // (auto load-balance across signed-in versions with headroom, skipping any that
    // are rate-limited); an explicit --cwd scopes the agent to the chosen repo (never
    // the home dir); an explicit --device offloads onto the chosen box (nil = this
    // Mac / affinity-auto is handled by the caller passing "auto"). `--notify` makes
    // the run itself post the completion notification, so it outlives this helper.
    static func quickFixRunArgs(agent: String, prompt: String, name: String,
                                cwd: String? = nil, device: String? = nil) -> [String] {
        var args = ["run", agent, prompt, "--mode", "auto", "--balanced", "--notify", "--name", name]
        if let cwd, !cwd.isEmpty {
            args.append("--cwd")
            args.append(cwd)
        }
        if let device, !device.isEmpty, device != "local" {
            args.append("--device")
            args.append(device)
        }
        return args
    }

    // MARK: Process helpers

    // The TIMER-DRIVEN path: bounded, group-killable, reapable. Everything the
    // cached refreshers poll goes through here, and it must, because a poller is
    // the only caller that can stack copies of itself.
    //
    // This used to be a bare `Process` + `readDataToEndOfFile()`, which waits
    // forever and leaves the child (and the child's own subprocesses) orphaned at
    // PPID 1 whenever the helper dies mid-call. Under launchd KeepAlive that
    // compounds: each crash restart spawns a new call while the previous one keeps
    // running, and the orphans accumulate until the machine is unusable. See
    // ChildProcess.swift for the full failure mode and the invariants that close
    // it.
    //
    // The one-shot spawn helpers below (runDetached / runMonitored /
    // runMonitoredWithInput) deliberately stay on bare `Process` — see the note
    // above runDetached for why bounding them would be a bug, not a fix.
    private static func capture(_ argv: [String], timeout: TimeInterval = ChildProcess.defaultTimeout) -> Data? {
        ChildProcess.run(argv, timeout: timeout)
    }

    // NOT routed through ChildProcess, and that is deliberate — do not "fix" it.
    //
    // ChildProcess exists to stop ACCUMULATION: a 10s timer that respawns work
    // faster than it completes is what stacked 38 orphaned doctors. Every caller
    // below is a user-initiated one-shot instead — a menu click (`routines
    // run/pause`, `devices register`, `open <url>`) or a ticket-agent / quick-fix
    // dispatch. One click cannot stack, so there is nothing to accumulate.
    //
    // Applying the timer-path invariants here would be actively wrong on both
    // counts: a deadline would kill the user's headless `agents run` mid-work,
    // and a fire-and-forget `open`/dispatch is SUPPOSED to outlive this helper —
    // reaping it on the next launch would destroy work the user asked for.
    //
    // If a future caller ever makes one of these repeating, that caller is the
    // bug; move it to `capture()` rather than bounding these.
    private static func runDetached(_ argv: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: argv[0])
        p.arguments = Array(argv.dropFirst())
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    // Async, non-blocking process whose stdout is captured and handed to `onFinish`
    // (on the main queue) when it exits. Unlike runDetached this keeps a strong
    // reference until termination so the completion callback can fire — used for
    // the ticket agent, which is long-running but must still report its result.
    //
    // The pipe is drained on a background queue WHILE the child runs, not from a
    // termination handler. A child that outputs more than the pipe buffer holds
    // (~64 KiB — `linear tasks --json` for one project is several hundred KiB, and
    // headless `agents run` output can be far more) blocks forever on write if
    // nothing reads until it exits, so the termination handler never fires and the
    // dispatch hangs with no notification.
    //
    // `captureStderr` folds the child's stderr into the same pipe, so a caller
    // that reports a FAILURE can quote the CLI's own error line instead of an
    // invented one. Off by default: the JSON-parsing callers (the ticket agent)
    // must not have diagnostics interleaved into the payload they parse.
    private static var monitored: [Process] = []
    private static func runMonitored(_ argv: [String], captureStderr: Bool = false,
                                     onFinish: @escaping (String, Bool) -> Void) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: argv[0])
        p.arguments = Array(argv.dropFirst())
        let out = Pipe()
        p.standardOutput = out
        p.standardError = captureStderr ? out : FileHandle.nullDevice
        do {
            try p.run()
            monitored.append(p)
        } catch {
            DispatchQueue.main.async { onFinish("", false) }
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            let text = String(data: data, encoding: .utf8) ?? ""
            let ok = p.terminationStatus == 0
            DispatchQueue.main.async {
                monitored.removeAll { $0 === p }
                onFinish(text, ok)
            }
        }
    }

    // Async monitored process with stdin data, used to pipe the description into
    // `linear create --description-file -` while keeping `--image` paths in argv.
    private static func runMonitoredWithInput(_ argv: [String], input: Data,
                                               onFinish: @escaping (String, Bool) -> Void) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: argv[0])
        p.arguments = Array(argv.dropFirst())
        let out = Pipe()
        let inPipe = Pipe()
        p.standardOutput = out
        p.standardInput = inPipe
        p.standardError = out
        do {
            try p.run()
            monitored.append(p)
        } catch {
            DispatchQueue.main.async { onFinish(error.localizedDescription, false) }
            return
        }
        // Feed stdin and drain stdout off the main thread, for the same reason as
        // runMonitored: either direction can fill its pipe buffer and block, and a
        // blocked main thread would freeze the menu bar.
        DispatchQueue.global(qos: .userInitiated).async {
            inPipe.fileHandleForWriting.write(input)
            inPipe.fileHandleForWriting.closeFile()
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            let text = String(data: data, encoding: .utf8) ?? ""
            let ok = p.terminationStatus == 0
            DispatchQueue.main.async {
                monitored.removeAll { $0 === p }
                onFinish(text, ok)
            }
        }
    }

    private static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
