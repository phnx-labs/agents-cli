- **Incremental Codex + Kimi transcript parsing on the live scan path.** Following
  the Claude incremental parse, the Codex rollout scanner and the Kimi wire.jsonl
  scanner now re-parse only the newly-appended bytes when an active session grows,
  instead of re-reading the whole file from the top every scan (`agents sessions`
  and every consumer that scans: `output` / `view` / `teams` / the watcher). Each
  persists a resumable continuation in the `scan_ledger` (`parser_state`, reusing
  the schema v15 columns): the next scan resumes from the saved byte offset when
  the file merely grew and its mtime did not go backwards, and falls back to a full
  reparse from byte 0 on a cold start, a truncation / rewrite (size shrank), or a
  clock rewind. Both branches run through one shared reducer per scanner, so the
  indexed row an append produces is identical, field for field, to a from-scratch
  full reparse. For Codex that covers messageCount, the last-wins cumulative token
  snapshot (tokenCount / outputTokens / cost), duration, topic, and PR + ticket +
  team signals that straddle two scans (a `gh pr create` function_call in one write
  and its URL in the next). For Kimi it covers the additive message + token
  counters. Both incremental paths apply only newline-terminated lines and defer a
  complete-but-unterminated trailing record to the next pass, so a record written
  before its `'\n'` is flushed is never double-counted. Grok is out of scope (it
  reads a whole `summary.json`, not an append-only JSONL); Claude / Gemini and the
  shared helpers are unchanged. Source: `apps/cli/src/lib/session/discover.ts`.
