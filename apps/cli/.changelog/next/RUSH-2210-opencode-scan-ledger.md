- **OpenCode session scans re-index only the sessions that changed (RUSH-2210).** OpenCode
  keeps every session in one shared `opencode.db`, and the scanner stamped each session
  with that whole file's mtime/size. Any write to any session therefore invalidated every
  indexed session, so a single new turn re-emitted up to 1000 sessions — and the indexer
  re-opened `opencode.db` once per re-emitted session to re-parse a transcript that had
  not moved. Each session is now stamped with its own row's `time_updated` + message
  count, so an unchanged session is skipped; the file-level stat stays only as the cheap
  "nothing changed at all" short-circuit, and a scan opens `opencode.db` once instead of
  once per session. Source: `apps/cli/src/lib/session/discover.ts`.
