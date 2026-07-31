- **The daemon no longer silently repoints your default agent version.** The unattended
  6-hourly launch-health pass (`healBrokenDefaultLaunches` → `ensureAgentRunnable`) now runs
  with `allowDefaultSwitch: false`: it still repairs the *current* default in place, but if
  that default can't be repaired it no longer adopts another installed version or installs
  `latest` and pins it. A background default switch installs a fresh version home, which for
  Claude is a fresh, empty credential scope (macOS keychain keyed off `CLAUDE_CONFIG_DIR`;
  Linux per-version token file) — i.e. an "unprovoked logout" at a time uncorrelated with
  anything you did, and a leading cause of routine auth-failures on unattended machines. The
  daemon now logs a `WARN` naming the version to pick instead; interactive callers
  (`agents run`, `agents add`) are unchanged and still repoint as before. Source:
  `apps/cli/src/lib/versions.ts`, `apps/cli/src/lib/daemon.ts`.
