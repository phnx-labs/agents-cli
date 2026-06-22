---
name: run
description: "Execute a single agent headlessly or interactively. Supports plan/edit/full modes, secrets bundle injection, version pinning, fallback chains, balanced rotation, profile dispatch (Kimi/DeepSeek/etc.), and workflow dispatch by name. Triggers on: 'run claude', 'run codex', 'agents run', 'dispatch an agent', 'headless agent', 'one-off agent task'."
argument-hint: "<agent|profile|workflow> [prompt]"
allowed-tools: Bash(agents run*)
user-invocable: true
---

# Run Skill

Dispatch a single agent for a one-off task. `agents run` is the fundamental command for interactive sessions and headless automation across Claude, Codex, Gemini, Cursor, OpenCode, and OpenClaw.

## Headless vs interactive

Explicit flags are definitive; otherwise the mode is inferred from prompt presence:

- `--interactive` (`-i`) → always interactive, even with a prompt (the prompt is forwarded as the first message).
- `--headless` → always headless, even with no prompt (the prompt is read from stdin).
- Neither flag, **prompt provided** → headless. Pipes stdout, no TTY, exits when the agent finishes.
- Neither flag, **prompt omitted** → interactive. Launches the agent's TUI with full stdio inheritance.

`--interactive` and `--headless` are mutually exclusive — passing both errors out.

```bash
# Interactive (TUI)
agents run claude

# Headless one-shot
agents run claude "summarize recent git commits"
```

## Modes

Permission mode controls what the agent can do. Headless runs MUST set an explicit mode or hang at `ExitPlanMode`.

| Mode | What it allows |
|------|----------------|
| `plan` (default) | Read-only — research, audit, analysis |
| `edit` | Read + write files |
| `full` | Writes + all permissions (autonomous) |

```bash
agents run claude "fix lint errors in src/" --mode edit
agents run deploy-bot --mode full "deploy api to staging"
```

## Reasoning effort and model

```bash
# Reasoning effort (claude and codex only)
agents run claude "..." --effort high

# Override the model directly
agents run claude "..." --model claude-opus-4-7
```

`--effort` accepts `low | medium | high | xhigh | max | auto`.

## Secrets injection

Inject keychain-backed bundles as env vars at run time. Repeatable.

```bash
agents run claude "deploy the api" --secrets prod
agents run claude "..." --secrets prod --secrets stripe
```

Bundles resolve from macOS Keychain (no plaintext on disk). See the `secrets` skill for bundle management.

For workflows with a frontmatter `secrets:` field, declared bundles auto-inject. Pass `--no-auto-secrets` to skip.

## Pass env vars directly

```bash
agents run claude "..." --env DEBUG=1 --env API_KEY=xyz
```

## Run strategy

Controls which installed version/account gets the work.

| Strategy | Behavior |
|----------|----------|
| `pinned` (default) | Use the workspace/global pinned version |
| `available` | Use pinned if usage available; otherwise switch to another signed-in version |
| `balanced` | Distribute load across healthy accounts by remaining capacity |

```bash
agents run claude "..." --strategy balanced
agents run claude "..." -b                  # shortcut for --strategy balanced
```

Strategy is ignored when `@version` is pinned, a profile is used, or `--fallback` is set.

## Fallback chains

Retry on rate-limit by handing off to another agent via `/continue`.

```bash
agents run claude "..." --fallback codex,gemini
agents run claude "..." --fallback codex@0.116.0,gemini
```

Primary runs first; on rate-limit error, the next agent picks up.

## Profile dispatch

Run any OpenAI-compatible model (Kimi, DeepSeek, Qwen, etc.) through a host CLI by passing a profile name in the agent slot.

```bash
agents profiles add kimi --host claude --endpoint https://api.moonshot.ai/anthropic --model kimi-k2-thinking
agents run kimi "..."
```

The profile bundles host CLI + endpoint + model + auth. See `agents profiles --help`.

## Workflow dispatch

Pass a workflow name in the agent slot. agents-cli resolves the workflow directory (project > user > system), launches the host agent, and prepends `WORKFLOW.md` to the prompt as system instructions.

```bash
agents run code-review "review PR #42 on acme/api" --mode edit
```

See the `workflows` skill for authoring workflows.

## Pin version

```bash
agents run claude@2.1.143 "..."
```

## Resume a previous session (Claude only)

```bash
agents run claude --session-id <id>
```

## Output and observability

```bash
# Stream ndjson events for parsing
agents run claude "..." --json --quiet | jq

# Verbose execution logs
agents run claude "..." --verbose
```

`--quiet` drops the rotation banner and "Running:" preamble.

## Bounded runs

Kill the agent after a duration. Useful in CI and scheduled jobs.

```bash
agents run claude "generate sales report" --timeout 30m
agents run claude "..." --timeout 2h30m
```

## Grant access to extra directories (Claude only)

```bash
agents run claude "refactor shared utils" --add-dir ../shared --add-dir ../other-pkg
```

## Working directory

```bash
agents run claude "..." --cwd /path/to/repo
```

## ACP routing

Route through the Agent Client Protocol (Zed integration).

```bash
agents run gemini "..." --acp
agents run claude "..." --acp           # via @zed-industries/claude-code-acp adapter
```

Emits a unified event stream; ndjson when combined with `--json`.

## Quick reference

| Flag | Purpose |
|------|---------|
| `--mode plan\|edit\|full` | Permission level (default `plan`) |
| `--effort low\|...\|max\|auto` | Reasoning effort |
| `--model <id>` | Override model |
| `--secrets <bundle>` | Inject keychain bundle (repeatable) |
| `--env KEY=val` | Pass env var (repeatable) |
| `--cwd <dir>` | Working directory |
| `--add-dir <dir>` | Extra dir access (Claude, repeatable) |
| `--json` | ndjson event stream |
| `--quiet` | Drop preamble |
| `--verbose` | Detailed logs |
| `--timeout 30m` | Kill after duration |
| `--session-id <id>` | Resume conversation (Claude) |
| `--fallback codex,gemini` | Rate-limit fallback chain |
| `-b, --balanced` | Shortcut for `--strategy balanced` |
| `--strategy pinned\|available\|balanced` | Version selection |
| `--acp` | Route via Agent Client Protocol |

For everything else, run `agents run --help`.
