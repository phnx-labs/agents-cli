import AppKit

// Owns the NSStatusItem. The dropdown is actionable-first: what needs the user
// now (attention sessions, a stopped scheduler, failing routines) leads; live
// work follows; setup/health noise collapses into one row. Every health fact
// has exactly one home — no section restates another.
final class StatusItemController: NSObject, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    // Factory Floor status palette (design-system.css). Brand green is accent /
    // selection only — never a status. running/idle/waiting/failed are the four
    // status colors, shared with the full dashboard so this reads as its quick view.
    private let brand = NSColor(srgbRed: 0xa3 / 255.0, green: 0xe6 / 255.0, blue: 0x35 / 255.0, alpha: 1) // #a3e635
    private let run   = NSColor(srgbRed: 0x22 / 255.0, green: 0xc5 / 255.0, blue: 0x5e / 255.0, alpha: 1) // #22C55E
    private let idleC = NSColor(srgbRed: 0x6b / 255.0, green: 0x72 / 255.0, blue: 0x80 / 255.0, alpha: 1) // #6B7280
    private let wait  = NSColor(srgbRed: 0xd4 / 255.0, green: 0xa7 / 255.0, blue: 0x2c / 255.0, alpha: 1) // #D4A72C
    private let fail  = NSColor(srgbRed: 0xef / 255.0, green: 0x44 / 255.0, blue: 0x44 / 255.0, alpha: 1) // #EF4444
    private let info  = NSColor(srgbRed: 0x58 / 255.0, green: 0xa6 / 255.0, blue: 0xff / 255.0, alpha: 1) // #58a6ff (new devices)

    // Cached cheap snapshot for the badge (no teams scan).
    private var badgeSessions: [Session] = []
    // New tailnet devices awaiting Register/Ignore (cheap sentinel-dir read).
    private var badgePending: [PendingDevice] = []

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
            let pending = LocalState.pendingDevices()
            DispatchQueue.main.async {
                self?.badgeSessions = s
                self?.badgePending = pending
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
        let pending = badgePending.count
        if attention > 0 {
            button.attributedTitle = badge("⚠", wait)
        } else if pending > 0 {
            // New devices to review — a blue count (◆) distinct from run/attention.
            button.attributedTitle = badge(" ◆\(pending)", info)
        } else if running > 0 {
            button.attributedTitle = badge(" \(running)", run)
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
        let pending = LocalState.pendingDevices()
        badgeSessions = sessions
        badgePending = pending
        rebuild(menu, sessions: sessions, browserTasks: browserTasks,
                recentSessions: cachedRecentSessions, routines: cachedRoutines,
                doctor: cachedDoctorOverview, daemonPid: daemonPid, pending: pending)
        refreshBadge()
        refreshRoutines()
        refreshRecentSessions()
        refreshDoctorOverview()
    }

    private func rebuild(_ menu: NSMenu, sessions: [Session], browserTasks: [BrowserTask],
                         recentSessions: [RecentSession], routines: [Routine],
                         doctor: DoctorOverview?, daemonPid: Int?, pending: [PendingDevice]) {
        menu.removeAllItems()

        addHeader(menu, sessions: sessions)
        menu.addItem(.separator())

        // What needs me now — rendered only when there's something actionable.
        if addNeedsAttention(menu, sessions: sessions, routines: routines, daemonPid: daemonPid) {
            menu.addItem(.separator())
        }

        // New tailnet devices to approve — only when there are any.
        if addNewDevices(menu, pending: pending) {
            menu.addItem(.separator())
        }

        addNewSession(menu)
        menu.addItem(.separator())

        // Live work — skipped entirely on a calm, idle machine.
        let live = sessions.filter { $0.status == .running || $0.status == .idle || $0.status == .attention }
        if !live.isEmpty || !browserTasks.isEmpty {
            addActive(menu, live: live, browserTasks: browserTasks)
            menu.addItem(.separator())
        }

        addRecent(menu, recentSessions: recentSessions)
        menu.addItem(.separator())

        addRoutinesRow(menu, routines: routines)
        addSetup(menu, doctor: doctor)

        menu.addItem(.separator())
        addFooter(menu, daemonPid: daemonPid)
    }

    // MARK: Sections
    private func addHeader(_ menu: NSMenu, sessions: [Session]) {
        let attn = sessions.filter { $0.status == .attention }.count
        let running = sessions.filter { $0.status == .running }.count
        let status: String
        let color: NSColor
        if attn > 0 {
            status = "⚠ \(attn) needs you"
            color = wait
        } else if running > 0 {
            status = "\u{25CF} \(running) running"
            color = run
        } else {
            status = "idle"
            color = idleC
        }

        let left = "agents-cli"
        let width = max(left.count + 3, 44 - status.count)
        let title = left.padding(toLength: width, withPad: " ", startingAt: 0) + status
        let item = disabled(title)
        let attr = NSMutableAttributedString(string: title, attributes: [
            .foregroundColor: NSColor.labelColor,
            .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .semibold),
        ])
        let range = (title as NSString).range(of: status, options: .backwards)
        if range.location != NSNotFound {
            attr.addAttributes([
                .foregroundColor: color,
                .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .bold),
            ], range: range)
        }
        item.attributedTitle = attr
        menu.addItem(item)
    }

    // Returns true if anything was rendered (caller adds the trailing separator).
    // Order mirrors the Factory Floor phase rank: waiting first, then failed.
    private func addNeedsAttention(_ menu: NSMenu, sessions: [Session],
                                   routines: [Routine], daemonPid: Int?) -> Bool {
        var rows: [(String, NSColor, String, NSMenu?)] = []   // glyph, color, text, submenu

        for s in sessions where s.status == .attention {
            let detail = s.detail.isEmpty ? "awaiting input" : trim(s.detail, 34)
            rows.append(("⚠", wait, "\(LocalState.agentLabel(s.agent)) · \(s.repo) — \(detail)",
                         s.cwd.map { revealSubmenu($0) }))
        }

        if daemonPid == nil && !routines.isEmpty {
            let sub = NSMenu()
            let start = NSMenuItem(title: "Start scheduler", action: #selector(onStartScheduler), keyEquivalent: "")
            start.target = self
            sub.addItem(start)
            sub.addItem(.separator())
            let next = routines.compactMap { $0.enabled ? $0.nextRunHuman : nil }.first(where: { $0 != "-" }) ?? "—"
            sub.addItem(disabled("\(routines.count) routines waiting · next \(next)"))
            rows.append(("⚠", wait, "Scheduler stopped — routines won’t run", sub))
        }

        let bad = routines.filter { $0.lastStatus == "failed" || $0.lastStatus == "timeout" || $0.overdue }
        if bad.count == 1, let r = bad.first {
            let why = r.overdue ? "overdue" : (r.lastStatus ?? "failed")
            rows.append(("✕", fail, "Routine \(r.name) \(why)", allRoutinesSubmenu(bad)))
        } else if bad.count > 1 {
            rows.append(("✕", fail, "\(bad.count) routines failing", allRoutinesSubmenu(bad)))
        }

        if rows.isEmpty { return false }
        addSectionTitle(menu, "⚠ NEEDS YOU", color: wait)
        for (glyph, color, text, sub) in rows {
            let it = statusRow(glyph, color, text)
            it.submenu = sub
            menu.addItem(it)
        }
        return true
    }

    // Returns true if anything was rendered (caller adds the trailing separator).
    // One row per newly-discovered tailnet node, each with a Register / Ignore
    // submenu that shells `agents devices register|ignore` (which also clear the
    // sentinel, so the row disappears on the next poll).
    private func addNewDevices(_ menu: NSMenu, pending: [PendingDevice]) -> Bool {
        if pending.isEmpty { return false }
        addSectionTitle(menu, "◆ NEW DEVICES (\(pending.count))", color: info)
        for d in pending {
            let sub = NSMenu()
            let reg = NSMenuItem(title: "Register", action: #selector(onRegisterDevice(_:)), keyEquivalent: "")
            reg.target = self
            reg.representedObject = d.name
            sub.addItem(reg)
            let ign = NSMenuItem(title: "Ignore", action: #selector(onIgnoreDevice(_:)), keyEquivalent: "")
            ign.target = self
            ign.representedObject = d.name
            sub.addItem(ign)
            let row = statusRow("◆", info, "\(d.name) — \(d.platform)")
            row.submenu = sub
            menu.addItem(row)
        }
        return true
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

    private func addActive(_ menu: NSMenu, live: [Session], browserTasks: [BrowserTask]) {
        let running = live.filter { $0.status == .running }.count
        let idle = live.filter { $0.status == .idle }.count
        var title = "ACTIVE"
        if running > 0 || idle > 0 { title += "  ·  \(running) running · \(idle) idle" }
        addSectionTitle(menu, title, color: .secondaryLabelColor)

        for s in live {
            let glyph = s.status == .attention ? "⚠" : (s.status == .running ? "●" : "◐")
            let color = s.status == .attention ? wait : (s.status == .running ? run : idleC)
            let detail = s.detail.isEmpty ? "" : " — \(trim(s.detail, 32))"
            let row = statusRow(glyph, color, "\(LocalState.agentLabel(s.agent))   \(s.repo)\(detail)")
            if let cwd = s.cwd { row.submenu = revealSubmenu(cwd) }
            menu.addItem(row)
        }
        for task in browserTasks {
            let tabs = task.tabCount == 1 ? "1 tab" : "\(task.tabCount) tabs"
            let row = statusRow("◦", idleC, "Browser   \(trim(task.name, 24)) · \(shortProfile(task.profile)) · \(tabs)")
            row.submenu = browserTaskSubmenu(task)
            menu.addItem(row)
        }
    }

    private func addRecent(_ menu: NSMenu, recentSessions: [RecentSession]) {
        addSectionTitle(menu, "RECENT", color: .secondaryLabelColor)
        let visible = Array(recentSessions.filter {
            let id = LocalState.normalizeAgent($0.agent)
            return LocalState.desiredAgents.contains { $0.id == id }
        }.prefix(3))
        if visible.isEmpty {
            menu.addItem(disabled(recentSessionsLoaded ? "  No recent sessions" : "  Recent sessions checking…"))
            return
        }
        for session in visible {
            let item = NSMenuItem(title: recentSessionTitle(session), action: nil, keyEquivalent: "")
            item.submenu = recentSessionSubmenu(session)
            menu.addItem(item)
        }
    }

    private func addRoutinesRow(_ menu: NSMenu, routines: [Routine]) {
        let detail: String
        if routines.isEmpty {
            detail = routinesLoaded ? "none" : "checking…"
        } else {
            let next = routines.compactMap { $0.enabled ? $0.nextRunHuman : nil }.first(where: { $0 != "-" }) ?? "—"
            let paused = routines.filter { !$0.enabled }.count
            var parts = ["\(routines.count)", "next \(next)"]
            if paused > 0 { parts.append("\(paused) paused") }
            detail = parts.joined(separator: " · ")
        }
        let item = NSMenuItem(title: "\(pad("Routines"))\(detail)", action: nil, keyEquivalent: "")
        if !routines.isEmpty { item.submenu = allRoutinesSubmenu(routines) }
        menu.addItem(item)
    }

    private func addSetup(_ menu: NSMenu, doctor: DoctorOverview?) {
        let item = NSMenuItem(title: "\(pad("Setup"))\(setupSummary(doctor))", action: nil, keyEquivalent: "")
        item.submenu = setupSubmenu(doctor)
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

    // MARK: Submenus
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

    private func setupSummary(_ doctor: DoctorOverview?) -> String {
        guard let doctor else { return doctorLoaded ? "unavailable" : "checking…" }
        let sync = desiredSyncStates(doctor)
        let stale = sync.filter { $0.status == "stale" }.count
        let never = sync.filter { $0.status == "never-synced" }.count
        let missing = LocalState.desiredAgents.filter { doctor.clis?[$0.id]?.installed == false }.count
        var parts: [String] = []
        if missing > 0 { parts.append("\(missing) not installed") }
        if stale > 0 { parts.append("\(stale) stale") }
        if never > 0 { parts.append("\(never) unsynced") }
        return parts.isEmpty ? "all set" : parts.joined(separator: " · ")
    }

    private func setupSubmenu(_ doctor: DoctorOverview?) -> NSMenu {
        let sub = NSMenu()
        guard let doctor else {
            sub.addItem(disabled(doctorLoaded ? "Doctor unavailable" : "Checking resources…"))
            return sub
        }
        let notInstalled = LocalState.desiredAgents.filter { doctor.clis?[$0.id]?.installed == false }
        if !notInstalled.isEmpty {
            sub.addItem(disabled("Not installed"))
            for a in notInstalled { sub.addItem(disabled("  \(a.label)")) }
        }
        let needsSync = LocalState.desiredAgents.compactMap { a -> (MenuAgent, DoctorSync)? in
            guard let s = syncState(a.id, doctor: doctor),
                  s.status == "stale" || s.status == "never-synced" else { return nil }
            return (a, s)
        }
        if !needsSync.isEmpty {
            sub.addItem(disabled("Resources"))
            for (a, s) in needsSync {
                sub.addItem(disabled("  \(a.label)  \(s.status)\(s.version.map { " · \($0)" } ?? "")"))
            }
        }
        if notInstalled.isEmpty && needsSync.isEmpty {
            sub.addItem(disabled("All agents installed & synced"))
        }
        sub.addItem(.separator())
        let doctorItem = NSMenuItem(title: "Run agents doctor", action: #selector(onRunDoctor), keyEquivalent: "")
        doctorItem.target = self
        sub.addItem(doctorItem)
        let open = NSMenuItem(title: "Open ~/.agents", action: #selector(onOpenAgentsHome), keyEquivalent: "")
        open.target = self
        sub.addItem(open)
        return sub
    }

    private func recentSessionTitle(_ session: RecentSession) -> String {
        let agent = LocalState.agentLabel(session.agent).padding(toLength: 9, withPad: " ", startingAt: 0)
        let project = session.project ?? session.cwd.map { ($0 as NSString).lastPathComponent } ?? "session"
        let label: String
        if let topic = session.topic, !topic.isEmpty {
            label = "“\(trim(topic, 22))”"
        } else {
            label = session.shortId ?? session.id.map { String($0.prefix(8)) } ?? "recent"
        }
        return "  \(agent) \(trim(project, 14)) · \(label) · \(shortWhen(session.timestamp))"
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
    @objc private func onStartScheduler() { AgentsCLI.startScheduler() }
    @objc private func onRunDoctor() { AgentsCLI.runDoctor() }

    @objc private func onRegisterDevice(_ sender: NSMenuItem) {
        withName(sender) { name in
            AgentsCLI.deviceRegister(name)
            badgePending.removeAll { $0.name == name } // optimistic; CLI clears the sentinel
            refreshBadge()
        }
    }
    @objc private func onIgnoreDevice(_ sender: NSMenuItem) {
        withName(sender) { name in
            AgentsCLI.deviceIgnore(name)
            badgePending.removeAll { $0.name == name }
            refreshBadge()
        }
    }
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

    // A row whose leading status glyph is tinted with the Factory palette while
    // the label stays default — mirrors the dashboard's color-coded status dots.
    private func statusRow(_ glyph: String, _ glyphColor: NSColor, _ rest: String) -> NSMenuItem {
        let title = "  \(glyph) \(rest)"
        let it = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let attr = NSMutableAttributedString(string: title, attributes: [
            .font: NSFont.menuFont(ofSize: 0),
            .foregroundColor: NSColor.labelColor,
        ])
        let r = (title as NSString).range(of: glyph)
        if r.location != NSNotFound {
            attr.addAttribute(.foregroundColor, value: glyphColor, range: r)
        }
        it.attributedTitle = attr
        return it
    }

    // Left-pad a single-row label so its value column lines up (Routines / Setup).
    private func pad(_ label: String) -> String {
        label.padding(toLength: max(label.count + 1, 10), withPad: " ", startingAt: 0)
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
            return f.string(from: date)
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

    private func dumpMenu(_ menu: NSMenu) {
        FileHandle.standardError.write("=== MENU DUMP (\(menu.numberOfItems) items) ===\n".data(using: .utf8)!)
        for it in menu.items {
            let kind = it.isSeparatorItem ? "----" : it.title
            let sub = it.submenu.map { " [\($0.items.map { $0.title }.joined(separator: " | "))]" } ?? ""
            FileHandle.standardError.write("  \(kind)\(sub)\n".data(using: .utf8)!)
        }
    }
}
