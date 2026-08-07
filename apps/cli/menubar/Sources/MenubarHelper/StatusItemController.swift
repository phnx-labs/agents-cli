import AppKit

/// A collapsible section header that handles its click inside the menu's tracking
/// session. An actionable NSMenuItem ends tracking before its action runs, which
/// made the status menu disappear on every expand/collapse. A custom item view
/// receives the click without selecting the NSMenuItem, so rows change in place.
/// Used by both the ACTIVE project accordion and the DEVICES section.
private final class AccordionRowView: NSView {
    private let button = NSButton()
    private let summary: String
    private var expanded: Bool
    private let expandTip: String
    private let collapseTip: String
    var onToggle: ((Bool) -> Void)?

    init(summary: String, expanded: Bool, accessibilityLabel: String,
         accessibilityHelp: String, expandTip: String, collapseTip: String) {
        self.summary = summary
        self.expanded = expanded
        self.expandTip = expandTip
        self.collapseTip = collapseTip
        let font = NSFont.menuFont(ofSize: 0)
        let textWidth = (summary as NSString).size(withAttributes: [.font: font]).width
        super.init(frame: NSRect(x: 0, y: 0, width: max(320, textWidth + 48), height: 22))
        autoresizingMask = [.width]

        button.isBordered = false
        button.font = font
        button.alignment = .left
        button.focusRingType = .none
        button.target = self
        button.action = #selector(toggle)
        button.translatesAutoresizingMaskIntoConstraints = false
        addSubview(button)
        NSLayoutConstraint.activate([
            button.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            button.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            button.topAnchor.constraint(equalTo: topAnchor),
            button.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        button.setAccessibilityLabel(accessibilityLabel)
        button.setAccessibilityHelp(accessibilityHelp)
        updateLabel()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    @objc private func toggle() {
        expanded.toggle()
        updateLabel()
        onToggle?(expanded)
    }

    private func updateLabel() {
        button.title = "  \(expanded ? "▼" : "▶")  \(summary)"
        button.toolTip = expanded ? collapseTip : expandTip
        button.setAccessibilityValue(expanded ? "expanded" : "collapsed")
    }
}

// Owns the NSStatusItem. The dropdown is actionable-first: what needs the user
// now (attention sessions, a stopped scheduler, failing routines) leads; live
// work follows; setup/health noise collapses into one row. Every health fact
// has exactly one home — no section restates another.
final class StatusItemController: NSObject, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    // The quick-dispatch bar (Cmd-Shift-O). Owned here so the menu's "New Task"
    // row and the global chord summon the SAME panel — one panel means an
    // interrupted capture is restored whichever way you come back to it.
    let promptController = PromptPanelController()
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
    // Devices under high load — this Mac (native getloadavg) + fresh fleet peers.
    private var badgeLoaded: [LoadedDevice] = []

    // Daemon-down watchdog. The only other proactive "routines won't run"
    // signal is `notifyOverdue` (src/lib/overdue.ts), fired from INSIDE
    // `runDaemon()` on startup — so it can never fire while the daemon itself
    // is down, the exact circularity this closes. This helper is a SEPARATE
    // launchd KeepAlive service that stays alive when the daemon dies, so it
    // is the one thing that can notice and say so. Polled every `tick()`
    // (independent of menu-open) via the cheap, synchronous `daemonPid()`
    // (a pid-file read + `kill(pid, 0)` — no CLI spawn), and delivered through
    // this process's own `Notifier`, not a spawned `--notify` child, so the
    // alert cannot depend on anything the dead daemon would have provided.
    private var daemonDeadTicks = 0
    private var daemonDownNotified = false
    /// True once `daemonDeadTicks` has crossed the threshold; drives the
    /// always-visible badge (see `refreshBadge`), independent of whether the
    /// dropdown is ever opened.
    private var schedulerDown = false
    /// Consecutive dead ticks (~10s apart) required before alerting. A daemon
    /// restart — a version upgrade, `agents doctor` self-heal, a crash the
    /// launchd-equivalent auto-relaunches — is down for a few seconds; this
    /// debounce absorbs that blip instead of paging the user for a non-event.
    private static let daemonDownTickThreshold = 3

    // Routine list bounds (RUSH-2290). A fleet can accumulate far more routines
    // than a dropdown can show — cap the NEEDS YOU attention-cause groups and the
    // "All routines…" submenu so a bad week never turns the menu into a
    // multi-screen scroll; each cap ends in a "+N more" row rather than silently
    // truncating with no signal. Not `private` — RoutineSelfTest asserts against
    // these directly rather than duplicating the numbers.
    static let maxAttentionGroups = 6
    static let maxAllRoutinesRows = 40

    // These three reads shell the CLI or touch the sessions DB. They are kept
    // off the click path and rendered from warm caches when the menu opens.
    private var cachedRoutines: [Routine] = []
    private var routinesLoaded = false

    private var cachedRecentSessions: [RecentSession] = []
    private var recentSessionsLoaded = false

    // The engine's active-session list (`sessions --active --local --json`) —
    // authoritative coverage (tmux/IDE/headless), but costs seconds, so it rides
    // the same warm-cache pattern as routines: refreshed off-path, rendered from
    // cache when the menu opens. Until first load, the cheap live-terminals view
    // fills in.
    private var cachedActiveSessions: [ActiveSession] = []
    private var activeSessionsLoaded = false

    // The registered fleet-device roster (from `agents menubar snapshot --json`),
    // rendered as the collapsible DEVICES section near the bottom. Live load% is
    // merged in at render time from LocalState.deviceLoads() (the warm fleet cache).
    private var cachedDevices: [Device] = []
    private var devicesLoaded = false

    private var cachedDoctorOverview: DoctorOverview?
    private var doctorLoaded = false
    private var doctorInFlight = false
    private var doctorFetchedAt: Date?

    // Watchdog state is read from the consolidated snapshot. The daemon is the
    // sole repeating executor; this helper only toggles device-local enablement.
    private var cachedWatchdog: WatchdogTick?
    private var watchdogEnabled = false
    private var snapshotInFlight = false
    private var snapshotFetchedAt: Date?
    private static let snapshotRefreshInterval: TimeInterval = 3 * 60

    // ACTIVE project accordion — projects collapsed by default. In-memory only
    // (resets on helper restart). Toggling rebuilds from the warm active-session
    // cache with NO extra CLI calls. Session *detail* lives in a side submenu (›),
    // not a second accordion level.
    private var expandedProjects = Set<String>()
    private var projectSessionItems: [String: [NSMenuItem]] = [:]

    // The DEVICES section is ONE collapsible block (collapsed by default), so its
    // state is a single flag + the rows currently shown — not the per-key Set the
    // project accordion needs. Same in-place insert/remove, no CLI on toggle.
    private var devicesExpanded = false
    private var deviceRowItems: [NSMenuItem] = []

    /// Same form as CLI `machineId()` so engine-tagged sessions compare as local.
    private lazy var thisMachine: String = ActiveDisplay.thisMachineId()

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

    /// Open this helper's menu. Called when a duplicate launch surrenders
    /// (SingleInstance) — re-launching a menu-bar app means "show me the one
    /// that is already running", so the incumbent answers by dropping its menu.
    ///
    /// @objc + NSObject because the observer must be registered with the
    /// selector-based DistributedNotificationCenter API: only that overload
    /// takes a suspensionBehavior, and this app is `.accessory` — never the
    /// active app — so the default behavior queues the notification instead of
    /// delivering it and the menu never opens.
    @objc func surface(_ note: Notification) {
        guard let button = statusItem.button else { return }
        let info = note.userInfo as? [String: String] ?? [:]
        // An agent/automation relaunched the helper (e.g. a coding agent running
        // `agents menubar enable`). The human did not ask to see the menu, so
        // re-home silently — popping the dropdown here steals the user's keyboard
        // focus mid-task, the interruption this attribution was added to stop.
        if info["automated"] == "1" {
            let who = [info["agent"].map { "agent=\($0)" }, info["sessionId"].map { "session=\($0)" }]
                .compactMap { $0 }.joined(separator: " ")
            FileHandle.standardError.write(Data(
                "MenubarHelper: automated relaunch (\(who.isEmpty ? "unknown" : who)) — re-homed silently, did not surface\n".utf8
            ))
            return
        }
        // Logged: this is the one moment where a second launch changed what the
        // user sees, and the launchd plist routes stderr to menubar.log.
        FileHandle.standardError.write(Data("MenubarHelper: surfacing menu for a user relaunch\n".utf8))
        NSApp.activate(ignoringOtherApps: true)
        button.performClick(nil)
    }

    private func tick() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let s = LocalState.sessions(includeTeams: false)
            let pending = LocalState.pendingDevices()
            let loaded = LocalState.loadedDevices()
            DispatchQueue.main.async {
                guard let self else { return }
                self.badgeSessions = self.merged(s)
                self.badgePending = pending
                self.badgeLoaded = loaded
                self.refreshBadge()
            }
        }
        checkDaemonLiveness()
        refreshSnapshot()
        refreshDoctorOverview()
    }

    /// Poll the scheduler's liveness on every tick — the one check that must
    /// NOT depend on the menu ever being opened. `daemonPid()` is a plain
    /// pid-file read + signal-0 probe (no subprocess), so it is safe to call
    /// on the main thread here just like `menuWillOpen` already does.
    ///
    /// Fires once per outage, only after `daemonDownTickThreshold` consecutive
    /// dead ticks — covers both a daemon that dies mid-session (an
    /// alive→dead transition) and one that is already down when the helper
    /// itself (re)launches (a reboot, a crash before the helper started).
    /// Resets the moment the daemon comes back, so the next real outage
    /// alerts again.
    private func checkDaemonLiveness() {
        let alive = AgentsCLI.daemonPid() != nil
        if alive {
            daemonDeadTicks = 0
            daemonDownNotified = false
            if schedulerDown {
                schedulerDown = false
                refreshBadge()
            }
            return
        }
        daemonDeadTicks += 1
        if daemonDeadTicks >= Self.daemonDownTickThreshold && !schedulerDown {
            schedulerDown = true
            refreshBadge()
        }
        guard daemonDeadTicks == Self.daemonDownTickThreshold, !daemonDownNotified else { return }
        daemonDownNotified = true
        Notifier.post(
            title: "Scheduler stopped — routines won't run",
            body: "Restart it from the menu bar, or run: agents routines start",
            url: URL(fileURLWithPath: "\(NSHomeDirectory())/.agents/.history/runs").absoluteString
        )
    }

    private func loadDumpCaches() {
        if let snapshot = AgentsCLI.menubarSnapshot() {
            applySnapshot(snapshot)
            snapshotFetchedAt = Date()
        }

        cachedDoctorOverview = AgentsCLI.doctorOverview()
        doctorLoaded = true
        doctorFetchedAt = Date()
    }

    // MARK: Cached CLI refreshes
    private func applySnapshot(_ snapshot: MenubarSnapshot) {
        cachedRoutines = snapshot.routines
        routinesLoaded = true
        cachedRecentSessions = snapshot.recentSessions
        recentSessionsLoaded = true
        promptController.updateRecentSessions(snapshot.recentSessions)
        cachedActiveSessions = snapshot.activeSessions
        activeSessionsLoaded = true
        cachedDevices = snapshot.devices ?? []
        devicesLoaded = true
        watchdogEnabled = snapshot.watchdog.enabled
        cachedWatchdog = snapshot.watchdog.lastTick
    }

    private func refreshSnapshot() {
        if snapshotInFlight { return }
        if let t = snapshotFetchedAt, Date().timeIntervalSince(t) < Self.snapshotRefreshInterval { return }
        snapshotInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let snapshot = AgentsCLI.menubarSnapshot()
            DispatchQueue.main.async {
                guard let self else { return }
                if let snapshot {
                    self.applySnapshot(snapshot)
                    self.snapshotFetchedAt = Date()
                }
                self.snapshotInFlight = false
            }
        }
    }

    /// How often the System row's `doctor --json` may be refreshed.
    ///
    /// This was 60s against a command measured at **136s** on an idle machine —
    /// i.e. the poll asked for a refresh more than twice as often as one could
    /// possibly complete, so the helper ran a doctor essentially continuously.
    /// (The in-flight guard kept it to one *per process*, which is why the
    /// unbounded child and the crash-restart loop were needed to turn this into
    /// the 38-orphan runaway — but a ~100% duty cycle was always the floor.)
    ///
    /// 15 minutes is matched to what the data actually is: installed CLIs,
    /// per-version sign-in, and resource sync drift change on the timescale of a
    /// person running `agents sync` or logging in, not second to second. That
    /// takes the duty cycle from ~100% of one core to ~15%.
    private static let doctorRefreshInterval: TimeInterval = 15 * 60

    private func refreshDoctorOverview() {
        if doctorInFlight { return }
        if let t = doctorFetchedAt, Date().timeIntervalSince(t) < Self.doctorRefreshInterval { return }
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
        let attention = badgeSessions.filter { $0.status == .inputRequired }.count
        let running = badgeSessions.filter { $0.status == .running }.count
        let pending = badgePending.count
        if attention > 0 || !badgeLoaded.isEmpty {
            // A blocked session or a device under high load — both are "needs you".
            // A critical-load device tips the glyph red; otherwise the amber warn.
            let critical = badgeLoaded.contains { $0.severity == .critical }
            button.attributedTitle = badge("⚠", critical ? fail : wait)
        } else if schedulerDown {
            // A dead scheduler means every routine silently stops firing — that
            // outranks a device-registration nudge or a running-session count,
            // so it is glanceable without opening the dropdown at all.
            button.attributedTitle = badge(" ⏻", fail)
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
        let loaded = LocalState.loadedDevices()
        badgeSessions = merged(sessions)
        badgePending = pending
        badgeLoaded = loaded
        rebuild(menu, sessions: sessions, browserTasks: browserTasks,
                recentSessions: cachedRecentSessions, routines: cachedRoutines,
                doctor: cachedDoctorOverview, daemonPid: daemonPid, pending: pending, loaded: loaded,
                devices: cachedDevices)
        refreshBadge()
        refreshSnapshot()
        refreshDoctorOverview()
    }

    // The one rule: attention floats to the top triage strip (wait-time sorted,
    // cross-project) and is never nested inside a project group; live work
    // groups by repo below; routines / tickets / recents stay dedicated,
    // glanceable sections; setup + watchdog noise collapses into one System row.
    private func rebuild(_ menu: NSMenu, sessions: [Session], browserTasks: [BrowserTask],
                         recentSessions: [RecentSession], routines: [Routine],
                         doctor: DoctorOverview?, daemonPid: Int?, pending: [PendingDevice],
                         loaded: [LoadedDevice], devices: [Device]) {
        menu.removeAllItems()
        projectSessionItems.removeAll()
        deviceRowItems.removeAll()

        // Prefer the engine's active list once the warm cache has it — full
        // coverage (tmux/IDE/headless), correct running/idle. The cheap
        // live-terminals view (`sessions` param) covers the cold start.
        let sessions = merged(sessions)

        addHeader(menu, sessions: sessions, plusNeeds: loaded.count)
        menu.addItem(.separator())

        // What needs me now — rendered only when there's something actionable.
        if addNeedsAttention(menu, sessions: sessions, routines: routines,
                             daemonPid: daemonPid, loaded: loaded) {
            menu.addItem(.separator())
        }

        addNewSession(menu)
        menu.addItem(.separator())

        // Live work grouped by repo — attention rows live in the triage strip,
        // not here. Skipped entirely on a calm, idle machine.
        let live = sessions.filter { $0.status != .inputRequired }
        if !live.isEmpty || !browserTasks.isEmpty {
            addActive(menu, live: live, browserTasks: browserTasks)
            menu.addItem(.separator())
        }

        addRoutines(menu, routines: routines)
        menu.addItem(.separator())

        // Tickets filed via the quick-issue bar (Cmd-Shift-O), clickable → open.
        if addRecentTickets(menu) {
            menu.addItem(.separator())
        }

        addRecent(menu, recentSessions: recentSessions)
        menu.addItem(.separator())

        // Devices sit just above the System controls: newly-discovered nodes to
        // approve first, then the full collapsible roster (folded by default so the
        // long fleet list never walls the menu).
        if addNewDevices(menu, pending: pending) {
            menu.addItem(.separator())
        }
        if addDevices(menu, devices: devices) {
            menu.addItem(.separator())
        }

        addSystem(menu, doctor: doctor)

        menu.addItem(.separator())
        addFooter(menu, daemonPid: daemonPid)
    }

    // Swap every cheap row for the engine's canonical list once the warm cache
    // has it. This preserves the exact lifecycle status and row count emitted by
    // `agents sessions --active --local --json` across terminal, teams, cloud,
    // tmux, and headless contexts. Cheap files are cold-start display only.
    private func merged(_ cheap: [Session]) -> [Session] {
        guard activeSessionsLoaded, !cachedActiveSessions.isEmpty else { return cheap }
        return LocalState.sessions(fromActive: cachedActiveSessions)
    }

    // MARK: Sections
    private func addHeader(_ menu: NSMenu, sessions: [Session], plusNeeds: Int = 0) {
        let attn = sessions.filter { $0.status == .inputRequired }.count + plusNeeds
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
    // Triage strip: blocked sessions grouped by (agent, repo). A group with 2+
    // blocked sessions collapses to one row + submenu — walls of identical
    // "Claude · muqsitnawaz — Claude is waiting for your input" rows were the
    // single biggest source of noise. Groups of 1 render inline as before; the
    // generic "awaiting input" filler drops when the Notification message is
    // empty (the ⚠ glyph + section header already convey it). Failing routines
    // follow.
    private func addNeedsAttention(_ menu: NSMenu, sessions: [Session],
                                   routines: [Routine], daemonPid: Int?,
                                   loaded: [LoadedDevice]) -> Bool {
        var rows: [(String, NSColor, String, NSMenu?)] = []   // glyph, color, text, submenu

        let blocked = sessions.filter { $0.status == .inputRequired }
        let groups = Dictionary(grouping: blocked) { s in "\(s.agent)\u{0000}\(s.repo)" }
        // Sort each group oldest-first, then order groups by their oldest wait.
        let sortedGroups = groups.values.map { group -> [Session] in
            group.sorted { ($0.attentionSinceMs ?? .greatestFiniteMagnitude) < ($1.attentionSinceMs ?? .greatestFiniteMagnitude) }
        }.sorted { (a, b) in
            (a.first?.attentionSinceMs ?? .greatestFiniteMagnitude) < (b.first?.attentionSinceMs ?? .greatestFiniteMagnitude)
        }

        for group in sortedGroups {
            guard let first = group.first else { continue }
            let agentLabel = LocalState.agentLabel(first.agent)
            let repo = first.repo
            if group.count == 1 {
                // Inline: skip the generic filler when the hook wrote no message.
                var text = "\(agentLabel) · \(repo)"
                if !first.question.isEmpty {
                    text += " — \(trim(first.question, 48))"
                }
                if let since = first.attentionSinceMs { text += "  ·  \(elapsedShort(since))" }
                rows.append(("⚠", wait, text, blockedSubmenu(sessionId: first.sessionId, cwd: first.cwd)))
            } else {
                // Collapsed: N waiting · oldest elapsed. Submenu lists each session.
                var text = "\(agentLabel) · \(repo) · \(group.count) waiting"
                if let since = first.attentionSinceMs {
                    text += "  ·  oldest \(elapsedShort(since))"
                }
                rows.append(("⚠", wait, text, groupedWaitersSubmenu(group)))
            }
        }

        // Devices under high load — this Mac (native getloadavg) first, then fresh
        // fleet peers. Warn at headroom() 'loaded' (>=75%); X red when critical.
        for d in loaded {
            let glyph = d.severity == .critical ? "✕" : "⚠"
            let color = d.severity == .critical ? fail : wait
            let scope = d.isLocal ? "\(d.name) (this Mac)" : d.name
            rows.append((glyph, color, "\(scope) — high load \(Int(d.loadPercent.rounded()))%", loadedSubmenu(d)))
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

        // Failing routines are surfaced HERE ONLY — the ROUTINES section below
        // renders upcoming runs and "All routines…", never a second copy of the
        // same failure inline, so a bad routine never shows twice in one menu.
        // Routines sharing an identical cause (same readiness code, or the same
        // lastStatus with no readiness) collapse into one row instead of one
        // per routine — never inventing a shared cause across routines that
        // fail for genuinely different reasons. Capped so a bad week doesn't
        // turn NEEDS YOU into its own scroll.
        let bad = routines.filter { routineNeedsAttention($0) }
        if !bad.isEmpty {
            let groups = groupedByAttentionCause(bad)
            let capped = Array(groups.prefix(Self.maxAttentionGroups))
            for (cause, group) in capped {
                if group.count == 1, let r = group.first {
                    let why = routineFailureSummary(r, max: 48)
                    let (glyph, color) = attentionGlyph(r)
                    rows.append((glyph, color, "Routine \(r.name) \(why)", allRoutinesSubmenu(group)))
                } else {
                    let label = readableAttentionCause(cause)
                    rows.append(("✕", fail, "\(group.count) routines \(label)", allRoutinesSubmenu(group)))
                }
            }
            if groups.count > capped.count {
                let remaining = groups.count - capped.count
                rows.append(("✕", fail,
                             "+\(remaining) more routine issue\(remaining == 1 ? "" : "s") — see All routines…",
                             nil))
            }
        }

        if rows.isEmpty { return false }
        // Title reflects the count of rendered rows in this section — always.
        // Any grouped-session count lives in the row text itself ("N waiting"),
        // so the header stays a simple 1:1 with what's visible below. This keeps
        // it consistent with the ACTIVE section's "header count = visible rows"
        // invariant, and never drops the failing-routines / scheduler-stopped
        // rows from the header count when grouping is in play.
        addSectionTitle(menu, "⚠ NEEDS YOU (\(rows.count))", color: wait)
        for (glyph, color, text, sub) in rows {
            // Action-required rows are emphasized so they stand out from the
            // informational sections below.
            let it = statusRow(glyph, color, text, emphasize: true)
            it.submenu = sub
            menu.addItem(it)
        }
        return true
    }

    // Small breakdown submenu for a high-load device row: load% (+ mem% when known).
    private func loadedSubmenu(_ d: LoadedDevice) -> NSMenu {
        let sub = NSMenu()
        var line = "load \(Int(d.loadPercent.rounded()))%"
        if let mem = d.memPercent { line += " · mem \(Int(mem.rounded()))%" }
        sub.addItem(disabled(line))
        return sub
    }

    // Submenu listing every blocked session in a grouped (agent, repo) waiter.
    // Sorted oldest-first (most stalled at the top). Row = session title (or a
    // "session" fallback when no title) with the elapsed wait as the trailing chip.
    private func groupedWaitersSubmenu(_ group: [Session]) -> NSMenu {
        let sub = NSMenu()
        for s in group {
            let label = s.title.isEmpty ? "session" : trim(s.title, 36)
            var text = label
            if !s.question.isEmpty { text += " — \(trim(s.question, 34))" }
            if let since = s.attentionSinceMs { text += "  ·  \(elapsedShort(since))" }
            let it = statusRow("⚠", wait, text)
            it.submenu = blockedSubmenu(sessionId: s.sessionId, cwd: s.cwd)
            sub.addItem(it)
        }
        return sub
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

    // The full registered-device roster as ONE collapsible block (folded by
    // default). The fleet is long, so it stays out of the way until asked for.
    // Rows carry live load% merged from the warm fleet cache; toggling inserts /
    // removes rows in place with no CLI call, exactly like the project accordion.
    // Returns true if anything was rendered (caller adds the trailing separator).
    private func addDevices(_ menu: NSMenu, devices: [Device]) -> Bool {
        guard !devices.isEmpty else { return false }
        let title = "DEVICES (\(devices.count))"
        let header = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let headerView = AccordionRowView(
            summary: title, expanded: devicesExpanded,
            accessibilityLabel: "Devices",
            accessibilityHelp: "Expand or collapse \(devices.count) device\(devices.count == 1 ? "" : "s")",
            expandTip: "Show devices", collapseTip: "Hide devices")
        headerView.onToggle = { [weak self, weak menu, weak header] shouldExpand in
            guard let self, let menu, let header else { return }
            self.setDevices(expanded: shouldExpand, devices: devices, in: menu, after: header)
        }
        header.view = headerView
        menu.addItem(header)
        if devicesExpanded {
            let rows = deviceRows(devices)
            deviceRowItems = rows
            for row in rows { menu.addItem(row) }
        }
        return true
    }

    /// In-place expand/collapse of the DEVICES block — mirrors setProject, but the
    /// section is a single unit so its state is one flag + one row list.
    private func setDevices(expanded: Bool, devices: [Device], in menu: NSMenu, after header: NSMenuItem) {
        if expanded {
            devicesExpanded = true
            let rows = deviceRows(devices)
            deviceRowItems = rows
            let idx = menu.index(of: header)
            guard idx >= 0 else { return }
            for (offset, row) in rows.enumerated() {
                menu.insertItem(row, at: idx + offset + 1)
            }
        } else {
            devicesExpanded = false
            for row in deviceRowItems { menu.removeItem(row) }
            deviceRowItems = []
        }
        menu.update()
    }

    /// One row per device: this Mac first, then alphabetical. Load% is shown only
    /// where the warm fleet cache has a fresh reading — its absence is never
    /// rendered as "offline" (the roster carries no probed online/offline state).
    private func deviceRows(_ devices: [Device]) -> [NSMenuItem] {
        let loads = LocalState.deviceLoads()
        let ordered = devices.sorted { a, b in
            if a.isLocal != b.isLocal { return a.isLocal }
            return a.name < b.name
        }
        return ordered.map { d in
            let load = loads[ActiveDisplay.normalizeHost(d.name)]
            var line = d.isLocal ? "\(d.name) (this Mac)" : d.name
            line += " · \(d.platform)"
            if let l = load { line += " · \(Int(l.load.rounded()))%" }
            // ◉ marks the configured interactive host, ○ otherwise. Deliberately no
            // color-coded status dot — the roster does not know online/offline.
            let row = statusRow(d.interactive ? "◉" : "○", idleC, line)
            row.submenu = deviceSubmenu(d, load: load)
            return row
        }
    }

    private func deviceSubmenu(_ d: Device, load: (load: Double, mem: Double?)?) -> NSMenu {
        let sub = NSMenu()
        if let l = load {
            var line = "load \(Int(l.load.rounded()))%"
            if let m = l.mem { line += " · mem \(Int(m.rounded()))%" }
            sub.addItem(disabled(line))
        }
        if d.interactive { sub.addItem(disabled("interactive host")) }
        if !sub.items.isEmpty { sub.addItem(.separator()) }
        let ssh = "agents ssh \(d.name)"
        let copy = NSMenuItem(title: "⧉  Copy  \(ssh)", action: #selector(onCopyText(_:)), keyEquivalent: "")
        copy.target = self
        copy.representedObject = ssh
        sub.addItem(copy)
        return sub
    }

    // Two ways to start work, most-direct first:
    //   New Task    — the quick-dispatch bar: type it, agents pick it up headless.
    //   New Session — an interactive TUI in the terminal the user works in.
    private func addNewSession(_ menu: NSMenu) {
        let task = NSMenuItem(title: "New Task…", action: #selector(onNewTask(_:)), keyEquivalent: "t")
        task.target = self
        task.toolTip = "Describe a task and dispatch it to agents (Cmd-Shift-O)"
        menu.addItem(task)

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

    // Live work: PROJECT accordion + SESSION side-submenu.
    //
    //   ▶ agents-cli  ●8 ◐1  zion          ← project collapsed (default)
    //   ▼ agents-cli  ●8 ◐1  zion          ← click folds open inline
    //       ● Claude · zion · 3m — work… ›  ← agent row; › opens detail submenu
    //
    // Project expand is an accordion (▶/▼). Session detail is a native side
    // submenu so linkable actions and multi-line context don't wall the main menu.
    // Expand rebuilds from the warm cache only — no CLI, no re-index.
    private func addActive(_ menu: NSMenu, live: [Session], browserTasks: [BrowserTask]) {
        let totalRun = live.filter { $0.status == .running }.count
        let totalIdle = live.filter { $0.status == .idle }.count
        let projectCount = Set(live.map { $0.repo.isEmpty ? "other" : $0.repo }).count
        var head = "ACTIVE"
        var bits: [String] = []
        if totalRun > 0 { bits.append("\(totalRun) run") }
        if totalIdle > 0 { bits.append("\(totalIdle) idle") }
        let otherStatuses = Dictionary(grouping: live.filter {
            $0.status != .running && $0.status != .idle
        }, by: \.status)
        for status in otherStatuses.keys.sorted(by: { $0.rawValue < $1.rawValue }) {
            bits.append("\(otherStatuses[status]!.count) \(ActiveDisplay.statusLabel(status))")
        }
        if projectCount > 0 { bits.append("\(projectCount) project\(projectCount == 1 ? "" : "s")") }
        if !bits.isEmpty { head += " · " + bits.joined(separator: " · ") }
        addSectionTitle(menu, head, color: .secondaryLabelColor)

        let groups = Dictionary(grouping: live) { $0.repo.isEmpty ? "other" : $0.repo }
        // Running projects first, then name — scannable triage order.
        let orderedKeys = groups.keys.sorted { a, b in
            let ra = groups[a]!.filter { $0.status == .running }.count
            let rb = groups[b]!.filter { $0.status == .running }.count
            if ra != rb { return ra > rb }
            return a.lowercased() < b.lowercased()
        }

        for repo in orderedKeys {
            guard let group = groups[repo] else { continue }
            let statuses = Dictionary(grouping: group, by: \.status).mapValues(\.count)
            let machines = group.compactMap(\.machine)
            let open = expandedProjects.contains(repo)
            let summary = ActiveDisplay.projectSummary(repo: repo, statuses: statuses,
                                                       machines: machines)
            let header = NSMenuItem(title: summary, action: nil, keyEquivalent: "")
            let headerView = AccordionRowView(summary: summary, expanded: open,
                                              accessibilityLabel: "\(repo) project",
                                              accessibilityHelp: "Expand or collapse \(group.count) session\(group.count == 1 ? "" : "s")",
                                              expandTip: "Expand project", collapseTip: "Collapse project")
            headerView.onToggle = { [weak self, weak menu, weak header] shouldExpand in
                guard let self, let menu, let header else { return }
                self.setProject(repo, expanded: shouldExpand, sessions: group,
                                in: menu, after: header)
            }
            header.view = headerView
            menu.addItem(header)

            guard open else { continue }

            let sessions = orderedProjectSessions(group)
            let rows = sessions.map { makeSessionRow(session: $0) }
            projectSessionItems[repo] = rows
            for row in rows { menu.addItem(row) }
        }

        if !browserTasks.isEmpty {
            addSectionTitle(menu, "  Browser", color: .secondaryLabelColor)
            for task in browserTasks {
                let tabs = task.tabCount == 1 ? "1 tab" : "\(task.tabCount) tabs"
                let row = statusRow("◦", idleC, "\(trim(task.name, 24)) · \(shortProfile(task.profile)) · \(tabs)")
                row.submenu = browserTaskSubmenu(task)
                menu.addItem(row)
            }
        }
    }

    /// Agent summary under an expanded project. Detail lives in the › submenu
    /// (linkable ticket/PR/cwd, locality, duration) — not a second accordion.
    private func makeSessionRow(session s: Session) -> NSMenuItem {
        let glyph = ActiveDisplay.statusGlyph(s.status)
        let color = s.status == .running ? run : (s.status == .inputRequired ? wait : idleC)
        let agent = LocalState.agentLabel(s.agent)
        let host = s.machine ?? thisMachine
        let age = ActiveDisplay.ageLabel(fromMs: s.lastActivityMs ?? s.startedAtMs)
        let work = s.workTitle

        // Compact chips on the main row so you see signal without opening ›.
        var chips: [String] = []
        if let t = s.ticketId, !t.isEmpty { chips.append("🎫\(t)") }
        if let pr = ActiveDisplay.prNumber(from: s.prLink) { chips.append("PR#\(pr)") }
        else if let link = s.prLink, !link.isEmpty { chips.append("PR") }
        if s.origin == "routine" {
            chips.append(s.routineName.map { "routine:\($0)" } ?? "routine")
        }

        var line = "\(glyph) \(agent) · \(host)"
        if let surface = s.surface, !surface.isEmpty { line += " · \(surface)" }
        if !age.isEmpty { line += " · \(age)" }
        if !chips.isEmpty { line += "  " + chips.joined(separator: " ") }
        if !work.isEmpty { line += " — \(trim(work, 32))" }

        let row = statusRow("", color, line)
        row.title = "    \(line)"
        row.attributedTitle = sessionRowTitle(glyph: glyph, glyphColor: color, rest: line)
        row.submenu = sessionDetailSubmenu(s)
        row.toolTip = work.isEmpty ? "Session detail" : work
        return row
    }

    /// Mutate only the rows under the clicked project. The enclosing status menu
    /// remains in the same tracking session and no cache refresh or CLI call runs.
    private func setProject(_ repo: String, expanded: Bool, sessions: [Session],
                            in menu: NSMenu, after header: NSMenuItem) {
        if expanded {
            expandedProjects.insert(repo)
            let ordered = orderedProjectSessions(sessions)
            let rows = ordered.map { makeSessionRow(session: $0) }
            projectSessionItems[repo] = rows
            let headerIndex = menu.index(of: header)
            guard headerIndex >= 0 else { return }
            for (offset, row) in rows.enumerated() {
                menu.insertItem(row, at: headerIndex + offset + 1)
            }
        } else {
            expandedProjects.remove(repo)
            for row in projectSessionItems.removeValue(forKey: repo) ?? [] {
                menu.removeItem(row)
            }
        }
        menu.update()
    }

    private func orderedProjectSessions(_ sessions: [Session]) -> [Session] {
        sessions.sorted { a, b in
            let ra = a.status == .running ? 0 : 1
            let rb = b.status == .running ? 0 : 1
            if ra != rb { return ra < rb }
            return (a.lastActivityMs ?? 0) > (b.lastActivityMs ?? 0)
        }
    }

    /// Status-colored glyph + label for the agent row.
    private func sessionRowTitle(glyph: String, glyphColor: NSColor, rest: String) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let font = NSFont.menuFont(ofSize: 0)
        out.append(NSAttributedString(string: "    \(glyph) ", attributes: [
            .foregroundColor: glyphColor, .font: font,
        ]))
        // rest already starts with glyph when built above — strip the leading glyph
        // if present so we don't double it.
        var body = rest
        for prefix in ["● ", "◐ ", "○ ", "⊘ ", "× ", "✗ ", "◍ ", "◌ "] {
            if body.hasPrefix(prefix) { body = String(body.dropFirst(prefix.count)); break }
        }
        out.append(NSAttributedString(string: body, attributes: [
            .foregroundColor: NSColor.labelColor, .font: font,
        ]))
        return out
    }

    /// Side submenu: graphical sections + linkable actions for one session.
    /// All fields from the warm active payload — no CLI on open.
    private func sessionDetailSubmenu(_ s: Session) -> NSMenu {
        let sub = NSMenu()
        let work = s.workTitle

        // ── Primary action ────────────────────────────────────────────────
        // Land in this session — attaches locally, or SSHes to its owning box
        // (`agents sessions focus`, the same call Factory's Focus button uses), so
        // it works whether the session is here or on a fleet peer. First so the one
        // thing you usually want is under the cursor.
        if let sid = s.sessionId, !sid.isEmpty {
            let focus = NSMenuItem(title: "▶  Focus session",
                                   action: #selector(onFocusSession(_:)), keyEquivalent: "")
            focus.target = self
            focus.representedObject = sid
            focus.toolTip = "Open this session — locally, or over SSH on its owning device"
            sub.addItem(focus)
            sub.addItem(.separator())
        }

        // ── What ──────────────────────────────────────────────────────────
        if !work.isEmpty {
            let head = NSMenuItem(title: "◎  \(trim(work, 72))", action: nil, keyEquivalent: "")
            head.isEnabled = false
            head.toolTip = work
            sub.addItem(head)
            // If the work title looks like a URL, make it one-click openable.
            if let url = firstURL(in: work) {
                let openWork = NSMenuItem(title: "   Open link in work title",
                                          action: #selector(onOpenURL(_:)), keyEquivalent: "")
                openWork.target = self
                openWork.representedObject = url.absoluteString
                sub.addItem(openWork)
            }
            sub.addItem(.separator())
        }

        // ── Where ─────────────────────────────────────────────────────────
        let locality = ActiveDisplay.locality(machine: s.machine, thisMachine: thisMachine)
        let locIcon = locality.hasPrefix("remote") ? "☁" : "💻"
        var whereLine = "\(locIcon)  \(locality)"
        if let surface = s.surface, !surface.isEmpty { whereLine += " · \(surface)" }
        sub.addItem(disabled(whereLine))

        // RUSH-2336: the exact process/provider handle — machine:pid for a real
        // OS process, provider · taskId for a cloud row with no local pid.
        let locator = ActiveDisplay.locator(machine: s.machine, pid: s.pid,
                                            cloudProvider: s.cloudProvider, cloudTaskId: s.cloudTaskId)
        if !locator.isEmpty {
            sub.addItem(disabled("Process  \(locator)"))
        }

        if !s.repo.isEmpty {
            sub.addItem(disabled("📁  \(s.repo)"))
        }
        if let cwd = s.cwd {
            let reveal = NSMenuItem(title: "📂  \(shortHome(cwd))",
                                    action: #selector(onRevealPath(_:)), keyEquivalent: "")
            reveal.target = self
            reveal.representedObject = cwd
            reveal.toolTip = "Reveal in Finder"
            sub.addItem(reveal)
        }

        // ── Links (ticket / PR) — primary actions, not just labels ────────
        let hasTicket = !(s.ticketId ?? "").isEmpty
        let hasPR = !(s.prLink ?? "").isEmpty
        if hasTicket || hasPR {
            sub.addItem(.separator())
            if let ticket = s.ticketId, !ticket.isEmpty {
                let t = NSMenuItem(title: "🎫  \(ticket)  — open in Linear",
                                   action: #selector(onOpenTicket(_:)), keyEquivalent: "")
                t.target = self
                t.representedObject = ticket
                sub.addItem(t)
            }
            if let pr = s.prLink, !pr.isEmpty {
                let label: String
                if let n = ActiveDisplay.prNumber(from: pr) {
                    label = "🔗  PR#\(n)  — open on GitHub"
                } else {
                    label = "🔗  Pull request  — open on GitHub"
                }
                let p = NSMenuItem(title: label, action: #selector(onOpenURL(_:)), keyEquivalent: "")
                p.target = self
                p.representedObject = pr
                sub.addItem(p)
            }
        }

        // ── Timing / status ───────────────────────────────────────────────
        sub.addItem(.separator())
        let started = ActiveDisplay.ageLabel(fromMs: s.startedAtMs)
        let active = ActiveDisplay.ageLabel(fromMs: s.lastActivityMs)
        let statusWord: String = {
            switch s.status {
            case .running: return "● running"
            case .idle: return "◐ idle"
            case .inputRequired: return "waiting"
            case .orphaned: return "orphan"
            default: return ActiveDisplay.statusLabel(s.status)
            }
        }()
        var timeLine = statusWord
        if !started.isEmpty { timeLine += " · started \(started) ago" }
        if !active.isEmpty { timeLine += " · active \(active) ago" }
        sub.addItem(disabled("⏱  \(timeLine)"))

        if let owner = s.owner, !owner.isEmpty, !owner.hasPrefix("UNRESOLVED") {
            sub.addItem(disabled("👤  \(owner)"))
        }
        if let sid = s.sessionId, !sid.isEmpty {
            let copy = NSMenuItem(title: "⧉  Copy session id  (\(String(sid.prefix(8)))…)",
                                  action: #selector(onCopySessionId(_:)), keyEquivalent: "")
            copy.target = self
            copy.representedObject = sid
            sub.addItem(copy)
        }

        // Latest preview snippet (trimmed) — optional context, not a wall.
        if let preview = s.preview?.trimmingCharacters(in: .whitespacesAndNewlines),
           !preview.isEmpty, preview != work {
            sub.addItem(.separator())
            let snip = disabled("💬  \(trim(preview, 80))")
            snip.toolTip = preview
            sub.addItem(snip)
        }

        return sub
    }

    private func firstURL(in text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return detector.firstMatch(in: text, options: [], range: range)?.url
    }

    private func shortHome(_ path: String) -> String {
        let home = NSHomeDirectory()
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

    @objc private func onRevealPath(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        AgentsCLI.openPath(path)
    }

    @objc private func onCopySessionId(_ sender: NSMenuItem) {
        guard let sid = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(sid, forType: .string)
    }

    @objc private func onCopyText(_ sender: NSMenuItem) {
        guard let text = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    @objc private func onOpenURL(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func onOpenTicket(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        if let url = URL(string: "https://linear.app/getrush/issue/\(id)") {
            NSWorkspace.shared.open(url)
        }
    }

    private func addRecent(_ menu: NSMenu, recentSessions: [RecentSession]) {
        let visible = Array(recentSessions.filter {
            let id = LocalState.normalizeAgent($0.agent)
            return LocalState.desiredAgents.contains { $0.id == id }
        }.prefix(3))
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

    // Routines stay a dedicated, glanceable section: the next few upcoming + any
    // failing routine inline, then "All routines…" for the rest.
    // When any routine carries a `projectGroup`, both the inline rows and the
    // "All routines…" submenu are grouped by that label (ungrouped routines last).
    private func addRoutines(_ menu: NSMenu, routines: [Routine]) {
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

        if routines.isEmpty {
            let item = NSMenuItem(title: "\(pad("Routines"))\(summary)", action: nil, keyEquivalent: "")
            menu.addItem(item)
            return
        }

        addSectionTitle(menu, "ROUTINES · \(summary)", color: .secondaryLabelColor)
        // A routine needing attention is surfaced ONCE, in NEEDS YOU (above) —
        // this section shows only what's upcoming, plus "All routines…" for the
        // rest, so the same failure never renders twice in one menu.
        let failing = routines.filter { routineNeedsAttention($0) }
        let upcoming = routines
            .filter { r in r.enabled && !failing.contains(where: { $0.name == r.name }) && r.nextRun != nil }
            .sorted { ($0.nextRun ?? "") < ($1.nextRun ?? "") }
            .prefix(3)

        let hasGroups = routines.contains { $0.projectGroup != nil }
        if hasGroups {
            let (grouped, ungrouped) = groupedRoutines(Array(upcoming))
            for (label, group) in grouped {
                menu.addItem(disabled("  \(label)"))
                for r in group { menu.addItem(inlineRoutineRow(r)) }
            }
            for r in ungrouped { menu.addItem(inlineRoutineRow(r)) }
        } else {
            for r in upcoming {
                let row = statusRow("◔", idleC, "\(r.name)  \(r.nextRunHuman ?? r.schedule)")
                row.submenu = routineSubmenu(r)
                menu.addItem(row)
            }
        }
        let all = NSMenuItem(title: "  All routines…", action: nil, keyEquivalent: "")
        all.submenu = allRoutinesSubmenu(routines)
        menu.addItem(all)
    }

    // One colored inline row for the ROUTINES section. Only ever called with an
    // upcoming (non-attention) routine now — see the comment on addRoutines —
    // but keeps the attention styling for defensiveness rather than assuming a
    // caller never changes.
    private func inlineRoutineRow(_ r: Routine) -> NSMenuItem {
        let row: NSMenuItem
        if routineNeedsAttention(r) {
            let why = routineFailureSummary(r, max: 48)
            let (glyph, color) = attentionGlyph(r)
            row = statusRow(glyph, color, "\(r.name)  \(why)")
        } else {
            row = statusRow("◔", idleC, "\(r.name)  \(r.nextRunHuman ?? r.schedule)")
        }
        row.submenu = routineSubmenu(r)
        return row
    }

    // Glyph/color for a routine currently needing attention — distinguishes a
    // readiness block (can't run at all: paused-not-ready) from an infra miss
    // (a scheduled fire never happened) from a real execution failure. Pure
    // classification lives in `routineAttentionKind`; this only maps it to the
    // menu's status palette.
    private func attentionGlyph(_ r: Routine) -> (String, NSColor) {
        switch routineAttentionKind(r) ?? .failure {
        case .notReady: return ("⏸", wait)
        case .miss: return ("⃠", wait)
        case .failure: return ("✕", fail)
        }
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

    /// Submenu for a blocked row. "Focus session" comes FIRST and is the point:
    /// a NEEDS-YOU row exists because an agent is waiting on the operator, so the
    /// action that resolves it — land in that session — must be the first thing
    /// under the cursor. Revealing the working dir does not unblock anything.
    ///
    /// `sessionId` is nil for a row the engine could not identify (a cloud task,
    /// a stale sentinel); the item is simply omitted rather than shown disabled,
    /// so the menu never offers an action that would do nothing.
    private func blockedSubmenu(sessionId: String?, cwd: String?) -> NSMenu? {
        let sub = NSMenu()
        if let id = sessionId, !id.isEmpty {
            let focus = NSMenuItem(title: "Focus session", action: #selector(onFocusSession(_:)), keyEquivalent: "")
            focus.target = self
            focus.representedObject = id
            sub.addItem(focus)
        }
        if let dir = cwd, !dir.isEmpty {
            let reveal = NSMenuItem(title: "Reveal working dir", action: #selector(onOpenPath(_:)), keyEquivalent: "")
            reveal.target = self
            reveal.representedObject = dir
            sub.addItem(reveal)
        }
        return sub.items.isEmpty ? nil : sub
    }


    private func routineSubmenu(_ r: Routine) -> NSMenu {
        let sub = NSMenu()

        // Last-run outcome / live status, a dedicated "can't run right now" line
        // when readiness explicitly blocks it (independent of how the LAST run
        // went — a routine can have completed fine and still be blocked for the
        // NEXT fire), the concrete failure/skip reason, and the next fire — all
        // from the already-decoded, server-verified routine fields, so no fresh
        // fetch on open.
        var addedInfo = false
        if r.enabled, r.ready == false {
            var text = "⏸ \(r.readiness?.message ?? "not ready to run")"
            if let target = r.project ?? r.resolvedCwd ?? r.requestedCwd, !target.isEmpty { text += " · \(target)" }
            sub.addItem(disabled(trim(text, 80))); addedInfo = true
        }
        if let status = routineRunStatusLine(r) {
            sub.addItem(disabled(status)); addedInfo = true
        }
        // The readiness line above already carries the reason when the routine
        // is blocked for its NEXT run — this is the reason for the LAST run's
        // outcome, so it's skipped for `.notReady` to avoid restating the same
        // sentence twice in one submenu.
        if routineAttentionKind(r) != .notReady, let reason = routineFailureDetail(r, max: 72) {
            sub.addItem(disabled("   \(reason)")); addedInfo = true
        }
        if r.enabled, r.lastStatus != "running", let next = r.nextRunHuman, next != "-" {
            sub.addItem(disabled("next \(next)")); addedInfo = true
        }
        if addedInfo { sub.addItem(.separator()) }

        // Run/Resume are disabled (never hidden — the operator can still see
        // and reach the routine) when readiness explicitly says the next fire
        // can't start; an older CLI with no `ready` field, or one that never
        // computed it for this routine, behaves exactly as before (enabled).
        let state = routineActionState(r)

        let run = NSMenuItem(title: "Run now", action: #selector(onRoutineRun(_:)), keyEquivalent: "")
        run.target = self
        run.representedObject = r.name
        run.isEnabled = state.runEnabled
        sub.addItem(run)

        let pauseResume = NSMenuItem(title: state.pauseResumeTitle,
                                     action: r.enabled ? #selector(onRoutinePause(_:)) : #selector(onRoutineResume(_:)),
                                     keyEquivalent: "")
        pauseResume.target = self
        pauseResume.representedObject = r.name
        pauseResume.isEnabled = state.pauseResumeEnabled
        sub.addItem(pauseResume)

        // History… beside Logs: Logs tails the raw process output of the last
        // fire, History lists past run ids/outcomes/timestamps (`agents routines
        // runs <name>`) — same read-only-CLI-data pattern as Logs, just a
        // different CLI verb.
        let history = NSMenuItem(title: "History…", action: #selector(onRoutineHistory(_:)), keyEquivalent: "")
        history.target = self
        history.representedObject = r.name
        sub.addItem(history)

        let logs = NSMenuItem(title: "Logs", action: #selector(onRoutineLogs(_:)), keyEquivalent: "")
        logs.target = self
        logs.representedObject = r.name
        sub.addItem(logs)
        return sub
    }

    // One-line "how did the last run go / is one going now" summary for a routine
    // submenu. `running` is server-verified (the CLI pid-checks it before emitting
    // the field), so "● running now" is trustworthy, not a stale marker.
    private func routineRunStatusLine(_ r: Routine) -> String? {
        // `overdue` is INDEPENDENT of the last run's outcome — it means the daemon
        // missed the NEXT scheduled fire (laptop off / daemon crash) — so it must
        // surface even when the last run completed, matching the guarantee the old
        // routineFailureDetail (`lastRunFailed || overdue`) gave. A run in flight
        // now is catching up, not missed, so it is the one status we don't tag.
        let overdueTag = r.overdue ? "  ·  ⚠ overdue" : ""
        guard let status = r.lastStatus else {
            return r.overdue ? "⚠ overdue" : nil
        }
        switch status {
        case "running":
            if let started = r.lastRunStartedAt.flatMap(parseIso) {
                return "● running now · started \(elapsedShort(started.timeIntervalSince1970 * 1000)) ago"
            }
            return "● running now"
        case "completed":
            var line = "✓ completed"
            if let dur = routineRunDuration(r) { line += " · ran \(dur)" }
            line += " · \(shortWhen(r.lastRunCompletedAt))"
            return line + overdueTag
        case "failed", "timeout":
            var line = status == "timeout" ? "✕ timed out" : "✕ failed"
            if let code = r.exitCode { line += " exit \(code)" }
            line += " · \(shortWhen(r.lastRunCompletedAt))"
            return line + overdueTag
        case "missed":
            return "⦸ missed · \(shortWhen(r.lastRunCompletedAt))" + overdueTag
        case "blocked":
            return "⏸ blocked · \(shortWhen(r.lastRunCompletedAt))" + overdueTag
        case "skipped":
            let reason = r.skipReason.map { " (\($0.replacingOccurrences(of: "_", with: " ")))" } ?? ""
            return "⦸ skipped\(reason) · \(shortWhen(r.lastRunCompletedAt))" + overdueTag
        default:
            return "\(status) · \(shortWhen(r.lastRunCompletedAt))" + overdueTag
        }
    }

    // Human duration of the last run ("45s" / "3m 12s" / "1h 4m"), when both the
    // start and completion timestamps are present.
    private func routineRunDuration(_ r: Routine) -> String? {
        guard let start = r.lastRunStartedAt.flatMap(parseIso),
              let end = r.lastRunCompletedAt.flatMap(parseIso) else { return nil }
        let secs = max(0, Int(end.timeIntervalSince(start)))
        if secs < 60 { return "\(secs)s" }
        let mins = secs / 60, rem = secs % 60
        if mins < 60 { return rem == 0 ? "\(mins)m" : "\(mins)m \(rem)s" }
        return "\(mins / 60)h \(mins % 60)m"
    }

    // Bounded to `maxAllRoutinesRows` — a trailing "+N more" row names what was
    // dropped rather than truncating silently (see the class-level comment on
    // the cap constants).
    private func allRoutinesSubmenu(_ routines: [Routine]) -> NSMenu {
        let sub = NSMenu()
        let capped = Array(routines.prefix(Self.maxAllRoutinesRows))
        let hasGroups = capped.contains { $0.projectGroup != nil }
        if hasGroups {
            let (grouped, ungrouped) = groupedRoutines(capped)
            for i in grouped.indices {
                if i > 0 { sub.addItem(.separator()) }
                let (label, group) = grouped[i]
                sub.addItem(disabled("  \(label)"))
                for r in group { sub.addItem(routineListRow(r)) }
            }
            if !ungrouped.isEmpty {
                if !grouped.isEmpty { sub.addItem(.separator()) }
                for r in ungrouped { sub.addItem(routineListRow(r)) }
            }
        } else {
            for r in capped { sub.addItem(routineListRow(r)) }
        }
        if routines.count > capped.count {
            sub.addItem(.separator())
            sub.addItem(disabled("+\(routines.count - capped.count) more — see `agents routines list`"))
        }
        return sub
    }

    // One flat row for the "All routines…" submenu.
    private func routineListRow(_ r: Routine) -> NSMenuItem {
        let mark = routineNeedsAttention(r) ? "! "
            : (r.enabled ? "  " : "· ")
        let when = routineFailureDetail(r, max: 52) ?? (r.enabled ? (r.nextRunHuman ?? r.schedule) : "paused")
        let item = NSMenuItem(title: "\(mark)\(r.name)  \(when)", action: nil, keyEquivalent: "")
        item.submenu = routineSubmenu(r)
        return item
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
    // "New Task…" — the same quick-dispatch bar the Cmd-Shift-O chord summons.
    // Dispatched async because the menu owns the run loop while it is open: the
    // panel can only take key focus once the menu has finished dismissing.
    @objc private func onNewTask(_ s: NSMenuItem) {
        DispatchQueue.main.async { [weak self] in self?.promptController.summon() }
    }
    // RUSH-1415: flip global auto-nudge. Optimistically update local state so the
    // checkmark reflects immediately; the next tick re-reads the sentinel as truth.
    @objc private func onToggleWatchdog() {
        watchdogEnabled.toggle()
        AgentsCLI.watchdogSetEnabled(watchdogEnabled)
    }
    @objc private func onRoutineRun(_ s: NSMenuItem) { withName(s, AgentsCLI.routineRun) }
    @objc private func onRoutinePause(_ s: NSMenuItem) { withName(s, AgentsCLI.routinePause) }
    @objc private func onRoutineResume(_ s: NSMenuItem) { withName(s, AgentsCLI.routineResume) }
    @objc private func onRoutineLogs(_ s: NSMenuItem) { withName(s, AgentsCLI.routineLogs) }
    @objc private func onRoutineHistory(_ s: NSMenuItem) { withName(s, AgentsCLI.routineHistory) }
    @objc private func onOpenPath(_ s: NSMenuItem) {
        if let p = s.representedObject as? String { AgentsCLI.openPath(p) }
    }
    @objc private func onFocusSession(_ s: NSMenuItem) {
        if let id = s.representedObject as? String { AgentsCLI.focusSession(id) }
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
    private func statusRow(_ glyph: String, _ glyphColor: NSColor, _ rest: String,
                           emphasize: Bool = false) -> NSMenuItem {
        let title = "  \(glyph) \(rest)"
        let it = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let base = NSFont.menuFont(ofSize: 0)
        let font = emphasize ? NSFontManager.shared.convert(base, toHaveTrait: .boldFontMask) : base
        let attr = NSMutableAttributedString(string: title, attributes: [
            .font: font,
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

/// Why a routine needs the operator's attention, in three DISTINCT flavors
/// (RUSH-2290) — the plan's "distinguish paused-not-ready from execution
/// failure": readiness explicitly refusing the next run is not the same
/// situation as a run that started and then failed, and neither is the same
/// as a scheduled fire that simply never happened.
enum RoutineAttentionKind: Equatable {
    /// Can't run at all right now — readiness blocked the last attempt
    /// (`lastStatus == "blocked"`) or explicitly blocks the next one
    /// (`enabled && ready == false`). Distinct from a manually paused routine
    /// (`enabled == false`), which needs no attention on its own.
    case notReady
    /// Infrastructure, not a task failure: the scheduled fire never started
    /// (`missed`), the daemon deliberately skipped an overlapping fire
    /// (`skipped`), or the next fire is overdue with no worse outcome.
    case miss
    /// The run itself started and did not complete cleanly.
    case failure
}

/// Single source of truth for "does this routine need a look", classified
/// into the three kinds above. One function rather than the same disjunction
/// repeated at each call site, so a new status can't be added to some checks
/// and missed in others.
func routineAttentionKind(_ r: Routine) -> RoutineAttentionKind? {
    // Both notReady triggers require `enabled` — a manually paused routine
    // (enabled == false) needs no attention just because its last attempt was
    // blocked or its next one would be; the operator already parked it.
    if r.enabled && (r.lastStatus == "blocked" || r.ready == false) { return .notReady }
    if r.lastStatus == "failed" || r.lastStatus == "timeout" { return .failure }
    if r.lastStatus == "missed" || r.lastStatus == "skipped" || r.overdue { return .miss }
    return nil
}

/// A routine the operator should look at, in ANY of the three attention kinds.
func routineNeedsAttention(_ r: Routine) -> Bool { routineAttentionKind(r) != nil }

/// `missed` means the run never started — infrastructure, not a task failure —
/// so it reads as a warning rather than a red error. `skipped` (the daemon
/// deliberately stood a fire down for a duplicate/overlapping run) is the
/// same flavor of "nothing went wrong with the task itself".
func routineIsMiss(_ r: Routine) -> Bool { routineAttentionKind(r) == .miss }

/// True when the routine is enabled but explicitly blocked from its next run
/// by a readiness check — the `.notReady` attention kind. Absent `ready`
/// (an older CLI, or a routine readiness never covers) is NOT not-ready.
func routineIsNotReady(_ r: Routine) -> Bool { routineAttentionKind(r) == .notReady }

/// The concrete, specific reason behind an attention kind — a readiness
/// message, a free-text failure reason (optionally tagged with its short
/// `failureCode`), why a fire was skipped, or a bare exit code. Returns nil
/// when there is nothing more specific to say than the bare status itself
/// (e.g. a `missed` run with no other detail) — never invents text.
func routineConcreteReason(_ r: Routine, max: Int) -> String? {
    if (r.lastStatus == "blocked" || (r.enabled && r.ready == false)),
       let readiness = r.readiness, !readiness.message.isEmpty {
        var text = readiness.message
        if let target = r.project ?? r.resolvedCwd ?? r.requestedCwd, !target.isEmpty {
            text += " · \(target)"
        }
        return trimText(text, max)
    }
    if r.lastStatus == "skipped" {
        let reason = r.skipReason.map { $0.replacingOccurrences(of: "_", with: " ") } ?? "overlapping run"
        return trimText("skipped · \(reason)", max)
    }
    if r.lastStatus == "failed" || r.lastStatus == "timeout" {
        if let reason = r.failureReason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty {
            var text = reason.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            if let code = r.failureCode, !code.isEmpty, !text.contains(code) { text = "\(code): \(text)" }
            if let target = r.project ?? r.resolvedCwd, !target.isEmpty { text += " · \(target)" }
            return trimText(text, max)
        }
        if let code = r.exitCode { return "exit \(code)" }
    }
    return nil
}

/// Always returns SOME text for a routine needing attention — falls back to
/// naming the attention kind itself when there's no more concrete reason.
func routineFailureSummary(_ r: Routine, max: Int) -> String {
    if let reason = routineConcreteReason(r, max: max) { return reason }
    switch routineAttentionKind(r) {
    case .notReady: return "not ready"
    case .miss: return r.lastStatus == "skipped" ? "skipped" : (r.overdue ? "overdue" : (r.lastStatus ?? "missed"))
    case .failure: return r.lastStatus ?? "failed"
    case .none: return r.overdue ? "overdue" : (r.lastStatus ?? "failed")
    }
}

/// Same as `routineFailureSummary`, but nil when the routine needs no
/// attention at all — the form call sites use to fall back to a neutral
/// "next run" / "paused" line instead of restating a non-issue.
func routineFailureDetail(_ r: Routine, max: Int) -> String? {
    guard routineNeedsAttention(r) else { return nil }
    return routineFailureSummary(r, max: max)
}

/// Groups routines needing attention by a shared cause signature — the
/// readiness code when one is blocking, else the raw last-run status — so N
/// routines hitting the IDENTICAL cause collapse into one row instead of N
/// nearly-identical ones. Never invents a shared cause: two routines that
/// fail for different reasons (or carry no readiness code at all) each keep
/// their own group. Preserves the order causes first appear in `routines`.
func groupedByAttentionCause(_ routines: [Routine]) -> [(String, [Routine])] {
    var order: [String] = []
    var byCause: [String: [Routine]] = [:]
    for r in routines {
        // readiness code first (the most specific signal); failureCode next —
        // two "failed" routines with different failureCodes must NOT collapse
        // into one row just because they share a lastStatus; lastStatus is the
        // last resort, for when neither of the more specific signals exists.
        let cause = r.readiness?.code ?? r.failureCode ?? r.lastStatus ?? "failed"
        if byCause[cause] == nil { order.append(cause) }
        byCause[cause, default: []].append(r)
    }
    return order.map { ($0, byCause[$0]!) }
}

/// Human phrasing for a grouped cause signature — a readiness code
/// ("project_path_missing" -> "project path missing") or a raw lastStatus.
/// Falls back to the literal string with underscores turned to spaces rather
/// than inventing new copy for a code this doesn't recognize.
func readableAttentionCause(_ cause: String) -> String {
    switch cause {
    case "failed": return "failing"
    case "timeout": return "timing out"
    case "missed": return "missing runs"
    case "skipped": return "being skipped"
    case "blocked": return "blocked"
    default: return cause.replacingOccurrences(of: "_", with: " ")
    }
}

/// What the routine submenu's Run-now / Pause-Resume actions should allow.
/// Pure and AppKit-free so it's directly testable: Run is disabled only when
/// readiness EXPLICITLY refuses the next run (`ready == false`); an absent
/// `ready` (older CLI, or a routine readiness never covers) behaves exactly
/// as before — enabled. Resume inherits the same gate (re-enabling a routine
/// that can't run would just fail again); Pause is always allowed.
struct RoutineActionState: Equatable {
    let runEnabled: Bool
    let pauseResumeTitle: String
    let pauseResumeEnabled: Bool
}

func routineActionState(_ r: Routine) -> RoutineActionState {
    let ready = r.ready != false
    let isResume = !r.enabled
    return RoutineActionState(
        runEnabled: ready,
        pauseResumeTitle: isResume ? "Resume" : "Pause",
        pauseResumeEnabled: isResume ? ready : true
    )
}

private func trimText(_ value: String, _ max: Int) -> String {
    if value.count <= max { return value }
    return String(value.prefix(max - 1)) + "…"
}

/// Partitions routines by `projectGroup`, preserving the order of first occurrence.
/// Returns ordered (label, routines) pairs and an ungrouped tail for routines whose
/// `projectGroup` is nil (cross-project / not associated with a single project).
func groupedRoutines(_ routines: [Routine]) -> (grouped: [(String, [Routine])], ungrouped: [Routine]) {
    var order: [String] = []
    var byGroup: [String: [Routine]] = [:]
    var ungrouped: [Routine] = []
    for r in routines {
        if let g = r.projectGroup {
            if byGroup[g] == nil { order.append(g) }
            byGroup[g, default: []].append(r)
        } else {
            ungrouped.append(r)
        }
    }
    return (order.map { ($0, byGroup[$0]!) }, ungrouped)
}
