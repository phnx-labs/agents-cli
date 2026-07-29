- **Project resource manifests are now portable across Windows and POSIX.** The
  managed-resource manifest `.agents-managed.json` recorded its paths with the
  host's native separator, so a sync run on Windows wrote entries like
  `skills\myskill`. That file lives in the version-controlled project `.agents`
  dir and travels between machines, and the cleanup pass matches manifest entries
  with `path.sep` — so a manifest written on Windows silently failed to match on
  macOS or Linux and left previously managed files behind on the next sync (and
  vice versa). Manifest paths are now normalized to POSIX separators on write and
  on read, which also repairs manifests written by earlier Windows builds. Source:
  `apps/cli/src/lib/project-resources.ts`.
