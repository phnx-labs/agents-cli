# AGI CLI board — by module (2026-09-01 snapshot)

A business-level, module-grouped view of the open AGI (CLI) Linear board, built for a
5-minute skim instead of reading tickets one by one. Rendered page:
[`agi-board-by-module.html`](agi-board-by-module.html).

**What it shows** (as of 2026-09-01, 70 open):
- One card per product module (Sessions & Resume, Daemon, Accounts/Auth/Usage, Browser,
  Release/CI, Guards, Share, Devices/Fleet, Config/Sync, Growth, Other) with the open
  count, whether it holds High-priority work, and how many are in progress.
- A **"Nice-to-haves — keep or cancel"** table of the Low-priority + Backlog long tail,
  for pruning dead weight.
- Every ticket id links to its Linear thread.

**Excluded** (closed earlier the same session): 9 shipped (PHNX-2717, 3118, 3510, 3688,
3520, 3317, 3352, 3645, 3618) + 4 cleaned as outdated (3588 done, 3620/3619 dup, 3635
moved to the ext repo).

**How it was generated:** grouped from `linear tasks --project AGI --status open --json`
by a keyword→module map, then rendered to the house terminal-coded HTML. It is a
point-in-time snapshot; regenerate from live Linear when the board moves.
