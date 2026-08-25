# Daemon module

The background process behind `agents __daemon-run` — the interval-driven
services that keep sessions, watchdog checks, device probes, monitors,
self-heal, and reapers running on each machine without a human polling them.

## Current architecture

**N independent per-device daemons, no daemon-to-daemon bus.** Every device
that runs agents-cli runs its own daemon process (`agents __daemon-run` →
`runDaemon()`, `daemon.ts:850`). No daemon opens a persistent connection to
another daemon. The only cross-device transport is spawning `ssh` to invoke a
CLI verb with `--local` on the peer and reading its stdout — e.g.
`watchFleetFeed` spawns `ssh <peer> agents feed watch --local`
(`cli/src/lib/feed/watch.ts:151`) and `watchFleetSessions` does the same for
sessions (`cli/src/lib/session/remote/watch.ts:245`). This means every
cross-device feature in this repo is built on top of one primitive (ssh +
CLI verb), not a shared daemon protocol.

**Two runtime models coexist today (RUSH-3193 P1/P2 migrated 5 of 12
services; the rest are still inline).** `cli/src/lib/daemon-services.ts`
defines `DaemonServiceId` (`daemon-services.ts:17-29`, 12 ids:
`secrets-broker`, `scheduler`, `monitors`, `browser-ipc`,
`webhook-receiver`, `self-heal`, `keychain-reap`, `account-state`,
`watchdog`, `device-probe`, `state-dir-check`, `session-index`) — the
catalog every id in `runDaemon()` is expected to register under, whichever
model it uses.

- **Supervised (`ServiceSupervisor`, `supervisor.ts`), 5 services:**
  `secrets-broker` (`secrets-broker-service.ts`), `browser-ipc`
  (`browser-ipc-service.ts`), `account-state`
  (`account-state-daemon-service.ts`), `session-index`
  (`session-index-service.ts`), and `monitors`
  (`monitor-engine-service.ts`). Each implements the `DaemonService`
  contract (`service.ts`) — `id`, `start`/`stop`/`restart`/`health()`, plus
  `intervalMs`/`deadlineMs`/`tick()` for the periodic ones — and is
  `supervisor.register()`ed in `runDaemon()` (`daemon.ts:956-976`) only when
  `isDaemonServiceEnabled(id)` is true at boot. The supervisor gives each one
  a per-tick deadline race, a per-service try/catch that never escapes to the
  process-wide crash handler, and a park/backoff circuit breaker
  (`parkAfterFailures`, default 3) that retries independently of every
  sibling service. `getServiceSupervisorHealth()` (`daemon.ts:60`) exposes
  the live in-process `supervisor.health()` map for a future same-process
  reader; a cross-process reader (`agents daemon services`, a separate CLI
  invocation) instead reads the persisted mirror below.
- **Inline `setInterval` closures, 7 services:** `scheduler` (the routine
  `JobScheduler`, handled on its own live-reload path, not the supervisor),
  `webhook-receiver`, `self-heal`, `keychain-reap`, `watchdog`,
  `device-probe`, and `state-dir-check` are each still a bare
  `setInterval`/`setTimeout` closure directly in `runDaemon()`, guarded only
  by a local in-flight boolean and a try/catch that logs and returns — the
  pre-P1 shape, e.g. the active-sessions-warm tick (`daemon.ts:1101-1110`):

  ```ts
  if (activeSessionsWarmInFlight) return;
  activeSessionsWarmInFlight = true;
  try { await runActiveSessionsWarmTick(); }
  catch (err) { log('WARN', ...) }
  finally { activeSessionsWarmInFlight = false; }
  ```

  These 7 have no per-service circuit breaker and no state persisted to
  `health.json` — `agents daemon services` infers a coarse `running`/`stopped`
  label for them from the enable toggle plus whether the daemon process is up
  (see below), never a measured value. Migrating each onto the supervisor is
  the RUSH-3193 P3 follow-up this doc's Target section still describes.

Enabled/disabled state lives separately in a `DaemonServicesConfig`, read
and written via `isDaemonServiceEnabled` (`daemon-services.ts`),
`setDaemonServiceEnabled` (`daemon-services.ts`), and
`listDaemonServiceStates` (`daemon-services.ts`) — one `services.yaml` under
`getDaemonConfigDir()`, unioned across both runtime models above.

**Cross-process health is file-backed, keyed by the same `DaemonServiceId`
strings the two models above use.** `cli/src/lib/daemon-health.ts` is the
one health mirror both the daemon (writer) and `agents daemon` /
`agents daemon services` (a separate reader process) use —
`recordSubsystemOk`/`recordSubsystemError` (ok/error streak + last
error/timestamp) and, since RUSH-3193 P4, `recordSubsystemState` (the
supervisor's `idle`/`running`/`parked`/`stopped` lifecycle state, written on
every transition in `supervisor.ts`'s `startOne`/`stopOne`/`park`/
`attemptRestart`). Only the 5 supervised services ever call
`recordSubsystemState`, so a `SubsystemHealth` record's `state` field being
present is itself the signal `agents daemon services` uses to render
"measured" vs "inferred" (`commands/daemon.ts`'s `buildServiceRows`).

**Crash model: any uncaught error in the process kills and restarts the
whole daemon, not just the failing service — except for the 5 supervised
services above, which the supervisor's own try/catch + deadline race now
isolate.** A throw that escapes an INLINE service's local try/catch is still
uncaught at the process level. `cli/src/index.ts:96-102` installs the
top-level handlers:

```ts
process.on('uncaughtException', crash('uncaughtException'));
process.on('unhandledRejection', crash('unhandledRejection'));
```

`crash()` logs and then calls `process.exit(1)` (`index.ts:100`), relying on
the OS supervisor (launchd `KeepAlive` on macOS, `systemd Restart=always` on
Linux) to relaunch the whole process — every INLINE service restarts
together, not just the one that threw. The 7 inline services still have no
recorded health signal beyond their own log lines.

**Live enable/disable/restart (RUSH-3193 P4).** `agents daemon services
enable|disable|restart <id>` persists the toggle (or, for `restart`, queues
a one-shot restart request via `queueDaemonServiceRestart` —
`daemon-services.ts`) and then signals the running daemon over the same
`SIGHUP` `agents daemon reload` already used (`signalDaemonReload`,
`daemon.ts:2423`) — there is no separate control socket. The daemon's
`handleReload` (`daemon.ts:1399`) diffs the reloaded `services.yaml` against
the config it booted with and, for any of the 5 supervised ids, calls
`supervisor.start(id)` / `supervisor.stop(id)` live — no daemon restart. It
also drains any queued restart via `supervisor.restartOne(id)`. A service
disabled at boot was never `register()`ed, so enabling it live is not
possible (the supervisor's registry is fixed at construction) — the CLI
falls back to the pre-P4 "restart the daemon to apply" advice for that case,
and for all 7 inline services, which have no supervisor entry to start/stop
at all. `agents daemon services` (no subcommand) reads
`readAllSubsystemHealth()` plus `listDaemonServiceStates()` and renders one
row per registered id — state, enabled, consecutive failures, last error —
additively alongside the pre-existing `secretsBroker`/`browserIpc` hosted-
socket fields in `--json` (`commands/daemon.ts`'s `runServices`). An
interactive TTY browser (reusing `dynamicPicker`, `lib/picker.ts`) is
intentionally out of scope for this PR — see the linked follow-up ticket.

**Four cross-device distribution patterns already exist, each hand-rolled
independently — there is no shared abstraction between them:**

- **fanout** (per-peer watch, local process per remote): `watchFleetFeed`
  (`cli/src/lib/feed/watch.ts:133`) and `watchFleetSessions`
  (`cli/src/lib/session/remote/watch.ts:223`) each spawn one `ssh` child per
  peer device and merge their streamed output into one local view.
- **mirror** (every device publishes its own row, readers union all rows):
  `publishLocalFleetStatus` (`cli/src/lib/fleet-status.ts:151`) and
  `writeAuthHealthEntries` (`cli/src/lib/auth-health.ts:373`, called at
  `auth-health.ts:603`) each write a local file that other devices read and
  merge — no single device owns the aggregate.
- **elected-singleton** (first-come binds, others detect and back off):
  the secrets broker binds a local socket in `startHostedBroker`
  (`cli/src/lib/secrets/agent.ts:915`, bind call at `:925`); daemon-side
  takeover logic is `shouldTakeOverBroker`
  (`cli/src/lib/daemon/daemon.ts:182`):

  ```ts
  export function shouldTakeOverBroker(isHosting: boolean, brokerReachable: boolean): boolean {
    return !isHosting && !brokerReachable;
  }
  ```

**Caching is mostly ad-hoc — the bounded primitive is underused.**
`createMemoryCache` (`cli/src/lib/memory-cache.ts:21-23`) is a bounded
LRU+TTL cache (`max` and `ttlMs` are required, with optional
`fetchMethod` coalescing):

```ts
export function createMemoryCache<K extends {}, V extends {}>(options: MemoryCacheOptions<K, V>): LRUCache<K, V>
```

Only 3 call sites actually use it: `cli/src/lib/session/session-cache.ts:78`
and `cli/src/commands/sessions-picker.ts:142` / `:160`. Roughly 28 other
files implement their own ad-hoc TTL constants plus disk-mirror files with
little or no eviction (`fleet-status.ts`, `auth-health.ts`, `mailbox.ts`,
`linear-cache.ts`, `devices/stats-cache.ts`, `session/presence.ts`,
`secrets/vault.ts`, and others) — so roughly 3 of ~31 cache-like constructs
in this area route through the shared bounded cache. State this as it is:
most daemon-adjacent caching has no shared eviction policy today.

## Target (RUSH-3193, in progress)

**Shipped:** the `DaemonService`/`PeriodicService` contract and
`ServiceSupervisor` (P1); 5 of 12 services migrated onto it — secrets-broker,
browser-ipc, account-state, session-index, monitors (P2); and the operator
surface — `agents daemon services` reporting every registered service's
health (measured for the 5 supervised, inferred for the other 7) plus live
`enable`/`disable`/`restart` for the supervised set over the existing SIGHUP
reload path (P4, this doc's Current architecture section above is the
source of truth for all three).

**Still open:**

- **P3 — migrate the remaining 7 inline services** (`scheduler`,
  `webhook-receiver`, `self-heal`, `keychain-reap`, `watchdog`,
  `device-probe`, `state-dir-check`) onto the supervisor, so every service
  gets the per-service error boundary, deadline, circuit breaker, and
  `recordSubsystemState` mirror the 5 supervised ones already have — and so
  `agents daemon services enable <id>` can start a service that was disabled
  at daemon boot (today the supervisor's registry is fixed at construction,
  so that case still needs a restart). `scheduler` in particular already has
  its own live-reload path (`schedulerGateTransition`) that predates the
  supervisor; folding it in needs care not to regress that.
- **Interactive `agents daemon services` browser** — a TTY-only view reusing
  `dynamicPicker` (`lib/picker.ts`), one row per service with a live-updating
  preview pane (log tail, last error, config) and inline
  enable/disable/restart keybindings, mirroring the `agents sessions`
  browser (`commands/sessions-browser.ts`). Deferred out of the P4 PR.
- **Cross-device distribution patterns** (fanout / mirror / elected-singleton,
  described above) formalized as declared `placement` (`every-device` |
  `singleton`) and `distribution` (`fanout` | `mirror` | `local`) fields
  resolved by shared helpers, instead of independent implementations. (Usage's
  former `provider` pattern was removed in RUSH-3193 #15 — usage is now
  per-device local, so it no longer needs cross-device distribution.)
- **Caching** routed through `createMemoryCache` under a declared `cache`
  policy instead of the ~28 files of ad-hoc TTL constants + disk-mirror files
  described above.

See [RUSH-3193](https://linear.app/getrush/issue/RUSH-3193) for the design
and [RUSH-2654](https://linear.app/getrush/issue/RUSH-2654) for the
originating context. Do not describe P3/distribution/caching work as shipped
until the corresponding code lands.
