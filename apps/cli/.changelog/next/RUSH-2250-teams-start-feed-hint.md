- **`agents teams start` nudges the operator toward feed milestones (RUSH-2250).**
  After launching teammates, `teams start` now prints a one-line tip — teammates are
  briefed to post IMPORTANT milestones to the feed; watch them with
  `agents teams status <team>`. Print-only in both the single-wave and `--watch`
  paths (suppressed under `--json`); no engine behavior changes. Pairs with the
  `.agents-system` guidance that instructs teammates to post those milestones. Source:
  `apps/cli/src/commands/teams.ts`.
