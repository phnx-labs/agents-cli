- **Faster `agents sessions` on large / unchanged session trees.** Session
  discovery re-walked and re-`stat`'d every transcript directory on every
  `agents sessions` / `output` / `view` / `teams` call — for a heavy user the
  immutable version-home and backup roots dominated the cost yet never changed. A
  new `dir_ledger` (SQLite, schema v14) caches each leaf transcript directory's
  `(mtime, entry_count)`; when both match, the per-file `stat` of that directory
  is skipped and its unchanged files are served straight from the DB, so those
  immutable roots cost one dir stat each instead of hundreds of per-file stats.
  Append safety is preserved: a file under the agent's live `~/.<agent>` root, or
  scanned within the last 10 minutes, is always re-`stat`'d (a parent-dir mtime
  bumps on create/delete/rename but NOT on an in-place append), so a growing live
  session is never missed; a create / delete / rename bumps the dir mtime and
  forces a full re-walk of that dir exactly as before. Wired into the Claude and
  Gemini scanners (the biggest win); the other scanners keep the existing
  per-file path. Set `AGENTS_SESSIONS_NO_DIR_LEDGER=1` to disable the
  short-circuit and force the old full per-file walk. Source:
  `apps/cli/src/lib/session/db.ts`, `apps/cli/src/lib/session/discover.ts`.
