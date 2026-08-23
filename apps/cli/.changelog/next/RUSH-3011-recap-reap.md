- **Session rows show what the agent DID, and dead crash-orphans stop piling up (RUSH-3011).**
  The `agents sessions watch --json` row (which the AGI EXT Fleet reads) now carries a
  **recap** so a row reads as the agent's work, not its stale first prompt: `title` follows
  a best-source-wins ladder — a `/rename`/harness `label` → a cached agent recap → the last
  agent line → the first-prompt topic — and `recapSource` (`'label'|'agent'|'last'|'prompt'`)
  names which rung won, so a session that produced work shows an agent-derived line. The first
  user turn is cleaned into `userPromptClean`/`userPromptKind` (with `lastAgentLine` exposed)
  so a screenshot path folds to `[image]`, a pasted `$ cmd` to the command, and a `/skill`
  install path to `/<name>` — path noise never shows on the "You" line — and the recap card's
  `Prompt:` line uses the same cleaning. Separately, a crash-leaked `--device` tunnel session
  that is genuinely dead and days-stale (`abandoned` + dead pid) is folded OUT of the
  reconnectable set (`resumable: false`, `recovery: null`), so the "Needs reconnecting" list
  stops ballooning; a live pid (idle-but-unfinished) or a recently-closed session is never
  reaped. Source: `apps/cli/src/lib/session/{prompt,active,render}.ts`,
  `apps/cli/src/lib/session/remote/watch.ts`, `apps/cli/docs/sessions.md`.
