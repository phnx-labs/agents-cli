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

- **The Claude parser can surface interruption markers on request.** `[Request
  interrupted` text was dropped outright, so the signal was unrecoverable downstream.
  `parseSession(..., { includeInterrupts: true })` now emits a dedicated `interrupt`
  event. It stays OFF by default because the event array is a versioned consumer
  contract: `agents sessions <id> --json` serializes it verbatim, `computeSummaryStats`
  folds every timestamp into the session duration, and the live-state reader inspects a
  fixed window of trailing events. `agents insights` is the only caller that opts in.
  Source: `apps/cli/src/lib/session/parse.ts`.

- **`digest.ts` now classifies droid's `Create` as a file write.** Its tool-vocabulary
  set claimed cross-harness coverage but omitted it, so droid file creations classified
  as nothing. Source: `apps/cli/src/lib/session/digest.ts`.
