import Foundation

// Launch guards for the interactive mode (status item + global hotkeys).
//
// The helper's two global chords are only useful if THIS bundle can act on
// them: Cmd-Shift-V synthesizes a Cmd-V keystroke (Clip.inject), which needs an
// Accessibility (TCC) grant, and TCC grants are keyed to a code identity.
// Two ways a helper that can never hold that grant has ended up owning the
// chords anyway — both refused here at launch rather than diagnosed afterwards:
//
//   1. Started from an ssh session. Its TCC requests are attributed to the
//      RESPONSIBLE process, /usr/libexec/sshd-keygen-wrapper, not to this
//      bundle. The user gets an "sshd-keygen-wrapper would like to control this
//      computer" prompt; granting it does nothing for the helper and hands
//      keystroke synthesis to every process any ssh session spawns. And since
//      RegisterEventHotKey is first-come, whichever helper started first owns
//      the chord — so when this one wins it, Cmd-Shift-V stops reaching the
//      launchd-managed bundle that IS trusted, and the paste silently dies.
//   2. Started with an unrecognized flag. Every mode other than `--notify` is
//      env-gated, so an unknown flag used to fall straight through to
//      `app.run()` — a stray `MenubarHelper --self-test` from a verify run left
//      a permanent second status-bar app holding Cmd-Shift-V.
//
// The supported launch path is `launchctl bootstrap gui/<uid>`
// (`agents menubar enable`, install-menubar.ts). launchd starts the helper in
// the GUI session with no SSH_* in its environment, so neither guard can fire
// for it — including when `agents menubar enable` itself is run over ssh.
enum Guards {
    // Variables set by sshd in a remote shell's environment. SSH_AUTH_SOCK is
    // deliberately NOT here: launchd's GUI session exports an agent socket, so
    // matching on it would refuse the supported launch path.
    private static let remoteShellVars = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]

    /// The name of the ssh variable that marks this process as a child of a
    /// remote shell, or nil when running in the local GUI session.
    static func remoteShellVariable(
        _ environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String? {
        remoteShellVars.first { !(environment[$0] ?? "").isEmpty }
    }

    /// Arguments the interactive mode does not accept. `--notify` is handled
    /// before this (Notifier.runOneShot never returns), so by the time the
    /// interactive path is reached, ANY remaining argument is unrecognized.
    static func unrecognizedArguments(_ arguments: [String]) -> [String] {
        Array(arguments.dropFirst())
    }

    /// Refuse the interactive path when either guard trips. Returns only when
    /// it is safe to install the status item and register the global chords.
    static func enforceForInteractiveLaunch() {
        let extra = unrecognizedArguments(CommandLine.arguments)
        if !extra.isEmpty {
            fail("""
            unrecognized argument\(extra.count == 1 ? "" : "s"): \(extra.joined(separator: " "))

            usage:
              MenubarHelper              status item + global hotkeys
              MenubarHelper --notify …   post one notification and exit

            every other mode is env-gated:
              MENUBAR_BENCH=1  MENUBAR_CLIP_TEST=1  MENUBAR_ISSUE_TEST=1  MENUBAR_GUARD_TEST=1
            """)
        }

        if let variable = Guards.remoteShellVariable() {
            fail("""
            refusing to start the status item over a remote shell (\(variable) is set).

            A helper started from ssh cannot hold the Accessibility grant its
            Cmd-Shift-V paste needs — macOS attributes the request to
            /usr/libexec/sshd-keygen-wrapper instead of this bundle — and
            registering the chord here takes it away from the launchd-managed
            helper that can.

            Start it in the GUI session instead:
              agents menubar enable
            """)
        }
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("MenubarHelper: \(message)\n".utf8))
        exit(2)
    }
}
