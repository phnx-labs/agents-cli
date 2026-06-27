import AppKit

// Owns the NSStatusItem. Layout: NEEDS YOU (attention) pinned on top, then a +New
// launcher, then the agent roster (per-agent running/idle counts), then a single
// routines line. All session data is read directly from disk (LocalState) — no
// CLI, no re-index — so the menu populates instantly on click.
final class StatusItemController: NSObject, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let accent = NSColor(red: 0x39 / 255.0, green: 0xd3 / 255.0, blue: 0x53 / 255.0, alpha: 1) // #39d353
    private let alert = NSColor.systemRed

    // Cached cheap snapshot for the badge (no teams scan).
    private var badgeSessions: [Session] = []

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
            let probe = NSMenu()
            menuWillOpen(probe)
            FileHandle.standardError.write("=== MENU DUMP (\(probe.numberOfItems) items) ===\n".data(using: .utf8)!)
            for it in probe.items {
                let kind = it.isSeparatorItem ? "----" : it.title
                let sub = it.submenu.map { " [\($0.items.map { $0.title }.joined(separator: " | "))]" } ?? ""
                FileHandle.standardError.write("  \(kind)\(sub)\n".data(using: .utf8)!)
            }
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
    }

    private func refreshBadge() {
        guard let button = statusItem.button else { return }
        let attention = badgeSessions.filter { $0.status == .attention }.count
        let running = badgeSessions.filter { $0.status == .running }.count
        if attention > 0 {
            button.attributedTitle = badge("!", alert)       // needs you — highest priority
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

    // MARK: - Menu (rebuilt on open against fresh, full state)
    func menuWillOpen(_ menu: NSMenu) {
        let sessions = LocalState.sessions(includeTeams: true)
        let installed = LocalState.installedAgents()
        let routines = AgentsCLI.routines()
        let daemonPid = AgentsCLI.daemonPid()
        badgeSessions = sessions
        rebuild(menu, sessions: sessions, installed: installed, routines: routines, daemonPid: daemonPid)
        refreshBadge()
    }

    private func rebuild(_ menu: NSMenu, sessions: [Session], installed: [String], routines: [Routine], daemonPid: Int?) {
        menu.removeAllItems()

        // NEEDS YOU — attention sessions + failed/overdue routines, pinned on top.
        let needAttention = sessions.filter { $0.status == .attention }
        let badRoutines = routines.filter { $0.lastStatus == "failed" || $0.lastStatus == "timeout" || $0.overdue }
        if !needAttention.isEmpty || !badRoutines.isEmpty {
            addSectionTitle(menu, "NEEDS YOU (\(needAttention.count + badRoutines.count))", color: alert)
            for s in needAttention {
                let item = NSMenuItem(title: "  ! \(s.agent)  \(s.repo)  awaiting input", action: nil, keyEquivalent: "")
                if let cwd = s.cwd { item.submenu = revealSubmenu(cwd) }
                menu.addItem(item)
            }
            for r in badRoutines {
                let why = r.overdue ? "overdue" : (r.lastStatus ?? "failed")
                let item = NSMenuItem(title: "  ! routine \(r.name)  \(why)", action: nil, keyEquivalent: "")
                item.submenu = routineSubmenu(r)
                menu.addItem(item)
            }
            menu.addItem(.separator())
        }

        // + New session.
        let newItem = NSMenuItem(title: "New session", action: nil, keyEquivalent: "n")
        let newSub = NSMenu()
        for agent in installed {
            let it = NSMenuItem(title: agent, action: #selector(onNewSession(_:)), keyEquivalent: "")
            it.target = self; it.representedObject = agent
            newSub.addItem(it)
        }
        newItem.submenu = newSub
        menu.addItem(newItem)
        menu.addItem(.separator())

        // Agent roster — per-agent counts; only show agents that are installed.
        let running = sessions.filter { $0.status == .running }.count
        let idle = sessions.filter { $0.status == .idle }.count
        addSectionTitle(menu, "AGENTS  ·  \(running) running · \(idle) idle", color: .secondaryLabelColor)
        for agent in installed {
            let mine = sessions.filter { $0.agent == agent }
            let item = NSMenuItem(title: rosterRow(agent: agent, sessions: mine), action: nil, keyEquivalent: "")
            item.submenu = rosterSubmenu(agent: agent, sessions: mine)
            menu.addItem(item)
        }
        menu.addItem(.separator())

        // Routines — one compact line (secondary).
        let routineLine: String
        if routines.isEmpty {
            routineLine = "routines   none"
        } else {
            let next = routines.compactMap { $0.enabled ? $0.nextRunHuman : nil }.first(where: { $0 != "-" }) ?? "—"
            let failed = badRoutines.count
            routineLine = "routines   next \(next)" + (failed > 0 ? "  ·  \(failed) failed" : "")
        }
        let routinesItem = NSMenuItem(title: routineLine, action: nil, keyEquivalent: "")
        if !routines.isEmpty { routinesItem.submenu = allRoutinesSubmenu(routines) }
        menu.addItem(routinesItem)
        menu.addItem(.separator())

        // Footer.
        if daemonPid != nil {
            let stop = NSMenuItem(title: "Stop scheduler", action: #selector(onStopScheduler), keyEquivalent: "")
            stop.target = self
            menu.addItem(stop)
        }
        let quit = NSMenuItem(title: "Quit menu bar", action: #selector(onQuit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    // MARK: Row builders
    private func rosterRow(agent: String, sessions: [Session]) -> String {
        let attn = sessions.filter { $0.status == .attention }.count
        let run = sessions.filter { $0.status == .running }.count
        let idle = sessions.filter { $0.status == .idle }.count
        let name = agent.padding(toLength: 11, withPad: " ", startingAt: 0)
        if attn > 0 { return "\(name) ! \(attn) awaiting input" }
        if run > 0 { return "\(name) ● \(run) running" + (idle > 0 ? " · \(idle) idle" : "") }
        if idle > 0 { return "\(name) ○ \(idle) idle" }
        return "\(name) ○ idle"
    }

    private func rosterSubmenu(agent: String, sessions: [Session]) -> NSMenu {
        let sub = NSMenu()
        for s in sessions {
            let mark = s.status == .attention ? "! " : (s.status == .running ? "● " : "○ ")
            let detail = s.detail.isEmpty ? "" : "  ·  \(s.detail)"
            let row = NSMenuItem(title: "\(mark)\(s.repo)\(detail)", action: nil, keyEquivalent: "")
            if let cwd = s.cwd { row.submenu = revealSubmenu(cwd) }
            sub.addItem(row)
        }
        if !sessions.isEmpty { sub.addItem(.separator()) }
        let new = NSMenuItem(title: "New \(agent) session", action: #selector(onNewSession(_:)), keyEquivalent: "")
        new.target = self; new.representedObject = agent
        sub.addItem(new)
        return sub
    }

    private func revealSubmenu(_ cwd: String) -> NSMenu {
        let sub = NSMenu()
        let reveal = NSMenuItem(title: "Reveal working dir", action: #selector(onOpenPath(_:)), keyEquivalent: "")
        reveal.target = self; reveal.representedObject = cwd
        sub.addItem(reveal)
        return sub
    }

    private func routineSubmenu(_ r: Routine) -> NSMenu {
        let sub = NSMenu()
        let run = NSMenuItem(title: "Run now", action: #selector(onRoutineRun(_:)), keyEquivalent: "")
        run.target = self; run.representedObject = r.name
        sub.addItem(run)
        let logs = NSMenuItem(title: "Logs", action: #selector(onRoutineLogs(_:)), keyEquivalent: "")
        logs.target = self; logs.representedObject = r.name
        sub.addItem(logs)
        return sub
    }

    private func allRoutinesSubmenu(_ routines: [Routine]) -> NSMenu {
        let sub = NSMenu()
        for r in routines {
            let mark = r.lastStatus == "failed" || r.lastStatus == "timeout" ? "! "
                : (r.enabled ? "  " : "· ")
            let when = r.enabled ? (r.nextRunHuman ?? r.schedule) : "paused"
            let item = NSMenuItem(title: "\(mark)\(r.name)  \(when)", action: nil, keyEquivalent: "")
            item.submenu = routineSubmenu(r)
            sub.addItem(item)
        }
        return sub
    }

    // MARK: Actions
    @objc private func onNewSession(_ s: NSMenuItem) {
        if let a = s.representedObject as? String { AgentsCLI.newSession(agent: a) }
    }
    @objc private func onRoutineRun(_ s: NSMenuItem) { withName(s, AgentsCLI.routineRun) }
    @objc private func onRoutineLogs(_ s: NSMenuItem) { withName(s, AgentsCLI.routineLogs) }
    @objc private func onOpenPath(_ s: NSMenuItem) {
        if let p = s.representedObject as? String { AgentsCLI.openPath(p) }
    }
    @objc private func onStopScheduler() { AgentsCLI.stopDaemon() }
    @objc private func onQuit() { AgentsCLI.menubarDisable(); NSApp.terminate(nil) }

    private func withName(_ s: NSMenuItem, _ fn: (String) -> Void) {
        if let n = s.representedObject as? String { fn(n) }
    }

    // MARK: Helpers
    private func addSectionTitle(_ menu: NSMenu, _ title: String, color: NSColor) {
        let it = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        it.isEnabled = false
        it.attributedTitle = NSAttributedString(string: title, attributes: [
            .foregroundColor: color,
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
        ])
        menu.addItem(it)
    }
}
