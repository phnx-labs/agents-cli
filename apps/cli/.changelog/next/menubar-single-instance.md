- **The menu bar is a single instance, always.** Two copies of the helper could
  run at once — launchd's `KeepAlive` service plus a LaunchServices/`open` launch
  of the same `.app` — putting two agents marks in the menu bar, and the second
  copy could hold `Cmd-Shift-V`/`Cmd-Shift-O` (`RegisterEventHotKey` is
  first-come). The helper now takes an `flock` on
  `~/.agents/.cache/state/menubar.lock` at launch and holds it for its lifetime;
  a helper that cannot take the lock pops the **running** helper's menu open and
  exits 0, since re-launching a menu-bar app means "show me the one I already
  have". An `flock` rather than a pid file: the kernel releases it when the
  holder dies, so a `SIGKILL`ed helper cannot leave a stale "already running"
  that blocks every later launch. Source:
  `apps/cli/menubar/Sources/MenubarHelper/SingleInstance.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`.

- **`agents menubar setup` configures the menu bar end-to-end.** One idempotent
  command for a machine that is wrong — never configured, helper down, or showing
  a duplicate icon. It ends every running helper, installs/refreshes the bundle,
  checks its code signature, writes the launchd login item (`RunAtLoad` +
  `KeepAlive`), clears a previous `agents menubar disable`, and verifies exactly
  one helper came back up — reporting each as its own step and exiting nonzero if
  it cannot reach that state. `--check` reports without changing; `--json` emits
  the step list. Source: `apps/cli/src/commands/menubar.ts`,
  `apps/cli/src/lib/menubar/install-menubar.ts`.

- **`agents menubar status` now shows a duplicate.** Live helper processes were
  collapsed to a boolean `running`, so two copies of the *installed* bundle — the
  duplicate a user actually sees — reported as healthy. `--json` now carries an
  `instances` array (copies of the installed bundle) beside the existing
  `foreignInstances`, and the text readout names every extra pid and points at
  `agents menubar setup`. Source:
  `apps/cli/src/lib/menubar/install-menubar.ts` (`classifyMenubarProcesses`).
