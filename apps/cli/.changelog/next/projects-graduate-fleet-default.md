- **`agents projects` is out of beta — no `agents beta enable projects` needed.**
  The command tree (list / add / import / status / link / …) is always registered
  now; `projects` is dropped from the beta registry (`ALL_BETA_FEATURES`,
  `BetaFeatureName`) and the `preAction` beta gate is removed. Any lingering
  `beta.enabled: [projects]` entry is harmlessly ignored, and `agents beta
  enable/disable projects` prints a friendly "graduated out of beta" note and
  no-ops instead of erroring (so old scripts survive). Source:
  `apps/cli/src/lib/beta.ts`, `apps/cli/src/lib/types.ts`,
  `apps/cli/src/commands/beta.ts`, `apps/cli/src/commands/projects.ts`.

- **`agents projects status` shows every project across the whole fleet by default;
  scope it with `--device`/`--devices`.** The old `--fleet` flag is gone — status
  now dials every registered device's workspace (presence, branch, drift) in one
  parallel SSH round without being asked. `--device <name...>` (repeatable) or
  `--devices a,b,c` narrows the fan-out to a subset; with no filter the whole fleet
  is dialled. Reuses the shared `--host`/`--device` target resolution. Source:
  `apps/cli/src/commands/projects.ts`.
