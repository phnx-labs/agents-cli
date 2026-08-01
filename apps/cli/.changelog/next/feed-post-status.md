- **`agents feed post` — agents announce progress without opening a “needs you”
  block.** Free-text status posts append a `status.posted` milestone to the
  per-session activity log (same stream as `agents activity` and the feed’s
  recent-activity lane). Session/agent/host/runtime/pid/launch identity is
  auto-stamped from the process env and the per-pid launch registry — no
  domain-specific flags (tickets, URLs). Managed runs export `AGENT_SESSION_ID`
  / `AGENTS_AGENT_NAME` / `AGENTS_CWD` so a Bash tool call needs no extra
  wiring. Source: `apps/cli/src/lib/feed-post.ts`, `apps/cli/src/commands/feed.ts`,
  `apps/cli/src/lib/activity.ts`, `apps/cli/src/lib/exec.ts`.
