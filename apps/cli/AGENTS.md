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

`agents setup` is the re-runnable onboarding hub. It reports live readiness for
core, browser, computer, secrets, fleet, share, watchdog, and preferences, then
delegates each selected phase to its existing `agents setup <capability>` wizard.
`agents setup status --json` is the non-interactive view of the same probes.

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

[`src/lib/installations/migrate.ts`](src/lib/installations/migrate.ts) folds legacy paths ONCE at install time.
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
(`migrateLegacySwarmToTeams()` in `src/lib/installations/migrate.ts`). Don't reach for Swarm — gone.

### 7. Every agent conversation is a session; execution ledgers link to it

**An agent conversation from a session-capable harness MUST remain a session,
whether launched interactively, headlessly, as a teammate, or by a routine.** A
caller MUST preserve the harness transcript and make it discoverable by `agents
sessions`; it MUST NOT replace or hide that conversation record with its own
execution metadata. This applies to `SESSION_AGENTS`, not a harness such as Warp
that exposes no local transcript. The indexed session row carries the relationship
when the harness and launch path provide one:

| Launch surface | Session relationship | Separate execution state |
|---|---|---|
| `agents run`, including headless and `--device` | Ordinary indexed session for a session-capable harness; when its SessionStart hook records an id, the launch id joins a remotely coined session back to the dispatch. A hookless run remains unmapped rather than receiving a fabricated id. | Dispatch/audit events |
| `agents teams` teammate | Its **own** session id plus `teamOrigin`; `parentSessionId` links the orchestrator when the teammate was spawned inside an identified agent session | Team registry + teammate `meta.json` own DAG/task/process state |
| Agent/workflow routine | The transcript is archived under the run; supported archive readers index it with `origin: routine`, `routineName`, and `routineRunId` | `.history/runs/<routine>/<run>/meta.json` owns the attempt outcome |
| Command-only, `missed`, `blocked`, or `skipped` routine | No session is synthesized because no agent conversation occurred | The routine run record is the complete canonical record |

Source of truth: `buildExecEnv` / `emitResolvedSessionId` in
[`src/lib/exec.ts`](src/lib/exec.ts), `listTeamsActive` in
[`src/lib/session/active.ts`](src/lib/session/active.ts),
`archiveRoutineTranscripts` in [`src/lib/runner.ts`](src/lib/runner.ts), and
`decorateRoutineSession` in [`src/lib/session/discover.ts`](src/lib/session/discover.ts).
Enforced by [`src/lib/session/team-filter.test.ts`](src/lib/session/team-filter.test.ts)
(`--teams includes team sessions with teamOrigin populated`),
[`src/lib/runner.test.ts`](src/lib/runner.test.ts) (routine transcript archival), and
[`src/commands/sessions.test.ts`](src/commands/sessions.test.ts) (routine run history
plus linked sessions, with no fake session for command-only runs).

Team-origin sessions are durable session rows but are excluded from the ordinary
historical listing by default to keep an orchestrator's fan-out from flooding it;
`agents sessions --teams` includes them, while live teammates appear in
`agents sessions --active` with `context: teams`. That is a presentation filter,
never permission to omit the transcript from the session index.

**Current routine-archive gap:** `readRoutineArchiveMeta` indexes Claude, Codex,
and Cursor routine archives. Kimi's `state.json` + `wire.jsonl` are archived by
`archiveRoutineTranscripts` but do not yet have a routine-archive reader, so they
are not session rows today. Treat that as named drift from the invariant, never as
precedent for a second run-only conversation model; adding another routine harness
requires both archival and a parser in `readRoutineArchiveMeta` plus an indexing
test.

### 8. Routine definitions and device activation are separate

Routine YAML under project, user, or system `routines/` describes what runs and
when. Whether it runs on one host is membership in that host's top-level
`devices/<hostname>/agents.yaml` `routines:` list. Pause/resume and setup MUST
write only the target host's device file; they MUST NOT rewrite a definition with
`enabled`, `devices`, or runtime metadata. Run history belongs in
`.history/runs/<routine>/<run>/`, and that run history — not the session index — is
the canonical record of an attempt; sessions/logs/reports are optional children of a
run (so a `missed`/`blocked`/`skipped` attempt is visible with no session).

**`projects` (plural) is grouping metadata only; the singular `project` anchor is a
separate concept.** The plural list organises a routine in `list`/the menu bar and
MUST NOT affect execution; the (planned) singular `project`/`--project-anchor` plus a
routine-level `cwd` is the execution anchor, resolved on the *execution target*. A
routine's `repo` is an external Git/cloud/webhook identity, never a local cwd. The
reliability contract — context resolution, readiness/pause-on-blocker, single-fire
`(routine, scheduledFor)` claim distinct from the active-run claim, and the
`blocked`/`skipped` run statuses — is normative in
[`docs/specifications.md` §Routine execution & readiness](docs/specifications.md#routine-execution--readiness)
(RT-1..RT-11) and §Scheduling & execution singularity (SING-13, SING-15, SING-16); much of it
is `[Intended]` (RUSH-2290), and each requirement marks landed vs intended.

Routine execution context is separate from grouping and repository identity.
Plural `projects` is metadata-only; singular `project` selects one `ProjectDef`
execution base; `cwd` is resolved on the eventual execution device. A rootless
Linear project may still use a relative `cwd`, which anchors at that target user's
home. `repo` remains GitHub/cloud/webhook identity and MUST NOT be used to infer a
local checkout. Readiness failures save valid definitions paused through device
activation; they never write mutable activation into routine YAML.

### 9. Self-updating agents are ONE binary, not fictional version-homes

Some harnesses (droid, grok, antigravity, cursor, hermes, muse, kiro, goose) install
via an official `curl … | sh` / `brew install` script that carries no version token —
the installer only ever fetches the *current* release and the binary self-updates in
place. `isSelfUpdatingAgent()` ([`src/lib/agents.ts`](src/lib/agents.ts)) is the single
predicate for "no pinnable semver"; route every such decision through it, never a
scattered `=== 'droid'`. Its narrower cousin `isGlobalBinaryAgent()`
([`src/lib/installations/store.ts`](src/lib/installations/store.ts)) — computed by probing whether
`getBinaryPath` ignores the version arg — is true only when the agent resolves to ONE
global binary (droid). For those, `listInstalledVersions` collapses the phantom
per-version dirs to a single canonical entry, `reconcileStaleLatestForAgent` folds the
stale dirs into the survivor, `agents view` shows the live `--version`, and
`agents add droid@1.2.3` gracefully installs the current release instead of erroring.
grok is self-updating but stores a real per-version binary under each version-home, so
it is NOT a global-binary agent and is left uncollapsed. (RUSH-1321)

### 10. Diagnostic command taxonomy — `doctor` is the umbrella (RUSH-2027)

Three diagnostics, distinct scopes. Don't blur them — each answers a different
question, and a new health check goes in the one whose scope it matches.

| Command | Scope | Answers |
|---|---|---|
| `agents fleet status` | Coarse **device** health across the fleet | Are devices online, do they have the agent CLIs installed, are they signed in, what is the agents-cli **version skew**, how many agents are running on each box. NOT fine-grained resource divergence. Publish-own/read-union: each daemon publishes only its own row (no N² ssh probe, RUSH-2061); the reader unions peers on demand (`--local --json` is the per-host publish endpoint). |
| `agents inspect <agent>[@version]` | Deep **single-harness** diagnosis | Per-resource diff between one version home and its resolved sources; manifest staleness; orphans. One harness, one machine. |
| `agents doctor` | **Umbrella** — overall fleet + harness health | Local diagnostics (CLI presence, per-version sign-in, per-version sync, orphans) **and** cross-device divergence, rendered as the prioritized critical-at-top + per-computer hybrid below. The single command a user runs to discover problems before runtime. |

**`agents doctor <agent>[@qualifier]` accepts symbolic qualifiers** — `@latest`, `@oldest`, `@default`/`@pinned`, `@all`, or an exact version — resolved through the shared agent-spec engine (`lib/agent-spec/index.ts`, `resolveAgentTargets`). Bare `agents doctor <agent>` (no qualifier) sweeps every installed version without setting `versionExplicit`; `--fix` then excludes isolated copies. Any explicit qualifier sets `versionExplicit: true`, scoping `--fix` to the resolved version set (including isolated copies for `@all`). `AgentSpecError` from the engine is surfaced as a user-facing error. Routing flags (`--device`/`--remote-cwd`) are stripped via `stripRoutingFlags` before target parsing, so `agents doctor claude@latest --device remotebox` resolves correctly on the remote. (issue #2058, `src/commands/doctor.ts:parseTargetArg`)

**`agents doctor` is a prioritized, comprehensive-by-default hybrid (RUSH-2069).**
There is no `--verbose`. A top `✗ CRITICAL — needs you now (N)` section lists every
critical across the whole fleet worst-first; a `─── by computer ───` section then
gives each device its warnings plus a compact accounts/versions line (every
installed version + its account, provable ✓ / ✗). Single-machine `agents doctor`
collapses to the CRITICAL section plus one `▸ <machine>` block. Severity:
**critical** is `logged-out` (provable), `missing-hook`, `missing-plugin`,
`unwired-hook`, `hook-runtime-broken`, `cli-missing`, `ssh-key-enrollment` and `owner-sink-unreachable` (the feed/notify
owner-delivery lane can't reach the owner from this box, RUSH-2262); **warning**
is `logout-unprovable`,
`missing-resource`, `content-drift`, `never-synced`, `stale`, `repo-behind`,
`repo-drift`, `version-skew`, `fleet-resource-gap`, `hook-runtime-visibility-unavailable`, `orphan`, `duplicate-hook`,
`duplicate-hook-drift`, `host-cli-missing`, `host-cli-invalid`,
`rc-secret-export`, `env-secret-export`, `exec-policy`, `stale-cli` and `binary-shadow`. (RUSH-2162 moved
`never-synced` and `duplicate-hook-drift` to warning — both are stale-sync states
one `agents sync` resolves.)

`FINDING_SEVERITY` in
[`src/lib/devices/doctor-findings.ts`](src/lib/devices/doctor-findings.ts) is the
single source of truth: the builders read their severity from it, and a test
asserts this list and the module docblock assign every kind to the **same bucket**
it does. Change a severity there and the test names the docs to move with it. The findings model,
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
  never-synced version reports one warning (`agents sync <agent>@<version>
  --yes`) instead of one row per absent resource.

**Every check the old overview printed is a finding now.** `renderOverviewText`
was the ONLY text renderer for several independent checks, so deleting it dropped
each of them from the command — the top defect this redesign had to answer for, and
it recurred three times during review. They all enter `buildLocalFindings` as
plain **inputs** (never probes, so the module stays pure and every branch is
testable without a shell, PowerShell, or an installed CLI):

| Check | Input | Finding kind |
|---|---|---|
| Credential-shaped shell-rc exports (RUSH-1968) | `rcSecrets` | `rc-secret-export` |
| The file-store master key live in the process env (RUSH-1968) | `masterPassphraseInEnv` | `env-secret-export` |
| Windows exec policy blocking `agents.ps1` | `execPolicy` | `exec-policy` |
| Windows OpenSSH key path/content/ACL invalid | `windowsSshEnrollment` | `ssh-key-enrollment` |
| Hooks duplicated across version homes | `duplicateHooks` | `duplicate-hook{,-drift}` |
| Declared host CLIs not on PATH | `hostClis.statuses` | `host-cli-missing` |
| Host-CLI manifests the loader rejected | `hostClis.errors` | `host-cli-invalid` |

**Before deleting any renderer here, enumerate what it called.**

**A remediation must fix EVERY version in its row, and must be a command that
exists.** Three separate rounds of review here found remediations naming a command
form that does not do what the row claims — `agents sync <agent>` (default version
only), `agents repo pull` (skips the system repo), `agents prune cleanup` (default
versions only), `agents clis install <a> <b>` (takes one name), and
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

**Per-device harness/account readiness lives in `agents devices harnesses` /
`agents devices accounts` (RUSH-2003).** A fourth fleet lens, distinct from the
three diagnostics above: not "is the fleet healthy?" (`fleet status`) or "is a
token live?" (`fleet ping`), but "what can each box actually *run* right now?" —
per installed `agent@version`, its account, signed-in, quota, and a single `ready`
verdict (signed in AND not rate-limited). `harnesses` is the per-install view;
`accounts` collapses installs that share one account. The collector
([`collectLocalHarnessInventory`](src/lib/devices/harness-inventory.ts)) reuses
`getAccountInfo` (identity), the daemon-warmed usage cache via
`getUsageInfoByIdentity({ readOnly })` (quota — never blocks on a per-account
network fetch unless `--refresh`), and `deriveUsageStatusFromSnapshot` (throttle
state); the fan-out mirrors `fleet ping` (probe self in process, SSH each peer's
`devices harnesses --local --json` worker, same per-device + overall deadlines).
Everything but the collector is pure and unit-tested
([`harness-inventory.test.ts`](src/lib/devices/harness-inventory.test.ts)). Agent
coverage is `ALL_AGENT_IDS`-driven, so a new harness is included automatically.

### 11. Session recovery is one decision on the origin device

`resolveSessionRecovery` in `src/lib/session/recovery.ts` is the only place that
chooses native resume versus `/continue`. `sessions resume` and
`run --resume` route through it — as do the retired `focus`/`attach`/`reconnect`
spellings, which are hidden aliases that still run the same bodies. Native resume is valid only for the exact healthy
origin version when that active isolated home still owns the indexed transcript;
a removed, signed-out, revoked, exhausted, trashed, backup-only, or same-number
reinstalled origin uses a healthy version of the same harness and reads the
indexed transcript with `/continue`. Claude native resume uses the earliest
recorded transcript cwd, which selected `projects/<cwd-key>`, not the later cwd
stored from its first user turn. Never add a caller-local fallback that
native-resumes another version home, and never let `run auto` change harnesses
during recovery.

## Configuration surface

All persistent configuration that affects how agents run — default model, mode,
effort, tier overrides, interactive host, browser profile, and per-device limits —
lives under one command barrel:

```bash
agents config list
agents config get <key>
agents config set <key> <value>
agents config unset <key>
```

Keys use `agent@version` as the canonical harness identifier. Examples:

```bash
agents config set run.claude@*.model best
agents config set run.claude@*.tier.best claude-opus-4-8
agents config set run.claude@2.1.45.model claude-opus-4-8
agents config set run.claude@*.mode auto
agents config set run.claude@*.effort high
agents config set interactive.host zion
agents browser use work
agents config set auto.pool workers
agents config set devices.mac-mini.role worker
agents config set devices.mac-mini.max-agents 4
agents config set devices.mac-mini.scheduler off
agents config set devices.mac-mini.tmux off
```

The new command is a **facade over the existing YAML storage**
(`run.defaults`, `model.tiers`, `config.interactiveHost`,
`defaultBrowserProfile`, and `deviceConfig`). Fleet sync behavior is unchanged.

`devices.<name>.tmux` (stored as `tmux.enabled`) is the durable form of
`--no-tmux` / `AGENTS_NO_TMUX=1`: off makes every interactive `agents run` on that
box spawn the agent directly instead of wrapping it in the shared-socket tmux
session. It is machine-local by design — a broken or unwanted tmux is a property
of one machine, so the value never enters the fleet-shared file and cannot be set
for a peer. Off costs that box `%pane` addressing, so `agents sessions --active`
can no longer tell co-located agents apart there and `agents focus` cannot
re-attach its sessions. The gate is `shouldWrapInTmux`
([`src/lib/exec.ts`](src/lib/exec.ts)), reading `isTmuxEnabled()`.

`devices.<name>.role` (stored as `role`) says what a device is for fleet-wide —
`worker` (agents run here) or `personal` (a machine you sit at).
`agents devices role <name> <role>` is the task-shaped spelling. Marking any
device `worker` turns automatic placement into an allowlist: `--device auto` then
picks only from the marked workers, in every caller (`run`, `teams`, `ssh auto`,
the generic `--device auto` passthrough, and the AGI EXT launch commands, which
resolve placement through the CLI rather than scoring devices themselves); a
`personal` box is never picked automatically. The rule is one function —
`filterAutoPool` in [`src/lib/devices/pool.ts`](src/lib/devices/pool.ts) — read by
`listOnlineDeviceNames`, and `auto.pool` (`workers` by default, or `all`) turns
the allowlist off. When roles leave the pool empty, **both** resolvers throw
(`formatEmptyAutoPoolError`): a `null` host means "run locally", which on a
`personal` box is the outcome the mark exists to prevent. Unlike the machine-local
keys, `role` is **shared**: it lives in that device's tracked
`devices/<name>/agents.yaml` `config.role` and syncs with `agents repo
push/pull`, because every box has to agree on where agents may land.

The vocabulary stops at `worker | personal` on purpose. A paired cockpit's
`control` role is the pre-existing `DeviceRole` in
[`src/lib/devices/registry.ts`](src/lib/devices/registry.ts), written by
`agents devices pair-ios` into that box's own registry and read by the
`isControlDevice()` dial filters. Those filters read each machine's LOCAL
registry, so accepting `control` in the shared key would promise a fleet-wide
dial exclusion it cannot deliver — placement simply skips control devices where
it already reads the registry (`listOnlineDeviceNames`).

`interactive.host` is a **user-level** preference: it lives in central
`~/.agents/agents.yaml` under `config.interactiveHost`, syncs fleet-wide via
`agents repo push/pull`, and answers "which device shows me artifacts?" It is
intentionally not a per-device key. To see it in the per-device view, use
`agents devices config <name> --inherited`.

The old commands still work but are deprecated and print a warning pointing to
`agents config`:

- `agents models tier` → `agents config set run.<agent@version>.tier.<tier>`
- `agents devices set-interactive` → `agents config set interactive.host <name>`
- `agents devices configure` → `agents config set devices.<name>.<key>`
- `agents browser profiles set-default` → `agents browser use <name>`

Implementation: [`src/commands/config.ts`](src/commands/config.ts) with key
parsing in [`src/lib/config-keys.ts`](src/lib/config-keys.ts). Per-device config
helpers live in [`src/lib/device-config.ts`](src/lib/device-config.ts).

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
| ★ Kimi CLI | `kimi` | ✓ | ✓ | ✓ | ✓ | — | ✓ | ≥0.29.0 | ✓ |
| ★ Antigravity CLI | `antigravity` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ≥1.0.16 | ≥1.0.6 |
| ★ Grok CLI | `grok` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ≥0.2.111 |
| ★ OpenCode | `opencode` | ≥0.3.130 | ✓ | ≥1.1.1 | ✓ | ✓ | ✓ | — | — |
| Cursor | `cursor` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ≥2026.1.22 | — |
| OpenClaw | `openclaw` | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| Copilot | `copilot` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ≥0.0.353 | — |
| Amp | `amp` | — | ✓ | — | ✓ | ✓ | — | — | — |
| Kiro | `kiro` | ≥0.10 | ✓ | ≥2.8 | ✓ | ✓ | — | ≥1.23 | — |
| Goose | `goose` | ≥1.34 | ✓ | — | ≥1.25 | — | ✓ | — | ✓ |
| Droid | `droid` | ✓ | ✓ | ≥0.57.5 | ≥0.26 | ✓ | ✓ | ✓ | — |
| Hermes | `hermes` | ≥0.11 | ✓ | — | ✓ | — | — | — | — |
| Muse Code | `muse` | ✓ | ✓ | — | ✓ | — | ✓ | — | — |
| Pi (Oh My Pi) | `pi` | — | ✓ | — | ✓ | ✓ | — | ✓ | — |
| Warp Agent CLI | `warp` | — | ✓ | — | ✓ | — | — | — | — |

✓ = supported · — = not · version cell = only within that range (out-of-range =
skipped silently). [`src/lib/agents.ts`](src/lib/agents.ts) is canonical — keep this
snapshot in sync. `workflows` is `claude`/`kimi`/`goose`/`antigravity` (≥1.0.6, written to the
shared HOME-global `~/.gemini/config/global_workflows/`, not a per-version home), `openclaw` (Lobster `.lobster` files under `.openclaw/workflows/`), and `grok` (≥0.2.111, native Rhai under `.grok/workflows/`); `mcp` is universal; `allowlist` is
`claude`/`cursor`/`opencode`/`antigravity`/`grok`/`kimi`/`kiro`/`droid`/`openclaw`/`copilot` (Copilot writes per-location approvals to `~/.copilot/permissions-config.json`; **Goose is deliberately NOT allowlist-capable** — its `permission.yaml` gates whole tools (`developer__shell`, `developer__text_editor`), so a canonical rule set could not be expressed or read back faithfully; OpenClaw is tool-level only —
blanket rules map to `~/.openclaw/openclaw.json` `tools.alsoAllow`/`tools.deny`, sub-command patterns skipped); `subagents` is `claude`/`codex`/`kiro`/`kimi` (≥0.29.0, Claude-shaped `<name>.md` in `~/.kimi-code/agents/`; older kimi-code compiles its agent profiles into the bundle with no filesystem loader)/`grok`/`openclaw`/`droid`/`copilot`/`antigravity`/`cursor` (≥2026.1.22)/`pi`. **Pi (Oh My Pi, `omp`)** is Claude-compatible: it natively reads `.claude/commands`, `.mcp.json`, and Claude-shaped subagents, and keeps its own native resources under `~/.omp/agent/` (skills, commands, subagents `agents/`, `AGENTS.md` context, `.mcp.json`). `mcp` covers stdio + http + headers. `hooks`/`allowlist`/`plugins` are OFF: omp hooks are per-tool JS/TS extension modules (not event->shell-command registrations), approval is per-TOOL only (`tools.approval`, no command/path patterns), and plugins are npm/TS modules (not the Claude marketplace manifest). Its cross-provider model catalog (OpenRouter/OpenAI/Anthropic/xAI/DeepSeek/…) surfaces in `agents view` / `agents models pi` via `omp models --json`. **Warp Agent CLI (`oz`)** is the coding-agent CLI on Warp's Oz platform (the shared Warp binary invoked via the `oz` symlink). Install is self-updating via `brew install --cask oz` (macOS) / the `oz-stable` apt|yum|pacman package (Linux); config lives under `~/.warp/`, the rules/context file is `AGENTS.md`, and auth is `oz login` (browser OAuth) or a `WARP_API_KEY` token for headless/CI (`oz api-key create`). Headless run is `oz agent run --prompt "<task>" [--model <id>]`; autonomy is governed by the selected agent profile (`--profile`), not a per-run permission flag, so the single `edit` mode maps to no flags (mirrors Hermes). `mcp` covers stdio + http + headers via the Claude `.mcp.json` schema at `~/.warp/.mcp.json` (project `<root>/.warp/.mcp.json`); `skills` come from `--skill` + `oz agent skills`. `hooks`/`allowlist`/`commands`/`plugins`/`subagents`/`workflows`/`memory` are OFF: Oz has no event→shell hook registration, its permissions are profile-based (not a Claude tool allow/deny list), slash-commands are native/server-managed, and cloud agents/profiles are server-side (no installable subagent dir). Warp is intentionally **absent from `SESSION_AGENTS`** — Oz stores conversations server-side (retrieved with auth via `oz run conversation get <id>`), so there is no local transcript for `agents sessions` to index — and it exposes no usage/limits endpoint, so `agents view` shows no usage bar for it.
**Gemini is hard-deprecated.** Keep the legacy `gemini` id only for parsing old
sessions/config; `agents add gemini`, `agents import gemini`, and
`agents sync gemini` fail and point users to Antigravity.

## Source layout

```
src/
  index.ts             # CLI entry (commander.js)
  commands/            # User-facing subcommands (one file — or a `<cmd>-*.ts` family, e.g. the `sessions*.ts` family — per `agents <cmd>`)
  lib/
    state.ts           # Path constants; agents.yaml read/write (serializeCentral preserves comments)
    manifest.ts        # Project/user agents.yaml Manifest read/write (comment-preserving Document round-trip; used by mcp add, etc.)
    resources.ts       # resolveResource() / listResources() — layered resolution
    capabilities.ts    # supports() — the per-agent write gate
    agents.ts          # Per-agent capability table
    subagents-registry.ts  # SUBAGENT_TARGETS — declarative per-agent subagent shape (dir/layout/transform); generic install/list/remove engine
    installations/     # versions.ts (install, remove, syncResourcesToVersion), migrate.ts (one-shot idempotent migrations), store/resolve/strategies
    shims.ts           # Shim generation, config symlink switching
    hooks.ts           # hooks.yaml parser + per-agent registrar
    hooks/match.ts     # `matches:` predicate evaluator
    browser/           # browser daemon service + existing CDP connection pool; ipc.ts owns one-shot and persistent socket clients, stream.ts owns the NDJSON action loop; hygiene.ts is the abandoned-task reaper (session-dead + idle, RUSH-2622) the daemon's 5-min tick and `agents browser gc` both call
    monitors/          # `agents monitors` — event-triggered watchers (source→condition→action); native state-diff store; MonitorEngine runs in the daemon beside the cron scheduler. See docs/monitors.md
    projects.ts        # `agents projects` — named multi-repo project defs (~/.agents/projects/*.yaml) layered above the --project convention (resolveProjectRef in project-root.ts); project-status.ts rolls live sessions + merged PRs + artifacts into the progress card. Beta-gated. See docs/projects.md
    project-pull.ts    # `agents projects pull` — fleet fan-out logic: pullProjectTargets (sequential local fast-forward + per-target repo-slug verification), pullLocalArgs/encodePullTargets/decodePullTargets (the {path, expectedSlug} CLI-arg hop to each peer's hidden `pull-local` — bare paths would disable slug verification remotely AND break the fingerprint), buildPullEnvelope/parseProjectPullEnvelope (fail-closed AND fail-loud: a rejected envelope returns valid:false so the peer lands in parseFailed and exits non-zero, never a silent empty result set), printProjectPullSummary. Strict safe contract: dirty trees and non-default branches are blocked; missing checkouts are skipped, never cloned. See docs/projects.md §Pulling every reachable checkout
    session/           # `agents sessions` READER — discovery/parse/render of agent transcripts; also `migrate-targets.ts` (the `sessions migrate` target scorer); `db.ts` `queryResourceUsageStats`/`backfillResourceUsage` back `agents sessions stats` + `sessions backfill resources` (skill/command usage rollup, session_resource_usage + resource_scan_ledger); `claude-accounts.ts` attributes each Claude transcript to the account that produced it (account_key) and `insights.ts` extracts the cached multi-harness friction/correction/automation facets behind `agents sessions insights` (`agents insights` alias)
    terminal/          # Terminal launch engine — tab/split in iTerm/Ghostty/tmux/Terminal.app, local or --device;
                       #   preferred.ts resolves WHICH terminal for a GUI caller (from live sessions' host app)
    cloud/             # Provider registry (Rush / Codex / Factory / Antigravity)
    teams/             # `agents teams` orchestration
    computer-rpc.ts    # `agents computer` client → native/computer-mac (Unix socket)
    ssh-tunnel.ts      # `agents computer --device` → native/computer-win over ssh -L
    menubar/           # Menu-bar helper installer (source in ../menubar)
    profiles.ts        # Host CLI + endpoint + model bundles
```

Note: `src/lib/session/` here is the transcript **reader**. The live-session
**writer** is a separate package, [`packages/session-tracker`](../../packages/session-tracker)
— different data, different consumer; see its AGENTS.md.

### `agents sessions` preview architecture (map before you touch it)

The interactive UI is three picker variants in `src/lib/picker.ts`: `itemPicker`
(single-select, `space` toggles preview), `dynamicPicker` (async data source, used
by the session browser, `tab` toggles preview), and a multi-select variant. All
render a right/bottom **preview pane** built by `buildPreview(session)` in
`src/commands/sessions-picker.ts` — a header (agent/model/cwd/tokens/ticket/PR) plus
`formatCompactPreview` (prompt, files/changes, hooks, errors, tests, last response).
`agents sessions preview <uuid-or-prefix>` uses the same card without the picker.
ID-shaped selectors go through the indexed fleet resolver, remote cards render on
their owning peer, and the normalized digest is cached in SQLite against the
transcript's actual mtime + size. Live status is deliberately outside that durable
digest and expires after 15 seconds through `session-cache.ts`.

Indexing is lazy — only `discoverSessions` writes the index — so a session THIS
box just started is "running" in `--active` before it is indexed. The id resolver
(`computeLocalMetadataMatches` in `sessions.ts`) therefore unions the indexed
rows with the LIVE registry on a cold id miss, so `preview`/`resume`/`focus`
resolve a running session with no transcript row yet (the fan-out peer answers
from the same union, so it works cross-device too — SES-9b). The daemon keeps the
index current within seconds via `runSessionIndexWarmTick`, and the cold-miss
repair waits for a concurrent scan rather than returning a stale read
(`discoverSessions({ waitForScan })` — SES-9c). This is why a running session no
longer reads "No session matching" during the index-lag window (RUSH-2682).

Routing lives in `src/commands/sessions.ts`: `isBareBrowserListing`
(+`hasNoBrowserDisqualifyingFlags`) gates the bare fleet-wide listing to the rich
`runSessionBrowser` ([`src/commands/sessions-browser.ts`](src/commands/sessions-browser.ts));
a query/filter falls through to `pickSessionInteractive` → `sessionPicker`.
`--flat`/`--tree`/`--json`/`--no-interactive` print non-interactive views with no
preview. `PICKER_RECENT_COUNT = 15` caps the picker's list rows.

Gotcha: the preview pane has **no guaranteed height** — `availablePreviewRows =
terminalRows() - fixedRows` (`picker.ts`), and `limitPreviewHeight` returns `''` when
that collapses, so the preview can silently vanish on a full/short terminal (the
RUSH-2198 bug). See the [§Contracts §Sessions spec](docs/specifications.md#sessions)
for the non-empty-preview invariant (SES-8).

### Resume is machine-bound — check the owner before you start a harness

**Reading and resuming follow different machines, and conflating them is the bug.**
Reading follows the FILE — a synced mirror is on this disk, so only a live fan-out
row (`_remote`) must be read on the peer (`transcriptOnPeerOf` in
`sessions-picker.ts`). Resuming follows the HARNESS STATE, which is on the owning
machine whatever the transcript's location. A mirror is therefore readable and NOT
resumable, and that is the trap: nothing fails until the agent is asked to continue
a conversation it has never seen, and `sessions-resume.ts`'s `fs.existsSync(cwd)`
fallback then quietly resumed in `process.cwd()` (RUSH-2022).

`sessionOwnerDevice`
([`src/lib/session/resume-owner.ts`](src/lib/session/resume-owner.ts)) is the one
answer to "may this resume run here?". Every path that starts a harness from a picked
row consults it first: `agents sessions resume` and the `agents sessions` picker hop to the
owner, and `sessions attach` hops as an **attach** (its detach record and the
headless process it stops are both on the owner — hopping as a bare resume would
skip the stop and leave two processes on one transcript). The batch
`sessions resume` mostly inherits it for free: every TAB it opens runs the
canonical `agents sessions resume <id>` (`lib/session/resume-command.ts`), whose docblock
already promised source-device routing — this is what makes that true. Its
no-tab-backend path (`inplace`, which any Linux box in a plain ssh shell lands on)
never runs that command, so it routes explicitly via `resumeOnOwnerIfRemote`.
`resumeSessionInPlace` is the LOCAL takeover and **fails loud** if it is handed a
peer-owned session, since reaching it with one means a caller skipped its routing
step.

The hop uses `runOnPeer` ([`src/lib/session/remote-list.ts`](src/lib/session/remote-list.ts)),
not the `--device` passthrough. Two reasons: the passthrough re-discovers locally and
dead-ends for a session that exists only on the peer, and it marks the run
`AGENTS_FLEET_REMOTE` — a one-shot command may carry that consent marker, but a
resumed session would inherit it for its whole life and `agents browser start` inside
it would be refused as a cross-machine drive.

The signal is only as good as what wrote it: `machine` on a host-dispatched run is
stamped by [`src/lib/hosts/session-index.ts`](src/lib/hosts/session-index.ts) from
the dispatch host. Any new writer of an `agents run --device`-shaped row must set it,
or the index will claim the dispatching box.

## Bundled native helpers (where the tarball's `.app`s come from)

Two native helpers plus the standalone signed CLI binary ship **inside** this
package's npm tarball; two more helpers are dev-only and live at repo-root `native/`.

| Helper | Source | Ships in tarball? | Resolver |
|---|---|---|---|
| Keychain broker | `src/lib/secrets/keychain-helper.swift` → `bin/Agents CLI.app` | **Yes** (signed + notarized) | `src/lib/secrets/` |
| Menu-bar helper | [`menubar/`](menubar) (SwiftPM) → `bin/MenubarHelper.app` | **Yes** (signed + notarized) | `src/lib/menubar/install-menubar.ts` |
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
branch pushes/PRs and manual `workflow_dispatch` — not `v*` tags (the tag points
at the commit already gated on the release branch). CI runs from `apps/cli` via
`defaults.run.working-directory`.

**Live Windows `--device` e2e (opt-in):** `src/lib/ssh-tunnel.e2e.test.ts` and
`src/lib/browser/drivers/ssh.e2e.test.ts` drive a real Windows box end-to-end
(exe push + LOGON task, tunnel + RPC, screenshot, type/get-text round-trip,
remote browser launch/stop). Gated on `AGENTS_TEST_WIN_HOST=<registered device>`;
both suites skip cleanly when the var is unset, so CI needs no Windows runner.

**Local dev build:** `scripts/install.sh --skip-tests` builds the working tree,
installs it at `$HOME/.local/agents-cli-dev/`, and exposes it as
`$HOME/.local/bin/agents-dev` (plus `ag-dev`). Drive it by name — `agents-dev
sessions --active`. Version stamps as `0.0.0-dev.<sha>[-dirty]`.

The production command is never created or overwritten: the script must not write
`$HOME/.local/bin/{agents,ag,browser}`, and it deletes any such link an older
revision of itself left pointing into the dev prefix (including a dangling one,
which is what a cleaned dev prefix leaves behind). A dev build that answered to
`agents` made PATH order decide which code ran — see the root
[AGENTS.md](../../AGENTS.md) §Never install a dev build over the user's `agents`.

The routines daemon is **shared** (secrets broker, browser IPC, scheduler), so
the install leaves it on production code. `--bounce-daemon` restarts it onto the
dev build when you need that, and says plainly that it changes what the user's
everyday `agents` talks to.

**Bin entrypoints need `chmod 755`.** [`scripts/build.sh`](scripts/build.sh) chmods
every `package.json#bin` entry after `tsc` emits. Newer npm preserves tarball file
mode and does NOT auto-chmod — 644 surfaces as `zsh: permission denied: agents`.

The `files` allowlist in [`package.json`](package.json) is a **whitelist** — only
`dist/**`, the two signed `.app`s, and the postinstall scripts + README/LICENSE ship.
Nothing from `apps/`, `native/`, or sibling `packages/` can leak into the tarball.

## Releasing

**Self-routing, zero-config.** Run it from ANY fleet box and ANY checkout state —
no variables to set, no Touch ID, no hand-moved credentials, and no requirement
that the caller be on a clean `main`:

```bash
scripts/release.sh <version>                      # dry-run: bump, type-check, tarball preview, detected state
scripts/release.sh <version> --apply              # tests on a crabbox -> PR + CI -> merge + tag -> build/sign/publish on the home base (mac-mini)
scripts/release.sh <version> --apply --device <mac>  # sign/publish on <mac> when mac-mini is down -- <mac> must ALREADY be a provisioned signing home base (see below)
```

The release has **three self-selected homes** and prints a `[n/6]` phase tracker,
each phase labeled with the box it runs on and a ✓/✗ result:

| Work | Runs on | How it's chosen |
|---|---|---|
| Orchestrate: bump, changelog, PR, tag | a detached worktree on the box you invoked it on | fresh `origin/<default>` under `.agents/worktrees/release-v<version>-<pid>` |
| CI / tests (Linux) | a **crabbox** workspace (Hetzner Linux VM) | [`scripts/sandbox.sh`](scripts/sandbox.sh) reclaims an available warm box and syncs into `~/workspaces/<repo>-<task>`; it warms capacity only when the shared pool has none — **dynamic, never a hardcoded or release-exclusive instance** |
| Build, sign+notarize, npm publish, computer-helper | a **Mac home base** | `--device <name>` in `release.sh`, defaulting to `mac-mini`; the script detects if it's already there (`scutil --get LocalHostName` / `hostname -s`), else reaches it over `ssh` |

The home base is a Mac that holds the Developer ID cert + npm publish rights.
It defaults to `mac-mini` and is overridable with **`--device <name>`** to drive
the release from another Mac when mac-mini is down. Not an env
var: a flag with a default. The macOS-only sign/notarize + the npm tarball's
signed binaries mean the home base must be a Mac; a Linux worker can *drive* the
release but not be the home base. The crabbox is **not** hardcoded.

**A `--device` fallback must ALREADY be a provisioned signing home base — it is
not turnkey.** Signing + notarizing + publishing needs, on that box: the
`Developer ID Application` identity in a *headless-unlockable* keychain
(`rush-signing.keychain-db` + `~/Library/Application Support/rush/signing.kcpass`,
the pass file that lets a headless SSH release unlock it — a cert that only appears
after an interactive login does **not** count), and the `apple.com` (notarytool)
and `npmjs.com` (publish token) secrets bundles. A box like `zion` typically has a
Developer ID cert in its *login* keychain but none of the headless plumbing, so it
cannot sign a release. Passing `--device zion` there used to run the whole flow —
merge the PR, push the tag — and only fail at the sign step, leaving a
tagged-but-**unpublished** release (RUSH-2535; npm stuck at 1.22.35 with `v1.22.36`
tagged). `release.sh` now **preflights the resolved home base BEFORE any mutation**
([`scripts/signing-home-base-probe.sh`](scripts/signing-home-base-probe.sh), run on
that box over `agents ssh`): an unprovisioned `--device` aborts at the preflight,
before the crabbox/PR/merge/tag phases, naming the exact gap, so a mac-mini outage
no longer risks a half-finished release. `apps/cli/bin/embedded.provisionprofile` is a
committed input (commit 2567004b4) that self-heals — the preflight and the
home-base phase both recover it from a freshly fetched `origin/<default>` ref when
the box's own on-disk checkout predates that commit, so a brand-new home base
never needs the profile hand-copied over (RUSH-2541). The keychain (Developer ID
identity in a headless-unlockable keychain) and the `apple.com`/`npmjs.com`
secrets bundles remain genuinely manual, per-machine provisioning steps — seed
those first, then `--device <that-mac>` works.

**The caller checkout is never mutated or gated.** `release.sh` immediately
fetches origin and re-enters the release from a detached, release-owned worktree
at fresh `origin/<default>`. Version bumps, changelog folding, release-branch
construction, CI orchestration, merging, and tagging happen there. The worktree
is removed on every exit path, so a dirty shared `main`, an agent feature branch,
or another branch already checking out `main` cannot block or contaminate a
release. The isolated tree installs dependencies from its pinned lockfile; it
does not borrow `node_modules` or staged files from the caller.

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
scripts/release-lease.sh status     # unheld | held version=… holder=… age=…min holder-alive=yes|no|unknown
scripts/release-lease.sh claim <v>  # 0 = acquired, 1 = someone else is releasing
scripts/release-lease.sh renew      # prove this run is still alive
scripts/release-lease.sh verify     # 0 = still ours; fails CLOSED on any doubt
scripts/release-lease.sh release    # drop the lease this checkout claimed
scripts/release-lease.sh clear      # drop a lease with no live holder (any checkout)
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

**An externally killed run is detected, not just waited out (RUSH-2274).** The TTL
alone made a killed release indistinguishable from a healthy long one: for up to 30
minutes `status` read `held` while nothing was releasing. So the lease also records
**which process** holds it — `host`, `pid`, and that pid's start time — and
`claim`/`clear`/`status` probe it, reporting `holder-alive=yes|no|unknown`:

| Probe | When | What it licenses |
|---|---|---|
| `dead` | we are on the holder's box and that process is gone | reclaim **immediately**, no TTL wait |
| `alive` | the recorded pid runs here with the recorded start time | **never** taken, at any age — stop that release instead |
| `unknown` | the holder is another box, or the lease predates these fields | the TTL, exactly as before |

`release.sh` exports `RELEASE_LEASE_HOLDER_PID=$$` so the recorded pid is the
orchestrating release, not the 10-minutely `renew` shell (whose `$$` is dead a
second later — recording that would make every renewed lease read as abandoned).
A lease with no recorded pid stays `unknown`, so a missing export degrades to the
old TTL behaviour rather than to "instantly reclaimable". The start time is what
makes `dead` safe to act on: a recycled pid would otherwise read as a live release
forever. A **zombie** counts as dead — a SIGKILLed release whose parent never
reaped it is still listed by `ps`, which is precisely the case this detects.

`scripts/release-lease.sh clear` drops such a lease without starting a release —
the operator's unwedge path, since `release` only drops a lease *this checkout*
claimed. It shares one predicate with `claim`, so it can never take a live holder's
lease either.

**Finish a stuck release before cutting a new one — with one exemption.** `release.sh`
refuses to start when an older `v*` tag exists that npm never received, and prints
the re-run that finishes it. The single carve-out is a **`patch-from-main` bump
stepping over main's own version**, because that stuck release cannot be finished
at all: `release.sh`'s catch-up guard rejects it and points at "cut the next patch",
so without the exemption the two guards deadlock and *nothing* publishes (2026-08-10,
npm at 1.22.35 with `v1.22.36` tagged — its CI-tested tree predated the prepack
version-gate fix, so its own `npm publish` rejected a correct binary). Only main's
own version is dropped from the candidate set, and `stuck-release.sh` says so on
stderr; any other stuck tag still blocks, under every bump kind. Without the guard,
a release that died between tag and publish left the
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
another Mac (no publish); it takes the same `--device <name>` flag as `release.sh`
(default `mac-mini`), with no other env knobs or fleet discovery.

**Provisioning the `apple.com` bundle on a headless sign host.** A Linux-driven
release offloads macOS signing to a sign host over SSH, which needs the `apple.com`
secrets bundle *on that host*. Push it with the **file backend** —
`agents secrets export apple.com --device <signer> --remote-backend file` (**no
passphrase required** — the remote keys it under a machine-local key it
auto-provisions and reads it headlessly; set `AGENTS_SECRETS_PASSPHRASE` locally only
to opt into a shared off-disk key, forwarded over ssh stdin) — **not** the default
keychain backend: a
macOS login keychain is locked under headless SSH, so a keychain-backed push lands
the bundle metadata but no readable secret items (`secrets export --device` now
read-back-verifies a keychain push and fails loudly if it didn't persist, pointing
at this fix). `--device` / `-D` is the fleet routing flag (legacy `--host` is stripped but not registered) on the secrets remote
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
`codesign --verify` + a **stapled notarization ticket**). It is Developer-ID signed
**and notarized + stapled** ([`menubar/scripts/build.sh`](menubar/scripts/build.sh),
run inside the release's `agents secrets exec apple.com` context): Gatekeeper on
macOS 26+ rejects an un-notarized `.app` as "damaged" (crashing AppKit at launch),
and the stapled ticket rides inside the bundle so it survives npm's tarball
round-trip — so the installed helper launches with **no per-machine re-signing**
(the old `install-menubar.ts` ad-hoc re-sign band-aid is gone; the launch guards now
verify Gatekeeper acceptance and fail loud instead — RUSH-2134). Notarization is
mandatory for any real (Developer-ID) build; an ad-hoc dev build can't be notarized
and the prepack gate refuses to pack it. Keep it a **separate bundle** from the
keychain app — a menu-bar crash must never take down the secret broker. Stage a
freshly-built `bin/MenubarHelper.app` before any release or the menu bar ships
code-only (the 1.20.22 bug the gate prevents).

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

**Only the install that OWNS the helper may reinstall it.** The startup self-heal
(`installMenubarLaunchAgentOnUpgrade`, every darwin invocation) reinstalls when the
version stamp drifted or the plist's baked entry names another install. Both of
those record *whichever copy acted last*, so on a box with several agents-cli
copies each one read the others' marks as drift and recopied the bundle over them —
and recopying replaces the executable under the running helper, killing it, after
which `KeepAlive` restarts it and the next copy repeats it. Observed: a new pid
every 5-15s, 578 launches in one helper log, a status item that never stayed
visible, and `agents menubar status` still saying `running: yes` because a pid
always existed (#2109). `mayInstallMenubarHelper` gates it: the plist's
`AGENTS_ENTRY` names the owner, and only the owner reinstalls freely. A same-install
upgrade keeps its entry path, so `npm update` still lands normally.

Three escapes keep the gate from becoming a **stuck state**, which is how the first
version of it regressed: (1) **repairs are never gated** — a missing helper
executable or a Developer-ID heal proceeds from any install, since a bundle that
isn't there cannot be contested and blocking it leaves the menu bar dead with no
automatic recovery; (2) a non-owner takes over immediately once the recorded owner
is **gone from disk**; (3) otherwise a non-owner may still take over **once per
`MENUBAR_TAKEOVER_COOLDOWN_MS`** (1h, stamped in `.menubar-last-heal`). Without (3)
a stale-but-present copy — an old nvm node dir nobody runs — owns the plist forever
while the user's actual daily driver upgrades and never heals again. The cooldown
turns an every-invocation storm into at most one restart per hour while leaving
every install able to make progress. `agents menubar setup` bypasses the gate
entirely and stays the immediate manual fix.

Two caveats worth knowing before you tune any of this. **(a)** Escape (3) is
refused to a source bundle that is not Developer-ID signed: `scripts/install.sh`
puts an ad-hoc dev build beside the npm global, and letting it win a *timed*
takeover would recopy an un-notarized bundle over a good one, which Gatekeeper
rejects as "damaged" and AppKit crashes on (RUSH-2134) — a broken menu bar rather
than a cosmetic restart. It can still adopt via (2), the case that must never
deadlock. **(b)** The cooldown bounds the loop but does not converge it: two
installs that are *both* invoked regularly trade ownership every cooldown, so the
helper restarts roughly hourly until one is removed. That is deliberate — the
alternative is stranding one of them — and the real fix is a single install
(#2147 expanded the multi-install banner beyond `PATH` to NVM, fnm, Volta, Bun,
common npm prefixes, and the npm `_npx` cache). The banner also checks each
copy for `dist/lib/app-bundle-install.js`; a copy without it is labelled an
unsafe legacy helper installer and must be removed, because current code cannot
make an older executable use the atomic installer it predates.

**Do NOT "improve" this by comparing bundle content.** It looks like the obvious
gate and it does not work: the helper is rebuilt, re-signed and re-notarized on
every release (`menubar/scripts/build.sh` via `release.sh`), so consecutive
releases ship byte-different bundles from identical Swift source. Measured on
1.22.20/21/22 — same 2876288-byte executable, three different sha256s, and three
different **CDHashes** (so stripping the CMS/timestamp blob doesn't rescue it
either). Any digest gate reports "changed" for precisely the skew case it was
meant to exempt. Ownership is the only signal here that is stable across
independently-signed builds. Related: the secrets broker hit the same
multi-install failure and answered it differently, by keeping a *hot* broker alive
across version skew (`shouldTeardownVersionSkewedBroker`, `src/lib/secrets/agent.ts`;
#435, PR #909) — same disease, and a third `KeepAlive` helper will need one of
these two answers rather than a fresh rediscovery.

**The lock fd is `O_CLOEXEC`, and `acquire` self-heals a stale lock.** The lock is
opened `O_RDWR | O_CREAT | O_CLOEXEC` so no spawned child can inherit the
descriptor — a pre-fix `doctor` child that inherited it and orphaned at PPID 1 held
the flock forever, and every relaunch then read "already running" and exited, so
the menu bar stayed dead until reboot. `O_CLOEXEC` is the fd-level guarantee across
*every* spawn path: `ChildProcess.spawn` sets only `POSIX_SPAWN_SETPGROUP` (no
close-on-exec default), and the bare-`Process` one-shots (`runDetached` /
`runMonitored`) are meant to *outlive* the helper — so the flag on the fd, not the
spawn site, is what keeps the lock out of every child. The helper never execs
itself, so it keeps the fd for life. And when the flock is
held but **no LIVE `MenubarHelper` owns it** — the lock-file pid is dead, or belongs
to some other program by reuse (`liveHelperOwnsLock` checks liveness + `proc_pidpath`
basename) — `acquire` reaps the leaked orphan and retries the lock once, instead of
surfacing into the deadlock. Only a genuine live incumbent is ever surfaced, so a
duplicate launch never reaps a live helper's in-flight children (the reap is reached
only when the holder is provably not a live helper).

**Every CLI child the helper spawns is bounded, group-killable, and reapable.**
The helper shells `agents` on a timer, and an unbounded `Process` there is not a
slow menu — it is a machine-killer. `doctor --json` measures **136s on an idle
box**, the poll asked for it every 60s, and a helper that dies mid-call leaves the
child reparented to launchd with nothing to reap it (plus the `node -e` probes
that child forked). The deaths are not preventable from inside the app:
`NSApplication.shared` segfaults in `SLSNewConnection` when WindowServer is too
starved to hand out a connection, and `KeepAlive` restarts into another doctor.
Observed: 38 orphaned doctors + 92 orphaned probes, ~13 of 18 cores, load 490.
**The property that made this fatal is accumulation, so the rule is scoped to
what accumulates: every TIMER-DRIVEN, repeating CLI call MUST go through
[`ChildProcess`](menubar/Sources/MenubarHelper/ChildProcess.swift)** — that is the
`capture()` path behind the cached refreshers (`routines`, `recentSessions`,
`activeSessions`, `doctorOverview`, `watchdog`). A poller is the only thing that
can stack 38 copies of itself.

**User-initiated one-shots deliberately do NOT** — `runDetached`,
`runMonitored`, and `runMonitoredWithInput` keep a bare `Process` on purpose,
because every one of their callers is a menu click (`routines run/pause`,
`devices register`, `open <url>`, and the ticket-agent / quick-fix dispatches).
Two reasons, and both would be violated by "bound everything": a deadline there
would **kill the user's headless `agents run` mid-work**, and a fire-and-forget
`open`/dispatch is *supposed* to outlive the helper. One click cannot stack, so
there is nothing to accumulate. Do not "fix" these by routing them through
`ChildProcess` — if a future caller makes one of them repeating, that caller is
the bug.

`ChildProcess` holds three invariants:

- **Bounded.** Every spawn carries a deadline (30s; `ChildProcess.doctorTimeout`
  180s for `doctor --json`, above its real measured cost — a ceiling set *below*
  the true cost just makes every poll fail while still paying full CPU).
- **Killed as a group.** The child is spawned as its own process-group leader
  (`POSIX_SPAWN_SETPGROUP`) so a timeout `kill(-pgid)`s the subtree. Signalling
  the pid alone is what left 92 probes running. Foundation's `Process` cannot set
  a process group — that is why this is `posix_spawn` and not `Process`.
- **Reaped by the NEXT launch.** Live children are recorded in
  `~/.agents/.cache/state/menubar-children`; `reapOrphansFromPreviousLaunch()`
  runs in `main.swift` **before** the first AppKit call, since the crash being
  recovered from happens *inside* that call. Do NOT move it after, and do NOT
  replace it with an exit handler — SIGSEGV runs none. Pid reuse is guarded by
  re-checking the executable path (`proc_pidpath`) before killing.

Poll intervals must stay well above the call's real cost:
`StatusItemController.doctorRefreshInterval` is 15 min against a 136s command
(it was 60s — a >100% duty cycle). `MENUBAR_CHILD_TEST=1 MenubarHelper` exercises
all of it against real processes, including reaping a real surviving orphan and
proving a spawned child never inherits the single-instance flock fd.
Separately, **`doctor --json` taking 136s on an idle machine is its own defect**
— the helper is now safe against it, not a reason to consider it acceptable.

**These self-tests are a build gate now, not just manual modes.** The helper's
env-gated self-tests (`MENUBAR_SINGLE_TEST`, `MENUBAR_CHILD_TEST`,
`MENUBAR_GUARD_TEST`, `MENUBAR_ISSUE_TEST`) are headless — they exit before the
AppKit path (`Guards.enforceForInteractiveLaunch`) so they need no GUI or signing.
[`menubar/scripts/test-menubar.sh`](menubar/scripts/test-menubar.sh) runs all four against
the just-built binary and [`build.sh`](menubar/scripts/build.sh) invokes it before
signing, so no helper artifact ships whose invariants regressed. Nothing ran these
before — PR CI is Linux (can't build Swift) and prepack only checks the shipped
bundle's signature — which is how the flock fd-inheritance deadlock escaped. Do NOT
add `MENUBAR_DUMP` / `MENUBAR_PROMPT_PREVIEW` to the gate: those reach AppKit and
need a GUI session.

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
  clauses match distinct calls, tool queries never parse transcripts, and exact
  static program counts retain repeated sites with wrapper/effective roles;
  versioned tool envelopes do not replace the list/detail JSON contracts
  (SES-31..SES-37, SES-IF-4a); `agents sessions insights` emits aggregate-only
  actions and keeps `agents insights` as its top-level alias (SES-IF-4c); `agents sessions stats` emits its own versioned
  `sessions-stats` rollup of skill/command usage and never the list/detail shape
  (SES-IF-4b); `agents sessions
  export --encrypt` seals every transcript
  body client-side with AES-256-GCM under the shared `r2.backups` bundle key, or
  an ephemeral one when unconfigured (SES-24, SES-25).
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

Beyond the two above, the document also specifies **§Agent execution**,
**§Scheduling & execution singularity**, and **§Watchdog**. It does **not** cover
every command group — `hosts`, `teams`, and `cloud` have design docs but zero
RFC-2119 requirements, and surfaces like `wallet` and `sync`/`apply`
have neither. The
[coverage inventory](docs/specifications.md#coverage-inventory) says which row a
surface sits in; check it before treating a behavior as guaranteed.

Every section enumerates **known gaps** (implemented-vs-intended drift) — a new
feature MUST NOT widen them and SHOULD close the one it touches. A gap that has
been closed stays as a `(resolved)` entry so references never dangle.

## Detailed design

[`docs/`](docs/README.md) is the source-grounded reference. Start with
[`architecture.md`](docs/architecture.md) for the CLI/extension layering and the
session mechanisms, then [`concepts.md`](docs/concepts.md) for the resource
model. The normative contract
([`specifications.md`](docs/specifications.md)) sits
alongside the reference docs ([sessions.md](docs/sessions.md),
[secrets.md](docs/secrets.md)) — read the spec for the guarantee, the reference
for the how-to.
