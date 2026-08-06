- **Plugin discovery warns instead of silently skipping a directory with no
  `.claude-plugin/plugin.json` (RUSH-2270).** A `plugins/<name>/` directory missing
  (or with a malformed) manifest was invisible to `agents plugins list`/`info`/`sync`,
  `agents doctor`, and the marketplace materialize-into-version-homes step, with zero
  diagnostic anywhere in the chain — no `agents sync`/`agents repo pull` could
  surface it, since discovery dropped it before any of those ran. Found via a real
  case: the `work` plugin merged to `phnx-labs/.agents-system` without its manifest
  and sat invisible for a full merge cycle; the same fix run against this box's own
  `~/.agents/plugins/duck` found it missing one too. `discoverPluginsInDir` now
  writes one `agents-cli:` warning to stderr naming the directory and the missing
  manifest path, matching the existing advisory-not-fatal pattern
  `syncMarketplaceManifest` already uses for a malformed (as opposed to missing)
  manifest. Source: `apps/cli/src/lib/plugins.ts`.
