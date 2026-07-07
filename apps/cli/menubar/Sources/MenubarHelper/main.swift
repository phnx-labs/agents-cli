import AppKit
import Carbon.HIToolbox

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

// Issue-capture self-test: exercise the quick-issue logic (newest-clip pick,
// ticket-id parse, prompt contract) against real code, print PASS/FAIL, exit.
// No GUI, no hotkey. See IssueSelfTest.swift.
if ProcessInfo.processInfo.environment["MENUBAR_ISSUE_TEST"] == "1" {
    IssueSelfTest.run()
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let controller = StatusItemController()

final class AppDelegate: NSObject, NSApplicationDelegate {
    let controller: StatusItemController
    init(_ c: StatusItemController) { self.controller = c }
    let hotkey = HotkeyManager()
    let promptController = PromptPanelController()
    func applicationDidFinishLaunching(_ notification: Notification) {
        controller.install()
        let mods = UInt32(cmdKey | shiftKey)
        hotkey.register([
            .init(id: HotkeyManager.clipID, keyCode: UInt32(kVK_ANSI_V), modifiers: mods,
                  onFire: { Clip.run() }),
            .init(id: HotkeyManager.promptID, keyCode: UInt32(kVK_ANSI_O), modifiers: mods,
                  onFire: { [weak self] in self?.promptController.summon() }),
        ])
        // Preview the quick-issue panel without the global hotkey (QA / a machine
        // where synthesizing a system hotkey isn't possible): MENUBAR_PROMPT_PREVIEW=1.
        if ProcessInfo.processInfo.environment["MENUBAR_PROMPT_PREVIEW"] == "1" {
            promptController.summon()
        }
    }
}

let delegate = AppDelegate(controller)
app.delegate = delegate
if ProcessInfo.processInfo.environment["MENUBAR_DUMP"] == "1" {
    controller.install()
    exit(0)
}
app.run()
