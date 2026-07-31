- **`agents run antigravity "prompt"` now works headless without an explicit
  `--headless`.** Antigravity's `--print` flag was gated on the raw `--headless`
  flag, which defaults to `false` at the CLI layer — but headless is inferred from
  prompt presence. So a bare `agents run antigravity "do X"` built `agy <prompt>`
  with no `--print`, launching the interactive TUI and dying with
  `bubbletea: could not open TTY: /dev/tty` in any non-terminal shell (headless
  runs, teams, routines, `--host`). Print flags are now gated on the resolved
  headless state, matching the documented "`--headless` auto-enabled when a prompt
  is provided" contract and the behavior of every other agent. Antigravity was the
  only agent affected — it is the sole harness whose prompt is a bare positional
  with no headless subcommand and no `-p` print alias. Source:
  `apps/cli/src/lib/exec.ts`.
