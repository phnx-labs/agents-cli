# agents-cli (monorepo)

A monorepo housing the `agents` CLI and the Factory VS Code extension, plus their
shared libraries and native helpers. Install, configure, run, and dispatch AI
coding agents (Claude, Codex, Gemini, Cursor, OpenCode, OpenClaw, Grok, Droid, …)
from one place.

> Phoenix Labs OSS (Apache-2.0). **NOT part of the Rush brand** — see
> [§Brand identity](#brand-identity) before touching assets, demos, or website.

**This file is the repo map + repo-wide policy.** Each component has its own
`AGENTS.md` (agent map) and/or `README.md` (usage). Start there for anything
component-specific — this file deliberately stays shallow.

## Repo map

```
apps/
  cli/        @phnx-labs/agents-cli — the `agents`/`ag` CLI (the published npm package)
  factory/    Factory — the VS Code extension + its React UI + Electron app (publisher: swarmify, swarm-ext)
native/
  computer-mac/   Swift daemon behind `agents computer` (Accessibility + screen capture)
  computer-win/   C#/.NET daemon behind `agents computer` on Windows (UI Automation)
packages/
  session-tracker/  @agents/session-tracker — SessionStart hook that WRITES live-session state
  swarmify-mirror/  legacy npm-redirect stub (@companion/agents-cli → @phnx-labs/agents-cli)
docs/         Source-grounded design reference (start: docs/00-concepts.md)
assets/ demo/ website/   Brand, launch demo, landing (repo-root, not shipped in any tarball)
```

| Component | What it is | Read |
|---|---|---|
| [`apps/cli`](apps/cli) | The CLI — version mgmt, config sync, sessions, teams, cloud, browser, computer, secrets | [AGENTS.md](apps/cli/AGENTS.md) · [README.md](apps/cli/README.md) |
| [`apps/factory`](apps/factory) | Factory VS Code extension — spawns agent terminals as tabs, Factory Floor dashboard, dispatch | [AGENTS.md](apps/factory/AGENTS.md) · [README.md](apps/factory/README.md) |
| [`native/computer-mac`](native/computer-mac) | macOS `agents computer` backend (Swift) | [AGENTS.md](native/computer-mac/AGENTS.md) · [README.md](native/computer-mac/README.md) |
| [`native/computer-win`](native/computer-win) | Windows `agents computer` backend (C#/.NET) | [AGENTS.md](native/computer-win/AGENTS.md) · [README.md](native/computer-win/README.md) |
| [`packages/session-tracker`](packages/session-tracker) | Live-session **writer** (SessionStart hook) | [AGENTS.md](packages/session-tracker/AGENTS.md) · [README.md](packages/session-tracker/README.md) |
| [`packages/swarmify-mirror`](packages/swarmify-mirror) | Deprecated npm-redirect stub | [README.md](packages/swarmify-mirror/README.md) |

**No JS workspaces.** Each package self-installs (`bun install` inside it). There is
deliberately no root `workspaces` field — adding one changed bun's hoisting and broke
`@inquirer/core` resolution under `--frozen-lockfile`. Don't add it back. There are no
cross-package imports except the CLI resolving the native helpers by relative path.

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
  something to dig into. (It's a Rush Cloud app, not a `.github/workflows/` Action.)
- **The default branch is untouchable.** Every change is a git worktree + PR — never
  edit or commit on `main`. Worktrees live under `.agents/worktrees/<slug>/`.
- **VS Code publish identity is frozen.** `apps/factory` publishes as publisher
  `swarmify`, name `swarm-ext`, appId `com.swarmify.factory`, productName `Factory`.
  Never change these — it would orphan the Marketplace listing. The product is called
  **Factory**; the CLI is **agents-cli**. (There is no "Agency.Li" — that was a
  dictation artifact.)

## Security

**No sensitive data in any DotAgents repo** — all three (`project` / `user` / `system`)
are designed to be safely version-controlled. Use `agents secrets` (macOS
Keychain-backed, metadata only, never raw credentials on disk). Committed a secret by
accident? Rotate immediately — git history persists.

## Brand identity

`agents-cli` is a Phoenix Labs OSS product (Apache-2.0). **NOT part of the Rush brand.**
Phoenix Horizon, Inc. owns several brands; agents-cli sits in the OSS lane, Rush in the
consumer-product lane.

When working on this repo or the sibling `agent-cli-web` landing:

- **No Rush styling** — no gold sheen, cream paper, falcon mark, Cormorant Garamond
  serif, "Interface for the future" voice. The Rush plugin at `~/.agents/plugins/rush/`
  is a tool to call, not a brand to import.
- **No `~/Rush/Brand/` writes** for agents-cli renders, screenshots, or videos. Use
  `~/Phoenix/agents-cli/` or this repo's `assets/` / `demo/out/`.
- **Visual language is terminal-coded** — `#0a0a0a` bg, `#a3e635` lime accent, JetBrains
  Mono for wordmark + code, Inter for prose. See [`assets/`](assets/), [`demo/src/`](demo/src/),
  [`website/`](website/).
- **Voice is direct-developer** — verb + artifact, no marketing claims. Closer to a `man`
  page than a landing pitch.
- **Composer + animator skills** can be USED here — but ignore their §Brand voice
  sections (Rush-only). Override destination to `~/Phoenix/agents-cli/launches/` and use
  this repo's color/type tokens.

Note: `apps/factory` (the Factory extension) is a **different product** with its own
`swarmify`/Factory identity — the Phoenix "no Rush brand" rule governs the CLI, assets,
demo, and website; Factory keeps its own brand and publish identity (frozen, above).

If any agent starts pulling Rush styling, paths, or voice into agents-cli work, stop
and reread this block.

## Detailed design

[`docs/`](docs/README.md) is source-grounded reference. Start with
[`00-concepts.md`](docs/00-concepts.md) for the full mental model and resolution
semantics of the CLI.
