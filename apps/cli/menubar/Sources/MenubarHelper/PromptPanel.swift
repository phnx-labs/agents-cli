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

private enum QuickDispatchAction: Int {
    case fileTicket = 0
    case fix = 1
}

final class PromptPanelController: NSObject, NSTextFieldDelegate {
    // A screenshot older than this isn't pre-selected — but it still shows in the
    // strip for manual attach, since the user can see exactly what they're picking.
    private static let recentClipWindow: TimeInterval = 10 * 60
    private static let panelWidth: CGFloat = 640

    private var panel: PromptPanel?
    private let field = NSTextField()
    private let modeControl = NSSegmentedControl(labels: ["File Ticket", "Fix"],
                                                 trackingMode: .selectOne,
                                                 target: nil,
                                                 action: nil)
    private let agentStrip = NSStackView()
    private let hint = NSTextField(labelWithString: "")
    private let thumbStrip = NSStackView()
    private var selected: [String] = []   // newest-first order preserved
    private var selectedAgents = Set<String>()
    private var roster: [MenuAgent] = []
    private var agentButtons: [NSButton] = []
    private var action: QuickDispatchAction = .fileTicket
    private var inFlight = false
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

        // Reset for a fresh capture.
        inFlight = false
        field.stringValue = ""
        action = .fileTicket
        modeControl.setSelected(true, forSegment: action.rawValue)
        rebuildAgents()
        rebuildThumbs()

        let hasThumbs = !thumbStrip.arrangedSubviews.isEmpty
        thumbStrip.isHidden = !hasThumbs
        panel.setContentSize(NSSize(width: Self.panelWidth, height: hasThumbs ? 248 : 156))

        dismissArmed = false
        position(panel)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
        if ProcessInfo.processInfo.environment["MENUBAR_PROMPT_DEBUG"] == "1" {
            FileHandle.standardError.write(Data(
                "summon: frame=\(panel.frame) visible=\(panel.isVisible) thumbs=\(thumbStrip.arrangedSubviews.count)\n".utf8))
        }
        // Arm click-outside dismissal once the activation race has settled.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.dismissArmed = true
        }
    }

    private func dismiss() {
        dismissArmed = false
        guard let panel, panel.isVisible else { return }
        panel.orderOut(nil)
    }

    // MARK: Submit

    private func submit() {
        let note = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !note.isEmpty, !inFlight else { return }
        inFlight = true
        let agents = selectedAgentList()
        switch action {
        case .fileTicket:
            AgentsCLI.dispatchTicketAgent(note: note, screenshotPaths: selected, agent: agents.first)
        case .fix:
            AgentsCLI.dispatchQuickFix(note: note, screenshotPaths: selected, agents: agents)
        }
        dismiss()
    }

    // Return submits, Escape cancels. A single-line NSTextField sends these as
    // command selectors through the field editor — intercept them here.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { submit(); return true }
        if sel == #selector(NSResponder.cancelOperation(_:)) { dismiss(); return true }
        return false
    }

    // MARK: Dispatch mode / agents

    @objc private func onModeChanged(_ sender: NSSegmentedControl) {
        action = QuickDispatchAction(rawValue: sender.selectedSegment) ?? .fileTicket
        normalizeSelectionForAction()
        updateAgentButtons()
        updateHint()
    }

    @objc private func onAgentToggle(_ sender: NSButton) {
        guard sender.tag >= 0, sender.tag < roster.count else { return }
        let id = roster[sender.tag].id
        switch action {
        case .fileTicket:
            selectedAgents = [id]
        case .fix:
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

    private func rebuildAgents() {
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
        selectedAgents = defaultAgentSelection()
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
        if action == .fileTicket, let first = selectedAgentList().first {
            selectedAgents = [first]
        }
    }

    private func updateAgentButtons() {
        for (index, button) in agentButtons.enumerated() {
            let id = roster[index].id
            button.state = selectedAgents.contains(id) ? .on : .off
        }
    }

    // MARK: Thumbnails

    private func rebuildThumbs() {
        for v in thumbStrip.arrangedSubviews {
            thumbStrip.removeArrangedSubview(v)
            v.removeFromSuperview()
        }
        selected = []
        let paths = AgentsCLI.recentImageAttachments()
        for path in paths {
            let thumb = ClipThumbView(path: path)
            // Pre-select the newest clip only when it's recent enough to relate
            // to what the user just captured.
            if path == paths.first, isRecent(path) {
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
        let actionText = action == .fileTicket ? "file ticket with \(agents)" : "fix with \(agents)"
        hint.stringValue = "\(attach)\(pickable)    ↩ \(actionText) · esc cancel"
    }

    // MARK: Build / layout

    private func buildPanel() -> PromptPanel {
        let panel = PromptPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.panelWidth, height: 188),
            styleMask: [.nonactivatingPanel, .borderless],
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

        field.placeholderString = "Describe the issue or fix…"
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
        modeControl.selectedSegment = QuickDispatchAction.fileTicket.rawValue
        modeControl.segmentStyle = .rounded
        modeControl.translatesAutoresizingMaskIntoConstraints = false

        agentStrip.orientation = .horizontal
        agentStrip.alignment = .centerY
        agentStrip.spacing = 10
        rebuildAgents()

        hint.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
        hint.textColor = .secondaryLabelColor

        let stack = NSStackView(views: [field, modeControl, agentStrip, thumbStrip, hint])
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

    // `url`, when present, is opened on click (the created ticket).
    static func post(title: String, body: String, url: String? = nil) {
        if !wired {
            NSUserNotificationCenter.default.delegate = delegate
            wired = true
        }
        let note = NSUserNotification()
        note.title = title
        note.informativeText = body
        if let url {
            note.userInfo = ["url": url]
            note.hasActionButton = true
            note.actionButtonTitle = "Open"
        }
        NSUserNotificationCenter.default.deliver(note)
    }
}
