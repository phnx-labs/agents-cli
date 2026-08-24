---
type: feat
---

- **Deletion verbs normalize on `remove` (specific item) and `prune` (bulk
  stale), old spellings kept as hidden aliases.** The CLI had drifted into seven
  different words for "delete" across groups — `remove`, `rm`, `delete`, `gc`,
  `cleanup`, plus `prune`. The canonical pair `remove <name>` / `prune` (already
  the pattern in `commands`, `hooks`, `skills`, `versions`) is now applied to the
  stragglers: `agents route rm` / `agents devices rm` / `agents projects rm` make
  `remove` the primary spelling (`rm` stays an alias); `agents browser profiles
  delete` → `remove` (alias `delete`); and the bulk-stale sweeps `agents browser
  gc`, `agents lease gc`, `agents mailboxes gc`, and `agents routines cleanup`
  become `prune` (each old verb stays a hidden alias). No invocation breaks — the
  old verbs still resolve; they just no longer appear in `--help`. `agents
  secrets remove`/`delete` (key vs whole-bundle) and `agents artifacts share
  delete`/`unshare` are deliberately left as-is: those pairs encode a real
  distinction, not drift. Source: `apps/cli/src/commands/{route,ssh,projects,
  browser,lease,mailboxes,routines}.ts`.
