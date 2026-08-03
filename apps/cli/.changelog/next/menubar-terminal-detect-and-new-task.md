- **The menu bar's New Session opens in the terminal you actually work in.** It
  hardcoded AppleScript at Terminal.app, so a Ghostty or iTerm user got a
  Terminal.app window every time. It now shells `agents run <agent> --terminal`,
  and the CLI resolves the terminal from the user's own live sessions — the host
  app `agents sessions --active` already attributes every session to
  (`ActiveSession.host`). Order: the terminal the caller is in, then the host of
  the most recent live session, then the first available backend. Hosts map to
  backends only where the engine can really drive them, so an undrivable host
  (Warp, kitty, Cursor) falls through instead of opening the wrong app. A
  tmux-hosted session (every interactive `agents run`) resolves to the app its
  attached tmux client is in, via the same resolver behind
  `agents sessions`' "viewing in Ghostty tab 2" — without that it would name the
  multiplexer and no terminal at all. Source:
  `apps/cli/src/lib/terminal/preferred.ts`,
  `apps/cli/src/lib/terminal/backends/terminal-app.ts`,
  `apps/cli/menubar/Sources/MenubarHelper/AgentsCLI.swift`.

- **`agents run <agent> --terminal` opens a run in a real terminal tab.** For a
  caller that cannot host a TUI (the menu bar, a script). Without a value the
  terminal is detected as above; `--terminal <backend>` forces one
  (`iterm | ghostty | terminal | tmux | vscodium-agent`) and errors on an unknown
  id rather than silently auto-detecting. The tab re-invokes the same argv with
  the flag stripped, so `--mode`, `--cwd`, and a `--` passthrough ride along.
  Cannot combine with `--host`. Source: `apps/cli/src/lib/terminal/run-surface.ts`,
  `apps/cli/src/commands/exec.ts`.

- **Terminal.app is a real launch backend now (`terminal`).** Registered last, so
  it is the every-Mac floor without outranking a terminal the user chose to
  install, and reported unavailable over SSH where `osascript` cannot reach the
  GUI login. It has no scriptable split, so a split request opens a tab — stated
  rather than silently dropped. `detectCurrentBackend` also recognizes
  `TERM_PROGRAM=Apple_Terminal`. Source:
  `apps/cli/src/lib/terminal/backends/terminal-app.ts`.

- **New Task… in the menu bar.** A row above New Session that opens the
  quick-dispatch bar — the same panel as `Cmd-Shift-O`, now reachable without the
  chord (and without the Accessibility grant the chord needs). The status item
  owns the one panel instance, so an interrupted capture is restored whichever
  entry point you return through. Source:
  `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`.
