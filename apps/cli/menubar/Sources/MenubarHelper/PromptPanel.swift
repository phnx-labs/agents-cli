import AppKit

// Spotlight-style quick-dispatch bar (Cmd-Shift-O). A thin capture surface: type
// a one-line note, optionally attach one or more recent screenshots from clip
// history, pick the agents, and hit Return. "File Ticket" dispatches the ticket
// agent; "Fix" fans out autonomous `agents run --mode auto --name quick-*`
// sessions. The panel then gets out of the way — agents do the work, and
// notifications report results.
//
// Focus is the crux. This is a no-Dock .accessory app, so a borderless panel
// can't take keyboard input by default. Three things, all required on summon:
//   NSApp.activate(ignoringOtherApps:true)  → the process gets the keyboard
//   makeKeyAndOrderFront                     → the window becomes key (needs the
//                                              canBecomeKey override below)
//   makeFirstResponder(field)                → the field editor lands keystrokes
// This deliberately steals focus (Spotlight/Alfred do the same) — scoped to the
// explicit Cmd-Shift-O press only. It does NOT regress the focus-safe clip paste
// (Clip.inject), which has no summon and still targets the frontmost app.

private let kAccent = NSColor(red: 0xa3/255.0, green: 0xe6/255.0, blue: 0x35/255.0, alpha: 1)

// A borderless window returns canBecomeKey == false by default; override so the
// text field can edit. resignKey drives click-outside / app-switch dismissal.
final class PromptPanel: NSPanel {
    var onResignKey: (() -> Void)?
    var onBecomeKey: (() -> Void)?
    // Cmd-1 … Cmd-9 dispatch the Nth listed ticket. Returns true when the index
    // matched a visible row, so an unhandled digit still reaches the field editor.
    var onTicketShortcut: ((Int) -> Bool)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    override func resignKey() {
        super.resignKey()
        onResignKey?()
    }
    override func becomeKey() {
        super.becomeKey()
        onBecomeKey?()
    }

    // A borderless .accessory app has NO main menu, so the standard clipboard key
    // equivalents (Cmd-V/C/X/A) are never dispatched to the field editor and paste
    // silently does nothing. Route them through the responder chain so the text
    // field's editor handles them.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           let key = event.charactersIgnoringModifiers?.lowercased() {
            if let digit = Int(key), digit >= 1, digit <= 9,
               onTicketShortcut?(digit - 1) == true {
                return true
            }
            let selector: Selector?
            switch key {
            case "v": selector = #selector(NSText.paste(_:))
            case "c": selector = #selector(NSText.copy(_:))
            case "x": selector = #selector(NSText.cut(_:))
            case "a": selector = #selector(NSResponder.selectAll(_:))
            default:  selector = nil
            }
            if let selector, NSApp.sendAction(selector, to: nil, from: self) { return true }
        }
        return super.performKeyEquivalent(with: event)
    }
}

// One clickable clip in the history strip. Draws the image aspect-filled into a
// rounded square; a lime border + full opacity marks it selected, dim + hairline
// marks it available. Single click toggles selection; double click previews the
// full image (thumbnails are small — this is how you confirm which one it is).
final class ClipThumbView: NSView {
    let path: String
    var isSelected = false { didSet { updateChrome() } }
    var onToggle: ((ClipThumbView) -> Void)?
    var onPreview: ((ClipThumbView) -> Void)?
    static let side: CGFloat = 54

    init(path: String) {
        self.path = path
        super.init(frame: NSRect(x: 0, y: 0, width: Self.side, height: Self.side))
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.masksToBounds = true
        layer?.backgroundColor = NSColor.black.withAlphaComponent(0.15).cgColor
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: Self.side).isActive = true
        heightAnchor.constraint(equalToConstant: Self.side).isActive = true
        toolTip = (path as NSString).lastPathComponent
        if let img = NSImage(contentsOfFile: path),
           let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            layer?.contents = cg
            layer?.contentsGravity = .resizeAspectFill
        }
        updateChrome()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount >= 2 {
            // Double-click: cancel the pending single-click toggle, open the preview.
            NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(fireToggle), object: nil)
            onPreview?(self)
        } else {
            // Single click: defer the toggle by the double-click interval so a
            // double-click previews WITHOUT also flipping the selection.
            perform(#selector(fireToggle), with: nil, afterDelay: NSEvent.doubleClickInterval)
        }
    }
    @objc private func fireToggle() { onToggle?(self) }

    private func updateChrome() {
        layer?.borderWidth = isSelected ? 2.5 : 1
        layer?.borderColor = (isSelected ? kAccent : NSColor.separatorColor).cgColor
        animator().alphaValue = isSelected ? 1.0 : 0.55
    }
}

// One open Linear ticket in the panel's list. Click dispatches it to the selected
// agents in the picked repo; Cmd-click opens it in Linear instead (the escape hatch
// for "I want to read it first"). A row is a real button-shaped surface — hover
// highlight and a `⌘N` chip — because dispatching an agent on a click needs to look
// deliberate, not incidental.
final class TicketRowView: NSView {
    let ticket: LinearTicket
    var onDispatch: ((LinearTicket) -> Void)?
    var onOpen: ((LinearTicket) -> Void)?
    static let height: CGFloat = 22

    private var hovered = false { didSet { updateChrome() } }

    init(ticket: LinearTicket, index: Int) {
        self.ticket = ticket
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 5
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: Self.height).isActive = true

        let shortcut = Self.label(index < 9 ? "\u{2318}\(index + 1)" : "",
                                  color: .tertiaryLabelColor, width: 24)
        let priority = Self.label(LinearTickets.priorityLabel(ticket.priority),
                                  color: Self.priorityColor(ticket.priority), width: 24)
        let identifier = Self.label(ticket.identifier, color: kAccent, width: 80)
        let state = Self.label(ticket.stateName, color: .tertiaryLabelColor, width: 56)
        // A long title truncates instead of widening the panel.
        let title = Self.label(ticket.title, color: .labelColor, width: nil)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [shortcut, priority, identifier, state, title])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])

        var tip = "\(ticket.identifier) — \(ticket.title)"
        if let due = ticket.dueDate, !due.isEmpty { tip += "\ndue \(due)" }
        tip += "\nclick dispatches · \u{2318}click opens in Linear"
        toolTip = tip
        updateChrome()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: bounds,
                                       options: [.mouseEnteredAndExited, .activeAlways],
                                       owner: self, userInfo: nil))
    }
    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command) {
            onOpen?(ticket)
        } else {
            onDispatch?(ticket)
        }
    }

    private func updateChrome() {
        layer?.backgroundColor = hovered
            ? kAccent.withAlphaComponent(0.14).cgColor
            : NSColor.clear.cgColor
    }

    // Linear's scale: 1 urgent, 2 high, 3 medium, 4 low, 0 none.
    static func priorityColor(_ priority: Int) -> NSColor {
        switch priority {
        case 1: return .systemRed
        case 2: return .systemOrange
        case 3: return .secondaryLabelColor
        default: return .tertiaryLabelColor
        }
    }

    private static func label(_ text: String, color: NSColor, width: CGFloat?) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
        field.textColor = color
        field.translatesAutoresizingMaskIntoConstraints = false
        if let width { field.widthAnchor.constraint(equalToConstant: width).isActive = true }
        return field
    }
}

enum QuickDispatchAction: Int {
    case plan = 0
    case run = 1
}

struct PromptDraft {
    let note: String
    let selectedPaths: [String]
    let selectedAgents: Set<String>
    let action: QuickDispatchAction

    // Pure decision for what to preserve when the panel dismisses without
    // submitting: a note that is empty (or only whitespace) means "nothing to keep"
    // and yields nil so the next summon starts clean; otherwise the note and its
    // current selections round-trip verbatim. Kept as a free function so the
    // save/clear state machine is testable without a live NSPanel (see
    // IssueSelfTest.testDraftPreservation).
    static func forDismissal(note: String,
                             selectedPaths: [String],
                             selectedAgents: Set<String>,
                             action: QuickDispatchAction) -> PromptDraft? {
        if note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return nil
        }
        return PromptDraft(note: note,
                           selectedPaths: selectedPaths,
                           selectedAgents: selectedAgents,
                           action: action)
    }
}

final class PromptPanelController: NSObject, NSTextFieldDelegate {
    // A screenshot older than this isn't pre-selected — but it still shows in the
    // strip for manual attach, since the user can see exactly what they're picking.
    private static let recentClipWindow: TimeInterval = 10 * 60
    private static let panelWidth: CGFloat = 680
    // Panel height is additive: the capture half is fixed, and the screenshot strip
    // and the ticket list each add their own block when they have content.
    private static let baseHeight: CGFloat = 156
    private static let thumbStripHeight: CGFloat = 92
    private static let ticketSectionChrome: CGFloat = 36   // one control row + spacing
    // Fixed viewport for the ticket list — rows scroll inside; panel height does not
    // grow with every ticket (keeps the capture field pinned).
    private static let ticketViewportHeight: CGFloat =
        CGFloat(LinearTickets.viewportRows) * TicketRowView.height

    private var panel: PromptPanel?
    private let field = NSTextField()
    private let modeControl = NSSegmentedControl(labels: ["Plan", "Run"],
                                                 trackingMode: .selectOne,
                                                 target: nil,
                                                 action: nil)
    private let agentStrip = NSStackView()
    private let hint = NSTextField(labelWithString: "")
    private let thumbStrip = NSStackView()
    // Repo the agent runs in — sourced from recent-session cwds, never $HOME. The
    // parallel `repoDirs` holds the full paths behind the shown basenames.
    private let repoPicker = NSPopUpButton(frame: .zero, pullsDown: false)
    private var repoDirs: [String] = []
    private static let lastRepoKey = "menubar.quickDispatch.lastRepo"
    // Ticket half: one compact row of popups (project · filter · sort) — no chip
    // matrices or two-column blocks — then a scrollable flat list.
    private let projectPicker = NSPopUpButton(frame: .zero, pullsDown: false)
    private let filterPicker = NSPopUpButton(frame: .zero, pullsDown: false)
    private let sortPicker = NSPopUpButton(frame: .zero, pullsDown: false)
    private let ticketStatus = NSTextField(labelWithString: "")
    private let ticketList = NSStackView()
    private let ticketScroll = NSScrollView()
    private var linearCache = LinearTickets.Cache()
    private var activeProject: LinearProject?
    private var visibleTickets: [LinearTicket] = []
    private var ticketFilter: LinearTickets.QuickFilter = .all
    private var ticketSort: LinearTickets.QuickSort = .urgentFirst
    // Bumped on every scope change so a slow `linear tasks` answering after the
    // user switched repo/project is dropped instead of overwriting the new list.
    private var ticketFetchToken = 0
    private var repoNamesByDir: [String: String] = [:]
    private var rebuildingProjectPicker = false
    private var rebuildingFilterPickers = false
    private static let projectOverrideKeyPrefix = "menubar.quickDispatch.project."
    private static let lastFilterKey = "menubar.quickDispatch.ticketFilter"
    private static let lastSortKey = "menubar.quickDispatch.ticketSort"
    private var selected: [String] = []   // newest-first order preserved
    private var selectedAgents = Set<String>()
    private var roster: [MenuAgent] = []
    private var agentButtons: [NSButton] = []
    private var action: QuickDispatchAction = .plan
    private var inFlight = false
    private var draft: PromptDraft?
    // Click-outside dismissal is armed only AFTER the summon settles — otherwise
    // the key/order race while activating an .accessory app fires resignKey once
    // and the panel dismisses itself the instant it appears.
    private var dismissArmed = false
    // Set while opening a thumbnail in Preview: Preview taking focus fires the
    // panel's resignKey, which would otherwise dismiss the bar and drop the typed
    // note. Cleared when the bar regains key focus.
    private var suppressDismiss = false

    // MARK: Summon / dismiss

    func summon() {
        let panel = self.panel ?? buildPanel()
        self.panel = panel

        // Restore an interrupted capture if another app stole focus last time.
        let restoredDraft = draft
        inFlight = false
        field.stringValue = restoredDraft?.note ?? ""
        action = restoredDraft?.action ?? .plan
        modeControl.setSelected(true, forSegment: action.rawValue)
        rebuildAgents(restoring: restoredDraft?.selectedAgents)
        rebuildThumbs(restoring: restoredDraft?.selectedPaths)
        rebuildRepos()
        // Tickets render from the warm cache first (a `linear tasks` round trip
        // costs seconds), then refresh in the background.
        linearCache = LinearTickets.loadCache()
        restoreTicketControls()
        refreshTicketScope()

        thumbStrip.isHidden = thumbStrip.arrangedSubviews.isEmpty
        applyContentHeight()

        dismissArmed = false
        position(panel)
        NSApp.activate(ignoringOtherApps: true)
        panel.orderFrontRegardless()
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
        waitUntilReadyForTyping(panel)
        if ProcessInfo.processInfo.environment["MENUBAR_PROMPT_DEBUG"] == "1" {
            FileHandle.standardError.write(Data(
                "summon: frame=\(panel.frame) visible=\(panel.isVisible) thumbs=\(thumbStrip.arrangedSubviews.count)\n".utf8))
        }
        // Arm click-outside dismissal once the activation race has settled. The
        // preview affordance leaves it disarmed: its whole point is to hold the
        // panel on screen for QA and screenshots, and an unbundled dev build does
        // not keep app activation, so an armed panel dismisses itself immediately.
        guard ProcessInfo.processInfo.environment["MENUBAR_PROMPT_PREVIEW"] != "1" else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.dismissArmed = true
        }
    }

    private func dismiss(preservingDraft: Bool = true) {
        dismissArmed = false
        if preservingDraft {
            saveDraftForDismissal()
        } else {
            clearDraft()
        }
        guard let panel, panel.isVisible else { return }
        panel.orderOut(nil)
    }

    private func saveDraftForDismissal() {
        guard !inFlight else { return }
        draft = PromptDraft.forDismissal(note: field.stringValue,
                                         selectedPaths: selected,
                                         selectedAgents: selectedAgents,
                                         action: action)
    }

    private func clearDraft() {
        draft = nil
    }

    private func waitUntilReadyForTyping(_ panel: PromptPanel) {
        let deadline = Date().addingTimeInterval(0.25)
        while Date() < deadline {
            if panel.isKeyWindow, field.currentEditor() != nil { return }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
    }

    // MARK: Submit

    private func submit() {
        let note = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !note.isEmpty, !inFlight else { return }
        inFlight = true
        let agents = selectedAgentList()
        let cwd = selectedRepo()
        if let cwd { UserDefaults.standard.set(cwd, forKey: Self.lastRepoKey) }
        switch action {
        case .plan:
            AgentsCLI.dispatchTicketAgent(note: note, screenshotPaths: selected, agent: agents.first, cwd: cwd)
        case .run:
            AgentsCLI.dispatchQuickFix(note: note, screenshotPaths: selected, agents: agents, cwd: cwd)
        }
        dismiss(preservingDraft: false)
    }

    // Return submits, Escape clears. A single-line NSTextField sends these as
    // command selectors through the field editor — intercept them here.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { submit(); return true }
        if sel == #selector(NSResponder.cancelOperation(_:)) { dismiss(preservingDraft: false); return true }
        return false
    }

    // MARK: Dispatch mode / agents

    @objc private func onModeChanged(_ sender: NSSegmentedControl) {
        action = QuickDispatchAction(rawValue: sender.selectedSegment) ?? .plan
        normalizeSelectionForAction()
        updateAgentButtons()
        updateHint()
    }

    @objc private func onAgentToggle(_ sender: NSButton) {
        guard sender.tag >= 0, sender.tag < roster.count else { return }
        let id = roster[sender.tag].id
        switch action {
        case .plan:
            selectedAgents = [id]
        case .run:
            if sender.state == .on {
                selectedAgents.insert(id)
            } else {
                selectedAgents.remove(id)
            }
            if selectedAgents.isEmpty {
                selectedAgents.insert(id)
            }
        }
        updateAgentButtons()
        updateHint()
    }

    private func rebuildAgents(restoring restoredAgents: Set<String>? = nil) {
        for v in agentStrip.arrangedSubviews {
            agentStrip.removeArrangedSubview(v)
            v.removeFromSuperview()
        }
        roster = LocalState.quickDispatchRoster()
        agentButtons = roster.enumerated().map { index, agent in
            let button = NSButton(checkboxWithTitle: agent.label, target: self,
                                  action: #selector(onAgentToggle(_:)))
            button.tag = index
            button.font = .systemFont(ofSize: 12.5, weight: .medium)
            button.contentTintColor = .labelColor
            return button
        }
        for button in agentButtons { agentStrip.addArrangedSubview(button) }
        selectedAgents = restoredAgents ?? defaultAgentSelection()
        normalizeSelectionForAction()
        updateAgentButtons()
    }

    private func defaultAgentSelection() -> Set<String> {
        let configured = ProcessInfo.processInfo.environment["AGENTS_QUICK_DISPATCH_AGENTS"]?
            .split(separator: ",")
            .map { LocalState.normalizeAgent(String($0).trimmingCharacters(in: .whitespacesAndNewlines)) }
            .filter { id in roster.contains { $0.id == id } } ?? []
        if !configured.isEmpty { return Set(configured) }
        return [roster.first?.id ?? "claude"]
    }

    private func selectedAgentList() -> [String] {
        let ordered = roster.map(\.id).filter { selectedAgents.contains($0) }
        return ordered.isEmpty ? [roster.first?.id ?? "claude"] : ordered
    }

    private func normalizeSelectionForAction() {
        let visible = Set(roster.map(\.id))
        selectedAgents = selectedAgents.intersection(visible)
        if selectedAgents.isEmpty {
            selectedAgents = [roster.first?.id ?? "claude"]
        }
        if action == .plan, let first = selectedAgentList().first {
            selectedAgents = [first]
        }
    }

    private func updateAgentButtons() {
        for (index, button) in agentButtons.enumerated() {
            let id = roster[index].id
            button.state = selectedAgents.contains(id) ? .on : .off
        }
    }

    @objc private func onRepoChanged(_ sender: NSPopUpButton) {
        updateHint()
        // The repo IS the ticket scope: switching it switches the Linear project.
        refreshTicketScope()
    }

    // MARK: Repo picker

    // Populate the repo dropdown from recent-session cwds (never $HOME). The last
    // picked repo is restored; if none is remembered, the most-recent one leads.
    private func rebuildRepos() {
        repoDirs = AgentsCLI.recentRepoDirs()
        repoPicker.removeAllItems()
        guard !repoDirs.isEmpty else {
            repoPicker.addItem(withTitle: "This Mac (no recent repo)")
            repoPicker.isEnabled = false
            return
        }
        repoPicker.isEnabled = true
        for dir in repoDirs {
            repoPicker.addItem(withTitle: "\u{1F4C1} \((dir as NSString).lastPathComponent)")
            repoPicker.lastItem?.toolTip = dir
        }
        if let last = UserDefaults.standard.string(forKey: Self.lastRepoKey),
           let idx = repoDirs.firstIndex(of: last) {
            repoPicker.selectItem(at: idx)
        } else {
            repoPicker.selectItem(at: 0)
        }
    }

    // The absolute path behind the selected repo item, or nil when there is no
    // recent repo (the agent then falls back to This Mac / cwd inheritance).
    private func selectedRepo() -> String? {
        let idx = repoPicker.indexOfSelectedItem
        guard idx >= 0, idx < repoDirs.count else { return nil }
        return repoDirs[idx]
    }

    // MARK: Linear tickets

    // The repo name behind the picked directory — the key that maps to a Linear
    // project. Resolving it shells out to git for the common dir (a worktree must
    // answer with its parent repo), so it runs off the main thread and is memoized
    // for the life of the helper: the first summon for a directory fills its ticket
    // list one beat late, every later summon has the name before the panel is on
    // screen. Deliberately NOT persisted — a directory that gets renamed or
    // repurposed would otherwise keep answering with a name that no longer exists.
    private func currentRepoName() -> String? {
        guard let dir = selectedRepo() else { return nil }
        if let known = repoNamesByDir[dir] { return known }
        resolveRepoName(dir: dir)
        return nil
    }

    private func resolveRepoName(dir: String) {
        DispatchQueue.global(qos: .userInitiated).async {
            let name = AgentsCLI.repoName(forDir: dir)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.repoNamesByDir[dir] = name
                if dir == self.selectedRepo() { self.refreshTicketScope() }
            }
        }
    }

    private func projectOverride(for repoName: String) -> String? {
        UserDefaults.standard.string(forKey: Self.projectOverrideKeyPrefix + repoName)
    }

    @objc private func onProjectChanged(_ sender: NSPopUpButton) {
        // Populating the popup selects its first item, which arrives here as an
        // action — persisting that would pin every repo to whatever project Linear
        // happens to list first.
        guard !rebuildingProjectPicker else { return }
        guard let name = sender.titleOfSelectedItem, let repoName = currentRepoName(),
              name != activeProject?.name else { return }
        // An explicit pick sticks to this repo, which is how a repo whose name
        // matches no project (or matches the wrong one) gets scoped correctly.
        UserDefaults.standard.set(name, forKey: Self.projectOverrideKeyPrefix + repoName)
        refreshTicketScope()
    }

    @objc private func onFilterChanged(_ sender: NSPopUpButton) {
        guard !rebuildingFilterPickers else { return }
        let idx = sender.indexOfSelectedItem
        let all = LinearTickets.QuickFilter.allCases
        guard idx >= 0, idx < all.count else { return }
        ticketFilter = all[idx]
        UserDefaults.standard.set(ticketFilter.rawValue, forKey: Self.lastFilterKey)
        reapplyTicketList()
    }

    @objc private func onSortChanged(_ sender: NSPopUpButton) {
        guard !rebuildingFilterPickers else { return }
        let idx = sender.indexOfSelectedItem
        let all = LinearTickets.QuickSort.allCases
        guard idx >= 0, idx < all.count else { return }
        ticketSort = all[idx]
        UserDefaults.standard.set(ticketSort.rawValue, forKey: Self.lastSortKey)
        reapplyTicketList()
    }

    private func restoreTicketControls() {
        if let raw = UserDefaults.standard.string(forKey: Self.lastFilterKey),
           let f = LinearTickets.QuickFilter(rawValue: raw) {
            ticketFilter = f
        }
        if let raw = UserDefaults.standard.string(forKey: Self.lastSortKey),
           let s = LinearTickets.QuickSort(rawValue: raw) {
            ticketSort = s
        }
        rebuildFilterAndSortPickers()
    }

    private func rebuildFilterAndSortPickers() {
        rebuildingFilterPickers = true
        defer { rebuildingFilterPickers = false }

        filterPicker.removeAllItems()
        for f in LinearTickets.QuickFilter.allCases {
            filterPicker.addItem(withTitle: f.title)
        }
        if let idx = LinearTickets.QuickFilter.allCases.firstIndex(of: ticketFilter) {
            filterPicker.selectItem(at: idx)
        }

        sortPicker.removeAllItems()
        for s in LinearTickets.QuickSort.allCases {
            sortPicker.addItem(withTitle: s.title)
        }
        if let idx = LinearTickets.QuickSort.allCases.firstIndex(of: ticketSort) {
            sortPicker.selectItem(at: idx)
        }
    }

    /// Re-run filter+sort on the cached tickets for the active project (no fetch).
    private func reapplyTicketList() {
        guard let project = activeProject,
              let tickets = linearCache.scopes[project.name]?.tickets else {
            updateHint()
            return
        }
        visibleTickets = rankedAndFiltered(tickets)
        renderTickets()
    }

    // Point the ticket list at the project behind the picked repo: rebuild the
    // project popup, render whatever is cached, and fetch when the cache is stale.
    private func refreshTicketScope() {
        ticketFetchToken += 1
        let repoName = currentRepoName()
        activeProject = LinearTickets.resolveProject(
            repoName: repoName,
            projects: linearCache.projects,
            override: repoName.flatMap { projectOverride(for: $0) })
        rebuildProjectPicker()

        if linearCache.projects.isEmpty { fetchProjects() }

        guard let project = activeProject else {
            visibleTickets = []
            if selectedRepo() == nil {
                renderTickets(status: "pick a repo to see its tickets")
            } else if let repoName {
                renderTickets(status: "no Linear project matches \(repoName) — pick one")
            } else {
                // The repo name is still being resolved (first summon for this dir).
                renderTickets(status: "loading…")
            }
            return
        }
        let cached = linearCache.scopes[project.name]?.tickets
        visibleTickets = rankedAndFiltered(cached ?? [])
        renderTickets(status: cached == nil ? "loading \(project.name)…" : nil)
        if !LinearTickets.isFresh(linearCache, project: project.name) {
            fetchTickets(project: project.name)
        }
    }

    private func fetchProjects() {
        let token = ticketFetchToken
        AgentsCLI.linearProjectsAsync { [weak self] projects in
            guard let self, let projects else { return }
            self.linearCache = LinearTickets.merged(self.linearCache, projects: projects)
            LinearTickets.saveCache(self.linearCache)
            // A project list arriving after a scope change still helps the CURRENT
            // scope, so re-resolve rather than dropping it on the token check.
            if token == self.ticketFetchToken || self.activeProject == nil { self.refreshTicketScope() }
        }
    }

    private func fetchTickets(project: String) {
        let token = ticketFetchToken
        AgentsCLI.linearTicketsAsync(project: project) { [weak self] tickets in
            guard let self else { return }
            guard let tickets else {
                if token == self.ticketFetchToken, self.visibleTickets.isEmpty {
                    self.renderTickets(status: "could not reach Linear")
                }
                return
            }
            self.linearCache = LinearTickets.merged(self.linearCache, project: project,
                                                    tickets: tickets)
            LinearTickets.saveCache(self.linearCache)
            guard token == self.ticketFetchToken, self.activeProject?.name == project else { return }
            self.visibleTickets = self.rankedAndFiltered(tickets)
            self.renderTickets()
        }
    }

    // Quick filter + sort, then the typed note as a text search — so an existing
    // ticket surfaces before Return files a duplicate. Flat list only (no groups).
    private func rankedAndFiltered(_ tickets: [LinearTicket]) -> [LinearTicket] {
        let query = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return LinearTickets.list(tickets,
                                  filter: ticketFilter,
                                  sort: ticketSort,
                                  query: query)
    }

    private func renderTickets(status: String? = nil) {
        for v in ticketList.arrangedSubviews {
            ticketList.removeArrangedSubview(v)
            v.removeFromSuperview()
        }
        for (index, ticket) in visibleTickets.enumerated() {
            let row = TicketRowView(ticket: ticket, index: index)
            row.onDispatch = { [weak self] t in self?.dispatchTicket(t) }
            row.onOpen = { [weak self] t in self?.openTicket(t) }
            ticketList.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: ticketList.widthAnchor).isActive = true
        }
        let empty = visibleTickets.isEmpty
        ticketScroll.isHidden = empty
        ticketStatus.stringValue = status ?? ticketCountText()
        // Document height grows with rows; the scroll viewport stays fixed so the
        // user can scroll through the full filtered set.
        let width = max(ticketScroll.contentSize.width, Self.panelWidth - 44)
        let contentH = max(CGFloat(visibleTickets.count) * TicketRowView.height, 1)
        ticketList.frame = NSRect(x: 0, y: 0, width: width, height: contentH)
        applyContentHeight()
        updateHint()
    }

    private func ticketCountText() -> String {
        guard let project = activeProject else { return "" }
        let total = linearCache.scopes[project.name]?.tickets.count ?? 0
        if total == 0 { return "no open tickets" }
        if visibleTickets.isEmpty {
            return "\(total) open · none match filter"
        }
        let shown = visibleTickets.count
        let sortBit = ticketSort == .urgentFirst ? "urgent first" : ticketSort.title.lowercased()
        if shown < total || ticketFilter != .all {
            return "\(shown)/\(total) · \(sortBit) · \u{2318}N"
        }
        return "\(total) open · \(sortBit) · click or \u{2318}N"
    }

    private func rebuildProjectPicker() {
        rebuildingProjectPicker = true
        defer { rebuildingProjectPicker = false }
        projectPicker.removeAllItems()
        let names = linearCache.projects.map(\.name)
        guard !names.isEmpty else {
            projectPicker.addItem(withTitle: activeProject?.name ?? "Linear project")
            projectPicker.isEnabled = false
            return
        }
        projectPicker.isEnabled = true
        for name in names {
            projectPicker.addItem(withTitle: name)
            projectPicker.lastItem?.toolTip = "Scope the ticket list to \(name)"
        }
        if let active = activeProject, let idx = names.firstIndex(of: active.name) {
            projectPicker.selectItem(at: idx)
        }
    }

    // Cmd-click a row: read the ticket in Linear instead of dispatching it. Same
    // dismissal suppression as the screenshot preview — the browser taking focus
    // must not throw away the typed note.
    private func openTicket(_ ticket: LinearTicket) {
        guard let raw = ticket.url, let url = URL(string: raw) else { return }
        suppressDismiss = true
        NSWorkspace.shared.open(url)
    }

    // Dispatch an EXISTING ticket: same agents, same repo, same balanced headless
    // run as a quick Run — Plan asks for a plan comment on the ticket, Run asks for
    // the change. The panel closes immediately, like a submit does, so a second
    // click can't double-dispatch.
    private func dispatchTicket(_ ticket: LinearTicket) {
        guard !inFlight else { return }
        inFlight = true
        let cwd = selectedRepo()
        if let cwd { UserDefaults.standard.set(cwd, forKey: Self.lastRepoKey) }
        AgentsCLI.dispatchTicketWork(ticket: ticket, agents: selectedAgentList(),
                                     action: action, cwd: cwd)
        dismiss(preservingDraft: false)
    }

    // Dispatch the Nth listed ticket (Cmd-1 … Cmd-9). False when no such row is
    // listed, so the keystroke falls through to the text field.
    private func dispatchTicket(at index: Int) -> Bool {
        guard index >= 0, index < visibleTickets.count else { return false }
        dispatchTicket(visibleTickets[index])
        return true
    }

    // MARK: Thumbnails

    private func rebuildThumbs(restoring restoredSelection: [String]? = nil) {
        for v in thumbStrip.arrangedSubviews {
            thumbStrip.removeArrangedSubview(v)
            v.removeFromSuperview()
        }
        selected = []
        let paths = AgentsCLI.recentImageAttachments()
        let restoredSet = Set(restoredSelection ?? [])
        for path in paths {
            let thumb = ClipThumbView(path: path)
            if restoredSelection != nil {
                if restoredSet.contains(path) {
                    thumb.isSelected = true
                    selected.append(path)
                }
            } else if path == paths.first, isRecent(path) {
                // Pre-select the newest clip only when it's recent enough to relate
                // to what the user just captured.
                thumb.isSelected = true
                selected.append(path)
            }
            thumb.onToggle = { [weak self] t in self?.toggle(t) }
            thumb.onPreview = { [weak self] t in self?.preview(t) }
            thumbStrip.addArrangedSubview(thumb)
        }
        updateHint()
    }

    // Open the full screenshot in the default image viewer so the user can confirm
    // which one it is (thumbnails are small). Suppress the bar's click-outside
    // dismissal so summoning Preview doesn't close the bar / lose the typed note;
    // it re-arms when the bar regains key focus (panel.onBecomeKey).
    private func preview(_ thumb: ClipThumbView) {
        suppressDismiss = true
        NSWorkspace.shared.open(URL(fileURLWithPath: thumb.path))
    }

    private func toggle(_ thumb: ClipThumbView) {
        thumb.isSelected.toggle()
        if thumb.isSelected {
            selected.append(thumb.path)
        } else {
            selected.removeAll { $0 == thumb.path }
        }
        // Keep newest-first order regardless of click order.
        let ordering = AgentsCLI.recentImageAttachments()
        selected.sort { (ordering.firstIndex(of: $0) ?? .max) < (ordering.firstIndex(of: $1) ?? .max) }
        updateHint()
    }

    private func isRecent(_ path: String) -> Bool {
        guard let mtime = (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date
        else { return false }
        return Date().timeIntervalSince(mtime) <= Self.recentClipWindow
    }

    private func updateHint() {
        let count = selected.count
        let attach = count == 0 ? "no image attached"
            : count == 1 ? "1 image attached" : "\(count) images attached"
        let pickable = thumbStrip.arrangedSubviews.isEmpty ? "" : " · click attaches · dbl-click previews"
        let agents = selectedAgentList().map(LocalState.agentLabel).joined(separator: ", ")
        let repoName = selectedRepo().map { " in \(($0 as NSString).lastPathComponent)" } ?? ""
        let actionText = action == .plan
            ? "file ticket + plan with \(agents)\(repoName)"
            : "run \(agents)\(repoName) · balanced"
        // Deliberately unchanged in length by the ticket list: this label's
        // intrinsic width is what sizes the panel, and the rows carry their own
        // `⌘N` chips plus a click/⌘click tooltip, so nothing needs saying here.
        hint.stringValue = "\(attach)\(pickable)    ↩ \(actionText) · esc clear"
    }

    // Typing is also a ticket search: narrow the list so an existing ticket shows
    // up before Return files a duplicate.
    func controlTextDidChange(_ obj: Notification) {
        guard let project = activeProject,
              let tickets = linearCache.scopes[project.name]?.tickets else {
            updateHint()
            return
        }
        visibleTickets = rankedAndFiltered(tickets)
        renderTickets()
    }

    // Height is additive over the fixed capture half; the ticket viewport is a
    // fixed-height scroll area so many open tickets do not push the panel taller.
    // Grows downward from a fixed top edge so an async fill does not shift the
    // text field out from under the cursor.
    private func applyContentHeight() {
        guard let panel else { return }
        var height = Self.baseHeight + Self.ticketSectionChrome
        if !ticketScroll.isHidden {
            height += Self.ticketViewportHeight
        }
        if !thumbStrip.isHidden { height += Self.thumbStripHeight }
        guard abs(panel.frame.height - height) > 0.5 else { return }
        let top = panel.frame.maxY
        panel.setContentSize(NSSize(width: Self.panelWidth, height: height))
        if panel.isVisible {
            panel.setFrameOrigin(NSPoint(x: panel.frame.minX, y: top - panel.frame.height))
        }
    }

    // MARK: Build / layout

    private func buildPanel() -> PromptPanel {
        let panel = PromptPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.panelWidth, height: 188),
            styleMask: [.borderless],
            backing: .buffered, defer: false)
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.onResignKey = { [weak self] in
            guard let self, self.dismissArmed, !self.suppressDismiss else { return }
            self.dismiss()
        }
        // Returning to the bar after a preview re-arms click-outside dismissal.
        panel.onBecomeKey = { [weak self] in self?.suppressDismiss = false }
        panel.onTicketShortcut = { [weak self] index in self?.dispatchTicket(at: index) ?? false }

        let bg = NSVisualEffectView()
        bg.material = .hudWindow
        bg.blendingMode = .behindWindow
        bg.state = .active
        bg.wantsLayer = true
        bg.layer?.cornerRadius = 14
        bg.layer?.masksToBounds = true
        bg.layer?.borderWidth = 1
        bg.layer?.borderColor = kAccent.withAlphaComponent(0.35).cgColor
        panel.contentView = bg

        field.placeholderString = "Describe the task…"
        field.font = .systemFont(ofSize: 21, weight: .regular)
        field.textColor = .labelColor
        field.isBezeled = false
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.lineBreakMode = .byTruncatingTail
        field.usesSingleLineMode = true
        field.delegate = self

        thumbStrip.orientation = .horizontal
        thumbStrip.alignment = .centerY
        thumbStrip.spacing = 8

        modeControl.target = self
        modeControl.action = #selector(onModeChanged(_:))
        modeControl.selectedSegment = QuickDispatchAction.plan.rawValue
        modeControl.segmentStyle = .rounded
        modeControl.translatesAutoresizingMaskIntoConstraints = false

        agentStrip.orientation = .horizontal
        agentStrip.alignment = .centerY
        agentStrip.spacing = 10
        rebuildAgents()

        repoPicker.translatesAutoresizingMaskIntoConstraints = false
        repoPicker.controlSize = .small
        repoPicker.font = .systemFont(ofSize: 12)
        repoPicker.target = self
        repoPicker.action = #selector(onRepoChanged(_:))
        rebuildRepos()

        hint.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
        hint.textColor = .secondaryLabelColor

        projectPicker.translatesAutoresizingMaskIntoConstraints = false
        projectPicker.controlSize = .small
        projectPicker.font = .systemFont(ofSize: 12)
        projectPicker.target = self
        projectPicker.action = #selector(onProjectChanged(_:))

        // Same control size as the project popup — one compact row of dropdowns,
        // not a two-column chip matrix.
        for picker in [filterPicker, sortPicker] {
            picker.translatesAutoresizingMaskIntoConstraints = false
            picker.controlSize = .small
            picker.font = .systemFont(ofSize: 12)
        }
        filterPicker.target = self
        filterPicker.action = #selector(onFilterChanged(_:))
        sortPicker.target = self
        sortPicker.action = #selector(onSortChanged(_:))
        rebuildFilterAndSortPickers()

        ticketStatus.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        ticketStatus.textColor = .tertiaryLabelColor
        ticketStatus.lineBreakMode = .byTruncatingTail
        ticketStatus.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        ticketList.orientation = .vertical
        ticketList.alignment = .leading
        ticketList.spacing = 0
        ticketList.translatesAutoresizingMaskIntoConstraints = false

        // Scrollable ticket body: fixed viewport, document grows with rows.
        // Document view uses flipped coordinate + explicit width so rows stay
        // full-width as the user scrolls (stack-as-document without a flip view
        // pins from the bottom and clips the first rows).
        ticketScroll.drawsBackground = false
        ticketScroll.hasVerticalScroller = true
        ticketScroll.hasHorizontalScroller = false
        ticketScroll.autohidesScrollers = true
        ticketScroll.borderType = .noBorder
        ticketScroll.scrollerStyle = .overlay
        ticketScroll.translatesAutoresizingMaskIntoConstraints = false
        let clip = FlippedClipView()
        clip.drawsBackground = false
        ticketScroll.contentView = clip
        ticketScroll.documentView = ticketList
        clip.postsBoundsChangedNotifications = true

        let controlRow = NSStackView(views: [modeControl, repoPicker])
        controlRow.orientation = .horizontal
        controlRow.alignment = .centerY
        controlRow.spacing = 12

        // One row: project (1:1 Linear scope) · quick filter · quick sort · count.
        // No block cards — same popup language as the repo picker above.
        let ticketTitle = NSTextField(labelWithString: "Tickets")
        ticketTitle.font = .monospacedSystemFont(ofSize: 11, weight: .medium)
        ticketTitle.textColor = .secondaryLabelColor
        let ticketHeader = NSStackView(views: [ticketTitle, projectPicker, filterPicker,
                                               sortPicker, ticketStatus])
        ticketHeader.orientation = .horizontal
        ticketHeader.alignment = .centerY
        ticketHeader.spacing = 8

        let stack = NSStackView(views: [field, controlRow, agentStrip, thumbStrip,
                                        ticketHeader, ticketScroll, hint])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        bg.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: bg.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: bg.trailingAnchor, constant: -22),
            stack.centerYAnchor.constraint(equalTo: bg.centerYAnchor),
            field.widthAnchor.constraint(equalTo: stack.widthAnchor),
            modeControl.widthAnchor.constraint(equalToConstant: 180),
            ticketScroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            ticketScroll.heightAnchor.constraint(equalToConstant: Self.ticketViewportHeight),
            // The panel is a fixed-width bar: cap the popups so long names truncate
            // inside them instead of stretching the window past panelWidth.
            repoPicker.widthAnchor.constraint(lessThanOrEqualToConstant: 200),
            projectPicker.widthAnchor.constraint(lessThanOrEqualToConstant: 160),
            filterPicker.widthAnchor.constraint(lessThanOrEqualToConstant: 110),
            sortPicker.widthAnchor.constraint(lessThanOrEqualToConstant: 120),
        ])
        return panel
    }

    // Center horizontally, sit ~20% above vertical center (where Spotlight lives).
    private func position(_ panel: PromptPanel) {
        guard let screen = NSScreen.main else { panel.center(); return }
        let vf = screen.visibleFrame
        let size = panel.frame.size
        let x = vf.minX + (vf.width - size.width) / 2
        let y = vf.minY + (vf.height - size.height) / 2 + vf.height * 0.20
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }
}

// Top-left origin for the ticket list document view so row 0 is at the top of
// the scroll view (AppKit's default NSClipView is bottom-left).
private final class FlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}

// Local notifications for the ticket flow. NSUserNotification is deprecated but
// needs no framework link and no authorization prompt — right for a signed
// menu-bar helper delivering an occasional user-invoked confirmation.
//
// Clicking a completion notification opens the created ticket. NSUserNotification
// carries no click target on its own, so stash the URL in userInfo and open it
// from the center delegate's didActivate. Also force-present the banner even when
// this (accessory) app is frontmost, so the "Created RUSH-####" notice never gets
// swallowed silently.
final class NotifierDelegate: NSObject, NSUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: NSUserNotificationCenter,
                                didActivate notification: NSUserNotification) {
        if let s = notification.userInfo?["url"] as? String, let url = URL(string: s) {
            NSWorkspace.shared.open(url)
        }
    }
    func userNotificationCenter(_ center: NSUserNotificationCenter,
                                shouldPresent notification: NSUserNotification) -> Bool { true }
}

enum Notifier {
    private static let delegate = NotifierDelegate()
    private static var wired = false

    // Register the click delegate without delivering anything. Called at app
    // launch so the persistent menu-bar instance handles clicks on notifications
    // the daemon posts via one-shot `--notify` processes (RUSH-2030). Idempotent.
    static func wireClickHandler() {
        if !wired {
            NSUserNotificationCenter.default.delegate = delegate
            wired = true
        }
    }

    // `url`, when present, is opened on click (the created ticket, or a routine
    // report/log for daemon notifications). `subtitle` is the secondary line.
    //
    // `agent` names the harness the notification is ABOUT (`claude`, `codex`, …)
    // and drives the banner's RIGHT-hand `contentImage` via AgentAvatar. The LEFT
    // slot is the sending bundle's app icon, which macOS resolves from
    // MenubarHelper.app's LaunchServices record — so the two slots read as
    // "agents-cli, about Claude", the layout the system uses for a YouTube
    // notification (app icon left, channel avatar right). Passing no agent leaves
    // the right slot empty on purpose: `contentImage` used to be the agents-cli
    // app icon, which just repeated the left slot and said nothing.
    static func post(title: String, body: String, subtitle: String? = nil,
                     url: String? = nil, agent: String? = nil) {
        wireClickHandler()
        let note = NSUserNotification()
        note.title = title
        if let subtitle { note.subtitle = subtitle }
        note.informativeText = body
        if let url {
            note.userInfo = ["url": url]
            note.hasActionButton = true
            note.actionButtonTitle = "Open"
        }
        if let image = AgentAvatar.image(for: agent) {
            note.contentImage = image
        }
        NSUserNotificationCenter.default.deliver(note)
    }

    // Daemon notification one-shot: `MenubarHelper --notify --title T --body B
    // [--subtitle S] [--action A] [--agent claude]` (RUSH-2030). The daemon spawns
    // the installed .app in this mode, so the notification is attributed to this
    // bundle and shows its AppIcon (the agents-cli mark) on the left — not the
    // generic osascript icon. `--agent` adds the harness avatar on the right.
    // Delivers, briefly spins the runloop so NSUserNotificationCenter flushes
    // before the short-lived process exits, then exits.
    static func runOneShot(_ args: [String]) -> Never {
        func value(_ flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        guard let title = value("--title"), let body = value("--body") else { exit(2) }
        // Hard self-terminate watchdog: guarantee this one-shot exits even if
        // delivery stalls (a locked screen or WindowServer/XPC hiccup can block
        // NSUserNotificationCenter.deliver on the main thread, so the runloop spin
        // below never reaches its deadline and the process hangs — piling up in
        // the menu bar). It runs on a BACKGROUND queue, not `.main`: a wedged main
        // thread can't starve it, so the force-exit fires regardless of runloop
        // state. 3s sits above the 0.6s happy-path flush and below the Node-side
        // 4s SIGKILL (notify-desktop.ts), so the process reliably ends itself.
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 3) {
            exit(0)
        }
        // Establish the app object so delivery has a running NSApplication to
        // attribute the notification to; never call run() — the runloop spin below
        // drives this short-lived process.
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        post(title: title, body: body, subtitle: value("--subtitle"),
             url: clickURL(for: value("--action")), agent: value("--agent"))
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        exit(0)
    }

    // Map the daemon action deep-link to a URL the click delegate opens:
    //   open:<path>   -> the run report/log file (opens in the default app)
    //   url:<https…>  -> a web target (the PR or ticket a finished run produced)
    //   routines:list -> the runs-history folder (opens in Finder)
    // Any other/absent action yields no click target.
    private static func clickURL(for action: String?) -> String? {
        guard let action else { return nil }
        if action.hasPrefix("open:") {
            return URL(fileURLWithPath: String(action.dropFirst("open:".count))).absoluteString
        }
        if action.hasPrefix("url:") {
            // Only web schemes: the click handler hands this straight to
            // NSWorkspace, so a `file:`/custom scheme here would be an arbitrary
            // open-anything primitive driven by a notification argument.
            let raw = String(action.dropFirst("url:".count))
            guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
                  scheme == "https" || scheme == "http" else { return nil }
            return url.absoluteString
        }
        if action == "routines:list" {
            return URL(fileURLWithPath: "\(NSHomeDirectory())/.agents/.history/runs").absoluteString
        }
        return nil
    }
}
