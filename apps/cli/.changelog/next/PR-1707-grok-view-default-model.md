- **`agents view` now shows Grok's default model (e.g. `grok-4.5`).** Claude,
  Codex, Antigravity, and Kimi already filled the model column via their
  catalogs; Grok was missing from `locateModelSource`, so
  `resolveConfiguredModel` returned null and the column stayed blank. Grok has
  no `settings.json` `model` field (its config is `config.toml` +
  `models_cache.json`); the authoritative default is `grok models` →
  `Default model: <id>`. The catalog extractor now spawns that command against
  the version-home binary (skipping failed-download stubs) and flags the
  default, so `agents view`, `agents view --json` (`configuredModel`), and the
  other identity-cluster surfaces show it. Source: `apps/cli/src/lib/models.ts`,
  `apps/cli/src/commands/models.ts`.
