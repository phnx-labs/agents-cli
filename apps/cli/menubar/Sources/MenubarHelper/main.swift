import AppKit
import Carbon.HIToolbox

// agents-cli menu bar helper. A no-Dock (.accessory) status-bar app run as a
// launchd user agent (`com.phnx-labs.agents-menubar`, KeepAlive), installed and
// started by `agents menubar enable` -> install-menubar.ts. Do NOT hand-launch
// the interactive mode: launchd starts it in the GUI session, which is the only
// context where its global chords can hold the Accessibility grant they need
// (see Guards.swift).
//
// Usage:
//   MenubarHelper                 # status item + global hotkeys (launchd-started)
//   MenubarHelper --notify ...    # one-shot: post a desktop notification, exit
//   AGENTS_BIN=/path/to/agents    # override the `agents` binary location

// One-shot notification delivery for the daemon (RUSH-2030). Posts and exits
// WITHOUT starting the status-bar UI, so the daemon can fire branded, actionable
// notifications by spawning the installed .app in this mode. The notification is
// attributed to this bundle, so it shows the app's AppIcon (the agents-cli mark)
// instead of the generic osascript/Script Editor icon. See Notifier (PromptPanel.swift).
if CommandLine.arguments.contains("--notify") {
    Notifier.runOneShot(CommandLine.arguments)
}

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

// Launch-guard self-test: exercise the remote-shell and argument predicates
// that gate the interactive mode below, print PASS/FAIL, exit. See Guards.swift.
if ProcessInfo.processInfo.environment["MENUBAR_GUARD_TEST"] == "1" {
    GuardsSelfTest.run()
}

// Everything past here installs the status item and registers the global
// chords, so it must only run where those chords can actually be serviced.
// Refuses an ssh-started launch or an unrecognized flag — the two ways a helper
// that can never hold the Accessibility grant has ended up owning Cmd-Shift-V.
Guards.enforceForInteractiveLaunch()

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
        // Own notification click-through (RUSH-2030): the daemon posts branded
        // notifications via one-shot `--notify` processes, but this persistent
        // instance is the NSUserNotificationCenter delegate that opens their
        // click URL (a run report/log, or the runs folder) when clicked.
        Notifier.wireClickHandler()
        let mods = UInt32(cmdKey | shiftKey)
        hotkey.register([
            .init(id: HotkeyManager.clipID, keyCode: UInt32(kVK_ANSI_V), modifiers: mods,
                  label: "Cmd-Shift-V (paste clip reference)",
                  onFire: { Clip.run() }),
            .init(id: HotkeyManager.promptID, keyCode: UInt32(kVK_ANSI_O), modifiers: mods,
                  label: "Cmd-Shift-O (quick capture)",
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
