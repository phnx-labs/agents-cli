- **Fix: actor attribution now actually reaches `agents sessions` and `--active`
  for real runs (RUSH-2018/2019).** Two bugs, found by driving a real `agents run`
  end-to-end: (1) the session index's `actor`/`initiated_by` were kept out of the
  upsert `ON CONFLICT` entirely, so any row indexed *before* its actor sidecar
  landed (an older scanner, or a scan racing the spawn-time write) was locked to
  `NULL` forever — now `COALESCE(existing, incoming)` backfills a null while still
  never clobbering a stored owner; (2) the live `--active` **owner** read only the
  per-pid registry entry, which the SessionStart hook rewrites without an actor, so
  real runs showed no owner — `--active` now falls back to the durable per-session
  actor sidecar. Verified with a real `agents run`: the actor reaches `sessions.db`
  and the `--active` owner resolves. Source: `apps/cli/src/lib/session/db.ts`,
  `apps/cli/src/lib/session/active.ts` (`resolveOwner`).
