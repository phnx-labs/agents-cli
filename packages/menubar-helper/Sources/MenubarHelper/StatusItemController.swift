import AppKit

// Owns the NSStatusItem. The dropdown is intentionally data-dense: a fixed
// product roster, activity from local sessions/browser work, routines,
// resource sync state, and compact warnings near the footer.
final class StatusItemController: NSObject, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let accent = NSColor(red: 0x39 / 255.0, green: 0xd3 / 255.0, blue: 0x53 / 255.0, alpha: 1) // #39d353
    private let alert = NSColor.systemRed
    private let warning = NSColor.systemOrange

    // Cached cheap snapshot for the badge (no teams scan).
    private var badgeSessions: [Session] = []

    // These three reads shell the CLI or touch the sessions DB. They are kept
    // off the click path and rendered from warm caches when the menu opens.
    private var cachedRoutines: [Routine] = []
    private var routinesLoaded = false
    private var routinesInFlight = false
    private var routinesFetchedAt: Date?

    private var cachedRecentSessions: [RecentSession] = []
    private var recentSessionsLoaded = false
    private var recentSessionsInFlight = false
    private var recentSessionsFetchedAt: Date?

    private var cachedDoctorOverview: DoctorOverview?
    private var doctorLoaded = false
    private var doctorInFlight = false
    private var doctorFetchedAt: Date?

    func install() {
        if let button = statusItem.button {
            button.image = Icon.make()
            button.imagePosition = .imageLeading
            button.toolTip = "agents-cli"
        }
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        tick()
        // Cheap poll: terminals + cloud + attention only. Badge stays glanceable
        // without paying the teams-dir scan cost on every interval.
        Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.tick() }

        if ProcessInfo.processInfo.environment["MENUBAR_DUMP"] == "1" {
            loadDumpCaches()
            let probe = NSMenu()
            menuWillOpen(probe)
            dumpMenu(probe)
            // Dump mode is a probe for tests and diagnostics; do not leave a
            // second status item alive after emitting the menu contents.
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func tick() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let s = LocalState.sessions(includeTeams: false)
            DispatchQueue.main.async {
                self?.badgeSessions = s
                self?.refreshBadge()
            }
        }
        refreshRoutines()
        refreshRecentSessions()
        refreshDoctorOverview()
    }

    private func loadDumpCaches() {
        cachedRoutines = AgentsCLI.routines()
        routinesLoaded = true
        routinesFetchedAt = Date()

        cachedRecentSessions = AgentsCLI.recentSessions(limit: 6)
        recentSessionsLoaded = true
        recentSessionsFetchedAt = Date()

        cachedDoctorOverview = AgentsCLI.doctorOverview()
        doctorLoaded = true
        doctorFetchedAt = Date()
    }

    // MARK: Cached CLI refreshes
    private func refreshRoutines() {
        if routinesInFlight { return }
        if let t = routinesFetchedAt, Date().timeIntervalSince(t) < 20 { return }
        routinesInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let r = AgentsCLI.routines()
            DispatchQueue.main.async {
                guard let self else { return }
                self.cachedRoutines = r
                self.routinesLoaded = true
                self.routinesFetchedAt = Date()
                self.routinesInFlight = false
            }
        }
    }

    private func refreshRecentSessions() {
        if recentSessionsInFlight { return }
        if let t = recentSessionsFetchedAt, Date().timeIntervalSince(t) < 45 { return }
        recentSessionsInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let s = AgentsCLI.recentSessions(limit: 6)
            DispatchQueue.main.async {
                guard let self else { return }
                self.cachedRecentSessions = s
                self.recentSessionsLoaded = true
                self.recentSessionsFetchedAt = Date()
                self.recentSessionsInFlight = false
            }
        }
    }

    private func refreshDoctorOverview() {
        if doctorInFlight { return }
        if let t = doctorFetchedAt, Date().timeIntervalSince(t) < 60 { return }
        doctorInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let d = AgentsCLI.doctorOverview()
            DispatchQueue.main.async {
                guard let self else { return }
                self.cachedDoctorOverview = d
                self.doctorLoaded = true
                self.doctorFetchedAt = Date()
                self.doctorInFlight = false
            }
        }
    }

    private func refreshBadge() {
        guard let button = statusItem.button else { return }
        let attention = badgeSessions.filter { $0.status == .attention }.count
        let running = badgeSessions.filter { $0.status == .running }.count
        if attention > 0 {
            button.attributedTitle = badge("!", alert)
        } else if running > 0 {
            button.attributedTitle = badge(" \(running)", accent)
        } else {
            button.title = ""
        }
    }

    private func badge(_ s: String, _ color: NSColor) -> NSAttributedString {
        NSAttributedString(string: s, attributes: [
            .foregroundColor: color,
            .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .bold),
        ])
    }

    // MARK: - Menu
    func menuWillOpen(_ menu: NSMenu) {
        // Critical path is all cheap disk reads. CLI-backed sections come from
        // warm caches; opening the menu only schedules refreshes for next time.
        let sessions = LocalState.sessions(includeTeams: true)
        let browserTasks = LocalState.browserTasks(limit: 3)
        let daemonPid = AgentsCLI.daemonPid()
        badgeSessions = sessions
        rebuild(menu, sessions: sessions, browserTasks: browserTasks,
                recentSessions: cachedRecentSessions, routines: cachedRoutines,
                doctor: cachedDoctorOverview, daemonPid: daemonPid)
        refreshBadge()
        refreshRoutines()
        refreshRecentSessions()
        refreshDoctorOverview()
    }

    private func rebuild(_ menu: NSMenu, sessions: [Session], browserTasks: [BrowserTask],
                         recentSessions: [RecentSession], routines: [Routine],
                         doctor: DoctorOverview?, daemonPid: Int?) {
        menu.removeAllItems()

        addHeader(menu, daemonPid: daemonPid)
        addNewSession(menu)
        menu.addItem(.separator())

        addAgents(menu, sessions: sessions, doctor: doctor)
        menu.addItem(.separator())

        addActivity(menu, browserTasks: browserTasks, recentSessions: recentSessions)
        menu.addItem(.separator())

        addRoutines(menu, routines: routines)
        menu.addItem(.separator())

        addResources(menu, doctor: doctor)

        let warnings = warningRows(routines: routines, doctor: doctor)
        if !warnings.isEmpty {
            menu.addItem(.separator())
            addSectionTitle(menu, "WARNINGS", color: warning)
            for row in warnings.prefix(4) {
                let it = NSMenuItem(title: "  ! \(row)", action: nil, keyEquivalent: "")
                menu.addItem(it)
            }
            if warnings.count > 4 {
                menu.addItem(disabled("  \(warnings.count - 4) more warnings"))
            }
        }

        menu.addItem(.separator())
        addFooter(menu, daemonPid: daemonPid)
    }

    private func addHeader(_ menu: NSMenu, daemonPid: Int?) {
        let status = daemonPid == nil ? "STOPPED" : "RUNNING"
        let title = "agents-cli                                      \(status)"
        let item = disabled(title)
        let attr = NSMutableAttributedString(string: title, attributes: [
            .foregroundColor: NSColor.labelColor,
            .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .semibold),
        ])
        let range = (title as NSString).range(of: status)
        attr.addAttributes([
            .foregroundColor: daemonPid == nil ? alert : accent,
            .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .bold),
        ], range: range)
        item.attributedTitle = attr
        menu.addItem(item)
    }

    private func addNewSession(_ menu: NSMenu) {
        let newItem = NSMenuItem(title: "New Session", action: nil, keyEquivalent: "n")
        let newSub = NSMenu()
        for agent in LocalState.desiredAgents {
            let it = NSMenuItem(title: agent.label, action: #selector(onNewSession(_:)), keyEquivalent: "")
            it.target = self
            it.representedObject = agent.id
            newSub.addItem(it)
        }
        newItem.submenu = newSub
        menu.addItem(newItem)
    }

    private func addAgents(_ menu: NSMenu, sessions: [Session], doctor: DoctorOverview?) {
        let running = sessions.filter { $0.status == .running }.count
        let idle = sessions.filter { $0.status == .idle }.count
        addSectionTitle(menu, "AGENTS  ·  \(running) running · \(idle) idle", color: .secondaryLabelColor)
        for agent in LocalState.desiredAgents {
            let mine = sessions.filter { LocalState.normalizeAgent($0.agent) == agent.id }
            let item = NSMenuItem(title: rosterRow(agent: agent, sessions: mine, doctor: doctor),
                                  action: nil, keyEquivalent: "")
            item.submenu = rosterSubmenu(agent: agent, sessions: mine, doctor: doctor)
            menu.addItem(item)
        }
    }

    private func addActivity(_ menu: NSMenu, browserTasks: [BrowserTask], recentSessions: [RecentSession]) {
        addSectionTitle(menu, "ACTIVITY", color: .secondaryLabelColor)
        let visibleRecentSessions = Array(recentSessions.filter {
            let id = LocalState.normalizeAgent($0.agent)
            return LocalState.desiredAgents.contains { $0.id == id }
        }.prefix(3))

        for task in browserTasks {
            let tabs = task.tabCount == 1 ? "1 tab" : "\(task.tabCount) tabs"
            let title = "  Browser      \(trim(task.name, 28)) · \(shortProfile(task.profile)) · \(tabs)"
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.submenu = browserTaskSubmenu(task)
            menu.addItem(item)
        }

        if visibleRecentSessions.isEmpty {
            menu.addItem(disabled(recentSessionsLoaded ? "  No recent sessions" : "  Recent sessions checking…"))
            return
        }

        for session in visibleRecentSessions {
            let title = recentSessionTitle(session)
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.submenu = recentSessionSubmenu(session)
            menu.addItem(item)
        }
    }

    private func addRoutines(_ menu: NSMenu, routines: [Routine]) {
        addSectionTitle(menu, "ROUTINES", color: .secondaryLabelColor)
        let item = NSMenuItem(title: routinesSummary(routines), action: nil, keyEquivalent: "")
        if !routines.isEmpty { item.submenu = allRoutinesSubmenu(routines) }
        menu.addItem(item)
    }

    private func addResources(_ menu: NSMenu, doctor: DoctorOverview?) {
        addSectionTitle(menu, "RESOURCES", color: .secondaryLabelColor)
        let item = NSMenuItem(title: resourcesSummary(doctor), action: nil, keyEquivalent: "")
        item.submenu = resourcesSubmenu(doctor)
        menu.addItem(item)
    }

    private func addFooter(_ menu: NSMenu, daemonPid: Int?) {
        if daemonPid != nil {
            let stop = NSMenuItem(title: "Stop scheduler", action: #selector(onStopScheduler), keyEquivalent: "")
            stop.target = self
            menu.addItem(stop)
        }
        let settings = NSMenuItem(title: "Settings", action: #selector(onOpenAgentsHome), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)

        let quit = NSMenuItem(title: "Quit menu bar", action: #selector(onQuit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    // MARK: Row builders
    private func rosterRow(agent: MenuAgent, sessions: [Session], doctor: DoctorOverview?) -> String {
        let attn = sessions.filter { $0.status == .attention }.count
        let run = sessions.filter { $0.status == .running }.count
        let idle = sessions.filter { $0.status == .idle }.count
        let name = agent.label.padding(toLength: 13, withPad: " ", startingAt: 0)
        let resource = resourceHint(agent.id, doctor: doctor)
        if cliInstalled(agent.id, doctor: doctor) == false { return "\(name) ! missing CLI" }
        if attn > 0 { return "\(name) ! \(attn) awaiting input\(resource)" }
        if run > 0 { return "\(name) ● \(run) running" + (idle > 0 ? " · \(idle) idle" : "") + resource }
        if idle > 0 { return "\(name) ○ \(idle) idle\(resource)" }
        return "\(name) ○ ready\(resource)"
    }

    private func rosterSubmenu(agent: MenuAgent, sessions: [Session], doctor: DoctorOverview?) -> NSMenu {
        let sub = NSMenu()
        if sessions.isEmpty {
            sub.addItem(disabled("No live sessions"))
        } else {
            for s in sessions {
                let mark = s.status == .attention ? "! " : (s.status == .running ? "● " : "○ ")
                let detail = s.detail.isEmpty ? "" : "  ·  \(trim(s.detail, 40))"
                let row = NSMenuItem(title: "\(mark)\(s.repo)\(detail)", action: nil, keyEquivalent: "")
                if let cwd = s.cwd { row.submenu = revealSubmenu(cwd) }
                sub.addItem(row)
            }
        }

        sub.addItem(.separator())
        if let sync = syncState(agent.id, doctor: doctor) {
            sub.addItem(disabled("Resources: \(sync.status)\(sync.version.map { " · \($0)" } ?? "")"))
        } else {
            sub.addItem(disabled(doctorLoaded ? "Resources: unknown" : "Resources: checking…"))
        }
        if let cli = doctor?.clis?[agent.id] {
            sub.addItem(disabled(cli.installed ? "CLI installed" : "CLI missing"))
        }

        sub.addItem(.separator())
        let new = NSMenuItem(title: "New \(agent.label) session", action: #selector(onNewSession(_:)), keyEquivalent: "")
        new.target = self
        new.representedObject = agent.id
        sub.addItem(new)
        return sub
    }

    private func browserTaskSubmenu(_ task: BrowserTask) -> NSMenu {
        let sub = NSMenu()
        sub.addItem(disabled("Profile: \(task.profile)"))
        sub.addItem(disabled("PID: \(task.pid)"))
        let open = NSMenuItem(title: "Open browser cache", action: #selector(onOpenPath(_:)), keyEquivalent: "")
        open.target = self
        open.representedObject = "\(AgentsCLI.home)/.agents/.cache/browser/\(task.profile)"
        sub.addItem(open)
        return sub
    }

    private func recentSessionSubmenu(_ session: RecentSession) -> NSMenu {
        let sub = NSMenu()
        if let topic = session.topic, !topic.isEmpty {
            sub.addItem(disabled(trim(topic, 60)))
            sub.addItem(.separator())
        }
        if let version = session.version {
            sub.addItem(disabled("Version: \(version)"))
        }
        if let branch = session.gitBranch {
            sub.addItem(disabled("Branch: \(branch)"))
        }
        if session.version != nil || session.gitBranch != nil {
            sub.addItem(.separator())
        }
        if let filePath = session.filePath {
            let open = NSMenuItem(title: "Open transcript", action: #selector(onOpenPath(_:)), keyEquivalent: "")
            open.target = self
            open.representedObject = filePath
            sub.addItem(open)
        }
        if let cwd = session.cwd {
            let reveal = NSMenuItem(title: "Reveal project", action: #selector(onOpenPath(_:)), keyEquivalent: "")
            reveal.target = self
            reveal.representedObject = cwd
            sub.addItem(reveal)
        }
        return sub
    }

    private func revealSubmenu(_ cwd: String) -> NSMenu {
        let sub = NSMenu()
        let reveal = NSMenuItem(title: "Reveal working dir", action: #selector(onOpenPath(_:)), keyEquivalent: "")
        reveal.target = self
        reveal.representedObject = cwd
        sub.addItem(reveal)
        return sub
    }

    private func routineSubmenu(_ r: Routine) -> NSMenu {
        let sub = NSMenu()
        let run = NSMenuItem(title: "Run now", action: #selector(onRoutineRun(_:)), keyEquivalent: "")
        run.target = self
        run.representedObject = r.name
        sub.addItem(run)

        let pauseResume = NSMenuItem(title: r.enabled ? "Pause" : "Resume",
                                     action: r.enabled ? #selector(onRoutinePause(_:)) : #selector(onRoutineResume(_:)),
                                     keyEquivalent: "")
        pauseResume.target = self
        pauseResume.representedObject = r.name
        sub.addItem(pauseResume)

        let logs = NSMenuItem(title: "Logs", action: #selector(onRoutineLogs(_:)), keyEquivalent: "")
        logs.target = self
        logs.representedObject = r.name
        sub.addItem(logs)
        return sub
    }

    private func allRoutinesSubmenu(_ routines: [Routine]) -> NSMenu {
        let sub = NSMenu()
        for r in routines {
            let mark = r.lastStatus == "failed" || r.lastStatus == "timeout" || r.overdue ? "! "
                : (r.enabled ? "  " : "· ")
            let when = r.enabled ? (r.nextRunHuman ?? r.schedule) : "paused"
            let item = NSMenuItem(title: "\(mark)\(r.name)  \(when)", action: nil, keyEquivalent: "")
            item.submenu = routineSubmenu(r)
            sub.addItem(item)
        }
        return sub
    }

    private func resourcesSubmenu(_ doctor: DoctorOverview?) -> NSMenu {
        let sub = NSMenu()
        guard let doctor else {
            sub.addItem(disabled(doctorLoaded ? "Doctor unavailable" : "Checking resources…"))
            return sub
        }

        for agent in LocalState.desiredAgents {
            let sync = syncState(agent.id, doctor: doctor)
            let cli = doctor.clis?[agent.id]
            var title = "\(agent.label)  "
            if cli?.installed == false {
                title += "missing CLI"
            } else if let sync {
                title += "\(sync.status)" + (sync.version.map { " · \($0)" } ?? "")
            } else {
                title += "unknown"
            }
            sub.addItem(disabled(title))
        }

        sub.addItem(.separator())
        let open = NSMenuItem(title: "Open ~/.agents", action: #selector(onOpenAgentsHome), keyEquivalent: "")
        open.target = self
        sub.addItem(open)
        return sub
    }

    // MARK: Summaries
    private func routinesSummary(_ routines: [Routine]) -> String {
        if routines.isEmpty && !routinesLoaded { return "  checking…" }
        if routines.isEmpty { return "  none" }

        let next = routines.compactMap { $0.enabled ? $0.nextRunHuman : nil }.first(where: { $0 != "-" }) ?? "—"
        let bad = routines.filter { $0.lastStatus == "failed" || $0.lastStatus == "timeout" || $0.overdue }.count
        let paused = routines.filter { !$0.enabled }.count
        var parts = ["  \(routines.count) routines", "next \(next)"]
        if paused > 0 { parts.append("\(paused) paused") }
        if bad > 0 { parts.append("\(bad) warning\(bad == 1 ? "" : "s")") }
        return parts.joined(separator: " · ")
    }

    private func resourcesSummary(_ doctor: DoctorOverview?) -> String {
        guard let doctor else { return doctorLoaded ? "  unavailable" : "  checking…" }
        let sync = desiredSyncStates(doctor)
        let stale = sync.filter { $0.status == "stale" }.count
        let never = sync.filter { $0.status == "never-synced" }.count
        let missing = LocalState.desiredAgents.filter { doctor.clis?[$0.id]?.installed == false }.count
        var parts: [String] = []
        if stale > 0 { parts.append("\(stale) stale") }
        if never > 0 { parts.append("\(never) never synced") }
        if missing > 0 { parts.append("\(missing) missing CLI") }
        if parts.isEmpty { parts.append("all synced") }
        return "  sync \(parts.joined(separator: " · "))"
    }

    private func warningRows(routines: [Routine], doctor: DoctorOverview?) -> [String] {
        var rows: [String] = []

        let badRoutines = routines.filter { $0.lastStatus == "failed" || $0.lastStatus == "timeout" || $0.overdue }
        if badRoutines.count == 1, let r = badRoutines.first {
            let why = r.overdue ? "overdue" : (r.lastStatus ?? "failed")
            rows.append("Routine \(r.name) \(why)")
        } else if badRoutines.count > 1 {
            rows.append("\(badRoutines.count) routines need attention")
        }

        if let doctor {
            let missing = LocalState.desiredAgents.filter { doctor.clis?[$0.id]?.installed == false }.map(\.label)
            if !missing.isEmpty { rows.append("Missing CLI: \(list(missing))") }

            let never = desiredSyncStates(doctor).filter { $0.status == "never-synced" }.map { LocalState.agentLabel($0.agent) }
            if !never.isEmpty { rows.append("Never synced: \(list(never))") }

            let stale = desiredSyncStates(doctor).filter { $0.status == "stale" }.map { LocalState.agentLabel($0.agent) }
            if !stale.isEmpty { rows.append("Stale resources: \(list(stale))") }

            let drift = doctor.orphans?.filter { LocalState.desiredAgents.map(\.id).contains($0.agent) } ?? []
            if !drift.isEmpty { rows.append("Local-only resources in \(drift.count) agents") }
        }

        return rows
    }

    private func recentSessionTitle(_ session: RecentSession) -> String {
        let agent = LocalState.agentLabel(session.agent).padding(toLength: 11, withPad: " ", startingAt: 0)
        let project = session.project ?? session.cwd.map { ($0 as NSString).lastPathComponent } ?? "session"
        let sid = session.shortId ?? session.id.map { String($0.prefix(8)) } ?? "recent"
        return "  \(agent) \(trim(project, 18)) · \(sid) · \(shortWhen(session.timestamp))"
    }

    private func resourceHint(_ agent: String, doctor: DoctorOverview?) -> String {
        guard let doctor else { return "" }
        if doctor.clis?[agent]?.installed == false { return " · missing CLI" }
        guard let sync = syncState(agent, doctor: doctor) else { return "" }
        switch sync.status {
        case "stale": return " · stale"
        case "never-synced": return " · never synced"
        case "missing": return " · missing resources"
        default: return ""
        }
    }

    private func cliInstalled(_ agent: String, doctor: DoctorOverview?) -> Bool? {
        doctor?.clis?[agent]?.installed
    }

    private func syncState(_ agent: String, doctor: DoctorOverview?) -> DoctorSync? {
        doctor?.sync?.first { $0.agent == agent }
    }

    private func desiredSyncStates(_ doctor: DoctorOverview) -> [DoctorSync] {
        LocalState.desiredAgents.compactMap { agent in
            (doctor.sync ?? []).first { $0.agent == agent.id }
        }
    }

    // MARK: Actions
    @objc private func onNewSession(_ s: NSMenuItem) {
        if let a = s.representedObject as? String { AgentsCLI.newSession(agent: a) }
    }
    @objc private func onRoutineRun(_ s: NSMenuItem) { withName(s, AgentsCLI.routineRun) }
    @objc private func onRoutinePause(_ s: NSMenuItem) { withName(s, AgentsCLI.routinePause) }
    @objc private func onRoutineResume(_ s: NSMenuItem) { withName(s, AgentsCLI.routineResume) }
    @objc private func onRoutineLogs(_ s: NSMenuItem) { withName(s, AgentsCLI.routineLogs) }
    @objc private func onOpenPath(_ s: NSMenuItem) {
        if let p = s.representedObject as? String { AgentsCLI.openPath(p) }
    }
    @objc private func onOpenAgentsHome() { AgentsCLI.openPath("\(AgentsCLI.home)/.agents") }
    @objc private func onStopScheduler() { AgentsCLI.stopDaemon() }
    @objc private func onQuit() { AgentsCLI.menubarDisable(); NSApp.terminate(nil) }

    private func withName(_ s: NSMenuItem, _ fn: (String) -> Void) {
        if let n = s.representedObject as? String { fn(n) }
    }

    // MARK: Helpers
    private func addSectionTitle(_ menu: NSMenu, _ title: String, color: NSColor) {
        let it = disabled(title)
        it.attributedTitle = NSAttributedString(string: title, attributes: [
            .foregroundColor: color,
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
        ])
        menu.addItem(it)
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        it.isEnabled = false
        return it
    }

    private func trim(_ value: String, _ max: Int) -> String {
        if value.count <= max { return value }
        return String(value.prefix(max - 1)) + "…"
    }

    private func shortProfile(_ profile: String) -> String {
        profile.replacingOccurrences(of: "@endpoint-0", with: "")
    }

    private func shortWhen(_ raw: String?) -> String {
        guard let raw, let date = parseIso(raw) else { return "recent" }
        let cal = Calendar.current
        if cal.isDateInToday(date) {
            let f = DateFormatter()
            f.dateStyle = .none
            f.timeStyle = .short
            return "today \(f.string(from: date))"
        }
        if cal.isDateInYesterday(date) { return "yesterday" }
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }

    private func parseIso(_ raw: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: raw) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: raw)
    }

    private func list(_ values: [String], limit: Int = 3) -> String {
        if values.count <= limit { return values.joined(separator: ", ") }
        return values.prefix(limit).joined(separator: ", ") + " +\(values.count - limit)"
    }

    private func dumpMenu(_ menu: NSMenu) {
        FileHandle.standardError.write("=== MENU DUMP (\(menu.numberOfItems) items) ===\n".data(using: .utf8)!)
        for it in menu.items {
            let kind = it.isSeparatorItem ? "----" : it.title
            let sub = it.submenu.map { " [\($0.items.map { $0.title }.joined(separator: " | "))]" } ?? ""
            FileHandle.standardError.write("  \(kind)\(sub)\n".data(using: .utf8)!)
        }
    }
}
