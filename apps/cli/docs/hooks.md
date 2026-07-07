# Hooks

Shell scripts that run automatically in response to agent lifecycle events — session start, tool calls, task completion, and more.

## Overview

Hooks are shell scripts in `~/.agents/hooks/` that fire when an agent crosses a lifecycle event boundary. Each hook is declared in a manifest (the `hooks:` section of `agents.yaml`) that binds it to one or more events, specifies an optional timeout, and optionally declares predicate matchers that gate execution. At agent launch, agents-cli reads the merged system + user manifest and writes the resolved script paths into the agent's native settings file — `settings.json` for Claude, `hooks.json` for Codex, and so on.

All declared predicates AND together at fire time: every predicate in the `matches:` block must pass, or the script is skipped. An empty `matches:` block always passes.

Hooks are separate from plugin-bundled hooks (which use a `hooks/hooks.json` inside the plugin directory). Central hooks in `~/.agents/hooks/` follow the same layered resolution as every other resource: project overrides user overrides system. See [02-resource-sync.md](02-resource-sync.md) for the full resolution model.

## Architecture

```
Central storage (user > system):
  ~/.agents/hooks/                    User-authored scripts (higher precedence)
  ~/.agents-system/hooks/             System-shipped scripts

  Manifest declarations:
  ~/.agents/agents.yaml               User-layer hook manifest  (hooks: section)
  ~/.agents-system/agents.yaml        System-layer hook manifest (hooks: section)

  Merge rule: user wins on key collision.
              enabled: false in user layer disables a system hook without forking it.

                         agents hooks add / agents use
                                    │
                                    ▼
  <version-home>/
    .claude/hooks/<name>.sh          Copied script (Claude)
    .codex/hooks/<name>.sh           Copied script (Codex)
    .gemini/hooks/<name>.sh          Copied script (Gemini)
    ...

  registerHooksToSettings() writes resolved paths into agent-native config:
    Claude:   <version-home>/.claude/settings.json        (hooks: {...})
    Codex:    <version-home>/.codex/hooks.json            + config.toml features.codex_hooks=true
    Gemini:   <version-home>/.gemini/settings.json        (hooks: {...})
    Agy:      <version-home>/.gemini/antigravity-cli/settings.json

                         Agent fires event
                                    │
                                    ▼
  Agent reads registered hooks from its settings file.
  For each matching hook: evaluate matches: predicates (shouldFire())
  If all predicates pass: exec the script with event context as JSON on stdin.
```

## Command Reference

| Command | Description |
|---------|-------------|
| `agents hooks list [agent]` | Show registered hooks per agent version and which events they respond to |
| `agents hooks add [source]` | Install from GitHub, local path, or pick interactively from `~/.agents/hooks/` |
| `agents hooks remove [name]` | Delete a hook from agent version homes |
| `agents hooks view [name]` | Print the shell script source for a hook |

### Options

| Command | Flag | Effect |
|---------|------|--------|
| `list` | `-a, --agent <agent>` | Filter to a specific agent; supports `agent@version` syntax |
| `list` | `-s, --scope <scope>` | `user` (global), `project` (repo), or `all` (default) |
| `add` | `-a, --agents <list>` | Target specific agents/versions: `claude`, `codex@0.116.0`, `gemini@default` |
| `add` | `--names <list>` | Install specific hooks by name from `~/.agents/hooks/` (comma-separated) |
| `add` | `-y, --yes` | Skip all prompts |
| `remove` | `-a, --agents <list>` | Limit removal to specific agents |

## Hook Manifest Schema

Hooks are declared in the `hooks:` section of `agents.yaml`. The schema maps to `ManifestHook` in `src/lib/types.ts:110`.

```yaml
# ~/.agents/agents.yaml  (user layer)
hooks:
  post-edit:
    script: post-edit.sh               # filename in ~/.agents/hooks/
    events:
      - PostToolUse
    timeout: 30                        # seconds; default 600
    matcher: "Edit"                    # optional: tool name filter (PreToolUse/PostToolUse)
    matches:
      cwd_includes: /projects/myapp    # predicate: only fire in this path
    override: true                     # silence shadow warning when overriding system hook

  session-start:
    script: session-start.sh
    events:
      - SessionStart
    timeout: 10

  prompt-guard:
    script: prompt-guard.sh
    events:
      - UserPromptSubmit
    matches:
      prompt_contains: "deploy"        # only fire when prompt mentions deploy
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `script` | string | yes | Filename of the shell script in `~/.agents/hooks/` (or system hooks dir) |
| `events` | `string[]` | yes | One or more lifecycle events that trigger this hook |
| `timeout` | number | no | Seconds before the hook is killed; default `600` |
| `matcher` | string | no | Tool name substring filter for `PreToolUse`/`PostToolUse` events (Codex) |
| `matches` | `HookMatches` | no | Predicate set; all predicates AND together |
| `enabled` | boolean | no | Set `false` in user layer to disable a system-shipped hook of the same name |
| `override` | boolean | no | Set `true` to silence the shadow warning when a user hook has the same name as a system hook |
| `cache` | string \| object | no | Opt-in caching + per-invocation timing. See [Caching](#caching). |

## Caching

Any hook that runs slow — API call, heavy script, anything over a few hundred ms — should declare `cache:` so the registrar wraps it in a shim that serves cached output and logs timing. The underlying script stays unchanged.

### Shorthand

```yaml
hooks:
  linear-inject-tasks:
    script: 03-linear-inject-tasks-context.sh
    events: [SessionStart]
    cache: 5m         # ttl=5min, key=global, prefetch=none
```

| Shorthand | Meaning |
|-----------|---------|
| `30s` | 30-second TTL, sync refresh on miss |
| `5m` | 5-minute TTL, sync refresh on miss |
| `1h` | 1-hour TTL, sync refresh on miss |
| `5m-bg` | 5-minute TTL, stale-while-revalidate: serve stale immediately + refresh in background |

### Full object form

```yaml
cache:
  ttl: 1h                # seconds or "30s" / "5m" / "1h"
  key: per-cwd           # global | per-cwd | per-session | per-project
  prefetch: background   # none | background
```

| Key | Effect | Use when |
|-----|--------|----------|
| `global` (default) | One cache file per hook, shared everywhere | SessionStart hooks pulling org-wide context (Linear sprint, GitHub notifications) |
| `per-cwd` | Cache keyed on the `cwd` field in the hook's stdin JSON | Per-repo context injection |
| `per-session` | Cache lives for the agent's `session_id` | Memoization within a session for hooks that fire repeatedly |
| `per-project` | Cache keyed on the nearest git repo root above cwd | Per-project context injection |

`prefetch: background` is the magic flag for SessionStart-style hooks: boot is always instant because the shim serves the cached file immediately, then refreshes in a detached child for the next session.

### What it generates

When the registrar sees `cache:` on a hook, it writes a per-hook shim under `~/.agents/.cache/shims/hooks/<name>.sh` and registers that shim's path in the agent's native settings file (`~/.claude/settings.json`, `~/.codex/hooks.json`, etc.) instead of the raw script. The shim:

1. Reads stdin once (Claude/Codex/Gemini pass JSON to every hook).
2. Computes the cache file path from `key:`.
3. If the cache is fresh, serves it (cache=hit).
4. If stale + `prefetch: background`, serves stale + spawns a detached refresh (cache=stale-prefetch).
5. If stale + no prefetch, runs the real script + caches the output (cache=miss).
6. Appends one JSONL line per fire to `~/.agents/.cache/logs/events-YYYY-MM-DD.jsonl`.

Stale shim files are garbage-collected automatically when a hook is renamed, deleted, or has its `cache:` field removed.

### `agents hooks profile`

```
agents hooks profile              # last 7 days, table form
agents hooks profile --days 30
agents hooks profile --json | jq
agents hooks profile --warn-ms 500
```

Aggregates `hook.fire` events into per-hook p50/p99/mean/max + cache hit rate. Any hook whose p99 exceeds `--warn-ms` (default 2000) and has no cache config gets flagged as a candidate for `cache:`.

Only hooks with `cache:` are instrumented today — that's deliberate. Opting into the primitive is what surfaces the data. To make every hook show up, declare `cache: 5m` on it (or `cache: 1s` to effectively disable caching while still getting timing).


### Supported Events

| Event | When it fires | Agents |
|-------|--------------|--------|
| `SessionStart` | Agent session begins | Claude, Codex, Gemini, Grok |
| `SessionEnd` | Agent session ends | Claude, Grok |
| `UserPromptSubmit` | User prompt received before model sees it | Claude, Gemini (as `BeforeAgent`), Grok |
| `PreToolUse` | Before a tool call executes | Claude, Codex, Gemini, Antigravity (`before_tool_call`) |
| `PostToolUse` | After a tool call completes | Claude, Codex, Gemini, Antigravity (mapped to `after_model_call`) |
| `PreCompact` | Before context compaction | Claude, Grok |
| `Stop` | Agent stops (final turn) | Claude, Codex, Antigravity (`on_loop_stop`), Grok |
| `Notification` | Agent sends a notification | Claude, Grok |
| `OnError` | Agent encounters an error | Antigravity (`on_error`) |

Event name mapping across agents is handled in `src/lib/hooks.ts`: `GEMINI_EVENT_MAP` (line 843), `ANTIGRAVITY_EVENT_MAP` (line 827), and Grok's `eventMap` (line 1328).

## Predicate Matchers

All predicates live in `matches:`. They AND together — every declared predicate must pass. Evaluated by `shouldFire()` in `src/lib/hooks/match.ts:117`. The hook input context (`HookInput`) is passed by the agent CLI as JSON to each registered script.

| Matcher | Tests | Example |
|---------|-------|---------|
| `prompt_contains` | User prompt string contains this substring (exact) | `prompt_contains: "deploy"` |
| `prompt_matches` | User prompt matches this regex | `prompt_matches: "^(deploy\|release)"` |
| `tool_name` | Tool name equals one of these values (`string` or `string[]`) | `tool_name: ["Edit", "Write"]` |
| `tool_args_match` | Serialized tool arguments match this regex | `tool_args_match: "production"` |
| `cwd_includes` | Current working directory contains any of these substrings (`string` or `string[]`) | `cwd_includes: "/projects/myapp"` |
| `project_has` | Project root (nearest `.git` ancestor) contains this file or directory | `project_has: "Cargo.toml"` |
| `git_dirty` | Working tree dirty state matches this boolean | `git_dirty: true` |

### Matcher Implementation Notes

- `prompt_contains`: `src/lib/hooks/match.ts:123` — `prompt.includes(matches.prompt_contains)`
- `prompt_matches`: `src/lib/hooks/match.ts:128` — compiled via `compileHookRegex()`; capped at 200 chars and max group depth 3 to prevent ReDoS
- `tool_name`: `src/lib/hooks/match.ts:134` — accepts a string or array; `arrayOf()` normalizes both
- `tool_args_match`: `src/lib/hooks/match.ts:142` — serializes `tool_args` to JSON if not already a string, then applies regex
- `cwd_includes`: `src/lib/hooks/match.ts:152` — `cwd.includes(n)` for each needle; passes if any matches
- `project_has`: `src/lib/hooks/match.ts:160` — walks up to the nearest `.git` directory via `findProjectRoot()`, then checks `fs.existsSync(path.join(root, matches.project_has))`
- `git_dirty`: `src/lib/hooks/match.ts:166` — runs `git status --porcelain` in `cwd`; returns true if output is non-empty

## Script Resolution

`resolveHookScriptPath(script)` in `src/lib/hooks.ts:35` resolves a script filename by checking, in order:

1. `~/.agents/hooks/<script>` (user dir)
2. Each enabled extra repo's `hooks/` directory (insertion order)
3. `~/.agents-system/hooks/<script>` (system dir)

The first match wins. At agent launch, scripts are copied from the central dirs into the version home (`<version-home>/.claude/hooks/`), and the registered command paths in `settings.json` point to the version-local copies — so scripts remain stable even when the source directories change.

## Disabling System Hooks

To disable a hook shipped by `~/.agents-system/`, add an entry with `enabled: false` in your `~/.agents/agents.yaml`:

```yaml
hooks:
  03-linear-inject-tasks-context:
    script: 03-linear-inject-tasks-context.sh
    events:
      - UserPromptSubmit
    enabled: false          # Disables the system-shipped hook
```

`parseHookManifest()` in `src/lib/hooks.ts:704` strips entries where `enabled === false` from the returned map before the registrar sees them.

## Recipes

**1. List all registered hooks**

```bash
agents hooks list
agents hooks list claude
agents hooks list claude@2.1.112
agents hooks list --scope user
```

**2. Install hooks from GitHub**

```bash
agents hooks add gh:team/hooks --agents claude,codex
agents hooks add gh:team/hooks --agents claude@2.1.112
```

**3. Install a specific hook by name**

```bash
agents hooks add --names post-edit --agents claude
agents hooks add --names post-edit,session-start --agents claude@default
```

**4. Gate a hook to fire only on Edit tool calls**

In `~/.agents/agents.yaml`:

```yaml
hooks:
  post-edit:
    script: post-edit.sh
    events:
      - PostToolUse
    matches:
      tool_name: "Edit"
```

**5. Gate a hook to a specific working directory**

```yaml
hooks:
  deploy-check:
    script: deploy-check.sh
    events:
      - UserPromptSubmit
    matches:
      cwd_includes: /projects/myapp
      prompt_contains: deploy
```

**6. Disable a system-shipped hook from user layer**

```yaml
# ~/.agents/agents.yaml
hooks:
  03-linear-inject-tasks-context:
    script: 03-linear-inject-tasks-context.sh
    events:
      - UserPromptSubmit
    enabled: false
```

**7. Fire a hook only on session start in dirty repos**

```yaml
hooks:
  dirty-tree-warn:
    script: dirty-tree-warn.sh
    events:
      - SessionStart
    matches:
      git_dirty: true
```

**8. View a hook's script source**

```bash
agents hooks view post-edit
agents hooks view       # interactive picker
```

**9. Remove a hook**

```bash
agents hooks remove post-edit
agents hooks remove     # interactive picker
agents hooks remove post-edit --agents claude
```

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/hooks.mp4"></video>

## See Also

- [02-resource-sync.md](02-resource-sync.md) — hooks participate in the same layered resource sync as commands, skills, and rules
- [docs/plugins.md](plugins.md) — plugins can bundle hooks alongside skills and MCP servers
- [docs/workflows.md](workflows.md) — workflow lifecycle events that hooks can observe
- [docs/subagents.md](subagents.md) — subagent definitions that parent agents dispatch to
