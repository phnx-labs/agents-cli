import AppKit

// agents-cli menu bar helper. A no-Dock (.accessory) status-bar app whose
// lifecycle is tied to the routines scheduler daemon — the daemon spawns it on
// start and it self-terminates when the daemon's PID goes away.
//
// Usage:
//   MenubarHelper                 # daemon-spawned; quits when daemon stops
//   MENUBAR_STANDALONE=1 ...      # dev: stay up even with no daemon running
//   AGENTS_BIN=/path/to/agents    # override the `agents` binary location

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let controller = StatusItemController()

final class AppDelegate: NSObject, NSApplicationDelegate {
    let controller: StatusItemController
    init(_ c: StatusItemController) { self.controller = c }
    func applicationDidFinishLaunching(_ notification: Notification) {
        controller.install()
    }
}

let delegate = AppDelegate(controller)
app.delegate = delegate
app.run()
