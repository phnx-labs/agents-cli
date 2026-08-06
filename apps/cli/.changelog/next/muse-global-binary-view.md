- **Muse Code global binary is visible to `agents view` / `isVersionInstalled`.**
  Muse installs a single self-updating launcher at `~/.local/bin/muse` (same
  shape as droid), but `getBinaryPath` still resolved a version-home
  `node_modules/.bin/muse` that never exists. After `agents import muse` /
  `agents add muse`, version dirs now resolve to that global path so managed
  view, collapse, and live-version bookkeeping match what actually executes;
  install no longer writes a self-referential shim symlink. Source:
  `apps/cli/src/lib/versions.ts`.
