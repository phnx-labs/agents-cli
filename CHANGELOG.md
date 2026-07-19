# Changelog

## Unreleased

### Security

- **`agents plugins update` no longer silently executes a compromised upstream (RUSH-1757).**
  A plugin's upstream is mutable: `updatePlugin` used to `git pull --ff-only` (or
  re-copy) straight over the live plugin tree, then re-sync — and when the new
  revision added an executable surface (`hooks/`, `.mcp.json`, `bin/`, `scripts/`,
  `settings.json`, `permissions/`) it only *declined to add* an enablement key,
  never *removed* a pre-existing one. A benign, already-enabled plugin whose
  upstream was later compromised would therefore execute new hooks/MCP on the next
  update without renewed consent. The update now fetches the incoming revision into
  a **quarantine** dir first, diffs its capabilities against the current on-disk
  baseline, and applies to the live tree only after the trust decision: an update
  that introduces a *new* exec surface is **refused** (last-good content kept in
  place) unless the user re-consents with `agents plugins update <name>
  --allow-exec-surfaces`. A surface the user already trusted is not "new" and does
  not re-trigger the gate. Source: `apps/cli/src/lib/plugins.ts` (`updatePlugin`,
  `newExecSurfaceLabels`), `apps/cli/src/commands/plugins.ts`.
- **`launch_app` on Windows rejects UNC/remote and protocol/URL targets (RUSH-1763).**
  Explicit `path` values used to flow straight into `ProcessStartInfo` with
  `UseShellExecute=true`, so a caller could launch `\\server\share\payload.exe`
  or `http://…` / `ms-settings:…` handlers. `launch_app` now rejects UNC/remote
  paths, protocol/URL schemes, and `..` path segments; explicit `path` must be
  a local drive-rooted absolute path (`C:\…`). Short names (`notepad`, `msedge`)
  still resolve via PATH / App Paths. Source: `native/computer-win/LaunchTarget.cs`,
  `native/computer-win/Apps.cs`.
- **The Windows `computer` daemon now requires authentication.** `computer-helper-win`
  previously started with `authed = expectedToken == null` and the CLI never provisioned a
  token, so it ran open on `127.0.0.1` — and loopback TCP on Windows is not user/session
  scoped, letting **any** local process drive full screen capture, input injection, and
  program launch. The daemon now **refuses to start without a `--token-file`**
  (`native/computer-win/Program.cs`), and `agents computer setup --host` generates a
  shared-secret token, writes it on the remote with an owner-only ACL, registers the task
  with `--token-file`, and persists it locally so `start --host` authenticates
  (`apps/cli/src/lib/ssh-tunnel.ts`). Existing token-less setups must re-run
  `agents computer setup --host <device>` (the daemon will otherwise refuse to start).
- **Plugin exec-surface detection now sees inline manifest `hooks`/`mcpServers`.**
  `inspectPluginCapabilities` classified a plugin as having an execution surface only
  from filesystem artifacts (a `hooks/` dir, a `.mcp.json` file), but the official plugin
  format also allows `hooks`/`mcpServers` declared **inline** in `.claude-plugin/plugin.json`.
  A cloned repo's project plugin declaring exec config inline was therefore not detected,
  so `project-launch` auto-enabled it — clone-to-code-execution on the next agent launch
  without `--allow-exec-surfaces`. Detection now also treats a non-empty inline
  `hooks`/`mcpServers` (event map or path string) as an execution surface
  (`apps/cli/src/lib/plugins.ts`). (`apps/cli/src/lib/types.ts` gains the manifest fields.)
- **SSH option-injection containment for `browser` over `ssh://`.** The `user`/`host`
  from an `ssh://` browser profile endpoint (git-tracked user config) are now validated
  with `assertValidSshTarget` before every raw `ssh` spawn — the remote-launch
  (`ensureRemoteBrowser`), remote-kill (`runSSHCommand`), and `-L` tunnel
  (`startSSHTunnel`) sinks in `apps/cli/src/lib/browser/drivers/ssh.ts` and
  `apps/cli/src/lib/ssh-tunnel.ts`. A crafted endpoint like `ssh://-Fattacker@victim`
  can no longer place `-Fattacker` at the ssh target position (parsed as `-F <file>`),
  which an attacker-supplied ssh config's `ProxyCommand` would have turned into local
  code execution.
- **Path-traversal containment for untrusted-input filesystem sinks.**
  - Routine job names (from routine YAML `name:` / file basename, which can arrive via a
    synced user/system config repo) are now contained to a single path segment beneath
    the routines dir at **every** sink. A crafted name such as `../../../..` can no longer
    steer the overlay HOME setup — whose teardown does a recursive `rmSync`
    (`apps/cli/src/lib/sandbox.ts`) — nor the per-run directory that the daemon's
    load/schedule path `mkdirSync`s and writes `stdout.log`/`meta.json`/`report.md` into
    (`getJobRunsDir`/`getRunDir` in `apps/cli/src/lib/routines.ts`, used by
    `apps/cli/src/lib/runner.ts`), outside `~/.agents/routines` and
    `~/.agents/.history/runs`. `validateJob` also rejects unsafe names.
  - Session-sync **pull** now validates the peer-controlled `machine` and `relKey` fields
    before writing a mirrored transcript, matching the guard the push side already applied.
    A malicious fleet peer can no longer use a manifest `relKey` like
    `../../../.ssh/authorized_keys` to write attacker content outside the backups mirror
    (`apps/cli/src/lib/session/sync/agents.ts`). The new containment rejection is caught
    per-session in `apps/cli/src/lib/session/sync/sync.ts` and around the umbrella-sync
    stage in `apps/cli/src/lib/sync-umbrella.ts`, so one malicious manifest entry can't
    wedge the whole sync tick (skipping `savePullState`) or the `agents sync` reconcile
    stage for everyone else.
  - Shared containment helpers `isSafeSegmentName` / `assertWithin` added to
    `apps/cli/src/lib/paths.ts`.
- **`agents sessions <id> --json` now redacts secrets by default.** The JSON render
  path emitted raw transcript events with no redaction, while `--markdown` masked
  them by default — so the output format an agent scripts against was the one that
  leaked credentials. `renderJson` now runs the whole payload (events *and* the
  session meta, including `topic`/`plan` — verbatim message excerpts) through the
  same `redactSecrets` pass as markdown, covering the JSON-only leak vector of raw
  tool-call `args`. Additionally, `--no-redact` now actually works: it read the
  wrong Commander property (`options.noRedact`, never populated) so the flag was a
  dead no-op for **both** formats; it now reads `--no-redact`'s real `redact`
  property and genuinely disables redaction when passed. Source:
  `apps/cli/src/lib/session/render.ts` (`renderJson`, `redactDeep`),
  `apps/cli/src/commands/sessions.ts`.

### Added

- **`agents run <agent>@` now opens a safe per-run account picker.** The picker
  shows one row per installed version with account identity, exact version,
  login state, plan, and available session/weekly/monthly capacity. Logged-out,
  rate-limited, and out-of-credit rows stay visible but cannot be selected;
  signed-in rows without provider quota data remain selectable and say `limits
  unavailable`. The selected version is pinned for that run only. Ambiguous
  combinations (`--resume`, strategy overrides, leases, remote hosts, profiles,
  and workflows) fail before dispatch. Source:
  `apps/cli/src/commands/run-account-picker.ts`,
  `apps/cli/src/commands/exec.ts`, `apps/cli/src/lib/rotate.ts`.

- **Routine `meta.json` now includes `duration` and `errorMessage` (RUSH-1281).**
  `RunMeta` records wall-clock `duration` in milliseconds and a machine-readable
  `errorMessage` on failure paths (spawn errors, timeouts, loop errors, host-reconcile
  failures, and monitor-reaped runs). Populated on every terminal state in
  `apps/cli/src/lib/runner.ts` via the new `finalizeRunMeta` helper in
  `apps/cli/src/lib/routines.ts`.

- **`agents run --lease` is now frictionless end-to-end (RUSH-1723).** Leasing a
  disposable cloud box to run an agent — the BYO-your-own-cloud way to offload heavy
  work when local CPU cores are exhausted — no longer needs an env var, a flag, or a
  hand-made keychain bundle:
  - **Headless by default (RUSH-1724).** `--lease` no longer blocks on an interactive
    runtime picker or confirm — it infers the one runtime the run needs from the agent,
    and copies the account the run's own `balanced` strategy would pick (a healthy,
    non-rate-limited one), never the whole set of signed-in tokens and never a throttled
    account.
  - **`agents lease setup` (RUSH-1728).** A one-time wizard opens the Hetzner token page,
    validates the token against the live API, stores it in the `hetzner.com` keychain
    bundle, and sets it as the default. First-run `--lease` detects a missing credential
    and runs this automatically, then continues.
  - **No more `AGENTS_LEASE_SECRETS_BUNDLE=` (RUSH-1728).** New `lease.secretsBundle`
    config, plus auto-detection of the first bundle that declares a provider token
    (`HCLOUD_TOKEN`/`AWS_ACCESS_KEY_ID`/`DIGITALOCEAN_TOKEN`) — only that key is injected
    into crabbox (least privilege).
  - **`agents lease gc` (RUSH-1726).** Reclaim expired, idle "orphan" boxes that hold a
    provider's server quota (the cause of a Hetzner `server_limit` 403, which is now an
    actionable error). Conservative: only stops boxes whose lease expired AND that have
    been untouched past a safety window, and requires `--yes` or a TTY confirm.

  Source: `apps/cli/src/commands/lease.ts`, `apps/cli/src/commands/exec.ts`,
  `apps/cli/src/lib/crabbox/cli.ts`, `apps/cli/src/lib/crabbox/runtimes.ts`,
  `apps/cli/src/lib/crabbox/lease.ts`, `apps/cli/src/lib/types.ts`.

### Fixed

- **`agents run <agent> --fallback …` no longer disables account rotation.**
  A `--fallback` chain skipped strategy resolution entirely ("strategy balanced
  ignored: --fallback pins versions directly"), so the bare primary always ran on
  the pinned default version — one fixed account, every run. On a multi-account
  host this silently stopped rotation for exactly the runs that most need it
  (unattended monitors dispatching with a cross-agent fallback chain). The
  fallback chain only names where to cascade; it never pinned the primary, so
  the strategy now resolves the primary's version/account as usual. The
  same-agent rotation failover (#348) also now composes with an explicit chain:
  the other healthy accounts are unshifted ahead of the cross-agent entries, so
  a rate limit exhausts same-agent accounts before switching CLIs. Explicit
  `@version` pins and profiles keep their pinning behavior.

- **Fallback now cascades on Claude billing refusals ("monthly spend limit",
  "out of usage credits").** Two gaps: the messages matched no
  `RATE_LIMIT_PATTERNS` entry, and Claude prints them to **stdout** while the
  cascade only scanned stderr — so a capped account failed the whole run
  (exit 1) with codex/droid sitting unused in the chain. Added both patterns,
  and `runWithFallback` now tees a bounded stdout tail per attempt
  (`captureStdoutTail`) and scans it alongside stderr. Output remains mirrored
  to the parent's stdout exactly as before.

- **`agents run --resume <id>` now spawns from the session's origin directory.**
  Native resume (claude/codex) resolves the transcript relative to the working
  directory (`projects/<cwd-hash>/`), but the resolver found the session across all
  projects and then invoked the agent from the *current* cwd — so a resume from a
  different directory (most importantly a routine daemon firing `agents run --resume`)
  failed with "No conversation found with session ID". It now `cd`s to the resolved
  session's own `cwd` (honoring an explicit `--cwd`). This makes `routines add
  --resume` (self-scheduled wake-ups) actually reopen the session end-to-end.

### Added

- **Allowlist (permissions) support for OpenClaw (RUSH-1570).** Permission
  groups now sync to OpenClaw. Because OpenClaw gates at TOOL granularity only,
  just **blanket** (whole-tool) rules map into `~/.openclaw/openclaw.json`
  `tools.alsoAllow` (allow) / `tools.deny` (deny) — `bash → exec`,
  `read → read`, `write`/`edit → write`, `webfetch → web_fetch`,
  `websearch → web_search`; sub-command/path/domain rules (`Bash(git:*)`,
  `Write(secrets/**)`, `WebFetch(domain:x)`) are skipped. The absolute
  `tools.allow` list and all other config keys are preserved. Source:
  `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/permissions.ts`,
  `apps/cli/src/lib/resources/permissions.ts`,
  `apps/cli/src/lib/staleness/detectors/permissions.ts`.

### Fixed

- **`agents add grok@latest` now places the Grok binary in the new version's
  isolated home.** The x.ai installer writes to `~/.grok/downloads`, which
  resolved to the previous default home during install, leaving `agents view`
  and `agents run` pointing at the old version. The installer-dropped binary is
  now relocated into the target version home automatically.

- **`agents run` user splits close automatically instead of leaving dead husks.**
  `createSession` now applies `remain-on-exit` only to the agent pane and reverts
  the global default, so splits opened with `agents tmux split` (or tmux
  keybindings) close when their shell exits. The guarded `pane-died` hook still
  detaches the client on agent pane death, and its `kill-pane` fallback remains
  for legacy sessions that still carry the old global setting. This removes the
  async cleanup race that made the guarded-hook test flake in CI.

### Added

- **Hooks support for Hermes Agent (RUSH-1687).** Central hooks now register into
  Hermes' `~/.hermes/config.yaml` under a `hooks:` block (YAML, gated to Hermes
  ≥ 0.11.0). The registrar read-modify-writes the shared config so `mcp_servers`
  and other keys survive, maps canonical events to Hermes' snake_case lifecycle
  names (`pre_tool_call`, `post_tool_call`, `on_session_start`, `on_session_end`,
  `pre_llm_call`, `on_session_finalize`, `subagent_stop`), and caps each timeout
  at 300s. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/hooks.ts`,
  `apps/cli/src/lib/staleness/writers/hooks.ts`.

- **`agents routines add --resume <sessionId>` — wake an existing session instead
  of starting fresh.** At fire time the job runs `agents run <agent> --resume <id>`,
  so the *actual* prior session reopens with its full context and the routine's
  `--prompt` becomes its next turn. Powers self-scheduled wake-ups (an agent that
  hibernates on a long external wait and resumes itself later). Without it, a routine
  spawns a context-less fresh agent, which correctly refuses an opaque instruction it
  has no memory of. Requires `--agent claude` or `codex` (native resume, validated);
  the job runs **un-sandboxed** so `--resume` can find the session in the real agent
  home, and — like workflow jobs — its command is never binary-pinned.
- **Cursor CLI receives synced subagents.** cursor-agent custom subagents are
  installed as `.md` profiles under `~/.cursor/agents/` (matching cursor-agent's
  native format), with matching list, remove, and stale-state behavior.
  (RUSH-1388)

- **`agents output` — productivity: token burn vs shipped output.** A new command
  that joins spend (`$` cost, from the offline price table) to what actually
  shipped: real generated **output tokens** plus **commits across every git
  identity** and **PRs opened/merged** (`gh`), with burn-vs-output ratios
  (`$/PR`, `$/commit`, output-tokens/`$`). Supports `--since`, `--by
  agent|project|day`, `--repos-dir`, `--author`, `--login`, `--no-prs`, `--json`,
  and `--host`. Leads with output tokens because the raw session `token_count`
  sums cache-read/-write context re-counted every turn and runs ~100–400× the
  real generation — an honest "work produced" signal, not the inflated total.
  `--all-hosts` folds in every online device (`ag devices`) over SSH for one
  fleet-wide burn-vs-output view (unreachable/older machines are labeled, not
  dropped). `--since` accepts `1h`, `24h`, `7d`, `4w`, `1mo`, `1y`, or an ISO
  date.

- **`parseTimeFilter` gains month (`mo`) and year (`y`) units.** Additive and
  non-breaking — `m` still means minutes; `1mo` = 30 days, `1y` = 365 days.
  Shared by `output`, `cost`, and `sessions --since`.

- **`output_tokens` recorded per session (schema v12).** The session scanners now
  capture real generated tokens separately from `token_count` for claude, codex,
  gemini, opencode, kimi, and droid, surfaced via `queryUsageRollup`. Existing
  session databases migrate additively and backfill on the next scan (the first
  run re-indexes once).

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
  `setup-share.ts` (+ `setup.test.ts`), `apps/cli/src/lib/browser/chrome.ts`
  (`listInstalledBrowsers`), `apps/cli/src/commands/share.ts`.

- **The macOS `agents computer` helper now ships as a signed + notarized release asset,
  downloaded on demand.** A fresh `npm i -g @phnx-labs/agents-cli` no longer needs to build
  the Swift helper from source: `agents computer setup` / `agents setup computer` fetch
  `ComputerHelper.app.zip` from the matching `v<version>` GitHub release, verify it against
  the published `.sha256`, and re-check the code signature (Developer ID Team `2HTP252L87`)
  and notarization (`spctl --assess`) before it is ever copied to /Applications — mirroring
  the Windows helper's distribution. The helper is version-stamped at build time and the
  release pipeline publishes the asset automatically. Source:
  `apps/cli/src/lib/computer/download.ts` (+ `download.test.ts`),
  `apps/cli/src/lib/computer-rpc.ts`, `apps/cli/src/commands/computer.ts`,
  `native/computer-mac/scripts/build.sh`, `apps/cli/scripts/publish-computer-helper-mac.sh`,
  `apps/cli/scripts/release.sh`.
- **`agents ssh` propagates your terminal's terminfo to the remote (RUSH-1811).**
  Modern terminals (Ghostty, kitty, Alacritty, WezTerm, foot, rio) advertise a
  custom `TERM` — e.g. `xterm-ghostty` — whose terminfo ships with the terminal,
  not with the remote host's ncurses. SSH into a box that lacks the entry and the
  session is subtly broken: wrong backspace, missing colors, a garbled
  clear/alt-screen. Ghostty's shell integration fixes the bare `ssh` command, but
  `agents ssh` (spawned directly, Tailscale-relayed) bypassed it. Now, on an
  interactive POSIX login, `agents ssh` exports the local entry (`infocmp -x`) and
  compiles it on the remote (`tic -x -`, into the user's `~/.terminfo`, no sudo).
  It is **fail-safe** — any error, timeout, or missing remote `tic` is swallowed
  so the login is never blocked or delayed beyond a short push cap — and
  **cached** per host+`TERM`, so only the first login to each host pays one extra
  round-trip. Skipped for Windows/PowerShell devices (the console ignores
  terminfo), non-interactive command runs, and terminfo names ncurses ships
  everywhere. Source: `apps/cli/src/lib/devices/terminfo.ts`,
  `apps/cli/src/commands/ssh.ts`.

- **`agents devices list` / `agents fleet status` are cache-first now — instant by
  default, `--refresh` (alias `--live`) for a live probe.** Both used to live-SSH
  every registered box for load/mem on every call, so a glance at a dozen-device
  fleet (a few cold or timing out) hung for seconds. Resource stats now serve from
  a small on-disk cache (`.fleet-stats.json`) that the daemon warms ~every 3 min;
  a default read probes only *this* machine (locally, no ssh) plus any device
  missing from the cache. Pass `--refresh`/`--live` to force a full live probe.
  Cache-served output carries an "`updated … — pass --refresh (--live)`" age note.
  `agents view` (usage already stale-while-revalidate cached) gains the same
  `--live` alias for its `--refresh`. Source: `apps/cli/src/lib/devices/stats-cache.ts`,
  `apps/cli/src/commands/ssh.ts`, `apps/cli/src/commands/view.ts`,
  `apps/cli/src/lib/daemon.ts`.

- **`agents fleet status` gains an Auth column — see which accounts are actually
  logged in, per device.** Reads the shared auth-health cache (no network) and
  rolls each host up into four honest buckets so it never cries wolf:
  `●live` (verified), `·present` (signed in but the agent has no live-probe
  endpoint — codex/grok/antigravity/opencode — benign), `◐degraded`
  (soft/self-healing: expired/limited/error), `○revoked` (server rejected —
  re-login now). Remote hosts self-report their rollup through `doctor --json`, so
  the column is current without a fleet-wide `agents fleet ping`. The daemon also
  refreshes this host's auth verdicts alongside the stats warm. Source:
  `apps/cli/src/lib/auth-health.ts` (`summarizeHostAuth`),
  `apps/cli/src/lib/devices/health-report.ts`, `apps/cli/src/commands/doctor.ts`.

## 1.20.58

### Added

- **Cursor CLI allowlists sync into its native permission store.** Shell, file,
  web, and MCP grants now write to `~/.cursor/cli-config.json` without changing
  Cursor's existing deny rules. (RUSH-1387)

- **GitHub Copilot CLI and Kiro CLI receive synced subagents.** Copilot custom
  agents are installed as `.agent.md` profiles, while Kiro custom agents are
  installed as native JSON definitions with matching list, remove, and stale-
  state behavior. (RUSH-1390, RUSH-1393)

- **Active-session JSON includes attachment metadata for Factory previews.**
  Prompt images and documents now surface their path, name, media type, and size
  so consumers can render thumbnails and open the originals. (RUSH-1524)

- **Kiro CLI allowlists sync as v3 capability rules.** Shell, filesystem, and
  web permissions now merge into Kiro 2.8.0+ while preserving user-authored
  rules and removing duplicate generated entries.

- **Remote runs honor `--cwd`, with `--project` as a project-name shortcut.**
  Host dispatch re-roots home-anchored paths on the remote machine, while
  `--project <slug>[@worktree]` resolves configured project roots locally or
  over `--host`.

### Fixed

- **Self-updating agents are modeled as one live binary, not fictional version
  homes.** `agents view` reports the installed binary's version and folds away
  stale per-version directories; `agents add <agent>@<version>` gracefully keeps
  or installs the current release for Droid, Grok, Cursor, Kiro, Goose, Hermes,
  and other single-binary agents. (RUSH-1321)

- **Stopped teammate resumes are transactional.** Failed local and remote resume
  launches preserve the existing teammate record and runtime state, terminate
  the replacement process group and descendants, restore the prior log cursor,
  and preserve the original launch error even if the restore write also fails.
  Successful resumes restart log parsing at byte zero after truncation. (#1104,
  #1108)

- **Menu-bar Quick Dispatch keeps drafts when focus is stolen and carries every
  selected screenshot into filed tickets.** Reopening the panel restores its
  text and selections, while ticket-agent briefs now require the attached files
  to be uploaded to the resulting Linear issue. (RUSH-1592, RUSH-1668)

- **The always-on daemon is the sole persistent secrets-broker host.** Upgrades
  retire the legacy `com.phnx-labs.agents-secrets-agent` launchd service before
  restarting the daemon, and the `secrets start`, `stop`, and `status` commands
  now report and control broker reachability without reinstalling that service.
  (#416, step 2)

- **Interactive remote secret reveals do not leave an SSH control master
  behind.** The one-shot TTY reveal path now disables multiplexing, so it exits
  immediately after Touch ID or passphrase authorization.

- **Global npm upgrades restart the scheduler through the installed CLI.** The
  macOS postinstall self-heal now passes the resolved signed CLI path into daemon
  startup explicitly, so launchd never records `scripts/postinstall.js` as the
  scheduler command.

- **Daemon-hosted and standalone secrets brokers share one race-safe socket
  binder.** Either startup order now preserves the live owner; the losing broker
  stays quiescent without triggering launchd restart churn, takes over if the
  owner stops, releases its standby PID on service shutdown, and only reclaims
  an unreachable stale socket.

- **Daemon service manifests pin the active Node runtime.** Symlinked and
  extension-less Node entrypoints launch through `process.execPath`, and service
  PATHs no longer hardcode a removable nvm patch version.

## 1.20.57

### Added

- **Stopped teammates can resume with a follow-up message.**
  `agents teams resume` re-enters the teammate's captured session, while
  `agents teams message` routes to a live mailbox or resumes a stopped teammate.

- **The always-on daemon hosts the secrets broker socket-first.** Secret reads
  can use the supervised daemon immediately after start without changing the
  broker wire protocol.

### Changed

- **Secret policy labels use one `policy · state` vocabulary.**
  `agents secrets list` now reports `daily`, `daily · held 7d`,
  `always · prompt`, and `never · no prompt`.

## 1.20.56

### Fixed

- **Installed native CLIs supervise daemons through their physical executable.**
  Bun standalone binaries expose an embedded `/$bunfs/root/agents` entry at
  `process.argv[1]` and report that virtual entry as existing. Daemon service
  manifests now resolve that case through the physical on-disk `process.execPath`,
  so `agents routines start` works from the published macOS standalone binary
  while the virtual-path safety guard remains enforced.

- **Standalone self-spawns use the physical CLI binary.** `agents teams`,
  `agents message`, and `agents profiles check` no longer pass Bun's virtual
  entry back as a subcommand, restoring those flows for signed native installs.

## 1.20.55

### Added

- **Heartbeat watchdog** — the daemon writes a heartbeat (timestamp + pid) every
  monitor tick; `agents routines status` now distinguishes `running` / `wedged` /
  `stopped`. A wedged daemon (pid alive but heartbeat stale >3 ticks) is reported
  with a restart hint. (RUSH-1670)

- **Opportunistic orphan reaper** — `agents routines list` and `status` now call
  `monitorRunningJobs()` on entry (best-effort, swallowed errors), so orphaned
  `running` records finalize even when the daemon is down. (RUSH-1671)

- **Pid-reuse-safe reaper + max wall-clock** — `monitorRunningJobs()` records
  `spawnedAt` (epoch ms) at spawn and verifies process identity via `ps` before
  treating a pid as alive, preventing recycled-pid false positives. Runs exceeding
  24 hours are finalized as `timeout` regardless of pid state. (RUSH-1672)

- **Daemon binary path guard** — `getDaemonLaunch()` rejects `/$bunfs/root/…`
  (bun virtual filesystem) paths with a hard error and warns when the resolved
  binary sits inside `.agents/worktrees/`. `agents routines status` now prints the
  resolved daemon binary path. (RUSH-1673)
