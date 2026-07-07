import AppKit
import CoreGraphics
import Foundation

// Translucent floating overlay marking where the helper is about to click /
// is dragging. Purely visual — set ignoresMouseEvents=true so it never
// intercepts a real click. Sits at .statusBar level so it floats above
// normal app windows but below the system menu bar overlays.
//
// Threading: NSWindow operations must run on the main thread; the RPC
// dispatcher calls Sprite.flash() / Sprite.move() / Sprite.hide() from
// background threads, and these methods dispatch onto main themselves.
//
// All callsites are wrapped in `Sprite.enabled` so the helper can run
// headless (env var or future RPC toggle) for CI and test runs.
final class CursorSprite {
    static let shared = CursorSprite()

    // Disabled at startup if COMPUTER_HELPER_NO_SPRITE is set. Lets test
    // harnesses (probe.py, e2e-test.sh) avoid spurious UI without code.
    static var enabled: Bool {
        ProcessInfo.processInfo.environment["COMPUTER_HELPER_NO_SPRITE"] == nil
    }

    private var window: NSWindow?
    private var hideWorkItem: DispatchWorkItem?
    private let size: CGFloat = 28

    private init() {}

    // Flash at a screen-coords point (Quartz top-left origin), hide after
    // durationMs. Repeated calls reset the hide timer so a sequence of
    // clicks looks continuous.
    func flash(at point: CGPoint, durationMs: Int = 350) {
        guard Self.enabled else { return }
        DispatchQueue.main.async { [weak self] in
            self?.showOrMove(to: point)
            self?.scheduleHide(afterMs: durationMs)
        }
    }

    // Show at the start of a drag, leave visible. Caller pairs with move()
    // for each intermediate point and hide() at the end.
    func showFor(drag at: CGPoint) {
        guard Self.enabled else { return }
        DispatchQueue.main.async { [weak self] in
            self?.hideWorkItem?.cancel()
            self?.showOrMove(to: at)
        }
    }

    func move(to point: CGPoint) {
        guard Self.enabled, window != nil else { return }
        DispatchQueue.main.async { [weak self] in
            self?.setOrigin(at: point)
        }
    }

    func hide() {
        guard Self.enabled else { return }
        DispatchQueue.main.async { [weak self] in
            self?.window?.orderOut(nil)
            self?.hideWorkItem?.cancel()
            self?.hideWorkItem = nil
        }
    }

    // MARK: - private (main thread only)

    private func showOrMove(to point: CGPoint) {
        if window == nil { window = makeWindow() }
        setOrigin(at: point)
        window?.orderFrontRegardless()
    }

    private func scheduleHide(afterMs ms: Int) {
        hideWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.window?.orderOut(nil)
        }
        hideWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms), execute: work)
    }

    // Convert Quartz screen coords (top-left origin, used by CGEvent /
    // AXFrame) to AppKit screen coords (bottom-left origin, used by NSWindow).
    // Anchored on the screen containing the point so multi-display setups
    // don't flip Y onto the wrong monitor.
    private func setOrigin(at point: CGPoint) {
        guard let w = window else { return }
        let screen = NSScreen.screens.first { NSPointInRect(NSPoint(x: point.x, y: point.y), $0.frame) }
            ?? NSScreen.main
        let screenHeight = screen?.frame.maxY ?? 0
        let ns = NSPoint(x: point.x - size / 2, y: screenHeight - point.y - size / 2)
        w.setFrameOrigin(ns)
    }

    private func makeWindow() -> NSWindow {
        let rect = NSRect(x: 0, y: 0, width: size, height: size)
        let win = NSWindow(contentRect: rect, styleMask: .borderless, backing: .buffered, defer: false)
        win.level = .statusBar
        win.isOpaque = false
        win.backgroundColor = .clear
        win.ignoresMouseEvents = true
        win.hasShadow = false
        win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]

        let view = NSView(frame: rect)
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.clear.cgColor

        // Outer halo: low-alpha pulse circle.
        let halo = CAShapeLayer()
        halo.path = CGPath(ellipseIn: rect, transform: nil)
        halo.fillColor = NSColor.systemBlue.withAlphaComponent(0.20).cgColor
        halo.strokeColor = NSColor.systemBlue.withAlphaComponent(0.55).cgColor
        halo.lineWidth = 1.5

        // Inner dot: high-contrast brand color.
        let inset: CGFloat = 9
        let dotRect = rect.insetBy(dx: inset, dy: inset)
        let dot = CAShapeLayer()
        dot.path = CGPath(ellipseIn: dotRect, transform: nil)
        dot.fillColor = NSColor.systemBlue.cgColor
        dot.strokeColor = NSColor.white.withAlphaComponent(0.95).cgColor
        dot.lineWidth = 1.5

        view.layer?.addSublayer(halo)
        view.layer?.addSublayer(dot)
        win.contentView = view
        return win
    }
}
