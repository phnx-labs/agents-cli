- **Add Pi (Oh My Pi, `omp`) as a native harness.** agents-cli now installs, runs, and
  syncs resources for [Oh My Pi](https://omp.sh) (`@oh-my-pi/pi-coding-agent`, binary
  `omp`) under id `pi`. Pi is a Bun-based, terminal-first, multi-provider coding agent;
  its cross-provider model catalog (OpenRouter, OpenAI, Anthropic, xAI, DeepSeek, …)
  surfaces in `agents view` and `agents models pi` via `omp models --json`. It is
  Claude-compatible: MCP (`.mcp.json`, stdio + http + headers), skills, file commands, and
  Claude-shaped subagents all sync into `~/.omp/agent/`. Hooks, allowlist, and plugins are
  intentionally off (omp's hook/approval/plugin models don't map to agents-cli's).
  Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/exec.ts`, `apps/cli/src/lib/models.ts`.
