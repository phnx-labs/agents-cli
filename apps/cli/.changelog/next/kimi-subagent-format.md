- **Kimi subagents are written in the format kimi-code actually reads, and gated at 0.29.0.** The
  integration emitted a `<name>.yaml` + `<name>.system.md` pair plus a managed `_agents-cli.yaml`
  parent index, targeting the `version: 1` / `agent:` agentspec of the older, separate `kimi-cli`
  product. `@moonshot-ai/kimi-code` has no loader for that schema — `system_prompt_path` appears
  nowhere in its bundle — so every synced Kimi subagent was written to disk and never loaded by any
  session. Kimi now gets one Claude-shaped `<name>.md` (frontmatter `name`/`description` + body),
  which kimi-code discovers from its brand home's `agents/` dir. Discovery landed in kimi-code
  0.29.0; 0.28.x and earlier compile their four agent profiles into the bundle with no filesystem
  loader, so the `subagents` capability is now `>= 0.29.0` and older installs skip with a stated
  reason instead of writing files nothing reads. Verified against a real kimi 0.29.0:
  `--agent no-such-agent` reports `Available profiles: plan, agent, coder, explore, code-reviewer`.
  Source: `apps/cli/src/lib/subagents-registry.ts`, `apps/cli/src/lib/agents.ts`.

  Homes synced before this fix carry stale `<name>.yaml`, `<name>.system.md`, and
  `_agents-cli.yaml` files in `~/.kimi-code/agents/`. The next `agents sync kimi` deletes them:
  `agents prune cleanup` could never reach them (the two `.yaml` files match no enumerator), and
  the leftover `<name>.system.md` would otherwise be listed as a phantom subagent named
  `<name>.system` and warned about by kimi-code once per session, since it ends in `.md` and
  carries no frontmatter.
