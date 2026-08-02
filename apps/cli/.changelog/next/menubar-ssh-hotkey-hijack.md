- **Cmd-Shift-V clip paste no longer breaks with an "sshd-keygen-wrapper would like
  to control this computer" prompt.** A menu-bar helper started from an ssh session
  registered the global chords but could never service them: macOS attributes its
  Accessibility request to the responsible process, `/usr/libexec/sshd-keygen-wrapper`,
  not to the helper's bundle, so the prompt named a process whose grant does nothing
  for the paste (and, if granted, hands keystroke synthesis to everything any ssh
  session spawns). And because `RegisterEventHotKey` is first-come, that copy — up
  since before the trusted launchd helper — also held Cmd-Shift-V away from it. The
  interactive
  mode now refuses to start over a remote shell, and refuses unrecognized arguments —
  an unknown flag used to fall straight through to the status-bar app, which is how a
  stray `MenubarHelper --self-test` from a verify run became a permanent second
  helper. `launchctl bootstrap` (`agents menubar enable`) is unaffected, including
  when run over ssh. Source: `apps/cli/menubar/Sources/MenubarHelper/Guards.swift`.

- **`agents menubar status` now names a second helper process instead of reporting a
  healthy `running: yes`.** The check was `pgrep -f MenubarHelper`, which matches any
  process with that name, so a stray copy holding the global chords looked identical
  to a working install. Status now identifies the helper by its resolved executable
  (`ps -o comm=`), reports `running` only for the installed bundle, and lists every
  other live copy with its pid under `foreignInstances` (also in `--json`). Source:
  `apps/cli/src/lib/menubar/install-menubar.ts`.

- **The menu bar now says so when a hotkey is unavailable or the paste is not
  permitted.** A `RegisterEventHotKey` conflict only wrote a line to a launchd log,
  and a missing Accessibility grant made `Clip.inject` return silently — both looked
  exactly like a dead hotkey. A stolen chord now posts a notification naming it, and a
  denied grant copies the `host:path` reference to the clipboard and says which
  setting to grant, so the clip is never lost. Source:
  `apps/cli/menubar/Sources/MenubarHelper/Hotkey.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/Clip.swift`.
