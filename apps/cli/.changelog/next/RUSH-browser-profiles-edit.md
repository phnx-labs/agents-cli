- **`agents browser profiles edit` and `profiles scope`.** An existing profile's
  description, endpoints, secrets, viewport, and binary could not be changed
  without deleting and recreating it — `-d/--description` existed only on
  `create`, and `updateProfile()` had no CLI caller at all. `profiles edit <name>`
  reuses `create`'s flag spellings (minus `-b/--browser` and `--fleet`, which key
  the on-disk profile cache and the store) and validates the merged record, so a
  binary edit re-resolves the browser path and a `--target-filter` edit re-checks
  the `--electron` gate. `profiles scope <name> <local|fleet>` moves a profile
  between the synced store and this machine.
  Source: `src/lib/browser/profiles.ts`, `src/commands/browser.ts`.
- **`profiles doctor` flags a fleet profile with a loopback endpoint.** A
  `--fleet` profile whose endpoint is `cdp://localhost:PORT` is evaluated on the
  machine running the command, so the name resolved to a different browser on
  every box — silently handing an agent a logged-out stranger instead of the
  credentialed profile it asked for. Now a failing `scope` check naming the
  repair. `ssh://` profiles are unaffected: they address a host, so fleet scope is
  correct for them. Source: `src/lib/browser/profiles.ts` (`misfiledFleetProfile`).
- **Fixed: editing a profile's endpoint could collide with itself.** The local
  port scan `createProfile` runs was never applied on update, and applying it
  naively would have failed every edit against the profile's own stored port.
  Extracted as `assertLocalPortFree(profile, { ignore })` and now used by both.
  Source: `src/lib/browser/profiles.ts`.
