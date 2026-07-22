- **`agents secrets list` and `agents secrets view` now support `--json`.** An agent
  could inject a bundle but couldn't first discover which bundles/keys exist without
  parsing column-aligned text. Both emit metadata only — bundle/key names, policy,
  presence, expiry — never secret values (reveal still gated behind `--reveal`).
  Source: `apps/cli/src/commands/secrets.ts`. (RUSH-1834)
