- **The configured model now shows wherever an agent is displayed.** `agents
  view`, `use`, `add`, `status`, and `inspect` surface the model an agent+version
  actually runs with, beside the version (the identity cluster reads `agent ·
  version · model · account`). The model is resolved agents.yaml `run.defaults` →
  the native `settings.json` → the built-in default, and `agents view --json`
  gains a `configuredModel { model, source }` field so downstream tools can read
  both the value and where it came from. Source: `apps/cli/src/lib/models.ts`,
  `apps/cli/src/commands/view.ts`.
