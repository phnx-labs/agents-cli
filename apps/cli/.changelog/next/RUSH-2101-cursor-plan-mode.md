- **Cursor now supports `--mode plan` headless and interactive (RUSH-2101).** The
  capability registry previously listed only `edit` and `skip`, so `agents run cursor --mode plan`
  and routine jobs silently degraded to writable `edit`. `cursor-agent` has supported `--plan`
  since the 2026-01-16 CLI release; the registry, `AGENT_COMMANDS` flag mapping, and the routine
  runner now forward it correctly. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/exec.ts`,
  `apps/cli/src/lib/runner.ts`.
