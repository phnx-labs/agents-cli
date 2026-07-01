import AppKit

// agents-cli menu bar helper. A no-Dock (.accessory) status-bar app whose
// lifecycle is tied to the routines scheduler daemon — the daemon spawns it on
// start and it self-terminates when the daemon's PID goes away.
//
// Usage:
//   MenubarHelper                 # daemon-spawned; quits when daemon stops
//   MENUBAR_STANDALONE=1 ...      # dev: stay up even with no daemon running
//   AGENTS_BIN=/path/to/agents    # override the `agents` binary location

// Benchmark mode: time the data-layer methods that build the menu, then exit.
// No GUI session needed — LocalState reads files, AgentsCLI shells the CLI.
if ProcessInfo.processInfo.environment["MENUBAR_BENCH"] == "1" {
    Bench.run()
    exit(0)
}

// Clip test: persist the current clipboard image + print the scp token, then
// exit. No GUI, no hotkey, no Accessibility grant — verifies persist+format.
if ProcessInfo.processInfo.environment["MENUBAR_CLIP_TEST"] == "1" {
    Clip.printTokenAndExit()
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let controller = StatusItemController()

final class AppDelegate: NSObject, NSApplicationDelegate {
    let controller: StatusItemController
    init(_ c: StatusItemController) { self.controller = c }
    let hotkey = HotkeyManager(onFire: { Clip.run() })
    func applicationDidFinishLaunching(_ notification: Notification) {
        controller.install()
        hotkey.register()
    }
}

let delegate = AppDelegate(controller)
app.delegate = delegate
if ProcessInfo.processInfo.environment["MENUBAR_DUMP"] == "1" {
    controller.install()
    exit(0)
}
app.run()
