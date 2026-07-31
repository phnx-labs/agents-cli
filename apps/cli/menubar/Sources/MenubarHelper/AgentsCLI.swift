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

    // Routines are secondary and fetched only when the menu opens. This shells
    // the CLI, but `routines list` does NOT trigger the sessions re-index — it
    // only computes cron next-run, which is cheap. Session data never comes from
    // here; it's read directly from disk by LocalState.
    static func routines() -> [Routine] {
        guard let data = capture(argv(["routines", "list", "--json"])) else { return [] }
        return (try? JSONDecoder().decode([Routine].self, from: data)) ?? []
    }

    static func recentSessions(limit: Int = 3) -> [RecentSession] {
        guard let data = capture(argv(["sessions", "--all", "--limit", "\(limit)", "--json"])) else { return [] }
        return (try? JSONDecoder().decode([RecentSession].self, from: data)) ?? []
    }

    // The session engine's live view — every local session (tmux, IDE, headless),
    // not just extension-registered terminals. Costs seconds (transcript tails
    // across version homes), so it is ONLY called from the warm-cache refreshers,
    // never on the menu-open click path.
    static func activeSessions() -> [ActiveSession] {
        guard let data = capture(argv(["sessions", "--active", "--local", "--json"])) else { return [] }
        return (try? JSONDecoder().decode([ActiveSession].self, from: data)) ?? []
    }

    static func doctorOverview() -> DoctorOverview? {
        guard let data = capture(argv(["doctor", "--json"])) else { return nil }
        return try? JSONDecoder().decode(DoctorOverview.self, from: data)
    }

    // RUSH-1415: is global auto-nudge on? The Swift menu-bar toggle drives this
    // sentinel via watchdogSetEnabled; the tick reads it back to decide whether
    // to inject or stay detect-only.
    static func watchdogStatus() -> WatchdogStatus? {
        guard let data = capture(argv(["watchdog", "status", "--json"])) else { return nil }
        return try? JSONDecoder().decode(WatchdogStatus.self, from: data)
    }

    // RUSH-1415: run one watchdog tick. `nudge` actually injects "Continue." into
    // stalled+addressable splits; without it the tick is detect-only (for the
    // badge). The CLI's own cooldown ledger prevents re-nudging the same split, so
    // this is safe to call on every 10s menu-bar poll.
    static func watchdogTick(nudge: Bool) -> WatchdogTick? {
        var a = ["watchdog", "--json"]
        if nudge { a.append("--nudge") }
        guard let data = capture(argv(a)) else { return nil }
        return try? JSONDecoder().decode(WatchdogTick.self, from: data)
    }

    static func watchdogSetEnabled(_ on: Bool) {
        runDetached(argv(["watchdog", on ? "enable" : "disable"]))
    }

    // MARK: Actions
    // New interactive session: open a Terminal window running `agents run <agent>`.
    // A status-bar click can't host a TUI, so hand off to the user's terminal.
    static func newSession(agent: String) {
        let cmd = "\(shellQuote(binary)) run \(shellQuote(agent))"
        let script = "tell application \"Terminal\"\nactivate\ndo script \"\(cmd)\"\nend tell"
        runDetached(["/usr/bin/osascript", "-e", script])
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

    static func openPath(_ path: String) { runDetached(["/usr/bin/open", path]) }

    static func startScheduler() { runDetached(argv(["routines", "start"])) }
    static func stopDaemon() { runDetached(argv(["routines", "stop"])) }

    // NEW DEVICES actions. `register` adds the pending node to the registry;
    // `ignore` dismisses it for good. Both clear the pending sentinel CLI-side,
    // so the badge/section updates on the next 10s poll. TS owns the truth.
    static func deviceRegister(_ name: String) { runDetached(argv(["devices", "register", name])) }
    static func deviceIgnore(_ name: String) { runDetached(argv(["devices", "ignore", name])) }

    // Surface CLI health in a terminal — `agents doctor` is interactive output.
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

    static func linearSkillBinary() -> String {
        "\(home)/.agents/skills/linear/scripts/linear"
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
    static func ticketCreateArgs(draft: TicketDraft, screenshotPaths: [String]) -> [String] {
        var args = [linearSkillBinary(), "create", draft.title,
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
    static func dispatchTicketAgent(note: String, screenshotPaths: [String], agent: String? = nil) {
        let prompt = ticketAgentPrompt(note: note, screenshotPaths: screenshotPaths)
        let agent = agent ?? env["AGENTS_ISSUE_AGENT"] ?? "claude"
        Notifier.post(title: "Filing ticket…", body: shortenForNotice(note))
        runMonitored(argv(["run", agent, prompt, "--mode", "auto"])) { output, ok in
            guard ok, let draft = parseTicketDraft(output) else {
                Notifier.post(title: "Ticket agent finished",
                              body: ok ? "Could not parse ticket draft from agent output."
                                       : "The ticket agent exited with an error.")
                return
            }
            let args = ticketCreateArgs(draft: draft, screenshotPaths: screenshotPaths)
            guard let descriptionData = draft.description.data(using: .utf8) else {
                Notifier.post(title: "Ticket agent finished", body: "Could not encode description.")
                return
            }
            Notifier.post(title: "Creating ticket…", body: shortenForNotice(note))
            runMonitoredWithInput(args, input: descriptionData) { createOutput, createOk in
                guard createOk, let completion = ticketCompletion(output: createOutput) else {
                    Notifier.post(title: "Ticket creation failed",
                                  body: createOk ? "Could not confirm a ticket was created."
                                               : "linear create exited with an error.")
                    return
                }
                // Persist to the ledger so the menu bar's RECENT TICKETS section can
                // surface it beyond the transient notification.
                RecentTickets.record(id: completion.id, title: note, url: completion.url,
                                     createdAt: ISO8601DateFormatter().string(from: Date()))
                // Attach the ticket URL so the notification is clickable → opens it.
                Notifier.post(title: "Created \(completion.id)", body: shortenForNotice(note), url: completion.url)
            }
        }
    }

    static func dispatchQuickFix(note: String, screenshotPaths: [String], agents: [String]) {
        let selected = agents.isEmpty ? ["claude"] : agents
        let prompt = quickFixPrompt(note: note, screenshotPaths: screenshotPaths)
        Notifier.post(title: "Dispatching \(selected.count) agent\(selected.count == 1 ? "" : "s")…",
                      body: shortenForNotice(note))
        for agent in selected {
            let name = quickDispatchName(agent: agent)
            runMonitored(argv(quickFixRunArgs(agent: agent, prompt: prompt, name: name))) { _, ok in
                let label = LocalState.agentLabel(agent)
                Notifier.post(title: ok ? "\(label) finished" : "\(label) failed",
                              body: shortenForNotice(note))
            }
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

    static func quickDispatchName(agent: String, date: Date = Date()) -> String {
        let stamp = Int(date.timeIntervalSince1970)
        let clean = LocalState.normalizeAgent(agent).replacingOccurrences(of: "[^a-z0-9-]", with: "-", options: .regularExpression)
        return "quick-\(clean)-\(stamp)"
    }

    static func quickFixRunArgs(agent: String, prompt: String, name: String) -> [String] {
        ["run", agent, prompt, "--mode", "auto", "--name", name]
    }

    // MARK: Process helpers
    private static func capture(_ argv: [String]) -> Data? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: argv[0])
        p.arguments = Array(argv.dropFirst())
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
        } catch {
            return nil
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0 ? data : nil
    }

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
    private static var monitored: [Process] = []
    private static func runMonitored(_ argv: [String], onFinish: @escaping (String, Bool) -> Void) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: argv[0])
        p.arguments = Array(argv.dropFirst())
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { proc in
            let data = out.fileHandleForReading.readDataToEndOfFile()
            let text = String(data: data, encoding: .utf8) ?? ""
            let ok = proc.terminationStatus == 0
            DispatchQueue.main.async {
                monitored.removeAll { $0 === proc }
                onFinish(text, ok)
            }
        }
        do {
            try p.run()
            monitored.append(p)
        } catch {
            DispatchQueue.main.async { onFinish("", false) }
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
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { proc in
            let data = out.fileHandleForReading.readDataToEndOfFile()
            let text = String(data: data, encoding: .utf8) ?? ""
            let ok = proc.terminationStatus == 0
            DispatchQueue.main.async {
                monitored.removeAll { $0 === proc }
                onFinish(text, ok)
            }
        }
        do {
            try p.run()
            monitored.append(p)
            inPipe.fileHandleForWriting.write(input)
            inPipe.fileHandleForWriting.closeFile()
        } catch {
            DispatchQueue.main.async { onFinish("", false) }
        }
    }

    private static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
