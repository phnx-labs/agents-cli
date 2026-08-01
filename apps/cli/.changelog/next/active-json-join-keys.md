- **`agents sessions --active --json` now emits flat `ticketId` and `project`
  keys on every row.** A supervising watcher joins active sessions on ticket +
  project, but the raw row nested the ticket under `ticket.id` and carried no
  `project` at all, so a naive join silently dropped every session. Each row now
  carries top-level `ticketId` (from the detected ticket) and `project` (the
  basename of the session's cwd — the same derivation the historical `--json`
  listing uses), both always present and `null` when unknown. The existing raw
  fields are unchanged. Source: `apps/cli/src/commands/sessions.ts`
  (`serializeActiveSessionsForJson`).
