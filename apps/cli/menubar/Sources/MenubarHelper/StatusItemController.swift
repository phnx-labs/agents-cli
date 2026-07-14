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

    // The engine's active-session list (`sessions --active --local --json`) —
    // authoritative coverage (tmux/IDE/headless), but costs seconds, so it rides
    // the same warm-cache pattern as routines: refreshed off-path, rendered from
    // cache when the menu opens. Until first load, the cheap live-terminals view
    // fills in.
    private var cachedActiveSessions: [ActiveSession] = []
    private var activeSessionsLoaded = false
    private var activeSessionsInFlight = false
    private var activeSessionsFetchedAt: Date?

    private var cachedDoctorOverview: DoctorOverview?
    private var doctorLoaded = false
    private var doctorInFlight = false
    private var doctorFetchedAt: Date?

    // RUSH-1415: watchdog auto-nudge. Each tick runs `agents watchdog`; when the
    // toggle (watchdogEnabled) is on it injects "Continue." into stalled splits.
    private var cachedWatchdog: WatchdogTick?
    private var watchdogEnabled = false
    private var watchdogInFlight = false
    private var watchdogFetchedAt: Date?

    // Density: rich rows carry the session title / question / routine schedule
    // inline; compact folds them to one-liners. `auto` (the default) is rich
    // while something needs the user and compact on a calm machine.
    private enum Density: String, CaseIterable {
        case auto, rich, compact
        var label: String {
            switch self {
            case .auto: return "Auto"
            case .rich: return "Rich"
            case .compact: return "Compact"
            }
        }
    }

    private var densitySetting: Density {
        get {
            // Env override so dump mode can probe a fixed density.
            if let env = ProcessInfo.processInfo.environment["MENUBAR_DENSITY"],
               let d = Density(rawValue: env) { return d }
            return Density(rawValue: UserDefaults.standard.string(forKey: "menubarDensity") ?? "") ?? .auto
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "menubarDensity") }
    }

    private func isRich(attention: Int) -> Bool {
        switch densitySetting {
        case .rich: return true
        case .compact: return false
        case .auto: return attention > 0
        }
    }

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
                guard let self else { return }
                self.badgeSessions = self.merged(s)
                self.badgePending = pending
                self.refreshBadge()
            }
        }
        refreshRoutines()
        refreshRecentSessions()
        refreshActiveSessions()
        refreshDoctorOverview()
        refreshWatchdog()
    }

    private func loadDumpCaches() {
        cachedRoutines = AgentsCLI.routines()
        routinesLoaded = true
        routinesFetchedAt = Date()

        cachedRecentSessions = AgentsCLI.recentSessions(limit: 6)
        recentSessionsLoaded = true
        recentSessionsFetchedAt = Date()

        cachedActiveSessions = AgentsCLI.activeSessions()
        activeSessionsLoaded = true
        activeSessionsFetchedAt = Date()

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

    private func refreshActiveSessions() {
        if activeSessionsInFlight { return }
        if let t = activeSessionsFetchedAt, Date().timeIntervalSince(t) < 30 { return }
        activeSessionsInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let a = AgentsCLI.activeSessions()
            DispatchQueue.main.async {
                guard let self else { return }
                self.cachedActiveSessions = a
                self.activeSessionsLoaded = true
                self.activeSessionsFetchedAt = Date()
                self.activeSessionsInFlight = false
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

    // RUSH-1415: run one watchdog tick each poll. Reads the enable sentinel first,
    // then ticks with nudge=enabled so auto-nudge fires only when the toggle is on
    // (detect-only otherwise). No time-throttle: nudging must be timely, and the
    // CLI's cooldown ledger already prevents re-nudging the same split.
    private func refreshWatchdog() {
        if watchdogInFlight { return }
        // Throttle like the sibling refreshers: a 30s floor keeps this well under
        // the 5m stall threshold (still timely) while cutting the two subprocess
        // spawns per tick from 6x/min to ~2x/min on a battery-sensitive helper.
        if let t = watchdogFetchedAt, Date().timeIntervalSince(t) < 30 { return }
        watchdogInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let enabled = AgentsCLI.watchdogStatus()?.enabled ?? false
            let tick = AgentsCLI.watchdogTick(nudge: enabled)
            DispatchQueue.main.async {
                guard let self else { return }
                self.watchdogEnabled = enabled
                self.cachedWatchdog = tick
                self.watchdogFetchedAt = Date()
                self.watchdogInFlight = false
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
        badgeSessions = merged(sessions)
        badgePending = pending
        rebuild(menu, sessions: sessions, browserTasks: browserTasks,
                recentSessions: cachedRecentSessions, routines: cachedRoutines,
                doctor: cachedDoctorOverview, daemonPid: daemonPid, pending: pending)
        refreshBadge()
        refreshRoutines()
        refreshRecentSessions()
        refreshActiveSessions()
        refreshDoctorOverview()
        refreshWatchdog()
    }

    // The one rule: attention floats to the top triage strip (wait-time sorted,
    // cross-project) and is never nested inside a project group; live work
    // groups by repo below; routines / tickets / recents stay dedicated,
    // glanceable sections; setup + watchdog noise collapses into one System row.
    private func rebuild(_ menu: NSMenu, sessions: [Session], browserTasks: [BrowserTask],
                         recentSessions: [RecentSession], routines: [Routine],
                         doctor: DoctorOverview?, daemonPid: Int?, pending: [PendingDevice]) {
        menu.removeAllItems()

        // Prefer the engine's active list once the warm cache has it — full
        // coverage (tmux/IDE/headless), correct running/idle. The cheap
        // live-terminals view (`sessions` param) covers the cold start.
        let sessions = merged(sessions)

        // Auto density keys off the FULL needs-you set — blocked sessions plus
        // failing/overdue routines and a stopped scheduler — so the menu is rich
        // whenever the triage strip has anything to say, not only when a session
        // is blocked.
        let attention = sessions.filter { $0.status == .attention }.count
        let routinesFailing = routines.contains { $0.lastStatus == "failed" || $0.lastStatus == "timeout" || $0.overdue }
        let schedulerStopped = daemonPid == nil && !routines.isEmpty
        let needsYou = attention + (routinesFailing ? 1 : 0) + (schedulerStopped ? 1 : 0)
        let rich = isRich(attention: needsYou)

        addHeader(menu, sessions: sessions)
        menu.addItem(.separator())

        // What needs me now — rendered only when there's something actionable.
        if addNeedsAttention(menu, sessions: sessions, routines: routines,
                             daemonPid: daemonPid, rich: rich) {
            menu.addItem(.separator())
        }

        // New tailnet devices to approve — only when there are any.
        if addNewDevices(menu, pending: pending) {
            menu.addItem(.separator())
        }

        addNewSession(menu)
        menu.addItem(.separator())

        // Live work grouped by repo — attention rows live in the triage strip,
        // not here. Skipped entirely on a calm, idle machine.
        let live = sessions.filter { $0.status == .running || $0.status == .idle }
        if !live.isEmpty || !browserTasks.isEmpty {
            addActive(menu, live: live, browserTasks: browserTasks, rich: rich)
            menu.addItem(.separator())
        }

        addRoutines(menu, routines: routines, rich: rich)
        menu.addItem(.separator())

        // Tickets filed via the quick-issue bar (Cmd-Shift-O), clickable → open.
        if addRecentTickets(menu) {
            menu.addItem(.separator())
        }

        addRecent(menu, recentSessions: recentSessions, rich: rich)
        menu.addItem(.separator())

        addSystem(menu, doctor: doctor)

        menu.addItem(.separator())
        addFooter(menu, daemonPid: daemonPid)
    }

    // Swap the cheap terminal rows for the engine's list once the warm cache
    // has it. The engine list also carries teams/cloud contexts — those are
    // dropped here because the cheap sources own them (titles from meta.json /
    // tasks.db that the engine payload lacks); keeping both would double-count.
    private func merged(_ cheap: [Session]) -> [Session] {
        guard activeSessionsLoaded, !cachedActiveSessions.isEmpty else { return cheap }
        let engineTerminals = cachedActiveSessions.filter {
            $0.context != "teams" && $0.context != "cloud"
        }
        return LocalState.sessions(fromActive: engineTerminals)
            + cheap.filter { $0.context != "terminal" }
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
    // Triage strip: blocked sessions sorted by wait-time (most-stalled first,
    // regardless of repo), each carrying the actual question it's waiting on
    // plus how long it's been waiting. Waiting first, then failed.
    private func addNeedsAttention(_ menu: NSMenu, sessions: [Session],
                                   routines: [Routine], daemonPid: Int?, rich: Bool) -> Bool {
        var rows: [(String, NSColor, String, NSMenu?)] = []   // glyph, color, text, submenu

        let blocked = sessions.filter { $0.status == .attention }.sorted {
            ($0.attentionSinceMs ?? .greatestFiniteMagnitude) < ($1.attentionSinceMs ?? .greatestFiniteMagnitude)
        }
        for s in blocked {
            let q = s.question.isEmpty ? "awaiting input" : trim(s.question, rich ? 48 : 34)
            var text = "\(LocalState.agentLabel(s.agent)) · \(s.repo) — \(q)"
            if let since = s.attentionSinceMs { text += "  ·  \(elapsedShort(since))" }
            rows.append(("⚠", wait, text, s.cwd.map { revealSubmenu($0) }))
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
        addSectionTitle(menu, "⚠ NEEDS YOU (\(rows.count))", color: wait)
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

    // Live work grouped by repo: one `ACTIVE · <repo>` header per project, the
    // repo's sessions clustered under it. Rich rows carry the session's own
    // title inline (the repo lives in the header, so rows don't repeat it).
    private func addActive(_ menu: NSMenu, live: [Session], browserTasks: [BrowserTask], rich: Bool) {
        let groups = Dictionary(grouping: live) { $0.repo.isEmpty ? "other" : $0.repo }
        for (repo, group) in groups.sorted(by: { $0.key.lowercased() < $1.key.lowercased() }) {
            let running = group.filter { $0.status == .running }.count
            let idle = group.count - running
            var title = "ACTIVE · \(repo)"
            var counts: [String] = []
            if running > 0 { counts.append("\(running) running") }
            if idle > 0 { counts.append("\(idle) idle") }
            if !counts.isEmpty { title += "  ·  " + counts.joined(separator: " · ") }
            addSectionTitle(menu, title, color: .secondaryLabelColor)

            // Running rows always render; idle rows cap at 3 per repo (the
            // header carries the true counts) so a big idle fleet can't wall
            // the menu.
            let ordered = group.sorted { a, b in
                (a.status == .running ? 0 : 1) < (b.status == .running ? 0 : 1)
            }
            var idleShown = 0
            for s in ordered {
                if s.status != .running {
                    if idleShown >= 3 { continue }
                    idleShown += 1
                }
                let glyph = s.status == .running ? "●" : "◐"
                let color = s.status == .running ? run : idleC
                let detail = (rich && !s.title.isEmpty) ? " — \(trim(s.title, 36))" : ""
                let row = statusRow(glyph, color, "\(LocalState.agentLabel(s.agent))\(detail)")
                if let cwd = s.cwd { row.submenu = revealSubmenu(cwd) }
                menu.addItem(row)
            }
        }
        if !browserTasks.isEmpty {
            addSectionTitle(menu, "ACTIVE · Browser", color: .secondaryLabelColor)
            for task in browserTasks {
                let tabs = task.tabCount == 1 ? "1 tab" : "\(task.tabCount) tabs"
                let row = statusRow("◦", idleC, "\(trim(task.name, 24)) · \(shortProfile(task.profile)) · \(tabs)")
                row.submenu = browserTaskSubmenu(task)
                menu.addItem(row)
            }
        }
    }

    private func addRecent(_ menu: NSMenu, recentSessions: [RecentSession], rich: Bool) {
        let visible = Array(recentSessions.filter {
            let id = LocalState.normalizeAgent($0.agent)
            return LocalState.desiredAgents.contains { $0.id == id }
        }.prefix(3))
        // Compact: the long tail folds behind one row instead of three.
        if !rich {
            let item = NSMenuItem(title: pad("Recent") + (visible.isEmpty ? "none" : "\(visible.count) sessions"),
                                  action: nil, keyEquivalent: "")
            if !visible.isEmpty {
                let sub = NSMenu()
                for session in visible {
                    let it = NSMenuItem(title: recentSessionTitle(session), action: nil, keyEquivalent: "")
                    it.submenu = recentSessionSubmenu(session)
                    sub.addItem(it)
                }
                item.submenu = sub
            }
            menu.addItem(item)
            return
        }
        addSectionTitle(menu, "RECENT", color: .secondaryLabelColor)
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

    // Tickets filed via the quick-issue bar. Returns false (renders nothing) when
    // the ledger is empty. Each row opens the ticket in Linear on click.
    private func addRecentTickets(_ menu: NSMenu) -> Bool {
        let tickets = RecentTickets.load(limit: 5)
        guard !tickets.isEmpty else { return false }
        addSectionTitle(menu, "RECENT TICKETS", color: .secondaryLabelColor)
        for t in tickets {
            let clickable = t.url != nil
            let item = NSMenuItem(title: "  \(t.id)  \(trim(t.title, 42))",
                                  action: clickable ? #selector(onOpenPath(_:)) : nil,
                                  keyEquivalent: "")
            if clickable {
                item.target = self
                item.representedObject = t.url
                item.toolTip = t.url
            }
            menu.addItem(item)
        }
        return true
    }

    // Routines stay a dedicated, glanceable section. Compact: one summary row
    // (submenu = all). Rich: a section with the next few upcoming + any failing
    // routine inline, then "All routines…" for the rest.
    private func addRoutines(_ menu: NSMenu, routines: [Routine], rich: Bool) {
        let summary: String
        if routines.isEmpty {
            summary = routinesLoaded ? "none" : "checking…"
        } else {
            let next = routines.compactMap { $0.enabled ? $0.nextRunHuman : nil }.first(where: { $0 != "-" }) ?? "—"
            let paused = routines.filter { !$0.enabled }.count
            var parts = ["\(routines.count)", "next \(next)"]
            if paused > 0 { parts.append("\(paused) paused") }
            summary = parts.joined(separator: " · ")
        }

        if !rich || routines.isEmpty {
            let item = NSMenuItem(title: "\(pad("Routines"))\(summary)", action: nil, keyEquivalent: "")
            if !routines.isEmpty { item.submenu = allRoutinesSubmenu(routines) }
            menu.addItem(item)
            return
        }

        addSectionTitle(menu, "ROUTINES · \(summary)", color: .secondaryLabelColor)
        let failing = routines.filter { $0.lastStatus == "failed" || $0.lastStatus == "timeout" || $0.overdue }
        let upcoming = routines
            .filter { r in r.enabled && !failing.contains(where: { $0.name == r.name }) && r.nextRun != nil }
            .sorted { ($0.nextRun ?? "") < ($1.nextRun ?? "") }
            .prefix(3)
        for r in upcoming {
            let row = statusRow("◔", idleC, "\(r.name)  \(r.nextRunHuman ?? r.schedule)")
            row.submenu = routineSubmenu(r)
            menu.addItem(row)
        }
        for r in failing {
            let why = r.overdue ? "overdue" : (r.lastStatus ?? "failed")
            let row = statusRow("✕", fail, "\(r.name)  \(why)")
            row.submenu = routineSubmenu(r)
            menu.addItem(row)
        }
        let all = NSMenuItem(title: "  All routines…", action: nil, keyEquivalent: "")
        all.submenu = allRoutinesSubmenu(routines)
        menu.addItem(all)
    }

    // Setup + watchdog collapsed into one System row — the health noise lives in
    // the submenu, not the flat tail. The auto-nudge toggle keeps working there.
    private func addSystem(_ menu: NSMenu, doctor: DoctorOverview?) {
        let nudge = "auto-nudge \(watchdogSummary())"
        let item = NSMenuItem(title: "\(pad("System"))\(setupSummary(doctor)) · \(nudge)",
                              action: nil, keyEquivalent: "")
        let sub = setupSubmenu(doctor)
        sub.addItem(.separator())
        let toggle = NSMenuItem(title: "Auto-nudge stalled sessions",
                                action: #selector(onToggleWatchdog), keyEquivalent: "")
        toggle.target = self
        toggle.state = watchdogEnabled ? .on : .off
        sub.addItem(toggle)
        item.submenu = sub
        menu.addItem(item)
    }

    private func watchdogSummary() -> String {
        guard let c = cachedWatchdog?.counts, c.stalled > 0 else {
            return watchdogEnabled ? "on" : "off"
        }
        let action = watchdogEnabled ? "\(c.nudged) nudged" : "detect-only"
        return "\(c.stalled) stalled · \(action)"
    }

    private func addFooter(_ menu: NSMenu, daemonPid: Int?) {
        let density = NSMenuItem(title: "Density: \(densitySetting.label)",
                                 action: #selector(onCycleDensity), keyEquivalent: "")
        density.target = self
        menu.addItem(density)

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
    // RUSH-1415: flip global auto-nudge. Optimistically update local state so the
    // checkmark reflects immediately; the next tick re-reads the sentinel as truth.
    @objc private func onToggleWatchdog() {
        watchdogEnabled.toggle()
        AgentsCLI.watchdogSetEnabled(watchdogEnabled)
    }
    // Cycle auto → rich → compact; the next menu open renders at the new density.
    @objc private func onCycleDensity() {
        let all = Density.allCases
        let idx = all.firstIndex(of: densitySetting) ?? 0
        densitySetting = all[(idx + 1) % all.count]
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

    // "3m" / "1h 12m" / "2d" — how long a session has been waiting (sentinel mtime).
    private func elapsedShort(_ sinceMs: Double) -> String {
        let mins = max(0, Int((LocalState.nowMs() - sinceMs) / 60_000))
        if mins < 1 { return "now" }
        if mins < 60 { return "\(mins)m" }
        let hours = mins / 60
        if hours < 24 { return mins % 60 == 0 ? "\(hours)h" : "\(hours)h \(mins % 60)m" }
        return "\(hours / 24)d"
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
