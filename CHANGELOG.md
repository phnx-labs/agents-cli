# Changelog

## Unreleased

### Fixed

- **Self-updating agents (droid et al.) are modeled as a single binary, not
  fictional version-homes.** droid installs one global self-updating binary, so
  `agents view` no longer shows phantom duplicate droid versions (e.g. `0.19.3`
  AND `0.21.0` for the same binary) — it collapses to a single row showing the
  live `droid --version`, and stale per-version dirs are folded away on sight.
  `agents add droid@<version>` no longer errors with "does not support
  version-pinned installs" — it gracefully installs the current release (a no-op
  when already installed). Applies to every VERSION-less curl/brew installer
  (droid, grok, antigravity, cursor, hermes, forge, kiro, goose). npm-packaged
  agents (claude, codex, kimi) are unaffected. (RUSH-1321)

## 1.20.58

### Added

- **Kiro CLI allowlists sync as v3 capability rules.** Shell, filesystem, and
  web permissions now merge into Kiro 2.8.0+ while preserving user-authored
  rules and removing duplicate generated entries.

- **Remote runs honor `--cwd`, with `--project` as a project-name shortcut.**
  Host dispatch re-roots home-anchored paths on the remote machine, while
  `--project <slug>[@worktree]` resolves configured project roots locally or
  over `--host`.

### Fixed

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
