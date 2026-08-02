# agents-cli (monorepo)

A monorepo housing the `agents` CLI and the Factory VS Code extension, plus their
shared libraries and native helpers. Install, configure, run, and dispatch AI
coding agents (Claude, Codex, Gemini, Cursor, OpenCode, OpenClaw, Grok, Droid, …)
from one place.

> Phoenix Labs OSS · Apache-2.0.

**This file is the repo map + repo-wide policy.** Each component has its own
`AGENTS.md` (agent map) and/or `README.md` (usage). Start there for anything
component-specific — this file deliberately stays shallow.

## Repo map

```
apps/
  cli/        @phnx-labs/agents-cli — the `agents`/`ag` CLI (the published npm package)
  factory/    Factory — the VS Code extension + its React UI + Electron app (publisher: swarmify, swarm-ext)
  ios/        Fleet Cockpit — iOS/iPadOS control-plane app (AnchorKit SwiftPM lib + Cockpit SwiftUI); steers the fleet, never a compute worker
native/
  computer-mac/   Swift daemon behind `agents computer` (Accessibility + screen capture)
  computer-win/   C#/.NET daemon behind `agents computer` on Windows (UI Automation)
packages/
  session-tracker/  @agents/session-tracker — SessionStart hook that WRITES live-session state
  agi-cli/          @phnx-labs/agi-cli — DEPRECATED alias; re-exports the canonical @phnx-labs/agents-cli
  swarmify-mirror/  legacy npm-redirect stub (@companion/agents-cli → @phnx-labs/agents-cli)
docs/         Repo-root design notes (docs/design/); the full CLI design reference is apps/cli/docs/ (start: apps/cli/docs/architecture.md)
assets/ demo/ website/   Brand, launch demo, landing (repo-root, not shipped in any tarball)
```

| Component | What it is | Read |
|---|---|---|
| [`apps/cli`](apps/cli) | The CLI — version mgmt, config sync, sessions, teams, cloud, browser, computer, secrets | [AGENTS.md](apps/cli/AGENTS.md) · [README.md](apps/cli/README.md) |
| [`apps/factory`](apps/factory) | Factory VS Code extension — spawns agent terminals as tabs, Factory Floor dashboard, dispatch | [AGENTS.md](apps/factory/AGENTS.md) · [README.md](apps/factory/README.md) |
| [`apps/ios`](apps/ios) | Fleet Cockpit — iOS/iPadOS control-plane app over the anchor (`agents serve --control`) | [AGENTS.md](apps/ios/AGENTS.md) · [README.md](apps/ios/README.md) |
| [`native/computer-mac`](native/computer-mac) | macOS `agents computer` backend (Swift) | [AGENTS.md](native/computer-mac/AGENTS.md) · [README.md](native/computer-mac/README.md) |
| [`native/computer-win`](native/computer-win) | Windows `agents computer` backend (C#/.NET) | [AGENTS.md](native/computer-win/AGENTS.md) · [README.md](native/computer-win/README.md) |
| [`packages/session-tracker`](packages/session-tracker) | Live-session **writer** (SessionStart hook) | [AGENTS.md](packages/session-tracker/AGENTS.md) · [README.md](packages/session-tracker/README.md) |
| [`packages/agi-cli`](packages/agi-cli) | Deprecated alias — re-exports the canonical CLI | [README.md](packages/agi-cli/README.md) |
| [`packages/swarmify-mirror`](packages/swarmify-mirror) | Deprecated npm-redirect stub | [README.md](packages/swarmify-mirror/README.md) |

**No JS workspaces.** Each package self-installs (`bun install` inside it). There is
deliberately no root `workspaces` field — adding one changed bun's hoisting and broke
`@inquirer/core` resolution under `--frozen-lockfile`. Don't add it back. There are no
cross-package imports except the CLI resolving the native helpers by relative path.

## Core concepts

What agents-cli actually is: one engine that installs the **resources** an agent needs,
**runs** the agent, and extends it with real-world **tools**, **sessions**, **teams**, and
other **machines**. Deep reference: [`apps/cli/docs/00-concepts.md`](apps/cli/docs/00-concepts.md)
and [`architecture.md`](apps/cli/docs/architecture.md).

- **Resources** — the typed things an agent needs, one kind per subdirectory of a
  DotAgents repo: `rules` (this `AGENTS.md` → `CLAUDE.md`/`GEMINI.md`/…), `commands`,
  `skills`, `hooks`, `mcp`, `permissions`, `profiles`, `subagents`. Installed once in
  `~/.agents/` and synced into each agent's native format. Resolution is **layered** —
  project → user → extra repos → system; the highest layer wins a name collision, the
  rest union (`apps/cli/src/lib/resources.ts`: `resolveResource`, `listResources`).
- **One execution engine.** Every agent invocation goes through one path —
  `buildExecEnv` → `execAgent` / `runWithFallback` in
  [`apps/cli/src/lib/exec.ts`](apps/cli/src/lib/exec.ts), entered via `agents run`. Each
  agent version runs in an isolated **version home** (`HOME` swapped before exec) so
  configs never bleed between versions.
- **Real-world tool surfaces.** `agents browser` (web) and `agents computer` (native
  desktop, backed by the `native/computer-*` daemons) are the essential tools that let an
  agent act on real UIs — the difference between talking about a task and doing it.
- **Sessions.** Two things wear the name: a durable **transcript** (on disk, indexed in
  `sessions.db`, read by `agents sessions`) and an ephemeral **live identity** (which pid
  is which session right now, surfaced by `--active`). Transcripts sync across the fleet,
  so a session is searchable and resumable **cross-device**.
- **Teams.** `agents teams` runs several agents in parallel on one task, each isolated in
  its own worktree — the multi-agent surface.
- **Devices & hosts.** agents-cli runs commands on other machines over SSH, no daemon:
  **devices** are the Tailscale fleet (`agents devices`), **hosts** are dispatch targets
  (`agents hosts`); `-H/--host <name>` routes a command to any of them. This is the
  cross-device fabric under sessions, teams, run, and cloud.
- **One engine, many consumers.** `apps/cli` owns the state — the session index, the
  pid→id registry, `sessions`/`teams`/`run`/`cloud`, and the SSH fan-out. `apps/factory`
  is a **consumer**: the VS Code UI layer that shells out to
  `agents sessions --active --json`, holding no data models of its own — not a separate
  codebase. Fix a mechanism in the CLI and every consumer benefits.

## Entry points — always build and release through the scripts

Never hand-roll a build or a release. A bare `tsc` / `bun run build` / `npm publish` /
`vsce publish` skips the version stamping, gates (tests + semver + CHANGELOG), and
sign/notarize + tap/marketplace steps these scripts own — a green local compile that
ships broken. Each component's `scripts/` dir is the contract (see
[`.agents/skills/scripts`](.agents/skills/scripts/SKILL.md)); add a `scripts/<verb>.sh`
rather than a one-off command in a PR.

| Task | Script | Contract |
|---|---|---|
| CLI build | [`apps/cli/scripts/build.sh`](apps/cli/scripts/build.sh) `[<version>] [--clean]` | builds into `apps/cli/dist` |
| CLI dev install | [`apps/cli/scripts/install.sh`](apps/cli/scripts/install.sh) | side-by-side dev build at `~/.local/agents-cli-dev`, exposed via `~/.local/bin/agents`; does not touch the registry install |
| CLI tests | `bun run test:remote` (in `apps/cli`) | full vitest suite offloaded to a remote crabbox via [`sandbox.sh`](apps/cli/scripts/sandbox.sh) — the laptop-safe path |
| CLI release | [`apps/cli/scripts/release.sh`](apps/cli/scripts/release.sh) `<version> [--apply]` | zero-config self-routing publish of `@phnx-labs/agents-cli` to npm: runnable from any fleet box with an empty environment — tests on a dynamic crabbox, PR + CI, then build/sign/notarize/publish on the `mac-mini` home base (the one hardcoded name); prints a `[n/6]` phase tracker. Legacy `@swarmify` shim built for reference, not published |
| Factory build / release | [`apps/factory/scripts/build.sh`](apps/factory/scripts/build.sh) `<version>` · [`release.sh`](apps/factory/scripts/release.sh) `<x.y.z> [--confirm] [--host <name>] [--here]` | ships `swarmify.swarm-ext` to VS Code Marketplace + Open VSX (dry-run without `--confirm`). Self-routing like the CLI release: the marketplace PATs live in the `vs-marketplace` secrets bundle on one machine, and tokens never move between hosts, so invoking from a box without the bundle probes `zion` then `mac-mini` and re-runs the publish there against a clean clone of the same commit. `--host` pins the publish box, `--here` refuses to route |
| agents-dbg app release | [`scripts/release.sh`](scripts/release.sh) `<version> [--confirm]` | root — builds/signs/notarizes the debug Mac app, uploads the GitHub release, updates the Homebrew tap |
| computer-mac build | [`native/computer-mac/scripts/build.sh`](native/computer-mac/scripts/build.sh) | Swift daemon |

## The `.agents/` workspace

The repo's own `.agents/` dir is where agent working files go — use it instead of `/tmp`
or the repo root so the tree stays clean. What's committed vs gitignored is deliberate
([`.gitignore`](.gitignore)):

| Path | Git | For |
|---|---|---|
| `.agents/worktrees/<slug>/` | ignored | PR-bound worktrees, one per change (see [§Conventions](#conventions-repo-wide)) |
| `.agents/scratch/` | ignored | throwaway working files |
| `.agents/plans/` | ignored | internal implementation plans (not shipped) |
| `.agents/artifacts/` | ignored | generated outputs, incl. a scratch rendered HTML plan |
| `.agents/skills/`, `.agents/commands/` | committed | project skills + slash commands |
| `.agents/reports/` | committed | durable reports meant to be kept/shared |

Rule of thumb: **ephemeral → the gitignored dirs; durable + shareable → `.agents/reports/`.**
A rendered HTML plan you want to keep goes in `reports/` (committed); a throwaway render
goes in `artifacts/`. Never scatter scratch in `/tmp` or the repo root.

## Conventions (repo-wide)

- **`AGENTS.md` is the canonical memory file.** `CLAUDE.md` / `GEMINI.md` are symlinks
  to it (`ls -la *.md`). **Edit `AGENTS.md` only** — a symlink target edited directly
  gets stomped on the next sync. This holds at the repo root and in every component.
- **Real services only — no mocking.** Tests must exercise the actual critical path.
  Test file sits next to source (`read.ts` → `read.test.ts`); integration tests in each
  package's `tests/`.
- **PRs are auto-reviewed by `prix/code-reviewer`** ([`.github/rush.yml`](.github/rush.yml)) —
  it reviews every PR to `main` and posts its verdict as the **`prix-cloud`** comment. That
  is the non-author review: rely on it and merge on green, don't spawn a redundant subagent
  reviewer. Review manually only if `prix-cloud` hasn't posted after CI settles or flags
  something to dig into. (It's a cloud reviewer configured in `.github/rush.yml`, not a
  `.github/workflows/` Action.) The
  reviewer reads this file before every review and enforces the conventions in
  [§Code review conventions](#code-review-conventions-the-reviewer-must-enforce-these) —
  that block is what it checks the diff against, not just prose for humans.
- **The default branch is untouchable.** Every change is a git worktree + PR — never
  edit or commit on `main`. Worktrees live under `.agents/worktrees/<slug>/`.
- **VS Code publish identity is frozen.** `apps/factory` publishes as publisher
  `swarmify`, name `swarm-ext`, appId `com.swarmify.factory`, productName `Factory`.
  Never change these — it would orphan the Marketplace listing. The product is called
  **Factory**; the CLI is **agents-cli**. (There is no "Agency.Li" — that was a
  dictation artifact.)

## Code review conventions (the reviewer must enforce these)

`prix/code-reviewer` reads this section on every PR and flags any violation with a
`file:line` reference. These are blocking unless the PR description explicitly justifies
the exception.

- **No stubs, placeholders, or unimplemented paths.** A function that returns a canned
  value, `throw new Error("not implemented")`, an empty body where behavior is expected, a
  hardcoded mock standing in for a real call, or a `// TODO`/`// FIXME` that defers the
  actual work — none of these merge. Flag every one with `file:line` and the concrete
  behavior that's missing. Real implementation or nothing; a stub is a bug the diff is
  hiding, not progress. (If work genuinely must be deferred, it carries a linked tracking
  ticket in the comment and the PR says so — an intent-only `// TODO` with no ticket does
  not qualify.)
- **Harness parity for cross-agent features.** The CLI integrates many agent harnesses —
  Claude, Codex, Gemini, Cursor, OpenCode, OpenClaw, Grok, Droid, Copilot, Kiro, Goose,
  Antigravity, Kimi, Forge. When a change adds or extends a capability that applies across
  harnesses (subagents, hooks, MCP, allowlists, config sync, skills, workflows), it should
  cover **every** harness the capability applies to — or the PR states which are out of
  scope and why. Flag a diff that wires up two or three agents and silently skips the rest.
  The registry-driven integrations are the pattern to follow (one table entry, e.g.
  `SUBAGENT_TARGETS` in `apps/cli/src/lib/subagents-registry.ts`, gated by
  `capableAgents(...)` — not near-identical `else if (agent === '...')` arms), and the
  completeness tests that pin the registry to the capability list must still pass.
- **Surface parity for propagation / cross-cutting features.** When a change adds data
  that must ride the exec env or a spawn — actor/provenance, identity, session lineage,
  credentials — it must be wired through **every** exec boundary that data is meant to
  reach: the local spawn (`buildExecEnv`), `--host` SSH dispatch, `agents ssh`
  passthrough, teams (local **and** remote teammates), and routines/cron — or the PR
  states which boundaries are out of scope and why. The tell is an **absence** at a
  remote call site (no `SetEnv`/`--env` forwarding across the SSH hop), so check the
  remote dispatch builders (`apps/cli/src/lib/hosts/dispatch.ts`, `hosts/remote-cmd.ts`),
  not just the changed files — a diff that wires only the local path and silently drops
  the data at the first SSH boundary is incomplete. (RUSH-2028 fixed exactly this gap for
  actor provenance, which PR #1525 shipped local-only.)
- **Docs stay in sync with behavior.** A change to a flag, command, config key, or
  user-visible behavior updates the docs that cover it — the relevant component
  `AGENTS.md`, its `README.md`, and `apps/cli/docs/`. Flag a diff that adds or changes a
  surface but leaves the docs describing the old behavior, and flag examples/command names
  in docs that the change has made stale. Exempt: pure internal refactors, test-only
  changes, self-evident renames.
- **README / feature list for core features.** A new core capability (a new top-level
  command or a substantial subsystem) updates the README and any feature/command index so
  it's discoverable — shipping it code-only, invisible to users, is incomplete.
- **CHANGELOG for user-visible changes.** `apps/cli` ships as the published
  `@phnx-labs/agents-cli` npm package. A change to a flag, command, or behavior adds a
  CHANGELOG entry under the next version. Same exemptions as docs.
- **No fallback band-aids.** Reject "just in case" branches, defensive lookups that paper
  over a data-shape inconsistency, or a second code path added to tolerate bad input.
  Standardize at the source — every fallback is a bug being hidden.
- **No dead or commented-out code.** Removed logic is deleted, not commented out "for
  later." git history is the archive.
- **Tests exercise the real path.** New behavior ships with a test that hits the actual
  critical path (no mocking — see the repo-wide rule above); a bugfix ships with a test
  that reproduces the bug. Flag new behavior or a fix that lands without one.

## Security

**No sensitive data in any DotAgents repo** — all three (`project` / `user` / `system`)
are designed to be safely version-controlled. Use `agents secrets` (macOS
Keychain-backed, metadata only, never raw credentials on disk). Committed a secret by
accident? Rotate immediately — git history persists.

## Assets & voice

Only if you touch `assets/`, `demo/`, or `website/`. Visual language is terminal-coded —
`#0a0a0a` bg, `#a3e635` lime accent, JetBrains Mono for the wordmark + code, Inter for
prose. Voice is direct-developer: verb + artifact, no marketing claims — closer to a
`man` page than a landing pitch. (Factory keeps its own `swarmify`/Factory brand — see
[§Conventions](#conventions-repo-wide) for the frozen publish identity.)

## Detailed design

[`apps/cli/docs/`](apps/cli/docs/README.md) is the source-grounded reference. Start
with [`architecture.md`](apps/cli/docs/architecture.md) for the CLI/extension layering
and the session mechanisms, then [`00-concepts.md`](apps/cli/docs/00-concepts.md) for
the resource model and resolution semantics of the CLI.

**Normative contract.** The major subsystems carry a source-of-truth spec
(RFC-2119 MUST/SHOULD + Given/When/Then, cited to `file:line`) that a change MUST
NOT silently deviate from — [`apps/cli/docs/specifications.md`](apps/cli/docs/specifications.md)
(§[Sessions](apps/cli/docs/specifications.md#sessions) ·
§[Secrets](apps/cli/docs/specifications.md#secrets) ·
§[Agent execution](apps/cli/docs/specifications.md#agent-execution)).
