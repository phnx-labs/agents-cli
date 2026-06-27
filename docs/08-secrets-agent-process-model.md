# Secrets-agent process model (design decision)

> Status: **proposed** · Supersedes nothing · Related: [secrets.md](secrets.md), [03-routines.md](03-routines.md)

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

## Options

1. **Fold into the routines daemon.** Host the broker next to `BrowserIPCServer`.
   - Fewer processes; reuses one lifecycle; matches an existing pattern.
   - **But** couples secrets availability to a heavy, only-runs-with-routines,
     empirically-flaky host; and forces secrets-only users to run the whole
     scheduler/browser/sync stack they don't need. It makes the *more* critical
     thing depend on the *less* reliable thing.
2. **Keep the broker as its own minimal service.**
   - Fault-isolated, lightweight, independently available, fast cold-start.
   - **But** two persistent services with (currently) two different lifecycle
     mechanisms — untidy unless both are auto-managed + self-healing.
3. **Unify into a light supervisor.** One always-on, lightweight background
   process that hosts only fast services in-process (broker; scheduler
   *triggers*) and spawns heavy work (job *runs*, browser automation, session
   sync) as separate on-demand children.
   - One background presence + a light, reliable core + isolation of heavy work.
   - **But** the largest refactor: today the daemon runs browser+sync in-process.

## Decision

**Do not fold the broker into today's daemon (reject Option 1).**

- **Short term — Option 2, made invisible.** Keep the broker its own minimal,
  auto-started, self-healing service. The "two processes" cost is only a problem
  if a human has to *manage* them; with auto-start + heal-on-upgrade +
  version-skew self-heal (see [secrets.md](secrets.md#self-healing-across-upgrades)),
  neither service needs hand-holding. Reliability isolation outweighs tidiness
  for a security primitive.
- **Long term — Option 3.** Evolve toward a light supervisor: move
  `BrowserService`/IPC and session-sync out of the daemon core into spawned
  children, leaving a light core that can host the broker too. *That* is the
  legitimate "one daemon," and it's the right time to consolidate — not by
  pushing the broker into the heavy daemon as it stands.

The guiding principle: **consolidate processes by making the host light, not by
making the critical service heavy.**

## Consequences

- The broker keeps its own `com.phnx-labs.agents-secrets-agent` service; the
  redundancy is paid down by self-healing, not by merging.
- The daemon's own fragility (PID-null, duplicates, cold-start) is fixed on its
  own merits (single-instance enforcement, self-heal) rather than inherited by
  secrets.
- The two services should converge on **one** lifecycle convention (launchd
  primary, detached fallback, version-skew self-heal) so they look and heal the
  same way — a prerequisite for the eventual Option-3 merge.
- Revisit this record when the supervisor refactor is scoped; at that point the
  broker folds into the *light* core and this status moves to "superseded."
