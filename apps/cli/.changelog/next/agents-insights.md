- **New: `agents insights` — how you work, split by the Claude account that did the
  work.** Tool and language mix, friction (interruptions, tool-error classes, your own
  reply latency), what you changed (line deltas, files, commits), an hour-of-day
  rhythm, and how often two accounts ran at once. Modelled on Claude Code's
  `/insights`, with the difference that motivated it: that command reads one account's
  directory, while `balanced` rotation sprays sessions across every signed-in account,
  so it describes a fraction of the work and credits all of it to one org. Source:
  `apps/cli/src/commands/insights.ts`, `apps/cli/src/lib/session/insights.ts`.

  Deterministic and offline by default. `--narrative` is opt-in and adds a written read
  by piping the *aggregate* — never raw transcripts, unlike `/insights` — through a
  headless `claude -p`. Facets are cached per session in a new `session_insights` table
  keyed on `(file_mtime_ms, file_size)`, so the first run parses every transcript once
  and later runs re-read only what changed.

- **The Claude parser no longer discards interruption markers.** `[Request interrupted`
  text was dropped outright, so the signal was unrecoverable downstream. It now emits a
  dedicated `interrupt` SessionEvent — kept out of the message stream, where every
  renderer and the topic extractor would have shown it as something the user typed.
  Source: `apps/cli/src/lib/session/parse.ts`.
