- **Layered resource listing is ~40% faster.** `getActiveResourceProfile()` read
  `agents.yaml` twice per call — once up front, then again inside
  `getActiveResourceProfileName()` — and `listResources()` calls it once per
  resolved resource, so a listing paid two memoized `readMeta()` round-trips
  (`ensureAgentsDir()` plus four `stat`s each) for every entry. Reading it only
  after the profile name is known drops one of them. Measured on `yosemite-s1`
  against the real `~/.agents`: one pass over all eight resource kinds (135
  entries) went 10.52 ms → 6.23 ms, and `agents doctor --json` spends ~243 ms in
  this path across 95 listings. No behavior change — an active profile still
  costs two reads, and the `ensureAgentsDir()` side effect is unchanged because
  `getActiveResourceProfileName()` always reaches `readMeta()`. Source:
  `apps/cli/src/lib/resource-profiles.ts`.
