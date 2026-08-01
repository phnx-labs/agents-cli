- **Incremental Claude transcript parsing on the live scan path.** When an active
  Claude session grows, `agents sessions` (and every consumer that scans:
  `output` / `view` / `teams` / the watcher) now re-parses only the newly-appended
  bytes instead of re-reading the whole transcript from the top. The scan persists
  a resumable continuation (`parser_state` + `content_text`, schema v15) in the
  `scan_ledger`; the next scan resumes from the saved byte offset when the file
  merely grew and its mtime did not go backwards, and falls back to a full reparse
  from byte 0 on a cold start, a truncation / rewrite (size shrank), or a clock
  rewind. Both paths run through one shared reducer, so the indexed row an append
  produces is identical, field for field, to a from-scratch full reparse — token
  counts, cost, duration, topic/title, PR + ticket refs, and FTS content all match
  even when a signal straddles two scans (a `gh pr create` in one write and its URL
  in the next). Only the Claude scanner is wired for now (Codex / Kimi are
  follow-ups); the other scanners are unchanged. Source:
  `apps/cli/src/lib/session/discover.ts`, `apps/cli/src/lib/session/db.ts`.
