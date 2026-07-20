- **`agents logs <id> --json` now reports the true final status of a host task.**
  For a run that finished remotely between dispatch and the one-shot `--json`
  read, the payload emitted a stale `status: "running"` with no `exitCode` — even
  though the completed log was already present — because `hostTaskLogJson`
  discarded the reconciled record `reconcileTask` returns (it heals a new object
  rather than mutating in place). It now emits the reconciled task, so a polling
  agent sees `completed`/`failed` + `exitCode` + `finishedAt`. Source:
  `apps/cli/src/lib/hosts/logs.ts`.
