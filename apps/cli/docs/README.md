# agents-cli docs

Reference documentation for every feature `agents` ships. Read [`00-concepts.md`](00-concepts.md) first if you are new — it covers DotAgents repos, resource kinds, and the layered resolution model that everything else builds on.

Source-grounded: every command, flag, and YAML field is sourced from `src/`. If you spot a mismatch, the code wins — please file an issue.

---

## Core

How agents-cli is laid out on disk and how it decides what to load.

| Doc | What it covers |
|---|---|
| [Concepts](00-concepts.md) | DotAgents repos, resource kinds, project › user › system resolution. |
| [Version management](01-version-management.md) | Installing, pinning, switching, and isolating agent CLI versions. |
| [Self-healing installs](self-healing.md) | Detect, surface, and repair a broken agent binary (gutted install / `ENOENT`) instead of dying cryptically. |
| [Resource sync](02-resource-sync.md) | How rules, commands, skills, hooks, etc. land in each version home. |
| [Sessions](05-sessions.md) | Unified transcript discovery across Claude, Codex, Gemini, OpenCode. |
| [Observability](06-observability.md) | The three `--json` sources (sessions / cloud / teams) as a fleet view, plus `agents mailboxes` fleet comms. |
| [SSH transport](09-ssh-transport.md) | The one multiplexed engine every `--host` command rides — default connection reuse, keepalive, one-round-trip follow. |
| [Optimizations](99-optimizations.md) | Sync manifest, SSH transport, startup profiling, hot-path notes. |
| [Landscape](04-landscape.md) | Where agents-cli sits next to similar tools. |

## Credentials and model routing

| Doc | What it covers |
|---|---|
| [Profiles](profiles.md) | Named (host CLI, endpoint, model, keychain auth) bundles — run Kimi / MiniMax / GLM / DeepSeek / Qwen through Claude Code with no proxy. |
| [Secrets](secrets.md) | Keychain-backed env-var bundles. Inject into runs via `agents run --secrets <name>`. 1Password import/export, encrypted push/pull. |
| [Secrets-agent process model](08-secrets-agent-process-model.md) | Design decision: fold the secrets broker into a hardened, always-on daemon — make the host reliable enough to carry the critical service rather than routing around it. |

## Orchestration

| Doc | What it covers |
|---|---|
| [Fleet profile sync](fleet.md) | `agents apply` — reconcile every device to a declared `fleet:` profile: install agents, sync config, propagate logins so one signed-in host seeds the fleet. |
| [Teams](teams.md) | Multi-agent DAG teams, boundary contracts, `--watch` supervisor, `--worktree` isolation, `--cloud` dispatch. |
| [Cloud](cloud.md) | Unified dispatch across Rush Cloud / Codex Cloud / Factory. Multi-repo tasks, balanced routing, SSE streaming. |
| [Hosts](hosts.md) | Offload `agents run` to your own machines over SSH (`--host`); track with `agents hosts ps` and view/follow with `agents logs`. |
| [Routines](03-routines.md) | Cron-scheduled and signed-webhook-triggered agent runs with sandboxed permissions and a long-running daemon. |
| [Monitors](10-monitors.md) | Durable event-triggered watchers: watch a source, detect a change, fire an action. A routine whose trigger is a watched source instead of a clock. |

## Extensibility

| Doc | What it covers |
|---|---|
| [Plugins](plugins.md) | Distributable bundles of skills + hooks + permissions. Exec-surface consent gate. |
| [Workflows](workflows.md) | `WORKFLOW.md` multi-agent pipelines, auto-secrets, allowed-agents allow-list. |
| [Subagents](subagents.md) | Focused agent definitions that parent agents can spawn via `Task()`. |
| [Hooks](hooks.md) | Shell scripts on agent lifecycle events. Predicate matchers (`tool_name`, `cwd_includes`, `git_dirty`, …). |
| [Entrypoints & Loops](07-entrypoints-and-loops.md) | Plugin packaging model, unified `run` target grammar, `loop:` block design. |

## Automation

| Doc | What it covers |
|---|---|
| [Browser](browser.md) | Drive Chrome / Brave / Edge / Electron via CDP. Profiles, screenshots, click/type/evaluate, remote endpoints. |
| [PTY](pty.md) | Persistent pseudo-terminals for REPLs and TUIs — start, exec, screen-snapshot, signal. |
| [Computer](computer.md) | macOS Accessibility automation — screenshot the active app, click by label. |
| [Menu bar](menubar.md) | macOS status item — live sessions, agents awaiting input, routines, + new session. Auto-enabled; `agents menubar enable/disable/status`. |
| [Terminal engine](terminal-engine.md) | Open a command as a tab or split pane in iTerm / Ghostty / tmux, local or over `--host`. Powers `sessions resume`. |

---

## Conventions used in these docs

- **Architecture diagrams** are ASCII so they render anywhere and diff cleanly.
- **YAML schema** blocks document the on-disk format. Field types come from the matching TypeScript interface in `src/`.
- **Command reference** tables list every subcommand and flag. Run `agents <cmd> --help` if anything looks stale.
- **Recipes** are numbered, copy-pasteable shell sequences. They run end-to-end, not toy snippets.
- **Demo clips** under `assets/videos/` are 6–15s real terminal captures. The pipeline is documented in [`../assets/videos/README.md`](../assets/videos/README.md).

## Contributing

Docs live as plain Markdown so they can be edited by anyone and rendered anywhere (GitHub, VS Code preview, future MDX wrapper for agents-cli.sh). When you add or rename a command, update the matching doc in the same PR. The verification loop:

```bash
agents <cmd> --help                    # confirm every flag mentioned in the doc still prints
rg -o '\[[^]]+\]\([^)]+\)' docs/*.md   # quick scan for broken relative links
```
