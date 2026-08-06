# Design: `agents run <agent> --cloud`

Date: 2026-08-05 · Status: spec (approved direction: registry routing, `--cloud` as a placement flag) · Replaces: the removed `cloud` plugin (`~/.agents/.system/plugins/cloud`)

## Summary

Add a `--cloud` placement flag to `agents run` that dispatches the run to the
agent's native cloud through the **existing `agents cloud` provider registry**
(`apps/cli/src/lib/cloud/registry.ts`). It is sugar over `agents cloud run
--agent <agent>` — one entry point (`run`), and `--cloud` selects the cloud
placement the same way `--host`/`--device`/`--lease` select a machine
placement.

## Placement model (confirmed with user)

`agents run` has exactly three placements:

1. **local** — the default.
2. **machine** — `--host` / `--device` (aliases of each other), and `--lease`,
   which is just a *new, disposable box* variant of a machine placement.
3. **cloud** — `--cloud`, the vendor's cloud via the provider registry.

Because they are placements, they are **mutually exclusive by definition**:
when `--cloud` is passed, `--host`/`--device`/`--lease` (and their modifiers)
are not merely unsupported — they are meaningless, and the run dies naming
both flags. There is no "cloud run on a host": placement is chosen once.

## Why registry routing (decision)

`agents cloud run` already implements dispatch, tracking, streaming, cancel,
and follow-up messaging across rush / codex / factory / antigravity / host,
with agent auto-routing via the `cloudProvider` field on the agent registry.
The alternative — appending each harness's native flag (`claude --cloud`,
`codex exec --cloud`, `cursor-agent --cloud`) — was rejected: sessions would
live outside `agents cloud list/status/logs/cancel/message`, tracking would be
uneven per vendor, and the flag would silently mean a different backend per
agent.

## Native cloud support by harness (researched 2026-08-05)

| Harness | Native cloud | Routed provider |
|---|---|---|
| claude | `claude --cloud "<prompt>"` (hidden flag, docs 2026-08-04; Anthropic infra, claude.ai/code; needs claude.ai sub auth) | `rush` (unchanged by this spec) |
| codex | `codex cloud exec` / `codex exec --cloud` | `codex` (provider already wraps the native CLI) |
| cursor | `cursor-agent --cloud` (since 2026-03) | **none yet** — fails loud until a cursor provider lands (follow-up) |
| droid | Factory pods | `factory` |
| antigravity | Gemini Managed Agents | `antigravity` |
| kimi | none found (kimi-cli is local-only; kimi-agent-sdk is programmatic, not cloud) | unsupported — fail loud |
| grok | none found (Grok Build is terminal-native: subagents, plan mode, Arena Mode — no cloud/remote dispatch flag) | unsupported — fail loud |
| opencode, copilot, kiro, goose, pi, forge | none found | unsupported — fail loud |

## Spec

### Surface

```
agents run <agent> [prompt] --cloud [--provider <id>] [--repo <owner/repo>]...
          [--branch <name>] [--env <id>] [--no-follow] [--json]
```

- `--cloud` — boolean placement flag. Routes via
  `resolveProvider(undefined, agent)`; the agent's `cloudProvider` wins, then
  `cloud.default_provider`, then `rush` (existing precedence).
- `--provider <id>` — optional override, same meaning as on `agents cloud run`.
- `--repo` (repeatable), `--branch`, `--env` — forwarded into
  `DispatchOptions` exactly as `agents cloud run` does. `--repo` required when
  the resolved provider is `rush` (mirror the existing validation).
- Reused run flags that map cleanly: `--timeout`, `--model`, `--no-follow`
  (dispatch and exit, print the task id + follow-up commands), `--json`.
- `--where cloud[:provider]` — added to the placement-door spec as the exact
  equivalent of `--cloud` / `--cloud --provider <provider>`
  (`docs/00-concepts.md#placement` updated in the implementing PR).

### Semantics

1. `--cloud` implies headless. A prompt is required (positional or stdin, same
   resolution as `agents cloud run`, including the prompt-file path).
2. Dispatch goes through the resolved provider's `dispatch()`, the task is
   persisted via `insertTask`, and output streams through `renderStream`
   unless `--no-follow` — i.e. the run behaves identically to
   `agents cloud run` with the same options, and is visible in
   `agents cloud list/status/logs/cancel/message`.
3. **Fail loud on unsupported agents** (repo convention): an agent with no
   `cloudProvider` and no configured default errors with the list of
   cloud-capable agents. No silent local fallback, ever.
4. **Placement exclusivity** — `--cloud` conflicts with every machine-placement
   flag: `--host`/`--device`/`--on`/`--computer`, `--where` (unless
   `cloud…`), `--lease`/`--box`/`--fresh`/`--reuse`/`--keep-box`/`--bare`/
   `--tailscale`. It also conflicts with local-only run modes: `--terminal`,
   `--interactive`, `--acp`, `--loop` and its guards, `--resume`/`--session-id`,
   `--secrets*`, `--copy-creds`. Each conflict dies with a message naming both
   flags.

### Implementation sketch (for the implementing PR)

- `apps/cli/src/commands/exec.ts` (`registerRunCommand`): add `--cloud`,
  `--provider`, `--repo`, `--branch`, `--env` options; in the action, branch
  early to a shared `dispatchCloudRun()` helper.
- Extract the dispatch core of `agents cloud run` (prompt resolution →
  provider resolution → `DispatchOptions` build → dispatch → `insertTask` →
  stream) from `apps/cli/src/commands/cloud.ts` into
  `apps/cli/src/lib/cloud/dispatch.ts`, and call it from both surfaces. No
  second dispatch path (one engine).
- Extend `--where` parsing with `cloud[:provider]`.
- `setHelpSections` examples on `run`: cloud placement examples after the
  `--host` ones.
- Fix the now-stale comment at `apps/cli/src/lib/agents.ts:237` ("Claude Code
  has no headless Anthropic-hosted dispatch CLI") — `claude --cloud` now
  exists; record that routing to `rush` is deliberate (this doc).
- Tests (real path, no mocks): registry routing for each capable agent
  (claude→rush, codex→codex, droid→factory, antigravity→antigravity), the
  unsupported-agent error, each placement-conflict rejection, `--where cloud`
  equivalence. Next to source per repo convention.
- Docs: `apps/cli/docs/` run reference + `docs/00-concepts.md#placement`,
  README feature list, CHANGELOG entry.

## Follow-ups (not in this spec)

- **Cursor provider** wrapping `cursor-agent --cloud`, then
  `cloudProvider: 'cursor'` on the cursor registry entry — capability flips to
  supported only in the same PR as the real code path (repo rule).
- **Kimi / Grok**: no native cloud exists for either; revisit if Moonshot or
  xAI ships one.
- **Native claude provider** (`claude --cloud` → claude.ai/code) as an
  additional provider, if direct Anthropic-infra dispatch without Rush is
  wanted. Would give `agents run claude --cloud --provider claude`.

## Tracking

- **RUSH-2224** — Implement `agents run --cloud` placement flag (registry-routed):
  <https://linear.app/getrush/issue/RUSH-2224/implement-agents-run-cloud-placement-flag-registry-routed>
  Carries this spec's acceptance criteria. The follow-ups above are out of its
  scope; the cursor provider's adjacent parent is RUSH-2079.
