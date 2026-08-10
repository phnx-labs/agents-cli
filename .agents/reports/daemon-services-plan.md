---
kind: plan
template: plan.v1
title: Per-service toggles for agents daemon
summary: Add independent enable/disable toggles for every daemon-hosted service, make the secrets broker disableable with a clear error, and expose the toggles through agents daemon services enable|disable <service>.
status: approved
tracking: RUSH-XXXX
---

## Purpose

`agents daemon` already exists on `main` (RUSH-2354): it has `status`, `start`, `stop`, `restart`, `enable`, `disable`, `reload`, `services`, `logs`, and `doctor`. What is missing is independent control of the services the daemon hosts.

The daemon currently runs all of these unconditionally:

- secrets broker (+ broker self-heal)
- routines scheduler + catchup
- monitor engine
- browser IPC server
- self-heal registry
- keychain reap
- account-state service (usage refresh + fleet-status publish)
- watchdog
- device probe
- state-dir self-check

When the secrets broker misbehaves and causes a Touch ID storm, there is no kill switch. This change adds a per-service toggle so any hosted service can be disabled, and callers get a clear error instead of a silent fallback.

<figure class="artifact-figure artifact-figure-diagram">
<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="20" width="680" height="280" rx="8" fill="#0a0a0a" stroke="#333" stroke-width="2"/>
  <text x="360" y="52" text-anchor="middle" fill="#e5e5e5" font-size="18" font-weight="bold">Proposed: each daemon service is independently toggleable</text>
  <rect x="60" y="90" width="180" height="60" rx="4" fill="#14532d" stroke="#4ade80" stroke-width="2"/>
  <text x="150" y="115" text-anchor="middle" fill="#dcfce7" font-size="14" font-weight="bold">services.yaml</text>
  <text x="150" y="138" text-anchor="middle" fill="#86efac" font-size="12">~/.agents/daemon/</text>
  <polygon points="250,120 290,120 280,110 290,120 280,130" fill="#a3e635"/>
  <line x1="240" y1="120" x2="290" y2="120" stroke="#a3e635" stroke-width="2"/>
  <rect x="320" y="90" width="180" height="60" rx="4" fill="#1e293b" stroke="#475569" stroke-width="1"/>
  <text x="410" y="115" text-anchor="middle" fill="#e2e8f0" font-size="14" font-weight="bold">runDaemon()</text>
  <text x="410" y="138" text-anchor="middle" fill="#94a3b8" font-size="12">read config, gate services</text>
  <line x1="500" y1="120" x2="550" y2="120" stroke="#a3e635" stroke-width="2"/>
  <polygon points="550,120 590,120 580,110 590,120 580,130" fill="#a3e635"/>
  <rect x="600" y="90" width="80" height="60" rx="4" fill="#1e293b" stroke="#475569" stroke-width="1"/>
  <text x="640" y="125" text-anchor="middle" fill="#e2e8f0" font-size="13">Service N</text>
  <rect x="320" y="180" width="360" height="90" rx="4" fill="#1e293b" stroke="#475569" stroke-width="1"/>
  <text x="360" y="210" fill="#e2e8f0" font-size="13">Disabled service path (e.g. secrets-broker)</text>
  <text x="360" y="235" fill="#fca5a5" font-size="12">Caller sees: "secrets broker is disabled —</text>
  <text x="360" y="255" fill="#fca5a5" font-size="12">re-enable with 'agents daemon services enable secrets-broker'"</text>
</svg>
<figcaption>Figure 1: Config-driven service gating and clear disabled-service errors.</figcaption>
</figure>

<p class="artifact-callout"><strong>Load-bearing takeaway:</strong> Disabling a service must stop the daemon from running it and must make callers fail with an actionable message — never silently fall back to Touch ID or another worse path.</p>

## Current state (after pulling latest main)

- `apps/cli/src/commands/daemon.ts` — full daemon command tree already exists.
- `apps/cli/src/commands/daemon.test.ts` — tests exist.
- `apps/cli/src/lib/daemon.ts` — `runDaemon()` starts all services unconditionally.
- `apps/cli/src/lib/device-config.ts` — `daemon.enabled` and `scheduler.enabled` already exist as device-config gates.
- Recent refactor `dd2043848` (RUSH-2495) removed the maintenance-routine layer; watchdog and device-probe are now plain daemon timers.

## Proposed Changes

### 1. Add a service config file and loader

Create `apps/cli/src/lib/daemon-services.ts`:

- Stable service IDs.
- Human titles + descriptions.
- Config path: `~/.agents/daemon/services.yaml`.
- Helpers: `readDaemonServicesConfig()`, `isDaemonServiceEnabled(id)`, `setDaemonServiceEnabled(id, enabled)`.

Initial catalog (all default to `true`):

```yaml
services:
  secrets-broker: true
  scheduler: true
  monitors: true
  browser-ipc: true
  self-heal: true
  keychain-reap: true
  account-state: true
  watchdog: true
  device-probe: true
  state-dir-check: true
```

Only explicit `false` disables. Missing file or missing key means enabled.

### 2. Extend `agents daemon services` with enable/disable

Add subcommands:

```
agents daemon services list           # existing + toggle state
agents daemon services enable <id>
agents daemon services disable <id>
```

Keep `agents daemon services` (no args) as the health-only view.

### 3. Gate services inside `runDaemon()`

Read the service config at startup. For each disabled service:

- Skip its initialization.
- Skip its timer/interval.
- Skip its self-heal loop.

On `SIGHUP` reload, apply scheduler and secrets-broker toggles immediately where feasible; for other services, log that a restart is required to apply a toggle change.

### 4. Make secrets broker disablement fail loudly

When `secrets-broker` is disabled:

- Daemon does not call `startHostedBroker()` and does not run `runBrokerSelfHeal()`.
- The secrets fast-path client reads the service config. If disabled, it returns a disabled verdict.
- `agents secrets` commands surface: `Secrets broker is disabled — re-enable with 'agents daemon services enable secrets-broker'`.
- This prevents the Touch ID fallback storm.

## Public Interface

### New commands

| Command | Behavior |
|---|---|
| `agents daemon services list` | Lists every hosted service, its enabled/disabled state, and description. |
| `agents daemon services enable <id>` | Enables a service. |
| `agents daemon services disable <id>` | Disables a service. |

### Config file

`~/.agents/daemon/services.yaml` holds per-service booleans.

### Disabled-service error

For secrets broker specifically:

```
Secrets broker is disabled — re-enable with 'agents daemon services enable secrets-broker'
```

## Validation

- Unit tests for `lib/daemon-services.ts`: defaults, read/write toggles, unknown IDs ignored.
- Tests for `agents daemon services list|enable|disable`.
- Test that disabling `secrets-broker` makes `agents secrets` fail with the expected message.
- Existing `daemon.test.ts` and `routines.test.ts` still pass.
- Run `bun run test:remote` or local suite and fix failures.

## Risks

| Risk | Mitigation |
|---|---|
| A service is accidentally disabled by default. | Default every known service to `true`; only explicit `false` disables. |
| Secrets broker disabled state leaks to non-daemon paths. | Check config inside `ensureAgentRunning()`; align with `AGENTS_SECRETS_NO_AGENT=1`. |
| `__daemon-run` behavior changes. | Only gate what happens after `runDaemon()` starts. |
| Single-instance guarantee breaks. | Do not touch `claimDaemonInstance()`, locks, pid file, or heartbeat logic. |
| Watchdog/device-probe toggle confusion with existing device-config flags. | Keep existing `watchdog.enabled` as the activity gate; the service toggle controls whether the timer runs at all. |

## Tracking

- [ ] Add `getDaemonConfigDir()` path helper in `state.ts`.
- [ ] Create `lib/daemon-services.ts` catalog + config loader.
- [ ] Extend `commands/daemon.ts` with `services enable|disable|list`.
- [ ] Gate services in `runDaemon()`.
- [ ] Wire secrets-broker disabled check into `lib/secrets/agent.ts` and `commands/secrets.ts`.
- [ ] Update tests.
- [ ] Update docs and CHANGELOG.
- [ ] Run tests and verify.
