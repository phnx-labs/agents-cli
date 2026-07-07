import Foundation

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
        let cmd = "\(shellQuote(binary)) routines logs \(shellQuote(name))"
        let script = "tell application \"Terminal\"\nactivate\ndo script \"\(cmd)\"\nend tell"
        runDetached(["/usr/bin/osascript", "-e", script])
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

    // MARK: Quick issue capture (Cmd-Shift-O)

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

    // The standing brief handed to the ticket agent. It embeds the user's note
    // and the screenshot path; the agent does project detection + investigation
    // itself (Swift pre-computes nothing). `linear create` takes a POSITIONAL
    // title, no --json, and prints `Created RUSH-###: <title>` — parsed back in
    // the termination handler for the completion notification.
    static func ticketAgentPrompt(note: String, screenshotPaths: [String]) -> String {
        let linear = "\(home)/.agents/skills/linear/scripts/linear"
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
        You are filing exactly ONE Linear ticket from a quick capture bar. Do not ask \
        questions — make your best call and act.

        User note: \(note)
        \(shots)

        Steps:
        1. If screenshots are attached, inspect them to understand what the user is pointing at.
        2. Run `agents sessions --all --limit 20` and skim the recent local sessions to \
        identify which repository / project this concerns (match the note + screenshot to a \
        repo you have been working in). Derive the repo name (e.g. `agents-cli`).
        3. Do a brief investigation for real context — name the likely file/area, a \
        reproduction path, or at minimum a crisp problem statement. Do NOT over-investigate; \
        a couple of focused reads is enough.
        4. File the ticket, piping a proper multi-line description via stdin:

           printf '%s' "<your markdown description>" | \\
             \(linear) create "<crisp imperative title>" \\
               --priority <urgent|high|medium|low> \\
               --project "<Linear project name matching the repo>" \\
               --label "repo:<repo-name>" \\
               --description-file -

           Pick an HONEST priority. Keep the title short and specific.
        5. Print the resulting `Created RUSH-###: <title>` line, then on the NEXT line print
        the ticket's Linear URL as `URL: https://linear.app/…` (the `linear create` output or
        `\(linear) tasks <id>` gives it). Nothing else — no commentary.
        """
    }

    // Dispatch the ticket agent for a captured note (+ optional screenshot). This
    // is the SINGLE isolation point: swapping to a cloud pod later (uploading the
    // screenshot, serializing session context) changes only this function. The
    // agent runs headless in `auto` mode so it may read files, run `agents
    // sessions`, investigate, and call `linear create` — but genuinely
    // destructive ops still gate. It runs as a MONITORED async process (not fully
    // detached) so its `Created RUSH-###` line drives a real completion
    // notification without blocking the panel/UI.
    static func dispatchTicketAgent(note: String, screenshotPaths: [String]) {
        let prompt = ticketAgentPrompt(note: note, screenshotPaths: screenshotPaths)
        let agent = env["AGENTS_ISSUE_AGENT"] ?? "claude"
        Notifier.post(title: "Filing ticket…", body: shortenForNotice(note))
        runMonitored(argv(["run", agent, prompt, "--mode", "auto"])) { output, ok in
            guard ok, let id = parseCreatedTicketID(output) else {
                Notifier.post(title: "Ticket agent finished",
                              body: ok ? "Could not confirm a ticket was created."
                                       : "The ticket agent exited with an error.")
                return
            }
            let url = parseTicketURL(output)
            // Persist to the ledger so the menu bar's RECENT TICKETS section can
            // surface it beyond the transient notification.
            RecentTickets.record(id: id, title: note, url: url,
                                 createdAt: ISO8601DateFormatter().string(from: Date()))
            // Attach the ticket URL so the notification is clickable → opens it.
            Notifier.post(title: "Created \(id)", body: shortenForNotice(note), url: url)
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

    private static func shortenForNotice(_ s: String) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count > 80 ? String(t.prefix(79)) + "…" : t
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

    private static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
