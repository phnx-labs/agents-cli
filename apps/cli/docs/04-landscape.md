# Competitive Landscape

How agents-cli fits alongside other tools in the AI coding agent ecosystem.

The space is young and moving fast. Many of these tools are excellent and solve real problems. This document maps where they focus and where agents-cli offers something different.

---

## What agents-cli does

agents-cli is a developer workstation tool that combines:

1. **Version management** -- Pin AI agent CLI versions per project via `agents.yaml`, with shim-based resolution and isolated config per version
2. **Package management** -- Install and sync skills, MCP servers, slash commands, rules, hooks, and permissions across all agents
3. **Unified execution** -- Run any agent through one interface (`agents run <agent> <prompt>`), enabling pipelines and CI scripting
4. **Team sharing** -- Git-based push/pull of your entire agent setup, so teammates and new machines get the same config in one command
5. **Automation** -- Scheduled routines with sandboxed permissions

No other single tool combines all five. Each individual capability has strong tools focused on it.

---

## Version Management

**No direct competitor exists** for per-project AI agent CLI version pinning.

| Tool | What it does | Difference |
|------|-------------|------------|
| [mise](https://mise.jdx.dev) | Universal dev tool version manager (asdf successor). Has Claude and Codex in its registry via npm backend. | General-purpose -- no config isolation per version, no project `agents.yaml`, no automatic backup on version switch. Great tool for language runtimes; agent CLIs are a secondary use case. |
| [llm-agents.nix](https://github.com/numtide/llm-agents.nix) | Nix flake packaging 50+ agent CLIs. 1,000+ stars, auto-updated daily. | Deterministic builds via Nix, not per-project switching. Excellent if your team already uses Nix. |
| [AgentManager](https://github.com/kevinelliott/agentmanager) | Detects installed agents, checks for updates. | Global-only -- no per-project pinning or version switching. Useful as a dashboard for what's installed. |

Built-in capabilities: Claude Code, Codex CLI, and Gemini CLI each support installing a specific version globally, but none offer per-project version files or directory-aware version resolution.

---

## Config Sync and Package Management

Several strong tools sync agent configurations across agents. The space is active and growing.

| Tool | What it does | Difference |
|------|-------------|------------|
| [Agentloom](https://www.npmjs.com/package/agentloom) | Syncs agents, commands, rules, skills, and MCP configs from a single `.agents/` directory to 7+ agents. | Focused on config sync -- does not manage CLI versions or provide unified exec. Well-designed single-purpose tool. |
| [coder-config](https://github.com/regression-io/coder-config) | Configuration manager for Claude, Gemini, Codex. Manages MCPs, rules, permissions, memory. | Similar config management scope. Does not handle CLI versions. |
| [Microsoft APM](https://github.com/microsoft/apm) | Agent Package Manager with `apm.yml` manifests. Supports Copilot, Claude, Cursor, OpenCode, Codex. Includes security auditing. | Package-manifest approach with dependency resolution. Strong on security. Does not manage CLI versions. |
| [agr](https://pypi.org/project/agr/) | Python package manager for agent resources. `agr.toml` + `agr sync`. | npm-like workflow for agent skills. Python ecosystem. Does not manage CLI versions. |
| [Skild](https://github.com/Peiiii/skild) | "npm for AI Agent Skills." Supports 7+ agents, skillsets (bundles), cross-tool sync. | Focused on skill distribution. Does not manage CLI versions or provide unified exec. |
| [skills.sh](https://skills.sh) | Open agent skills directory by Vercel. Supports 18+ agents. | Discovery and installation of community skills. Does not manage CLI versions. |

agents-cli's config sync is version-aware: when you switch agent versions, configs are backed up and resources are re-synced into the new version's isolated home. This is the integration point none of the above tools address.

---

## Unified Agent Execution

| Tool | What it does | Difference |
|------|-------------|------------|
| [Rivet Sandbox Agent SDK](https://sandboxagent.dev) | Unified HTTP API to control Claude Code, Codex, OpenCode, Amp, Cursor, Pi inside sandboxes. 1,300+ stars. | Server-side infrastructure -- designed for running agents in cloud sandboxes, containers, and CI. agents-cli is a local developer tool. Complementary: a team could use agents-cli locally and Rivet in production. |
| [Rivet Actors](https://rivet.dev) | Stateful compute primitives for AI agents. Hierarchical actor trees, message passing, workflows. 5,400+ stars, YC W23. | Full agent orchestration platform, not a CLI tool. Solves "how do I run agents at scale" rather than "how do I manage agent CLIs on my machine." |

agents-cli's `agents run` resolves to the project-pinned version with pre-synced skills and permissions, making it suitable for scripting pipelines locally and in CI.

---

## Session Management

Multiple mature tools provide cross-agent session viewing.

| Tool | What it does | Difference |
|------|-------------|------------|
| [cass](https://github.com/Dicklesworthstone/coding_agent_session_search) | Indexes 11+ agents with BM25 + semantic search. Sub-60ms queries. | Purpose-built search engine for agent sessions. More advanced search than agents-cli's session viewer. |
| [Agent Sessions](https://github.com/jazzyalex/agent-sessions) | Native macOS app. 8+ agents, live cockpit, rate limit tracking. | Desktop app with rich UI. agents-cli provides CLI-based session access. |
| [ccmanager](https://github.com/kbwo/ccmanager) | CLI session manager for 8+ agents. Worktree-aware. | Focused session management. Does not handle versions or config. |

agents-cli's session discovery is version-aware -- it finds sessions across all installed versions and backups, not just the active config directory. For teams that need advanced search, pairing with cass makes sense.

---

## Visual and Orchestration Tools

These tools solve adjacent problems worth knowing about.

| Tool | What it does |
|------|-------------|
| [Ironclad Rivet](https://github.com/Ironclad/rivet) | Visual node-based graph editor for chaining LLM prompts. 4,500+ stars, MIT, backed by Ironclad. Great for building complex prompt chains visually. Different problem space -- orchestrates LLM API calls, not coding agent CLIs. |
| [Rivet agentOS](https://github.com/rivet-dev/agent-os) | Lightweight agent sandbox via WASM + V8 isolates. 2,700+ stars. Solves agent isolation and sandboxing at the OS level. |

---

## Where agents-cli fits

```
                    Local developer machine              Cloud / CI / Production
                    -------------------------            ----------------------
Version pinning     agents-cli, mise (partial)           --
Config sync         agents-cli, Agentloom,               --
                    coder-config, APM, agr
Skill packages      agents-cli, Skild, skills.sh         --
Unified exec        agents-cli                           Rivet Sandbox Agent SDK
Pipelines           agents-cli (routines)                Rivet Actors
Sandboxing          --                                   Rivet agentOS, E2B, Modal
Session search      agents-cli, cass, ccmanager          --
Visual chains       --                                   Ironclad Rivet
```

agents-cli is the integrated layer for the developer workstation: one tool that handles versions, packages, config, execution, and team sharing. The tools listed above are excellent at their individual focus areas. For teams that need depth in a specific area (advanced session search, production sandboxing, visual orchestration), they pair well with agents-cli rather than replacing it.

---

*Last updated: April 2026. The AI agent tooling space moves fast -- if something here is outdated, please open an issue.*
