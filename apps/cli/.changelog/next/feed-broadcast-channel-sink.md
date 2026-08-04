- **`feed.broadcast` gains an in-process `channel:` sink and an implicit owner
  fallback (RUSH-2123).** A `feed.broadcast` sink can now declare `channel: <name>`
  (plus `to:` for a non-owner destination) instead of `command: [argv...]` — it
  delivers through the same channel-provider registry `agents send`/`agents notify`
  use (`deliverEnvelope()`), no spawn. `channel: owner` is the address alias,
  expanding to `notify.owner.{channel,to}`. When an operator has `notify.owner`
  configured but never wrote a `feed.broadcast` block at all, an important-level
  post (`--level important`, or any `--blocked` post) now falls back to that owner
  address automatically instead of reaching nobody — previously a `feed post
  --blocked` with `notify.owner` set and no `feed.broadcast` looked recorded but
  delivered to no one. A routine milestone post still stays record-only even with
  the fallback available, and an operator-declared `feed.broadcast` always wins
  outright. `command:` argv sinks (the tracker/webhook escape hatch) are unchanged.
  Source: `apps/cli/src/lib/feed-broadcast.ts`, `apps/cli/src/commands/feed.ts`.
