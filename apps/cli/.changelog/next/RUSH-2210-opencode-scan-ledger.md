- **OpenCode session scans re-index only the sessions that changed (RUSH-2210).** OpenCode
  keeps every session in one shared `opencode.db`, and the scanner stamped each session
  with that whole file's mtime/size. Any write to any session therefore invalidated every
  indexed session, so a single new turn re-emitted up to 1000 sessions — and the indexer
  re-opened `opencode.db` once per re-emitted session to re-parse a transcript that had
  not moved. Each session is now stamped with its own newest write time (across its
  `session` row, its messages, and its parts) and the byte length of its message + part
  payloads, so an unchanged session is skipped; the file-level stat stays only as the
  cheap "nothing changed at all" short-circuit, and a scan opens `opencode.db` once
  instead of once per session. The stamp deliberately does not rely on
  `session.time_updated` alone, which real databases leave hours behind the session's
  newest part. A side effect: `sessions.file_size` for an OpenCode row is now that
  session's payload size instead of the whole database's size, so the tool-backfill byte
  budget and its 16 MiB in-memory parser cap finally reflect the real cost of parsing
  that one session. Source: `apps/cli/src/lib/session/discover.ts`.
