---
type: feat
---

- **`agents browser profiles list` shows WHERE, not a stored scope.** The
  column is the devices whose own `devices/<machine>/agents.yaml` declares the
  name — true by construction, no field to drift. `--json` adds `devices` and
  `kind` (`identity` when exactly one device declares the name, `fungible` when
  several do). `profiles add` is an alias of `create` and prints
  `Added "<name>" on <device> (port N).`
  Source: `src/commands/browser.ts`.
- **`profiles doctor` fails `where` on the original comet-local shape.** An
  identity-bearing name whose endpoint is loopback, viewed from a box that is
  not the declaring device, exits non-zero and names both machines. Local
  binary/port/onboarding checks are skipped so they cannot paint a green local
  chromium over someone else's logins. `ssh://` endpoints and fungible names
  are unaffected.
  Source: `src/lib/browser/runtime-state.ts` (`identityLoopbackMismatch`),
  `src/commands/browser.ts`.
