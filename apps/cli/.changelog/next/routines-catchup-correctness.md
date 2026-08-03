- **A routine that fires less often than weekly can now be caught up at all.** Overdue
  detection walked a fixed one-week window for the most recent expected fire, so any cron whose
  gap exceeds that returned nothing and the routine was skipped entirely — never flagged
  overdue on any device, never caught up, no `missed` record, silently. Monthly, semi-monthly,
  quarterly and annual routines were all in that class. Measured on a real schedule
  (`0 9 1,13,25 * *`, 12-day gaps): on **10 of every 28 days** the routine could not be
  evaluated. The lookback now widens (week → month → quarter → year) only when the narrower
  window finds nothing, so a dense schedule never walks more than a week of occurrences.
- **Catch-up no longer resurrects a retired routine.** `detectOverdueJobs` never checked
  `endAt`, and the scheduler only auto-disables lazily inside a live cron tick — so a routine
  whose `endAt` elapsed while the daemon was down was still enabled on disk, rescheduled on
  restart, and executed by the catch-up pass.
- **One-shot detection matches the scheduler's.** Overdue used the raw `runOnce` flag while the
  scheduler uses `isOneShotRoutine`, so a one-shot-*like* schedule (a fixed minute/hour/day/
  month) that never carried the flag could be replayed by catch-up.
- **The creation floor now covers built-in routines.** `routineEffectiveStart` resolved a
  routine's file through a user-layer-only lookup, but `listJobs` reads the system layer too —
  so a built-in shipped in the system repo had neither a `createdAt` stamp nor a resolvable
  path, the floor was skipped, and it read as instantly overdue on first daemon start. Added
  `resolveJobFilePath`, which resolves across every layer the loader reads.
- **A `createdAt` in the future is clamped to now.** Left unclamped (clock skew, a hand-edited
  year) it sits after every possible expected fire, so the routine could never be flagged
  overdue until wall-clock time caught up.
