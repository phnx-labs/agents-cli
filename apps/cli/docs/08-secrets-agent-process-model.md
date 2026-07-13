# Secrets-agent process model (design decision)

> Status: **accepted** · Supersedes nothing · Related: [secrets.md](secrets.md), [03-routines.md](03-routines.md)

> **Implementation (#416, step 1 — landed):** the daemon now hosts the broker
> socket-first. `runDaemon()` calls `startHostedBroker()` before the scheduler
> and the heavy browser/session-sync services, so `agents secrets` resolves
> within ms of daemon start; `ensureAgentRunning()` prefers the daemon (Path 0)
> and falls back to the standalone `com.phnx-labs.agents-secrets-agent` service.
> The daemon only hosts when no broker is already reachable, so a live standalone
> broker is never orphaned. **Still to do (step 2 / #417):** retire the standalone
> launchd service via a gated `launchctl bootout` migration (only when the store
> is idle, so no Touch ID storm) and spawn the heavy services as bounded children.

A design record for *where the secrets-agent broker should live as a process* —
its own service, or folded into the routines daemon. Written after a stretch of
production incidents (stale daemon reading the keychain, broker cold-start
starvation, duplicate daemons) made the process model worth pinning down.

## Context

The **secrets-agent broker** (`src/lib/secrets/agent.ts`) is a persistent
process that holds unlocked bundles in memory behind a `0700` Unix socket, so
concurrent agents stop re-prompting Touch ID per process. It currently runs as
its own launchd user service, `com.phnx-labs.agents-secrets-agent`.

The **routines daemon** (`src/lib/daemon.ts`, `com.phnx-labs.agents-daemon`)
already hosts a socket IPC service of the same shape — `BrowserIPCServer` — which
prompted the question: *isn't the broker a second daemon we don't need? Fold it
into the routines daemon.*

## What the routines daemon actually is today

`runDaemon()` runs, **in-process**:

- the cron **scheduler** (`JobScheduler`),
- `BrowserService` + `BrowserIPCServer` (a socket server),
- **session-sync** to R2 every 90s,
- overdue-job detection + native notification on startup,
- orphan-process reaping,
- a 60s monitor interval.

It persists via launchd **or** a detached fallback, and **only auto-starts when
a routine exists** ("the scheduler auto-starts on first `routines add`").

Observed failure modes this cycle: heavy/slow startup, stale pid file
(`launchctl … PID: null`), duplicate daemon processes, and cold-start
starvation under high load (a fresh node process couldn't finish booting at load
~310).

## Why the broker has different requirements than the scheduler

| | Secrets broker | Routines scheduler |
|---|---|---|
| Blast radius of being down | **Loud** — every secret read pops Touch ID | Quiet — a cron job just runs late |
| Footprint | Tiny (socket + `Map`) | Heavy (browser, sync, scheduler) |
| Who needs it | Anyone using `agents secrets` | Only users with routines |
| Cold-start budget | Must be ~instant | Tolerant of slow start |

A reliability/security primitive that *everything* depends on should have the
**fewest dependencies and the lightest footprint**, and must not inherit the
failure modes of unrelated subsystems.

A note on an argument we explicitly **reject**: "the daemon is flaky, so keep the
broker out of it." A daemon is *defined* by being the supervised, always-on,
bounce-back backbone — robustness is its job. The PID-null / duplicate /
cold-start incidents are **bugs to fix in the daemon**, not properties to design
around. Routing a critical service *around* the daemon to dodge its bugs is
backwards; the fix is to make the daemon worthy of hosting critical services.
And the reliability isolation a separate broker seems to buy is largely illusory:
both a standalone broker and the daemon recover the same way — launchd
`KeepAlive` — so splitting them adds a second thing to supervise without adding
real resilience.

## Options

1. **Fold into the daemon, and harden the daemon.** Host the broker in the
   daemon next to `BrowserIPCServer`; make the daemon the always-on,
   single-instance, self-healing backbone it is meant to be.
   - One supervised backbone for all background services; one lifecycle; one
     self-heal path; the broker inherits the daemon's robustness.
   - Requires real work: the daemon must (a) be **always-on**, not gated on
     having routines; (b) enforce **single-instance** (no duplicates); (c) start
     the **broker socket first/fast** so secrets availability never waits on
     browser/sync init; (d) keep heavy/risky work (browser automation, job runs)
     in **spawned children** so a crash there can't take the backbone down.
2. **Keep the broker as its own minimal service.** Fault-isolated, but two
   services on two lifecycle mechanisms, and the "isolation" is mostly illusory
   (both rely on `KeepAlive`). Rejected — it treats daemon bugs as permanent.

## Decision

**Fold the broker into the daemon — and harden the daemon into the robust,
always-on, self-healing backbone (Option 1).** A daemon is the right home for a
persistent, critical background service precisely *because* it is supposed to be
the most reliable, supervised component. The broker's reliability should come
*from* a reliable daemon, not from avoiding it.

The guiding principle (corrected): **make the host (the daemon) reliable enough
to carry the critical service — don't route the critical service around the
host.**

This makes the daemon the single backbone that hosts the scheduler, browser IPC,
and the secrets broker, with heavy/optional work spawned as children to bound
blast radius.

## Consequences

- The standalone `com.phnx-labs.agents-secrets-agent` launchd service is retired;
  the broker becomes a service hosted inside `com.phnx-labs.agents-daemon`. The
  `secrets start/stop` surface either goes away or becomes thin aliases for
  daemon lifecycle.
- The daemon must become **always-on** (start for any background need, not only
  `routines add`) and **single-instance** (the PID-null/duplicate bugs are
  fixed, not tolerated).
- In `runDaemon()`, **bind the broker socket before** the browser/session-sync
  setup, so secrets resolution is available within milliseconds of daemon start
  even while the heavier services initialize.
- Heavy/crash-prone work stays in child processes so a failure there can't take
  down the broker; the daemon core stays light enough to be trustworthy.
- Self-heal (heal-on-upgrade + version-skew restart, PR #413) applies to the one
  daemon, covering the broker for free.
- Migration: on upgrade, `bootout` the old secrets-agent service and let the
  daemon take over the socket.
