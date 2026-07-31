- **`agents sessions` now classifies Grok transcripts into real events, not a
  one-line stub.** Grok sessions were indexed (title, timestamps, message count)
  but opening one showed a single placeholder `session_start` event — `parseGrok`
  was a stub. It now reads the session's `chat_history.jsonl` and normalizes every
  line into the shared `SessionEvent` shape: `user`/`assistant` messages,
  `reasoning` → thinking, `assistant.tool_calls[]` → tool_use (with `path` and
  `command` surfaced), and `tool_result` correlated back to its call by
  `tool_call_id` (an `Error:`-prefixed result becomes an error event). The scanner
  records `summary.json` as the session path, so the parser resolves
  `chat_history.jsonl` beside it; per-line timestamps aren't stored, so each event
  carries the session's `created_at` (falling back to the transcript mtime).
  Verified end-to-end against a real Grok session (30 events: messages + thinking +
  tool_use + tool_result). Source: `apps/cli/src/lib/session/parse.ts`.
