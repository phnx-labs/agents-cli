# agents-cli (the CLI)

`@phnx-labs/agents-cli` — the `agents` / `ag` CLI for managing AI coding-agent
versions, config, sessions, and cloud dispatch (Claude, Codex, Gemini, Cursor,
OpenCode, OpenClaw, Grok, Droid, …).

This is the **internal architecture** map. The user-facing feature tour is
[README.md](README.md) (pin versions, run, sessions, hosts, teams, workflows,
plugins, browser, secrets, routines, pty). This file covers the design choices,
module map, build, and release mechanics the README does not.

> Phoenix Labs OSS (Apache-2.0). **NOT part of the Rush brand** — brand rules are
> repo-wide, see the root [AGENTS.md](../../AGENTS.md) §Brand identity.

## Core design choices (read this first)

Break these and downstream code drifts silently.

### 1. Three DotAgents repos, resolution is project > user > system

Resources AND `agents.yaml` resolve in that order. Same-name overrides, everything
else unions.

| Path | Role | Edited by |
|---|---|---|
| `<repo>/.agents/` | **Project repo** — project-pinned commands / skills / hooks / rules. | Project maintainers |
| `~/.agents/` | **User repo** — user resources + ALL operational state (versions, shims, sessions, `agents.yaml`, browser). | You / CLI |
| `~/.agents/.system/` | **System repo** — npm-shipped defaults ONLY. | Maintainers (`gh:phnx-labs/.agents-system`) |

Extra repos register via `agents repo add <source>` → clone into `~/.agents-<alias>/`
and participate after the user repo.

### 2. `AGENTS.md` is the canonical memory file

`CLAUDE.md`, `GEMINI.md` are symlinks. **Edit `AGENTS.md` only** — editing a symlink
target directly gets stomped on the next sync. The sync writes the right file name
per agent (`OPENCODE.md`, `.cursorrules`, etc.).

### 3. Capability table gates per-agent writes

`supports(agent, cap, version?)` in [`src/lib/capabilities.ts`](src/lib/capabilities.ts)
is the only place that decides whether an agent+version can receive a resource.
Out-of-range versions are **skipped silently** — do not add per-call agent checks
elsewhere; route through `supports()`.

### 4. No fallback logic for legacy layouts

[`src/lib/migrate.ts`](src/lib/migrate.ts) folds legacy paths ONCE at install time.
The bootstrap gate that invokes `runMigration()` then writes the `.migrated` sentinel
(`MIGRATED_SENTINEL_FILE`, [`src/lib/state.ts`](src/lib/state.ts)), keyed to the
migration SCHEMA version, so the scan short-circuits next run — `runMigration()` itself
only relocates a legacy sentinel via `moveFileOnce`, never writes one. Downstream code
assumes the post-fold layout. "Just-in-case" branches re-introduce drift bugs; the
migrator is the single source of truth for legacy handling.

### 5. Hooks live in a single layered `hooks.yaml`

System + user `hooks.yaml` merged, user wins on same name. Per-entry `matches:`
predicates (`prompt_contains`, `prompt_matches`, `tool_name`, `tool_args_match`,
`cwd_includes`, `project_has`, `git_dirty`) AND together at fire time. Per-entry
`enabled: false` disables a system-shipped hook from the user side. The `agents:`
field in `ManifestHook` is `@deprecated` — the capability table decides which
agents register a hook.

### 6. Multi-agent work → `agents teams`

DAG-style, boundary contracts, `--watch` supervisor, `--worktree` isolation, optional
`--cloud` dispatch. The old `mcp__Swarm__*` surface was folded into teams
(`migrateLegacySwarmToTeams()` in `src/lib/migrate.ts`). Don't reach for Swarm — gone.

## Supported harnesses

14 harnesses ship support today. The full id list is `AgentId`
([`src/lib/types.ts`](src/lib/types.ts)); per-harness config + capabilities live in the
`AGENTS` registry ([`src/lib/agents.ts`](src/lib/agents.ts)) and are gated through
`supports()`. **Prioritized (first-class):** Claude Code, Codex CLI, Kimi CLI,
Antigravity CLI, Grok CLI, OpenCode — features target these six first.

| Harness | `id` | hooks | mcp | allowlist | skills | commands | plugins | subagents | workflows |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| ★ Claude Code | `claude` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ★ Codex CLI | `codex` | ≥0.116 | ✓ | — | ✓ | <0.117 | ≥0.128 | ≥0.117 | — |
| ★ Kimi CLI | `kimi` | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| ★ Antigravity CLI | `antigravity` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| ★ Grok CLI | `grok` | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| ★ OpenCode | `opencode` | — | ✓ | ≥1.1.1 | ✓ | ✓ | ✓ | ✓ | — |
| Gemini † | `gemini` | ≥0.26 | ✓ | — | ✓ | ✓ | — | — | — |
| Cursor | `cursor` | ✓ | ✓ | — | ✓ | ✓ | ✓ | — | — |
| OpenClaw | `openclaw` | ✓ | ✓ | — | ✓ | — | ✓ | ✓ | — |
| Copilot | `copilot` | ✓ | ✓ | — | ✓ | ✓ | ✓ | ≥0.0.353 | — |
| Amp | `amp` | — | ✓ | — | ✓ | ✓ | — | — | — |
| Kiro | `kiro` | ≥0.10 | ✓ | ≥2.8 | ✓ | ✓ | — | — | — |
| Goose | `goose` | ≥1.34 | ✓ | — | — | — | ✓ | — | — |
| Droid | `droid` | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | — |

✓ = supported · — = not · version cell = only within that range (out-of-range =
skipped silently). [`src/lib/agents.ts`](src/lib/agents.ts) is canonical — keep this
snapshot in sync. `workflows` is Claude-only; `mcp` is universal; `allowlist` is
`claude`/`antigravity`/`grok`/`kimi`/`kiro`; `subagents` is `claude`/`codex`/`kimi`/`grok`/`openclaw`/`droid`/`copilot`.
**† Gemini is deprecated by Google** (retired June 18 2026); Antigravity is the
successor — the CLI warns on `agents add gemini` (`warnAgentDeprecated`).

## Source layout

```
src/
  index.ts             # CLI entry (commander.js)
  commands/            # User-facing subcommands (one file per `agents <cmd>`)
  lib/
    state.ts           # Path constants; agents.yaml read/write
    resources.ts       # resolveResource() / listResources() — layered resolution
    capabilities.ts    # supports() — the per-agent write gate
    agents.ts          # Per-agent capability table
    versions.ts        # Install, remove, syncResourcesToVersion
    shims.ts           # Shim generation, config symlink switching
    hooks.ts           # hooks.yaml parser + per-agent registrar
    hooks/match.ts     # `matches:` predicate evaluator
    migrate.ts         # One-shot idempotent migrations
    session/           # `agents sessions` READER — discovery/parse/render of agent transcripts
    terminal/          # Terminal launch engine — tab/split in iTerm/Ghostty/tmux, local or --host
    cloud/             # Provider registry (Rush / Codex / Factory / Antigravity)
    teams/             # `agents teams` orchestration
    computer-rpc.ts    # `agents computer` client → native/computer-mac (Unix socket)
    ssh-tunnel.ts      # `agents computer --host` → native/computer-win over ssh -L
    menubar/           # Menu-bar helper installer (source in ../menubar)
    profiles.ts        # Host CLI + endpoint + model bundles
```

Note: `src/lib/session/` here is the transcript **reader**. The live-session
**writer** is a separate package, [`packages/session-tracker`](../../packages/session-tracker)
— different data, different consumer; see its AGENTS.md.

## Bundled native helpers (where the tarball's `.app`s come from)

Two native helpers plus the standalone signed CLI binary ship **inside** this
package's npm tarball; two more helpers are dev-only and live at repo-root `native/`.

| Helper | Source | Ships in tarball? | Resolver |
|---|---|---|---|
| Keychain broker | `src/lib/secrets/keychain-helper.swift` → `bin/Agents CLI.app` | **Yes** (signed + notarized) | `src/lib/secrets/` |
| Menu-bar helper | [`menubar/`](menubar) (SwiftPM) → `bin/MenubarHelper.app` | **Yes** (signed, no notarization) | `src/lib/menubar/install-menubar.ts` |
| Standalone CLI binary | `src/` → `bun build --compile` → `bin/agents-macos` | **Yes** (signed + notarized, arm64 Mach-O at `dist/bin/agents`) | `scripts/postinstall.js` |
| computer-mac | [`../../native/computer-mac`](../../native/computer-mac) | No (built from source) | `src/lib/computer-rpc.ts` |
| computer-win | [`../../native/computer-win`](../../native/computer-win) | No (staged at release) | `src/lib/ssh-tunnel.ts` |

Path math: compiled resolvers run from `apps/cli/dist/lib/…`. Repo-root `native/`
is **4 hops up** (`../../../../native/…`); the co-located `menubar/` is **3 hops up**
(`../../../menubar/dist/…`) because it moved into `apps/cli` with the CLI. Recompute
depth if you move files — don't blind-replace.

## Build, test, dev

```bash
bun install && bun run build && bun test
```

Tests are `*.test.ts` next to source; integration in `tests/`. Every PR to `main`
runs the real suite cheaply on Linux — `test`
([`../../.github/workflows/tests.yml`](../../.github/workflows/tests.yml)) plus
`gitleaks`; those two are the required checks. The full cross-platform matrix
(ubuntu + macOS + Windows × Node 22/24, `ci.yml`) is cost-gated to `release/**`
branches and `v*` tags. CI runs from `apps/cli` via `defaults.run.working-directory`.

**Live Windows `--host` e2e (opt-in):** `src/lib/ssh-tunnel.e2e.test.ts` and
`src/lib/browser/drivers/ssh.e2e.test.ts` drive a real Windows box end-to-end
(exe push + LOGON task, tunnel + RPC, screenshot, type/get-text round-trip,
remote browser launch/stop). Gated on `AGENTS_TEST_WIN_HOST=<registered device>`;
both suites skip cleanly when the var is unset, so CI needs no Windows runner.

**Local dev build:** `scripts/install.sh --skip-tests` builds the working tree and
installs at `$HOME/.local/agents-cli-dev/`, symlinked into `$HOME/.local/bin/agents`.
The npm-installed global is never touched. Version stamps as `0.0.0-dev.<sha>[-dirty]`.

**Bin entrypoints need `chmod 755`.** [`scripts/build.sh`](scripts/build.sh) chmods
every `package.json#bin` entry after `tsc` emits. Newer npm preserves tarball file
mode and does NOT auto-chmod — 644 surfaces as `zsh: permission denied: agents`.

The `files` allowlist in [`package.json`](package.json) is a **whitelist** — only
`dist/**`, the two signed `.app`s, and the postinstall scripts + README/LICENSE ship.
Nothing from `apps/`, `native/`, or sibling `packages/` can leak into the tarball.

## Releasing

**Releases can be cut locally on macOS, or driven from Linux by offloading the
Mac-only signing to a remote sign host.** Run from a clean, in-sync `main`:

```bash
scripts/release.sh <version>          # dry-run: bump, type-check, build, test, tarball preview
scripts/release.sh <version> --apply  # commits chore(release), tags v<version>, npm publish, pushes
```

`release.sh` reads the npm token from the `npmjs.com` secrets bundle (`agents
secrets`) — no 2FA prompt, no token on disk. The script's git-scope reads use
`<ref>:apps/cli/package.json` (not root) since the package moved under `apps/cli`.

**Linux-driven release (`SIGN_HOST`).** The signed macOS artifacts (below) are
the only reason publishing was macOS-pinned. `release.sh` now offloads producing
them: on every **non-macOS** release (the standalone CLI binary embeds the release
version, so it must be rebuilt each time; `FORCE_REMOTE_SIGN=1` forces it on any
host), it invokes [`scripts/remote-sign-mac.sh`](scripts/remote-sign-mac.sh), which
rsyncs the build inputs (the full `src/` tree + `package.json`/`bun.lock`,
keychain-helper.swift, entitlements, the build/sign scripts, the `menubar/` Swift
package, and — if present — `bin/embedded.provisionprofile`)
to `${SIGN_HOST:-mac-mini}`, runs the Mac build scripts there under the appliance's
headless signing creds (unlock `rush-signing.keychain-db`; Apple notary creds via
the `apple.com` secrets bundle), then pulls the signed `bin/*.app` +
`bin/agents-macos` back and re-verifies both sha pins locally. `bun run build` copies the helpers into
`dist/` on a **presence** gate now (`[ -d bin/… ]`), not `[ "$(uname)" = Darwin ]`,
so a Linux box that has pulled the pre-signed bundles packages them; `prepack`'s
sha gate is sha-tool-portable (`shasum` or `sha256sum`). The sign host needs a
Developer ID identity in `rush-signing.keychain-db`, the `kcpass` + `secrets.pass`
files under `~/Library/Application Support/rush/`, the `apple.com` secrets bundle,
and `bin/embedded.provisionprofile` (for the notarized keychain helper). Override
the checkout with `SIGN_HOST_REPO` (`$HOME` resolves on the remote side).

**Why not CI?** The tarball bundles `dist/lib/secrets/Agents CLI.app` — a native
keychain helper compiled with `swiftc`, codesigned (Developer ID), and notarized
(`xcrun notarytool`). `prepack` ([`scripts/verify-keychain-helper.sh`](scripts/verify-keychain-helper.sh))
refuses to pack unless that signed binary matches the sha pinned in
`scripts/Agents CLI.app.sha256`. CI runners are Linux and cannot produce it. Rebuild
the helper only when `src/lib/secrets/keychain-helper.swift` changes.

**Menu-bar helper** ([`menubar/`](menubar) → `bin/MenubarHelper.app`) ships the same
way — built into `bin/`, copied to `dist/lib/menubar/` by `build`, gated in `prepack`
by [`scripts/verify-menubar-helper.sh`](scripts/verify-menubar-helper.sh) (presence +
`codesign --verify`). No notarization (a status item has no Keychain ACL / TCC
grant). Keep it a **separate bundle** from the keychain app — a menu-bar crash must
never take down the secret broker. Stage a freshly-built `bin/MenubarHelper.app`
before any release or the menu bar ships code-only (the 1.20.22 bug the gate prevents).

**Standalone `agents` binary (#315).** Every release also builds `dist/bin/agents`
(`bun build --compile`, arm64 Mach-O), signs it (Developer ID + hardened runtime +
the JIT entitlement in `scripts/bun-jit-entitlements.plist` — bun's JavaScriptCore
needs MAP_JIT or the binary dies on startup), and notarizes it via
[`scripts/sign-cli-binary.sh`](scripts/sign-cli-binary.sh); on macOS `postinstall`
points the alias shims and the `~/.local/bin/agents`/`ag` links at it, with a
run-probe fallback to the JS entrypoint (mitigation 1 of #315 — the unsigned
node-shebang shim is what EDR flags). Unlike the `.app` helpers it embeds the
release version, so it is rebuilt **every** release: locally on macOS (`release.sh`
injects Apple creds via the `apple.com` bundle) or on the sign host for
Linux-driven releases. `prepack` gates it with
[`scripts/verify-cli-binary.sh`](scripts/verify-cli-binary.sh): sha pin at
`scripts/agents-cli-bin.sha256` (gitignored — a per-release artifact paired to the
sign run, unlike the helper's committed pin), an embedded-version check so a stale
binary can't ship, and `codesign --verify` + Developer ID authority where codesign
exists. Bare Mach-Os can't be stapled; Gatekeeper/EDR fetch the ticket online.

**The `@swarmify/agents-cli` shim is frozen at 1.19.x — do NOT "catch it up."** It's a
legacy re-export not published since v1.20.0; `release.sh` publishes only `@phnx-labs`.
Bumping it would un-deprecate a retired package.

## Conventions

- Real services only — no mocking. Tests exercise the actual critical path.
- `agents repo push` / `pull` operates on `~/.agents/` only. System updates ride
  `npm update -g @phnx-labs/agents-cli`.
- No sensitive data in any DotAgents repo — use `agents secrets` (Keychain-backed).

## Detailed design

[`../../docs/`](../../docs/README.md) is source-grounded reference. Start with
[`00-concepts.md`](../../docs/00-concepts.md) for the full mental model.
