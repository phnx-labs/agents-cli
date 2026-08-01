- **`agents sessions <id>` with a short/partial id resolves by id only — no more
  "Multiple sessions match" from fuzzy content.** A complete UUID already resolved
  by id, but a bare hex short-id like `d3470b57` was not caught by
  `isCompleteSessionId`, so it fell through to the ranked content search and
  surfaced every transcript that merely MENTIONED the string (a resume prompt
  echoes the parent id into the body of many later sessions) — a real view id
  returned a list of unrelated sessions. Any id-shaped query — complete id OR hex
  short-id/prefix (`looksLikeSessionId`) — now resolves through the index by id in
  both `resolveSessionQuery` and the `renderOneSession` content-widen gate, and
  reports "no session found" when nothing matches instead of content-searching.
  Free-text phrases keep the ranked search path. Source:
  `apps/cli/src/commands/sessions.ts`.
