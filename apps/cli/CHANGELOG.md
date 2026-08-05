# Changelog

## 1.22.16

- **Resume exact sessions locally or across the fleet with `agents resume <id>` and `agents run <agent|auto> --resume <id>`.** Full IDs use the local SQLite index before any SSH fan-out; remote owners route to the recorded device and version home. Session metadata now records launch mode alongside harness, version, account, cwd, and machine so strict resume reconstructs the original run. Claude, Codex, Grok, Kimi, Droid, and Cursor use their verified version-specific native resume syntax; `run auto --resume` can select another healthy harness/account and continue through `/continue` when native resume is unavailable. Source: `apps/cli/src/commands/{exec,resume,sessions}.ts`, `apps/cli/src/lib/{exec,session/db}.ts`, `packages/session-tracker/src/hook.sh`.

- **Hooks: one-level event dirs (`hooks/<event-name>/<script>`) are first-class.**
  System hooks organize by harness event (`session-start/`, `pre-tool-use/`, …).
  Install names stay the file basename. Dirs with top-level scripts expand into
  individual hooks; fixture-only dirs remain directory bundles. Manifest `script:`
  may be a relative path under `hooks/`. Source: `apps/cli/src/lib/hooks.ts`,
  `apps/cli/src/lib/staleness/writers/sources.ts`, `apps/cli/src/lib/versions.ts`,
  `apps/cli/src/lib/__tests__/hooks-nested-groups.test.ts`.

- **`agents humans show owner [--json]`** — new command to display the owner config from `~/.agents/humans.yaml`. The file is written automatically on first run when `notify.owner` exists in `agents.yaml`. Source: `apps/cli/src/lib/humans.ts`, `apps/cli/src/commands/humans.ts`.

- **`humans.yaml` — typed, versioned owner config.** `~/.agents/humans.yaml` (`version: 1`) now stores owner identity (name, timezone, quiet hours, severity), notification channels, and escalation policy. `notify.owner` in `agents.yaml` is migrated into it on first run and the `notify.owner` key is removed from `agents.yaml`; unrelated keys are preserved. `agents send --to owner` / `agents notify` prefer `humans.yaml` with a fallback to `agents.yaml` during the migration window. Source: `apps/cli/src/lib/humans.ts`, `apps/cli/src/commands/humans.ts`, `apps/cli/src/lib/migrate.ts`.

- **`agents memory` ignores `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `MEMORY.md`.** These rule/index files lived in `~/.agents/memory/` but were incorrectly surfaced as memory facts. `isFactFile()` now excludes them by name (case-insensitive). Source: `apps/cli/src/lib/memory.ts`.

- **Permissions write path fixed — `groups/` subdirectory.** `installPermissionSet`, `removePermissionSet`, and `savePermissionSet` now all write to the `groups/` subdirectory (matching `discoverPermissionGroups()` which already reads from `groups/`). Source: `apps/cli/src/lib/permissions.ts`.

- **Stop eagerly creating webhooks directories.** `ensureAgentsDir()` no longer creates `~/.agents/webhooks/` or `~/.agents/.system/webhooks/` on startup — both dirs are created on first actual use. Source: `apps/cli/src/lib/state.ts`.

- **Terminals canonically under `.cache/`.** The stale migration comment that blocked `terminals/` from moving to `~/.agents/.cache/terminals/` is replaced by the actual move. Factory already writes to `.cache/terminals/` (`foreman.registry.ts:9`), so no app-level change is needed. Source: `apps/cli/src/lib/migrate.ts`.

- **Menu bar warns when a device is under high load (local or remote).** The
  agents-cli menu bar now shows a `⚠ <device> — high load N%` row in NEEDS YOU when
  a machine's load or memory crosses the `headroom()` "loaded" threshold (≥75%), and
  a red `✕` when critical. The local machine is probed natively via `getloadavg`
  (zero subprocess); fleet peers come from the daemon-warmed `.fleet-stats.json`
  cache with a freshness guard — never the slow `agents doctor` path. Action-required
  rows are now emphasized so items that need you stand out. Source:
  `apps/cli/menubar/Sources/MenubarHelper/LocalState.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`.

- **Projects canonicalization contract.** `agents projects import --from-factory` / `--min-confidence` / `--all` are gone; import is `--from-linear` only, and `~/.agents/factory/projects.json` is never read or migrated. `agents projects list --json` returns definitions only (zero session scan / SSH); `--with-agents` is an explicit opt-in for local active counts. New `agents projects save --json` reads one complete `ProjectDef` from stdin, validates, writes atomically under `~/.agents/projects/`, and prints the saved def. `agents projects rm <name> --json` returns machine-readable success/error. Factory's `managedProjects.ts` shells only through `agents projects list|save|rm` — never reads or writes project YAML/JSON directly, never seeds or migrates legacy Factory state; errors stay explicit for inline UI display. Source: `apps/cli/src/commands/projects.ts`, `apps/cli/src/lib/projects.ts`, `apps/factory/src/core/managedProjects.ts`, `apps/cli/docs/11-projects.md`.

- **`ProjectDef` YAML gains `dispatch` block and `linear.name`.** `~/.agents/projects/<name>.yaml` now accepts a `dispatch:` block (`enabled`, `maxAgents`, `provider`, `host`) that opts a project into auto-dispatch and is read directly by `agents __auto-dispatch` — previously these fields lived only in Factory's own registry. `linear.name` stores the Linear project display name alongside the existing `projectId` and `url`. Both fields are optional; existing YAMLs are unchanged. Source: `apps/cli/src/lib/projects.ts`, `apps/cli/src/lib/auto-dispatch.ts`.

- **`agents secrets` no longer pops a generic "Agents CLI needs to authenticate" Touch ID sheet on every agent launch.** `listBundles` — which runs on essentially every secrets touch (session-title generation, `agents devices list`, every `agents run`, every remote launch that resolves secrets on the host) — could not ask the keychain for just the bundle *metadata* items: with hashed service names (#316) those names are opaque, so it fell back to a **broad `agents-cli.` keychain scan** that also matched the ACL'd secret *value* items. On machines where a bundle carries a biometric ACL (e.g. a `hold`-tier bundle holding an SSN or a password), macOS evaluated that value ACL during the attributes-only scan and raised a **generic, context-less** Touch ID prompt — on every launch, so a busy fleet felt like a machine-wide bombardment. Neither `kSecUseAuthenticationUIFail` nor `LAContext.interactionNotAllowed` can list the no-ACL items while skipping the ACL'd ones (both return nothing), so the fix is to stop doing the broad scan: a per-machine **no-ACL metadata-name index** (opaque hashes only, in the regenerable helpers dir — it leaks nothing #316 didn't) is read as a silent file instead. The write paths keep it current; an absent/stale index self-heals by rebuilding from the one-time scan, and a missing entry only makes `secrets list` cosmetically incomplete — it never affects a resolve-by-name. Your sensitive bundles keep their biometric gate on real value reads; only the bundle *listing* goes silent. Source: `apps/cli/src/lib/secrets/bundles.ts`.

## 1.22.15

- **Separate routine definitions from device activation (#2023).** Enable a routine by listing its name in `~/.agents/devices/<hostname>/agents.yaml`; built-in Watchdog setup and `watchdog on|off` now update that host-owned manifest without rewriting the routine definition. Source: `apps/cli/src/lib/routine-activation.ts`, `apps/cli/src/commands/setup-watchdog.ts`.

- **`agents devices list` no longer shows the "Leased boxes" section by default — it moves behind a new `--all` flag (RUSH-2190).** Loading the section routes through crabbox's bundle auto-detect, which scans the keychain and can raise a macOS Touch ID sheet *after* the device table has printed, hanging non-interactive callers (observed: the `.agents-system` SessionStart topology hook). The default list now renders only registered devices, which are reachable without any secrets; the load/mem/headroom columns are unchanged (the stats probe was already broker-only). `agents devices list --all` restores the section; `--no-stats` remains a hard "instant, no provider calls" opt-out even with `--all`. Source: `apps/cli/src/commands/ssh.ts` (`showLeasedBoxesSection`), `apps/cli/src/commands/ssh.test.ts`.

- **Install: `plugin:` prefix on the unified path (Phase 5 packaging).**
  `agents install plugin:<spec>` uses the same grammar and trust gate as
  `agents plugins install` (`name@url`, local path, `--allow-exec-surfaces`).
  Specialized verbs still work; `agents install` is the one add path for mcp,
  skill, plugin, and GitHub sources. Source: `apps/cli/src/commands/packages.ts`,
  `apps/cli/src/lib/registry.ts`.

## 1.22.14

- **`agents secrets view <bundle> --reveal` now resolves a locked keychain bundle
  interactively at a real terminal.** The command hardcoded `agentOnly: true` on
  both reveal call sites (`commands/secrets.ts`), so an explicit human `--reveal`
  on a locked bundle went through the broker-only path and errored with an unlock
  hint instead of raising the one Touch ID sheet the human just asked for. The
  `agentOnly` flag is now `isHeadlessSecretsContext() || !isInteractiveTerminal()`
  — under an agent (`AGENTS_RUNTIME`) or with no TTY it stays broker-only and
  never prompts, but a deliberate `--reveal` typed at an interactive terminal
  resolves the value with a single biometric sheet. This mirrors the existing
  `reveal && !isInteractiveTerminal()` guard a few lines up. `export --plaintext`
  and `exec` are untouched — they stay intentionally silent for release/CI
  scripts. Source: `apps/cli/src/commands/secrets.ts`.

- **`agents sessions optimize` — compact the FTS5 session search index.** The scanner delete+inserts a session's docs into the `tool_call_text` / `session_text` full-text indexes on every rescan, and FTS5 never merges the resulting segments on its own — so over thousands of sessions the `%_data` shadow tables bloat with hundreds of thousands of unmerged segments (observed on a real fleet box: 701 MB of index for ~69 MB of content, 196K segments) and `agents sessions` slows to a crawl / hangs. The new command runs FTS5 `'optimize'` (merge all segments, purge tombstones), non-destructively — no searchable content is lost. Reclaimed space frees as reusable pages inside the DB file (VACUUM with the daemon stopped returns it to disk); wireable to a weekly routine so the index never re-bloats. Source: `apps/cli/src/lib/session/db.ts` (`optimizeSessionSearchIndex`), `apps/cli/src/commands/sessions-optimize.ts`.

## 1.22.13

- **`agents sessions` accepts direct live-state flags and remains fleet-wide by default.** `--working`, `--idle`, `--waiting`, `--orphan`/`--orphaned`, `--crashed`, `--closed`, `--abandoned`, `--queued`, and `--unknown` each imply the live scan; multiple flags form a union. `--working` is narrower than `--active`: it excludes idle, waiting, and lifecycle-failure rows. Cross-device collection was already the default and stays that way; `--local` opts out, while `--all` continues to widen historical directory and time scope. Source: `apps/cli/src/commands/sessions.ts`, `apps/cli/src/commands/sessions.test.ts`.

- **Workflows: `name@source` disambiguation (Phase 5 packaging).** When two plugins (or a plugin and an extra repo) ship the same workflow name, pin the source: `agents run deploy@ship-tools` or `agents run workflow:deploy@social`. Bare names keep layered precedence (project > user > plugin > extra > system); a missing source returns no match instead of silently falling back. Source: `apps/cli/src/lib/workflows.ts`, `apps/cli/src/lib/resources/workflows.ts`.

## 1.22.12

- Store operational events in daily history directories, retain 7 days and at most 50 MiB automatically, and make `agents logs audit` use the `agents events --audit` reader.

- **`agents cli` renamed to `agents clis`; resource directory `cli/` renamed to `clis/`.** The CLI resource kind and its subdirectory are now plural throughout: `ResourceKind` changes from `'cli'` to `'clis'`, manifests live at `clis/<name>.yaml`, `agents clis` is the only command surface (no `agents cli` alias), and `agents view --clis` replaces `--cli`. A startup migration renames any existing `cli/` directory to `clis/` in the user, system, and project `.agents/` layers; if both `cli/` and `clis/` are present the migration fails with a clear error rather than silently merging. Source: `apps/cli/src/lib/resources.ts`, `apps/cli/src/lib/cli-resources.ts`, `apps/cli/src/commands/cli.ts`, `apps/cli/src/lib/startup/command-registry.ts`, `apps/cli/src/commands/repo.ts`, `apps/cli/src/commands/view.ts`, `apps/cli/src/lib/migrate.ts`.

- **`agents.yaml` no longer silently loses top-level keys across a version-skewed
  fleet.** `serializeCentral` (`lib/state.ts`) rewrote the synced `agents.yaml`
  with a delete-any-key-not-in-the-in-memory-object pass. An **older CLI version
  whose `Meta` type predated a key** (`beta:`, `notify.owner`, `feed:`, imported
  `projects`) would parse the file, never surface that key, delete it on the next
  write, and sync the deletion to every machine — the recurring "my config
  vanished" data-loss (see the restore in commit `04295e3`). The delete pass now
  consults a `Record<keyof Meta, 'central' | 'device'>` scope map (compile-time
  exhaustive — a new `Meta` field that isn't classified fails the build) and
  deletes **only keys this version knows** (a cleared central key, or a device
  key that is legacy cruft in the synced file); a key it doesn't know is
  preserved verbatim. Once a machine runs a CLI carrying this fix, it can never
  drop a newer version's key again. Source: `apps/cli/src/lib/state.ts`,
  `apps/cli/src/lib/__tests__/state.test.ts`.

- **Watchdog files a feed block only when a session genuinely needs the human.**
  When the smart brain concludes a stalled session must be left for the human
  (`needsHuman`), the watchdog now surfaces that on the owner's feed instead of
  dropping it in a menubar-only flag. Two cases: if the session is addressable it
  injects a self-file reminder into the agent ("You appear stuck. File it: `agents
  feed post … --blocked`") so the agent declares its own block; if it is
  un-addressable — the case where the watchdog can't even reach the terminal to
  remind it — the watchdog files a declared block on the agent's behalf so the owner
  is still paged. Paging fires **only** on this confirmed-needs-human path: a plain
  nudge-worthy drive-forward poke (un-addressable or under a hands-off policy) is
  flagged for the tray but never texts the owner. Both paths are gated by the
  existing cooldown ledger (at most once per `WATCHDOG_COOLDOWN_MS` window) and are
  no-ops when a block for the session already exists, so no double-paging. Source:
  `apps/cli/src/lib/watchdog/runner.ts` (`NudgeDecision.needsHuman`,
  `WatchdogTickOptions.publishBlockFn`, the needs-human skip branch),
  `apps/cli/src/lib/watchdog/runner.test.ts`.

## 1.22.11

- **`--blocked` iMessage notifications are now phone-actionable.** The forwarded message dropped the block's `--option`s, `--default`, and timeout and instead showed `agents focus <id>` — a CLI command that is useless on a phone. It now shows the choices (`Options: publish / wait`) and the safe-default fallback (`Default in 15 min: wait`) and omits the `agents focus` line, so a `--blocked` post that carries a `--default` self-resolves when the owner can't reply. Source: `apps/cli/src/lib/feed-broadcast.ts`.

- Move operational event logs from the git-backed `~/.agents/` root into `~/.agents/.history/events/`, including existing numbered gzip archives.

- **`agents projects` is out of beta — no `agents beta enable projects` needed.**
  The command tree (list / add / import / status / link / …) is always registered
  now; `projects` is dropped from the beta registry (`ALL_BETA_FEATURES`,
  `BetaFeatureName`) and the `preAction` beta gate is removed. Any lingering
  `beta.enabled: [projects]` entry is harmlessly ignored, and `agents beta
  enable/disable projects` prints a friendly "graduated out of beta" note and
  no-ops instead of erroring (so old scripts survive). Source:
  `apps/cli/src/lib/beta.ts`, `apps/cli/src/lib/types.ts`,
  `apps/cli/src/commands/beta.ts`, `apps/cli/src/commands/projects.ts`.

- **`agents projects status` shows every project across the whole fleet by default;
  scope it with `--device`/`--devices`.** The old `--fleet` flag is gone — status
  now dials every registered device's workspace (presence, branch, drift) in one
  parallel SSH round without being asked. `--device <name...>` (repeatable) or
  `--devices a,b,c` narrows the fan-out to a subset; with no filter the whole fleet
  is dialled. Reuses the shared `--host`/`--device` target resolution. Source:
  `apps/cli/src/commands/projects.ts`.

- **`scripts/release.sh` home-base hop: pass a single remote argv to `agents ssh`.** Multi-arg forms (`bash -lc '…'`) are joined without re-quoting by `wrapRemoteCommand`, so the remote `cd` never ran and publish failed with `fatal: not a git repository`. One shell string keeps the command intact. Source: `apps/cli/scripts/release.sh`.

## 1.22.10

- **Plugins package workflows (Phase 5 packaging slice).** A plugin’s `workflows/<name>/WORKFLOW.md` is discovered and resolved by `agents run <name>` with precedence project > user > plugin > extra > system — no separate install into `~/.agents/workflows/` required. Plugin inventory / resource groups list `workflows`. Source: `apps/cli/src/lib/workflows.ts`, `apps/cli/src/lib/plugins.ts`, `apps/cli/src/lib/resources/workflows.ts`.

- **`scripts/release.sh` routes the home-base publish hop via `agents ssh`.** Plain `ssh mac-mini` fails host-key checks on headless Linux workers; `agents ssh` uses the devices registry and brokered credentials. Falls back to plain ssh only when `agents` is not on PATH. Source: `apps/cli/scripts/release.sh`.

- **Touch ID is now raised in exactly one place — `agents secrets unlock`.** `agents secrets list`, `agents run <agent>`, `secrets get`/`export`/`view`, and every background read resolve from the secrets broker / durable session / no-ACL layer and never raise a biometric sheet; a locked keychain bundle fails with an actionable "run `agents secrets unlock <bundle>`" hint instead of prompting. The `AGENTS_SECRETS_NO_PROMPT` environment override and the "a human at a TTY, so prompting is fine" heuristic are deleted — the prompt decision is structural, not an ambient env var. The macOS keychain `list`/`list-synced` enumeration queries now pass `kSecUseAuthenticationUISkip` (enumeration itself was evaluating the biometry ACL, so `agents secrets list` prompted and silently dropped keychain bundles when the sheet was cancelled), and the one-time hash-rekey + metadata-ACL heal run only inside the single `unlock` sheet so nothing on the run/list path can storm. Source: `apps/cli/src/lib/secrets/keychain-helper.swift`, `apps/cli/src/lib/secrets/index.ts`, `apps/cli/src/lib/secrets/bundles.ts`, `apps/cli/src/lib/secrets/headless.ts`, `apps/cli/src/commands/secrets.ts`.
- **The Factory VS Code extension (`swarm-ext`) no longer decrypts secrets or shells raw `ssh`.** Device health, reachability, and sync route every remote command through `agents ssh <host>` (broker-owned credentials, no prompt); the extension's own secret-resolution path (`resolveSecret`/`discoverSecretsReadCmd`/`extractCredentials`) is removed, so rendering the devices list never raises Touch ID. Source: `apps/factory/src/vscode/deviceHealth.vscode.ts`, `apps/factory/src/vscode/settings.vscode.ts`, `apps/factory/src/vscode/extension.ts`.

## 1.22.9

- **`agents ssh auto` and `agents teams add --device auto` no longer reject with "Unknown device 'auto'" (RUSH-2185).** The `auto` affinity sentinel was a `run`-only preprocessing step (`applyDeviceAutoToOptions` in `smart-launch.ts`, wired only from `agents run`'s exec path) — every other `--host`/`--device` caller went straight to the shared resolver, which had no idea what `auto` meant and reported it as an unregistered device. `matchHost` (the one core every `--host`/`--device` caller shares) now resolves `auto` directly via the same `resolveDeviceAffinity` engine `run` uses, so `agents ssh`, `agents teams add`, and anything else routed through `matchHost`/`resolveHost` (including the generic `--host`/`--device` passthrough) pick a device the same way. `agents teams add --device auto` landing on the local machine now just runs the teammate locally, matching `run`'s "null pick = local" outcome; `agents ssh auto` refuses a local pick with a clear message instead of self-SSHing, since `agents ssh` exists to dial OUT to a remote box. Source: `apps/cli/src/lib/hosts/registry.ts`, `apps/cli/src/lib/devices/resolve-target.ts`, `apps/cli/src/commands/ssh.ts`, `apps/cli/src/commands/teams.ts`, `apps/cli/docs/00-concepts.md`, `apps/cli/docs/hosts.md`, `apps/cli/docs/teams.md`.

- **`agents harness edit` gains `--auth-provider`, `--fallback-model`, and `--from-secrets`; `add`/`fork` gain an interactive wizard and `--from-secrets`.** `edit` (already shipped with `--model`/`--base-url`/`--version`/`--description`) now also repoints auth at a different keychain-backed provider, sets or clears (`--fallback-model ""`) the same-host fallback model retried on a rate limit, and — like `add`/`fork` — accepts `--from-secrets <bundle>[:<key>]` to copy a value out of an existing `agents secrets` bundle into the harness's own keychain item once, instead of retyping a key already stored elsewhere (the item it writes to, `agents-cli.<provider>.token`, is never gated behind the biometry-required prefixes, so later reads stay silent). `agents harness add`/`fork` now accept `[name]`/`[source] [name]` as optional positionals — run either with insufficient flags in an interactive terminal and a picker (fork from a native host or existing harness → a built-in preset or "build custom" → the harness's name, pre-filled with the preset's own name → how to get the key) replaces the old hard error; flags remain fully supported for scripts, and a non-interactive shell still gets the original error. Source: `apps/cli/src/commands/harness.ts`, `apps/cli/src/commands/profiles.ts`, `apps/cli/docs/profiles.md`.

- **`agents run --lease` is reuse-first against the crabbox profile pool, with a
  `--fresh` opt-out.** A bare `--lease` used to always lease a brand-new box, so
  bursts of runs (e.g. resumed sessions) stacked up idle `keep=true` boxes at
  full monthly cost. Now, before warming a new box, the run looks for a warm box
  carrying the same `profile` label the warmup would use (read from the repo's
  `.crabbox.yaml`, matching `scripts/sandbox.sh`'s `pick_ready_box`) and the same
  network mode — a tailnet box is never handed to a public run or vice versa —
  and reuses the first one `crabbox status` reports SSH-ready, keeping it after
  the run. A not-ready pool box is skipped, never stopped. `--fresh` forces the
  old behavior (brand-new box, torn down after the run); `--box <slug>` is
  unchanged. Source: `apps/cli/src/lib/crabbox/lease.ts`,
  `apps/cli/src/lib/crabbox/cli.ts`, `apps/cli/src/lib/crabbox/config.ts`,
  `apps/cli/src/commands/exec.ts`.

- **The menu bar now notices and reports when the scheduler dies — instead of
  staying silent forever.** The only proactive "routines overdue / scheduler
  down" signal was `notifyOverdue` (`src/lib/overdue.ts`), fired from inside
  `runDaemon()` — so it could never fire while the daemon itself was down, the
  exact outage it exists to report. `MenubarHelper` is a separate launchd
  KeepAlive service that stays alive when the daemon dies, so its 10s tick now
  polls daemon liveness independently of the dropdown ever being opened; once
  it has been continuously unreachable for ~30s (debounced past a routine
  restart blip), it fires one native notification ("Scheduler stopped —
  routines won't run") through its own `NSUserNotificationCenter` delivery —
  no daemon, no CLI spawn required — and lights the always-visible menu-bar
  badge (`⏻`) until the scheduler comes back. Source:
  `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`.

- **Observe umbrella aliases: `inbox`, `timeline`, `roster` (Phase 3 surface consolidation).**
  Thin doors onto existing readers (no store merge): `agents inbox` ≡ `feed`,
  `agents timeline` ≡ `feed --filter updates`, `agents roster` ≡ `sessions --active`.
  Root help gains an Observe section; `agents audit` stays the tamper-evident run
  log (not an events alias). Source: `apps/cli/src/lib/observe-aliases.ts`,
  `apps/cli/src/commands/feed.ts`, `apps/cli/src/commands/sessions.ts`.

- **Daemon usage refresh is a fixed 5-minute per-host schedule, concurrency-safe, and Touch-ID-free.**
  Each machine's daemon still owns its own usage cache (no fleet-wide store). Account live
  fetches are now scheduled every **5 minutes** (was adaptive 90s–15m), with a 60s wake to
  notice due accounts after backoff ends. Cache writes use a file lock + atomic rename so a
  concurrent `agents view` background refresh cannot tear or drop rows. The daemon path
  loads Claude credentials with **`fileOnly`** (setup-token / no-ACL cache / `.credentials.json`
  only) and never opens the ACL-bound macOS keychain item, so a background tick cannot pop
  Touch ID. Refresh still skips a provider under 429 backoff and still never rotates
  single-use Claude refresh tokens.

## 1.22.8

- **`agents browser` now gates cross-machine drives behind per-device consent.** `agents browser <cmd> --host <device>` already routes a browser command to another fleet machine over SSH and drives its browser — but nothing asked that machine's permission, so any box you could SSH to, you could drive. A new device-local `browser.remote-control` setting (off by default, never synced) fixes that: a fleet-remote `browser --host <this-machine> start` is refused with an actionable message until the owner runs `agents browser remote-control on` here. Local starts (no `--host`) are never gated. The fleet passthrough marks every `--host` dispatch with `AGENTS_FLEET_REMOTE` so the far side can tell a cross-machine drive from a local one. New command: `agents browser remote-control [on|off]` (no arg prints status; `--json` supported). Source: `apps/cli/src/lib/browser/remote-control.ts`, `apps/cli/src/commands/browser.ts`, `apps/cli/src/lib/hosts/passthrough.ts`, `apps/cli/src/lib/device-config.ts`, `apps/cli/docs/browser.md`.

- **`agents browser` tasks are now attributed to the caller that ran `start`, not
  to the browser daemon.** `Task.owner` (RUSH-2020) was resolved with
  `resolveActor()` *inside* the shared, long-lived browser daemon, so every task —
  no matter which agent or person opened it — was stamped with the identity of
  whoever happened to start the daemon. The caller's identity is now forwarded over
  IPC: the CLI (the caller's own process) puts `actor` (`resolveActor().id`) and
  `launchId` (`$AGENT_LAUNCH_ID`, the per-run id `exec.ts` injects for every harness)
  on the `start` request, and the daemon stamps exactly those. Adds `Task.launchId` —
  which run created a task — the scope a later `browser status --mine` and the
  no-flag current-task default will filter on. Source:
  `apps/cli/src/lib/browser/types.ts`, `apps/cli/src/lib/browser/service.ts`,
  `apps/cli/src/lib/browser/ipc.ts`, `apps/cli/src/commands/browser.ts`.

- **`agents harness edit` and `agents harness rename` are now real commands.** `editProfile` and `renameProfile` already existed in `lib/profiles.ts` but nothing on the CLI surface reached them, so changing a custom harness meant hand-editing its YAML. `agents harness edit <name>` applies `--model`, `--base-url`, `--version`, and `--description` in place, preserving fork lineage (an edit never marks a harness as forked from itself). `agents harness rename <name> <new-name>` renames the YAML file and its `name` field, and rewrites `forkedFrom` on every harness that pointed at the old name so the fork graph stays accurate. There is deliberately no `--label`: the header `agents view` prints is derived from the harness name, so renaming is how you change it.

- **Run-time messages call a custom harness a "custom harness", not a "profile".** When you `agents run <name>` a custom harness (created with `agents harness add`), the CLI now says `Resolved custom harness '<name>'` and, for a discarded cost tier, `cost tiers don't apply to custom harness '<name>'` — instead of the legacy internal noun "profile". The `--strategy` and account-picker notices on a custom-harness run are aligned too. Behavior is unchanged; the legacy `agents profiles` alias still works. Source: `apps/cli/src/commands/exec.ts`.

- **Placement model + `agents run --where` (Phase 2 surface consolidation).**
  "Where does the body run?" is one shared object (`local | device | fleet | cloud | lease`)
  in `src/lib/placement.ts`. `agents run --where device:<name>|auto|lease[:backend]|local`
  expands into the existing `--host` / `--lease` paths; mixing doors fails loud. Docs
  (`00-concepts.md` § Placement, `hosts.md`) and help on run / routines / monitors teach
  the matrix — including that monitors `--device` is **owner**, not body placement.
  Old flags remain aliases. Source: `apps/cli/src/lib/placement.ts`, `apps/cli/src/commands/exec.ts`.

- **`agents harness fork` no longer accepts `--label` (breaking change).** The `--label` flag was used to set a human-facing display name for a custom harness. Display names are now always derived from the profile's `name` via a curated vendor/brand table (`deepseek-flash` → `DeepSeek Flash`, `spark` → `Spark`), so the flag is superfluous. Any script that passes `--label` to `agents harness fork` will receive a CLI error; remove the flag to migrate.

- **`agents run` no longer auto-picks an account whose token the server has already rejected.** Account rotation judged an account "signed in" from a local heuristic — a credential file is present and its email decodes — which cannot tell a good token from a revoked-but-unexpired one, so `balanced`/`available`/`run auto` could route into a `revoked` account and die at spawn ("session expired"). Eligibility now also reads the daemon's live auth-health probe (`auth-health.ts`): a `revoked` (401/403) account is excluded from the pick, reported as `revoked` by the pre-flight readiness check, shown as "needs re-login" in the account picker, and named in the teams throttle warning. Fail-open: a missing probe or any non-revoked verdict never blocks a launch (a cached `revoked` keeps gating until the daemon's next probe clears it). Source: `apps/cli/src/lib/rotate.ts`, `apps/cli/src/commands/run-account-picker.ts`, `apps/cli/src/commands/teams.ts`, `apps/cli/docs/hosts.md`.

- **Scheduled routines no longer overlap or outlive their configured timeout (RUSH-2186).** Detached cron, catchup, and monitor launches now take a cross-process per-routine claim and refuse a second fire while the prior run is alive. The configured deadline is persisted in run metadata; both the live runner and the restart-recovery monitor kill the owned process tree and record `timeout` when it expires. Source: `apps/cli/src/lib/runner.ts`, `apps/cli/src/lib/routines.ts`, `apps/cli/docs/03-routines.md`.

- **`agents snapshot` — one-process poll for inventory + active sessions (Phase 4 surface consolidation).**
  Consumers (Factory, scripts, menubar) were forking `view --json` × N harnesses plus
  `sessions --active --json` (and sometimes feed) on every tick. `agents snapshot --json`
  returns the same shapes in one invocation: `inventory` (view), `sessions` (active rows),
  optional `--with-feed` / `--with-sync`. Default sessions scope is this machine; `--all-hosts`
  matches full `sessions --active` fan-out. Does **not** redefine `agents status`, which stays
  the UnifiedSyncStatus sync contract. Source: `apps/cli/src/commands/snapshot.ts`,
  `apps/cli/src/lib/snapshot.ts`.

## 1.22.7

- **`agents feed --project <name>` scopes the whole feed to one project.** Open
  blocks, the updates view (`--filter updates`), and the trailing activity lane
  are all filtered to the requested repo/project using the same worktree-aware
  project key as `agents perf` (`lib/project-key.ts`). The masthead becomes
  `<project> needs you` / `<project> updates`. Filtering is applied locally after
  the fleet fan-out, so older peers that do not recognize `--project` still
  contribute correctly. Source: `apps/cli/src/commands/feed.ts`,
  `apps/cli/src/lib/feed-ranking.ts`.

- **Feed blocks are now stamped with their project.** The `feed-publish` hook
  derives project from the session cwd, and `agents feed post --blocked` stamps it
  on the declared block. Live-session enrichment backfills `project` onto older
  blocks that lack it. Source: `apps/cli/src/lib/feed.ts`,
  `apps/cli/src/lib/feed-outcome.ts`, `apps/cli/src/lib/session/active.ts`.

- **`agents activity` is removed.** The standalone milestone timeline is gone;
  its stream is now read through `agents feed --filter all` (blocks + updates) or
  `agents feed --filter updates` (updates only). `activity --project <name>` is
  replaced by `feed --project <name>`. Source: `apps/cli/src/index.ts`,
  `apps/cli/src/startup/command-registry.ts`, `apps/cli/src/commands/activity.ts`
  (deleted), `apps/cli/docs/06-observability.md`,
  `apps/cli/docs/11-projects.md`.

- **`agents browser start` no longer fails with "Custom binary not found" when the `default` profile came from another OS.** `~/.agents/agents.yaml` syncs across the fleet, so a `default` profile auto-created on macOS carried a `/Applications/Google Chrome.app/...` binary path that doesn't exist on a Linux box — a bare `browser start` there died with `Custom binary not found`, the top browser roadblock (one session burned six commands working around it). `ensureDefaultBrowserProfile` now validates that the resolved default can actually launch on THIS machine and, if its browser/binary is missing, regenerates the `default` from the installed-browser auto-detect instead of handing back the broken profile. A configured default (`profiles set-default`) that can't launch here warns and falls through to auto-detect; remote (`ssh://`) defaults skip the local binary check since their browser lives on the far host. Source: `apps/cli/src/lib/browser/profiles.ts`, `apps/cli/docs/browser.md`.

- **The stray "Agents CLI needs to authenticate to continue" Touch ID sheet now actually heals on an already-hashed machine (SEC-13/#1938 follow-up).** 1.22.5 added a one-time no-ACL re-store for a stale-ACL'd `agents-cli.hmackey` item — the internal HMAC key read *before every hashed keychain lookup*, whose damaged copy pops a generic, context-less Touch ID sheet on nearly any command that touches secrets. But it wired the heal only into `maybeAutoRekey`, which is bypassed for the hmackey and hashed-name lookups themselves (`prepareServiceName` returns early for `HMAC_KEY_ITEM` before `maybeAutoRekey` runs). So the exact hot paths that read the key — the `agents devices list` stats probe a SessionStart hook runs, and every background hashed read — never triggered the heal, and an already-migrated machine prompted forever. The documented `agents secrets rekey` remedy is also a no-op on such a machine: with no cleartext names left to re-key, it returns without re-storing the key. The heal now runs on the read path itself (`readHmacKeyRecord`): the first hashed lookup in the first process re-stores the record no-ACL exactly once (guarded by `healedNoAcl`, so it never churns the keychain afterward) — one last prompt on the read that heals it, then silent forever, on every path. Source: `apps/cli/src/lib/secrets/index.ts`.

- **Add Pi (Oh My Pi, `omp`) as a native harness.** agents-cli now installs, runs, and
  syncs resources for [Oh My Pi](https://omp.sh) (`@oh-my-pi/pi-coding-agent`, binary
  `omp`) under id `pi`. Pi is a Bun-based, terminal-first, multi-provider coding agent;
  its cross-provider model catalog (OpenRouter, OpenAI, Anthropic, xAI, DeepSeek, …)
  surfaces in `agents view` and `agents models pi` via `omp models --json`. It is
  Claude-compatible: MCP (`.mcp.json`, stdio + http + headers), skills, file commands, and
  Claude-shaped subagents all sync into `~/.omp/agent/`. Hooks, allowlist, and plugins are
  intentionally off (omp's hook/approval/plugin models don't map to agents-cli's).
  Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/exec.ts`, `apps/cli/src/lib/models.ts`.

- **`agents run <profile> --model <tier>` now resolves the cost tier against the profile's own harness, not its host's.** A custom-harness profile (e.g. a DeepSeek model routed through the `claude` host binary) resolved a tier token (`cheap|default|best|ultra`) by calling `resolveTier(options.agent, ...)` with `options.agent` already overwritten to the HOST agent's id — so `best` resolved against Claude's own catalog and could push a real Claude model id as the `--model` flag, clobbering the profile's own `ANTHROPIC_MODEL` env value. Profiles can now declare a `models:` block (per-tier model ids for the harness's own catalog); a requested tier resolves against it first — clamping an unset tier down to the next cheaper one that IS set — and the concrete id is substituted into both the env and the forwarded `--model` value before exec.ts's native (host-catalog) tier logic ever runs. A profile with no `models:` configured degrades gracefully to today's behavior — the harness's single pinned model, with an informational note instead of an error. Source: `apps/cli/src/lib/profiles.ts`, `apps/cli/src/commands/exec.ts`.

- **`agents projects status` card: host-grouped agents, focus units, and a warnings footer.** Live agents render under `@host` rows so the same harness on two machines is not collapsed into one cell. Focus counts are labeled `file-touches (Nd)` instead of bare integers. Repo drift, dirty trees, missing checkouts, slug mismatch, unmeasurable schedule, and crash piles land at the bottom with 🔴 critical / ⚠️ continue. Local workspace probe always feeds the footer (full fleet table still requires `--fleet`). Source: `apps/cli/src/lib/project-status.ts`, `project-focus.ts`, `project-probe.ts`, `commands/projects.ts`.

- **`agents projects status` and `view`/`show` share one body.** Named form is the full card (every milestone + definition); unnamed is the multi-project rollup. No second implementation to drift. Source: `apps/cli/src/commands/projects.ts`.

- **`agents sessions --help` and `05-sessions.md` now teach one session-lifecycle
  matrix.** `focus` / `focus --attach-only` / `detach` / `attach` / `resume` are
  listed as distinct intents (not synonyms), so operators stop guessing among
  `go` / `focus` / `attach` / `resume`. Source: `apps/cli/src/commands/sessions.ts`,
  `apps/cli/src/commands/focus.ts`, `apps/cli/docs/05-sessions.md`.

- **Cost tiers are ignored (with a clear warning) for profile runs.** A profile's model comes from its endpoint (e.g. Kimi/DeepSeek/GLM via `agents run <profile>`), not the host harness's catalog — so passing `--model cheap|default|best|ultra` to a profile used to resolve against the *host* harness and forward an incompatible model id to the profile's endpoint. Now a tier on a profile run is discarded with a standout warning and the profile's configured model is used. Concrete `--model <id>` on a profile is unchanged. Source: `apps/cli/src/commands/exec.ts`.

- **`agents view` harness rows now lead with the version number.** Custom harness rows previously showed `via <host> <version>` — the host CLI name came first, which buried the version in the middle of the line. The format is now `<version> (forked from <host>)` for pinned harnesses and `<version> (forked from <host>, tracks default)` for unpinned ones that follow the host's global default. The `tracks default` label is shown in green so it stands out at a glance.

- **Chained fork lineage in harness headers.** When a custom harness is itself a fork of another custom harness (which in turn forks a native host), the block header now shows the full two-hop chain: `custom · forked from <intermediate> -> <native-host>`. Single-hop forks continue to show `custom · forked from <parent>`.

- **BYOK budget bar in `agents view`.** Custom harnesses backed by an OpenRouter key now show a live spend bar (amount used, remaining, and limit) inline on the model/auth row. Keys are deduplicated so multiple harnesses sharing the same keychain entry trigger exactly one API call. The bar is rendered only when a budget is available; harnesses without a BYOK key are unaffected. Source: `apps/cli/src/lib/byok-usage.ts`, `apps/cli/src/commands/view.ts`.

- **`agents run auto` with no prompt no longer silently attaches a dead pane or leaves an orphan session (RUSH-2185 / EXEC-23a).** Three latent bugs combined to produce this failure when `auto` picked a harness like `cursor-agent` that exits immediately without a prompt: (F1) the auto-picker had no gate for whether a harness can open a bare interactive REPL — `cursor-agent` was a valid candidate even though its CLI requires a prompt and exits on `argv = []`; (F2) `surfacePaneFailure` was guarded by `status !== 0`, so a clean exit-0 death produced only a bare `[detached]` line with no diagnostic; (F3) the "pane still alive → keep session" fall-through relied on `paneExitStatus` returning `{dead:false}`, which it also returns on any query error (a race right after the pane-died hook), leaving the session alive as an orphan. Fixed: (F1) a new `interactiveRepl` capability bit in `AgentConfig.capabilities` marks every harness; `auto` now filters to REPL-capable candidates before picking, and fails loud naming the installed harnesses when none qualify; (F2) `shouldRecapDeadPane(status, interactive)` surfaces the pane tail any time the run is interactive, regardless of exit code; (F3) `isPaneKnownAliveFromQueryResult(code, stdout)` is now required as positive proof before keeping a session — an ambiguous result tears the session down via `killSession` instead. Source: `apps/cli/src/lib/exec.ts`, `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/types.ts`, `apps/cli/src/lib/capabilities.ts`, `apps/cli/src/commands/exec.ts`, `apps/cli/docs/specifications.md` (EXEC-23a).

- **`agents run auto` can pick the Pi (`omp`) harness for prompt-less interactive runs again, and `main` builds green.** The `interactiveRepl` capability bit added by the RUSH-2185 / EXEC-23a fix landed at the same time as the new Pi harness, and neither change saw the other — so `pi` was the one agent in `AGENTS` that never declared the bit, and the completeness test that pins the registry to the capability list went red on `main` (`pi missing interactiveRepl`). Pi now declares `interactiveRepl: true`: bare `omp` runs the TUI, and `omp -p` is the one-shot form that answers a prompt and exits.

- **`projects status --fleet` no longer labels this box `@local`.** Local sessions from `getActiveSessions()` lacked `machine`; host-grouped agents stamped remotes only. Locals are now filled with `machineId()` before rollup so the agents roster and fleet lines agree. Source: `apps/cli/src/lib/project-status.ts`, `commands/projects.ts`.

- **`agents sessions stats` — which skills/commands you actually invoke, and which are dead weight.** A cheap, db-backed rollup of `session_resource_usage` (the skill/`Skill`-tool + slash-command tallies already recorded at index time), joined to `sessions` for attribution so `--agent`/`--project`/`--since`/`--machine` narrow the window and `--kind`/`--plugin` narrow the resources. A both-ends view: the most-invoked resources (`--bottom` flips to least-invoked, `--top <n>` caps), and the installed-but-never-invoked ones (cross-referenced against `listResources`/`discoverPlugins`) — the productized form of a manual transcript-scan audit. `--json` emits a versioned `sessions-stats` envelope. The signal captures EXPLICIT invocations only (slash commands + `Skill` tool calls) — an auto-triggered skill emits no event and reads as 0, and only Claude transcripts expose the signal today; both caveats are surfaced in help and output. A new `agents sessions backfill resources` folds historical sessions (indexed before the signal shipped) into the usage index, re-parsing each transcript from byte 0, gated by a new `resource_scan_ledger` (schema v31) so reruns skip completed transcripts — mirroring `agents sessions backfill tools`. Source: `apps/cli/src/commands/sessions-stats.ts`, `apps/cli/src/commands/sessions-backfill.ts`, `apps/cli/src/lib/session/db.ts`, `apps/cli/docs/05-sessions.md`, `apps/cli/docs/specifications.md` (SES-IF-4b).

- **`agents share` serves screenshots and recordings with a real content-type.**
  Publishing a PNG/JPEG/GIF/WebP/AVIF image, an MP4/MOV/WebM video, or a PDF now
  sets the matching `content-type` instead of `application/octet-stream`. GitHub's
  image proxy (camo) only renders an inline `![](url)` when the asset is served as
  a real image/video type, so this is what lets an agent drop a screenshot or a
  screen recording straight into a PR body via `agents share <file>`. HTML, SVG,
  CSS, JS, JSON, and text were already typed correctly. Source:
  `apps/cli/src/lib/share/publish.ts`.

- **`agents trends tools-per-session` now counts every scanned session, not just `agents teams`
  runs.** The recipe read `sessions.tool_call_count`, a column nothing populates except the
  teams summarizer (`apps/cli/src/lib/teams/summarizer.ts`) — the general session indexer never
  computes it. So every session that did not come from a team was scored 0 or excluded outright
  by `WHERE tool_call_count IS NOT NULL`, pinning the fleet-wide p50 at 0 however many tools ran
  and leaving only `claude` in the table. It now reads `tool_scan_ledger.call_count`, the
  per-session count the tool indexer writes for every session it scans — the same index behind
  `agents sessions --include tools`, so the two surfaces stop disagreeing. Sessions with
  genuinely zero tool calls still count as 0 instead of vanishing. On a real 7-day window this
  took the sample from 400 to 570 sessions and surfaced `grok`, `rush`, `codex`, `kimi`,
  `droid` and `antigravity`, none of which had ever appeared. Run `agents sessions backfill
  tools` once if historical sessions were never indexed. Source:
  `apps/cli/src/lib/analytics/recipes.ts`.

## 1.22.5

- **`agents events` can now filter by `--session <id>` and `--bundle <name>` — trace which agent/session triggered a secret access.** Every event already carries the provenance `sessionId`, and secrets events carry the `bundle` in their payload, but neither was queryable: you could see *that* the `share` bundle was read, not *which session* read it. `--session` (wired to the engine's existing `sessionId` filter) and `--bundle` (a new payload filter across both the operational log and the activity stream) close that gap. `agents events --module secrets --bundle share --session <id>` answers "which agent read the share bundle" — the attribution the Touch ID storm investigation needed, since the macOS biometric sheet itself emits no event. Source: `apps/cli/src/lib/event-stream.ts`, `apps/cli/src/commands/events.ts`, `apps/cli/docs/06-observability.md`.

- **`agents feed post --blocked` records now survive the agent's next Stop.** The feed-publish hook cleared the per-session block file on every `Stop`/`SessionEnd`/`PostToolUse`, which silently dropped a declared (`--blocked`) block the moment the agent parked it and its turn ended — exactly when the owner still needs to see and answer it. Declared blocks are now exempt from the lifecycle clear and stay in `agents feed` until they are actually answered (a terminal reply or `recordAnswer`); question/notification/approval blocks still clear as before. Source: `apps/cli/src/lib/feed.ts`.

- **`agents add grok@latest` no longer lets a second grok account silently displace a first account's install.** Grok's version directories are keyed by upstream release number alone, not by account — so two different grok accounts that both self-update to the same identical release ("latest") were landing on the SAME on-disk `versions/grok/<version>/` directory. The second account's credentials would overwrite the first's in that shared directory, even though `agents view grok` still listed both accounts as separately installed. `installVersion` now detects this before finalizing the install: if the target version's home already has a signed-in account whose identity differs from the account driving the current update, it refuses with a clear error instead of silently corrupting the first account's install. Source: `apps/cli/src/lib/versions.ts`.

- **The stray "Agents CLI needs to authenticate to continue" Touch ID sheet now heals itself.** An old keychain helper (before the metadata/hmackey no-ACL migration fix) could re-stamp the internal HMAC-key item (`agents-cli.hmackey`) with a biometry ACL. That item is read *before every hashed keychain lookup*, so a damaged copy popped a generic, context-less Touch ID sheet on nearly any command that touched secrets — `agents devices list`, a background agent, a session hook — at seemingly random times. The migration fix stopped the re-stamping but never un-stamped an already-damaged item, and once hashed naming is active nothing re-stored it, so it prompted forever. Now, on the first read where hashing is active, an un-healed HMAC-key record is re-stored no-ACL exactly once (`healHmacKeyNoAclOnce`, gated by a `healedNoAcl` flag so it never churns the keychain afterward) — one last prompt on the read that heals it, then silent. Existing damaged machines can also fix it immediately with `agents secrets rekey`. Source: `apps/cli/src/lib/secrets/index.ts`.

- **`agents inspect` and `view --json` now report isolation honestly.** Found by diffing
  every command's output between an isolated-only and a normal install. `inspect` printed
  the bare-shim path unconditionally, so an isolated copy — which deliberately has no
  shim, that being the guarantee — was shown sitting on the user's PATH; it now reports
  `(none — isolated installs stay off PATH)` and `shim: null` in JSON. `inspect` also
  showed only `default: false` for an isolated copy, hiding that it *was* the selected
  one; it now carries `isolated` and `isolatedDefault`, and the header reads
  `[isolated default]`. `view --json` had no isolation signal at all, so tooling could not
  distinguish a sandboxed copy from one that owns the launcher and real config — its
  version entries gain `isolated` and `isIsolatedDefault`. Source:
  `apps/cli/src/commands/inspect.ts`, `apps/cli/src/commands/view.ts`.

- **`agents models` is now a scannable tier menu, and you can override a tier with a command.** The tier map (`cheap|default|best|ultra` → model + `~$/Mtok`) prints for every installed harness by default; the raw model list moved behind `--all`. When the auto-guess is wrong (subscription harnesses with no price signal), pin the right model without hand-editing YAML: `agents models tier set <agent[@version]> <tier> <model>` (e.g. `agents models tier set kimi best kimi-code/k3`), `tier clear`, `tier list`. Overrides live under `model.tiers` in `agents.yaml` (same selector shape as `run.defaults`) and resolve most-specific-first — `<agent>:<version>` → `<agent>:*` → auto; an overridden id a version doesn't ship falls back to auto, and `agents models` marks a pinned tier `[override]`. Ships a curated Kimi ladder (`k2.7-highspeed` < `k2.7-coding` < `k3`) so it's right by default. Also fixes two extraction bugs: bumps the model-catalog cache schema so a freshly-upgraded box re-extracts instead of serving a stale "No models extracted" for 24h, and stops the id-scan from listing bare legacy ids like `claude-opus-4` (#1892). Source: `apps/cli/src/lib/model-tier-overrides.ts`, `apps/cli/src/lib/model-tiers.ts`, `apps/cli/src/commands/models.ts`, `apps/cli/src/lib/models.ts`, `apps/cli/docs/model-tiers.md`.

- **`agents run --secrets <bundle>` never raises a Touch ID sheet on launch — even with a tty (a second storm source).** The `--secrets` injection read gated on `isHeadlessSecretsContext()`, which is FALSE for an interactive run — so an `agents run … --interactive` launch (the watchdog fires `agents run auto --interactive` every ~2 min via routine + menu-bar tick) could pop Touch ID for a keychain `hold` bundle, piling up helper sheets. An agent launch must never prompt regardless of tty (SEC-13): the read is now always `agentOnly` — it resolves from the broker (or a no-ACL bundle) and otherwise fails fast naming `agents secrets unlock <bundle>`, matching the behavior the code's own comment already described. Unchanged: the explicit `agents share` / `agents share setup` commands (`readWriteTokenFromBundle`, `readCloudflareCreds`) still honor the interactive/headless gate — those are user-initiated, not agent launches. Source: `apps/cli/src/commands/exec.ts`.

- **Background and read-only secret reads never raise Touch ID (SEC-13).** Every non-user-initiated secret read now resolves `agentOnly` — from the secrets broker or a no-ACL bundle — and, on a locked `hold`/`always` keychain bundle, fails fast naming `agents secrets unlock <bundle>` instead of popping a Touch ID sheet on the interactive launcher. This closes the rest of the per-launch prompt storm that #1905 fixed only for `--secrets` injection. Covered: session-sync (`r2.backups`, read on every daemon cycle — degrades to no-transport when locked, re-checked each cycle for fast pickup once unlocked), the `--lease` crabbox provider token (resolved once up front and memoized, so a locked bundle fails loud once and the ready-wait poll never re-issues the read), browser-profile secrets on launch (skipped silently, launch proceeds), cloud dispatch (`cloud:antigravity`, fails loud with the unlock hint), the `webhook serve` receiver, and the `get_secret` MCP tool (throws as the tool error). Unchanged and still interactive-gated: the user-initiated `agents secrets get/export`, `agents browser type`, `agents exec --secrets`, the `ssh` askpass, and the explicit `agents share` / `agents share setup` provisioning reads — a human running those in a plain terminal still gets a prompt. Source: `apps/cli/src/lib/session/sync/config.ts`, `apps/cli/src/lib/crabbox/cli.ts`, `apps/cli/src/lib/browser/chrome.ts`, `apps/cli/src/lib/cloud/antigravity.ts`, `apps/cli/src/lib/secrets/mcp.ts`, `apps/cli/src/commands/webhook.ts`.

## 1.22.4

- **Background processes no longer storm macOS Touch ID sheets (secrets-touchid-storm).**
  Raw keychain item reads — a profile's provider token on `agents run <profile>`,
  the Claude OAuth read behind `agents view`, any `getKeychainToken` caller — now
  fail fast with an actionable error naming the item when the process is
  non-interactive (an agent runtime, or a TTY-less background spawn like the
  Factory extension host's `agents view` poll), instead of raising a sheet nobody
  is watching. A cancelled or failed interactive read opens a 5-minute back-off
  memo (`~/.agents/.cache/keychain-read-backoff/`) so a polling caller can't
  re-prompt every few seconds; any successful read or write clears it. Reads that
  are prompt-free by construction (bundle metadata, `never`-policy bundles, the
  unlock session store, the OAuth token cache) attest their no-ACL write and are
  unaffected. crabbox's tailscale key is now read at most once per process
  instead of on every `crabboxEnv` call (list/wait/spawn/stop). Source:
  `apps/cli/src/lib/secrets/index.ts`, `apps/cli/src/lib/secrets/headless.ts`,
  `apps/cli/src/lib/secrets/read-backoff.ts`,
  `apps/cli/src/lib/secrets/bundles.ts`, `apps/cli/src/lib/crabbox/cli.ts`,
  `apps/cli/docs/specifications.md` (SEC-13, SEC-27).

## 1.22.3

- **Menubar home-base self-test accepts `MenubarHelper-universal`.** The
  signed-helper gate required `executablePath` to end in exactly `MenubarHelper`,
  but lipo production builds name the binary `MenubarHelper-universal`, so every
  1.22.2 publish on mac-mini failed after the release PR had already merged and
  tagged. Source: `menubar/Sources/MenubarHelper/ChildProcessSelfTest.swift`.

## 1.22.2

- **Menu bar recovers from a stale single-instance lock instead of staying dead.**
  The helper's lock fd is now opened `O_CLOEXEC`, so a spawned `doctor` child can
  never inherit it and hold the `menubar.lock` flock after the helper crashes; and
  `SingleInstance.acquire` now self-heals — when the flock is held but no live
  `MenubarHelper` owns it (a leaked orphan / dead pid), it reaps the orphan and
  retries rather than exiting as "already running". Previously a leaked orphan
  bricked the menu bar until reboot. The headless Swift self-tests (single-instance
  + child-process) now run as a build gate (`menubar/scripts/test-menubar.sh`),
  which nothing invoked before. Source: `apps/cli/menubar/Sources/MenubarHelper/SingleInstance.swift`.

- **`agents projects` definitions can now carry goals — the OKR-shaped "why".**
  A project serves one or more `goals[]`, each an `objective` (the outcome) plus an
  optional `measure` (the key result). Set them at scaffold time with
  `agents projects add <name> --goal "objective:measure"` (repeatable), replace them
  later with `agents projects set <name> --goal …`, or hand-edit the YAML. Goals show
  on the `status` card (compact) and in `projects view` (in full), and survive a
  `--from-linear` re-import like every other hand-set field. Milestones (pulled from
  Linear) remain the dated checkpoints toward these goals. Source:
  `apps/cli/src/lib/projects.ts`, `apps/cli/src/commands/projects.ts`.

- **Balanced rotation no longer picks version homes that only inherit the active login.**
  `getAccountInfo` falls back to the active/global HOME credential so `agents view`
  still shows who is signed in when a version home has no auth file of its own.
  Launch paths isolate config (`GROK_HOME`, `CODEX_HOME`, …) to the per-version home,
  so those empty homes died at spawn with "Not signed in" after balanced picked them
  (observed: `grok@0.2.118` with no `auth.json` looking signed-in via `~/.grok` →
  `0.2.32`). Rotation now requires a real per-version credential when we know where
  it lives (`credentialPresence.perVersion`). Source: `src/lib/rotate.ts`
  (`isLaunchableSignedIn`, `collectRunCandidates`).

- **A `never`-policy secrets bundle now actually stays silent — no more Touch ID for a bundle you set to silent, and no more double prompt.** Two bugs made `agents secrets policy <b> never` a lie. (1) The command rewrote only the bundle *metadata*, never the value items — but macOS gates each read on the item's own ACL, not the tier label, so a bundle created under `hold`/`always` kept its biometry ACL and kept popping Touch ID forever after the switch. `policy` now reconciles the value items to the new tier (`reAclBundleItems`): tightening to `never` re-stores them no-ACL (a single last prompt to read them once), and loosening back re-attaches the gate. (2) The signed keychain helper's just-in-time migration (`migrateInline`/`rehomeOrphan`) re-stamped a biometry ACL onto *every* `agents-cli.*` item it touched on read — including bundle metadata and the HMAC key, which are supposed to be silent — so a metadata/hmackey read in its own helper process raised a *second* Touch ID sheet on top of the value read. The migration now re-adds silent items (metadata, hmackey) without an ACL, so metadata enumeration and the pre-value hmackey read never prompt. Net: unlock/read a `never` bundle once and it stays silent through sleep, reboot, 30+ days, an agents-cli upgrade, and a macOS upgrade — with no Touch ID and no passphrase. The `never` tier's durability and attribution guarantees are now written into the `§Secrets` spec (SEC-19, SEC-27, SEC-28). Source: `apps/cli/src/commands/secrets.ts`, `apps/cli/src/lib/secrets/bundles.ts`, `apps/cli/src/lib/secrets/keychain-helper.swift`, `apps/cli/docs/specifications.md`.

- **The per-run Touch ID storm is fixed: `agents run` no longer pops a sheet to auto-inject the share token.** On every `agents run`, `shareRuntimeEnv` auto-reads the `share` bundle's R2 write token to hand it to the spawned agent — and because `share` is a keychain bundle that is rarely broker-held, an interactive read spawned the helper and raised Touch ID on EVERY launch. Auto-injecting a token on an agent launch is a background convenience, not a user-initiated secret access, so it must never raise a sheet (SEC-13): the read is now always `agentOnly` — it resolves the token from the injected env or an already-held / no-ACL bundle and silently returns nothing otherwise (the agent can still publish via its own explicit `agents share`). And a NEW `share` bundle now defaults to the `never` tier (no biometry ACL) — the write token is low-sensitivity automation infra — so auto-share is silent with no unlock at all; an existing bundle keeps its tier (change it with `agents secrets policy share never`, which now actually strips the ACL). Source: `apps/cli/src/lib/share/config.ts`, `apps/cli/src/commands/exec.ts`.

- **The daemon watchdog now rotates rate-limited sessions in place.** A stalled session whose transcript tail shows a hard account limit ("You've hit your weekly limit · resets …", "usage limit reached", "out of credits") is rotated instead of nudged: the tick gates on the same first-party healthy-account selection `agents run auto` makes (`collectHarnessCandidates` + `pickHarnessWeighted` — zero healthy logs one `rotate` skip event per cooldown window to `watchdog.log` and leaves the terminal untouched), injects the harness's exit sequence (claude: Esc, Ctrl+C, Ctrl+C; codex/gemini/cursor/opencode: Ctrl+C twice), relaunches `agents run auto --interactive --session-id <uuid>` in the SAME tab via the inject rail, then — once the new session's TUI is live — injects the resume replay for the old session. Readiness is the new session's transcript (primary) or a fresh active session correlated by cwd + machine, never an unrelated one; the wait is bounded (60s), and on timeout the session is flagged with a bare-shell message pointing at a manual `agents run auto` and suppressed for 15m before retry — never blind-typed into. The state machine (`exiting → launching → awaiting-tui → replaying → done | failed`) persists at `~/.agents/.cache/state/watchdog/rotate/<sessionId>.json` and spans ticks via a post-loop sweep. Config: **`agents watchdog rotate on|off`** writes `watchdog.rotate` in `~/.agents/agents.yaml` (default on; rotate-only, nudging is unaffected), honored per tick; `agents watchdog status` / `--json` report the rotate config and every persisted rotate state. This replaces the Factory extension's own watchdog rotate loop, which is being deleted in the companion change. Source: `apps/cli/src/lib/watchdog/rotate.ts`, `apps/cli/src/lib/watchdog/runner.ts`, `apps/cli/src/commands/watchdog.ts`.

## 1.22.1

- **`agents doctor` de-noise: never-synced and cross-version hook drift are warnings, not criticals (RUSH-2162).** The CRITICAL section now holds only "needs you now" problems — a logged-out account, or a hook/plugin missing from a version you keep synced. A version that was never synced (an old/unused install with nothing installed) and a hook that merely *differs* across versions (installed but stale) are surfaced as WARNINGs instead, cutting the critical count on a busy machine from ~11 to the handful that actually need action. Source: `apps/cli/src/lib/devices/doctor-findings.ts`.

- **The "… is damaged and can't be opened" dialog stops — both helper `.app` bundles now install atomically and serialized.** The secrets keychain helper (`Agents CLI.app`) and the menu-bar helper (`MenubarHelper.app`) are each (re)installed on the hot path of ordinary `agents` invocations, and both did a non-atomic `rm -rf dest` + `cp -R src dest` straight onto the live bundle. On a busy box dozens of concurrent invocations raced that path, so a reader (Gatekeeper, or an exec of the bundle) could see a half-written `.app` — a truncated Mach-O / mismatched code signature — which macOS reports as damaged. A new shared installer (`lib/app-bundle-install.ts`, replacing the two duplicated copy functions) stages the copy in a sibling dir and swaps it in with renames (the live bundle is only ever a complete, signed `.app`, and a failed copy never touches it), and serializes concurrent installers behind the shared `withFileLock` with a double-checked skip so a burst copies once instead of stampeding. Source: `apps/cli/src/lib/app-bundle-install.ts`, `apps/cli/src/lib/secrets/install-helper.ts`, `apps/cli/src/lib/menubar/install-menubar.ts`.

- **`agents doctor --json` no longer stampedes into dozens of concurrent runs — the overview is singleflighted and cached, with a new `--refresh` to force a live recompute.** The bare `doctor --json` overview probes every host CLI, every agent's sign-in, and every agent×version diff — seconds on an idle box, minutes on a loaded one. The menu-bar helper polls it on a timer with only a per-*process* in-flight guard, so a helper relaunch (or any second poller) each launched its own live compute, and a helper killed mid-run orphaned a `doctor --json` that kept spinning — stacking to dozens of concurrent runs pinning the CPU. Now a fresh snapshot (< 90s) serves instantly from a disk cache, and when a live compute IS needed exactly one runs while every other caller serves its result (a lock-directory singleflight that self-heals if the computer dies). `agents doctor --json --refresh` bypasses the cache. Source: `apps/cli/src/lib/devices/doctor-overview-cache.ts`, `apps/cli/src/commands/doctor.ts`.

- **`doctor --json` releases its singleflight lock before it returns.** The overview gate
  fired the lock release without awaiting it on the path where a waiter serves the winner's
  fresh snapshot, so the call returned with the lockfile still on disk. The next caller then
  retried against a lock that was already logically free — the pile-up the gate exists to
  prevent, narrowed to the window between return and unlink. The release is now awaited.
  The existing coalescing test failed 5 times in 15 runs before this and 0 in 15 after.
  Source: `apps/cli/src/lib/devices/doctor-overview-cache.ts`.

- **`agents add grok@latest` no longer strands the freshly-downloaded binary in the old version's home.** When the post-install version probe (`<cli> --version`) transiently failed right after grok's self-updating installer exited, `installVersion` silently fell back to the literal string `'latest'` as the resolved version — creating a bogus `versions/grok/latest/` directory and defeating `relocateGrokBinaryToVersionHome`'s exact-filename match (its regex could never match `grok-latest-...`, since the real file is named `grok-<semver>-<platform>`). The real multi-hundred-MB binary was left behind in the PREVIOUS default's downloads dir, and `agents view grok` never listed the new version as installed even though `agents add` reported success. The probe now retries briefly instead of silently falling back, and fails loudly if it still can't resolve a version rather than corrupting the version bookkeeping. Relocation also now self-heals: if the current `~/.grok` symlink target has nothing matching, it sweeps every other installed grok version home for a binary stranded by a past occurrence of this bug. Source: `apps/cli/src/lib/versions.ts`.

- **A blocked menu-bar row now takes you to the session (RUSH-2110).** A NEEDS-YOU row
  exists because an agent is waiting on you, but its only action was "Reveal working
  dir", which unblocks nothing — you still had to go find the session by hand. Blocked
  rows now lead with **Focus session**, which runs `agents focus <id>`: attach the live
  terminal, or open a new tab and resume, cross-host. Reveal stays underneath. Both
  render paths are covered — the single inline row and each entry inside a collapsed
  multi-waiter group. A row the engine could not identify (a cloud task, a stale
  sentinel) simply omits the item rather than offering an action that would do nothing.
  Source: `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`,
  `AgentsCLI.swift`.

- **Two projects sharing one monorepo checkout are no longer indistinguishable.** Session,
  activity, and feed attribution anchored a project on `root ?? defaultPath`, so a subproject
  whose `root` is the monorepo and whose `defaultPath` is a subdir collapsed onto the same
  path as its umbrella — the longest-match tiebreak had nothing to separate them, and work in
  `rush/apps/cli` counted toward whichever definition happened to be listed first. A
  `defaultPath` nested under `root` now takes precedence over that `root` (the root says where
  the checkout is; `defaultPath` says which work is this project's), and each bound repo's
  checkout and subpath anchor too. A narrowed `root` still covers the rest of its checkout as
  a fallback, so a lone project defined with `--path` keeps attributing work across its own
  repo instead of only inside the subdir. Source: `apps/cli/src/lib/projects.ts`.

- **`agents projects view <name>` now shows more than `status`, not less.** The command you
  open to learn everything about one project built its own short list — root, repos, a raw
  Linear project id, an issue count, milestones — and never called the card renderer, so it
  omitted the agents roster, merged PRs and release, focus areas, the schedule verdict,
  tickets, and artifacts that `status` had shown all along. `view` and `status` now gather
  through one function and render through one card; `view` adds every milestone (instead of
  just the next) and the stored definition in full underneath — each repo with its subpath and
  checkout, each context with its purpose, each integration with its URL. It also takes
  `--window <days>` to match `status`. Source: `apps/cli/src/commands/projects.ts`.
- **The `agents` roster on the card lists live sessions only.** It included every matched
  session, so a card headed `23 live` went on to print `claude · crashed ×25` — the corpses the
  `dead` row already reports, counted twice and contradicting the headline. Both now derive
  from one `isDeadStatus` predicate, pinned by a test across every `ActiveStatus`. Source:
  `apps/cli/src/lib/project-status.ts`.

- **`--host <self>` and the fleet-health fan-out now short-circuit ALL of the
  local machine's names, not just its short hostname (RUSH-2114).** A `--host`
  target or fleet probe that referenced this box by its **tailscale dnsName**
  (`zion.tail1a85a1.ts.net`) slipped past a `=== machineId()` check and SSH'd to
  the local box over its own name; on a loaded machine that self-SSH'd `doctor
  --json` orphaned on timeout and piled up until the host was crushed. A new
  `isSelfHost()` matches every identity the box answers to (short id, loopback,
  tailscale dnsName + its short form) and gates all four self-checks — the
  generic `--host` passthrough (`maybeRunOnHost`), the `--devices`-all fan-out
  (`runFleetPassthrough`), `remoteFleetTargets`, and `runFleet` — so a
  self-reference runs locally instead of self-SSHing. Source:
  `apps/cli/src/lib/devices/self-host.ts`, `apps/cli/src/lib/hosts/passthrough.ts`,
  `apps/cli/src/lib/devices/fleet.ts`.

## 1.22.0

- **`agents run auto` — full-auto dispatch (RUSH-2132).** `run auto` composes all three routing layers: host (14d launch affinity, unless `--host` is given), harness (installed CLIs weighted by best-account headroom), and account (the configured strategy). `balanced`/`available` now exit nonzero when every installed account is unhealthy — naming each excluded account, the earliest window reset, and the `--strategy pinned` escape hatch — instead of warning "falling back to defaults" and launching the exhausted pinned default. The error text is a machine-readable contract (`no healthy` + `resets <iso-time>`) the Factory watchdog tail-detects for rotate cooldowns. Source: `apps/cli/src/lib/rotate.ts`, `apps/cli/src/commands/exec.ts`, `apps/cli/src/lib/runner.ts`.

- **Bash-command summaries are faster and recognize more of what actually ran (#1830).**
  `classifyBashCommand` (behind `agents sessions` / `agents activity` summaries) tokenized
  the *entire* command — every pipeline segment, multi-KB heredoc bodies included — just to
  read the leading executable, costing up to ~1ms on a big `cat <<HEREDOC …`. It now
  tokenizes only the head of the first simple command. Coverage gaps that dumped commands
  into a raw `other` pile are closed too: a `cd` prefix separated by `;` or a newline (not
  just `&&`) unwraps to the real command, a path/tilde executable
  (`~/.agents/skills/linear/scripts/linear`) resolves by basename, and the repo's own
  toolchain (`agents`, `linear`, plus `rmdir`) is recognized — `agents` was the single top
  unrecognized token. `ag` stays the silver searcher, not an `agents` alias. Source:
  `apps/cli/src/lib/session/bash-command.ts`.

- **`agents computer describe` now counts toward `usedComputer`.** Every other
  verb (`click`, `type`, `key`, `screenshot`, `run`, …) fires the
  `computer.action` event via `emitComputerAction`; `describe` never did, so a
  session that only ran `agents computer describe` read back
  `usedComputer=false` — a false-negative in the sessions preview. A new
  completeness-guard test pins every registered `agents computer` verb command
  to a matching `emitComputerAction` call so a future verb can't ship the same
  gap silently. Source: `apps/cli/src/commands/computer-actions.ts`,
  `apps/cli/src/commands/computer-actions.test.ts`.

- **Pick a model by cost tier — `--model cheap|default|best|ultra` — on `agents run` and `agents teams add`.** Instead of a concrete id that churns per release and differs per harness, a tier resolves per `(harness, installed version)` to a model that version actually ships, ranked by the provider's own lineup (`opus/sonnet/haiku/fable`; Codex "frontier/balanced/fast" → Sol/Terra/Luna), then price, then size tokens. Single-model harnesses (Grok) map the tiers to reasoning effort; Droid uses a curated credit-multiplier map capped at 2x. An unsupported tier clamps to the nearest lower one; an unresolvable tier drops the flag and falls back to the harness default. Concrete model ids keep working unchanged. `agents models [agent[@version]]` now prints the per-harness tier map (with `~$/Mtok` where priced) and emits `tiers` in `--json`, and Droid joins the model-capable set. Also fixes the Claude catalog extractor returning 0 models on the newest native-binary format (a fallback id scan), and refreshes `prices.json` with the GPT-5.6 Sol/Terra/Luna series. Source: `apps/cli/src/lib/model-tiers.ts`, `apps/cli/src/lib/models.ts`, `apps/cli/src/lib/exec.ts`, `apps/cli/src/commands/models.ts`, `apps/cli/docs/model-tiers.md`.

- **`agents projects status` says what was worked on and what the dates prove.** Two new lines.
  `focus` ranks the directories the window's commits landed in, read from the local checkout
  with `git log --name-only` — no API call, no credential, no rate-limit budget, measured at
  0.23s over a 897-commit week. Changelog fragments and lockfiles are excluded from the
  ranking: this repo files one fragment per PR, so `.changelog` otherwise ranked second and
  presented PR count as an area of focus. `schedule` states what the milestone dates prove —
  `overdue by N days`, `due in N days`, `N milestones, no issues filed against any`, or
  `none dated`. Source: `apps/cli/src/lib/project-focus.ts`, `project-schedule.ts`.
- **The schedule line will never say "on track".** That verdict needs either project start and
  target dates to interpolate expected progress, or a scope-history series to extrapolate a
  finish date. Probed against a live workspace, all of them are absent (`health: null`,
  `startDate`/`targetDate` null, `scopeHistory` and `completedScopeHistory` empty), so an
  on-track or at-risk chip would be fabricated — and a confident wrong answer on a status card
  is unfalsifiable from the card. When a human posts a Linear project health update, it is
  relayed and attributed (`per Linear: atRisk`), never synthesized.

- **The `--device`/`--host` auto-reconnect loop no longer trusts a remote-origin exit code of 255 as "the SSH link dropped."** `reattachRemoteSession`'s `connected` flag is set as soon as the fast SSH preflight probe succeeds, before the actual reattach runs — so if the remote command it drives (`agents sessions focus <id> --local --attach-only`) ever exited 255 for a reason that had nothing to do with the SSH transport, that would be indistinguishable from the link itself dropping, refill the retry budget every cycle, and loop forever — printing "attempt 1/6" on every cycle and leaving the terminal full of aborted-TTY escape codes. The remote invocation is now wrapped in `bash -lc` so that whatever exit code it decides on, a 255 is remapped to 254 before this process sees it, closing that gap in the exit-code channel regardless of which remote-side path or peer `agents` version might produce it. A genuinely recurring *local* SSH failure can still refill the retry budget on every attempt by design (unchanged, tracked separately: phnx-labs/agents-cli#1884). Source: `apps/cli/src/lib/hosts/reconnect.ts`.

- **`agents sessions` can query distinct tool calls and count static Bash program occurrences locally or across the fleet.** Use `--include tools`, repeat `--query` with `tool:`, `program:`, `input:`, `output:`, `status:`, `exit:`, or `error:` fields, and add `--fleet` for live SSH fan-out. `--count` reports exact occurrence, containing-call, and session totals from ordered `wrapper`/`effective` rows without reparsing; synced mirrors are partitioned by origin so fleet evidence and totals do not duplicate sessions. Historical parsing is explicit and resumable through `agents sessions backfill tools`; normal scans index new and changed sessions once. Codex orchestration wrappers are parsed statically so only literal `tools.exec_command` commands reach the Bash AST, never wrapper code. Each device keeps a redacted, bounded relational SQLite/FTS5 cache, queries perform no transcript I/O or index writes, and no embeddings, vector database, or model calls are used. A sampling script explicitly backfills then extracts redacted shell-command origins from 50–100 sessions over the last seven days into a 16 MiB maximum artifact.

- **Local team worktrees base on freshly-fetched `origin/<default>`, not `HEAD`.**
  `createWorktree` (and `agents worktree provision` for new branches) now
  `git fetch origin` then `worktree add -b … origin/<default>`, matching
  `createRemoteWorktree`. Previously local teammates forked from the
  orchestrator's current `HEAD`, so a stale checkout made every teammate write
  on old code and only surface the conflict at merge. Source:
  `apps/cli/src/lib/teams/worktree.ts`, `apps/cli/src/commands/worktree.ts`,
  `apps/cli/docs/teams.md`.

## 1.21.3

- **`agents projects import --from-factory` stops printing raw git errors.** Reading each
  checkout's real remote is done per registry row, and a checkout with no `origin` makes git
  write `error: No such remote 'origin'` straight to the terminal — its own stderr, which the
  surrounding try/catch never sees. Importing 12 rows printed two of them between the progress
  lines. The probe now discards git's stderr; an absent remote is an expected answer, not
  something to report. Source: `apps/cli/src/commands/projects.ts`.

- **Sessions now track browser/computer tool use and skill/plugin/slash-command
  usage, queryable with `agents sessions --skill <name>` / `--plugin <name>`.**
  `browser.navigate`, `browser.screenshot`, and a new `computer.action` event
  fire on every `agents browser`/`agents computer` action, carrying session
  identity for free. The sessions index persists `usedBrowser`/`usedComputer`
  (from a scoped events-log read, not a transcript re-scan) and a new
  `session_resource_usage` table records every skill and slash-command
  invocation with its owning plugin, source repo, and git commit — resolved
  against `resolveResource()`/`discoverPlugins()` at scan time. The sessions
  picker preview surfaces both as `browser`/`computer` and `Skills:` tags.
  Source: `apps/cli/src/lib/browser/service.ts`, `apps/cli/src/commands/computer-actions.ts`,
  `apps/cli/src/lib/session/db.ts`, `apps/cli/src/lib/session/highlights.ts`,
  `apps/cli/src/lib/session/discover.ts`, `apps/cli/src/commands/sessions.ts`.
- **`ResolvedResource` and `DiscoveredPlugin` carry provenance: `repoRoot` and a
  lazily-resolved `snapshotSha`.** Every resource/plugin resolution can now
  answer "which DotAgents repo, which commit" without an extra lookup; the git
  shell-out is memoized per repo root and only runs when a caller actually
  reads `snapshotSha`. Source: `apps/cli/src/lib/resources.ts`,
  `apps/cli/src/lib/plugins.ts`, `apps/cli/src/lib/git.ts`.
- **`SessionEvent.slashCommand` captures a typed or model-invoked slash command**
  (both the `<command-name>` wrapper and the `SlashCommand` tool call), and
  `agents sessions`'s perf sample for `command.end` now carries the session id
  and agent instead of being anonymous. Source: `apps/cli/src/lib/session/prompt.ts`,
  `apps/cli/src/lib/session/parse.ts`, `apps/cli/src/index.ts`.
- **`agents routines status` no longer reports "stopped" for a live scheduler, and
  `agents routines start` can't spawn a second one.** The daemon writes its pid file
  once (on claim/start) but rewrites the heartbeat every tick. If the pid file was lost
  while the daemon kept ticking — an earlier status check clearing a stale/reused pid, or
  the file removed out from under a live daemon — `status` read only the pid file and
  reported `stopped` for a scheduler that was in fact running and firing jobs, while
  `claimDaemonInstance()` would start a concurrent `JobScheduler` that double-fires every
  routine. `isDaemonRunning()` and the single-instance claim now also trust a fresh
  heartbeat whose pid is alive, re-adopting the pid file to heal the desync.
  Source: `apps/cli/src/lib/daemon.ts`.

## 1.21.2

- **`agents trends` — resource and session analytics dashboard.** Baked recipes
  (harness/model mix, tools per session, token ratio, secrets/browser hot lists)
  read `sessions.db` plus a new value-free warehouse at
  `~/.agents/.history/analytics/usage.db`. Secrets usage migrates once from
  `secrets.db`; agent run and browser launch/close emit into the warehouse.
  Quota stays on `agents usage`, latency on `agents perf`.
  Source: `apps/cli/src/commands/trends.ts`, `apps/cli/src/lib/analytics/`.

- **The macOS menu bar app is now named AGI Menu in System Settings and
  Accessibility prompts.** Privacy & Security previously showed the executable
  name `MenubarHelper` because the bundle had no `CFBundleDisplayName`. The
  bundle now ships `CFBundleName` / `CFBundleDisplayName` = `AGI Menu`, and
  `agents menubar` status/enable/disable copy uses the same name. An install
  that was left ad-hoc-signed by an older heal path is also replaced from the
  Developer-ID source on the next `agents` run, so Accessibility stops
  re-prompting for a new identity every upgrade. Source:
  `apps/cli/menubar/scripts/build.sh`, `apps/cli/src/commands/menubar.ts`,
  `apps/cli/src/lib/menubar/install-menubar.ts`.

- **Cursor usage bars now show Auto/API/Total, and Cursor sessions carry live todo progress.** `agents view` reads Cursor's dashboard `get-current-period-usage` first for the Auto + Composer (`A`) / API (`API`) / Total (`T`) percent breakdown, falls back to `usage-summary` for accounts without a usable `planUsage`, and only drops to the legacy monthly request bar (`M`) for request-capped free/legacy plans. `agents sessions` also now folds a Cursor session's `TodoWrite` calls into `SessionMeta.todos`, so the checklist progress shown for Claude/Codex/Kimi sessions renders for Cursor too. Source: `apps/cli/src/lib/usage.ts`, `apps/cli/src/lib/session/discover.ts`.

- **`feed.broadcast` gains an in-process `channel:` sink and an implicit owner
  fallback (RUSH-2123).** A `feed.broadcast` sink can now declare `channel: <name>`
  (plus `to:` for a non-owner destination) instead of `command: [argv...]` — it
  delivers through the same channel-provider registry `agents send`/`agents notify`
  use (`deliverEnvelope()`), no spawn. `channel: owner` is the address alias,
  expanding to `notify.owner.{channel,to}`. When an operator has `notify.owner`
  configured but never wrote a `feed.broadcast` block at all, an important-level
  post (`--level important`, or any `--blocked` post) now falls back to that owner
  address automatically instead of reaching nobody — previously a `feed post
  --blocked` with `notify.owner` set and no `feed.broadcast` looked recorded but
  delivered to no one. A routine milestone post still stays record-only even with
  the fallback available, and an operator-declared `feed.broadcast` always wins
  outright. `command:` argv sinks (the tracker/webhook escape hatch) are unchanged.
  Source: `apps/cli/src/lib/feed-broadcast.ts`, `apps/cli/src/commands/feed.ts`.

- **`agents run` no longer stalls on a live usage fetch, and the daemon keeps the
  quota cache warm instead (RUSH-2061).** The router's candidate collection
  (`collectRunCandidates`) used to block on a live provider HTTP read whenever an
  account's usage snapshot was older than 5 minutes — one round trip per account
  added to cold-start. It now reads the usage cache **cache-only** (`readOnly`) and
  never touches the network; an unconfirmable snapshot is simply routed around by
  the existing freshness guard (`isUsageVerified`). A new daemon refresher
  (`runUsageRefresh`) keeps that cache fresh in the background: it refreshes only
  accounts signed in on THIS host (sole-writer, no cross-host coordination), on an
  adaptive cadence from each account's session-window burn rate (90s when racing
  toward the 5h cap, up to 15min when idle), capped at ~6 provider calls per
  account per hour and skipped entirely while a provider is under a 429 backoff.
  Source: `apps/cli/src/lib/usage.ts`, `apps/cli/src/lib/usage-refresh.ts`,
  `apps/cli/src/lib/rotate.ts`, `apps/cli/src/lib/daemon.ts`.

- **Balanced routing now deprioritizes an account projected to cap soon, not just
  one already maxed (RUSH-2061).** `deriveUsageHeadroom` projects minutes-to-limit
  from the session-window burn rate; balanced weighting scales an account's
  headroom weight down as that projection shortens (`capacityWeight`), so a launch
  avoids an account racing toward its 5-hour cap instead of only skipping a
  100%-maxed one. Source: `apps/cli/src/lib/usage.ts`, `apps/cli/src/lib/rotate.ts`.

- **The daemon no longer SSH-probes the whole fleet every 3 minutes — fleet status
  is publish-own / read-union now (RUSH-2061, RUSH-2114).** The daemon's fleet-cache
  warm force-probed every registered device over ssh on every tick; with N daemons
  each probing N devices that was N² remote resource probes across the fleet every
  3 minutes, and the source of the orphaned fleet-doctor probe pile-up. Each daemon
  now probes only **itself** (no ssh) and publishes its own row — resource stats
  **plus live-agent workload** (running-agent count and a per-context / per-agent
  breakdown) — to a shared local mirror (`~/.agents/.cache/.fleet-status.json`).
  Cross-host rows are unioned on demand by the reader: `agents devices status`
  gathers peers cache-first, ssh-reading a stale/missing peer via
  `agents devices status --local --json` through a bounded, kill-on-timeout
  fan-out. `agents devices status` (and `--json`) now shows how many agents are
  running on each box. Source: `apps/cli/src/lib/fleet-status.ts`,
  `apps/cli/src/lib/fleet-cache.ts`, `apps/cli/src/lib/daemon.ts`,
  `apps/cli/src/lib/devices/health-report.ts`, `apps/cli/src/commands/ssh.ts`.

- **`agents doctor --json` is no longer a ~136-second stall (RUSH-2136).** The
  overview probed every host-CLI manifest with a blocking `spawnSync` (10s timeout
  each) one after another, so a dozen-plus slow checks summed into minutes. The
  checks now run concurrently (`listCliStatusAsync`), so total time is the slowest
  single check, not their sum; the per-check 10s kill-on-timeout is preserved.
  Source: `apps/cli/src/lib/cli-resources.ts`, `apps/cli/src/commands/doctor.ts`.

- **Metrics foundation: hook/command instrumentation + routine metrics.** Every
  hook now instruments through a generated shim — `matcher:`-only hooks like
  git-guard/rm-guard/git-require-clean-tree previously fired with zero perf
  samples; `agents perf hooks` now reports them. `agents perf` gains
  `--project <key>` (scope to one repo), a `P95` column alongside P50/P99, and
  an `ERR/TIMEOUT` rate column. New `agents perf friction` surfaces sessions
  stuck repeatedly hitting the same guard block instead of adapting. New
  `agents routines stats [name]` reports run count/failed/missed/avg/p50/p95
  duration per routine; `agents routines runs --json` now includes `duration`.
  Routine session transcripts are now archived for gemini/antigravity/droid/
  kimi/grok routines, not just claude/codex/cursor. Source:
  `apps/cli/src/lib/hooks.ts`, `apps/cli/src/lib/perf/db.ts`,
  `apps/cli/src/commands/perf.ts`, `apps/cli/src/lib/routines.ts`,
  `apps/cli/src/lib/runner.ts`.

- **The Linear line on `agents projects status` is cached, and stops vanishing.** The card
  paged every issue in a project on every invocation — up to 10 requests per project — against
  a 2500/hour request budget that an agent running `status` in a loop exhausts. Answers are now
  cached on disk for 10 minutes (`~/.agents/.cache/linear-projects/`, one file per project written
  by atomic rename so concurrent agent sessions cannot clobber each other), so a repeated
  `status` spends zero Linear requests. More importantly, a failed or rate-limited fetch now
  serves the last good answer marked stale instead of dropping the line: a populated Linear row
  silently disappearing on one 8s timeout was the observed defect, and it is the same rule
  `mergeAuthHealthEntries` already keeps for account health. A 429 records its
  `x-ratelimit-requests-reset` so later runs don't spend a request to be told there are none
  left. Source: `apps/cli/src/lib/linear-cache.ts`.

- **The compact `projects status` card shows the milestone it calls `next`.** Milestones are
  listed in date order, and Linear can flag a later-dated one as next — so slicing the front
  of the list showed an earlier milestone while burying the actual next under `+N more`, which
  is the one thing that row exists to say. The next milestone now leads, and identity is
  matched on name plus target date rather than name alone (two milestones can share a name,
  which put the `next` label on the wrong row). Source: `apps/cli/src/commands/projects.ts`.

- **`agents projects` stops reading the wrong GitHub repository.** Factory derives a
  project's `owner/repo` from the checkout path's last two segments, so a repo cloned to
  `~/src/github.com/<you>/agents-cli` whose origin is `phnx-labs/agents-cli` imported as
  `<you>/agents-cli`. Both are real repositories, so nothing errored — the card's merged-PR
  and release lines simply reported a stranger's repo (0 merges in 7 days instead of 100).
  `import --from-factory` now reads the checkout's actual `origin` and only falls back to the
  path guess when there is no remote to ask, and `status`/`show` print a warning with the fix
  when a stored slug disagrees with the remote. Source: `apps/cli/src/lib/project-doctor.ts`.
- **`agents projects set <name>` changes one field without destroying the rest.** Previously
  the only ways to correct a field were `$EDITOR` on raw YAML or `add --force`, which rebuilds
  the definition from flags alone and silently drops `linear`, `contexts`, and `description`.
  `set` loads, patches the named field, and writes back. Flags: `--repo`, `--root`, `--path`,
  `--description`. Source: `apps/cli/src/commands/projects.ts`.
- **Merged-PR counts say when they are a lower bound.** The `gh` fetch caps at 100, and a busy
  repo where all 100 land inside the window has more — the count now renders `100+` rather than
  presenting the cap as a total, matching the existing Linear `2500+` contract. Source:
  `apps/cli/src/lib/project-status.ts`.

- **`agents projects view <name>`** replaces `show` (kept as an alias) and now renders the
  project's full plan: every declared Linear milestone with its date and progress, issue
  counts, and a warning when no issues are assigned to any milestone — a milestone nothing is
  filed against cannot report progress, and a row of silent `0%`s hid that. Sixteen other
  command groups already use `view <name>`; `projects` was the only one that did not. Source:
  `apps/cli/src/commands/projects.ts`.
- **The status headline counts live agents, not corpses.** It read `39 agents` on a project
  where 19 had crashed. It now reads `19 live`, with a separate `dead` row breaking down what
  finished or was lost — 19 crashed sessions is a thing to go fix, not throughput. `orphaned`
  counts as **live**: `session/active.ts` defines it as "alive, but no client is attached", and
  the repo's own dead rule is `closed` + `crashed` only. Source:
  `apps/cli/src/lib/project-status.ts`.
- **`planPct` is gone from the card and from `--json`.** It summed each matched session's most
  recent checklist snapshot, so one agent opening a fresh 40-item plan rendered the whole
  project `0% plan`, and a project where nobody had written a checklist showed no figure at
  all. A cross-session sum of ad-hoc checklists does not measure project progress. `live` and
  `dead` counts replace it in `--json`.
- **The next milestone comes from Linear's own `status: "next"`** when Linear sets it, falling
  back to earliest-dated-unfinished only when nothing is flagged — Linear's answer is the one
  shown in its UI, ours is a guess.

- **A regression guard for the distributed `--active --local` / `--host` session-query paths, wired into CI (#1866).** RUSH-2118 fixed a `--local` query dialing remote-host teammates over real ssh, but nothing bench-guarded the fix's latency, and the `--host` cross-fleet fan-out had no bench at all. `bench/sessions-active-perf.ts` times `AgentManager(..., localOnly=true).listAll()` against N synthetic remote-host teammates (asserting zero ssh calls and sub-500ms latency, with a positive-control run proving the ssh-PATH shim actually intercepts) and the `gatherActiveSessions({ hosts })` fan-out against N synthetic peers (asserting it stays parallel, not sequential). Wired into `.github/workflows/bench.yml` as the one gating step in that workflow — every other bench step stays `continue-on-error`. Documented with measured baselines in `apps/cli/docs/05-sessions.md#benchmarks`. Source: `apps/cli/bench/sessions-active-perf.ts`, `.github/workflows/bench.yml`.

- **`agents view` columns stay aligned across agents, and usage no longer piles up (view-ui-perf).**
  The multi-agent overview padded every row to the widest usage string — an
  Antigravity account with four model quotas forced ~194-column lines that
  wrapped so `rate-limited` and last-active drifted under the version column.
  Overview now caps compact meters to two windows (`+N` for the rest), always
  emits fixed account/usage/status/lastActive columns (empty cells space-padded),
  and measures padding with `stringWidth` so chalk + block bars don't skew
  gutters. Usage fetches go through one unified core: 5-minute fresh cache
  (was 2), concurrency-capped live reads (`USAGE_FETCH_CONCURRENCY=3`),
  single-flight per identity, and a background SWR queue capped at 2 so delayed
  HTTP responses cannot stack. Spinner stays up through account+usage load.
  Source: `apps/cli/src/commands/view.ts`, `apps/cli/src/lib/usage.ts`,
  `apps/cli/src/lib/agents.ts`.

## 1.21.1

- **Feed posts require a title + body; phone `{message}` ends with a Sent-from footer.** `agents feed post --title "Short subject" "body text"` — title is the phone first line (~4–5 words), body follows after a blank line, then `Sent from <agent>/<session-chunk> on <host>` (like "Sent from my iPhone"). Em/en dashes in title/body are scrubbed to ASCII ` - `. Source: `apps/cli/src/lib/feed-broadcast.ts`, `feed-post.ts`, `commands/feed.ts`.

- **Hook `timeout` in agents.yaml now accepts duration strings, not just bare seconds (#1555).**
  A hook can be written `timeout: 5s` / `timeout: 2m` / `timeout: 1h30m` instead of only
  `timeout: 30` — self-documenting at the call site. A bare number still means seconds, so
  every existing manifest keeps working. `parseHookManifest` normalizes the value to a
  seconds number once, so all harness serializers keep consuming a number; an unparseable
  timeout is dropped with a warning rather than silently coerced. Source:
  `apps/cli/src/lib/hooks.ts` (`normalizeHookTimeoutSeconds`, `parseHookManifest`),
  `apps/cli/docs/hooks.md`.

- **Owner notifications route through the one channel seam.** The feed urgent-block
  dispatch and the monitor `notify` action now send through the registered channel
  provider (`lookupTransport` → `ChannelProvider.send`) instead of shelling out to
  `openclaw` directly. The recipient comes from `notify.owner` in agents.yaml — the
  hardcoded owner chat id is gone, so changing `notify.owner` is honoured by every
  path. A bare `--notify` on a monitor now targets `notify.owner`; `--notify <channel>`
  overrides the owner channel. The monitor path also gains the provider's missing-binary
  guard (a clean error instead of a raw ENOENT). A channel name that resolves to no
  registered provider (a typo in `notify.owner.channel`, or `--notify <channel>`) fails
  that one send with a clean error — it does not exit the monitor daemon or abort the
  `agents feed --dispatch` loop. Source: `apps/cli/src/lib/notify.ts`,
  `apps/cli/src/lib/monitors/dispatch.ts`, `apps/cli/src/lib/channels/resolve.ts`.

## 1.21.0

- **A clone of your own DotAgents repo no longer hijacks project-layer rule resolution (RUSH-2037).**
  Cloning `~/.agents` to the canonical `~/src/github.com/<you>/.agents` path (to edit
  rules in an editor) made that checkout eligible as a *project* layer whenever you
  worked from its parent directory. Because project outranks user, a stale clone's
  `rules/subrules/*` then silently shadowed the live user rules by filename, and the
  compile planted an out-of-date `AGENTS.md` in an ancestor dir that every session
  beneath it ingested. Project-layer discovery now identifies a DotAgents repo by
  **repo identity** (git origin), not path: a `.agents/` that is itself a git checkout
  whose origin matches the user's or system's DotAgents repo is skipped, so the live
  user layer wins. Legitimate project `.agents/` layers (a plain subdirectory of a
  project, or a git repo with an unrelated origin) are unaffected.
  Source: `apps/cli/src/lib/state.ts`.

- **`agents sessions --local` no longer dials remote-host teammates over ssh,
  in the default listing or `--active` (RUSH-2118).** `--local` is supposed to
  mean this-machine-only, but the underlying `AgentManager` poll still fired a
  real ssh round-trip for every teammate dispatched via
  `agents teams add --device` — even a teammate that had already finished.
  On a box with 30 completed remote-host teammates that measured out to 180
  real `ssh` execve calls (6 per teammate: two ssh calls in
  `syncRemoteMirror`, run three times per poll) and a ~4.3s
  `--active --local` call. A `--local` query now reads a remote-host
  teammate's last-persisted `meta.json` state instead of dialing it, and a
  teammate that has already reached a terminal status (completed/failed/
  stopped) is never re-dialed by ANY `--active` query, local or not — its
  final log bytes and exit code were already captured on the poll that
  resolved it. The same gate now covers every `--local` surface: the bare
  default listing's live-glyph enrichment (`maybeLiveIndex`) and `--preview`
  (`renderSessionPreview`, freely combinable with `--local`) both called the
  local-only `getActiveSessions()` with no `localOnly` threaded through,
  despite the `--local` help text already promising this-machine-only for
  all of them. Source: `apps/cli/src/lib/teams/agents.ts`
  (`syncRemoteMirror`, `readNewEvents`, `updateStatusFromProcess`,
  `AgentManager`), `apps/cli/src/lib/session/active.ts` (`listTeamsActive`,
  `getActiveSessions`), `apps/cli/src/commands/sessions.ts`
  (`gatherActiveSessions`, `maybeLiveIndex`, `renderSessionPreview`).

- **A rules preset now applies at `agents run` time, not only after `agents
  rules switch` (RUSH-2128).** `setActiveRulesPreset` used to take effect only on the next
  explicit `agents rules switch`/`agents add`/`agents use` — a preset change
  made any other way left the harness launching against a stale rules file
  until someone remembered to re-sync. `agents run` now re-applies the active
  preset for the resolved agent+version immediately before dispatch, every
  time, with a skip-fast sentinel so an unchanged preset costs no recompose or
  rewrite. Version-scoped only; per-model preset scoping is a follow-up.
  Source: `apps/cli/src/lib/rules/run-sync.ts`, `apps/cli/src/commands/exec.ts`.

- **Activity events now carry the same actor and session lineage as operational events.**
  The TypeScript activity writer and the embedded PostToolUse hook stamp actor kind,
  launch id, and parent session id from the shared execution provenance floor, so
  `agents events` no longer invents an agent name as the activity record's OS user.
  Source: `apps/cli/src/lib/event-provenance.ts`, `apps/cli/src/lib/activity.ts`.

- **`agents view` no longer re-scans every installed Claude binary on each run.**
  When a Claude model extractor produced zero models (a broken regex, or a
  mid-install CLI), the result was never cached — so `getModelCatalog` re-ran a
  full `readFileSync` scan of the 230-270MB Claude binary for every affected
  installed version, on every invocation (~1.85s each). With 4 affected
  versions installed, that was ~7.5s added to every `agents view`. A 0-model
  extraction is now cached too, stamped with when it was attempted, and served
  for 24 hours before self-healing by retrying; an upgrade/reinstall (a new
  source mtime) still re-extracts immediately, as before. Measured on a real
  install with 7 Claude versions (4 of them hitting the broken extractor): the
  cold first-call cost (~12.5s, unavoidable) drops to ~1-2ms on every
  subsequent call. Source: `apps/cli/src/lib/models.ts`.

- **Per-device and fleet-wide config keys now have a home: the `config:` block in
  the two-tier agents.yaml store.** Three new subcommands under `agents devices`
  (no new top-level noun): `agents devices set-interactive <name>` records the one
  device agents show YOU artifacts on (browser opens, dashboards) as
  `config.interactiveHost` in the central, synced agents.yaml — skills no longer
  guess "the online macOS box", and the host is marked `★ interactive` in
  `agents devices list`. `agents devices configure <name> --max-agents N
  --scheduler on|off` and `agents devices note <name> "…"` (repeat
  to append, `--clear` to empty) write device-scope keys under `config:` in
  `~/.agents/devices/<name>/agents.yaml` — targetable for any device from any box
  (the devices/ tree syncs; each machine reads only its own). The default browser
  profile joins the same registry as `browser.profile`, routed to the existing
  device-local `defaultBrowserProfile` field (no duplicate key, resolution order
  unchanged). Unset keys always mean today's behavior; everything is scriptable
  with `--json`, and `devices list --json` now carries each row's `config` and an
  `interactive` flag. agents.yaml files the CLI writes now carry a
  `yaml-language-server` hint pointing at the new
  `apps/cli/schema/agents-yaml.schema.json`.

  The keys are live inputs, not just stored values. `--scheduler off` stops the
  routines scheduler from starting on that device — `routines add` skips the
  auto-start with the reason, a manual `routines start` refuses, and the daemon
  re-evaluates the gate on every SIGHUP reload (boot it again with
  `agents devices configure <host> --scheduler on` + any reload, no daemon
  restart). `--max-agents` feeds host ranking: Factory auto-launch excludes a
  device at its cap (counting device-wide running agents) and names the cap when
  a pool is exhausted; teams placement excludes it from the least-loaded
  auto-pick (counting the team's own roster, local teammates included) and an
  all-capped pool fails loud instead of over-filling a machine. Setup asks
  instead of guessing: bare `agents setup` ends with a skippable preferences
  step (which machine you sit at → interactive host; which browser agents drive
  here → device default), `agents setup fleet` offers the interactive host after
  a sync, and the `agents setup browser` picker highlights the auto-detect
  winner. Source: `apps/cli/src/lib/device-config.ts`,
  `apps/cli/src/lib/state.ts`, `apps/cli/src/lib/daemon.ts`,
  `apps/cli/src/lib/teams/scheduler.ts`, `apps/cli/src/commands/ssh.ts`,
  `apps/cli/src/commands/setup-preferences.ts`,
  `apps/factory/src/core/launchHost.ts`,
  `apps/cli/schema/agents-yaml.schema.json`.

- **Mailbox messages now expire and dead boxes are reaped automatically.** Messages
  enqueued without an explicit TTL used to sit in the spool forever, so pending mail
  would outlive the session that needed it. They now get a 24-hour default TTL
  (`AGENTS_MAILBOX_TTL` overrides the default; `agents message … --ttl 2h` sets it
  per message). When a message expires, a live-but-idle box archives it with a
  `dropped: expired` receipt. The watchdog tick also runs a liveness sweep using the
  same live-session set as `agents sessions --active`, archiving pending mail in dead
  boxes as `dropped: dead` and pruning stale consumed entries. Dropped messages tied
  to a feed block surface a failure receipt (`status: dropped` / `expired`) so the
  sender sees the bounce instead of silence. Run the sweep manually with
  `agents mailboxes gc` (`--json` supported). Source:
  `apps/cli/src/lib/mailbox.ts`, `apps/cli/src/lib/mailbox-gc.ts`,
  `apps/cli/src/commands/message.ts`, `apps/cli/src/commands/mailboxes.ts`,
  `apps/cli/src/commands/watchdog.ts`, `apps/cli/src/lib/feed.ts`.

- **The menu-bar helper can no longer leak CLI processes until the machine is unusable.**
  Its poll shelled `agents doctor --json` through an unbounded `Process` +
  `readDataToEndOfFile()`. Two properties composed badly: the call had no deadline
  (`doctor --json` measures **136s on an idle box**, against a 60s poll interval), and a
  helper that died mid-call left the child reparented to launchd (PPID 1) with nothing
  to reap it — along with the `node -e` version probes that child had forked. Both fire
  together, because the helper crashes under exactly the conditions that make the CLI
  slow: `NSApplication.shared` segfaults inside `SLSNewConnection` when WindowServer is
  too starved to hand out a connection, launchd's `KeepAlive` restarts it, and the
  restart spawns a new doctor while the old one keeps burning a core. Observed on a real
  machine: 38 orphaned doctors + 92 orphaned probes, ~13 of 18 cores consumed, load
  average 490, keystrokes visibly lagging.
  The crash itself cannot be prevented from inside the app — it is AppKit dereferencing
  a null connection before any of our code runs — so a crash no longer costs anything
  permanent: every child carries a deadline (30s; 180s for `doctor --json`, above its
  real measured cost); it is spawned as its own process-group leader so a timeout kills
  the whole subtree rather than just the CLI; and each live child is recorded on disk so
  the *next* launch reaps whatever a crash abandoned (no exit handler runs on SIGSEGV).
  The doctor refresh also drops from every 60s to every 15 minutes, and the launchd job
  gains `ThrottleInterval` 30 so a startup crash-loop cannot respawn every 10s.
  A poll that blows its deadline now shows a stale menu instead of taking the machine
  down with it. Source: `apps/cli/menubar/Sources/MenubarHelper/ChildProcess.swift`,
  `AgentsCLI.swift`, `StatusItemController.swift`, `main.swift`,
  `apps/cli/src/lib/menubar/install-menubar.ts`.

- **The macOS menu-bar helper is now notarized, ending the "app is damaged"
  dialog and the per-run `no valid code signature; skipping launch` spam
  (RUSH-2134).** The helper shipped Developer-ID signed but *not* notarized, so
  Gatekeeper on macOS 26+ rejected it as damaged and the install path tried to
  heal it by re-signing ad-hoc on every `agents` invocation — which can never
  satisfy Gatekeeper, so the dialog and the noise persisted. The release now
  notarizes + staples the helper (`menubar/scripts/build.sh`, mandatory for any
  Developer-ID build, run under the release's `agents secrets exec apple.com`
  context), the `prepack` gate refuses to pack an un-notarized bundle
  (`scripts/verify-menubar-helper.sh` now requires a stapled ticket), and the
  runtime ad-hoc re-sign band-aid is deleted — a notarized + stapled bundle
  survives npm's tarball round-trip untouched, so the helper launches with no
  per-machine healing. The launch guards now verify Gatekeeper acceptance (not
  just `codesign --verify`) and fail loud pointing at an upgrade rather than
  re-signing over it. Source: `apps/cli/menubar/scripts/build.sh`,
  `apps/cli/scripts/verify-menubar-helper.sh`, `apps/cli/scripts/release.sh`,
  `apps/cli/src/lib/menubar/install-menubar.ts`.

- **`agents projects import` gains Linear as a source, and gates the Factory guess.**
  `import --from-linear` turns the workspace's Linear projects into definitions via the
  `linear` CLI, binding a local checkout only on an exact name match so it never
  silently points a project at the wrong repo. `--from-factory` now imports only
  `high`-confidence rows by default (`--min-confidence low|medium|high`, `--all` to
  take everything), and prints why each row was skipped — the auto-detected registry
  used to absorb every stale clone it found. Source: `apps/cli/src/lib/project-import.ts`.
- **`agents projects list` columns line up again.** Widths are computed from the rows
  being printed instead of a fixed 32-character path pad that every home-relative root
  ran straight through. Source: `apps/cli/src/commands/projects.ts`.

- **`agents projects status` shows the next Linear milestone.** A new `next` line names
  the project's earliest unfinished milestone with its progress and a human due date
  (`Beta cut · 3/8 · due in 6 days`, `overdue by 3 days`, `due Aug 21`) — a percentage
  says how far along a project is, the milestone says what it is due to hit next. The
  milestone list comes from the project rather than from issue assignments, so a
  milestone with nothing filed under it yet still shows; it rides along on the first
  page of the existing issue fetch, costing no extra request. Source:
  `apps/cli/src/lib/linear-project-counts.ts`.

- **`agents publish --branch <b>` now pushes the index to `<b>`, not just the printed URL (#1061).**
  The flag rewrote the printed `raw.githubusercontent.com/.../<b>/skills-index.json`
  URL, but the commit still landed on the checked-out branch — so `--branch dev` from a
  `main` checkout published the index to `main` while advertising a `dev` URL that didn't
  resolve. `commitAndPush` now takes an optional target branch and pushes
  `<current>:<target>`, reporting back the branch the index actually landed on so the URL
  references it. Omitting `--branch` still publishes to the repo's current branch.
  Source: `apps/cli/src/lib/git.ts` (`commitAndPush`, `pushOrigin`, `getCurrentBranch`),
  `apps/cli/src/commands/packages.ts`.

- **Remove the unused `agents hq` command.** `agents hq floor --json` was a
  machine-readable bridge for an interactive Agents HQ floor UI that was never
  built — `apps/factory` has zero references to it and it had no other consumer.
  Typing `agents hq` now prints a clear removal notice and exits non-zero instead
  of silently disappearing. Source: `apps/cli/src/index.ts`,
  `apps/cli/src/lib/startup/command-registry.ts` (removed
  `apps/cli/src/commands/hq.ts`, `apps/cli/src/lib/hq/`).

- **Removed `agents drive` and the R2/CRDT background session-sync beta.** Both
  predate `agents sessions export`/`import`, which now cover the same ground
  without a daemon: `agents drive` (rsync-based session/config mirroring) and
  the opt-in `session-sync` beta (`agents sessions sync`, the daemon's ~90s R2
  push/pull loop, `agents sync --sessions`) are gone. If you had `session-sync`
  or `drive` enabled, re-enable is no longer possible — use `--host` for live
  cross-machine reads or `agents sessions export --encrypt` /
  `agents sessions import` for portable, encrypted transcript bundles instead.
  The R2 network client and CRDT merge machinery are removed entirely with the
  rest of the background sync. Export/import's own encrypted-bundle path
  survives unchanged: it never talked to R2 over the network — it only reuses
  the `r2.backups` bundle's shared `R2_SYNC_ENC_KEY` for local AES-256-GCM
  encryption, falling back to a printed ephemeral key when that bundle isn't
  configured. Source: `apps/cli/src/commands/drive.ts`,
  `apps/cli/src/commands/sessions-sync.ts`, `apps/cli/src/lib/session/sync/crdt.ts`,
  `apps/cli/src/lib/session/sync/sync.ts`, `apps/cli/src/lib/session/sync/r2.ts`,
  `apps/cli/src/lib/daemon.ts`.

- **A routine that fires less often than weekly can now be caught up at all.** Overdue
  detection walked a fixed one-week window for the most recent expected fire, so any cron whose
  gap exceeds that returned nothing and the routine was skipped entirely — never flagged
  overdue on any device, never caught up, no `missed` record, silently. Monthly, semi-monthly,
  quarterly and annual routines were all in that class. Measured on a real schedule
  (`0 9 1,13,25 * *`, 12-day gaps): on **10 of every 28 days** the routine could not be
  evaluated. The lookback now widens (week → month → quarter → year) only when the narrower
  window finds nothing, so a dense schedule never walks more than a week of occurrences.
- **Catch-up no longer resurrects a retired routine.** `detectOverdueJobs` never checked
  `endAt`, and the scheduler only auto-disables lazily inside a live cron tick — so a routine
  whose `endAt` elapsed while the daemon was down was still enabled on disk, rescheduled on
  restart, and executed by the catch-up pass.
- **One-shot detection matches the scheduler's.** Overdue used the raw `runOnce` flag while the
  scheduler uses `isOneShotRoutine`, so a one-shot-*like* schedule (a fixed minute/hour/day/
  month) that never carried the flag could be replayed by catch-up.
- **The creation floor now covers built-in routines.** `routineEffectiveStart` resolved a
  routine's file through a user-layer-only lookup, but `listJobs` reads the system layer too —
  so a built-in shipped in the system repo had neither a `createdAt` stamp nor a resolvable
  path, the floor was skipped, and it read as instantly overdue on first daemon start. Added
  `resolveJobFilePath`, which resolves across every layer the loader reads.
- **A `createdAt` in the future is clamped to now.** Left unclamped (clock skew, a hand-edited
  year) it sits after every possible expected fire, so the routine could never be flagged
  overdue until wall-clock time caught up.

- **A routine now runs on exactly one device, instead of once per device listed.** `devices:`
  was an allowlist where *every* listed device fired independently, so a routine pinned to two
  boxes ran twice on every schedule — two full agent sessions doing identical work and burning
  double the agent quota. On one live fleet seven routines were in that state: `security-sweep`
  ran at 15:30:02 on one box and 15:30:03 on the other, both completing. Ownership is now a pure
  function of the config (the first device in normalized sort order), so every daemon reaches the
  same answer with no lease, no cross-device coordination, and no split brain when the fleet
  partitions. Omitting `devices` still means fleet-wide, which is what `watchdog` and
  `check-updates` want.
- **`agents routines add --devices a,b` and `devices --set a,b` are now rejected.** A routine
  belongs to one machine; the error names the fix. Routines already on disk with a multi-device
  pin keep running — on their owner only — rather than being dropped.
- **`agents doctor` lists any routine still carrying a multi-device pin**, with the devices it
  names, the one that now fires, and the command to make it explicit. Also in `doctor --json` as
  `ambiguousDevicePins`. The remediation deliberately offers the candidates rather than
  prescribing the owner: the lowest-sorted name can be a registry alias that matches no live
  machine, and cementing that would keep the routine dead.

## 1.20.93

- **`agents send` is a real delivery envelope; `notify` is just `--to owner` (RUSH-2123).** Flag-first form: `--to`, `--text`, `--channel`, `--attach`, `--url`. `--to owner` expands from `notify.owner` in agents.yaml. Positional text still works. Help names the three planes (deliver / record / control) so send is not confused with `feed post`, `activity`, or `message`/`sessions inject`. Source: `apps/cli/src/commands/send.ts`, `apps/cli/src/lib/channels/send.ts`.

- **`agents events emit` — record events produced outside the CLI.** In-process code
  calls `emit()` directly, but the producers that most need to record events are not
  agents-cli processes: the Factory VS Code extension host, shell guards, external
  tools. They now pipe JSONL on stdin —
  `… | agents events emit --source factory`. `--source` is stamped as `module`, so
  `agents events --module factory` filters to one producer. Routing is forced by the
  stores rather than chosen: a milestone kind requires a `sessionId` and lands in that
  session's activity log, everything else lands in the operational log. A milestone
  with no `sessionId` is rejected, not quietly written elsewhere. Rejection is per
  line, so one bad line never discards a batch, and the exit code is 1 if any line was
  rejected. `--dry-run` validates without writing.
  Source: `apps/cli/src/lib/events-ingest.ts`, `apps/cli/src/commands/events.ts`,
  `apps/cli/docs/06-observability.md`.

- **Four `factory.*` event kinds.** `factory.command`, `factory.action`, `factory.uri`
  and `factory.launch` describe what a user did in the Factory VS Code extension.
  `factory.launch` is a milestone — it carries the `sessionId` and `terminalId` that
  later events join through — and `factory.uri` is audit-level, since an external
  process driving the user's editor is a "who reached in from outside" fact.
  Source: `apps/cli/src/lib/events.ts`, `apps/cli/src/lib/activity.ts`.

- **`emit()` accepts a caller-supplied timestamp.** A batched producer records when
  each event *happened* and flushes later; without this, every event in a flush was
  stamped at flush time, collapsing their order and corrupting `--since` boundaries.
  `ts` stays reserved against payload injection — only the explicit override can set
  it. Source: `apps/cli/src/lib/events.ts`.

- **Fixed: `agents _internal friction` recorded its own invocation.** The command
  exists precisely because shell guards run before any `agents` process exists and so
  cannot emit in-process, but it still fired the `command.start` / `command.end` audit
  hooks, writing two records on top of every friction record. Recorder commands are now
  exempt. Source: `apps/cli/src/index.ts`.

- **Desktop notifications now show the agent on the right, not a second copy of
  the app icon.** macOS draws two images on a banner: the sending app's icon on
  the left and `contentImage` on the right (a YouTube notification uses the slots
  for "YouTube" plus the channel avatar). agents-cli was putting its own lime mark
  in the right slot, so both slots said the same thing. The right slot now carries
  the harness the notification is *about* — a brand-colored tile with a two-letter
  mark (`CL` claude, `CX` codex, `GK` grok, …), two letters because four harnesses
  start with `c` and two with `g`. `agents run --notify` and agent/workflow
  routines pass their harness through; a daemon heal, an overdue sweep, a command
  routine, or a fan-out across several agents has no single agent and leaves the
  right slot empty. Source:
  `apps/cli/menubar/Sources/MenubarHelper/AgentAvatar.swift`,
  `apps/cli/src/lib/menubar/notify-desktop.ts`, `apps/cli/src/lib/run-notify.ts`,
  `apps/cli/src/lib/routine-notify.ts`, `apps/cli/docs/menubar.md`.

- **`MenubarHelper --notify` gains `--agent <id>`.** The one-shot notifier accepts
  the harness id that drives the right-hand avatar; omitting it is how a caller
  says "no single agent owns this event".

- **`agents projects status --fleet` — per-device workspace drift (beta).**
  Projects are natively multi-device; `--fleet` adds a `fleet` line to the status
  card showing, for each project, whether its workspace repos are present on every
  fleet device, on which branch, ahead/behind their upstream (`↑`/`↓`), and how
  many uncommitted changes they carry — plus a hidden `agents projects probe
  --json <path...>` subcommand that is the peer half of the fan-out. One parallel
  SSH call per device (12s timeout), **no `git fetch`** — drift is measured
  against each peer's last-fetched upstream, and a repo with no upstream reports
  no drift rather than zero. Peers that are unreachable or run an older CLI are
  named once in a trailing note; `probe` itself is not beta-gated so peers answer
  whenever their binary carries it. The schema gains `repos[].path` (home-relative
  local checkout) to opt additional repos into probing beyond the primary `root`,
  and `--json` gains per-project `workspaces[]` with the host-tagged probe rows.
  The card's `live` line also counts agents on every box under `--fleet` via the
  existing sessions fan-out. Source: `apps/cli/src/lib/project-probe.ts`,
  `apps/cli/src/commands/projects.ts`, `apps/cli/src/lib/projects.ts`.

- **`agents projects` outcomes on the card — agent×project members, releases,
  Linear counts, and `projects link --linear` (beta).** The status card gains an
  `agents` line under `live` naming WHICH harness is on each project
  (`claude · running · RUSH-2107 @zion`, sorted running-first, capped at 6 with a
  `+N more` tail; under `--fleet` remote agents carry their peer's hostname), a
  latest-release tag on the `ships` line (primary repo only, best-effort
  `gh release list`), and a `linear` line counting the bound Linear project's
  issues by state type (`12/30 done · 5 in progress`) — best-effort with an 8s
  budget, skipped by `--no-remote`, and omitted when the def has no
  `linear.projectId`. The new `agents projects link <name> --linear [query]`
  writes that binding: no query auto-suggests from the def name + repo slug via
  the normalized-key matcher (ported from Factory's `linearProjects.ts`),
  ambiguous/none prints the candidate list and exits 1. `--json` gains
  `members[]`, `latestRelease`, and `linear`. Source:
  `apps/cli/src/lib/project-status.ts`, `apps/cli/src/lib/linear-projects.ts`,
  `apps/cli/src/lib/linear-project-counts.ts`, `apps/cli/src/commands/projects.ts`.

- **Project sync no longer spams a warning per file it left alone.** Syncing a
  project whose `.claude/commands/` you wrote yourself printed one wrapped
  `Skipping project resource target …: already exists and is user-owned` line
  per file — six hand-authored commands meant twelve lines of terminal noise in
  the middle of `agents view claude`. Those files are the normal steady state,
  not a warning, so the sync now reports them once, grouped, in plain words:
  `Kept 6 of your own files in .claude/commands: debug.md, doc-gaps.md,
  image-nbp.md, +3 more`. The list also rides out on `SyncResult.projectSkipped`
  for callers that want it. Source: `apps/cli/src/lib/project-resources.ts`.

- **`agents secrets` now tracks per-bundle usage and surfaces it.** Every secret
  lifecycle/access event — create, import, export, view, access (a value read for
  injection), unlock — funnels through the one `emitSecretAudit` chokepoint, which
  writes to BOTH the append-only `~/.agents/events.jsonl` audit log AND a derived,
  value-free read-model at `~/.agents/secrets/secrets.db` (never a secret value —
  bundle name, event kind, key count, resolving agent/host, status only).
  `agents secrets view <bundle>` now shows whether the bundle is currently
  **unlocked** (held by the secrets-agent, so reads are prompt-free), a **usage**
  summary ("accessed 42× (last 2h ago) · exported 3× (last 1d ago)"), and
  **per-agent** attribution, and nudges when a bundle has no description (also at
  `create` time). `agents secrets list` gains **`--sort uses`** (most frequently
  accessed) alongside the existing `--sort used`, and the `--json` payloads carry
  `uses`, `usage`, and `heldExpiresAt`. A new **`agents secrets activity [bundle]`**
  prints the recent value-free event timeline (bounded to 90 days). Naming guidance
  is taught in the help and skill: name a website bundle after its domain
  (`stripe.com`, `openai.ai`), a desktop-app bundle after its binary suffix
  (`slack.app`, `photoshop.exe`). Recording is best-effort and
  `AGENTS_NO_USAGE_TRACK=1` disables it. Source:
  `apps/cli/src/lib/secrets/usage-db.ts`, `apps/cli/src/lib/secrets/audit.ts`,
  `apps/cli/src/commands/secrets.ts`, `apps/cli/src/lib/secrets/list-filter.ts`.

## 1.20.92

- **`agents sessions render <id...>` produces shareable, redacted Markdown instead of raw harness JSONL.** Claude, Codex, Kimi, Grok, Cursor, and Droid transcripts flow through the existing normalized `SessionEvent[]` parsers, then render with the same session-browser preview at the top, ordered user/assistant turns, fenced shell commands, JSON tool arguments, and explicitly truncated tool results. Redaction remains on by default through the canonical redactor, now also masking Unix/macOS/Windows home-directory identities and live secret values; `--no-redact` is local-only. Reasoning defaults to omitted and can be folded or included explicitly. One or several selected sessions can be written to a mode-`0600` Markdown file, and `--json` exposes the rendered documents for machine callers. The repo session skill and transcript-sharing guidance now require rendering `.md` before creating a confidential gist. Source: `apps/cli/src/commands/sessions-render.ts`, `apps/cli/src/lib/session/render.ts`, `apps/cli/src/lib/redact.ts`, `.agents/skills/sessions/SKILL.md`.

- **`agents sessions` rows show creation time as well as last activity (RUSH-2107).**
  The trailing time cell used to carry one unlabeled "X ago" — last activity — so a
  row could not say when the session began or how long it had been alive. It now
  reads `3d → 1 hour ago`: the compact creation age, then the last-activity label the
  listing sorts by. Both the interactive picker and the flat/tree listings render it.
  A session that ran for under a minute keeps a single field (the two halves would
  name the same moment), and a terminal too narrow for both drops the creation age
  rather than squeezing the topic below its floor, so rows never wrap. The picker's
  detail pane spells the same facts out as `created X ago · last active Y ago ·
  lasted Z`, and now derives them from the indexed session metadata when no local
  transcript exists — so **remote** and not-yet-indexed sessions report their timing
  instead of showing none. Source: `apps/cli/src/lib/session/relative-time.ts`,
  `apps/cli/src/commands/sessions.ts`, `apps/cli/src/commands/sessions-picker.ts`.

- **Stop fleet health probes from orphaning remote processes on timeout (RUSH-2114).** `sshExecAsync` now uses a direct ssh connection whenever a `timeoutMs` is set, because a control-master outlives the local client and keeps the remote command running after we kill it. `agents doctor` also normalizes host names before excluding the local machine, so `zion.local` can no longer be self-SSH'd. Source: `apps/cli/src/lib/ssh-exec.ts`, `apps/cli/src/commands/doctor.ts`.
- **Harden menubar install against Gatekeeper rejection.** `ensureValidSignature` now checks `spctl --assess`; a Developer-ID-signed but un-notarized bundle is stripped of quarantine and re-signed ad-hoc so the launchd service does not crash-loop with "app is damaged". The release build script gained optional notarization via `MENUBAR_HELPER_NOTARIZE` and `MENUBAR_HELPER_NOTARIZE_KEYCHAIN_PROFILE`. Source: `apps/cli/src/lib/menubar/install-menubar.ts`, `apps/cli/menubar/scripts/build.sh`.

- **`agents activity` now shows the whole fleet, grouped by project.** The
  question the command answers is "what are my agents doing", and agents run on
  every box — but it read only the local logs unless you remembered
  `--devices-all`, and printed one flat newest-first stream. Both defaults are
  inverted: every run fans `activity --json` out to each reachable device and
  merges the peers' streams host-tagged, then buckets them by project, one level,
  no sub-grouping. `--local` scopes back to this machine, `-H/--host` to named
  boxes, and `--flat` (or `--group-by none`) restores the single stream;
  `--devices-all`/`--hosts-all` remain accepted so existing scripts keep working.
  A peer answering the fan-out still carries the recursion guard, so it never
  re-fans the fleet.

- **Each project header names the machines its work ran on.** A bucket reads
  `▸ agents-cli  12 events · 4 milestones · zion, yosemite-s0` — up to three
  machines by name plus a `+N` tail, so a project touched by a dozen boxes stays
  one scannable line; individual rows keep their own `[host]` tag. Peers that
  never answered are reported once at the end (`· 2 devices unreachable: …`)
  rather than a line each above the timeline, so a missing machine is visible but
  not noisy.

- **A project is now the repository, not whatever directory the agent sat in.**
  A cwd resolves to the git repository containing it, so `<repo>/apps/cli` files
  under `<repo>` instead of `cli`, and a worktree under
  `<repo>/.agents/worktrees/<slug>` folds back into the repo it branched from.
  A directory in no repo groups as itself, and a dotfiles repo at `$HOME` is not
  treated as a project. The `agents sessions` overview and `agents feed post` now
  share this one resolver (`lib/project-key.ts`), so a project reads identically
  everywhere instead of each view folding cwds its own way.

- **`--limit` is spent on milestones, not on collapsed churn.** The default view
  rolls routine `file.edited` work up to a count, so a plain slice let one busy
  machine's 40 file edits hide every other device's PRs behind a single
  `file edited ×40` line. The cap now bounds the milestones shown, with the
  routine events inside that window riding along for the counts. `--all` still
  shows routine work inline and caps every event.

- **The activity header no longer carries other subsystems' hook warnings.**
  Registering the activity-log hooks surfaced every unresolved entry in the hook
  manifest — a missing `inject-session-id` script, someone else's half-installed
  plugin — printing five wrapped yellow lines above the timeline on every run.
  Those are `agents doctor`'s job; only a failure that would leave the activity
  log unwritten is reported here.

- **The menu bar's New Session opens in the terminal you actually work in.** It
  hardcoded AppleScript at Terminal.app, so a Ghostty or iTerm user got a
  Terminal.app window every time. It now shells `agents run <agent> --terminal`,
  and the CLI resolves the terminal from the user's own live sessions — the host
  app `agents sessions --active` already attributes every session to
  (`ActiveSession.host`). Order: the terminal the caller is in, then the host of
  the most recent live session, then the first available backend. Hosts map to
  backends only where the engine can really drive them, so an undrivable host
  (Warp, kitty, Cursor) falls through instead of opening the wrong app. A
  tmux-hosted session (every interactive `agents run`) resolves to the app its
  attached tmux client is in, via the same resolver behind
  `agents sessions`' "viewing in Ghostty tab 2" — without that it would name the
  multiplexer and no terminal at all. Source:
  `apps/cli/src/lib/terminal/preferred.ts`,
  `apps/cli/src/lib/terminal/backends/terminal-app.ts`,
  `apps/cli/menubar/Sources/MenubarHelper/AgentsCLI.swift`.

- **`agents run <agent> --terminal` opens a run in a real terminal tab.** For a
  caller that cannot host a TUI (the menu bar, a script). Without a value the
  terminal is detected as above; `--terminal <backend>` forces one
  (`iterm | ghostty | terminal | tmux | vscodium-agent`) and errors on an unknown
  id rather than silently auto-detecting. The tab re-invokes the same argv with
  the flag stripped, so `--mode`, `--cwd`, and a `--` passthrough ride along.
  Cannot combine with `--host`. Source: `apps/cli/src/lib/terminal/run-surface.ts`,
  `apps/cli/src/commands/exec.ts`.

- **Terminal.app is a real launch backend now (`terminal`).** Registered last, so
  it is the every-Mac floor without outranking a terminal the user chose to
  install, and reported unavailable over SSH where `osascript` cannot reach the
  GUI login. It has no scriptable split, so a split request opens a tab, and
  `agents sessions resume --splits` now says so instead of quietly producing
  tabs. `detectCurrentBackend` also recognizes `TERM_PROGRAM=Apple_Terminal`.
  Source: `apps/cli/src/lib/terminal/backends/terminal-app.ts`.

- **`agents sessions resume` / `sessions focus` reach Terminal.app too.** Adding
  it to the backend registry changes both: on a Mac with neither iTerm, Ghostty,
  nor VSCodium installed they used to fall back to resuming in the current
  process, and now open a Terminal.app tab; `resume`'s interactive picker gains a
  Terminal row, and `--terminal-app` forces it (named apart from
  `run --terminal`, which means something different). Source:
  `apps/cli/src/commands/sessions-resume.ts`, `apps/cli/src/commands/focus.ts`.

- **New Task… in the menu bar.** A row above New Session that opens the
  quick-dispatch bar — the same panel as `Cmd-Shift-O`, now reachable without the
  chord (and without the Accessibility grant the chord needs). The status item
  owns the one panel instance, so an interrupted capture is restored whichever
  entry point you return through. Source:
  `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`.

- **Activity, feed posts, and the sessions overview now speak defined project
  names.** One resolver (`resolveProjectNameForCwd`, `lib/projects.ts`) backs all
  three: a cwd inside a defined project (`~/.agents/projects/<name>.yaml`) reads
  as the project's name — a multi-repo project is a single bucket in `agents
  activity`, not one per repo — and anything else falls back to the
  repository-level key, so nothing changes without definitions. Each peer
  resolves its own cwds against its synced definitions before events cross the
  wire. Source: `apps/cli/src/lib/projects.ts`, `apps/cli/src/commands/activity.ts`.

- **`agents activity --project <name>`** narrows the fleet stream to one project,
  exact-matched on the resolved label — one project's PRs, plans, and worktrees
  across every box without the rest of the fleet's noise. Source:
  `apps/cli/src/lib/activity.ts` (`filterActivityByProject`).

- **`agents projects` — named multi-repo projects with a project progress rollup (beta).**
  Define a project once in `~/.agents/projects/<name>.yaml` (name, home-relative
  root/defaultPath, multiple repos with monorepo subpaths, described `contexts[]`
  starting points, external `integrations[]`, Linear link) and `agents run --project
  <name>` resolves the definition before the old `<root>/<slug>` convention — undefined
  slugs behave exactly as before. The headline is `agents projects status`: instead of a
  per-agent activity line, it renders one card per project — live agents by state, plan
  completion, open **and** recently-merged PRs, tickets in flight, and the artifacts
  agents produced — by rolling up signals already on disk (live agents matched to a project
  by this machine's session cwd; the merged-PR count is repo-global via `gh`). `--window
  <days>` and `--no-remote`
  tune the PR/artifact lookup. Also `list` / `add` (infers root + origin slug) / `show` /
  `edit` / `import --from-factory` (absorbs the Factory `projects.json` registry) / `rm`.
  Enable with `agents beta enable projects`. Source: `apps/cli/src/lib/projects.ts`,
  `apps/cli/src/lib/project-status.ts`, `apps/cli/src/commands/projects.ts`,
  `apps/cli/src/lib/project-root.ts`.

- **The cross-fleet session sweep no longer hides sessions on manually-registered devices.** `agents sessions` fan-out (and therefore `--resolve`, cross-machine resume, and `--active`) picked peers with a strict `tailscale.online === true` test. A device registered with `address.via: "manual"` never gets a Tailscale peer entry at all, so its `online` stayed `undefined` and the sweep skipped it **permanently** — every session on that box was invisible and could not be resolved or resumed from any other machine. Peer selection is now `isDialableDevice`, a union of both liveness signals: a device with no Tailscale block is unknown-not-offline (the rule `ssh.ts` `renderDeviceTable` and Factory's `isDeviceOnline` already used, so the picker and the sweep finally agree on who exists), and a positive live SSH probe (`DeviceProfile.reachability`, RUSH-1965) additionally rescues a device whose snapshot says offline. A **failed** probe deliberately does not remove a peer — the probe runs on a short SSH budget and returns false negatives on a congested tailnet (observed calling the local machine unreachable), and letting that shrink the sweep would hide sessions on healthy boxes. Applied to both sweeps that share this shape. Source: `apps/cli/src/lib/devices/registry.ts` (`isDialableDevice`), `apps/cli/src/lib/session/remote-list.ts`, `apps/cli/src/lib/remote-agents-json.ts`.

## 1.20.91

- **An agent can now say it is stuck: `agents feed post --blocked` (RUSH-2110).** The
  feed carried benign progress but had no way to signal "I cannot proceed", so agents
  hand-rolled it into the status text (`NEEDS MUQSIT: …`) and it reached nobody. A
  blocked post writes `status.blocked` to the shared activity stream *and* opens an
  answerable block in the ledger, so the ask stays open until someone resolves it
  instead of scrolling away. It is a flag on the existing verb, not a new command —
  one thing for an agent to learn, and one stream where most posts are benign and
  some need a human. Blocked is a state, not a volume: it always broadcasts at
  `important`, so passing `--level` too is a usage error rather than a silent
  override. Pair it with `--option` for an answerable choice or `--default` for a
  safe fallback policy may apply. Source: `apps/cli/src/commands/feed.ts`,
  `apps/cli/src/lib/feed.ts`.
- **Feed blocks are actually delivered.** `publishBlock` wrote every "needs you"
  record to the ledger and stopped there — `broadcastPostedEvent` ran only for
  `feed post`, so a block was durable and invisible at the same time. Blocks now
  reach the configured `feed.broadcast` sinks, carrying the ask and the literal
  `agents focus <id>` command that unblocks it, and a block that reaches nobody
  exits non-zero instead of looking like a success. Source:
  `apps/cli/src/lib/feed-broadcast.ts`.
- **New `desktop` channel provider.** `agents send --channel desktop` (and
  `notify.owner.channel: desktop`) posts a native notification through the branded
  menu-bar helper. It is the only channel with no external dependency — no network,
  no login, no vendor CLI — so it still reaches you at your Mac when a messaging
  gateway is down. It reports real deliverability rather than always succeeding:
  on Linux it probes for `notify-send` instead of trusting the platform name.
  Source: `apps/cli/src/lib/channels/providers/desktop.ts`.

- **`agents perf` — disposable SQLite latency warehouse.** Indexed p50/p99
  rollups for hooks, CLI commands, and `agent.run` timings without scanning the
  audit JSONL. Warehouse lives at `~/.agents/.cache/perf/perf.db` (safe to wipe);
  identity columns reuse sessions/events string shapes (`session_id`, `agent`,
  `machine`, …) for soft cross-reference — no foreign keys. Hook shims spool
  into the same DB; `agents hooks profile` reads it first. Source:
  `apps/cli/src/lib/perf/db.ts`, `apps/cli/src/commands/perf.ts`.

- **A routine that misses its fire now runs late instead of being silently lost.** Fires
  are in-process croner timers, and croner only ever schedules forward from "now" — so a
  daemon that was down, asleep, or wedged when a routine came due dropped that fire
  outright, and `loadAll()` rebuilt every timer looking only at the future. Detection
  existed but ran **once, at daemon startup**, and only logged a warning plus a
  notification; catching up was a manual `agents routines catchup`. Observed cost: zion's
  daemon was down from 02:03Z to 08:23Z while the laptop slept, `weekly-fleet-retro` was
  armed for exactly 04:00Z, never ran, and the restart logged `2 routine(s) overdue` and
  did nothing. The daemon now re-scans every 5 minutes as well as at startup and runs each
  missed routine via the same detached path `catchup` already used. Source:
  `apps/cli/src/lib/catchup.ts`, `apps/cli/src/lib/daemon.ts`.
- **New `catchup:` routine field, and `agents routines add --no-catchup`.** Defaults to
  true — a routine you scheduled is one you expect to have run. Set `catchup: false` for a
  routine whose worth expires with its slot (a 9am brief is useless at 3pm); the miss is
  still recorded, it just is not re-run. `agents routines list --json` reports the
  effective value as `catchup`.
- **New `missed` run status.** A missed fire previously left no trace anywhere — no run
  record, no log line in the routine's history — so `agents routines list` kept showing the
  previous run's `completed` as though it were current, sometimes for weeks. A miss is now
  written as a real run stamped at the moment the fire was due, so `agents routines runs
  <name>` shows the gap, and the listing renders it distinctly from `failed` (a miss is an
  infrastructure problem, not a task failure). That record is also what makes catch-up
  idempotent: it advances the overdue comparison, so the same missed fire is never
  reconsidered across ticks or a daemon restart storm, and its directory is created with a
  non-recursive `mkdir` — an atomic claim, so if the daemon's timer and a manual
  `agents routines catchup` overlap, only one of them runs the routine. Source: `apps/cli/src/lib/routines.ts` (`RunMeta`),
  `apps/cli/src/commands/routines.ts`.
- **A routine is never caught up for a fire that predates it.** `detectOverdueJobs` walks back
  a week for the most recent expected occurrence, and a routine with no runs is overdue by
  definition — so before this, `agents routines add` on any daily or weekly schedule whose slot
  had already passed made the routine instantly "overdue". That was cosmetic while catch-up was
  a manual command; with the daemon now catching up automatically it would have run every newly
  created routine once, within five minutes of creating it. Routines gain a `createdAt` stamp
  (written once, like `actor`), and overdue detection floors the expected fire at it — falling
  back to the routine file's mtime for routines written before the field existed. Observed on
  the live fleet: `agents-cli-updates`, created Aug 1 and never run, was flagged overdue for a
  Jul 27 fire. Source: `apps/cli/src/lib/overdue.ts` (`routineEffectiveStart`),
  `apps/cli/src/lib/routines.ts` (`writeJob`).

- **`agents secrets list` can be filtered.** It had no filtering at all —
  `--host` picks a machine and `--json` picks a format, but nothing selected over
  the bundles themselves, so "which of these read with no Touch ID?", "which
  still store a raw value inline?", "what have I not touched in three months?"
  meant piping the table through `grep` or went unanswered. There is now an axis
  per question: a `[query]` positional over name and description, `--policy`,
  `--backend`, `--type`, `--kind`, `--held`/`--not-held`, `--expired`,
  `--expiring [days]`, `--unused <duration>`, plus `--sort` and `-n/--limit`.
  Every axis narrows independently, so they compose. Following the `agents
  sessions` house style, an unknown value is a loud error naming the valid set
  rather than an empty list, filters apply before `--json` so the payload is the
  exact twin of the table, and they are forwarded over `--host` so a remote list
  narrows the same way. `--held`/`--not-held` read live broker state and so
  refuse to run off macOS instead of reporting every bundle as unheld. An empty
  result names the filters that emptied it and the total it started from. Source:
  `apps/cli/src/lib/secrets/list-filter.ts`, `apps/cli/src/commands/secrets.ts`.

- **The EXPIRING column no longer hides keys that have already expired.**
  `countExpiringSoon` counted only keys due in the next 30 days — the guard is
  `d >= 0` — so a bundle whose token died last month rendered `-`, identical to
  one with no expiry at all. The only places a lapsed key surfaced were
  `agents secrets view` and a hard abort at inject time, i.e. after it had already
  broken a run. The column now counts lapsed and upcoming together and turns red
  once anything has lapsed, and `secrets list --json` gains an `expired` count
  alongside the existing `expiringSoon`. Source: `apps/cli/src/commands/secrets.ts`.

- **`agents secrets list` now states the hold window instead of the bare word
  `hold`.** The `hold` tier is a duration — prompt once, then stay silent for
  `secrets.agent.holdMs` (7 days by default) — but the POLICY column printed only
  the tier name, so a reader could not tell it meant a window, let alone which
  one; finding out meant running `agents secrets status`. The column now reads
  `hold 7d`, and `hold 7d · held 6d` while the broker is actually caching the
  bundle. It follows the configured window, so a 24-hour hold reads `hold 1d`.
  `always` and `never` are unchanged — neither has a window, and annotating one
  would repeat the mistake the `daily` rename fixed. Two adjacent bugs go with
  it: `agents secrets view` printed "7d by default" as a string literal and so
  misstated the window for anyone who had configured `holdMs`, and a stale broker
  entry past its expiry rendered as `hold · held expired` because the column
  tested the entry for presence rather than liveness. `secrets list --json` and
  `secrets view --json` gain an additive `holdMs` field (null on `always`/`never`)
  so a machine caller gets the window too. Source:
  `apps/cli/src/commands/secrets.ts`.

- **Richer session previews: skills, hooks, links, artifacts, repos, todo status.** The `agents sessions` quick preview and full summary now show the skills a session invoked (with counts), the hooks that fired (Claude transcripts, with repeat counts and failures), a clickable Links section (Linear/Jira/GitHub/GitLab URLs harvested from the conversation), the documents the session produced (`.agents/artifacts|plans|reports` and other `*.md`/`*.html` creations), the repos it worked in (via `.git` walk-up), and an error tally in the picker. The full summary's Plan section now marks checklist items `[x]`/`[>]`/`[ ]` and renders the checklist alongside the ExitPlanMode text instead of hiding it. Changes/Dirs lines collapse `.agents/worktrees/<slug>` prefixes to `⧉ <slug>/…`, are width-capped, and no longer list shell junk (`2>&1`, `$VAR` paths), `node_modules`, or agents-cli internal archives. Source: `apps/cli/src/lib/session/highlights.ts`, `apps/cli/src/lib/session/parse.ts`, `apps/cli/src/lib/session/render.ts`, `apps/cli/src/commands/sessions-picker.ts`.

## 1.20.90

- **Bash commands are now parsed and classified for richer activity summaries.** The
  `11-activity-log.py` hook tokenizes every Bash tool call and emits a structured
  `bash.executed` activity record with `category`, `bashTool`, and `bashAction`.
  High-signal commands also raise milestones: `video.rendered`/`video.converted`
  for `ffmpeg`, `image.upscaled` for `realesrgan`/`waifu2x`/`swin2sr`, and
  `metadata.edited` for `exiftool`/`id3v2`/`metaflac`/`vorbiscomment`. The session
  renderer and digest use the shared `lib/session/bash-command.ts` classifier.
  Source: `apps/cli/src/lib/session/bash-command.ts`,
  `apps/cli/src/lib/activity.ts`, `apps/cli/src/lib/session/digest.ts`,
  `apps/cli/src/lib/session/render.ts`.

- **`agents sessions --active` now shows one row per agent, not one per directory.**
  A live tmux agent pane whose durable identity records were missing (the common case
  once meta/pid-registry entries age out) was dropped, then re-surfaced by the ps-scan
  under the newest transcript in its cwd — so many distinct sessions collapsed onto one
  stranger's id with an inflated `×N` badge, and `agents sessions focus <id>` could not
  find them. The scanner now recovers the session id straight from the `ag-<agent>-<shortid>`
  tmux pane name (resolved to the full UUID via the short-id index in one batched query),
  and refuses to borrow a co-located sibling's transcript when no id is known — so every
  live session surfaces as its own row and is focus-able again. Also adds a `runTmux`
  timeout so a wedged tmux server can't hang the scan. Source: `apps/cli/src/lib/session/active.ts`.

- **`agents view` now shows live usage bars for Antigravity.** The `agy` account
  row renders one bar per model quota bucket (`3.1P: ███░░ 42% (1d)` style),
  sourced from the same Google Code Assist `:retrieveUserQuota` endpoint `agy`
  itself talks to. Auth reuses the stored `agy` OAuth credential (macOS Keychain
  item `gemini`/`antigravity`, Linux Secret Service, or the
  `~/.gemini/antigravity-cli/antigravity-oauth-token` file fallback), refreshing
  the access token in memory when expired — safe from a read path because
  Google's refresh tokens are non-rotating, and never written back to the
  keychain. Each per-model bucket also flows into the throttle badge, run
  rotation eligibility, and `agents view --json` (whose usage windows now carry
  a `label` so same-keyed per-model bars are distinguishable). Source:
  `apps/cli/src/lib/usage.ts`, `apps/cli/src/lib/agents.ts`,
  `apps/cli/src/commands/view.ts`.

- **A custom harness is now its own agent type in `agents view`.** A harness created
  with `agents harness add` (or `agents profiles add`) used to render as an indented
  `profile` row under whichever host CLI executes it. It now gets its own block beside
  Claude and Codex — a bold name header, then one row carrying the pinned model, the
  account/auth state, and `via <host> <version>` naming the native harness underneath.
  That matches how it is already launched: `agents run <name>` treats a custom harness
  exactly like a native agent id. A harness whose host CLI has no install is flagged
  `(host <id> not installed)` rather than listed as runnable, and the separate
  "Profile-only Agents" section is gone — those harnesses now render in the main list
  like every other one. Source: `apps/cli/src/commands/view.ts`.
- **`agents view <harness>` describes a custom harness** — host, model, provider, auth,
  fork lineage, YAML path — instead of failing with "unknown agent";
  `agents view <harness> --json` emits its summary. Source:
  `apps/cli/src/commands/harness.ts` (`renderHarnessDetail`).
- **New `agents harness fork <source> <name>`.** One verb over both starting points:
  fork a native harness (`agents harness fork opencode deepseek --model
  deepseek/deepseek-v4-flash-0731 --auth-provider openrouter`) or copy a custom one you
  already tuned and change only what you name (`agents harness fork deepseek
  deepseek-chat --model deepseek/deepseek-chat-v3`). Forking a custom harness is a full
  copy — env, endpoint, auth binding, `fallback_model`, host version pin — so the two
  diverge and deleting the source never affects the fork; forking a native harness
  requires `--model` because there is no model to inherit. Flags: `--model`,
  `--base-url`, `--auth-provider`, `--version`, `--label`, `--description`,
  `--key-stdin`, `--force`. Source: `apps/cli/src/lib/profiles.ts` (`forkProfile`).
- **Profile YAML gains optional `label:` and `forkedFrom:`.** `label` sets the name
  `agents view` prints for the harness (defaults to the file name); `forkedFrom` records
  the parent as display-only lineage. Existing profiles keep working untouched. Source:
  `apps/cli/src/lib/profiles.ts`.
- **Breaking (`--json`):** in `agents view <agent> --json`, the per-agent `profiles` key
  is now `harnesses`, and each entry carries new `label`, `hostVersion`, `description`,
  and `forkedFrom` fields alongside the existing ones. Source:
  `apps/cli/src/commands/view.ts` (`ViewJsonAgent`).

- **Menu bar ACTIVE: project accordion + session detail submenu.** Projects are
  collapsed by default as a status strip (`▶ agents-cli  ●8 ◐1  zion`); click
  `▶`/`▼` to fold agents open under the project (idle-row caps removed — collapse
  is the wall protection). Focusing an agent opens a side submenu with linkable
  detail (work title URL, cwd, Linear ticket, GitHub PR, duration, copy session
  id) from the warm `sessions --active` cache. Accordion reopen rebuilds from
  cache only (no teams walk / no CLI schedule). Local/remote uses the same host
  normalize as CLI `machineId()` so local rows are not mislabeled remote. Source:
  `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`,
  `LocalState.swift`, `Models.swift`.

- **An offloaded editor tab no longer displays another session's id.** A Factory
  tab launched with `agents run --host <device>` has no local agent process, but
  the extension still resolved its "live" session id by reading the SessionStart
  hook's `~/.agents/.cache/state/sessions/<pid>.json` for the local pid tree —
  the pid of the ssh client. Those files are keyed by pid alone and are only
  pruned when the pid is dead, so once the OS recycled a pid the tab adopted
  whatever session had last held it: one remote tab showed the id and version of
  an unrelated synthetic run from 20 days earlier while `/status` inside it
  reported the truth. An offloaded tab now takes its identity from the device
  instead of local disk, and a local tab rejects any state record whose
  SessionStart timestamp predates the tab itself.
- **`AGENT_TERMINAL_ID` now rides the SSH hop.** `agents run --host` forwarded
  actor provenance but not the launching tab's terminal id, so the remote pid
  registry recorded no terminal — leaving `agents sessions --active --host
  <device>` unable to answer "which session is this tab running?" once the agent
  moved on (a `/clear`, or an exit and rerun in the same tab).
- **`agents sessions --active --json` now carries `terminalId`.** The pid registry
  has always recorded it; the emitted row dropped it, so no consumer could join a
  live session back to the editor tab that launched it.

- **Balanced routing no longer launches into an account it only *thinks* has
  headroom.** Account usage is cached per machine under stale-while-revalidate:
  a snapshot up to 24h old was served instantly, and the background refresh that
  should have corrected it lands after the pick is already made. On a box whose
  refresh is failing that state is permanent — measured on `yosemite-s1`, every
  Claude snapshot sat 26 hours to 2.7 days old, so balanced read
  `muqsit@getrush.ai` as 48% used and launched into it while the account was at
  its weekly cap; the session answered "You've hit your weekly limit" on its
  first turn. Routing now caps how stale a snapshot may be when it is about to
  decide (5 minutes), blocking on one bounded, parallel live read past that — and
  no read at all inside the existing 2-minute fresh window, which back-to-back
  launches hit. Display paths (`agents view`) keep the full 24h window and stay
  off the network.
- **A pick made on unconfirmed data says so.** When no account on the machine
  could be refreshed, routing still launches — a broken refresh must not make a
  box unusable — but the banner now reads `… (2 of 5 healthy, usage unverified —
  no account could be refreshed)` instead of presenting a guess as a fact. An
  account with a verified snapshot always wins over one with a stale snapshot,
  even when the stale number looks emptier. This applies to `--strategy
  available` as well as `balanced` — both route on the same cache, and
  `available`'s headroom sort was inverted by a stale number in exactly the same
  way. An explicit version preference is an instruction, not a ranking signal, so
  it still wins.
- **The mid-run failover chain is unchanged.** Declining to *pick* an account on
  unconfirmed data and declining to *fail over to* it after the primary already
  hit a 429 are different risks — by then the alternative is not launching at
  all. Every eligible account stays in the failover chain; only the initial pick
  prefers verified ones.

- **`agents routines list` no longer reports another device's routine as failed.** Run
  records are written into the runs dir of whichever machine fired the routine and carry
  no device attribution, but the listing resolved Last Status from any local record and
  rendered it even on rows for routines pinned elsewhere. A routine re-pinned to another
  device therefore kept reporting the old machine's leftover records forever — on zion,
  `security-sweep`, `review-open-prs` and `hetzner-lease-gc` all read `failed` from late
  July while `yosemite-s0`/`s1`, the devices that actually fire them, had completed them
  that morning. The macOS menu bar reads this JSON, so it painted a column of red `exit 1`
  rows for routines that were green. Last Status is now scoped to the device that owns the
  run: a routine this device does not fire shows `-`, and `--json` returns `null` for
  `lastStatus`, `exitCode`, `failureReason`, `lastRunStartedAt` and `lastRunCompletedAt`
  (`runsHere: false` already says why). A routine pinned to several devices renders one row
  per device but carries a status only on its **This machine** row. Read a peer's status
  with `agents routines list --device <name>`; the local history is untouched and still
  readable via `agents routines runs <name>`. Source: `apps/cli/src/commands/routines.ts`
  (`localLatestRun`, `groupRoutineJobsByDevice`), `apps/cli/docs/03-routines.md`.

- **`agents watchdog` now tracks per-session presence (RUSH-2007 Layer C).** Each
  tick reconciles a per-session presence record — `{location, device, transport,
  lastSeen, status}` at `~/.agents/.cache/state/watchdog/presence.json` — from the
  tick's active scan, deriving `connected` / `disconnected` by diffing consecutive
  ticks. A session that was tracked but is now absent (its SSH link dropped or the
  peer went unreachable) flips to `disconnected`, and the flip is surfaced in
  `agents watchdog --json` under `presence.transitions` — an interactive drop as a
  `reconnect-nudge` candidate, a headless remote as `keep-alive`. Folded into the
  existing tick (no revived daemon, no extra SSH fan-out); additive and does not
  change the tick's nudge decisions. Source:
  `apps/cli/src/lib/session/presence.ts`, `apps/cli/src/lib/watchdog/runner.ts`.

- **`agents setup secrets --policy hold` no longer fails, and `agents secrets
  status` stops naming the retired `daily` policy.** The 1.20.79 `daily` → `hold`
  rename swept the help, docs, and the `secrets list` POLICY column, but two
  surfaces were never migrated. The worse one was functional: the onboarding
  wizard carried its own copy of the policy vocabulary, so
  `agents setup secrets --policy hold` — the canonical name every other secrets
  command prints — exited with `Invalid --policy 'hold'. Use daily, always, or
  never.`, and its interactive prompt still offered `daily` as the default
  choice. It now shares `parsePolicyOpt` with `agents secrets policy`, so the two
  commands can't disagree about what a policy is called; `daily`/`session` stay
  accepted as aliases and the wizard's default is unchanged (the hold tier). The
  second was cosmetic: `agents secrets status` printed "a daily bundle prompts
  once…" and "the next read of each daily bundle…" — the one command a user runs
  to answer *why did it prompt again*, naming a policy its sibling commands no
  longer emit. Both lines now say `hold` and are pure values pinned by tests, so
  the vocabulary can't drift again. Source:
  `apps/cli/src/commands/setup-secrets.ts`, `apps/cli/src/commands/secrets.ts`.

- **Favorite sessions from the browser.** `*` stars the highlighted session in
  `agents sessions` and `f` filters the list to the starred ones; outside a TTY,
  `agents sessions favorite <id>` (`--remove` / `--list` / `--json`) and
  `agents sessions --favorites` do the same. Stars live in
  `~/.agents/.history/favorites.json` keyed by session id, so they survive a reindex
  of the session cache. They are per-machine — session sync carries transcripts, not
  this file. Source:
  `apps/cli/src/lib/session/favorites.ts`, `apps/cli/src/commands/sessions-favorite.ts`.
- **Detect sessions that lost their host — two new statuses, `crashed` and `orphaned`.**
  A session whose editor window or connection went down hard used to just VANISH from
  `agents sessions --active` (its dead-pid registry entry was filtered out), and one
  still running in tmux with nobody attached reported a plain `idle`. Both now say so:
  `✗ crashed` when the host window stopped republishing and the agent died with it,
  `◍ orphan` when the agent is alive with zero clients attached. Derived from tmux's
  `#{session_attached}` and the IDE window's registry heartbeat — never from a
  deliberate `agents sessions detach`, and never over a session that is still working.
  Source: `apps/cli/src/lib/session/host-link.ts`, `apps/cli/src/lib/session/active.ts`.
- **`agents sessions --active --favorites` now actually filters.** The flag was wired
  into the interactive browser only, so every path that skips it — `--json`,
  `--waiting`, a pipe, a multi-host scope, an SSH-fanout peer — silently returned the
  whole fleet. Source: `apps/cli/src/commands/sessions.ts`.
- **`agents sessions --active --waiting` no longer counts a dead session.** `activity`
  is not rewritten when a session dies, so one that crashed mid-question reported "needs
  your input" forever — what it needs is a relaunch. Source:
  `apps/cli/src/commands/sessions.ts`.

- **Resolve historical sessions safely across the fleet (#1757).** `agents sessions --resolve <full-id|prefix|keywords> --json` uses a versioned safe peer protocol, returns only resolver metadata, reports every full-ID candidate on ambiguity, treats synced copies as one match, and exits 2 without deciding when a peer fails, returns malformed output, or runs an older CLI. Source: `apps/cli/src/commands/sessions.ts`.

- **A rate-limited usage endpoint is now backed off instead of hammered.** The
  daemon warms auth-health every 3 minutes and probes *every installed version
  home* in one parallel batch, so a machine with five Claude accounts sent five
  concurrent requests to `api.anthropic.com/api/oauth/usage` every three minutes
  — roughly 100/hour — before the usage refresh added its own. Nothing read
  `Retry-After`. Measured on `yosemite-s1`: the endpoint answered
  `429 rate_limit_error` with `retry-after: 2678` (about 45 minutes) for every
  account while the credentials themselves read healthy, and the next tick fired
  three minutes later, deep inside the penalty window, re-arming it. The box
  never recovered, every usage read failed, and its cache froze — the
  permanently-stale state balanced routing was already having to defend against.
- **A 429 now records its deadline and every read honours it.** Usage fetches and
  health probes for that provider short-circuit until the window passes — no
  request, no renewed penalty — and report
  `Claude rate-limited this machine — not retrying for 45 minutes.` The state is
  on disk, because the callers are separate processes: the long-lived daemon and
  every one-shot `agents view` / `agents run` — one empty file per penalty under
  `~/.agents/.cache/usage-backoff/`, named `<agent>.<deadline>`, so two
  processes recording the same provider at once cannot displace each other and a
  read takes the furthest deadline. A server delay is capped at an hour, and a
  missing or unparseable `Retry-After` still backs off.

- **A usage read that fails now says so, instead of returning a silent null.**
  Four branches in every networked usage fetch — Claude, Kimi, Droid and
  Cursor — returned `{ snapshot: null, error: null }`: no readable credential, a
  locally-expired one, a rejected request, and a request that threw (timeout,
  DNS/TLS, an unparseable payload). The caller could not tell any of them apart
  from a healthy read, so it fell
  back to whatever the stale-while-revalidate cache held and drew those bars as
  fact. Measured on `yosemite-s1`: every Claude account's stored access token had
  expired (one of them eleven days earlier), so no read could succeed, and
  `agents view claude --refresh` printed a full, healthy-looking table twice
  while writing nothing to the cache. A usage read never refreshes a token
  (RUSH-1822), so an expired credential does not heal on its own — the account
  stays unreadable until that agent actually runs. A rate-limited endpoint (429)
  now reads differently from a rejected credential (401), because re-authing
  fixes one and not the other.
- **`agents view` marks bars the live read could not confirm.** A row whose
  snapshot came from the cache after a failed live read renders the reading plus
  `unverified`, rather than looking identical to a confirmed one. The number
  still shows — it is the last thing we saw — but it no longer reads as current.
- **`agents view --refresh` reports what it could not refresh.** It now lists
  each account it failed to reach and why, instead of rendering a table that
  looks fully refreshed regardless.

## 1.20.89

- **Webhook handler layer for one-off agent/workflow/command/routine triggers.**
  Routines still fire from signed webhooks, but a new `~/.agents/webhooks/*.yml`
  layer can also run one-off actions: `run.agent`, `run.workflow`, `run.command`,
  or delegate to an existing `routine`. Handlers support the same source/event/
  action/label/repo/branch filters as routine triggers, plus Linear
  `stateTo`/`stateFrom` state-change filters. Prompts and commands can use
  `{{issue.identifier}}`, `{{updatedFrom.state.name}}`, etc. The receiver emits
  `webhook.received`, `webhook.authorized`, `webhook.rejected`, `webhook.matched`,
  `webhook.fired`, `webhook.handler.start`, and `webhook.handler.end` events.
  Source: `apps/cli/src/lib/triggers/handlers.ts`,
  `apps/cli/src/lib/triggers/webhook.ts`, `apps/cli/src/lib/routines.ts`,
  `apps/cli/src/commands/routines.ts`, `apps/cli/docs/03-routines.md`.

- **`agents routines add` gains `--state-to` and `--state-from` filters for Linear
  triggers.** A Linear routine or handler can now fire only on a specific state
  transition (for example `--state-to Plan`), instead of on every issue update.

- **Values substituted into `run.command` are shell-quoted.** A webhook context is
  built from an external payload, and fields like `issue.title` or a GitHub
  `pull_request` title are free text any outside contributor can set — pasted raw
  into a shell command they would be a command-injection sink. Substituted values
  are now single-quoted (POSIX `sh`), so a payload stays one inert argument while
  the operator's own template keeps its pipes, redirects, and `&&`. On Windows,
  where `exec` runs through `cmd.exe` and these quoting rules do not hold, a
  `run.command` containing `{{…}}` is refused with a clear error rather than run.
  `run.prompt` is unaffected — it never reaches a shell.
  Source: `apps/cli/src/lib/routines.ts` (`substituteWebhookCommand`,
  `assertShellSubstitutionSupported`), `apps/cli/src/lib/triggers/handlers.ts`.

- **The `Cmd-Shift-O` quick-dispatch bar now lists the repo's open Linear tickets,
  and dispatches one on a click (RUSH-2098).** The panel only captured NEW work;
  it now also shows what already exists. Switching the repo dropdown switches the
  Linear project (the repo name is matched against `linear projects` reduced to
  lowercase alphanumerics, so `agents-cli` finds "Agents CLI" with nothing to
  configure; a worktree resolves to its parent repo, and a repo that matches no
  project says so and lets you pick one, remembered per repo). Rows are ranked
  urgent-first — Linear priority, then overdue, then in progress, then newest —
  and typing filters them, so an existing ticket surfaces before Return files a
  duplicate. Clicking a row (or `⌘1`–`⌘5`) dispatches that ticket to the selected
  agents in the picked repo: **Run** claims it and implements it, **Plan** posts a
  plan as a ticket comment. `⌘`-click opens it in Linear instead. The list renders
  from a 90-second warm cache so the panel still appears instantly. Source:
  `apps/cli/menubar/Sources/MenubarHelper/LinearTickets.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/AgentsCLI.swift`.

- **Fixed: a menu-bar dispatch whose child printed more than ~64 KiB hung forever
  and never notified.** The helper read a monitored child's stdout only from the
  process-termination handler, so a child that filled the pipe buffer blocked on
  write, never exited, and the completion callback never fired — two `linear`
  processes were left wedged by a single ticket fetch. Both monitored paths (the
  ticket agent and `linear create`) now drain stdout, and feed stdin, on a
  background queue while the child runs. Source:
  `apps/cli/menubar/Sources/MenubarHelper/AgentsCLI.swift`.

- **The daemon warns when it was launched from an ephemeral root.** A daemon
  started from a temp dir (`/tmp`, `/var/folders`, `/dev/shm`) or a git worktree
  resolves its own job modules by dynamic `import()` rooted at the launch entry
  (`getAgentsBinPath` → `process.argv[1]`). When that directory is later removed
  — a `/tmp` cleanup, a review/verify checkout teardown, `git worktree remove` —
  the long-lived daemon keeps ENOENT-ing on every routine's imports
  (`auto-dispatch.ts`, `routines-placement.ts`, `devices/fleet.ts`), silently
  wedging until restart. `anchorDaemonCwd` already rescues the cwd, but nothing
  can re-root a deleted module tree. `runDaemon` now calls
  `warnEphemeralDaemonRoot` at startup, so the risk is logged the moment the
  daemon comes up — including a direct `agents __daemon-run` that never passes
  through the launch-time `validateDaemonBinary` check. That launch-time check is
  also broadened from git-worktree-only to any ephemeral root via the shared
  `describeEphemeralDaemonRoot` predicate. The fix for a wedged daemon is
  unchanged: run it from the globally installed binary
  (`npm i -g @phnx-labs/agents-cli`) so its entry roots at a stable version home.
  Source: `apps/cli/src/lib/daemon.ts`
  (`describeEphemeralDaemonRoot`, `warnEphemeralDaemonRoot`, `validateDaemonBinary`).

- **A `README.md` / `AGENTS.md` sitting in a resource directory is no longer
  installed as a resource.** `listResources` skipped only dotfiles, so every `.md`
  beside the actual resources was materialized as one: `commands/README.md` — which
  the system repo has shipped for months — installed a bogus `/README` slash command
  into every agent home, and adding per-directory `AGENTS.md` docs would have added
  `/AGENTS`, `/CLAUDE`, and `/GEMINI` alongside it. `README`, `AGENTS`, `CLAUDE`, and
  `GEMINI` are now filtered from both `listResources` and `resolveResource` for every
  kind **except `rules`**, where `AGENTS.md` *is* the resource (the composed ruleset
  that syncs as each agent's memory file). The check tests `!entry.isDirectory()`
  rather than `isFile()`, because a `Dirent` for a symlink reports
  `isFile() === false` and `CLAUDE.md`/`GEMINI.md` are symlinks to `AGENTS.md` by
  convention — a resource *directory* named `agents/` is still a real resource.
  Verified against the real installed layers: 30 commands with `README` leaking
  before, 29 with none after.
- **`agents commands list` and the command picker no longer offer a name that
  cannot be opened.** `listCentralCommands` and `discoverCommands`
  (`src/lib/commands.ts`) run their own `readdirSync` scans rather than going
  through `listResources`, so they kept offering `README` while
  `agents commands view README` answered "not found" — a listed-but-unopenable
  name. Both now share the one exported `isDirectoryDoc` predicate, so every
  enumerator agrees. Verified: 27 names with `README` before, 26 with none after.
- **`agents commands add/remove/view` no longer suggest `README` as the example
  command name.** With `README` reserved as a directory doc, the six hardcoded
  examples in the help text and non-interactive hints named a command that can never
  exist. They now use `plan`, which actually ships.

- **File-backed secrets bundles no longer require `AGENTS_SECRETS_PASSPHRASE` on
  macOS.** The encrypted file store now silently auto-provisions a stable
  machine-local key (a 0600 file under `~/.agents/.secrets-key/`, kept outside the
  encrypted store) on first use on **every** platform, macOS included — no prompt,
  no Touch ID, nothing to set or remember. Previously a file-backed bundle on a Mac
  hard-failed unless `AGENTS_SECRETS_PASSPHRASE` was exported, which blocked
  headless reads (e.g. the `auth` bundle the usage/auth reader consults) and
  frequently hung. Setting `AGENTS_SECRETS_PASSPHRASE` still works and takes
  precedence — use it to hold the key off disk or to share one bundle's ciphertext
  across boxes under a common key. Source: `apps/cli/src/lib/secrets/filestore.ts`,
  `apps/cli/src/lib/secrets/bundles.ts`.

- **Menu-bar & daemon notifications now use the current agents-cli mark, not the
  legacy logo.** A desktop notification from the menu-bar helper or the routines
  daemon showed the old `assets/logo.png` gradient "A" — outdated, and blank in the
  notification's left-hand app-icon slot. `MenubarHelper.app`'s `AppIcon.icns` is
  now generated from the current brand mark (`assets/app-icon.svg` → `app-icon.png`:
  the lime-tile lowercase `a` shared with the agi-cli web favicon and the menu-bar
  glyph), which drives both the notification's right-hand `contentImage` and its
  left-hand app icon. The installer also registers the bundle with LaunchServices
  (`lsregister -f`) at its `~/Library/Application Support` path so the OS can resolve
  that app icon. Source: `apps/cli/menubar/scripts/build.sh`,
  `apps/cli/src/lib/menubar/install-menubar.ts`, `assets/app-icon.svg`.

- **The menu bar is a single instance, always.** Two copies of the helper could
  run at once — launchd's `KeepAlive` service plus a LaunchServices/`open` launch
  of the same `.app` — putting two agents marks in the menu bar, and the second
  copy could hold `Cmd-Shift-V`/`Cmd-Shift-O` (`RegisterEventHotKey` is
  first-come). The helper now takes an `flock` on
  `~/.agents/.cache/state/menubar.lock` at launch and holds it for its lifetime;
  a helper that cannot take the lock pops the **running** helper's menu open and
  exits 0, since re-launching a menu-bar app means "show me the one I already
  have". An `flock` rather than a pid file: the kernel releases it when the
  holder dies, so a `SIGKILL`ed helper cannot leave a stale "already running"
  that blocks every later launch. Source:
  `apps/cli/menubar/Sources/MenubarHelper/SingleInstance.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`.

- **`agents menubar setup` configures the menu bar end-to-end.** One idempotent
  command for a machine that is wrong — never configured, helper down, or showing
  a duplicate icon. It ends every running helper, installs/refreshes the bundle,
  checks its code signature, writes the launchd login item (`RunAtLoad` +
  `KeepAlive`), clears a previous `agents menubar disable`, and verifies exactly
  one helper came back up — reporting each as its own step and exiting nonzero if
  it cannot reach that state. `--check` reports without changing; `--json` emits
  the step list. Source: `apps/cli/src/commands/menubar.ts`,
  `apps/cli/src/lib/menubar/install-menubar.ts`.

- **`agents menubar status` now shows a duplicate.** Live helper processes were
  collapsed to a boolean `running`, so two copies of the *installed* bundle — the
  duplicate a user actually sees — reported as healthy. `--json` now carries an
  `instances` array (copies of the installed bundle) beside the existing
  `foreignInstances`, and the text readout names every extra pid and points at
  `agents menubar setup`. Source:
  `apps/cli/src/lib/menubar/install-menubar.ts` (`classifyMenubarProcesses`).

- **Quick-dispatch ticket list: one-row filter + sort, and a scrollable list.**
  The ticket controls sit on a single row of popups next to the Linear project
  (project · filter · sort) — not a chip matrix or two-column block. Quick filter
  options: All open, Todo, Doing, Backlog, P1 only, P2 only, Overdue. Quick sort
  options: Urgent first, Newest, Oldest, Due date, Priority (flat list, no
  status grouping). Filter and sort picks are remembered across summons. Ticket
  rows scroll inside a fixed viewport so more than five matches stay reachable
  without growing the panel. Source:
  `apps/cli/menubar/Sources/MenubarHelper/LinearTickets.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`.

- **`release.sh` now takes a release lease, and refuses to bump past an
  unpublished tag.** Releases run from whichever fleet box an agent happens to be
  on, so two agents could enter the pipeline at once; the collision only surfaced
  at the publish gate (`merged tree != built tree -- refusing to publish`), after
  one run had already merged and tagged, leaving the version merged but unshipped.
  A new `scripts/release-lease.sh` holds mutual exclusion on `origin` as an orphan
  commit at `refs/release-lock/held` — a second claimant's push can never be a
  fast-forward, so git's rejection *is* the failed lock acquisition. The lease is
  claimed before the first mutation and dropped by the existing cleanup trap on
  every exit path. Because a healthy release routinely outlives any sane
  expiry — the CI matrix alone has run 57 minutes and release 1.20.77 took 186
  minutes — the lease is **renewed** by a background renewer for the whole run,
  and the squash-merge, the tag, and the publish each **verify** ownership first,
  failing closed if it can no longer be proven. A lease that stops being renewed
  is reclaimable after 30 minutes, and reclaiming names the dead holder instead
  of silently overwriting it. Separately,
  `release.sh` now refuses to cut a new version while an older `v*` tag exists
  that npm never received, and points at the re-run that finishes it — bumping
  past an unpublished tag is what turned a one-version gap into npm 1.20.78 vs
  main 1.20.81. Source: `apps/cli/scripts/release-lease.sh`,
  `apps/cli/scripts/release.sh`.

- **`agents funnel down` disables a public Funnel port from the same wrapper used
  to enable ingress.** Webhook ingress now has a complete local receiver runbook:
  keep GitHub/Linear signing keys in `agents secrets`, bind the receiver to
  `127.0.0.1`, expose it with `agents funnel up`, rotate one source secret at a
  time, and turn the public port off with `agents funnel down` before stopping or
  moving the receiver. Source: `apps/cli/src/commands/funnel.ts`,
  `apps/cli/src/lib/funnel.ts`, `apps/cli/docs/03-routines.md`.

- **New `agents secrets rotate-passphrase` re-keys the encrypted file store under
  a new master passphrase, atomically (RUSH-1975).** Until now there was no
  supported way to rotate the file-store passphrase — `rekey` only renames macOS
  keychain service names and `rotate <bundle> <key>` replaces a single secret
  value, so a leaked passphrase (RUSH-1968) could only be remediated by a
  hand-rolled non-atomic script or an export-to-plaintext round-trip (the exact
  exposure being fixed). The new command decrypts every `<item>.enc` under the
  current key, re-encrypts under a freshly generated one, and swaps both the
  ciphertext and the 0600 key file by directory rename after verifying every item
  round-trips. A crash at any point self-heals on the next *rotate* run to a single
  readable store — content-aware recovery probes which key actually decrypts the
  live store (not merely which files are present) and classifies the WHOLE store:
  it completes the rotation forward or rolls back only when one key opens every
  item, and if a later `secrets set` contaminated a crashed rotation into a MIXED
  store (items under two keys at once, or a store dir recreated by an interstitial
  write after the crash left it absent, so its backup holds items the live dir does
  not) it refuses with an actionable error and preserves every recovery artifact
  rather than sweeping the only copy of a key or the backed-up ciphertext — so a
  crash anywhere in the swap can never orphan the store, even when a write landed in
  between. The rotation and every store write run under
  one cross-process lock, so a `secrets set` or a second rotation can never
  interleave with a swap in the first place. No plaintext secret or passphrase is
  ever written to disk, argv, or a log. Items
  that don't decrypt under the current key (orphan caches, stale test artifacts)
  are carried through verbatim, never re-keyed. Dry-run by default (`--commit` to
  apply). A dry run never re-keys, but it *does* heal an interrupted rotation —
  that is how a crashed store becomes readable again without re-keying it — and it
  says so instead of claiming nothing was written. Refuses while the secrets-agent
  holds live unlocks or while
  `AGENTS_SECRETS_PASSPHRASE` is exported in the environment, unless `--force`.
  Headless-safe and Linux-first. Source: `apps/cli/src/lib/secrets/filestore.ts`,
  `apps/cli/src/commands/secrets-rotate-passphrase.ts`.

- **`agents sessions --active --json` now reports who is watching each session.**
  The `viewingIn` field carries the same string the table prints — `codium tab 3`,
  `ghostty tab 2`, or `detached` for a live tmux pane with **no client attached**
  (its terminal was closed or crashed). It is `null` both for a session that isn't
  tmux-hosted and for one whose pane the locator could not resolve — `detached` is
  claimed only when the pane was actually located, so absence of evidence is never
  reported as evidence of absence. Previously the JSON path returned
  before the locator pass ran, so the field never appeared and a machine consumer
  could not tell a session someone is looking at from an orphaned one — which is
  exactly what the Factory extension's `Agents: Resume` picker ranks by. The JSON
  path resolves tmux clients only — no osascript — so scriptable output keeps the
  cheapness the old ordering was protecting; a Ghostty-attached client resolves as
  `ghostty` without its tab number. Peers running an older CLI that still emits the
  `{app, tab}` object are normalized at the fan-out boundary, so a mixed-version
  fleet sweep stays correct. Source: `apps/cli/src/lib/session/viewing-in.ts`
  (`viewingInLabel`, `parseViewingIn`), `apps/cli/src/commands/sessions.ts`
  (`serializeActiveSessionsForJson`, `enrichTmuxLocators`),
  `apps/cli/src/lib/session/remote-active.ts`.

- **Webhook handlers gain `run.env` and `host` placement.** A handler can now
  inject environment variables into the process it spawns (`run.env`), and choose
  where that run executes (`host`). `host` takes a device name (`yosemite-s0`), or
  `fleet` to pick any eligible online worker, or `fleet/<platform>` /
  `<platform>/fleet` (also a bare `linux` / `macos` / `windows`) to restrict that
  pick to one platform. A fleet expression that matches no eligible device fails
  loudly rather than silently falling back to the local machine, so `fleet/linux`
  can never land on a macOS box. Omitting `host` runs locally, as before.
  Source: `apps/cli/src/lib/triggers/handlers.ts` (`resolveHandlerHost`),
  `apps/cli/src/lib/routines-placement.ts` (`pickFleetDevice` platform filter),
  `apps/cli/src/lib/routines.ts` (`JobConfig.env`), `apps/cli/src/lib/runner.ts`.

## 1.20.88

- **`agents doctor` redesigned into a prioritized, fleet-aware, per-version
  readout (RUSH-2069).** Comprehensive by default (no `--verbose`): a top
  `✗ CRITICAL — needs you now (N)` section lists every critical across the whole
  fleet worst-first (`device · harness@version · account · message → remediation`),
  then a `─── by computer ───` section gives each device its warnings plus a
  compact accounts/versions line showing every installed version and its account
  (provable ✓ / ✗). A single-machine `agents doctor` collapses to the CRITICAL
  section plus one `▸ <machine>` block. Severity: provable logged-out, a missing
  hook/plugin, a broken CLI, and a never-synced version whose declared resources
  are therefore absent are CRITICAL; drift, version-skew, repo-behind/-drift,
  orphans, and an unprovable logout are WARNINGS. Sign-in is
  now probed **per installed version** (each version's own home + the global
  credential via the new `credentialPresence`), so a per-version logged-out claim
  is made only when both are absent, agents with no inspectable identity never
  report logged-out, and the login remediation is
  version-targeted (`agents run <agent>@<version>` for the isolated set;
  gemini/antigravity/droid/cursor say the login is shared). Older fleet boxes that
  can't report per-version sign-in surface an "older agents-cli — upgrade"
  warning. The readout is de-duplicated so one root cause is one line: a version's
  missing hooks/plugins and drifted resources collapse to a count plus two
  examples (`32 hooks missing (incl. 'a', 'b')`), the same problem on several
  versions of one agent reads as `claude (5 versions)` with an agent-wide fix
  (isolated copies stay on their own line, since the sweep skips them), every
  orphan row on a machine folds into one cleanup-only line, and a version that
  already listed its drifted resources no longer also says "sources changed since
  last sync". The two advisories that predate the redesign are findings now, not
  separate blocks: credential-shaped exports in shell rc files (RUSH-1968) and the
  Windows execution policy that blocks `agents.ps1`. The duplicate-version-home
  hook check keeps its text output too — differing copies are critical, identical
  ones a warning, one row per agent rather than one per hook — and so does the
  Host CLIs check, as a `host CLIs` warning naming `agents cli install <name>`.
  Remediations reach every version in their row: a row collapsed across versions
  uses `agents sync <agent>@all --yes` (a bare `agents sync <agent>` would fix only
  the default version), a cross-device resource gap says `agents repo pull` rather
  than the central-to-home `agents doctor --fix`, and a diverged config repo names
  its own alias instead of always saying `user`.
  `agents doctor --json` adds a `findings` array and a per-version
  `fleet.signIn` map; the existing `clis`/`sync`/`orphans`/`fleet`/`signIn`/`repos`
  fields are unchanged. Source: `apps/cli/src/lib/devices/doctor-findings.ts`,
  `apps/cli/src/lib/devices/fleet-inventory.ts`, `apps/cli/src/lib/agents.ts`,
  `apps/cli/src/commands/doctor.ts`.

- **Run Cursor routines safely (RUSH-2080).** Routines configured with `agent: cursor` now reuse the same-device login under the default sandbox, trust the configured workspace without `--yolo`, warn when a requested read-only plan is elevated to writable edit mode (including `loop:` jobs), and record successful runs correctly. Source: `apps/cli/src/lib/runner.ts`.

- **`agents sessions` now discovers, indexes, and renders Cursor agent transcripts (RUSH-2081).**
  Cursor writes its conversation to `projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`
  and metadata to `chats/<workspace-hash>/<uuid>/meta.json`. Discovery starts from the transcript
  and joins metadata by UUID, so abandoned chats with no transcript never become empty rows.
  Cursor is installed outside agents-cli's managed version homes, so users with any managed
  agent version must pass `--unmanaged` to include Cursor rows.
  Source: `apps/cli/src/lib/session/discover.ts`, `apps/cli/src/lib/session/parse.ts`.

- **Fix Cursor usage and account inspection (RUSH-2082).** `agents usage` now derives support from the usage library so Cursor, Grok, and future usage sources cannot drift from the command, and `agents run cursor@` can inspect Cursor's active account. Source: `apps/cli/src/commands/usage.ts`, `apps/cli/src/lib/agents.ts`.

- **Sync Cursor commands to the IDE and cursor-agent CLI (RUSH-2083).** Shared commands now remain available as typed IDE slash commands and are also generated as Agent Skills for cursor-agent, while preserving user-authored files in `.cursor/commands/`. Source: `apps/cli/src/lib/command-skills.ts`.

- **Daemon routines resolve `agents` on `~/.local/bin` installs.** The generated daemon service (systemd + launchd) now puts the `agents` shim's own directory on `PATH`, not only the Node runtime dir. On a box where the shim lives outside the Node bin dir (a `~/.local/bin` global install, a separate npm prefix), the daemon's `PATH` previously carried only the Node dir, so every scheduled `command` routine — the always-on watchdog included — shelled out to a bare `agents` that resolved to nothing and died with `exit 127`. Source: `apps/cli/src/lib/daemon.ts`.

## 1.20.87

- **`agents devices enable|disable|prefer|unprefer <name>` control which machines
  Factory auto-launches onto.** A *disabled* device is skipped by
  `New <Agent>` and the balanced launch, but stays available through
  `New <Agent> (Pick Host)`. A *preferred* device wins ties against otherwise
  equivalent machines — worth about two running agents in the ranking, so a
  preference never sends work to a box that is genuinely swamped. Every device
  is enabled and unpreferred by default, and an unregistered name is now
  rejected instead of writing a preference that matches nothing. Preferences
  live in `~/.agents/.history/devices/auto-launch.json`, written by the CLI and
  read by the extension. Source: `apps/cli/src/lib/devices/registry.ts`,
  `apps/cli/src/commands/ssh.ts`, `apps/factory/src/core/deviceAutoLaunch.ts`,
  `apps/factory/src/core/launchHost.ts`.

- **Point-of-use friction events for `agents teams` failures.** The CLI's `die()`
  chokepoints in `teams` now emit a structured `friction` event (`surface`,
  `failureId`, `error`) before exiting, so the nightly factory-metrics routine can
  rank recurring failures without re-parsing transcripts. A hidden
  `agents _internal friction` recorder lets shell guard hooks (git-guard, rm-guard,
  large-file-add-guard) self-report blocks into the same stream. Source:
  `apps/cli/src/lib/events.ts`, `apps/cli/src/lib/format.ts`,
  `apps/cli/src/commands/teams.ts`, `apps/cli/src/index.ts`.

- **`agents view` no longer reports a working Claude install as "logged out".**
  Claude's `signedIn` is `!!email` read from a version home's `.claude.json`
  (`lib/agents.ts`), so a version that authenticates from an ambient
  `CLAUDE_CODE_OAUTH_TOKEN` — no account ever written to that home — rendered
  "(logged out — log in with: claude, then /login)" while every run against it
  succeeded. On one fleet box five of seven versions read as locked out and all
  of them answered a live prompt. Those now render "(no per-version login —
  using ambient CLAUDE_CODE_OAUTH_TOKEN)", which is both accurate and the more
  useful warning: an ambient token is ONE account, so balanced rotation across
  those versions rotates nothing. Source: `apps/cli/src/lib/signin-badge.ts`,
  `apps/cli/src/commands/view.ts`.

- **Claude per-account run tokens.** `agents run` now injects the Claude setup token keyed to the selected version home's own account email, so balanced Claude rotation no longer inherits one ambient shared token across accounts. Source: `src/lib/exec.ts`.

- **`agents sessions` now shows which session spawned which team.** The link
  already existed on disk and was discarded twice. `SessionMeta.spawnedTeam` — the
  team name read off the `agents teams create/add` command at scan time — had no
  column in `sessions.db`, so the writer dropped it and no consumer had ever seen
  a non-`undefined` value; a new `spawned_team` column (schema **v21**, which
  forces one full rescan) persists it, and orchestrator rows now carry a green
  `team:<name>` badge. Separately, `classifyTeamSession` was already opening each
  teammate's `meta.json` and throwing away its `task_name` and
  `parent_session_id`, so a teammate row could not name its team or point back at
  its orchestrator; teammate rows now read `[<team>/<handle>]` and the preview
  pane carries a `Team:` line from either end of the lineage. New `--in-team
  <name>` (and a `t` hotkey in the browser) filters to one team's orchestrator
  plus its teammates, `agents teams status --parent-session <id>` lists the
  teammates a given session spawned, and `agents teams list` gains a `by <id>`
  column. Source: `apps/cli/src/lib/session/db.ts`,
  `apps/cli/src/lib/session/team-filter.ts`, `apps/cli/src/commands/sessions.ts`,
  `apps/cli/src/commands/sessions-browser.ts`, `apps/cli/src/commands/teams.ts`.

- **`agents sessions --device <box>` no longer opens an empty browser.** The
  interactive one-host listing kept the browser's default this-repo scope, but
  every row it fetches is the peer's and no peer cwd is under the local
  `process.cwd()` — so the filter dropped all of them. A host scope now implies
  all-directories (and the `p` hotkey is a no-op under one). Three more
  scope bugs on the same path: `--device <this machine>` fanned out to the whole
  tailnet, because `gatherRemoteList` reads the resulting empty peer list as "no
  hosts given" and sweeps; `--local --device <box>` rendered a silent empty list
  instead of reporting that the two flags ask for opposite things; and
  `--device <box> --cloud` fell through to the cloud listing, which has no host
  scope and silently ignored the device. An unreachable peer now says so in the
  browser header — the fan-out's stderr note is repainted away by the full-screen
  picker, so "that box is asleep" used to read as "no sessions match". Source:
  `apps/cli/src/commands/sessions.ts`, `apps/cli/src/commands/sessions-browser.ts`,
  `apps/cli/src/lib/session/remote-list.ts`.

- **Teammate records are found by the session id they actually produced.** A
  teammate's directory under `teams/agents/` is named for its *agent* id, but the
  harness mints its own session id and the spawn records it separately as
  `remote_session_id`. `classifyTeamSession` looked only under the directory
  name, so most teammates were unreachable — on a live box, 14 of 16 records
  resolved only via `remote_session_id` — and their rows could not name their
  team however complete the record was. Both keys are now registered in one
  index built per process, which also replaces the `existsSync` + `readFileSync`
  the old path paid for every row in the pool. Source:
  `apps/cli/src/lib/session/team-filter.ts`.

- **`detectSpawnedTeam` no longer indexes prose or flag values as team names.**
  Rendering the value exposed that it had been wrong for most of the rows that
  had one: on a live index of 4627 sessions, 11 carried a team and 6 of those
  read `2` or `t`. It matched documentation and echoed output rather than only
  executed commands; its flag-skip used `\s` and so ran across a newline to
  capture a word from the next line; and a value-taking flag did not swallow its
  value, so `--device auto` left `auto` looking like the team name — which was
  corrupting real detections, not just adding false ones. After the fix the same
  index resolves ten teams, every one of them a real team name. Source:
  `apps/cli/src/lib/session/state.ts`.

- **`--in-team` returns a team's whole lineage, not the slice inside the default
  window.** It filtered in memory after the query, so a team older than the
  default top-50 / 30-day / current-directory scope came back empty with no
  message — and a team's teammates run in their own worktrees, which the
  directory scope hid. The flag now widens its own scope the way `--all` does. It
  is also refused with `--active`, whose live rows carry no lineage to match on,
  rather than being silently ignored. Source: `apps/cli/src/commands/sessions.ts`.

- **The session preview pane sanitizes peer-supplied `plan` and directory
  text.** A remote row's metadata is JSON the peer sent and `parseRemoteList`
  hands over verbatim; `sanitizeMeta` covered `topic`/`label`/`cwd`/`todos` but
  not these, so a terminal escape in another machine's plan text reached the TTY.
  The remote preview also renders more of what already rides across the hop: the
  checklist items, the directories the scan recorded, and a one-line plan summary
  (never the full markdown blob). `directoriesTouched` now reads the real
  `recentDirectoriesTouched` field instead of a `dirsTouched` that nothing in the
  repo ever wrote. Source: `apps/cli/src/commands/sessions-picker.ts`.

## 1.20.86

- **`agents sessions` now shows a Kimi session's todo list and its file-touching
  tool calls.** Kimi writes its checklist with `TodoList` (items shaped
  `{title, status}`, where finished is `done`) rather than Claude's `TodoWrite`
  (`{content, status: "completed"}`), so the checklist registry matched nothing
  and every Kimi session rendered with no todos — in the picker preview, the
  session detail, and the `--active` fan-out that carries progress off remote
  devices. Kimi also names the file argument `path` where Claude names it
  `file_path`, so `Read`/`Write`/`Edit` calls summarized as a bare `Read ` with
  no file. Both spellings are now handled, and the snapshot-checklist tool names
  live in one exported registry (`SNAPSHOT_TODO_TOOLS`) that the picker and the
  state engine share instead of each hardcoding its own pair. Source:
  `apps/cli/src/lib/session/parse.ts`, `apps/cli/src/lib/session/state.ts`,
  `apps/cli/src/commands/sessions-picker.ts`.

- **`agents view` now shows Grok's default model (e.g. `grok-4.5`).** Claude,
  Codex, Antigravity, and Kimi already filled the model column via their
  catalogs; Grok was missing from `locateModelSource`, so
  `resolveConfiguredModel` returned null and the column stayed blank. Grok has
  no `settings.json` `model` field (its config is `config.toml` +
  `models_cache.json`); the authoritative default is `grok models` →
  `Default model: <id>`. The catalog extractor now spawns that command against
  the version-home binary (skipping failed-download stubs) and flags the
  default, so `agents view`, `agents view --json` (`configuredModel`), and the
  other identity-cluster surfaces show it. Source: `apps/cli/src/lib/models.ts`,
  `apps/cli/src/commands/models.ts`.

- **`agents events --limit 0` now reads the whole stream, and a capped read says
  so.** `--limit` parsed as `Math.max(1, parseInt(raw) || 50)`, so `--limit 0`
  collapsed back to `50` (`0 || 50`) and there was no way to read past the default
  cap at all. The cap is applied after filtering and before the caller sees
  anything, so every aggregation over `--json` silently ranked the newest 50
  records instead of the matching set — measured against a real 7-day corpus of
  2,135 CLI failures in 9 classes, 8 of 9 ranks came out wrong with counts off by
  roughly 100x, and nothing warned. `--limit 0` now means no cap (29,649 records
  on a 30-day stream here, against 50 before), a truncated read prints
  `Showing the newest 50 — more events matched. Pass --limit 0 for all.` (on
  stderr under `--json`, so a `| jq` pipeline still receives clean JSON), and a
  non-numeric, negative, or empty `--limit` exits 2 rather than quietly becoming
  50 — an empty one (`--limit "$LIMIT"` with the variable unset) would otherwise
  have read as "no cap" and returned the whole stream unannounced.
  Source: `apps/cli/src/commands/events.ts`, `apps/cli/tests/events-limit.test.ts`,
  `apps/cli/docs/06-observability.md`.

- **Desktop notifications now show the current agents-cli mark, not the old
  logo.** The menu-bar helper's app icon — the icon macOS puts on the left of
  every notification banner it posts (the menu bar helper's own notices and every
  `agents run --notify` finish notice) — was generated from the retired gradient
  "A" logo, so notifications carried stale branding while the menu-bar status
  item already used the new lowercase `a`. The shared master logo
  (`assets/logo.png`) is now the current `a` mark, so the menu-bar helper, the
  `agents computer` helper, and the keychain helper all regenerate their
  `AppIcon.icns` from it on the next build. Source: `assets/logo.png`,
  `apps/cli/menubar/scripts/build.sh`.

## 1.20.85

- **`agents feed post` can now be mirrored to the systems you actually watch.**
  A post was durable but local: an operator away from every terminal never saw
  it, and the tracker that owns the work heard nothing. Declare sinks under
  `feed.broadcast` in `agents.yaml` — argv templates, not built-in integrations —
  and each post is fanned out to them. `--level important` marks a post worth
  interrupting someone over, so a sink with `minLevel: important` never fires on
  a routine "CI green"; a template referencing `{ticket}` is skipped when no
  ticket is known, and the ticket is joined from the session index rather than
  asked for as a flag. `{message}` composes the human line a messaging sink wants
  — `<project> · <text>` plus the first attached URL — so an out-of-band ping
  leads with the project and carries a clickable link. Delivery is best-effort
  and reported per sink; a mirror that fails never costs you the post. Source:
  `apps/cli/src/lib/feed-broadcast.ts`, `apps/cli/src/commands/feed.ts`,
  `apps/cli/docs/06-observability.md`.

- **`agents feed --filter updates` now shows the progress posts agents actually
  wrote, across the fleet.** The view read the most recent N activity events and
  *then* kept `status.posted`, so routine `file.edited` churn filled the whole
  slice — a box with six real posts rendered "0 posts" (and `--json` returned one
  of six). `readRecentActivity` gained `events` / `tier` filters that apply before
  the limit, so the limit counts posts; the same fix restores the milestone lane
  under `agents feed`. The updates view also fans out over SSH like the block view
  (`-H/--host`, `--device`, `--local` to opt out), because an agent posts on
  whichever box ran it. Source: `apps/cli/src/lib/activity.ts`,
  `apps/cli/src/commands/feed.ts`.

- **`agents run --notify` posts a desktop notification when a headless run
  finishes, and menu-bar quick dispatch now uses it.** The dispatch panel used to
  post its "finished"/"failed" notice from the MenubarHelper's own
  process-termination callback, so a helper that restarted mid-run — an upgrade
  replacing the bundle, a crash — took the callback with it while the run carried
  on reparented to launchd, and the dispatch could never report back. The run
  process owns the notice now: armed on its own `exit`, so it covers local,
  `--host` and `--lease` dispatch alike and survives anything that happens to the
  launcher. The helper's click actions also accept `url:<https…>` so a completion
  notification can open the PR or ticket the run produced. Source:
  `apps/cli/src/lib/run-notify.ts`, `apps/cli/src/commands/exec.ts`,
  `apps/cli/menubar/Sources/MenubarHelper/AgentsCLI.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`.

## 1.20.84

- **Agent onboarding cheat sheet and docs drift guard.** Added
  `apps/cli/docs/AGENT-CHEATSHEET.md` as a one-page on-ramp for agents, wired it
  from `apps/cli/AGENTS.md` and `apps/cli/docs/README.md`, and added
  `scripts/verify-docs.sh` (plus a `verify-docs` npm script and CI job) to catch
  broken relative links and missing entry-point wiring before merge.

- **Codex can now build, test, and install without escalating to YOLO.** Codex's
  `workspace-write` sandbox blocks `$HOME`, so `cargo build`, `go build`, `npm/bun install`,
  `pip install` etc. failed on their out-of-workspace cache writes (`~/.cargo`, `GOCACHE`,
  `~/.npm`, `~/.cache`, …) — which is what pushed people to `--mode full`
  (`--dangerously-bypass-approvals-and-sandbox`). agents-cli now writes a platform-resolved
  baseline of **regenerable toolchain caches** into Codex's `config.toml`
  (`[sandbox_workspace_write].writable_roots`) on permission sync — `~/.cargo`, `~/.rustup`,
  `~/.npm`, `~/.bun`, `~/go`, `~/.deno`, `~/.gradle`, `~/.m2`, `~/.gem`, plus `~/Library/Caches`
  + `~/Library/pnpm` on macOS or `~/.cache` + `~/.local/{share,state}` on Linux. Credential dirs
  (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/.netrc`) are deliberately excluded, so
  `--mode auto` stays a real sandbox — far narrower than danger-full-access. Any
  `writable_roots` you set yourself are preserved (unioned, never clobbered). Source:
  `apps/cli/src/lib/permissions.ts` (`codexDefaultWritableRoots`, `mergeCodexSandboxWrite`).

- **`agents sessions` team rows now show the team's target and teammate, not just
  the slug.** Each teammate row reads `<team> · <teammate> · by <orchestrator> ·
  <live turn | mission>`, where the mission is a one-line summary of the teammate's
  spawn prompt (`assignedTask`, shown even before it has a transcript). Several
  teams from one orchestrator stay legible (distinct team names) and each says what
  it is for. `--active --json` carries `assignedTask`. Source:
  `apps/cli/src/lib/session/active.ts`, `apps/cli/src/commands/sessions.ts`.

## 1.20.83

- **Routines now treat date-specific cron schedules as one-shot jobs (RUSH-2074).**
  `agents routines add --schedule "0 14 29 7 *"` now warns, persists
  `runOnce: true`, marks the routine as one-shot in `routines list`, and
  `agents routines cleanup` removes completed expired one-shots that still have
  user-layer YAML. Source: `apps/cli/src/lib/routines.ts`,
  `apps/cli/src/lib/scheduler.ts`, `apps/cli/src/commands/routines.ts`.

- **`agents routines list` groups terminal output by device and placement
  (RUSH-2075).** The default table is bucketed under this machine, fleet-wide,
  cloud, named devices, and named hosts with offline/unknown registry hints;
  `--flat` keeps the legacy single table and `--json` remains a flat payload.
  Source: `apps/cli/src/commands/routines.ts`.

- **`agents.yaml` no longer churns on every meta write.** `writeMetaUnlocked` wrote
  the central config with `yaml.stringify`, which strips all comments — so the
  freshly-serialized bytes never matched the comment-annotated file on disk,
  `writeIfChanged` rewrote it on every meta write, and the perpetually-dirty tree
  wedged `agents sync` ("Blocked by local changes") across the fleet. It now
  serializes via a `yaml.Document` round-trip (`serializeCentral`) that edits only
  the keys that actually changed, so comments, key ordering, and untouched
  top-level blocks (e.g. `hosts:`) are byte-stable — and a write that changes no
  central field leaves `agents.yaml` untouched. Source: `apps/cli/src/lib/state.ts`.

- **`agents run codex` can now reach the fleet from inside its sandbox.** Codex's
  `workspace-write` sandbox blocks `$HOME` (verified against the live CLI and OpenAI's
  sandbox docs), but the model routinely shells out to `agents ...`, whose runtime state
  lives under `~/.agents` — the SSH askpass shim (`~/.agents/.cache/devices/askpass.sh`),
  the device/stats cache, secrets, session writes, config tunings. Those inner writes hit
  `EROFS` (`agents ssh` died before connecting, so a remote `agents run codex` could not
  SSH or self-tune), and the fix was previously left to the caller (teams pass
  `--add-dir ~/.agents` explicitly; a plain `agents run` never did). `buildExecCommand`
  now grants `~/.agents` as an extra writable root whenever Codex runs `workspace-write`
  (`--mode edit`/`auto`) — via `--add-dir` on fresh runs (deduped against user
  `--add-dir`s) and via `-c sandbox_workspace_write.writable_roots` on resume forms (which
  reject `--add-dir`). This is the officially-recommended way to widen scope "without
  removing the sandbox entirely" — far narrower than `--mode skip` (danger-full-access).
  `plan` (read-only) and `skip` (sandbox already dropped) are unaffected. Source:
  `apps/cli/src/lib/exec.ts` (`buildExecCommand`, `codexWritableRootsConfig`).

- **Fix headless release signing (`errSecInternalComponent`).** `headless-sign-context.sh` now runs `security set-key-partition-list` right after unlocking `rush-signing.keychain-db`, authorizing `codesign`/`apple-tool` to use the Developer ID key non-interactively. Without it, the key's ACL prompts for UI approval that a headless SSH release session can't answer, so `codesign` fails and the npm publish halts. Idempotent; runs every release. Source: `apps/cli/scripts/headless-sign-context.sh`.

- **Cmd-Shift-V clip paste no longer breaks with an "sshd-keygen-wrapper would like
  to control this computer" prompt.** A menu-bar helper started from an ssh session
  registered the global chords but could never service them: macOS attributes its
  Accessibility request to the responsible process, `/usr/libexec/sshd-keygen-wrapper`,
  not to the helper's bundle, so the prompt named a process whose grant does nothing
  for the paste (and, if granted, hands keystroke synthesis to everything any ssh
  session spawns). `RegisterEventHotKey` is first-come, and the prompt naming
  sshd-keygen-wrapper is itself the evidence that this copy — not the trusted
  launchd-managed one — had registered Cmd-Shift-V and was servicing it. The
  interactive mode now refuses to start over a remote shell, and refuses
  unrecognized arguments: an unknown flag used to fall straight through to the
  status-bar app, which is how a stray `MenubarHelper --self-test` from a verify run
  became a permanent second helper. `launchctl bootstrap` (`agents menubar enable`)
  is unaffected, including when run over ssh. Source:
  `apps/cli/menubar/Sources/MenubarHelper/Guards.swift`.

- **`agents menubar status` now names a second helper process instead of reporting a
  healthy `running: yes`.** The check was `pgrep -f MenubarHelper`, which matches any
  process with that name, so a stray copy holding the global chords looked identical
  to a working install. Status now identifies the helper by its resolved executable
  (`ps -o comm=`), reports `running` only for the installed bundle, and lists every
  other live copy with its pid under `foreignInstances` (also in `--json`). Source:
  `apps/cli/src/lib/menubar/install-menubar.ts`.

- **The menu bar now says so when a hotkey is unavailable or the paste is not
  permitted.** A `RegisterEventHotKey` conflict only wrote a line to a launchd log,
  and a missing Accessibility grant made `Clip.inject` return silently — both looked
  exactly like a dead hotkey. A stolen chord now posts a notification naming it, and a
  denied grant copies the `host:path` reference to the clipboard and says which
  setting to grant, so the clip is never lost. Source:
  `apps/cli/menubar/Sources/MenubarHelper/Hotkey.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/Clip.swift`.

- **Fix the release catch-up path aborting on an unbound variable.** When a release PR had already merged and only the tag + publish remained, `release.sh` re-validated CI and then aborted with `line 933: RELEASE_COMMIT: unbound variable`, so the retry never reached npm. The catch-up block that runs when `main` sits exactly at the release merge commit never set `HISTORICAL_CATCHUP`, so phase 4 took the normal-release branch and read `RELEASE_COMMIT`, which only the branch-creating path defines. It now sets the flag, and phase 4 resolves the release commit from the merged PR (`MERGED_RELEASE_SHA` + `CI_TESTED_HEAD`) as intended. This is why 1.20.79, 1.20.80, and 1.20.81 were tagged but never published. Source: `apps/cli/scripts/release.sh`.

- **Removed `agents check` / `agents resources` now forward to their replacements
  instead of erroring (RUSH-1234).** After the command consolidation, running the
  removed names produced a bare `unknown command` (their edit-distance to `doctor`
  was too far to even trigger a "did you mean"). They are now hidden tombstone
  commands that print a one-line deprecation notice to stderr and re-run the
  replacement, preserving flags and exit codes: `agents check …` runs
  `agents doctor --check …` (so `--json` / `--quiet` / `--devices` and the CI
  drift-gate exit code carry through), and `agents resources …` runs
  `agents view --merged …` (with `agents inspect <target>` pointed to for
  per-agent/per-repo detail). The notice goes to stderr so a `--json` consumer's
  stdout stays clean. Source: `apps/cli/src/index.ts`.

- **`agents sessions --host`/`--device <box>` now opens the interactive fleet
  browser instead of a raw text dump.** A bare remote listing on a TTY folds the
  named box into the same preview-rich, selectable picker as the local view (it
  previously short-circuited to the legacy per-host stream — non-interactive, no
  previews). A `--host` *query*, a render/filter flag, `--json`, or a
  non-interactive caller keep the streamed output. Source:
  `apps/cli/src/commands/sessions.ts`.

- **`agents sessions` now shows which orchestrator spawned each team.** A teams
  teammate row was keyed off its orchestrator's session id (captured from
  `AGENTS_SESSION_ID` at spawn), which both hid the lineage and mislabeled the
  teammate with the orchestrator's id/topic. The teammate now keys off its own
  transcript, exposes the orchestrator as `orchestratorSessionId` (+ a resolved
  `orchestratorLabel`) in `--active --json`, and the listing renders
  `<team> · by <orchestrator>` so "which session spun up this team" is answerable
  at a glance. Source: `apps/cli/src/lib/session/active.ts`,
  `apps/cli/src/commands/sessions.ts`.

## 1.20.82

- **Codex hook sync no longer leaves startup warnings after upgrades.** The Codex
  hook registrar now prunes hook commands from sibling Codex version homes before
  writing `hooks.json`, so removed versions such as `0.142.0` cannot leave dead
  PreToolUse/Stop handlers that exit `127`. It also writes `SessionEnd` hook
  timeouts at Codex's 3-second limit instead of emitting `timeout: 5` and making
  Codex warn that it is clamping the value on every startup. Source:
  `apps/cli/src/lib/hooks.ts`.

- **`agents secrets export`/`list`/`view` now accept `--device`/`--devices` as
  aliases for `--host`/`--hosts`, and a keychain-backed `export --host` push is
  verified.** `--device mac-mini` used to fail with "unknown option" on the secrets
  commands even though the rest of the fleet vocabulary (`agents activity`,
  `agents run --device`) accepts it; it now resolves identically to `--host`. And a
  default keychain-backend push to a macOS host over headless SSH — the sign host a
  Linux-driven release offloads `apple.com` provisioning to — used to land the bundle
  metadata but no readable secret items (the remote login keychain is locked over
  SSH), then fail every later read with the confusing `Bundle 'X' key 'Y': stored
  item '...' not found`. The push now reads the bundle back the way a headless release
  will and **fails loudly** when the keys didn't persist, naming the locked-login-keychain
  cause and steering to `--remote-backend file` (headless-readable) or unlocking the
  remote keychain. This unblocks headless Linux-driven releases. Source:
  `apps/cli/src/commands/secrets.ts`, `apps/cli/src/lib/secrets/remote.ts`.

- **`agents sessions resume` shows session previews immediately and opens one tab
  per session by default (RUSH-2023).** The multi-select picker now starts its
  preview pane open whenever the caller supplies preview content; `tab` still
  toggles it. Batch resume now uses full-width tabs across terminal backends,
  with side-by-side two-per-tab packing available explicitly via `--splits`.
  Source: `apps/cli/src/lib/picker.ts`,
  `apps/cli/src/commands/sessions-resume.ts`.

- **`agents sessions --active` now distinguishes dead and abandoned sessions
  (RUSH-2066).** The active-session engine computes lifecycle from PID liveness and
  transcript mtime: a dead process reports `closed`, a transcript stale for
  `ABANDONED_STALE_MS` reports `abandoned`, and a live opaque harness still reports
  `running` as its honest floor. The default list, grouped active tallies, and
  `agents hq floor` render `closed` / `abandoned` distinctly, and Factory maps
  `closed` to done and `abandoned` to failed so dead work no longer appears idle.
  Source:
  `apps/cli/src/lib/session/active.ts`, `apps/cli/src/commands/sessions.ts`,
  `apps/factory/src/core/remoteSessions.ts`.

- **`agents view` now surfaces the Cursor account and its usage.** Cursor was
  absent from the account view; it now shows the signed-in account (email/authId
  from `~/.cursor/cli-config.json`, token from `~/.config/cursor/auth.json`) and,
  for request-capped (free/legacy) plans, a monthly request bar (`M`) from
  `cursor.com/api/usage`. Usage-based plans have no request cap, so they render the
  account row without a bar. Source: `apps/cli/src/lib/usage.ts`,
  `apps/cli/src/lib/agents.ts`.

- **The routines daemon now anchors its working directory to `$HOME` on startup,
  so a deleted launch directory no longer crashes every scheduled routine.** The
  daemon is long-lived and inherited whatever cwd it was launched from — commonly a
  git worktree under `.agents/worktrees/`. When that directory was later removed
  (`git worktree remove`, `rm -rf`), the daemon kept the deleted inode as its cwd
  (a process cannot chdir out of a deleted directory on its own), and every job it
  spawned inherited the dead cwd — `spawnJobAttempt` and command runs pass no
  explicit `cwd`. Bun then failed `getcwd()` at startup and *every* routine died at
  0 seconds with `ENOENT: Bun could not find a file` (or `The current working
  directory was deleted`) before the agent ran — a fleet-wide routine outage from a
  single removed worktree. `runDaemon` now re-anchors to the home directory once at
  startup (`anchorDaemonCwd`), making the scheduler immune regardless of how it was
  launched. Source: `apps/cli/src/lib/daemon.ts` (`anchorDaemonCwd`, `runDaemon`).

- **`agents repo refresh` is deprecated in favor of `agents sync`.** The command is
  now hidden from help and prints a deprecation notice on use, pointing at the
  replacement: `agents sync --local` (reconcile all installed agents, no git) or
  `agents sync <agent>` (one agent). It still runs for now so existing scripts and
  muscle memory don't break — `refresh` was a partial variant of `sync` (it only
  ever materialized the single global-default version, and silently no-op'd for an
  agent with installed versions but no global default), whereas `sync` covers
  every installed version. Internal callers (crabbox bootstrap, the `agents pull`
  redirect, `agents setup` help) now use `agents sync --local`. The underlying
  `refresh()` function stays — it is the reconcile stage behind `agents sync`.
  Source: `apps/cli/src/commands/repo.ts`, `apps/cli/src/lib/crabbox/`.

- **`agents view` now shows Grok usage limits.** Grok's network usage endpoints
  404, so usage is parsed from the local `~/.grok/logs/unified.jsonl` log instead —
  the latest billing-period config and subscription tier render as a `W` window,
  matching the other agents' live-usage display. Source: `apps/cli/src/lib/usage.ts`.

- **`agents run --host` now starts in the same project you launched it from, not the remote `$HOME`.** A host run with neither `--cwd` nor `--remote-cwd` sent no `cd` at all, so the remote agent opened in the home directory with no project context — every launch from a repo (including every Factory "Pick Host" tab) began with a manual `cd`. The dispatch now derives a working directory from the local cwd when the caller named none: a cwd under the local home is re-rooted onto the *remote* home (`~/src/x` → the host's `$HOME/src/x`), which is the normal fleet layout where the same checkout sits at the same home-relative path on every box. Because a derived directory is a best-effort mirror rather than something the user asked for, a host that lacks that checkout falls back to its home instead of failing the run; an explicit `--cwd`/`--remote-cwd` is never mirrored, so a directory you named that does not exist still fails loudly. A cwd outside the local home is not mirrored — a path like `/opt/thing` says nothing about the target's filesystem. Source: `apps/cli/src/lib/hosts/dispatch.ts` (`deriveMirroredCwd`, `remoteCdPrefix`), `apps/cli/src/commands/exec.ts`.

- **The Cmd+Shift+O quick-dispatch bar is now Plan / Run, and never runs an agent
  in your home directory.** The two spotlight modes were renamed from File
  Ticket / Fix to **Plan** (investigate → file a Linear ticket) and **Run**
  (headless `agents run`). A new repo dropdown is populated from your recent
  session working directories with `$HOME` dropped, and the pick is passed as
  `--cwd` to both modes, so an agent is always scoped to a real repo instead of
  the too-broad home dir; the last-picked repo is remembered. Run now always uses
  `--strategy balanced` (auto load-balance across signed-in versions with
  headroom, skipping rate-limited), and `--name` is seeded from a slug of your
  task text instead of an opaque `quick-<timestamp>`. Source:
  `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/AgentsCLI.swift`.

- **The keychain Touch ID prompt now names the session that triggered the read
  (RUSH-1971).** When a bundle read pops Touch ID, the operation prompt already
  named the requesting agent, bundle, and reason; it now also carries the
  triggering session's 8-char short-id — e.g. *"Claude is requesting to unlock the
  'prod' bundle (session e0a1b2c3) for 7 days …"* — so an unexpected prompt is
  attributable when an interactive agent, headless workers, and `secrets exec`
  deploys all run at once. The short-id is derived from the `AGENT_SESSION_ID` the
  exec env already exports; no keychain-helper re-sign is required (the enriched
  string flows through the existing `AGENTS_KEYCHAIN_PROMPT` env). Source:
  `apps/cli/src/lib/secrets/index.ts`, `apps/cli/src/lib/secrets/bundles.ts`.

- **`agents teams list` renders from cached team metadata instead of full status
  probes (RUSH-1996).** The list and picker rows now read the team registry plus
  teammate `meta.json` snapshots, so listing teams no longer blocks on remote log
  pulls or unreachable hosts. Full teammate status is still loaded when a user picks
  a team or runs `agents teams status <team>`. Source:
  `apps/cli/src/commands/teams.ts`, `apps/cli/src/commands/teams.test.ts`,
  `apps/cli/docs/teams.md`.

- **`agents setup secrets` now guides first-run secrets onboarding (RUSH-1999).**
  The setup command registers a new `secrets` capability wizard that chooses a
  default storage backend (`keychain`, encrypted `file`, or synced `vault`), sets
  the existing default prompt policy (`daily`/`always`, with `never` gated for
  explicit automation use), persists `secrets.backend` so future `agents
  secrets create/import` commands use the selected backend when no backend flag is
  passed, optionally delegates imports to `agents secrets import`, and writes
  setup preferences under `~/.agents/.history/setup`. Source:
  `apps/cli/src/commands/setup-secrets.ts`, `apps/cli/src/commands/secrets.ts`,
  `apps/cli/src/commands/setup.ts`.

- **`agents setup fleet` now guides Tailscale device onboarding (RUSH-2000).**
  The setup command registers a new `fleet` capability wizard that verifies
  Tailscale, syncs discovered devices through the existing `agents devices sync`
  path, applies SSH auth with `agents devices set`, optionally writes the
  managed SSH config include, tests connectivity with `agents ssh <device>
  uname`, and can run `agents fleet update` after registration. Source:
  `apps/cli/src/commands/setup-fleet.ts`, `apps/cli/src/commands/setup.ts`.

- **`agents feed post` carries artifacts and a project chip, and progress posts
  render rich (RUSH-2013 / RUSH-2014).** `feed post` gains `--attach <path-or-url…>`
  (repeatable): a local file is copied under
  `~/.agents/.history/attachments/<session>/<update>/` so the link survives a
  worktree delete, and a URL is kept as a link — each classified to an
  image/audio/video/file/link kind by extension. Every post is now stamped with its
  project (basename of cwd, worktree-aware) on the activity event itself, so the
  chip shows without a live-session join. A `status.posted` event renders as a
  multi-line update — `agent · session · host · project` chips, the message, an
  attachment row with per-kind glyphs, and a `↳ ag focus/sessions` hint — wherever
  it appears (`feed post` echo, the feed activity lane, `agents feed --filter
  updates`, and `agents activity`).
- **`agents feed --filter needs|updates|all` (RUSH-2015).** `needs` (default) is the
  open-blocks inbox as before; `updates` shows only deliberate progress posts over
  the local activity timeline (no block pipeline, no remote fan-out); `all` renders
  the blocks then appends the updates view. `--json` under `--filter updates` emits
  the raw `status.posted` events. Source:
  `apps/cli/src/lib/activity.ts`, `apps/cli/src/lib/feed-post.ts`,
  `apps/cli/src/commands/feed.ts`, `apps/cli/src/commands/activity.ts`.

- **Fix: actor attribution now actually reaches `agents sessions` and `--active`
  for real runs (RUSH-2018/2019).** Two bugs, found by driving a real `agents run`
  end-to-end: (1) the session index's `actor`/`initiated_by` were kept out of the
  upsert `ON CONFLICT` entirely, so any row indexed *before* its actor sidecar
  landed (an older scanner, or a scan racing the spawn-time write) was locked to
  `NULL` forever — now `COALESCE(existing, incoming)` backfills a null while still
  never clobbering a stored owner; (2) the live `--active` **owner** read only the
  per-pid registry entry, which the SessionStart hook rewrites without an actor, so
  real runs showed no owner — `--active` now falls back to the durable per-session
  actor sidecar. Verified with a real `agents run`: the actor reaches `sessions.db`
  and the `--active` owner resolves. Source: `apps/cli/src/lib/session/db.ts`,
  `apps/cli/src/lib/session/active.ts` (`resolveOwner`).

- **Session lists expose the model and richer navigation metadata (RUSH-1981,
  RUSH-1991, RUSH-1992, RUSH-1994).** Static flat rows add a compact model column
  only when the result set has model data, with width sized to that set so an
  80-column terminal does not wrap. Local CWD and ticket/PR cells are clickable
  in supporting terminals, previews identify browser/computer use and sub-agent
  counts, and `agents sessions --active --json` adds an always-present `prLink`
  key. Existing session indexes migrate to schema v20 and rescan transcripts to
  backfill model data.

## 1.20.81

- **Generic `--device all` / `--host all` fleet fan-out for every fleet-aware
  command (RUSH-1969).** The passthrough now treats `all` as a sentinel value on
  `--host`, `--device`, `--hosts`, and `--devices`. For any routable command
  (`view`, `output`, `sync`, `doctor`, `list`, …) it runs `agents <cmd> --json`
  on every registered device concurrently, then renders an OS-grouped roster
  (`●` installed, `○` offline/skipped, `▸ … ← this machine`). Offline and
  no-address devices render as rows instead of hanging the whole run. Add
  `--json` to get a device-keyed object. Commands that already own `--all-hosts`
  (`output`) keep their existing behavior. Source:
  `apps/cli/src/lib/hosts/passthrough.ts`, `apps/cli/src/lib/hosts/option.ts`.

- **`agents apply` no longer propagates single-use rotating refresh tokens
  (RUSH-1958).** Droid (WorkOS) credentials use a refresh token that rotates
  server-side on every exchange; copying one credential file across N boxes
  caused the first refresh on any box to invalidate every other holder, collapsing
  the fleet to a single working login. `agents apply` now excludes droid — and any
  future harness added to the shared `SINGLE_USE_ROTATING_REFRESH_AGENTS` set in
  `src/lib/fleet/auth-sync.ts` — from credential propagation. The plan surfaces
  these as `manual login needed (single-use rotating refresh token)` with the
  device name, routing the user to log in on the target box itself. Source:
  `src/lib/fleet/auth-sync.ts`, `src/lib/fleet/apply.ts`,
  `src/commands/apply.ts`.

- **Non-Claude remote/tmux agent sessions now surface with their real id
  (RUSH-2007).** `agents sessions --active` and the `agents sessions focus` picker
  dropped every non-Claude tmux session (codex/gemini/kimi/grok/…) that lacked a
  launch-minted id, so a live `agents run --device <host> <agent>` was invisible and
  un-refocusable after an SSH drop. `listTmuxAgentSessions` now backfills the id from
  the **deployed** SessionStart hook's own per-pid record at
  `~/.agents/.cache/state/sessions/<pid>.json` — the CLI previously only read the
  un-deployed session-tracker path (`terminals/sessions/`, empty on the fleet). A
  targeted per-pid read (never a scan of that graveyard dir), freshness-guarded by
  the launch's known start so a reused-pid record can't cross sessions. Source:
  `apps/cli/src/lib/session/hook-sessions.ts`, `apps/cli/src/lib/session/active.ts`.

- **Releases publish the CI-tested tree, not a drifted merge.** On a busy default
  branch, unrelated PRs merging during a release PR's CI window made the
  squash-merge tree diverge from what CI actually tested, so `release.sh` refused
  to publish (`merged tree != built tree`) and the release stalled — every attempt
  merged a version bump it could never tag. The publish now tags the exact release
  commit the full matrix went green on (the PR head), letting the intervening
  commits ride the next release; the merge commit is still tagged when its tree
  matches (no drift). The `wait_for_ci_green` gate is unchanged, so the published
  tarball is always a tree the full matrix validated. The tree-comparison decision
  is extracted into `scripts/select-publish-commit.sh` and unit-tested against a
  real git repo. Source: `apps/cli/scripts/release.sh`,
  `apps/cli/scripts/select-publish-commit.sh`.

- **Consolidate the observability + inspection commands into one role each; remove
  `check` and `resources` (RUSH-1234).** Two overlapping command clusters had grown
  ambiguous. `agents check` (the CI drift gate) is folded into `agents doctor --check`
  — same drift engine, now with a scriptable exit code. `--check --quiet`,
  `--check --json` (backward-compatible payload: every field the old `check --json`
  emitted, plus additive `unwiredHookVersions`/`sourceBehind`), and `--check --devices`
  all carry over; the standalone `check` command is removed. `agents resources` (the merged first-wins cross-layer
  resource table) is folded into `agents view --merged`; the standalone `resources`
  command is removed. The observability surfaces (`events`, `feed`, `activity`,
  `output`, `sessions`) now have a documented one-role-each taxonomy — `events` is the
  raw unified audit stream, `feed` the cross-agent decisions/status inbox, `activity`
  the human milestone timeline, `output` productivity accounting, `sessions` the live
  roster + transcripts. Running the removed `agents check` / `agents resources` now
  reports `error: unknown command`. Source:
  `apps/cli/src/commands/doctor.ts`, `apps/cli/src/commands/view.ts`,
  `apps/cli/src/lib/merged-resources.ts`, `apps/cli/src/lib/startup/command-registry.ts`,
  `apps/cli/docs/06-observability.md`.

- **`agents sessions --active` shows who launched each run (RUSH-2018).** New
  **owner** column on the active-sessions table (and an `owner` field in
  `--active --json`), sourced from the resolved actor stamped at spawn into the
  per-pid registry and onto each teammate record. Displays the actor's short id
  (an email's local-part) and stays honest — an unresolved local run shows `-`,
  never a guessed box owner. The session index (`sessions.db`) also gains
  write-once `actor` / `initiated_by` columns, kept out of the upsert
  `ON CONFLICT` set so a content rescan never clobbers the original owner.
  Source: `apps/cli/src/lib/session/pid-registry.ts`,
  `apps/cli/src/lib/session/active.ts`, `apps/cli/src/commands/sessions.ts`
  (`ownerLabel`), `apps/cli/src/lib/session/db.ts`, `apps/cli/src/lib/exec.ts`.

- **`agents sessions` attributes historical sessions to a person, and teams carry
  spawn lineage (RUSH-2019).** Each run now writes a durable `sessionId -> actor`
  sidecar at spawn (`~/.agents/.history/by-session/`, unlike the pruned pid
  registry), and the session scanner joins it while indexing — so the write-once
  `actor` / `initiated_by` columns added in RUSH-2018 populate automatically and the
  durable `agents sessions` listing (not just `--active`) shows who launched each
  session. Teammate spawns inherit the orchestrator's frozen actor and now record a
  `parent_session_id` (the orchestrator's own `AGENTS_SESSION_ID`), so a team traces
  back to the one human who started it and the spawn chain is walkable. Source:
  `apps/cli/src/lib/session/actor-sidecar.ts`, `apps/cli/src/lib/exec.ts`,
  `apps/cli/src/lib/session/db.ts`, `apps/cli/src/lib/teams/agents.ts`.

- **Actor provenance reaches events, routines, and browser tasks (RUSH-2020).**
  Completes the actor layer's coverage beyond sessions: every emitted **event** now
  records `actor` + `kind` through the audit origin (so `agents events` stats carry
  a `byActor` breakdown in `agents logs stats`); a **routine** stamps its creator's
  actor id at creation and seeds it into each fired run's env (`AGENTS_ACTOR`), so an
  unattended cron's session and events attribute to the person who scheduled it
  instead of `UNRESOLVED@<host>` — its run records gain `actor` (creator) and
  `triggeredBy` (who kicked off that run); a **browser task** records the `owner` who
  launched it, on the live task and in history. Source:
  `apps/cli/src/lib/events.ts`, `apps/cli/src/lib/runner.ts`,
  `apps/cli/src/lib/routines.ts`, `apps/cli/src/lib/browser/{types,service}.ts`.

- **`agents sessions` now shows an accurate working / waiting / idle status for
  every harness, and shows it as text in the default list — not just a glyph.** Two
  gaps are closed. (1) A live non-Claude/Codex agent (grok, droid, gemini, rush,
  kimi, hermes, opencode, antigravity) used to fall through to a blanket `unknown`
  because `findSessionFileForKind` / `computeLiveSignals` only resolved and parsed
  Claude and Codex transcripts — a running Codex or grok session displayed
  `unknown`. Every tracked harness whose transcript is locatable + parseable is now
  wired into the same state engine: `findSessionFileForKind` resolves each kind's
  transcript through the session index (`latestSessionFileForCwd`), and
  `computeLiveSignals` parses it with that harness's own parser and runs it through
  the same `inferSessionState`, so it gets a real `working` / `waiting_input` /
  `idle` the principled way Claude/Codex do. For a genuinely opaque kind (cursor) or
  an unreadable transcript, `resolveFallbackStatus` now reports `running` for any
  live process — **a running agent never displays `unknown`** (that state is reserved
  for the sole un-answerable case: a dead process whose transcript vanished
  mid-read), and a live process is never downgraded to a fabricated `idle`. (2) The
  default `agents sessions` list (flat, tree, and the project overview) showed only a
  colored glyph for live rows; it now also prints the status **word** —
  `working` / `waiting` / `idle` — next to the glyph, the same three states the
  `--active` column shows, with `waiting` the unmistakable "needs you" case. The
  single-session preview (`agents sessions <id> --preview`) leads with the same live
  status line, flagging `← needs you` when the agent is waiting on a question,
  permission, or plan review. Source: `apps/cli/src/lib/session/active.ts`
  (`findSessionFileForKind`, `computeLiveSignals`, `resolveFallbackStatus`),
  `apps/cli/src/commands/sessions.ts` (`liveStatusWord`, `flatSessionRow`,
  `treeSessionRow`, `renderSessionPreview`).

- **`agents sessions inject` now addresses VSCodium / Cursor / VS Code and iTerm sessions, not just tmux.** It resolves targets through the same canonical resolver the watchdog uses (`resolveInjectTargetForSession`), so the manual unblock path and the watchdog agree on which sessions are reachable — and a failed resolve now surfaces the precise reason (host/rail) instead of a misleading "not running under tmux". Source: `apps/cli/src/commands/sessions-inject.ts`.
- **Watchdog brain focuses on driving idle agents to completion, with context-aware, tool-pointing nudges.** The decider prompt now reads the stalled agent's goal first, restates the conclusion it already reached, names the concrete next step (including a tool it forgot it has — `agents computer` / `agents browser` / `agents ssh <mac> "agents computer …"`), splits do-it-yourself from ask-the-human, and treats `idle` as its territory while leaving `waiting` prompts to the user's feed. Design + normative spec: `apps/cli/docs/watchdog.md`, `apps/cli/docs/specifications.md#watchdog`. Source: `apps/cli/src/lib/watchdog/watchdog.ts`.

## 1.20.80

- **`agents activity` goes fleet-wide, grouped, and session-enriched.** The activity
  lane was a flat, local-only, newest-first list; it now shows progress-so-far across
  the whole fleet — who did what, where, on which project, for which ticket. New flags:
  `--devices-all` (alias `--hosts-all`) fans the same `activity --json` payload out to
  every reachable device (feed-style, via `gatherRemoteAgentsJson`) and merges each
  peer's stream host-tagged; `-H/--host` / `--device` scope to specific boxes; `--local`
  forces local-only (still the default). `--group-by project|device|agent` buckets the
  stream (e.g. per project, what each agent did and for which ticket) and `--filter
  <text>` narrows by project/device/agent/event/ticket. Each item is enriched by JOINING
  to live sessions — the resolved project (repo/worktree slug from cwd), the execution
  host (`provenance.host`), and the Linear ticket (`ActiveSession.ticket`) — never by
  re-parsing transcripts. Milestone tiering (`--milestones`) and the default collapse are
  unchanged, and `--json` stays a mergeable per-host payload (now carrying the enriched
  fields). Source: `apps/cli/src/commands/activity.ts`, `apps/cli/src/lib/activity.ts`
  (`enrichActivityEvents`, `mergeActivityEvents`, `parseActivityPayload`, `groupActivity`,
  `filterActivityEvents`, `projectFromCwd`).

- **Add `agents set` — a short front door for per-version run defaults.** `agents set claude@2.1.220 --model opus-5` pins the default model (and/or `--mode`) that `agents run` uses for that agent version. It reads and writes the same store as `agents defaults run set` (`agents.yaml` -> `run.defaults`), so the two stay consistent. Bare `agents set` lists every default; `agents set <selector>` shows one. Source: `apps/cli/src/commands/set.ts`.

- **`agents doctor` now reads as a triaged health report, not neutral status.**
  The verdict was terse status text ("Verdict: 1 divergent, source ~/.agents 16
  commits behind…") a user had to decode. It is now a severity-ranked health block
  that leads with what is unhealthy, why it matters, and the exact fix — one row
  per finding, tagged with a restrained terminal glyph (`✓` `✗` `⚠` and a subtle
  info dot, colored via chalk to match the man-page voice):
  ```
  Claude@2.1.220
    ✗ unhealthy — 3 issues (1 critical · 2 warnings)

    ✗ critical  ask-user-question-guard — on disk but not wired into settings.json; the hook never fires
                → agents sync claude@2.1.220 --yes
    ⚠ warning   ~/.agents — 16 commits behind origin/main; you're running stale config
                → agents repo pull user
    ⚠ warning   11-activity-log — differs from source
                → agents doctor claude@2.1.220 --fix

    heal what's auto-fixable:  agents doctor claude@2.1.220 --fix
  ```
  A clean install collapses to one green line —
  `✓ healthy — 34 resources reconciled · hooks wired · sources current`. Each
  finding carries an agent-agnostic **severity**: **critical** (silent breakage —
  an unwired hook, a missing/unparseable `settings.json`, a MISSING resource),
  **warning** (stale/drift — a source layer behind origin, a DIVERGENT resource, a
  stale/never-synced version), or **info** (an orphan/EXTRA resource →
  `agents prune cleanup`). Both surfaces get the same treatment: the target report
  `agents doctor <agent>@<version>` and the bare `agents doctor` overview, which
  now opens with a `Health` banner aggregated across every installed version. The
  existing per-resource detail rows are kept — the health block layers on top of
  them as the verdict. `--json` gains a `verdict` field (target mode) and a
  `health` field (overview), each carrying `severity`/`category`/`subject`/
  `impact`/`fix` per issue; the existing `summary`/`kinds`/`hookWiring`/
  `sourceBehind`/`sync`/`orphans` fields are unchanged. Source:
  `apps/cli/src/commands/doctor.ts` (`computeVerdict`, `computeOverviewHealth`,
  `healthBlockLines`, `renderHealthBlock`, `verdictIsAutoFixable`).

- **The daemon's `MenubarHelper --notify` one-shots can no longer pile up in the
  menu bar.** Each routine notification (start/finish/overdue/heal) spawned a
  fresh, detached, unsupervised `MenubarHelper --notify` process; on a stalled
  delivery — a locked screen or a WindowServer/XPC hiccup — the helper's runloop
  spin never reached its deadline and the process hung indefinitely, so duplicate
  "Agents" instances accumulated. The one-shot is now bounded by two independent
  watchdogs: `runOneShot` arms a background-thread force-exit at 3s (off the main
  queue, so a wedged main thread can't starve it — unlike the 0.6s runloop
  deadline it backs up), and the Node spawner (`spawnDetachedQuiet`) SIGKILLs the
  child at 4s if it never self-exits. A notifier that posts normally (the common
  sub-second path) is untouched; only a genuinely hung one is killed. Source:
  `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift` (`Notifier.runOneShot`),
  `apps/cli/src/lib/menubar/notify-desktop.ts` (`spawnDetachedQuiet`,
  `NOTIFY_TIMEOUT_MS`).

- **Removed the dead `commitOwnDeviceMeta` auto-commit from the pull path.** It
  committed this machine's `devices/<host>/agents.yaml` pin snapshot to the user
  repo's `main` on nearly every `pullRepo`, without pushing — so `main` diverged
  N-ahead per machine and wedged `agents sync` across the fleet. Now that
  per-device pins are gitignored (they are local runtime state — written by
  `writeMetaUnlocked`, read on-disk by pinned-strategy resolution and the shim),
  the function only ever no-ops, so it and its sole `pullRepo` call are deleted
  along with their tests. `--strategy balanced` never read pins; the only behavior
  removed is the never-reached auto-commit. Source: `apps/cli/src/lib/git.ts`
  (`pullRepo`), `apps/cli/src/lib/git.test.ts`.

- **Remove Forge and hard-deprecate Gemini (RUSH-2060).** ForgeCode is no longer
  an `AgentId`, install target, resource-sync target, subagent target, MCP target,
  or permissions target. Gemini remains a legacy id so existing sessions/config can
  still be read, but it is no longer a managed harness: `agents add gemini`,
  `agents import gemini`, and `agents sync gemini` now fail and point users to
  Antigravity. Gemini is also excluded from capability-driven resource writers,
  staleness detectors, import choices, teams choices, model choices, fleet auth
  sync, and plugin/MCP/permissions/subagent sync. Source:
  `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/types.ts`,
  `apps/cli/src/lib/capabilities.ts`, `apps/cli/src/commands/{versions,import,sync}.ts`,
  and the resource writers under `apps/cli/src/lib/`.
  (RUSH-2060)

- **Every agent secret access and unlock is now captured in the raw event stream and the audit log.** After the recent relaxation that lets agents read and unlock bundles more freely, `agents events --module secrets` now surfaces two typed, value-free events for the complete access picture. `secrets.get` records every path that resolves a secret VALUE out of a bundle (`run --secrets`, `secrets exec`/`export`, `view --reveal`, raw `get <item>`, `sync push`, remote `bundle@host`), and a new `secrets.unlocked` records the deliberate `agents secrets unlock` grant into the broker/durable session — the longer-lived grant a per-read event does not capture, carrying its TTL and the harness scope it was granted to (`*` = global). Every record is tagged with the resolving `agent` scope and lands at audit level in the append-only `~/.agents/events.jsonl` audit trail, but is non-milestone so it does not clutter `agents activity` / `agents feed`. The resolved value is never written — only bundle name, key NAMES, and counts. All value-read/unlock audits now funnel through one canonical `emitSecretAudit` helper (`apps/cli/src/lib/secrets/audit.ts`), wired into `lib/secrets/bundles.ts`, `commands/secrets.ts` (reveal / raw get / unlock), `lib/secrets/sync.ts`, and `lib/secrets/remote.ts`; the new event type is registered in `lib/events.ts`. Source: `apps/cli/src/lib/secrets/audit.ts`, `apps/cli/src/lib/events.ts`, `apps/cli/src/commands/secrets.ts`.

## 1.20.79

- **A daemon bounce no longer orphans the secrets broker.** Installing agents-cli ran `stopDaemon()`, which sent SIGTERM, scheduled its hard-kill escalation on a `setTimeout`, and cleared the daemon pid file immediately — without waiting for the process to actually exit. In a short-lived process like the npm postinstall the timer never fired at all, and the cleared pid file made `isDaemonRunning()` report false, so `startDaemon()` launched a second daemon alongside the live one. Its hosted broker then found the socket in use, missed one 700ms ping against the busy owner, unlinked the live socket and rebound — leaving the first broker running with every unlocked bundle in RAM that no client could reach. On a machine with two installs (nvm + homebrew) this reproduced on every upgrade: `lsof` showed two processes on one socket path at two different kernel socket addresses. `stopDaemon` now waits for the process to actually stop serving before clearing the pid file (and escalates to a tree-kill only if it does not), and `bindBrokerSocket` probes an in-use socket several times and refuses to reclaim it while a live process still owns the broker pid file, surfacing a clear error instead of silently starting a second broker. A zombie counts as exited — it holds no socket — so a daemon that is the caller's own child is not hard-killed after it has already gone.  The socket owner is recorded in a dedicated `agent.owner` file rather than the standalone service's `agent.pid` single-instance claim, so the signal is present for the daemon-hosted broker (the primary configuration) without making a losing standalone service exit into a launchd restart loop; `ensureAgentRunning`'s one-off fallback and `teardownStaleBroker` also wait for a broker to stop serving before unlinking its socket and ownership record, instead of destroying the evidence the check depends on. Source: `apps/cli/src/lib/platform/process.ts` (`waitForExit`, `hasExited`), `apps/cli/src/lib/daemon.ts` (`stopDaemon`), `apps/cli/src/lib/secrets/agent.ts` (`ownerPath`, `brokerPidAlive`, `releaseBrokerPid`, `bindBrokerSocket`, `ensureAgentRunning`, `teardownStaleBroker`).

- **`agents doctor` now checks hook WIRING, not just hook files — and treats a
  stale source layer as unhealthy.** Two blind spots let a version home read
  "healthy" while its hooks were dead. (1) Doctor only compared hook FILES against
  source, never that `settings.json` actually references each hook in the right
  event array — so a hook whose script was byte-identical to source but never
  wired into `PreToolUse`/`Stop`/… reported `ok` and silently never fired
  (reproduced on `yosemite-s1`: `Claude@2.1.207` printed `hooks 32 items 32 ok`
  while its `settings.json` PreToolUse array omitted `ask-user-question-guard.sh`).
  Doctor now inspects the version's native `settings.json` (Claude-family: claude,
  droid), verifying each hook per `(event, matcher)` group, and reports a
  present-but-not-wired hook as `UNWIRED <hook> event=<event> matcher=<matcher>`,
  counted against the verdict; a missing/unparseable `settings.json` is surfaced
  too. `--fix` re-wires via the same `registerHooksToSettings` path `agents sync`
  uses. (2) A source layer behind `origin/main` means the home is reconciled
  against stale truth, yet the "N commits behind" fact was a buried preamble while
  the verdict still said healthy — it now flips the per-version verdict to unhealthy
  with the `agents repo pull` remediation. Both checks run in every mode, not just
  `agents doctor <agent>@<version>`: bare `agents doctor` (overview) and the CI gate
  `agents check` now flag a present-but-unwired hook and a behind-origin source
  layer, and `agents check` exits non-zero on them. Source:
  `apps/cli/src/lib/hooks.ts` (`checkVersionHookWiring`), `apps/cli/src/lib/drift.ts`
  (`checkSyncStatus`/`computeSourceBehind`/`computeDrift`),
  `apps/cli/src/lib/doctor-diff.ts`, `apps/cli/src/commands/doctor.ts`
  (`computeVerdict`), `apps/cli/src/commands/check.ts`, `apps/cli/src/lib/git.ts`
  (`commitsBehindUpstream`).

- **`agents repo pull` reconciles a diverged repo instead of wedging on it.** It ran
  `git merge --ff-only`, which refuses *any* divergence — conflict or not — so a
  single local commit permanently blocked every later pull with nothing actually in
  conflict. Since `pullRepo` itself auto-commits the machine's own
  `devices/<host>/agents.yaml` before pulling, every device eventually created that
  commit and stopped receiving updates: on one fleet, nine machines sat 9 commits
  behind and merged rule changes never reached any of them. It now rebases, which is
  what its own documentation has always described. Per-device paths are disjoint, so
  they replay cleanly. A genuine conflict aborts the rebase and rolls the checkout
  back untouched, so a failed pull can never leave the repo detached, mid-rebase, or
  with conflict markers in live config; a rebase already in progress is reported as
  itself rather than as a dirty tree.
- **`agents repo pull` / `push` exit non-zero when a repo fails.** Both printed a
  failure line and returned 0, so `agents fleet run "agents repo pull user"` reported
  `11 ok` across a fleet that pulled nothing. Any automation gating on the exit code
  read a total no-op as success. Matches `agents sync <repo>`, which already did this.

- **`agents repo status` reports across the fleet.** New `--devices-all` (alias
  `--hosts-all`) fans `repo status`/`repo list` out to every reachable device and
  renders one aggregated table (device · repo · sync · changes); `--devices <who>`
  (alias `--hosts`) takes `all` or a comma-separated device list. Unreachable peers
  are skipped with a clear marker, never failing the command, and a single
  `--device`/`--host` still streams that one box as before. Source:
  `apps/cli/src/commands/repo.ts`.

- **Routines now always authenticate as the machine they run on, never on an inherited Claude token.** The daemon was already forbidden from *injecting* a Claude OAuth token into a routine, but nothing stopped it *inheriting* one: `buildExecEnv` spreads the ambient `process.env`, and `sanitizeProcessEnv` only strips loader/interpreter variables, never credentials. So on any box whose daemon environment happened to carry `CLAUDE_CODE_OAUTH_TOKEN` — a provisioned fleet machine, a shell that exported it — every routine spawn silently ran on that one shared, rotating token instead of the host's own login. That is the fleet-wide-logout path the no-token design exists to prevent, reached by inheritance rather than injection: when the server rotates a refresh token, every other holder drops to "run /login". No CI runner has a token to inherit, so the existing test passed everywhere and the leak only appeared on a real machine (it surfaced on the release VM, halting a release). `buildRoutineSpawnEnv` now drops the variable, and the routine still authenticates exactly as before — `CLAUDE_CONFIG_DIR` is pinned to that box's per-account version home, so a routine uses whatever agent login is set up there and needs no token of its own. Source: `apps/cli/src/lib/runner.ts` (`buildRoutineSpawnEnv`).

- **The `daily` secrets policy is now called `hold`, because it was never daily.** The default prompt policy holds a bundle for `secrets.agent.holdMs` — 7 days out of the box — yet it was named `daily`, so `agents secrets policy --help` read as "you will be asked once a day" while the code comment beside it said "one Touch ID per ~7d". Both the CLI help and `docs/secrets.md` had resorted to apologising for it in prose ("Name is historical", "Despite the name, it is not tied to one calendar day"), which is a name stating something false, not a name that is merely unclear. It is not one day, not one session, and not any fixed period — it is the configured hold window, so it is now named for that. **`daily` and the wire token `session` remain accepted everywhere** (`agents secrets policy <bundle> daily`, `secrets.policy: daily` in agents.yaml, and the `tier: session` key already written into every bundle on every synced machine), so no config or stored bundle changes behaviour on upgrade. **One machine-readable surface does change**: `agents secrets list --json` and `agents secrets view --json` now report `"policy": "hold"` where a default-tier bundle previously reported `"daily"`. Anything matching on that string needs updating — the CLI keeps accepting `daily` as input, but it no longer emits it, because a JSON field that reports a name the CLI itself has retired is a worse trap than a one-line change. The help text now also states what the tier actually depends on: the hold is a property of the running broker plus the durable session, not of the stored keychain item, so a broker that is down degrades `hold` to prompt-every-read; only `never` is prompt-free independently of the broker. Source: `apps/cli/src/lib/secrets/bundles.ts` (`SecretsPolicy`, `parsePolicy`, `secretsDefaultPolicy`), `apps/cli/src/commands/secrets.ts` (`parsePolicyOpt`, `policy` command help), `apps/cli/src/lib/secrets/index.ts` (legacy token mapping for the signed helper), `apps/cli/docs/secrets.md`.

- **Claude usage/probe reads can authenticate with a file-based setup-token
  instead of the login keychain — no Touch ID.** On macOS, reading a Claude
  account's usage went through Claude Code's ACL-bound
  `Claude Code-credentials-<hash>` keychain item (`loadClaudeOauth` →
  `/usr/bin/security`), popping a Touch ID sheet on every cold read — per account,
  roughly every 8h, and again on the routines daemon's 3-minute auth-health probe
  (`probeLocalFleetAuth`), so `ag view` and the background warm both prompted.
  `loadClaudeOauth` now first resolves a per-account `claude setup-token` from the
  reserved **file-based** `auth` secrets bundle (keyed by account email as
  `CLAUDE_CODE_OAUTH_TOKEN_<slug>`); when present, the usage endpoint is
  authenticated with that long-lived, non-rotating token and the keychain is never
  touched — killing the prompt. This applies only to the read-only usage/probe
  callers (`accessTokenCache`); the full-credential run/export path (which needs the
  refresh token) is unchanged, and an account with no provisioned setup-token still
  falls through to the keychain for now. Keyed strictly per-account (never a bare
  shared key) so one account's token can't be misapplied to another. Source:
  `apps/cli/src/lib/usage.ts`; design: `docs/design/credential-management.md`.

## 1.20.78

- **`agents sessions <uuid>` now resolves a remote session exactly, across the
  fleet.** A full session id absent from the local disk used to fall back to an
  FTS content search — and because a UUID appears verbatim in other sessions'
  transcripts (a watchdog `/continue <uuid>` reference), that surfaced a list of
  unrelated "matches" instead of the one session, which actually lived on another
  machine. A UUID is now treated as an identifier: on a local miss the CLI fans
  the id lookup out to the online fleet (the existing `gatherRemoteList` SSH
  sweep), and when exactly one machine holds it, renders that session's summary
  from the owning peer via `runOnPeer` (instead of `Session transcript not
  available`). Same id on more than one box surfaces a machine-labeled conflict to
  disambiguate with `--device <host>`; a UUID found nowhere prints a clear "no
  session on this machine" message. There is **no** fuzzy/content fallback for a
  UUID anywhere — the peer's `--json` answer id-resolves too, so a content
  mentioner can never masquerade as the session. `--local` still restricts the
  lookup to the local machine, and a peer already answering a parent's sweep
  (`AGENTS_SESSIONS_LOCAL=1`) never re-fans-out. Source:
  `resolveSessionAcrossFleet` / `fleetHitsById` / `shouldFanOutForId` in
  `apps/cli/src/commands/sessions.ts` (wired into `renderOneSession`), and the
  id-only `--json` resolution at the sessions listing seam. (RUSH-2024)

- **`agents doctor --devices` now detects cross-device harness divergence (RUSH-2027).** The umbrella fleet diagnostic compares each registered device's installed harness inventory — resources (commands, skills, hooks, rules, mcp, permissions, subagents, plugins, promptcuts, workflows), per-agent installed versions, and `.agents`/`.system` config-repo state (branch, HEAD, dirty) — against the local machine as the baseline, and flags anything present on one box but missing on another. A plugin like `swarm` installed on `zion` but absent on `yosemite-s0` now surfaces as a clear warning (`yosemite-s0 is missing plugin 'swarm' (present on zion)`) instead of only being discovered at runtime as `Unknown command: /swarm:run`. Agent-version gaps (`yosemite-s0 is missing claude@2.1.220`) and diverged config repos are reported too. Read-only by default — it never installs or syncs; `--json` carries a stable `fleet` divergence block for the VS Code extension to consume. `agents fleet status` gained the same per-device divergence warning in its rollup. Every device's top-level `doctor --json` now emits a `fleet` inventory field so the comparison needs no extra probe. Source: `apps/cli/src/lib/devices/fleet-divergence.ts` (comparator), `apps/cli/src/lib/devices/fleet-inventory.ts` (`collectLocalFleetInventory`), `apps/cli/src/commands/doctor.ts` (`runDevicesDoctor`, `renderFleetDivergence`, `--json` `fleet` field), `apps/cli/src/lib/devices/health-report.ts` (`buildFleetHealthReport` divergence warning), `apps/cli/src/lib/git.ts` (`readRepoState`).

- **`agents doctor` now shows repo-behind notices; they no longer appear on stderr during normal commands (RUSH-2048).** `printPendingUpdateNotices()` — which wrote "agents-cli: ~/.agents/ is N commits behind origin/main" to stderr on every CLI invocation — is replaced by `readRepoBehindMarkers()`, which returns the same data without printing. `agents doctor` reads these markers and renders a "Repo updates" section showing which repos are behind and the `agents repo pull <alias>` fix command. `agents doctor --json` emits a `repos` array so menubar helpers and other consumers can read the same data. Markers persist on disk until the next background fetch overwrites them, so the notice stays visible until the user acts. Source: `apps/cli/src/lib/auto-pull.ts`, `apps/cli/src/commands/doctor.ts`, `apps/cli/src/index.ts`.

- **Session affinity data + host affinity resolver (RUSH-2049).** Sessions index
  persists `machine` (schema v18) so affinity can `GROUP BY machine`.
  `queryAffinityRollup` returns launch counts by device (and harness/joint for
  analytics). Host affinity sampling lives in `smart-launch.ts` as
  `resolveDeviceAffinity` / `applyDeviceAutoToOptions` (weight ∝ launches^α;
  online hosts with no history still explore at weight 1). Account pick stays
  the existing balanced strategy (live session/week rate-limit windows).
  **User-facing host pick shipped as `--device auto` / `--host auto` in
  RUSH-2059** (not a public `--smart` flag and not harness auto-pick). Source:
  `apps/cli/src/lib/session/db.ts`, `origin-machine.ts`, `smart-launch.ts`.

- **`agents sessions --all` now widens every non-status filter, not just the
  directory (RUSH-2055).** `--all` used to only drop the current-project scope; it
  now also drops the 30-day window cap, so one flag means "all values for every
  non-status filter" — all directories AND all time. `--active` still composes as a
  status filter, and `-a` / `--device` / `--since` still narrow their own axis (an
  explicit `--since` overrides the all-time default). Applies to both the bare
  listing and `--active`. Source: `apps/cli/src/commands/sessions-browser.ts`.

- **Device affinity is `--device auto` (not `--smart` / harness `auto`) (RUSH-2059).**
  Host pick from 14d usage affinity is a special value on the existing host flags:
  `agents run claude --device auto` or `--host auto`. The harness is always the
  agent you type — never auto-selected. Deprecated hidden `--smart` maps to
  `--device auto` for one release. Extension New Agent unpinned launches use
  `--device auto`. Banner: `device=auto → <host> (affinity …) · accounts=balanced`.
  Source: `apps/cli/src/commands/exec.ts`, `smart-launch.ts`,
  `apps/factory/src/core/agents.ts`.

- **`agents sessions --active` no longer hides most of your running sessions.** On a TTY, `--active` opens the interactive browser, and the browser resolved "running" two ways that both dropped live sessions: its live scan called the local-only `getActiveSessions()` instead of the fleet sweep the static view uses, and it treated running as an *intersection* with the transcript index (`pool.filter(r => live.has(r.id))`) rather than a source of rows. Together they meant every session on another machine was invisible, as was any local one the index didn't already carry — a fleet with 32 live sessions across 7 machines showed 4. The browser now shares one gather with the static view (`gatherActiveSessions`) and folds live sessions the index lacks in as their own rows, keyed by session id, cloud task id, or `machine:pid` so two id-less sessions never collapse into one. Picking a row that has no session id yet reports where the process is instead of trying to open a transcript that doesn't exist. Source: `apps/cli/src/commands/sessions.ts` (`gatherActiveSessions`, `isIdlessLiveRow`), `apps/cli/src/commands/sessions-browser.ts` (`liveRowKey`, `indexLiveRows`, `liveSessionToMeta`, `mergeLiveIntoPool`).
- **The session browser now shows which program each running session is in.** A new host column names the terminal or editor hosting the session — `codium`, `ghostty`, `tmux`, or `tmux→ghostty` when a tmux session is being watched through another app (a bare `tmux` means it is running detached) — so a session in the list can actually be found. The column is live-only and appears just in the running view, since transcript metadata carries no host. The id column also truncates now, so a row named by a 7-digit pid can no longer shunt every later column out of alignment. Source: `apps/cli/src/commands/sessions.ts` (`liveHostLabel`, `formatPickerLabel`, `PickerColumns.showHost`).

- **The routines daemon holds no Claude credential and injects no token.** A
  scheduled or daemon-fired Claude run now authenticates exactly like an
  interactive `agents run claude` on the same machine: through the rotation-pinned
  account's own `CLAUDE_CONFIG_DIR` login (`.credentials.json`), which Claude Code
  refreshes per-device. The daemon previously read a token from the `claude`
  secrets bundle and injected it into every routine spawn — first as one ambient
  `CLAUDE_CODE_OAUTH_TOKEN` (RUSH-1759), then also as per-account
  `CLAUDE_CODE_OAUTH_TOKEN_<account>` setup-tokens — which shadowed each account's
  own on-disk login and made the daemon a second, competing credential store. Both
  paths are removed, along with the sandbox `ENV_ALLOWLIST` entry that forwarded
  them; a sandboxed routine now strips `CLAUDE_CODE_OAUTH_TOKEN` from its
  environment and falls through to the per-account login. A box whose interactive
  login has expired is skipped up front by the auth-health preflight with a
  `re-login required` hint instead of running on an injected fallback — log in once
  on that box (`agents run claude`) to restore it; no daemon restart is needed. This
  keeps the daemon out of the credential entirely, which is what avoids the
  fleet-wide rotation logout (a shared/injected token was the cause, not the fix).
  Removed: `readDaemonClaudeOAuthToken` / `readDaemonClaudeBundleEnv` /
  `buildDetachedDaemonEnv` (`daemon.ts`), `resolveAccountSetupToken` and
  `apps/cli/src/lib/secrets/account-token.ts`, `claudeHomeHasOwnCredential`
  (`agents.ts`). Source: `apps/cli/src/lib/daemon.ts`, `runner.ts`, `sandbox.ts`,
  `agents.ts`.

- **`agents sessions` no longer over-counts test results from arbitrary stdout.** The catch-up digest scraped any `\d+ pass`-shaped substring anywhere in a command's output, so a `442 passwords generated` log, a `git status: 442 files` line, or a `442 passes/sec` benchmark was reported as `Tests ✓ tests 442 pass`. It also treated any command merely containing a runner token as a test run, so npm-script sub-targets like `bun test:setup`, `npm run test:watch`, or `pnpm test:ci` were counted. Test-run classification now matches only real invocations (`bun/npm/yarn/pnpm test` bare, `vitest`, `jest`, `mocha`, `pytest`, `go test`, `cargo test`, `tsc`) and rejects `:sub-target` scripts, and pass/fail counts are read only from each runner's authoritative summary construct — vitest's ` Tests  N passed` / ` Tests  N failed | M passed` row, jest's `Tests:` line, pytest's `=== N passed[, M failed] in Xs ===` rule, bun's ` N pass`/` N fail` block closed by `Ran N tests`, and mocha's ` N passing`/` N failing`. A verdict is reported only when a real summary matched, so an ambiguous blob now shows nothing instead of a fabricated pass count. Source: `apps/cli/src/lib/session/digest.ts` (`TEST_RUNNERS` classification with `(?![:\w-])` guard, new `parseSummaryLine`, `parseTestOutput`); consumed by `apps/cli/src/lib/session/render.ts` (`renderTestsLine`) and `apps/cli/src/commands/sessions-picker.ts`.

- **Readable `Dirs:` line in `agents sessions`.** The session preview's touched-directories line no longer renders raw Claude project-slugs (`-home-me--agents-…`) or nested worktree paths. Paths under a git worktree collapse to `⧉ <slug>/<remainder>`; a Claude project-slug is matched in slug space (its cwd/`.`-encoding is lossy, so it is never decoded to a fake path) — a slug worktree shows `⧉ <name>` and a slug pointing at the session's own cwd (internal projects-storage scratch) is dropped; real paths still relativize against the session cwd and home (`~`). Source: `apps/cli/src/commands/sessions-picker.ts`.

- **`release.sh` is now a zero-config, self-routing release — runnable from any fleet box with an empty environment.** No routing/secret environment variables: `SIGN_HOST`, `SECRET_HOST`, `SIGN_HOST_REPO`, `FORCE_REMOTE_SIGN`, the `PREFERRED_SIGN_HOSTS` list, the `zion` fallback, and the `agents devices` fleet discovery are all gone. The release has three self-selected homes: git/gh orchestration on the invoking box, the Linux test suite on a **dynamic crabbox** (`scripts/sandbox.sh` selects an available Hetzner VM for the repo's `.crabbox.yaml` profile or warms one — never a hardcoded instance), and build + sign + notarize + `npm publish` + computer-helper on the **`mac-mini` home base** (the one hardcoded name, `RELEASE_HOME_BASE`). The script detects its own host (`scutil --get LocalHostName` / `hostname -s`) and runs the privileged phase on the home base — locally if already there, else over ssh — always by checking out the `v<version>` tag into a throwaway worktree and running **that worktree's** `release.sh --home-base-phase`, so the publishing script is the one carried by the release tag, never the home base's stale on-disk checkout; the worktree is removed on exit on success or failure. The npm token is resolved on the home base and never borrowed to the trigger box. A new shared `scripts/headless-sign-context.sh` factors the headless keychain-unlock + `AGENTS_SECRETS_PASSPHRASE` preamble (no Touch ID) used by both the on-home-base publish and `remote-sign-mac.sh`. A phase tracker (`[n/N]`, N=6 for a normal release, 4 for a catch-up publish) labels each phase with the box it runs on and a ✓/✗ result; a crabbox test failure prints the failing tests + the captured log path and halts before any PR/publish. Idempotency/catch-up/tree-verification guards are preserved. Source: `apps/cli/scripts/release.sh`, `apps/cli/scripts/remote-sign-mac.sh`, `apps/cli/scripts/headless-sign-context.sh`.

- **`agents secrets unlock` now grants globally, so one Touch ID actually covers everything.** An unlock was silently scoped to the ambient `AGENTS_AGENT_NAME`: typed in a plain shell it was stored under a literal `cli` harness, while a read from inside an agent looked under *its* harness (`claude`, `codex`, …). The two never met, so a valid 7-day grant was invisible to every agent for its whole life — `agents secrets exec <bundle>` reported "not unlocked in the secrets agent" while the bundle sat unexpired in the store, and each miss cost another Touch ID or blocked a headless run outright. An unlock with no `--for` is now a global grant that every harness and a plain shell can read; `--for <agent>` still narrows it to one harness, and readers resolve own-harness → global so a narrow grant wins where it applies. The broker's in-memory store and the durable session store share one scope chain, so behavior is identical before and after a daemon restart. Grants already written under the old `cli` scope migrate to global on the next broker start — an unlock you already paid Touch ID for keeps working across the upgrade instead of going unreadable. Source: `apps/cli/src/lib/secrets/scope.ts` (`GLOBAL_HARNESS`, `bundleScopeChain`), `apps/cli/src/lib/secrets/agent.ts` (`get` handler), `apps/cli/src/lib/secrets/session-store.ts` (`resolveSession`, `cli`→global migration), `apps/cli/src/lib/secrets/bundles.ts` (`readAndResolveBundleEnv`), `apps/cli/src/commands/secrets.ts` (`unlock --for`).

- **`agents sessions export <id>` now resolves a short id the same way `sessions
  <id>` does — by id only, never fuzzy content.** The id-only fix landed for the
  `sessions` view but `sessions export` still gated its index lookup on
  `isCompleteSessionId`, so a bare hex short-id like `d3470b57` absent from the
  discovered pool skipped the index and fell through to the text query — bundling
  every transcript that merely MENTIONED the id into the export. The one canonical
  id-shaped test, `looksLikeSessionId`, now lives beside `isCompleteSessionId` in
  `lib/session/discover.ts` and is shared: `sessions export` resolves any id-shaped
  selector through the index (exact -> prefix -> `findSessionsById`) and reports
  "No session with id …" on a miss instead of shipping the mentioner. Source:
  `apps/cli/src/lib/session/discover.ts`, `apps/cli/src/commands/sessions-export.ts`.

- **Resolve a Claude transcript across every version home, not just the live `~/.claude`.** A session launched under an earlier agent version keeps its transcript under that version's home; resolving only the `~/.claude` symlink (which repoints to the newest installed version) meant that installing a new version silently hid every still-running older-version session — no `sessionFile`, so `agents sessions` rendered it `unknown` and the watchdog skipped it as "no activity timestamp". `findClaudeSessionFile` now searches all version-home project roots via `getAgentSessionDirs`, newest mtime winning. Source: `apps/cli/src/lib/session/active.ts`.

## 1.20.77

- **Interactive `agents run --host` now tracks the real session for every agent,
  not just Claude.** Codex, Kimi, Grok, and Gemini coin their own session id and
  reject a caller-supplied one, so an interactive host run of any of them showed a
  stale/absent id locally — `agents sessions` couldn't surface it and a dropped
  link couldn't auto-reconnect it (RUSH-2033 fixed only the Claude `--session-id`
  path). The launcher now forwards one correlation key it controls
  (`AGENT_LAUNCH_ID`); the remote `agents run` adopts that key
  (`resolveLaunchId`), so its SessionStart hook records the agent's real session id
  under it. After the stream the launcher does one ssh read of the remote hook
  record, resolves the real id by launch id (`resolveRemoteSessionId` /
  `pickRemoteSessionId`), registers it in the local session index, and reconnects
  against it on a dropped link. Claude still forces its own id up front and is
  unchanged. Source: `apps/cli/src/lib/hosts/remote-session-id.ts`,
  `resolveLaunchId` in `apps/cli/src/lib/exec.ts`, and the interactive `--host`
  branch in `apps/cli/src/commands/exec.ts`. (RUSH-2034)

- **Project routines can opt into daemon firing with source tracking, sync, and
  host placement (RUSH-2035).** Project YAML under `<project>/.agents/routines/*.yml`
  stays inspection-only until `agents routines enable-project` (with interactive /
  `--yes` approval) records the project on `meta.routines.projects` and materialises
  copies into `~/.agents/routines/` with a `source:` block (`projectPath`, git
  `repo`/`branch`/`commit`). `agents routines sync` (and daemon start/SIGHUP reload)
  refreshes those copies when project YAML changes; `disable-project` / `projects`
  manage the allowlist. New `hostStrategy: local|host|fleet|cloud` (CLI `--placement`)
  chooses where the job body runs: local, a named `--run-on` host, one online fleet
  device per fire (no cross-device double-fire — off-box strategies auto-pin
  `devices`), or the agent's native cloud provider. `--host` remains the remote-
  management passthrough. List/JSON surfaces source repo/branch and strategy. Source:
  `apps/cli/src/lib/routines.ts`, `routines-project.ts`, `routines-placement.ts`,
  `runner.ts`, `daemon.ts`, `commands/routines.ts`, `docs/03-routines.md`.

- **Factory interactive launches default to `--mode auto` (RUSH-2038).** The Factory VS Code extension no longer inherits the CLI's `plan` default for interactive terminal launches. Codex, Claude, Gemini, Cursor, OpenCode, and Antigravity now start in `auto` (writable-but-gated) when opened from Factory without an explicit mode, so the agent can edit files instead of stalling in a read-only sandbox. Source: `apps/factory/src/core/agents.ts`.

- **Codex approval blocks now notify you.** A headless or terminal Codex agent
  blocked on an approval prompt used to stall silently — the feed/notification path
  only fired for Claude. Codex emits `PermissionRequest` (not Claude's
  `Notification`), which the `feed-publish` hook now handles: it publishes an
  approval-class block with a high cost-of-delay and a `deny` safe-default, so the
  blocked agent surfaces on `agents feed` and `agents feed --dispatch` pages the
  phone as urgent. A Codex approval card clears once the approved tool runs, via a
  matcher-less `PostToolUse` clear hook registered **for Codex only** — so Claude's
  card lifetime (its `permission_prompt`/`idle_prompt`/`elicitation_dialog`
  notification blocks persist until `Stop`/`SessionEnd`) and per-tool overhead are
  exactly as before. The other feed hooks are now registered for Codex too, not
  Claude only. The Factory extension bridges the same waiting state to an
  edge-triggered VS Code notification with a "Focus terminal" action. Claude's path
  is unchanged. Source: `FEED_PUBLISH_HOOK_SCRIPT` / `ensureFeedPublishHook` in
  `apps/cli/src/lib/feed.ts`, `apps/factory/src/core/waitingNotifier.ts`.
  (RUSH-2039)

- **`agents fleet ping` now completes within ~15 s per device and ~30 s total, even when several fleet devices are offline or slow (RUSH-2041).** The per-device remote auth probe timeout was lowered from 60 s to 15 s (matching the `fleet status` version-probe budget, which is enough for the ~8 s provider-fetch inside the local auth probe). `fanOutDevices` gained an optional `perDeviceTimeoutMs` that races each probe against a deadline and records it as `failed: timed out` instead of hanging. `runFleetPing` now also wraps the entire fan-out in a 30 s hard cap so the command can never outlast a reasonable budget. Offline devices are now reported promptly as failed/timed-out rather than left hanging in the spinner. Source: `apps/cli/src/lib/devices/fleet.ts` (`fanOutDevices`, `FanOutDeviceOptions`), `apps/cli/src/commands/ssh.ts` (`probeRemoteAuth`, `runFleetPing`).

- **`agents sessions` surfaces checklist progress in every list/preview (RUSH-2045).** The picker preview, `--active` rows (local + cross-machine), flat `doing` cell, and metadata-only previews now show compact `✓done/total · current step` from `SessionMeta.todos` / `ActiveSession.todos`, plus the originating prompt and a directories-touched activity line. Active/cross-machine rows also show label + clickable project/ticket alongside the agent short id. Covers interactive, headless, teams, and sub-agent sessions that share the preview infra. Source: `apps/cli/src/commands/sessions-picker.ts`, `apps/cli/src/commands/sessions.ts`.

- **Checklist completions emit a feed event (RUSH-2046).** When an agent marks a
  task-checklist item done, the `11-activity-log.py` hook now appends a
  `task.completed` milestone to the session activity log (and `checklist.created`
  the first time a checklist appears), so completions show in `agents feed` and the
  unified `agents events` stream with the item subject and running `N/M`. Detection
  folds the transcript across harnesses — Claude `TaskUpdate`/`TodoWrite`, Grok
  `todo_write`, Codex `update_plan` — so a completion is recognized regardless of
  which agent produced it. Source: `apps/cli/src/lib/activity.ts` (incl. the embedded
  hook), `apps/cli/src/lib/events.ts`, `apps/cli/src/commands/feed.ts`.

- **Actor provenance now survives the SSH hop.** A run dispatched to another host
  (`agents run --host`, a remote `agents teams` supervisor, or any `--host`
  passthrough) used to drop the resolved actor at the SSH boundary, so the remote
  re-resolved it from the *originating* box's `SSH_CONNECTION` and mis-credited the
  work to the shared machine or `UNRESOLVED@<host>`. The dispatch layer now forwards
  `AGENTS_ACTOR*` / `GIT_*` across the wire (POSIX `export` and Windows `$env:`
  alike), so the remote inherits the origin identity instead of re-resolving. A
  caller-supplied env value still wins on collision (mirrors `buildExecEnv`).
  Source: `withActorEnv` in `apps/cli/src/lib/hosts/dispatch.ts`, wired into
  `launchDetached` / `runInteractiveOnHost` and the `--host` passthrough. (RUSH-2028)

- **A Linux-driven release now auto-discovers its macOS sign host instead of
  hardcoding `mac-mini`.** `scripts/remote-sign-mac.sh` previously defaulted
  `SIGN_HOST` to `mac-mini`, so a release from a Linux box failed outright whenever
  that one appliance was offline — the recurring reason a release stalled and a
  human had to finish it by hand. With `SIGN_HOST` unset the script now reads
  `agents devices list --json`, keeps the reachable/online macOS devices, and picks
  the first that answers `ssh` in preference order `mac-mini` → `zion` → any other
  online Mac. `mac-mini` stays first because it signs headlessly (no Touch ID);
  `zion` (the interactive Mac) is the fallback. An explicit `SIGN_HOST=<host>` still
  pins one and skips discovery, and when no reachable Mac qualifies the script fails
  with the ordered list it tried rather than hanging on a dead host. Source:
  `apps/cli/scripts/remote-sign-mac.sh`.

- **An agent launch never raises a Touch ID sheet.** On macOS, starting an agent
  terminal or firing a routine could pop several biometric prompts in a row, because
  each keychain read runs in its own helper process and the biometric assertion never
  reuses across processes. Two causes: `interactiveUnlock` defaulted to true whenever
  an agent name was present, which let an agent-initiated read fall through the
  `agentOnly` guard; and `isHeadlessSecretsContext` recognized the `headless` and
  `teams` runtimes but not `terminal`, which is what an interactive run sets. Agent
  launches now resolve broker-only and a locked bundle fails fast naming
  `agents secrets unlock <bundle>`. Direct read commands use the same broker-only
  path even from a plain shell; only an explicit unlock may authenticate. This narrows the
  agent-triggered approval added in RUSH-2032, which is unreleased.

- **`release.sh` now borrows the npm token from a primary device when the local box
  has none, so a Linux-driven release stops asking a human to approve a token.**
  Token resolution was env → local `npmjs.com` bundle → *die*. On a fleet box whose
  own keychain holds no npm token, that dead end pushed agents to hand-move a
  credential between machines (and correctly get gated on it). A third step now
  resolves the bundle **ephemerally from a primary device over SSH** —
  `agents secrets exec npmjs.com --host <host>`, which resolves on the remote and
  injects into the run only, never storing the token locally. It tries `SECRET_HOST`
  first, then `zion`, then `mac-mini`, and fails with the list it tried if none
  answer. Combined with the sign-host auto-discovery, a Linux box can now cut a full
  release end-to-end given a reachable Mac for signing and any reachable device that
  holds the npm token. Source: `apps/cli/scripts/release.sh`.

- **Branded, actionable daemon notifications on the routine lifecycle (RUSH-2030).**
  Daemon desktop notifications (overdue routines, config heal, the no-credential
  warning) now route through the `MenubarHelper.app` companion instead of raw
  AppleScript, so they carry the agents-cli mark rather than the generic Script
  Editor icon; they degrade to `osascript`/`notify-send` only when the helper is
  not installed. The daemon also notifies when a routine **starts** and
  **finishes** (success/failure, with the report's first line or the error reason
  folded in), suppressing command-housekeeping start/success pings to avoid spam.
  Clicking a finish notification opens the run report/log; start/overdue open the
  runs folder. Source: `apps/cli/src/lib/menubar/notify-desktop.ts`,
  `apps/cli/src/lib/routine-notify.ts`, `apps/cli/src/lib/daemon.ts`,
  `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`.

- **`agents secrets status` now suggests which bundles to unlock.** It reads the existing `secrets.get` audit events and surfaces bundles you keep getting a Touch ID prompt for — read from the keychain (not served silently by the broker/session) 3+ times in the last 7 days and not currently held — with a ready `agents secrets unlock <name>` command. `never`/no-ACL bundles (which never prompt) are excluded, and the hint is best-effort so it never breaks `status`. Source: `apps/cli/src/lib/secrets/unlock-hints.ts`, `apps/cli/src/commands/secrets.ts`.

- **`agents sessions <id>` with a short/partial id resolves by id only — no more
  "Multiple sessions match" from fuzzy content.** A complete UUID already resolved
  by id, but a bare hex short-id like `d3470b57` was not caught by
  `isCompleteSessionId`, so it fell through to the ranked content search and
  surfaced every transcript that merely MENTIONED the string (a resume prompt
  echoes the parent id into the body of many later sessions) — a real view id
  returned a list of unrelated sessions. Any id-shaped query — complete id OR hex
  short-id/prefix (`looksLikeSessionId`) — now resolves through the index by id in
  both `resolveSessionQuery` and the `renderOneSession` content-widen gate, and
  reports "no session found" when nothing matches instead of content-searching.
  Free-text phrases keep the ranked search path. Source:
  `apps/cli/src/commands/sessions.ts`.

- **`agents sessions --active` attributes the initiating device for SSH-launched
  sessions.** A session started by ssh'ing into a box (common for tmux-hosted
  runs) used to render as `local` with no origin, because the tmux discovery path
  stamped a `transport:'local'` placeholder that made provenance enrichment skip
  it. Enrichment now probes the pane process's env and upgrades the row to `ssh`
  with the real origin, then resolves the SSH client IP against the device
  registry into `provenance.origin` (`{ device, user? }`). Both the flat listing
  and the interactive browser read `ssh←<device>` (e.g. `ssh←zion`); an
  unregistered IP stays bare `ssh`. Answers "which box launched this session"
  without scraping `ps`/`who`/`tailscale`. Source:
  `apps/cli/src/lib/session/active.ts`, `apps/cli/src/lib/session/provenance.ts`,
  `apps/cli/src/commands/sessions.ts`, `apps/cli/src/commands/sessions-browser.ts`.

- **`agents sessions --include user` / `--first` / `--last` now count genuine user turns, not harness-injected scaffolding (#1550).** A Claude session opened with a `!`-prefix command (e.g. `j <dir>`) stores `<bash-input>`/`<bash-stdout>` as `role=user` records, and `<system-reminder>`/`<task-notification>`/`<command-*>`/hook-feedback/skill bodies land the same way — so `--include user --first 3` returned the jump command and its shell output before the real ask, and every consumer of `--include user` (the `verify-work-complete` Stop hook's "original request" self-audit, `session-recall`) inherited the noise. `parseSession` now flags these injected `role=user` events `_synthetic` at its central post-parse chokepoint via one shared classifier (`isSyntheticUserMessage`), so turn slicing (`applyTurnSlice`) and role filtering (`roleOfEvent`) skip them; they stay in the default/`--markdown` stream for full fidelity. Claude-specific in practice — Codex/Gemini/OpenCode/Grok/Kimi/Rush route shell output to `tool_result`, never to `role=user`, and Droid's `<system-reminder>` was already dropped — but the classifier is cross-harness by construction. Source: `apps/cli/src/lib/session/{prompt,parse,render,types}.ts`.

- **Routine/daemon Claude runs authenticate the rotation-pinned account via its own long-lived setup-token — fixes fleet-wide daily logout.** Claude Code's interactive OAuth session uses single-use *rotating* refresh tokens: when one fleet machine refreshes, the server invalidates that account's token on every other machine, so unattended boxes 401 and drop (Claude Code #25609/#56339). A `claude setup-token` is a 1-year, non-rotating token that sidesteps this. The daemon now injects every `CLAUDE_CODE_OAUTH_TOKEN_<account>` present in the `claude` bundle (not just the one ambient token), and a routine spawn selects the token matching the account its version-home is pinned to (`runner.ts` `buildRoutineSpawnEnv` → `resolveAccountSetupToken`), so each unattended account authenticates with its own setup-token instead of the rotating interactive session. Works on macOS too, where the prior drop-based path was inert. Inert (no behavior change) until per-account setup-tokens are stored in the no-ACL `claude` bundle. Interactive `agents run` and remote `--host` dispatch are unchanged (out of scope; noted for follow-up). Source: `apps/cli/src/lib/secrets/account-token.ts`, `apps/cli/src/lib/runner.ts`, `apps/cli/src/lib/daemon.ts`, `apps/cli/src/lib/sandbox.ts`.

## 1.20.76

- **The routines daemon can read a `never`/no-ACL secrets bundle headlessly again — fixes a false "no Claude credential" alert.** The headless secrets guard (`readAndResolveBundleEnv`'s `agentOnly` branch) threw for every keychain-backed bundle absent from the broker, but a `never`/no-ACL bundle carries no biometry ACL — its reads raise no Touch ID sheet, so blocking it served no purpose. That wrongly blocked the automation-only `claude` bundle the routines daemon reads at startup (`readDaemonClaudeOAuthToken`), leaving every scheduled Claude routine token-less, and — on the new auth-failure alert path — firing "no Claude credential" on each daemon start even when the bundle was configured correctly. The guard now exempts `never`/no-ACL bundles (policy learned via a prompt-less metadata read), matching the existing file-backend exemption. Source: `apps/cli/src/lib/secrets/bundles.ts`.

- **`release.sh` can now cut the next patch when main is ahead of an unpublishable
  version.** The catch-up guard refuses to publish a merged release PR whose squash pulled
  in concurrent main commits — correctly, since the tree that would ship is not the tree CI
  tested (the hole that let 1.20.58 publish before its Windows matrix failed). Its refusal
  advises cutting the next patch through the normal release PR flow, but the version
  validator measured patch+1 from the REGISTRY, so with main at 1.20.75 and npm at 1.20.74
  both 1.20.75 (blocked) and 1.20.76 (read as a skipped version) were rejected — leaving no
  patch-level path forward and a minor bump as the only escape. A new `patch-from-main`
  case accepts the version one patch above `package.json` when main is ahead of the
  registry; it grants no bypass, and the release still earns its own release PR, full
  cross-platform matrix, merge, tag, and publish. The decision moved out of `release.sh`
  into `scripts/validate-bump.sh` so it can be tested directly — `release.sh` itself
  cannot be run in a test, since it demands a clean main plus npm and gh auth long before
  it reaches the bump decision, which is why this arithmetic had no coverage at all. The
  rejection message now also lists the main-ahead options only when main really is ahead,
  instead of advising a version the script would then refuse. Source:
  `apps/cli/scripts/validate-bump.sh`, `apps/cli/scripts/release.sh`.

- **Teams now run local teammates under one frozen actor.** The orchestrator was
  spawning each local teammate through a raw shell without the actor env, so every
  teammate's inner `agents run` re-resolved the actor independently instead of
  inheriting the orchestrator's — contradicting the "resolve once, whole tree
  shares one actor" contract. The local spawn env now carries `actorEnv(resolveActor())`
  (process env < actor < `--env` overrides), so all teammates inherit the single
  frozen actor. Teammate records also carry an `actor` field, persisted to
  `meta.json` and emitted in the status dict. Remote teammates inherit the fix at
  the dispatch layer. Source: `apps/cli/src/lib/teams/agents.ts`.

- **`agents sessions <full-session-id>` no longer answers with an unrelated
  session.** A complete id that was not in the local index fell through to the
  FTS content search, which tokenizes the UUID and matches every transcript that
  merely *mentions* it. The miss surfaced as up to ten unrelated sessions under
  `Multiple sessions match "<id>"` plus the advice `Pass a longer ID to narrow it
  down` — impossible to follow, since a full id is already the longest form. The
  same fallthrough made `--preview` render a different session's transcript, let
  an 8-char short id lose to a content hit, and made `agents sessions export
  <id>` bundle every transcript that mentions the id (14 unrelated sessions
  written into an archive meant to be handed to someone else). A query that is a
  whole session id now resolves by id alone: it reports `No session with id <id>
  on this machine.` and points at `--device <host>` for the fleet. Short-id
  prefixes and text searches are unchanged. The recognized shapes are the ones
  the index actually holds — a bare UUID, `session_` + UUID (kimi, rush), and
  `ses_` + 26-char ULID (opencode); routine run ids and cloud execution ids stay
  out of scope and keep today's search behavior. Source:
  `apps/cli/src/lib/session/discover.ts` (`isCompleteSessionId`),
  `apps/cli/src/commands/sessions.ts` (`resolveSessionQuery`), and
  `apps/cli/src/commands/sessions-export.ts` (`selectSessions`).

## 1.20.75

- **Wire native file-based slash commands for Grok (RUSH-1851).** Grok >= 0.2.111
discovers commands from the cross-agent `~/.agents/commands/` dir (plus the
legacy `~/.claude/commands/` symlink). `agents sync grok` now writes native
`.md` command files there instead of converting commands to skills, so `agents
view grok` and `agents commands list grok` report Grok as commands-capable.
Source: `apps/cli/src/lib/agents.ts`.

- **Document that Droid Factory Missions are invoke-only (RUSH-1864).** Probed
  droid v0.177.0 (self-updating; ticket cited v0.161.0) and Factory docs:
  Missions run via `/missions` or `droid exec --mission` (optional `-f` is a
  prompt file, not a named template). `~/.factory/missions/<sessionId>/` is
  runtime state only — no auto-discovery dir agents-cli can populate — so
  `workflows` stays `false` with an evidence comment rather than inventing a
  writer target. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/tests/agents.test.ts`.

- **Reading state no longer writes `agents.yaml`, which silently deadlocked
  `agents repo pull` (RUSH-1925).** Registry presets from `SEEDED_REGISTRIES` (today
  `skill.hermes`) were seeded on the state **read** path, which wrote the registry entry
  plus a `seededPresets` marker into `agents.yaml`. That file is git-tracked in the user's
  DotAgents repo, so the write left the working tree dirty and every subsequent
  `agents repo pull` aborted with `Working tree has uncommitted changes` — naming neither
  the file nor the cause. Because *every* `agents` invocation reads state, the dirt
  reappeared the instant it was cleared: `git checkout -- agents.yaml && agents repo pull`
  re-seeded before the pull ran, so the loop could not be escaped through the CLI at all.
  On a host with several live agent sessions even a raw `git pull --rebase` lost the race,
  and one machine sat 27 commits behind for weeks as a result. Seeded presets are now
  resolved in memory by `getRegistries` — the same way `DEFAULT_REGISTRIES` has always
  worked — so nothing is written and no later write can flush them into the file.
  `seededPresets` becomes a removal tombstone: `agents registry remove skill hermes`
  records the key and the preset stops being offered, which is the behaviour the marker
  existed to protect. Files seeded by the old code carry both the tombstone and an explicit
  entry in their own `registries:` block, and the explicit entry still wins, so upgrading
  changes nothing for them. `setRegistry` also falls back to
  `SEEDED_REGISTRIES` when merging a partial update, so `registry disable/enable/config`
  on a never-materialized preset can no longer persist a stripped entry that drops `url`.
  Source: `apps/cli/src/lib/registry.ts`,
  `apps/cli/src/lib/state.ts`, `apps/cli/src/lib/registry.seeds.test.ts`,
  `apps/cli/src/lib/state.test.ts`.

- **`agents fleet status` no longer hangs on an unreachable box (RUSH-1964).** The cheap
  stats probe (~2.5s) already learns whether each box is reachable, but the dead-box skip
  that spares the expensive `agents --version` (15s) + `agents doctor --json` (30s) dials
  was gated behind `--refresh` — so a default run still spent up to 45s per genuinely
  unreachable box, and one down box could stall the whole matrix. The default path now
  gates those dials on the same reachability verdict: a box the stats probe found
  unreachable short-circuits straight to an `unreachable` row with zero further SSH
  round-trips. Measured on a single blackholed target, `fleet status` dropped from 22.8s
  to 2.8s. (VPN-first transport and SSH key provisioning remain deferred.) Source:
  `apps/cli/src/lib/devices/fleet.ts` (`fleetHealthSkip`), `apps/cli/src/commands/ssh.ts`
  (`runFleetStatus`).

- **Fleet reachability reflects the live probe (RUSH-1965).** `agents devices` and `agents fleet status` now persist the live SSH probe's `{reachable, via, checkedAt}` verdict to the registry and read the online/offline word from it — freshest signal wins: a live stat this run, then the written-back verdict, then the cached `tailscale.online` snapshot. A reachable box (including a `via:"manual"` device with no Tailscale peer) no longer renders "offline" while its live load/mem sit one column over. Source: `apps/cli/src/lib/devices/reachability.ts`, `apps/cli/src/lib/devices/registry.ts`.

- **`agents fleet status` output redesigned — rollup + NEEDS ATTENTION, quiet when healthy
  (RUSH-1966).** The old grid buried "is my fleet OK?" under duplicated columns and glyph
  soup (a "Health" column that just repeated Load/Mem, `stale · cold` counts across every
  orphan version, an `●5 ·8 ◐3` auth cell, and warnings that re-listed all 12 devices three
  times). The default view now leads with a one-line rollup (`● N online · ○ M offline`),
  then a short **NEEDS ATTENTION** list where every item names its fix command — offline →
  `check the box`, config drift or a stark CLI gap → `agents apply <box>`, version skew →
  `agents upgrade --fleet` — then quiet per-device rows grouped by OS (macOS / Linux /
  Windows) showing `name · capacity · load/mem · version`, with this machine flagged
  `▸ … ← this machine`. Drift is reported on the active version only (not orphan versions);
  orphaned versions are demoted to a one-line `agents prune` nudge in the footer; the
  freshness footer names the cache age and what `--live` / `--verbose` add. A healthy fleet
  reads in a few lines. The full per-device auth/CLI/sync/version grid moves behind the new
  `--verbose` flag; `--json` is unchanged. Source: `apps/cli/src/lib/devices/health-report.ts`
  (`renderFleetSummary`, `buildFleetAttentionItems`), `apps/cli/src/commands/ssh.ts`
  (`runFleetStatus`).

- **`agents doctor` now flags credentials exported from shell rc files (RUSH-1968).** A
  secret exported from `~/.zshenv`/`~/.zshrc`/`~/.bashrc`/`~/.profile` is inherited by every
  process the login shell spawns and is readable from `/proc/<pid>/environ` by any same-user
  process — `.zshenv` is sourced even by non-interactive `ssh host 'cmd'`, so the value lands
  in essentially everything the box runs. The doctor overview now scans the current user's rc
  files and prints a `Secrets in shell config` warning that names each credential-shaped
  export by `file:line` and variable name (never the value), with the file-store master key
  `AGENTS_SECRETS_PASSPHRASE` called out separately — its off-env home is
  `~/.agents/.secrets-key/passphrase` (chmod 600), and other credentials should move to
  `agents secrets` and inject via `agents secrets exec`. The scanner reads only the variable
  name and line number, so a finding is safe to print or log. Source:
  `apps/cli/src/lib/secrets/rc-hygiene.ts` (`scanUserRcFiles`, `scanRcExports`,
  `rcSecretWarningLines`), wired into `apps/cli/src/commands/doctor.ts`
  (`renderRcHygieneAdvisory`).

- **`agents devices` no longer forces a Touch ID prompt on a password-auth box
  (RUSH-1970).** The read-only stats probe's live SSH to an uncached
  `auth.method === 'password'` device used to drive the askpass shim to resolve
  the SSH password through the biometry-gated Keychain sheet under a TTY, popping
  Touch ID during what should be a silent probe. The probe now threads a
  broker-only signal (`AGENTS_SSH_AGENT_ONLY`) so it resolves from an
  already-unlocked broker or degrades to an unreachable row — never a biometric
  prompt. Source: `apps/cli/src/commands/ssh.ts`,
  `apps/cli/src/lib/devices/health.ts`, `apps/cli/src/lib/devices/connect.ts`.

- **`agents sessions migrate` (alias `relocate`) relocates a RUNNING session onto
  another machine, then stops the source here (RUSH-1977).** `--auto` scores the
  fleet and picks a target, `--host <name>` names one explicitly, and `--lease`
  provisions a fresh ephemeral box; `--mode resume|rehydrate` chooses whether the
  target resumes the native transcript or replays it via `/continue`. Every
  migration is written to an append-only ledger, viewable with `agents sessions
  migrations`. Load-bearing invariant: the source session is never stopped until
  the transcript is confirmed live on the target, so a failed hop leaves the
  original running. (Not to be confused with `agents sessions detach`/`attach`,
  the unrelated background/foreground pair.) Source:
  `apps/cli/src/commands/sessions-migrate.ts`,
  `apps/cli/src/lib/session/migrate-targets.ts`,
  `apps/cli/src/lib/session/migrations.ts`.

- **`agents sessions --active --json` now emits flat `ticketId` and `project`
  keys on every row.** A supervising watcher joins active sessions on ticket +
  project, but the raw row nested the ticket under `ticket.id` and carried no
  `project` at all, so a naive join silently dropped every session. Each row now
  carries top-level `ticketId` (from the detected ticket) and `project` (the
  basename of the session's cwd — the same derivation the historical `--json`
  listing uses), both always present and `null` when unknown. The existing raw
  fields are unchanged. Source: `apps/cli/src/commands/sessions.ts`
  (`serializeActiveSessionsForJson`).

- **Actor provenance — agent git commits are now credited to the human who
  started the run, not the shared account.** One account across a shared fleet
  meant every commit, from anyone who SSH'd into a box, showed up as the same
  author. `resolveActor()` now identifies who is behind a run: over SSH it
  `tailscale whois`es the client IP to the connecting tailnet identity (name +
  login email); locally it stays honest with `UNRESOLVED@<host>` and claims no
  identity. The resolved actor rides the agent's process env as `AGENTS_ACTOR` /
  `AGENTS_ACTOR_KIND` (inherited by the whole spawn tree, so it resolves once),
  and for a resolved human it also injects `GIT_AUTHOR_*` / `GIT_COMMITTER_*` — so
  the agent's own `git commit` is attributed to the person. An unresolved actor
  injects no git identity, so local runs keep their ambient git config unchanged.
  Source: `apps/cli/src/lib/actor.ts`, wired into `buildExecEnv`
  (`apps/cli/src/lib/exec.ts`).

- **New optional `actors:` map in `agents.yaml`.** Keyed by a short slug, each
  entry (`kind` / `name` / `email` / `github` / `login`) enriches or overrides
  what `tailscale whois` resolves — pin a preferred git email, add a GitHub
  handle, override the display name, or mark an entry as an agent rather than a
  human. Entirely optional: a tailnet SSH identity already resolves without it.
  Source: `apps/cli/src/lib/types.ts` (`ActorConfig`, `Meta.actors`).

- **`agents run antigravity "prompt"` now works headless without an explicit
  `--headless`.** Antigravity's `--print` flag was gated on the raw `--headless`
  flag, which defaults to `false` at the CLI layer — but headless is inferred from
  prompt presence. So a bare `agents run antigravity "do X"` built `agy <prompt>`
  with no `--print`, launching the interactive TUI and dying with
  `bubbletea: could not open TTY: /dev/tty` in any non-terminal shell (headless
  runs, teams, routines, `--host`). Print flags are now gated on the resolved
  headless state, matching the documented "`--headless` auto-enabled when a prompt
  is provided" contract and the behavior of every other agent. Antigravity was the
  only agent affected — it is the sole harness whose prompt is a bare positional
  with no headless subcommand and no `-p` print alias. Source:
  `apps/cli/src/lib/exec.ts`.

- **Routine auth-failures are now detected, not silent.** When a routine's agent is logged
  out or its token is revoked, the run is classified `failed` with an `auth_failed:` /
  `auth_preflight:` reason instead of a generic non-zero exit. The login-error text is no
  longer written into `report.md`, and `{last_report}` now only injects the last *completed*
  run's report — so a single logged-out run can no longer poison every subsequent run's
  prompt. Classification uses the Claude stream-json markers (`error:"authentication_failed"`
  and a `result` event with `is_error:true`), which is the reliable signal — `terminal_reason`
  is `"completed"` on a logged-out run. Rate-limit still classifies first, so a 429 keeps
  triggering failover rather than being mistaken for an auth failure. Source:
  `apps/cli/src/lib/exec.ts`, `apps/cli/src/lib/runner.ts`, `apps/cli/src/lib/routines.ts`.
- **`agents routines run` now exits non-zero when a run doesn't complete.** A run that ends
  in `failed`, `timeout`, or an auth failure returns exit code 1 and `--json { "ok": false, … }`
  with the reason, instead of exiting 0 with `ok:true` — so cron wrappers, `&&` chains, and
  `--json` consumers actually see the failure. (Exit code is set via `process.exitCode` so the
  JSON payload flushes fully to a pipe first.) Source: `apps/cli/src/commands/routines.ts`.
- **Auth preflight before dispatch.** A routine whose (agent, version) has a cached
  `revoked` auth verdict fails fast with `auth_preflight: revoked` without spawning a
  doomed agent. Fails open on any other verdict, so a stale/absent probe or a network blip
  never blocks a run, and agents with no live probe (codex/gemini/grok) are never blocked.
  Source: `apps/cli/src/lib/runner.ts`, reusing `apps/cli/src/lib/auth-health.ts`.
- **The routines daemon no longer starts silently token-less.** When no Claude OAuth token
  is available (e.g. a headless macOS daemon whose keychain was locked at start), the daemon
  now logs a `WARN` and fires a desktop notification instead of quietly spawning Claude
  routines that all fail auth. Source: `apps/cli/src/lib/daemon.ts`.

- **`agents sessions` indexes again from the standalone binary.** Every session
  write went through a named-parameter bind (`INSERT ... VALUES (@id, @short_id,
  ...)` in `apps/cli/src/lib/session/db.ts`), and `bun:sqlite` matches such an
  object only when its keys carry the SQL sigil — bare keys bound nothing, so all
  columns landed NULL and `sessions.short_id` (NOT NULL) rejected the row. The
  shims exec the Bun-compiled `dist/bin/agents`, so no session reached the index
  from the CLI: `agents sessions` printed `Warning: skipped unindexable session
  <id>: NOT NULL constraint failed: sessions.short_id` per session and then
  listed only rows indexed earlier by the Node entrypoint. The suite runs under
  Node (vitest), where `node:sqlite` accepts bare keys, which is why CI stayed
  green. `apps/cli/src/lib/sqlite.ts` now opens the DB with `strict: true` under
  Bun, so the bare-key call shape this codebase uses works on both runtimes (the
  edges still differ — the module doc lists what strict changes). `sqlite.test.ts`
  covers both the bind and a full `agents sessions` scan in a real `bun`
  subprocess.

- **The compiled binary no longer reports itself as a phantom `/$bunfs` install, and can self-upgrade again.**
  Since the standalone executable started shipping (1.20.53), the running copy located
  its own package root as `<__dirname>/..`. Under a Bun standalone binary `__dirname`
  is the embedded virtual filesystem, so that resolved to `/$bunfs` — a path that
  exists nowhere. Two symptoms followed on every machine running the compiled binary:
  the multi-install check reported one install as two (`/$bunfs (running)` alongside
  the real npm root, with the misleading advice to uninstall a stale copy that did not
  exist), and `agents upgrade` failed closed with `/$bunfs is not an npm-managed
  install` because no global prefix can be derived from a virtual path. A new
  `resolveRunningPackageRoot()` resolves the real on-disk root by walking up from
  `process.execPath` to the directory whose `package.json` names this package, and
  both sites use it. The PATH scan also recognizes `<root>/dist/bin/agents` as an
  entrypoint, so a shim pointing at the compiled binary — typically first on PATH, and
  the copy that actually runs — resolves to the same root as its sibling npm bin
  instead of being invisible. Genuine multi-install warnings still fire, now naming a
  real, actionable path. Source: `apps/cli/src/lib/self-update.ts`,
  `apps/cli/src/index.ts`, `apps/cli/src/lib/self-update.test.ts`.

- **Reading Claude usage no longer rotates the token and logs your fleet out.**
  `getClaudeUsageInfo` refreshed the OAuth token just to read the usage endpoint
  (`getClaudeAccessToken`, `usage.ts`) — and Claude's refresh token is single-use
  and rotates server-side, so with one account signed into several machines that
  background refresh (fired by the stale-while-revalidate usage cache and by
  `agents run`'s default "balanced" rotation on every unpinned run) invalidated
  every other box's copy, dropping the fleet to "run /login". This is the
  RUSH-1822 stampede, which was fixed for the 3-minute health probe but left live
  in the usage/run hot path. Usage reads are now strictly read-only: a new pure
  `claudeUsageAccessTokenNoRefresh` uses the stored access token and, when it is
  within the refresh leeway, reports "no usage right now" instead of rotating —
  exactly mirroring `probeClaudeStatus`. The single legitimate refresh stays on
  the real `claude` run, never a usage read. Source: `apps/cli/src/lib/usage.ts`,
  `apps/cli/src/lib/usage.test.ts`.

- **No more Touch ID storm from the usage view.** On macOS, the usage-bar fetch
  (`agents view`, the Factory watchdog that polls `agents view --json` every 60s
  per agent) and the daemon's every-3-min auth-health probe each read Claude's own
  ACL-bound `Claude Code-credentials-<hash>` keychain item on every refresh — each
  read popping a Touch ID prompt, so several running Claude agents meant a
  biometric prompt every couple of minutes. Those two access-token-only, high-
  frequency callers now opt into a device-local **no-ACL** access-token cache (the
  prompt-free mechanism `secrets/session-store.ts` uses for unlocked bundles),
  bounded by the token's own expiry, so the ACL-gated read happens at most once per
  token lifetime and every agent process reads the cache silently. The cache is
  opt-in and caches only the short-lived access token — callers that need the full
  credential (`isClaudeAuthValid`'s refresh, `readClaudeCredentialsBlob`'s Rush
  Cloud export) still take the ACL read with the refresh token intact. Source:
  `apps/cli/src/lib/usage.ts`.

- **The daemon no longer silently repoints your default agent version.** The unattended
  6-hourly launch-health pass (`healBrokenDefaultLaunches` → `ensureAgentRunnable`) now runs
  with `allowDefaultSwitch: false`: it still repairs the *current* default in place, but if
  that default can't be repaired it no longer adopts another installed version or installs
  `latest` and pins it. A background default switch installs a fresh version home, which for
  Claude is a fresh, empty credential scope (macOS keychain keyed off `CLAUDE_CONFIG_DIR`;
  Linux per-version token file) — i.e. an "unprovoked logout" at a time uncorrelated with
  anything you did, and a leading cause of routine auth-failures on unattended machines. The
  daemon now logs a `WARN` naming the version to pick instead; interactive callers
  (`agents run`, `agents add`) are unchanged and still repoint as before. Source:
  `apps/cli/src/lib/versions.ts`, `apps/cli/src/lib/daemon.ts`.

- **`agents sessions detach` / `agents sessions attach` — send a running agent to the
  background and back.** `agents sessions detach <id>` stops a live session's
  interactive process (killing the tmux session when tmux-hosted, else SIGTERM'ing the
  pid) and continues it **headless**, detached, via the existing version-pinned
  `agents run --resume` path — so it drives its task to completion without holding a
  terminal. The resumed run carries a nudge that tells the now-unwatched agent it is
  headless and to make the call rather than stall on a confirmation nobody can answer.
  `agents sessions attach <id>` stops that headless continuation and **resumes the
  session interactively** in the current terminal (`resumeSessionInPlace`) — the same
  session and full history, including whatever the background run did. They sit under
  `sessions` next to `focus`/`resume` (the session-lifecycle verbs); the Factory
  extension exposes them as **Agents: Detach** (`Cmd/Ctrl+K B`) and **Agents: Attach**
  (`Cmd/Ctrl+K A`). Both verbs are agent-agnostic (native resume for Claude/Codex,
  `/continue` replay for the rest). A session on **another host** is detached there over SSH rather than
  killed locally; **cloud and team sessions are refused** (they have their own
  lifecycles); the interactive process is fully awaited before the headless resume
  starts (no transcript race); and the background run's output is captured to
  `~/.agents/.cache/logs/detach-<shortid>.log` so a crash after detach is
  debuggable. `agents sessions --active --json` now carries a `presence` field
  (`attached` / `background` / `parked`), folded onto every row from a per-session
  detach record, so the menu bar and Factory show where each agent is. Source:
  `apps/cli/src/commands/detach.ts`, `apps/cli/src/commands/attach.ts`,
  `apps/cli/src/lib/session/detached.ts`.
  (`agents sessions migrate`'s old `detach` alias is renamed to `relocate` to free
  the `detach` name for the background/foreground verb — `migrate` and `relocate`
  both still work.)

- **`agents devices sync` no longer auto-registers tailnet nodes another user
  shared into the tailnet.** `tailscale status` includes ShareeNode peers (for
  example a tagged relay shared in by a teammate); the parser ignored that flag,
  so bootstrap registered them as your own boxes and they surfaced in `agents
  fleet ls`. Parsing now carries a `sharee` flag, `runDeviceSync` filters those
  peers out of auto-registration and suggestions, and the interactive picker
  leaves them unchecked (labeled `shared`). Deliberate paths — `devices
  register`/`add` and a `fleet:` manifest — still reach shared nodes when you name
  them. Source: `apps/cli/src/lib/devices/sync.ts`,
  `apps/cli/src/lib/devices/tailscale.ts`.

- **Faster `agents sessions` on large / unchanged session trees.** Session
  discovery re-walked and re-`stat`'d every transcript directory on every
  `agents sessions` / `output` / `view` / `teams` call — for a heavy user the
  immutable version-home and backup roots dominated the cost yet never changed. A
  new `dir_ledger` (SQLite, schema v14) caches each leaf transcript directory's
  `(mtime, entry_count)`; when both match, the per-file `stat` of that directory
  is skipped and its unchanged files are served straight from the DB, so those
  immutable roots cost one dir stat each instead of hundreds of per-file stats.
  Append safety is preserved: a file under the agent's live `~/.<agent>` root, or
  scanned within the last 10 minutes, is always re-`stat`'d (a parent-dir mtime
  bumps on create/delete/rename but NOT on an in-place append), so a growing live
  session is never missed; a create / delete / rename bumps the dir mtime and
  forces a full re-walk of that dir exactly as before. Wired into the Claude and
  Gemini scanners (the biggest win); the other scanners keep the existing
  per-file path. Set `AGENTS_SESSIONS_NO_DIR_LEDGER=1` to disable the
  short-circuit and force the old full per-file walk. Source:
  `apps/cli/src/lib/session/db.ts`, `apps/cli/src/lib/session/discover.ts`.

- **`agents feed post` — agents announce progress without opening a “needs you”
  block.** Free-text status posts append a `status.posted` milestone to the
  per-session activity log (same stream as `agents activity` and the feed’s
  recent-activity lane). Session/agent/host/runtime/pid/launch identity is
  auto-stamped from the process env and the per-pid launch registry — no
  domain-specific flags (tickets, URLs). Managed runs export `AGENT_SESSION_ID`
  / `AGENTS_AGENT_NAME` / `AGENTS_CWD` so a Bash tool call needs no extra
  wiring. Source: `apps/cli/src/lib/feed-post.ts`, `apps/cli/src/commands/feed.ts`,
  `apps/cli/src/lib/activity.ts`, `apps/cli/src/lib/exec.ts`.

- **PID-reuse protection now works on Windows, from one implementation.**
  `captureProcessStartTime()` existed twice — in `pty-server.ts` and `teams/agents.ts` —
  and neither copy had a Windows branch: both fell through to `ps`, which does not exist
  there, so the function always returned `null` and every caller silently skipped the
  guard. A dead session whose PID the OS had recycled read as alive, and
  `agents teams stop` could signal an unrelated process group. Both copies now delegate to
  a single implementation in `platform/process.ts` that reads `CreationDate` from
  `Win32_Process` as a culture-independent FILETIME, memoizes per PID (the listing path
  probes one PID per row), and bounds the spawn with a timeout. Source:
  `apps/cli/src/lib/platform/process.ts` (`captureProcessStartTime`).

- **A session's recorded working directory is no longer rebased onto the local drive.**
  `normalizeCwd()` ran `path.resolve()` over a cwd read out of a transcript, which may name
  a directory on another machine. On Windows that grafted the current drive onto a POSIX
  path (`/Users/me` became `D:\Users\me`), inventing a location that never existed. A
  foreign path is now normalized with POSIX rules and never realpath'd; local paths still
  normalize and resolve symlinks as before. Source:
  `apps/cli/src/lib/session/discover.ts` (`normalizeCwd`).

- **`agents cloud`'s task database can now be closed.** `cloud/store.ts` opened `tasks.db`
  and exported no closer, so nothing could release the handle — on Windows that leaves the
  file un-unlinkable. Adds `closeStore()`, the mirror of `closeDB()` in `session/db.ts`.
  Source: `apps/cli/src/lib/cloud/store.ts` (`closeStore`).

- **Collapse indistinguishable worker processes into one active-session row.** A daemon
  that spawns many agent binaries (an OpenClaw gateway running `codex app-server`) produced
  one `sessions --active` row per process, because a row with no session id and no
  transcript file skipped dedupe entirely — the Factory Floor showed ~40 identical
  `.openclaw · bg · 0s ago` rows that buried every real session. Dedupe now falls back to
  the cloud/run handle and then to the worker's identity (agent binary + context + working
  directory), so N indistinguishable workers become one row carrying `pidCount: N`.
  Source: `apps/cli/src/lib/session/active.ts`.

- **`sessions --active` now stamps a start and last-activity time on every
  interactive session.** Terminal, tmux, and headless agents discovered by the
  process scan carried no `startedAtMs` — so the Factory Floor rendered every
  running agent as "0s ago" even when its transcript, topic, and progress had
  resolved. The scan now stamps `startedAtMs` (the SessionStart hook's own
  timestamp, else the transcript's creation time) and a new `lastActivityMs` (the
  transcript's last-write) on each row, and the Floor renders "Xs ago" off the
  real last-activity instead of the session's age. Source:
  `apps/cli/src/lib/session/active.ts`, `apps/cli/src/lib/session/hook-sessions.ts`.

- **`agents sessions` now classifies Grok transcripts into real events, not a
  one-line stub.** Grok sessions were indexed (title, timestamps, message count)
  but opening one showed a single placeholder `session_start` event — `parseGrok`
  was a stub. It now reads the session's `chat_history.jsonl` and normalizes every
  line into the shared `SessionEvent` shape: `user`/`assistant` messages,
  `reasoning` → thinking, `assistant.tool_calls[]` → tool_use (with `path` and
  `command` surfaced), and `tool_result` correlated back to its call by
  `tool_call_id` (an `Error:`-prefixed result becomes an error event). The scanner
  records `summary.json` as the session path, so the parser resolves
  `chat_history.jsonl` beside it; per-line timestamps aren't stored, so each event
  carries the session's `created_at` (falling back to the transcript mtime).
  Verified end-to-end against a real Grok session (30 events: messages + thinking +
  tool_use + tool_result). Source: `apps/cli/src/lib/session/parse.ts`.

- **`agents harness` — name a (host CLI + model) combo and run it like a native agent
  type.** `agents harness add spark --host opencode --model meta/muse-spark-1.1` writes
  `~/.agents/profiles/spark.yml`, and `agents run spark` then dispatches OpenCode pinned to
  that model; `--model` at run time still overrides it. A harness is a profile under the
  hood (same YAML, same run resolution, same `agents repo push user` device sync), so
  `agents profiles` is unchanged; `harness` adds the host+model one-shot (no preset
  required), owns its own `--host` (never remote-routed, unlike `profiles --host`), and
  `agents harness list` shows custom harnesses, addable presets, and the native harness
  registry in one view. The model lands on the host's model env var
  (`OPENCODE_MODEL`/`ANTHROPIC_MODEL`/`GROK_MODEL`/`GEMINI_MODEL`). Source:
  `apps/cli/src/commands/harness.ts`, `apps/cli/src/lib/profiles.ts`,
  `apps/cli/src/lib/hosts/passthrough.ts`.
- **Fixed the Spark presets, which never ran.** `claude-spark`, `opencode-spark`, and the
  `opencode` preset help all named `meta/claude-spark-1.1` — a model neither OpenRouter nor
  OpenCode serves; the live id is `meta/muse-spark-1.1`. Separately, an `authOptional`
  preset (opencode) still wrote a keychain `auth` block that `resolveProfileEnv` always
  read, so `agents run opencode-spark` died with "Keychain item not found" even though
  OpenCode uses its own login. `resolveProfileEnv` now skips optional auth when no token is
  stored, so those presets run on the host's own credentials. Source:
  `apps/cli/src/lib/profiles-presets.ts`, `apps/cli/src/lib/profiles.ts`.

- **`agents sessions` now heals any pre-existing empty-`shortId` rows on upgrade.**
  The prior fix stopped *producing* empty shortIds (bare-prefix ids like a `session_`
  directory stripped to `''`), but a row already poisoned in the index did not
  self-heal — an empty shortId is not re-parsed unless its transcript changes, and an
  orphaned row whose file is gone never re-parses at all, so it stayed unaddressable in
  the `short_id LIKE ?` picker lookups. A one-time schema migration (v16) repairs every
  such row in place (`short_id = substr(id, 1, 8)`), so upgrading users get a clean
  index without a full rescan. Source: `apps/cli/src/lib/session/db.ts`.

- **Host and cloud runs are now mappable in `agents sessions` for every agent, not
  just Claude.** A `--host` dispatch forced a session id only for Claude (the sole
  agent that accepts `--session-id`); every other agent's remote run coined its own
  id that the launcher never learned, so the run was orphaned in `agents sessions`
  and couldn't be resumed by id. The remote run now prints its resolved session id
  as a one-line stdout sentinel (via a new internal `--emit-session-id` flag the
  dispatch forwards); the launcher parses it out of the followed log and stamps it
  on the host task, so `agents sessions`/resume-by-id work for Codex, Gemini, and
  the rest. Source: `apps/cli/src/lib/hosts/session-marker.ts`,
  `apps/cli/src/lib/hosts/session-index.ts`, `apps/cli/src/lib/hosts/run-target.ts`,
  `apps/cli/src/lib/exec.ts`.

- **`agents cloud run` reconciles into the session index at dispatch.** The cloud
  task store (`tasks.db`) and the session index were disjoint: a cloud run wrote only
  the store, and `agents sessions` learned of it only later, via a proxy discovery.
  Now every cloud dispatch (and every status poll) registers a session row keyed by
  the real execution id with a `[cloud/<status>]` label, so a launch is mappable to a
  session immediately. Source: `apps/cli/src/lib/cloud/session-index.ts`,
  `apps/cli/src/lib/cloud/store.ts`.

- **Codex Cloud dispatch no longer fabricates a task id.** When `codex cloud exec`
  didn't print a parseable id, the provider minted a synthetic `codex-<timestamp>` —
  an id that could never match the real execution, silently breaking status, list,
  and session reconcile. It now also scans stderr for the id and, on a genuine miss,
  fails loud pointing at `agents cloud list` rather than persisting a bogus id.
  Source: `apps/cli/src/lib/cloud/codex.ts`.

- **`agents import <agent> --as <version>` — the version flag now actually works.** The
  option was declared as `--version <version>`, which the program-level `.version(VERSION)`
  claims globally: `agents import codex --version 1.2.3` printed the CLI's own version and
  exited without importing. It had been unreachable since it was introduced, and the
  "could not determine version" error advised passing it. Renamed to `--as`, which reaches
  the command. This also makes `agents import <agent> --isolated --as <version>` re-seed an
  *existing* isolated copy from your current local config, instead of only ever creating a
  new copy at whatever version happens to be installed locally.
- **Fixed a silent no-op in config copying under the compiled binary.** `fs.cpSync` defaults
  to `force: true`, but Bun drops that default when a `filter` is supplied — so copies that
  strip symlinks left existing destination files untouched. `dist/bin/agents` is
  bun-compiled, so this affected a shipped path, not just tests. Now passed explicitly in
  `config-transfer.ts` and `import.ts`.

- **`agents import --isolated` no longer misdescribes itself, chokes on codex, or copies
  your session history.** Three defects found by using it: (1) the confirmation summary
  printed `config: ~/.codex (will be moved into version home)` even under `--isolated` —
  announcing the exact adoption the flag exists to prevent, though the code correctly
  copied; it now reads `will be COPIED — your original stays put`. (2) Seeding failed
  outright for codex with `Cannot overwrite non-directory`, because its version home is a
  SUN_LEN-safe symlink to `~/.agents/.codex-homes/<version>/.codex` rather than a real
  directory; the seeder now follows the link and writes the home the agent actually reads.
  (3) The seed copied the whole config dir including sessions, logs, caches and sqlite —
  757MB on a real machine, 349MB of it `sessions` — so runtime state is now skipped and
  reported (33MB for the same install), with `--all` to include it. Also skips the config
  copy when `~/.<agent>` is itself a managed symlink, which is another version's home
  rather than the user's real settings. Source: `apps/cli/src/lib/import.ts`,
  `apps/cli/src/commands/import.ts`.

- **Incremental Claude transcript parsing on the live scan path.** When an active
  Claude session grows, `agents sessions` (and every consumer that scans:
  `output` / `view` / `teams` / the watcher) now re-parses only the newly-appended
  bytes instead of re-reading the whole transcript from the top. The scan persists
  a resumable continuation (`parser_state` + `content_text`, schema v15) in the
  `scan_ledger`; the next scan resumes from the saved byte offset when the file
  merely grew and its mtime did not go backwards, and falls back to a full reparse
  from byte 0 on a cold start, a truncation / rewrite (size shrank), or a clock
  rewind. Both paths run through one shared reducer, so the indexed row an append
  produces is identical, field for field, to a from-scratch full reparse — token
  counts, cost, duration, topic/title, PR + ticket refs, and FTS content all match
  even when a signal straddles two scans (a `gh pr create` in one write and its URL
  in the next). Only the Claude scanner is wired for now (Codex / Kimi are
  follow-ups); the other scanners are unchanged. Source:
  `apps/cli/src/lib/session/discover.ts`, `apps/cli/src/lib/session/db.ts`.

- **Incremental Codex + Kimi transcript parsing on the live scan path.** Following
  the Claude incremental parse, the Codex rollout scanner and the Kimi wire.jsonl
  scanner now re-parse only the newly-appended bytes when an active session grows,
  instead of re-reading the whole file from the top every scan (`agents sessions`
  and every consumer that scans: `output` / `view` / `teams` / the watcher). Each
  persists a resumable continuation in the `scan_ledger` (`parser_state`, reusing
  the schema v15 columns): the next scan resumes from the saved byte offset when
  the file merely grew and its mtime did not go backwards, and falls back to a full
  reparse from byte 0 on a cold start, a truncation / rewrite (size shrank), or a
  clock rewind. Both branches run through one shared reducer per scanner, so the
  indexed row an append produces is identical, field for field, to a from-scratch
  full reparse. For Codex that covers messageCount, the last-wins cumulative token
  snapshot (tokenCount / outputTokens / cost), duration, topic, and PR + ticket +
  team signals that straddle two scans (a `gh pr create` function_call in one write
  and its URL in the next). For Kimi it covers the additive message + token
  counters. Both incremental paths apply only newline-terminated lines and defer a
  complete-but-unterminated trailing record to the next pass, so a record written
  before its `'\n'` is flushed is never double-counted. Grok is out of scope (it
  reads a whole `summary.json`, not an append-only JSONL); Claude / Gemini and the
  shared helpers are unchanged. Source: `apps/cli/src/lib/session/discover.ts`.

- **Isolated installs now resume sessions and resolve `@default` like any other install.**
  Two places still assumed a managed version is reachable on PATH — which an isolated
  install deliberately is not. (1) `agents sessions` resume looked up
  `<cli>@<version>` with a plain PATH lookup, never found it (the shims dir is
  intentionally off PATH under `--isolated`), concluded the version was uninstalled, and
  fell back to spawning `<cli> "/continue <id>"` — a slash command neither CLI has, so
  the session simply never resumed. It now resolves the versioned alias by absolute path,
  the way `agents run` already did, and the fallback is the agent's real resume verb
  against the current version rather than `/continue`. (2) The agent-spec resolver behind
  `--agents` / `@default` / `@pinned` read only the global default, so an isolated-only
  agent threw "No default version set" even after an explicit `agents use` —
  `resolveVersion` had gained the isolated-default fallback but this resolver had not.
  Both now consult it, and report `isolated-default` as the source rather than claiming a
  global default. `opencode` resume stays deliberately un-pinned, since its sessions are
  shared across versions. Source: `apps/cli/src/commands/sessions.ts`,
  `apps/cli/src/lib/agent-spec/`.

- **Menu bar: prune orphan attention sentinels; group `NEEDS YOU`; end silent
  truncation.** `LocalState.attentionMarks` now takes the caller's live-session
  set and unlinks sentinels whose `sessionId` is not alive — the
  `06-attention-sentinel.sh` hook already clears on `Stop`/`UserPromptSubmit`,
  but leaks when a terminal is killed hard, a Claude version has no hook, or the
  `sessionId` doesn't round-trip; the reader is the only layer with `pidAlive`
  ground truth. Verified on mac-mini: 6 stale sentinels aged 1–22 days pruned to
  0 on one dump run. `addNeedsAttention` groups blocked sessions by
  `(agent, repo)` and collapses groups of 2+ into a single
  `<Agent> · <repo> · N waiting · oldest <t> ›` row + submenu, dropping the
  generic `— Claude is waiting for your input` filler when the Notification
  message is empty. `addActive` collapses the `"other"` bucket to a single
  clickable `ACTIVE · other · N idle ›` row when idle-only, and replaces the
  silent 3-cap on idle rows with an explicit `+ N more idle ›` row + submenu so
  the header count always matches visible + explicit-hidden. No new session
  state — closed = hidden, as before.

- **The menu-bar helper no longer crash-loops on macOS 26.** npm's pack/extract
  strips the ad-hoc signature the release bakes into `MenubarHelper.app`, leaving
  it `code object is not signed at all`. macOS 26's code-signing monitor SIGKILLs
  an unsigned binary at launch (`SIGKILL (Code Signature Invalid)`), so under the
  launchd `KeepAlive` service it restarted forever, and its unstable identity made
  the Accessibility grant (needed for the clip→paste keystroke in `Clip.swift`)
  re-prompt every time. The install path now re-signs the copied bundle ad-hoc and
  verifies it before bootstrapping the service, so every machine gets a valid
  signature the kernel accepts — and a bundle that can't be made valid is skipped
  instead of spun in a crash loop. A Developer-ID-signed helper (which survives
  npm) is left untouched. Source: `apps/cli/src/lib/menubar/install-menubar.ts`,
  `apps/cli/menubar/scripts/build.sh`.

- **The configured model now shows wherever an agent is displayed.** `agents
  view`, `use`, `add`, `status`, and `inspect` surface the model an agent+version
  actually runs with, beside the version (the identity cluster reads `agent ·
  version · model · account`). The model is resolved agents.yaml `run.defaults` →
  the native `settings.json` → the built-in default, and `agents view --json`
  gains a `configuredModel { model, source }` field so downstream tools can read
  both the value and where it came from. Source: `apps/cli/src/lib/models.ts`,
  `apps/cli/src/commands/view.ts`.

- **`agents repo pull` now reloads the routines daemon so device pins refresh.**
  The scheduler froze each routine's config — device pins included — in memory at
  daemon start. A `repo pull` rewrites the synced routine YAML on disk (a routine
  re-pinned to another host, say), but without a reload the daemon kept firing the
  pre-pull pins, so a routine moved to another device still fired on the old host
  too — a phantom double-fire across the fleet. A successful pull now SIGHUPs the
  running daemon (`scheduler.reloadAll()`), re-reading the YAML so pins refresh. A
  no-op when the daemon isn't running or on Windows (no SIGHUP). Source:
  `apps/cli/src/commands/repo.ts`.

- **Routines can pin a Claude account by identity to stop the OAuth-rotation
  logout storm.** Unpinned `claude` routines pick an account with the default
  `balanced` (stateless weighted-random) strategy, so two concurrent unattended
  runs — on one box or across the fleet — can land on the same account; Claude's
  refresh token is single-use and rotates server-side, so the second refresh
  revokes the first run's token mid-flight (`401 OAuth access token has been
  revoked`). Across ~20 routines waking in one morning window that is a
  self-inflicted logout storm (RUSH-1957). A routine may now set `account:` (a
  login email or account key) to pin the run to the version slot holding that
  account — no rotation, no usage-read refresh, no failover onto other accounts —
  so each routine (or each device's routines) refreshes one credential nobody else
  touches. Prefer it over `version:`, which pins a version *number* that is GC'd on
  the next upgrade, silently dropping the routine back to `balanced`. An account
  that is not signed in on the box warns and falls back to the strategy rather than
  refusing to run. Source: `apps/cli/src/lib/routines.ts`,
  `apps/cli/src/lib/rotate.ts`, `apps/cli/src/lib/runner.ts`.

- **Balanced account rotation now works for scheduled Claude routines.** The
  routines daemon injects one `CLAUDE_CODE_OAUTH_TOKEN` into its environment so a
  token-less default account still authenticates (RUSH-1759). But Claude — and the
  Linux shim's own `-z CLAUDE_CODE_OAUTH_TOKEN` guard — both prefer that env var
  over a pinned account's `CLAUDE_CONFIG_DIR`, so once balanced rotation pinned a
  specific account the injected token shadowed it: the whole pool was inert and
  every fire authenticated as (and eventually 401'd on) the one token. A routine
  spawn now drops the injected token when the rotated account holds its own on-disk
  credential, so it authenticates as that account; when the account has no on-disk
  credential (the RUSH-1759 default) the injected token is kept. Source:
  `apps/cli/src/lib/runner.ts` (`buildRoutineSpawnEnv`),
  `apps/cli/src/lib/agents.ts` (`claudeHomeHasOwnCredential`).

- **No more Touch ID prompt on every new agent session.** Bundle metadata (names,
  descriptions, variable names + references, and non-sensitive `--value` literals)
  is now stored WITHOUT the biometry ACL at every prompt-policy tier, not just
  `never`. Metadata is non-sensitive by contract — real secret values live in
  separate `agents-cli.secrets.*` items that keep the bundle's policy ACL — so
  enumerating bundles no longer needs a keychain unlock. This kills the recurring
  Touch ID prompt that fired on every new Claude/agent terminal: a SessionStart
  hook runs `agents devices list`, which scans bundle metadata through crabbox, and
  that scan used to pop Touch ID once per broker window (~7 days) on every cold
  launch. `agents secrets list` is now silent too. Reading a bundle's actual
  values (run injection, `view --reveal`) still prompts. Existing bundles are
  migrated automatically and once: the first metadata scan after upgrade re-homes
  each bundle's metadata item no-ACL (reusing the read it already did, so it adds
  no extra prompt), and every scan after that is prompt-free. Source:
  `apps/cli/src/lib/secrets/bundles.ts`, `apps/cli/src/lib/secrets/index.ts`.

- **Wire workflows support for Grok (RUSH-1863).** Grok Build ships native Workflows as of v0.2.111 (on by default): file-defined Rhai orchestration scripts in `~/.grok/workflows/<name>.rhai` (user-global, under `GROK_HOME`) and `.grok/workflows/` (repo-level). agents-cli now declares `workflows: { since: 0.2.111 }` for grok, projects central `WORKFLOW.md` bundles into managed Rhai scripts via `transformWorkflowForGrok` (with an `// agents_workflow: <name>` marker so user-authored scripts are never overwritten), and registers the writer + detector so `agents workflows add --agents grok@…` / sync land files Grok can invoke as `/<name>`. Distinct from the grok *commands* gap (RUSH-1851). Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/workflows.ts`, `apps/cli/src/lib/staleness/{writers,detectors}/workflows.ts`, `apps/cli/src/lib/versions.ts`.

- **Dispatch-bar screenshots now upload via `linear create --image` instead of
  landing as dead local paths.** The menu-bar helper previously injected
  screenshot paths into the ticket-agent prompt, and the model echoed them into
  the issue description as `/Users/…` text. The agent now returns ticket fields
  as JSON, and the helper itself runs `linear create` with `--image <path>` for
  each selected screenshot, so paths pass through Swift argv and survive spaces
  or `@` in CleanShot filenames. Coordinates with the `linear create --image`
  support added in `phnx-labs/linear-cli#28`. Source:
  `apps/cli/menubar/Sources/MenubarHelper/AgentsCLI.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/IssueSelfTest.swift`.

- **Native helper bundles now ship the agents-cli icon and the computer helper is
  branded "Agents Computer".** MenubarHelper.app, ComputerHelper.app, and the
  keychain `Agents CLI.app` previously had no `CFBundleIconFile`/`.icns`, so
  Notification Center and System Settings → Privacy & Security showed a blank
  square. Each build script now generates `AppIcon.icns` from `assets/logo.png`
  and adds `CFBundleIconFile` to the bundle `Info.plist`. The computer helper
  display name changed from "Computer Helper" to "Agents Computer" while keeping
  its bundle id and on-disk path, so existing Accessibility/Screen Recording
  grants remain valid. Source: `apps/cli/menubar/scripts/build.sh`,
  `native/computer-mac/scripts/build.sh`, `apps/cli/scripts/build-keychain-helper.sh`,
  `apps/cli/src/commands/setup-computer.ts`, `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`.

- **One resolver for `--host` / `--device` — every subcommand now dials the same box
  (RUSH-1967).** A host token used to resolve through two disagreeing code paths:
  `run --host` (and the generic passthrough, teams placement, doctor, funnel, remote
  secrets) let a `~/.ssh/config` stanza win and dialed its bare name, while
  `sessions --host`, session bundles, and `agents ssh` dialed the device Tailscale
  `user@dnsName`. The same name could reach two different machines, and because the two
  emitted different target strings they never shared a multiplexed SSH connection.
  Resolution is now a single merged lookup (`matchHost`): the live devices registry
  supplies address/OS/presence, the agents.yaml overlay supplies capability tags, and
  ssh_config supplies hosts Tailscale has never seen — merged per-field, not one
  shadowing another. Fallout fixed with it: an enrolled device address always comes from
  the live registry (so `agents devices sync` takes effect without re-enrolling, no more
  frozen route), an enrolled device keeps its presence and `dispatchable` flags, a
  password-auth device cannot be made dispatchable by shadowing it with an inline entry,
  and a host present only in `~/.ssh/config` is now visible to the `sessions --host`
  fan-out.

- **`agents run --device`/`--host` now auto-reconnects when the network drops.** A
  remote interactive agent runs in a detached tmux session on the peer, so an SSH
  blink kills only the local client — the agent keeps running. Previously the local
  side exited with ssh's connection-layer code (255) and you had to notice, find the
  session id, and `agents sessions focus` by hand. Now, when a tmux-hosted run with a
  known session id drops (exit 255), the client re-attaches the live remote pane
  automatically over SSH — reusing the peer's own `agents sessions focus <id> --local
  --attach-only` (a live join, not a resumed copy) — with bounded exponential backoff
  (2s→30s, up to 6 attempts, and the budget refills after a genuinely live
  reconnection). A clean detach (Ctrl-b d, exit 0) or a real agent exit (any non-255
  code) is left alone; `--raw`/no-tmux runs, which don't survive a drop, are not
  retried. This covers Claude and resumed runs today; capturing a resumable id for
  other agents on the `--device` path is tracked in RUSH-2007. Source:
  `apps/cli/src/lib/hosts/reconnect.ts`, `apps/cli/src/commands/exec.ts`.

- **The secrets broker cache now actually works on the shipped macOS binary — one Touch ID per bundle per hold window, not one per read.** The three synchronous broker clients (`agentGetSync`, `agentReachableSync`, `agentEvictSync`) spawned `process.execPath -e <inline node program>`, which is only correct when `process.execPath` is node. Since 1.20.53 the macOS `agents` is a bun-compiled Mach-O, so `process.execPath` is the CLI itself and the spawn became `agents -e …` — rejected with `error: unknown option '-e'` and a non-zero exit. Each client then took its own failure path (`null` / `false` / no-op), which the caller reads as "broker down" and falls through to a real keychain read. Net effect: on every standalone install the hot cache was never hit, so the `daily` policy's one-prompt-per-7d never applied and **every bundle read re-popped Touch ID** — `agents secrets status` would report the broker running while holding nothing but explicitly `unlock`ed bundles (the durable session-store path, the only client that never spawned). Same defect class as the broker launch fixed in 1.20.56 and the PTY sidecar in 1.20.72; these three sites were simply never converted. They now spawn top-level `__secrets-get` / `__secrets-ping` / `__secrets-lock` tokens built by the shared `getCliLaunch` primitive and intercepted in `index.ts` before commander — alongside `__daemon-run` and `__vault-age-helper`, and deliberately above the line where every normal command runs `checkForUpdates()` and forks a detached background sync, which would otherwise fire on every cache hit. Source: `apps/cli/src/lib/secrets/agent.ts`, `apps/cli/src/index.ts`.

- **Let a bundle whose passphrase is lost be deleted, so the name can be recovered.**
  A file-backed bundle that no longer decrypts bricked its own name: `view`, `add`,
  `delete`, and both `import --from icloud` and `import --from 1password` all called
  `readBundle()` first, so none of them could touch it — including the two commands that
  exist to restore it from a valid iCloud Keychain or 1Password copy. `delete` now uses
  the new `readBundleIfDecryptable()` and proceeds without the plaintext, reporting that
  the bundle's keychain items cannot be enumerated for purging instead of claiming a
  clean purge. The `view` hint no longer points at `import --from icloud` for a bundle
  that is still on disk — that command fails identically — and names the delete-then-import
  sequence that actually works. Only a genuine decrypt failure counts as deletable: a
  bundle that is merely locked for the run (headless macOS with no
  `AGENTS_SECRETS_PASSPHRASE`) still fails loudly and is left in place, so
  `secrets delete <name> --yes` from a cron/launchd run that forgot to export the
  passphrase can't silently destroy a healthy bundle. Source:
  `apps/cli/src/lib/secrets/bundles.ts`, `apps/cli/src/commands/secrets.ts`.

- **Session tab titles no longer go missing or stale.** A rescan that carried an
  empty or whitespace-only label used to clobber a good stored label, because
  `upsertSession`/`upsertSessionsBatch` wrote `label = excluded.label`
  unconditionally on conflict. The `ON CONFLICT` clause now preserves an existing
  non-empty label and only overwrites when a real label arrives, so a `/rename`,
  agent-generated title, or `--name` handle survives later rescans. Headless runs
  launched with `--name` now also surface that name as the session label (matching
  the terminal path) instead of showing only the topic. Source:
  `apps/cli/src/lib/session/db.ts`, `apps/cli/src/lib/session/active.ts`.

- **`agents sessions --active` no longer shows zombie sessions from recycled pids.**
  Liveness was a bare `process.kill(pid, 0)` existence check, so once the OS handed a
  dead session's pid to an unrelated process, that session kept showing as alive — and
  the registry GC never pruned it. `isPidAlive` now takes the session's recorded
  `startedAtMs` and, when a start time is available, verifies the process at that pid did
  not begin meaningfully after the session started (a 60s window): a process that started
  later is a reused pid, so the session is dead. The start time is read once via
  `ps -o lstart=` (macOS + Linux); Windows and any unreadable start time fall back to the
  existence check, never worse than before. Applied to every registry-backed liveness
  path — the live-terminals filter, the terminal listing, the tmux-pane resolver, and the
  pid-registry prune. Source: `apps/cli/src/lib/session/active.ts`.

- **`agents sessions` no longer corrupts the index with empty `shortId` rows.**
  Session ids that are only a known prefix — a bare `session_` Rush directory, an
  id of exactly `api-` (Hermes) or `ses_` (OpenCode) — used to strip to `''`
  (`'session_'.replace(/^session_/, '').slice(0, 8) === ''`). An empty `shortId`
  passes the `short_id TEXT NOT NULL` constraint (empty string is not NULL) yet
  matches nothing in the `short_id LIKE ?` picker lookups, so the row was silently
  unaddressable. All shortId derivation is now routed through one helper,
  `deriveShortId`, that guarantees a non-empty result by falling back to the
  unstripped id when the strip empties it. Every producer — the twelve parsers in
  `discover.ts`, `session/cloud.ts`, `cloud/session-index.ts`, `hosts/session-index.ts`,
  `session/fork.ts`, and `commands/go.ts` — uses it, replacing the duplicated inline
  `.slice(0, 8)` (some with a `.replace(prefix, '')`). Source:
  `apps/cli/src/lib/session/short-id.ts`.

- **Honest live status: report `unknown` instead of a fake `idle` (RUSH-1976).** `agents
  sessions --active` now reports an explicit `unknown` status (`◌`) for a live agent whose
  activity it cannot introspect — a running gemini/droid/cursor/opencode whose transcript
  format is not parsed — instead of the misleading `idle` it showed before. Status resolution
  is standardized in one place (`resolveFallbackStatus`): a vanished transcript file no longer
  flips to a false `running`, an unanswered prose question with no mtime signal no longer
  sticks as "waiting on you" forever (the RUSH-1522 null-mtime hole), and the `ps`/`lsof`
  probes behind the scan now have hard timeouts so a hung syscall can't silently drop live
  sessions. Source: `apps/cli/src/lib/session/active.ts` (`resolveFallbackStatus`),
  `apps/cli/src/lib/session/state.ts`, `apps/cli/src/commands/sessions.ts`.

- **Interactive session browser: preview-by-default with clickable ticket + PR
  links.** In `agents sessions` / `agents sessions --active`, the highlighted
  row's preview is now open by default (`tab` toggles it off), and the preview's
  links line renders the ticket and PR as OSC 8 terminal hyperlinks — the ticket
  resolves to its Linear URL (workspace slug resolved config-first) and `PR#`
  resolves to its GitHub URL — so they are click-through in terminals that support
  them. Source: `apps/cli/src/lib/picker.ts`,
  `apps/cli/src/commands/sessions-browser.ts`,
  `apps/cli/src/lib/session/render.ts`.

- **`agents sessions` now lists what agents-cli manages, not your own installs.** Discovery
  scans the union of your real `~/.<agent>` and every managed version home, so once you had
  managed versions the listing mixed both — most visibly after `agents add --isolated`, where
  keeping the two apart was the whole point. Listing is now scoped to managed versions
  (isolated or not); `--unmanaged` brings your own installs back, and every render path prints
  what it hid (`N sessions from your own unmanaged installs hidden`) so nothing disappears
  silently. A user who has never run `agents add` sees exactly what they saw before — with
  nothing managed there is nothing to scope to. Scoping happens at query time rather than by
  narrowing the scan, so the index stays complete, `--unmanaged` needs no re-scan, and
  watchdog / `--roots` / the Factory watcher are unaffected. Source:
  `apps/cli/src/lib/session/discover.ts`, `apps/cli/src/commands/sessions.ts`.

- **Attribute split-spawned agents on the authoritative tmux source (RUSH-1976).** `agents
  sessions --active` now attributes each tmux pane to the agent actually running in it: an
  agent bare-spawned into a split of an existing shared-socket session (where `$TMUX` is
  already set, so no new session meta is stamped) is surfaced by the authoritative tmux
  source with its own exact identity and pane, instead of being dropped there and left to the
  weaker `ps`-scan fallback. Attribution reads the per-pane launch registry (the id recorded
  at launch, or the SessionStart-hook join by launchId for a non-Claude agent), gated on the
  pid still being alive so a dead agent's pane can't linger. Source:
  `apps/cli/src/lib/session/active.ts` (`resolvePaneIdentity`, `listTmuxAgentSessions`),
  `apps/cli/src/lib/session/pid-registry.ts` (`listPidSessionEntries`).

- **Watchdog v2 — the always-on watchdog now has judgment and delivers correctly
  into VS Codium.** The 2-minute `agents watchdog --nudge` routine no longer
  hard-skips a session that stopped to ask a question. The deterministic pass is
  now a cheap pre-filter (clearly-complete → skip, clear promise-without-toolcall →
  nudge) that ESCALATES the judgment-heavy cases — a session parked on a question,
  or an ambiguous stall — to a smart brain. The brain drives the agent to finish
  end-to-end when it asked a needless / already-authorized question or paused with
  work left, and leaves it for the human only for genuine cases (credentials/auth,
  an irreversible or outward-facing action, a real ambiguous product decision, or a
  finished task). Nudge messages restate the goal, tell the agent to use best
  judgment, and give one concrete next step. The brain is a customizable
  `watchdog` workflow: drop a `watchdog` WORKFLOW.md in your project or user
  `workflows/` to override the prompt and pick the `model:`; absent one, the
  improved built-in prompt runs via `agents run … --mode plan`. Source:
  `apps/cli/src/lib/watchdog/watchdog.ts`, `apps/cli/src/lib/watchdog/runner.ts`.
- **Watchdog delivery routes through the answer-router with the VS Codium rail
  working.** A running agent is steered via its mailbox; a parked-on-question agent
  is answered into its EXACT split — including a VS Codium / Cursor / VS Code
  integrated terminal, which the answer-router's own resolver could not address —
  or, when headless, re-entered via resume; a parked agent with no addressable rail
  is flagged, never a guessed target.
- **Watchdog precedence + concurrency fixes.** A long-idle (>15m) open question is
  no longer blindly force-nudged — waiting-on-user and completion now win over the
  15-minute force-review short-circuit. The per-session cooldown ledger is written
  under a file lock (fresh-read + merge + atomic write), closing a lost-update race
  between concurrent ticks.
- **Watchdog decisions are logged to `~/.agents/.cache/logs/watchdog.log`** in the
  JSONL shape the Factory Floor watchdog card reads, so it keeps working after the
  extension-side watchdog is retired.

- **The always-on watchdog is now a daemon-fired routine, not a hand-rolled loop + sentinel.**
  `agents watchdog enable` used to flip a private `~/.agents/.cache/state/watchdog/enabled`
  sentinel that only meant anything to a manually-launched `agents watchdog --watch` loop —
  so the auto-nudge only ran while some shell was babysitting it. It now creates and enables a
  plain `watchdog` command routine (`agents watchdog --nudge`, every 2 minutes) and reloads
  the daemon, so the always-on watchdog is fired by the same scheduler that runs every other
  routine: it survives reboots, catches up if the daemon was down, and shows up in
  `agents routines list`. `disable` pauses that routine; `status` reports whether it is
  enabled. The Swift menu-bar toggle and `watchdog status --json` are unchanged. Bare
  `agents watchdog` (dry) and `agents watchdog --watch` (now dry unless `--nudge`) still work
  for ad-hoc runs. If you had already opted in under the old build, a one-shot migration
  folds that state forward — you stay enabled, now as the routine. Source:
  `apps/cli/src/lib/watchdog/routine.ts`, `apps/cli/src/commands/watchdog.ts`,
  `apps/cli/src/lib/migrate.ts`.

- **Wire hooks support for OpenCode through generated plugins (RUSH-1850).** `hooks.yaml` entries now compile into `~/.config/opencode/plugins/agents-cli-hooks.ts`, mapping tool, prompt, and session lifecycle events to OpenCode's native plugin API and executing managed scripts with Bun's `$` shell primitive. OpenCode hooks are capability-gated to v0.3.130 and newer.

## 1.20.74

- **`agents apply --agent claude@all --device <box>` — replicate this machine's
  exact version set.** The fleet roster is agent-granular, so a fresh box only ever
  got one `claude@latest` — losing a multi-version setup (e.g. several claude
  versions, one per Max account, to spread rate-limit quota). The new `--agent
  <specs...>` flag overrides the roster for the targeted device(s): `claude@all`
  expands source-side to every version installed here (`claude@2.1.170`,
  `claude@2.1.207`, …) and installs each missing one on the target; a pinned
  `claude@2.1.207` installs that exact version even if another claude is present.
  Version-pinned specs diff against a per-device `agents view --json` probe, so the
  plan installs only what's missing and login still propagates once per agent.
  Source: `apps/cli/src/commands/apply.ts`, `apps/cli/src/lib/fleet/apply.ts`.

- **Project resource manifests are now portable across Windows and POSIX.** The
  managed-resource manifest `.agents-managed.json` recorded its paths with the
  host's native separator, so a sync run on Windows wrote entries like
  `skills\myskill`. That file lives in the version-controlled project `.agents`
  dir and travels between machines, and the cleanup pass matches manifest entries
  with `path.sep` — so a manifest written on Windows silently failed to match on
  macOS or Linux and left previously managed files behind on the next sync (and
  vice versa). Manifest paths are now normalized to POSIX separators on write and
  on read, which also repairs manifests written by earlier Windows builds. Source:
  `apps/cli/src/lib/project-resources.ts`.

- **`agents import <agent> --isolated` — bring your existing setup into a sandbox.**
  Isolation was a cold start: a new isolated copy began empty, and the only way to get
  settings into it was by hand. A plain `agents import` is the opposite of what is
  wanted here — it *adopts*, moving `~/.<agent>` into a version home, symlinking the
  original away, setting the global default and creating a shim (and is now refused
  outright for an isolated-only agent). `--isolated` copies instead: your settings land
  in the isolated home, your real config stays exactly where it is, and the version is
  finalized the way `agents add --isolated` does — versioned alias and marker, no
  default, no bare shim, no config symlink. Credentials are skipped by default and
  named in the output rather than silently included, since an isolated copy signs in as
  its own principal; `--with-auth` opts in. Symlinks into `~/.agents` are dropped so the
  copy does not depend on the CLI's tree. Source: `apps/cli/src/lib/import.ts`,
  `apps/cli/src/commands/import.ts`.

- **`agents use <agent>@<isolated>` now works, and a bare `agents run <agent>` reaches
  your isolated copy.** Isolated installs were unreachable by name: `resolveVersion`
  ended at the global default, and an isolated install deliberately never becomes one —
  so `agents use` refused, and an isolated-only user had to type the full
  `agents run codex@0.144.6` every time while a bare `agents run codex` fell through to
  whatever `codex` meant on PATH. `use` now records an **isolated default** instead of
  refusing, and resolution falls back to it (`project pin -> global default -> isolated
  default`). Strictly a fallback, so nothing changes for anyone who has a global
  default. The pointer lives in `isolatedAgents:` in `agents.yaml`, never in the global
  `agents:` map — that separation is what keeps `getGlobalDefault` incapable of
  returning an isolated version, and with it the launcher, bare shim, config symlink and
  self-heal `shadowing` check all stay out of reach. It is verified on read and
  re-pointed (or cleared) on removal, so it can never resolve to a version that is gone.
  `agents view` labels it `(isolated default)`. Source: `apps/cli/src/lib/versions.ts`,
  `apps/cli/src/commands/versions.ts`, `apps/cli/src/commands/view.ts`.

- **`agents export <agent>[@<version>]` — take an isolated install's config with you.**
  `--isolated` was a one-way door: it builds a self-contained home under the version
  dir and nothing ever brings that work back, so a user who configured a sandboxed copy
  for a week had to copy files by hand to promote it — or to leave. Export is additive
  by default: it copies only paths you don't already have, and a collision is **not**
  silently skipped — the incoming file is written beside yours as
  `<name>.from-agents-cli` so you can `--diff` it and take the parts you want. Your
  files are never modified. `--replace` promotes a sandbox wholesale (yours is moved to
  `backups/<agent>/<ts>`, and it is the only mode that asks for confirmation);
  `--staged` dumps the tree into `~/.<agent>/.agents-export-<ts>/` and activates
  nothing. Every mode strips symlinks pointing back into `~/.agents` so the result
  keeps working after agents-cli is gone, keeps your own symlinks, and writes a receipt
  to `~/.<agent>/.agents-cli-export.json` recording exactly what came from the export —
  which makes "which of these files are mine?" answerable and the whole thing
  reversible. A `~/.<agent>` that agents-cli already adopted is refused, since writing
  there would mutate that version's home rather than your config. File *contents* are
  never auto-merged: the TOML parser here drops comments across parse+stringify, so
  unioning keys would silently delete them. Source: `apps/cli/src/lib/export.ts`,
  `apps/cli/src/commands/export.ts`, `apps/cli/src/lib/config-transfer.ts`.

- **An isolated-only agent can no longer be adopted by anything.** `--isolated` used to
  be defined by what it *doesn't* do — no global default, no bare shim, no config
  symlink, no PATH edit — which meant every code path that could adopt an agent had to
  remember to check first. It leaked three times that way. Protection is now derived
  from the `.isolated` markers on disk (`isIsolationProtected`: at least one installed
  version, and every one isolated) and enforced inside the five primitives that can
  cross the boundary — `setGlobalDefault`, `createShim`, `switchConfigSymlink`,
  `switchHomeFileSymlinks`, `adoptShadowingLauncher` — so refusal is a property of the
  code rather than a convention. There is no mode to set and none to forget: installing
  with `--isolated` *is* the opt-in, it is per-agent, and the escape hatch is inherent
  (remove the isolated copies and the agent is ordinary again). `agents add`,
  `agents import` and `doctor --adopt` refuse with guidance rather than a stack trace —
  `import` is additionally checked at its entry point, because it registers the adopted
  install as a normal version *before* adopting, which would otherwise un-protect the
  agent underneath the primitive gate. Clearing a global default stays allowed, since
  removal legitimately clears one as an agent becomes isolated-only. A completeness test
  pins the primitive list and scans for any new ungated mutator. Source:
  `apps/cli/src/lib/shims.ts`, `apps/cli/src/lib/versions.ts`,
  `apps/cli/src/lib/isolation-boundary-report.ts`.

- **`agents view` no longer hides your own CLI behind an isolated install.** The listing
  was either/or per agent: any managed version at all suppressed the "Not Managed by
  Agents CLI" block, so a single `agents add <agent>@<v> --isolated` made the user's
  globally-installed CLI disappear from the one command they'd run to confirm
  `--isolated` had left it alone. Nothing on disk was ever touched — the isolation
  boundary holds — but the report read exactly like the damage it was supposed to rule
  out. Isolated copies now render alongside the global install and are tagged
  `9.9.4 (isolated)`; a normal (non-isolated) version still takes the launcher over and
  still suppresses the global row, since that row would just be our own shim. The global
  row is also resolved from PATH now (`getUnmanagedCliState`) instead of from the version
  dirs, which could otherwise report an isolated copy — deliberately unreachable from
  PATH — as `(global)`. Source: `apps/cli/src/commands/view.ts`, `apps/cli/src/lib/agents.ts`.

- **`agents sessions --active` now resolves the exact session id for non-Claude and
  user-typed agents.** Previously only Claude (launched with a known `--session-id`) got an
  exact id; every other agent fell back to "newest `.jsonl` in the cwd", which collapses
  co-located agents onto one row. `ag run` now mints a launch id and exports it as
  `AGENT_LAUNCH_ID` on every launch path (bare spawn, tmux, and the Windows shim); the
  agent's own SessionStart hook already records that id, so the active-scan reconciles a
  `ps`-discovered process to the hook's authoritative session id by `launchId` (robust even
  when the hook runs under a different pid — a tmux pane leaf or `cmd.exe` wrapper), falling
  back to `terminalId` and pid. This also attributes agents `ag run` never launched (you
  typing `claude` in a terminal). No on-disk directory moved — the CLI reads the existing
  hook state files read-only, so old installed hooks and a new CLI coexist safely. Source:
  `apps/cli/src/lib/exec.ts`, `apps/cli/src/lib/session/{pid-registry,hook-sessions,active}.ts`.

## 1.20.73

- **`agents cli install <binary-cli>` no longer hardcodes `/usr/local/bin` (#1103).**
  Binary-method installs downloaded (and extracted archives) straight into
  `/usr/local/bin`, which fails with `EACCES` on Apple Silicon Macs where that
  directory is root-owned and not user-writable. A new `resolveBinDir()` picks
  the install directory instead: honor `AGENTS_CLI_BIN_DIR` if set, else prefer
  `~/.local/bin` (created on demand — the same XDG user-bin dir shims already
  use), else fall back to `/usr/local/bin` with an actionable error pointing at
  `AGENTS_CLI_BIN_DIR` / `~/.local/bin` instead of a bare `EACCES`. Source:
  `apps/cli/src/lib/cli-resources.ts`, `apps/cli/src/lib/cli-resources.test.ts`.

- **Stream host follows over one persistent SSH connection (RUSH-1407).** `run --host` and `hosts logs -f` now follow remote logs with a long-lived `tail -f` stream that reconnects from the saved byte offset and captures the remote `.exit` code without per-cycle SSH spawns. Source: `apps/cli/src/lib/hosts/progress.ts`.

- **Reuse warm crabbox boxes from `agents run` (RUSH-1609).** `agents run <agent> "<task>" --box <slug>` now targets an existing warm crabbox box, runs the same bootstrap and credential provisioning as `--lease`, and leaves the box running for reuse across repositories. Source: `apps/cli/src/commands/exec.ts`, `apps/cli/src/lib/crabbox/lease.ts`.

- **Show reasoning in Factory progress timelines (RUSH-1634).** Factory detail panes now interleave assistant prose and reasoning summaries with tool calls in the Progress rail, so agent activity explains intent instead of showing only file/tool touches. Source: `apps/factory/src/core/session.summary.ts`, `apps/factory/ui/settings/components/mission-control/Timeline.tsx`.

- **Expose an Agents HQ floor snapshot bridge (RUSH-1638).** `agents hq floor --json` now emits a machine-readable floor snapshot that joins live sessions, teams, feed blocks, room placement, ambient events, and command-backed actions for HQ clients. Source: `apps/cli/src/commands/hq.ts`, `apps/cli/src/lib/hq/floor.ts`.

- **Menu-bar Quick Dispatch attaches selected screenshots after ticket creation (RUSH-1693).** The helper now uploads every selected quick-capture screenshot to the created Linear issue itself after parsing the `Created RUSH-###` result, instead of relying on the ticket agent to run a second proof-upload command from its prompt. Source: `apps/cli/menubar/Sources/MenubarHelper/AgentsCLI.swift`, `apps/cli/menubar/Sources/MenubarHelper/IssueSelfTest.swift`, `apps/cli/docs/menubar.md`.

- **Move supported OpenClaw secrets into Keychain-backed refs (RUSH-175).** `agents secrets openclaw-keychain migrate` now stores supported OpenClaw plaintext credentials in macOS Keychain, rewrites OpenClaw config fields to exec SecretRefs, and refuses to delete top-level env secrets that have no supported SecretRef target. Source: `apps/cli/src/lib/openclaw-keychain.ts`, `apps/cli/src/commands/secrets.ts`, `apps/cli/docs/secrets.md`.

- **Provision share workers completely (RUSH-1792).** `agents share setup` now configures the R2 lifecycle rule and sets the Worker `WRITE_TOKEN` through Cloudflare's Workers Secrets API after deploying the R2-bound Worker. Source: `apps/cli/src/lib/share/provision.ts`.

- **Extract a reusable share-publish endpoint seam (RUSH-1794).** `agents share <file>` now delegates its authenticated PUT (bearer token, `--slug`, `--expire`) through `publishToEndpoint`, decoupled from config/keychain loading, with a real-HTTP test asserting the wire contract. Source: `apps/cli/src/lib/share/publish.ts`.

- **Map the default share domain automatically (RUSH-1796).** `agents share setup` now maps `share.agents-cli.sh` when the Cloudflare token can see the `agents-cli.sh` zone, while keeping the workers.dev endpoint when it cannot and honoring `--domain` overrides. Source: `apps/cli/src/commands/share.ts`, `apps/cli/docs/share.md`.

- **Expire shared artifacts end to end (RUSH-1797).** `agents share --expire` now stores
  `expires-at` metadata for the Worker to enforce and `agents share setup` installs a
  managed R2 lifecycle rule so old share objects self-clean. Source:
  `apps/cli/src/lib/share/{publish,provision,worker-template}.ts`.

- **`agents share` central mode now follows synced config plus injected write tokens (RUSH-1798).** `agents share join` can bind an existing synced endpoint without reprovisioning, publish reads `SHARE_WRITE_TOKEN` from runtime env before falling back to the local `share` bundle, and agent/team/supported cloud launches propagate the token when it is already available so ephemeral agents can publish durable links with no Cloudflare setup. Source: `apps/cli/src/commands/share.ts`, `apps/cli/src/lib/share/config.ts`, `apps/cli/src/commands/exec.ts`, `apps/cli/src/commands/cloud.ts`, `apps/cli/src/commands/teams.ts`, `apps/cli/src/lib/cloud/rush.ts`, `apps/cli/src/lib/cloud/factory.ts`, `apps/cli/src/lib/cloud/codex.ts`.

- **Plan-render auto-publish plumbing (RUSH-1799).** `agents share <file> --json`
  now emits a stable `{ url, coverUrl, expiresAt }` result so plan-render hooks can
  publish rendered HTML and post the returned link without scraping terminal output.
  Source: `apps/cli/src/commands/share.ts`, `apps/cli/src/lib/share/publish.ts`.

- Added `agents share` regression coverage for token storage, publish upload headers, expiry metadata, and Cloudflare provisioning request shapes without calling real Cloudflare in CI. Source: `src/lib/share/{config,publish-file,provision}.test.ts`, `src/lib/share/provision.ts`.

- `agents repo pull` now fast-forwards the local checkout after fetch
  (`--ff-only` semantics) and reports when it is blocked by local changes or
  local commits instead of leaving the checkout behind origin. The system repo
  uses the same fast-forward path as user and extra repos.

- **`agents share` default links are much harder to guess (RUSH-1821).** The random
  tail of an auto-generated share slug is now a 64-bit nonce (`randomBytes(8)`, 16 hex
  chars) instead of the old 24-bit / 6-hex tail — closing a `~16.7M`-possibility space
  that was small enough to brute-force. Since share reads are public (the URL is the only
  capability), the nonce is the whole defense, so it now carries the full 64 bits.
  Passed-in `--slug` values and existing links are unchanged. `docs/share.md` now states
  the security model explicitly (unlisted-not-secret; reads are public; use `--expire`
  for sensitive content; an opt-in auth-gated read is a future option). Source:
  `apps/cli/src/lib/share/publish.ts` (`defaultSlug`), `apps/cli/src/lib/share/publish.test.ts`,
  `apps/cli/docs/share.md`.

- **`agents secrets list`/`view` gain `--json` (RUSH-1834).** Agents can now discover which secrets bundles and keys exist as machine-readable JSON before injecting one — `list --json` emits bundle metadata (name, key count, policy, backend, timestamps) and `view <bundle> --json` lists each key with its kind and stored/missing state. Values stay `null` unless `--reveal` (which keeps the same non-TTY `--plaintext` gate and audit event as the human view), so the discovery surface never leaks a secret. Gated on the explicit `--json` flag, not `stdout.isTTY`. Source: `apps/cli/src/commands/secrets.ts`.

- **Per-user URL namespaces + privacy-first analytics for `agents share` (RUSH-1835).**
  Shares now publish under the publisher's GitHub username (`share.agents-cli.sh/<user>/<slug>`),
  with `/<user>` rendering a public gallery and legacy flat slugs still resolving. Every HTML
  publish also injects a cookieless Cloudflare Web Analytics beacon (opt out with
  `--no-analytics`). Configure the token during `agents share setup --analytics-token`, and
  check status with `agents share status` / `agents share analytics`. Source:
  `apps/cli/src/commands/share.ts`, `apps/cli/src/lib/share/{publish,analytics,worker-template}.ts`,
  `apps/cli/src/lib/git.ts`, `apps/cli/docs/share.md`.

- **Codex no longer breaks on macOS when its versioned `CODEX_HOME` overflows the
  Unix-socket `SUN_LEN` limit.** Codex binds an app-server control socket at
  `$CODEX_HOME/app-server-control/app-server-control.sock`, and macOS caps Unix
  socket paths at 104 bytes (`SUN_LEN`). agents-cli points `CODEX_HOME` at the deep
  versioned home (`~/.agents/.history/versions/codex/<version>/home/.codex`), which
  for a typical user is long enough that the derived socket path exceeds 104 bytes —
  so `codex app-server daemon start` failed with `path must be shorter than
  SUN_LEN` and every codex spawn on macOS died (this took down every OpenClaw agent
  on a mac-mini). Codex exposes no socket-path override and resolves symlinks before
  binding, so a short symlink to the deep home does not help. The codex shims and
  `buildExecEnv` now detect the overflow on macOS and relocate the home once to a
  short real directory under `~/.agents/.codex-homes/<version>/.codex` (leaving a
  symlink behind so the versioned path still resolves), keeping config, auth, and
  state intact. A caller-set `CODEX_HOME` is always respected. Source:
  `apps/cli/src/lib/codex-home.ts` (new), `apps/cli/src/lib/shims.ts`,
  `apps/cli/src/lib/exec.ts`.

- **Gate GitHub webhook routines on pull request labels (RUSH-203).** `agents routines add --on github:pull_request` and `agents cloud run --on pr` now preserve GitHub `--action` and `--label` filters, so a UX test routine can fire only when a PR receives `ux-approved`. Source: `apps/cli/src/lib/routines.ts`, `apps/cli/src/lib/triggers/webhook.ts`, `apps/cli/src/commands/routines.ts`, `apps/cli/src/commands/cloud.ts`.

- **Remove the deprecated `agents daemon` command tree (RUSH-403).** The legacy `agents daemon start|stop|status|logs` aliases are gone for v2.0; use `agents routines start|stop|status|scheduler-logs` for scheduler controls. Source: `apps/cli/src/lib/startup/command-registry.ts`, `apps/cli/src/index.ts`, `apps/cli/src/lib/daemon.ts`, `apps/cli/docs/03-routines.md`.

Added top-level resource profiles via `agents profile use`, filtering synced resources and secrets bundles by the active profile.
Fixed source-qualified resource profile selectors for permission groups and workflows so `project:`, `user:`, and `system:` patterns match the real resource layer.
Fixed `resolveResource` to fall through to lower-precedence layers when a higher-layer match is excluded by the active profile, matching `listResources` behavior.

- **Support multiple accounts per secrets bundle (RUSH-668).** Secrets bundle keys now accept `BASE.account` names such as `GITHUB_USERNAME.personal`; selected account variants inject as the base env key and conflicting variants fail loud unless narrowed with `--keys`. Source: `apps/cli/src/lib/secrets/bundles.ts`, `apps/cli/docs/secrets.md`.

- **Harden synced vault writes (RUSH-682).** Synced secret mutations now lock the vault across the full read-modify-write cycle and persist through an atomic rename, preventing concurrent CLI processes from losing each other's bundle updates. Source: `apps/cli/src/lib/secrets/vault.ts`.

## Features

- Added `agents login`, `agents logout`, and `agents whoami` plus `agents secrets create --synced` for age-encrypted synced secrets stored in `~/.agents/vault.age`.
- Protected synced secrets vaults from accidental replacement: `agents login --create` and `agents login --join <path>` now require `--force` before replacing an existing `vault.age`, and synced bundle writes batch metadata plus stored keys into one vault update.
- Synced vault encryption now runs without re-executing the `agents` binary, so standalone macOS installs can encrypt and decrypt vault data reliably; new vault writes also use the age library's default scrypt work factor.

- **Keep project resources in workspace config (RUSH-705).** Project-scoped commands,
  skills, subagents, and workflows now sync into the current workspace's `.<agent>/`
  directory instead of lingering in global agent version homes. Source:
  `apps/cli/src/lib/project-resources.ts`.
- **Track Goose workflow subrecipes from first sync (RUSH-705).** Goose workflow
  `.subrecipes/` directories are tracked in the ownership manifest from the first
  sync, preventing workflows from being incorrectly skipped on later syncs. Source:
  `apps/cli/src/lib/project-resources.ts`.

- **`agents activity` — an event-sourced view of what agents *did*.** A new append-only, per-session event log (`~/.agents/.history/activity/<sessionId>.jsonl`) records agent-semantic milestones at hook time (plans, PRs, worktrees, sub-agents, artifacts) with no transcript re-parsing. `agents activity` renders the stream newest-first (milestones individually, routine edits collapsed to a count); `agents feed` gains a compact recent-activity lane. Source: `apps/cli/src/lib/activity.ts`, `apps/cli/src/commands/activity.ts`.

- **Lease command surface: reuse picker, devices section, step UI, and Tailscale net-mode (RUSH-1922/1923/1924).**
  Wires the command layer onto the merged crabbox-core lib:
  - **Reuse (F3).** On an interactive `agents run … --lease`, a picker lists your
    warm boxes (`ready` + unexpired, most-recently-touched first) and offers
    "Provision a fresh box" / "Always provision fresh (remember for this repo)".
    New flags: `--reuse` (scriptable — auto-pick the freshest warm box, else
    fresh) and `--bare` (skip copying your local `~/.agents` setup onto the box,
    i.e. `copySetup=false`). Headless / `--json` never blocks — it provisions
    fresh unless `--reuse`/`--box` is given. New subcommands `agents lease list`
    (`--json`) and `agents lease stop <slug>`.
  - **Step UI (F2).** The box-side setup now renders as a live checklist —
    each `___PHASE_<name>___` step from the lib's `onStep` stream prints via
    `renderStepLine` (✔ Step — detail (elapsed)). Non-TTY prints one line per
    step; `--json` emits `{phase:"setup",name,elapsedMs}` events. Host-side
    warmup/ready/teardown phases are unchanged.
  - **Devices (F4).** `agents devices` gains a live "Leased boxes (ephemeral ·
    via crabbox)" section computed from `crabboxList()` — never written into the
    device registry. `agents ssh <slug>` now resolves a leased-box slug and
    connects to `crabbox@<tailnet-or-ip>:2222`.
  - **Net-mode (F5).** New `--tailscale` / `--no-tailscale` on `agents run`.
    `netMode = (--tailscale || reuse-context) && !--no-tailscale` (a solo
    one-shot `--lease` stays public) is threaded into the lease so the lib leases
    onto the tailnet. `agents lease setup` now also captures a Tailscale auth key
    (EPHEMERAL, pre-authorized, `tag:crabbox`) into the `tailscale.com` secrets
    bundle as `CRABBOX_TAILSCALE_AUTH_KEY`; when Tailscale is requested with no
    key configured the run falls back to a public lease with an actionable hint.
    The final "box ready/kept" line surfaces the box's tailnet FQDN/IP.

  Source: `apps/cli/src/commands/exec.ts`, `apps/cli/src/commands/lease.ts`,
  `apps/cli/src/commands/ssh.ts` (+ `*.test.ts`).

- Add GitHub Copilot CLI permission sync, writing supported allow rules to `.copilot/permissions-config.json`.

- **Lease lifecycle: setup-copy, step progress, and tailscale plumbing (RUSH-1920/1921/1924).** `agents run --lease` gains a library core the command layer wires up: `copySetupToBox` pushes the git-tracked subset of the local `~/.agents` onto the box and refreshes it (never `~/.claude`); the box bootstrap now echoes `___PHASE_<name>___` sentinels parsed into a structured `LeaseStep` stream (`onStep` + `renderStepLine`); and a `netMode: 'tailscale'` path leases boxes onto the tailnet (`--network tailscale -tailscale-tags tag:crabbox`, `CRABBOX_TAILSCALE_AUTH_KEY` from a secrets bundle) with `CrabboxBox.tailscaleIPv4`/`tailscaleFQDN` parsed from box labels. Source: `apps/cli/src/lib/crabbox/setup-copy.ts`, `apps/cli/src/lib/crabbox/progress.ts`, `apps/cli/src/lib/crabbox/lease.ts`, `apps/cli/src/lib/crabbox/cli.ts`.

- **`agents cloud run --json` now emits machine-readable failures.** `die()` — the
  shared fatal-exit path — always wrote red text to stderr and left stdout empty,
  so an agent parsing `--json` output saw nothing plus a bare nonzero exit with no
  reason. `die()` gains an optional `{ json, hint }` and, in json mode, prints
  `{"error", "hint"?}` to stdout; a pure `formatDie()` makes the human/agent split
  unit-testable. Every failure path in `cloud run` now threads the resolved
  `--json` flag. Source: `apps/cli/src/lib/format.ts`, `apps/cli/src/commands/cloud.ts`.
  (RUSH-1830)

- **Show live Droid quota bars in `agents view` (RUSH-1357).** Factory billing
  limits now render as `S`/`W`/`M` windows for Droid, matching Claude's live-usage
  display. Source: `apps/cli/src/lib/usage.ts`.

- **`agents events` is now one unified stream — operational + agent activity.** Agent-semantic events (plans, PRs, worktrees, sub-agents, artifacts) share the event vocabulary and read through the same reader as operational events (secrets, teams, commands), newest-first. `--module activity` shows agent events, `--audit` restricts to operational only, and all existing filters (`--event`, `--agent`, `--since`, `--command`) apply across both. New `readUnifiedEvents` (`apps/cli/src/lib/event-stream.ts`) is the single read surface for higher-level features. Source: `apps/cli/src/lib/events.ts`, `apps/cli/src/lib/activity.ts`, `apps/cli/src/commands/events.ts`.

- **The daemon no longer crash-loops on headless Linux when a routine is overdue.**
  On an overdue routine the daemon fires a best-effort desktop notification via
  `notify-send` (Linux) / `osascript` (macOS). A missing notifier binary — the
  default on a headless box without `libnotify-bin` — surfaces as an asynchronous
  `spawn` `'error'` event, not the synchronous throw the surrounding `try/catch`
  expected, so Node re-threw it as an uncaught exception and killed the daemon.
  systemd then restart-looped it every ~10s, which also tore down the browser IPC
  socket (`agents browser start` failed with "Timeout waiting for browser daemon
  socket"). Both notifier spawns now carry an `'error'` listener so the failure is
  swallowed as the "best-effort" contract already promised. Source:
  `apps/cli/src/lib/overdue.ts`, `apps/cli/src/lib/overdue.test.ts`.

- **`agents fleet apply` — reconcile the fleet from under the `fleet` verb.** The idempotent reconcile engine already shipped as top-level `agents apply`, but users who reach for `fleet`/`devices` as the noun (`fleet capture`, `fleet login`, `fleet status`) had no matching `fleet apply`. This surfaces the identical command as `agents fleet apply` (and `agents devices apply`) via a shared configurator, so the two can never drift — same flags, same engine, same `--plan`/`--device`/`--only` semantics. Pure discoverability alias; no behavior change to `agents apply`. Source: `apps/cli/src/commands/apply.ts` (`configureApplyCommand`, `registerFleetApplyAlias`), `apps/cli/src/commands/ssh.ts`.

- **`agents fleet login` now finds the agent CLIs on the remote box.** The remote drive ran the login command over a non-login SSH shell (`ssh <box> kimi`), where the agents-cli shims (`~/.agents/.cache/shims`) are not on PATH — so `kimi`/`droid`/`codex` were "command not found" and the device-code scrape always timed out. The remote command now prepends the shim dir (resolved on the box via `$HOME`) to PATH so the login program launches. Source: `apps/cli/src/lib/fleet/remote-login.ts`.

- **New `agents fleet login` — log agent CLIs into every fleet box over SSH from one browser page.** File-copying one OAuth credential across N machines is fatal: a shared refresh token rotates server-side on first refresh and invalidates the other copies. The durable fix is a per-machine login (one interactive OAuth per agent x box), and this command makes that bearable. It drives each box's device-code flow through the PTY sidecar (`ssh -tt <box> <loginCmd>`), scrapes the verification URL + user code, and surfaces every pending login in ONE local dark/light dashboard with per-code `Authorize` deep-links and TTL countdowns — so you enter codes back-to-back instead of babysitting N terminals. Default mode requests all codes concurrently; `--interactive` walks one box at a time, requesting each code just-in-time so the ~15-min TTL can't expire while you work. Only true device-code flows are driven (droid, codex, kimi); loopback / keychain-bound / uncharacterized agents (claude, gemini, antigravity, opencode, grok) are flagged non-remotable with an honest reason instead of a mis-drive. Flags: `--agents <csv>`, `--devices <csv>`, `--all`, `--interactive`, `--json`. Source: `apps/cli/src/lib/fleet/remote-login.ts`, `apps/cli/src/lib/fleet/auth-sync.ts` (`FLEET_LOGIN_FLOWS`), `apps/cli/src/commands/ssh.ts`, `apps/cli/src/lib/open-url.ts`.

- **`agents fleet ping` stops crying wolf on healthy accounts.** The auth matrix
  painted a fully-logged-in fleet as half-broken: `codex`/`grok` (which have no
  in-repo live-probe endpoint) rolled up as an alarming yellow `0/N`, and the
  `--verbose` per-account list painted `expired` **red** — lumped with a real
  `revoked` — even though `expired` is soft and self-refreshes on the CLI's next
  launch (kimi/droid). Both renderers now share one truthful color model
  (`verdictColor` / `authCellColor`): red is reserved for `revoked` (the only
  "re-login now"); `unverified` reads as neutral **gray** "signed in
  (unverifiable)"; `expired`/`rate_limited`/`error` are soft **yellow**; and the
  cell numerator counts signed-in accounts (`live + present`) so a logged-in codex
  fleet reads `1/1`, not `0/1`. Separately, `fleet ping --verbose` now actually
  emits the per-account breakdown: the root program's global `--verbose` was
  shadowing the subcommand flag, so the breakdown was silently unreachable — the
  action now reads the effective value from the merged globals. Source:
  `apps/cli/src/lib/auth-health.ts`, `apps/cli/src/commands/ssh.ts`,
  `apps/cli/src/lib/auth-health.test.ts`.

- **Wire allowlist support for ForgeCode and Hermes (RUSH-1748, RUSH-1749).** ForgeCode now receives permission groups as `~/.forge/permissions.yaml` operation-family policies (`read`, `write`, `command`, `url`) for built-in tools; this file is active only when `.forge.toml` has `restricted = true`, and MCP tools bypass it. Hermes now receives command allow rules in `~/.hermes/config.yaml` `command_allowlist` and deny globs in `approvals.deny`, preserving sibling YAML keys such as `mcp_servers` and `hooks`. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/permissions.ts`, `apps/cli/src/lib/resources/permissions.ts`, `apps/cli/src/lib/staleness/detectors/permissions.ts`, `apps/cli/docs/{00-concepts,02-resource-sync}.md`.

- **`agents run --lease`/`--box` fail fast outside a git repo instead of billing a dead box.** crabbox syncs the working directory to the leased box with `git ls-files`, so from a non-git directory the run died at `build sync file list: exit status 128` — but only *after* provisioning (and billing) the box. `agents run` now checks the working directory is a git repo before provisioning and exits with an actionable message (`… is not a git repository. Run from inside a git repo, or initialize one: (cd <dir> && git init)`). Source: `apps/cli/src/commands/exec.ts`.

- **Fix `agents run --lease` setup-copy (and `agents ssh <slug>`) to actually reach the box.** Both used a raw `ssh crabbox@ip:2222`, which fails `publickey` — crabbox provisions a per-lease identity key. They now tunnel through crabbox's own ssh invocation (`crabbox ssh --id <slug> --reclaim`), so the git-tracked `~/.agents` config really lands on a leased box (`agents repo refresh` then materializes it) and `agents ssh <slug>` connects. Verified end-to-end on a real Hetzner box. Source: `apps/cli/src/lib/crabbox/{setup-copy,cli}.ts`, `apps/cli/src/commands/ssh.ts`.

- **Fix the Linear `--label` trigger filter matching nothing.** `routines` and
  `monitors` jobs triggered on `linear:Issue` with `--label <name>` never fired:
  the matcher read `data.labels.nodes[].name` (the GraphQL-query connection
  shape), but Linear webhook bodies flatten list relations — `data.labels` is a
  flat array of label objects. The `.nodes` read always yielded `[]`, so every
  label filter silently failed to match. It now reads the flat array. The prior
  unit test fixtured the same wrong shape, so the suite was green while the
  integration was dead; the fixture now uses the real webhook shape and a
  regression test locks it. Source: `apps/cli/src/lib/triggers/webhook.ts`.

- **`agents menubar` now works from the Bun single-file binary.** When the CLI runs
  as the compiled Bun executable, `import.meta.url` points inside the virtual
  `/$bunfs/` bundle, so the menu-bar helper couldn't find the shipped
  `MenubarHelper.app` on disk (`bundle source: missing (cannot enable)`) or read its
  own `package.json` (`current version: unknown`, and a perpetual "stale" warning).
  `enable` refused with "no menu-bar helper bundle ships with this install." Version
  and bundle resolution now fall back to the real on-disk install, located by
  following the `agents` launcher symlink, so `enable`/`disable`/`status` behave the
  same whether the CLI runs under Node or the Bun binary. Source:
  `apps/cli/src/lib/version.ts`, `apps/cli/src/lib/menubar/install-menubar.ts`.

- Add OpenClaw workflow sync by projecting agents-cli workflows into Lobster `.lobster` files under `.openclaw/workflows/`.

- **Fix the PTY sidecar (`agents pty`, interactive `agents teams`, `agents fleet login`) on the macOS standalone binary.** Since the macOS release became a `bun --compile` standalone (#315), the sidecar was spawned AS that binary (`process.execPath pty _server`) — but a Bun standalone cannot `require()` a native addon, so node-pty's `pty.node` failed to load (`Cannot require module ../build/Debug/pty.node`) and every PTY-backed command died with "PTY server failed to start within 5 seconds." `getServerSpawnArgs` now detects the standalone case and runs the sidecar via a real `node` executing the `dist/index.js` that ships beside the binary (where the prebuilt `pty.node` loads from disk), falling back to the binary only when no node / no dist is found. Verified end-to-end against a real compiled Mach-O standalone. Source: `apps/cli/src/lib/pty-client.ts`.

- `agents sessions` now indexes routine-run transcripts from durable run history; use `agents sessions --routine --all` or `agents sessions <run-id>` to inspect a routine run with the existing summary view.

- **`agents routines add`, `run`, and `runs` now support `--json`.** Previously only
  `list`/`status` emitted JSON, so an agent creating a routine or triggering a run
  had to scrape human strings for the job name / run id. `add` emits
  `{ ok, added, job }`, `run` emits `{ ok, job, runId, logDir }`, and `runs` emits an
  array of run records — all on stdout, with the scheduler-start banner suppressed so
  it never pollutes the JSON stream. Source: `apps/cli/src/commands/routines.ts`.
  (RUSH-1833)

- **`agents run <agent>` no longer hangs when launched headless without a prompt.**
  A run with no prompt and no explicit `--interactive` resolves to interactive
  intent — but in a non-TTY shell (a headless agent, a pipe, CI) there is no
  terminal to host the REPL, so it attached a TUI to dead stdin and hung forever.
  It now fails fast with the headless alternatives (`agents run <agent> "<task>"`
  or `agents run <agent> --headless` to read the prompt from stdin). An explicit
  `--interactive` is still honored. Source: `apps/cli/src/commands/exec.ts`,
  `apps/cli/src/lib/exec.ts` (`inferredInteractiveWithoutTty`). (RUSH-1829)

- Menu bar routines now include latest run `exitCode` and `failureReason` from `agents routines list --json`, show failed routine reasons inline, label healthy-but-overdue routines as `overdue` instead of `exit 0`, and open the concise logs summary instead of a raw Terminal dump.

- Show Droid teammate activity in `agents teams collect` by normalizing stream-json tools, file edits, and final messages.

Fix: route remaining specialized direct SSH spawns through the shared hardened SSH baseline.

- **Agent feed dispatch now keeps local and remote answer paths separate (RUSH-1472).** `agents feed` only applies stall suppression, default-on-no-answer policy, and dispatch controls to blocks owned by the local machine, so remote feed rows cannot enqueue answers into the wrong local mailbox. Per-block `timeoutMinutes` is honored for approval defaults and decision parking, policy/default answers are tested against the real mailbox spool, block-specific `allowedOperators` restrict high-consequence answers, and urgent notification text is emoji-free. Source: `apps/cli/src/commands/feed.ts`, `apps/cli/src/lib/{ask-classifier,feed,feed-policy,notify}.ts`.

- **`agents feed` ranks blocked agents by cost of delay and surfaces runaway/needy control cards (RUSH-1478).** Open blocks are sorted by idle time, downstream blast radius, dollar burn rate, and classifier irreducibility, while silent high-burn/relaunch-loop agents and chronic askers render once as control cards with `ag feed --pause` / `ag feed --kill` actions. Source: `apps/cli/src/lib/feed-ranking.ts`, `apps/cli/src/commands/feed.ts`, `apps/cli/src/lib/feed.ts`.

- Make live session follows compact by default: `agents sessions tail` now prints low-noise message/tool/result lines unless `--json` is passed, and `agents logs -f <id>` keeps raw transcript streaming behind `--full`.

- **Fix `agents repo refresh` for stale plugin skill shadows.** Full refresh now forces a materialization pass, copies trusted plugin-bundled skills into legacy top-level agent-home skill dirs when those names already matter to the agent, and prunes orphaned top-level skill dirs whose source no longer exists.

- `agents run <profile> --lease` now provisions the profile's host runtime and temporary profile config on the leased box without copying base-runtime OAuth credentials when the profile authenticates with its own API key, including OpenCode and Antigravity-hosted profiles.

- `agents pty` now starts its sidecar correctly from the standalone CLI binary and includes the spawned command plus recent sidecar log lines when startup fails.

- Fixed `agents secrets openclaw-keychain migrate` so OpenClaw Keychain writes no longer expose secret values in process argv, and migration now fails closed when matching plaintext credentials disagree.

- `agents share setup` and `agents setup share` now read Cloudflare provisioning credentials from the `cloudflare` secrets bundle and persist the Worker write token as `WRITE_TOKEN` in the `share` bundle, matching the setup/onboarding contract while keeping endpoint config in `agents.yaml` under `share:`.

- Fix `agents routines list` and `agents routines view` so a project-layer routine with the same name no longer hides the user-layer `devices` allowlist written by `agents routines devices --set`.

- Keep piped CLI output human-readable unless `--json` is passed.

- Add `--json` to `agents monitors view` and `agents monitors test`, and send monitor errors to stderr so JSON stdout stays parseable.

- Add `--json` output to `agents routines add`, `agents routines run`, and
  `agents routines runs` so scripts can capture routine and run ids without scraping human text.

- Fix hook directory sync status so bundled hook directories such as `hooks/tests` copy correctly and no longer appear permanently drifted after sync.

- Neutralize residual OSS scrub breadcrumbs by replacing browser/session test fixture hostnames with `remote-host` and removing legacy private product path references from cloud proxy comments.

- **Add `agents setup mine` / `agents mine` — white-label the CLI.** Mint your own personally-named binary (e.g. `jack`) that runs every agents verb under your name, with the built-in commands you disable hidden and a per-brand resource profile that curates skills/plugins/MCP/etc. `agents setup mine` is the wizard; `agents mine init/list/toggle/remove` manage brands. Free and Apache-2.0. Source: `apps/cli/src/commands/mine.ts`, `apps/cli/src/lib/brand.ts`.

- **One-time "star us on GitHub" nudge after your first successful run.** After a
  user's first successful `agents run` or `agents teams`, agents-cli prints a
  single plain inline line pointing at the repo. Shown at most once ever (claimed
  with an atomic O_EXCL sentinel so concurrent `agents teams` processes can't
  double-print), and skipped for non-TTY, CI, `--json`/`--quiet`, or
  `AGENTS_NO_NUDGE=1`. The `agents teams` call site only nudges on a clean drain
  (no failed teammates). Source: `apps/cli/src/lib/star-nudge.ts`,
  `apps/cli/src/commands/exec.ts`, `apps/cli/src/commands/teams.ts`,
  `apps/cli/src/lib/teams/supervisor.ts`.

## 1.20.72

- **Stop `agents doctor` from reporting phantom drift and `agents prune` from
  deleting source-managed resources.** Three reconciler false positives are
  fixed: the instruction file (`CLAUDE.md`/`AGENTS.md`) is now compared against
  the composed active-preset output the rules writer actually emits — not the raw
  whole-repo `rules/AGENTS.md` — so a correctly-synced home no longer shows as
  permanent drift; plugin-bundled commands installed as `<plugin>-<command>`
  command-skills (e.g. `swarm-plan`, `code-review`) are no longer flagged as
  orphans/extras that `prune cleanup` would delete; and command-as-skill wrappers
  (the `agents_command` marker) are no longer miscounted as skills and surfaced as
  deletable skill orphans. Source: `apps/cli/src/lib/staleness/`,
  `apps/cli/src/lib/commands.ts`, `apps/cli/src/lib/skills.ts`.

- **Capture your whole fleet into `agents.yaml`, then rebuild it anywhere with
  `agents apply` (#1305).** New `agents fleet capture` (alias `agents devices
  capture`) snapshots the live environment into the portable `fleet:` block — the
  device roster (**names only**), the source's agents as `defaults`, secrets-bundle
  **names**, and routine **names**. It commits **zero** Tailscale IPs or usernames:
  `agents apply` reconstructs a fresh machine's roster by resolving each device
  name **live from Tailscale** (`ensureDevicesRegistered`), so `git clone` +
  `agents apply` replicates the fleet with nothing sensitive in the repo. `apply`
  now also passes declared `sync:` scopes through to `agents sync <scope>`
  (previously a bare `sync`) and surfaces declared secrets-bundle names to recreate
  on each device (values stay keychain-local, never pushed). Browser profiles are
  intentionally not duplicated into `fleet:` — they already sync via the central
  `browser:` block. Source: `apps/cli/src/commands/fleet-capture.ts`,
  `apps/cli/src/lib/fleet/capture.ts`, `apps/cli/src/lib/devices/sync.ts`,
  `apps/cli/src/lib/fleet/{types,manifest,apply}.ts`.

- **`agents fleet status` no longer hangs on a stale `~/.ssh/config`.** The fleet probes (version / doctor / `fleet ping`) now dial each device at its registry Tailscale address (`dnsName`/IP) instead of the bare host name — so a hand-written `Host <name>` block carrying a drifted LAN IP can no longer shadow the correct entry and make a reachable box look dead. It also fails fast: a device the stats probe already found unreachable is skipped straight to an unreachable row instead of eating a 15s+30s version+doctor timeout. Source: `apps/cli/src/commands/ssh.ts`.

- **No more macOS keychain password prompt from an interactive command.** Writing a non-`agents-cli.` keychain item (e.g. a refreshed Claude OAuth token during `agents view`, or an `agents secrets add`) via `/usr/bin/security add-generic-password -w` piped the value over stdin — but `readpassphrase(3)` reads the *controlling terminal* when one exists, so in an interactive shell `security` prompted the user ("password data for new item:") and hung to the timeout, ignoring the piped value. The write now runs `detached` (a new session with no controlling terminal) so the piped stdin is always used. Verified under a pty. Source: `apps/cli/src/lib/secrets/index.ts`.

- **`agents logs <id> --json` now reports the true final status of a host task.**
  For a run that finished remotely between dispatch and the one-shot `--json`
  read, the payload emitted a stale `status: "running"` with no `exitCode` — even
  though the completed log was already present — because `hostTaskLogJson`
  discarded the reconciled record `reconcileTask` returns (it heals a new object
  rather than mutating in place). It now emits the reconciled task, so a polling
  agent sees `completed`/`failed` + `exitCode` + `finishedAt`. Source:
  `apps/cli/src/lib/hosts/logs.ts`.

- **Fix the macOS menu-bar auto-heal so upgrades actually restart the helper.**
  `agents` has an on-startup self-heal that re-copies `MenubarHelper.app` when
  the CLI version changes, but on modern macOS `launchctl bootstrap` fails when
  the job is already bootstrapped, and the deprecated `launchctl load -w`
  fallback plus `kickstart -k` did not recover a job that launchd had stopped
  respawning after a `WindowServer event port death`. The helper would stay
  updated on disk but invisible in the menu bar. `enableMenubarService` now
  boots the old job out, bootstraps the fresh plist, and kickstarts it — the
  same sequence that reliably restores the icon by hand. Source:
  `apps/cli/src/lib/menubar/install-menubar.ts`,
  `apps/cli/src/lib/menubar/install-menubar.test.ts`.

- **`agents repo pull` no longer wedges on per-machine pin drift.** The committed
  `devices/<machineId>/agents.yaml` (each box's agent version pins) is rewritten
  whenever a pin changes, leaving the working tree perpetually dirty — so
  `agents repo pull`, which refuses a dirty tree, kept failing until the file was
  hand-committed. `pullRepo` now durably commits **just that one path** (explicit
  pathspec) before pulling, via `commitOwnDeviceMeta`. Genuine uncommitted edits to
  any other file still (correctly) block the pull. No-op for the system/extra repos
  that don't own the path. Source: `apps/cli/src/lib/git.ts`.

- **`agents secrets unlock` now stays unlocked across an agents-cli upgrade (and,
  with `--durable`, across sleep + reboot).** The macOS secrets broker held an
  unlock only in RAM, so it evaporated every time the daemon restarted (upgrade)
  or the machine slept — forcing a Touch ID re-tap and breaking headless reads
  with "not unlocked in the secrets agent". An unlock now also persists a
  device-local, non-biometry keychain session item that the broker **rehydrates on
  start** and that reads **fall back to** silently. Split default: it survives
  upgrade/restart automatically; pass `--durable` (or set `secrets.agent.durable:
  true`) to also survive sleep/reboot — otherwise a bundle re-locks on sleep as
  before. `lock` / rotate / delete clear it. On Linux and Windows `unlock` is now a
  friendly no-op (secrets already resolve durably from the OS store with no
  prompt), so the command behaves the same on all three platforms. Source:
  `apps/cli/src/lib/secrets/session-store.ts` (new),
  `apps/cli/src/lib/secrets/agent.ts`, `apps/cli/src/lib/secrets/bundles.ts`,
  `apps/cli/src/lib/secrets/index.ts`, `apps/cli/src/commands/secrets.ts`,
  `apps/cli/src/lib/types.ts`.

- **`agents share` cover capture finds Playwright's `chrome-headless-shell` packages.** `scanCaches()` only knew the classic `chrome-mac/Chromium.app` and `Google Chrome for Testing` layouts, so on machines whose Playwright cache holds only the newer `chromium_headless_shell-*` packages (a raw `chrome-headless-shell` binary, not an `.app` bundle) — and no system Chrome/Brave/Edge — the OG cover capture silently returned null and shared plans published without a preview card. The scan now matches `chrome-headless-shell-mac-arm64`, `chrome-headless-shell-mac-x64`, and `chrome-headless-shell-linux64` layouts alongside the existing ones. Source: `apps/cli/src/lib/share/capture.ts`, `apps/cli/src/lib/share/capture.test.ts`.

- **New `agents uninstall` — cleanly reverse adoption and restore your original setup.** Installing agents-cli *adopts* your agent config: it moves `~/.<agent>` aside and replaces it with a symlink into the version homes, adopts the launcher on `PATH`, and adds the shim dir to your shell rc — but until now nothing put any of that back, so removing the CLI stranded your original config under `~/.agents/.history/backups/` and left `~/.claude` a dangling symlink. `agents uninstall` is the reverse of `agents setup`: it restores every adopted `~/.<agent>` (from the timestamped backup, or the version home for imported installs), restores owned home files, releases adopted launchers, strips the shim dir from every shell rc, then disposes of `~/.agents` — moved aside to `~/.agents.removed-<ts>` (recoverable) by default, or hard-deleted with `--purge`. A config agents-cli never adopted is never touched (ownership is decided structurally by `getConfigSymlinkVersion`, the same check `removeVersion` uses); `--dry-run` prints the full plan without changing anything; and if any restore step errors, `--purge` self-downgrades to the recoverable move-aside so a swallowed error can never take your only copy. Works on macOS, Linux, and Windows (junctions and cross-volume `~/.agents` handled). Source: `apps/cli/src/lib/uninstall.ts`, `apps/cli/src/commands/uninstall.ts`.

## 1.20.70

- **Fix `agents setup computer` / `agents computer setup` refusing to install a
  valid downloaded helper.** The signature check read `codesign -dv` from stdout,
  but that command writes its details to **stderr** on success — so the Team-ID
  check saw an empty string, found no `TeamIdentifier`, and rejected every
  validly-signed, notarized helper with "signed by unexpected Team (none)". It now
  reads both streams via `spawnSync`. Verified end-to-end against the real
  published `v1.20.69` release asset (download → sha256 → extract → codesign +
  Team `2HTP252L87` + `spctl` notarization → install). Source:
  `apps/cli/src/lib/computer/download.ts`.

- **The bundled macOS menu-bar helper is now a true universal binary on
  Xcode-less release hosts.** `menubar/scripts/build.sh release` used
  `swift build --arch arm64 --arch x86_64` (needs Xcode's xcbuild) and, on a
  Command-Line-Tools-only host, silently fell back to a **single-arch** build —
  shipping an arm64-only `MenubarHelper.app` in the tarball that could not run on
  Intel Macs. It now builds each slice via `--triple` and `lipo`s them into one
  universal binary, matching the computer helper. Source:
  `apps/cli/menubar/scripts/build.sh`.

## 1.20.69

- **Choose a safe account with `agents run <agent>@`.** A trailing `@` opens a
  per-run picker showing each installed version's account identity, login state,
  plan, and available session/weekly/monthly capacity. Logged-out, rate-limited,
  and out-of-credit accounts remain visible but disabled; signed-in accounts
  without quota data remain selectable and say `limits unavailable`. Source:
  `apps/cli/src/commands/run-account-picker.ts`,
  `apps/cli/src/commands/exec.ts`, `apps/cli/src/lib/rotate.ts`.

- **The macOS `agents computer` helper now ships as a signed + notarized release asset,
  downloaded on demand.** A fresh `npm i -g @phnx-labs/agents-cli` no longer needs to build
  the Swift helper from source: `agents computer setup` / `agents setup computer` fetch
  `ComputerHelper.app.zip` from the matching `v<version>` GitHub release, verify it against
  the published `.sha256`, and re-check the code signature (Developer ID Team `2HTP252L87`)
  and notarization (`spctl --assess`) before it is ever copied to /Applications — mirroring
  the Windows helper's distribution. The download cache is never a trusted resolver source;
  a cached bundle is only ever read back through the verifying downloader. The helper is
  version-stamped at build time and the release pipeline publishes the asset automatically.
  Source: `apps/cli/src/lib/computer/download.ts`, `apps/cli/src/lib/computer-rpc.ts`,
  `apps/cli/src/commands/computer.ts`, `native/computer-mac/scripts/build.sh`,
  `apps/cli/scripts/publish-computer-helper-mac.sh`, `apps/cli/scripts/release.sh`.

- **Live fleet auth health (`agents fleet ping`) + `agents view` chip (#1285).** New `agents fleet ping` completes a real authenticated request for every agent account across the fleet — the ground truth the local "signed in" flag can't give (it can't tell a revoked-but-unexpired token from a good one). Claude/Kimi/Droid are network-verified; Codex/Grok are best-effort. `agents view` now shows a live-status chip per version, read from the shared cache the ping writes. The probe hits the usage endpoint (no model tokens, no session created). Source: `apps/cli/src/lib/auth-health.ts`, `apps/cli/src/commands/ssh.ts`, `apps/cli/src/commands/view.ts`.

- **`agents fork` — branch a session into a new independent copy.** Copies a Claude
  session transcript to a fresh session id (rewriting only the `sessionId` field so the
  per-message uuid chain stays intact) beside the original, then registers it so it
  resumes independently from the same cwd and version — the original is left untouched.
  `--name` labels the fork. Source: `apps/cli/src/lib/session/fork.ts`,
  `apps/cli/src/commands/fork.ts`.

- **`agents setup` is now a capability hub with guided `browser` / `computer` / `share`
  subcommands.** Bare `agents setup` still clones the system repo and imports unmanaged
  agents, but on a TTY it now also offers to set up the optional capabilities a fresh
  machine needs. Each is also runnable on its own and is idempotent (re-run to change
  settings): `agents setup browser` detects an installed Chromium-family browser and
  creates/points the `default` profile; `agents setup share` provisions or joins a
  Cloudflare share endpoint (reusing `agents share setup`/`join`); `agents setup computer`
  installs the macOS helper and walks you through the Accessibility + Screen-Recording
  grants — opening the exact System Settings panes and polling until trust lands. The
  existing `agents share setup` / `agents computer setup` remain for scripted use. Source:
  `apps/cli/src/commands/setup.ts`, `setup-browser.ts`, `setup-computer.ts`,
  `setup-share.ts`, `apps/cli/src/lib/browser/chrome.ts`, `apps/cli/src/commands/share.ts`.

## 1.20.68

- **MCP resource handler now syncs project-level agent configs alongside user-level configs (RUSH-671).** `McpHandler.sync` previously wrote resolved MCP servers only to the version-home (user-level) config path. It now also writes project-layer MCP servers to each agent CLI's project-level config path (e.g., `.mcp.json` for Claude, `.codex/config.toml` for Codex) so agent CLIs can discover project-scoped MCPs natively. User-level sync is unchanged. Source: `apps/cli/src/lib/resources/mcp.ts`, `apps/cli/src/lib/agents.ts` (`getProjectMcpConfigPath` exported), `apps/cli/src/lib/resources/mcp.test.ts`.
- **Production MCP sync path also writes project-level configs.** `installMcpServers` now merges project-layer servers into the agent's project-level config file, using a shared `writeMcpConfig` serializer with overwrite/merge modes. OpenClaw serialization is corrected to nest under `mcp.servers`, matching the existing reader; Grok/OpenClaw user-level configs are written directly with merge mode so multiple servers don't clobber each other; and `installMcpServers` only reports `applied` for agents it actually wrote a config for. Source: `apps/cli/src/lib/mcp.ts`, `apps/cli/src/lib/mcp.test.ts`.

- **Accurate account tier and legible usage limits in `agents view`.** Each row's plan
  tier is now derived from `organizationType` (Max/Pro/Team/Enterprise) instead of a
  billingType guess that mislabelled every Max account as "Pro", and the redundant tier
  badge next to the email is dropped for personal plans (multi-seat orgs keep their org
  name, which is real identity). The compact `S:`/`W:` usage bars now show the exact
  percentage and a compact reset hint (`S: ███░░ 58% (3d)`), a signed-in account whose
  usage can't be fetched reads `usage unavailable` instead of a blank gauge, and a new
  `agents view --refresh` (`-r`) forces a live usage refresh past the cache. Source:
  `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/usage.ts`, `apps/cli/src/commands/view.ts`.

- **Fleet health status and drift gate.** `agents fleet status` now renders a fleet-wide warnings rollup plus a device matrix for reachability, resource headroom, sync drift, CLI readiness, and agents-cli version skew; `--json` emits the same report for scripts and `--strict` exits non-zero when any warning is present. `agents check --devices` now fans the existing drift gate across registered devices and exits non-zero when any device is drifted or unreachable. Source: `apps/cli/src/commands/ssh.ts`, `apps/cli/src/commands/check.ts`, `apps/cli/src/lib/devices/fleet.ts`, `apps/cli/src/lib/devices/health-report.ts`.

- **Login state per agent — `agents doctor` shows signed-in/logged-out, and `agents run` warns before launching into a logged-out account.** `agents doctor`'s **Agent CLIs** section now renders a `✓ signed in <account>` / `✗ logged out` badge per installed agent (also surfaced in `--json` under `signIn`), and an interactive `agents run <agent>` now prints a one-line stderr warning — `⚠ <agent> looks logged out — log in with: <cmd>. Launching anyway...` — when the account looks logged out, so you find out **before** the TUI opens instead of after typing a prompt and getting `/login` back. It is advisory (file-based `getAccountInfo`, no Keychain ACL prompt) and **never blocks**: skipped for `--json`/`--quiet`, when a rotation already picked a signed-in account, for `--host`/`--lease`, and via `--no-auth-check` / `AGENTS_NO_AUTH_CHECK=1`. `agents view`'s logged-out line now names the exact login command too. One shared badge/hint renderer keeps all three surfaces consistent across claude, codex, kimi, grok, opencode, and gemini. Source: `apps/cli/src/lib/signin-badge.ts` (+ `signin-badge.test.ts`), `apps/cli/src/commands/exec.ts`, `apps/cli/src/commands/doctor.ts`, `apps/cli/src/commands/view.ts`.

- **`agents repos add` adopts an existing checkout instead of dead-ending.** When
  the target `~/.agents-<alias>/` already holds a git repo whose origin matches the
  requested source, `repos add` now registers it in place (no re-clone) rather than
  erroring `Directory already exists`. A repo with a *different* origin is left
  untouched unless you pass `--adopt`. This removes the trap that forced a second,
  inconsistent install method when a repo had been cloned by hand. Remote matching
  is transport-agnostic (SSH and HTTPS forms of the same repo compare equal). Source:
  `apps/cli/src/commands/repo.ts`, `apps/cli/src/lib/git.ts`.

- **`--json` for `repos list` and `plugins list`.** Both list commands now emit
  machine-readable JSON with `--json`, matching the `repos view --json` /
  `plugins marketplaces --json` that already existed — so an agent can enumerate
  registered repos (with per-repo sync/drift state) and installed plugins (with
  per-agent-version sync targets) without scraping the human table. Source:
  `apps/cli/src/commands/repo.ts`, `apps/cli/src/commands/plugins.ts`.

- **`teams add --remote-cwd` now fails loud instead of silently doing nothing.** The
  flag rides the shared `--host` option family but `teams add` treats
  `--host`/`--device` as placement and never reads it, so passing it used to be a
  silent no-op that misled you into thinking it set the teammate's repo path. It is
  now rejected with guidance (place with `--device`, set the code with the team's
  `--repo`, one team per repo). The shared `--remote-cwd` help also warns that a
  local `~` expands on your machine, not the remote host — pass a single-quoted
  `'$HOME/…'` path or a valid remote absolute path. Teams docs + skill lead with
  this. Source: `apps/cli/src/commands/teams.ts` (`remoteCwdOnAddError`),
  `apps/cli/src/lib/hosts/option.ts`, `apps/cli/docs/teams.md`, `skills/teams/SKILL.md`.

- **No more CLIXML blobs from Windows hosts.** A remote `agents …` invocation
  routed to a Windows box (`--host win-mini`, `agents doctor --devices`,
  `agents fleet status`) no longer comes back wrapped in a raw `#< CLIXML <Objs …>`
  envelope. PowerShell 5.1 serializes its progress stream ("Preparing modules for
  first use.") to CLIXML when stderr is a captured pipe rather than a console; the
  Windows command builder now silences that stream (`$ProgressPreference =
  'SilentlyContinue'`) so failures read as plain text for humans and the JSON
  parsers that consume the output. Source: `apps/cli/src/lib/hosts/remote-cmd.ts`.

## 1.20.67

- **Interactive session browser — `agents sessions --active` and a bare `agents sessions`
  now open a live, filterable picker on a TTY (RUSH-1802).** One canonical filter driven by
  single keys, re-pulled across the fleet as you toggle: `s` search, `r` running-only, `c`
  teams, `a` agent (cycles), `d` device (cycles), `p` this-repo↔all-dirs, `w` time window;
  filters **stack** (AND together) and the active set shows in the header, with a live
  preview of the highlighted row and `⏎` to resume/attach via the existing dispatch. Every
  hotkey mirrors a flag, so the view is reproducible as a command — `y` copies (and
  `--print-cmd` prints) the exact `ag sessions …` line the filters map to, bridging the
  human picker and the agent/script flag surface. The interactive front-end is TTY-only:
  `--json`, a pipe, or the new `--no-interactive` keep the existing static listing verbatim,
  so scripts and headless agents are unchanged. Adds `-p` as the short form of `--project`,
  `--print-cmd`, `--preview` (`agents sessions <id> --preview` prints the compact digest
  without the pager), and `--no-interactive`. Built on a new async-refetch `dynamicPicker`
  variant that reuses the existing render/pagination/preview machinery, the fleet SSH
  fan-out, and the resume/focus path. Source: `apps/cli/src/lib/picker.ts` (`dynamicPicker`),
  `apps/cli/src/commands/sessions-browser.ts` (+ `sessions-browser.test.ts`),
  `apps/cli/src/commands/sessions.ts`.

- **kimi/grok headless `--mode plan` now auto-downgrades to `auto` instead of
  crashing or stalling (RUSH-1810).** kimi's headless `-p` refuses to combine with
  `--plan` (it hard-failed at spawn) and grok's `--permission-mode plan` silently
  stalls a headless run at its ExitPlanMode gate. Both now model this honestly with
  a `capabilities.headlessPlan: false` flag: a headless plan request degrades to
  `auto` (kimi `-p` auto-runs; grok maps `auto`→`edit`) with a one-line stderr
  warning, mirroring the graceful plan→edit degrade cursor/antigravity already get.
  Interactive plan is unchanged, and claude/codex/droid/opencode keep read-only
  plan headless. The same downgrade covers `agents run`, `agents teams add`
  teammates, and routine jobs. Source: `apps/cli/src/lib/exec.ts`
  (`resolveHeadlessMode`), `apps/cli/src/lib/runner.ts`, `apps/cli/src/lib/agents.ts`,
  `apps/cli/src/lib/types.ts`.

## 1.20.66

- **Fix (`agents monitors`, RUSH-1782 follow-up): `--watch-device` no longer silently watches the local machine on a bad name.** An unregistered or mistyped `--watch-device` name is now rejected at `add` time (same registry gate as `--device`/`--devices`), and the device source evaluator returns an explicit `device not registered` observation instead of falling back to local stats if a watched device is removed later — closing a "monitors the wrong box, silently" gap. The rate-limit firehose trip now also writes a fire record (`ok:false, error:'rate limited'`), so `agents monitors runs` reflects the auto-pause that `view`'s `last fired` already showed. Adds `sources/device.test.ts`. Source: `apps/cli/src/lib/monitors/sources/device.ts`, `apps/cli/src/commands/monitors.ts`, `apps/cli/src/lib/monitors/engine.ts`.

- **`agents monitors` — durable event-triggered watchers (RUSH-1782).** A monitor watches a SOURCE, detects a CONDITION change, and fires an ACTION — a routine whose trigger is a *watched source* instead of a *clock*, reusing the routines daemon, dispatch (`executeJobDetached`), device model, and notify path. Sources: `--watch`/`--poll` (a shell command's stdout), `--poll-http` (a URL's status+body), `--watch-file`, `--watch-device` (fleet reachability + load headroom, the first scheduler consumer of `devices/health.ts`), plus `--ws`/`--on` (push sources, accepted; delivery wired in a follow-up). Conditions: `--on-change` (default; first observation is a silent baseline), `--match <regex>` (fires once per distinct matched token), `--every`, with `--dedupe-key`. Actions: `--run <agent> --prompt` (the event is injected as `{event}`), `--routine`, `--notify`, `--webhook-out`. Pin-to-one placement: `--device <name>` names the single OWNER machine (exactly-once, v1 — no distributed lock); `--devices` is the advanced allowlist; `--run-on` offloads the action over SSH. The one genuinely new primitive is a native state-diff store (`~/.agents/.history/monitors/<name>/state.json`) that replaces the hand-rolled markdown memory files ad-hoc watchers needed. `agents monitors test <name>` is a dry-run that evaluates the source once and prints the emitted event + would-fire decision without acting. A `rateLimit: {max, per}` firehose guard auto-pauses a runaway monitor. The daemon hosts a `MonitorEngine` beside the cron scheduler, reloading on SIGHUP. Source: `apps/cli/src/lib/monitors/*` (`config.ts`, `state.ts`, `engine.ts`, `dispatch.ts`, `sources/*`), `apps/cli/src/lib/daemon.ts`, `apps/cli/src/lib/state.ts`, `apps/cli/src/commands/monitors.ts`, `apps/cli/src/lib/hosts/passthrough.ts`, `apps/cli/docs/10-monitors.md`.

- **NEW: `agents share <file>` — publish any HTML to a shareable link on your own Cloudflare R2, for ~$0 (RUSH-1791).** A one-command "publish" for agent-generated artifacts (plans, viz, reports). `agents share setup` provisions an R2 bucket + a ~30-line Worker on **your** Cloudflare (read from your `cloudflare.com` secrets bundle), enables the free `*.workers.dev` subdomain, and — if your token owns the zone — maps a custom domain like `share.agents-cli.sh`; `agents share plan.html [--slug x] [--expire 30d]` then does an authed `PUT` and prints the link. R2 has **zero egress** and a 10 GB free tier, so this is effectively free even at scale. The Worker is the ingress: uploads are bearer-gated through it (its R2 binding does the write, so the client needs no S3 keys) and **reads are public** — the link outlives the agent, since the page is stored in R2, not streamed. **Fleet/central mode**: the owner provisions one endpoint and every fleet/cloud/ephemeral agent publishes through it via the shared write token (a `share` secrets bundle) + synced `share:` config in `agents.yaml` (`agents share join` uses an existing endpoint with no provisioning). Expiry is per-object (`x-share-expires-at` metadata → the Worker 410s + lazily deletes past that instant). Source: `apps/cli/src/commands/share.ts`, `apps/cli/src/lib/share/{worker-template,provision,publish,config}.ts` (+ `Meta.share` in `apps/cli/src/lib/types.ts`).

- **`agents share` now auto-generates an OG cover so links unfurl (RUSH-1809).** Publishing an HTML page screenshots its own hero at 1200×630 and attaches it as `og:image` + `twitter:card`, so a `share.agents-cli.sh/<slug>` link previews as a rich card in Slack, iMessage, Twitter/X, and Discord. The capture is client-side (no central render service, ~$0): it reuses the CLI's browser detector (`findFirstInstalledBrowser`) and falls back to a managed Chromium in the Playwright/Puppeteer caches, skipping poor headless hosts; if nothing headless-capable is present the cover is skipped and the plain link still publishes. Pass `--no-cover` to opt out. Default slugs are now Notion-style **`<project>-<feature>-<hash>`** (the repo name scopes the link; a random tail keeps it unguessable). New: `apps/cli/src/lib/share/{capture,og}.ts`; wired through `publish.ts` and the `agents share` command.

- **SSH host-key pinning for credential-copy and `agents ssh` (Security, RUSH-1767).** `--copy-creds` now refuses to ship credentials to a `--host` whose SSH host key is not pinned, and `agents ssh` pins a host key (via `ssh-keyscan` into a managed `~/.agents/.cache/devices/known_hosts`) on first connect, resolving an ssh-config alias to its real HostName so the pin target and the strict-check target line up. Scope: this hardens the `--copy-creds` gate and the `agents ssh` pin path specifically; other SSH call sites still use OpenSSH default `~/.ssh/known_hosts` (wiring them onto the managed store is follow-up). Source: apps/cli/src/lib/devices/known-hosts.ts, apps/cli/src/lib/ssh-exec.ts, apps/cli/src/commands/exec.ts.

## 1.20.65

- **`agents serve --control` — the authenticated anchor for the iOS/iPadOS cockpit (RUSH-1731).** The read-only `agents serve` gains an opt-in control mode: a bearer-gated HTTP surface that adds `POST /api/run` (dispatch a headless `agents run`, local or `--host <device>`, returning a server-minted session id so the run is immediately addressable) and `POST /api/session/:id/message` (steer a running agent via `agents message`), on top of the existing `GET /api/state` + SSE `/events` — which are reused verbatim, not duplicated. It adds no execution machinery: both mutations re-invoke the same CLI paths (inheriting host offload, secrets, and detached dispatch), so a run outlives the request. Every request is verified against a token whose **SHA-256 hash only** is stored on disk (`<cache>/serve/control-tokens.json`, 0600) — the raw token is shown once at first `--control` boot and never persisted; `--bind <addr>` allows reaching it from a paired phone over the tailnet (keep it on the tailnet, never public Funnel). First step of the "Fleet Cockpit" — iOS is a control plane, not a compute worker. Source: `apps/cli/src/lib/serve/control.ts`, `apps/cli/src/lib/serve/token.ts`, `apps/cli/src/lib/serve/server.ts` (extracted `handleServeGet`), `apps/cli/src/commands/serve.ts`, `+ control.test.ts` / `token.test.ts`.

- **Live NDJSON event stream for the iOS cockpit — `GET /api/session/:id/stream` (RUSH-1732).** The authenticated control server (`agents serve --control`) can now stream a run's events to the phone as Server-Sent Events. A control-mode run is launched with `--json` and its harness output captured to a per-session NDJSON file (`<cache>/serve/streams/<id>.ndjson`); the stream route offset-tails that file — the same resumable pattern `hosts/progress.ts` uses — normalizing each line to `{type, raw}` (message / tool_use / tool_result / result / error) and emitting one SSE frame per event. Each frame's `id:` is the exact byte offset past its line, so a phone that drops mid-run reconnects with `?offset=<bytes>` or the standard `Last-Event-ID` header and loses or duplicates nothing; the stream closes on the terminal `result`/`error` event. Scope: streams anchor-local runs; streaming a `--host`-offloaded run reuses `pullRemoteLogDelta` and is a follow-up. Source: `apps/cli/src/lib/serve/stream.ts`, `apps/cli/src/lib/serve/control.ts` (`startSessionStream`, `defaultRunner` capture, `spawnDetached` stdio), `+ stream.test.ts` / `control.test.ts`.

- **Devices gain a `control` role + `agents devices pair-ios` for the iOS cockpit (RUSH-1733).** A `DeviceProfile` now carries an optional `role: 'worker' | 'control'` (absent = `worker`). A **control** device is a cockpit that drives the fleet but never runs agents itself (an iPhone/iPad running the companion app): it appears in the fleet but is skipped from the `agents sessions --active` SSH fan-out (`remote-list.ts` now bails on `isControlDevice(d)` regardless of platform, so a control node is never dialed and never burns a ConnectTimeout). The team scheduler is unaffected — it only places onto a user-declared device pool. New `agents devices pair-ios [name]` (run on the anchor) mints a bearer token for `agents serve --control` (hash-only on disk, shown once), marks a matching registered device `role=control` so the fleet stops dialing it, and prints how to point the app at the anchor over the tailnet. Source: `apps/cli/src/lib/devices/registry.ts` (`DeviceRole`, `deviceRole`, `isControlDevice`, `DeviceInput.role`), `apps/cli/src/lib/session/remote-list.ts`, `apps/cli/src/commands/ssh.ts`, `apps/cli/src/lib/devices/registry.test.ts`.

- **Project-scoped MCP servers are untrusted by default (RUSH-1776).** A cloned repo's `<repo>/.agents/mcp/*.yaml` defines an arbitrary command spawned under the agent's authority, so merely using a hostile repo no longer auto-registers or runs it. Project-scoped MCPs now enter the register/spawn path only after an explicit per-project opt-in (`agents mcp trust`, revoke with `agents mcp untrust`), recorded in a user-owned store (`~/.agents/mcp-trust.yaml`) that a cloned repo can't write to. The gate lives at the register/spawn choke point (`getMcpServersByName` → `installMcpServers` and workflow assembly) and in the sync path, and it also closes the name-collision case where an untrusted project entry could shadow a same-named user entry. `agents mcp list` now flags an untrusted project server and shows the exact command+args that would run. User- and system-scoped MCPs (`~/.agents/mcp/*`) remain trusted and unchanged. Source: `apps/cli/src/lib/mcp.ts` (`isProjectMcpTrusted`, `trustProjectMcp`, `untrustProjectMcp`, `listMcpServerConfigs`, `getMcpServersByName`), `apps/cli/src/lib/versions.ts`, `apps/cli/src/commands/mcp.ts`.

- **`agents view` surfaces Claude org identity per account — same-email installs in different orgs now read distinctly.** Two Claude installs signed into the same email (a personal Max plan and a Team seat) used to render identically. `getAccountInfo` now reads `organizationType`/`organizationName` from each version home's `.claude.json` `oauthAccount` (file-only, no keychain access, so no macOS ACL prompts); `agents view` appends an org badge inside the existing account column — `taylor@modsquad.com (ModSquad · Team)`, `taylor@turingsaas.com (Max)` — mapping known tiers (Max/Pro/Team/Enterprise/Free) and title-casing unknown future ones, showing the org *name* only for team/enterprise seats (a personal org's name is auto-generated boilerplate). The `agents use` version picker gets the same badge, and `view --json` emits the raw `organizationType`/`organizationName` fields. Companion fix: `agents view --prune` now keys duplicate detection on `accountKey` (account + org) instead of email alone, so a Max + Team install sharing one email is no longer proposed for deletion. Source: `apps/cli/src/lib/agents.ts` (`formatClaudeOrgLabel`, `accountOrgBadge`), `apps/cli/src/commands/view.ts`, `apps/cli/src/commands/versions.ts`.

- **`agents view` compact usage bars now show every blocking window — Droid gains its monthly bar (`M:`).** Droid meters usage on three windows (5-hour, weekly, monthly), but the compact row hard-filtered to session + week, so an account throttled by an exhausted month window could read as rate-limited with no bar explaining why. The compact filter now renders every blocking window (all except Claude's non-blocking per-model `sonnet_week`), matching the exact set `deriveUsageStatusFromSnapshot` already uses for the rate-limited badge. Claude, Codex, and Kimi rows are byte-identical (their fetchers emit no month window), and row alignment is unaffected. Source: `apps/cli/src/lib/usage.ts` (`formatUsageSummary`).

- **`agents apply` / `ag apply` — one-command fleet profile sync.** A new declarative command reconciles every registered device to a profile declared in the `fleet:` block of any `-f` file (default `agents.yaml`): ensure agents installed, sync config, and **propagate login** so a machine that is signed in once seeds the fleet — killing the "6 hosts × ~8 harnesses = ~48 OAuth flows" slog. `--plan`/`--dry-run` renders a device×dimension matrix (agents-cli · agents · config · login) without changing anything; `-y/--yes` skips the confirm; `--device <name>` scopes to one device; `--only agents,config,login` limits dimensions; `--no-login` skips login propagation. Login propagation captures portable credential files on the source (claude, codex, gemini, grok, kimi, opencode, droid, antigravity) and streams them to each target over the existing encrypted SSH channel (`sshExec` stdin, never shell-interpolated); an internal `--recv-auth` receiver validates + materializes them at 0600 and rejects path traversal. **Honest boundary:** macOS keychain-bound tokens (claude, antigravity) can't be read from the ACL-locked keychain — those are surfaced as a one-time manual login, never faked. `fleet:` is additive to the `Meta` schema; project `agents:` version-pins are untouched. Source: `apps/cli/src/commands/apply.ts`, `apps/cli/src/lib/fleet/{types,manifest,apply,auth-sync}.ts` (+ tests), `apps/cli/src/lib/hosts/passthrough.ts` (apply owns `--device`), `apps/cli/src/lib/types.ts` (`Meta.fleet`).

- **Hosts become first-class run/task execution options.** (1) `agents cloud run --host <name>` dispatches onto your own machines through a new `host` cloud provider — tasks visible in both `agents cloud ps` and `agents hosts ps` (one sidecar store, two views); status reconciles from the remote `.exit` with a per-target reachability memo, never guessing failure. (2) `agents run --host` gains a forwarding contract (`RUN_OPTION_FORWARDING`): `--effort --env --add-dir --timeout --strategy/--balanced/--fallback`, the `--loop` family, `--json --verbose --yes --acp` and `--` passthrough now forward to the remote; `--secrets*`, bare `--resume`, `--resume-checkpoint` reject loud before dispatch (all previously silently dropped) — locked by a commander-introspection test. (3) Devices join the host pool via a `devices` HostProvider: `agents hosts list` shows them, capability routing reaches them, `agents hosts add <device> --cap` enrolls from the device profile. (4) Routines placement: `agents routines add --run-on <host> [--run-cwd <dir>]` executes the job body on a machine (auto-pins `devices:` to the adding machine against duplicate fleet fires; daemon finalizes from the remote exit). Auto-dispatch projects can pin `provider: 'host'` + `host:`. Also fixes `--no-auto-secrets` being a local no-op (commander stores it as `autoSecrets`). Source: `apps/cli/src/lib/hosts/{run-target,remote-cmd,dispatch,registry,types}.ts`, `apps/cli/src/lib/hosts/providers/devices.ts`, `apps/cli/src/lib/cloud/{host,types,registry}.ts`, `apps/cli/src/lib/{runner,routines,auto-dispatch,auto-dispatch-provider}.ts`, `apps/cli/src/commands/{exec,cloud,routines,hosts}.ts`.
- **Fix: `agents run <agent>@<version> --host <host>` now forwards the version pin and most run flags to the remote host.** Previously the `--host` branch stripped `@version` and ignored `--strategy`, `--effort`, `--add-dir`, `--json`, `--verbose`, `--timeout`, `--yes`, and `--acp`, so the remote host applied its own defaults. The local CLI now parses `agent@version` verbatim, normalizes `--strategy`/`--balanced`, makes `--add-dir` paths remote-portable, and forwards all of these flags to the remote `agents run` invocation. `--add-dir` portability uses the same `~`/`$HOME` re-rooting that `--cwd` already uses, so a Linux remote resolves home paths against its own `/home/<user>`. Source: `apps/cli/src/lib/hosts/dispatch.ts`, `apps/cli/src/commands/exec.ts`, `apps/cli/src/lib/hosts/dispatch.test.ts`.
- **Fix: routine edits no longer rewrite the whole YAML file, so `~/.agents` stays clean and `agents repo pull` can sync routines across the fleet.** `writeJob` previously re-emitted the entire document via `yaml.stringify` on every mutation (pause/resume, `routines devices --set`, add), restyling untouched scalars — unquoting `schedule`, re-wrapping the folded `prompt` block — which left the git-backed user repo perpetually dirty. That made cross-device `agents repo pull` refuse ("uncommitted changes"), so a `devices:` pin set on one machine never reached the others and `Devices: all` routines kept firing on every box. A new `serializeJob` edits only the changed keys via the YAML Document API, preserving byte-for-byte formatting of untouched nodes; new/unparseable/non-mapping files fall back to canonical stringify. Source: `apps/cli/src/lib/routines.ts`, `apps/cli/src/lib/__tests__/routines.serialize.test.ts`.

- **`agents secrets` gains a server-independent recovery path (RUSH-1414).** Secrets recovery no longer hard-depends on `api.prix.dev`: `secrets export --to-file <path>` writes an encrypted offline bundle (AES-256-GCM via the existing `encryptForFallback`, mode `0600`) and `secrets import --from-file <path>` restores it — both gated on `AGENTS_SECRETS_PASSPHRASE`, never auto-provisioned. `secrets import --from-ssh --host <peer>` pulls a bundle straight from a fleet peer over the existing encrypted SSH channel, mirroring the `export --host` push mechanics. Source: `apps/cli/src/commands/secrets.ts` (`exportBundleToFile`, `importBundleFromFile`, `--from-ssh`), `apps/cli/src/commands/secrets.test.ts`.

- **`agents sessions <id> --json` now carries `session.todos` — checklist progress from the state engine (RUSH-1503).** The single-session JSON already surfaced `session.plan` (the last `ExitPlanMode`); it now also carries `todos` — the most-recent checklist write as `{ items: [{ content, status, activeForm }], done, total, activeForm }`, computed from the **unfiltered** transcript so it's stable regardless of any `--include` filter. This lets the Factory extension read the CLI's computed checklist instead of re-parsing raw JSONL itself. The state engine's todo extraction now also covers **Codex `update_plan`** (`plan: [{ step, status }]`), not just Claude `TodoWrite`, so `--active --json` (`ActiveSession.todos`) and the Factory Floor show live plan progress for Codex sessions too. `TodoItem`/`TodoProgress` moved from `lib/session/state.ts` to `lib/session/types.ts` (re-exported from `state.ts`) so `SessionMeta` can carry `todos` without an import cycle. Source: `apps/cli/src/lib/session/state.ts` (`extractTodoProgress`, `inferActivity`), `apps/cli/src/lib/session/types.ts` (`SessionMeta.todos`), `apps/cli/src/commands/sessions.ts` (json branch), `apps/cli/src/lib/session/{state,render}.test.ts`.

- **Plugin installs strip symlinks that escape the install root and gate OpenCode exec surfaces (Security, RUSH-1755, RUSH-1756).** Installing a plugin ran a recursive `fs.cpSync` that preserved symlinks verbatim, so a plugin carrying a symlink pointing outside its source root could redirect a follow-up managed-marker write through that link and clobber an arbitrary file on disk. Every per-agent install path — Claude/Codex marketplace, Gemini, Goose, and now Hermes — audits the copied tree and removes any symlink whose resolved target escapes both the destination and source roots, while preserving internal (in-tree) symlinks. Separately, OpenCode plugins with executable surfaces (hooks/bin/scripts/`.mcp.json`/settings) are no longer auto-enabled on sync; they require explicit `--allow-exec-surfaces` consent like the other agents. Source: `apps/cli/src/lib/plugins.ts` (`stripEscapingSymlinks`, `installHermesPlugin`, `syncPluginToVersion`), `apps/cli/src/lib/plugin-marketplace.ts` (`copyPluginToMarketplace`).

- **`agents serve` now rejects non-loopback `Host` headers (Security, RUSH-1766).** The read-only viewer binds `127.0.0.1`, but binding alone didn't stop DNS-rebinding: a remote page could point a hostname at `127.0.0.1` and drive the victim's browser to `GET /api/state`, exfiltrating uncommitted `git diff HEAD` of every worktree plus routine/cloud config. The server now serves only requests whose `Host` header is loopback (`localhost`/`127.0.0.1`/`[::1]`, any port); a missing `Host` (raw non-browser client) is still allowed, and the authenticated `--control` server is unaffected (it gates on a bearer token and is intended to be reachable off-box). Source: `apps/cli/src/lib/serve/server.ts` (`isAllowedServeHost`).

- **Secrets `daily` hold is now reliable, configurable, and diagnosable.** Three changes to the secrets-agent so a `daily`-policy bundle actually stays silent after its first Touch ID: (1) **reliability** — the auto-cache warms an already-running broker *synchronously* (gated on a real liveness ping, not a lingering socket file) instead of firing a detached worker that lost the race under load, so a short-lived reader (`agents secrets export`, a release loop) no longer exits before the cache populates and re-prompts on every read; a dead/stale-socket broker still costs the foreground read nothing (it drops to the detached path). (2) **Configurable hold cap** — a new `secrets.agent.holdMs` key in `agents.yaml` caps how long an unlocked/auto-cached bundle is held before the next re-prompt (default 7 days; e.g. `86400000` for 24h), clamped to `[1m, 30d]` and applied consistently across the value read-path, the `secrets list` metadata cache, and `unlock`. (3) **Diagnostic** — `agents secrets status` now shows the hold window, a version-skew warning (a broker on an older build gets torn down on `agents-cli-update`, wiping held bundles — the top "why did `daily` re-prompt" cause), and clear held-vs-prompts-once guidance. Source: `apps/cli/src/lib/secrets/agent.ts` (`secretsHoldMs`/`clampHoldMs`, `agentReachableSync`, load-truthful `runAgentLoadFromStdin`), `apps/cli/src/lib/secrets/bundles.ts`, `apps/cli/src/commands/secrets.ts` (`formatHoldWindow`, status diagnostic), `apps/cli/src/lib/types.ts` (`Meta.secrets.agent.holdMs`).

- **Secrets headless-read guard — background processes never raise an unwatched Touch ID prompt (#1212).** A background/headless read (scheduled routine, teammate, detached release script, the daemon sync loop, `agents run --headless`, `agents secrets export` in a pipe) now resolves broker-only and fails with an actionable "run `agents secrets unlock <b>` first" message instead of popping a Touch ID sheet on the interactive user's screen. Interactive terminal reads still prompt; file-backed bundles and non-macOS platforms are unaffected. Gated by `isHeadlessSecretsContext()` (macOS-keychain-only; false off-darwin) across every `readAndResolveBundleEnv` call site. Source: `apps/cli/src/lib/secrets/bundles.ts`, `apps/cli/src/commands/{exec,secrets,browser,ssh}.ts`, `apps/cli/src/lib/{session/sync/config,cloud/antigravity,browser/chrome,crabbox/cli,secrets/mcp}.ts`.

- **Fix: workflow routines that orchestrate subagents no longer silently no-op.** A `WORKFLOW.md` `tools:` list becomes Claude's `--tools` allowlist, which *restricts* the available built-ins. A workflow that ships a `subagents/` dir — whose files `agents run <workflow>` copies into the shared agents dir *specifically so the `Task` tool can dispatch them* — but whose `tools:` omits `Task` had its one dispatch path stripped: the orchestrator ran with no way to reach its own subagents and degenerated to a one-line no-op ("I'll wait for the completion notification") before the process exited. This bit every subagent-orchestrating workflow run headlessly (e.g. the `doc-gaps` / `blog-engine` / `iterate-until-good` routines, which showed "failed" on schedule). `agents run <workflow>` now keeps `Task` in the restricted tool set whenever the run installs ≥1 dispatchable subagent, so a `tools:` list that forgets `Task` can't strip an orchestrator's ability to orchestrate. Source: `apps/cli/src/lib/workflows.ts` (`ensureSubagentDispatchTool`), `apps/cli/src/commands/exec.ts`, `apps/cli/src/lib/workflows.test.ts`.

## 1.20.64

- **`teams` skill documents the fleet-comms surface (RUSH-1739).** The Monitoring section now points teammates-of-teams at `agents feed` (what agents need from you), `agents mailboxes` / `--watch` / `--graph` / `--between` (what agents say to each other), and the `agents message` / `agents teams message` reply path — so an operator running a team can see and answer the whole conversation. Source: `skills/teams/SKILL.md`.
- **`agents feed` reskin to shared fleet-comms visual language (RUSH-1738).** Presentation only: amber `they need you` masthead, shared `GLYPH` ask/answered markers (▲ / ✓), and `↳ ag message <id> "…"` reply hints — same product face as `agents mailboxes`. Grouping, fan-out, policy, and JSON contracts are unchanged. Source: `apps/cli/src/commands/feed.ts`.
- **`agents mailboxes` grows into the fleet-comms surface (RUSH-1737).** The overview now opens with the shared `fleet comms` masthead (`N live · M boxes`, total messages, count still awaiting delivery, last activity) plus a 24-hour hourly-volume sparkline. New views and filters, all mirrored in `--json`: `--watch`/`-f` streams cross-box messages live (`HH:MM:SS  from ─→ toLabel   text`, NDJSON with `--json`, clean Ctrl-C via an AbortController, `--since` backfills the window first, and mail addressed to the watching agent's own `AGENTS_MAILBOX_DIR` box renders as `▲ you` so an orchestrator sees its replies); `--between <a> <b>` reads one relationship as a chronological thread in both directions under an `a ⇄ b · N messages · span` header; `--graph` renders who-talks-to-whom `from └─▶ to ···· count` adjacency, busiest first; `--from`/`--to`/`--since` filter the overview recency log, the watch stream, and the graph. The `<id>` detail view, `--limit`, and the `mailbox` alias are unchanged. Built on the RUSH-1736 comms engine (`lib/comms-render.ts`, `watchMessages`). Source: `apps/cli/src/commands/mailboxes.ts`, `apps/cli/src/commands/mailboxes.test.ts`, `apps/cli/docs/06-observability.md`.
- **Routines can run a plain shell `command:` — no LLM agent required.** A routine (`JobConfig`) now accepts `command: <shell>` as a third execution mode alongside `agent:` and `workflow:` (exactly one is required). A command routine runs the shell string directly via `/bin/sh -c` (`cmd /c` on Windows) in the **real** environment (no sandbox overlay — it can `npm i -g` / `git pull`), honoring `timeout` with the same SIGTERM→SIGKILL kill the agent path uses, and writes the identical run record (`meta.json` + `stdout.log`, status from exit code) so `agents routines list/runs`, overdue tracking, and device scoping are unchanged. `agents routines add` gains `--command`. This exists because deterministic housekeeping routines (e.g. a built-in update checker) shouldn't depend on a logged-in agent, burn tokens, or gamble on account rotation — a real failure mode where the rotation dispatched an update-check to a logged-out agent version and the run died on "Not logged in." Source: `apps/cli/src/lib/routines.ts` (`JobConfig.command`, `validateJob`), `apps/cli/src/lib/runner.ts` (`executeCommandJob{Foreground,Detached}`), `apps/cli/src/lib/daemon.ts`, `apps/cli/src/commands/routines.ts`.
- **Shared fleet-comms rendering and mailbox streaming (RUSH-1736).** Adds the common masthead, glyph, sparkline, aggregation, hourly-volume, and route-graph helpers used by `agents mailboxes` and `agents feed`, plus an abortable spool watcher that emits each new box/message pair once without replaying history unless backfill is requested. Source: `apps/cli/src/lib/comms-render.ts`, `apps/cli/src/lib/mailbox.ts`.
- **Fix: Claude usage bars now render on Linux — so `agents view claude --host <linux-box>` shows them too.** `agents … --host X` runs the whole command on the remote box over SSH, so `agents view` executes on Linux there. Claude usage needs a live OAuth-token fetch, but `loadClaudeOauth` read the token *only* from the OS keychain — which on macOS falls through to `/usr/bin/security` and reads Claude Code's real login-keychain entry, while on Linux it routed to agents-cli's own secret store and never found the token (Claude Code on a headless Linux box writes its OAuth to the plaintext `<home>/.claude/.credentials.json` instead). The token load now falls back to that file when the keychain has no item — the same keychain-then-`.credentials.json` order `readClaudeCredentialsBlob` (`cloud/rush.ts`) already uses — so the live usage fetch succeeds and the bars render. Account + plan were unaffected because those come from the plaintext `.claude.json`. Codex (session logs), Kimi (`kimi-code.json`), and Droid (`auth.v2.file`) were already file-based and unaffected. Source: `apps/cli/src/lib/usage.ts` (`loadClaudeOauth`, `parseClaudeOauthPayload`), `apps/cli/src/lib/__tests__/usage.test.ts`.
- **`agents mailboxes` — a read-only window onto the agent mailbox spool.** The mailbox spool (`~/.agents/.history/mailbox/<id>/{inbox,processing,consumed}`) is the transport under `agents message` / `agents feed` / `agents teams message`, but until now it had no inspection surface — `agents mailboxes` failed with `unknown command`. The new command lists every box with pending/total counts, last activity, and a live-session label when the owning agent is running, then renders a recency-ordered log of the messages that flowed **between** agents — including already-`consumed` (delivered) mail — so an operator can see agent-to-agent chatter after the fact, not just what a running agent is currently blocked on. `agents mailboxes <id>` shows one box in full across all three buckets; `--json` for machine output, `-n/--limit` bounds the overview log; `mailbox` is an alias. Adds `listBoxes()` (enumerate boxes, consistent with the GC's validity contract) and `readBox()` (read all buckets, tagged by state, non-destructive — unlike `peek`, includes `consumed/`) to the mailbox lib. Source: `apps/cli/src/commands/mailboxes.ts`, `apps/cli/src/lib/mailbox.ts`, `apps/cli/src/lib/mailbox.test.ts`, `apps/cli/src/lib/startup/command-registry.ts`, `apps/cli/src/index.ts`.
- **`agents usage` now reports live usage for Droid and Kimi, matching `agents view`.** Both agents already render live usage bars in `agents view` — Droid via `GET https://api.factory.ai/api/billing/limits` (decrypted from `~/.factory/auth.v2.file`; 5-hour/weekly/monthly rolling windows), Kimi via its `/usages` API — but the standalone `agents usage` command still marked them "does not publish usage data" because its supported-agent set had drifted from the live sources. `agents usage droid` / `agents usage kimi` now show the same live windows with reset times, and the observability docs reflect that Droid exposes live usage. Source: `apps/cli/src/commands/usage.ts`, `apps/cli/docs/06-observability.md`.
- **`agents devices list` now shows live resource headroom — which box has room right now.** The list used to show only name / platform / address / reachability. It now probes every reachable device in parallel (one SSH round-trip each: `uptime` + `vm_stat`/`/proc/meminfo` + `nproc`/`hw.ncpu`), bounded by a per-probe timeout so a slow or wedged node degrades to `—` instead of hanging the table, and the local machine is measured directly (no self-SSH). Each row gains **normalized load** (`load1 / cores`), **memory pressure %**, and an **idle / light / busy / loaded** headroom badge (colored by the worse of load and memory); a trailing **fleet-capacity summary** aggregates total cores and free/total RAM (`164 cores · 421G free / 518G RAM (81% free) across 10 reachable devices`). `--full` adds per-device core count and free/total memory; `--no-stats` restores the instant registry-only view; `--json` stays registry-only and fast (the path the Factory extension polls). This is the utilization signal the teammate scheduler doesn't yet consume. Source: `apps/cli/src/lib/devices/health.ts`, `apps/cli/src/commands/ssh.ts`, `apps/cli/src/lib/devices/health.test.ts`.
- **Portable session export / import over the SSH fleet (RUSH-1710, RUSH-1711, RUSH-1712).** `agents sessions export` bundles selected sessions into a portable, self-describing archive and `agents sessions import` restores one — the user-driven successor to background R2/CRDT sync for the durable-archive / hand-off case (no daemon, no bucket). A bundle is NDJSON (a header line + one line per transcript file) so it pipes over SSH with no external archiver, stays greppable, and carries a per-file AES-256-GCM envelope under `--encrypt`; secrets are redacted by default (`--no-redact` to keep them). Selection reuses the `agents sessions` flags (`--since`, `-n/--limit`, `--all`, `-a/--agent`); dir-shaped sessions (Kimi) carry all their files. Import places each session at the cross-machine mirror keyed by its origin machine, so it shows up in `agents sessions` tagged with that machine and never overwrites your own local sessions; dedup is byte-exact (`--overwrite` to replace conflicts, `--dry-run` to preview). Multi-device transfer rides the existing SSH transport — `agents sessions import --from-host <h>` (and `export --host <h>`) run the export on the peer and stream the bundle back, equivalent to `agents ssh <h> 'agents sessions export --stdout' | agents sessions import -`; no R2, no daemon. Source: `apps/cli/src/lib/session/bundle.ts`, `apps/cli/src/lib/session/remote-bundle.ts`, `apps/cli/src/commands/sessions-export.ts`, `apps/cli/src/commands/sessions-import.ts`.
- **SSH-first recall is now the documented default; R2/CRDT background sync is demoted to an opt-in backup (RUSH-1714).** `agents sessions --host <box>` reads any online peer's sessions live (no sync, always current) and covers almost all cross-machine recall; export/import handles the offline / hand-off case. Background sync (`agents sessions sync`) stays an opt-in beta, off by default — a passive mirror for when you want offline machines' sessions to appear automatically, not the primary mechanism. Documented in `apps/cli/docs/05-sessions.md`.
- **Session sync now round-trips directory-shaped sessions (Kimi, Grok) instead of silently dropping the conversation (RUSH-1466).** A session used to be assumed to be one transcript file, so for agents that store a session as a *directory* — Kimi's `session_<id>/state.json` + `agents/<name>/wire.jsonl` + per-tool `tasks/*.json`, Grok's `<uuid>/events.jsonl` — only a single file survived and the actual conversation was never synced. `SyncAgentSpec` gains `dirShaped`/`exts`/`fileFilter`/`mergeableExts`; `listLocalTranscripts` now returns every file of a session (`LocalTranscript.files[]`), each stored under its own R2 sub-key and mirrored at its own relative path. Per-file reconciliation splits by kind: append-only logs (`wire.jsonl`) take the CRDT G-Set union; mutable blobs (`state.json`, task sidecars) take last-writer-wins by `(lastTs, hash)`, where a blob's `lastTs` is derived from its file mtime (blobs carry no event timestamp, so without this LWW degraded to an arbitrary highest-hash-wins that could keep a stale copy). The manifest entry shape is backward-compatible (`ManifestEntry | ManifestEntry[]`) so older CLIs read file-shaped entries byte-identically. Source: `apps/cli/src/lib/session/sync/agents.ts`, `apps/cli/src/lib/session/sync/sync.ts` (`deriveLastTs`, `resolveMirrorWrite`), `apps/cli/src/lib/session/sync/manifest.ts`, and their `*.test.ts`.

## 1.20.63

- **Built-in routines: the daemon now fires routines shipped in the system repo.** Routine discovery (`listJobs`/`readJob`) unions a new system layer — `~/.agents/.system/routines/*.yml` (shipped via `gh:phnx-labs/.agents-system`, which every install pulls at `agents setup`) — under the existing project and user layers. Ordering is project > user > system with first-seen-wins, so a routine shipped as a built-in fires for every install, while a user routine of the same name overrides it and a user copy with `enabled: false` disables it. The daemon (which loads with no `cwd`) sees user + system routines; `writeJob` still only ever writes to the user layer, so built-ins are never mutated in place. This is what lets a routine like `check-updates` ship to all users centrally. Source: `apps/cli/src/lib/state.ts` (`getSystemRoutinesDir`), `apps/cli/src/lib/routines.ts`, `apps/cli/src/lib/routines.test.ts`.

- **`--host` / `--device` work across virtually all first-class subcommand groups (RUSH-1691).** Previously only a handful of groups accepted the flags; `agents repos list --host yosemite-s0` (and the same with `--device`) died with commander's raw `unknown option`. Remote routing now covers `repos`/`repo`, status/inspect groups, config/resource groups (`plugins`, `skills`, `hooks`, `sync`, …), `teams`, `routines`, and more via the central `maybeRunOnHost` allowlist. Commands with their own richer host handling (`run`, `sessions`, `feed`, `computer`, `secrets`, `logs`) still fall through to their actions. Groups with no remote semantics reject the flag with a clear message instead of `unknown option`. Self-host targets strip the routing flags before the local command parses so fall-through never trips an unregistered option. Source: `apps/cli/src/lib/hosts/passthrough.ts`, `apps/cli/src/commands/repo.ts`, `apps/cli/docs/{00-concepts,hosts}.md`.
- **Subagent integrations are now a declarative capability registry — one table entry per agent instead of copy-pasted `else if (agent === …)` arms across six files (RUSH-1698).** Wiring subagents for an agent used to mean editing the same near-identical per-agent branches in `subagents.ts` (install / list / remove-from-agent / orphan-diff / soft-delete), the staleness writer, and the staleness detector — roughly O(agents × operations), and the top source of merge conflicts when new-agent PRs landed in parallel. All of it now iterates a single `SUBAGENT_TARGETS` table (`apps/cli/src/lib/subagents-registry.ts`) keyed by agent, each entry declaring the target dir, on-disk layout (`flat-file` / `dir-file` / `dir-copy`), transform, and ownership marker; the install/list/detect/orphan/remove engine is generic with zero per-agent branches. Genuinely-bespoke agents keep a handler in the same table (Kimi: two files per subagent + a managed parent index). Adding a standard integration is now one registry entry plus the `subagents` capability gate — the writer, detector, and `subagents.ts` need no new arm, and a test pins `Object.keys(SUBAGENT_TARGETS)` to `capableAgents('subagents')` so the flag and the shape can never drift. This also closed real latent gaps the old hand-written chains had left inconsistent: `droid` (synced to `.factory/droids/` but absent from every `subagents.ts` function, so its subagents could not be listed, pruned, or removed), and `copilot`/`codex` (present in some operations, missing from others) are now uniformly install/list/remove-capable. Behavior for every already-supported agent is unchanged (verified: full subagent + versions suites green, byte-identical trash/list semantics per layout). A documented **integration tier list** (`apps/cli/docs/subagents.md`) scopes future "wire X" tickets by importance instead of treating every agent equally. Source: `apps/cli/src/lib/subagents-registry.ts`, `apps/cli/src/lib/subagents.ts`, `apps/cli/src/lib/staleness/{writers,detectors}/subagents.ts`, `apps/cli/src/lib/subagents-registry.test.ts`, `apps/cli/docs/subagents.md`.
- **Signed webhook ingress for routines via Tailscale Funnel (RUSH-1456, RUSH-1459, RUSH-1460, RUSH-1461).**
  Routine triggers now understand both GitHub and Linear event sources, including
  Linear action/team/label filters. `agents webhook serve --secrets-bundle <name>`
  exposes signed localhost endpoints at `/hooks/github` and `/hooks/linear` with
  raw-body HMAC verification, Linear timestamp checks, duplicate delivery
  suppression, and rate limiting. `agents funnel status/up` wraps the allowed
  Tailscale Funnel ports through the existing SSH/device path so a webhook
  receiver can be exposed without hand-written SSH commands. Source:
  `apps/cli/src/lib/routines.ts`, `apps/cli/src/lib/triggers/webhook.ts`,
  `apps/cli/src/commands/routines.ts`, `apps/cli/src/commands/webhook.ts`,
  `apps/cli/src/commands/funnel.ts`, `apps/cli/src/lib/funnel.ts`.
- **Cross-machine session sync verified end-to-end + documented (RUSH-1464).** The R2/CRDT session-sync beta (Claude + Codex) is now signed off across the full matrix: a machine push with a read-write R2 token uploads with zero errors (the read-only-token 403 from #412 is resolved), a second machine pulls and folds those sessions into its own list, CRDT G-Set union converges byte-identically regardless of sync order, and a machine that fell behind catches up automatically when it returns (a grown session's manifest hash no longer matches the puller's recorded signature, forcing a re-fetch + re-merge). Ships the previously-missing docs: a "Cross-machine sync (R2 + CRDT)" section in `apps/cli/docs/05-sessions.md` covering the single-writer prefix layout, manifest + mirror model, CRDT convergence, client-side AES-256-GCM encryption, the opt-in beta gate, and the `r2.backups` credential bundle (including the read+write scope requirement). Verification only — no runtime change. Source: `apps/cli/docs/05-sessions.md`.
- **Guided session-sync provisioning in `agents setup` and `agents sessions sync --setup` (RUSH-1468).** Joining a machine to the cross-machine session-sync fabric no longer requires hand-running four `agents secrets add r2.backups …` commands. A new interactive step mints the `r2.backups` bundle (R2 account/bucket/access-key/secret + a generated `R2_SYNC_ENC_KEY`), probes read+write connectivity with a throwaway object, and opts the machine into the `session-sync` beta on success. The first machine mints and prints the shared encryption key; every other machine pastes it so the whole fabric shares one key (an existing key is reused, never overwritten — overwriting would orphan peers' encrypted transcripts). `agents setup` offers it opt-in (default No, never blocks setup); `agents sessions sync --setup` runs it explicitly and can re-show the shared key. Source: `apps/cli/src/lib/session/sync/provision.ts`, `apps/cli/src/lib/session/sync/provision.test.ts`, `apps/cli/src/commands/sync-provision.ts`, `apps/cli/src/commands/setup.ts`, `apps/cli/src/commands/sessions-sync.ts`.
- **`agents fleet` alias + fleet-wide rollout (RUSH-1632).** `fleet` is an alias
  for `devices`. New subcommands `update [version]` and `run <cmd…>` roll out
  across every online device with a per-device result table. Source:
  `apps/cli/src/commands/ssh.ts`, `apps/cli/src/lib/devices/fleet.ts`.
- **`agents hosts stop <id>` (alias `kill`) terminates a detached host run from the origin machine (RUSH-1360).**
  Sends SIGTERM to the remote process group, writes exit `143` only when a live
  group was signaled (or no `.exit` existed), and keeps the remote log for
  `agents hosts logs <id>`. Source: `apps/cli/src/lib/hosts/dispatch.ts`,
  `apps/cli/src/commands/hosts.ts`.
- **Fix: mailbox GC actually archives expired messages on live boxes (RUSH-1611).**
  The live-box branch of `gcMailbox` only incremented `messagesDroppedExpired`
  without moving the file to `consumed/`, so `agents feed --dispatch` could report
  drops while leaving expired messages in `inbox/`/`processing/`. GC now reuses
  `sweepExpired` (the same path as drain/peek). Source: `apps/cli/src/lib/mailbox-gc.ts`.
- **Fix: Antigravity sign-in detection on Linux when the OAuth grant lives in Secret Service (RUSH-1329).** `agy` uses the Go keyring library, which prefers libsecret (gnome-keyring) over the file fallback whenever a Secret Service daemon is running — so `~/.gemini/antigravity-cli/antigravity-oauth-token` may be absent even when the user is signed in. After the file check, `getAccountInfo` now probes `secret-tool lookup service gemini username antigravity` (exit 0 = present; stdout discarded), mirroring the macOS `security find-generic-password` probe from #506. Missing `secret-tool`, locked collections, and timeouts all read as signed out. Opt out with `AGENTS_NO_KEYCHAIN_PROBE=1`. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/agents.test.ts`.
- **Client-side (zero-knowledge) encryption of session transcripts before R2 upload (RUSH-1463).** Transcripts carry secrets, tokens, and absolute file paths; R2's server-side encryption uses Cloudflare's key, so anyone with bucket-read access (or Cloudflare) could read them as plaintext NDJSON. `agents sessions sync` now seals each transcript BODY client-side with AES-256-GCM before upload and decrypts on pull, so R2 only ever stores ciphertext. The 32-byte key is a new `R2_SYNC_ENC_KEY` in the `r2.backups` bundle — shared across the sync fabric (every machine derives the identical key) and deliberately separate from the R2 access key so rotating the token never orphans encrypted objects. CRDT identity stays over plaintext (the manifest hash is cleartext; pull decrypts before the G-Set union), so cross-machine merge is unaffected. Pull transparently reads legacy plaintext objects (migration-safe); a push with no key configured still uploads but emits a loud per-cycle warning. A new `R2_ENDPOINT` override points sync at any S3-compatible store (MinIO/other providers), which is also how the flow is verified end-to-end without live R2. Source: `apps/cli/src/lib/session/sync/transcript-crypto.ts`, `apps/cli/src/lib/session/sync/transcript-crypto.test.ts`, `apps/cli/src/lib/session/sync/sync.ts`, `apps/cli/src/lib/session/sync/config.ts`, `apps/cli/src/commands/sessions-sync.ts`, `apps/cli/src/lib/daemon.ts`.
- **Extend session sync to Droid, Grok, Kimi, and OpenCode (RUSH-1467).** `agents sessions sync` now includes these four agents in its upload/download matrix. `SyncAgentSpec` gains an optional `ext` field so agents with non-`.jsonl` transcript files (e.g., Kimi `state.json`) are walked correctly. Droid `.jsonl` rollouts, Grok `events.jsonl` streams, and Kimi `state.json` metadata files round-trip through the R2 mirror; OpenCode is slotted in `SYNC_AGENTS` but remains a placeholder because its sessions live in a SQLite DB and still require an SQLite-to-JSONL export step. Source: `apps/cli/src/lib/session/sync/agents.ts`, `apps/cli/src/lib/session/sync/agents.test.ts`, `apps/cli/src/commands/sessions-sync.ts`.
- **`agents repos` is canonical (`repo` alias); push/pull echo the resolved target; push no longer no-ops when clean-but-ahead; pull rebases on diverge (RUSH-1454).** Help now prints `Usage: agents repos …`. Push/pull report `user (~/.agents → origin/main): …` instead of the bare alias. `commitAndPush` still `git push`es when the tree is clean but local is ahead of origin (previously returned success without pushing). `pullRepo` uses `git pull --rebase` so divergent branches reconcile instead of failing with a raw git error. Source: `apps/cli/src/commands/repo.ts`, `apps/cli/src/lib/git.ts`, `apps/cli/src/lib/startup/command-registry.ts`.
- **`agents run --host <name> --copy-creds` provisions runtime credentials on a persistent host (RUSH-1608).**
  Reuses the `--lease` credential path (`resolveClaudeCredentialsBlob` + the
  `~/.claude/.credentials.json` bootstrap) but makes copying tokens to a
  persistent host strictly opt-in per run. The user picks runtimes, sees a
  consent prompt naming accounts and the Claude OAuth token, and the files are
  shredded after the run. Source: `apps/cli/src/commands/exec.ts`,
  `apps/cli/src/lib/hosts/dispatch.ts`, `apps/cli/src/lib/hosts/credentials.ts`,
  `apps/cli/src/lib/hosts/credentials.test.ts`.

## 1.20.62

- **Browser downloads land in a known per-profile dir; profile data is consolidated.** A browser profile is now one self-contained tree under `~/.agents/.cache/browser/<profile>/`: `chrome-data/`, `downloads/`, and `sessions/<task>/` (screenshots, PDFs, recordings). Previously downloads had no configured destination — the CLI only set the download dir when the agent explicitly ran `browser download --path`, so absent that call a download fell to Chromium's own default (for an attached user browser like comet, wherever *that* browser was last configured), which is how downloads escaped into random locations. The service now sets the profile's `downloads/` dir browser-global at connect time (both fresh launch and every attach path), so downloads always land somewhere agents-cli controls; `browser download --path` becomes an optional override (omit it to use the profile default) and reports the resolved path. Screenshots/PDFs/recordings moved from the old GLOBAL `browser/sessions/<task>/` root to the per-profile `browser/<profile>/sessions/<task>/`, with a one-shot migration that folds existing captures into the owning profile (attributed via each profile's `tasks.json`; unattributable captures go to a `_legacy` bucket). New `agents browser sessions [--profile <name>] [--open latest|<file>] [--json]` lists a profile's captures + downloads, aliased as `agents sessions --browser`. Source: `apps/cli/src/lib/browser/{profiles,service,ipc,sessions-list}.ts`, `apps/cli/src/lib/migrate.ts`, `apps/cli/src/commands/{browser,sessions}.ts`.
- **Wire Goose commands support (RUSH-1572).** `agents` now syncs slash commands to Goose as recipe YAML files under `~/.config/goose/commands/<name>.yaml`, each registered in `~/.config/goose/config.yaml` under a `slash_commands: [{ command, recipe_path }]` array (Goose has no native slash-command file format — a slash command IS a recipe). The command recipes live in a dir distinct from the workflow recipes dir (`~/.config/goose/recipes/`) so the workflow detector never treats a command recipe as a workflow. Registration is a read-modify-write that preserves every other `config.yaml` key (`mcp_servers`, `extensions`, …) and other `slash_commands` entries, and removal soft-deletes the recipe + unregisters the entry. Flip Goose's `commands` capability and add `goose` branches to install/list/match/remove, the staleness commands writer, and doctor-diff, backed by a new `goose-commands.ts` module + a `markdownToGooseRecipe` converter. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/goose-commands.ts`, `apps/cli/src/lib/commands.ts`, `apps/cli/src/lib/convert.ts`, `apps/cli/src/lib/staleness/writers/commands.ts`, `apps/cli/src/lib/doctor-diff.ts`.
- **Fix: Hermes plugin sync no longer disables a plugin the user explicitly enabled.** The plugin install path (RUSH-1688) unconditionally forced `plugins.enabled` to the exec-surface trust verdict on every sync. An ordinary un-flagged background re-sync computes `enable=false` for a plugin with hooks/tools, so it stripped that plugin from the `~/.hermes/config.yaml` allowlist — clobbering a plugin the user deliberately enabled with `--allow-exec-surfaces`. The install path now enables only when trusted and never down-toggles (matching the marketplace flow's add-if-trusted semantics); removal still unregisters explicitly. Source: `apps/cli/src/lib/plugins.ts`.
- **Wire Goose subagents support (RUSH-1573).** `agents` now syncs subagents to Goose as recipe YAML files under `~/.config/goose/agents/<name>.yaml` — Goose has no dedicated subagent format, so a named subagent IS a recipe (goose auto-discovers `~/.config/goose/agents/` and delegates to them by name in autonomous mode). `transformSubagentForGoose` emits the same recipe schema agents-cli already uses for Goose workflow recipes (`version`/`title`/`description`/`instructions`/`prompt`, plus optional `settings.goose_model`). Flip Goose's `subagents` capability and wire the install/remove/list/orphan/version-remove branches plus the staleness subagents writer and detector. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/subagents.ts`, `apps/cli/src/lib/staleness/{writers,detectors}/subagents.ts`.

- **Wire ForgeCode commands and subagents support (RUSH-1689, RUSH-1690).** `agents` now syncs slash commands to ForgeCode as Markdown files under `~/.forge/commands/<name>.md` (previously ForgeCode had `commands: false` and received commands only as skills), and named subagents as Markdown-with-frontmatter definitions under `~/.forge/agents/<name>.md` (same `color`-less shape as Droid/Copilot/Cursor, so `transformSubagentForForge` aliases `transformSubagentForDroid`). Flip ForgeCode's `commands`/`subagents` capabilities, set `commandsDir`, add the subagent transform plus install/remove/list/orphan/version-remove branches, and register the subagents writer + detector. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/subagents.ts`, `apps/cli/src/lib/staleness/{writers,detectors}/subagents.ts`.
- **Wire allowlist (permissions) support for OpenClaw (RUSH-1570).** OpenClaw gates at TOOL granularity only, so permission sync maps just **blanket** (whole-tool) rules into `~/.openclaw/openclaw.json` `tools.alsoAllow` (allow) / `tools.deny` (deny): `bash → exec`, `read → read`, `write`/`edit → write`, `webfetch → web_fetch`, `websearch → web_search`. Sub-command/path/domain rules (`Bash(git:*)`, `Write(secrets/**)`, `WebFetch(domain:x)`) have no tool-level equivalent and are skipped — coarse-mapping a specific deny to a whole tool would wrongly gate every use of that tool. The absolute `tools.allow` list is never touched, and all other keys (`mcp`, `exec`, `agents`, …) are preserved on read-modify-write. Flip OpenClaw's `allowlist: true`, add `convertToOpenClawFormat` + the `openclaw` branch in `applyPermissionsToVersion`, register the config path and staleness detector. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/permissions.ts`, `apps/cli/src/lib/resources/permissions.ts`, `apps/cli/src/lib/staleness/detectors/permissions.ts`.
- **Wire subagents support for Cursor CLI (RUSH-1388).** cursor-agent loads custom subagents as Markdown with YAML frontmatter under `~/.cursor/agents/*.md` (project-scoped `.cursor/agents/` also supported natively), same shape as Claude/Droid/Copilot minus the `color` field, gated at `>= 2026.1.22` (cursor-agent's CalVer build tag for Cursor 2.4). Flip Cursor's `subagents`, add `transformSubagentForCursor` (alias of `transformSubagentForDroid`), and wire the install/remove, list, orphan-detection, writer, and detector paths. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/subagents.ts`, `apps/cli/src/lib/staleness/{writers,detectors}/subagents.ts`.
- **Wire hooks support for Hermes (RUSH-1687).** `agents` now registers central hooks into Hermes Agent's `~/.hermes/config.yaml` under a `hooks:` block (YAML, ≥ 0.11.0). The registrar read-modify-writes that shared config so sibling keys like `mcp_servers` survive, maps canonical events to Hermes' snake_case lifecycle names (`SessionStart→on_session_start`, `SessionEnd→on_session_end`, `PreToolUse→pre_tool_call`, `PostToolUse→post_tool_call`, `SubagentStop→subagent_stop`, `UserPromptSubmit→pre_llm_call`, `Stop→on_session_finalize`), and clamps each hook's timeout to 300s (default 60s). Managed entries are re-synced idempotently while user-authored hooks are preserved. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/hooks.ts`, `apps/cli/src/lib/staleness/writers/hooks.ts`.

## 1.20.61

- **Detect OpenCode sign-in state so `agents view` stops mislabeling a logged-in install as "not signed in."** `getAccountInfo` had no `opencode` case, so it fell through to `signedIn: false` and every row printed "(not signed in — run opencode to log in)" even with a live login. It now reads OpenCode's `auth.json` (`$XDG_DATA_HOME/opencode/auth.json`, defaulting to `~/.local/share/opencode/auth.json` on every platform — `xdg-basedir` does not special-case macOS), validates each provider entry against its `oauth`/`api`/`wellknown` credential shape, and reports the account as signed in with the non-secret provider ids surfaced as the account label (e.g. `id:muse-spark`). Credential secrets (`access`/`refresh`/`key`/`token`) are only inspected for presence — never read into any display or JSON output. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/agents.test.ts`.
- **Wire Antigravity workflows support (RUSH-1580).** `agents` now syncs workflows to Antigravity as markdown files with the required `description` frontmatter plus an `agents_workflow` ownership marker, invocable as `/<name>` slash commands. Antigravity workflows are the one non-version-isolated target: `agy` scans a single shared, HOME-global `~/.gemini/config/global_workflows/` at startup (a real home directory, never symlinked per version — verified via strace of `agy`), so the writer and detector both resolve that shared dir for every installed version instead of a per-version home. Gated at `>= 1.0.6`. The ownership marker prevents overwriting or removing user-authored workflows of the same name. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/workflows.ts`, `apps/cli/src/lib/staleness/detectors/workflows.ts`.

## 1.20.60

- **Fix Goose skill sync status for its native central-storage path.** `agents skills list goose@<version>` now reports skills under `~/.agents/skills/` as installed instead of falsely requiring a per-version `.config/goose/skills/` copy that Goose never reads. Source: `apps/cli/src/lib/skills.ts`.
- **Correct the documented `auto` and ACP `skip` semantics.** The README and bundled `run` skill now distinguish Kimi's interactive `--auto` from its already-auto-approved headless `-p` path, document Droid's native `--auto high`, and explain that ACP `skip` prefers `allow_always` but falls back to the first permission option offered by the server. Documentation only; runtime behavior is unchanged. Source: `README.md`, `skills/run/SKILL.md`.
- **Wire Antigravity subagents and Kimi workflow sync (RUSH-1548, RUSH-1581).** Antigravity now receives subagents as custom-agent Markdown under `~/.gemini/config/agents/<name>/agent.md` with the `>= 1.0.16` version gate enforced during sync. Kimi receives workflows as managed `type: flow` skills under `.kimi-code/skills/<name>/SKILL.md`, using the canonical slug as the flow name and an `agents_workflow` marker so native user-owned flows are not overwritten or removed. Antigravity workflows are wired separately in RUSH-1580 (they target a shared HOME-global dir, not a version home). Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/subagents.ts`, `apps/cli/src/lib/workflows.ts`.
- **Release retries rebuild the exact merged, CI-tested release tree even after `main` advances.** A registry/auth failure after the release PR merged previously stranded that version because the catch-up guard required the release merge to remain current `main`. The local release script now validates the original PR head and full green matrix, verifies the SHA-pinned keychain helper, rebuilds the unpinned menu-bar helper from historical source in a detached temporary worktree, rejects mismatched remote tags, and tags/publishes that exact merge without including later commits. Source: `apps/cli/scripts/release.sh`.
- **Wire Gemini plugins/subagents and Goose workflows/allowlists.** Gemini now syncs plugin bundles as Gemini extensions (`.gemini/extensions/<name>/gemini-extension.json`) from CLI 0.8.0+ and subagents as `.gemini/agents/*.md` from CLI 0.36.0+. Goose now syncs workflows as recipe/subrecipe YAML under `.config/goose/recipes/` and permission groups into `.config/goose/permission.yaml`. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/plugins.ts`, `apps/cli/src/lib/subagents.ts`, `apps/cli/src/lib/workflows.ts`, `apps/cli/src/lib/permissions.ts`. (RUSH-1568, RUSH-1569, RUSH-1574, RUSH-1582)
- **Wire Gemini permissions/allowlist support (RUSH-1567).** Gemini permission groups now sync Bash allow/deny rules into `.gemini/settings.json` as `tools.core` / `tools.exclude` entries with per-command `ShellTool(...)` patterns; non-Bash canonical permissions remain unsupported by Gemini's native tool grammar and are skipped. Flip `allowlist: true`, register the permission writer/detector through the capability table, and replace the dormant legacy `tools.allowed` serializer. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/permissions.ts`, `apps/cli/src/lib/resources/permissions.ts`, `apps/cli/src/lib/staleness/detectors/permissions.ts`.
- **Fix: `agents run <agent>@<version> --host <host>` now forwards the version pin and most run flags to the remote host.** Previously the `--host` branch stripped `@version` and ignored `--strategy`, `--effort`, `--add-dir`, `--json`, `--verbose`, `--timeout`, `--yes`, and `--acp`, so the remote host applied its own defaults. The local CLI now parses `agent@version` verbatim, normalizes `--strategy`/`--balanced`, makes `--add-dir` paths remote-portable, and forwards all of these flags to the remote `agents run` invocation. `--add-dir` portability uses the same `~`/`$HOME` re-rooting that `--cwd` already uses, so a Linux remote resolves home paths against its own `/home/<user>`. Source: `apps/cli/src/lib/hosts/dispatch.ts`, `apps/cli/src/commands/exec.ts`, `apps/cli/src/lib/hosts/dispatch.test.ts`.
- **Fix: routine edits no longer rewrite the whole YAML file, so `~/.agents` stays clean and `agents repo pull` can sync routines across the fleet.** `writeJob` previously re-emitted the entire document via `yaml.stringify` on every mutation (pause/resume, `routines devices --set`, add), restyling untouched scalars — unquoting `schedule`, re-wrapping the folded `prompt` block — which left the git-backed user repo perpetually dirty. That made cross-device `agents repo pull` refuse ("uncommitted changes"), so a `devices:` pin set on one machine never reached the others and `Devices: all` routines kept firing on every box. A new `serializeJob` edits only the changed keys via the YAML Document API, preserving byte-for-byte formatting of untouched nodes; new/unparseable/non-mapping files fall back to canonical stringify. Source: `apps/cli/src/lib/routines.ts`, `apps/cli/src/lib/__tests__/routines.serialize.test.ts`.
- **`agents sessions --active --json` now carries live plan progress (RUSH-1380).** The state engine parses the latest `TodoWrite` off the transcript tail into `ActiveSession.todos` (`{ items: [{ content, status, activeForm? }], done, total, activeForm }`), and the live preview verb reads `Plan N/M: <current step>` instead of a bare "TodoWrite". This lets consumers (the Factory Floor) show an N/M pill + checklist for every session — including remote / device-dispatched agents that have no local tool-call stream. Source: `apps/cli/src/lib/session/state.ts` (`extractTodoProgress`, `inferActivity`), `apps/cli/src/lib/session/active.ts` (`ActiveSession.todos`, `applyState`), `apps/cli/src/lib/session/parse.ts` (`summarizeToolUse`).

## 1.20.59

- **Fix: remote secrets now choose the Windows PowerShell wrapper from the original `--host` name, not the resolved `user@ip` SSH target.** Inline enrolled Windows hosts resolve to address-based SSH targets, but the OS registry is keyed by the host name; `agents secrets view/list/exec --host <windows>`, `agents run --secrets bundle@<windows>`, and remote secrets unlock/export paths now pass that original name into command construction so Windows hosts no longer fall back to `bash -lc`. Source: `apps/cli/src/lib/secrets/remote.ts`, `apps/cli/src/commands/secrets.ts`, `apps/cli/src/commands/exec.ts`. (RUSH-1431)
- **Wire Droid skills support (RUSH-1397).** Droid loads skills from `.factory/skills/` (since 0.26.0). Flip `skills: { since: '0.26.0' }`, register generic skills writer/detector. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/__tests__/capabilities.test.ts`.
- **Wire skills support for Goose CLI (RUSH-1394).** Goose reads skills directly from `~/.agents/skills/` via the Summon extension (block-goose-cli >= 1.25.0). Flip `skills: { since: '1.25.0' }`, register generic skills writer/detector. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/staleness/writers/commands.ts`.
- **Wire Droid allowlist support (RUSH-1396).** Droid stores allow/deny in `.factory/settings.json` (`commandAllowlist`/`commandDenylist`). Flip `allowlist: true` since 0.57.5, add `convertToDroidFormat`, wire writer/detector. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/permissions.ts`.
- **Wire Codex permissions/allowlist support (RUSH-1566).** Codex stores allow/deny in `.codex/config.toml` (`approval_policy`, `sandbox_mode`). Flip `allowlist: true` since 0.128.0, add `convertToCodexFormat`, wire writer/detector. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/permissions.ts`.
- **OpenCode permissions write to the loaded config path (RUSH-1623).** Global config is `~/.config/opencode/opencode.jsonc` (not `~/.opencode/`); project config is `opencode.jsonc` at the project root. Source: `apps/cli/src/lib/permissions.ts`, `apps/cli/src/lib/agents.ts`.
- **Catch-up publishes now require the exact CI-tested release tree and its full green matrix.** A package version already present on `main` no longer counts as release validation by itself: `release.sh` resolves the merged `release/v<version>` PR, requires its merge commit to be current `main`, fetches the PR head that ran CI, requires that head tree to equal current `main`, and rechecks every expected CI context before publishing. This closes the path that let 1.20.58 reach npm before its tag-triggered Windows matrix exposed failures. Source: `apps/cli/scripts/release.sh`.
- **Windows release validation now matches portable path behavior.** Home-relative project paths normalize native separators to `/` before they are stored as `~/…`, and the systemd-manifest and remote-shell assertions now compare the escaped/quoted forms that the runtime deliberately emits. This restores the Windows Node 22/24 release matrix without weakening command escaping. Source: `apps/cli/src/lib/project-root.ts`, `apps/cli/src/lib/{project-root,daemon}.test.ts`, `apps/cli/src/lib/hosts/dispatch.test.ts`.
- **Wire subagents support for Kiro CLI.** Kiro custom agents are JSON files under `~/.kiro/agents/*.json` (introduced in kiro-cli v1.23.0). Flip Kiro's `subagents: { since: '1.23.0' }`, add `transformSubagentForKiro`, and wire the subagents writer, detector, install/remove, and orphan-detection paths. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/subagents.ts`, `apps/cli/src/lib/staleness/{writers,detectors}/subagents.ts`. (RUSH-1393)

## 1.20.58

- **Self-updating agent CLIs are represented as one live installation.** `agents view` no longer invents version-home rows for single-binary installers such as Droid, Grok, Cursor, Kiro, Goose, and Hermes; it reports the version returned by the installed binary and folds away stale per-version directories. `agents add <agent>@<version>` now installs or keeps that agent's current release instead of rejecting an unsupported pinned install. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/versions.ts`, `apps/cli/src/commands/{versions,view}.ts`. (RUSH-1321)
- **Stopped teammate resumes are transactional from launch through persistence.** If a local or remote resume fails, the existing teammate record, directory, runtime metadata, stdout mirror, and log cursor are restored; any replacement wrapper and its descendants are terminated as one process group. A successful resume whose log was truncated restarts parsing at byte zero, and a secondary restore-write failure retains the original launch error as its cause. Source: `apps/cli/src/lib/teams/agents.ts`, `apps/cli/src/lib/hosts/dispatch.ts`. (#1104, #1108)
- **Wire allowlist support for Cursor CLI.** Cursor agent CLI stores allow/deny in `~/.cursor/cli-config.json` (`permissions.allow`/`deny` with Shell/Read/Write/WebFetch/Mcp). Flip `allowlist: true`, add `convertToCursorFormat` (Bash→Shell), and write via `applyPermissionsToVersion` + detector. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/permissions.ts`. (RUSH-1387)
- **GitHub Copilot CLI subagents now sync (RUSH-1390).** Installed subagents flatten into GitHub Copilot custom-agent profiles at `~/.copilot/agents/<name>.agent.md` (the Droid custom-droid format), gated to Copilot CLI ≥ 0.0.353. `agents subagents list/view` now surfaces synced Copilot agents and `agents subagents remove` soft-deletes their `.agent.md` files to trash — both previously skipped `copilot` entirely. Source: `apps/cli/src/lib/subagents.ts` (`listSubagentsForAgent`, `removeSubagentFromVersion`, `transformSubagentForCopilot`), `apps/cli/src/lib/staleness/writers/subagents.ts`, `apps/cli/src/lib/staleness/detectors/subagents.ts`, `apps/cli/src/lib/agents.ts`.
- **Menu-bar Quick Dispatch preserves typed drafts when focus is stolen (RUSH-1592).** If another app activates while the `Cmd-Shift-O` capture panel is open, the panel can hide without destroying the note; the next summon restores the draft text plus selected screenshots, action, and agents. Return submits and clears the draft; Escape clears without dispatching. Source: `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`, `apps/cli/docs/menubar.md`.
- **Menu-bar ticket agents now carry every selected screenshot into the Linear issue (RUSH-1668).** `Cmd-Shift-O` already passed selected file paths to the ticket agent, but the prompt only asked it to inspect them, so agents could create text-only issues and stop. The brief now identifies every selected path as user-provided ticket material, requires each file to be uploaded, supplies the existing `linear update <id> --proof <path>` path as a reliable default, and leaves description/comment/other placement to the agent's judgment. Source: `apps/cli/menubar/Sources/MenubarHelper/{AgentsCLI,IssueSelfTest}.swift`, `apps/cli/docs/menubar.md`.
- **`agents sessions --active --json` now carries session attachment metadata for Factory previews (RUSH-1524).** Claude and Droid prompt image/document blocks that reference local files are preserved as `{ path, name, mediaType, sizeBytes }`, and the active-session state dedupes them into `attachments` so consumers can render screenshot thumbnails and open the original files instead of only seeing an attachment count. Source: `apps/cli/src/lib/session/parse.ts`, `apps/cli/src/lib/session/state.ts`, `apps/cli/src/lib/session/active.ts`.
- **Retired the standalone `com.phnx-labs.agents-secrets-agent` launchd service — the always-on daemon is now the sole broker host (#416, step 2).** `ensureAgentRunning()` no longer installs a separate launchd service: it retires any leftover plist via the new `retireLegacySecretsAgentService()` and relies on the daemon (Path 0), with a one-off detached broker as the only fallback. The upgrade migration (`scripts/postinstall.js` → `healLongRunningProcesses`) now `launchctl bootout`s the legacy service **first**, then (re)starts the daemon so it takes over the broker socket, instead of kickstarting the old service onto new code. `agents secrets start` is now a thin alias that brings the daemon up (and waits for the broker to answer); `agents secrets stop` locks all bundles and retires any leftover legacy service while leaving the always-on daemon running; `agents secrets status` reports broker reachability (daemon-hosted vs standalone) rather than "service installed". The stale broker teardown (version-skew self-heal) retires the legacy service instead of kickstarting it. Source: `apps/cli/src/lib/secrets/agent.ts` (`retireLegacySecretsAgentService`, `ensureAgentRunning`, `teardownStaleBroker`, `uninstallSecretsAgentService`; removed `installSecretsAgentService`/`kickstartSecretsAgentService`/`generateServicePlist`), `apps/cli/scripts/postinstall.js` (`healLongRunningProcesses`), `apps/cli/src/commands/secrets.ts` (`start`/`stop`/`status`).

- **Clarify the native escape hatch behind `--mode skip`.** The README and bundled `run` skill now discourage `skip`, list its exact direct-exec per-harness flag mappings and ACP `allow_always` behavior, replace an older recommendation of unsafe `full` for ordinary writes, and distinguish Codex `auto` (sandboxed `edit`, which can still prompt) from Codex `skip` (`--dangerously-bypass-approvals-and-sandbox`, equivalent to unsandboxed `--yolo`). Documentation only; runtime behavior is unchanged. Source: `README.md`, `skills/run/SKILL.md`.
- **Wire allowlist support for Kiro CLI.** Kiro 2.8.0+ permission groups now sync into `~/.kiro/settings/permissions.yaml` as v3 capability rules for shell, filesystem, and web access; existing user-authored rules are preserved and duplicate generated rules are removed. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/permissions.ts`, `apps/cli/src/lib/staleness/detectors/permissions.ts`. (RUSH-1392)
- **Fix: remote `agents secrets view <bundle>@host --reveal` no longer leaves a 60-second SSH control master behind.** The interactive `-tt` reveal path now opts out of default SSH multiplexing (`multiplex: false`), matching the transport guidance for one-shot commands that must not keep a `ControlPersist` socket open after a Touch ID/passphrase reveal. Source: `apps/cli/src/lib/secrets/remote.ts` (`remoteSecretsRaw`).
- **`agents run --host <host> --cwd <dir>` now sets the working directory ON the host (and a new `--project` shorthand jumps to a project by name).** Previously `--cwd` was silently dropped for `--host` runs — only the separate `--remote-cwd` flag worked — so `agents run claude --host s1 --cwd ~/src/foo` landed in the remote login-shell's default directory with no warning. `--cwd` is now forwarded as the host working directory, and a home-anchored path (`~/…`, `$HOME/…`, or a local-home absolute the shell already expanded like `/Users/me/…`) is re-rooted at the *remote* `$HOME` so it resolves correctly across machines with different home paths (`/Users/me` → `/home/me`). `--remote-cwd` remains as the explicit override. New `-P, --project <slug>[@worktree]` resolves a bare project name against your projects root (e.g. `~/src/github.com/<user>`) — auto-inferred from the repo you launch inside and cached in `agents.yaml`, or set/shown with `agents defaults project-root [path]`; `--project foo@fix` targets the `fix` git worktree. Works for local and `--host` runs. Verified end-to-end: `agents run claude --host yosemite-s1 --project agents-cli` runs the remote agent with `pwd` = `/home/muqsit/src/github.com/muqsitnawaz/agents-cli`. Source: `apps/cli/src/lib/project-root.ts` (new), `apps/cli/src/lib/hosts/dispatch.ts` (`remoteCdPrefix`), `apps/cli/src/commands/exec.ts` (`--project`/`--cwd` host wiring), `apps/cli/src/commands/defaults.ts` (`project-root`).
- **Fix daemon crash-looping when its pinned Node version is pruned (fleet-wide).** The routine daemon's launchd/systemd manifest hardcoded `~/.nvm/versions/node/v24.0.0/bin` on PATH, and launched the CLI entry bare when it was an extension-less shim or a `bin/agents → dist/index.js` symlink (an extension check on the link name missed it). The moment that exact nvm patch was upgraded away, the shim's `#!/usr/bin/env node` shebang fell through to an ancient system node (Node 18 → `SyntaxError: node:util has no export 'styleText'` from `@inquirer/core`), and the service crash-looped at import — observed at 100k+ restarts on Linux workers, silently killing all scheduled routines. `getDaemonLaunch` now detects Node-script entries by resolving symlinks and sniffing the shebang (not just the `.js`/`.cjs`/`.mjs` extension), so it pins them to `process.execPath`; and the generated PATH now leads with `path.dirname(process.execPath)` — the Node that installed the service — instead of a hardcoded nvm version, so both the shim and child routine processes always resolve a working runtime. Source: `apps/cli/src/lib/daemon.ts` (`getDaemonLaunch`, `isNodeScriptEntry`, `daemonNodeBinDir`, `generateSystemdUnit`, `generateLaunchdPlist`).
- **Fix global npm upgrades restarting the routines daemon through `scripts/postinstall.js`.** The postinstall process is itself `process.argv[1]`, so its daemon self-heal could stamp `node scripts/postinstall.js daemon _run` into launchd. Daemon startup now accepts an explicit CLI entry and postinstall passes the resolved signed native binary (or JavaScript entrypoint), with the same value threaded through launchd, systemd, and detached startup. Source: `apps/cli/scripts/postinstall.js`, `apps/cli/src/lib/daemon.ts`.
- **Fix a standalone secrets service stealing the daemon-hosted broker socket during postinstall.** The standalone and hosted brokers now bind through one race-safe owner arbitration path: an existing reachable broker wins without its socket being unlinked, a persistent losing service stays quiescent instead of triggering launchd restart churn, takes over if the owner stops, and releases its standby PID on service shutdown; only an unreachable stale socket is reclaimed. This covers the release ordering where postinstall restarts the daemon first and then kickstarts an installed standalone service. Source: `apps/cli/src/lib/secrets/agent.ts` (`bindBrokerSocket`, `runSecretsAgent`, `startHostedBroker`).

## 1.20.57

- **`agents teams resume` / `agents teams message` — resume a stopped teammate with a follow-up message.** A teammate that ended its turn with more to do (PR open awaiting review, headless turn cap, a redirect after the fact) could not be reached: `agents message` resolves only *live* sessions, so a completed/stopped/failed teammate had no path back short of finishing the work by hand or spawning a fresh, context-less teammate. `teams resume <team> <teammate> <message>` re-enters the teammate's **own** session with the message as the next user turn, re-launching through the same backend (local process or remote host) in its original worktree and flipping it back to `running` so `teams status` tracks it live. `teams message` is the same command with automatic routing by reconciled status: a **running** teammate is steered via its mailbox (delivered at its next tool call, no re-launch); a **stopped** one is resumed; a **pending** one is refused with a pointer to `teams start`. Works for every harness — the resume delegates to `agents run --resume`, inheriting native resume for Claude/Codex and the universal `/continue` replay for the rest (OpenCode, Grok, Kimi, …); the resume target is the teammate's captured underlying session id (`remoteSessionId ?? agentId`), and a non-Claude teammate that died before emitting a session id is refused with a clear error rather than resumed into a fresh run. This also makes good on `teams stop`'s long-standing "can be restarted later" promise, which no code implemented. Source: `apps/cli/src/commands/teams.ts` (`message`/`resume` subcommands, `decideTeamMessageRoute`), `apps/cli/src/lib/teams/agents.ts` (`AgentManager.resumeTeammate`, resume-aware `buildRunArgv`/`buildCommand`/`launchProcess`/`launchRemoteProcess`).
- **The always-on daemon now hosts the secrets broker (socket-first) — one supervised backbone instead of a separate service (#416, step 1).** `runDaemon()` binds the broker via the new `startHostedBroker()` before the scheduler and the heavy browser/session-sync services, so `agents secrets` resolves within ms of daemon start. It serves the same socket + wire protocol as the standalone broker (no `PROTOCOL_VERSION` bump — `agentGetSync`/`agentPing`/`agentAutoLoadSync` are unchanged), but is daemon-safe: no pid-guard, no `process.exit`/signal handlers/self-heal-exit (which would take the daemon down), TTL-eviction only. `ensureAgentRunning()` gains a Path 0 that prefers the daemon and falls back to the standalone `com.phnx-labs.agents-secrets-agent` launchd service, and the daemon only hosts when no broker is already reachable, so a live standalone broker is never orphaned. Retiring the standalone service (a gated `launchctl bootout` migration) and child-spawning the heavy services are the follow-on (#417). Source: `apps/cli/src/lib/secrets/agent.ts` (`startHostedBroker`, `ensureAgentRunning` Path 0, `agentPing` exported), `apps/cli/src/lib/daemon.ts` (`runDaemon` broker host + shutdown).
- **Clarified `agents secrets list` POLICY column labels.** The column previously mixed policy names, runtime state, and implementation jargon (`daily · 7d left`, `always ask`, `never · NO ACL`). It now uses a consistent `policy · state` form: `daily`, `daily · held 7d`, `always · prompt`, and `never · no prompt`. Source: `apps/cli/src/commands/secrets.ts` (`renderPolicyCol`).

## 1.20.56

- **Fix native routine schedulers rejecting the published CLI as a Bun virtual path.** Bun's standalone runtime reports the embedded `/$bunfs/root/agents` entry as existing at `process.argv[1]`, while the real physical executable lives at `process.execPath`. Daemon resolution now substitutes that physical executable before generating launchd/systemd manifests or detached launches; the existing virtual-path guard still rejects any virtual path that reaches supervision. Source: `apps/cli/src/lib/daemon.ts`.
- **Fix: `agents teams`, `agents message`, and `agents profiles check` work again on the signed standalone binary (regression from #315).** When `agents` resolves to the bun-compiled Mach-O (shipped since 1.20.53), three self-spawn sites relaunched the CLI as `[process.execPath, process.argv[1], …]` — but under a bun standalone executable `process.argv[1]` is the virtual entry `/$bunfs/root/agents`, so the child died with `unknown command '/$bunfs/root/agents'` (or `/bin/sh: /$bunfs/root/agents: No such file or directory`). Every teammate spawned by a compiled-binary install failed in 0s. New shared `getAgentsInvocation(subArgs)` (`apps/cli/src/lib/daemon.ts`) resolves the real on-disk binary — mapping the `/$bunfs/root/…` virtual path to `process.execPath`, running a `.js` entry under node, and a native binary directly — and `teams/agents.ts`, `commands/message.ts`, and `commands/profiles.ts` route through it. Verified end-to-end: a teammate spawned by the freshly-compiled binary runs to `completed` with no `$bunfs` error. Source: `apps/cli/src/lib/daemon.ts` (`getAgentsInvocation`), `apps/cli/src/lib/teams/agents.ts`, `apps/cli/src/commands/{message,profiles}.ts`.

## 1.20.55

- **Routine scheduler health is now observable and self-healing.** `agents routines status` distinguishes `running`, `wedged`, and `stopped`, and reports the daemon binary plus heartbeat age. Routine listing/status opportunistically finalize orphaned runs; PID reuse checks and a 24-hour wall-clock limit prevent stale `running` records; daemon startup rejects bun virtual paths and warns about worktree binaries that can disappear. Source: `apps/cli/src/lib/daemon.ts`, `apps/cli/src/lib/runner.ts`, `apps/cli/src/commands/routines.ts`.
- **Built-in Open-Claude and OpenCode profiles.** `agents profiles` now ships `open-claude` and `claude-spark` for Claude Code through OpenRouter, plus `opencode`, `opencode-spark`, and `opencode-qwen` presets for the OpenCode harness. Source: `apps/cli/src/lib/profiles-presets.ts`, `apps/cli/docs/profiles.md`.
- **Fix: exiting a user split inside an `agents run` tmux session reliably closes just that split (de-flakes CI #965).** The guarded `pane-died` hook's else-branch was a bare `kill-pane`, which relies on the hook context supplying an implicit "current pane" — nondeterministic on a loaded detached server, so the dead split intermittently survived as a husk (the same failure the flaky `session.test.ts` pane-died tests reproduced in CI). An intermediate external `tmux -S <socket>` self-client still raced the server under Linux load. The else-branch now runs `run-shell -C "kill-pane -t #{hook_pane}"`, which format-expands the event pane and executes the targeted command inside tmux's own server queue. Interactive tmux-backed runs now require tmux 3.2+, the release that introduced `run-shell -C`. `AGENT_HOOK_SCHEMA` bumps to 4; the daemon reconcile retrofits live sessions automatically and only stamps the marker after tmux accepts the hook, so a transient failure stays retryable. Source: `apps/cli/src/lib/tmux/session.ts` (`agentPaneDiedHook`, `AGENT_HOOK_SCHEMA`), `apps/cli/src/lib/tmux/binary.ts`, `apps/cli/src/lib/exec.ts`.
- **`agents devices sync` pins the login user on Windows too.** `os.userInfo().username` returns `COMPUTER\user` / `DOMAIN\user` on Windows, which failed the safe-charset guard, so Windows boxes synced with no pinned user and `--host <device>` fell back to the wrong local account. `sanitizeLoginUser` now strips the domain prefix to the bare ssh account before the guard. Also folds the duplicate `user@host` splitter (`parseTarget` in `ssh.ts`) into the canonical `splitUserHost` so there is one parser. Source: `apps/cli/src/lib/devices/sync.ts`, `apps/cli/src/commands/ssh.ts`.
- **Menu bar ACTIVE section now shows every local session, not just extension-registered terminals.** The dropdown's session source was `live-terminals.json`, which only carries terminals the Factory extension registers — a machine with 25 live sessions (tmux, ghostty, headless) rendered `ACTIVE · 1 running`. The helper now feeds triage + ACTIVE from `agents sessions --active --local --json` (the session engine's authoritative view, issue #741 contract) on the same warm-cache pattern as routines (30s TTL, refreshed off the click path; the cheap file still covers cold start and the 10s badge poll). Blocked sessions outside the extension's view now surface in NEEDS YOU too. Idle rows cap at 3 per repo group — the group header carries the true counts — so a big idle fleet can't wall the menu. Source: `apps/cli/menubar/Sources/MenubarHelper/{StatusItemController,LocalState,AgentsCLI,Models}.swift`.
- **Daemon service manifests pin JavaScript installs to the current Node runtime.** launchd and systemd now invoke `process.execPath <entry> daemon _run`, matching the detached launcher, instead of executing the JS entrypoint through `#!/usr/bin/env node`. Linux user services therefore stop falling back to an obsolete system Node (observed as Node 18 failing on `node:util.styleText`) when the CLI was installed under Node 22/24. Native `agents` launchers remain direct executables. Source: `apps/cli/src/lib/daemon.ts`.
- **Routines support a `devices:` allowlist so multiple machines each fire the same job independently.** Routine YAMLs sync fleet-wide via the user repo, so without a restriction an enabled routine fires on every device running the scheduler. A `devices: [yosemite-s0, mac-mini]` allowlist makes each listed machine run the job independently on schedule; omitting the field (or `--clear`) leaves the job unrestricted. A single-entry list `devices: [yosemite-s0]` replaces the legacy singular `device:` pin — v12 migration converts any existing `device: X` YAML automatically to `devices: [X]`. All automatic paths (cron scheduler, webhook triggers, overdue/`catchup`, daemon nags, detached runner fires, one-shot `--at`) skip devices outside the allowlist; attempting to run a job on an ineligible host errors with the allowed device names and a ready-to-paste `--host` hint. `routines add --devices yosemite-s0,mac-mini` sets the list at creation (validated against the registered fleet); `routines devices <name>` opens a preselected multi-select picker; `--set <csv>` and `--clear` update it non-interactively and are mutually exclusive. `routines list` gains a Devices column; `--json` gains `devices` array and `runsHere`. `--host <device>` (alias: `--device`) routes any `routines` subcommand to a remote machine over SSH. Source: `apps/cli/src/lib/routines.ts`, `apps/cli/src/lib/scheduler.ts`, `apps/cli/src/lib/overdue.ts`, `apps/cli/src/lib/triggers/webhook.ts`, `apps/cli/src/lib/runner.ts`, `apps/cli/src/lib/hosts/passthrough.ts`, `apps/cli/src/lib/migrate.ts`, `apps/cli/src/commands/routines.ts`.
- **Routines now default to `--mode auto` instead of `plan` (RUSH-1595).** A routine created without an explicit `mode` now runs under the smart classifier (`auto`) rather than read-only `plan`, so unattended jobs can create PRs, write files, and run tests end-to-end without every user opting in — `auto` maps to `--permission-mode auto` (claude), workspace-write + network (codex), `--auto high` (droid), and kimi's default headless run (which had no read-only mode and previously errored at `plan`). Opt down to `mode: plan` for read-only monitoring/reporting. `JOB_DEFAULTS.mode`, the `agents routines add --mode` flag default, and the file-add default all move to `auto`; `writeJob` now omits `mode` when it equals `auto`. Source: `apps/cli/src/lib/routines.ts`, `apps/cli/src/commands/routines.ts`.
- **`agents publish` — a self-hosted, zero-infrastructure skill registry that round-trips with `agents search`/`agents install`.** Publish walks a git repo's `skills/` directory, records a sha256 of every `SKILL.md`, and writes a flat `skills-index.json` (`SkillIndexDocument` shape) at the repo root, then commits + pushes it and prints the `raw.githubusercontent.com` URL plus the exact `agents registry add skill <name> <url>` command to share. No hosted aggregator: the index is just a file in your GitHub repo, consumed directly by the existing `fetchSkillIndex`/`searchSkillRegistries` path. Targets your `~/.agents` repo by default or an extra repo via `--repo <alias>` (`--dry-run` previews without pushing). Each index entry carries `sha256`, threaded through `SkillEntry`/`normalizeSkillEntry`, and `agents install` now verifies the freshly cloned `SKILL.md` against it — a mismatch aborts with a clear error rather than trusting a tampered artifact. This is the self-hosted/git-index slice of #336; global no-URL discovery (a hosted aggregator) remains future work. Source: `apps/cli/src/commands/packages.ts` (`publish` subcommand + install-time verify), `apps/cli/src/lib/registry.ts` (`buildSkillIndex`, `verifySkillIntegrity`, `sha256OfFile`, `parseOwnerRepoFromRemote`, `SkillIndexEntry.sha256`), `apps/cli/src/lib/types.ts` (`SkillEntry.sha256`). (#336)

## 1.20.54

- **Unified fleet target resolution for `agents ssh` + `sessions --host`.** `agents ssh` now accepts the full target grammar the fan-out already used — a registered `name`, a `user@device` (same device, login user overridden, still dialed via its Tailscale route rather than raw LAN DNS), and an ad-hoc `user@host`/`host` literal — instead of only an exact device name (`agents ssh muqsit@mac-mini` no longer errors "Unknown device"). A bare unregistered alias still reports "Unknown device". `sessions --host user@device` now resolves the host part through the registry too, so it stops silently diverging onto the non-Tailscale route. New `resolveDeviceTarget`; `resolveSshTarget` shares one host-part matcher. Source: `apps/cli/src/lib/devices/resolve-target.ts`, `apps/cli/src/commands/ssh.ts`.
- **`agents sessions --host` searches the peer's whole index, not its login cwd.** A remote listing runs in the peer's SSH-login home dir and was silently cwd-scoped, so `sessions --host <box>` read as empty (`No sessions found for /home/<user>`) even when the box's index was full. `--host` now defaults to whole-index (`--all`) scope; an explicit path query / `--project` / `--since` / `--agent` filter still narrows on top. It also runs the peer once, for itself (`AGENTS_SESSIONS_LOCAL=1`), so it no longer re-sweeps the fleet and prints a spurious `<this-machine>: unreachable`. Source: `apps/cli/src/lib/session/remote.ts`, `apps/cli/src/commands/sessions.ts`.
- **`agents devices sync` pins each device's login user.** Tailscale status carries a node's OS + address but not the account you ssh in as, so sync now materializes the local operator's username onto newly-synced devices (never clobbering a user you pinned). This makes `--host <device>` dial the same account no matter which machine launches the fan-out, instead of leaning on ssh's implicit local-username default. Source: `apps/cli/src/lib/devices/sync.ts`.

## 1.20.53

- **`agents add <agent>@latest` resolves to a concrete version before installing (no install race).** `latest` (like `oldest`) is now resolved via `npm view` up front and installed as a pinned spec directly into `versions/<agent>/<version>/`. Previously `latest` installed into a shared, well-known `versions/<agent>/latest/` scratch dir and was renamed to the real version only after npm finished — so a concurrent `agents view` reconcile (`reconcileStaleLatestForAgent`) or a second `latest` install could rename that dir out from under npm mid-extraction, corrupting the install with `ENOENT` on the seeded `package.json`. A concrete dir per version has no shared name to race on. Source: `apps/cli/src/lib/versions.ts`.
- **Native memory sync preserves unmanaged Markdown files (RUSH-1621).** Sync tracks managed fact names in `.agents-cli-memory.json` and only deletes those; user-authored `*.md` under the agent memory dir survive. Source: `apps/cli/src/lib/memory.ts`.
- **Feed high-consequence authz uses the canonical operator registry (RUSH-1618).** `recordAnswer` no longer looks for `operators.yaml` under the feed root; it resolves operators from `~/.agents/` via `loadOperators()`. Source: `apps/cli/src/lib/feed.ts`.
- **Menu bar groups worktree sessions under the real repo name (RUSH-1635).** Paths under `.agents/worktrees/<slug>` use the enclosing repository directory as the grouping key instead of the worktree slug. Source: `apps/cli/menubar/.../LocalState.swift`.

- **PR outcome keys include repository identity (RUSH-1630).** Full GitHub pull URLs normalize to `owner/repo#N` so two repos' PR #10 no longer collide under `pr:#10`. Source: `apps/cli/src/lib/feed-outcome.ts`.

- **Urgent OpenClaw notifications use `--target` and `--message` (RUSH-1620).** `openclaw message send` requires a destination and the `--message` flag (not `--text`); without `--target` the send was invalid. Source: `apps/cli/src/lib/notify.ts`.
- **High-consequence answers require env-proven operator identity (RUSH-1619).** `agents message --as <id>` alone is not verification; `AGENTS_OPERATOR_ID` must match the claimed id (and the id must be in `operators.yaml`). Source: `apps/cli/src/lib/operator.ts`, `apps/cli/src/commands/message.ts`.
- **Hermes and ForgeCode are first-class install targets (RUSH-559).** `AgentId` now includes `hermes` and `forge`, with resource capability metadata for skills, rules, and MCP. MCP sync writes Hermes `mcp_servers` YAML in `~/.hermes/config.yaml` and ForgeCode `mcpServers` JSON in `~/.forge/.mcp.json`, so registering these targets no longer requires their CLIs to be installed first. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/mcp.ts`, `apps/cli/src/lib/resources/mcp.ts`.
- **Cloud tasks can now report a resumable `idle` status (RUSH-601).** Provider-side stopped states such as Rush `idle`/`paused`/`needs_review`, Codex `paused`/`needs_review`, and Antigravity `idle`/`paused` normalize to canonical `idle`; stream output, `agents sessions`, and `agents cloud list/status` render idle as an idle state instead of falling through to queued or unknown-status output. Source: `apps/cli/src/lib/cloud/types.ts`, `apps/cli/src/lib/cloud/stream.ts`, `apps/cli/src/lib/session/active.ts`, `apps/cli/src/commands/cloud.ts`.
- **OpenCode plugin install only writes loader-visible direct `.ts`/`.js` files (RUSH-1617).** Drop nested and `.mjs`/`.cjs` installs that OpenCode never scans; multi-module plugins flatten into `~/.config/opencode/plugins/`. Source: `apps/cli/src/lib/plugins.ts`.
- **Routine credit-failover scans only the current attempt's log (RUSH-1616).** Each failover spawn writes `stdout.attempt-N.log` and rate-limit detection uses that file alone; prior attempts still append into `stdout.log` for the continuous trail. Source: `apps/cli/src/lib/runner.ts`.
- **Cursor hook sync drops stale managed entries when matcher/event change (RUSH-1615).** GC keys managed hooks by `event|command|matcher` instead of command path alone, so a matcher or event edit no longer leaves dead entries. Source: `apps/cli/src/lib/hooks.ts`.
- **Stop advertising Goose SubagentStart/SubagentStop hooks (RUSH-1613).** Goose does not emit those events; drop them from `GOOSE_EVENT_MAP` so sync no longer installs dead entries. Source: `apps/cli/src/lib/hooks.ts`.
- **Mailbox delivery receipts are monotonic (RUSH-1614).** `recordMessageReceipt` no longer lets a late `queued` write overwrite an already-recorded `consumed`/`continued` when enqueue races the drain. Source: `apps/cli/src/lib/feed.ts`.
- **Per-session rate-limit detection + feed badge (RUSH-1523).** The session state engine flags rate/usage-limit text in the transcript (`detectRateLimited`); `ActiveSession.rateLimited` flows through remote fan-out into Factory's `FloorAgent.rateLimited`, which renders a **rate limited** pill on the feed card. Source: `apps/cli/src/lib/session/state.ts`, `apps/factory/.../floorAdapter.ts`, `FeedItem.tsx`.
- **Kiro launches with `--v3` so standalone hooks actually fire (RUSH-1612).** Agents-cli writes Kiro hooks as v3 standalone files under `~/.kiro/hooks/*.json`, but those only load on the v3 engine. `AGENT_COMMANDS.kiro.base` now includes `--v3` so `agents run kiro` opts into the engine that reads them. Source: `apps/cli/src/lib/exec.ts`.

- **Ask classifier + stall suppression for the agent feed (RUSH-1477).** Every open block is classified as Decision / Approval / Clarification / Stall / Fyi. Workflow-stalls ("should I…?", "what's next?", "looks good?") are auto-answered and removed so they never render as cards; Decisions and Approvals still surface. `agents feed` reports a digest (`N stalls auto-resolved by policy`); `--all` shows suppressed items; `--json` stamps each block with its `ask` classification. Agent-tagged `blockClass: decision` is never auto-suppressed. Source: `apps/cli/src/lib/ask-classifier.ts`, `apps/cli/src/commands/feed.ts`.
- **Parked-agent answer router: PTY-select / resume / mailbox by runtime (RUSH-1474).** `agents message` no longer always enqueues to the mailbox. When the target is parked on an open feed question, delivery routes by runtime: tmux/iterm/pty rails get keystrokes that select the matching option label (or free-text via Other); headless parked runs resume via `agents run --resume <id> -- <answer>`; running agents still use the mailbox. Wrong-state delivery is refused with a clear error instead of silently rotting in the spool. Source: `apps/cli/src/lib/answer-router.ts`, `apps/cli/src/commands/message.ts`.
- **Wire subagents support for OpenCode.** OpenCode loads agent markdown from `~/.config/opencode/agents/` with frontmatter `mode: subagent`. Flip `subagents: true`, add `transformSubagentForOpenCode`, wire writer/detector/list/diff/remove. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/subagents.ts`. (RUSH-1386)
- **`agents feed` groups by outcome (ticket/PR/worktree), not by agent (RUSH-1479).** The default human view collapses open blocks under the deliverable they serve — Linear ticket first, then PR, then worktree/epic, then a shared Unassigned bucket — so a 1,100-agent fleet reads as dozens of initiatives (`RUSH-1125 · 4 agents · 1 needs you`). Each block is attributed to exactly one outcome; live session meta fills missing ticket/PR/worktree at list time; `--flat` restores the per-agent list; `--json` stamps each block with its `outcome` ref. Factory Floor's Group control gains an Outcome axis (the new default). Source: `apps/cli/src/lib/feed-outcome.ts`, `apps/cli/src/commands/feed.ts`, `apps/factory/ui/settings/components/mission-control/floorModel.ts`.
- **Menu bar dropdown redesigned around triage: attention floats up, context groups down.** The dropdown used to stack ~11 flat sections at equal weight, so a session waiting on you sat as loud as setup noise. Now: a **⚠ NEEDS YOU strip on top**, sorted by wait-time across all projects (most-stalled first), each row carrying the actual question the session is waiting on plus how long it's waited (`Claude · agents-cli — Claude needs your permission to use Bash · 2h 25m`); **live work grouped by repo** below (`ACTIVE · <repo>` headers, rich rows show the session's own title inline); **ROUTINES expanded** into a glanceable section (next few upcoming + any failing routine inline, `All routines…` for the rest); RECENT TICKETS and RECENT stay dedicated sections; **Setup + Auto-nudge collapse into one System row** (submenu keeps the doctor items and the auto-nudge toggle). A **density toggle** in the footer cycles Auto → Rich → Compact — compact folds rows to one-liners and tucks Recent behind a submenu; Auto (default) is rich while something needs you, compact on a calm machine (`menubarDensity` in UserDefaults, `MENUBAR_DENSITY` env override for dump probes). The question text + wait-time come from the attention sentinel: the Notification hook now writes the notification message as the sentinel content (phnx-labs/.agents-system#74), and the helper reads content + mtime (`LocalState.attentionMarks`); an empty sentinel still renders as "awaiting input". `Session` gained `title`/`question`/`attentionSinceMs`; terminal rows group by working-dir name and carry the live-terminal label as the title. Source: `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`, `apps/cli/menubar/Sources/MenubarHelper/LocalState.swift`.
- **Wire allowlist support for OpenCode.** OpenCode stores per-tool allow/ask/deny rules in `opencode.json`/`opencode.jsonc` under `permission` (bash patterns etc.; present since ~1.1.1). Flip `allowlist: { since: '1.1.1' }` so the existing `convertToOpenCodeFormat` / `applyPermissionsToVersion` / detector path actually runs. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/permissions.ts`. (RUSH-1385)
- **Wire subagents support for Grok CLI.** Grok discovers agent definitions as Claude-compatible `.md` files under `~/.grok/agents/` (docs: user-guide/16-subagents.md). Flip `subagents: true`, reuse the Claude flatten transform for install/writer paths, and register a detector plus list/diff/remove. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/subagents.ts`, `apps/cli/src/lib/staleness/writers/subagents.ts`, `apps/cli/src/lib/staleness/detectors/subagents.ts`. (RUSH-1384)
- **Wire subagents support for Kimi CLI.** Kimi Code loads custom agents as YAML under `~/.kimi-code/agents/*.yaml` with a sibling `*.system.md` referenced via `system_prompt_path` (Kimi has no inline `system_prompt` field) and a managed parent `_agents-cli.yaml` that declares `agent.subagents` for `--agent-file`. Flip `subagents: true`, add `transformSubagentForKimi` / `writeKimiSubagentFiles`, list/diff/remove paths, and wire the subagents writer + detector (underscore-prefixed parent excluded from the installed name list). Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/subagents.ts`, `apps/cli/src/lib/staleness/writers/subagents.ts`, `apps/cli/src/lib/staleness/detectors/subagents.ts`. (RUSH-1383)
- **Grok + Antigravity now register dir-form subrule hooks.** The hooks writer excluded `grok` from `registerHooksToSettings`, so subrule-bundled guards (absolute paths outside the central hooks copy set) never reached `~/.grok/hooks/hooks.json`. Grok is now in the gate. Antigravity entries carry `matcher` so guards are tool-scoped. Source: `apps/cli/src/lib/staleness/writers/hooks.ts`, `apps/cli/src/lib/hooks.ts`. (RUSH-1353)
- **Menu-bar Quick Dispatch can now pick agents and fan out autonomous fixes from the screenshot panel.** `Cmd-Shift-O` still supports filing one Linear ticket, but the panel now has a File Ticket / Fix mode control plus a roster picker sourced from the menu-bar agent list. File Ticket runs the selected ticket agent; Fix dispatches every selected agent with `agents run <agent> --mode auto --name quick-<agent>-<timestamp>`, carrying the typed note and selected screenshots into a repo-discovery prompt so those runs surface in normal session/tray views instead of hidden background work. `AGENTS_QUICK_DISPATCH_ROSTER=claude,codex` filters visible agents and `AGENTS_QUICK_DISPATCH_AGENTS=claude,codex` preselects them. Source: `apps/cli/menubar/Sources/MenubarHelper/{LocalState,PromptPanel,AgentsCLI,IssueSelfTest}.swift`, `apps/cli/docs/menubar.md`. (RUSH-1416)
- **Menu-bar Quick Dispatch keeps immediate typing in the capture field.** The `Cmd-Shift-O` quick-capture panel now uses an activating borderless window, orders it front, and waits briefly for the field editor to become ready before returning from summon, so notes typed immediately after summon no longer lose their leading characters to the previously focused app. Source: `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`. (RUSH-1591)
- **Internal: consolidated the drifted provider status-normalizers and git-root helpers (#753).** The three copies of `mapStatus` in `cloud/{rush,codex,antigravity}.ts` — which had drifted (different vocabularies and defaults) — collapse into one exported `normalizeProviderStatus(provider, wireStatus)` in `cloud/types.ts`, with provider-specific defaults still explicit (rush default `running`, codex default `running`, antigravity `undefined`-safe default `completed`); factory's structurally-different `mapResultStatus` is left in place. `getGitRoot` moves to `lib/git.ts` and `commands/worktree.ts` now calls it instead of a private `gitRoot` copy; the two divergent `isGitRepo` variants (synchronous root-only in `git.ts` vs async worktree-correct in `teams/worktree.ts`) are documented and deliberately not merged. Source: `apps/cli/src/lib/cloud/{types,rush,codex,antigravity}.ts`, `apps/cli/src/lib/git.ts`, `apps/cli/src/lib/teams/worktree.ts`, `apps/cli/src/commands/worktree.ts`. (#753)
- **macOS installs now run a Developer-ID-signed + notarized `agents` binary — the primary fix for EDR (CrowdStrike Falcon) blocking the CLI.** The resolved `agents` on macOS was a node-shebang JS file in a user-writable path; unsigned and spawned by editor/Electron children, it matched Falcon's post-exploitation profile and the sessions feature silently died on EDR-enabled Macs (mitigation 1 of #315; the behavioral hardening, mitigations 2-4, shipped earlier). Releases now build a standalone arm64 Mach-O with `bun build --compile` (`scripts/build-bin.sh`), sign it with Developer ID + hardened runtime + the JIT entitlement bun's JavaScriptCore needs under the hardened runtime (`scripts/sign-cli-binary.sh`, `scripts/bun-jit-entitlements.plist`), notarize it with `notarytool`, and ship it in the npm tarball at `dist/bin/agents`. `postinstall` points the alias shims and the `~/.local/bin/agents`/`ag` links at the signed binary — with a run-probe that falls back loudly to the JS entrypoint if the binary is missing, wrong-arch, or blocked — and repoints links an earlier install left at the JS shim. A `prepack` gate (`scripts/verify-cli-binary.sh`) refuses to pack unless the binary matches its sign-run sha pin, embeds the release version, and (on macOS) passes `codesign --verify` with a Developer ID authority. Linux-driven releases build + sign the binary on the mac sign host via `scripts/remote-sign-mac.sh`. Intel Macs and non-mac platforms keep the JS entrypoint. (#315)
- **Codex multi-file apply_patch now surfaces every path.** `parseCodex` used `.match()` on the patch body so only the first `*** Update/Add/Delete File:` path became a tool_use; files 2+ were invisible to artifact discovery. Now `applyPatchTargetPaths` uses `matchAll` and emits one Edit event per file. Source: `apps/cli/src/lib/session/parse.ts`. (RUSH-1410)
- **`memory` is a first-class top-level resource (distinct from `rules`).** `agents memory list|add|remove|view|sync` manages portable knowledge facts under `~/.agents/memory/` (project > user > system; `MEMORY.md` index + one `<slug>.md` per fact). The legacy `agents memory` → `rules` tombstone is gone. Capable agents (claude, codex, openclaw, grok) get facts fanned into version homes on `syncResourcesToVersion` / `agents memory sync`. Plugins can ship a `memory/` dir (surfaced in `pluginResourceGroups`). Note: internal `ResourceSelection.memory` still means the composed *rules* file — rename to `rules` is a follow-up. Source: `apps/cli/src/lib/memory.ts`, `apps/cli/src/commands/memory.ts`, `apps/cli/src/lib/resources/memory.ts`, `apps/cli/src/lib/versions.ts`, `apps/cli/src/lib/plugins.ts`. (RUSH-1330)
- **`agents sessions --active --json` now carries `tokPerSec`, and `agents sessions --roots --json` emits the session-scan directories — one CLI contract the Factory extension consumes instead of re-implementing (issue #741).** Every active row gained `tokPerSec`: live output-token throughput over a rolling 60s window from the transcript tail (Claude assistant `output_tokens`; Codex `token_count` output + reasoning; Gemini output + thoughts), absent when the session is idle or its format reports no usage. The new `agents sessions --roots --json` prints, per on-disk agent, the exact directories the CLI scans for transcripts (every version home + backup mirror), so an external watcher (the Factory Floor's `fs.watch`) tracks the same paths the CLI does instead of hardcoding `~/.claude|.codex|.gemini` — add an on-disk agent to discovery and every consumer watches it automatically. The throughput math and the roots list are now the single source of truth; the extension used to keep parallel copies. Source: `apps/cli/src/lib/session/throughput.ts` (`computeTokPerSec`), `apps/cli/src/lib/session/active.ts` (`ActiveSession.tokPerSec`, `computeLiveSignals`), `apps/cli/src/lib/session/tail.ts` (`readSessionTailWithRaw`), `apps/cli/src/lib/session/discover.ts` (`getSessionRoots`), `apps/cli/src/commands/sessions.ts` (`--roots`).
- **Fix: `agents sessions --active` no longer attaches stale Codex transcripts to live processes.** Codex session lookup now sorts by indexed `last_activity` and refuses to borrow a transcript outside an explicit 24-hour freshness bound, so a desktop app service or unrelated long-lived process cannot light up a months-old session as `running`. Source: `apps/cli/src/lib/session/active.ts`, `apps/cli/src/lib/session/db.ts`. (RUSH-1489)
- **Startup shim self-heal stays silent by default, with `--verbose` diagnostics on stderr.** The unified shim/shadow/PATH repair path no longer pollutes command stdout, including `agents sessions --active --json`; `agents --verbose <cmd>` now prints a concise startup self-heal summary to stderr for debugging. Source: `apps/cli/src/index.ts`, `apps/cli/src/lib/shim-heal.ts`. (RUSH-1533)
- **Wire subagents support for Codex CLI.** Codex custom agents are standalone TOML under `~/.codex/agents/*.toml` (required: `name`, `description`, `developer_instructions`; multi-agent plumbing since 0.117.0). Flip `subagents: { since: '0.117.0' }`, add `transformSubagentForCodex`, and wire the subagents writer + install/remove paths. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/subagents.ts`, `apps/cli/src/lib/staleness/writers/subagents.ts`. (RUSH-1382)
- **Routines use the same version/account selection and credit failover as `agents run`.** Scheduled jobs used to spawn a bare `claude`/`codex` name under a sandbox HOME, which could surface as `agents: no version of claude configured` even when installs existed, and never walked past a credit-exhausted default. The runner now resolves a healthy install via the configured run strategy (default `balanced`), pins the absolute binary, injects per-version config dirs + the daemon's `CLAUDE_CODE_OAUTH_TOKEN` into sandboxed spawns, and on foreground `agents routines run` re-dispatches to the next healthy same-agent account when a mid-run rate/usage limit is detected (daemon detached fires use the pre-flight pick only). Diagnostic lines log the pick, skipped accounts, and each failover hop. Source: `apps/cli/src/lib/runner.ts` (`resolveRoutineLaunch`, `pinJobBinary`, `buildRoutineSpawnEnv`), `apps/cli/src/lib/sandbox.ts` (OAuth allowlist), `apps/cli/src/commands/routines.ts` (help). (RUSH-1016)
- **Wire plugin support for Goose.** Goose loads Open Plugins from `$HOME/.agents/plugins/<name>/` (same layout as agents-cli). Flip `plugins: true` and copy each selected plugin into the version home under `.agents/plugins/`. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/plugins.ts` (`installGoosePlugin`). (RUSH-1339)
- **Wire plugin support for Cursor CLI.** Cursor agent plugins use `.cursor-plugin/plugin.json` (re-enabled 2026-05). Flip `plugins: true`, set `pluginManifestDir: '.cursor-plugin'`, and reuse the centralized marketplace mirror path under `~/.cursor/plugins/`. Source: `apps/cli/src/lib/agents.ts`. (RUSH-1338)
- **Wire plugin support for OpenCode.** OpenCode loads JS/TS plugin modules from `$HOME/.config/opencode/plugins/` (not Claude marketplace layout). Flip `plugins: true`, install modules from a plugin's `opencode/` or `plugins/` dir (or root) into the version home, and track install/remove via `isPluginSynced` / `removePluginFromVersion`. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/plugins.ts` (`installOpenCodePlugin`, `openCodePluginsDir`). (RUSH-1336)
- **Wire hooks support for Cursor CLI.** Cursor agent CLI (`cursor-agent`) gained lifecycle hooks on 2026-01-16 (`~/.cursor/hooks.json`, `{ "version": 1, "hooks": {…} }`). Flip the capability, map canonical events to Cursor camelCase (`SessionStart` → `sessionStart`, `UserPromptSubmit` → `beforeSubmitPrompt`, `Stop` → `stop`, …), and merge managed entries into `hooks.json` while preserving user-authored commands outside managed prefixes. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/hooks.ts` (`registerHooksForCursor`, `CURSOR_EVENT_MAP`), `apps/cli/src/lib/staleness/writers/hooks.ts`. (RUSH-1326)
- **Wire hooks support for Goose.** Goose (`block-goose-cli` ≥ 1.34.0) auto-discovers Open Plugins hooks at `$HOME/.agents/plugins/<name>/hooks/hooks.json`. Flip `supportsHooks` and gate `hooks: { since: '1.34.0' }`, write a managed plugin (`agents-cli-hooks`) under the version home with Claude-shaped event groups, and leave user plugins alone. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/hooks.ts` (`registerHooksForGoose`, `GOOSE_EVENT_MAP`), `apps/cli/src/lib/staleness/writers/hooks.ts`. (RUSH-1325)
- **Wire hooks support for Kiro CLI.** Kiro CLI v3 stores standalone hooks under `~/.kiro/hooks/*.json` (`{ "version": "v1", "hooks": [...] }` with command/agent actions); PreToolUse/PostToolUse firing was fixed in kiro-cli 0.10. Flip `supportsHooks` and gate `hooks: { since: '0.10.0' }`, map canonical events to Kiro PascalCase triggers, and write a single managed `agents-cli-hooks.json` on every sync (user-authored sibling files untouched). Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/hooks.ts` (`registerHooksForKiro`, `KIRO_EVENT_MAP`), `apps/cli/src/lib/staleness/writers/hooks.ts`. (RUSH-1324)
- **Wire hooks support for GitHub Copilot CLI.** Copilot GA (`@github/copilot` ≥ 1.x) ships a real hooks system (`~/.copilot/hooks/*.json`, schema `{ "version": 1, "hooks": {…} }`), but agents-cli still declared `hooks: false` so nothing ever installed. Flip the capability, map canonical events to Copilot camelCase (`SessionStart` → `sessionStart`, `PreToolUse` → `preToolUse`, `Stop` → `agentStop`, …), and write a single managed file (`agents-cli-hooks.json`) on every sync so GC is a rewrite and user-authored sibling JSON files are never touched. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/hooks.ts` (`registerHooksForCopilot`, `COPILOT_EVENT_MAP`), `apps/cli/src/lib/staleness/writers/hooks.ts`. (RUSH-1323)
- **`agents run --lease` now shows live progress instead of a 30-90s blank terminal.** After the runtime picker + consent, the lease used to go completely silent while the box provisioned (`crabboxWarmup` was a blocking `spawnSync`, so nothing could animate), then dump crabbox's raw sync/bootstrap log interleaved with the agent's output. Now a spinner animates each previously-silent phase — `Leasing a hetzner box… (Ns)` → `✔ Box <slug> ready (<ip>) · Ns` → `Setting up box — <latest step>` → `✔ Box provisioned — <agent> output:` — and the agent's own output then prints verbatim. The box bootstrap echoes a marker (`LEASE_AGENT_MARKER`) right before the agent run; `createLeaseOutputRouter` splits the crabbox stream on it so setup noise feeds the spinner while the agent output streams clean, and a setup failure dumps the captured setup log so errors are never swallowed. `crabboxWarmup` is now async so the event loop stays free to animate. The spinner is a purpose-built `createSpinner` (NOT `ora`): ora hooks `stream.write` and re-renders on every external write while spinning, which ballooned to multi-GB output when a lease streamed past a live spinner — `createSpinner` writes exactly one short line per fixed tick and nowhere else (a unit test asserts 100k `update()` calls produce zero writes), and on a non-TTY prints each phase label once and stays silent on update (no piped/CI flood). Verified live on Hetzner: animated warmup counter, clean `LOGIN_OK`, box auto-destroyed, 43KB total output. Source: `apps/cli/src/lib/crabbox/progress.ts` (`createSpinner`, `createLeaseOutputRouter`, `LEASE_AGENT_MARKER`), `apps/cli/src/lib/crabbox/{lease,cli}.ts`, `apps/cli/src/commands/exec.ts`.
- **Fix: Grok hooks now respect their `matcher` and no longer run twice per event.** The Grok hook registrar (`registerHooksForGrok`) dropped the manifest `matcher` when writing `~/.grok/hooks/`, so a matcher-scoped hook fired on every tool call — the plan-presentation hook (meant for `ExitPlanMode` only) hard-blocked whole Grok sessions (exit 2 = explicit deny). It also double-registered every hook into BOTH `hooks.json` AND a per-event file (`pretooluse.json`, …); Grok merges all of `~/.grok/hooks/*.json`, so each hook ran twice. Now the registrar emits `matcher` only for the events Grok accepts it on (`PreToolUse`, `PostToolUse`, `Notification` — lifecycle events reject it), groups hooks one-per-distinct-matcher like the Claude writer, translates tool names Grok doesn't auto-alias (`ExitPlanMode` → `ExitPlanMode|exit_plan_mode`, since Grok's plan tool is `exit_plan_mode`), and writes a single `hooks.json`, pruning the stale per-event files an older build left behind so already-synced installs stop double-running. Source: `apps/cli/src/lib/hooks.ts` (`registerHooksForGrok`, `isManagedGrokHookFile`, `GROK_MATCHER_EVENTS`, `GROK_MATCHER_ALIASES`).
- **Agent feed replies now have delivery confirmation and atomic first-answer-wins closure (RUSH-1476).** `agents message` ties a local reply to the agent's current open feed block; if any surface already answered that block, the second attempt is rejected with the surface that won. The feed block records queued → consumed → continued receipts: `queued` when `agents message` enqueues, `consumed` when the mailbox drain archives the message, and `continued` once the agent continues past the block. A human answer typed directly in the terminal is reconciled via the `UserPromptSubmit` hook, which records a terminal answer and removes the visible block within one feed poll cycle. Source: `apps/cli/src/lib/feed.ts` (`recordAnswer`, `recordMessageReceipt`, `recordContinued`, answered-marker lifecycle), `apps/cli/src/lib/mailbox.ts` (`blockId` on `MailboxMessage`, consumed-receipt surfacing), `apps/cli/src/commands/message.ts` (open-block lookup + `--surface`), `apps/cli/src/commands/feed.ts` (receipt rendering).
- **24/7 multi-operator controls for agent feed (RUSH-1480).** Blocks can now carry `blockClass` (`approval`/`decision`), `consequence` (`normal`/`high`), `allowedOperators`, `timeoutMinutes`, `safeDefault`, and `costOfDelay`; the feed-publish hook captures these from the agent's `AskUserQuestion` tool_input. High-consequence answers require a verified operator id known to `~/.agents/operators.yaml` (`agents message --as <operator>`). `agents feed --dispatch` evaluates default-on-no-answer policy loaded from `~/.agents/feed-policy.yaml`: approval blocks resolve to their safe default after the timeout, decision blocks are hard-parked. Urgent blocks (`costOfDelay` at or above the phone threshold) are paged once via the OpenClaw Telegram gateway (`openclaw message send --channel telegram --account default`). Source: `apps/cli/src/lib/operator.ts`, `apps/cli/src/lib/feed-policy.ts`, `apps/cli/src/lib/notify.ts`, `apps/cli/src/lib/feed.ts` (block metadata + authz + parked/defaulted/notified timestamps), `apps/cli/src/commands/message.ts` (`--as`), `apps/cli/src/commands/feed.ts` (`--dispatch`, metadata rendering).
- **Mailbox TTL + liveness/GC so messages never rot in dead-agent inboxes (RUSH-1475).** `enqueue` accepts an optional `ttlSeconds`; expired messages are archived to `consumed/` with `dropped: expired` instead of being returned by `drain`/`peek`. `agents feed --dispatch` runs a liveness sweep against `getActiveSessions()`: boxes whose owning agent is no longer alive are treated as dead, their pending messages are archived with `dropped: dead`, and any feed block tied to that mailbox is removed so the operator never answers a ghost. Old `consumed/` entries are pruned after 24 hours by default. Source: `apps/cli/src/lib/mailbox.ts` (`expiresAt`, `isExpired`, `sweepExpired`), `apps/cli/src/lib/mailbox-gc.ts`, `apps/cli/src/commands/feed.ts` (`--dispatch` liveness sweep).
- **Keychain service names are no longer silently enumerable — items are stored under opaque HMAC-hashed names (macOS).** The helper's `list` never decrypts and never prompts (that's what keeps `agents secrets list` snappy), which meant the service names themselves — `agents-cli.secrets.<bundle>.<KEY>`, `agents-cli.bundles.<name>`, `agents-cli.<provider>.token` — were readable metadata: any same-user process could silently inventory your bundles, keys, and providers before ever popping Touch ID. Every `agents-cli.*` item now lives under an opaque name (`agents-cli.h.<ns>.m` for bundle metadata, `agents-cli.h.<ns>.k.<kh>` for values, `agents-cli.h.o.<ih>` otherwise) keyed by a per-machine random HMAC key (`agents-cli.hmackey`, no-ACL so silent operations stay silent). The structured shape keeps a bundle's items under one hashed prefix, so `secrets exec`/`run --secrets` still resolve metadata + all values behind a single Touch ID. A one-time re-key migrates existing items — automatically on the first interactive keychain use, or via the new `agents secrets rekey` (`--status` to inspect, exit 4 on a cancelled Touch ID; re-running resumes). It is crash-safe end to end: values are batch-read once, hashed copies are written and verified before ANY original is deleted, activation is all-or-nothing, and an interrupted delete phase is finished silently by the next run. A `--prefix`-restricted (partial) run resolves each value item's bundle tier directly from the keychain — scoping a `never`-policy bundle's value items without its metadata item keeps the silent no-ACL tier intact. The signed Swift helper is untouched (it already treats service names as opaque), so no re-notarization or sha re-pin. Caveat: an older agents-cli on the same machine writes/reads cleartext names and won't see re-keyed items — keep all installs current. Source: `apps/cli/src/lib/secrets/index.ts` (`hashedServiceName`, `rekeyServiceNames`), `apps/cli/src/lib/secrets/bundles.ts`, `apps/cli/src/commands/secrets-migrate.ts`, `apps/cli/docs/secrets.md`. (GitHub #316, Finding 1)

## 1.20.52

- **Re-pinned the keychain helper to a freshly notarized build carrying the new iCloud verbs.** The #904 session changed `keychain-helper.swift` (legacy iCloud/synchronizable item verbs) and re-pinned the sha, but the notarized binary it pinned lived only in that session's since-removed worktree — the release prepack gate (`verify-keychain-helper.sh`) then failed on every machine (`SHA256 mismatch`) because no reachable `bin/Agents CLI.app` matched the pin. Rebuilt the helper from current source on the release machine (universal, signed, notarized: Gatekeeper `Notarized Developer ID`, submission accepted) and pinned that binary. Same class of fix as #835.
- **Fix: version-skewed CLI invocations no longer wipe the secrets-agent's hot cache — the recurring Touch ID storm on version-churning machines is closed.** `ensureAgentRunning` tore down a reachable broker whenever the broker's running version differed from the caller's on-disk version — unconditionally, via `launchctl kickstart -k`, wiping every unlocked bundle. On a machine where installed versions churn (dev builds stamp a fresh `0.0.0-dev.<sha>` per install; an npm copy and a dev copy invoke in turn), that meant constant wipes, and the next read of *each* held bundle popped a fresh Touch ID prompt — the exact storm #435 fixed on the server side, reintroduced client-side. The client now accepts a protocol-compatible, version-skewed broker while it holds real unlocks (`shouldTeardownVersionSkewedBroker`); the broker's own sweep still adopts new code at the next quiet moment (store empty), so upgrades land without ever costing a re-prompt. Source: `apps/cli/src/lib/secrets/agent.ts` (`ensureAgentRunning`, `shouldTeardownVersionSkewedBroker`).
- **Fix: mutating a bundle now evicts the broker-held copy — `rotate` no longer serves the old secret for up to 7 days.** Only `secrets policy` invalidated the secrets-agent after a write; `add`, `rotate`, `remove`, `rename`, `delete`, and `import` updated the keychain while a broker-held snapshot kept serving the pre-write values for the rest of the ~7d hold — a rotated credential silently kept injecting the OLD value into every run. `writeBundle` and `deleteBundle` now evict the bundle from the broker after every mutating write (`agentEvictSync`, a synchronous socket client mirroring the read fast-path), so the next read re-resolves fresh from the keychain (one prompt) and re-caches. The usage-telemetry stamp (`stampLastUsed`, fired on every broker HIT) opts out — evicting there would make the cache destroy itself on first use — and the eviction honors `AGENTS_SECRETS_NO_AGENT` plus the test-backend override so suites never evict a user's real unlocks (`shouldEvictAfterBundleWrite`). The `policy` command's bespoke eviction is superseded by the chokepoint. Source: `apps/cli/src/lib/secrets/bundles.ts` (`writeBundle`, `deleteBundle`, `shouldEvictAfterBundleWrite`), `apps/cli/src/lib/secrets/agent.ts` (`agentEvictSync`), `apps/cli/src/commands/secrets.ts`.
- **`agents secrets import` gains a unified `--from <source>` and recovers bundles stranded in the iCloud Keychain.** One axis for every source: a .env path (`-` reads stdin), `1password:<vault>` (the boolean `--from-1password --vault <name>` pair still works as a hidden deprecated alias), and the new `icloud`. Bundles created in the pre-biometry era were synced via iCloud Keychain; the device-local cutover pinned every query to `kSecAttrSynchronizable: false`, which orphaned those items — visible in Keychain Access under iCloud, invisible to `secrets list` and `migrate-acl`. `agents secrets import --from icloud` discovers them (bundle metadata *and* bare per-key secret items whose metadata never synced), offers an interactive multi-select (or takes an explicit bundle name for non-interactive use), re-imports them as normal device-local biometry-gated bundles, and with `--purge` deletes only the iCloud copies whose value provably lives locally — imported this run or already present in the local bundle; an unreadable item, a key the modern store refuses by policy (reserved/loader env names the pre-cutover store accepted — reported as `reserved, not importable` instead of aborting the bundle), and the metadata item of a partially-recovered bundle all survive. `secrets view <name>` on a missing bundle now points at the recovery command when an iCloud copy of that name exists. Three new keychain-helper verbs (`list-synced`, `get-batch-synced`, `delete-synced`) match synchronizable items exclusively, so the live device-local store is untouchable from the recovery path. Source: `apps/cli/src/lib/secrets/icloud-import.ts`, `apps/cli/src/lib/secrets/keychain-helper.swift`, `apps/cli/src/commands/secrets.ts` (`parseImportSource`).
- **`agents feed` surfaces every top-level agent block that is waiting on the user across the fleet.** `AskUserQuestion` and waiting `Notification` hooks publish atomic open-block records with the full question/options or notification message, mailbox/session identity, host, and runtime; answer/resume/stop hooks remove resolved blocks, and Task subagents are gated out so internal questions do not flood the operator view. A bare `agents feed` merges local blocks with every registered online device in parallel, `--host`/`--device` scopes the fleet, `--local` skips SSH, and `--json` returns the same merged view. Runtime-managed hooks install from the CLI-writable user layer without dirtying the auto-pulled system repository. Source: `apps/cli/src/commands/feed.ts`, `apps/cli/src/lib/feed.ts`, `apps/cli/src/lib/remote-agents-json.ts`, runtime labelling in `apps/cli/src/lib/exec.ts` and `apps/cli/src/lib/teams/agents.ts`. (RUSH-1473)
- **Browser-profile credentials: account identity, `secrets get <bundle> <KEY>`, and `browser type --secret` for leak-free login.** `agents browser profiles logins` now shows, per profile, the account signed into each live service (plaintext username from Chromium `Login Data` — never decrypts the encrypted password) and whether login creds are declared in the profile's secrets bundle (columns `SERVICE | ACCOUNT | CREDS`); `profiles show` gains a `Logins:` block. `agents secrets get <bundle> <KEY>` prints one resolved value from a bundle (arg-count overload of the existing raw `get <item>`; ungated like it, and the `secrets.get` audit event fires inside the resolver). `agents browser type <ref> --secret <bundle>/<KEY>` resolves a credential in-process and types it into the page — the value never crosses stdout or the agent transcript — so an agent can drive a login by composing `profiles logins` → `browser start <loginUrl>` → `refs` → `type --secret` → `screenshot`, handling 2FA/selectors itself (no fragile CLI auto-login engine; Google/X block automation anyway). A profile's `--secrets` bundle is the credential store, keyed by the `<PREFIX>_USERNAME`/`<PREFIX>_PASSWORD` convention (per-service prefixes in `AUTH_SIGNATURES`); `profiles create --secrets` now warns if the bundle doesn't exist yet. Cookie-persistence-first remains the headline (the `browser` skill's credential guidance was corrected — the bundle only injected env vars into the browser process before, inert for web login). Source: `apps/cli/src/lib/browser/login-detection.ts`, `apps/cli/src/lib/browser/secret-ref.ts`, `apps/cli/src/commands/browser.ts`, `apps/cli/src/commands/secrets.ts`.
- **`agents logs audit` / `agents logs stats` / `agents logs rotate` — user-facing audit trail viewer.** The append-only local event log (`~/.agents/events.jsonl`) is now a first-class audit surface. `agents logs audit` queries events with filters (`--module`, `--command`, `--event`, `--agent`, `--caller`, `--level`, `--since`, `--limit`, `--json`) and `--follow` for live tailing; `agents logs stats` shows aggregate breakdowns by level, event type, module, and user; `agents logs rotate` prunes old numbered archives (`--days`, default 7). Events carry `level` (audit/warn/info/debug) and an environment-derived `caller` (`claude-code`, Factory agent kind, terminal, or script). Sensitive flag values, secret-shaped payload fields, token-like strings, and raw prompts are redacted before append. Security-relevant operations (secrets, teams lifecycle, cloud dispatch) auto-classify as `audit`. At 10 MB the active file rotates losslessly through `events.1.jsonl.gz`, `events.2.jsonl.gz`, and so on; `query()` reads every archive transparently. New instrumentation in `cloud.ts`, `factory.ts`, `teams.ts`, `secrets.ts`, `mcp.ts`, and `rotate.ts`. Source: `apps/cli/src/lib/events.ts`, `apps/cli/src/commands/logs.ts`, instrumentation call sites. (RUSH-460)
- **`agents run claude --lease` now runs the box logged-in — the Claude OAuth token ships alongside the config.** The lease copied `~/.claude.json` (config/account-metadata) but never the OAuth token, so Claude booted "Not logged in" on every leased box. The token lives in the macOS Keychain (hash-suffixed service for an agents-cli managed home, bare for a default install) and on Linux at `~/.claude/.credentials.json`. `resolveClaudeCredentialsBlob()` now reads the raw wrapped Keychain payload **silently** (`/usr/bin/security … -w` — Claude's item trusts it, no Touch ID): bare service first, then enumerate installed version homes, preferring the account whose email matches the copied config; off-darwin it reuses the existing `.credentials.json` file branch. `buildCredentialScript` writes that blob to `~/.claude/.credentials.json` (0600) via the same quoted-heredoc that carries every other cred (the box's `~/.claude` is a symlink into the versioned home, so it lands exactly where the shim's `CLAUDE_CONFIG_DIR` reads it); it is shredded after the run **regardless of `--keep-box`**. Resolved in the command layer after the existing per-run consent prompt, whose text now names the token explicitly. Scope is Claude-only — Codex/Grok already ship their token in the copied auth file. Verified live on Hetzner: a leased box ran `agents run claude` and returned a real model reply (`LOGIN_OK`, exit 0), and the token file was absent (shredded) afterward. Source: `apps/cli/src/lib/crabbox/runtimes.ts` (`resolveClaudeCredentialsBlob`, `buildCredentialScript`), `apps/cli/src/lib/crabbox/lease.ts`, `apps/cli/src/commands/exec.ts`.
- **`agents browser profiles set-default <name>` picks the profile a bare `agents browser start` uses — so agents stop opening a logged-out Chrome.** With no `--profile`, `start` used to auto-detect the first installed Chromium-family browser (Chrome first on macOS) and save it as `default`, ignoring a profile you'd actually logged into. Now `start` resolves in order: (1) your configured default, (2) an existing `default` profile, (3) auto-detect. The configured default ALSO re-points an explicit `--profile default`, so an agent that hardcodes `default` still lands on your chosen profile. The setting is **device-local** — stored in `~/.agents/devices/<machine>/agents.yaml`, never synced to other machines (the target profile may hold machine-local logins). `profiles list`/`show` mark it; `set-default --unset` reverts to auto-detect; a missing target warns and falls back rather than hard-failing. Source: `apps/cli/src/lib/browser/profiles.ts` (`ensureDefaultBrowserProfile`, `getConfiguredDefaultProfileName`), `apps/cli/src/lib/state.ts` (`writeMetaUnlocked`, `overlayMachineLocal`), `apps/cli/src/lib/types.ts` (`Meta.defaultBrowserProfile`), `apps/cli/src/commands/browser.ts`.
- **`agents browser` now warns when a task opens a login-gated site on a logged-out profile — grounded in real session state.** New `apps/cli/src/lib/browser/login-detection.ts` reads a profile's Chromium cookie store (presence only — never decrypts the Keychain-encrypted values, and filters expiry in SQL so Chromium's >2^53 microsecond timestamps never trip `node:sqlite`'s integer range) to tell which login-gated services (LinkedIn, Google, X, GitHub, Reddit) have a live session. `agents browser start --url <login-gated>` prints a stderr hint like `profile "default" has no linkedin.com session. logged in elsewhere: comet-local. try: --profile comet-local` when the chosen profile is logged out; it never blocks or slows start. `agents browser profiles logins` shows a profile-by-service table. Source: `apps/cli/src/lib/browser/login-detection.ts`, `apps/cli/src/commands/browser.ts`.
- **Fix: a finished session that signed off with a trailing "?" no longer reads as `input_required` forever (RUSH-1522).** The session state engine's prose-question heuristic (last assistant message ends with a question) now decays after 30 minutes without a session write: an unanswered prose question older than that classifies as `idle`, not `waiting_input` — so `agents sessions --active` and the Factory Floor's NEEDS YOU lane stop surfacing long-finished sessions as needing input. The structural signals are exempt and never decay: a genuinely pending `ExitPlanMode` (plan review) or `AskUserQuestion` still classifies as `waiting_input` at any age. Source: `apps/cli/src/lib/session/state.ts` (`inferActivity`, `PROSE_QUESTION_FRESH_MS`).
- **The post-upgrade "What's new" summary shows the release notes again.** The summary parser only recognized the old changelog format (standalone `**Heading**` lines with sub-bullets); every release since the changelog moved to single-line `- **Title.** prose…` entries rendered as a bare version header with zero bullets, so upgrades looked like they shipped nothing. The parser now extracts the bold heading from both formats (prose still dropped — full notes stay in the changelog). Verified against the real changelog: the 1.20.49 → 1.20.50 range renders all four 1.20.50 entry titles. Source: `apps/cli/src/lib/whats-new.ts`.
- **Fix: daemon no longer crash-loops when started from the bare `browser` or `computer` shim.** Daemon launch resolution now maps installed sibling shims to the `agents` launcher and compiled shims to `index.js` before generating launchd/systemd commands, and fails clearly if that invariant is broken. Headless auto-start reads the long-lived Claude token only from an already-unlocked secrets-agent snapshot, so it cannot hang on a biometric prompt nobody can answer; an interactive start can still prompt normally. Source: `apps/cli/src/lib/daemon.ts` (`getAgentsBinPath`, `readDaemonClaudeOAuthToken`), `apps/cli/src/lib/secrets/bundles.ts` (`agentOnly`). (RUSH-1527)

## 1.20.51

- **Fix: `agents run --lease` bootstraps a fresh crabbox image and no longer leaks the box after the run.** Three failures compounded on a stock Hetzner lease (Ubuntu 24.04, no node preinstalled): (1) the bootstrap's `npm install -g @phnx-labs/agents-cli` ran with no node/npm on the box and swallowed the failure with `|| true`, so every run died deep in the script with `agents: command not found` (exit 127) and no hint why; (2) even with the CLI installed, a fresh install refuses `agents run` with "agents-cli is not set up" until `agents setup` has run; (3) teardown called `crabbox stop --id <slug>`, but crabbox's `stop` takes a positional target (unlike `status`/`run`/`ssh`) and died with `flag provided but not defined: -id` — silently, because `crabboxStop` is best-effort — so every one-shot lease box was **kept, billed, and left carrying the run's working data** until someone noticed (`Box … kept` instead of destroyed). The bootstrap now: exports `~/.local/bin` onto PATH, installs node user-level from the official `latest-v22.x` tarball when missing (arch-aware, satisfies `engines.node >=22.5.0`, no sudo needed), points the npm prefix at `~/.local`, fails loud with exit 96 and a diagnostic when the CLI still isn't runnable, and runs `agents setup` behind the same `[ ! -d ~/.agents/.system ]` first-run guard the hosts bootstrap uses; `crabboxStop` passes the slug positionally. Verified live on a fresh Hetzner cpx62 by the run's own progression across builds: the pre-fix lease exited 127 (`agents: command not found`) with `Box … kept`; after the node/npm fix it reached `agents-cli is not set up`; after the setup fix it reached the agent's login check (`Not logged in`); and every post-fix run ends with `Box <slug> destroyed.` instead of leaking. Source: `apps/cli/src/lib/crabbox/lease.ts` (`ENSURE_AGENTS_CLI`, `buildBootstrapScript`), `apps/cli/src/lib/crabbox/cli.ts` (`crabboxStop`). Known follow-up: leasing a **Claude** runtime from a Mac whose Claude Code credential lives in the login Keychain (the default install, and any agents-cli managed home — service name is hash-suffixed) still lands "Not logged in" on the box, because the picker copies `~/.claude.json` (config/state) but not the OAuth token, and extracting the token from the Keychain needs an interactive ACL approval; tracked separately.
- **`agents repo pull user <git-url>` now git-backs a plain `~/.agents` instead of silently skipping it — fixing config sync on Windows/fresh machines.** Setup only ever git-clones the *system* repo (`~/.agents/.system/`); the user repo is created as a bare directory (`state.ts ensureAgentsDir`), so `~/.agents` is git-backed only where it was cloned by hand as a dotfiles step. On a box where that never happened (a fresh install, or Windows), `agents repo pull` just printed `user: not a git repo, skipping` and the machine silently fell out of config sync — no `rules/`, no `agents sync` of shared resources. Now, passing your config remote once — `agents repo pull user git@github.com:you/.agents.git` — **adopts** the existing directory in place: it clones your remote and moves the `.git` in without deleting anything, materializes the tracked resources it was missing, and **backs up any locally-modified tracked file** (e.g. a machine-specific `agents.yaml`) to a sibling `~/.agents.pre-adopt-backup/` before overwriting it. Untracked runtime state (`.cache/`, `.history/`, `.system/` — all gitignored) is never touched. Every subsequent `agents repo pull` / `agents sync` is plain (the remote is now `origin`). No new command; the URL is only needed the first time. SSH transport is preserved (a `git@…` URL clones over SSH, not a rewritten https that would hang on a private-repo credential prompt), and git never prompts (`GIT_TERMINAL_PROMPT=0`). Source: `apps/cli/src/lib/git.ts` (`adoptRepo`), `apps/cli/src/commands/repo.ts`.
- **`agents run` now warns when a headless run leaves committed-but-unpushed work, instead of stranding it silently.** A headless `agents run` in a writable mode (`edit`/`skip`/`auto`) could end with the agent having committed on a branch but never pushed it — the run's exit path did no git work, so those commits sat invisible in a worktree until someone audited the box (exactly how a batch dispatch loop can quietly lose a verified fix). After a non-interactive, writable run the CLI now inspects the cwd for commits on the current branch that haven't reached any remote (`git log HEAD --not --remotes`, correct even when no upstream is set — work already on an `origin/*` ref is not flagged) and prints a loud stderr warning naming the branch, the unpushed commits, and the exact `git push` / `gh pr create` commands. Advisory only: it never pushes, never mutates the repo, and never throws (a 5s git timeout plus full error-swallowing guarantee it can't delay or break the run's exit). The check is wired into every headless exit path — single run, `--loop`, `--acp`, `--resume-checkpoint`, and the crash/catch path — and gated by `shouldWarnUnpushed(mode, interactive)` so it stays silent for interactive runs (the human sees their shell) and read-only `plan` mode. Source: `apps/cli/src/lib/warn-unpushed.ts`, `apps/cli/src/commands/exec.ts`. (#868)
- **Codex mode flags now match what the mode names promise — only `--mode skip` is yolo.** `--mode edit` used to append `--dangerously-bypass-approvals-and-sandbox` (Codex's `--yolo`) alongside `--sandbox workspace-write`, and the bypass flag wins — so "edit" silently ran Codex with **no sandbox and no approvals**, verified against codex 0.142.5's own session banner (`sandbox: danger-full-access`). And `--mode plan` mapped to `workspace-write` (writable!) because the template predated Codex's `read-only` sandbox. Now: `plan` → `--sandbox read-only`, `edit` → `--sandbox workspace-write -c sandbox_workspace_write.network_access=true` (sandboxed writes, network on so git/gh/installs keep working, no approval bypass), `skip` → `--dangerously-bypass-approvals-and-sandbox` (unchanged — skip IS the gnarly mode, equivalent to `codex --yolo`). Same fix in routine jobs (`runner.ts`) and in headless `codex exec resume`, which used to get the bypass for ANY non-plan resume — it now maps plan/edit through `-c sandbox_mode=…` and reserves the bypass for skip; interactive `codex resume` now carries the mode's sandbox flags instead of none. Verified live per mode against codex 0.142.5 session banners: skip = `approval: never / sandbox: danger-full-access`, edit = `sandbox: workspace-write (network access enabled)`, plan = `sandbox: read-only`. Source: `apps/cli/src/lib/exec.ts` (`AGENT_COMMANDS.codex`, resume block), `apps/cli/src/lib/runner.ts` (`buildJobCommand`).
- **`--add-dir` is now forwarded to Codex (it was silently dropped).** `agents teams` passes `--add-dir ~/.agents` so Codex teammates can run `agents teams add`, but `buildExecCommand` emitted `--add-dir` for Claude only — the grant never reached Codex, masked until now by edit mode's accidental sandbox bypass. Codex takes `--add-dir` natively (widens the workspace-write sandbox); it is now forwarded for fresh runs and skipped on resume (`codex exec resume` rejects it). Source: `apps/cli/src/lib/exec.ts`.
- **Fix: the documented `agents run <agent> [prompt] -- <native flags>` passthrough works again.** commander ≥13 rejects excess operands by default, so any post-`--` token (e.g. `agents run codex -- --yolo`) died with `too many arguments` before the run started. The run command now allows excess operands, re-derives the `--` boundary from argv (a post-`--` token can never be mis-parsed as the prompt — `agents run codex -- --yolo` launches the TUI with `--yolo`, it doesn't headless-run the "prompt" `--yolo`), and still errors, with a hint to quote the prompt, on excess operands NOT behind `--`. Verified live: `agents run codex "…" -- --yolo` forwards `--yolo` and codex reports `sandbox: danger-full-access`. Source: `apps/cli/src/commands/exec.ts`.

- **Fix: grok launch shims resolve the binary from the versioned home before the global `~/.grok/downloads`, so a pinned grok that installed into the versioned home no longer dies with "grok@<version> not installed."** Grok ships a native binary (not an npm package), and it lands in the versioned home's `.grok/downloads` whenever the installer runs with `GROK_HOME` set — via the shim, a correct `agents add grok`, or a grok self-update from within the shim. Both generated shims (the dispatcher in `generateShimScript` and the `grok@<version>` versioned alias in `generateVersionedAliasScript`) checked only `$HOME/.grok/downloads`, which was often empty, so they fell through to the "not installed" error even though the binary existed in the versioned home. `getBinaryPath` already checked the versioned home first, so `agents view` and the shims disagreed. Both shim blocks now check `$VERSION_DIR/home/.grok/downloads` first and fall back to the global `$HOME/.grok/downloads` for pre-fix installs, then the existing adopted-launcher/PATH last resort. Bumps `SHIM_SCHEMA_VERSION` 25→26 and `VERSIONED_ALIAS_SCHEMA_VERSION` 12→13 so existing on-disk grok shims regenerate. Supersedes the pre-monorepo #830. Source: `apps/cli/src/lib/shims.ts` (`generateShimScript` grok dispatcher block, `generateVersionedAliasScript` `binaryResolution`).
- **Fix: `browser stop --host <windows>` tree-kills the remote browser — relaunches never wedge on a stale `SingletonLock`.** The kill script used `Stop-Process` on the CDP port owner only; orphaned Chromium child processes survived, kept the profile's `SingletonLock` held, and the next `browser start --host` against the same profile exited immediately as a second instance. The script now uses `taskkill /PID <owner> /T /F` to take down the whole process tree. Source: `apps/cli/src/lib/browser/drivers/ssh.ts` (`buildWindowsKillScript`). (GitHub #561)
- **Fix: `agents browser start --host <windows>` actually serves CDP now — the remote browser launches in the user's interactive session instead of session 0.** The Windows launch used WMI `Win32_Process.Create` (chosen so the browser outlives the ssh session), but a WMI-created process lands in session 0, where Edge binds the debugging port yet its DevTools server never initializes — every `/json/version` probe hung forever and `DevToolsActivePort` was never written, so `browser start --host` failed with a connection error on every attempt. The launch is now a one-shot scheduled task registered and started by the logged-on user: it survives ssh disconnect the same way, runs in the interactive session where DevTools comes up normally, and is unregistered immediately after start. The launch args also gained the same automation-modal suppressors the local launcher has (`--no-first-run --no-default-browser-check --hide-crash-restore-bubble --disable-session-crashed-bubble`) — without them a relaunch against a previously hard-killed profile triggers session-restore churn that closes the CDP page target mid-command. Verified live against win-mini (Edg/150). Source: `apps/cli/src/lib/browser/drivers/ssh.ts` (`buildWindowsLaunchScript`). (GitHub #561)
- **Fix: remote CDP no longer dies on large payloads — screenshots of content-rich pages over `browser --host` work.** The CDP client rode the platform (undici) WebSocket, which enforces a non-configurable max decompressed message size; a `Page.captureScreenshot` response for a content-rich page blew past it and the socket closed with 1006 ("Max decompressed message size exceeded") while the command was pending, surfacing as "CDP connection closed". The websocket transport now uses the `ws` client (no permessage-deflate offer by default, explicit 256MB `maxPayload`); the local pipe transport is unchanged. Source: `apps/cli/src/lib/browser/cdp.ts`. (GitHub #561)
- **`agents sessions <id> --json` now exposes the ExitPlanMode plan markdown as a top-level field, and the shape changed from a bare event array to `{ session, events }`.** The session-state engine already detected plan-review (`awaitingReason: 'plan_review'`) off a trailing `ExitPlanMode` tool call, but the plan markdown itself was dropped on the floor — forcing every consumer that wanted it (the Factory NEEDS-YOU panel via `parsePlanFromClaudeJsonl`, external dashboards) to re-open the raw JSONL and scan for the same tool call. That "extension re-implements the session engine" gap now closes at the source: the state engine surfaces `state.plan` alongside `awaitingReason`, the Claude scanner captures the plan text at scan time and persists it to `sessions.db` (schema v11, additive, rescan-on-migrate), it's exposed as `plan` on `SessionMeta` in every `agents sessions --json` row, and `agents sessions <id> --json` now emits `{ session: SessionMeta, events: SessionEvent[] }` so the plan is one top-level `output.session.plan` read instead of a needle-in-haystack scan. Verified live against a real Claude session with an ExitPlanMode event: `agents sessions 74464df7 --json` prints the plan markdown at `.session.plan`. Source: `apps/cli/src/lib/session/{state,discover,db,render,types}.ts`, `apps/cli/src/lib/session/active.ts`, `apps/cli/src/commands/sessions.ts`. (issue #743 / RUSH-1505)
- **`agents computer` Windows parity: scoped screenshots, `get-text --max-chars`, `status`/`reload --host`, and honest `--background`/`--require-frontmost` handling (#548).** Four params the CLI already sent were silently ignored by the Windows daemon. (1) **Screenshots are now pid-scoped like macOS** — `screenshot --list` enumerates the target pid's top-level windows (`window_id` is the Win32 HWND, the same id `raise --window-id` takes), the default capture crops to the pid's largest on-screen window, `--window-id` shoots one window, and `--display` captures the display the app is on; previously every capture was the whole virtual desktop. Verified live on win-mini: window capture 2097x984/28KB vs full display 2560x1440/380KB. (2) **`get-text --max-chars` is honored** (default stays 20k, ceiling 200k like macOS) — `--max-chars 100` now returns exactly 100 chars. (3) **`status --host <device>` and `reload --host <device>`** — status reports the recorded tunnel plus a live daemon probe (previously it misreported macOS-local install state for a remote Windows daemon); reload restarts the daemon's scheduled task (the way to pick up a freshly pushed exe) and confirms it answers through the tunnel. (4) **`--require-frontmost` is enforced on Windows** — `SendInput` lands in the *focused* window, so `type-text`/`key` now report `frontmost` (feeding the existing CLI warning) and the flag hard-fails with `not_frontmost` when the target isn't foreground; **`--background` is rejected** with `action_unsupported` instead of silently no-oping (macOS postToPid delivery has no Win32 analogue — element-mode clicks via UIA patterns are the focus-safe path). Source: `native/computer-win/{Screenshot,Automation}.cs`, `apps/cli/src/commands/computer.ts`, `apps/cli/docs/computer.md`.
- **The `never` prompt-policy is now live — the signed keychain helper was rebuilt, re-notarized, and re-pinned.** `agents secrets create --policy never --i-understand` stores bundle values with no biometry ACL (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, device-local, non-synchronizable) so headless automation can read them with zero Touch ID prompts. The Swift `set-no-acl` path shipped in #682 but the pinned helper binary predated it, so the policy failed against the shipped helper; the helper is rebuilt from current source, notarized (Apple submission `a2373c91-7fc2-4894-a801-b37c111597aa`, status Accepted, stapled, Gatekeeper `Notarized Developer ID`), and `scripts/Agents CLI.app.sha256` re-pinned to the new binary. (GitHub #421)
- **Consolidated ~30 copy-pasted terminal-formatting helpers into one shared `apps/cli/src/lib/format.ts`, fixing three user-visible drifts at the source.** `die`, `truncate`, `relTime`, `humanDuration`, `visibleWidth`, `padRight`/`padVisible`, `isJsonMode`, `readStdinSync`, and `termLink` had drifted into per-command copies with different behavior; every consumer now imports the single canonical version. Three normalizations are user-visible: (1) the truncation ellipsis is now the single glyph `…` everywhere — `agents cloud` task lists, `agents sessions` overflow, and session prompt/tool summaries previously showed ASCII `...` or a bare `.`; (2) `agents cloud` relative timestamps switch from the long "5 minutes ago" form to the compact "5m ago" form already used by `agents teams`; (3) the `agents teams` picker duration cell gains a space ("2h5m" → "2h 5m") to match the sessions/browser pickers. It also fixes a latent bug: `agents repo`'s divergence-table column alignment used a `visibleWidth` regex missing its `\x1b` escape, so ANSI-colored cells were mis-measured and columns could misalign — the canonical `visibleWidth` strips the full SGR sequence. `lib/events.ts`'s `truncate` (a distinct nullable, exported helper that truncates persisted event payloads) and the domain-specific `statusColor` copies (different status vocabularies with conflicting color assignments) are deliberately left in place. Internal refactor plus the noted string normalizations; no other behavior change. Source: `apps/cli/src/lib/format.ts` and consumers across `apps/cli/src/commands/` and `apps/cli/src/lib/`. (GitHub #753 / RUSH-1515)
- **`agents computer setup --host` now works from a plain `npm i -g` install — the Windows helper exe downloads on demand from GitHub releases.** The ~157MB `computer-helper-win.exe` never shipped in the npm tarball, so setup died with "Windows helper exe not built. Run: bash scripts/build-win.sh" for anyone without a repo checkout. On `v*` tags the `computer-helper-win.yml` workflow now builds the self-contained exe, smoke-tests it, and uploads it plus a `.sha256` as GitHub release assets; `setup --host` resolves a local build first, then downloads the asset for the exact running CLI version, verifies its sha256 against the published checksum, and caches it under `~/.agents/.cache/computer/win-helper/v<version>/`. A tag with no asset is a hard error naming that tag — never a silent fallback to a different release. (GitHub #547) Source: `apps/cli/src/lib/ssh-tunnel.ts` (`ensureWinHelperExe`, `downloadWinHelperExe`), `.github/workflows/computer-helper-win.yml` (`release-exe`).
- **`registerMcp` HTTP transport now routes through the capability table instead of an inline agent-id allowlist.** MCP-over-HTTP support and MCP-header support were gated by hardcoded `agentId !== 'claude' && agentId !== 'codex' && agentId !== 'gemini'` / `agentId !== 'claude'` checks in `apps/cli/src/lib/agents.ts`, bypassing the `capabilities.ts`/`supports()` table that is the single source of truth for "which agent supports what." A newly-added agent would silently get the wrong HTTP-MCP behavior with no compile-time signal. Two new capabilities land on the `AgentConfig` matrix — `mcpHttp` (Claude/Codex/Gemini today) and `mcpHeaders` (Claude only) — and both inline allowlists are replaced with `supports(agentId, cap)` calls. Pure refactor: `capableAgents('mcpHttp')` is `['claude','codex','gemini']` and `capableAgents('mcpHeaders')` is `['claude']`, matching the pre-change behavior exactly. Source: `apps/cli/src/lib/{agents,capabilities,types}.ts`, `apps/cli/src/lib/{agents,capabilities}.test.ts`, `apps/cli/src/lib/__tests__/capabilities.test.ts`. (issue #742 / RUSH-1504)
- **Hook `matches:` predicates are now enforced at fire time — the documented gating was inert.** A hook manifest entry could declare `matches:` predicates (`prompt_contains` / `prompt_matches` / `tool_name` / `tool_args_match` / `cwd_includes` / `project_has` / `git_dirty`) to gate when it fires, and the docs described the gate ("all predicates AND together; an empty block always fires"), but `shouldFire()` (the evaluator in `src/lib/hooks/match.ts`) had **zero runtime callers**: the agent execs the registered command directly and nothing evaluated `matches:`, so any hook with a `matches:` block fired unconditionally. A hook that declares `matches:` (with or without `cache:`) is now registered as a generated wrapper shim that evaluates the predicates against the event JSON on stdin before running the script — a non-matching event exits 0 without running the hook body (logged as `cache:"skip"`), a matching event runs it. Matches-only hooks (no `cache:`) get a gate-only pass-through shim; cached hooks apply the gate before the cache. The shim gate is a faithful port of `shouldFire()` (same AND semantics, same ReDoS guard) and is pinned to it by a 20-case conformance test so the two can't drift. Gating is fail-open: a garbled predicate runs the hook rather than silently disabling a safety hook (e.g. `git-guard`). No installed or bundled hook currently declares `matches:`, so this changes no existing hook's behavior — it activates a documented feature for authors who add one. Verified end-to-end by generating a shim from a `matches: { tool_name: Bash, tool_args_match: "rm -rf" }` manifest and firing it: a `Read` event and a `Bash`+`ls` event were skipped, a `Bash`+`rm -rf` event ran the body. Source: `apps/cli/src/lib/hooks/cache.ts` (`renderShim` gate + pass-through tail), `apps/cli/src/lib/hooks.ts` (`resolveHookCommand`), `apps/cli/docs/hooks.md`. (RUSH-1506)
- **Browser-over-SSH no longer hangs on an unreachable remote host — it fails fast (~10s).** The raw-`ssh` spawns in the browser SSH driver (`ensureRemoteBrowser`, `runSSHCommand`) passed only `-o BatchMode=yes`, with no `ConnectTimeout`, so a dropped SYN to a down host stalled on the OS default TCP timeout (~127s) instead of erroring. Both call sites now compose the shared hardened baseline `SSH_OPTS` from `ssh-exec.ts` (`BatchMode` + `ConnectTimeout=10` + `ServerAlive` keepalive) rather than re-listing options — the same baseline `sshExec` and the `-L` tunnel already use. The options now also precede the target (matching `sshExec`); on macOS/BSD `getopt` an option placed after the target is swallowed into the remote command instead of applied. Verified against TEST-NET `203.0.113.1` (guaranteed unreachable): `-o BatchMode=yes` alone was still hanging at a 30s cap (en route to ~127s), while the `SSH_OPTS` set failed in `10.04s` with `connect to host 203.0.113.1 port 22: Connection timed out`. Source: `apps/cli/src/lib/browser/drivers/ssh.ts`. (RUSH-1508)
- **Fix: OpenCode sessions now load on Windows.** Reading OpenCode sessions shelled out to the `sqlite3` CLI at three call sites — `parseOpenCode` (transcript parse) plus the session scan and active-account lookup in discovery — and that binary is absent on Windows, so OpenCode sessions silently never appeared in `agents sessions` there. All three now read through the same runtime-aware node/bun `Database` wrapper the Antigravity parser already uses (`bun:sqlite`/`node:sqlite`, no native addon, no CLI), and the OpenCode transcript query binds the session id as a parameter instead of interpolating it. No behavior change on macOS/Linux. Source: `apps/cli/src/lib/session/parse.ts` (`parseOpenCode`), `apps/cli/src/lib/session/discover.ts` (`scanOpenCodeIncremental`, `getOpenCodeAccount`). (RUSH-1513)
- **`agents sessions --active --json` now carries the agent's actual decision, not a truncated status line.** A session waiting on you used to collapse everything to a one-line `preview` — an `AskUserQuestion` became the generic `"Asked you a question"` (throwing away the options that are already in the tool input), and a trailing thinking block masked the real turn as `"thinking…"`. The state engine now emits a structured `question` object (`{ text, reason, options: [{ label, description, key }] }`) for every waiting path — `AskUserQuestion` (with each option's 1-based select key), plan review, permission (Approve=`1` / Deny=`esc`), and a trailing prose question — plus a short assistant `tail` for context, and `preview` no longer degrades to `"thinking…"` when a real turn exists. Every consumer (the Factory NEEDS-YOU panel, teams, cloud) now gets the real "what does it want from me" instead of re-deriving it from prose. Verified live: the blocked session in the screenshot now reports `awaitingReason: question` with the real question text. Source: `apps/cli/src/lib/session/state.ts` (`structuredQuestionFromAsk`, `inferActivity`), `apps/cli/src/lib/session/active.ts`. (RUSH-453)

## 1.20.50

- **Distributed agent teams: teammates can now run on different machines across your fleet, not just the box running `teams start`.** A single team can place the backend teammate on a Linux box and the UI teammate on a Mac while one orchestrator still drives the DAG, polls status, and cleans up. One vocabulary, all optional (omit it and teams stay 100% local as before): `teams create --devices a,b,c` (alias `--hosts`) declares a pool the team may auto-schedule onto, `--repo <url|path>` (defaults to the local checkout's `origin`) says how each device gets the code, and `teams add --device X` (alias `--host`) pins one teammate to a host — which needs **no** pool, so "send just one teammate elsewhere" is zero-setup. Placement resolves top-down at launch: explicit `--device` pin → single-device pool (whole team there) → multi-device pool (least-loaded auto-schedule) → local. Remote teammates dispatch over SSH via the existing `agents devices`/host machinery (a third teammate backend beside local and cloud), are monitored by offset-tailing the remote log + `.exit` sentinel, and get the repo auto-provisioned per device (reuse an existing checkout, else clone into `~/.agents/repos/<team>`) with an optional per-teammate git worktree on the host. `teams status`/`teams logs` show each teammate's host and stream its output back with the local mirror capped (~512KB rolling tail) so a 10+-teammate fleet can't blow up the orchestrator. POSIX hosts only in v1 (Windows rejected with a clear message). Source: `apps/cli/src/lib/teams/{scheduler,remoteWorktree,agents,api,supervisor,registry}.ts`, `apps/cli/src/lib/hosts/{progress,passthrough}.ts`, `apps/cli/src/commands/teams.ts`, `apps/cli/docs/teams.md`.
- **NEW: `agents doctor --devices` shows a cross-device agent-readiness matrix.** `agents doctor` could already run on one remote machine via `--host`, but checking the whole fleet meant running the command once per box. `--devices` fans out `agents teams doctor --json` to every registered device (plus the local machine), renders a device × agent matrix, and emits a stable JSON contract with `--json`. `--device <name>` or `--host <name>` scopes the same matrix to a single machine. The remote probe now bootstraps `PATH` with the canonical shim directories before running, so login shells that haven't sourced interactive rc files no longer report false "not installed" negatives. Source: `apps/cli/src/commands/doctor.ts`, `apps/cli/src/lib/teams/agents.ts`, `apps/cli/src/lib/hosts/{passthrough,remote-cmd}.ts`.
- **`agents run codex` / `agents teams` now honor your configured Codex model instead of silently defaulting to `gpt-5.3-codex`.** Codex runs under a per-version `CODEX_HOME`, and your `model` preference (`~/.codex/config.toml`) lives only in the version-home that was active when you set it. A dispatch pinned to a different version read a home with no top-level `model`, so Codex fell back to its built-in default — which a ChatGPT-tier account isn't entitled to use, so the run died with `400: The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account` before doing any work, even though `ag view` reported Codex "signed in". When no explicit `--model` is passed, the model is now defaulted (for Codex) to the top-level `model` in your active `~/.codex/config.toml` and forwarded via `--model`; it's read-only (no file writes), so fanning out many parallel runs to one version-home can't race. Verified live on a box where Codex was 100% unusable: the request model changed `gpt-5.3-codex` → `gpt-5.5` and codex@0.142.0 returned successfully. Source: `apps/cli/src/lib/exec.ts`, `apps/cli/src/lib/shims.ts` (`readCodexConfiguredModel`).
- **Fix: `agents add claude@<version>` now produces a runnable install — it no longer ships a half-built binary that dies with "claude native binary not installed."** `installVersion` runs `npm install --ignore-scripts` (the right posture for the dependency *tree* — never run arbitrary transitive postinstalls), but that also skipped the agent package's OWN postinstall, which for `@anthropic-ai/claude-code` is a required step: the package ships a ~500-byte stub at `bin/claude.exe` plus per-arch native binaries as optional deps, and its `postinstall` (`node install.cjs`) is what copies the correct ~231 MB native binary over the stub. Skipped, every launch died with `Error: claude native binary not installed`. The existing launch-health self-heal (#764, and its Windows/daemon extension) couldn't save it on two counts: the stub reports its breakage *politely* rather than with a raw `ENOENT`, so the probe's missing-binary signature didn't match and the gutted install read as healthy; and the repair path (`ensureAgentRunnable` → clean reinstall) re-ran the same `--ignore-scripts` install, so it never copied the binary either. `installVersion` now runs the **first-party** package's declared `postinstall` after the npm install (scoped to that one package — never the dependency tree, never claude-code's `exit 1` `prepare` guard), best-effort, before the integrity gate. Because `installVersion` is the single choke point for `agents add`, config refresh, run-time heal, and the daemon's proactive heal, this also revives the repair path for the whole class. `isMissingBinarySignature` was additionally widened to recognize the stub's polite phrases (`native binary not installed`, `postinstall did not run`, `optional dependency was not downloaded`) so the self-heal catches this failure mode if a postinstall ever silently no-ops. Verified end-to-end on linux-arm64: `installVersion('claude','2.1.186')` into a clean HOME runs the postinstall automatically, lands the 231,782,112-byte binary (not the stub), and `claude.exe --version` returns `2.1.186 (Claude Code)` — with no manual `install.cjs` step. Source: `apps/cli/src/lib/versions.ts` (`installVersion`, `isMissingBinarySignature`).

## 1.20.49

- **`agents run --mode plan` no longer hard-fails on agents without a read-only mode (antigravity, cursor, kiro, …).** Those agents have no plan flag, so an explicit or default `--mode plan` used to abort with `does not support 'plan' mode` — breaking multi-agent scripts that pass a uniform plan flag, and diverging from `agents teams add` (default mode `edit`). `resolveMode` now degrades unsupported `plan` to the agent's safest native mode (`capabilities.modes[0]`, typically `edit`), matching the existing `auto` → `edit` degrade. The CLI prints a yellow warning when the user explicitly asked for plan (gray for the implicit default) so the elevation is never silent. `skip` still hard-fails when unsupported. Source: `apps/cli/src/lib/exec.ts`, `apps/cli/src/commands/exec.ts`.
- **`agents cloud cancel` now actually cancels paused runs.** `RushProvider.cancel()` issued `DELETE /api/v1/cloud-runs/{id}`, which the backend doesn't implement — it 404s — so `agents cloud cancel` (and the Factory Floor's cancel affordance) silently failed on any run that wasn't actively running: `queued`, `needs_review`, and `input_required` runs stayed stuck (e.g. a 14-day-old input-required run lingering in the Floor's "NEEDS YOU" bucket forever). Switched to the cancel action endpoint `POST /api/v1/cloud-runs/{id}/cancel`, which the backend implements and which cancels paused runs too. Verified live against `api.prix.dev` (the POST returned `{"ok":true,"status":"cancelled"}` and the stuck run transitioned `needs_review` → `cancelled`). Source: `apps/cli/src/lib/cloud/rush.ts`.

## 1.20.48

- **Menu-bar helper: a RECENT TICKETS section shows the issues you filed via the quick-issue bar, each clickable to open in Linear.** The completion notification is transient, so the tickets the `Cmd-Shift-O` bar creates now also persist to a small local ledger (`~/.agents/.history/menubar/recent-tickets.json`, newest-first, deduped by id, capped at 10) that the menu-bar dropdown surfaces below RECENT sessions — click a row to open the ticket. The dispatch records the id + note + Linear URL on a successful create; the section renders nothing when the ledger is empty. Source: `apps/cli/menubar/Sources/MenubarHelper/{RecentTickets,StatusItemController,AgentsCLI,IssueSelfTest}.swift`.
- **Menu-bar helper: the quick-issue completion notification now deep-links to the created ticket, and the helper self-heals onto the install you actually run.** Two fixes from dogfooding the `Cmd-Shift-O` bar. (1) **Clickable notification** — the "Created RUSH-####" banner carried no click target, so there was no way to open the ticket. The ticket agent now also prints the issue's `URL:` line, the helper parses it, and clicking the notification (or its **Open** button) opens the ticket in Linear (via an `NSUserNotificationCenterDelegate`; the banner is also force-presented so it can't be silently swallowed when the accessory app is frontmost). (2) **Dual-install self-heal** — the helper bakes the node interpreter + CLI entry into its launchd plist so a GUI process can find `agents` without a login PATH, but the staleness check only re-baked on a *version* change. With two installs present (e.g. an nvm copy and a bun copy), the plist kept pointing at whichever copy first wrote it, so the menu data **and** the quick-issue dispatch ran on a stale install even after `agents upgrade`. The startup self-heal now also re-points when the plist's baked `AGENTS_ENTRY`/`AGENTS_NODE` no longer match the install currently running `agents` (a null active entry — a dev/tsx run — never churns the plist). Source: `apps/cli/menubar/Sources/MenubarHelper/{PromptPanel,AgentsCLI,IssueSelfTest}.swift`, `apps/cli/src/lib/menubar/install-menubar.ts`.
- **The npm release can now be driven from a Linux box** by offloading the Mac-only helper signing to a remote sign host. The tarball bundles two signed macOS `.app` helpers a Linux runner can't build — `bin/Agents CLI.app` (the keychain helper: `swiftc` universal → codesign with entitlements + embedded provisioning profile → `notarytool` → staple) and `bin/MenubarHelper.app` (the menu-bar status item: `swift build` → codesign, no notarization) — which is the only reason publishing was macOS-pinned. New `scripts/remote-sign-mac.sh` (invoked automatically by `release.sh` when it runs on a non-macOS host and the signed apps are absent, or on any host with `FORCE_REMOTE_SIGN=1`) rsyncs the build inputs to `${SIGN_HOST:-mac-mini}`, runs both Mac build scripts there under the appliance's headless signing creds (unlocks `rush-signing.keychain-db`, injects Apple notary creds via the `apple.com` secrets bundle), then pulls the signed `bin/*.app` back and re-verifies the keychain sha locally. The `build` script now copies the helpers into `dist/` on a **presence** gate (`[ -d 'bin/…' ]`) instead of `[ "$(uname)" = 'Darwin' ]`, so a Linux box that pulled the pre-signed bundles packages them, and `prepack`'s sha gate uses `shasum` or `sha256sum` (whichever is present) so it works on Linux too. Override the sign host with `SIGN_HOST` and its checkout with `SIGN_HOST_REPO`. Source: `apps/cli/scripts/remote-sign-mac.sh`, `apps/cli/scripts/release.sh`, `apps/cli/scripts/verify-keychain-helper.sh`, `apps/cli/package.json`.

- **The shim self-heal now repairs shims that point at a *removed* install and prunes orphaned command shims.** A dispatch shim bakes its `AGENTS_BIN` (the agents-cli entrypoint it execs) at generation time, so when that install moves or is deleted — a dev build under `~/.local/agents-cli-dev`, an old npm-global under `/opt/homebrew`, a rotated version dir — the shim keeps pointing at the dead path. Agent shims survive it via their runtime self-recovery block, but the previous self-heal only compared the *schema marker*, so a schema-current shim aimed at a removed install read as healthy and was never repaired. Two additions to the `shims` self-heal check (daemon + interactive startup): (1) **drift repair** — an agent shim whose baked `AGENTS_BIN` names a *different, now-missing* install is force-regenerated to the current install (`shimPointsAtLiveInstall`); a shim pointing at another install that still exists is left alone, so two live installs sharing the shims dir can't ping-pong. (2) **orphan prune** — legacy standalone command shims (`browser`/`secrets`/`sessions`/`teams`/`pty`) that a removed install left in the shims dir, which the current source never regenerates and which either die with `exit 127` or shadow the real package bin on PATH, are removed when their baked install is gone (`pruneOrphanedCommandShim`); user `agents alias` shims and any shim whose install still exists are spared. Verified end-to-end against a real machine carrying a deleted dev build + a removed Homebrew install: the agent shims repoint to the live install and five dead command shims are pruned. Source: `apps/cli/src/lib/shims.ts` (`shimPointsAtLiveInstall`, `pruneOrphanedCommandShim`, `listShimFileNames`), `apps/cli/src/lib/self-heal/checks/shims.ts`.

## 1.20.47

- **Quick-issue bar (`Cmd-Shift-O`): `Cmd-V` now pastes into the note field, and double-clicking a screenshot thumbnail opens it in Preview.** Two fixes from dogfooding the new bar. (1) The panel is a borderless `.accessory` window with **no main menu**, so the standard clipboard key-equivalents (`Cmd-V`/`C`/`X`/`A`) were never dispatched to the field editor — paste silently did nothing. `PromptPanel.performKeyEquivalent` now routes them through the responder chain so the text field handles them. (2) Thumbnails are small, so there was no way to confirm which screenshot you were attaching: **single click still toggles selection, double click opens the full image in the default viewer (Preview)**. The single-click toggle is deferred by the double-click interval so a double-click previews without also flipping the selection, and the bar suppresses its own click-outside dismissal while Preview takes focus (so summoning Preview never closes the bar or drops your typed note; it re-arms when the bar regains focus). Source: `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`.
- **Fix: the headless file-store fallback no longer silently shadows the OS keyring; NEW `agents secrets import-keyring` migrates stranded secrets into it.** On headless Linux/Windows the encrypted-file store is *sticky* — once any item is on disk, `preflight()` routed **every** op to the file store and never consulted GNOME Keyring / Windows Credential Manager again, so a secret written earlier into the native store (e.g. while a desktop keyring was unlocked) read back **empty** with no hint. This stranded real Linear CLI credentials in a locked keyring while other bundles lived in the file store, silently breaking the SessionStart hook. Two fixes: (1) `get`/`has` now **read through** to the native store on a file-store *miss* (the fast path and the non-fallback keychain-first path are untouched — the file store is still checked first), emitting a one-time stderr notice pointing at `import-keyring`; once a locked/`1312` error is seen the store is marked unreachable so it stops re-probing a known-dead store. (2) NEW **`agents secrets import-keyring`** — the Linux/Windows analogue of the macOS `migrate-acl`/orphan sweep — enumerates `agents-cli` items in the native store and copies them into the encrypted file store (the durable, passwordless headless backend). Dry-run by default; `--commit` writes; existing file-store items are never overwritten; Windows enumeration is floored to the `agents-cli.` namespace since Credential Manager targets have no service scoping. macOS is unaffected (it has no file fallback and keeps `migrate-acl`). Source: `apps/cli/src/lib/secrets/{fallback,linux,windows,index}.ts`, `apps/cli/src/commands/{secrets-import,secrets}.ts`, `apps/cli/docs/secrets.md`.
- **Launch-health self-heal now covers Windows, and the daemon repairs a gutted install proactively — before your next `agents run`.** #764 gave `agents run` an install/run-time self-heal (probe `<binary> --version`; clean-reinstall in place, else fall back to another installed version that launches), but it **skipped the probe on Windows** — `verifyInstalledBinaryLaunches` returned healthy on `win32` unconditionally, because probing the extensionless `.bin/<cli>` wrapper would ENOENT even on a *healthy* install. So the exact Windows failure the self-heal was built for went unhealed: a vendor auto-update renames the native `claude.exe` to `claude.exe.old.<epochMs>` and never lands the replacement, leaving the shim chain intact but pointing at a missing file, and every launch dies with `'…claude.exe' is not recognized`. The probe now runs on Windows against the **real launch target** — the npm `.cmd` wrapper `agents run` actually execs (`getBinaryPath + '.cmd'`, resolved via `cmd.exe`), which chains to the native `.exe` — so a gutted install trips the existing missing-binary signature (`is not recognized`) and is repaired by the same `ensureAgentRunnable` machinery; a missing `.cmd` (a non-npm/global agent like `droid.exe`) is still treated as healthy so a good install is never destroyed. Separately, the **daemon** now runs a proactive launch-health pass (`healBrokenDefaultLaunches`) ~90s after startup and every ~6h: it probes each agent's default version and, if it won't launch, repairs it in the background — so a gutted install is fixed *before* the next `agents run` hits the ENOENT, not at spawn time (the run-time `ensureAgentRunnable` only fires once a run is already starting). Verified end-to-end on a real Windows host: renaming `claude.exe` to `.old` makes the `.cmd` probe emit `is not recognized`; restoring it returns `2.1.191 (Claude Code)`. Source: `apps/cli/src/lib/versions.ts` (`verifyInstalledBinaryLaunches`, `healBrokenDefaultLaunches`), `apps/cli/src/lib/daemon.ts`.

## 1.20.46

- **NEW: `Cmd-Shift-O` opens a Spotlight-style quick-issue bar in the menu-bar helper — type a sentence, attach recent screenshots, and an agent files the Linear ticket for you.** The menu-bar helper already turned a screenshot into a `<host>:<path>` token with `Cmd-Shift-V` (clip capture), but there was no path from "I see a bug" to "a triaged ticket exists." The new chord summons a borderless panel (a thin capture surface, not another form): you type a one-line note, optionally toggle one or more recent screenshots (from the system screencapture folder, CleanShot's export path, or the clip history) as a thumbnail strip (the newest is pre-selected when it's fresh), and hit Return. It then **dispatches a headless agent** (`agents run claude --mode auto`, isolated behind one `AgentsCLI.dispatchTicketAgent` call so a cloud pod is a later swap) that reads the screenshots, runs `agents sessions` to identify which repo/project this concerns, does a brief investigation for real context, and files the ticket via `~/.agents/skills/linear/scripts/linear create` with an honest priority + a `repo:<name>` label — no preview step, the panel closes immediately and a notification reports the created `RUSH-####`. Focus is handled for a no-Dock `.accessory` app (`NSApp.activate` → `makeKeyAndOrderFront` → `makeFirstResponder`, with a borderless `NSPanel` overriding `canBecomeKey`; click-outside dismissal is armed only after the summon settles so the activation race can't self-dismiss the panel). The `Cmd-Shift-V` clip hotkey is unchanged — the Carbon hotkey manager now demultiplexes both chords by `EventHotKeyID.id` through one installed handler. Self-test: `MENUBAR_ISSUE_TEST=1 MenubarHelper` exercises screenshot selection, ticket-id parsing, and the meta-prompt contract; `MENUBAR_PROMPT_PREVIEW=1` renders the panel without the global hotkey for QA. Source: `apps/cli/menubar/Sources/MenubarHelper/{PromptPanel,Hotkey,AgentsCLI,main,IssueSelfTest,Clip}.swift`.
- **NEW: a unified self-heal subsystem — the shim/PATH "repair" notice no longer nags on every terminal, and the daemon now heals shim drift in the background.** agents-cli had accumulated ~37 separate repair routines scattered across the daemon, every CLI startup, and a handful of commands, each hand-rolling its own detect+fix on its own trigger. The most visible symptom: the interactive shim bootstrap (`maybeBootstrapShimIntegration`) regenerated shims, adopted shadowing launchers, and offered to add the shims dir to PATH **in the foreground on every invocation**, suppressed only by a `process.ppid`-keyed temp sentinel — so a new terminal re-ran the whole detect-and-nag, and the underlying condition was never permanently fixed. This lands a single `HealCheck` registry (`lib/self-heal/`) with one runner (`runSelfHeal`) driven by two front doors — the daemon (on its existing ~30s-after-start + ~6h `safe`-mode cycle) and the interactive startup — sharing the same checks: `shims` (regenerate stale shims/aliases), `shadowing` (adopt symlink launchers; report real-binary shadows), `path` (add the shims dir to PATH once), and `resources` (the existing `heal()` engine, wrapped unchanged). The daemon's heal cycle now runs all four in `safe` mode (low-risk fixes silently; risky ones reported), replacing the resource-only `heal()` call — and drops the desktop toast for background heals (the log is the record). The interactive startup now heals **silently** and prints at most a **persistent, once-per-condition** notice (`lib/shim-heal.ts`, keyed to a signature of the actionable state under `~/.agents/.cache/state/shim-notice.json`) for what a machine genuinely can't fix for you — a real native binary shadowing the shim — instead of re-nagging every shell. What changes is *where* the repairs run (background/silent) and *how often* you hear about them (once, not every terminal). Source: `apps/cli/src/lib/self-heal/` (new), `apps/cli/src/lib/shim-heal.ts` (new), `apps/cli/src/lib/daemon.ts`, `apps/cli/src/index.ts`, `apps/cli/src/lib/shims.ts` (`isShimCurrent` exported).

## 1.20.45

- **NEW: `agents run <agent> --host <name>` without a prompt forwards your TTY over SSH and runs the agent interactively on the remote host.** Previously `--host` runs required a prompt and were always headless (`agents run <agent> "<task>" --host <name>`). Now, omitting the prompt takes the interactive path: when local stdin is a TTY, the local CLI SSHes with `-tt`, runs `agents run <agent>` on the host, and lets the remote machine's `agents` start its normal tmux wrapper. The tmux session lives on the remote box, so detaching (`Ctrl-b d`) ends the SSH connection but keeps the agent running; you can reattach from the host or resume by session id. Session ids for Claude are still minted up front so `agents sessions` can surface and resolve the remote run. `--no-follow` is rejected for interactive host runs (it is meaningless for an attached TTY), and `--mode`, `--model`, `--name`, passthrough args after `--`, and `--raw`/`--no-tmux` are forwarded to the remote invocation. Source: `apps/cli/src/commands/exec.ts`, `apps/cli/src/lib/hosts/dispatch.ts`, `apps/cli/src/lib/hosts/session-index.ts`, `apps/cli/docs/hosts.md`.
- **`agents secrets export --host` now works against Windows targets, and a new `agents secrets unlock --host` unlocks a bundle on a remote machine.** The export push was POSIX-only (`bash -lc`, `--from /dev/stdin`, `create … || true`, `IFS= read`), so a Windows remote died with `'true' is not recognized … cannot find the path specified`. Two changes fix it: `agents secrets import` now accepts **`--from -`** (read the `.env` from stdin, replacing the POSIX-only `/dev/stdin`), and the push is **platform-aware** — `bash -lc` on POSIX, `powershell -EncodedCommand` on Windows, with the target's OS taken from the device registry. Because the npm `agents.ps1` shim does **not** forward ssh-piped stdin to the underlying node process (a raw `--from -` read hangs), the Windows keychain push bridges the piped `.env` through PowerShell into a temp file and imports `--from <file>` (deleted afterwards). File-backend export to a Windows target is refused cleanly rather than emitting broken PowerShell. Verified end-to-end: `agents secrets export linear.app --host win-mini` imported all 13 keys. Separately, **`agents secrets unlock --host <machine> <bundle>`** runs the unlock ON the remote over `ssh -tt`, so a **file-backed** bundle's passphrase prompt surfaces on your terminal — the "unlock the Mac from the road with its password" path; keychain/biometry bundles are GUI-only (a local Touch-ID/passcode sheet can't cross SSH) and can't be remote-unlocked. `unlock`'s `--host` is single-valued so it never swallows the positional bundle name. Source: `apps/cli/src/commands/secrets.ts`, `apps/cli/src/lib/hosts/remote-cmd.ts`.
- **A session now has ONE name, not two. `--name` seeds the session label instead of a parallel column.** Shipping `agents run --name` (1.20.43) as a separate immutable `name` column created two look-alike fields — an unshown, frozen `name` and the shown, searchable `label` — that both resolved `agents sessions <ref>` and forced tie-break bookkeeping nobody could keep straight. They unify into one field. `--name` is now the universal way to *seed* the `label` at launch — the same field an agent-generated title (Claude's `/rename`) later refines and `agents sessions` displays and searches — and it works consistently across interactive, headless, `--host`, and teams teammate runs (a teammate's friendly name now seeds its session label; before, teammate sessions had no name at all). Priority is a plain fallback chain resolved at scan time, no stored winner: an agent-generated title wins, else the `--name` seed, else the listing falls back to `topic`. So a Claude run's `--name` shows until Claude titles it (your seed, then refined); a non-Claude run keeps its `--name` as the label (it has no auto-title). The seeded name is now fuzzy-searchable in FTS (the old `name` column was not). `agents hosts logs <name>` is unchanged — it resolves against the host-task sidecar, not the session column. Schema v10 folds any existing `name` into `label` (where the label was empty), mirrors it into the FTS row, then drops the `name` column; the run-name sidecars re-seed every scan (`seedLabelsFromNames`), so no rescan is needed. Reworks the 1.20.43 `--name` design (partly reverts its separate-column approach). Source: `apps/cli/src/lib/session/{db,discover,run-names,types}.ts`, `apps/cli/src/lib/hosts/session-index.ts`, `apps/cli/src/lib/teams/agents.ts`, `apps/cli/src/commands/exec.ts`, `apps/cli/docs/{05-sessions,hosts}.md`.
- **NEW: `agents teams add`/`start` warns when a *version-pinned* teammate is on a throttled or signed-out account.** The 1.20.43 `balanced`-default fix keeps *bare* teammates off rate-limited accounts (they route through bare `agents run`, which rotates), but a **version-pinned** (`claude@2.1.112`) or **profile** teammate spawns `agents run <agent>@<version>` / `agents run <profile>`, and a pin/profile deliberately *bypasses* rotation — so it would launch straight onto a maxed account and 429 on the first request, with no mid-run failover either (that only arms when a non-pinned strategy actually rotated). `agents teams add` (at add time) and `agents teams start` (per staged teammate, deduped by `agent@version`) now pre-check a **version-pinned** teammate's account and print an advisory when it's rate-limited, out of credits, or not signed in — reusing the router's *exact* eligibility gate (`checkRunAccountReadiness` → `hasUsageAvailable`, the same session-inclusive signal the `agents view` badge uses), so the warning can never disagree with what the spawn would actually do. It **warns, never blocks** (mirroring the existing "may not be signed in" advisory); `--force` silences it. Scoped to version-pinned teammates on purpose: bare teammates are already handled by rotation, and a profile injects its own auth (a different account than the version home carries) that isn't locally checkable — so no unreliable profile warning is emitted. Source: `apps/cli/src/lib/rotate.ts` (`readinessFromCandidate`, `checkRunAccountReadiness`, `rotate.test.ts`), `apps/cli/src/commands/teams.ts`.

## 1.20.44

- **Every `logs` command is concise by default; the token-heavy raw dump is now opt-in behind `--full`.** Agents that spin up agents on other machines or add teammates were pulling whole transcripts just to glance at status — `agents logs <session>` printed the full markdown transcript, and `agents hosts logs` / `agents teams logs` / `agents routines logs` each `cat`'d their entire captured stdout, because each subsystem had hand-rolled its own "cat the log" verb over its own storage. All four now default to a bounded, concise view, with `-m/--full` for the raw log: `agents logs <session>` renders the same summary digest as `agents sessions <id>` (a real session shrank 92% — 29.9 KB → 2.6 KB); `agents routines logs <name>` shows a status header + the extracted report (a real run shrank 99.5% — 386 KB → 1.8 KB), falling back to a bounded stdout tail when no report was extracted; `agents teams logs <teammate>` renders the teammate's session summary (its agentId **is** the session id), with `-n <lines>` / `--full` for raw stdout; `agents hosts logs <id>` shows a bounded tail of the captured stdout (`tailLines`, with a "… N earlier lines hidden — pass --full" note) instead of the whole log. `renderSessionLog` now takes a mode and defaults to `'summary'`; `agents sessions <id>` was already summary-by-default and is unchanged. Regression-tested: `tailLines` truncation/elision math (`hosts/logs.test.ts`) and `formatRunDuration` human-time formatting (`routines-logs.test.ts`). Source: `apps/cli/src/commands/{logs,sessions,hosts,teams,routines}.ts`, `apps/cli/src/lib/hosts/logs.ts`. Scoped follow-up (not in this PR): host-task and sandboxed-routine runs write their real transcript on the remote / in an overlay HOME, so `logs` can't yet resolve them to the full `renderSummary` — making those runs discoverable is a separate change; until then the bounded tail / extracted report is the safe concise default.
- **The daemon now self-heals the `pane-died` hook on already-running `agents run` sessions.** The v1.20.42 fix that stops exiting a split from kicking you out of tmux is installed once, at session creation — so sessions already alive under the long-lived shared tmux server keep the old, unconditional `detach-client` hook until they exit or the server is recycled. On a machine that's never "between sessions," that meant hand-repairing live sessions. The daemon now runs `reconcileSessionHooks()` ~20s after startup and every ~5 min: it walks the managed `ag-` sessions on the shared socket and retrofits the `#{hook_pane}`-guarded hook onto any whose hook predates the current schema. It is strictly **non-destructive — `set-hook` only, never a `kill-pane` or `detach-client`** — so it is safe to run against sessions you're attached to; a per-session `@ag_hook_schema` marker makes steady-state a no-op. The hook string is now built in one place (`agentPaneDiedHook`) shared by the spawn-wrap and the reconcile so they can't drift. Source: `apps/cli/src/lib/tmux/session.ts`, `apps/cli/src/lib/daemon.ts`, `apps/cli/src/lib/exec.ts`.
- **NEW: `agents run` self-heals a gutted install instead of crashing with `ENOENT`.** The recurring failure: an npm agent whose native binary ships as an optional per-arch dependency (codex → `@openai/codex-<platform>`) can have that tarball extract **partially** — the platform package's `package.json` lands, its `vendor/<triple>/…/codex` binary does not (an interrupted or concurrently-raced `agents add` into the same version dir). The CLI's wrapper `require.resolve`s the platform package, finds the `package.json`, and sails straight past its own "missing optional dependency" guard into a `spawn(binaryPath)` that dies with a raw `ENOENT`. `agents run` now probes the version it's about to launch and, if the binary can't run, **repairs it in place** (a *clean* reinstall — the partial `node_modules` is wiped first, because npm treats the present-but-gutted platform package as already installed and would otherwise skip re-fetching it), then falls back to another installed version that launches (re-pinning it as the default so the shim path heals too), then to installing `latest` — only erroring if nothing can be made runnable. `installVersion` gained a `{ clean }` option for the wipe-then-reinstall. Source: `apps/cli/src/lib/versions.ts` (`ensureAgentRunnable`), `apps/cli/src/commands/exec.ts`.
- **Fix: a broken agent install no longer launches into a silent `[detached]` — the real crash is surfaced.** When an interactive `ag run <agent>` wrapped the agent in tmux and the agent died the instant it spawned (e.g. a gutted install crashing with `spawn … ENOENT`, a bad flag, a startup crash), the `pane-died` hook detached the client before you could read anything — you got a bare `[detached (from session …)]` with zero indication of why. `runInTmux` now recaps the dead pane's last output (read from scrollback via `capture-pane -S -200`, since the pane's visible screen is just the "Pane is dead" banner) plus the exit code to stderr, and points you at `--no-tmux`. Fast failures (dead before attach) always recap; a post-attach nonzero exit recaps too (a clean exit or a manual detach stays quiet). Source: `apps/cli/src/lib/exec.ts`, `apps/cli/src/lib/tmux/session.test.ts`.
- **NEW: `--no-tmux` / `--disable-tmux` on `agents run`.** The interactive tmux wrapper (which gives `%pane` addressing + re-attach) already had an opt-out, but it was hidden behind the opaquely-named `--raw`. `--no-tmux` (and its alias `--disable-tmux`) spawn the agent directly with full stdio inherited — the fastest way to see an agent's real startup output when a launch is failing. Same effect as `--raw` and `AGENTS_NO_TMUX=1`. Source: `apps/cli/src/commands/exec.ts`.
- **Fix: `agents add <agent>@<version>` no longer records a gutted install as healthy (root cause of the ENOENT crash + a broken default pin).** npm packages that ship their native binary via an optional per-arch dependency (e.g. codex → `@openai/codex-<platform>`) can land the JS wrapper at `node_modules/.bin/<cli>` while the real platform binary is missing (interrupted install, omitted optional dep, `--ignore-scripts`). `getBinaryPath()` only checked the wrapper, so the broken version read as installed, got pinned as the default, and got picked to run — then died with ENOENT. `installVersion` now probes `<binary> --version` (under the version's isolated HOME) after install and **fails the install** if the binary can't launch, so a broken version is never silently pinned. The check is deliberately narrow — only the missing-binary signature (`ENOENT`/"no such file"/"command not found") fails it; a plain nonzero exit or a timeout is treated as healthy, so a well-behaved agent that dislikes `--version` is never false-failed. Source: `apps/cli/src/lib/versions.ts`, `apps/cli/src/lib/versions-integrity.test.ts`.
- **Security fix: the routines daemon log no longer leaks GitHub / AWS / npm tokens.** `daemon.ts` carried its own private `redactSecrets` (used by every `log()` write to `logs.jsonl`) that predated and diverged from the canonical `redact.ts` — it caught `sk-`, `eyJ…`, `Bearer …`, and a narrow `NAME=value` list, but **not** `ghp_` (GitHub PAT), `AKIA…` (AWS access key), or `npm_` (npm token), so any of those appearing in a daemon message (a git push URL, a bundle-env dump, an error string) was written to the log in the clear. The private copy is deleted; `log()` now routes through the canonical `redactSecrets` in `redact.ts`, which covers all of those classes with a stronger quote-aware `NAME=value` pattern. The one pattern the daemon copy had and the canonical lacked — `Bearer <token>` — is added to `redact.ts`, so the shared redactor (also used by session-transcript export in `session/render.ts`) is now a strict superset. New `redact.test.ts` pins every token class as a regression guard. Source: `apps/cli/src/lib/daemon.ts`, `apps/cli/src/lib/redact.ts`, `apps/cli/src/lib/redact.test.ts`.
- **Fix: `agents teams doctor` tells the truth, a version fallback never spawns an unspawnable literal, and shims survive a vanished dispatcher (completing this release's self-heal series).** Three gaps remained after the `agents run` self-heal above. (1) **`agents teams doctor` lied** — it reported `installed: true` whenever a *shim file* existed, never checking the real binary, so a stub or gutted-native install (the exact codex/kimi failure) showed "ready" and then `ENOENT`'d at spawn. `checkCliAvailable` now verifies the resolved default version is actually installed, and doctor additionally **launch-probes** each installed agent (`verifyInstalledBinaryLaunches`) and flips a gutted-native one to not-installed with a repair hint. (2) **A version fallback spawned an unspawnable literal** — when a specific version was requested (`agents run kimi@0.19.2`, the path every version-pinned teammate takes) and no versioned shim existed on disk, the launch left the bare `<agent>@<version>` name as `argv[0]`, which is not on PATH, so it died with `spawn kimi@0.19.2 ENOENT`; it now resolves the version's real binary (`getBinaryPath`) instead, falling back to the literal only when no binary exists at all. (3) **A shim couldn't survive its dispatcher vanishing** — when the baked `AGENTS_BIN` (often a dev build under `~/.local/agents-cli-dev`) was removed, moved, or went stale, the shim exited 127 and bricked *every* managed launch; it now **self-recovers** to whatever `agents` resolves to on PATH before erroring (`SHIM_SCHEMA_VERSION` → 25). Also drops a stale, npm-unrecoverable `codex 0.116.0` pin from the repo's own `agents.yaml` so codex resolves to the machine default instead of self-healing on every run. Source: `apps/cli/src/lib/{exec,shims}.ts`, `apps/cli/src/lib/teams/agents.ts`, `apps/cli/src/commands/teams.ts`, `agents.yaml`.

## 1.20.43

- **NEW: `agents run --name <slug>` — a durable, human/agent-friendly handle for any run.** An agent that dispatches another agent had no cheap status handle: the host-task id was never even printed (the `--no-follow` tip showed a literal `<id>` placeholder), and only Claude's session id is known up front (pre-minted `--session-id`) — every other agent's id is discovered later by scanning transcripts, so callers fell back to `agents logs`, which dumps the raw, token-heavy transcript. `--name` is chosen at launch, agent-agnostic, and stored on the structures that already back these views: a first-class `name` column on `sessions.db` (schema v9, additive, no rescan) parallel to `label` — `agents sessions <ref>` resolves against **both** name and label; the HostTask sidecar (forwarded to the remote run, so `agents hosts ps` gains a NAME column and `agents hosts logs <name>` resolves by name); and a run-name sidecar (`~/.agents/.cache/run-names/`) that joins a local run's name onto the index by id every scan via `syncNames` — the same idempotent pattern as `/rename` label sync. The `name` column is deliberately left out of the upsert `ON CONFLICT … SET` clause, so a discovery rescan can never null an existing name (regression-tested in `db.names.test.ts`). Omitting `--name` is a strict no-op: `name` stays unset and every id-based path is unchanged. The `--no-follow` dispatch tip now prints the real handle and steers to the compact `agents sessions` digest over the raw log. Source: `apps/cli/src/commands/exec.ts`, `apps/cli/src/lib/session/{db,run-names,discover}.ts`, `apps/cli/src/lib/hosts/{dispatch,tasks}.ts`.
- **New terminals (and teammates) no longer launch into a rate-limited account; `balanced` is now the default run strategy.** Two coupled fixes. (1) A bare `agents run <agent>` — every new agent terminal the extension spawns, and every non-version-pinned `agents teams add`/`start` teammate, since both route through bare `agents run` — used to default to the `available` strategy, which *prefers the pinned default version when it looks healthy*. But "healthy" was judged by the router's `getRoutingUsedPercent`, which **excluded the 5-hour session window** and looked at weekly usage only. So a session-maxed account with weekly headroom (e.g. session 100% / week 60%) was deemed eligible and kept getting launched — while `agents view` showed it "rate-limited" (its badge, `deriveUsageStatusFromSnapshot`, *counts* the session window). The router and the badge disagreed. Now `hasUsageAvailable` shares the badge's exact signal: an account maxed on **any** blocking window (session or weekly) is ineligible and skipped by both `available` and `balanced` — you never spin up an agent on an account that can't serve the next request. Capacity *weighting* still ranks eligible accounts by weekly headroom, so a brief session spike doesn't distort long-run routing. (2) The default strategy is now `balanced` (was `available`): a bare run spreads load across all healthy accounts by remaining headroom instead of sticking to the pinned default. Override per-workspace with `run.<agent>.strategy` in `agents.yaml`, or per-invocation with `--strategy` / `-b`. Source: `apps/cli/src/lib/rotate.ts`, `apps/cli/src/lib/usage.ts`, `apps/cli/src/commands/exec.ts`.
- **[browser] Logins survive browser restarts: sandboxed profiles keep memory-only session cookies, without restoring tabs.** Sites that issue login cookies with `expires=-1` (idealista, many banking/classifieds sites) logged the profile out on every browser restart, because Chromium purges memory-only session cookies at startup unless the session-restore preference is set — a constraint that had already leaked into agent designs as "sessions can't survive restarts". Every launch now pins `session.restore_on_startup: 1` ("continue where you left off") in the profile's `Default/Preferences`, which is the switch Chromium's cookie purge actually keys off — and pairs it with `--no-startup-window` so the *visible* side of restore never happens: no window exists at startup for restore to fill, no ghost tabs from the last task reopen, and the task flow creates its own tab over CDP exactly as before. Verified live on Windows/Comet: a memory-only cookie planted pre-restart was still present after a full stop/start, with OS-level window enumeration confirming a single window and zero restored tabs. The Preferences patch runs pre-spawn (browser down, so Chromium can't overwrite it on exit), stamps the profile name only on first launch, skips malformed files untouched, and is a no-op when already set. Electron profiles keep the old name-only seeding — they manage their own storage and need their startup window (the CDP driver binds to it). Bare `agents browser start` (no `--url`) recreates the old startup-window affordance by opening a blank page target when none exists, unregistered on the task like the startup window always was. Server-side session TTLs still apply — this removes the restart logout, not the site's own expiry. Source: `apps/cli/src/lib/browser/chrome.ts` (`ensureProfilePreferences`, launch args), `apps/cli/src/lib/browser/service.ts`.
- **Security fix: `agents sessions --host <target>` no longer accepts a leading-dash target (SSH argv-flag smuggling).** `session/remote.ts` carried its own copy of `assertValidSshTarget` that omitted the `host.startsWith('-')` guard every other SSH path enforces, so a bare flag like `-l` or `-F/path` — which passes the character allowlist — was handed straight to `ssh` as an argument (`-oProxyCommand=…`-class injection) before any connection. The duplicate validator (and its `SSH_TARGET_RE`) is deleted; `runRemoteSessions` now routes through the canonical `assertValidSshTarget` in `ssh-exec.ts`, whose dash guard is already regression-tested (`ssh-exec.test.ts`). Source: `apps/cli/src/lib/session/remote.ts`.

## 1.20.42

- **Fix: exiting a split pane inside an interactive `ag run` session kicked you out of tmux entirely.** When you split the window of an interactive agent session (`ag run claude`) with Ctrl-b `"`/`%` and then `exit`ed *your* split, the whole tmux client detached and dumped you back to the parent shell — even though the agent was still running in the other pane. Cause: `runInTmux` installed a session-wide `pane-died` hook (`detach-client`) meant to fire only when the AGENT pane exits (so the attach returns and the exit status is read), but with no `#{hook_pane}` guard it fired for *any* pane's death. The hook is now scoped to the agent pane; a user split that exits is closed in place (`kill-pane`, no lingering dead husk) and the agent keeps running full-window. Source: `apps/cli/src/lib/exec.ts`, `apps/cli/src/lib/tmux/session.test.ts`.
- **Every secret-value read is now audited, not just the ones that flowed through the resolver.** `agents events --module secrets` (or `--event secrets.get`) is meant to show "every secret accessed or revealed", but several paths read plaintext values without going through `readAndResolveBundleEnv` (the only place that emitted `secrets.get`), so they were invisible: `secrets push` (which reads the whole bundle to upload it — the most sensitive silent read), `secrets view --reveal`, the raw `secrets get <item>`, `secrets set <item>` (a raw write, no `secrets.set`), and the *initiating* side of `secrets exec --host` / `run --secrets bundle@host` (only the remote host logged it). Each now emits with a `source` telling you HOW it was read — `keychain`, `agent` (served from the unlocked broker), `reveal`, `raw-item`, `sync-push`, or `remote` (with the target `host`) — alongside the bundle, caller, keyCount, and OS-user/host/transport. The resolved **value is never written to the log**, only names and counts. All `secrets.*` events are now tagged `module: 'secrets'` so `--module secrets` actually surfaces the value reads (previously it matched only the coarse command events). Note: the event log has a 7-day retention, so export what you need for long-term records. Source: `src/lib/secrets/bundles.ts`, `src/lib/secrets/sync.ts`, `src/lib/secrets/remote.ts`, `src/commands/secrets.ts`, `docs/06-observability.md`.
- **Fix: `sessions --active` showed the SAME preview + topic for every co-located session.** Multiple Claude sessions in one cwd (e.g. several editor tabs, or two worktree siblings) all rendered identical activity — they looked like duplicate cards. `findClaudeSessionFile` fell back to the newest `.jsonl` in the cwd whenever a session's `<id>.jsonl` wasn't found, so every distinct session collapsed onto ONE file's preview/topic. The stale-id trigger: an editor caches the launch uuid in `live-terminals.json`, but Claude rotates its transcript uuid on resume/compact, so the cached id no longer matches any file. Now the terminal path resolves each tab's EXACT id from the pid registry (mirroring the headless path), the newest-file fallback is gated to the no-id case (`pickSessionFile`), and an unresolvable file reads as `idle` rather than `running`. Source: `apps/cli/src/lib/session/active.ts`.
- **Fix: one malformed Kimi session blanked the WHOLE `agents sessions` listing.** A Kimi `state.json` with neither `createdAt` nor `updatedAt` made `readKimiMeta` return an `undefined` timestamp, which binds `NULL` into the `timestamp TEXT NOT NULL` column and aborts the entire batch index — so a single bad session took down the listing for every session, not just itself. Two layers: `readKimiMeta` now coerces the timestamp to never-null, falling back to the `state.json` mtime (matching how the listing already ranks Kimi via `last_activity`, like every other parser); and `upsertSessionsBatch` wraps each row in a per-row guard so a future constraint-violating row skips itself (ledger deliberately not stamped, so the next scan re-tries it) instead of rolling back the whole batch. Source: `apps/cli/src/lib/session/discover.ts`, `apps/cli/src/lib/session/db.ts`.

## 1.20.41

- **NEW: `agents sessions focus [id]`** — one command to get back to a session, however it's reachable. It **attaches** a live session in place (tmux `switch-client`/`attach-session`, a remote tmux over `ssh -tt`, or a Ghostty tab — joining the live process without forking); where there's **no live terminal to attach**, it **opens a new tab and resumes** the session — locally, or on the remote peer over SSH (`runOnPeer`, so the peer resolves the version-pinned binary). No id opens the rich live-session picker (this-machine first). Reuses the live-session detection and the terminal launch engine (`openSurfaces`), and folds `go`'s attach paths in. Source: `src/commands/focus.ts`, `src/commands/go.ts`.
- **`--device` is now a first-class alias of `--host`** on every host-routable command (`sessions`, `run`, …), registered centrally on `addHostOption` so a local fall-through no longer errors. Source: `src/lib/hosts/`.
- **`agents computer` steers Electron/webview targets over CDP** instead of reporting a fake success when the native-automation path can't reach them (#716).
- **Secrets: the "remember" policy hold now lasts 7 days and survives screen-lock**, instead of re-prompting after every lock/sleep; stale copies are evicted when a policy is tightened. Source: `src/lib/secrets/`.
- **Fixes:** shim `machine_id()` normalizes to match `normalizeHost()`, and shim resolution honors the per-device default pin (not just the central `agents.yaml`).
- **`agents sessions go` is retired as a deprecated alias for `agents sessions focus --attach-only`.** `go` was already a strict subset of `focus` — its only unique behavior was "attach the live terminal or refuse, never fork/resume." That behavior is now a first-class `--attach-only` flag on `focus` (`focus.ts`: `selectFallback()` picks `refuseFallback` under `--attach-only`, else the resume-in-a-new-tab fallback). `go` now prints a one-line deprecation notice and delegates to `focusAction(id, { attachOnly: true })`; the shared reach engine (`jumpTo`/`gatherLiveTargets`/`pickLiveTarget`/`refuseFallback`) still lives in `go.ts` and is imported by `focus.ts`. Source: `src/commands/go.ts`, `src/commands/focus.ts`.
- **`agents sessions --json --host <h>` now emits a clean JSON array** of recent (non-active) sessions instead of the legacy per-host raw banner stream, so a UI can fetch a remote device's recent sessions when it has no live agents. `serializeSessionsJson()` is shared by the local and remote `--json` paths; `runRemoteSessionsJson()` reuses the existing `gatherRemoteList` SSH fan-out. The non-JSON banner path and `--active` are unchanged (#711).

## 1.20.36

**[windows] `agents sessions --active` detects sessions on Windows, and shim launches carry cwd + session identity everywhere**

- The active listing found nothing on Windows: the headless scan shelled out to `ps -A` and per-pid `lsof` — both POSIX-only, both failing silently into "No active agent sessions" with a dozen live `claude.exe` processes running. The process table now comes from one CIM query on win32 (`powershell.exe Get-CimInstance Win32_Process`; `wmic` is removed on current Windows 11) parsed into the same pid/ppid/comm rows, agent-kind matching strips the `.exe` image suffix case-insensitively (POSIX comms stay exact-match — macOS's Claude *desktop app* process is named `Claude` and must not be listed), and the ancestry walk recognizes Windows terminal hosts (`Code.exe`, `Cursor.exe`, `VSCodium.exe`, `Windsurf.exe`, `WindowsTerminal.exe`). Where no cwd can be recovered (no `lsof` on Windows), same-kind child agent processes — Claude runs subagents and its bundled ripgrep as child `claude` processes — fold onto their root candidate (`foldSubordinateAgents`) instead of printing one row per fork; on POSIX those children collapsed via shared-cwd session dedupe, which now accumulates pre-folded pid counts instead of resetting them. Verified live: 6 root `claude.exe` processes render as 6 rows (previously zero). Source: `src/lib/session/active.ts`.
- Those Windows rows grouped under `unknown` with no topic because only `ag run` recorded a pid → session/cwd registry entry. The transparent shim delegate (`execShimPassthrough`) — the path every `claude`/`codex` typed into a terminal actually takes — now writes the same `by-pid` registry entry at spawn: agent, launch cwd, and the exact session id when the caller passed `--session-id` (`extractSessionIdArg`; whole-arg match only, a uuid inside a prompt never counts). On the win32 `.cmd` shell path the recorded pid is the cmd.exe intermediary rather than the agent binary, so the active scan resolves entries by walking a candidate's ancestors (`readAncestorSessionEntry`), accepting only a matching agent kind — a claude session shelling out to codex can't hand codex its identity — and the fork-fold keeps a descendant with a wrapper entry below its fold target as its own row (a claude launched from inside another claude session is a real second session, not a fork). Net effect: Windows shim launches list with their project directory, exact session id, and topic instead of `unknown`. (POSIX bash shims `exec` the binary directly without the delegate, so they are unchanged and keep relying on lsof-recovered cwd + newest-jsonl.) Source: `src/lib/exec.ts`, `src/lib/session/pid-registry.ts`, `src/lib/session/active.ts`.
**[windows] `browser profiles create` no longer hands out a port an already-running browser is listening on**

- `findFreeProfilePort` probed candidate ports by shelling out to `lsof`, which doesn't exist on Windows — the ENOENT was swallowed by the "assume free" catch, so **every** port in 9222–9399 scanned as free. The first profile created without `--endpoint` was assigned `cdp://127.0.0.1:9222`, and if the user's own browser was running with `--remote-debugging-port=9222` (a common Comet/Chrome setup), the new profile silently *attached* to that browser instead of launching its own sandboxed instance — tabs then opened in whatever profile the user had on screen. The scan now routes through `isPortInUse` (`chrome.ts`, newly exported), the same platform-aware probe the launcher already used: `lsof` on POSIX, `netstat -ano` on Windows. Regression-tested with a real bound socket, no mocks, so the probe is exercised per-platform in CI (`src/lib/browser/chrome.test.ts`). Source: `src/lib/browser/profiles.ts`, `src/lib/browser/chrome.ts`.

**[windows] Background spawns no longer flash console windows while agents run**

- Every background chain root — the scheduler daemon, the auto-pull worker, the PTY sidecar server, the routine runner's job spawns, detached ssh tunnels — was spawned `detached: true` without `windowsHide`. On Windows `detached` maps to `DETACHED_PROCESS`, under which CreateProcess ignores `CREATE_NO_WINDOW` and the child runs console-less, so every console-subsystem descendant (powershell.exe for a Credential Manager read, git, node, a `.cmd` shim's cmd.exe wrapper) allocated its own **visible** console window — the "PowerShell windows popping up and closing while I type" bug. The worst repeat offender: the console-less daemon resolves secrets bundles through `powershell.exe` on every session-sync cycle (90s). The new `backgroundSpawnOptions()` (`src/lib/platform/process.ts`) is the single place that decides the pattern: POSIX keeps `detached: true` (own process group, group-kill still works); Windows switches to `windowsHide: true` with no detach — the child owns a *hidden* console that all descendants inherit (nothing down the tree can flash) and that no launcher console-close event can reach, preserving the #556 daemon-teardown fix. Verified with a live Win32 probe (`GetConsoleWindow` + `IsWindowVisible`): the old pattern yields `VISIBLE=True`, the new pattern allocates no console window at all. Leaf spawns of console tools reachable from a console-less parent (powershell in `secrets/windows.ts` + `platform/winpath.ts`, tasklist/netstat/taskkill in the browser runtime probes, `tailscale status`, ssh, ffmpeg) now pass `windowsHide: true` as defense in depth for callers this release can't re-parent (e.g. an already-running daemon). Source: `src/lib/platform/process.ts`, `src/lib/daemon.ts`, `src/lib/auto-pull.ts`, `src/lib/pty-client.ts`, `src/lib/runner.ts`, `src/lib/ssh-tunnel.ts`, plus the leaf call sites.
- Fallout the hidden console surfaced (caught by the real-advapi32 round-trip test): the Credential Manager driver's `set` read the secret from stdin as *text* via `[Console]::In.ReadToEnd()`, decoded with the console codepage — correct only when the caller's console happened to be UTF-8 (Windows Terminal). Under a fresh hidden console (OEM cp437), or any console-less caller like the daemon, non-ASCII secrets corrupted on write (`café ☕` stored as `caf├⌐ Γÿò`). The static PS script now reads stdin as raw bytes (`[Console]::OpenStandardInput()` → `MemoryStream`) and pins `[Console]::OutputEncoding` to UTF-8, so the round-trip is codepage-independent in every calling context. Source: `src/lib/secrets/windows.ts`.
- Correction for the fd-redirected roots (daemon, runner, PTY server): `windowsHide` is inert whenever a stdio slot is redirected to an fd — libuv skips `CREATE_NO_WINDOW` if any stdio fd is inherited, and log-file redirection counts. A non-detached daemon therefore shared its launcher's console and died on the launcher's console-close event the moment `agents daemon start` returned (the #556 failure, reproduced live: child `alive-after-launcher-exit=false` under `{detached:false, windowsHide:true}` with fd stdio, `true` under `{detached:true, …}`). `backgroundSpawnOptions({ fdStdio: true })` now keeps `DETACHED_PROCESS` for these roots — the child runs console-less and windowless, and its console-tool spawns stay invisible via the leaf `windowsHide` fixes above. Fully-piped/`'ignore'` roots (auto-pull, detached ssh tunnels) keep the hidden-console pattern, which the Win32 probe validated. Regression-tested: a hidden-console launcher spawns an fd-redirected child and exits; the child must survive (`src/lib/platform/process.test.ts`).

**[teams] `agents teams pr-watch <team>` — autonomous PR lifecycle: CI-fix waves + review-comment routing (Closes #338)**

- A team's teammates open PRs; `pr-watch` watches them and reacts without a human in the loop. Each poll it resolves the PRs the team opened (from each teammate's `pr_url`, else the `gh pr create` detected in the session it ran), snapshots CI + review comments via the `gh` CLI (`gh pr checks --json`, `gh api …/pulls/{n}/comments`), and decides follow-ups: **RED CI** spawns a fix teammate `--after` the one that failed, with the failing-run logs (`gh run view --log-failed`) injected so it pushes a follow-up commit to the *same* PR branch; a **new review comment** routes a `bugfix` teammate (the existing `TaskType`) `--after` the source, with the comment body injected. Both slot into the team DAG the supervisor already drains — the loop calls `startReady` each pass so staged fixers launch when their source completes — and every reaction is visible in `agents teams status`. Dedupe is by check-run id / comment id, persisted to `pr-watch-<team>.json`, so the same failure or comment never spawns twice across restarts. The decision logic (`decidePrActions`) is a pure function over injected snapshot data (unit-tested in `src/lib/teams/pr-watch.test.ts`, no network); the `gh` collectors and the `handleSpawn`-backed reactor sit on top. **Deferred (documented follow-up):** the event-driven path from #331's webhook receiver — `pollPrSnapshot` is the seam where a `check_run` / `pull_request_review_comment` payload plugs in, producing the same `PrSnapshot` the pure decider already consumes. Source: `src/lib/teams/pr-watch.ts`, `src/commands/teams.ts`.

**[hosts] `--host`/`--device` now resolves registered devices and ad-hoc `user@host` — one concept, one flag**

- Offloading a run no longer needs a machine enrolled in *two* registries. `agents run --host <name>` (and the new `--device <name>` alias, plus `teams add --host`, and every other `--host` consumer via the shared resolver) now resolves in order: the `agents hosts` registry (unchanged), then the **`agents devices`** registry, then an ad-hoc **`user@host`**. A machine registered once with `agents devices sync` is reachable immediately — previously it errored `Unknown host` unless you *also* ran `agents hosts add`. The fall-through lives in one place (`resolveHost`), so it's not a per-command band-aid. A bare unknown name still returns null so capability-tag routing (`--host gpu`) is unaffected; only a name containing `@` is treated as an ad-hoc target (validated by `assertValidSshTarget`). A device that authenticates by password can't offload over the BatchMode ssh path, so it throws a typed, actionable `DeviceOffloadUnsupportedError` (switch to key auth or enroll as a host) instead of dispatching a run that would hang. Source: `src/lib/hosts/registry.ts`, `src/commands/exec.ts`, `src/lib/hosts/option.ts`.

**[secrets] recover credentials orphaned under a stale keychain access group (RUSH-1413)**

- Secrets written before the access-group pin (#279, first shipped v1.20.27) were filed by macOS under the implicit default group — the literal wildcard `2HTP252L87.*`, not the concrete `2HTP252L87.com.phnx-labs.agents-keychain` that every query now pins (`keychain-helper.swift` `dpBase`). Those items are intact and the wildcard entitlement authorizes reading them, but the pinned queries never ask for that group, so `has`/`get`/`list` reported them **missing** and whole bundles vanished from `secrets list` (their metadata was orphaned too). On one machine this stranded 43 items including the ssh private key, the release signing key, and identity secrets. The helper now recovers them on three levels: (1) `readItem`/`has` add an **un-pinned data-protection fallback pass** after the pinned miss, so an orphan reads and reports present instead of missing; (2) `get`/`get-batch` **re-home** an orphan inline the first time it's read — reusing the read's Touch ID, add-before-delete, deleting the exact orphan by `kSecValuePersistentRef` — mirroring the existing file-based `migrateInline`; (3) a new `migrate-orphans` helper verb bulk re-homes every orphan behind a single Touch ID. `list` is now un-pinned so orphaned bundle metadata reappears, and `set`/`delete` clear across all groups so a rotate/delete can't leave a shadow copy. New `list-orphans` verb enumerates orphans prompt-free. Source: `src/lib/secrets/keychain-helper.swift`, `src/lib/secrets/index.ts`.
- `agents secrets migrate-acl` now sweeps orphaned-access-group items in addition to legacy-ACL stragglers: the dry-run lists both classes, `--commit` re-homes the orphans in one batched Touch ID (add-before-delete needs no pre-write backup), and any listed orphan the helper can't reach (e.g. under a different signing team) is surfaced, never dropped silently. Because every published helper shares team `2HTP252L87` and the same wildcard entitlement, one run recovers every affected user losslessly. Source: `src/commands/secrets-migrate.ts`, `src/lib/secrets/index.ts` (`listOrphanedKeychainItems`, `migrateOrphanedKeychainItems`, `parseOrphanMigrationOutput`). The signed helper must be rebuilt + re-signed + notarized and its sha re-pinned (`scripts/build-keychain-helper.sh`, `scripts/Agents CLI.app.sha256`) at release, per the standard keychain-helper release step.

**CI: audit-event tests are green on Windows; the release re-gates on the windows-latest matrix legs (RUSH-1412)**

- The cross-platform matrix (`ci.yml`, runs only on `release/**` + `v*`) had both `build (windows-latest, …)` legs red: `tests/events-audit.test.ts` and `tests/teams-events.test.ts` spawn the CLI with a redirected `HOME` and then read the audit trail under it, but the events writer rooted its log dir at a bare `os.homedir()` (`src/lib/events.ts:24`). On Windows `os.homedir()` resolves from `USERPROFILE` and ignores a `HOME` override, so every `command.start`/`command.end` record was silently written to the real profile instead of the test's temp home — the events array came back empty and the log file `ENOENT`'d (macOS/Ubuntu were green because `os.homedir()` honors `$HOME` on POSIX). The writer now roots its log dir through `state.getLogsDir()`, the single canonical home anchor (`process.env.HOME ?? os.homedir()`), which honors an explicit `HOME` on every platform and still resolves to `USERPROFILE` in production on Windows (where `HOME` is unset), so real users are unaffected. One `events-audit` case also reconstructed its log filename from a UTC `toISOString()` while the writer names files from the local date, so it `ENOENT`'d whenever a runner's local and UTC dates straddled midnight; it now globs the log dir like the other assertions. `scripts/release.sh` restores both `build (windows-latest, 22|24)` entries to `EXPECTED_CHECKS`, so Windows is a release gate again. Source: `src/lib/events.ts`, `tests/events-audit.test.ts`, `scripts/release.sh`.
- Three more `build (windows-latest, …)` failures fixed. (1) **Antigravity sessions were invisible to Windows users, not just tests.** `parseAntigravity` read its conversation SQLite DBs by shelling out to the `sqlite3` CLI (`src/lib/session/parse.ts:893`), which is absent on Windows — so `execFileSync('sqlite3', …)` threw `spawnSync sqlite3 ENOENT` and the parser silently returned `[]` for every real Antigravity session on Windows. It now reads the `step_payload` BLOBs through the runtime-agnostic `src/lib/sqlite.ts` wrapper (node:sqlite / bun:sqlite, the same path production already uses for the session index), so it works on every OS with no CLI dependency; `parse-antigravity.test.ts` builds its fixture DB through the same wrapper instead of the CLI. (2) `parse-droid.test.ts` derived its `testdata` dir from `new URL(import.meta.url).pathname`, which on Windows yields `/C:/…` — so `path.join` produced a doubled-drive `C:\C:\…` that `ENOENT`'d; it now uses `fileURLToPath(import.meta.url)`. (3) `git.test.ts`'s `syncRepoGit` "pull-only" case failed because the Windows runner's `core.autocrlf=true` converted the freshly-cloned `README.md` to CRLF *during* `git clone` — before `configIdentity()` could set `autocrlf=false` on the clone — so `status.isClean()` saw a phantom modification and `syncRepoGit` refused with "Working tree has uncommitted changes." The test seed now commits a `.gitattributes` (`* -text`), which wins over `autocrlf` at checkout time so every clone lands byte-identical LF content. (`parseOpenCode` shells out to `sqlite3` the same way and has the same latent Windows gap, but its test mocks `execFileSync` so CI never caught it and its argv-injection regression test pins the CLI call — left untouched to avoid scope creep.) Source: `src/lib/session/parse.ts`, `src/lib/session/__tests__/parse-antigravity.test.ts`, `src/lib/session/__tests__/parse-droid.test.ts`, `src/lib/git.test.ts`.

**`agents message <target> <text>`: deliver a message to an already-running agent mid-flight [RUSH-1415]**

- One verb now reaches a live agent while it works, not just a cloud task. `agents message <id> <text>` resolves the target to exactly one destination and routes it: a **cloud task id** takes the existing provider follow-up path (was `agents cloud message`); a **live local/teams/loop agent** gets the text enqueued into a per-agent file-spool mailbox that a `PreToolUse` hook drains and injects at the agent's next tool call. `resolveMessageTarget()` is the anti-misroute gate — exact id wins over prefix, results de-dupe by canonical mailbox id, and a target matching zero or more-than-one live agent (or an empty string) is never guessed: the command errors with the candidate list. `--from <who>` records a sender label; `--host <h>` routes the whole command over SSH (via `REMOTE_PASSTHROUGH`) to the box that owns the agent, and `message` registers as a lazy SQLite-backed command like `cloud`/`sessions`/`teams`. Source: `src/commands/message.ts`, `src/lib/mailbox-target.ts`, `src/lib/hosts/passthrough.ts`, `src/lib/startup/command-registry.ts`.
- The mailbox itself is a crash-safe file-spool under `~/.agents/.history/mailbox/<id>/{inbox,processing,consumed}/`. Enqueue is atomic (temp-write + `rename`); drain is claim-first (`inbox → processing → consumed`) so an interrupted drain is recovered on the next call (at-least-once delivery; consumers dedup by `msgId`). Every message stamps a `to` field and a monotonic FIFO `msgId`; a message that lands in the wrong box or fails to parse is archived and dropped, never delivered or looped. A mailboxId must be a single separator-free path segment (`[A-Za-z0-9._-]`, not `.`/`..`) — validated at the id→path boundary and the write-time `to` stamp so a traversal-bearing id fails loud instead of silently misrouting. At spawn, `buildExecEnv` points each agent at its own box via `AGENTS_MAILBOX_DIR` (keyed by session id); a loop overrides it to the run-level box so every iteration shares one inbox, and prints `agents message <runId>` at start since the runId is otherwise undiscoverable. Source: `src/lib/mailbox.ts`, `src/lib/state.ts`, `src/lib/exec.ts`, `src/lib/loop.ts`.

**Watchdog core: stall detection + nudge decision for a stalled agent (#612) [RUSH-1415]**

- Ports the pure, fs/vscode-free watchdog core so agents-cli can decide when a running agent has stalled and what to say to un-stall it: `classifyTerminal` + `isLikelyTrulyBlocked` (blocked / waiting / completion-hint signals plus a promise-without-toolcall detector), `renderWatchdogPrompt` / `composePromptWithPlaybook` / `WATCHDOG_SYSTEM_PROMPT`, and a tolerant `parseWatchdogResponse`. `summarizeWatchdogTail` extracts the last user/assistant turn across Claude/Codex/Gemini transcript shapes and filters synthetic `<system-reminder>`-style tags. The session-tail reader seeks backward from EOF for the last N JSONL lines and resolves a transcript from `sessionId + agent` by reusing `getAgentSessionDirs()` rather than hardcoding paths — including the recursive `walkForFiles` walk that reaches Codex's deep `sessions/YYYY/MM/DD/rollout-…jsonl` layout and Gemini's tmp layout, driven per-agent by `WATCHDOG_SESSION_LAYOUT`. Source: `src/lib/watchdog/watchdog.ts`, `src/lib/watchdog/watchdogTail.ts`, `src/lib/watchdog/read.ts`, `src/lib/watchdog/index.ts`.

**Terminal injection: type into an already-running agent's exact terminal (#611, #616) [RUSH-1415]**

- `injectIntoTerminal` extends the Terminal Engine to type into a *running* surface, not just open new ones — the primitive a native watchdog needs to nudge a stalled agent with "continue" delivered into the precise terminal it lives in. It mirrors the engine's shape: pure per-backend spec builders produce a `LaunchSpec` run through the same `runSpec` transport, so injection inherits local/remote (`--host` over SSH) execution for free. Backends: **tmux** `send-keys -t <pane>` (socket-addressed), **iterm** `tell session id "<uuid>" to write text` (no `activate`, so it addresses the exact split without stealing focus), **vscodium** (VSCodium/Cursor/VS Code) over the editor CLI's `--open-url` into the extension's `/inject` verb, and **pty** via the agents-pty sidecar (local-only). Ink-TUI Enter semantics: text and Enter are two separate writes by default (a fused `text\r` is swallowed by Claude's Ink TUI), and `combined` opts into the single fused write for plain shells. Source: `src/lib/terminal/inject.ts`, `src/lib/terminal/index.ts`.
- `resolveInjectTarget` is the single resolver the watchdog calls: `sessionId →` a precise `InjectTarget` or an honest `{ addressable: false, reason }`, with precedence tmux > iterm > vscodium > pty and a deliberate safe skip for Ghostty (no addressable split API). `deriveProvenance` now captures `$ITERM_SESSION_ID` and, absent tmux, exposes an `iterm` reply rail carrying the iTerm2 session UUID — tmux still wins whenever present because a pane is reachable inside any host app. `agents sessions inject <id> <text>` is the CLI face: it resolves an active session to its provenance reply rail and routes to the matching backend, with `--pane`/`--pty` to target a backend directly, `--combined` to toggle the Ink-safe two-write default, `--no-enter` to send without submitting, and `--host` to inject over SSH. Source: `src/lib/terminal/resolve.ts`, `src/lib/session/provenance.ts`, `src/lib/session/inject.ts`, `src/commands/sessions-inject.ts`.

**Watchdog consumer + `agents watchdog`: run one stall-detection tick end to end (#619, #622) [RUSH-1415]**

- `runWatchdogTick` ties the pure pieces together into one pass over `getActiveSessions()`: `classifyTerminal()` finds stalls, `readWatchdogTail()` reads the transcript, `isLikelyTrulyBlocked()` gates on the promise-without-toolcall heuristic (deterministic v1) or an optional `--smart` LLM decider, `resolveInjectTargetForSession()` is the absolute safety gate, and `injectIntoTerminal()` delivers `Continue.` into the EXACT split. A nudge fires ONLY on `addressable:true`; an `addressable:false` stall is flagged to a tray-readable state file and skipped — never a guessed target. Per-session policy is `off|keep|handsoff` (handsoff detects and flags but never injects); cooldown and un-addressable flags persist under `~/.agents/.cache/state/watchdog/`. The `agents watchdog` command runs it without the menu-bar: bare = one dry tick (reports would-nudge/skip + why), `--nudge` injects for real, `--watch` is a daemon loop (`--interval`, default 30s), `--json` is machine-readable, and `--stall/--cooldown/--dormant` override thresholds. `runner.test.ts` drives real synthetic sessions through the pure logic (nothing mocked) with dry-run injection. Source: `src/lib/watchdog/runner.ts`, `src/commands/watchdog.ts`, `src/lib/startup/command-registry.ts`.
- The macOS menu-bar helper now auto-nudges from its native tick: `StatusItemController.tick()` reads the enable sentinel and runs one watchdog tick (`nudge=enabled`, detect-only when off), a checkable **Auto-nudge** menu row toggles it via `agents watchdog enable|disable` and shows `N stalled · M nudged`, and `AgentsCLI` gains `watchdogStatus()/watchdogTick(nudge:)/watchdogSetEnabled()` mirroring the `doctorOverview()` shell-and-decode pattern. `refreshWatchdog()` is throttled to a 30s floor (siblings: doctor 60s, routines 20s) so it doesn't spawn two node subprocesses on every 10s tick — still well under the 5-minute stall threshold. Source: `packages/menubar-helper/Sources/MenubarHelper/StatusItemController.swift`, `packages/menubar-helper/Sources/MenubarHelper/AgentsCLI.swift`, `src/commands/watchdog.ts`.

**VSCodium / Cursor / VS Code terminal backend (#608, #620)**

- A new `vscodium-agent` terminal backend opens each resumed session as an agent-terminal tab in a running VSCodium / Cursor / VS Code window — via the `swarm-ext` extension's `/spawn` URI verb — instead of scripting a GUI terminal app. It builds `<cli> --open-url '<scheme>://swarmify.swarm-ext/spawn?…'` (default VSCodium: `codium` / `vscodium://`); the editor CLI forwards the URL over its IPC socket, so it needs no OS scheme handler, works on Linux, and flows over `--host` (SSH) like the other backends — with no `zsh -ilc` wrap since the target is already an interactive login shell. The `{command, cwd, split}` payload is base64url-encoded into a single query param because VS Code percent-decodes `uri.query` once before the handler parses it (a bare `echo a && touch b` was otherwise truncated at the `&`). Wired into `sessions resume` as `--vscodium`; auto-detect is intentionally omitted (`TERM_PROGRAM=vscode` can't disambiguate the three products). Because VSCodium agent terminals open as individual full-width editor tabs, this backend defaults packing to one tab per session (`--tabs` still forces tabs elsewhere). Source: `src/lib/terminal/backends/vscodium-agent.ts`, `src/lib/terminal/index.ts`, `src/commands/sessions-resume.ts`.

**`agents sync <repo>`: git-sync a single DotAgent repo (#535)**

- Giving a DotAgent repo name alone — `agents sync system` / `agents sync user` / `agents sync <alias>` — now git-syncs just that one repo instead of running the umbrella reconcile. The new `syncRepoGit` refuses on a dirty working tree (commit or discard first), otherwise `git fetch origin` + `git pull --rebase origin <branch>` against the repo's own HEAD branch (falling back to `main`), reinstalls the git hooks, and reports the resulting short commit. The `user` repo and enabled extra-repo aliases also `git push` local commits up; `system` is a pull-only mirror of the npm-shipped upstream (`push: false`). `project` and unknown names are rejected — the project `.agents/` lives inside the user's own repo and isn't independently synced. This repo-name form is matched before agent-spec parsing, since names like `system`/`user` would otherwise fail `parseAgentSpec`. Source: `src/lib/git.ts`, `src/commands/sync.ts`.
- Bare `agents sync` no longer eager-fetches secrets and sessions: the umbrella planner now defaults to config repos + reconcile only, with secret bundles and session transcripts made opt-in via `--secrets` / `--sessions` (pulling every secret bundle onto a machine was more blast radius than a bare sync should carry; transcripts stay queryable on demand via `agents sessions --host <machine>`). Interactive bare `agents sync` (TTY, no flags) now drops into a two-checklist picker — which repos to sync FROM, which installed agents to sync INTO — then pull-only freshens the selected repos and reconciles a single merged selection into each agent, unioned across repos via `mergeRepoScopedSelections` / `unionResourceSelections`. Source: `src/lib/sync-umbrella.ts`, `src/lib/versions.ts`, `src/commands/sync.ts`.

**Split `agents.yaml` into portable, per-device, and machine-local files (#538)**

- The committed central `~/.agents/agents.yaml` used to carry machine-specific fields and was held back with a `git skip-worktree` band-aid so it wouldn't sync. It's now partitioned by sync-domain: `agents:` (version pins) moves to per-device `~/.agents/devices/<machineId>/agents.yaml` (committed and synced, but each machine only writes its own folder so pulls never conflict), `versions:` (per-version resource tracking) moves to gitignored, machine-local `~/.agents/.history/version-resources.json`, and central `agents.yaml` is left portable. `writeMetaUnlocked` writes the device and history files BEFORE stripping and rewriting central, so a crash mid-write never drops pins/versions before they persist; `readMeta` overlays the machine-local files back on via `overlayMachineLocal` (device pins win and self-heal a pre-migration central). Source: `src/lib/state.ts`, `src/lib/machine-id.ts`.
- Migration `migrateSplitDeviceLocalMeta` (sentinel bumped to `v11`) performs the one-time split on raw YAML, merging into any existing device/history files (existing entries win) via `atomicWriteFileSync`, and only rewrites central when it actually carries machine-local fields — a portable-only `agents.yaml` is left byte-untouched — while always clearing the `skip-worktree` bit so every machine's file syncs cleanly. The meta cache stamp is now a `|`-delimited string of all four source files' mtimes rather than a numeric sum that could round sub-unit device/history changes away and serve stale reads in long-lived processes. `machineId()` / `normalizeHost()` were extracted to a dependency-free leaf module so low-level `state.ts` can key per-device paths without an import cycle. Source: `src/lib/migrate.ts`, `src/lib/machine-id.ts`, `src/lib/session/sync/config.ts`, `src/index.ts`.

**`agents sessions`: the interactive picker now shows origin machine, PR/ticket, and worktree columns**

- Every discovered session carries the machine it originated on — the local box for live-home transcripts, or the origin host parsed from the cross-machine mirror layout (`backups/<agent>/<machine>/…`) — recorded on `SessionMeta.machine` by `discoverSessions`. The picker row, previously stuck on `shortId · agent · version · project · topic · when`, now folds in a gray machine column (only when the pool spans >1 box, with the longest shared dash-delimited prefix stripped so `yosemite-s0`/`yosemite-s1` read as `s0`/`s1`), a blue `PR#`/ticket column (only when some row carries a ref), and a magenta `wt:<slug>` worktree badge. Column flags are computed once over the whole pool via `pickerColumnsFor` and shared by both the browse picker and the multi-select resume picker, and the topic width is now terminal-aware so the extra columns never wrap.
- A dim `subtitle` hint line renders between the header and the rows (new `subtitle` field on `PickerConfig`/`SessionPickerConfig`), rotating a `Tip:` that surfaces the filter flags (`-a/--agent`, `--project`, `--all`, `-H/--host`, `--since`/`--until`), keyed off pool size so it stays fixed across re-renders. Fixed a wrap bug where the resume picker prepends a 6-cell `> [x] ` gutter but `formatPickerLabel` reserved only the 2-cell single-select cursor, overflowing every row by 4 cells and halving the viewport; the gutter width (2 browse, 6 resume) now threads through `PickerColumns` and is reserved from the topic width. Source: `src/commands/sessions.ts`, `src/commands/sessions-resume.ts`, `src/commands/sessions-picker.ts`, `src/lib/picker.ts`, `src/lib/session/discover.ts`, `src/lib/session/types.ts`.

**Reach Windows peers over `--host` (RUSH-1429)**

- The SSH command layer gained a PowerShell dialect so `--host` operations can target Windows remotes, where ssh lands in `cmd.exe`/PowerShell and `bash -lc` does not exist. `remoteShellFor(os)` routes `windows → powershell` and everything else (including unknown/absent) → posix, so linux/macOS never regress; `buildWindowsAgentsCommand` emits `powershell -NoProfile -EncodedCommand <base64-utf16le>`, which survives `cmd.exe` re-parsing with zero quoting hazards. The peer OS is resolved from the tailscale-synced device registry (fleet fan-out) or the enrolled `HostEntry.os` (explicit `--host`). This fixes `agents sessions --host` / `--active` and remote secrets reads (browse + use-a-remote-bundle), which previously wrapped the remote invocation in `bash -lc` and got `'bash' is not recognized` from a Windows peer. The `secrets export/import --host` write path stays POSIX-only for now (documented follow-up). Source: `src/lib/hosts/remote-cmd.ts`, `src/lib/hosts/remote-os.ts`, `src/lib/devices/registry.ts`.

**Windows portability + CI hardening**

- `agents sessions … resume` no longer crashes on Windows with `spawn EFTYPE`: `resumeSessionInPlace` spawned the version-pinned launcher (`claude@2.1.196`) with `shell:false`, but on Windows that shim is a `.cmd`/extensionless file, so spawn threw synchronously and the error was mis-reported as a discovery failure. It now spawns through the shell on Windows via `needsWindowsShell` and reports a synchronous launch failure truthfully. The generated hook-cache shim also hardcoded `python3` for its hash/timer/mtime, but on Windows `python3` is often the Microsoft Store execution-alias stub (prints to stderr, exits non-zero, 0 bytes) — silently emptying `mtime` so every call missed the cache and re-ran the hook; it now probes for a runnable interpreter (`python3`, then `python`) by executing `-c 'import sys'`. Source: `src/commands/sessions.ts`, `src/lib/hooks/cache.ts`.
- Two new CI guards keep these Windows-only, separator-prone bugs from reaching a release: a path-filtered `test-windows` job runs the suite on `windows-latest` for changes under hooks/platform/shims (the required `test` gate runs on `ubuntu-latest`, where `path.sep` is `/`, so a backslash-path bug is invisible), and `toPortableCommand` is now pure/exported with injectable home + separator so a unit test can assert Windows `C:\…` → `~/…` folding on any host. Separately, a `prepare: npm run build` hook rebuilds the gitignored `dist/` on every install/link (and before `npm publish`), so a dev-linked checkout can't silently run a stale `dist/` behind a source fix. Source: `.github/workflows/tests-windows.yml`, `package.json`.

**License: MIT → Apache-2.0 (#504)**

- The project relicenses from MIT to Apache-2.0. `LICENSE`, `README`, and `package.json` carry the new license, and the human-facing docs (the `AGENTS.md` brand lines, the `CONTRIBUTING.md` CLA clause, `DESIGN.md`) were aligned so the stated license is consistent everywhere.

**Security hardening batch (#474–#478)**

- **Shell / option injection.** `agents inspect` no longer builds its `git` call as a shell string: a crafted repo path could inject via `$(…)` or other shell syntax through `execSync(\`git -C ${…} ${args}\`)`. It now uses argv-form `execFileSync('git', ['-C', root, …args])`, so the path can never reach a shell (#474). Separately, MCP server management rejects a server name that starts with `-` or contains whitespace/control characters and places every user-controlled positional after `--`, closing an option-injection vector (#478). Source: `src/commands/inspect.ts`, `src/lib/mcp.ts`.
- **Path-traversal containment.** Plugin resolution rejects a plugin name that resolves to the plugins root itself, so a crafted name can't escape or target the directory root (#475). Hook-shim generation validates the shim name before constructing any path and asserts the resolved shim path stays inside the shims directory — rejecting separators, traversal components (`..`), NUL bytes, and leading dashes (#477). Source: `src/lib/plugins.ts`, `src/lib/hooks.ts`, `src/lib/hooks/cache.ts`.
- **Supply-chain.** Per-version agent installs now run `npm install --ignore-scripts`, so a dependency's install/postinstall lifecycle script can't execute arbitrary code during an `agents` version install (#476). Source: `src/lib/versions.ts`.

## 1.20.35

**CI: build node-pty's native binary on macOS/Windows so the release matrix is green cross-platform**

- The cross-platform matrix (`ci.yml`, runs only on `release/**` + `v*`) installed deps with `bun install --ignore-scripts`, so `pty.node` from `@homebridge/node-pty-prebuilt-multiarch` was never fetched/built. That package ships prebuilt binaries only for Linux; macOS/Windows obtain `pty.node` via its own install script (prebuild-install download, else a node-gyp compile). With that script skipped the native module was absent, so the daemon-liveness integration test added in #568 — which spawns the real daemon (it loads node-pty) and asserts the browser IPC socket stays up — crashed on macOS/Windows while passing on Linux, and had been red on every release since. The matrix runs only on release branches, so it never surfaced on normal PRs (bun does not run that install script even without `--ignore-scripts` in bun 1.3.x). CI now runs a dedicated step that invokes the package's own install script (`npm run install`), which prefers a prebuilt download and falls back to a node-gyp compile, so it self-heals across platforms and node ABIs. Production (`npm install`) already built the native module, so end users were unaffected. A second macOS/Windows-only failure in the same #568 daemon-liveness test was also fixed: the test rooted its fake `HOME` under `os.tmpdir()`, which on macOS is the long `/var/folders/…/T/…`, pushing the daemon's AF_UNIX socket path to ~116 bytes — past macOS's 104-byte `sun_path` limit — so `bind()` failed with `EADDRINUSE`. The test now roots `HOME` at a short base on POSIX (Windows uses length-unlimited named pipes); real users with a normal `HOME` were never affected. Source: `.github/workflows/ci.yml`, `src/lib/daemon.test.ts`.

**`agents logs`: a top-level, unified run-log viewer (#575)**

- Viewing a dispatched run's output used to be nested and undiscoverable — only `agents hosts logs <id>` and `agents daemon logs` existed, and `agents hosts` wasn't even in `--help`. `agents logs [id]` is now a discoverable top-level command that resolves a run across **two substrates** — host-dispatch task stdout (`agents run --host`) and the local session index — and shows or (`-f`) follows it. `[id]`/`--session` load directly (host task tried first, then session); with no id, `--host`/`--agent`/`--version` filter a merged candidate list (one match shows, several open a fuzzy picker, non-TTY prints the list). Additive: `agents hosts logs` and `agents sessions tail` are unchanged and share the same helpers. Source: `src/commands/logs.ts`, `src/lib/hosts/logs.ts`.

**Host-follow log tailer: no self-corruption on localhost, byte-accurate offsets (#586, #589)**

- Following a run dispatched to **localhost** tripled the on-disk log and triple-printed the output, because the local mirror file and the remote log were the same file and the tailer appended its own reads back into it; it now detects that aliasing by file identity (`dev:ino`) and echoes only. Separately, the offset tracker advanced by a re-encoded string length, so a multibyte UTF-8 char split at a poll boundary drifted the offset and corrupted the stream on non-ASCII output; the tail is now byte-exact (raw `Buffer` via `sshExecRaw`). Source: `src/lib/hosts/progress.ts`, `src/lib/ssh-exec.ts`.

**`agents upgrade`: the "What's new" changelog is now a compact heading list (#562)**

- The post-upgrade changelog dumped every heading *and* every verbose sub-bullet for each version in the range — a screenful across a multi-version jump. It now prints one bullet per feature/fix heading and links to the full CHANGELOG for the details. The parser was extracted to a pure, unit-tested `renderWhatsNew` so it can be exercised without the CLI's import-time side effects. Source: `src/lib/whats-new.ts`, `src/index.ts`.

**`agents sessions --active`: a per-pid registry de-collapses co-located agents (#546)**

- On a host with no terminal extension (bare SSH/tmux — e.g. any Linux box), `--active` could only map a discovered agent process to a session by guessing the newest `.jsonl` in its cwd, so several agents in the same repo collapsed onto one session row (observed live: a single id listed 28 times), and `/restore` couldn't tell them apart. `agents run` now records each launch to `~/.agents/.cache/terminals/by-pid/<pid>.json` (`{agent, cwd, tmuxPane, sessionId, startedAtMs}`) — the headless equivalent of the terminal extension's `live-terminals.json` — so `--active` and `/restore` attribute each co-located agent correctly. Source: `src/lib/session/pid-registry.ts`, `src/lib/session/active.ts`, `src/lib/exec.ts`.

## 1.20.34

**Test suite runs remotely on a crabbox VM (#525, #540)**

- `scripts/release.sh`'s test gate now runs `bun install && bun run build && bun run test` on a leased crabbox VM via `scripts/sandbox.sh` instead of freezing the local machine, matching CI's Build→Test order (crabbox's sync honors `.gitignore`, so the gitignored `dist/` is built on the box). A new `bun run test:remote` offloads the suite the same way for local dev. Publishing still happens locally — only the signed macOS keychain helper can be produced and notarized here, and crabbox boxes are Linux. Source: `scripts/sandbox.sh`, `scripts/release.sh`, `package.json`.
- `scripts/sandbox.sh` box acquisition is now robust: secrets load via `agents secrets export --plaintext` (the bare form now hard-errors), a missing `.crabbox.yaml` no longer aborts the script under `set -e`, and the agents-cli/claude install is gated to PR mode so test-mode runs match GitHub CI. Box selection gates on `crabbox status … ready=true` — skipping failed-bootstrap duds (which still report `status=running`) and warming a fresh box if none are ready — keyed on the stable `profile` label rather than an ephemeral slug. A dedicated `agents-cli` crabbox profile (`.crabbox.yaml`) isolates this repo's warm pool. Source: `scripts/sandbox.sh`, `.crabbox.yaml`.

## 1.20.31

**`agents sessions <id>`: a catch-up digest for switching between many agents (#502)**

- Opening a single session now leads with its auto-inferred title (user `/rename` > Claude `ai-title` > first-prompt topic) and PR / worktree / ticket badges, then a **Changes** section that groups touched files by directory and tags each as created / modified / deleted (with a `+N ~N -N` summary) instead of the old flat "Modified" list, a **Tools** histogram (per-tool call counts), and a **Tests** verdict parsed from the last `vitest` / `jest` / `pytest` / `go test` / `cargo test` / `tsc` run. The same signals are folded into the interactive picker preview.
- `agents sessions --active` now collapses the many subagent/fork PIDs of one session into a single row with a `×N` count instead of printing dozens of identical lines. Source: `src/lib/session/digest.ts`, `src/lib/session/render.ts`, `src/lib/session/active.ts`, `src/commands/sessions.ts`, `src/commands/sessions-picker.ts`.

## 1.20.30

**`agents sessions` live state engine: waiting / PR / worktree / ticket detection + reliable preview (#494)**

- `agents sessions --active` infers real activity from each transcript's tail — **working** / **waiting** / **idle** — rather than the old mtime-only running/idle guess, using structural signals (Claude `ExitPlanMode` / `AskUserQuestion`) plus a question + mtime heuristic for Codex. It detects and badges a PR opened during the session (`gh pr create` + the resulting pull URL), a git worktree (`.agents/worktrees/<slug>/`), and a Linear/Jira ticket (from the prompt or branch), and shows the latest turn as the preview instead of the first prompt.
- `--waiting` filters `--active` to only sessions blocked on your input and exits non-zero (a scriptable gate); `--tree` groups the listing by directory, dropping the id/version columns while keeping the short-id handle.
- The preview line is now width-correct: measurement is ANSI- and wide-char-aware and reads `$COLUMNS` first, so it no longer wraps or drifts under tmux or over `--host` SSH (the remote is handed the caller's width). Session index schema v7 persists the PR / worktree / ticket signals so historical listings carry them too. Source: `src/lib/session/state.ts`, `src/lib/session/tail.ts`, `src/lib/session/width.ts`, `src/lib/session/{discover,db,active}.ts`, `src/commands/sessions.ts`.

**`agents sessions --host <machine>`: query a remote machine's sessions live over SSH**

- `agents sessions "<query>" --host <alias|user@host>` runs the same session query on a remote machine's own index over SSH and streams the result back — repeat `--host` (or pass several) to fan out across machines. SSH access is the only auth; there's no daemon or shared store. Targets are validated against a strict allowlist (`SSH_TARGET_RE`) to block flag-smuggling, and the forwarded invocation is double-quoted (`shellQuote`) so a query like `$(whoami)` survives as a literal string on both shell layers. Source: `src/lib/session/remote.ts`, `src/commands/sessions.ts`, `docs/05-sessions.md`.

**Fix: migrations + menu-bar self-heal were silently disabled on Homebrew-node installs**

- The "is this a dev build?" check walked `dirname(dirname(argv[1]))` looking for a `.git`, without resolving the bin symlink. On a Homebrew-node setup `agents` is `/opt/homebrew/bin/agents`, so it walked up to `/opt/homebrew` — **which is itself a git repo** — and false-positived as a dev build. Dev builds auto-set `AGENTS_SKIP_MIGRATION=1`, which gates **both** one-shot migrations **and** the menu-bar upgrade self-heal. Net effect: every Homebrew-node user ran with migrations and the menu-bar refresh permanently off.
- Detection now `realpath`s the entrypoint (so a symlinked bin resolves into the real package dir) and requires the `.git`'s repo root to actually be the `@phnx-labs/agents-cli` package — an unrelated ancestor repo no longer counts. Extracted to `src/lib/startup/dev-build.ts` with tests covering the Homebrew symlink layout, a real checkout, and unrelated-ancestor cases.

**Secrets default policy is now `daily` (one Touch ID per ~24h), not `always`**

- The default prompt policy for bundles without an explicit one flipped from `always` (Touch ID on *every* read) to **`daily`** (one prompt, then held ~24h until screen-lock / sleep / logout). This is the fix for the prompt storm: a background reader like sessions-sync hammering a bundle now costs one Touch ID per ~24h instead of one per read.
- **Auto-cache is on by default.** The secrets-agent is the mechanism that delivers the daily policy, so it self-caches a `daily` bundle on first read with no `secrets.agent.auto: true` needed. Opt out with `secrets.agent.auto: false`.
- **Configurable, still flexible.** Set the global default in `agents.yaml` (`secrets.policy: always` to restore prompt-every-time), or override per bundle with `agents secrets policy <bundle> always` for high-value keys (signing, SSH) you want to confirm on every read.
- **Explicit `always` now persists** under the legacy `tier: biometry` token (older CLIs read it as their own always default). Bundles with no stored policy inherit the configured default — so an existing always-by-default bundle quietly becomes `daily` on first read by the new CLI, which is the intended migration.

**Menu bar: a macOS status item for agent activity (`agents menubar`)**

- New no-Dock menu bar app showing live agent activity on the machine: a **NEEDS YOU** section (sessions awaiting input + failed/overdue routines), a per-agent **roster** (running / idle counts across installed agents), a **+ New session** launcher, and a one-line routines summary. The icon badges red `!` when something needs you, green with a count when sessions are running.
- Reads state **directly from disk** — `live-terminals.json`, teams `meta.json`, and the cloud `tasks.db` — so opening the menu never triggers the costly sessions transcript re-index. The CLI is shelled only for actions (start a session, run a routine).
- **Auto-enabled on macOS** for every user as a launchd login service (`com.phnx-labs.agents-menubar`); a fresh install brings the icon up with no manual step. Manage with `agents menubar enable | disable | status`. Opt out with `agents menubar disable` — sticky across upgrades.
- **Upgrade self-heal:** the installed bundle is version-stamped, and the startup self-heal now re-installs the helper when a newer release ships a newer build (or the installed copy goes missing), instead of skipping whenever a service already existed. So `npm update` actually moves users onto the new helper binary + plist rather than leaving the old one running (#442). `agents menubar status` shows installed vs current version and staleness.
- Docs: [Menu bar](docs/menubar.md). macOS only.

**`agents repos view [name]`: inspect one repo's contents without opening it**

- New `agents repo view <name>` (also reachable as `agents repos view`, now a first-class alias of the `repo` command) prints a single repo's git state and per-kind resource counts — `system`, `user`, `project`, or an extra-repo alias. Omit the name for an interactive picker over the registered repos. It reuses the `inspect` repo renderer, so output matches `agents inspect <repo>`; supports `--brief` and `--json`. Source: `src/commands/repo.ts`, `src/commands/inspect.ts`.

**`agents doctor --fix` + a daemon safety check: heal the gap between defined and installed**

- Root cause behind "a plugin/command silently vanished": a DotAgents repo can DEFINE a resource that never makes it into an agent home, and nothing closes the gap. Two concrete failure modes — (1) `agents plugins update`/`sync` only reconcile each agent's **default** version, so a non-default installed version keeps serving stale/invalid resources; (2) a plugin.json with a bare-name `skills`/`commands` field makes Claude Code **silently reject the entire plugin**, and the sync path only *warned*. The detection (`agents doctor`'s live-home diff) and the healing (`syncResourcesToVersion`) existed but were never wired together — and the sync fast-guard keyed off the staleness manifest, which is blind to home-side rot.
- **`agents doctor --fix`** turns the read-only diagnosis into a heal: installs missing resources, repairs Claude-invalid plugin manifests (strips the bare `skills`/`commands` field — Claude auto-discovers from the dirs), fast-forwards stale plugins from their `.source`, and reconciles drift — across **every installed version**, not just defaults. With no target it heals the whole install; `agents doctor <agent> --fix` scopes to one.
- **Daemon safety check:** the routines daemon now runs the same heal in conservative `safe` mode (~every 6h + ~30s after start) — it fixes only unambiguous gaps (missing resources, invalid manifests, *provably-unmodified* stale plugins) and **notifies rather than clobbers** on hand-edited content or a plugin it can't prove is pristine.
- Built on the **live-home diff**, not the staleness manifest, so it catches drift the sync fast-guard can't. Heal **fills and fixes, never deletes** (orphans stay `agents prune cleanup`'s job), excludes the project layer (the global home isn't reconciled against per-cwd project resources), and **verifies after writing** — it only claims resources that actually reconciled, so repeated runs converge instead of "fixing" the same item forever.
- `.source` now records the plugin version at pull time, a baseline that lets the safe path tell an untouched mirror (fast-forward) from a user edit (leave alone).
- **`agents doctor` overview now covers every installed version, not just defaults.** Sync status and orphans previously reported only each agent's default version — so a stale NON-default version (the exact rot `--fix` heals) was invisible in the readout. Each version is now listed with its default marked. The **Agent CLIs** list also stops nagging: it shows the agents you actually run (ready, or managed-but-broken) and collapses the rest of the supported catalog to a single `+N more supported …` hint instead of a column of red "not installed" lines for tools you never adopted.
- **Says exactly WHAT is out of sync — plugins first.** A stale version in the overview now lists the specifics under it, prioritizing plugins and their bundled content: `plugin code — 0.6.1→0.7.0, missing skills: ship, learn`. The plugin diff went from presence-only ("installed: yes") to **content-aware** — it compares the version's marketplace mirror against the central source and surfaces a stale mirror version, a Claude-invalid manifest, and the plugin's own skills/commands that never reached the mirror (the system-repo content that matters most). `agents doctor <agent>@<version>` shows the same detail per plugin row.
- **Fixed a false "drift" that could never be reconciled:** a hook's `.md`/`.rst` doc sibling (e.g. `git-guard.md` next to `git-guard.sh`) was wrongly treated as the hook's runtime *data file*, so the installer's correct omission of docs showed as perpetual drift in `doctor` (and as an un-healable item under `--fix`). Docs are no longer counted as hook data; structured siblings (`.yaml`/`.json`/...) still are.
- **Corrected a false promise in the sync-status readout.** Stale/cold versions used to say "will sync on next launch" / "first launch will populate" — but version homes are NOT reconciled on launch (the shim hot path only resolves a version and compiles project-scoped resources; v15/v16 moved version-home reconciliation to management commands). The readout now states the fact ("sources changed since last sync" / "never synced") and points at the real fix: `agents doctor <agent>@<version> --fix` or `agents sync <agent>@<version>`.

**Secrets prompt policy: human-readable `always` / `daily`, and `secrets list` now shows it**

- Renamed the secrets-agent `tier` to a **prompt policy** with plain-language names: `biometry` → **`always`** (ask every time), `session` → **`daily`** (ask once, then held ~24h until screen-lock / sleep / logout). The old name `session` was misleading — it never meant "once per login session" — and collided with the half-dozen other "session" concepts in the CLI (`agents sessions`, sessions-sync, pty/browser sessions). Set it with `agents secrets policy <bundle> [always|daily]`.
- **Disclosure fixed.** `agents secrets list` now has a `POLICY` column — previously there was no way to tell which bundles would Touch-ID-prompt you. `daily` bundles currently held by the agent show `daily · Nh left`. `agents secrets view` and `create` now always state the policy (before, only the quiet tier was shown; the noisy default printed nothing).
- **Back-compat:** the policy still persists under the legacy `tier`/`session` token, so bundles stay readable across mixed CLI versions on synced machines. `agents secrets tier`, `--tier`, and the `biometry`/`session` values keep working as aliases.
- A third **`never`** policy (silent, no biometry ACL) is tracked for later in #421.

**Self-healing: long-running processes reload onto new code after an upgrade**

- Root cause behind a class of "stale behavior" bugs: a routines daemon or secrets-agent broker keeps running **pre-upgrade code** for days. An in-place `npm i -g` swaps the files but not the running processes, so fixes (keychain read-memoization, the broker fast-path, etc.) silently never take effect — the daemon kept popping Touch ID from the keychain because it predated the fix.
- **Heal-on-upgrade:** `postinstall` now bounces the routines daemon and kickstarts the persistent secrets-agent broker onto the just-installed code — the one moment we know the code changed. Best-effort, non-fatal, skipped in CI / with `AGENTS_NO_HEAL=1`.
- **Broker version-skew self-heal:** the broker's `ping` reports the version of the code it's running; `ensureAgentRunning` (the unlock / auto-cache path, never per-read) restarts a broker found running stale code, and a persistent broker self-exits on detecting an in-place upgrade so launchd relaunches it fresh. New `getCliVersionFresh()` re-reads `package.json` to detect the swap.
- No hot-path cost: all checks live on existing control-plane paths (postinstall, the broker sweep, `ensureAgentRunning`), never on a per-secret-read. macOS only. Complements #412 (daemon session-sync memoization) by ensuring the daemon actually *runs* that code.

**`agents secrets start`: persistent secrets-agent service (fixes the broker under heavy load)**

- On a heavily-loaded machine (many concurrent agents, high load average) the on-demand broker — a full CLI cold-start — couldn't get scheduled enough CPU to finish booting and bind its socket, so `unlock`/auto-cache silently failed and reads kept prompting. New `agents secrets start` installs the broker as a **launchd user service** (`RunAtLoad` + `KeepAlive`, `ProcessType: Interactive` for foreground scheduling priority): it starts once and stays up for the whole login session, so every read just connects — the cold start happens once (and launchd retries until it wins), never per read. `agents secrets stop` removes it; `agents secrets status` shows whether it's installed.
- `unlock` and the auto-cache worker now install/kickstart this service automatically via `ensureAgentRunning`, falling back to the old one-off detached spawn only if the service path is unavailable. So the persistent broker is set up on first use with no extra step.
- macOS only. Security model unchanged: in-memory only, per-bundle TTL, wiped on screen-lock/sleep.

**Fix: secrets-agent auto-cache now survives a slow broker cold-start under load**

- `secrets.agent.auto` (auto-cache on first read of a `session`-tier bundle) used a fire-and-forget inline loader that gave up connecting to the broker after 3s. But the broker it spawns is itself a full CLI cold-starting; under heavy load (many concurrent agents) that can exceed 3s, so the loader quit before the broker bound and the cache silently never populated — every read kept prompting. The auto-load now runs through a detached `secrets _agent-load` worker that reuses the robust `ensureAgentRunning` path (spawn-then-ping, 20s budget) and loads synchronously, so it reliably populates even when the broker is slow to start. Manual `agents secrets unlock` was always reliable and is unchanged. (secret values still travel over stdin, never argv.)

**`agents secrets unlock`: a secrets-agent that ends Touch ID prompt spam (macOS)**

- macOS pops a Touch ID prompt **per bundle, per process** — the biometry assertion is process-local and macOS refuses to cache `kSecAccessControl`+biometry items, so running several agents at once (`agents teams`, parallel `agents run --secrets`) re-prompts once per process. New `agents secrets unlock <bundle>` reads the bundle once (one prompt) and holds the resolved env in a local broker; every later resolution — `agents run`, teammates, browser profiles, the routines daemon — is served from memory over a user-only Unix socket (`~/.agents/.cache/helpers/secrets-agent/`, `0700`) with no prompt. `agents secrets lock` wipes it; `agents secrets status` shows what's held and when it locks. The hold also ends on TTL expiry (default 24h, `--ttl`) and on screen-lock / sleep.
- **Opt-in by construction:** if you never `unlock`, resolution is byte-for-byte the existing keychain path — guarded behind a single `agentSocketExists()` stat. The single integration point is `readAndResolveBundleEnv`, so every consumer benefits without per-call-site changes. Broker-served reads are tagged `"source":"agent"` in the audit log.
- **Security trade-off (documented in `docs/secrets.md`):** while unlocked, a same-user process that can reach the socket reads the bundle silently — the same trust boundary the keychain already concedes (the ACL is user-presence, not code-identity), minus the visible prompt. Bounded by explicit per-bundle opt-in, TTL, screen-lock/sleep auto-lock, and `lock`.
- Snapshot semantics: `unlock` freezes a bundle's dynamic `exec:`/`env:`/`file:` refs at unlock time; keychain and literal values are unaffected.
- **Release note:** auto-lock on screen-lock/sleep adds a `watch-lock` subcommand to `keychain-helper.swift`. The signed helper must be rebuilt + re-notarized and its sha re-pinned (`scripts/build-keychain-helper.sh`, `scripts/Agents CLI.app.sha256`) for that path to ship; until then the agent degrades gracefully to TTL-only locking. Source: `src/lib/secrets/agent.ts`.

**Per-bundle tiers + opt-in auto-cache for the secrets-agent**

- Bundles now carry a tier (`agents secrets tier <bundle> [biometry|session]`, or `--tier` on `create`). `biometry` (default) is today's behavior — only an explicit `unlock` puts it in the agent. `session` makes a bundle agent-eligible.
- New `secrets.agent.auto: true` in `agents.yaml` (default off): the first real keychain read of a **`session`**-tier bundle auto-loads it into the broker in the background (no added latency, secret passed over stdin not argv), so the next concurrent run reads it silently — no manual `unlock`. A `biometry`-tier bundle is never auto-held.
- A `none` tier (items without the biometry ACL, fully silent, no agent) is intentionally **not** offered yet — it needs a separate signed-helper change and is the global downgrade the agent exists to avoid.
- Default secrets-agent TTL is 24h.

**Headless Linux: `agents secrets` works out of the box when the keyring is locked**

- On a headless server the libsecret/GNOME-keyring collection is locked, so the encrypted-file fallback is the only option — but it previously hard-failed unless `AGENTS_SECRETS_PASSPHRASE` was set, leaving `agents secrets` silently unusable. Now, on a headless run with no passphrase set, a random machine-local passphrase is auto-provisioned once at `~/.agents/.cache/secrets/.passphrase` (mode 0600) so the encrypted-file store just works. `AGENTS_SECRETS_PASSPHRASE` still takes precedence (off-disk key), an existing `.passphrase` is reused for stable interactive/headless behavior, and interactive TTY sessions are still prompted. Security model + resolution order documented in `docs/secrets.md`. (#371)

**`agents secrets get/set <item>`: raw, cross-platform keychain access for hooks**

- New `agents secrets get <item>` / `agents secrets set <item>` read and write a single keychain item **by bare name** (outside the bundle namespace), so shell hooks and automation have one platform-agnostic credential primitive to call instead of hardcoding `/usr/bin/security` (macOS-only) or `secret-tool` (Linux-only). `get` prints the value to stdout (newline-terminated for clean `$(…)` capture), sends diagnostics to stderr, and exits 1 with empty stdout when the item is missing — exactly what a `SessionStart` hook needs to probe-and-fallback quietly. Routing goes through the existing cross-platform keychain layer: macOS via `/usr/bin/security`, Linux via `secret-tool` with the encrypted-file fallback.
- `setKeychainToken` now writes bare (non-`agents-cli.`) items on macOS **without** the biometry ACL, mirroring the existing no-prompt read path for such items. This is what lets a hook read e.g. `linear-api-key` silently on every launch — routing it through the Touch ID helper would attach an ACL the `/usr/bin/security` read can't satisfy without popping the legacy password sheet. The change is purely additive: every existing caller passes an `agents-cli.`-namespaced item and is unaffected (still biometry-gated via the signed helper).

**`agents inspect` summary: expanded detail for hooks, plugins, and MCP**

- The bare `agents inspect <agent>` / `agents inspect <repo>` summary no longer collapses everything to a count table. Simple kinds (commands, skills, rules, subagents, workflows) keep a count line but now preview a few names; the rich kinds get their own expanded sections: **hooks** show their events + `matches:` predicates + cache (`PreToolUse(Bash) · git_dirty · prompt~"deploy" (5m cache)`), **plugins** show version + bundle contents (`v2.1.0  skills:6 commands:5 hooks:2 mcp:1`), and **MCP** show transport + url/command. Drill-down flags (`--hooks`, `--plugins`, `--mcp`) and `--brief` are unchanged; `--json` gains the structured detail additively (existing keys retained).
- Hook detail joins installed hooks to the manifest by **script basename** (installed hooks are named after their script file while the manifest keys on the logical name), and the repo Hooks section uses the grouped hook reader so a script + its data file collapse to one clean entry.

**Plugin hooks were misreported — fixed**

- `discoverPluginHooks` read the **top-level** keys of a plugin's `hooks/hooks.json`, so the official `{ description, hooks: { SessionStart: [...] } }` format surfaced as `description, hooks` instead of the real events. It now reads the `hooks` wrapper when present (falling back to top-level keys for the flat format), so `agents inspect --plugin <name>` and the plugin row show the actual lifecycle events (e.g. `SessionStart, PreToolUse, …`).

**`agents doctor` / `agents prune`: precise orphan-hooks detection**

- Orphan-hook detection now flags hook scripts present in a version home that **no `agents.yaml`/`hooks.yaml` entry registers** — i.e. scripts that sync to disk but are never wired to a lifecycle event, so they never fire. This replaces the source-diff heuristic, which compared only against the user hooks dir and so **false-flagged valid system-sourced, registered hooks** (e.g. `03-linear-inject`, `04-capture`) as orphans — meaning `agents prune cleanup` could have deleted live hooks. Doctor's Orphans section and `prune cleanup hooks` now share this single manifest-based definition. `parseHookManifest` gained a silent (`{ warn: false }`) option so the diagnostic doesn't emit shadow/override warnings.

**Regression coverage: resource sync from extras repos**

- Added end-to-end regression tests (`src/lib/__tests__/extras-sync.test.ts`) locking in two behaviors for repos registered via `agents repo add` (`~/.agents-<alias>/`): a top-level `commands/<name>.md` is written into the agent's version home on `agents sync`, and plugins under `plugins/<name>/` are synthesized into a registered `agents-<alias>` marketplace on launch. Both already work in `main`; the tests exercise the real sync path (no mocking, isolated `$HOME`) so the extras-repo behavior can't silently regress (#313, #314).

**Windows: `agents` is discoverable right after `npm i -g`**

- On a global Windows install, postinstall now prepends npm's global-bin dir (where `agents.cmd`/`agents.ps1` live) to the **User PATH** via the .NET environment API. Node's installer normally adds it, but winget / portable / nvm-windows setups often don't — and then `npm i -g @phnx-labs/agents-cli` succeeds yet `agents` is "not recognized". The shims dir (claude/codex/…) is still left to `agents setup`, which the user can now run because `agents` resolves.
- Postinstall also detects a `Restricted`/`AllSigned` PowerShell execution policy (which blocks the generated `.ps1` launchers, so even an on-PATH `agents` fails in PowerShell) and prints the one-line fix (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`). The policy is a security setting, so it is never changed silently — only surfaced.
- Refactor: the Windows User-PATH prepend logic moved from `shims.ts` into a new `src/lib/platform/winpath.ts` leaf module (`prependToWindowsUserPath`, `getEffectiveExecutionPolicy`, `blocksLocalScripts`, `npmGlobalBinFromEntry`); `addShimsToWindowsUserPath` now delegates to it. Pure helpers are unit-tested.

**Factory AI Droid (first-class support)**

- Add `droid` as a first-class supported agent (AgentId + full registry entry for Factory AI's `droid` CLI, config in `~/.factory/`). Installs via the official script (`curl -fsSL https://app.factory.ai/cli | sh`); the binary is resolved through the standard install-script path and isolated per version via the `~/.factory` config symlink (Droid has no `*_HOME` override).
- Resource sync wired for the four resource types Droid supports natively: **MCP** (`~/.factory/mcp.json`), **rules** (native `AGENTS.md`), **subagents** (custom droids flattened to `~/.factory/droids/*.md`, with the unsupported `color` frontmatter key stripped), and **commands** (`~/.factory/commands/`). Skills/plugins/workflows have no Droid equivalent and are disabled; hooks/permissions are deferred.
- `agents run droid` and `agents teams add … droid` work end-to-end: headless `droid exec` with mode mapping (plan → read-only, edit → `--auto low`, auto → `--auto high`, skip → `--skip-permissions-unsafe`), `-o stream-json` output, `-m` model selection, and `-r` reasoning effort. Routine/daemon jobs (`buildJobCommand`) support Droid too.
- Known limitation: `agents teams` renders Droid events through the generic normalizer pending a verified `droid exec -o stream-json` event schema; structured tool/file categorization will follow. Session reading and Factory cloud dispatch remain follow-ups.

**`agents upgrade` now refreshes the macOS Keychain helper**

- Upgrading runs `npm install -g … --ignore-scripts`, so the postinstall that installs the signed Keychain helper never fired — a user upgrading away from a broken build (e.g. the entitlement-less 1.20.4 helper that failed `SecItemAdd` with `errSecMissingEntitlement -34018`) kept the broken helper until the lazy staleness check in `getKeychainHelperPath()` happened to repair it on their next secret operation. `installResolvedPackage` now force-refreshes the helper (`ensureKeychainHelperInstalled({ forceReinstall: true })`) on darwin after the install, so both the explicit `agents upgrade` and the auto-update prompt land the fixed helper immediately. Best-effort and non-fatal: an upgrade never fails because the helper could not be reinstalled, and `agents helper install --force` remains the manual path.

**`agents inspect <repo>` summary now shows what's actually inside, not just counts**

- The bare repo summary gained four enrichments so it reads as an inventory instead of a tally: (1) **resource name previews** — each kind lists its first few names with a `…(+N)` tail; (2) **manifest summary** — `agents.yaml` is parsed for its `run.<agent>.strategy` and any `agents.<agent>` version pins, shown under `manifests` instead of just the filename; (3) **git detail** — last commit (sha, subject, relative time), ahead/behind upstream when non-zero, and the names of dirty files; (4) **size + file counts** — total repo size and a per-kind byte size. `--json` carries all of it (`git.lastCommit`, `git.ahead/behind`, `manifest`, `size`, and per-kind `{count, bytes, files, names}`); `--brief` still skips resources and size.
- Fixed a path-parse bug surfaced by the dirty-files list: the shared git helper trimmed leading whitespace, which clipped the first character off the first `git status --porcelain` path; status is now read untrimmed.

**`agents inspect .` reads the project `.agents/`, and plugin drill-down shows bundled skills**

- `agents inspect .` (and any path to a repo root) now resolves to the project's nested `.agents/` tree when that tree is a populated DotAgents root, instead of the project root itself. Previously a top-level `agents.yaml` version-pin or an unrelated source `skills/` dir at the repo root was mistaken for a DotAgents root, so `inspect .` reported the wrong directory's resources (e.g. `plugins 0` while the real `.agents/plugins/` held a plugin). A bare `.agents`-named dir still resolves to itself, and standalone clones / extra repos that keep resources at the top level (using `.agents/` only for worktrees) are unaffected — their nested `.agents/` is not a DotAgents root, so the top level still wins.
- `agents inspect <repo> --plugins` now reads plugin bundles through the plugin discoverer: the list shows each plugin's manifest description, and drilling into one (`--plugins <name>`) reports its bundled skills, commands, subagents, hooks, MCP servers, and version. Previously plugins were treated as opaque directories with no description and no view into what they ship.

**Single-typo agent names auto-correct everywhere, not just `agents run`**

- `agents view cladue` used to print `Unknown agent 'cladue'` even though `agents run cladue` auto-corrected. `resolveAgentName` — the canonical resolver behind `view`, `usage`, `inspect`, `doctor`, `sync`, `models`, `skills`, `hooks`, `import`, `sessions --agent`, and every `agent@version` spec (`agents add claud@latest`, `agents use codx@2.1.170`) — now falls back to Damerau-Levenshtein distance-1 matching against canonical ids and multi-letter aliases: `cladue` -> `claude` (transposition), `kim` -> `kimi`, `codx` -> `codex`, `gemni` -> `gemini`.
- Corrections apply only when unambiguous: every distance-1 candidate must agree on one agent. `kiri` (one edit from both `kiro` and `kimi`) and inputs under 3 characters still error. `agents run` keeps its existing exact -> profile -> workflow -> fuzzy precedence, so a profile named `claud` still beats the typo correction.
- Fixes `kimi` being listed as a valid agent but missing from the alias map — `agents view kimi` previously errored. Added `kimi` / `kimi-code` entries.

## 1.20.7

**`agents inspect` — DotAgents repo targets (#256)**

- `agents inspect` now accepts a DotAgents repo as the target, not just an installed agent: `user` (~/.agents/), `system` (~/.agents/.system/), `project` (nearest `.agents/` from cwd), any extra-repo alias registered via `agents repo add`, or a filesystem path. Paths accept either a repo containing a `.agents/` dir or a DotAgents root directly.
- Repo summary shows the root (OSC-8 linked), git branch / dirty count / origin URL, manifest files (`agents.yaml`, `hooks.yaml`), and per-kind resource counts. All existing drill-down flags (`--commands`, `--skills`, `--plugins`, ... with fuzzy queries and `--json`) work against the single repo root — what is physically in that repo, with no layered resolution or same-name overrides.
- Resolution precedence: a directory that is itself a DotAgents root wins over its nested `.agents/`, so extra repos that keep resources at the top level and use `.agents/` only for worktrees resolve to their real resources.
- Unknown targets now error with both halves of the namespace: the known agent ids and the available repo targets (built-in layers plus registered aliases).

**`scripts/install.sh` — bash 3.2 fix (#256)**

- `set -u` plus `"${BUILD_ARGS[@]}"` on an empty array aborted the dev install with `BUILD_ARGS[@]: unbound variable` under macOS system bash; the expansion is now guarded with `${BUILD_ARGS[@]+...}`.

## 1.20.5

**`agents inspect` — per-agent+version detail view with drill-down (#217)**

- New top-level command `agents inspect <agent>[@version]`. Summary mode shows install path, config symlink target, shim path, versioned alias, run strategy, capability table (`hooks`/`mcp`/`skills`/`commands`/`subagents`/`plugins`/`workflows`/`rules`/`allowlist`), resource counts with project/user/system scope breakdown, and session total. Replaces the awkward `agents view <agent>@<version>` deep-detail mode as a dedicated verb; `view` itself is unchanged.
- Drill-down flags for every resource kind — `--commands`, `--skills`, `--hooks`, `--mcp`, `--rules`, `--plugins`, `--workflows`, `--subagents`. Bare flag lists every entry; passing a positional query fuzzy-searches that kind, ranking exact > substring > Damerau-Levenshtein. Zero matches exit 1 with the three closest names as suggestions. One drill-down at a time (validation error otherwise). `--json` works with summary and every drill-down for scriptable consumption.
- Resource names render as OSC-8 terminal hyperlinks to the marker file (`SKILL.md` / `WORKFLOW.md` / `AGENT.md`) for clickable navigation in modern terminals (Ghostty, iTerm2, WezTerm) — no inline path noise. Plain text on terminals without OSC-8 support.
- MCP detail intentionally suppresses path and env values to avoid leaking secrets — only the server name, scope, and version reach the output.
- Removes the deprecated `agents status` alias for `view @default`. Top-level help text updated; no consumers referenced it.

**Headless Linux: encrypted-file fallback when libsecret collection is locked (#183)**

- On server-class Linux (Ubuntu 24.04 over SSH on the reporter's box), `agents secrets create x` failed with `secret-tool: Cannot create an item in a locked collection`. Diagnosis in the issue: `gnome-keyring-daemon` is running and D-Bus is reachable, but the default `login` collection is locked because no graphical login has fed the daemon the passphrase, and `secret-tool` from `libsecret-tools` has no `--collection` flag so it can't target the unlocked `session` collection. This made `agents secrets` effectively macOS-only on any headless box.
- `src/lib/secrets/linux.ts` now transparently falls back to a file-based AES-256-GCM encrypted store at `~/.agents/.cache/secrets/<item>.enc` (mode 0600, per-file random scrypt salt + 96-bit IV, GCM auth tag). The encryption key is scrypt-derived from a passphrase read from `AGENTS_SECRETS_PASSPHRASE` (preferred) or a TTY prompt via `/dev/tty` with `stty -echo` for non-echoing input. The fallback also activates when `libsecret-tools` is not installed at all but `AGENTS_SECRETS_PASSPHRASE` is set, so a fresh install can store secrets without any apt-get step.
- The decision is cached per process; on first activation we emit one stderr line: `[agents] secret-service collection locked, using file-based store at <dir>`. The `KeychainBackend` interface in `src/lib/secrets/index.ts` is unchanged — `has`/`get`/`set`/`delete`/`list` work identically against either backend, so `bundles.ts`, `sync.ts`, and every consumer above it sees no API change.
- Items written into the file store before the fallback was added remain accessible only via libsecret if/when the collection is later unlocked; this PR does not migrate stranded items in either direction — the user simply re-creates them on a freshly headless box.

## 1.20.4

**Plugin marketplace sync (skip outside-pointing symlinks)**

- `copyPluginToMarketplace` used `fs.cpSync(plugin.root, dest, { recursive: true, dereference: false })`, which faithfully preserved every symlink — including the ones plugin authors put at the top of their plugin source for prompt-side references (the rush plugin's `app -> ../../../rush/app`, `web -> rush/web`, `widgets -> rush/widgets`). Those targets resolve to the rush monorepo (~8.7 GB of `app/` including node_modules + .next builds, 782 MB of `web/`, plus 463 MB brand-assets). Every claude version got a full set of those symlinks in `~/.claude/plugins/marketplaces/agents-cli/plugins/rush/`. When the consumer (Claude Code, OpenClaw) discovers plugins, it walks the marketplace tree and follows those symlinks — producing multi-minute startup hangs.
- The copy now walks the source tree and drops symlinks whose `realpath` escapes the plugin root, leaving internal symlinks intact (cpSync rewrites internal targets to absolute paths into the source tree, which the consumer still resolves correctly). One informational line per plugin lists the skipped names so plugin authors notice.
- Existing per-version marketplace directories still hold the bloat from prior syncs; clean up with `rm` against `~/.claude/plugins/marketplaces/agents-cli/plugins/*/{app,web,widgets,*-symlinks-that-escaped}` then re-run `agents pull` or any plugin sync to re-copy with the filter.

## 1.20.3

**`agents run` startup latency (stale-while-revalidate the usage probe + memoize agents.yaml)**

- The default `agents run` strategy is `available`, which calls `getUsageInfoForIdentity` to skip rate-limited accounts. With a 2-minute cache, every cold invocation past that window made a blocking `fetch` to `api.anthropic.com/api/oauth/usage` (5 s timeout, plus an optional 15 s OAuth token refresh) before `spawn(claude)` — so `agents run claude` regularly stalled 5–8 s with nothing on screen after the rotation banner.
- The cache is now stale-while-revalidate: fresh (<2 min) returns instantly with no network, stale-but-recent (<24 h) returns the cached snapshot instantly and refreshes in the background, and only a fully cold / >24 h cache blocks on the live fetch. The background refresh defers its first await past `setImmediate` so the synchronous Keychain CLI call (`security find-generic-password`, invoked by `loadClaudeOauth`) cannot block the foreground caller — that's how an SWR returns "instantly" even while the refresh is technically still on its first sync step.
- `readMeta()` had a `metaCache` module global plus `writeMetaUnlocked` cache-invalidation logic wired in years ago — but no read path ever consulted the cache. So every call did 2x `fs.readFileSync` + 2x `yaml.parse` on system + user `agents.yaml`, and hot callers (`getConfiguredRunStrategy`, `getGlobalDefault`, `getVersionResources`, `ensureVersionResourcePatterns`) fire it multiple times per `agents run`. The read path now consults the cache, keyed on the combined mtime of both source files — out-of-band edits still invalidate on the next stat, and in-process writers already clear it.

## 1.20.2

**Grok and Antigravity Support & Documentation**

- **Grok CLI Integration**: Added support for installing Grok via `agents add grok@<version>`, which invokes the official xAI installer with the specified version. Grok MCP server configuration paths (via `config.toml`) and memory file mapping are now correctly documented.
- **Antigravity (AGY) CLI Integration**: Added support for the Google Antigravity CLI. Since the AGY installer doesn't support version-pinned installs currently, `agents add agy` uses the `latest` version. Documented the canonical config path `~/.gemini/antigravity-cli/` and its `mcp_config.json`.
- **Documentation**: Updated `02-resource-sync.md` to reflect accurate MCP mappings and memory file symlinks for both Grok and Antigravity.
- **Profiles**: Hardened presets with verified 2026 model IDs and added generic proxy configuration. Show custom profiles in agents view.

## 1.20.1

**Agents selector (auto-install missing versions + unified `@all` everywhere)**

- `--agents claude@2.1.999` used to hard-error when 2.1.999 wasn't installed. Now the CLI prompts to install it inline and continues (auto-install with `--yes`). No more breaking flow to run `agents add` first.
- `--agents claude@all` and the bare `all` literal now work across every callsite that takes `--agents` — previously `agents install gh:...`, `mcp register`, `mcp remove`, and inline `mcp add` had diverged from the canonical syntax and threw "Version all is not installed" despite the help text advertising it. Selector is unified end-to-end.

**Prompt (fail loud on non-TTY + `@all` syntax in picker)**

- Scripts that called `agents <resource> add` with no `--agents` and no `--yes` used to silently auto-pick a default version. That hid scripted misuse behind unpredictable picks. The non-TTY path now throws with a clear pointer at the new syntax: `--agents claude@all` (every installed version of Claude), `--agents all` (every capable agent at all versions), or `--agents claude@2.1.141` (one specific version).
- `--agents` parsing in `<resource> add` understands `@all` and the bare `all` literal; `promptAgentVersionSelection`'s picker surfaces version counts when there's more than one installed, mirroring what `@all` would target.

**Resources / install (`gh:` form sniffs every type, `mcp add gh:`, `--names` + `@all` unified across resource add)**

- `agents install gh:<owner>/<repo>` now sniffs every resource type in the source repo (commands, skills, hooks, MCP, permissions, profiles, subagents, workflows) instead of requiring one `--types` per kind. Pass `--types skills,workflows` to narrow.
- New `agents mcp add gh:<owner>/<repo>` form — install MCP servers directly from a git source, parallel to the other `<resource> add gh:` paths.
- `<resource> add` accepts `--names` and `@all` uniformly across commands, skills, hooks, MCP, permissions, profiles, rules, subagents, workflows — same flags, same semantics, regardless of resource kind.

**Profiles (interactive `create` wizard, gateway + self-hosted presets)**

- New `agents profiles create` command — interactive wizard to assemble a profile from gateway or self-hosted presets (OpenRouter, OpenAI-compatible) without hand-writing YAML.
- `--smoke-test` exercises the resolved env block against the configured endpoint before writing the profile.

**Feedback (in-CLI bug / idea / question routing)**

- New `agents feedback` command — collects a short description + optional category (bug, idea, question) and routes to the project's tracker without leaving the terminal.

**Routines (real exit codes for detached scheduled runs)**

- `monitorRunningJobs` used to hardcode `status: 'failed'` whenever it detected that a detached child had exited — `executeJobDetached` fires-and-forgets, so the real exit code was unreachable. Every scheduler-driven routine ended up labeled `failed/exitCode: null`, even when the agent completed cleanly.
- Fix: when finalizing a vanished child, scan the tail of its stream-json `stdout.log` for Claude's `type: result` terminator (which carries `is_error`). If found, set `status` and `exitCode` from it. Only fall back to `failed` when no result marker exists (process was killed mid-run).
- Routines list cell rendering hardened around 7-day retention boundaries.
- Codex/Gemini run finalization continues to fall back to `failed` until their stream tail parsers are added.

**Security**

- `security(cli)`: eliminated `shell: true` from manifest-driven installs — closes a command-injection vector in `install`/`add` paths that took git URLs or shell-interpolated metadata.
- `security(logs)`: prompts and tokens are redacted before `events.jsonl` is written, and event retention is shortened from 30d to 7d. Reduces blast radius on accidental disclosure.
- `security(exec)`: strip loader env vars (`DYLD_*`, `LD_*`, `NODE_OPTIONS`) from environments propagated to child agents — avoids passing host-process loader state into spawned binaries.
- `security(browser)`: CDP origin allowlist replaces the previous wildcard — only `localhost` and explicitly configured browser hosts can speak CDP into a session.
- `security(ci)`: keychain helper SHA is verified at publish time, so a tampered helper binary cannot ride a release.

**Copilot (fix user-scoped MCP path)**

- Copilot's user-scoped MCP path now correctly resolves to `mcp-config.json` (the path the IDE actually reads) instead of the legacy filename. Fixes user-level MCP registrations not appearing in Copilot sessions.

**Docs**

- Full docs site IA shipped: browser, cloud, computer, hooks, plugins, profiles, pty, secrets, subagents, teams, workflows.
- Brand identity block: `agents-cli` is Phoenix Labs OSS, not part of the Rush brand — guards downstream agents against pulling Rush styling into this project.

**Build / install**

- Staged dev install tarball strips `prepack` and `prepare` hooks so side-by-side dev installs don't accidentally re-run the full publish pipeline locally.
- `test(jobs)`: un-break 3 stale assertions on main.

## 1.20.0

**Routines (overdue detection + catchup)**

- Detect routines whose most recent scheduled fire was missed (laptop off, daemon crashed, reboot). The daemon logs them on startup and pops a native desktop notification (`osascript` on macOS, `notify-send` on Linux).
- `agents routines list` annotates overdue rows with `(overdue)` and prints a footer pointing at the catchup command.
- New `agents routines catchup` command: lists overdue routines and fires them in the background under the scheduler. `--dry-run` lists without triggering.
- `JobScheduler.schedule` now sets croner's `catch: true` and forwards `timezone` defensively, so a synchronous throw in one job's callback can't kill the whole cron loop.

**Landing page (agents-cli.sh)**

- Expanded the homepage with seven new sections: rotate accounts (`--rotate`), parallel teams (`agents teams`), browser automation, cross-agent session search, routines/cron, keychain secrets, and machine-to-machine sync (`agents drive`).
- Rewrote meta description + lede to spell out the actual feature set (pin versions, swap models, rotate accounts, drive a browser, spawn parallel teams, schedule on cron) instead of just "same interface, on your machine."

**Codex (commands-as-skills sync fix)**

- Fix recurring "N commands new" prompt on `agents view codex` for Codex >= 0.117.0. `getActuallySyncedResources` now detects converted command-skills via the `agents_command` marker in `~/.codex/skills/<name>/SKILL.md` instead of only scanning the empty legacy `prompts/` directory.
- Summary and selection prompts are version-aware: the static `COMMANDS_CAPABLE_AGENTS` gate is replaced by `supports(agent, 'commands', version)` so the "X commands" line only appears for versions that can actually take them.
- Generalize `shouldInstallCommandAsSkill` beyond Codex — any agent where commands are gated off and skills are on (e.g. Grok) now gets the same automatic slash-command → skill conversion at install/sync time.

**Grok Build (first-class support)**

- Add `grok` as a first-class supported agent (AgentId + full registry entry using official `~/.grok/README.md` paths).
- Implement proper binary resolution from `~/.grok/downloads/`.
- Add `GROK_HOME` isolation to generated shims for true versioned config (skills, hooks, plugins, agents/, MCP, memory, etc.).
- Extend `installVersion` to support Grok via its official installer script (`curl ... -s <version>`).
- Update shims, exec templates, MCP path helpers, session helpers, unmanaged detection, and docs.
- `agents add grok@<ver>`, `agents use grok@<ver>`, resource sync, and shims now work end-to-end for Grok Build.

**Browser**

- `agents browser start --record` convenience flag for one-shot recording sessions.
- Auto-discover per-site `SKILL.md` on `browser start` so skills appear under the active task without manual wiring.
- Auto-pick a Chromium-family browser when `--profile` is omitted; the limitation is surfaced in `--help` and the auto-pick error.
- No more stacktraces when the daemon is down or CDP is unreachable — error paths print a single human-readable line.
- Drop the Playwright `bundled-chromium` devdependency.

**Secrets / Keychain**

- `agents secrets list` and `agents run --secrets <bundle>` collapse to one Touch ID prompt per bundle instead of one per key. Previously every secret in a bundle would re-prompt for keychain unlock.

**Sessions**

- Extract `groupActiveSessions` into a tested helper for `--active` window grouping.
- Propagate `windowid` from live-terminals into the active session record.

**Copilot**

- Emit `COPILOT_HOME` in the shim and exec env builder for versioned isolation.
- Wire the Copilot session dir and `.jsonl` extension into the sessions reader.

**OpenClaw**

- Carry OpenClaw user data forward on version switch.

**Teams**

- Warn loudly when `--after` teammates reference a name whose watch process never launched, instead of silently sitting in pending state.

**Plugins**

- Use `'directory'` source discriminator (not `'local'`) for marketplace registration so plugins reload correctly.

**Dependencies**

- Bump `@inquirer/prompts` 7.10.1 → 8.5.1, `diff` 8.0.4 → 9.0.0, `tsx` 4.22.2 → 4.22.3, `actions/setup-node` 4.4.0 → 6.4.0.

## 1.18.6

**Claude**

- Add auto permission mode support for Claude runs.
- Remove a dead automatic mode flag from the Claude command template.

**Teams**

- Fix the cycle-detection test to accept running or failed teammate status.

## 1.18.5

**Browser**

- **Breaking:** action commands no longer accept a leading `<task>` positional.
  Bind the task once per shell via `AGENTS_BROWSER_TASK`, or pass `--task <name>`
  for a per-call override:
  ```bash
  export AGENTS_BROWSER_TASK=$(agents browser start --profile work)
  agents browser navigate --url https://example.com
  agents browser click 42
  agents browser screenshot
  ```
  Env vars are per-process, so parallel agents in different shells never collide.
- **Breaking:** URL/text/expression/scroll arguments are now flag-only — positional forms removed:
  - `navigate --url <url>` (was `navigate <url>`)
  - `tab add --url <url>` (was `tab add <url>`)
  - `type <ref> --text "..."` (was `type <ref> "..."`)
  - `evaluate --expression "..."` or `--file <path>` (was `evaluate "..."`)
  - `scroll --dx <n> --dy <n>` (was `scroll <dx> <dy>` — fixes negative-value parser collision)
- `screenshot` prints a one-line auto-save tip on stderr when `--output` is not passed,
  so agents see the directory without having to dirname() the path.

## 1.18.4

**Browser**

- `agents browser start` writes the resolved task name to **stdout** as a
  single line (e.g. `swift-crab-falcon-a3f92b1c`), and routes the human
  commentary ("Started task ... with tab ...", "Tip: export
  AGENTS_BROWSER_TASK=...") to **stderr**. This makes
  `T=$(agents browser start --profile X)` Just Work — no `--quiet` flag needed.
- Auto-generated task names are now three English words plus an 8-char hex
  suffix, e.g. `swift-crab-falcon-a3f92b1c`. Memorable, distinct, 32 bits of
  entropy so parallel agents never collide. Daemon retries on the (vanishingly
  rare) name clash and rejects explicit `--task <name>` values that already
  exist.
- `agents browser start --profile <name>` now pre-validates the profile
  locally before touching the daemon. Missing profile prints the list of
  available profiles plus the create-command hint instead of a generic error.
- `agents browser tab list` is now `agents browser tabs` (top-level), pairing
  cleanly with `agents browser tab focus <id>`. The old `tab list` form is
  removed.
- `agents browser --help` is reorganized by mental model — *Session lifecycle*,
  *Drive the page*, *Capture evidence* — instead of an alphabetical dump.
  Rare commands stay under a trailing *Commands* section.
- BREAKING: `agents browser profiles prime` and `agents browser profiles launch`
  are removed. Both were thin duplicates of `start`. For first-run
  onboarding, just `agents browser start --profile <name>` and complete the
  interactive screens in the browser; the user-data-dir persists across
  runs. The daemon's `launch-profile` IPC action is also gone.
- Named endpoint presets per profile. One profile can now cover the local
  and remote variants of the same app instead of forcing two parallel
  profiles. YAML supports both the legacy `endpoints: [url]` shape and the
  new map form:
  ```yaml
  name: rush
  browser: custom
  electron: true
  endpoints:
    local:
      target: cdp://127.0.0.1:9223
      binary: /Applications/Rush.app/Contents/MacOS/Rush
    mac-mini:
      target: ssh://mac-mini?port=9223
      # no binary — daemon attaches only
  defaultEndpoint: local
  ```
  `agents browser start --profile rush --endpoint mac-mini` picks a specific
  preset; `--endpoint` falls back to `defaultEndpoint` or the first preset.
  Pre-validated client-side so a typo doesn't waste an IPC round-trip.
  Per-endpoint `binary` and `targetFilter` override the profile-level
  fields. `agents browser profiles show` lists every preset, marks the
  default, and shows per-endpoint overrides.
- The daemon's runtime identity is now `<profile>@<endpoint>` so the same
  profile can run at multiple endpoints concurrently without colliding on
  pid/port files. `agents browser status` and `tasks` show the composite
  name, so you can tell at a glance which variant a task is using.
- `agents browser screenshot --quality raw` captures pixel-faithful PNG
  (no downscale) for archived QA evidence. Default stays `compressed`
  (JPEG, capped near 100 KB) for chat-injected screenshots.
- New `agents browser record start` / `agents browser record stop`
  recording verbs. Captures via CDP `Page.startScreencast`, pipes frames
  into ffmpeg (image2pipe → libvpx-vp9) and writes a webm under
  `sessions/<task>/recordings/`. Bounded three ways — `--fps` (default
  5), `--duration` (hard cap, default 60s), `--max-mb` (default 25);
  whichever fires first auto-finalizes the file. Requires ffmpeg on
  PATH (`brew install ffmpeg`).

## 1.18.3

**Plugins** ([#22](https://github.com/phnx-labs/agents-cli/issues/22))

- `agents plugins sync` now installs plugins via Claude Code's native marketplace path — `<versionHome>/.{claude,openclaw}/plugins/marketplaces/agents-cli/plugins/<name>/` — instead of flattening contents into `~/.claude/skills/<plugin>--<skill>/`. Skills resolve as `/plugin:skill` (the documented form) instead of `/plugin--skill`. Plugins appear in Claude's `/plugins` UI under Installed and respond to `/plugin enable`, `/plugin disable`.
- A synthetic `agents-cli` marketplace is materialized per version: `.claude-plugin/marketplace.json` is synthesized from discovered plugins, an entry is added to `<versionHome>/.claude/plugins/known_marketplaces.json`, and `settings.json#enabledPlugins["<plugin>@agents-cli"]` is flipped to `true`. Removal is symmetric — last plugin out drops the marketplace dir and the known_marketplaces entry.
- The sync now copies the whole plugin tree verbatim (single `fs.cpSync`) instead of re-implementing per-feature merges into `settings.json`. Every Claude plugin feature — skills, commands, subagents, hooks, `.mcp.json`, `.lsp.json`, `monitors/monitors.json`, `bin/`, `settings.json` — is preserved end-to-end. `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are left intact so Claude can expand them at runtime; only `${user_config.*}` (agents-cli-specific) is pre-expanded in copied text files.
- Legacy dual-dash layout from prior versions is auto-migrated at sync time — `~/.claude/skills/<plugin>--*`, `~/.claude/commands/<plugin>--*.md`, `~/.claude/agents/<plugin>--*.md`, `plugin-bin/<plugin>/`, and namespaced `mcpServers["<plugin>--*"]` entries are removed after the marketplace install succeeds.
- `agents plugins view <name>` surfaces every feature the plugin ships: Skills, Commands, Subagents, Hooks, MCP Servers, LSP Servers, Monitors, Bin, Scripts, Settings. The `agents view <agent>@<version>` Plugins section gains MCP/LSP/Monitor/Bin/Settings counts. New `discoverPluginMcpServers`, `discoverPluginLspServers`, `discoverPluginMonitors` helpers parse `.mcp.json`, `.lsp.json`, and `monitors/monitors.json`.

## 1.18.2

**Teams**

- Dropped `~/.agents/teams/config.json` entirely. It duplicated information agents-cli already has — agent commands, enabled flags, model defaults, provider endpoints — none of which the team runner was actually reading. Teams now discover agents via `listInstalledVersions()` (the same source `agents view` uses) and invoke them via the canonical `agents run` subcommand. One spawn path, one canonical exec module (`src/lib/exec.ts`). The deprecated `AGENT_COMMANDS`, `applyEditMode`, `applyFullMode`, `readConfig`, `writeConfig`, `setAgentEnabled`, `AgentConfig`, `SwarmConfig`, `ProviderConfig`, `ModelOverrides`, `ReadConfigResult`, and `EffortLevel` (the persistence-module copy) exports are removed from `@phnx-labs/agents-cli/teams`. Migration deletes both `~/.agents/teams/config.json` and the legacy `~/.agents/config.json`.
- `~/.agents/teams/registry.json` moves to `~/.agents/.history/teams/registry.json` — it's per-machine runtime state (timestamps + absolute worktree paths) and shouldn't be synced across machines via `agents repo push`.
- New `agents run --quiet` flag suppresses the rotation banner and `Running: …` preamble lines. Used by the team runner so stream-json events reach the parser without non-JSON preamble.

**Dev builds**

- The CLI auto-detects dev builds (version stamped `0.0.0-dev.<sha>` by `scripts/install.sh`, or invoked from a working tree where `<cli-dir>/../.git/` exists) and defaults `AGENTS_NO_AUTOPULL=1`, `AGENTS_SKIP_MIGRATION=1`, and `AGENTS_CLI_DISABLE_AUTO_UPDATE=1`. No more typing those three env vars on every iteration. Production installs (registry global, no `.git/` at package root) are unaffected.

## 1.18.1

**Fixes**

- `scripts/build.sh` now sets mode `0o755` on every file declared in `package.json#bin` after `tsc` emits dist/. Newer npm versions preserve file mode from the published tarball and do NOT auto-chmod the bin target during `npm install -g`, so 1.18.0 shipped with mode-644 entrypoints. Users hit `zsh: permission denied: agents` after auto-update. Re-install to recover: `npm install -g @phnx-labs/agents-cli@latest`.
- New `scripts/install.sh` builds the working tree as a side-by-side dev install at `$HOME/.local/agents-cli-dev/`, symlinked into `$HOME/.local/bin/agents`. The registry install is never touched — `agents --version` shows `0.0.0-dev.<sha>[-dirty]` when the dev build is on PATH.

## 1.18.0

**Plugins**

- `~/.agents/plugins/` is now a first-class user-resource location, alongside `skills/`, `commands/`, `hooks/`, etc. — git-tracked as source of truth. Previously, `migrateRuntimeToCache` moved `~/.agents/plugins/` into `~/.agents/.cache/plugins/` on every CLI version bump, silently destroying user-authored plugins in the working tree. Fixed by (1) removing the destructive move, (2) restoring discovery to the user-root, (3) a one-shot reverse migration that moves any cached plugins back to the user-root without overwriting an existing user-root copy, and (4) decoupling the migration sentinel from the binary version so migrations only re-run on real schema bumps. ([#20](https://github.com/phnx-labs/agents-cli/issues/20))
- `agents view <agent>@<version>` gains a `Plugins` section listing each plugin that supports the agent, with a `(N skills, N commands, …)` content summary and an OSC 8 hyperlink to the plugin source.

**Hooks**

- `getAvailableResources` and the version-home sync now treat only executable files in `hooks/` as hooks. Docs (`README.md`) and data files (`promptcuts.yaml`) that live alongside hooks no longer get synced into version homes as hooks, and the orphan-pruner trusts the manifest's declared hook list rather than re-scanning every source dir.

## 1.17.6

**Workflows**

- New `workflows` skill — author-and-run guide for workflow bundles (`WORKFLOW.md` frontmatter, `subagents/` directory for multi-agent pipelines, scoped `skills/` and `plugins/`, sharing via `agents repo push` or GitHub install). Calls out the `--mode plan` deadlock that bites workflows which need to post comments or edit files.
- `agents workflows --help` rewritten with a structure diagram, project > user > system resolution order, and an explicit note that workflows mutating state need `--mode edit` or `--mode full` to avoid a headless deadlock at `ExitPlanMode`.
- README gains a `Workflows` section between Teams and Browser covering the bundle layout, frontmatter, subagents/skills/plugins, and the `--mode` requirement.

## 1.17.4

**Browser**

- `agents browser type` now detects rich-text editor frameworks (Lexical, ProseMirror, Slate, Draft.js, Quill, CKEditor5, Trix) by walking up to 5 ancestor levels from each textbox and tagging refs with `[editor=<framework>]`. Editor-tagged refs route through the WHATWG `beforeinput` dispatch (`InputEvent('beforeinput', { inputType: 'insertText', ... })`) for Lexical/ProseMirror/Slate/Quill/CKEditor5/Draft and `el.editor.insertString()` for Trix. `agents browser refs --json` surfaces the new `editor` field, and `type --clear` prepends a select-all + `deleteContentBackward` dispatch before inserting.
- Plain-input reliability also improved: `typeText` now issues a single CDP `Input.insertText` instead of per-character `dispatchKeyEvent`, so framework-controlled inputs (React, Vue, Solid, MUI/Chakra/Mantine `TextField`, masked-number fields, Canva-style pickers) actually receive `beforeinput`/`input`/`textInput` events. `focusNode` falls back to the first focusable descendant when `DOM.focus` throws "Element is not focusable" — fixes wrapper-ref UIs like Slack composer, Linear comments, Notion blocks, and every MUI/Chakra/Mantine `TextField`. ([#12](https://github.com/phnx-labs/agents-cli/pull/12))

## 1.17.3

**Browser**

- `agents browser profiles create` gains `--electron`, `--binary`, and `--target-filter` for driving Electron desktop apps (Canva, Slack, etc.) that expose multiple CDP page targets. The picker matches by `url:<substring>` or `title:<substring>` (case-insensitive) and falls back to a skip-invisible heuristic when no filter is set; misses against an explicit filter throw with the full candidate list. `BrowserService.evaluate` now uses `awaitPromise: true` and surfaces `exceptionDetails` so async script errors propagate as thrown errors. ([#14](https://github.com/phnx-labs/agents-cli/pull/14))

**Secrets**

- `agents secrets list` rework — drop the misleading `SENSITIVE` column and add `SYNC` (iCloud yes/no) plus `CREATED` / `UPDATED` / `USED` relative-age columns. Timestamps live inside the keychain bundle JSON, are stamped on write (created sticky, updated always advances), and on resolve via a 60s throttle. Set `AGENTS_NO_USAGE_TRACK=1` to disable the usage stamp. `agents secrets view` shows the matching absolute ISO + relative age fields. ([#18](https://github.com/phnx-labs/agents-cli/pull/18))

## 1.17.2

**Fixes**

- Auto-update prompt no longer hangs in non-interactive environments (CI, k8s pods, cloud sandbox factories). The TTY check now requires both stdin and stdout to be terminals before prompting, and `AGENTS_CLI_DISABLE_AUTO_UPDATE=1` forces the check off entirely for headless deploys. ([#15](https://github.com/phnx-labs/agents-cli/issues/15))

## 1.17.1

**Agent management**

- `agents import <agent>` — adopt an existing global npm/homebrew install into agents-cli management without reinstalling. Supports `--version`, `--from-path`, `--yes`. The imported version is wired in as the global default with shim + versioned alias so it behaves the same as a freshly `agents add`'d install.

## 1.17.0

**Workflows: a new first-class resource**

- `agents workflows list / add / remove / view` — WORKFLOW.md bundles (with optional `subagents/`, `skills/`, `plugins/`) install from GitHub or a local path and resolve through the same system → user → project layer model as every other resource.
- `agents run <name>` resolves a workflow or named subagent as an orchestrator: prepends WORKFLOW.md / AGENT.md body to the prompt, copies `subagents/*` into `~/.claude/agents/` for Agent-tool discovery, and syncs workflow-scoped `skills/` and `plugins/` at run time.
- `agents view` now has a workflows section.

**Browser**

- Port-per-profile with auto-allocation and viewport enforcement — concurrent browser profiles no longer collide on CDP ports.
- `agents browser scroll` plus new `profiles launch`, `profiles doctor`, `profiles prime`, viewport position, and port diagnostics commands.
- `agents browser profiles list` now shows a description column when any profile has one.
- `isProcessRunning` treats EPERM as process-alive (fixes false-negative on sandboxed processes).

**Cloud dispatch**

- `--balanced` strategy and `--upload-account-tokens` flag on cloud dispatch.
- Remote account API client; `--balanced` skips the client manifest path.

**Plugin system extension**

- Plugins now ship with `commands/`, `agents/`, `bin/`, MCP configs, settings, and `install` / `update` hooks. Discovery and sync extended end-to-end.

**Secrets**

- `agents secrets import <bundle> --from-1password` / `export <bundle> --to-1password` with vault picker, skip-empty-fields on import, overwrite-only-with-`--force` on export. Wires the existing 1Password library into the CLI.

**Sandbox**

- `scripts/sandbox.sh --pr` — author real PRs from a Crabbox-isolated box via a bare-mirror clone off main.
- `sandbox.sh --linear` and `--post-file` post run output to Linear tickets.
- Dynamic GitHub App token, `gh` CLI installed, stale git credentials cleaned.

**Sessions / SQLite concurrency**

- Scan coordinator prevents concurrent session indexing.
- SQLite concurrency hardened with `BEGIN IMMEDIATE` and ledger recheck on contention.
- Session discovery uses `getHistoryDir` for version roots and backup paths.

**Run / shims / hooks**

- Versioned alias shims regenerate on startup if missing.
- Hooks prefer version-home scripts to prevent path breakage when the source dir moves.
- Linux: claude shim sources `CLAUDE_CODE_OAUTH_TOKEN` from the per-version `.oauth_token` file when unset.

**Resource UI**

- `agents view` replaces path columns with OSC 8 hyperlinks for commands, skills, and rules.
- Flat version resource lists replaced with source-pattern selection.

**CI / security**

- Gitleaks secret-scanning workflow on every push (switched to the free CLI, no org license needed).

**Postinstall**

- Correct shims dir, expanded aliases, prints changelog on install.

**Dev**

- Test isolation via vitest `pool: 'forks'`; mock state paths instead of hitting real `~/.agents/`.
- Concurrent-writes benchmark for the session indexer.
- Dead code + phantom deps removed: `src/commands/fork.ts`, `@aws-sdk/client-s3`, `@modelcontextprotocol/sdk`, `semver`.

## 1.16.0

**System-repo sweep: ~/.agents-system reduced to npm-shipped defaults only**

- New migrators move every form of operational state out of ~/.agents-system into user-side buckets: sessions, teams (live + per-run), trash, repos (→ ~/.agents-<alias>/ peer dirs), legacy swarm/, cache/, cloud/.
- SQLite DBs merge row-level (INSERT OR IGNORE) into the user-side DB; filesystem dirs merge dir-by-dir with user-side winning on collision.
- Dead artifacts dropped automatically: bin/agents-keychain-*, empty shims/, .DS_Store-only versions/ skeletons.
- Unrecognized leftover dirs print a one-line stderr warning so future drift surfaces immediately.
- Migration diagnostics moved to stderr — `eval "$(agents secrets export …)"` stops being polluted by log lines.
- DB merge now skips FTS5 virtual + shadow tables (previously corrupted the session_text index). Indexer re-populates FTS on the next scan.
- Stale ~/.agents-system/agents.yaml is now dropped when a user copy exists.

**~/.agents split into .history/ and .cache/ buckets**

- Durable runtime state (sessions, versions, runs, teams/agents, trash, backups) moves to ~/.agents/.history/.
- Regenerable runtime state (shims, packages, cloud, logs, companion, helpers, browser runtime, fetch cache, dot-files) moves to ~/.agents/.cache/.
- Single-line gitignore for backing up ~/.agents/ — no more per-subdir cherry-picking.

**Browser: profiles fold into agents.yaml + many new automation commands**

- Profile YAMLs at ~/.agents/browser/profiles/*.yaml now live as a `browser:` section in agents.yaml. Single user-facing file, single sync.
- Single window per profile; `start` renamed to `open`; new tab subcommands; session history with profile picker; viewport piped through to the launched browser.
- New commands: `agents browser set viewport`, `set device`, `devices`, `console`, `errors`, `requests`, `responsebody`, `wait`, `download`, `waitdownload`.

**Hooks: hooks.yaml folded into agents.yaml `hooks:` section**

- ~/.agents/hooks.yaml is migrated into agents.yaml on first run; the standalone file is removed.
- System repo ships the same shape — one config file, layered project > user > system.

**Sessions & secrets**

- `agents secrets exec <bundle> -- <command>` injects a bundle's env vars into a one-shot subprocess (no shell-state leakage).
- `agents sessions` now groups active sessions by workspace and surfaces session topics in the picker.
- Session discovery scans both version repos; migrator merges overlapping versions instead of leaving duplicates.

**Renames**

- `agents init` → `agents setup`.
- `permissions/sets/` → `permissions/presets/` (resource directory + on-disk migration to match rules/presets convention).

**Dev**

- Crabbox remote-test profile (~$0.14/hr) + `scripts/sandbox.sh` documented in README and CLAUDE.md. Tests run remotely to avoid freezing the local machine.

## 1.15.0

**Secrets: Linux support via libsecret/GNOME Keyring**

- `agents secrets` now works on Linux backed by libsecret/GNOME Keyring with the same UX as macOS Keychain. Headless workarounds documented.
- New `agents password generate` subcommand.
- Lifecycle events emitted for secrets and other subsystems; richer metadata (timing helpers) on the events system.

**Browser**

- HTTP and WebSocket endpoint support for remote browsers.
- Concurrent Electron profile forks no longer step on each other; cleanup hardened.
- Remote browser restart works; SSH port handling improved; page target created when none exists for Electron apps.
- Events emitted for navigation and screenshots.

**First-run UX**

- Improved new-user experience: clearer CLI help, better defaults, audit-log opt-out, better run-timing display.

**Prune**

- `agents prune` learned `trash`, `sessions`, and `runs` cleanup targets.

**Fixes**

- Command-injection hole in daemon + secrets closed.
- Layered permission resolution corrected; daemon tests isolated from real user state.
- `.tmp-bun` gitignore pattern fixed.
- `codex` interactive mode no longer routes through `exec` subcommand.

**Docs**

- Security/privacy section in README, browser skill + automation guide, FAQ updated with audit-log transparency.

## 1.14.6

**Fix: OAuth token refresh now persists to Keychain**

- Fixed bug where refreshed Claude OAuth tokens were used but never saved back to macOS Keychain
- Previously, agents-cli would refresh expired tokens on each run but discard them, eventually exhausting the refresh token
- Now refreshed `accessToken`, `refreshToken`, and `expiresAt` are written back to Keychain after successful refresh
- Accounts will stay healthy across runs without requiring re-login

## 1.14.5

**Browser: custom binary and Electron app support**

- Added `binary` field to browser profiles for specifying custom executable paths (e.g., Electron apps like Rush)
- Added `electron` field to browser profiles — when true, uses existing windows instead of creating new ones (Electron doesn't support `Target.createTarget`)
- New `custom` browser type that requires a binary path
- Works with both local and SSH-based browser connections
- Example profile for Rush: `agents browser profiles edit rush --browser custom --binary "/Applications/Rush.app/Contents/MacOS/Rush" --electron`

## 1.12.0

**JSON output for sessions list**

- Added `--json` flag to `agents sessions list` and `agents sessions` for programmatic use
- Output is a JSON array of session metadata (id, shortId, agent, version, account, project, cwd, filePath, topic, messageCount, tokenCount, timestamp)
- Enables the Companion VS Code extension's "Agents: Session Resume" and "Agents: Session Trace" pickers

**OpenClaw workspace-aware sessions**

- Fixed `agents sessions --agent openclaw` so synthetic OpenClaw rows now use the configured agent workspace from `~/.openclaw/openclaw.json`
- When no per-agent workspace is available, OpenClaw session discovery now falls back to `~/.openclaw` instead of leaving `cwd` empty or filling it with status text
- Added a regression test covering managed OpenClaw homes symlinked through `~/.agents/versions/openclaw/...`

## 1.11.1

**Session search and version labeling**

- `agents sessions view` now opens a live-search picker by default in interactive terminals
- `agents sessions --agent ...` and `agents sessions --project ...` now open the same live-search picker before falling back to the table view
- `agents sessions view <query>` now resolves prompt text, not just exact session IDs
- Fixed `--project` search so it scans across directories instead of intersecting with the current working directory
- Session topics now skip injected scaffolding and use the first human prompt
- Codex session rows now show the real CLI build from `cli_version` (for example `codex@0.113.0`)
- Gemini, OpenCode, and OpenClaw session rows now resolve and display agent versions consistently in the shared `Agent` column
- Claude usage lookup now falls back across scoped and legacy Keychain services when loading OAuth credentials

## 1.11.0

**PTY -- interactive terminal sessions for AI agents**

- New `agents pty` command suite for persistent, interactive PTY sessions
- Sidecar server architecture -- lightweight daemon on `~/.agents/pty.sock`, auto-starts on first use
- `agents pty start` -- spawn a session with configurable rows, cols, shell, and working directory
- `agents pty exec <id> <command>` -- submit commands (non-blocking, sentinel-based completion detection)
- `agents pty screen <id>` -- render the terminal as clean text (no ANSI codes), powered by xterm-headless
- `agents pty write <id> <input>` -- send keystrokes with escape sequence support (`\n`, `\t`, `\e`, `\xHH`)
- `agents pty read <id>` -- read raw PTY output with configurable timeout
- `agents pty signal <id> [INT|TERM|KILL]` -- send signals to the PTY process
- `agents pty list` -- show active sessions with status, PID, age, and active command
- `agents pty server start|stop|status` -- manage the sidecar server directly
- Session idle cleanup (30 min) and server auto-exit (1 hour with no sessions)
- `--json` output on all commands for scripting
- Auto-fixes node-pty spawn-helper permissions on startup (bun install workaround)

## 1.10.0

**Drive -- sync agent sessions across machines**

- New `agents drive` command for syncing agent state between machines via rsync over SSH
- `agents drive remote <user@host>` -- set sync target (syncs to `~/.agents/drive/` on remote)
- `agents drive pull` / `push` -- additive rsync (no data loss, both sides accumulate)
- `agents drive attach` -- swap `~/.claude` symlinks to the drive, so Claude reads/writes there
- `agents drive detach` -- restore symlinks to the version home
- `agents drive status` -- show remote, attached state, symlink targets, last sync times

## 1.9.1

**Better sessions**

- Sessions list and picker show `Agent@Version` combined column (e.g., `claude@2.1.85`)
- Added `Topic` column showing first user message of each session
- Account shows email instead of display name

## 1.9.0

**New agents, routines, and better sessions**

Agents:
- Added support for 5 new agents: Copilot, Amp, Kiro, Goose, and Roo Code
- Agent type expanded to 11 agents total

Routines (renamed from cron):
- `agents cron` is now `agents routines` -- aligns with Claude Code Routines naming
- `agents cron` and `agents jobs` still work as deprecated aliases
- `~/.agents/cron/` directory renamed to `~/.agents/routines/`

Sessions:
- Sessions list now shows `Agent@Version` in a combined column (e.g., `claude@2.1.85`)
- Added `Topic` column showing the first message of each session
- Account column now shows email instead of display name
- Session picker uses the same columns as the list view

Other:
- Account email preferred over display name across the CLI
- Rewritten help text for all top-level commands

## 1.6.12

**"memory" is now "rules"**

The `agents memory` command has been renamed to `agents rules`. This better reflects what these files actually are -- instruction files like AGENTS.md, CLAUDE.md, and .cursorrules that tell your agents how to behave.

- `agents rules list` -- see your instruction files across all agents
- `agents rules add` -- install and sync rule files from a repo or local path
- `agents rules view` -- view rule file content for any agent
- `agents rules remove` -- remove a rule file

If you run `agents memory`, you'll see a message pointing you to the new command.

The files themselves haven't changed -- AGENTS.md is still AGENTS.md. Only the CLI command name changed.

## 1.6.8

**Bug fix**

- Skip commands and memory sync for agents that don't support file-based commands (openclaw)
- Added `commands` capability flag to agent configs
- `agents use openclaw` and `agents view openclaw` no longer show or sync slash commands or memory files
- Fixed `hasNewResources` to filter by agent capabilities (was triggering prompt even when no applicable resources existed)

## 1.6.5

**Bug fix**

- Fixed memory file detection counting symlinks as separate files (CLAUDE.md/GEMINI.md -> AGENTS.md)

## 1.6.4

**Bug fixes**

- Fixed Claude email not showing in `agents view` (was reading from version home instead of real ~/.claude.json)
- Fixed memory file updates not being detected in `agents use` (now compares content, not just existence)

## 1.6.3

**Bug fix**

- Fixed infinite "new resources available" loop in `agents view`
- Partial resource syncs no longer wipe out previously synced resources

## 1.5.82

**MCP & Permission improvements**

- MCP configs now stored as YAML in `~/.agents/mcp/` (was JSON)
- Permissions now use groups from `~/.agents/permissions/groups/`
- Resource selection shows proper counts: "Permissions (19 groups, 3132 rules)"
- When selecting "specific" permissions, shows individual groups with rule counts
- Added MCP support for cursor and opencode agents
- Removed `agents` filter from MCP configs - selection tracked in agents.yaml
- Added capability checks for MCPs (consistent with hooks/permissions)

## 1.5.81

**Cron jobs & unified execution**

- Renamed `jobs` command to `cron` (`jobs` still works with deprecation warning)
- New `agents exec <agent> <prompt>` for unified agent execution across all CLIs
- Inline job creation: `agents cron add my-job --schedule "..." --agent claude --prompt "..."`
- One-shot jobs with `--at`: `agents cron add reminder --at "14:30" -a claude -p "..."`
- New `agents cron edit [name]` opens job in `$EDITOR`
- Timezone support: `--timezone America/Los_Angeles`
- Custom variables in prompts: define `variables:` block, use `{var_name}` in prompt
- Interactive pickers for all cron subcommands when name is omitted
- Smart filtering: `resume` shows only paused jobs, `pause` shows only enabled jobs
- Effort-based model mapping: `--effort fast|default|detailed` maps to agent-specific models

**Resource command cleanup**

- Added `view` command to commands, mcp, hooks, and permissions
- Removed `push` commands from all resources (commands, skills, mcp, memory, hooks)
- Deprecated `perms` alias for `permissions` (shows warning but still works)
- Deprecated `info` alias for `skills view`, `show` alias for `memory view`

## 1.5.68

- Upgrade prompt now shows on ALL command flows (--version, --help, bare `agents`)

## 1.5.67

**Unified view command**

- New `agents view` command replaces `list` and `status`
- `agents view` / `agents view claude` shows installed versions
- `agents view claude@2.0.65` shows full resources (commands, skills, mcp, hooks, memory)
- Old commands show deprecation warning but continue to work

## 1.5.48

**Simplified repo structure**

- Flattened repo structure: removed `shared/` prefix
- Resources now live at top level: `commands/`, `skills/`, `hooks/`, `memory/`, `permissions/`
- Removed agent-specific override directories (no more `claude/commands/`, etc.)
- Simplified discovery functions

## 1.5.29

**Version-aware resource installation**

- `agents pull` now prompts for version selection per agent when multiple versions are installed
- Resources (commands, skills, hooks, memory) are linked into version homes at pull time via `syncResourcesToVersion()`
- Simplified shims: HOME overlay + exec only (~80 lines, down from ~160). No more runtime sync logic.
- MCP registration uses direct binary path for version-managed agents (bypasses shim)

## 1.5.7

- Remove trailing newlines from command output

## 1.5.5

- Update prompt: Interactive menu before command runs (Upgrade now / Later)

## 1.5.4

- `cli list`: Shows spinner while checking installed CLIs

## 1.5.3

- `skills view`: Opens in pager (less) for scrolling, press `q` to quit

## 1.5.2

- `skills view`: Truncate descriptions to fit on one line

## 1.5.1

- Update check: Shows prompt when new version available
- What's new: Displays changelog after upgrade
- `skills view`: Interactive skill selector (renamed from `info`)
- Fixed `--version` showing hardcoded 1.0.0 (now reads from package.json)
- Silent npm/bun output during upgrade

## 1.5.0

**Pull command redesign**

- Agent-specific sync: `agents pull claude` syncs only Claude resources
- Agent aliases: `cc`, `cx`, `gx`, `cr`, `oc` for quick filtering
- Overview display: Shows NEW vs EXISTING resources before installation
- Per-resource prompts: Choose overwrite/skip/cancel for each conflict
- `-y` flag: Auto-confirm and skip conflicts
- `-f` flag: Auto-confirm and overwrite conflicts
- Graceful cancellation: Ctrl+C shows "Cancelled" cleanly

## 1.4.0

- Conflict detection for pull command
- Bulk conflict handling (overwrite all / skip all / cancel)

## 1.3.13

- Enabled skills support for Cursor and OpenCode
- Fixed Cursor MCP config path (now uses mcp.json)

## 1.3.12

- Fixed MCP detection for Codex (TOML config format)
- Fixed MCP detection for OpenCode (JSONC config format)
- Added smol-toml dependency for TOML parsing

## 1.3.11

- Status command shows resource names instead of counts
- Better formatting for installed commands, skills, and MCPs

## 1.3.0

- Added Agent Skills support (SKILL.md + rules/)
- Skills validation with metadata requirements
- Central skills directory at ~/.agents/skills/

## 1.2.0

- Added hooks support for Claude and Gemini
- Hook discovery from hooks/ directory
- Project-scope hooks support

## 1.1.0

- Added MCP server registration
- Support for stdio and http transports
- Per-agent MCP configuration

## 1.0.0

- Initial release
- Pull/push commands for syncing agent configurations
- Slash command management
- Multi-agent support (Claude, Codex, Gemini, Cursor, OpenCode)
