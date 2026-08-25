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
