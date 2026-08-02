- **`agents activity` goes fleet-wide, grouped, and session-enriched.** The activity
  lane was a flat, local-only, newest-first list; it now shows progress-so-far across
  the whole fleet — who did what, where, on which project, for which ticket. New flags:
  `--devices-all` (alias `--hosts-all`) fans the same `activity --json` payload out to
  every reachable device (feed-style, via `gatherRemoteAgentsJson`) and merges each
  peer's stream host-tagged; `-H/--host` / `--device` scope to specific boxes; `--local`
  forces local-only (still the default). `--group-by project|device|agent` buckets the
  stream (e.g. per project, what each agent did and for which ticket) and `--filter
  <text>` narrows by project/device/agent/event/ticket. Each item is enriched by JOINING
  to live sessions — the resolved project (repo/worktree slug from cwd), the execution
  host (`provenance.host`), and the Linear ticket (`ActiveSession.ticket`) — never by
  re-parsing transcripts. Milestone tiering (`--milestones`) and the default collapse are
  unchanged, and `--json` stays a mergeable per-host payload (now carrying the enriched
  fields). Source: `apps/cli/src/commands/activity.ts`, `apps/cli/src/lib/activity.ts`
  (`enrichActivityEvents`, `mergeActivityEvents`, `parseActivityPayload`, `groupActivity`,
  `filterActivityEvents`, `projectFromCwd`).
