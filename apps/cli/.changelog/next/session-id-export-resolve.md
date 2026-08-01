- **`agents sessions export <id>` now resolves a short id the same way `sessions
  <id>` does — by id only, never fuzzy content.** The id-only fix landed for the
  `sessions` view but `sessions export` still gated its index lookup on
  `isCompleteSessionId`, so a bare hex short-id like `d3470b57` absent from the
  discovered pool skipped the index and fell through to the text query — bundling
  every transcript that merely MENTIONED the id into the export. The one canonical
  id-shaped test, `looksLikeSessionId`, now lives beside `isCompleteSessionId` in
  `lib/session/discover.ts` and is shared: `sessions export` resolves any id-shaped
  selector through the index (exact -> prefix -> `findSessionsById`) and reports
  "No session with id …" on a miss instead of shipping the mentioner. Source:
  `apps/cli/src/lib/session/discover.ts`, `apps/cli/src/commands/sessions-export.ts`.
