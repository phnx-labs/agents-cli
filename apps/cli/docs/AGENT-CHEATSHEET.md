# agents-cli — agent cheat sheet

Read this first, then dive into [`architecture.md`](architecture.md) or the per-feature docs. This file is the on-ramp: the concepts agents repeatedly need when touching this codebase.

## 1. What agents-cli actually does

One engine installs the **resources** an agent needs, **runs** the agent, and extends it with tools, sessions, teams, and machines. Deep reference: [`00-concepts.md`](00-concepts.md).

## 2. The three DotAgents repos (resolution order matters)

Resources and `agents.yaml` resolve in this order; same-name wins, everything else unions:

```
project (.agents/)  >  user (~/.agents/)  >  extra (~/.agents-<alias>/)  >  system (~/.agents/.system/)
```

Source: [`src/lib/resources.ts`](../src/lib/resources.ts) (`resolveResource`, `listResources`).

Implication: don't edit `~/.agents/.system/` directly; put overrides in `~/.agents/` or project `.agents/`.

## 3. `AGENTS.md` is the canonical memory file

`CLAUDE.md`, `GEMINI.md`, etc. are **symlinks**. Edit `AGENTS.md` only. The sync rewrites the per-agent file names.

## 4. Capability table gates every per-agent write

[`src/lib/capabilities.ts`](../src/lib/capabilities.ts) `supports(agent, cap, version?)` is the single source of truth for "can this agent+version receive this resource?". Out-of-range versions are skipped silently. Never scatter `=== 'claude'` checks; route through `supports()`.

Snapshot in [`apps/cli/AGENTS.md`](../AGENTS.md) §Supported harnesses — keep it in sync when you change the registry.

## 5. Version homes isolate every agent version

Each installed agent version lives under `~/.agents/.history/versions/<agent>/<version>/home/`. agents-cli swaps `HOME` to that directory before exec-ing the agent. No config bleed between versions.

Source: [`src/lib/versions.ts`](../src/lib/versions.ts), [`src/lib/exec.ts`](../src/lib/exec.ts).

## 6. Two unrelated things are called "session"

| | Transcript | Live identity |
|---|---|---|
| What | conversation on disk | which running **pid** is which session right now |
| Where | agent-native files → `sessions.db` | `~/.agents/.cache/terminals/by-pid/<pid>.json` + `sessions/<pid>.json` |
| Read by | `agents sessions` | `agents sessions --active`, Factory extension |
| Lifetime | durable | ephemeral (pid dies → file is stale) |

Details: [`architecture.md`](architecture.md) §2–4, [`05-sessions.md`](05-sessions.md).

## 7. One execution path

Every agent invocation goes through `buildExecEnv` → `execAgent` / `runWithFallback` in [`src/lib/exec.ts`](../src/lib/exec.ts), entered via `agents run`.

## 8. Self-updating vs pinnable agents

Some harnesses (droid, grok, antigravity, cursor, hermes, kiro, goose) install via `curl | sh` / `brew` and the binary self-updates in place — no pinnable semver. Use `isSelfUpdatingAgent()` ([`src/lib/agents.ts`](../src/lib/agents.ts)) as the single predicate. `isGlobalBinaryAgent()` ([`src/lib/versions.ts`](../src/lib/versions.ts)) is narrower: true only for droid.

## 9. Work on a worktree, never `main`

The default branch is untouchable. Create a worktree under `.agents/worktrees/<slug>/`, open a PR, merge on green. See root `AGENTS.md` §Conventions.

## 10. Tests use real services — no mocking

Tests hit the actual critical path. Integration tests live in `tests/`; unit tests sit next to source (`read.ts` → `read.test.ts`). The full suite runs via `bun run test:remote` in `apps/cli`.

## 11. Where the major code lives

| Area | Entry |
|---|---|
| CLI commands | `src/commands/` |
| Resource resolution | `src/lib/resources.ts` |
| Capability gating | `src/lib/capabilities.ts`, `src/lib/agents.ts` |
| Agent execution | `src/lib/exec.ts` |
| Version install/sync | `src/lib/versions.ts` |
| Session transcript index | `src/lib/session/` |
| Live active sessions | `src/lib/session/active.ts` |
| Hosts / SSH dispatch | `src/lib/hosts/` |
| Teams orchestration | `src/lib/teams/` |
| Secrets broker | `src/lib/secrets/` |
| Cloud providers | `src/lib/cloud/` |

## 12. Keep docs in sync

If you change a flag, command, config key, or behavior, update the relevant doc and `CHANGELOG.md`. If you change a core invariant here, update this cheat sheet too. Drift is checked by `scripts/verify-docs.sh`.
