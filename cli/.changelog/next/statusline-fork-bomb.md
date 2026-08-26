- **Claude status-line delegate no longer fork-bombs the machine.** The delegate
  self-reference guard compared the saved command against the exact literal
  `agents __claude-statusline`, so a delegate seeded with the same private
  subcommand under a *different* binary name (e.g. `agents-dev __claude-statusline`
  from a dev install, or an absolute path) was not recognized as us. Every
  status-line render then `spawnSync`ed that command, which read the same delegate
  and spawned another — unbounded recursion. Observed on a real box: ~4,900 live
  `node __claude-statusline` processes accumulated over a 2-day uptime, exhausting
  96 GB of swap and driving load past 300, so keystrokes lagged. The guard now
  matches the `__claude-statusline` subcommand under any binary name or path
  (`isStatusLineSelfReference`), `installClaudeStatusLine` refuses to persist such
  a command as a delegate (and deletes an already-poisoned delegate on re-install),
  a `AGENTS_CLAUDE_STATUSLINE_DELEGATED` env marker hard-caps delegation at one hop,
  and the delegate `spawnSync` now carries a 5 s timeout. Source:
  `cli/src/lib/claude-statusline.ts`.
