- **Reading state no longer writes `agents.yaml`, which silently deadlocked
  `agents repo pull` (RUSH-1925).** Registry presets from `SEEDED_REGISTRIES` (today
  `skill.hermes`) were seeded on the state **read** path, which wrote the registry entry
  plus a `seededPresets` marker into `agents.yaml`. That file is git-tracked in the user's
  DotAgents repo, so the write left the working tree dirty and every subsequent
  `agents repo pull` aborted with `Working tree has uncommitted changes` — naming neither
  the file nor the cause. Because *every* `agents` invocation reads state, the dirt
  reappeared the instant it was cleared: `git checkout -- agents.yaml && agents repo pull`
  re-seeded before the pull ran, so the loop could not be escaped through the CLI at all.
  On a host with several live agent sessions even a raw `git pull --rebase` lost the race,
  and one machine sat 27 commits behind for weeks as a result. Seeded presets are now
  resolved in memory by `getRegistries` — the same way `DEFAULT_REGISTRIES` has always
  worked — so nothing is written and no later write can flush them into the file.
  `seededPresets` becomes a removal tombstone: `agents registry remove skill hermes`
  records the key and the preset stops being offered, which is the behaviour the marker
  existed to protect. Files seeded by the old code carry both the tombstone and an explicit
  entry in their own `registries:` block, and the explicit entry still wins, so upgrading
  changes nothing for them. `setRegistry` also falls back to
  `SEEDED_REGISTRIES` when merging a partial update, so `registry disable/enable/config`
  on a never-materialized preset can no longer persist a stripped entry that drops `url`.
  Source: `apps/cli/src/lib/registry.ts`,
  `apps/cli/src/lib/state.ts`, `apps/cli/src/lib/registry.seeds.test.ts`,
  `apps/cli/src/lib/state.test.ts`.
