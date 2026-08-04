- **`agents computer describe` now counts toward `usedComputer`.** Every other
  verb (`click`, `type`, `key`, `screenshot`, `run`, …) fires the
  `computer.action` event via `emitComputerAction`; `describe` never did, so a
  session that only ran `agents computer describe` read back
  `usedComputer=false` — a false-negative in the sessions preview. A new
  completeness-guard test pins every registered `agents computer` verb command
  to a matching `emitComputerAction` call so a future verb can't ship the same
  gap silently. Source: `apps/cli/src/commands/computer-actions.ts`,
  `apps/cli/src/commands/computer-actions.test.ts`.
