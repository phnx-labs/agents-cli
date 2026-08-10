- **The auto-detected browser `default` profile no longer churns the fleet-shared
  `agents.yaml`.** `ensureDefaultBrowserProfile` regenerates that profile on every
  `agents browser start` without `--profile`, writing an absolute `binary:` path
  and a port chosen by probing the local machine. Because it lived in the synced
  file, a macOS box wrote `/Applications/Google Chrome.app/...`, a Linux box found
  that unlaunchable and rewrote `/usr/bin/chromium-browser`, and the two flipped
  the tracked file back and forth forever — the single largest source of churn on
  it. The auto `default` now lives in that box's own
  `~/.agents/devices/<machine>/agents.yaml`, which is gitignored. **User-created
  named profiles stay central and still sync**; reads merge both maps, with the
  machine-local copy winning a name collision (it was written by this box, for
  this box). Source: `apps/cli/src/lib/browser/profiles.ts`,
  `apps/cli/src/lib/state.ts`.
- **`projectRoot` is machine-local too.** `ensureProjectRoot` infers it from
  whatever directory the CLI happened to run in, so it is machine state rather
  than fleet policy; it was being cached into the file every machine syncs.
  Source: `apps/cli/src/lib/state.ts`.
- **Browser profile writes no longer clobber a concurrent write.**
  `createProfile` / `updateProfile` / `deleteProfile` did an unlocked `readMeta()`,
  mutated, then `writeMeta(meta)` — persisting a snapshot taken before the lock, so
  a newer write from another process was silently lost. They now go through
  `updateMeta`, which re-reads under the lock.
  Source: `apps/cli/src/lib/browser/profiles.ts`.
