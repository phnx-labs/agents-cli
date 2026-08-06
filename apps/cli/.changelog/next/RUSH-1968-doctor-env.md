- **`agents doctor` now reports the file-store master key when it is live in the
  process environment, not just when it is exported from a shell rc file
  (RUSH-1968).** `rc-hygiene.ts` scans FILES, which leaves a real hole: a value
  inherited by a long-lived process outlives the rc line that set it, so an operator
  who deletes `~/.zshenv:8` gets a clean `rc-secret-export` while every shell, editor
  and agent started before the edit still carries the key and hands it to everything
  they spawn. Confirmed on `yosemite-s1`, which has zero rc exports and still had the
  value in its environment. The new `env-secret-export` warning names that state and
  says the deletion is not sufficient; like every other finding it reports only that
  the variable is set, never its value. Expected inside a release sign context
  (`headless-sign-context.sh` sets it deliberately), which the message says so an
  operator on the home base does not chase it. Source:
  `apps/cli/src/lib/secrets/rc-hygiene.ts` (`masterPassphraseInEnv`),
  `apps/cli/src/lib/devices/doctor-findings.ts`, `apps/cli/src/commands/doctor.ts`.

- **`agents doctor --devices` now reports a remote box's secret hygiene, and its
  inventory probe no longer times out on a slow box (RUSH-1968).** The fan-out ran
  each remote's own `doctor --json` but parsed only `.fleet`, discarding the
  `findings` the remote had already computed — so a leaking box read as clean from
  anywhere but itself. The remote's `rc-secret-export` / `env-secret-export` rows
  now ride back, validated field by field and re-attributed to the device that was
  actually dialled (a remote can never pin a finding on another box). Only those two
  kinds forward: sign-in and divergence rows are recomputed centrally and would
  otherwise double.

  Separately, the probe's 30s timeout was below the real cost of the command it
  runs — `doctor --json` measures 57s on `yosemite-m0` and 136s on an idle box — so
  every slow device silently contributed nothing at all: no inventory, no sign-in,
  no divergence. Raised to 180s, matching `ChildProcess.doctorTimeout`, which was set
  to 180 for this same command for this same reason. Source:
  `apps/cli/src/commands/doctor.ts` (`asRemoteSecretFindings`, `probeFleetInventory`).
