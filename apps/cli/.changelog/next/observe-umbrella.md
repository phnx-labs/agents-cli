- **Observe umbrella aliases: `inbox`, `timeline`, `roster` (Phase 3 surface consolidation).**
  Thin doors onto existing readers (no store merge): `agents inbox` ≡ `feed`,
  `agents timeline` ≡ `feed --filter updates`, `agents roster` ≡ `sessions --active`.
  Root help gains an Observe section; `agents audit` stays the tamper-evident run
  log (not an events alias). Source: `apps/cli/src/lib/observe-aliases.ts`,
  `apps/cli/src/commands/feed.ts`, `apps/cli/src/commands/sessions.ts`.
