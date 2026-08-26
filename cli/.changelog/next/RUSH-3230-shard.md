- **`scripts/test.sh --shard <n>` — fan the suite across n fleet workers (RUSH-3230).**
  Uses vitest's own `--shard=i/n`, drawing workers from the same auto pool a single
  `--device auto` run uses, so `role=worker`/`role=personal` marks govern the fan-out too.
  This is the change that moves release time, and the reason is arithmetic: a measured full
  run is 3,079s of CPU at 11.5× parallelism on one box, so wall equals CPU/workers (269s) —
  the suite is **throughput-bound**, not bound by any single slow file. Adding boxes divides
  the CPU: 3 ≈ 93s, 6 ≈ 47s, 9 ≈ 31s. Shards run concurrently and every one is waited on
  before reporting, so a failure in one does not hide the others. Requires `agents` ≥ 1.22.49
  for `devices pick --json`; an older CLI fails naming the version and the fix rather than
  passing through a commander error. Source: `cli/scripts/test.sh`.
- **`scripts/test.sh --devices a,b,c` — name the shard workers explicitly (RUSH-3230).**
  Pins the fan-out to known-idle boxes instead of auto-picking, and skips the
  `devices pick --json` dependency, so sharding also works from a machine whose installed
  CLI predates 1.22.49. Source: `cli/scripts/test.sh`.
- **`--shard` fails loud on a count below 2 and on a conflicting target flag (RUSH-3230).**
  `--shard 0` previously passed the numeric check, ran zero shards, and still printed
  `All 0 shards passed.` with exit 0 — a false green that reported success having run no
  tests. It now requires at least 2 (a single worker is `--device auto`). Separately, `MODE`
  was last-write-wins with no cross-flag validation, so `--shard 6 --device box` silently
  dropped one of the two purely on argument order; conflicting target flags now die naming
  both. Source: `cli/scripts/test.sh`.
