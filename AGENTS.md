# agents-cli

CLI for managing AI coding agent versions, config, sessions, and cloud dispatch (Claude, Codex, Gemini, Cursor, OpenCode, OpenClaw, Grok Build, Droid).

> Phoenix Labs OSS (MIT). **NOT part of the Rush brand** — see [§Brand identity](#brand-identity) before touching assets, demos, or website.

## Core design choices (read this first)

Break these and downstream code drifts silently.

### 1. Three DotAgents repos, resolution is project > user > system

Resources AND `agents.yaml` resolve in that order. Same-name overrides, everything else unions.

| Path | Role | Edited by |
|---|---|---|
| `<repo>/.agents/` | **Project repo** — project-pinned commands / skills / hooks / rules. | Project maintainers |
| `~/.agents/` | **User repo** — user resources + ALL operational state (versions, shims, sessions, `agents.yaml`, browser). | You / CLI |
| `~/.agents/.system/` | **System repo** — npm-shipped defaults ONLY. | Maintainers (`gh:phnx-labs/.agents-system`) |

Extra repos register via `agents repo add <source>` → clone into `~/.agents-<alias>/` and participate after the user repo.

### 2. `AGENTS.md` is the canonical memory file

`CLAUDE.md`, `GEMINI.md` are symlinks (`ls -la *.md` confirms). **Edit `AGENTS.md` only** — editing the symlink targets directly will be stomped on the next sync. The sync writes the right file name per agent (`OPENCODE.md`, `.cursorrules`, etc.) — see [§Supported harnesses](#supported-harnesses).

### 3. Capability table gates per-agent writes

`supports(agent, cap, version?)` in [`src/lib/capabilities.ts`](src/lib/capabilities.ts) is the only place that decides whether an agent+version can receive a resource. Out-of-range versions are **skipped silently** — do not add per-call agent checks elsewhere; route through `supports()`.

### 4. No fallback logic for legacy layouts

[`src/lib/migrate.ts`](src/lib/migrate.ts) folds legacy paths ONCE at install time (`runMigration()` writes a `.migrated` sentinel). Downstream code assumes the post-fold layout. "Just-in-case" branches re-introduce drift bugs; the migrator is the single source of truth for legacy handling.

### 5. Hooks live in a single layered `hooks.yaml`

System (`~/.agents/.system/hooks.yaml`) + user (`~/.agents/hooks.yaml`) merged, user wins on same name. Per-entry `matches:` predicates (`prompt_contains`, `prompt_matches`, `tool_name`, `tool_args_match`, `cwd_includes`, `project_has`, `git_dirty`) AND together at fire time. Per-entry `enabled: false` disables a system-shipped hook from the user side.

The `agents:` field in `ManifestHook` is `@deprecated` ([`src/lib/types.ts:176-177`](src/lib/types.ts)) — capability table decides which agents register a hook. Promptcuts are hook data (`hooks/promptcuts.yaml`), not a top-level resource.

### 6. Multi-agent work → `agents teams`

DAG-style, boundary contracts, `--watch` supervisor, `--worktree` isolation, optional `--cloud` dispatch. The old `mcp__Swarm__*` surface was folded into teams (`migrateLegacySwarmToTeams()` in `src/lib/migrate.ts`). Don't reach for Swarm — it's gone.

---

## Directory layout

**System repo (`~/.agents/.system/`)** — npm-shipped, fully tracked. Layout: `commands/  hooks/  hooks.yaml  mcp/  permissions/  profiles/  rules/  skills/`. Clone `gh:phnx-labs/.agents-system` to inspect what ships. Nothing else belongs here.

**User repo (`~/.agents/`):**

- **Resources** (git-tracked, top-level): `commands/`, `skills/`, `hooks/`, `rules/`, `mcp/`, `permissions/`, `profiles/`, `subagents/`, `plugins/`, `workflows/`, `routines/`, `cli/`, `agents.yaml`
- **Durable runtime** (`~/.agents/.history/`): `versions/`, `sessions/`, `runs/`, `trash/`, `backups/`, `teams/agents/`
- **Regenerable runtime** (`~/.agents/.cache/`): `shims/`, `bin/`, `packages/`, `cloud/`, `drive/`, `logs/`, `helpers/`, `state/`, `companion/`, `.migrated`
- **Browser:** `browser/profiles/` (configs) + `~/.agents/.cache/browser/<profile>/` (chrome-data, pids)

**Plugins (`~/.agents/plugins/`) are user-authored, NOT regenerable.** Each plugin = a directory with `.claude-plugin/plugin.json`, optionally `skills/`, `commands/`, `hooks/`, `subagents/`, `.mcp.json`. The CLI never moves `plugins/` into `.cache/`. Treat exactly like `skills/`.

**No `secrets/` directory anywhere** — bundle metadata lives in macOS Keychain.

**CLI binaries (`~/.agents/cli/<name>.yaml`)** declare host-level tools (e.g. `gh`, `higgsfield`). `install:` methods tried in order (`npm` / `brew` / `script` / `binary`). Unlike skills/commands/hooks, CLI manifests are NOT copied into per-agent version homes — they install to host PATH. Manage via `agents cli list|install|check|view|add`. `agents repo refresh` reports missing entries and prompts to install.

See [`docs/00-concepts.md`](docs/00-concepts.md) for the full mental model and resolution semantics.

## Supported harnesses

14 harnesses ship support today. The full id list is `AgentId` ([`src/lib/types.ts:10`](src/lib/types.ts)); per-harness config + capabilities live in the `AGENTS` registry ([`src/lib/agents.ts:215-550`](src/lib/agents.ts)) and are gated through `supports()` ([`src/lib/capabilities.ts`](src/lib/capabilities.ts)).

### Prioritized (first-class) harnesses

These six are the support-priority set — new features and parity work target them first. When a feature can't reach all 14 at once, it must reach these:

**Claude Code** (`claude`) · **Codex CLI** (`codex`) · **Kimi CLI** (`kimi`) · **Antigravity CLI** (`antigravity`) · **Grok CLI** (`grok`) · **OpenCode** (`opencode`)

### Feature support matrix

Not every harness supports every capability — the registry decides per harness. Snapshot below (★ = prioritized); [`src/lib/agents.ts`](src/lib/agents.ts) is canonical, keep both in sync.

| Harness | `id` | hooks | mcp | allowlist | skills | commands | plugins | subagents | workflows | modes |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| ★ Claude Code | `claude` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | plan·edit·auto·skip |
| ★ Codex CLI | `codex` | ≥0.116 | ✓ | — | ✓ | <0.117 | ≥0.128 | — | — | plan·edit·skip |
| ★ Kimi CLI | `kimi` | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | — | plan·edit·auto·skip |
| ★ Antigravity CLI | `antigravity` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | edit·skip |
| ★ Grok CLI | `grok` | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | — | plan·edit·skip |
| ★ OpenCode | `opencode` | — | ✓ | — | ✓ | ✓ | — | — | — | plan·edit |
| Gemini † | `gemini` | ≥0.26 | ✓ | — | ✓ | ✓ | — | — | — | plan·edit·skip |
| Cursor | `cursor` | — | ✓ | — | ✓ | ✓ | — | — | — | edit·skip |
| OpenClaw | `openclaw` | ✓ | ✓ | — | ✓ | — | ✓ | ✓ | — | plan·edit·skip |
| Copilot | `copilot` | — | ✓ | — | ✓ | ✓ | ✓ | — | — | plan·edit·auto·skip |
| Amp | `amp` | — | ✓ | — | ✓ | ✓ | — | — | — | plan·edit |
| Kiro | `kiro` | — | ✓ | — | ✓ | ✓ | — | — | — | edit |
| Goose | `goose` | — | ✓ | — | — | — | — | — | — | edit |
| Droid | `droid` | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | — | plan·edit·auto·skip |

✓ = supported · — = not supported · version cell = supported only within that range (e.g. `≥0.116` needs version `>= 0.116.0`; `<0.117` only below `0.117.0`). Out-of-range cells are **skipped silently** — `supports()` returns false and the resource is never written.

- `rules` (the memory file) is supported by **all 14** — each writes its own file (see config matrix below). `workflows` is **Claude-only**. `mcp` is universal.
- `allowlist` (granular per-tool permission rules) is limited to `claude`, `antigravity`, `grok`, `kimi`.
- `subagents` is limited to `claude`, `openclaw`, `droid`.
- **† Gemini (`gemini`) is deprecated by Google.** The Gemini CLI was retired for free/Pro/Ultra tiers on June 18, 2026 (announced at Google I/O 2026); **Antigravity CLI (`antigravity`) is the official successor.** agents-cli still manages existing installs but warns on `agents add gemini` / `agents teams add … gemini` (`warnAgentDeprecated` in [`src/lib/agents.ts`](src/lib/agents.ts); marker on the `gemini` registry entry).

### Config matrix

| Agent | Commands dir | Memory file |
|-------|--------------|-------------|
| Claude | `commands/` (md) | `CLAUDE.md` → `AGENTS.md` |
| Codex | `prompts/` (md) | `AGENTS.md` (native) |
| Gemini | `commands/` (toml) | `GEMINI.md` → `AGENTS.md` |
| Cursor | `commands/` (md) | `.cursorrules` |
| OpenCode | `commands/` (md) | `OPENCODE.md` |
| Grok | skills + `.grok/` (hooks, plugins, agents, `config.toml`) | `AGENTS.md` + `~/.grok/memory/` |
| Droid | `commands/` (md) + `.factory/` (`settings.json` hooks, `mcp.json`, `droids/`, `plugins/`) | `AGENTS.md` (native) |

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
    session/           # Discovery, parsing, rendering (Claude / Codex / Gemini / OpenCode)
    cloud/             # Provider registry (Rush / Codex / Factory / Antigravity)
    teams/             # `agents teams` orchestration
    profiles.ts        # Host CLI + endpoint + model bundles
```

## Build, test, dev

```bash
bun install && bun run build && bun test
```

Tests are `*.test.ts` next to source; integration in `tests/`. Every PR to `main` runs the real suite cheaply on Linux — `test` ([`tests.yml`](.github/workflows/tests.yml)) plus `gitleaks` ([`secret-scan.yml`](.github/workflows/secret-scan.yml)); those two are the required checks. The full cross-platform matrix (ubuntu + macOS + Windows × Node 22/24, [`ci.yml`](.github/workflows/ci.yml)) is cost-gated to `release/**` branches and `v*` tags (plus manual dispatch), so it runs before a release, not on every PR.

**Local dev build:** `scripts/install.sh --skip-tests` builds the working tree and installs at `$HOME/.local/agents-cli-dev/`, symlinked into `$HOME/.local/bin/agents`. The npm-installed global is never touched. Version stamps as `0.0.0-dev.<sha>[-dirty]` so `agents --version` disambiguates which build is on PATH.

```bash
scripts/install.sh --skip-tests
# Put $HOME/.local/bin ahead of nvm's bin dir on PATH to use the dev build.
# Revert: drop the PATH entry, or `rm -rf ~/.local/agents-cli-dev`.
```

**Why two prefixes?** Issue #20-class regressions ship to npm and silently break auto-updaters; side-by-side dev installs let you iterate without risking the working install.

**Bin entrypoints need `chmod 755`.** [`scripts/build.sh`](scripts/build.sh) chmods every `package.json#bin` entry after `tsc` emits. Newer npm preserves tarball file mode and does NOT auto-chmod — 644 surfaces as `zsh: permission denied: agents`. Do not skip this step.

## Releasing

**Releases are cut locally on macOS — there is no CI publish.** Run from a clean, in-sync `main`:

```bash
scripts/release.sh <version>          # dry-run: validates bump, type-checks, builds, tests, previews tarball
scripts/release.sh <version> --apply  # commits chore(release), tags v<version>, npm publish, pushes
```

`release.sh` reads the npm token from the `npmjs.com` secrets bundle (`agents secrets`), so no 2FA prompt and no token on disk.

**Why not CI?** The package bundles `dist/lib/secrets/Agents CLI.app` — a native keychain helper that must be compiled with `swiftc`, codesigned with the Developer ID identity, and notarized (`xcrun notarytool`); see [`scripts/build-keychain-helper.sh`](scripts/build-keychain-helper.sh). `prepack` ([`scripts/verify-keychain-helper.sh`](scripts/verify-keychain-helper.sh)) refuses to pack unless that signed binary matches the sha pinned in `scripts/Agents CLI.app.sha256`. CI runners are Linux and cannot produce it, so publishing stays on a macOS machine that holds the signed helper. The keychain helper itself is rebuilt only when [`src/lib/secrets/keychain-helper.swift`](src/lib/secrets/keychain-helper.swift) changes — rerun `scripts/build-keychain-helper.sh` (needs `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`) and update the pinned sha.

**The `@swarmify/agents-cli` shim is intentionally frozen at 1.19.x — do NOT "catch it up."** It is a legacy re-export that has **not been published since v1.20.0**: `release.sh` publishes only `@phnx-labs`, and the shim's "Building… / Tarball preview" lines are vestigial — there is no `npm publish` for it (see [`scripts/release.sh`](scripts/release.sh), the "legacy shim no longer published as of v1.20.0" comment). Bumping `@swarmify` to the current version would un-deprecate a retired package. Leave it at 1.19.1.

**The macOS menu-bar helper** ([`packages/menubar-helper`](packages/menubar-helper) → `bin/MenubarHelper.app`) ships in the tarball the same way as the keychain app — built into `bin/`, copied to `dist/lib/menubar/` by `build`, gated in `prepack` by [`scripts/verify-menubar-helper.sh`](scripts/verify-menubar-helper.sh) (presence + `codesign --verify`). Unlike the keychain helper it needs **no notarization** (a status item has no Keychain ACL / TCC grant). Keep it a **separate bundle** from the keychain app — process isolation matters: a menu-bar UI crash must never take down the secret broker. Stage a freshly-built `bin/MenubarHelper.app` before any release or the menu bar ships code-only (the 1.20.22 bug the prepack gate now prevents).

## Conventions

- `AGENTS.md` is canonical; `CLAUDE.md` / `GEMINI.md` are symlinks. **Edit `AGENTS.md` only.**
- `agents repo push` / `pull` operates on `~/.agents/` only. System updates ride `npm update -g @phnx-labs/agents-cli`.
- Real services only — no mocking. Tests must exercise the actual critical path (see [CLAUDE.md](CLAUDE.md) testing rules).

## Security

**No sensitive data in any DotAgents repo.** All three repos are designed to be safely version-controlled.

- Use `agents secrets` — bundle metadata in macOS Keychain, never on disk.
- Browser profile configs reference bundles by name, not raw credentials.
- Accidentally committed a secret? Rotate immediately — git history persists.

## Detailed design

[`docs/`](docs/README.md) is source-grounded reference. Start with [`00-concepts.md`](docs/00-concepts.md). Index covers core (concepts, version mgmt, sync, sessions, observability), credentials (profiles, secrets), orchestration (teams, cloud, routines), extensibility (plugins, workflows, subagents, hooks), automation (browser, pty, computer).

---

## Brand identity

`agents-cli` is a Phoenix Labs OSS product (MIT). **NOT part of the Rush brand.** Phoenix Horizon, Inc. owns several brands; agents-cli sits in the OSS lane, Rush in the consumer-product lane.

When working on this repo or the sibling `agent-cli-web` landing:

- **No Rush styling** — no gold sheen, cream paper, falcon mark, Cormorant Garamond serif, "Interface for the future" voice. The Rush plugin at `~/.agents/plugins/rush/` is a tool to call, not a brand to import.
- **No `~/Rush/Brand/` writes** for agents-cli renders, screenshots, or videos. Use `~/Phoenix/agents-cli/` or this repo's `assets/` / `demo/out/`.
- **Visual language is terminal-coded** — `#0a0a0a` bg, `#a3e635` lime accent, JetBrains Mono for wordmark + code, Inter for prose. See [`assets/`](assets/), [`demo/src/`](demo/src/), [`website/`](website/).
- **Voice is direct-developer** — verb + artifact, no marketing claims. Closer to a `man` page than a landing pitch.
- **Composer + animator skills (`~/.agents/plugins/rush/skills/`)** can be USED here — but ignore their §Brand voice sections (Rush-only). Override destination to `~/Phoenix/agents-cli/launches/` and use this repo's color/type tokens.

If any agent starts pulling Rush styling, paths, or voice into agents-cli work, stop and reread this block.
