import AppKit

// Spotlight-style quick-issue bar (Cmd-Shift-O). A thin capture surface: type a
// one-line note, optionally attach one or more recent screenshots from clip
// history, hit Return, and it dispatches a headless agent that recalls the
// project from recent sessions, investigates, and files the Linear ticket itself
// (AgentsCLI.dispatchTicketAgent). The panel then gets out of the way — the agent
// does the work, a notification reports the created ticket.
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
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    override func resignKey() {
        super.resignKey()
        onResignKey?()
    }
}

// One clickable clip in the history strip. Draws the image aspect-filled into a
// rounded square; a lime border + full opacity marks it selected, dim + hairline
// marks it available. Click toggles.
final class ClipThumbView: NSView {
    let path: String
    var isSelected = false { didSet { updateChrome() } }
    var onToggle: ((ClipThumbView) -> Void)?
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

    override func mouseDown(with event: NSEvent) { onToggle?(self) }

    private func updateChrome() {
        layer?.borderWidth = isSelected ? 2.5 : 1
        layer?.borderColor = (isSelected ? kAccent : NSColor.separatorColor).cgColor
        animator().alphaValue = isSelected ? 1.0 : 0.55
    }
}

final class PromptPanelController: NSObject, NSTextFieldDelegate {
    // A screenshot older than this isn't pre-selected — but it still shows in the
    // strip for manual attach, since the user can see exactly what they're picking.
    private static let recentClipWindow: TimeInterval = 10 * 60
    private static let panelWidth: CGFloat = 640

    private var panel: PromptPanel?
    private let field = NSTextField()
    private let hint = NSTextField(labelWithString: "")
    private let thumbStrip = NSStackView()
    private var selected: [String] = []   // newest-first order preserved
    private var inFlight = false
    // Click-outside dismissal is armed only AFTER the summon settles — otherwise
    // the key/order race while activating an .accessory app fires resignKey once
    // and the panel dismisses itself the instant it appears.
    private var dismissArmed = false

    // MARK: Summon / dismiss

    func summon() {
        let panel = self.panel ?? buildPanel()
        self.panel = panel

        // Reset for a fresh capture.
        inFlight = false
        field.stringValue = ""
        rebuildThumbs()

        let hasThumbs = !thumbStrip.arrangedSubviews.isEmpty
        thumbStrip.isHidden = !hasThumbs
        panel.setContentSize(NSSize(width: Self.panelWidth, height: hasThumbs ? 188 : 96))

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
        AgentsCLI.dispatchTicketAgent(note: note, screenshotPaths: selected)
        dismiss()
    }

    // Return submits, Escape cancels. A single-line NSTextField sends these as
    // command selectors through the field editor — intercept them here.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { submit(); return true }
        if sel == #selector(NSResponder.cancelOperation(_:)) { dismiss(); return true }
        return false
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
            thumbStrip.addArrangedSubview(thumb)
        }
        updateHint()
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
        let pickable = thumbStrip.arrangedSubviews.isEmpty ? "" : " · click clips to attach"
        hint.stringValue = "\(attach)\(pickable)    ↩ file · esc cancel"
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
            guard let self, self.dismissArmed else { return }
            self.dismiss()
        }

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

        field.placeholderString = "Describe the issue…"
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

        hint.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
        hint.textColor = .secondaryLabelColor

        let stack = NSStackView(views: [field, thumbStrip, hint])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        bg.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: bg.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: bg.trailingAnchor, constant: -22),
            stack.centerYAnchor.constraint(equalTo: bg.centerYAnchor),
            field.widthAnchor.constraint(equalTo: stack.widthAnchor),
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
enum Notifier {
    static func post(title: String, body: String) {
        let note = NSUserNotification()
        note.title = title
        note.informativeText = body
        NSUserNotificationCenter.default.deliver(note)
    }
}
