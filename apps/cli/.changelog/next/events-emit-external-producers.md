- **`agents events emit` — record events produced outside the CLI.** In-process code
  calls `emit()` directly, but the producers that most need to record events are not
  agents-cli processes: the Factory VS Code extension host, shell guards, external
  tools. They now pipe JSONL on stdin —
  `… | agents events emit --source factory`. `--source` is stamped as `module`, so
  `agents events --module factory` filters to one producer. Routing is forced by the
  stores rather than chosen: a milestone kind requires a `sessionId` and lands in that
  session's activity log, everything else lands in the operational log. A milestone
  with no `sessionId` is rejected, not quietly written elsewhere. Rejection is per
  line, so one bad line never discards a batch, and the exit code is 1 if any line was
  rejected. `--dry-run` validates without writing.
  Source: `apps/cli/src/lib/events-ingest.ts`, `apps/cli/src/commands/events.ts`,
  `apps/cli/docs/06-observability.md`.

- **Four `factory.*` event kinds.** `factory.command`, `factory.action`, `factory.uri`
  and `factory.launch` describe what a user did in the Factory VS Code extension.
  `factory.launch` is a milestone — it carries the `sessionId` and `terminalId` that
  later events join through — and `factory.uri` is audit-level, since an external
  process driving the user's editor is a "who reached in from outside" fact.
  Source: `apps/cli/src/lib/events.ts`, `apps/cli/src/lib/activity.ts`.

- **`emit()` accepts a caller-supplied timestamp.** A batched producer records when
  each event *happened* and flushes later; without this, every event in a flush was
  stamped at flush time, collapsing their order and corrupting `--since` boundaries.
  `ts` stays reserved against payload injection — only the explicit override can set
  it. Source: `apps/cli/src/lib/events.ts`.

- **Fixed: `agents _internal friction` recorded its own invocation.** The command
  exists precisely because shell guards run before any `agents` process exists and so
  cannot emit in-process, but it still fired the `command.start` / `command.end` audit
  hooks, writing two records on top of every friction record. Recorder commands are now
  exempt. Source: `apps/cli/src/index.ts`.
