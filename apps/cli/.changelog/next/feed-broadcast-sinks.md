- **`agents feed post` can now be mirrored to the systems you actually watch.**
  A post was durable but local: an operator away from every terminal never saw
  it, and the tracker that owns the work heard nothing. Declare sinks under
  `feed.broadcast` in `agents.yaml` — argv templates, not built-in integrations —
  and each post is fanned out to them. `--level important` marks a post worth
  interrupting someone over, so a sink with `minLevel: important` never fires on
  a routine "CI green"; a template referencing `{ticket}` is skipped when no
  ticket is known, and the ticket is joined from the session index rather than
  asked for as a flag. `{message}` composes the human line a messaging sink wants
  — `<project> · <text>` plus the first attached URL — so an out-of-band ping
  leads with the project and carries a clickable link. Delivery is best-effort
  and reported per sink; a mirror that fails never costs you the post. Source:
  `apps/cli/src/lib/feed-broadcast.ts`, `apps/cli/src/commands/feed.ts`,
  `apps/cli/docs/06-observability.md`.
