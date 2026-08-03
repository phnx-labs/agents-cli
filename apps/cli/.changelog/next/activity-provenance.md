- **Activity events now carry the same actor and session lineage as operational events.**
  The TypeScript activity writer and the embedded PostToolUse hook stamp actor kind,
  launch id, and parent session id from the shared execution provenance floor, so
  `agents events` no longer invents an agent name as the activity record's OS user.
  Source: `apps/cli/src/lib/event-provenance.ts`, `apps/cli/src/lib/activity.ts`.
