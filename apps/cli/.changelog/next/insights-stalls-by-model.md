- **`agents insights` splits silent stalls by harness and model.** The By-agent/account
  table now shows per-group stall and resume-nudge counts (so laziness is visible without
  `--json`). Stalls are also attributed to the model that last spoke
  (`silentStallsByModel`, "Silent stalls by model" section). Extractor version 6.
  Source: `apps/cli/src/lib/session/insights.ts`, `commands/insights.ts`.
