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
