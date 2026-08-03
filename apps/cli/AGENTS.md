# agents-cli (the CLI)

`@phnx-labs/agents-cli` — the `agents` / `ag` CLI for managing AI coding-agent
versions, config, sessions, and cloud dispatch (Claude, Codex, Cursor,
OpenCode, OpenClaw, Grok, Droid, …).

> **New agent? Read [`docs/AGENT-CHEATSHEET.md`](docs/AGENT-CHEATSHEET.md) first.**
> It covers the dozen concepts agents repeatedly need (DotAgents repos, version
> homes, the two "session" meanings, capability gating, the execution path) in
> one scannable page. Come back to this file for the full architecture map.

This is the **internal architecture** map. The user-facing feature tour is
[README.md](README.md) (pin versions, run, sessions, hosts, teams, workflows,
plugins, browser, secrets, routines, pty). This file covers the design choices,
module map, build, and release mechanics the README does not.

> Phoenix Labs OSS · Apache-2.0. Repo-wide policy (conventions, code review, security)
> lives in the root [AGENTS.md](../../AGENTS.md).

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

`CLAUDE.md` and legacy `GEMINI.md` are symlinks. **Edit `AGENTS.md` only** —
editing a symlink target directly gets stomped on the next sync. The sync writes
the right file name per supported agent (`OPENCODE.md`, `.cursorrules`, etc.).

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

### 7. Self-updating agents are ONE binary, not fictional version-homes

Some harnesses (droid, grok, antigravity, cursor, hermes, kiro, goose) install
via an official `curl … | sh` / `brew install` script that carries no version token —
the installer only ever fetches the *current* release and the binary self-updates in
place. `isSelfUpdatingAgent()` ([`src/lib/agents.ts`](src/lib/agents.ts)) is the single
predicate for "no pinnable semver"; route every such decision through it, never a
scattered `=== 'droid'`. Its narrower cousin `isGlobalBinaryAgent()`
([`src/lib/versions.ts`](src/lib/versions.ts)) — computed by probing whether
`getBinaryPath` ignores the version arg — is true only when the agent resolves to ONE
global binary (droid). For those, `listInstalledVersions` collapses the phantom
per-version dirs to a single canonical entry, `reconcileStaleLatestForAgent` folds the
stale dirs into the survivor, `agents view` shows the live `--version`, and
`agents add droid@1.2.3` gracefully installs the current release instead of erroring.
grok is self-updating but stores a real per-version binary under each version-home, so
it is NOT a global-binary agent and is left uncollapsed. (RUSH-1321)

### 8. Diagnostic command taxonomy — `doctor` is the umbrella (RUSH-2027)

Three diagnostics, distinct scopes. Don't blur them — each answers a different
question, and a new health check goes in the one whose scope it matches.

| Command | Scope | Answers |
|---|---|---|
| `agents fleet status` | Coarse **device** health across the fleet | Are devices online, do they have the agent CLIs installed, are they signed in, what is the agents-cli **version skew**. NOT fine-grained resource divergence. |
| `agents inspect <agent>[@version]` | Deep **single-harness** diagnosis | Per-resource diff between one version home and its resolved sources; manifest staleness; orphans. One harness, one machine. |
| `agents doctor` | **Umbrella** — overall fleet + harness health | Local diagnostics (CLI presence, per-version sign-in, per-version sync, orphans) **and** cross-device divergence, rendered as the prioritized critical-at-top + per-computer hybrid below. The single command a user runs to discover problems before runtime. |

**`agents doctor` is a prioritized, comprehensive-by-default hybrid (RUSH-2069).**
There is no `--verbose`. A top `✗ CRITICAL — needs you now (N)` section lists every
critical across the whole fleet worst-first; a `─── by computer ───` section then
gives each device its warnings plus a compact accounts/versions line (every
installed version + its account, provable ✓ / ✗). Single-machine `agents doctor`
collapses to the CRITICAL section plus one `▸ <machine>` block. Severity:
**critical** is `logged-out` (provable), `missing-hook`, `missing-plugin`,
`unwired-hook`, `never-synced` *when the version's declared resources are
therefore absent*, `duplicate-hook-drift`, and `cli-missing`; **warning** is
`logout-unprovable`, `missing-resource`, `content-drift`, `stale`, `never-synced`
when the version declares nothing to miss, `repo-behind`, `repo-drift`,
`version-skew`, `fleet-resource-gap`, `orphan`, `duplicate-hook`,
`host-cli-missing`, `host-cli-invalid`, `rc-secret-export`, `exec-policy` and
`stale-cli`. The same list is in the `doctor-findings.ts` module docblock — keep
both exhaustive, since a kind missing from either is a doc that lies. The findings model,
builders, `remediationFor`, and the pure `renderFindings` live in
[`src/lib/devices/doctor-findings.ts`](src/lib/devices/doctor-findings.ts).

**One root cause is one line.** A readout the user cannot scan is as useless as no
readout, so the builders de-duplicate before rendering — on a real machine this
takes ~57 rows down to ~16, and the rules are unit-pinned in
`doctor-findings.test.ts`:

- **Per version, per kind, one row.** `emitGroup` names a lone resource in full
  (`hook 'git-guard' missing`) and otherwise emits a count plus two examples
  (`32 hooks missing (incl. 'a', 'b')`). Never one row per resource.
- **Per agent, one row across versions.** `collapseAcrossVersions` folds findings
  with the same `(device, agent, kind, severity, account, message)` into a single
  row carrying `versions`, rendered `claude (5 versions)`, and widens the
  remediation to the agent-wide sweep. Three exclusions, each because the widened
  remediation would be wrong: **isolated copies** (`runFix` skips them, so the
  sweep would leave one broken — the caller passes `isolatedVersions` from
  `isVersionIsolated`); **findings with no agent** (their `version` is a repo
  alias); and **logouts** (`NEVER_COLLAPSED`) — a login is inherently per-version,
  there is no `@all` for it, and dropping the version falls back to the bare
  native hint, which the shim points at the *default* version.
- **Orphans are one line per machine.** They are cleanup-only and
  `agents prune cleanup --all` fixes every version at once — **`--all` is load
  bearing**: without it cleanup sweeps only each agent's default version
  (`commands/prune.ts:351`).
- **Duplicate version-home hooks are one line per (agent, severity).**
  `agents sync <agent>@all --yes` reconciles every copy at once, and a
  machine with five installed claudes otherwise emits two dozen identical rows.
- **No vaguer restatement.** A version that just listed its drifted/missing
  resources gets no `sources changed since last sync` row on top, and a
  never-synced version reports one critical (`agents sync <agent>@<version>
  --yes`) instead of one per absent resource.

**Every check the old overview printed is a finding now.** `renderOverviewText`
was the ONLY text renderer for several independent checks, so deleting it dropped
each of them from the command — the top defect this redesign had to answer for, and
it recurred three times during review. They all enter `buildLocalFindings` as
plain **inputs** (never probes, so the module stays pure and every branch is
testable without a shell, PowerShell, or an installed CLI):

| Check | Input | Finding kind |
|---|---|---|
| Credential-shaped shell-rc exports (RUSH-1968) | `rcSecrets` | `rc-secret-export` |
| Windows exec policy blocking `agents.ps1` | `execPolicy` | `exec-policy` |
| Hooks duplicated across version homes | `duplicateHooks` | `duplicate-hook{,-drift}` |
| Declared host CLIs not on PATH | `hostClis.statuses` | `host-cli-missing` |
| Host-CLI manifests the loader rejected | `hostClis.errors` | `host-cli-invalid` |

**Before deleting any renderer here, enumerate what it called.**

**A remediation must fix EVERY version in its row, and must be a command that
exists.** Three separate rounds of review here found remediations naming a command
form that does not do what the row claims — `agents sync <agent>` (default version
only), `agents repo pull` (skips the system repo), `agents prune cleanup` (default
versions only), `agents cli install <a> <b>` (takes one name), and
`agents run <agent>@<v>, then <cli> login` (the second command resolves through the
shim to the *default* version, not the one that is logged out — use
`agents run <agent>@<v> -- login`, since `--` forwards verbatim into that version
home). **Open the command definition and check arity, flags, and scope before
writing a remediation string.** `agents sync <agent>` targets
only the default/sole installed version (`commands/sync.ts:8`), so a row collapsed
across versions uses the `@all` selector — `agents sync <agent>@all --yes`. A fleet
resource gap is absent from that box's *central repos*, so the central-to-home
`agents doctor --fix` cannot close it — and neither `agents repo pull` nor the sync
umbrella touches the **system** repo (`commands/repo.ts:1186`,
`lib/sync-umbrella.ts:104`), which moves with the npm package instead, so that row
names both paths rather than one command that quietly covers half the cases. A
`repo-drift` row carries the repo alias (`user` / `system`) rather than hardcoding
one.

**Sign-in is per installed VERSION, and a logged-out claim must be provable.**
[`credentialPresence(agent, versionHome)`](src/lib/agents.ts) splits a credential's
existence into the per-version home and the active/global HOME; a logged-out
critical is emitted only when BOTH are absent (`provable = !perVersion && !active`).
A version sharing the global login is signed in, not out; an agent with no
inspectable identity (`!supportsAccountInspection`) never yields a logout finding,
not even the hedged warning. **Do not enumerate that set here or in tests** —
`ACCOUNT_INSPECTION_AGENT_IDS` and `CREDENTIAL_FILE_SEGMENTS`
([`src/lib/agents.ts`](src/lib/agents.ts)) are the source of truth and agents move
between them (antigravity and cursor both did, mid-review, each time turning a
hardcoded list into a false doc claim or a red test). Derive it:
`ALL_AGENT_IDS.filter(supportsAccountInspection)`. Login remediation is version-targeted via
`agents run <agent>@<version>` + the harness-native login (`loginHint`) — but ONLY
for the per-version-isolated set (claude/codex/grok/kimi/opencode/copilot);
gemini/antigravity/droid/cursor share their login, so the fix says so instead of
faking a per-version repair. Per-version sign-in rides the device inventory
(`FleetInventory.signIn`, populated by `collectLocalFleetSignIn` in
[`src/lib/devices/fleet-inventory.ts`](src/lib/devices/fleet-inventory.ts)); an
older remote CLI that omits it degrades to an "older agents-cli — upgrade" warning.

**Cross-device divergence lives in `agents doctor --devices`.** It compares each
device's self-reported harness inventory against the local baseline and flags a
resource / agent-version / config-repo present on one box but missing on another
(e.g. the `swarm` plugin on `zion` but not `yosemite-s0`). The data path:

- Every device's **top-level `agents doctor --json`** emits a `fleet` inventory
  field ([`src/lib/devices/fleet-inventory.ts`](src/lib/devices/fleet-inventory.ts) →
  `collectLocalFleetInventory`): installed resource names per kind, installed
  version ids per agent, and `.agents`/`.system` repo state (`readRepoState` in
  [`src/lib/git.ts`](src/lib/git.ts)).
- `runDevicesDoctor` ([`src/commands/doctor.ts`](src/commands/doctor.ts)) fans that
  payload out per device and runs the **pure comparator**
  [`compareFleetInventories`](src/lib/devices/fleet-divergence.ts) — SSH-free, so
  it's unit-tested against fixtures with no live fleet — then maps the divergences
  and each box's per-version sign-in into the hybrid via `fleetDivergenceToFindings`
  / `signInToFindings` / `renderFindings`
  ([`src/lib/devices/doctor-findings.ts`](src/lib/devices/doctor-findings.ts)).
- `agents fleet status` reuses the same comparator inside `buildFleetHealthReport`
  ([`src/lib/devices/health-report.ts`](src/lib/devices/health-report.ts)) to add a
  per-device `divergence` warning to its rollup.

Read-only by default — divergence detection never installs or syncs. `--json`
carries a stable `fleet` divergence block for the VS Code extension / Agency.

## Supported harnesses

The supported harnesses are the entries in the `AGENTS` registry
([`src/lib/agents.ts`](src/lib/agents.ts)) — the canonical list, gated through
`supports()`; the full id union is `AgentId` ([`src/lib/types.ts`](src/lib/types.ts)).
The table below is a snapshot of their per-harness capabilities — keep it in sync
with the registry. **Prioritized (first-class):** Claude Code, Codex CLI, Kimi CLI,
Antigravity CLI, Grok CLI, OpenCode — features target these six first.

| Harness | `id` | hooks | mcp | allowlist | skills | commands | plugins | subagents | workflows |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| ★ Claude Code | `claude` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ★ Codex CLI | `codex` | ≥0.116 | ✓ | — | ✓ | <0.117 | ≥0.128 | ≥0.117 | — |
| ★ Kimi CLI | `kimi` | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| ★ Antigravity CLI | `antigravity` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ≥1.0.16 | ≥1.0.6 |
| ★ Grok CLI | `grok` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ≥0.2.111 |
| ★ OpenCode | `opencode` | ≥0.3.130 | ✓ | ≥1.1.1 | ✓ | ✓ | ✓ | — | — |
| Cursor | `cursor` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ≥2026.1.22 | — |
| OpenClaw | `openclaw` | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| Copilot | `copilot` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ≥0.0.353 | — |
| Amp | `amp` | — | ✓ | — | ✓ | ✓ | — | — | — |
| Kiro | `kiro` | ≥0.10 | ✓ | ≥2.8 | ✓ | ✓ | — | ≥1.23 | — |
| Goose | `goose` | ≥1.34 | ✓ | ✓ | ≥1.25 | — | ✓ | — | ✓ |
| Droid | `droid` | ✓ | ✓ | ≥0.57.5 | ≥0.26 | ✓ | ✓ | ✓ | — |
| Hermes | `hermes` | ≥0.11 | ✓ | — | ✓ | — | — | — | — |

✓ = supported · — = not · version cell = only within that range (out-of-range =
skipped silently). [`src/lib/agents.ts`](src/lib/agents.ts) is canonical — keep this
snapshot in sync. `workflows` is `claude`/`kimi`/`goose`/`antigravity` (≥1.0.6, written to the
shared HOME-global `~/.gemini/config/global_workflows/`, not a per-version home), `openclaw` (Lobster `.lobster` files under `.openclaw/workflows/`), and `grok` (≥0.2.111, native Rhai under `.grok/workflows/`); `mcp` is universal; `allowlist` is
`claude`/`cursor`/`opencode`/`antigravity`/`grok`/`kimi`/`kiro`/`droid`/`goose`/`openclaw`/`copilot` (Copilot writes per-location approvals to `~/.copilot/permissions-config.json`; OpenClaw is tool-level only —
blanket rules map to `~/.openclaw/openclaw.json` `tools.alsoAllow`/`tools.deny`, sub-command patterns skipped); `subagents` is `claude`/`codex`/`kiro`/`kimi`/`grok`/`openclaw`/`droid`/`copilot`/`antigravity`/`cursor` (≥2026.1.22).
**Gemini is hard-deprecated.** Keep the legacy `gemini` id only for parsing old
sessions/config; `agents add gemini`, `agents import gemini`, and
`agents sync gemini` fail and point users to Antigravity.

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
    subagents-registry.ts  # SUBAGENT_TARGETS — declarative per-agent subagent shape (dir/layout/transform); generic install/list/remove engine
    versions.ts        # Install, remove, syncResourcesToVersion
    shims.ts           # Shim generation, config symlink switching
    hooks.ts           # hooks.yaml parser + per-agent registrar
    hooks/match.ts     # `matches:` predicate evaluator
    monitors/          # `agents monitors` — event-triggered watchers (source→condition→action); native state-diff store; MonitorEngine runs in the daemon beside the cron scheduler. See docs/10-monitors.md
    projects.ts        # `agents projects` — named multi-repo project defs (~/.agents/projects/*.yaml) layered above the --project convention (resolveProjectRef in project-root.ts); project-status.ts rolls live sessions + merged PRs + artifacts into the progress card. Beta-gated. See docs/11-projects.md
    migrate.ts         # One-shot idempotent migrations
    session/           # `agents sessions` READER — discovery/parse/render of agent transcripts; also `migrate-targets.ts` (the `sessions migrate` target scorer)
    terminal/          # Terminal launch engine — tab/split in iTerm/Ghostty/tmux/Terminal.app, local or --host;
                       #   preferred.ts resolves WHICH terminal for a GUI caller (from live sessions' host app)
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
| computer-mac | [`../../native/computer-mac`](../../native/computer-mac) | No — signed + notarized GitHub **release asset**, downloaded on demand | `src/lib/computer-rpc.ts`, `src/lib/computer/download.ts` |
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

**Self-routing, zero-config.** Run it from ANY fleet box with an empty
environment — no variables to set, no Touch ID, no hand-moved credentials. Run
from a clean, in-sync `main`:

```bash
scripts/release.sh <version>          # dry-run: bump, type-check, tarball preview, detected state
scripts/release.sh <version> --apply  # tests on a crabbox -> PR + CI -> merge + tag -> build/sign/publish on the home base
```

The release has **three self-selected homes** and prints a `[n/6]` phase tracker,
each phase labeled with the box it runs on and a ✓/✗ result:

| Work | Runs on | How it's chosen |
|---|---|---|
| Orchestrate: bump, changelog, PR, tag | the box you invoked it on | it's already there (git + gh only) |
| CI / tests (Linux) | a **crabbox** (Hetzner Linux VM) | [`scripts/sandbox.sh`](scripts/sandbox.sh) selects an available box for this repo's `.crabbox.yaml` profile or warms a fresh one — **dynamic, never a hardcoded instance** |
| Build, sign+notarize, npm publish, computer-helper | the **home base** | one hardcoded constant `RELEASE_HOME_BASE="mac-mini"` in `release.sh`; the script detects if it's already there (`scutil --get LocalHostName` / `hostname -s`), else reaches it over `ssh` |

`mac-mini` is the only hardcoded machine name (it holds the Developer ID cert +
npm publish rights). The crabbox is **not** hardcoded.

**One releaser at a time — the lease.** Because the script runs from any box, two
agents on two machines could enter it at once; they then clobber the same release
branch, tag, and publish, and the collision only surfaces at the publish gate
(`merged tree != built tree`) once one of them has already merged and tagged.
[`scripts/release-lease.sh`](scripts/release-lease.sh) holds exclusivity on
`origin` — the only thing every box can agree on — by pushing an **orphan commit**
to `refs/release-lock/held`. A second claimant's push can never be a fast-forward
of the first's, so git's rejection *is* the failed lock acquisition: no polling, no
second service.

```bash
scripts/release-lease.sh status     # unheld | held version=… holder=… age=…min
scripts/release-lease.sh claim <v>  # 0 = acquired, 1 = someone else is releasing
scripts/release-lease.sh renew      # prove this run is still alive
scripts/release-lease.sh verify     # 0 = still ours; fails CLOSED on any doubt
scripts/release-lease.sh release    # drop the lease this checkout claimed
```

`release.sh` claims it right after the confirmation (before the first mutation)
and drops it from `cleanup_all`'s trap on every exit path. Ownership is the lease
**commit sha**, recorded in `.git/release-lease.token` — not the pid, so a release
resumed by a second invocation can still drop its own lease, and a third agent can
never drop one it did not claim.

**The TTL is not "how long a release takes".** It is "how long since the holder
last proved it was alive" — a distinction that matters because a healthy release
routinely outlives any sane TTL: the CI matrix alone has run **57 minutes**, and
release 1.20.77 took **186 minutes** wall clock. So two things hold the invariant
together:

- **Renewal.** `release.sh` runs a background renewer for the whole release
  (`renew` every 10 minutes), so a live run's lease is never older than 10 minutes
  and cannot be reclaimed out from under it. The renewer is killed before the
  lease is dropped, so it can never re-push a lease that is being deleted.
- **`verify` before every irreversible step.** `require_lease` gates the
  squash-merge, the tag, and the publish routing. It fails **closed** — no token,
  no ref, unreachable origin all mean "we cannot prove this is ours", so the
  release stops rather than merging alongside whoever holds it now.

A lease abandoned by a killed run stops being renewed, so it becomes reclaimable
after `RELEASE_LEASE_TTL` minutes (default 30); reclaiming names the dead holder
rather than silently overwriting it.

**Finish a stuck release before cutting a new one.** `release.sh` refuses to start
when an older `v*` tag exists that npm never received, and prints the re-run that
finishes it. Without this, a release that died between tag and publish left the
next run validating its bump against a registry that was behind, so it cut the
*next* version and the gap widened by one every time — that is how npm sat at
1.20.78 while `main` carried 1.20.81.

**The privileged phase runs on the home base, always — from the TAGGED script.**
After the invoking box merges + tags (git + gh, which need that box's auth),
`release.sh` routes build + sign + notarize + `npm publish` + computer-helper to
`mac-mini`. Whether inline (you invoked it there) or over ssh, it first checks out
`v<version>` into a throwaway worktree under `.agents/worktrees/`, then runs **that
worktree's** `apps/cli/scripts/release.sh <version> --home-base-phase` — so the
script that publishes is the one carried by the release tag (with
`--home-base-phase` + `headless-sign-context.sh`), never the home base's possibly-
stale on-disk checkout. The worktree is removed on exit whether the phase succeeds
or fails. `--home-base-phase` runs inside that worktree: it verifies the checked-
out version == `<version>`, enters the headless context
([`scripts/headless-sign-context.sh`](scripts/headless-sign-context.sh) — unlocks
`rush-signing.keychain-db` + exports `AGENTS_SECRETS_PASSPHRASE` from the on-disk
pass files, so codesign/notarytool and every `agents secrets exec` run with **no
Touch ID**), builds + signs the artifacts, resolves the **npm token on the home
base** (never borrowed to the trigger box), publishes, and pushes the computer-
helper release asset. `bun run build` copies the signed helpers into `dist/` on a
presence gate (`[ -d bin/… ]`); `prepack`'s sha gate is sha-tool-portable.

**Tests: crabbox for Linux, GH Actions for the rest.** The `--apply` flow runs the
full suite on a crabbox before opening the PR; a failure prints the failing tests +
the captured log path and **halts before any PR/publish**. That covers the Linux
suite; the GH Actions CI matrix on the release PR still gates the cross-platform
(macOS/Windows) legs (`wait_for_ci_green` blocks on them, fail-closed). `--skip-tests`
skips only the crabbox lease.

**Idempotent re-runs.** The script's git-scope reads use `<ref>:apps/cli/package.json`
(not root) since the package moved under `apps/cli`. If a publish fails after the PR
merges, rerun the same command: registry-truth short-circuits skip an
already-published version, tag creation is idempotent against the verified release
commit, and the catch-up guards (CI-tested-head match + merged-tree match + version
match) refuse an unverified publish so later commits on `main` cannot leak into the
already-versioned package.

**`scripts/remote-sign-mac.sh` is no longer on the release path.** The privileged
phase builds signed artifacts directly on the home base. The script remains only
for the narrow case of building + pulling back JUST the signed macOS artifacts from
another Mac (no publish); it too is zero-config, targeting the same hardcoded
`RELEASE_HOME_BASE` with no env knobs or fleet discovery.

**Provisioning the `apple.com` bundle on a headless sign host.** A Linux-driven
release offloads macOS signing to a sign host over SSH, which needs the `apple.com`
secrets bundle *on that host*. Push it with the **file backend** —
`agents secrets export apple.com --host <signer> --remote-backend file` (needs
`AGENTS_SECRETS_PASSPHRASE` set locally) — **not** the default keychain backend: a
macOS login keychain is locked under headless SSH, so a keychain-backed push lands
the bundle metadata but no readable secret items (`secrets export --host` now
read-back-verifies a keychain push and fails loudly if it didn't persist, pointing
at this fix). `--device` is accepted as an alias for `--host` on the secrets remote
commands. See [`docs/secrets.md`](docs/secrets.md) → *Pushing to a headless sign host*.

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

**Exactly one status item is an invariant, enforced in the helper.** The bundle
can be started from more than one place — launchd's `KeepAlive` service, a
LaunchServices/`open` launch, a second `agents menubar enable` — so the helper
takes an `flock` on `~/.agents/.cache/state/menubar.lock` at launch
([`SingleInstance.swift`](menubar/Sources/MenubarHelper/SingleInstance.swift)) and
holds the descriptor for its lifetime; a loser surfaces the incumbent's menu and
exits 0. Do NOT re-derive liveness from a pid file or a `ps` scan — the kernel
releases an `flock` however the holder dies, which a pid cannot express, and a
process list cannot say which copy launchd will keep alive. On the CLI side,
`classifyMenubarProcesses` returns live copies of the installed bundle as a LIST
(`own`), never a boolean: collapsing them is what let a duplicate icon read as a
healthy `running: yes`. `agents menubar setup` is the recovery path — it ends
every live helper and re-kickstarts the service so the survivor is always
launchd's.

**Standalone `agents` binary (#315).** Every release also builds `dist/bin/agents`
(`bun build --compile`, arm64 Mach-O), signs it (Developer ID + hardened runtime +
the JIT entitlement in `scripts/bun-jit-entitlements.plist` — bun's JavaScriptCore
needs MAP_JIT or the binary dies on startup), and notarizes it via
[`scripts/sign-cli-binary.sh`](scripts/sign-cli-binary.sh); on macOS `postinstall`
points the alias shims and the `~/.local/bin/agents`/`ag` links at it, with a
run-probe fallback to the JS entrypoint (mitigation 1 of #315 — the unsigned
node-shebang shim is what EDR flags). Unlike the `.app` helpers it embeds the
release version, so it is rebuilt **every** release on the home base (`release.sh`
injects Apple creds via the `apple.com` bundle in the headless context). `prepack`
gates it with
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

## Contracts (source-of-truth spec — read before touching sessions/secrets)

The major subsystems carry a **normative contract** in
[`docs/specifications.md`](docs/specifications.md) — what a human, an agent, or a
downstream tool may rely on, written because features have regressed by quietly
deviating from an unwritten contract. When code and the spec disagree, one is a
bug; fix the drift. It uses RFC-2119 MUST/SHOULD language, cites the implementing
`file:line`, and carries Given/When/Then scenarios that map to tests. Sections:

- **[`docs/specifications.md` §Sessions](docs/specifications.md#sessions)** — the `agents sessions`
  contract. Load-bearing invariants: discovery MUST parse **every** harness in
  `SESSION_AGENTS` (all 12) and a malformed line MUST be skipped, never thrown
  (SES-1, SES-3); every list row MUST show a **non-empty preview** — live turn →
  `label` → first-prompt `topic` → `'-'` (SES-8; `--flat` and the interactive
  picker share the one unguarded renderer, SES-GAP-1); "where a session started"
  spans three fields (`cwd` + `provenance` + `context`), not one `origin`
  (SES-13); the `--json` shapes and `SessionEvent` union are a stability contract
  (SES-IF-1, SES-IF-4); tool-call evidence is always redacted/bounded, repeated
  clauses match distinct calls, and its versioned envelope does not replace the
  list/detail JSON contracts (SES-31..SES-34, SES-IF-4a); R2 sync is a CRDT G-Set union, zero-knowledge whenever an
  encryption key is configured (SES-24, SES-25).
- **[`docs/specifications.md` §Secrets](docs/specifications.md#secrets)** — the `agents secrets`
  contract. Load-bearing invariants: **inject into the child, never materialize
  to the agent** — every command is on one side of the boundary by construction
  (SEC-6, SEC-7); the master passphrase MUST be stripped from the child env
  (SEC-8); the "no-noise" rules — silent value-free `list`, batched single-prompt
  reads, silent broker miss, no `console.*` in the lib layer, no shell-rc
  pollution (SEC-11..SEC-17); all three desktop platforms are supported and the
  parity matrix names where guarantees are weaker (SEC-CROSS-1, SEC-CROSS-3).

Requirement ids are section-namespaced — `SES-*` / `SEC-*` / `EXEC-*`, with the
`-IF-` (interface), `-CROSS-` (platform parity), `-COMPAT-` (stability) and
`-GAP-` (known gap) families — and a requirement the code does not yet fully meet
carries a trailing `Status: [Intended]` or `[Drift]` line naming its `-GAP-`.

Both specs also enumerate **known gaps** (implemented-vs-intended drift) — a new
feature MUST NOT widen them and SHOULD close the one it touches.

## Detailed design

[`docs/`](docs/README.md) is the source-grounded reference. Start with
[`architecture.md`](docs/architecture.md) for the CLI/extension layering and the
session mechanisms, then [`00-concepts.md`](docs/00-concepts.md) for the resource
model. The normative contract
([`specifications.md`](docs/specifications.md)) sits
alongside the reference docs ([05-sessions.md](docs/05-sessions.md),
[secrets.md](docs/secrets.md)) — read the spec for the guarantee, the reference
for the how-to.
