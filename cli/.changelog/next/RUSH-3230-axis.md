- **The menu-bar helper's staleness check compares the HELPER's version, not the CLI's
  (RUSH-3230).** `installAndStartService` stamped `getCliVersion()` as the installed
  helper's version, and `menubarSetupStale()` compared against `getCliVersion()` too. Once
  helpers gained their own version line that was wrong in both directions: every CLI
  release made an unchanged helper look stale and reinstalled it — recopying the bundle
  under the running helper, which `KeepAlive` then restarts (the #2109 storm: a new pid
  every 5-15s, 578 launches in one log) — while a genuinely newer helper at the same CLI
  version never looked stale at all, so it could never install.
  The stamp is now JSON recording what the helper actually IS: `release` with its helper
  version, or `local` with the source path + mtime for a dev build (menubar's build.sh
  hardcodes `CFBundleShortVersionString`, so a local build has no version to compare).
  Staleness compares like with like, treats a kind change (local <-> release) as stale, and
  never downgrades when the installed helper is ahead of the floor. A pre-JSON stamp is
  stale exactly once and is re-stamped in the new format, so the migration cannot loop.
  `agents menubar status` / `doctor` now print three labelled lines — helper installed,
  helper available, CLI version — instead of conflating two axes into one, and the
  permanent false "(mismatch — `agents menubar setup` updates it)" hint is gone.
  Source: `cli/src/lib/menubar/install-menubar.ts`.
