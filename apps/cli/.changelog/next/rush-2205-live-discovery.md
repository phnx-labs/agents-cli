- **`agents sessions --orphan`/`--active`: cross-harness live discovery + richer rows (RUSH-2205).**
  Two fixes. (1) The headless `ps`-scan recognized only 6 agent executables, so a
  bare-headless `grok`/`kimi`/`antigravity`/`openclaw`/`hermes`/`rush` run was
  silently dropped from the live views; the comm→kind map is now derived from
  `SESSION_AGENTS` × the AGENTS registry (`cliCommand`), so every discoverable
  harness surfaces. (2) Each live row now shows the agent **version** and a human
  **created · idle** time cell, and backfills the **ticket/PR/label** from the
  indexed session history onto orphan rows that lack them, with the label/topic on
  its own line — grouped-by-directory layout unchanged, rows stay width-safe.
  Source: `apps/cli/src/lib/session/active.ts`, `apps/cli/src/commands/sessions.ts`.
