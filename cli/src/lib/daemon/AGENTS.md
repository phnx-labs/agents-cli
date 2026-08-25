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

**Services are inline `setInterval` closures inside `runDaemon()`, not a
managed list.** There are 11 today, each scheduled directly in `runDaemon()`:
catchup (5min, `daemon.ts:1059`), active-sessions warm (15s,
`daemon.ts:1112`), session-index warm (20s, `daemon.ts:1137`), watchdog
(3min, `daemon.ts:1166`), device-probe (3min, `daemon.ts:1212`), monitor
(60s, `daemon.ts:1354`), self-heal (6h, `daemon.ts:1361`), broker self-heal
(60s, `daemon.ts:1398`), keychain reap (5min, `daemon.ts:1406`), dead-pane
reap (5min, `daemon.ts:1414`), browser-task reap (5min, `daemon.ts:1423`),
and a state-dir check (interval from config, `daemon.ts:1463`). Each tick is
guarded by a local boolean in-flight flag plus a try/catch that only logs —
e.g. the active-sessions-warm tick (`daemon.ts:1101-1110`):

```ts
if (activeSessionsWarmInFlight) return;
activeSessionsWarmInFlight = true;
try { await runActiveSessionsWarmTick(); }
catch (err) { log('WARN', ...) }
finally { activeSessionsWarmInFlight = false; }
```

The session-index warm tick follows the identical shape at
`daemon.ts:1118-1133`. Nothing outside a tick's own try/catch observes
whether that tick is healthy.

**The service catalog is descriptive metadata plus an enable toggle — not a
runtime contract.** `cli/src/lib/daemon-services.ts` defines
`DaemonServiceId` (`daemon-services.ts:17-27`, 11 ids: `secrets-broker`,
`scheduler`, `monitors`, `browser-ipc`, `webhook-receiver`, `self-heal`,
`keychain-reap`, `account-state`, `watchdog`, `device-probe`,
`state-dir-check`) and `DaemonServiceDef` (`daemon-services.ts:31-35`):

```ts
export interface DaemonServiceDef {
  id: DaemonServiceId;
  title: string;
  description: string;
}
```

Enabled/disabled state lives separately in a `DaemonServicesConfig`, read
and written via `isDaemonServiceEnabled` (`daemon-services.ts:165`),
`setDaemonServiceEnabled` (`daemon-services.ts:172`), and
`listDaemonServiceStates` (`daemon-services.ts:182`). There is no
start/stop/restart/health method anywhere on a `DaemonServiceDef` — the
catalog only names what exists and whether it's toggled on; the interval
loops in `runDaemon()` are the actual runtime.

**Crash model: any uncaught error in the process kills and restarts the
whole daemon, not just the failing service.** A throw that escapes a tick's
local try/catch is uncaught at the process level. `cli/src/index.ts:96-102`
installs the top-level handlers:

```ts
process.on('uncaughtException', crash('uncaughtException'));
process.on('unhandledRejection', crash('unhandledRejection'));
```

`crash()` logs and then calls `process.exit(1)` (`index.ts:100`), relying on
the OS supervisor (launchd `KeepAlive` on macOS, `systemd Restart=always` on
Linux) to relaunch the whole process — every service restarts together, not
just the one that threw. Only a subset of subsystems report health
proactively: `cli/src/lib/daemon-health.ts` exposes `recordSubsystemOk`
(`daemon-health.ts:85`) and `recordSubsystemError`
(`daemon-health.ts:93`), called from `daemon.ts` at 7 sites covering just
the secrets broker (`daemon.ts:948`, `:952`) and browser IPC
(`daemon.ts:1322`, `:1326`), plus daemon-start bookkeeping (`daemon.ts:1473`,
`:1796`). The other 9 interval services have no recorded health signal
beyond their own log lines.

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
- **provider** (one primary produces, others pull via SSH import):
  `usageRefreshRole` (`cli/src/lib/usage-fleet.ts:54`) and
  `importUsageFleetFromHost` (`cli/src/lib/usage-fleet.ts:135`) implement
  primary/subscriber usage refresh; the primary is pinned by the
  `usage.primary-host` config key, resolved in `device-config.ts:580` (falls
  back to `interactive.host`, comment at `device-config.ts:579`).
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

RUSH-3193 replaces the inline-`setInterval` pattern above with a
`DaemonService` contract (`id`, `start`/`stop`/`restart`/`health`, plus
`intervalMs`/`deadlineMs`/`tick` for periodic services) owned by a
`ServiceSupervisor`. The supervisor is meant to give every service — not
just the 2 that currently call `daemon-health.ts` — a per-service error
boundary (so one throwing service no longer takes down the whole daemon via
`crash()` → `process.exit(1)`), a per-tick deadline, backoff with a circuit
breaker, uniform health reporting, and live enable/disable without a daemon
restart. It also plans to formalize the four hand-rolled distribution
patterns above as declared `placement` (`every-device` | `singleton`) and
`distribution` (`fanout` | `mirror` | `provider` | `local`) fields resolved
by shared helpers instead of four independent implementations, and to route
caching through `createMemoryCache` under a declared `cache` policy instead
of ad-hoc TTL constants. None of this exists in the code yet as of this
writing — see [RUSH-3193](https://linear.app/getrush/issue/RUSH-3193) for
the design and [RUSH-2654](https://linear.app/getrush/issue/RUSH-2654) for
the originating context. Do not describe supervisor behavior as shipped
until the corresponding code lands.
